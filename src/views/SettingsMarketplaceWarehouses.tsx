import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../api/supabaseClient";
import { MarketplaceChannelCode, syncMarketplaceDestinations } from "../api/marketplaceWarehouses";

type ChannelCode = MarketplaceChannelCode | "CLIENT";

type ChannelRow = {
  id: string;
  code: ChannelCode;
  name: string;
};

type DestinationRow = {
  id: string;
  channelId: string;
  channelCode: ChannelCode;
  channelName: string;
  name: string;
  region?: string | null;
  address?: string | null;
  externalId?: string | null;
  isActive: boolean;
  updatedAt?: string | null;
};

const channelOrder: ChannelCode[] = ["WB", "OZON", "CLIENT"];
const channelLabels: Record<ChannelCode, string> = {
  WB: "Wildberries",
  OZON: "Ozon",
  CLIENT: "Клиенты",
};

const badgeClass: Record<ChannelCode, string> = {
  WB: "mpwh-badge wb",
  OZON: "mpwh-badge ozon",
  CLIENT: "mpwh-badge client",
};

export default function SettingsMarketplaceWarehouses() {
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [rows, setRows] = useState<DestinationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Record<ChannelCode, boolean>>({
    WB: true,
    OZON: true,
    CLIENT: true,
  });
  const [syncing, setSyncing] = useState<Record<MarketplaceChannelCode, boolean>>({ WB: false, OZON: false });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [{ data: channelRows, error: chErr }, { data: destRows, error: destErr }] = await Promise.all([
        supabase.from("mp_channels").select("id, code, name"),
        supabase
          .from("mp_destinations")
          .select("id, channel_id, name, region, address, external_id, is_active, updated_at")
          .order("name", { ascending: true }),
      ]);
      if (chErr) throw chErr;
      if (destErr) throw destErr;
      const typedChannels: ChannelRow[] =
        channelRows?.map((row) => ({
          id: row.id,
          code: (row.code as ChannelCode) ?? "CLIENT",
          name: row.name,
        })) ?? [];
      setChannels(typedChannels);
      const channelById = new Map(typedChannels.map((c) => [c.id, c]));
      const mapped: DestinationRow[] =
        destRows?.map((row) => {
          const channel = channelById.get(row.channel_id);
          const code = channel?.code ?? "CLIENT";
          return {
            id: row.id,
            channelId: row.channel_id,
            channelCode: code,
            channelName: channel?.name ?? channelLabels[code],
            name: row.name,
            region: row.region,
            address: row.address,
            externalId: row.external_id,
            isActive: Boolean(row.is_active),
            updatedAt: row.updated_at,
          };
        }) ?? [];

      mapped.sort((a, b) => {
        const chDiff = channelOrder.indexOf(a.channelCode) - channelOrder.indexOf(b.channelCode);
        if (chDiff !== 0) return chDiff;
        return a.name.localeCompare(b.name, "ru");
      });
      setRows(mapped);
    } catch (err: any) {
      console.error("load marketplace warehouses", err);
      setError(err?.message ?? "Не удалось загрузить склады");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleFilter = (code: ChannelCode) => {
    setFilters((prev) => ({ ...prev, [code]: !prev[code] }));
  };

  const filteredRows = useMemo(
    () => rows.filter((row) => filters[row.channelCode]),
    [rows, filters],
  );

  const handleSync = async (code: MarketplaceChannelCode) => {
    setSyncing((prev) => ({ ...prev, [code]: true }));
    try {
      await syncMarketplaceDestinations(code);
      await load();
    } catch (err: any) {
      console.error("sync mp warehouses", err);
      alert(err?.message ?? `Не удалось синхронизировать ${code}`);
    } finally {
      setSyncing((prev) => ({ ...prev, [code]: false }));
    }
  };

  const toggleActive = async (row: DestinationRow) => {
    const next = !row.isActive;
    setRows((prev) => prev.map((item) => (item.id === row.id ? { ...item, isActive: next } : item)));
    const { error: updErr } = await supabase
      .from("mp_destinations")
      .update({ is_active: next })
      .eq("id", row.id);
    if (updErr) {
      console.error("toggle mp destination", updErr);
      setRows((prev) => prev.map((item) => (item.id === row.id ? { ...item, isActive: !next } : item)));
      alert("Не удалось изменить статус. Подробнее в консоли.");
    }
  };

  const addClientWarehouse = async () => {
    const channel = channels.find((c) => c.code === "CLIENT");
    if (!channel) {
      alert("Нет канала CLIENT в справочнике mp_channels");
      return;
    }
    const name = (window.prompt("Название склада клиента:") ?? "").trim();
    if (!name) return;
    const region = (window.prompt("Регион / город:", "") ?? "").trim();
    const address = (window.prompt("Адрес:", "") ?? "").trim();
    const { error: insertErr } = await supabase.from("mp_destinations").insert({
      channel_id: channel.id,
      name,
      region: region || null,
      address: address || null,
      is_active: true,
    });
    if (insertErr) {
      console.error("add client warehouse", insertErr);
      alert("Не удалось добавить склад клиента");
      return;
    }
    await load();
  };

  return (
    <div className="app-plate app-plate--solid p-3">
      <div className="flex flex-wrap gap-2 items-center mb-3">
        <div className="text-lg font-semibold flex-1">Справочник складов маркетплейсов</div>
        <button
          className="mrp-btn mrp-btn--ghost"
          onClick={() => handleSync("WB")}
          disabled={syncing.WB}
        >
          {syncing.WB ? "WB… " : "Синхр. WB"}
        </button>
        <button
          className="mrp-btn mrp-btn--ghost"
          onClick={() => handleSync("OZON")}
          disabled={syncing.OZON}
        >
          {syncing.OZON ? "Ozon…" : "Синхр. Ozon"}
        </button>
        <button className="mrp-btn mrp-btn--primary" onClick={addClientWarehouse}>
          + Склад клиента
        </button>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div className="panel-header__title">Фильтр каналов</div>
        </div>
        <div className="filter-row">
          {channelOrder.map((code) => (
            <label key={code} className="filter-check">
              <input
                type="checkbox"
                checked={filters[code]}
                onChange={() => toggleFilter(code)}
              />
              <span>{channelLabels[code]}</span>
            </label>
          ))}
        </div>
      </div>

      {error && <div className="text-sm text-red-600 mb-2">{error}</div>}

      <div className="overflow-auto rounded-xl border border-slate-200 bg-white">
        <table className="mrp-table text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Канал</th>
              <th className="px-3 py-2 text-left">Склад</th>
              <th className="px-3 py-2 text-left">Регион</th>
              <th className="px-3 py-2 text-left">Адрес</th>
              <th className="px-3 py-2 text-left">ID в системе</th>
              <th className="px-3 py-2 text-left">Обновлён</th>
              <th className="px-3 py-2 text-left">Статус</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-center text-slate-500">
                  Загрузка…
                </td>
              </tr>
            ) : filteredRows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-4 text-center text-slate-500">
                  Нет складов для выбранных каналов
                </td>
              </tr>
            ) : (
              filteredRows.map((row) => (
                <tr key={row.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2">
                    <span className={badgeClass[row.channelCode]}>{channelLabels[row.channelCode]}</span>
                  </td>
                  <td className="px-3 py-2 font-semibold">{row.name}</td>
                  <td className="px-3 py-2">{row.region || "—"}</td>
                  <td className="px-3 py-2">{row.address || "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{row.externalId || "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {row.updatedAt ? new Date(row.updatedAt).toLocaleString("ru-RU") : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className={`mrp-chip ${row.isActive ? "is-active" : ""}`}
                      onClick={() => toggleActive(row)}
                    >
                      {row.isActive ? "Активен" : "Выключен"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
