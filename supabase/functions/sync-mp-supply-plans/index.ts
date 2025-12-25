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
  ACTIVE: ["DATA_FILLING", "READY_TO_SUPPLY"],
};
const WB_STATUS_IDS_DEFAULT = [1, 2, 3];

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
    const res = await fetch(url, {
      method,
      headers: {
        "Client-Id": clientId,
        "Api-Key": apiKey,
        "Content-Type": "application/json",
      },
      body: payload,
    });

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

  let delay = 400;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
      body: payload,
    });

    if (res.ok) return res.json();

    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 4000);
      continue;
    }

    throw new Error(`[${path}] WB ${res.status}: ${text || res.statusText}`);
  }

  throw new Error("wbRequest: исчерпаны попытки");
};

const listFboSupplyOrderIds = async () => {
  const states = SUPPLY_ORDER_STATES.ACTIVE;
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

  for (let guard = 0; guard < 200; guard += 1) {
    const body: Record<string, unknown> = { bundle_ids: uniq, limit: LIMIT };
    if (lastId) body.last_id = lastId;

    const r = await ozonRequest("/v1/supply-order/bundle", body);
    const page = Array.isArray(r?.items) ? r.items : Array.isArray(r?.result?.items) ? r.result.items : [];
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

const fetchDestinationsMap = async (channelId: string) => {
  const { data, error } = await supabase
    .from("mp_destinations")
    .select("id, external_id, name")
    .eq("channel_id", channelId);
  if (error) throw error;
  const map = new Map<string, { id: string; name: string }>();
  for (const row of data ?? []) {
    const ext = String((row as any).external_id ?? "").trim();
    if (!ext) continue;
    map.set(ext, { id: row.id, name: row.name });
  }
  return map;
};

const ensureDestination = async (
  channelId: string,
  destMap: Map<string, { id: string; name: string }>,
  externalId?: string,
  name?: string,
  fallbackLabel?: string,
) => {
  const ext = String(externalId ?? "").trim();
  if (!ext) return null;
  const existing = destMap.get(ext);
  if (existing) return existing.id;

  const row = {
    channel_id: channelId,
    external_id: ext,
    name: name?.trim() || `${fallbackLabel ?? "Склад"} ${ext}`,
    is_active: true,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("mp_destinations")
    .upsert(row, { onConflict: "channel_id,external_id" })
    .select("id, name")
    .maybeSingle();
  if (error) throw error;

  if (data?.id) {
    destMap.set(ext, { id: data.id, name: data.name });
    return data.id as string;
  }

  return null;
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
  const channelId = await fetchChannelId("OZON");
  const destMap = await fetchDestinationsMap(channelId);

  const ids = await listFboSupplyOrderIds();
  if (!ids.length) return { imported: 0, skipped: 0, unknown: 0 };

  const orders = await getSupplyOrdersInfo(ids);
  const active = orders.filter((o) => SUPPLY_ORDER_STATES.ACTIVE.includes(String(o.state ?? "").trim()));

  const orderItems = [] as Array<{ order: SupplyOrder; items: AggregatedItem[] }>;
  const allBarcodes = new Set<string>();

  for (const order of active) {
    const itemsRaw = await getFboSupplyItemsByBundles(order.bundle_ids);
    const agg = aggregateSupplyItems(itemsRaw);
    if (!agg.length) continue;
    for (const it of agg) allBarcodes.add(it.barcode);
    orderItems.push({ order, items: agg });
  }

  if (!orderItems.length) return { imported: 0, skipped: 0, unknown: 0 };

  const { byBarcode, itemById } = await fetchItemMap(Array.from(allBarcodes));
  const nowIso = new Date().toISOString();
  const supplyRows: any[] = [];
  const cleanupQueue: Array<{ externalSupplyId: string; itemIds: string[] }> = [];
  const skuUpdates: Array<{ id: string; ozon_sku: string }> = [];
  let unknown = 0;

  for (const { order, items } of orderItems) {
    const planDateObj = parseDateOnly(order.slot_from);
    if (!planDateObj) continue;
    const planDate = planDateObj.toISOString().slice(0, 10);

    const displayId = order.supply_ids?.[0] || order.supply_order_id || order.order_number || "";
    const srcName = order.warehouse_name || order.warehouse_id || "Склад";
    const destName = order.dest_warehouse_name || order.dest_warehouse_id || "";
    const shipmentName = destName
      ? `${srcName} → ${destName} • ${displayId}`
      : `${srcName} • ${displayId}`;

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
        external_supply_id: order.supply_order_id || displayId || null,
        updated_at: nowIso,
      });
    }

    if (order.supply_order_id && matchedItemIds.length) {
      cleanupQueue.push({ externalSupplyId: order.supply_order_id, itemIds: matchedItemIds });
    }
  }

  if (skuUpdates.length) {
    const dedup = new Map<string, string>();
    for (const row of skuUpdates) {
      if (!dedup.has(row.id)) dedup.set(row.id, row.ozon_sku);
    }
    await updateOzonSkus(Array.from(dedup, ([id, ozon_sku]) => ({ id, ozon_sku })));
  }

  if (supplyRows.length) {
    for (const slice of chunk(supplyRows, 500)) {
      const { error } = await supabase
        .from("mp_supply_plans")
        .upsert(slice, { onConflict: "channel_id,external_supply_id,item_id" });
      if (error) throw error;
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

  const allBarcodes = new Set<string>();
  const supplyItems: Array<{
    supplyId: string;
    info: any;
    items: AggregatedItem[];
  }> = [];

  for (const s of supplies) {
    const supplyId = String(s?.supplyID ?? s?.supplyId ?? "").trim();
    if (!supplyId) continue;
    const info = await getWbSupplyDetails(supplyId);
    const goodsRaw = await getWbSupplyGoods(supplyId);
    const agg = aggregateSupplyItems(goodsRaw);
    if (!agg.length) continue;
    for (const it of agg) allBarcodes.add(it.barcode);
    supplyItems.push({ supplyId, info, items: agg });
  }

  if (!supplyItems.length) return { imported: 0, skipped: 0, unknown: 0 };

  const { byBarcode, itemById } = await fetchItemMap(Array.from(allBarcodes));
  const nowIso = new Date().toISOString();
  const supplyRows: any[] = [];
  const skuUpdates: Array<{ id: string; wb_sku: string }> = [];
  const cleanupQueue: Array<{ externalSupplyId: string; itemIds: string[] }> = [];
  let unknown = 0;

  for (const row of supplyItems) {
    const planDate = parseDateOnly(row.info?.supplyDate || row.info?.createDate);
    if (!planDate) continue;
    const planDateISO = planDate.toISOString().slice(0, 10);

    const whId = String(row.info?.warehouseID ?? row.info?.warehouseId ?? "").trim();
    const whName = String(row.info?.warehouseName ?? "").trim();
    const shipmentName = whName ? `${whName} • ${row.supplyId}` : row.supplyId;
    const destinationId = await ensureDestination(channelId, destMap, whId, whName, "WB склад");

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
        comment: row.info?.statusID != null ? `wb_status=${row.info.statusID}` : null,
        external_supply_id: row.supplyId,
        updated_at: nowIso,
      });
    }

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
