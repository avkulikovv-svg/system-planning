import { serve } from "https://deno.land/std@0.213.0/http/server.ts";

const WB_BASE = "https://supplies-api.wildberries.ru";
const WB_API_TOKEN = Deno.env.get("WB_API_TOKEN");
const WB_CONTENT_TOKEN = Deno.env.get("WB_CONTENT_TOKEN");

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: baseHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, { status: 405 });

  let body: any = {};
  try {
    body = await req.json();
  } catch (_) {
    body = {};
  }
  const debug = Boolean(body?.debug);

  const rawItems = Array.isArray(body?.items) ? body.items : Array.isArray(body) ? body : [];
  const items = rawItems
    .map((row: any) => ({
      barcode: String(row?.barcode ?? row ?? "").trim(),
      quantity: Number(row?.quantity ?? 1),
    }))
    .filter((row: any) => row.barcode);

  if (!items.length) {
    return jsonResponse({ items: [] });
  }

  const uniqMap = new Map<string, number>();
  for (const row of items) {
    if (!uniqMap.has(row.barcode)) uniqMap.set(row.barcode, row.quantity || 1);
  }
  const uniqItems = Array.from(uniqMap, ([barcode, quantity]) => ({
    barcode,
    quantity: Math.max(1, Number(quantity) || 1),
  }));

  const warehousesRaw = await wbRequest("/api/v1/warehouses", { method: "GET" });
  const whList = Array.isArray(warehousesRaw)
    ? warehousesRaw
    : warehousesRaw?.warehouses ??
      warehousesRaw?.result?.warehouses ??
      warehousesRaw?.result?.items ??
      warehousesRaw?.result?.data ??
      warehousesRaw?.result ??
      [];
  const whMap = new Map<string, string>();
  for (const w of whList) {
    const id = String(
      w?.id ??
        w?.ID ??
        w?.warehouseID ??
        w?.warehouseId ??
        w?.warehouse_id ??
        w?.officeId ??
        "",
    ).trim();
    const name = String(w?.name ?? w?.warehouseName ?? w?.officeName ?? w?.address ?? "").trim();
    if (id) whMap.set(id, name || id);
  }

  const results: any[] = [];
  for (const slice of chunk(uniqItems, 5000)) {
    const opts = await wbRequest("/api/v1/acceptance/options", { method: "POST", body: slice });
    let arr: any[] = [];
    if (Array.isArray(opts)) arr = opts;
    else if (Array.isArray(opts?.items)) arr = opts.items;
    else if (Array.isArray(opts?.data)) arr = opts.data;
    else if (Array.isArray(opts?.result)) arr = opts.result;

    results.push(...arr);
  }

  const mapped = results.map((row: any) => {
    const warehouses = Array.isArray(row?.warehouses) ? row.warehouses : [];
    return {
      barcode: String(row?.barcode ?? "").trim(),
      isError: Boolean(row?.isError),
      error: row?.error ?? null,
      warehouses: warehouses.map((w: any) => {
        const id = String(w?.warehouseID ?? w?.warehouseId ?? "").trim();
        return {
          warehouseId: id,
          name: whMap.get(id) ?? id,
          canBox: Boolean(w?.canBox),
          canMonopallet: Boolean(w?.canMonopallet),
          canSupersafe: Boolean(w?.canSupersafe),
        };
      }),
    };
  });

  let debugInfo: Record<string, unknown> | undefined;
  if (debug) {
    debugInfo = {
      warehousesCount: whMap.size,
      acceptanceCount: results.length,
      sample: results[0] ?? null,
    };
    if (!results.length && uniqItems.length) {
      const single = await wbRequest("/api/v1/acceptance/options", {
        method: "POST",
        body: [uniqItems[0]],
      });
      debugInfo = {
        ...debugInfo,
        singleSample: single ?? null,
        singleBarcode: uniqItems[0]?.barcode ?? null,
      };
    }
  }

  return jsonResponse({
    items: mapped,
    received: mapped.length,
    total: uniqItems.length,
    debug: debugInfo,
  });
});
