import { serve } from "https://deno.land/std@0.213.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.2";

type ChannelCode = "OZON" | "WB";

type SupplyOrder = {
  supply_order_id: string;
  order_number?: string;
  warehouse_id?: string;
  warehouse_name?: string;
  dest_warehouse_id?: string;
  dest_warehouse_name?: string;
  slot_from?: string;
  state?: string;
  state_updated_date?: string;
  supply_ids: string[];
  bundle_ids: string[];
};

type AggregatedItem = {
  barcode: string;
  qty: number;
  ozonSku?: string;
  wbSku?: string;
};

const SUPPLY_ORDER_STATES = {
  IMPORT: [
    "DATA_FILLING",
    "READY_TO_SUPPLY",
    "ACCEPTED_AT_SUPPLY_WAREHOUSE",
    "IN_TRANSIT",
    "ACCEPTANCE_AT_STORAGE_WAREHOUSE",
    "REPORTS_CONFIRMATION_AWAITING",
    "REPORT_REJECTED",
    "COMPLETED",
    "OVERDUE",
    "CANCELLED",
    "REJECTED_AT_SUPPLY_WAREHOUSE",
  ],
  SHIPPED: [
    "ACCEPTED_AT_SUPPLY_WAREHOUSE",
    "IN_TRANSIT",
    "ACCEPTANCE_AT_STORAGE_WAREHOUSE",
    "REPORTS_CONFIRMATION_AWAITING",
    "REPORT_REJECTED",
    "COMPLETED",
    "OVERDUE",
  ],
  REMOVE: ["CANCELLED", "REJECTED_AT_SUPPLY_WAREHOUSE"],
};
const WB_STATUS_IDS_DEFAULT = [1, 2, 3, 4, 5, 6];
const WB_SHIPPED_STATUS_IDS = new Set([4, 5, 6]);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const OZON_CLIENT_ID = Deno.env.get("OZON_CLIENT_ID");
const OZON_API_KEY = Deno.env.get("OZON_API_KEY");
const WB_API_TOKEN = Deno.env.get("WB_API_TOKEN");
const WB_CONTENT_TOKEN = Deno.env.get("WB_CONTENT_TOKEN");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const OZON_BASE = "https://api-seller.ozon.ru";
const WB_BASE = "https://supplies-api.wildberries.ru";

const logStep = (step: string, meta?: Record<string, unknown>) => {
  if (meta) {
    console.log(`[sync-mp-supply-plans] ${step} ${JSON.stringify(meta)}`);
  } else {
    console.log(`[sync-mp-supply-plans] ${step}`);
  }
};

const baseHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type,authorization,apikey,x-client-info",
};

const jsonResponse = (body: Record<string, unknown>, init?: ResponseInit) =>
  new Response(JSON.stringify(body, null, 2), {
    headers: baseHeaders,
    ...init,
  });

const chunk = <T>(arr: T[], size: number) => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const parseDateOnly = (raw?: string) => {
  const s = (raw ?? "").trim();
  if (!s) return null;
  let d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

const pickBarcode = (it: Record<string, unknown>) => {
  const cands = [
    it.barcode,
    it.bar_code,
    it.barcode_seller,
    it.barcode_supplier,
    Array.isArray(it.barcodes) ? it.barcodes[0] : null,
    it.sku_barcode,
    it.offer_barcode,
    it.ean,
    it.gtin,
  ];
  for (const v of cands) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
};

const pickOzonSku = (it: Record<string, unknown>) => {
  const cands = [
    it.offer_id,
    it.offerId,
    it.product_id,
    it.productId,
    it.sku,
    it.sku_id,
    it.skuId,
  ];
  for (const v of cands) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
};

const pickWbSku = (it: Record<string, unknown>) => {
  const cands = [it.vendorCode, it.nmID, it.nmId, it.nm_id, it.vendor_code];
  for (const v of cands) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
};

const ozonRequest = async (path: string, body?: Record<string, unknown>, opts?: { method?: string }) => {
  const clientId = (OZON_CLIENT_ID ?? "").replace(/\s+/g, "").trim();
  const apiKey = (OZON_API_KEY ?? "").replace(/\s+/g, "").trim();
  if (!clientId || !apiKey) throw new Error("OZON_CLIENT_ID / OZON_API_KEY не заданы");

  const url = `${OZON_BASE}${path}`;
  const payload = body ? JSON.stringify(body) : undefined;
  const method = opts?.method ?? "POST";

  let delay = 400;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const startedAt = Date.now();
    const res = await fetch(url, {
      method,
      headers: {
        "Client-Id": clientId,
        "Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: payload,
    });

    const durationMs = Date.now() - startedAt;
    logStep("ozonRequest", { path, status: res.status, durationMs, attempt });

    if (res.ok) return res.json();

    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 4000);
      continue;
    }

    throw new Error(`[${path}] OZON ${res.status}: ${text || res.statusText}`);
  }

  throw new Error("ozonRequest: исчерпаны попытки");
};

const wbRequest = async (path: string, opts?: { method?: string; body?: Record<string, unknown> }) => {
  const token = (WB_API_TOKEN || WB_CONTENT_TOKEN || "").replace(/[^\x21-\x7E]/g, "").trim();
  if (!token) throw new Error("WB_API_TOKEN/WB_CONTENT_TOKEN не задан");

  const url = `${WB_BASE}${path}`;
  const method = opts?.method ?? "GET";
  const payload = opts?.body ? JSON.stringify(opts.body) : undefined;

  let delay = 800;
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const startedAt = Date.now();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
      body: payload,
    });

    const durationMs = Date.now() - startedAt;
    logStep("wbRequest", { path, status: res.status, durationMs, attempt });

    if (res.ok) return res.json();

    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 8000);
      continue;
    }

    throw new Error(`[${path}] WB ${res.status}: ${text || res.statusText}`);
  }

  throw new Error("wbRequest: исчерпаны попытки");
};

const listFboSupplyOrderIds = async () => {
  const states = SUPPLY_ORDER_STATES.IMPORT;
  const LIMIT = 100;
  const ids: string[] = [];
  let lastId = "";

  for (let guard = 0; guard < 500; guard += 1) {
    const body = {
      filter: { states },
      last_id: String(lastId || ""),
      limit: LIMIT,
      sort_by: "ORDER_CREATION",
      sort_dir: "DESC",
    };

    const r = await ozonRequest("/v3/supply-order/list", body);
    const arr = Array.isArray(r?.order_ids) ? r.order_ids : [];
    logStep("ozon list page", { count: arr.length, lastId });
    if (!arr.length) break;

    for (const x of arr) ids.push(String(x));

    const next = String(r?.last_id || "").trim();
    if (!next || next === lastId) break;
    lastId = next;
  }

  return Array.from(new Set(ids));
};

