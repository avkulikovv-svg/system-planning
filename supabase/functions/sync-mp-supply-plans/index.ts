import { serve } from "https://deno.land/std@0.213.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.2";

type ChannelCode = "OZON" | "WB" | "WB_FBS" | "OZON_FBS";

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
const WB_SUPPLY_SYNC_DAYS = Number(Deno.env.get("WB_SUPPLY_SYNC_DAYS") ?? "30");
const WB_SUPPLY_SYNC_LOOKAHEAD_DAYS = Number(Deno.env.get("WB_SUPPLY_SYNC_LOOKAHEAD_DAYS") ?? "30");
const WB_FBS_SYNC_DAYS = Number(Deno.env.get("WB_FBS_SYNC_DAYS") ?? "30");
const OZON_FBS_SYNC_DAYS = Number(Deno.env.get("OZON_FBS_SYNC_DAYS") ?? "30");
const WB_TIMEZONE = "Europe/Moscow";
const WB_FBS_ACTIVE_STATUSES = new Set(["waiting"]);
const WB_FBS_CANCELED_STATUSES = new Set(["canceled", "declined_by_client", "canceled_by_client", "defect"]);
const OZON_FBS_ACTIVE_STATUSES = new Set([
  "awaiting_registration",
  "acceptance_in_progress",
  "awaiting_approve",
  "awaiting_packaging",
  "awaiting_deliver",
  "awaiting_verification",
]);
const OZON_FBS_CANCELED_STATUSES = new Set(["cancelled", "cancelled_from_split_pending", "not_accepted"]);

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const OZON_CLIENT_ID = Deno.env.get("OZON_CLIENT_ID");
const OZON_API_KEY = Deno.env.get("OZON_API_KEY");
const WB_API_TOKEN = Deno.env.get("WB_API_TOKEN");
const WB_CONTENT_TOKEN = Deno.env.get("WB_CONTENT_TOKEN");
const SYNC_MP_CRON_SECRET = Deno.env.get("SYNC_MP_CRON_SECRET");

if (!SUPABASE_URL) {
  throw new Error("SUPABASE_URL must be set");
}

type SupabaseClient = ReturnType<typeof createClient>;

const getAdminClient = (): SupabaseClient | null => {
  if (!SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
};

const getUserClient = (authHeader: string): SupabaseClient => {
  if (!SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_ANON_KEY must be set for user auth");
  }
  const headers: Record<string, string> = { Authorization: authHeader };
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers },
  });
};

const OZON_BASE = "https://api-seller.ozon.ru";
const WB_BASE = "https://supplies-api.wildberries.ru";
const WB_FBS_BASE = "https://marketplace-api.wildberries.ru";

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

