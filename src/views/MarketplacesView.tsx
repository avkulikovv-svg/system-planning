import React from "react";
import * as XLSX from "xlsx";
import { supabase } from "../api/supabaseClient";
import { syncMarketplaceSupplyPlans } from "../api/marketplaceSupplyPlans";
import {
  DEFAULT_PALLET_LIMITS,
  DEFAULT_PALLET_WEIGHT_KG,
  PalletLimits,
  PalletPlan,
  PalletWarning,
  distributePallets,
} from "../utils/pallets";

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
  externalSupplyId?: string | null;
  destinationId?: string | null;
  supplyBoxTypeId?: number | null;
  planDate?: string | null;
};

type MatrixItem = {
  id: string;
  code: string;
  name: string;
  group: string;
  bucket: string;
  currentStock: number;
  barcode?: string | null;
  units_per_box?: number | null;
  unit_weight?: number | null;
  box_length?: number | null;
  box_width?: number | null;
  box_height?: number | null;
  box_weight?: number | null;
  box_volume?: number | null;
  box_orientation?: string | null;
  shelf_life_days?: number | null;
  shelf_life_required?: boolean | null;
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
  meta?: any;
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
  supply_box_type_id?: number | null;
  status: string;
  updated_at?: string | null;
};

type SupplyHistoryRow = {
  id: string;
  source_plan_id: string;
  channel_id: string;
  destination_id: string | null;
  item_id: string;
  plan_date: string;
  qty: number;
  shipment_name: string | null;
  external_supply_id: string | null;
  supply_box_type_id?: number | null;
  status: string;
  archived_at?: string | null;
  restored_at?: string | null;
  canceled_at?: string | null;
};

type ItemRow = {
  id: string;
  code: string;
  name: string;
  category: string | null;
  barcode?: string | null;
  units_per_box?: number | null;
  unit_weight?: number | null;
  box_length?: number | null;
  box_width?: number | null;
  box_height?: number | null;
  box_weight?: number | null;
  box_volume?: number | null;
  box_orientation?: string | null;
  shelf_life_days?: number | null;
  shelf_life_required?: boolean | null;
};

