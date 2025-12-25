import { serve } from "https://deno.land/std@0.213.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.2";

const WB_CONTENT_BASE = "https://content-api.wildberries.ru";
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
  new Response(JSON.stringify(body, null, 2), {
    headers: baseHeaders,
    ...init,
  });

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

const hashToken = async (token: string) => {
  if (!token) return "";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hash.slice(0, 12);
};

const wbContentRequest = async (path: string, body: Record<string, unknown>) => {
  const { token } = getToken();
  if (!token) throw new Error("WB_CONTENT_TOKEN не задан");

  const url = `${WB_CONTENT_BASE}${path}`;
  let delay = 400;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
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

const wbContentRequestRaw = async (path: string, body: Record<string, unknown>) => {
  const { token } = getToken();
  if (!token) throw new Error("WB_CONTENT_TOKEN не задан");

  const url = `${WB_CONTENT_BASE}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_) {
    json = null;
  }
  return {
    ok: res.ok,
    status: res.status,
    contentType: res.headers.get("content-type"),
    text: text.slice(0, 2000),
    json,
  };
};

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: baseHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, { status: 405 });

  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch (_) {
      body = {};
    }

    const raw = Array.isArray(body?.barcodes) ? body.barcodes : Array.isArray(body) ? body : [];
    const barcodes = raw.map((b: any) => String(b ?? "").trim()).filter(Boolean);
    const rawNmIds = Array.isArray(body?.nmIds)
      ? body.nmIds
      : Array.isArray(body?.wbSkus)
      ? body.wbSkus
      : [];
    const rawVendorCodes = Array.isArray(body?.vendorCodes)
      ? body.vendorCodes
      : Array.isArray(body?.codes)
      ? body.codes
      : [];
    const nmIds = rawNmIds
      .map((id: any) => Number(id))
      .filter((id: number) => Number.isFinite(id) && id > 0);
    const vendorCodes = rawVendorCodes.map((code: any) => String(code ?? "").trim()).filter(Boolean);

    const debugEnabled = body?.debug === true;
    const probeEnabled = body?.probe === true;
    const tokenInfo = getToken();
    const debug: Record<string, unknown> = {
      barcodesCount: barcodes.length,
      nmIdsCount: nmIds.length,
      vendorCodesCount: vendorCodes.length,
    };
    if (debugEnabled) {
      debug.token = {
        source: tokenInfo.source,
        length: tokenInfo.token.length,
        hash: await hashToken(tokenInfo.token),
      };
    }
    if (debugEnabled && probeEnabled) {
      const payload = {
        settings: {
          filter: { withPhoto: -1 },
          cursor: { limit: 1 },
        },
      };
      debug.probe = {
        payload,
        response: await wbContentRequestRaw("/content/v2/get/cards/list", payload),
      };
    }

    if (!barcodes.length && !nmIds.length) {
      return jsonResponse({
        items: [],
        debug: debugEnabled ? { reason: "empty-input", barcodesCount: 0, nmIdsCount: 0 } : undefined,
      });
    }

    const uniq = Array.from(new Set(barcodes));
    const uniqNmIds = Array.from(new Set(nmIds));
    const uniqVendorCodes = Array.from(new Set(vendorCodes));
    const byBarcode = new Map<
      string,
      { barcode?: string; nmId?: number; subjectId?: number; subjectName?: string; vendorCode?: string }
    >();
    const byNmId = new Map<
      number,
      { barcode?: string; nmId?: number; subjectId?: number; subjectName?: string; vendorCode?: string }
    >();
    const byVendorCode = new Map<
      string,
      { barcode?: string; nmId?: number; subjectId?: number; subjectName?: string; vendorCode?: string }
    >();

    const addResult = (entry: { barcode?: string; nmId?: number; subjectId?: number; subjectName?: string; vendorCode?: string }) => {
      if (entry.barcode) byBarcode.set(entry.barcode, entry);
      if (Number.isFinite(entry.nmId ?? NaN)) byNmId.set(entry.nmId as number, entry);
      if (entry.vendorCode) byVendorCode.set(entry.vendorCode, entry);
    };

    const collectFromCards = (cards: any[]) => {
      for (const card of cards) {
        const subjectId = Number(card?.subjectID ?? card?.subjectId);
        const subjectName = String(card?.subjectName ?? "").trim();
        const nmId = Number(card?.nmID ?? card?.nmId);
        const vendorCode = String(card?.vendorCode ?? "").trim() || undefined;
        const entryBase = {
          nmId: Number.isFinite(nmId) ? nmId : undefined,
          subjectId: Number.isFinite(subjectId) ? subjectId : undefined,
          subjectName,
          vendorCode,
        };
        const directBarcodes = Array.isArray(card?.barcodes) ? card.barcodes : [];
        const sizeSkus = Array.isArray(card?.sizes)
          ? card.sizes.flatMap((size: any) =>
              Array.isArray(size?.skus) ? size.skus.map((sku: any) => String(sku ?? "").trim()) : []
            )
          : [];
        const cardBarcodes = Array.from(
          new Set([...directBarcodes, ...sizeSkus].map((bc) => String(bc ?? "").trim()).filter(Boolean)),
        );
        if (cardBarcodes.length) {
          for (const bc of cardBarcodes) {
            const code = String(bc ?? "").trim();
            if (!code) continue;
            addResult({ ...entryBase, barcode: code });
          }
        } else {
          addResult(entryBase);
        }
      }
    };

    for (const slice of chunk(uniq, 100)) {
      const payload = {
        settings: {
          filter: { barcode: slice },
          cursor: { limit: 100 },
        },
      };
      const res = await wbContentRequest("/content/v2/get/cards/list", payload);
      if (debugEnabled && !debug.barcodeQuery) {
        const cards = Array.isArray(res?.cards)
          ? res.cards
          : Array.isArray(res?.data?.cards)
          ? res.data.cards
          : Array.isArray(res?.data?.cardsList)
          ? res.data.cardsList
          : [];
        const first = cards[0] || null;
        debug.barcodeQuery = {
          payload,
          cardsCount: cards.length,
          firstCard: first
            ? {
                nmID: first?.nmID ?? first?.nmId,
                subjectID: first?.subjectID ?? first?.subjectId,
                subjectName: first?.subjectName,
                barcodesCount: Array.isArray(first?.barcodes) ? first.barcodes.length : 0,
                skusCount: Array.isArray(first?.sizes)
                  ? first.sizes.reduce((sum: number, size: any) => {
                      const count = Array.isArray(size?.skus) ? size.skus.length : 0;
                      return sum + count;
                    }, 0)
                  : 0,
              }
            : null,
          cursor: res?.cursor ?? res?.data?.cursor ?? null,
        };
      }
      const cards = Array.isArray(res?.cards)
        ? res.cards
        : Array.isArray(res?.data?.cards)
        ? res.data.cards
        : Array.isArray(res?.data?.cardsList)
        ? res.data.cardsList
        : [];
      collectFromCards(cards);
    }

    for (const slice of chunk(uniqVendorCodes, 100)) {
      const payload = {
        settings: {
          filter: { vendorCode: slice },
          cursor: { limit: 100 },
        },
      };
      const res = await wbContentRequest("/content/v2/get/cards/list", payload);
      if (debugEnabled && !debug.vendorCodeQuery) {
        const cards = Array.isArray(res?.cards)
          ? res.cards
          : Array.isArray(res?.data?.cards)
          ? res.data.cards
          : Array.isArray(res?.data?.cardsList)
          ? res.data.cardsList
          : [];
        const first = cards[0] || null;
        debug.vendorCodeQuery = {
          payload,
          cardsCount: cards.length,
          firstCard: first
            ? {
                nmID: first?.nmID ?? first?.nmId,
                subjectID: first?.subjectID ?? first?.subjectId,
                subjectName: first?.subjectName,
                vendorCode: first?.vendorCode,
                barcodesCount: Array.isArray(first?.barcodes) ? first.barcodes.length : 0,
                skusCount: Array.isArray(first?.sizes)
                  ? first.sizes.reduce((sum: number, size: any) => {
                      const count = Array.isArray(size?.skus) ? size.skus.length : 0;
                      return sum + count;
                    }, 0)
                  : 0,
              }
            : null,
          cursor: res?.cursor ?? res?.data?.cursor ?? null,
        };
      }
      const cards = Array.isArray(res?.cards)
        ? res.cards
        : Array.isArray(res?.data?.cards)
        ? res.data.cards
        : Array.isArray(res?.data?.cardsList)
        ? res.data.cardsList
        : [];
      collectFromCards(cards);
    }

    if (!byBarcode.size && !byVendorCode.size && uniqNmIds.length) {
      for (const slice of chunk(uniqNmIds, 100)) {
        const payload = {
          settings: {
            filter: { nmID: slice },
            cursor: { limit: 100 },
          },
        };
        const res = await wbContentRequest("/content/v2/get/cards/list", payload);
        if (debugEnabled && !debug.nmIdQuery) {
          const cards = Array.isArray(res?.cards)
            ? res.cards
            : Array.isArray(res?.data?.cards)
            ? res.data.cards
            : Array.isArray(res?.data?.cardsList)
            ? res.data.cardsList
            : [];
          const first = cards[0] || null;
          debug.nmIdQuery = {
            payload,
            cardsCount: cards.length,
          firstCard: first
            ? {
                nmID: first?.nmID ?? first?.nmId,
                subjectID: first?.subjectID ?? first?.subjectId,
                subjectName: first?.subjectName,
                barcodesCount: Array.isArray(first?.barcodes) ? first.barcodes.length : 0,
                skusCount: Array.isArray(first?.sizes)
                  ? first.sizes.reduce((sum: number, size: any) => {
                      const count = Array.isArray(size?.skus) ? size.skus.length : 0;
                      return sum + count;
                    }, 0)
                  : 0,
              }
            : null,
          cursor: res?.cursor ?? res?.data?.cursor ?? null,
        };
        }
        const cards = Array.isArray(res?.cards)
          ? res.cards
          : Array.isArray(res?.data?.cards)
          ? res.data.cards
          : Array.isArray(res?.data?.cardsList)
          ? res.data.cardsList
          : [];
        collectFromCards(cards);
      }
    }

    // Fallback: scan cards list if filter by barcode returns nothing.
    if (!byBarcode.size && !byNmId.size && !byVendorCode.size && (uniq.length || uniqNmIds.length || uniqVendorCodes.length)) {
      const remaining = new Set(uniq);
      let cursorUpdatedAt: string | null = null;
      let cursorNmId: number | null = null;

      for (let guard = 0; guard < 200 && remaining.size; guard += 1) {
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
        if (debugEnabled && !debug.scanQuery) {
          const cards = Array.isArray(res?.cards)
            ? res.cards
            : Array.isArray(res?.data?.cards)
            ? res.data.cards
            : Array.isArray(res?.data?.cardsList)
            ? res.data.cardsList
            : [];
          const first = cards[0] || null;
          debug.scanQuery = {
            payload,
            cardsCount: cards.length,
          firstCard: first
            ? {
                nmID: first?.nmID ?? first?.nmId,
                subjectID: first?.subjectID ?? first?.subjectId,
                subjectName: first?.subjectName,
                barcodesCount: Array.isArray(first?.barcodes) ? first.barcodes.length : 0,
                skusCount: Array.isArray(first?.sizes)
                  ? first.sizes.reduce((sum: number, size: any) => {
                      const count = Array.isArray(size?.skus) ? size.skus.length : 0;
                      return sum + count;
                    }, 0)
                  : 0,
              }
            : null,
          cursor: res?.cursor ?? res?.data?.cursor ?? null,
        };
        }
        const cards = Array.isArray(res?.cards)
          ? res.cards
          : Array.isArray(res?.data?.cards)
          ? res.data.cards
          : Array.isArray(res?.data?.cardsList)
          ? res.data.cardsList
          : [];
        if (!cards.length) break;

        collectFromCards(cards);
        for (const code of remaining) {
          if (byBarcode.has(code)) remaining.delete(code);
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
    }

    const items = [
      ...byBarcode.values(),
      ...Array.from(byVendorCode.values()).filter((entry) => !entry.barcode),
      ...Array.from(byNmId.values()).filter((entry) => !entry.barcode && !entry.vendorCode),
    ];

    if (supabase) {
      const updates = items.filter((row) => row.barcode && row.subjectName);
      for (const row of updates) {
        const { error } = await supabase
          .from("items")
          .update({ mp_category_wb: row.subjectName })
          .eq("barcode", row.barcode as string);
        if (error) throw error;
      }

      const codeUpdates = items.filter((row) => row.vendorCode && row.subjectName);
      for (const row of codeUpdates) {
        const { error } = await supabase
          .from("items")
          .update({ mp_category_wb: row.subjectName })
          .eq("code", row.vendorCode as string);
        if (error) throw error;
      }

      const nmUpdates = new Map<number, string>();
      for (const row of items) {
        if (row.nmId && row.subjectName) nmUpdates.set(row.nmId, row.subjectName);
      }
      for (const [nmId, subjectName] of nmUpdates.entries()) {
        const { error } = await supabase
          .from("items")
          .update({ mp_category_wb: subjectName })
          .eq("wb_sku", String(nmId));
        if (error) throw error;
      }
    }

    return jsonResponse({ items, debug: debugEnabled ? debug : undefined });
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
});
