import { serve } from "https://deno.land/std@0.213.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const TG_BOT_TOKEN = Deno.env.get("TG_BOT_TOKEN");
const TG_BOT_USERNAME = Deno.env.get("TG_BOT_USERNAME");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}
if (!TG_BOT_TOKEN) {
  throw new Error("TG_BOT_TOKEN must be set");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const baseHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type,authorization,apikey,x-client-info",
};

const tgApi = (method: string) => `https://api.telegram.org/bot${TG_BOT_TOKEN}/${method}`;

const sendMessage = async (chatId: number | string, text: string) => {
  const payload: Record<string, unknown> = { chat_id: chatId, text };
  if (TG_BOT_USERNAME) {
    payload.reply_markup = {
      inline_keyboard: [[{ text: "Перейти в личку", url: `https://t.me/${TG_BOT_USERNAME}?start=bind` }]],
    };
  }
  await fetch(tgApi("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: baseHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: baseHeaders });

  const body = await req.json().catch(() => ({}));
  const tgUserId = body?.tgUserId;
  const warehouseId = body?.warehouseId;

  if (!tgUserId || !warehouseId) {
    return new Response("Missing tgUserId or warehouseId", { status: 400, headers: baseHeaders });
  }

  const { data: user, error: userErr } = await supabase
    .from("tg_users")
    .select("id, username, role, status")
    .eq("id", tgUserId)
    .maybeSingle();
  if (userErr) return new Response(userErr.message, { status: 500, headers: baseHeaders });
  if (!user || user.role !== "controller") {
    return new Response("Not a controller", { status: 200, headers: baseHeaders });
  }

  const { data: wh, error: whErr } = await supabase
    .from("warehouses")
    .select("id, name, type, parent_id, tg_chat_id")
    .eq("id", warehouseId)
    .maybeSingle();
  if (whErr) return new Response(whErr.message, { status: 500, headers: baseHeaders });
  if (!wh) return new Response("Warehouse not found", { status: 404, headers: baseHeaders });

  let targetChatId = wh.tg_chat_id as string | null;
  let warehouseName = wh.name as string;
  if (wh.type === "virtual") {
    const { data: parent, error: parentErr } = await supabase
      .from("warehouses")
      .select("id, name, tg_chat_id")
      .eq("id", wh.parent_id)
      .maybeSingle();
    if (parentErr) return new Response(parentErr.message, { status: 500, headers: baseHeaders });
    if (parent) {
      targetChatId = parent.tg_chat_id;
      warehouseName = `${parent.name} / ${wh.name}`;
    }
  }

  if (!targetChatId) {
    return new Response("Warehouse chat is not set", { status: 200, headers: baseHeaders });
  }

  const mention = user.username ? `@${user.username}` : "контролёр";
  const text = `${mention}, вы назначены контролёром по складу "${warehouseName}". Перейдите в личку и подтвердите назначение.`;
  await sendMessage(targetChatId, text);

  return new Response("ok", { headers: baseHeaders });
});