const formatDateShort = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}`;
};

const formatDateRu = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
};

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};

type WbExportRow = { barcode: string; qty: number; expiry?: string };

export function MarketplacesView() {
  const [filters, setFilters] = React.useState<Record<ChannelCode, boolean>>({
    WB: true,
    OZON: true,
    CLIENT: true,
  });
  const [columns, setColumns] = React.useState<SupplyColumn[]>([]);
  const [items, setItems] = React.useState<MatrixItem[]>([]);
  const [matrix, setMatrix] = React.useState<Record<string, Record<string, number>>>({});
  const [historyRows, setHistoryRows] = React.useState<SupplyHistoryRow[]>([]);
  const [destinations, setDestinations] = React.useState<DestinationRow[]>([]);
  const [viewMode, setViewMode] = React.useState<"active" | "history">("active");
  const [channelIdMap, setChannelIdMap] = React.useState<Record<string, ChannelRow>>({});
  const [loading, setLoading] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const [syncingWb, setSyncingWb] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [lastUpdatedOzon, setLastUpdatedOzon] = React.useState<string | null>(null);
  const [wbExportOpen, setWbExportOpen] = React.useState(false);
  const [wbExportSupply, setWbExportSupply] = React.useState<string>("");
  const [wbExportFile, setWbExportFile] = React.useState<File | null>(null);
  const [wbExportError, setWbExportError] = React.useState<string | null>(null);
  const [wbProdDates, setWbProdDates] = React.useState<Record<string, string>>({});
  const [itemBarcodes, setItemBarcodes] = React.useState<Record<string, string>>({});
  const [palletOpen, setPalletOpen] = React.useState(false);
  const [palletSupply, setPalletSupply] = React.useState<string>("");
  const [palletPlan, setPalletPlan] = React.useState<PalletPlan | null>(null);
  const [palletErrors, setPalletErrors] = React.useState<PalletWarning[]>([]);
  const [palletWarnings, setPalletWarnings] = React.useState<PalletWarning[]>([]);
  const [palletMaxWeight, setPalletMaxWeight] = React.useState<string>("");
  const [palletMaxHeight, setPalletMaxHeight] = React.useState<string>("");
  const [palletLimits, setPalletLimits] = React.useState<PalletLimits>(DEFAULT_PALLET_LIMITS);
  const [hasSupplyBoxType, setHasSupplyBoxType] = React.useState(true);

  const loadData = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [channelsRes, destinationsRes, itemsRes, stockRes, barcodeRes] = await Promise.all([
        supabase.from("mp_channels").select("id, code, name"),
        supabase.from("mp_destinations").select("id, channel_id, name, meta"),
        supabase
          .from("items")
          .select(
            "id, code, name, category, barcode, units_per_box, unit_weight, box_length, box_width, box_height, box_weight, box_volume, box_orientation, shelf_life_days, shelf_life_required",
          )
          .eq("kind", "product"),
        supabase.from("stock_balances").select("item_id, qty"),
        supabase.from("item_barcodes").select("item_id, barcode, channel, is_primary"),
      ]);

      if (channelsRes.error) throw channelsRes.error;
      if (destinationsRes.error) throw destinationsRes.error;
      if (itemsRes.error) throw itemsRes.error;
      if (stockRes.error) throw stockRes.error;
      if (barcodeRes.error) throw barcodeRes.error;

      const plansSelectFull =
        "id, channel_id, destination_id, item_id, plan_date, qty, shipment_name, external_supply_id, supply_box_type_id, status, updated_at";
      const plansSelectFallback =
        "id, channel_id, destination_id, item_id, plan_date, qty, shipment_name, external_supply_id, status, updated_at";
      const historySelectFull =
        "id, source_plan_id, channel_id, destination_id, item_id, plan_date, qty, shipment_name, external_supply_id, supply_box_type_id, status, archived_at, restored_at, canceled_at";
      const historySelectFallback =
        "id, source_plan_id, channel_id, destination_id, item_id, plan_date, qty, shipment_name, external_supply_id, status, archived_at, restored_at, canceled_at";

      let plansRes: any = await supabase
        .from("mp_supply_plans")
        .select(plansSelectFull)
        .eq("status", "planned");
      let historyRes: any = await supabase
        .from("mp_supply_plans_history")
        .select(historySelectFull)
        .order("archived_at", { ascending: false });

      const boxTypeError =
        (plansRes.error?.message || "").includes("supply_box_type_id") ||
        (historyRes.error?.message || "").includes("supply_box_type_id");

      if (boxTypeError) {
        setHasSupplyBoxType(false);
        plansRes = await supabase
          .from("mp_supply_plans")
          .select(plansSelectFallback)
          .eq("status", "planned");
        historyRes = await supabase
          .from("mp_supply_plans_history")
          .select(historySelectFallback)
          .order("archived_at", { ascending: false });
      } else {
        setHasSupplyBoxType(true);
      }

      if (plansRes.error) throw plansRes.error;
      if (historyRes.error) throw historyRes.error;

      const channels: ChannelRow[] =
        channelsRes.data?.map((row: any) => ({
          id: row.id,
          code: (row.code as ChannelCode) ?? "CLIENT",
          name: row.name,
        })) ?? [];
      const channelById = new Map(channels.map((c) => [c.id, c]));
      setChannelIdMap(Object.fromEntries(channelById.entries()));

      const destinations: DestinationRow[] =
        destinationsRes.data?.map((row: any) => ({
          id: row.id,
          channelId: row.channel_id,
          name: row.name,
          meta: row.meta ?? null,
        })) ?? [];
      const destinationById = new Map(destinations.map((d) => [d.id, d]));

      const planRows: SupplyPlanRow[] = plansRes.data ?? [];
      const historyData: SupplyHistoryRow[] = historyRes.data ?? [];
      const itemRows: ItemRow[] = itemsRes.data ?? [];
      const ozonChannelId = channels.find((ch) => ch.code === "OZON")?.id ?? null;

      const stockMap = new Map<string, number>();
      for (const row of stockRes.data ?? []) {
        const itemId = String(row.item_id);
        stockMap.set(itemId, (stockMap.get(itemId) ?? 0) + Number(row.qty ?? 0));
      }

      const barcodeMap: Record<string, string> = {};
      for (const row of barcodeRes.data ?? []) {
        const itemId = String(row.item_id);
        const barcode = String(row.barcode ?? "").trim();
        if (!barcode) continue;
        const isPrimary = Boolean(row.is_primary);
        const isWb = String(row.channel ?? "").toLowerCase() === "wb";
        const current = barcodeMap[itemId];
        if (!current || isPrimary || isWb) {
          barcodeMap[itemId] = barcode;
        }
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
            externalSupplyId: plan.external_supply_id ?? null,
            destinationId: plan.destination_id ?? null,
            supplyBoxTypeId: plan.supply_box_type_id ?? null,
            planDate: plan.plan_date ?? null,
          };
          columnMap.set(colKey, col);
        } else {
          if (!col.destinationId && plan.destination_id) col.destinationId = plan.destination_id;
          if (col.supplyBoxTypeId == null && plan.supply_box_type_id != null) {
            col.supplyBoxTypeId = plan.supply_box_type_id;
          }
          if (!col.planDate && plan.plan_date) col.planDate = plan.plan_date;
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
        barcode: row.barcode ?? null,
        units_per_box: row.units_per_box ?? null,
        unit_weight: row.unit_weight ?? null,
        box_length: row.box_length ?? null,
        box_width: row.box_width ?? null,
        box_height: row.box_height ?? null,
        box_weight: row.box_weight ?? null,
        box_volume: row.box_volume ?? null,
        box_orientation: row.box_orientation ?? null,
        shelf_life_days: row.shelf_life_days ?? null,
        shelf_life_required: row.shelf_life_required ?? null,
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
      setHistoryRows(historyData);
      setItemBarcodes(barcodeMap);
      setDestinations(destinations);
    } catch (err: any) {
      console.error("load marketplace plans", err);
      setError(err?.message ?? "Не удалось загрузить данные");
    } finally {
      setLoading(false);
    }
  }, []);

  const wbColumns = React.useMemo(
    () =>
      columns.filter((col) => col.channel === "WB" && col.externalSupplyId).map((col) => ({
        id: col.id,
        label: col.title,
        date: col.subtitle,
        externalSupplyId: col.externalSupplyId ?? "",
      })),
    [columns],
  );

  const palletColumns = React.useMemo(
    () => columns.filter((col) => col.externalSupplyId),
    [columns],
  );

  const destinationById = React.useMemo(
    () => new Map(destinations.map((d) => [d.id, d])),
    [destinations],
  );

  const selectedPalletColumn = React.useMemo(
    () => palletColumns.find((col) => col.id === palletSupply) ?? null,
    [palletColumns, palletSupply],
  );

  const itemMetaById = React.useMemo(() => {
    const map = new Map<string, ItemRow>();
    for (const row of (items as any as Array<ItemRow>)) {
      map.set(row.id, row);
    }
    return map;
  }, [items]);

  const parseNumber = (value: string) => {
    const v = value.replace(",", ".").trim();
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const resolvePalletLimits = React.useCallback(
    (col: SupplyColumn | null) => {
      const mode = col?.supplyBoxTypeId === 5 ? "mono" : "box";
      const destMeta = col?.destinationId ? destinationById.get(col.destinationId)?.meta : null;
      const raw = destMeta && typeof destMeta === "object"
        ? (destMeta as any).pallet_limits?.[mode]
        : null;
      const merged = { ...DEFAULT_PALLET_LIMITS, ...(raw || {}) };
      return { limits: merged, mode };
    },
    [destinationById],
  );

  React.useEffect(() => {
    if (!selectedPalletColumn) return;
    const { limits } = resolvePalletLimits(selectedPalletColumn);
    setPalletLimits(limits);
    setPalletMaxWeight(String(limits.maxWeightKg));
    setPalletMaxHeight(String(limits.maxHeightCm));
  }, [resolvePalletLimits, selectedPalletColumn]);

  React.useEffect(() => {
    setPalletPlan(null);
    setPalletErrors([]);
    setPalletWarnings([]);
  }, [palletSupply]);

  React.useEffect(() => {
    const raw = localStorage.getItem("mrp.returnToPallets");
    if (!raw) return;
    let payload: any = null;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    const target = payload?.supplyId;
    if (target && palletColumns.some((c) => c.id === target)) {
      setPalletOpen(true);
      setPalletSupply(target);
      localStorage.removeItem("mrp.returnToPallets");
    }
  }, [palletColumns]);

  const wbBoxNeedMap = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const col of wbColumns) {
      let total = 0;
      for (const item of items) {
        const qty = Number(matrix[item.id]?.[col.id] ?? 0);
        if (qty <= 0) continue;
        const perBoxRaw = Number(item.units_per_box ?? 0);
        const perBox = perBoxRaw > 0 ? perBoxRaw : qty;
        const full = Math.floor(qty / perBox);
        const rem = qty % perBox;
        total += full + (rem > 0 ? 1 : 0);
      }
      map.set(col.id, total);
    }
    return map;
  }, [wbColumns, items, matrix]);

  const supplyItems = React.useMemo(() => {
    if (!wbExportSupply) return [];
    const col = columns.find((c) => c.id === wbExportSupply);
    if (!col) return [];
    return items
      .map((item) => ({
        item,
        qty: Number(matrix[item.id]?.[col.id] ?? 0),
      }))
      .filter((row) => row.qty > 0);
  }, [items, matrix, columns, wbExportSupply]);

  const requiredExpiryItems = React.useMemo(() => {
    return supplyItems
      .map(({ item }) => itemMetaById.get(item.id))
      .filter((row): row is ItemRow => Boolean(row?.shelf_life_required));
  }, [supplyItems, itemMetaById]);

  const handleWbExport = async () => {
    setWbExportError(null);
    if (!wbExportSupply) {
      setWbExportError("Выберите поставку WB.");
      return;
    }
    if (!wbExportFile) {
      setWbExportError("Загрузите файл с коробами WB.");
      return;
    }
    const col = columns.find((c) => c.id === wbExportSupply);
    if (!col?.externalSupplyId) {
      setWbExportError("Не найдена выбранная поставка.");
      return;
    }

    const rows: WbExportRow[] = [];
    for (const { item, qty } of supplyItems) {
      const meta = itemMetaById.get(item.id);
      const barcode = String(meta?.barcode ?? itemBarcodes[item.id] ?? "").trim();
      if (!barcode) {
        setWbExportError(`У товара ${item.code} отсутствует штрихкод.`);
        return;
      }
      const perBoxRaw = Number(meta.units_per_box ?? 0);
      const perBox = perBoxRaw > 0 ? perBoxRaw : qty;
      const full = Math.floor(qty / perBox);
      const rem = qty % perBox;
      let expiry: string | undefined;
      if (meta.shelf_life_required) {
        const prodDate = wbProdDates[item.id];
        if (!prodDate) {
          setWbExportError(`Укажите дату производства для ${item.code}.`);
          return;
        }
        const shelfDays = Number(meta.shelf_life_days ?? 0);
        if (!shelfDays) {
          setWbExportError(`У товара ${item.code} не задан срок годности (дней).`);
          return;
        }
        expiry = formatDateRu(addDays(prodDate, shelfDays));
      }
      for (let i = 0; i < full; i++) {
        rows.push({ barcode, qty: perBox, expiry });
      }
      if (rem > 0) {
        rows.push({ barcode, qty: rem, expiry });
      }
    }
    if (!rows.length) {
      setWbExportError("Нет строк для распределения.");
      return;
    }

    const buf = await wbExportFile.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[sheetName];
    if (!sheet) {
      setWbExportError("Не удалось прочитать файл WB.");
      return;
    }

    const range = XLSX.utils.decode_range(sheet["!ref"] || "A1:D1");
    const boxRows: number[] = [];
    for (let r = 1; r <= range.e.r; r++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c: 2 })]; // C column
      const val = cell?.v;
      if (val != null && String(val).trim()) {
        boxRows.push(r);
      }
    }
    if (rows.length > boxRows.length) {
      setWbExportError(`Недостаточно коробов в файле: нужно ${rows.length}, есть ${boxRows.length}.`);
      return;
    }

    boxRows.forEach((r, idx) => {
      const target = rows[idx];
      const cellA = XLSX.utils.encode_cell({ r, c: 0 });
      const cellB = XLSX.utils.encode_cell({ r, c: 1 });
      const cellD = XLSX.utils.encode_cell({ r, c: 3 });
      if (target) {
        sheet[cellA] = { t: "s", v: target.barcode };
        sheet[cellB] = { t: "n", v: target.qty };
        if (target.expiry) {
          sheet[cellD] = { t: "s", v: target.expiry };
        } else {
          delete sheet[cellD];
        }
      } else {
        delete sheet[cellA];
        delete sheet[cellB];
        delete sheet[cellD];
      }
    });

    const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `wb-boxes-${col.externalSupplyId}.xlsx`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const openProductFromPallet = (itemId: string) => {
    if (!itemId) return;
    localStorage.setItem("mrp.openProductId", JSON.stringify(itemId));
    localStorage.setItem("mrp.activeSection", JSON.stringify("purchase"));
    localStorage.setItem("mrp.activeSub", JSON.stringify("products"));
    if (palletSupply) {
      localStorage.setItem("mrp.returnToPallets", JSON.stringify({ supplyId: palletSupply }));
    }
    window.location.reload();
  };

  const handlePalletCalc = () => {
    setPalletErrors([]);
    setPalletWarnings([]);
    setPalletPlan(null);

    if (!selectedPalletColumn) {
      setPalletErrors([{
        itemId: "",
        code: "",
        name: "",
        message: "Выберите поставку для расчёта.",
        level: "error",
      }]);
      return;
    }

    const { limits, mode } = resolvePalletLimits(selectedPalletColumn);
    const maxW = parseNumber(palletMaxWeight);
    const maxH = parseNumber(palletMaxHeight);
    const effectiveLimits: PalletLimits = {
      ...limits,
      maxWeightKg: maxW && maxW > 0 ? maxW : limits.maxWeightKg,
      maxHeightCm: maxH && maxH > 0 ? maxH : limits.maxHeightCm,
    };
    setPalletLimits(effectiveLimits);

    const supplyItems = items
      .map((item) => ({
        item,
        qty: Number(matrix[item.id]?.[selectedPalletColumn.id] ?? 0),
      }))
      .filter((row) => row.qty > 0);

    if (!supplyItems.length) {
      setPalletErrors([{
        itemId: "",
        code: "",
        name: "",
        message: "В поставке нет товаров для расчёта.",
        level: "error",
      }]);
      return;
    }

    const inputs = supplyItems.map(({ item, qty }) => ({
      itemId: item.id,
      code: item.code,
      name: item.name,
      category: item.group,
      qty,
      unitsPerBox: item.units_per_box,
      unitWeight: item.unit_weight,
      boxLength: item.box_length,
      boxWidth: item.box_width,
      boxHeight: item.box_height,
      boxWeight: item.box_weight,
      boxVolume: item.box_volume,
      boxOrientation: item.box_orientation,
    }));

    const plan = distributePallets(inputs, effectiveLimits);
    const extraWarnings: PalletWarning[] = [];
    if (!hasSupplyBoxType) {
      extraWarnings.push({
        itemId: "",
        code: "",
        name: "",
        message: "Тип поставки недоступен (колонка не создана) — используем лимиты для коробов.",
        level: "warn",
      });
    } else if (selectedPalletColumn.supplyBoxTypeId === 0) {
      extraWarnings.push({
        itemId: "",
        code: "",
        name: "",
        message: "Тип поставки WB: виртуальная (без коробов). Проверьте применимость расчёта.",
        level: "warn",
      });
    } else if (selectedPalletColumn.supplyBoxTypeId == null && mode === "box") {
      extraWarnings.push({
        itemId: "",
        code: "",
        name: "",
        message: "Тип поставки не определён, использованы лимиты для коробов.",
        level: "warn",
      });
    }
    setPalletErrors(plan.errors);
    setPalletWarnings([...extraWarnings, ...plan.warnings]);
    setPalletPlan(plan);
  };

  const handlePalletPrint = () => {
    if (!palletPlan || !palletPlan.pallets.length || !selectedPalletColumn) {
      alert("Сначала сделайте расчёт палет.");
      return;
    }

    const escapeHtml = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    const palletCards = palletPlan.pallets.map((pallet, idx) => {
      const totalWeight = pallet.weightKg + DEFAULT_PALLET_WEIGHT_KG;
      const totalBoxes = pallet.items.reduce((sum, it) => sum + it.boxes, 0);
      const items = pallet.items.slice().sort((a, b) => {
        const order = { heavy: 0, normal: 1, light: 2 } as const;
        return order[a.weightClass] - order[b.weightClass];
      });

      const layersTopDown = items.slice().reverse();
      const layerHtml = layersTopDown
        .map(
          (it, layerIdx) => `
          <div class="layer">
            <div class="layer-label">${layerIdx === 0 ? "Верх" : layerIdx === layersTopDown.length - 1 ? "Низ" : ""}</div>
            <div class="layer-box">
              <div class="layer-top">
                <div class="layer-code">${escapeHtml(it.code)}</div>
                <div class="layer-qty">${it.boxes} кор.</div>
              </div>
              <div class="layer-sub">${escapeHtml(it.name)}</div>
              <div class="layer-meta">
                <div>Ориентация: ${escapeHtml(it.orientation)}</div>
                <div>Класс: ${
                  it.weightClass === "heavy"
                    ? "тяжёлый"
                    : it.weightClass === "normal"
                      ? "средний"
                    : "лёгкий"
                }</div>
              </div>
            </div>
          </div>
        `,
        )
        .join("");

      return `
        <div class="card">
          <div class="card-head">
            <div class="title">Палета ${idx + 1}</div>
            <div class="meta">${escapeHtml(selectedPalletColumn.title)} · ${escapeHtml(selectedPalletColumn.subtitle)}</div>
          </div>
          <div class="stats">
            <div><span>Масса:</span> ${totalWeight.toFixed(1)} кг</div>
            <div><span>Высота:</span> ${pallet.heightCm.toFixed(1)} см</div>
            <div><span>Объём:</span> ${pallet.volumeM3.toFixed(3)} м³</div>
            <div><span>Коробов:</span> ${totalBoxes}</div>
          </div>
          <div class="diagram">
            <div class="pallet-base">Палета 120×80</div>
            <div class="layers">
              ${layerHtml}
            </div>
          </div>
          <div class="rule">Важно: тяжёлые короба укладывать снизу.</div>
        </div>
      `;
    });

    const chunked: string[] = [];
    for (let i = 0; i < palletCards.length; i += 4) {
      const pageItems = palletCards.slice(i, i + 4);
      const fillers = Math.max(0, 4 - pageItems.length);
      for (let f = 0; f < fillers; f += 1) {
        pageItems.push(`<div class="card card--empty"></div>`);
      }
      chunked.push(`
        <section class="sheet">
          ${pageItems.join("")}
        </section>
      `);
    }

    const html = `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>Печать палет</title>
        <style>
          @page { size: A4; margin: 10mm; }
          body { font-family: Arial, sans-serif; margin: 0; color: #111827; }
          .sheet { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; gap: 10mm; page-break-after: always; height: 100%; }
          .card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 8mm; }
          .card--empty { border: 1px dashed #e5e7eb; background: #fafafa; }
          .card-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 4mm; }
          .title { font-size: 16px; font-weight: 700; }
          .meta { font-size: 12px; color: #6b7280; text-align: right; }
          .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 2mm 4mm; font-size: 12px; margin-bottom: 4mm; }
          .stats span { color: #6b7280; }
          .rule { margin-top: 3mm; font-size: 11px; color: #991b1b; font-weight: 600; }
          .diagram { border: 1px dashed #e5e7eb; border-radius: 8px; padding: 4mm; margin-bottom: 4mm; }
          .pallet-base { font-size: 11px; color: #6b7280; margin-bottom: 3mm; }
          .layers { display: grid; gap: 2mm; }
          .layer { display: grid; grid-template-columns: 28px 1fr; gap: 2mm; align-items: stretch; }
          .layer-label { font-size: 10px; color: #9ca3af; text-transform: uppercase; letter-spacing: .08em; }
          .layer-box { border: 1px solid #c7d2fe; background: #eef2ff; border-radius: 6px; padding: 2mm 3mm; display: grid; gap: 1mm; font-size: 12px; }
          .layer-top { display: flex; align-items: baseline; justify-content: space-between; gap: 6mm; }
          .layer-code { font-weight: 800; color: #111827; font-size: 14px; }
          .layer-qty { font-weight: 800; font-size: 14px; color: #111827; white-space: nowrap; }
          .layer-sub { color: #374151; font-size: 12px; }
          .layer-meta { display: flex; gap: 6mm; justify-content: flex-end; color: #374151; font-size: 11px; white-space: nowrap; }
        </style>
      </head>
      <body>
        ${chunked.join("")}
      </body>
      </html>
    `;

    const w = window.open("", "_blank", "width=1024,height=768");
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
  };

  const handleWbPackingPrint = () => {
    if (!palletPlan || !palletPlan.pallets.length || !selectedPalletColumn) {
      alert("Сначала сделайте расчёт палет.");
      return;
    }
    if (selectedPalletColumn.channel !== "WB") {
      alert("Упаковочные листы доступны только для WB.");
      return;
    }

    const escapeHtml = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

    const supplyId = selectedPalletColumn.externalSupplyId ?? "—";
    const supplyDate = selectedPalletColumn.planDate ? formatDateRu(selectedPalletColumn.planDate) : "—";
    const destinationName = selectedPalletColumn.destinationId
      ? destinationById.get(selectedPalletColumn.destinationId)?.name ?? "—"
      : "—";
    const deliveryMethod =
      selectedPalletColumn.supplyBoxTypeId === 5
        ? "Монопалета"
        : selectedPalletColumn.supplyBoxTypeId === 1 || selectedPalletColumn.supplyBoxTypeId === 2
          ? "Короба"
          : "—";
    const supplierName = "ИП Куликов Антон Владимирович";
    const supplierInn = "665895679976";
    const totalPallets = palletPlan.pallets.length;

    const pages = palletPlan.pallets.map((pallet, idx) => {
      const totalBoxes = pallet.items.reduce((sum, it) => sum + it.boxes, 0);
      return `
        <section class="sheet">
          <div class="title">Упаковочный лист</div>
          <table class="info">
            <tr><td>Номер паллеты</td><td class="value">${idx + 1}</td></tr>
            <tr><td>Кол-во паллет в поставке</td><td class="value">${totalPallets}</td></tr>
            <tr><td>Номер поставки</td><td class="value">${escapeHtml(supplyId)}</td></tr>
            <tr><td>Кол-во коробов на данной паллете</td><td class="value">${totalBoxes}</td></tr>
            <tr><td>Склад назначения</td><td class="value">${escapeHtml(destinationName)}</td></tr>
            <tr><td>Способ поставки</td><td class="value">${deliveryMethod}</td></tr>
            <tr><td>Наименование поставщика, ИНН</td><td class="value">${escapeHtml(supplierName)}, ${supplierInn}</td></tr>
            <tr><td>Дата поставки</td><td class="value">${escapeHtml(supplyDate)}</td></tr>
          </table>
        </section>
      `;
    });

    const html = `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>Упаковочные листы</title>
        <style>
          @page { size: A4 landscape; margin: 10mm; }
          body { font-family: Arial, sans-serif; margin: 0; color: #111827; }
          .sheet { page-break-after: always; break-after: page; height: 190mm; box-sizing: border-box; }
          .title { font-size: 26px; font-weight: 800; margin-bottom: 6mm; }
          .info { width: 100%; border-collapse: collapse; font-size: 18px; table-layout: fixed; break-inside: avoid; }
          .info tr { break-inside: avoid; page-break-inside: avoid; }
          .info td { border: 1px solid #111827; padding: 6mm 5mm; vertical-align: middle; }
          .info td.value { font-weight: 700; font-size: 22px; }
        </style>
      </head>
      <body>
        ${pages.join("")}
      </body>
      </html>
    `;

    const w = window.open("", "_blank", "width=1100,height=800");
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
  };

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

  const itemById = React.useMemo(
    () => new Map(items.map((it) => [it.id, it])),
    [items],
  );
  const historyVisible = historyRows.filter((row) => {
    const meta = channelIdMap[row.channel_id];
    if (!meta) return true;
    return filters[meta.code];
  });

  const restoreHistoryRow = async (row: SupplyHistoryRow) => {
    const nowIso = new Date().toISOString();
    const insertRow: Record<string, any> = {
      id: row.source_plan_id,
      channel_id: row.channel_id,
      destination_id: row.destination_id,
      item_id: row.item_id,
      plan_date: row.plan_date,
      qty: row.qty,
      status: "planned",
      shipment_name: row.shipment_name,
      shipment_date: null,
      shipped_at: null,
      planned_by: "history:restore",
      comment: row.external_supply_id ? `restored_from=${row.external_supply_id}` : "restored",
      external_supply_id: row.external_supply_id,
      updated_at: nowIso,
    };
    if (hasSupplyBoxType) {
      insertRow.supply_box_type_id = row.supply_box_type_id ?? null;
    }
    const { error: insErr } = await supabase
      .from("mp_supply_plans")
      .upsert(insertRow, { onConflict: "id" });
    if (insErr) throw insErr;
    const { error: delMoveErr } = await supabase
      .from("stock_movements")
      .delete()
      .eq("doc_type", "mp_supply")
      .eq("doc_id", row.source_plan_id);
    if (delMoveErr) throw delMoveErr;
    const { error: histErr } = await supabase
      .from("mp_supply_plans_history")
      .update({ status: "restored", restored_at: nowIso, updated_at: nowIso })
      .eq("id", row.id);
    if (histErr) throw histErr;
  };

  const cancelHistoryRow = async (row: SupplyHistoryRow) => {
    const nowIso = new Date().toISOString();
    const { error: delMoveErr } = await supabase
      .from("stock_movements")
      .delete()
      .eq("doc_type", "mp_supply")
      .eq("doc_id", row.source_plan_id);
    if (delMoveErr) throw delMoveErr;
    const { error: histErr } = await supabase
      .from("mp_supply_plans_history")
      .update({ status: "canceled", canceled_at: nowIso, updated_at: nowIso })
      .eq("id", row.id);
    if (histErr) throw histErr;
  };

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
            className={`mrp-btn ${viewMode === "active" ? "mrp-btn--primary" : "mrp-btn--ghost"}`}
            onClick={() => setViewMode("active")}
          >
            Актуальные
          </button>
          <button
            className={`mrp-btn ${viewMode === "history" ? "mrp-btn--primary" : "mrp-btn--ghost"}`}
            onClick={() => setViewMode("history")}
          >
            История отгрузок
          </button>
        </div>
      </header>

      <section className="panel">
        <div className="panel-header">
          <div className="panel-header__title">Каналы</div>
          <div className="panel-actions">
            <div className="panel-actions__group">
              <button
                className="mrp-btn mrp-btn--primary"
                onClick={async () => { await syncOzon(); await loadData(); }}
                disabled={syncing || loading}
              >
                {syncing ? "Обновление Ozon…" : "Обновить Ozon"}
              </button>
              <button
                className="mrp-btn mrp-btn--primary"
                onClick={async () => { await syncWb(); await loadData(); }}
                disabled={syncingWb || loading}
              >
                {syncingWb ? "Обновление WB…" : "Обновить WB"}
              </button>
              <button className="mrp-btn mrp-btn--primary">+ Добавить колонку</button>
              <button className="mrp-btn mrp-btn--primary">Импорт из XLSX</button>
              <button
                className="mrp-btn mrp-btn--primary"
                onClick={() => {
                  setWbExportOpen(true);
                  setWbExportSupply(wbColumns[0]?.id ?? "");
                }}
              >
                WB XLSX
              </button>
              <button
                className="mrp-btn mrp-btn--primary"
                onClick={() => {
                  setPalletOpen(true);
                  setPalletSupply(palletColumns[0]?.id ?? "");
                }}
              >
                Палеты
              </button>
            </div>
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
      {wbExportOpen && (
        <section className="panel">
          <div className="panel-header">
            <div className="panel-header__title">WB распределение по коробам</div>
            <div className="panel-actions">
              <button className="mrp-btn mrp-btn--ghost" onClick={() => setWbExportOpen(false)}>
                Закрыть
              </button>
            </div>
          </div>
          <div className="filter-row wb-export-row">
            <label className="filter-check wb-export-field">
              <span>Поставка WB</span>
              <select
                value={wbExportSupply}
                onChange={(e) => setWbExportSupply(e.target.value)}
              >
                {wbColumns.map((col) => (
                  <option key={col.id} value={col.id}>
                    {col.label} · {col.date} · {wbBoxNeedMap.get(col.id) ?? 0} кор.
                  </option>
                ))}
              </select>
            </label>
            {wbExportSupply && (
              <div className="wb-export-need">
                Нужно коробов: {wbBoxNeedMap.get(wbExportSupply) ?? 0}
              </div>
            )}
            <label className="wb-export-file">
              <span>Файл коробов WB</span>
              <input
                className="wb-export-file__input"
                type="file"
                accept=".xlsx"
                onChange={(e) => setWbExportFile(e.target.files?.[0] ?? null)}
              />
              <span className="mrp-btn mrp-btn--ghost wb-export-file__button">Выбрать файл</span>
              <span className="wb-export-file__name">
                {wbExportFile?.name ?? "Файл не выбран"}
              </span>
            </label>
            <button className="mrp-btn mrp-btn--primary" onClick={handleWbExport}>
              Сформировать XLSX
            </button>
          </div>
          {requiredExpiryItems.length > 0 && (
            <div className="text-xs text-slate-600 mt-3">
              Укажите дату производства для товаров со сроком годности.
            </div>
          )}
          <div className="mt-2 grid gap-2">
            {requiredExpiryItems.map((row) => (
              <div key={row.id} className="flex items-center gap-3 text-sm">
                <div className="min-w-[180px] font-medium">{row.code}</div>
                <div className="flex-1">{row.name}</div>
                <input
                  type="date"
                  value={wbProdDates[row.id] ?? ""}
                  onChange={(e) =>
                    setWbProdDates((prev) => ({ ...prev, [row.id]: e.target.value }))
                  }
                />
              </div>
            ))}
          </div>
          {wbExportError && <div className="text-sm text-red-600 mt-3">{wbExportError}</div>}
        </section>
      )}

      {palletOpen && (
        <section className="panel">
          <div className="panel-header">
            <div className="panel-header__title">Распределение по палетам</div>
            <div className="panel-actions">
              <button className="mrp-btn mrp-btn--ghost" onClick={() => setPalletOpen(false)}>
                Закрыть
              </button>
            </div>
          </div>
          <div className="pallet-toolbar">
            <label className="pallet-field">
              <span>Поставка</span>
              <select
                className="form-control"
                value={palletSupply}
                onChange={(e) => setPalletSupply(e.target.value)}
              >
                {palletColumns.map((col) => (
                  <option key={col.id} value={col.id}>
                    {col.title} · {col.subtitle}
                  </option>
                ))}
              </select>
            </label>
            <div className="pallet-toolbar__group">
              <label className="pallet-field pallet-field--compact">
                <span>Макс. вес, кг</span>
                <input
                  className="form-control"
                  type="number"
                  step="0.1"
                  value={palletMaxWeight}
                  onChange={(e) => setPalletMaxWeight(e.target.value)}
                  placeholder={String(palletLimits.maxWeightKg)}
                />
              </label>
              <label className="pallet-field pallet-field--compact">
                <span>Макс. высота, см</span>
                <input
                  className="form-control"
                  type="number"
                  step="0.1"
                  value={palletMaxHeight}
                  onChange={(e) => setPalletMaxHeight(e.target.value)}
                  placeholder={String(palletLimits.maxHeightCm)}
                />
              </label>
              <button className="mrp-btn mrp-btn--primary" onClick={handlePalletCalc}>
                Рассчитать
              </button>
              {palletPlan && palletPlan.pallets.length > 0 && (
                <>
                  <button className="mrp-btn mrp-btn--ghost" onClick={handlePalletPrint}>
                    Печать
                  </button>
                  {selectedPalletColumn?.channel === "WB" && (
                    <button className="mrp-btn mrp-btn--ghost" onClick={handleWbPackingPrint}>
                      Упаковочный лист WB
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {selectedPalletColumn && (
            <div className="pallet-meta">
              <div className="pallet-chip">
                Лимиты: {palletLimits.lengthCm}×{palletLimits.widthCm}×{palletLimits.maxHeightCm} см
              </div>
              <div className="pallet-chip">
                Объём: {palletLimits.maxVolumeM3.toFixed(3)} м³
              </div>
              <div className="pallet-chip">
                Допуск: {palletLimits.maxWeightToleranceKg} кг
              </div>
              <div className="pallet-chip">
                Тип:{" "}
                {selectedPalletColumn.channel === "WB"
                  ? selectedPalletColumn.supplyBoxTypeId === 5
                    ? "монопаллеты"
                    : selectedPalletColumn.supplyBoxTypeId === 1 || selectedPalletColumn.supplyBoxTypeId === 2
                      ? "короба"
                      : selectedPalletColumn.supplyBoxTypeId === 0
                        ? "виртуальная"
                        : "не определён"
                  : "не WB"}
              </div>
              {palletPlan && (
                <div className="pallet-chip pallet-chip--accent">
                  Палет: {palletPlan.pallets.length}, вес {palletPlan.totalWeightKg.toFixed(1)} кг, объём{" "}
                  {palletPlan.totalVolumeM3.toFixed(3)} м³
                </div>
              )}
            </div>
          )}

          {palletErrors.length > 0 && (
            <div className="pallet-alert pallet-alert--error">
              <div className="pallet-alert__title">Проверьте параметры товаров</div>
              <div className="pallet-alert__list">
                {palletErrors.map((err, idx) => (
                  <div key={`${err.itemId || idx}`} className="pallet-alert__item">
                    <div className="pallet-alert__code">{err.code || "—"}</div>
                    <div className="pallet-alert__msg">{err.message}</div>
                    {err.itemId && (
                      <button className="mrp-btn mrp-btn--ghost" onClick={() => openProductFromPallet(err.itemId)}>
                        Открыть товар
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {palletWarnings.length > 0 && (
            <div className="pallet-alert pallet-alert--warn">
              <div className="pallet-alert__title">Предупреждения</div>
              <div className="pallet-alert__list">
                {palletWarnings.map((warn, idx) => (
                  <div key={`${warn.itemId || idx}`} className="pallet-alert__item">
                    <div className="pallet-alert__code">{warn.code || "—"}</div>
                    <div className="pallet-alert__msg">{warn.message}</div>
                    {warn.itemId && (
                      <button className="mrp-btn mrp-btn--ghost" onClick={() => openProductFromPallet(warn.itemId)}>
                        Открыть товар
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {palletPlan && palletPlan.pallets.length > 0 && (
            <div className="pallet-grid">
              {palletPlan.pallets.map((pallet, idx) => {
                const totalWeight = pallet.weightKg + DEFAULT_PALLET_WEIGHT_KG;
                const maxGross = palletLimits.maxWeightKg + DEFAULT_PALLET_WEIGHT_KG;
                const remainingWeight = palletLimits.maxWeightKg - pallet.weightKg;
                const remainingHeight = palletLimits.maxHeightCm - pallet.heightCm;
                const remainingVolume = palletLimits.maxVolumeM3 - pallet.volumeM3;
                const incomplete = totalWeight <= maxGross * 0.8 && pallet.heightCm < palletLimits.maxHeightCm;
                const items = pallet.items.slice().sort((a, b) => {
                  const order = { heavy: 0, normal: 1, light: 2 } as const;
                  return order[a.weightClass] - order[b.weightClass];
                });
                return (
                  <div key={`pallet-${idx}`} className="pallet-card">
                    <div className="pallet-card__head">
                      <div className="pallet-card__title">Палета {idx + 1}</div>
                      {incomplete && <div className="pallet-card__tag">Неполная</div>}
                    </div>
                    <div className="pallet-stats">
                      <div>
                        <div className="pallet-stats__label">Масса</div>
                        <div className="pallet-stats__value">{totalWeight.toFixed(1)} кг</div>
                        <div className="pallet-stats__note">Без палеты {pallet.weightKg.toFixed(1)} кг</div>
                      </div>
                      <div>
                        <div className="pallet-stats__label">Высота</div>
                        <div className="pallet-stats__value">{pallet.heightCm.toFixed(1)} см</div>
                        <div className="pallet-stats__note">Лимит {palletLimits.maxHeightCm} см</div>
                      </div>
                      <div>
                        <div className="pallet-stats__label">Объём</div>
                        <div className="pallet-stats__value">{pallet.volumeM3.toFixed(3)} м³</div>
                        <div className="pallet-stats__note">Лимит {palletLimits.maxVolumeM3.toFixed(3)} м³</div>
                      </div>
                    </div>
                    {incomplete && (
                      <div className="pallet-remaining">
                        Можно добавить: {remainingWeight.toFixed(1)} кг, {remainingHeight.toFixed(1)} см,{" "}
                        {remainingVolume.toFixed(3)} м³
                      </div>
                    )}
                    <div className="pallet-items">
                      {items.map((it) => (
                        <div key={it.partId} className="pallet-item">
                          <div className="pallet-item__name">{it.name}</div>
                          <div className="pallet-item__code">{it.code}</div>
                          <div className="pallet-item__qty">{it.boxes} кор.</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {viewMode === "active" ? (
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
      ) : (
        <div className="mp-matrix-wrapper">
          <table className="mrp-table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>Канал</th>
                <th>Поставка</th>
                <th>Товар</th>
                <th>Кол-во</th>
                <th>Статус</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {historyVisible.map((row) => {
                const item = itemById.get(row.item_id);
                return (
                  <tr key={row.id}>
                    <td>{formatDateShort(row.plan_date)}</td>
                    <td>{channelIdMap[row.channel_id]?.name ?? row.channel_id}</td>
                    <td>{row.shipment_name ?? row.external_supply_id ?? "—"}</td>
                    <td>{item ? `${item.code} — ${item.name}` : row.item_id}</td>
                    <td>{row.qty}</td>
                    <td>{row.status}</td>
                    <td>
                      <div className="actions">
                        <button
                          className="mrp-btn mrp-btn--ghost mrp-btn--xs"
                          onClick={async () => { await restoreHistoryRow(row); await loadData(); }}
                        >
                          Вернуть
                        </button>
                        <button
                          className="mrp-btn mrp-btn--ghost mrp-btn--xs"
                          onClick={async () => { await cancelHistoryRow(row); await loadData(); }}
                        >
                          Отменить списание
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!historyVisible.length && (
                <tr>
                  <td colSpan={7} className="text-center text-slate-400">История пуста</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
