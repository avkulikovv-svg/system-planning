import React from "react";
import { supabase } from "../api/supabaseClient";
import { syncMarketplaceSupplyPlans } from "../api/marketplaceSupplyPlans";

const channelGroups = [
  { code: "WB", label: "Wildberries", accent: "wb" },
  { code: "OZON", label: "Ozon", accent: "ozon" },
  { code: "CLIENT", label: "Клиенты", accent: "client" },
] as const;

type ChannelCode = typeof channelGroups[number]["code"];

type SupplyColumn = {
  id: string;
  channel: ChannelCode;
  title: string;
  subtitle: string;
};

type MatrixItem = {
  id: string;
  code: string;
  name: string;
  group: string;
  bucket: string;
  currentStock: number;
};

type ChannelRow = {
  id: string;
  code: ChannelCode;
  name: string;
};

type DestinationRow = {
  id: string;
  channelId: string;
  name: string;
};

type SupplyPlanRow = {
  id: string;
  channel_id: string;
  destination_id: string | null;
  item_id: string;
  plan_date: string;
  qty: number;
  shipment_name: string | null;
  external_supply_id: string | null;
  status: string;
  updated_at?: string | null;
};

type ItemRow = {
  id: string;
  code: string;
  name: string;
  category: string | null;
};

const formatDateShort = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}`;
};

export function MarketplacesView() {
  const [filters, setFilters] = React.useState<Record<ChannelCode, boolean>>({
    WB: true,
    OZON: true,
    CLIENT: true,
  });
  const [columns, setColumns] = React.useState<SupplyColumn[]>([]);
  const [items, setItems] = React.useState<MatrixItem[]>([]);
  const [matrix, setMatrix] = React.useState<Record<string, Record<string, number>>>({});
  const [loading, setLoading] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const [syncingWb, setSyncingWb] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [lastUpdatedOzon, setLastUpdatedOzon] = React.useState<string | null>(null);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [channelsRes, destinationsRes, itemsRes, plansRes, stockRes] = await Promise.all([
        supabase.from("mp_channels").select("id, code, name"),
        supabase.from("mp_destinations").select("id, channel_id, name"),
        supabase.from("items").select("id, code, name, category").eq("kind", "product"),
        supabase
          .from("mp_supply_plans")
          .select("id, channel_id, destination_id, item_id, plan_date, qty, shipment_name, external_supply_id, status, updated_at"),
        supabase.from("stock_balances").select("item_id, qty"),
      ]);

      if (channelsRes.error) throw channelsRes.error;
      if (destinationsRes.error) throw destinationsRes.error;
      if (itemsRes.error) throw itemsRes.error;
      if (plansRes.error) throw plansRes.error;
      if (stockRes.error) throw stockRes.error;

      const channels: ChannelRow[] =
        channelsRes.data?.map((row: any) => ({
          id: row.id,
          code: (row.code as ChannelCode) ?? "CLIENT",
          name: row.name,
        })) ?? [];
      const channelById = new Map(channels.map((c) => [c.id, c]));

      const destinations: DestinationRow[] =
        destinationsRes.data?.map((row: any) => ({
          id: row.id,
          channelId: row.channel_id,
          name: row.name,
        })) ?? [];
      const destinationById = new Map(destinations.map((d) => [d.id, d]));

      const planRows: SupplyPlanRow[] = plansRes.data ?? [];
      const itemRows: ItemRow[] = itemsRes.data ?? [];
      const ozonChannelId = channels.find((ch) => ch.code === "OZON")?.id ?? null;

      const stockMap = new Map<string, number>();
      for (const row of stockRes.data ?? []) {
        const itemId = String(row.item_id);
        stockMap.set(itemId, (stockMap.get(itemId) ?? 0) + Number(row.qty ?? 0));
      }

      const columnMap = new Map<string, SupplyColumn>();
      const matrixNext: Record<string, Record<string, number>> = {};

      for (const plan of planRows) {
        const channel = channelById.get(plan.channel_id);
        if (!channel) continue;
        const colKey = `${channel.code}:${plan.external_supply_id ?? plan.shipment_name ?? plan.plan_date}`;
        let col = columnMap.get(colKey);
        if (!col) {
          const destName = plan.destination_id ? destinationById.get(plan.destination_id)?.name : "";
          const title = plan.shipment_name || destName || channel.name;
          col = {
            id: colKey,
            channel: channel.code,
            title,
            subtitle: formatDateShort(plan.plan_date),
          };
          columnMap.set(colKey, col);
        }

        if (!matrixNext[plan.item_id]) matrixNext[plan.item_id] = {};
        matrixNext[plan.item_id][col.id] = (matrixNext[plan.item_id][col.id] ?? 0) + Number(plan.qty ?? 0);
      }

      const bucketedItems: MatrixItem[] = itemRows.map((row) => ({
        id: row.id,
        code: row.code ?? "",
        name: row.name ?? "",
        group: row.category ?? "Без категории",
        bucket: row.category ?? "Без категории",
        currentStock: stockMap.get(row.id) ?? 0,
      }));

      const sortedColumns = Array.from(columnMap.values()).sort((a, b) => {
        if (a.channel !== b.channel) return a.channel.localeCompare(b.channel, "ru");
        if (a.subtitle !== b.subtitle) return a.subtitle.localeCompare(b.subtitle, "ru");
        return a.title.localeCompare(b.title, "ru");
      });

      if (ozonChannelId) {
        let latest = 0;
        for (const plan of planRows) {
          if (plan.channel_id !== ozonChannelId) continue;
          const ts = Date.parse(plan.updated_at ?? "");
          if (!Number.isNaN(ts)) latest = Math.max(latest, ts);
        }
        setLastUpdatedOzon(latest ? new Date(latest).toLocaleString("ru-RU") : null);
      } else {
        setLastUpdatedOzon(null);
      }

      setColumns(sortedColumns);
      setItems(bucketedItems);
      setMatrix(matrixNext);
    } catch (err: any) {
      console.error("load marketplace plans", err);
      setError(err?.message ?? "Не удалось загрузить данные");
    } finally {
      setLoading(false);
    }
  }, []);

  const syncOzon = React.useCallback(async () => {
    setSyncing(true);
    try {
      await syncMarketplaceSupplyPlans("OZON");
    } catch (err: any) {
      console.error("sync marketplace plans", err);
      setError(err?.message ?? "Не удалось обновить Ozon");
    } finally {
      setSyncing(false);
    }
  }, []);

  const syncWb = React.useCallback(async () => {
    setSyncingWb(true);
    try {
      await syncMarketplaceSupplyPlans("WB");
    } catch (err: any) {
      console.error("sync marketplace plans", err);
      setError(err?.message ?? "Не удалось обновить WB");
    } finally {
      setSyncingWb(false);
    }
  }, []);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  const toggleChannel = (code: ChannelCode) => {
    setFilters((prev) => ({ ...prev, [code]: !prev[code] }));
  };

  const visibleColumns = columns.filter((col) => filters[col.channel]);
  const headerGroups = React.useMemo(() => {
    const groups: Array<{ code: ChannelCode; label: string; accent: string; count: number }> = [];
    for (const col of visibleColumns) {
      const last = groups[groups.length - 1];
      if (last && last.code === col.channel) {
        last.count += 1;
        continue;
      }
      const meta = channelGroups.find((g) => g.code === col.channel);
      groups.push({
        code: col.channel,
        label: meta?.label ?? col.channel,
        accent: meta?.accent ?? "client",
        count: 1,
      });
    }
    return groups;
  }, [visibleColumns]);

  const bucketOrder = React.useMemo(() => {
    const set = new Set(items.map((it) => it.bucket));
    return Array.from(set).sort((a, b) => a.localeCompare(b, "ru"));
  }, [items]);

  const itemsWithPlan = items.filter((item) =>
    (matrix[item.id] && Object.values(matrix[item.id]).some((qty) => qty > 0)) ?? false,
  );
  const itemsWithoutPlan = items.filter((item) => !itemsWithPlan.find((pl) => pl.id === item.id));

  const sortItems = (arr: MatrixItem[]) =>
    [...arr].sort((a, b) => {
      const bucketDiff = bucketOrder.indexOf(a.bucket) - bucketOrder.indexOf(b.bucket);
      if (bucketDiff !== 0) return bucketDiff;
      return a.name.localeCompare(b.name, "ru");
    });

  const renderRow = (item: MatrixItem) => (
    <tr key={item.id}>
      <td className="mp-matrix__bucket">{item.bucket}</td>
      <td className="mp-matrix__code">{item.code}</td>
      <td className="mp-matrix__name">{item.name}</td>
      <td className="mp-matrix__stock">{item.currentStock}</td>
      {visibleColumns.map((col) => {
        const value = matrix[item.id]?.[col.id] ?? 0;
        return (
          <td key={`${item.id}-${col.id}`} className="mp-matrix__cell">
            <input
              type="number"
              className="form-control input-compact mp-matrix__input"
              value={value || ""}
              readOnly
            />
          </td>
        );
      })}
    </tr>
  );

  return (
    <div className="marketplaces">
      <header className="page-header">
        <div>
          <h1>План поставок по маркетплейсам</h1>
          <p className="subtitle">
            Таблица повторяет Excel-матрицу: строки — товары, колоноки — поставки по каналам.
          </p>
        </div>
        <div className="actions">
          <button
            className="app-pill app-pill--md"
            onClick={async () => { await syncOzon(); await loadData(); }}
            disabled={syncing || loading}
          >
            {syncing ? "Обновление Ozon…" : "Обновить Ozon"}
          </button>
          <button
            className="app-pill app-pill--md"
            onClick={async () => { await syncWb(); await loadData(); }}
            disabled={syncingWb || loading}
          >
            {syncingWb ? "Обновление WB…" : "Обновить WB"}
          </button>
          <button className="app-pill app-pill--md">+ Добавить колонку</button>
          <button className="app-pill app-pill--md">Импорт из XLSX</button>
        </div>
      </header>

      <section className="panel">
        <div className="panel-header">
          <div className="panel-header__title">Каналы</div>
          <div className="actions gap">
            <button className="app-pill app-pill--sm" disabled>
              Отгрузить
            </button>
            <button className="app-pill app-pill--sm" disabled>
              Отменить
            </button>
          </div>
        </div>
        <div className="filter-row">
          {channelGroups.map((opt) => (
            <label key={opt.code} className="filter-check">
              <input
                type="checkbox"
                checked={filters[opt.code]}
                onChange={() => toggleChannel(opt.code)}
              />
              <span>{opt.label}</span>
            </label>
          ))}
          <div className="text-xs text-slate-500 ml-auto">
            {lastUpdatedOzon ? `Ozon обновлён: ${lastUpdatedOzon}` : "Ozon ещё не обновлялся"}
          </div>
        </div>
      </section>

      {error && <div className="text-sm text-red-600 mb-2">{error}</div>}

      <div className="mp-matrix-wrapper">
        <table className="mp-matrix">
          <thead>
            <tr>
              <th rowSpan={2} className="sticky-col">Группа</th>
              <th rowSpan={2} className="sticky-col">Код</th>
              <th rowSpan={2} className="mp-matrix__name-head">Наименование</th>
              <th rowSpan={2} className="mp-matrix__stock">Доступно</th>
              {headerGroups.map((group) => (
                <th key={group.code} colSpan={group.count} className={`mp-matrix__group mp-${group.accent}`}>
                  {group.label}
                </th>
              ))}
            </tr>
            <tr>
              {visibleColumns.length === 0 ? (
                <th className="mp-matrix__empty" colSpan={1}>
                  Выберите хотя бы один канал
                </th>
              ) : (
                visibleColumns.map((col) => (
                  <th key={col.id} className="mp-matrix__col">
                    <div>{col.title}</div>
                    <small>{col.subtitle}</small>
                  </th>
                ))
              )}
            </tr>
          </thead>
          <tbody>
            {sortItems(itemsWithPlan).map(renderRow)}
            {itemsWithoutPlan.length > 0 && (
              <tr className="mp-divider">
                <td colSpan={visibleColumns.length + 4}>Без активных планов</td>
              </tr>
            )}
            {sortItems(itemsWithoutPlan).map(renderRow)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