const extractDateISO = (raw?: string) => {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const m = s.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

const getDefaultPhysicalWarehouseId = async (supabase: SupabaseClient) => {
  const { data: defaultWh, error: defaultErr } = await supabase
    .from("warehouses")
    .select("id")
    .eq("type", "physical")
    .eq("is_default", true)
    .limit(1)
    .maybeSingle();
  if (defaultErr) throw defaultErr;
  if (defaultWh?.id) return defaultWh.id;

  const { data: whData, error: whErr } = await supabase
    .from("warehouses")
    .select("id")
    .eq("type", "physical")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (whErr) throw whErr;
  return whData?.id ?? null;
};

const pickBarcode = (it: Record<string, unknown>) => {
  const cands = [
    it.barcode,
    it.bar_code,
    it.barcode_seller,
    it.barcode_supplier,
    Array.isArray(it.barcodes) ? it.barcodes[0] : null,
    Array.isArray((it as any).skus) ? (it as any).skus[0] : null,
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

const wbFbsRequest = async (path: string, opts?: { method?: string; body?: Record<string, unknown> }) => {
  const token = (WB_API_TOKEN || WB_CONTENT_TOKEN || "").replace(/[^\x21-\x7E]/g, "").trim();
  if (!token) throw new Error("WB_API_TOKEN/WB_CONTENT_TOKEN не задан");

  const url = `${WB_FBS_BASE}${path}`;
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
    logStep("wbFbsRequest", { path, status: res.status, durationMs, attempt });

    if (res.ok) return res.json();

    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 8000);
      continue;
    }

    throw new Error(`[${path}] WB ${res.status}: ${text || res.statusText}`);
  }

  throw new Error("wbFbsRequest: исчерпаны попытки");
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

const fetchChannelId = async (supabase: SupabaseClient, code: ChannelCode) => {
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

const fetchDestinationsMap = async (supabase: SupabaseClient, channelId: string) => {
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
  supabase: SupabaseClient,
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

const fetchItemMap = async (supabase: SupabaseClient, barcodes: string[]) => {
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

const updateOzonSkus = async (supabase: SupabaseClient, updates: Array<{ id: string; ozon_sku: string }>) => {
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

const updateWbSkus = async (supabase: SupabaseClient, updates: Array<{ id: string; wb_sku: string }>) => {
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

const fetchItemMapByOffers = async (supabase: SupabaseClient, offers: string[]) => {
  const normalized = Array.from(new Set(offers.map((s) => s.trim()).filter(Boolean)));
  const byOffer = new Map<string, { itemId: string }>();

  if (!normalized.length) return { byOffer };

  const normalizeKey = (s: string) => s.trim().toUpperCase();
  for (const slice of chunk(normalized, 200)) {
    const { data, error } = await supabase
      .from("items")
      .select("id, code, ozon_sku")
      .in("code", slice);
    if (error) throw error;
    for (const row of data ?? []) {
      const code = String((row as any).code ?? "").trim();
      if (!code) continue;
      byOffer.set(normalizeKey(code), { itemId: row.id });
    }
  }

  for (const slice of chunk(normalized, 200)) {
    const { data, error } = await supabase
      .from("items")
      .select("id, code, ozon_sku")
      .in("ozon_sku", slice);
    if (error) throw error;
    for (const row of data ?? []) {
      const sku = String((row as any).ozon_sku ?? "").trim();
      if (!sku) continue;
      const key = normalizeKey(sku);
      if (!byOffer.has(key)) {
        byOffer.set(key, { itemId: row.id });
      }
    }
  }

  return { byOffer };
};

const syncOzonSupplyPlans = async (supabase: SupabaseClient) => {
  const MAX_ORDERS_PER_RUN = 20;
  const startedAt = Date.now();
  logStep("ozon sync start");
  const channelId = await fetchChannelId(supabase, "OZON");
  const destMap = await fetchDestinationsMap(supabase, channelId);

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

  const { byBarcode, itemById } = await fetchItemMap(supabase, Array.from(allBarcodes));
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
      supabase,
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
    await updateOzonSkus(supabase, Array.from(dedup, ([id, ozon_sku]) => ({ id, ozon_sku })));
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
      const warehouseId = await getDefaultPhysicalWarehouseId(supabase);

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
    const warehouseId = await getDefaultPhysicalWarehouseId(supabase);
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

const listWbFbsOrders = async (fromTs: number, toTs: number) => {
  const orders: any[] = [];
  const LIMIT = 1000;
  let next = 0;

  for (let guard = 0; guard < 200; guard += 1) {
    const url = `/api/v3/orders?dateFrom=${fromTs}&dateTo=${toTs}&limit=${LIMIT}&next=${next}`;
    const r = await wbFbsRequest(url, { method: "GET" });
    const page = Array.isArray(r?.orders) ? r.orders : [];
    orders.push(...page);

    const nxt = r?.next;
    if (nxt == null) break;
    next = Number(nxt);
    if (!Number.isFinite(next) || next <= 0) break;
  }

  return orders;
};

const fetchWbFbsStatuses = async (orderIds: number[]) => {
  const map = new Map<string, { wbStatus?: string | null; supplierStatus?: string | null }>();
  for (const slice of chunk(orderIds, 100)) {
    const r = await wbFbsRequest("/api/v3/orders/status", { method: "POST", body: { orders: slice } });
    const statuses = Array.isArray(r?.orders) ? r.orders : [];
    for (const row of statuses) {
      const id = Number(row?.id);
      if (!Number.isFinite(id)) continue;
      map.set(String(id), {
        wbStatus: row?.wbStatus ?? null,
        supplierStatus: row?.supplierStatus ?? null,
      });
    }
  }
  return map;
};

const pickFbsStatusGroup = (wbStatus?: string | null) => {
  const norm = String(wbStatus ?? "").trim();
  if (WB_FBS_ACTIVE_STATUSES.has(norm)) return "active";
  if (WB_FBS_CANCELED_STATUSES.has(norm)) return "canceled";
  if (!norm) return "active";
  return "shipped";
};

const parseWbFbsOrderId = (raw: unknown) => {
  const num = Number(raw);
  if (Number.isFinite(num)) return String(num);
  const s = String(raw ?? "").trim();
  return s ? s : null;
};

const pickOzonFbsStatusGroup = (status?: string | null) => {
  const norm = String(status ?? "").trim();
  if (OZON_FBS_ACTIVE_STATUSES.has(norm)) return "active";
  if (OZON_FBS_CANCELED_STATUSES.has(norm)) return "canceled";
  if (!norm) return "active";
  return "shipped";
};

const formatOzonIso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

const listOzonFbsPostings = async (fromIso: string, toIso: string) => {
  const postings: any[] = [];
  const LIMIT = 1000;
  let offset = 0;

  for (let guard = 0; guard < 300; guard += 1) {
    const baseBody = {
      dir: "asc",
      limit: LIMIT,
      offset,
      with: {
        analytics_data: true,
        barcodes: true,
        financial_data: false,
        legal_info: false,
        translit: true,
      },
    };

    const bodies = [
      {
        ...baseBody,
        filter: {
          processed_at_from: fromIso,
          processed_at_to: toIso,
        },
      },
      {
        ...baseBody,
        filter: {
          cutoff_from: fromIso,
          cutoff_to: toIso,
        },
      },
      {
        ...baseBody,
        filter: {
          since: fromIso,
          to: toIso,
        },
      },
    ];

    let r: any = null;
    let lastError: Error | null = null;
    for (const body of bodies) {
      logStep("ozon fbs list request", { offset, fromIso, toIso, body: JSON.stringify(body) });
      try {
        r = await ozonRequest("/v3/posting/fbs/list", body);
        lastError = null;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = new Error(`${msg} (offset=${offset})`);
      }
    }
    if (lastError) throw lastError;

    const result = r?.result ?? {};
    const page = Array.isArray(result?.postings) ? result.postings : [];
    postings.push(...page);

    if (page.length < LIMIT) break;
    offset += LIMIT;
  }

  return postings;
};

const syncOzonFbsOrders = async (supabase: SupabaseClient) => {
  const channelId = await fetchChannelId(supabase, "OZON_FBS");
  const now = new Date();
  const nowIso = now.toISOString();
  const windowDays =
    Number.isFinite(OZON_FBS_SYNC_DAYS) && OZON_FBS_SYNC_DAYS > 0 ? OZON_FBS_SYNC_DAYS : 30;
  const fromIso = formatOzonIso(new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000));
  const toIso = formatOzonIso(now);

  logStep("ozon fbs window", { fromIso, toIso, windowDays });
  const postings = await listOzonFbsPostings(fromIso, toIso);
  if (!postings.length) return { imported: 0, skipped: 0, unknown: 0 };

  const orderRowMap = new Map<string, any>();
  const newlyShipped = new Set<string>();
  const newlyCanceled = new Set<string>();
  const orderCreatedAt = new Map<string, string | null>();
  const orderStatusGroup = new Map<string, string>();
  const orderItemsById = new Map<string, Map<string, { offerId: string; qty: number }>>();
  const offerIds = new Set<string>();
  let unknown = 0;

  const existingMap = new Map<string, { status_group: string; shipped_at?: string | null; canceled_at?: string | null }>();
  const postingNumbers = Array.from(
    new Set(
      postings.map((p: any) => String(p?.posting_number ?? "").trim()).filter(Boolean),
    ),
  );
  for (const slice of chunk(postingNumbers, 200)) {
    const { data, error } = await supabase
      .from("mp_fbs_orders")
      .select("order_id, status_group, shipped_at, canceled_at")
      .eq("channel_id", channelId)
      .in("order_id", slice);
    if (error) throw error;
    for (const row of data ?? []) {
      existingMap.set(String(row.order_id), {
        status_group: row.status_group,
        shipped_at: row.shipped_at,
        canceled_at: row.canceled_at,
      });
    }
  }

  for (const posting of postings) {
    const postingNumber = String(posting?.posting_number ?? "").trim();
    if (!postingNumber) continue;
    const status = String(posting?.status ?? "").trim();
    const nextGroup = pickOzonFbsStatusGroup(status);
    const existing = existingMap.get(postingNumber);
    const finalGroup = existing?.status_group === "shipped" || existing?.status_group === "canceled"
      ? existing.status_group
      : nextGroup;

    const createdAtRaw = String(posting?.in_process_at ?? posting?.shipment_date ?? posting?.delivering_date ?? "").trim();
    const createdAt = createdAtRaw ? new Date(createdAtRaw).toISOString() : null;
    orderCreatedAt.set(postingNumber, createdAt);
    orderStatusGroup.set(postingNumber, finalGroup);
    if (finalGroup === "shipped" && !existing?.shipped_at) newlyShipped.add(postingNumber);
    if (finalGroup === "canceled" && !existing?.canceled_at) newlyCanceled.add(postingNumber);

    orderRowMap.set(postingNumber, {
      channel_id: channelId,
      order_id: postingNumber,
      wb_status: status,
      supplier_status: null,
      status_group: finalGroup,
      order_created_at: createdAt,
      last_seen_at: nowIso,
      shipped_at: finalGroup === "shipped" ? existing?.shipped_at ?? nowIso : existing?.shipped_at ?? null,
      canceled_at: finalGroup === "canceled" ? existing?.canceled_at ?? nowIso : existing?.canceled_at ?? null,
      updated_at: nowIso,
    });

    const products = Array.isArray(posting?.products) ? posting.products : [];
    if (!products.length) continue;
    const orderItems = orderItemsById.get(postingNumber) ?? new Map();

    for (const product of products) {
      const offerId = String(product?.offer_id ?? "").trim();
      if (!offerId) continue;
      const qty = Number(product?.quantity ?? 0) || 0;
      if (!qty) continue;
      const key = offerId.toUpperCase();
      offerIds.add(key);
      const prev = orderItems.get(key);
      if (prev) {
        prev.qty += qty;
      } else {
        orderItems.set(key, { offerId: key, qty });
      }
    }
    if (orderItems.size) orderItemsById.set(postingNumber, orderItems);
  }

  const orderRows = Array.from(orderRowMap.values());
  if (orderRows.length) {
    for (const slice of chunk(orderRows, 500)) {
      const { error } = await supabase
        .from("mp_fbs_orders")
        .upsert(slice, { onConflict: "channel_id,order_id" });
      if (error) throw error;
    }
  }

  const { byOffer } = await fetchItemMapByOffers(supabase, Array.from(offerIds));
  const itemRowMap = new Map<string, any>();
  const cleanupQueue: Array<{ orderId: string; itemIds: string[] }> = [];
  const activeAgg = new Map<string, number>();

  for (const [orderId, items] of orderItemsById.entries()) {
    const statusGroup = orderStatusGroup.get(orderId) ?? "active";
    const itemIds: string[] = [];

    for (const row of items.values()) {
      const mapped = byOffer.get(row.offerId);
      if (!mapped?.itemId) {
        unknown += 1;
        continue;
      }
      itemIds.push(mapped.itemId);
      const rowKey = `${orderId}:${mapped.itemId}`;
      const existing = itemRowMap.get(rowKey);
      if (existing) {
        existing.qty = Number(existing.qty ?? 0) + row.qty;
        existing.updated_at = nowIso;
      } else {
        itemRowMap.set(rowKey, {
          channel_id: channelId,
          order_id: orderId,
          item_id: mapped.itemId,
          barcode: null,
          qty: row.qty,
          updated_at: nowIso,
        });
      }
      if (statusGroup === "active") {
        activeAgg.set(mapped.itemId, (activeAgg.get(mapped.itemId) ?? 0) + row.qty);
      }
    }
    cleanupQueue.push({ orderId, itemIds });
  }

  const itemRows = Array.from(itemRowMap.values());
  if (itemRows.length) {
    for (const slice of chunk(itemRows, 500)) {
      const { error } = await supabase
        .from("mp_fbs_order_items")
        .upsert(slice, { onConflict: "channel_id,order_id,item_id" });
      if (error) throw error;
    }
  }

  for (const task of cleanupQueue) {
    if (!task.itemIds.length || task.itemIds.length > 1000) continue;
    const inList = `(${task.itemIds.map((id) => `"${id}"`).join(",")})`;
    const { error } = await supabase
      .from("mp_fbs_order_items")
      .delete()
      .eq("channel_id", channelId)
      .eq("order_id", task.orderId)
      .not("item_id", "in", inList);
    if (error) throw error;
  }

  const planDate = nowIso.slice(0, 10);
  const supplyRows = Array.from(activeAgg, ([itemId, qty]) => ({
    channel_id: channelId,
    destination_id: null,
    item_id: itemId,
    plan_date: planDate,
    qty,
    status: "planned",
    shipment_name: "FBS Ozon",
    shipment_date: null,
    shipped_at: null,
    planned_by: "import:ozon-fbs",
    comment: null,
    external_supply_id: "FBS_OZON",
    supply_box_type_id: null,
    updated_at: nowIso,
  }));

  if (supplyRows.length) {
    for (const slice of chunk(supplyRows, 500)) {
      const { error } = await supabase
        .from("mp_supply_plans")
        .upsert(slice, { onConflict: "channel_id,external_supply_id,item_id" });
      if (error) throw error;
    }
  } else {
    const { error } = await supabase
      .from("mp_supply_plans")
      .delete()
      .eq("channel_id", channelId)
      .eq("external_supply_id", "FBS_OZON");
    if (error) throw error;
  }

  if (activeAgg.size) {
    const activeItemIds = Array.from(activeAgg.keys());
    if (activeItemIds.length <= 1000) {
      const inList = `(${activeItemIds.map((id) => `"${id}"`).join(",")})`;
      const { error } = await supabase
        .from("mp_supply_plans")
        .delete()
        .eq("channel_id", channelId)
        .eq("external_supply_id", "FBS_OZON")
        .not("item_id", "in", inList);
      if (error) throw error;
    }
  }

  const finalizeOrders = new Set<string>([...newlyShipped, ...newlyCanceled]);
  if (finalizeOrders.size) {
    const orderIdsToFinalize = Array.from(finalizeOrders);
    const fbsItems: any[] = [];
    for (const slice of chunk(orderIdsToFinalize, 200)) {
      const { data, error } = await supabase
        .from("mp_fbs_order_items")
        .select("id, order_id, item_id, qty")
        .eq("channel_id", channelId)
        .in("order_id", slice);
      if (error) throw error;
      if (data?.length) fbsItems.push(...data);
    }

    if (fbsItems.length) {
      const itemIds = fbsItems.map((r) => r.id);
      const { data: existingHist, error: histErr } = await supabase
        .from("mp_supply_plans_history")
        .select("source_plan_id")
        .in("source_plan_id", itemIds);
      if (histErr) throw histErr;
      const existingHistIds = new Set((existingHist ?? []).map((r) => r.source_plan_id));

      const historyRows: any[] = [];
      const shippedItemIds: string[] = [];

      for (const row of fbsItems) {
        if (existingHistIds.has(row.id)) continue;
        const orderId = String(row.order_id ?? "");
        const isShipped = newlyShipped.has(orderId);
        const isCanceled = newlyCanceled.has(orderId);
        if (!isShipped && !isCanceled) continue;
        const createdAt = orderCreatedAt.get(orderId) ?? null;
        const planDateIso = createdAt ? createdAt.slice(0, 10) : planDate;
        historyRows.push({
          source_plan_id: row.id,
          channel_id: channelId,
          destination_id: null,
          item_id: row.item_id,
          plan_date: planDateIso,
          qty: row.qty,
          status: isCanceled ? "canceled" : "shipped",
          shipment_name: `FBS Ozon • ${orderId}`,
          shipment_date: null,
          shipped_at: isCanceled ? null : nowIso,
          planned_by: "import:ozon-fbs",
          comment: null,
          external_supply_id: orderId,
          supply_box_type_id: null,
          archived_at: nowIso,
          canceled_at: isCanceled ? nowIso : null,
          created_at: nowIso,
          updated_at: nowIso,
        });
        if (isShipped) shippedItemIds.push(row.id);
      }

      if (historyRows.length) {
        for (const slice of chunk(historyRows, 500)) {
          const { error } = await supabase
            .from("mp_supply_plans_history")
            .upsert(slice, { onConflict: "source_plan_id" });
          if (error) throw error;
        }
      }

      if (shippedItemIds.length) {
        const warehouseId = await getDefaultPhysicalWarehouseId(supabase);
        if (warehouseId) {
          const { data: existingMoves, error: moveErr } = await supabase
            .from("stock_movements")
            .select("doc_id")
            .eq("doc_type", "mp_fbs")
            .in("doc_id", shippedItemIds);
          if (moveErr) throw moveErr;
          const existing = new Set((existingMoves ?? []).map((m) => m.doc_id));

          const inserts = fbsItems
            .filter((row) => shippedItemIds.includes(row.id) && !existing.has(row.id))
            .map((row) => ({
              doc_type: "mp_fbs",
              doc_id: row.id,
              item_id: row.item_id,
              warehouse_id: warehouseId,
              qty: Number(row.qty ?? 0) * -1,
              created_at: nowIso,
            }))
            .filter((row) => Number(row.qty) !== 0);

          if (inserts.length) {
            for (const slice of chunk(inserts, 500)) {
              const { error: insErr } = await supabase.from("stock_movements").insert(slice);
              if (insErr) throw insErr;
            }
          }
        }
      }
    }
  }

  logStep("ozon fbs sync done", { imported: supplyRows.length, unknown, orders: orderRows.length });
  return { imported: supplyRows.length, skipped: 0, unknown };
};

const syncWbFbsOrders = async (supabase: SupabaseClient) => {
  const channelId = await fetchChannelId(supabase, "WB_FBS");
  const now = new Date();
  const nowIso = now.toISOString();

  const windowDays = Number.isFinite(WB_FBS_SYNC_DAYS) && WB_FBS_SYNC_DAYS > 0 ? WB_FBS_SYNC_DAYS : 30;
  const from = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const fromTs = Math.floor(from.getTime() / 1000);
  const toTs = Math.floor(now.getTime() / 1000);

  logStep("wb fbs window", { fromTs, toTs, windowDays });
  const orders = await listWbFbsOrders(fromTs, toTs);
  if (!orders.length) {
    return { imported: 0, skipped: 0, unknown: 0 };
  }

  const orderIdNums = orders
    .map((o) => Number(o?.id))
    .filter((n) => Number.isFinite(n)) as number[];
  const orderIds = orderIdNums.map((n) => String(n));

  const statusMap = await fetchWbFbsStatuses(orderIdNums);

  const existingMap = new Map<string, { status_group: string; shipped_at?: string | null; canceled_at?: string | null }>();
  for (const slice of chunk(orderIds, 200)) {
    const { data, error } = await supabase
      .from("mp_fbs_orders")
      .select("order_id, status_group, shipped_at, canceled_at")
      .eq("channel_id", channelId)
      .in("order_id", slice);
    if (error) throw error;
    for (const row of data ?? []) {
      existingMap.set(String(row.order_id), {
        status_group: row.status_group,
        shipped_at: row.shipped_at,
        canceled_at: row.canceled_at,
      });
    }
  }

  const orderRowMap = new Map<string, any>();
  const newlyShipped = new Set<string>();
  const newlyCanceled = new Set<string>();
  const orderCreatedAt = new Map<string, string | null>();
  const orderStatusGroup = new Map<string, string>();
  const allBarcodes = new Set<string>();
  const orderItemsById = new Map<string, Map<string, { barcode: string; qty: number }>>();
  let unknown = 0;

  for (const order of orders) {
    const orderId = parseWbFbsOrderId(order?.id);
    if (!orderId) continue;

    const status = statusMap.get(orderId);
    const wbStatus = status?.wbStatus ?? null;
    const supplierStatus = status?.supplierStatus ?? null;
    const nextGroup = pickFbsStatusGroup(wbStatus);
    const existing = existingMap.get(orderId);
    const finalGroup = existing?.status_group === "shipped" || existing?.status_group === "canceled"
      ? existing.status_group
      : nextGroup;

    const createdAtRaw = String(order?.createdAt ?? "").trim();
    const createdAt = createdAtRaw ? new Date(createdAtRaw).toISOString() : null;
    orderCreatedAt.set(orderId, createdAt);
    orderStatusGroup.set(orderId, finalGroup);

    if (finalGroup === "shipped" && !existing?.shipped_at) newlyShipped.add(orderId);
    if (finalGroup === "canceled" && !existing?.canceled_at) newlyCanceled.add(orderId);

    orderRowMap.set(orderId, {
      channel_id: channelId,
      order_id: orderId,
      wb_status: wbStatus,
      supplier_status: supplierStatus,
      status_group: finalGroup,
      order_created_at: createdAt,
      last_seen_at: nowIso,
      shipped_at: finalGroup === "shipped" ? existing?.shipped_at ?? nowIso : existing?.shipped_at ?? null,
      canceled_at: finalGroup === "canceled" ? existing?.canceled_at ?? nowIso : existing?.canceled_at ?? null,
      updated_at: nowIso,
    });

    const skus = Array.isArray(order?.skus) ? order.skus : [];
    const rawQty = Number(order?.quantity ?? order?.count ?? order?.qty ?? 1);
    const qtyPerSku = Number.isFinite(rawQty) && rawQty > 0 ? rawQty : 1;
    if (!skus.length) continue;

    const orderItems = orderItemsById.get(orderId) ?? new Map();
    for (const sku of skus) {
      const barcode = String(sku ?? "").trim();
      if (!barcode) continue;
      allBarcodes.add(barcode);
      const prev = orderItems.get(barcode);
      if (prev) {
        prev.qty += qtyPerSku;
      } else {
        orderItems.set(barcode, { barcode, qty: qtyPerSku });
      }
    }
    if (orderItems.size) orderItemsById.set(orderId, orderItems);
  }

  const orderRows = Array.from(orderRowMap.values());
  if (orderRows.length) {
    for (const slice of chunk(orderRows, 500)) {
      const { error } = await supabase
        .from("mp_fbs_orders")
        .upsert(slice, { onConflict: "channel_id,order_id" });
      if (error) throw error;
    }
  }

  const { byBarcode } = allBarcodes.size
    ? await fetchItemMap(supabase, Array.from(allBarcodes))
    : { byBarcode: new Map<string, { itemId: string }>() };

  const itemRowMap = new Map<string, any>();
  const cleanupQueue: Array<{ orderId: string; itemIds: string[] }> = [];
  const activeAgg = new Map<string, number>();

  for (const [orderId, items] of orderItemsById.entries()) {
    const mappedItems = new Map<string, { itemId: string; qty: number; barcode: string }>();
    for (const it of items.values()) {
      const mapped = byBarcode.get(it.barcode);
      if (!mapped?.itemId) {
        unknown += 1;
        continue;
      }
      const prev = mappedItems.get(mapped.itemId);
      if (prev) {
        prev.qty += it.qty;
      } else {
        mappedItems.set(mapped.itemId, { itemId: mapped.itemId, qty: it.qty, barcode: it.barcode });
      }
    }

    if (!mappedItems.size) continue;

    const existing = existingMap.get(orderId);
    const statusGroup = orderStatusGroup.get(orderId) ?? existing?.status_group ?? "active";

    const itemIds: string[] = [];
    for (const row of mappedItems.values()) {
      itemIds.push(row.itemId);
      const rowKey = `${orderId}:${row.itemId}`;
      const existing = itemRowMap.get(rowKey);
      if (existing) {
        existing.qty = Number(existing.qty ?? 0) + row.qty;
        if (!existing.barcode && row.barcode) existing.barcode = row.barcode;
        existing.updated_at = nowIso;
      } else {
        itemRowMap.set(rowKey, {
          channel_id: channelId,
          order_id: orderId,
          item_id: row.itemId,
          barcode: row.barcode,
          qty: row.qty,
          updated_at: nowIso,
        });
      }
      if (statusGroup === "active") {
        activeAgg.set(row.itemId, (activeAgg.get(row.itemId) ?? 0) + row.qty);
      }
    }
    cleanupQueue.push({ orderId, itemIds });
  }

  const itemRows = Array.from(itemRowMap.values());
  if (itemRows.length) {
    for (const slice of chunk(itemRows, 500)) {
      const { error } = await supabase
        .from("mp_fbs_order_items")
        .upsert(slice, { onConflict: "channel_id,order_id,item_id" });
      if (error) throw error;
    }
  }

  for (const task of cleanupQueue) {
    if (!task.itemIds.length || task.itemIds.length > 1000) continue;
    const inList = `(${task.itemIds.map((id) => `"${id}"`).join(",")})`;
    const { error } = await supabase
      .from("mp_fbs_order_items")
      .delete()
      .eq("channel_id", channelId)
      .eq("order_id", task.orderId)
      .not("item_id", "in", inList);
    if (error) throw error;
  }

  const planDate = nowIso.slice(0, 10);
  const supplyRows = Array.from(activeAgg, ([itemId, qty]) => ({
    channel_id: channelId,
    destination_id: null,
    item_id: itemId,
    plan_date: planDate,
    qty,
    status: "planned",
    shipment_name: "FBS WB",
    shipment_date: null,
    shipped_at: null,
    planned_by: "import:wb-fbs",
    comment: null,
    external_supply_id: "FBS_WB",
    supply_box_type_id: null,
    updated_at: nowIso,
  }));

  if (supplyRows.length) {
    for (const slice of chunk(supplyRows, 500)) {
      const { error } = await supabase
        .from("mp_supply_plans")
        .upsert(slice, { onConflict: "channel_id,external_supply_id,item_id" });
      if (error) throw error;
    }
  } else {
    const { error } = await supabase
      .from("mp_supply_plans")
      .delete()
      .eq("channel_id", channelId)
      .eq("external_supply_id", "FBS_WB");
    if (error) throw error;
  }

  if (activeAgg.size) {
    const activeItemIds = Array.from(activeAgg.keys());
    if (activeItemIds.length <= 1000) {
      const inList = `(${activeItemIds.map((id) => `"${id}"`).join(",")})`;
      const { error } = await supabase
        .from("mp_supply_plans")
        .delete()
        .eq("channel_id", channelId)
        .eq("external_supply_id", "FBS_WB")
        .not("item_id", "in", inList);
      if (error) throw error;
    }
  }

  const finalizeOrders = new Set<string>([...newlyShipped, ...newlyCanceled]);
  if (finalizeOrders.size) {
    const orderIdsToFinalize = Array.from(finalizeOrders);
    const fbsItems: any[] = [];
    for (const slice of chunk(orderIdsToFinalize, 200)) {
      const { data, error } = await supabase
        .from("mp_fbs_order_items")
        .select("id, order_id, item_id, qty")
        .eq("channel_id", channelId)
        .in("order_id", slice);
      if (error) throw error;
      if (data?.length) fbsItems.push(...data);
    }

    if (fbsItems.length) {
      const itemIds = fbsItems.map((r) => r.id);
      const { data: existingHist, error: histErr } = await supabase
        .from("mp_supply_plans_history")
        .select("source_plan_id")
        .in("source_plan_id", itemIds);
      if (histErr) throw histErr;
      const existingHistIds = new Set((existingHist ?? []).map((r) => r.source_plan_id));

      const historyRows: any[] = [];
      const shippedItemIds: string[] = [];

      for (const row of fbsItems) {
        if (existingHistIds.has(row.id)) continue;
        const orderId = String(row.order_id ?? "");
        const isShipped = newlyShipped.has(orderId);
        const isCanceled = newlyCanceled.has(orderId);
        if (!isShipped && !isCanceled) continue;
        const createdAt = orderCreatedAt.get(orderId) ?? null;
        const planDateIso = createdAt ? createdAt.slice(0, 10) : planDate;
        historyRows.push({
          source_plan_id: row.id,
          channel_id: channelId,
          destination_id: null,
          item_id: row.item_id,
          plan_date: planDateIso,
          qty: row.qty,
          status: isCanceled ? "canceled" : "shipped",
          shipment_name: `FBS WB • ${orderId}`,
          shipment_date: null,
          shipped_at: isCanceled ? null : nowIso,
          planned_by: "import:wb-fbs",
          comment: null,
          external_supply_id: orderId,
          supply_box_type_id: null,
          archived_at: nowIso,
          canceled_at: isCanceled ? nowIso : null,
          created_at: nowIso,
          updated_at: nowIso,
        });
        if (isShipped) shippedItemIds.push(row.id);
      }

      if (historyRows.length) {
        for (const slice of chunk(historyRows, 500)) {
          const { error } = await supabase
            .from("mp_supply_plans_history")
            .upsert(slice, { onConflict: "source_plan_id" });
          if (error) throw error;
        }
      }

      if (shippedItemIds.length) {
        const warehouseId = await getDefaultPhysicalWarehouseId(supabase);
        if (warehouseId) {
          const { data: existingMoves, error: moveErr } = await supabase
            .from("stock_movements")
            .select("doc_id")
            .eq("doc_type", "mp_fbs")
            .in("doc_id", shippedItemIds);
          if (moveErr) throw moveErr;
          const existing = new Set((existingMoves ?? []).map((m) => m.doc_id));

          const inserts = fbsItems
            .filter((row) => shippedItemIds.includes(row.id) && !existing.has(row.id))
            .map((row) => ({
              doc_type: "mp_fbs",
              doc_id: row.id,
              item_id: row.item_id,
              warehouse_id: warehouseId,
              qty: Number(row.qty ?? 0) * -1,
              created_at: nowIso,
            }))
            .filter((row) => Number(row.qty) !== 0);

          if (inserts.length) {
            for (const slice of chunk(inserts, 500)) {
              const { error: insErr } = await supabase.from("stock_movements").insert(slice);
              if (insErr) throw insErr;
            }
          }
        }
      }
    }
  }

  logStep("wb fbs sync done", { imported: supplyRows.length, unknown, orders: orderRows.length });
  return { imported: supplyRows.length, skipped: 0, unknown };
};

const syncWbSupplyPlans = async (supabase: SupabaseClient, statusIds: number[]) => {
  const channelId = await fetchChannelId(supabase, "WB");
  const destMap = await fetchDestinationsMap(supabase, channelId);

  const formatDateMsk = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: WB_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);

  const today = new Date();
  const windowDays = Number.isFinite(WB_SUPPLY_SYNC_DAYS) && WB_SUPPLY_SYNC_DAYS > 0 ? WB_SUPPLY_SYNC_DAYS : 30;
  const lookaheadDays =
    Number.isFinite(WB_SUPPLY_SYNC_LOOKAHEAD_DAYS) && WB_SUPPLY_SYNC_LOOKAHEAD_DAYS >= 0
      ? WB_SUPPLY_SYNC_LOOKAHEAD_DAYS
      : 30;
  const from = new Date(today.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const till = new Date(today.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);
  const fromDate = formatDateMsk(from);
  const tillDate = formatDateMsk(till);

  logStep("wb supplies window", { fromDate, tillDate, windowDays, lookaheadDays, tz: WB_TIMEZONE });
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
    ? await fetchItemMap(supabase, Array.from(allBarcodes))
    : { byBarcode: new Map<string, { itemId: string }>(), itemById: new Map<string, any>() };
  const nowIso = new Date().toISOString();
  const supplyRows: any[] = [];
  const shippedRows: Array<{ external_supply_id: string; item_id: string }> = [];
  const shippedExternalIdsAll = new Set<string>(shippedSupplyIdsFromList);
  const skuUpdates: Array<{ id: string; wb_sku: string }> = [];
  const cleanupQueue: Array<{ externalSupplyId: string; itemIds: string[] }> = [];
  let unknown = 0;

  for (const row of supplyItems) {
    const planDateISO =
      extractDateISO(row.info?.supplyDate) ||
      extractDateISO(row.info?.createDate) ||
      (parseDateOnly(row.info?.supplyDate || row.info?.createDate)?.toISOString().slice(0, 10) ?? null);
    if (!planDateISO) continue;
    const boxTypeId = pickBoxTypeId(row.info) ?? row.listBoxTypeId ?? null;

    const whId = String(row.info?.warehouseID ?? row.info?.warehouseId ?? "").trim();
    const whName = String(row.info?.warehouseName ?? "").trim();
    const shipmentName = whName ? `${whName} • ${row.supplyId}` : row.supplyId;
    const destinationId = await ensureDestination(supabase, channelId, destMap, whId, whName, "WB склад");
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
    await updateWbSkus(supabase, Array.from(dedup, ([id, wb_sku]) => ({ id, wb_sku })));
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
        const warehouseId = await getDefaultPhysicalWarehouseId(supabase);
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
      const warehouseId = await getDefaultPhysicalWarehouseId(supabase);
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

  const authHeader = req.headers.get("Authorization");
  const accessToken = authHeader?.replace(/^Bearer\s+/i, "").trim();
  const cronHeader = req.headers.get("x-cron-secret");
  const isCron = Boolean(SYNC_MP_CRON_SECRET && cronHeader === SYNC_MP_CRON_SECRET);

  let supabase = getAdminClient();
  if (!isCron) {
    if (!authHeader) {
      return jsonResponse({ error: "Authorization required" }, { status: 401 });
    }

    const userClient = getUserClient(authHeader);
    const { data: userData, error: userError } = accessToken
      ? await userClient.auth.getUser(accessToken)
      : await userClient.auth.getUser();
    if (userError || !userData?.user) {
      const details = userError
        ? { message: userError.message, status: (userError as any).status }
        : undefined;
      return jsonResponse({ error: "Unauthorized", details }, { status: 401 });
    }

    const { data: profile, error: profileError } = await userClient
      .from("profiles")
      .select("is_active")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (profileError || !profile?.is_active) {
      return jsonResponse({ error: "Forbidden" }, { status: 403 });
    }

    supabase = supabase ?? userClient;
  } else if (!supabase) {
    return jsonResponse({ error: "Service role key required for cron" }, { status: 500 });
  }

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
      const result = await syncOzonSupplyPlans(supabase);
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
      const result = await syncWbSupplyPlans(supabase, statusIds.length ? statusIds : WB_STATUS_IDS_DEFAULT);
      return jsonResponse({ channel, ...result });
    }
    if (channel === "WB_FBS") {
      const result = await syncWbFbsOrders(supabase);
      return jsonResponse({ channel, ...result });
    }
    if (channel === "OZON_FBS") {
      const result = await syncOzonFbsOrders(supabase);
      return jsonResponse({ channel, ...result });
    }
    return jsonResponse({ error: "channel must be OZON, WB, WB_FBS or OZON_FBS" }, { status: 400 });
  } catch (err) {
    console.error("sync-mp-supply-plans", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return jsonResponse({ error: message }, { status: 500 });
  }
});