const getSupplyOrdersInfo = async (ids: string[]) => {
  if (!ids.length) return [] as SupplyOrder[];
  const MAX = 50;
  const out: SupplyOrder[] = [];

  for (const slice of chunk(ids, MAX)) {
    logStep("ozon get orders slice", { count: slice.length });
    const r = await ozonRequest("/v3/supply-order/get", { order_ids: slice });
    const orders = Array.isArray(r?.orders) ? r.orders : [];

    for (const o of orders) {
      const orderId = String(o?.order_id ?? "").trim();
      if (!orderId) continue;

      const drop = o?.dropoff_warehouse || o?.drop_off_warehouse || {};
      const dropId = String(drop?.warehouse_id ?? "").trim();
      const dropName = String(drop?.name ?? "").trim();

      const slotFrom = String(o?.timeslot?.timeslot?.from ?? "").trim();
      const suppliesArr = Array.isArray(o?.supplies) ? o.supplies : [];
      const bundleIds: string[] = [];
      const supplyIds: string[] = [];
      let destId = "";
      let destName = "";

      for (const s of suppliesArr) {
        const bid = String(s?.bundle_id ?? "").trim();
        if (bid) bundleIds.push(bid);

        const sid = s?.supply_id != null ? String(s.supply_id).trim() : "";
        if (sid) supplyIds.push(sid);

        if (!destId) {
          const st = s?.storage_warehouse || {};
          destId = String(st?.warehouse_id ?? "").trim();
          destName = String(st?.name ?? "").trim();
        }
      }

      out.push({
        supply_order_id: orderId,
        order_number: String(o?.order_number ?? "").trim(),
        warehouse_id: dropId,
        warehouse_name: dropName,
        dest_warehouse_id: destId,
        dest_warehouse_name: destName,
        slot_from: slotFrom,
        state: String(o?.state ?? "").trim(),
        state_updated_date: String(o?.state_updated_date ?? "").trim(),
        supply_ids: supplyIds,
        bundle_ids: bundleIds,
      });
    }
  }

  return out;
};

const getFboSupplyItemsByBundles = async (bundleIds: string[]) => {
  const uniq = Array.from(new Set(bundleIds.filter(Boolean).map(String)));
  if (!uniq.length) return [] as Record<string, unknown>[];

  const items: Record<string, unknown>[] = [];
  const LIMIT = 100;
  let lastId = "";
  logStep("ozon bundles fetch", { bundleCount: uniq.length });

  for (let guard = 0; guard < 200; guard += 1) {
    const body: Record<string, unknown> = { bundle_ids: uniq, limit: LIMIT };
    if (lastId) body.last_id = lastId;

    const r = await ozonRequest("/v1/supply-order/bundle", body);
    const page = Array.isArray(r?.items) ? r.items : Array.isArray(r?.result?.items) ? r.result.items : [];
    logStep("ozon bundles page", { count: page.length, lastId });
    if (!page.length) break;

    items.push(...page);

    const hasNext = (r?.has_next ?? r?.result?.has_next) === true;
    lastId = String(r?.last_id || r?.result?.last_id || "").trim();
    if (!hasNext || !lastId) break;
  }

  return items;
};

const aggregateSupplyItems = (items: Record<string, unknown>[]) => {
  const map = new Map<string, AggregatedItem>();
  for (const it of items) {
    const barcode = pickBarcode(it as Record<string, unknown>);
    if (!barcode) continue;
    const qty = Number((it as any)?.quantity ?? (it as any)?.qty ?? (it as any)?.count ?? 0) || 0;
    const sku = pickOzonSku(it as Record<string, unknown>);
    const wbSku = pickWbSku(it as Record<string, unknown>);

    const prev = map.get(barcode);
    if (prev) {
      prev.qty += qty;
      if (!prev.ozonSku && sku) prev.ozonSku = sku;
      if (!prev.wbSku && wbSku) prev.wbSku = wbSku;
    } else {
      map.set(barcode, { barcode, qty, ozonSku: sku || undefined, wbSku: wbSku || undefined });
    }
  }
  return Array.from(map.values());
};

const fetchChannelId = async (code: ChannelCode) => {
  const { data, error } = await supabase
    .from("mp_channels")
    .select("id")
    .eq("code", code)
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) throw new Error(`Не найден канал ${code}`);
  return data.id as string;
};

type PalletLimits = {
  length_cm: number;
  width_cm: number;
  max_height_cm: number;
  pallet_height_cm: number;
  max_weight_kg: number;
  max_weight_tolerance_kg: number;
  max_volume_m3: number;
};

type DestinationMeta = {
  pallet_limits?: {
    box?: Partial<PalletLimits>;
    mono?: Partial<PalletLimits>;
  };
  [key: string]: unknown;
};

const DEFAULT_PALLET_LIMITS: PalletLimits = {
  length_cm: 120,
  width_cm: 80,
  max_height_cm: 180,
  pallet_height_cm: 14,
  max_weight_kg: 510,
  max_weight_tolerance_kg: 1,
  max_volume_m3: 1.728,
};

const ensurePalletMetaDefaults = (meta?: DestinationMeta | null) => {
  const base: DestinationMeta = meta && typeof meta === "object" ? { ...meta } : {};
  const limits = (base.pallet_limits && typeof base.pallet_limits === "object")
    ? { ...base.pallet_limits }
    : {};
  let changed = false;

  const ensureMode = (mode: "box" | "mono") => {
    const current = (limits as any)[mode];
    if (!current || typeof current !== "object") {
      (limits as any)[mode] = { ...DEFAULT_PALLET_LIMITS };
      changed = true;
      return;
    }
    const merged = { ...DEFAULT_PALLET_LIMITS, ...current };
    const same = Object.keys(DEFAULT_PALLET_LIMITS).every(
      (k) => (current as any)[k] === (merged as any)[k],
    );
    if (!same) {
      (limits as any)[mode] = merged;
      changed = true;
    }
  };

  ensureMode("box");
  ensureMode("mono");

  if (changed) {
    base.pallet_limits = limits as DestinationMeta["pallet_limits"];
  }

  return { meta: base, changed };
};

const fetchDestinationsMap = async (channelId: string) => {
  const { data, error } = await supabase
    .from("mp_destinations")
    .select("id, external_id, name, meta")
    .eq("channel_id", channelId);
  if (error) throw error;
  const map = new Map<string, { id: string; name: string; meta?: DestinationMeta | null }>();
  for (const row of data ?? []) {
    const ext = String((row as any).external_id ?? "").trim();
    if (!ext) continue;
    map.set(ext, { id: row.id, name: row.name, meta: (row as any).meta ?? null });
  }
  return map;
};

const ensureDestination = async (
  channelId: string,
  destMap: Map<string, { id: string; name: string; meta?: DestinationMeta | null }>,
  externalId?: string,
  name?: string,
  fallbackLabel?: string,
) => {
  const ext = String(externalId ?? "").trim();
  if (!ext) return null;
  const existing = destMap.get(ext);
  if (existing) {
    const { meta: nextMeta, changed } = ensurePalletMetaDefaults(existing.meta ?? null);
    if (changed) {
      const { error: updateErr } = await supabase
        .from("mp_destinations")
        .update({ meta: nextMeta, updated_at: new Date().toISOString() })
        .eq("id", existing.id);
      if (updateErr) throw updateErr;
      existing.meta = nextMeta;
    }
    return existing.id;
  }

  const row = {
    channel_id: channelId,
    external_id: ext,
    name: name?.trim() || `${fallbackLabel ?? "Склад"} ${ext}`,
    is_active: true,
    meta: ensurePalletMetaDefaults(null).meta,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("mp_destinations")
    .insert(row)
    .select("id, name, meta")
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) return null;

  destMap.set(ext, { id: data.id, name: data.name, meta: (data as any).meta ?? null });
  return data.id as string;
};

