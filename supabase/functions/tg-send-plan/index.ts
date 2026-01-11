import { serve } from "https://deno.land/std@0.213.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const TG_BOT_TOKEN = Deno.env.get("TG_BOT_TOKEN");
const TG_WEBAPP_URL = Deno.env.get("TG_WEBAPP_URL");
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

type TgReplyMarkup = {
  inline_keyboard?: Array<Array<{ text: string; callback_data?: string; web_app?: { url: string } }>>;
};

const sendMessage = async (chatId: number | string, text: string, replyMarkup?: TgReplyMarkup) => {
  const payload: Record<string, unknown> = { chat_id: chatId, text };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await fetch(tgApi("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
};

const chunkText = (text: string, limit = 3500) => {
  const chunks: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if ((buf + line + "\n").length > limit) {
      if (buf) chunks.push(buf.trimEnd());
      buf = "";
    }
    buf += `${line}\n`;
  }
  if (buf.trim()) chunks.push(buf.trimEnd());
  return chunks;
};

const formatLine = (code: string, name: string, plan: number, fact: number) =>
  `${code || "—"} · ${name} — план ${plan}, факт ${fact}`;

const loadPlans = async (physWarehouseId: string, dateISO: string) => {
  const [{ data: fgRows, error: fgErr }, { data: semiRows, error: semiErr }] = await Promise.all([
    supabase
      .from("plans_fg")
      .select("product_id, qty, fact_qty")
      .eq("phys_warehouse_id", physWarehouseId)
      .eq("date_iso", dateISO)
      .gt("qty", 0),
    supabase
      .from("plans_semi")
      .select("semi_id, qty, fact_qty")
      .eq("phys_warehouse_id", physWarehouseId)
      .eq("date_iso", dateISO)
      .gt("qty", 0),
  ]);
  if (fgErr) throw fgErr;
  if (semiErr) throw semiErr;

  const fgIds = Array.from(new Set((fgRows ?? []).map((r: any) => r.product_id).filter(Boolean)));
  const semiIds = Array.from(new Set((semiRows ?? []).map((r: any) => r.semi_id).filter(Boolean)));
  const itemIds = Array.from(new Set([...fgIds, ...semiIds]));

  const { data: items, error: itemsErr } = itemIds.length
    ? await supabase.from("items").select("id, code, name").in("id", itemIds)
    : { data: [], error: null };
  if (itemsErr) throw itemsErr;

  const itemMap = new Map<string, { code: string; name: string }>();
  (items ?? []).forEach((it: any) => itemMap.set(it.id, { code: it.code ?? "", name: it.name ?? "" }));

  const fgLines = (fgRows ?? []).map((r: any) => ({
    id: r.product_id,
    plan: Number(r.qty) || 0,
    fact: Number(r.fact_qty) || 0,
    ...itemMap.get(r.product_id),
  }));
  const semiLines = (semiRows ?? []).map((r: any) => ({
    id: r.semi_id,
    plan: Number(r.qty) || 0,
    fact: Number(r.fact_qty) || 0,
    ...itemMap.get(r.semi_id),
  }));

  return { fgLines, semiLines };
};

const upsertTask = async (
  physWarehouseId: string,
  dateISO: string,
  chatId: string,
  fgLines: any[],
  semiLines: any[],
) => {
  const { data: task, error: taskErr } = await supabase
    .from("prod_task_headers")
    .upsert(
      { plan_date: dateISO, phys_warehouse_id: physWarehouseId, tg_chat_id: chatId },
      { onConflict: "plan_date,phys_warehouse_id" },
    )
    .select("id")
    .maybeSingle();
  if (taskErr) throw taskErr;
  const taskId = task?.id;
  if (!taskId) return null;

  const payload = [
    ...semiLines.map((l: any) => ({
      task_id: taskId,
      plan_kind: "semi",
      plan_item_id: l.id,
      plan_qty: l.plan,
    })),
    ...fgLines.map((l: any) => ({
      task_id: taskId,
      plan_kind: "fg",
      plan_item_id: l.id,
      plan_qty: l.plan,
    })),
  ];

  if (!payload.length) return taskId;
  const { error: lineErr } = await supabase
    .from("prod_task_lines")
    .upsert(payload, { onConflict: "task_id,plan_kind,plan_item_id" });
  if (lineErr) throw lineErr;
  return taskId;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: baseHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: baseHeaders });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch (_) {
    body = {};
  }

  const physWarehouseId = String(body?.physWarehouseId ?? "").trim();
  const dateISO = String(body?.dateISO ?? "").trim();
  if (!physWarehouseId || !dateISO) {
    return new Response(JSON.stringify({ error: "physWarehouseId and dateISO are required" }), { status: 400, headers: baseHeaders });
  }

  const { data: wh, error: whErr } = await supabase
    .from("warehouses")
    .select("id, name, tg_chat_id")
    .eq("id", physWarehouseId)
    .eq("type", "physical")
    .maybeSingle();
  if (whErr) throw whErr;
  if (!wh?.tg_chat_id) {
    return new Response(JSON.stringify({ error: "tg_chat_id not set for warehouse" }), { status: 400, headers: baseHeaders });
  }

  const { fgLines, semiLines } = await loadPlans(physWarehouseId, dateISO);
  const taskId = await upsertTask(physWarehouseId, dateISO, String(wh.tg_chat_id), fgLines, semiLines);

  const lines: string[] = [];
  lines.push(`План на ${dateISO} · ${wh.name}`);
  if (semiLines.length) {
    lines.push("");
    lines.push("Полуфабрикаты:");
    semiLines.forEach((l: any) => lines.push(formatLine(l.code ?? "", l.name ?? "", l.plan, l.fact)));
  }
  if (fgLines.length) {
    lines.push("");
    lines.push("Готовая продукция:");
    fgLines.forEach((l: any) => lines.push(formatLine(l.code ?? "", l.name ?? "", l.plan, l.fact)));
  }
  if (!semiLines.length && !fgLines.length) {
    lines.push("");
    lines.push("Нет планов на сегодня.");
  }

  const chunks = chunkText(lines.join("\n"));
  const link = taskId
    ? (TG_BOT_USERNAME
      ? `https://t.me/${TG_BOT_USERNAME}?start=report_${taskId}`
      : TG_WEBAPP_URL ?? "")
    : "";
  const button = taskId && link
    ? { text: "Сдать отчёт", url: link }
    : taskId
      ? { text: "Сдать отчёт", callback_data: `report:start:${taskId}` }
      : null;

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const replyMarkup = isLast && button ? { inline_keyboard: [[button]] } : undefined;
    await sendMessage(wh.tg_chat_id, chunks[i], replyMarkup);
  }

  return new Response(JSON.stringify({ ok: true }), { headers: baseHeaders });
});
