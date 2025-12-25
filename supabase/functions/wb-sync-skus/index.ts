import { serve } from "https://deno.land/std@0.213.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.2";

const WB_CONTENT_BASE = "https://content-api.wildberries.ru";
const WB_SUPPLIES_BASE = "https://supplies-api.wildberries.ru";
const WB_CONTENT_TOKEN = Deno.env.get("WB_CONTENT_TOKEN");
const WB_API_TOKEN = Deno.env.get("WB_API_TOKEN");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const baseHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type,authorization,apikey,x-client-info",
};

const jsonResponse = (body: Record<string, unknown>, init?: ResponseInit) =>
  new Response(JSON.stringify(body, null, 2), { headers: baseHeaders, ...init });

const normalizeUpdatedAt = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const asNum = Number(trimmed);
      if (!Number.isFinite(asNum)) return null;
      return new Date(asNum).toISOString();
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : trimmed;
  }
  return null;
};

const chunk = <T>(arr: T[], size: number) => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const getToken = () => {
  const raw = (WB_CONTENT_TOKEN || WB_API_TOKEN || "").replace(/[^\x21-\x7E]/g, "").trim();
  if (!raw) return { token: "", source: "none" as const };
  return { token: raw, source: WB_CONTENT_TOKEN ? "WB_CONTENT_TOKEN" : "WB_API_TOKEN" };
};

const wbContentRequest = async (path: string, body: Record<string, unknown>) => {
  const { token } = getToken();
  if (!token) throw new Error("WB_CONTENT_TOKEN не задан");

  const url = `${WB_CONTENT_BASE}${path}`;
  let delay = 400;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();

    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 4000);
      continue;
    }
    throw new Error(`[${path}] WB CONTENT ${res.status}: ${text || res.statusText}`);
  }

  throw new Error("wbContentRequest: исчерпаны попытки");
};

const wbSuppliesRequest = async (path: string, body?: Record<string, unknown>, method = "POST") => {
  const token = (WB_API_TOKEN || WB_CONTENT_TOKEN || "").replace(/[^\x21-\x7E]/g, "").trim();
  if (!token) throw new Error("WB_API_TOKEN/WB_CONTENT_TOKEN не задан");

  const url = `${WB_SUPPLIES_BASE}${path}`;
  let delay = 400;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
    if (res.ok) return res.json();

    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 4000);
      continue;
    }
    throw new Error(`[${path}] WB SUPPLIES ${res.status}: ${text || res.statusText}`);
  }

  throw new Error("wbSuppliesRequest: исчерпаны попытки");
};