const fetchItemMap = async (barcodes: string[]) => {
  const barcodeList = Array.from(new Set(barcodes.map((b) => String(b).trim()).filter(Boolean)));
  const byBarcode = new Map<string, { itemId: string }>();
  const itemById = new Map<string, { ozonSku?: string | null; wbSku?: string | null }>();

  if (!barcodeList.length) return { byBarcode, itemById };

  for (const slice of chunk(barcodeList, 200)) {
    const { data, error } = await supabase
      .from("items")
      .select("id, barcode, ozon_sku, wb_sku")
      .in("barcode", slice);
    if (error) throw error;
    for (const row of data ?? []) {
      const bc = String((row as any).barcode ?? "").trim();
      if (!bc) continue;
      byBarcode.set(bc, { itemId: row.id });
      itemById.set(row.id, {
        ozonSku: (row as any).ozon_sku ?? null,
        wbSku: (row as any).wb_sku ?? null,
      });
    }
  }

  for (const slice of chunk(barcodeList, 200)) {
    const { data, error } = await supabase
      .from("item_barcodes")
      .select("item_id, barcode")
      .in("barcode", slice);
    if (error) throw error;
    for (const row of data ?? []) {
      const bc = String((row as any).barcode ?? "").trim();
      const itemId = String((row as any).item_id ?? "").trim();
      if (!bc || !itemId || byBarcode.has(bc)) continue;
      byBarcode.set(bc, { itemId });
    }
  }

  const missingItemIds = new Set<string>();
  for (const entry of byBarcode.values()) {
    if (!itemById.has(entry.itemId)) missingItemIds.add(entry.itemId);
  }

  if (missingItemIds.size) {
    for (const slice of chunk(Array.from(missingItemIds), 200)) {
      const { data, error } = await supabase
        .from("items")
        .select("id, ozon_sku, wb_sku")
        .in("id", slice);
      if (error) throw error;
      for (const row of data ?? []) {
        itemById.set(row.id, {
          ozonSku: (row as any).ozon_sku ?? null,
          wbSku: (row as any).wb_sku ?? null,
        });
      }
    }
  }

  return { byBarcode, itemById };
};

const updateOzonSkus = async (updates: Array<{ id: string; ozon_sku: string }>) => {
  if (!updates.length) return { updated: 0 };
  let updated = 0;
  for (const row of updates) {
    const { error } = await supabase
      .from("items")
      .update({ ozon_sku: row.ozon_sku })
      .eq("id", row.id);
    if (error) throw error;
    updated += 1;
  }
  return { updated };
};

const updateWbSkus = async (updates: Array<{ id: string; wb_sku: string }>) => {
  if (!updates.length) return { updated: 0 };
  let updated = 0;
  for (const row of updates) {
    const { error } = await supabase
      .from("items")
      .update({ wb_sku: row.wb_sku })
      .eq("id", row.id);
    if (error) throw error;
    updated += 1;
  }
  return { updated };
};

