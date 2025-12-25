import { serve } from "https://deno.land/std@0.213.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.2";

type ChannelCode = "WB" | "OZON";

type RemoteWarehouse = {
  externalId: string;
  name: string;
  region?: string;
  address?: string;
  meta?: Record<string, unknown> | null;
  isActive?: boolean;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const WB_API_TOKEN = Deno.env.get("WB_API_TOKEN");
const WB_CONTENT_TOKEN = Deno.env.get("WB_CONTENT_TOKEN");
const OZON_CLIENT_ID = Deno.env.get("OZON_CLIENT_ID");
const OZON_API_KEY = Deno.env.get("OZON_API_KEY");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const WB_ENDPOINT = "https://supplies-api.wildberries.ru/api/v1/warehouses";
const OZON_ENDPOINT = "https://api-seller.ozon.ru/v1/supplier/available_warehouses";

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

const randomId = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

async function fetchChannelId(code: ChannelCode): Promise<string> {
  const { data, error } = await supabase
    .from("mp_channels")
    .select("id")
    .eq("code", code)
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) throw new Error(`Не найден канал ${code}`);
  return data.id as string;
}

async function fetchWbWarehouses(): Promise<RemoteWarehouse[]> {
  const rawToken = WB_API_TOKEN || WB_CONTENT_TOKEN || "";
  const token = rawToken.replace(/[^\x21-\x7E]/g, "").trim();
  if (!token) throw new Error("WB_API_TOKEN/WB_CONTENT_TOKEN не задан в окружении");

  const res = await fetch(WB_ENDPOINT, {
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WB API ${res.status}: ${text || res.statusText}`);
  }
  const json = await res.json();
  if (!Array.isArray(json)) return [];
  return json.map((row: any): RemoteWarehouse => {
    const region =
      row?.oblast ?? row?.region ?? row?.city ?? row?.area ?? row?.settlement ?? row?.addressRegion ?? "";
    const addressParts = [row?.city, row?.address, row?.addressForFbs, row?.addressPpochta]
      .filter((part: unknown) => typeof part === "string" && part.trim().length > 0)
      .map((part: string) => part.trim());
    return {
      externalId: String(row?.id ?? row?.warehouseId ?? row?.warehouse_id ?? row?.name ?? randomId()),
      name: (row?.name ?? `WB склад ${row?.id ?? ""}`).trim(),
      region: region || undefined,
      address: addressParts.length ? addressParts.join(", ") : undefined,
      meta: row ?? null,
      isActive: Boolean(row?.isWork ?? true),
    };
  });
}

async function fetchOzonWarehouses(): Promise<RemoteWarehouse[]> {
  const clientId = (OZON_CLIENT_ID ?? "").replace(/\s+/g, "").trim();
  const apiKey = (OZON_API_KEY ?? "").replace(/\s+/g, "").trim();
  if (!clientId || !apiKey) {
    throw new Error("OZON_CLIENT_ID / OZON_API_KEY не заданы");
  }

  const res = await fetch(OZON_ENDPOINT, {
    method: "GET",
    headers: {
      "Client-Id": clientId,
      "Api-Key": apiKey,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ozon API ${res.status}: ${text || res.statusText}`);
  }
  const json = await res.json();
  const rows: any[] = Array.isArray(json?.result) ? json.result : [];
  return rows.map((row) => {
    const warehouse = row?.warehouse ?? {};
    const addressParts = [warehouse?.city, warehouse?.address, row?.address]
      .filter((part: unknown) => typeof part === "string" && part.trim().length > 0)
      .map((part: string) => part.trim());
    return {
      externalId: String(
        warehouse?.warehouse_id ?? row?.warehouse_id ?? warehouse?.id ?? row?.id ?? warehouse?.name ?? randomId(),
      ),
      name: (warehouse?.name ?? `Ozon склад ${warehouse?.warehouse_id ?? ""}`).trim(),
      region: (warehouse?.city ?? warehouse?.region ?? row?.region ?? "") || undefined,
      address: addressParts.length ? addressParts.join(", ") : undefined,
      meta: row ?? null,
      isActive: true,
    };
  });
}

async function upsertWarehouses(channel: ChannelCode, warehouses: RemoteWarehouse[]) {
  if (!warehouses.length) return { inserted: 0 };
  const channelId = await fetchChannelId(channel);
  const rows = warehouses.map((w) => ({
    channel_id: channelId,
    external_id: w.externalId,
    name: w.name,
    region: w.region ?? null,
    address: w.address ?? null,
    meta: w.meta ?? null,
    is_active: w.isActive ?? true,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase
    .from("mp_destinations")
    .upsert(rows, { onConflict: "channel_id,external_id" });
  if (error) throw error;
  return { inserted: rows.length };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: baseHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }

  let channel = "";
  try {
    const body = await req.json();
    if (body?.channel) channel = String(body.channel);
  } catch (_) {
    // ignore body parse errors
  }
  if (!channel) {
    const url = new URL(req.url);
    channel = url.searchParams.get("channel") ?? "";
  }
  channel = channel.toUpperCase();

  if (channel !== "WB" && channel !== "OZON") {
    return jsonResponse({ error: "channel must be WB or OZON" }, { status: 400 });
  }

  try {
    const remote = channel === "WB" ? await fetchWbWarehouses() : await fetchOzonWarehouses();
    const result = await upsertWarehouses(channel as ChannelCode, remote);
    return jsonResponse({ channel, ...result });
  } catch (err) {
    console.error("sync-mp-warehouses", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return jsonResponse({ error: message }, { status: 500 });
  }
});