const formatDate = (d: Date) => d.toISOString().slice(0, 10);

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: baseHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, { status: 405 });

  try {
    if (!supabase) throw new Error("SUPABASE_SERVICE_ROLE_KEY не задан");

    let body: any = {};
    try {
      body = await req.json();
    } catch (_) {
      body = {};
    }
    const debugEnabled = body?.debug === true;
    const maxPages = Number.isFinite(Number(body?.maxPages)) ? Number(body.maxPages) : 500;
    const tokenInfo = getToken();
    const rawNmIds = Array.isArray(body?.nmIds)
      ? body.nmIds
      : Array.isArray(body?.wbSkus)
      ? body.wbSkus
      : [];
    const nmIds = rawNmIds
      .map((id: any) => Number(id))
      .filter((id: number) => Number.isFinite(id) && id > 0);
    const nmIdDebug: Record<string, unknown> = {};

    if (debugEnabled && nmIds.length) {
      const payload = {
        settings: {
          filter: { nmID: nmIds.slice(0, 100) },
          cursor: { limit: 100 },
        },
      };
      const res = await wbContentRequest("/content/v2/get/cards/list", payload);
      const cards = Array.isArray(res?.cards)
        ? res.cards
        : Array.isArray(res?.data?.cards)
        ? res.data.cards
        : Array.isArray(res?.data?.cardsList)
        ? res.data.cardsList
        : [];
      const first = cards[0] || null;
      nmIdDebug.nmIdsCount = nmIds.length;
      nmIdDebug.cardsCount = cards.length;
      nmIdDebug.firstCard = first
        ? {
            nmID: first?.nmID ?? first?.nmId,
            subjectID: first?.subjectID ?? first?.subjectId,
            subjectName: first?.subjectName,
            barcodesCount: Array.isArray(first?.barcodes) ? first.barcodes.length : 0,
          }
        : null;
      nmIdDebug.cursor = res?.cursor ?? res?.data?.cursor ?? null;
    }

    const { data: items, error } = await supabase
      .from("items")
      .select("id, code, barcode, wb_sku, mp_category_wb")
      .eq("kind", "product");
    if (error) throw error;

    const byCode = new Map<string, any>();
    const byBarcode = new Map<string, any>();
    for (const item of items ?? []) {
      if (item.code) byCode.set(String(item.code).trim().toLowerCase(), item);
      if (item.barcode) byBarcode.set(String(item.barcode).trim(), item);
    }

    let cursorUpdatedAt: string | null = null;
    let cursorNmId: number | null = null;
    let totalCards = 0;
    let matchedByCode = 0;
    let matchedByBarcode = 0;
    const updates = new Map<string, { id: string; wb_sku: string; mp_category_wb?: string | null }>();
    const debugSample: any[] = [];

    for (let page = 0; page < maxPages; page += 1) {
      const cursorPayload: Record<string, unknown> = { limit: 100 };
      if (cursorUpdatedAt) cursorPayload.updatedAt = cursorUpdatedAt;
      if (Number.isFinite(cursorNmId ?? NaN) && (cursorNmId ?? 0) > 0) {
        cursorPayload.nmID = cursorNmId;
      }
      const payload = {
        settings: {
          filter: { withPhoto: -1 },
          cursor: cursorPayload,
        },
      };

      const res = await wbContentRequest("/content/v2/get/cards/list", payload);
      const cards = Array.isArray(res?.cards)
        ? res.cards
        : Array.isArray(res?.data?.cards)
        ? res.data.cards
        : Array.isArray(res?.data?.cardsList)
        ? res.data.cardsList
        : [];
      if (!cards.length) break;

      totalCards += cards.length;

      for (const card of cards) {
        const nmId = Number(card?.nmID ?? card?.nmId);
        if (!Number.isFinite(nmId)) continue;
        const subjectName = String(card?.subjectName ?? "").trim();
        const vendorCode = String(card?.vendorCode ?? "").trim();
        const barcodes = Array.isArray(card?.barcodes) ? card.barcodes : [];

        let matched = false;
        if (vendorCode) {
          const item = byCode.get(vendorCode.toLowerCase());
          if (item) {
            matched = true;
            matchedByCode += 1;
            updates.set(item.id, {
              id: item.id,
              wb_sku: String(nmId),
              mp_category_wb: subjectName || item.mp_category_wb || null,
            });
          }
        }
        if (!matched && barcodes.length) {
          for (const bc of barcodes) {
            const barcode = String(bc ?? "").trim();
            if (!barcode) continue;
            const item = byBarcode.get(barcode);
            if (!item) continue;
            matched = true;
            matchedByBarcode += 1;
            updates.set(item.id, {
              id: item.id,
              wb_sku: String(nmId),
              mp_category_wb: subjectName || item.mp_category_wb || null,
            });
            break;
          }
        }

        if (debugEnabled && debugSample.length < 3) {
          debugSample.push({
            nmID: nmId,
            vendorCode,
            barcodesCount: barcodes.length,
            subjectName,
            matched,
          });
        }
      }

      const nextCursor = res?.cursor ?? res?.data?.cursor ?? {};
      const nextUpdatedAtRaw = nextCursor?.updatedAt ?? nextCursor?.updated_at;
      const nextUpdatedAt = normalizeUpdatedAt(nextUpdatedAtRaw);
      const nextNmIdRaw = nextCursor?.nmID ?? nextCursor?.nmId;
      const nextNmId = Number(nextNmIdRaw);
      if (!nextUpdatedAt && !Number.isFinite(nextNmId)) break;
      if (nextUpdatedAt === cursorUpdatedAt && nextNmId === (cursorNmId ?? NaN)) break;
      cursorUpdatedAt = nextUpdatedAt || null;
      cursorNmId = Number.isFinite(nextNmId) ? nextNmId : cursorNmId;
    }

    let suppliesMatched = 0;
    let suppliesTotal = 0;
    if (!totalCards) {
      const statusIDs = Array.isArray(body?.statusIds)
        ? body.statusIds.map((s: any) => Number(s)).filter((s: number) => Number.isFinite(s))
        : [1, 2, 3];
      const fromDate = body?.dateFrom ? String(body.dateFrom) : formatDate(new Date(Date.now() - 365 * 86400000));
      const tillDate = body?.dateTill ? String(body.dateTill) : formatDate(new Date());
      const dateType = body?.dateType ? String(body.dateType) : "createDate";
      const maxSupplies = Number.isFinite(Number(body?.maxSupplies)) ? Number(body.maxSupplies) : 200;

      const listBody = {
        dates: [{ from: fromDate, till: tillDate, type: dateType }],
        statusIDs,
      };
      const list = await wbSuppliesRequest("/api/v1/supplies", listBody, "POST");
      const supplies = Array.isArray(list) ? list : Array.isArray(list?.supplies) ? list.supplies : [];
      const supplyIds = supplies
        .map((s: any) => Number(s?.supplyID ?? s?.supplyId))
        .filter((id: number) => Number.isFinite(id))
        .slice(0, maxSupplies);
      suppliesTotal = supplyIds.length;

      for (const supplyId of supplyIds) {
        const goods = await wbSuppliesRequest(`/api/v1/supplies/${supplyId}/goods`, undefined, "GET");
        const items = Array.isArray(goods) ? goods : [];
        for (const row of items) {
          const barcode = String(row?.barcode ?? "").trim();
          const nmId = Number(row?.nmID ?? row?.nmId);
          if (!barcode || !Number.isFinite(nmId)) continue;
          const item = byBarcode.get(barcode);
          if (!item) continue;
          suppliesMatched += 1;
          updates.set(item.id, {
            id: item.id,
            wb_sku: String(nmId),
            mp_category_wb: item.mp_category_wb ?? null,
          });
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    let updated = 0;
    const updateRows = Array.from(updates.values());
    for (const slice of chunk(updateRows, 50)) {
      for (const row of slice) {
        const patch: Record<string, unknown> = { wb_sku: row.wb_sku };
        if (row.mp_category_wb) patch.mp_category_wb = row.mp_category_wb;
        const { error: updateError } = await supabase
          .from("items")
          .update(patch)
          .eq("id", row.id);
        if (updateError) throw updateError;
        updated += 1;
      }
    }

    return jsonResponse({
      totalCards,
      matchedByCode,
      matchedByBarcode,
      suppliesTotal,
      suppliesMatched,
      updated,
      sample: debugEnabled ? debugSample : undefined,
      token: debugEnabled
        ? {
            source: tokenInfo.source,
            length: tokenInfo.token.length,
          }
        : undefined,
      nmIdQuery: debugEnabled && nmIds.length ? nmIdDebug : undefined,
    });
  } catch (error) {
    console.error("wb-sync-skus error", error);
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : String(error),
        detail: error instanceof Error ? error.stack : null,
      },
      { status: 500 },
    );
  }
});