const syncOzonSupplyPlans = async () => {
  const MAX_ORDERS_PER_RUN = 20;
  const startedAt = Date.now();
  logStep("ozon sync start");
  const channelId = await fetchChannelId("OZON");
  const destMap = await fetchDestinationsMap(channelId);

  const ids = await listFboSupplyOrderIds();
  logStep("ozon list ids done", { count: ids.length });
  if (!ids.length) return { imported: 0, skipped: 0, unknown: 0 };

  const orders = await getSupplyOrdersInfo(ids);
  logStep("ozon orders loaded", { count: orders.length });
  const removalOrders = orders.filter((o) => {
    const state = String(o.state ?? "").trim();
    return SUPPLY_ORDER_STATES.REMOVE.includes(state);
  });
  const activeAll = orders.filter((o) => {
    const state = String(o.state ?? "").trim();
    return !SUPPLY_ORDER_STATES.REMOVE.includes(state) && SUPPLY_ORDER_STATES.IMPORT.includes(state);
  });
  const pendingOrders = activeAll.filter((o) => !SUPPLY_ORDER_STATES.SHIPPED.includes(String(o.state ?? "").trim()));
  const shippedOrdersAll = activeAll.filter((o) => SUPPLY_ORDER_STATES.SHIPPED.includes(String(o.state ?? "").trim()));
  let shippedOrders = shippedOrdersAll;
  const shippedCap = Math.max(MAX_ORDERS_PER_RUN - pendingOrders.length, 0);
  if (shippedOrders.length > shippedCap) {
    shippedOrders = shippedOrders.slice(0, shippedCap);
    logStep("ozon orders capped", {
      cap: MAX_ORDERS_PER_RUN,
      pending: pendingOrders.length,
      shipped: shippedOrders.length,
      total: orders.length,
    });
  }
  const active = [...pendingOrders, ...shippedOrders];
  logStep("ozon orders split", {
    removal: removalOrders.length,
    active: active.length,
    pending: pendingOrders.length,
    shipped: shippedOrders.length,
  });

  const orderItems = [] as Array<{ order: SupplyOrder; items: AggregatedItem[] }>;
  const allBarcodes = new Set<string>();
  const shippedExternalIdsAll = new Set<string>();

  for (const order of shippedOrdersAll) {
    const displayId = order.supply_ids?.[0] || order.supply_order_id || order.order_number || "";
    const externalSupplyId = order.supply_order_id || displayId;
    if (externalSupplyId) shippedExternalIdsAll.add(externalSupplyId);
  }

  for (const order of removalOrders) {
    const displayId = order.supply_ids?.[0] || order.supply_order_id || order.order_number || "";
    const externalSupplyId = order.supply_order_id || displayId;
    if (!externalSupplyId) continue;
    logStep("ozon remove order", { externalSupplyId });
    const { data: planIds, error: plansErr } = await supabase
      .from("mp_supply_plans")
      .select("id")
      .eq("channel_id", channelId)
      .eq("external_supply_id", externalSupplyId);
    if (plansErr) throw plansErr;
    const idsToRemove = (planIds ?? []).map((r) => r.id);
    if (idsToRemove.length) {
      const { error: moveErr } = await supabase
        .from("stock_movements")
        .delete()
        .eq("doc_type", "mp_supply")
        .in("doc_id", idsToRemove);
      if (moveErr) throw moveErr;
    }
    const { error: deleteErr } = await supabase
      .from("mp_supply_plans")
      .delete()
      .eq("channel_id", channelId)
      .eq("external_supply_id", externalSupplyId);
    if (deleteErr) throw deleteErr;
  }

  for (const order of active) {
    const itemsRaw = await getFboSupplyItemsByBundles(order.bundle_ids);
    const agg = aggregateSupplyItems(itemsRaw);
    if (!agg.length) continue;
    for (const it of agg) allBarcodes.add(it.barcode);
    orderItems.push({ order, items: agg });
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!orderItems.length) return { imported: 0, skipped: 0, unknown: 0 };

  const { byBarcode, itemById } = await fetchItemMap(Array.from(allBarcodes));
  logStep("ozon barcodes mapped", { barcodes: byBarcode.size, items: itemById.size });
  const nowIso = new Date().toISOString();
  const supplyRows: any[] = [];
  const shippedRows: any[] = [];
  const shippedExternalIds = new Set<string>();
  const shippedExternalIdsWithItems = new Set<string>();
  const cleanupQueue: Array<{ externalSupplyId: string; itemIds: string[] }> = [];
  const skuUpdates: Array<{ id: string; ozon_sku: string }> = [];
  let unknown = 0;

  for (const { order, items } of orderItems) {
    const planDateObj = parseDateOnly(order.slot_from);
    if (!planDateObj) continue;
    const planDate = planDateObj.toISOString().slice(0, 10);

    const displayId = order.supply_ids?.[0] || order.supply_order_id || order.order_number || "";
    const externalSupplyId = order.supply_order_id || displayId;
    const srcName = order.warehouse_name || order.warehouse_id || "Склад";
    const destName = order.dest_warehouse_name || order.dest_warehouse_id || "";
    const shipmentName = destName
      ? `${srcName} → ${destName} • ${displayId}`
      : `${srcName} • ${displayId}`;
    const orderState = String(order.state ?? "").trim();
    const isShipped = SUPPLY_ORDER_STATES.SHIPPED.includes(orderState);
    if (isShipped && externalSupplyId) shippedExternalIds.add(externalSupplyId);
    const shippedAt = (() => {
      const raw = String(order.state_updated_date ?? "").trim();
      if (!raw) return null;
      const dt = new Date(raw);
      if (Number.isNaN(dt.getTime())) return null;
      return dt.toISOString();
    })();

    const destinationId = await ensureDestination(
      channelId,
      destMap,
      order.dest_warehouse_id,
      order.dest_warehouse_name,
      "Ozon склад",
    );

    const matchedItemIds: string[] = [];

    for (const it of items) {
      const mapped = byBarcode.get(it.barcode);
      if (!mapped?.itemId) {
        unknown += 1;
        continue;
      }

      matchedItemIds.push(mapped.itemId);
      const itemMeta = itemById.get(mapped.itemId);
      const existingSku = itemMeta?.ozonSku;
      if (itemMeta && !existingSku && it.ozonSku) {
        skuUpdates.push({ id: mapped.itemId, ozon_sku: it.ozonSku });
        itemById.set(mapped.itemId, { ozonSku: it.ozonSku, wbSku: itemMeta.wbSku ?? null });
      }

      if (isShipped) {
        shippedRows.push({
          external_supply_id: externalSupplyId || null,
          item_id: mapped.itemId,
        });
        if (externalSupplyId) shippedExternalIdsWithItems.add(externalSupplyId);
      } else {
        supplyRows.push({
          channel_id: channelId,
          destination_id: destinationId,
          item_id: mapped.itemId,
          plan_date: planDate,
          qty: it.qty,
          status: "planned",
          shipment_name: shipmentName,
          shipment_date: null,
          shipped_at: null,
          planned_by: "import:ozon",
          comment: order.state ? `ozon_state=${order.state}` : null,
          external_supply_id: externalSupplyId || null,
          supply_box_type_id: null,
          updated_at: nowIso,
        });
      }
    }

    if (externalSupplyId && matchedItemIds.length) {
      cleanupQueue.push({ externalSupplyId, itemIds: matchedItemIds });
    }
  }

  if (skuUpdates.length) {
    const dedup = new Map<string, string>();
    for (const row of skuUpdates) {
      if (!dedup.has(row.id)) dedup.set(row.id, row.ozon_sku);
    }
    await updateOzonSkus(Array.from(dedup, ([id, ozon_sku]) => ({ id, ozon_sku })));
    logStep("ozon sku updates", { count: dedup.size });
  }

  if (shippedRows.length) {
    const extIds = Array.from(new Set(shippedRows.map((r) => String(r.external_supply_id ?? "").trim()).filter(Boolean)));
    const itemIds = Array.from(new Set(shippedRows.map((r) => String(r.item_id ?? "").trim()).filter(Boolean)));
    if (extIds.length && itemIds.length) {
      const historyRows: any[] = [];
      for (const extSlice of chunk(extIds, 200)) {
        for (const itemSlice of chunk(itemIds, 200)) {
          const { data, error } = await supabase
            .from("mp_supply_plans_history")
            .select("external_supply_id, item_id, status")
            .eq("channel_id", channelId)
            .in("external_supply_id", extSlice)
            .in("item_id", itemSlice);
          if (error) throw error;
          if (data?.length) historyRows.push(...data);
        }
      }

      const shippedKeys = new Set(
        historyRows
          .filter((r) => String(r.status) === "shipped")
          .map((r) => `${String(r.external_supply_id)}:${String(r.item_id)}`),
      );
      const shippedExtIds = Array.from(
        new Set(
          historyRows
            .filter((r) => String(r.status) === "shipped")
            .map((r) => String(r.external_supply_id ?? "").trim())
            .filter(Boolean),
        ),
      );

      if (shippedKeys.size) {
        const beforeSupply = supplyRows.length;
        const beforeShipped = shippedRows.length;
        const filteredSupply = supplyRows.filter((row) => {
          if (row.status !== "shipped") return true;
          const key = `${String(row.external_supply_id ?? "")}:${String(row.item_id ?? "")}`;
          return !shippedKeys.has(key);
        });
        const filteredShipped = shippedRows.filter((row) => {
          const key = `${String(row.external_supply_id ?? "")}:${String(row.item_id ?? "")}`;
          return !shippedKeys.has(key);
        });
        supplyRows.length = 0;
        supplyRows.push(...filteredSupply);
        shippedRows.length = 0;
        shippedRows.push(...filteredShipped);
        logStep("ozon shipped already archived", {
          supplyDropped: beforeSupply - filteredSupply.length,
          shippedDropped: beforeShipped - filteredShipped.length,
        });

        if (shippedExtIds.length) {
          for (const extId of shippedExtIds) {
            const { error: delErr } = await supabase
              .from("mp_supply_plans")
              .delete()
              .eq("channel_id", channelId)
              .eq("external_supply_id", extId);
            if (delErr) throw delErr;

            const { error: legacyDelErr } = await supabase
              .from("mp_supply_plans")
              .delete()
              .eq("channel_id", channelId)
              .is("external_supply_id", null)
              .ilike("shipment_name", `%${extId}%`);
            if (legacyDelErr) throw legacyDelErr;
          }
          logStep("ozon cleaned archived plans", { extIds: shippedExtIds.length });
        }
      }
    }
  }

  if (shippedExternalIdsAll.size) {
    const shippedExtIds = Array.from(shippedExternalIdsAll);
    const shippedPlans: any[] = [];

    for (const extSlice of chunk(shippedExtIds, 200)) {
      const { data, error } = await supabase
        .from("mp_supply_plans")
        .select(
          "id, channel_id, destination_id, item_id, plan_date, qty, status, shipment_name, shipment_date, shipped_at, planned_by, comment, external_supply_id, supply_box_type_id, created_at, updated_at",
        )
        .eq("channel_id", channelId)
        .in("external_supply_id", extSlice);
      if (error) throw error;
      if (data?.length) shippedPlans.push(...data);
    }

    if (shippedPlans.length) {
      const { data: whData, error: whErr } = await supabase
        .from("warehouses")
        .select("id")
        .eq("type", "physical")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (whErr) throw whErr;
      const warehouseId = whData?.id;

      if (warehouseId) {
        const planIds = shippedPlans.map((p) => p.id);
        const { data: existingMoves, error: moveErr } = await supabase
          .from("stock_movements")
          .select("doc_id")
          .eq("doc_type", "mp_supply")
          .in("doc_id", planIds);
        if (moveErr) throw moveErr;
        const existing = new Set((existingMoves ?? []).map((m) => m.doc_id));

        const inserts = shippedPlans
          .filter((p) => !existing.has(p.id))
          .map((p) => ({
            doc_type: "mp_supply",
            doc_id: p.id,
            item_id: p.item_id,
            warehouse_id: warehouseId,
            qty: Number(p.qty ?? 0) * -1,
            created_at: nowIso,
          }))
          .filter((p) => Number(p.qty) !== 0);

        if (inserts.length) {
          for (const slice of chunk(inserts, 500)) {
            const { error: insErr } = await supabase.from("stock_movements").insert(slice);
            if (insErr) throw insErr;
          }
        }
      }

      const historyRows = shippedPlans.map((row) => ({
        source_plan_id: row.id,
        channel_id: row.channel_id,
        destination_id: row.destination_id,
        item_id: row.item_id,
        plan_date: row.plan_date,
        qty: row.qty,
        status: "shipped",
        shipment_name: row.shipment_name,
        shipment_date: row.shipment_date,
        shipped_at: nowIso,
        planned_by: row.planned_by,
        comment: row.comment,
        external_supply_id: row.external_supply_id,
        supply_box_type_id: row.supply_box_type_id ?? null,
        archived_at: nowIso,
        created_at: row.created_at,
        updated_at: row.updated_at ?? nowIso,
      }));

      for (const slice of chunk(historyRows, 500)) {
        const { error: histErr } = await supabase
          .from("mp_supply_plans_history")
          .upsert(slice, { onConflict: "source_plan_id" });
        if (histErr) throw histErr;
      }

      const planIds = shippedPlans.map((p) => p.id);
      for (const slice of chunk(planIds, 500)) {
        const { error: delErr } = await supabase.from("mp_supply_plans").delete().in("id", slice);
        if (delErr) throw delErr;
      }

      logStep("ozon archive shipped by ext", { count: shippedPlans.length, extIds: shippedExtIds.length });
    }
  }

  const shippedWithoutItems = Array.from(shippedExternalIds).filter((id) => !shippedExternalIdsWithItems.has(id));
  if (shippedWithoutItems.length) {
    const shippedPlans: any[] = [];
    for (const extSlice of chunk(shippedWithoutItems, 200)) {
      const { data, error } = await supabase
        .from("mp_supply_plans")
        .select(
          "id, channel_id, destination_id, item_id, plan_date, qty, status, shipment_name, shipment_date, shipped_at, planned_by, comment, external_supply_id, supply_box_type_id, created_at, updated_at",
        )
        .eq("channel_id", channelId)
        .in("external_supply_id", extSlice);
      if (error) throw error;
      if (data?.length) shippedPlans.push(...data);
    }

    if (shippedPlans.length) {
      const historyRows = shippedPlans.map((row) => ({
        source_plan_id: row.id,
        channel_id: row.channel_id,
        destination_id: row.destination_id,
        item_id: row.item_id,
        plan_date: row.plan_date,
        qty: row.qty,
        status: "shipped",
        shipment_name: row.shipment_name,
        shipment_date: row.shipment_date,
        shipped_at: nowIso,
        planned_by: row.planned_by,
        comment: row.comment,
        external_supply_id: row.external_supply_id,
        supply_box_type_id: row.supply_box_type_id ?? null,
        archived_at: nowIso,
        created_at: row.created_at,
        updated_at: row.updated_at ?? nowIso,
      }));

      for (const slice of chunk(historyRows, 500)) {
        const { error: histErr } = await supabase
          .from("mp_supply_plans_history")
          .upsert(slice, { onConflict: "source_plan_id" });
        if (histErr) throw histErr;
      }

      const planIds = shippedPlans.map((p) => p.id);
      for (const slice of chunk(planIds, 500)) {
        const { error: delErr } = await supabase.from("mp_supply_plans").delete().in("id", slice);
        if (delErr) throw delErr;
      }

      logStep("ozon archive shipped (no items)", { count: shippedPlans.length });
    }
  }

  if (supplyRows.length) {
    for (const slice of chunk(supplyRows, 500)) {
      const { error } = await supabase
        .from("mp_supply_plans")
        .upsert(slice, { onConflict: "channel_id,external_supply_id,item_id" });
      if (error) throw error;
    }
    logStep("ozon upsert plans", { count: supplyRows.length });
  }

  if (shippedRows.length) {
    const { data: whData, error: whErr } = await supabase
      .from("warehouses")
      .select("id")
      .eq("type", "physical")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (whErr) throw whErr;
    const warehouseId = whData?.id;
    if (warehouseId) {
      const shippedByExt = new Map<string, string[]>();
      for (const row of shippedRows) {
        const extId = String(row.external_supply_id ?? "").trim();
        const itemId = String(row.item_id ?? "").trim();
        if (!extId || !itemId) continue;
        const list = shippedByExt.get(extId) ?? [];
        list.push(itemId);
        shippedByExt.set(extId, list);
      }

      for (const [extId, itemIds] of shippedByExt.entries()) {
        if (!itemIds.length) continue;
        const { data: plans, error: planErr } = await supabase
          .from("mp_supply_plans")
          .select("id, item_id, qty")
          .eq("channel_id", channelId)
          .eq("external_supply_id", extId)
          .in("item_id", itemIds);
        if (planErr) throw planErr;
        if (!plans?.length) continue;

        const planIds = plans.map((p) => p.id);
        const { data: existingMoves, error: moveErr } = await supabase
          .from("stock_movements")
          .select("doc_id")
          .eq("doc_type", "mp_supply")
          .in("doc_id", planIds);
        if (moveErr) throw moveErr;
        const existing = new Set((existingMoves ?? []).map((m) => m.doc_id));

        const inserts = plans
          .filter((p) => !existing.has(p.id))
          .map((p) => ({
            doc_type: "mp_supply",
            doc_id: p.id,
            item_id: p.item_id,
            warehouse_id: warehouseId,
            qty: Number(p.qty ?? 0) * -1,
            created_at: nowIso,
          }))
          .filter((p) => Number(p.qty) !== 0);

        if (inserts.length) {
          for (const slice of chunk(inserts, 500)) {
            const { error: insErr } = await supabase.from("stock_movements").insert(slice);
            if (insErr) throw insErr;
          }
        }
      }
      logStep("ozon stock movements", { shippedPlans: shippedRows.length });
    }
  }

  if (shippedRows.length) {
    const extIds = Array.from(new Set(shippedRows.map((r) => String(r.external_supply_id ?? "").trim()).filter(Boolean)));
    const itemIds = Array.from(new Set(shippedRows.map((r) => String(r.item_id ?? "").trim()).filter(Boolean)));
    if (extIds.length && itemIds.length) {
      const shippedPlans: any[] = [];
      for (const extSlice of chunk(extIds, 200)) {
        for (const itemSlice of chunk(itemIds, 200)) {
          const { data, error } = await supabase
            .from("mp_supply_plans")
            .select(
              "id, channel_id, destination_id, item_id, plan_date, qty, status, shipment_name, shipment_date, shipped_at, planned_by, comment, external_supply_id, supply_box_type_id, created_at, updated_at",
            )
            .eq("channel_id", channelId)
            .in("external_supply_id", extSlice)
            .in("item_id", itemSlice);
          if (error) throw error;
          if (data?.length) shippedPlans.push(...data);
        }
      }

      if (shippedPlans.length) {
        const historyRows = shippedPlans.map((row) => ({
          source_plan_id: row.id,
          channel_id: row.channel_id,
          destination_id: row.destination_id,
          item_id: row.item_id,
          plan_date: row.plan_date,
          qty: row.qty,
          status: "shipped",
          shipment_name: row.shipment_name,
          shipment_date: row.shipment_date,
          shipped_at: nowIso,
          planned_by: row.planned_by,
          comment: row.comment,
          external_supply_id: row.external_supply_id,
          supply_box_type_id: row.supply_box_type_id ?? null,
          archived_at: nowIso,
          created_at: row.created_at,
          updated_at: row.updated_at ?? nowIso,
        }));

        for (const slice of chunk(historyRows, 500)) {
          const { error: histErr } = await supabase
            .from("mp_supply_plans_history")
            .upsert(slice, { onConflict: "source_plan_id" });
          if (histErr) throw histErr;
        }

        const planIds = shippedPlans.map((p) => p.id);
        for (const slice of chunk(planIds, 500)) {
          const { error: delErr } = await supabase.from("mp_supply_plans").delete().in("id", slice);
          if (delErr) throw delErr;
        }

        logStep("ozon archive shipped", { count: shippedPlans.length });
      }
    }
  }

  for (const task of cleanupQueue) {
    if (!task.itemIds.length) continue;
    if (task.itemIds.length > 1000) continue;
    const inList = `(${task.itemIds.map((id) => `"${id}"`).join(",")})`;
    const { error } = await supabase
      .from("mp_supply_plans")
      .delete()
      .eq("channel_id", channelId)
      .eq("external_supply_id", task.externalSupplyId)
      .not("item_id", "in", inList);
    if (error) throw error;
  }

  logStep("ozon sync done", { imported: supplyRows.length, unknown, durationMs: Date.now() - startedAt });
  return { imported: supplyRows.length, skipped: 0, unknown };
};

const listWbSupplies = async (
  statusIds: number[],
  fromDate: string,
  tillDate: string,
  dateType: "createDate" | "supplyDate" | "factDate" = "createDate",
) => {
  const supplies: any[] = [];
  let next: string | number | null = null;

  for (let guard = 0; guard < 200; guard += 1) {
    const body: Record<string, unknown> = {
      dates: [{ from: fromDate, till: tillDate, type: dateType }],
    };
    if (statusIds.length) body.statusIDs = statusIds;
    if (next) body.next = next;

    const r = await wbRequest("/api/v1/supplies", { method: "POST", body });
    const page = Array.isArray(r?.supplies) ? r.supplies : Array.isArray(r) ? r : [];
    supplies.push(...page);

    const nxt = r?.next;
    if (!nxt) break;
    next = nxt;
  }

  return supplies;
};

const getWbSupplyDetails = async (supplyId: string) =>
  wbRequest(`/api/v1/supplies/${supplyId}`, { method: "GET" });

const pickBoxTypeId = (src: any): number | null => {
  if (!src || typeof src !== "object") return null;
  const raw =
    src.boxTypeID ??
    src.boxTypeId ??
    src.box_type_id ??
    src.boxType ??
    src.box_type ??
    src?.supply?.boxTypeID ??
    src?.supply?.boxTypeId ??
    src?.supply?.box_type_id ??
    src?.supply?.boxType ??
    src?.supply?.box_type;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
};

const getWbSupplyGoods = async (supplyId: string) => {
  const goods = await wbRequest(`/api/v1/supplies/${supplyId}/goods`, { method: "GET" });
  return Array.isArray(goods) ? goods : [];
};

const syncWbSupplyPlans = async (statusIds: number[]) => {
  const channelId = await fetchChannelId("WB");
  const destMap = await fetchDestinationsMap(channelId);

  const today = new Date();
  const from = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000);
  const fromDate = from.toISOString().slice(0, 10);
  const tillDate = today.toISOString().slice(0, 10);

  const supplies = await listWbSupplies(statusIds, fromDate, tillDate, "createDate");
  if (!supplies.length) return { imported: 0, skipped: 0, unknown: 0 };

  const shippedSupplyIdsFromList = supplies
    .map((s) => ({
      id: String(s?.supplyID ?? s?.supplyId ?? "").trim(),
      statusId: Number(s?.statusID ?? s?.statusId ?? s?.status),
    }))
    .filter((s) => s.id && Number.isFinite(s.statusId) && WB_SHIPPED_STATUS_IDS.has(s.statusId))
    .map((s) => s.id);
  const listSupplyIds = new Set(
    supplies
      .map((s) => String(s?.supplyID ?? s?.supplyId ?? "").trim())
      .filter(Boolean),
  );

  const pendingSupplies = supplies.filter((s) => {
    const id = String(s?.supplyID ?? s?.supplyId ?? "").trim();
    if (!id) return false;
    const statusId = Number(s?.statusID ?? s?.statusId ?? s?.status);
    if (Number.isFinite(statusId) && WB_SHIPPED_STATUS_IDS.has(statusId)) return false;
    return true;
  });

  logStep("wb supplies listed", { total: supplies.length, shipped: shippedSupplyIdsFromList.length, pending: pendingSupplies.length });

  const allBarcodes = new Set<string>();
  const supplyItems: Array<{
    supplyId: string;
    info: any;
    listStatusId?: number | null;
    listBoxTypeId?: number | null;
    items: AggregatedItem[];
  }> = [];

  const listBoxTypeById = new Map<string, number>();
  for (const s of pendingSupplies) {
    const sid = String(s?.supplyID ?? s?.supplyId ?? "").trim();
    if (!sid) continue;
    const val = pickBoxTypeId(s);
    if (val != null) listBoxTypeById.set(sid, val);
  }

  for (const s of pendingSupplies) {
    const supplyId = String(s?.supplyID ?? s?.supplyId ?? "").trim();
    if (!supplyId) continue;
    const listStatusIdRaw = s?.statusID ?? s?.statusId ?? s?.status;
    const listStatusId = Number.isFinite(Number(listStatusIdRaw)) ? Number(listStatusIdRaw) : null;
    const info = await getWbSupplyDetails(supplyId);
    const goodsRaw = await getWbSupplyGoods(supplyId);
    const agg = aggregateSupplyItems(goodsRaw);
    await new Promise((r) => setTimeout(r, 120));
    if (agg.length) {
      for (const it of agg) allBarcodes.add(it.barcode);
      supplyItems.push({
        supplyId,
        info,
        listStatusId,
        listBoxTypeId: listBoxTypeById.get(supplyId) ?? null,
        items: agg,
      });
    }
  }

  if (!supplyItems.length && !shippedSupplyIdsFromList.length) {
    return { imported: 0, skipped: 0, unknown: 0 };
  }

  const { byBarcode, itemById } = supplyItems.length
    ? await fetchItemMap(Array.from(allBarcodes))
    : { byBarcode: new Map<string, { itemId: string }>(), itemById: new Map<string, any>() };
  const nowIso = new Date().toISOString();
  const supplyRows: any[] = [];
  const shippedRows: Array<{ external_supply_id: string; item_id: string }> = [];
  const shippedExternalIdsAll = new Set<string>(shippedSupplyIdsFromList);
  const skuUpdates: Array<{ id: string; wb_sku: string }> = [];
  const cleanupQueue: Array<{ externalSupplyId: string; itemIds: string[] }> = [];
  let unknown = 0;

  for (const row of supplyItems) {
    const planDate = parseDateOnly(row.info?.supplyDate || row.info?.createDate);
    if (!planDate) continue;
    const planDateISO = planDate.toISOString().slice(0, 10);
    const boxTypeId = pickBoxTypeId(row.info) ?? row.listBoxTypeId ?? null;

    const whId = String(row.info?.warehouseID ?? row.info?.warehouseId ?? "").trim();
    const whName = String(row.info?.warehouseName ?? "").trim();
    const shipmentName = whName ? `${whName} • ${row.supplyId}` : row.supplyId;
    const destinationId = await ensureDestination(channelId, destMap, whId, whName, "WB склад");
    const statusId = Number(
      row.info?.statusID ??
        row.info?.statusId ??
        row.info?.status_id ??
        row.info?.status ??
        row.listStatusId,
    );
    const isShipped = Number.isFinite(statusId) && WB_SHIPPED_STATUS_IDS.has(statusId);
    if (isShipped) shippedExternalIdsAll.add(row.supplyId);

    const matchedItemIds: string[] = [];

    for (const it of row.items) {
      const mapped = byBarcode.get(it.barcode);
      if (!mapped?.itemId) {
        unknown += 1;
        continue;
      }
      matchedItemIds.push(mapped.itemId);
      const itemMeta = itemById.get(mapped.itemId);
      const existingSku = itemMeta?.wbSku;
      if (itemMeta && !existingSku && it.wbSku) {
        skuUpdates.push({ id: mapped.itemId, wb_sku: it.wbSku });
        itemById.set(mapped.itemId, { ozonSku: itemMeta.ozonSku ?? null, wbSku: it.wbSku });
      }

      if (isShipped) {
        shippedRows.push({
          external_supply_id: row.supplyId,
          item_id: mapped.itemId,
        });
      } else {
        supplyRows.push({
          channel_id: channelId,
          destination_id: destinationId,
          item_id: mapped.itemId,
          plan_date: planDateISO,
          qty: it.qty,
          status: "planned",
          shipment_name: shipmentName,
          shipment_date: null,
          shipped_at: null,
          planned_by: "import:wb",
          comment: Number.isFinite(statusId) ? `wb_status=${statusId}` : null,
          external_supply_id: row.supplyId,
          supply_box_type_id: boxTypeId,
          updated_at: nowIso,
        });
      }
    }

  logStep("wb shipped detected", { shippedSupplies: shippedExternalIdsAll.size, shippedItems: shippedRows.length });

    if (row.supplyId && matchedItemIds.length) {
      cleanupQueue.push({ externalSupplyId: row.supplyId, itemIds: matchedItemIds });
    }
  }

  if (skuUpdates.length) {
    const dedup = new Map<string, string>();
    for (const row of skuUpdates) {
      if (!dedup.has(row.id)) dedup.set(row.id, row.wb_sku);
    }
    await updateWbSkus(Array.from(dedup, ([id, wb_sku]) => ({ id, wb_sku })));
  }

  if (supplyRows.length) {
    for (const slice of chunk(supplyRows, 500)) {
      const { error } = await supabase
        .from("mp_supply_plans")
        .upsert(slice, { onConflict: "channel_id,external_supply_id,item_id" });
      if (error) throw error;
    }
  }

  if (shippedRows.length) {
    const extIds = Array.from(new Set(shippedRows.map((r) => String(r.external_supply_id).trim()).filter(Boolean)));
    const itemIds = Array.from(new Set(shippedRows.map((r) => String(r.item_id).trim()).filter(Boolean)));
    if (extIds.length && itemIds.length) {
      const shippedPlans: any[] = [];
      for (const extSlice of chunk(extIds, 200)) {
        for (const itemSlice of chunk(itemIds, 200)) {
          const { data, error } = await supabase
            .from("mp_supply_plans")
            .select(
              "id, channel_id, destination_id, item_id, plan_date, qty, status, shipment_name, shipment_date, shipped_at, planned_by, comment, external_supply_id, supply_box_type_id, created_at, updated_at",
            )
            .eq("channel_id", channelId)
            .in("external_supply_id", extSlice)
            .in("item_id", itemSlice);
          if (error) throw error;
          if (data?.length) shippedPlans.push(...data);
        }
      }

      if (shippedPlans.length) {
        const { data: whData, error: whErr } = await supabase
          .from("warehouses")
          .select("id")
          .eq("type", "physical")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (whErr) throw whErr;
        const warehouseId = whData?.id;
        if (warehouseId) {
          const planIds = shippedPlans.map((p) => p.id);
          const { data: existingMoves, error: moveErr } = await supabase
            .from("stock_movements")
            .select("doc_id")
            .eq("doc_type", "mp_supply")
            .in("doc_id", planIds);
          if (moveErr) throw moveErr;
          const existing = new Set((existingMoves ?? []).map((m) => m.doc_id));

          const inserts = shippedPlans
            .filter((p) => !existing.has(p.id))
            .map((p) => ({
              doc_type: "mp_supply",
              doc_id: p.id,
              item_id: p.item_id,
              warehouse_id: warehouseId,
              qty: Number(p.qty ?? 0) * -1,
              created_at: nowIso,
            }))
            .filter((p) => Number(p.qty) !== 0);

          if (inserts.length) {
            for (const slice of chunk(inserts, 500)) {
              const { error: insErr } = await supabase.from("stock_movements").insert(slice);
              if (insErr) throw insErr;
            }
          }
        }

        const historyRows = shippedPlans.map((row) => ({
          source_plan_id: row.id,
          channel_id: row.channel_id,
          destination_id: row.destination_id,
          item_id: row.item_id,
          plan_date: row.plan_date,
          qty: row.qty,
          status: "shipped",
          shipment_name: row.shipment_name,
          shipment_date: row.shipment_date,
          shipped_at: nowIso,
          planned_by: row.planned_by,
          comment: row.comment,
          external_supply_id: row.external_supply_id,
          archived_at: nowIso,
          created_at: row.created_at,
          updated_at: row.updated_at ?? nowIso,
        }));

        for (const slice of chunk(historyRows, 500)) {
          const { error: histErr } = await supabase
            .from("mp_supply_plans_history")
            .upsert(slice, { onConflict: "source_plan_id" });
          if (histErr) throw histErr;
        }

        const planIds = shippedPlans.map((p) => p.id);
        for (const slice of chunk(planIds, 500)) {
          const { error: delErr } = await supabase.from("mp_supply_plans").delete().in("id", slice);
          if (delErr) throw delErr;
        }

        logStep("wb archive shipped", { count: shippedPlans.length });
      }
    }
  }

  if (shippedExternalIdsAll.size) {
    const shippedExtIds = Array.from(shippedExternalIdsAll);
    const shippedPlans: any[] = [];

    for (const extSlice of chunk(shippedExtIds, 200)) {
      const { data, error } = await supabase
        .from("mp_supply_plans")
        .select(
          "id, channel_id, destination_id, item_id, plan_date, qty, status, shipment_name, shipment_date, shipped_at, planned_by, comment, external_supply_id, supply_box_type_id, created_at, updated_at",
        )
        .eq("channel_id", channelId)
        .in("external_supply_id", extSlice);
      if (error) throw error;
      if (data?.length) shippedPlans.push(...data);
    }

    if (shippedPlans.length) {
      const { data: whData, error: whErr } = await supabase
        .from("warehouses")
        .select("id")
        .eq("type", "physical")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (whErr) throw whErr;
      const warehouseId = whData?.id;
      if (warehouseId) {
        const planIds = shippedPlans.map((p) => p.id);
        const { data: existingMoves, error: moveErr } = await supabase
          .from("stock_movements")
          .select("doc_id")
          .eq("doc_type", "mp_supply")
          .in("doc_id", planIds);
        if (moveErr) throw moveErr;
        const existing = new Set((existingMoves ?? []).map((m) => m.doc_id));

        const inserts = shippedPlans
          .filter((p) => !existing.has(p.id))
          .map((p) => ({
            doc_type: "mp_supply",
            doc_id: p.id,
            item_id: p.item_id,
            warehouse_id: warehouseId,
            qty: Number(p.qty ?? 0) * -1,
            created_at: nowIso,
          }))
          .filter((p) => Number(p.qty) !== 0);

        if (inserts.length) {
          for (const slice of chunk(inserts, 500)) {
            const { error: insErr } = await supabase.from("stock_movements").insert(slice);
            if (insErr) throw insErr;
          }
        }
      }

      const historyRows = shippedPlans.map((row) => ({
        source_plan_id: row.id,
        channel_id: row.channel_id,
        destination_id: row.destination_id,
        item_id: row.item_id,
        plan_date: row.plan_date,
        qty: row.qty,
        status: "shipped",
        shipment_name: row.shipment_name,
        shipment_date: row.shipment_date,
        shipped_at: nowIso,
        planned_by: row.planned_by,
        comment: row.comment,
        external_supply_id: row.external_supply_id,
        supply_box_type_id: row.supply_box_type_id ?? null,
        archived_at: nowIso,
        created_at: row.created_at,
        updated_at: row.updated_at ?? nowIso,
      }));

      for (const slice of chunk(historyRows, 500)) {
        const { error: histErr } = await supabase
          .from("mp_supply_plans_history")
          .upsert(slice, { onConflict: "source_plan_id" });
        if (histErr) throw histErr;
      }

      const planIds = shippedPlans.map((p) => p.id);
      for (const slice of chunk(planIds, 500)) {
        const { error: delErr } = await supabase.from("mp_supply_plans").delete().in("id", slice);
        if (delErr) throw delErr;
      }

      logStep("wb archive shipped by ext", { count: shippedPlans.length, extIds: shippedExtIds.length });
    }
  }

  for (const task of cleanupQueue) {
    if (!task.itemIds.length) continue;
    if (task.itemIds.length > 1000) continue;
    const inList = `(${task.itemIds.map((id) => `"${id}"`).join(",")})`;
    const { error } = await supabase
      .from("mp_supply_plans")
      .delete()
      .eq("channel_id", channelId)
      .eq("external_supply_id", task.externalSupplyId)
      .not("item_id", "in", inList);
    if (error) throw error;
  }

  if (listSupplyIds.size) {
    const { data: existingPlans, error: listErr } = await supabase
      .from("mp_supply_plans")
      .select("id, channel_id, destination_id, item_id, plan_date, qty, status, shipment_name, shipment_date, shipped_at, planned_by, comment, external_supply_id, supply_box_type_id, created_at, updated_at")
      .eq("channel_id", channelId);
    if (listErr) throw listErr;
    const missingPlans = (existingPlans ?? []).filter((r: any) => {
      const extId = String(r?.external_supply_id ?? "").trim();
      return extId && !listSupplyIds.has(extId);
    });

    if (missingPlans.length) {
      const historyRows = missingPlans.map((row: any) => ({
        source_plan_id: row.id,
        channel_id: row.channel_id,
        destination_id: row.destination_id,
        item_id: row.item_id,
        plan_date: row.plan_date,
        qty: row.qty,
        status: "canceled",
        shipment_name: row.shipment_name,
        shipment_date: row.shipment_date,
        shipped_at: null,
        planned_by: row.planned_by,
        comment: row.comment,
        external_supply_id: row.external_supply_id,
        supply_box_type_id: row.supply_box_type_id ?? null,
        archived_at: nowIso,
        canceled_at: nowIso,
        created_at: row.created_at,
        updated_at: row.updated_at ?? nowIso,
      }));

      for (const slice of chunk(historyRows, 500)) {
        const { error: histErr } = await supabase
          .from("mp_supply_plans_history")
          .upsert(slice, { onConflict: "source_plan_id" });
        if (histErr) throw histErr;
      }

      const planIds = missingPlans.map((p: any) => p.id);
      for (const slice of chunk(planIds, 500)) {
        const { error: delErr } = await supabase
          .from("mp_supply_plans")
          .delete()
          .in("id", slice);
        if (delErr) throw delErr;
      }

      logStep("wb archive missing plans", { count: missingPlans.length });
    }
  }

  return { imported: supplyRows.length, skipped: 0, unknown };
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: baseHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, { status: 405 });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch (_) {
    body = {};
  }

  const channel = String(body?.channel ?? "OZON").toUpperCase();
  logStep("request", { channel });

  try {
    if (channel === "OZON") {
      const result = await syncOzonSupplyPlans();
      return jsonResponse({ channel, ...result });
    }
    if (channel === "WB") {
      const raw = Array.isArray((body as any).statusIds)
        ? (body as any).statusIds
        : WB_STATUS_IDS_DEFAULT;
      const statusIds = raw.map((s: any) => Number(s)).filter((n: number) => Number.isFinite(n));
      if ((body as any).scanStatuses === true) {
        const today = new Date();
        const from = new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000);
        const fromDate = from.toISOString().slice(0, 10);
        const tillDate = today.toISOString().slice(0, 10);
        const supplies = await listWbSupplies(statusIds, fromDate, tillDate, "createDate");
        const unique = Array.from(new Set(supplies.map((s: any) => s?.statusID ?? s?.statusId))).filter(
          (v) => v != null,
        );
        return jsonResponse({ channel, statuses: unique });
      }
      const result = await syncWbSupplyPlans(statusIds.length ? statusIds : WB_STATUS_IDS_DEFAULT);
      return jsonResponse({ channel, ...result });
    }
    return jsonResponse({ error: "channel must be OZON or WB" }, { status: 400 });
  } catch (err) {
    console.error("sync-mp-supply-plans", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return jsonResponse({ error: message }, { status: 500 });
  }
});
