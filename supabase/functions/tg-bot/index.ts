import { serve } from "https://deno.land/std@0.213.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const TG_BOT_TOKEN = Deno.env.get("TG_BOT_TOKEN");
const TG_BOT_USERNAME = Deno.env.get("TG_BOT_USERNAME");
const TG_WEBAPP_URL = Deno.env.get("TG_WEBAPP_URL");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}
if (!TG_BOT_TOKEN) {
  throw new Error("TG_BOT_TOKEN must be set");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const EKAT_TZ = "Asia/Yekaterinburg";
const toEkatISO = (d: Date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: EKAT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
};

const baseHeaders = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "content-type,authorization,apikey,x-client-info",
};

const tgApi = (method: string) => `https://api.telegram.org/bot${TG_BOT_TOKEN}/${method}`;

type TgInlineButton = { text: string; url?: string; callback_data?: string; web_app?: { url: string } };
type TgReplyMarkup = {
  inline_keyboard?: Array<Array<TgInlineButton>>;
  keyboard?: Array<Array<{ text: string }>>;
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
};

const sendMessage = async (
  chatId: number | string,
  text: string,
  replyMarkup?: TgReplyMarkup,
) => {
  const payload = { chat_id: chatId, text, reply_markup: replyMarkup };
  const res = await fetch(tgApi("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("[tg-bot] sendMessage failed", { status: res.status, body });
  }
};

const answerCallback = async (callbackQueryId: string, text?: string) => {
  const payload: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text) payload.text = text;
  await fetch(tgApi("answerCallbackQuery"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
};

const parseCommand = (text: string) => {
  const m = text.trim().match(/^\/([a-zA-Z0-9_]+)(?:@[\w_]+)?/);
  return m ? m[1].toLowerCase() : null;
};

const parseStartPayload = (text: string) => {
  const m = text.trim().match(/^\/start(?:@[\w_]+)?(?:\s+(.+))?$/i);
  if (!m) return null;
  const payload = (m[1] || "").trim();
  return payload || null;
};

const normalizeUsername = (raw?: string | null) => {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  return s.startsWith("@") ? s.slice(1) : s;
};

const isCyrillicWord = (value: string) => /^[А-Яа-яЁё-]+$/.test(value);

const titleCasePart = (value: string) => {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLocaleLowerCase("ru-RU");
      return `${lower.charAt(0).toLocaleUpperCase("ru-RU")}${lower.slice(1)}`;
    })
    .join("-");
};

const normalizeFullName = (first?: string | null, last?: string | null) => {
  const firstClean = String(first ?? "").trim();
  const lastClean = String(last ?? "").trim();
  if (!firstClean || !lastClean) return null;
  if (!isCyrillicWord(firstClean) || !isCyrillicWord(lastClean)) return null;
  return {
    first_name: titleCasePart(firstClean),
    last_name: titleCasePart(lastClean),
  };
};

const hasValidCyrillicName = (first?: string | null, last?: string | null) => {
  const firstClean = String(first ?? "").trim();
  const lastClean = String(last ?? "").trim();
  if (!firstClean || !lastClean) return false;
  return isCyrillicWord(firstClean) && isCyrillicWord(lastClean);
};

const parseNameFromText = (text: string) => {
  const cleaned = text.trim().replace(/\s+/g, " ");
  const parts = cleaned.split(" ");
  if (parts.length < 2) return null;
  const [first, last] = parts;
  return normalizeFullName(first, last);
};

const upsertTgUser = async (user: any) => {
  if (!user?.id) return null;
  const username = normalizeUsername(user.username);
  const normalized = normalizeFullName(user.first_name, user.last_name);
  const payload = {
    tg_user_id: Number(user.id),
    username,
    first_name: normalized?.first_name ?? null,
    last_name: normalized?.last_name ?? null,
    status: normalized ? "active" : "pending",
    updated_at: new Date().toISOString(),
  };
  const { data: existing, error: findErr } = await supabase
    .from("tg_users")
    .select("id, status, role, first_name, last_name, last_prompt_at")
    .eq("tg_user_id", payload.tg_user_id)
    .maybeSingle();
  if (findErr) throw findErr;
  if (existing?.id) {
    const nextStatus =
      existing.status === "disabled"
        ? "disabled"
        : existing.status === "active"
          ? "active"
          : payload.status;
    const existingValid = hasValidCyrillicName(existing.first_name, existing.last_name);
    const nextPayload = {
      ...payload,
      status: nextStatus,
      first_name: payload.first_name ?? (existingValid ? existing.first_name : null),
      last_name: payload.last_name ?? (existingValid ? existing.last_name : null),
    };
    const { error } = await supabase.from("tg_users").update(nextPayload).eq("id", existing.id);
    if (error) throw error;
    return {
      id: existing.id,
      status: nextStatus,
      role: existing.role,
      hasName: hasValidCyrillicName(nextPayload.first_name, nextPayload.last_name),
      lastPromptAt: existing.last_prompt_at,
    };
  }

  if (username) {
    const { data: pending, error: pendingErr } = await supabase
      .from("tg_users")
      .select("id, status, role")
      .eq("status", "pending")
      .is("tg_user_id", null)
      .ilike("username", username)
      .maybeSingle();
    if (pendingErr) throw pendingErr;
    if (pending?.id) {
      const { error } = await supabase
        .from("tg_users")
        .update(payload)
        .eq("id", pending.id);
      if (error) throw error;
      return {
        id: pending.id,
        status: payload.status,
        role: pending.role,
        hasName: hasValidCyrillicName(payload.first_name, payload.last_name),
        lastPromptAt: null,
      };
    }
  }

  const { data, error } = await supabase
    .from("tg_users")
    .insert({ ...payload, role: "executor" })
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return {
    id: data?.id ?? null,
    status: payload.status,
    role: "executor",
    hasName: hasValidCyrillicName(payload.first_name, payload.last_name),
    lastPromptAt: null,
  };
};

const ensureCyrillicName = async (
  userRow: any,
  chatId: number | string,
  text: string,
  cmd: string | null,
  chatType: string | null,
) => {
  if (!userRow?.id) return { updated: false };
  const isPrivate = chatType === "private";

  if (userRow.status === "active" && !userRow.hasName) {
    const parsed = cmd ? null : parseNameFromText(text);
    if (parsed) {
      const { error } = await supabase
        .from("tg_users")
        .update({ ...parsed })
        .eq("id", userRow.id);
      if (!error) {
        await sendMessage(chatId, `Спасибо! Сохранил: ${parsed.first_name} ${parsed.last_name}.`);
        return { updated: true };
      }
    }
    if (isPrivate) {
      await sendMessage(chatId, "Напишите, пожалуйста, фамилию и имя на русском языке в формате: Имя Фамилия.");
    }
    return { updated: false };
  }

  if (userRow.status !== "pending") return { updated: false };

  const textLower = String(text ?? "").trim().toLowerCase();

  if (userRow.role === "controller") {
    if (isPrivate && ["принято", "принял", "приняла"].includes(textLower)) {
      const { error } = await supabase.from("tg_users").update({ status: "active" }).eq("id", userRow.id);
      if (!error) {
        await sendMessage(chatId, "Назначение контролёра подтверждено.");
        if (!userRow.hasName) {
          await sendMessage(chatId, "Напишите, пожалуйста, фамилию и имя на русском языке в формате: Имя Фамилия.");
        }
        return { updated: true };
      }
    }

    if (!isPrivate) {
      const now = Date.now();
      const lastPromptAt = userRow.lastPromptAt ? new Date(userRow.lastPromptAt).getTime() : 0;
      if (lastPromptAt && now - lastPromptAt < 15 * 60 * 1000) {
        return { updated: false };
      }
      const link = TG_BOT_USERNAME ? `https://t.me/${TG_BOT_USERNAME}?start=bind` : null;
      const replyMarkup = link
        ? { inline_keyboard: [[{ text: "Перейти в личку", url: link }]] }
        : undefined;
      await sendMessage(chatId, "Перейдите в личку и подтвердите назначение контролёра.", replyMarkup);
      await supabase.from("tg_users").update({ last_prompt_at: new Date().toISOString() }).eq("id", userRow.id);
      return { updated: false };
    }

    await sendMessage(chatId, "Подтвердите назначение: напишите «Принято».");
    return { updated: false };
  }

  if (userRow.hasName) return { updated: false };

  const parsed = cmd ? null : parseNameFromText(text);
  if (parsed) {
    const { error } = await supabase
      .from("tg_users")
      .update({ ...parsed, status: "active" })
      .eq("id", userRow.id);
    if (!error) {
      await sendMessage(chatId, `Спасибо! Сохранил: ${parsed.first_name} ${parsed.last_name}.`);
      return { updated: true };
    }
  }

  const now = Date.now();
  const lastPromptAt = userRow.lastPromptAt ? new Date(userRow.lastPromptAt).getTime() : 0;
  if (!isPrivate && lastPromptAt && now - lastPromptAt < 15 * 60 * 1000) {
    return { updated: false };
  }

  if (isPrivate) {
    await sendMessage(chatId, "Напишите, пожалуйста, фамилию и имя на русском языке в формате: Имя Фамилия.");
  } else {
    const link = TG_BOT_USERNAME ? `https://t.me/${TG_BOT_USERNAME}?start=bind` : null;
    const replyMarkup = link
      ? { inline_keyboard: [[{ text: "Перейти в личку", url: link }]] }
      : undefined;
    await sendMessage(
      chatId,
      "Укажите имя и фамилию кириллицей в формате: Имя Фамилия. Можно ответить тут или в личке.",
      replyMarkup,
    );
  }
  await supabase.from("tg_users").update({ last_prompt_at: new Date().toISOString() }).eq("id", userRow.id);
  return { updated: false };
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

const getSession = async (tgUserId: string) => {
  const { data, error } = await supabase
    .from("tg_user_sessions")
    .select("id, kind, payload")
    .eq("tg_user_id", tgUserId)
    .maybeSingle();
  if (error) throw error;
  return data;
};

const setSession = async (tgUserId: string, kind: string, payload: Record<string, unknown>) => {
  const { error } = await supabase
    .from("tg_user_sessions")
    .upsert(
      { tg_user_id: tgUserId, kind, payload, updated_at: new Date().toISOString() },
      { onConflict: "tg_user_id" },
    );
  if (error) throw error;
};

const clearSession = async (tgUserId: string) => {
  const { error } = await supabase.from("tg_user_sessions").delete().eq("tg_user_id", tgUserId);
  if (error) throw error;
};

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

const getZonesForPhys = async (physWarehouseId: string) => {
  const { data, error } = await supabase
    .from("warehouses")
    .select("id, name, parent_id, type")
    .eq("parent_id", physWarehouseId);
  if (error) throw error;
  const zones = (data || []) as Array<{ id: string; name: string }>;
  const byName = (needle: RegExp) => zones.find((z) => needle.test(z.name));
  const fgZone = byName(/готов/i) ?? zones[0];
  const matZone = byName(/материал/i) ?? zones[0];
  const semiZone = byName(/полуфабрик/i) ?? matZone ?? zones[0];
  return {
    fgZoneId: fgZone?.id ?? null,
    matZoneId: matZone?.id ?? null,
    semiZoneId: semiZone?.id ?? null,
  };
};

const getUserPhysWarehouses = async (tgUserId: string) => {
  const { data: user, error: userErr } = await supabase
    .from("tg_users")
    .select("id, is_global_controller")
    .eq("id", tgUserId)
    .maybeSingle();
  if (userErr) throw userErr;
  if (!user?.id) return [];

  const { data: whRows, error: whErr } = await supabase
    .from("warehouses")
    .select("id, name, type, parent_id, is_active");
  if (whErr) throw whErr;
  const whList = (whRows || []).filter((w: any) => w.is_active !== false);
  if (user.is_global_controller) {
    return whList.filter((w: any) => w.type === "physical").map((w: any) => w.id);
  }

  const { data: bindings, error: bindErr } = await supabase
    .from("tg_user_warehouses")
    .select("warehouse_id, is_active")
    .eq("tg_user_id", tgUserId);
  if (bindErr) throw bindErr;
  const activeIds = (bindings || []).filter((b: any) => b.is_active !== false).map((b: any) => b.warehouse_id);
  const whMap = new Map(whList.map((w: any) => [w.id, w]));
  return Array.from(
    new Set(
      activeIds
        .map((id: string) => whMap.get(id))
        .filter(Boolean)
        .map((w: any) => (w.type === "virtual" ? w.parent_id : w.id))
        .filter(Boolean),
    ),
  );
};

const notifyControllers = async (physWarehouseId: string, text: string, buttons: TgReplyMarkup) => {
  const { data: userRows, error: userErr } = await supabase
    .from("tg_users")
    .select("id, tg_user_id, is_global_controller")
    .eq("role", "controller")
    .eq("status", "active");
  if (userErr) throw userErr;
  const controllers = (userRows || []).filter((u: any) => u.tg_user_id);
  if (!controllers.length) return;

  const { data: whRows, error: whErr } = await supabase
    .from("warehouses")
    .select("id, parent_id, type")
    .eq("parent_id", physWarehouseId);
  if (whErr) throw whErr;
  const zoneIds = new Set((whRows || []).map((w: any) => w.id));
  zoneIds.add(physWarehouseId);

  const { data: bindings, error: bindErr } = await supabase
    .from("tg_user_warehouses")
    .select("tg_user_id, warehouse_id, is_active")
    .in("warehouse_id", Array.from(zoneIds));
  if (bindErr) throw bindErr;
  const boundUserIds = new Set(
    (bindings || []).filter((b: any) => b.is_active !== false).map((b: any) => b.tg_user_id),
  );

  await Promise.all(
    controllers.map((u: any) => {
      if (!u.is_global_controller && !boundUserIds.has(u.id)) return Promise.resolve();
      return sendMessage(u.tg_user_id, text, buttons);
    }),
  );
};

const loadTaskLines = async (taskId: string) => {
  const { data: taskLines, error: taskErr } = await supabase
    .from("prod_task_lines")
    .select("plan_kind, plan_item_id, plan_qty")
    .eq("task_id", taskId);
  if (taskErr) throw taskErr;
  const itemIds = Array.from(new Set((taskLines ?? []).map((l: any) => l.plan_item_id).filter(Boolean)));
  const { data: items, error: itemsErr } = itemIds.length
    ? await supabase.from("items").select("id, code, name").in("id", itemIds)
    : { data: [], error: null };
  if (itemsErr) throw itemsErr;
  const itemMap = new Map<string, { code: string; name: string }>();
  (items ?? []).forEach((it: any) => itemMap.set(it.id, { code: it.code ?? "", name: it.name ?? "" }));

  return (taskLines ?? []).map((l: any) => ({
    plan_kind: l.plan_kind,
    plan_item_id: l.plan_item_id,
    plan_qty: Number(l.plan_qty) || 0,
    ...itemMap.get(l.plan_item_id),
  }));
};

const loadTaskHeader = async (taskId: string) => {
  const { data, error } = await supabase
    .from("prod_task_headers")
    .select("id, plan_date")
    .eq("id", taskId)
    .maybeSingle();
  if (error) throw error;
  return data;
};

const parseQty = (text: string) => {
  const normalized = text.trim().replace(",", ".");
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return value;
};

const formatReportLine = (item: { code?: string; name?: string }, qty: number, scrap: number) =>
  `${item.code || "—"} · ${item.name || ""} — факт ${qty}, брак ${scrap}`.trim();

const sendReportLinePicker = async (
  chatId: number | string,
  submissionId: string,
  taskId: string,
  tgUserId: string,
) => {
  const lines = await loadTaskLines(taskId);
  if (!lines.length) {
    await sendMessage(chatId, "Нет строк плана для отчёта.");
    return;
  }
  const lineMap = lines.map((l: any) => ({
    planKind: l.plan_kind,
    itemId: l.plan_item_id,
    label: `${l.code || "—"} · ${l.name}`.slice(0, 48),
  }));
  await setSession(tgUserId, "report_pick", { submissionId, taskId, lines: lineMap });
  const buttons = lineMap.map((l: any, idx: number) => ({
    text: l.label,
    data: `report:line:${idx}`,
  }));

  const perMessage = 16;
  for (let i = 0; i < buttons.length; i += perMessage) {
    const slice = buttons.slice(i, i + perMessage);
    const inline_keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let j = 0; j < slice.length; j += 2) {
      const row = slice.slice(j, j + 2).map((b) => ({ text: b.text, callback_data: b.data }));
      inline_keyboard.push(row);
    }
    await sendMessage(chatId, "Выберите позицию для отчёта:", { inline_keyboard });
  }
};

const startReportFlow = async (chatId: number | string, taskId: string, userRow: any) => {
  if (!userRow?.id) {
    await sendMessage(chatId, "Не удалось определить пользователя.");
    return false;
  }
  const { data: existing } = await supabase
    .from("prod_report_submissions")
    .select("id")
    .eq("task_id", taskId)
    .eq("tg_user_id", userRow.id)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .maybeSingle();
  const submissionId =
    existing?.id ??
    (
      await supabase
        .from("prod_report_submissions")
        .insert({ task_id: taskId, tg_user_id: userRow.id })
        .select("id")
        .maybeSingle()
    ).data?.id;
  if (!submissionId) {
    await sendMessage(chatId, "Не удалось создать отчёт.");
    return false;
  }
  await sendReportLinePicker(chatId, submissionId, taskId, userRow.id);
  return true;
};

const loadTasksForWarehouses = async (physWarehouseIds: string[], dateISO: string) => {
  const { data: whRows, error: whErr } = await supabase
    .from("warehouses")
    .select("id, name, tg_chat_id")
    .in("id", physWarehouseIds);
  if (whErr) throw whErr;
  const tasks: Array<{
    taskId: string | null;
    warehouseId: string;
    warehouseName: string;
    fgLines: any[];
    semiLines: any[];
  }> = [];

  for (const wh of whRows ?? []) {
    const { fgLines, semiLines } = await loadPlans(wh.id, dateISO);
    const taskId = await upsertTask(wh.id, dateISO, String(wh.tg_chat_id ?? ""), fgLines, semiLines);
    tasks.push({
      taskId,
      warehouseId: wh.id,
      warehouseName: wh.name,
      fgLines,
      semiLines,
    });
  }
  return tasks;
};

const sendPlanSummary = async (chatId: number | string, dateISO: string, tasks: any[]) => {
  for (const task of tasks) {
    const lines: string[] = [];
    lines.push(`План на ${dateISO} · ${task.warehouseName}`);
    if (task.semiLines.length) {
      lines.push("");
      lines.push("Полуфабрикаты:");
      task.semiLines.forEach((l: any) => lines.push(formatLine(l.code ?? "", l.name ?? "", l.plan, l.fact)));
    }
    if (task.fgLines.length) {
      lines.push("");
      lines.push("Готовая продукция:");
      task.fgLines.forEach((l: any) => lines.push(formatLine(l.code ?? "", l.name ?? "", l.plan, l.fact)));
    }
    if (!task.semiLines.length && !task.fgLines.length) {
      lines.push("");
      lines.push("Нет планов на сегодня.");
    }

    const chunks = chunkText(lines.join("\n"));
    const taskId = task.taskId;
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
      await sendMessage(chatId, chunks[i], replyMarkup);
    }
  }
};

const sendPlanPicker = async (chatId: number | string, tasks: any[], userRow: any) => {
  const validTasks = tasks.filter((t: any) => t.taskId);
  if (!validTasks.length) {
    await sendMessage(chatId, "Нет планов на сегодня.");
    return;
  }
  if (validTasks.length === 1) {
    const opened = await startReportFlow(chatId, validTasks[0].taskId, userRow);
    if (!opened) {
      await sendMessage(chatId, "Не удалось открыть отчёт. Попробуйте ещё раз.");
    }
    return;
  }
  const inline_keyboard = validTasks.map((t: any) => [
    { text: t.warehouseName, callback_data: `report:plan:${t.taskId}` },
  ]);
  await sendMessage(chatId, "Выберите план:", { inline_keyboard });
};

const notifyControllersForSubmission = async (submissionId: string) => {
  const { data: submission, error: subErr } = await supabase
    .from("prod_report_submissions")
    .select("id, task_id")
    .eq("id", submissionId)
    .maybeSingle();
  if (subErr || !submission?.task_id) return;

  const { data: task, error: taskErr } = await supabase
    .from("prod_task_headers")
    .select("phys_warehouse_id")
    .eq("id", submission.task_id)
    .maybeSingle();
  if (taskErr || !task?.phys_warehouse_id) return;

  const { data: lines, error: lineErr } = await supabase
    .from("prod_report_lines")
    .select("id, plan_kind, plan_item_id, qty, scrap_qty, comment, plan_date")
    .eq("submission_id", submissionId)
    .eq("status", "pending");
  if (lineErr || !lines?.length) return;

  const itemIds = Array.from(new Set(lines.map((l: any) => l.plan_item_id)));
  const { data: items } = await supabase
    .from("items")
    .select("id, code, name")
    .in("id", itemIds);
  const itemMap = new Map<string, { code: string; name: string }>();
  (items ?? []).forEach((it: any) => itemMap.set(it.id, { code: it.code ?? "", name: it.name ?? "" }));

  for (const line of lines) {
    const item = itemMap.get(line.plan_item_id) ?? { code: "—", name: "" };
    const text = [
      `Отчёт: ${item.code} · ${item.name}`.trim(),
      `Факт: ${line.qty}, Брак: ${line.scrap_qty}`,
      line.comment ? `Комментарий: ${line.comment}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    await notifyControllers(task.phys_warehouse_id, text, {
      inline_keyboard: [
        [
          { text: "Подтвердить", callback_data: `report:approve:${line.id}` },
          { text: "Отклонить", callback_data: `report:reject:${line.id}` },
        ],
      ],
    });
  }
};

const saveReportLine = async (
  submissionId: string,
  planKind: string,
  itemId: string,
  planDate: string,
  qty: number,
  scrap: number,
) => {
  const linePayload = {
    submission_id: submissionId,
    plan_kind: planKind,
    plan_item_id: itemId,
    plan_date: planDate,
    qty,
    scrap_qty: scrap,
    status: "pending",
  };
  const { data: line, error } = await supabase
    .from("prod_report_lines")
    .insert(linePayload)
    .select("id")
    .maybeSingle();
  if (error || !line?.id) return null;
  return line.id;
};

const incrementPlanScrap = async (
  planKind: string,
  itemId: string,
  planDate: string,
  physWarehouseId: string,
  scrapQty: number,
) => {
  if (!scrapQty) return;
  const table = planKind === "semi" ? "plans_semi" : "plans_fg";
  const idColumn = planKind === "semi" ? "semi_id" : "product_id";
  const { data: row, error } = await supabase
    .from(table)
    .select("scrap_qty")
    .eq(idColumn, itemId)
    .eq("phys_warehouse_id", physWarehouseId)
    .eq("date_iso", planDate)
    .maybeSingle();
  if (error) throw error;
  const nextScrap = Number(row?.scrap_qty || 0) + scrapQty;
  const payload: Record<string, any> = {
    [idColumn]: itemId,
    phys_warehouse_id: physWarehouseId,
    date_iso: planDate,
    scrap_qty: nextScrap,
  };
  await supabase.from(table).upsert(payload, { onConflict: `${idColumn},phys_warehouse_id,date_iso` });
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

  const update = await req.json().catch(() => ({}));
  const callback = update?.callback_query;
  if (callback?.data && callback?.message?.chat?.id) {
    const chatId = callback.message.chat.id;
    const userRow = await upsertTgUser(callback.from);
    const data = String(callback.data);
    const parts = data.split(":");
    await answerCallback(callback.id);

    if (parts[0] === "report" && parts[1] === "start" && parts[2]) {
      const taskId = parts[2];
      await startReportFlow(chatId, taskId, userRow);
      return new Response("ok", { headers: baseHeaders });
    }

    if (parts[0] === "report" && parts[1] === "plan" && parts[2]) {
      const taskId = parts[2];
      await startReportFlow(chatId, taskId, userRow);
      return new Response("ok", { headers: baseHeaders });
    }

    if (parts[0] === "report" && parts[1] === "line" && parts[2]) {
      if (!userRow?.id) return new Response("ok", { headers: baseHeaders });
      const index = Number(parts[2]);
      if (!Number.isFinite(index)) {
        await sendMessage(chatId, "Не удалось выбрать позицию.");
        return new Response("ok", { headers: baseHeaders });
      }
      const session = await getSession(userRow.id);
      const lines = (session?.payload as any)?.lines;
      const submissionId = (session?.payload as any)?.submissionId;
      const taskId = (session?.payload as any)?.taskId;
      if (session?.kind !== "report_pick" || !Array.isArray(lines) || !submissionId || !taskId) {
        await sendMessage(chatId, "Сессия выбора устарела. Нажмите «Сдать отчёт» снова.");
        return new Response("ok", { headers: baseHeaders });
      }
      const picked = lines[index];
      if (!picked?.planKind || !picked?.itemId) {
        await sendMessage(chatId, "Не удалось выбрать позицию.");
        return new Response("ok", { headers: baseHeaders });
      }
      const task = await loadTaskHeader(taskId);
      if (!task?.plan_date) {
        await sendMessage(chatId, "Не удалось получить дату плана.");
        return new Response("ok", { headers: baseHeaders });
      }
      await setSession(userRow.id, "report_qty", {
        submissionId,
        taskId,
        planKind: picked.planKind,
        itemId: picked.itemId,
        planDate: task.plan_date,
      });
      await sendMessage(chatId, "Введите факт (числом).", {
        inline_keyboard: [[{ text: "0", callback_data: "report:qty0" }]],
      });
      return new Response("ok", { headers: baseHeaders });
    }

    if (parts[0] === "report" && parts[1] === "more" && parts[2]) {
      const submissionId = parts[2];
      const { data: submission } = await supabase
        .from("prod_report_submissions")
        .select("task_id")
        .eq("id", submissionId)
        .maybeSingle();
      if (submission?.task_id) {
        if (userRow?.id) {
          await sendReportLinePicker(chatId, submissionId, submission.task_id, userRow.id);
        }
      }
      return new Response("ok", { headers: baseHeaders });
    }

    if (parts[0] === "report" && parts[1] === "qty0") {
      if (!userRow?.id) return new Response("ok", { headers: baseHeaders });
      const session = await getSession(userRow.id);
      if (session?.kind !== "report_qty") {
        await sendMessage(chatId, "Сессия ввода факта устарела.");
        return new Response("ok", { headers: baseHeaders });
      }
      const payload = session.payload as any;
      await setSession(userRow.id, "report_scrap", {
        submissionId: payload.submissionId,
        planKind: payload.planKind,
        itemId: payload.itemId,
        planDate: payload.planDate,
        qty: 0,
      });
      await sendMessage(chatId, "Введите брак (числом, можно 0).", {
        inline_keyboard: [[{ text: "0", callback_data: "report:scrap0" }]],
      });
      return new Response("ok", { headers: baseHeaders });
    }

    if (parts[0] === "report" && parts[1] === "scrap0") {
      if (!userRow?.id) return new Response("ok", { headers: baseHeaders });
      const session = await getSession(userRow.id);
      if (session?.kind !== "report_scrap") {
        await sendMessage(chatId, "Сессия ввода брака устарела.");
        return new Response("ok", { headers: baseHeaders });
      }
      const payload = session.payload as any;
      const lineId = await saveReportLine(
        payload.submissionId,
        payload.planKind,
        payload.itemId,
        payload.planDate,
        Number(payload.qty ?? 0),
        0,
      );
      if (!lineId) {
        await sendMessage(chatId, "Не удалось сохранить строку отчёта.");
      } else {
        await sendMessage(chatId, "Строка отчёта сохранена.", {
          inline_keyboard: [
            [
              { text: "Еще позиция", callback_data: `report:more:${payload.submissionId}` },
              { text: "Добавить комментарий", callback_data: `report:comment:${lineId}` },
            ],
            [{ text: "Завершить отчёт", callback_data: `report:finish:${payload.submissionId}` }],
          ],
        });
      }
      await clearSession(userRow.id);
      return new Response("ok", { headers: baseHeaders });
    }

    if (parts[0] === "report" && parts[1] === "comment" && parts[2]) {
      const lineId = parts[2];
      if (!userRow?.id) return new Response("ok", { headers: baseHeaders });
      const { data: line } = await supabase
        .from("prod_report_lines")
        .select("submission_id")
        .eq("id", lineId)
        .maybeSingle();
      await setSession(userRow.id, "report_comment", { lineId, submissionId: line?.submission_id ?? null });
      await sendMessage(chatId, "Введите комментарий.");
      return new Response("ok", { headers: baseHeaders });
    }

    if (parts[0] === "report" && parts[1] === "finish" && parts[2]) {
      const submissionId = parts[2];
      const { data: lines } = await supabase
        .from("prod_report_lines")
        .select("plan_item_id, qty, scrap_qty")
        .eq("submission_id", submissionId);
      if (lines?.length) {
        const itemIds = Array.from(new Set(lines.map((l: any) => l.plan_item_id)));
        const { data: items } = await supabase
          .from("items")
          .select("id, code, name")
          .in("id", itemIds);
        const itemMap = new Map<string, { code: string; name: string }>();
        (items ?? []).forEach((it: any) => itemMap.set(it.id, { code: it.code ?? "", name: it.name ?? "" }));
        const summary = lines
          .map((l: any) => formatReportLine(itemMap.get(l.plan_item_id) ?? {}, l.qty, l.scrap_qty))
          .join("\n");
        if (summary) {
          await sendMessage(chatId, `Итог:\n${summary}`);
        }
      }
      await notifyControllersForSubmission(submissionId);
      await sendMessage(chatId, "Отчёт отправлен на проверку.");
      return new Response("ok", { headers: baseHeaders });
    }

    if (parts[0] === "report" && parts[1] === "approve" && parts[2]) {
      const lineId = parts[2];
      const { data: line, error: lineErr } = await supabase
        .from("prod_report_lines")
        .select("id, qty, scrap_qty, plan_kind, plan_item_id, plan_date, submission_id")
        .eq("id", lineId)
        .maybeSingle();
      if (lineErr || !line) {
        await sendMessage(chatId, "Не найден отчёт.");
        return new Response("ok", { headers: baseHeaders });
      }
      const { data: submission } = await supabase
        .from("prod_report_submissions")
        .select("task_id")
        .eq("id", line.submission_id)
        .maybeSingle();
      const { data: task } = await supabase
        .from("prod_task_headers")
        .select("phys_warehouse_id")
        .eq("id", submission?.task_id)
        .maybeSingle();
      if (!task?.phys_warehouse_id) {
        await sendMessage(chatId, "Не удалось определить склад.");
        return new Response("ok", { headers: baseHeaders });
      }
      if (!userRow?.id) {
        await sendMessage(chatId, "Не удалось определить автора отчёта. Проверьте, что вы зарегистрированы в системе.");
        return new Response("ok", { headers: baseHeaders });
      }
      const zones = await getZonesForPhys(task.phys_warehouse_id);
      if (!zones.matZoneId || !zones.fgZoneId) {
        await sendMessage(chatId, "Не найдены зоны материалов/ГП.");
        return new Response("ok", { headers: baseHeaders });
      }
      if (line.qty > 0) {
        await supabase.rpc("post_production_report", {
          p_number: `PR-${line.id}`,
          p_date_iso: line.plan_date,
          p_product_id: line.plan_item_id,
          p_qty: line.qty,
          p_phys_warehouse_id: task.phys_warehouse_id,
          p_fg_zone_id: line.plan_kind === "semi" ? zones.semiZoneId ?? zones.fgZoneId : zones.fgZoneId,
          p_mat_zone_id: zones.matZoneId,
          p_plan_kind: line.plan_kind,
          p_plan_item_id: line.plan_item_id,
          p_plan_date: line.plan_date,
          p_actor_id: userRow?.id ?? null,
        });
      }
      if (line.scrap_qty > 0) {
        await supabase.rpc("post_production_scrap", {
          p_number: `SCR-${line.id}`,
          p_date_iso: line.plan_date,
          p_item_id: line.plan_item_id,
          p_qty: line.scrap_qty,
          p_phys_warehouse_id: task.phys_warehouse_id,
          p_mat_zone_id: zones.matZoneId,
          p_semi_zone_id: line.plan_kind === "semi" ? zones.semiZoneId ?? zones.matZoneId : null,
          p_plan_kind: line.plan_kind,
          p_plan_item_id: line.plan_item_id,
          p_plan_date: line.plan_date,
          p_actor_id: userRow?.id ?? null,
        });
        await incrementPlanScrap(line.plan_kind, line.plan_item_id, line.plan_date, task.phys_warehouse_id, line.scrap_qty);
      }
      await supabase
        .from("prod_report_lines")
        .update({ status: "approved", approved_at: new Date().toISOString(), approved_by: userRow?.id ?? null })
        .eq("id", lineId);
      await supabase.from("prod_report_actions").insert({
        report_line_id: lineId,
        actor_id: userRow?.id ?? null,
        action: "approved",
        payload: { qty: line.qty, scrap_qty: line.scrap_qty },
      });
      await sendMessage(chatId, "Отчёт подтверждён.");
      return new Response("ok", { headers: baseHeaders });
    }

    if (parts[0] === "report" && parts[1] === "reject" && parts[2]) {
      const lineId = parts[2];
      await supabase
        .from("prod_report_lines")
        .update({ status: "rejected", approved_at: new Date().toISOString(), approved_by: userRow?.id ?? null })
        .eq("id", lineId);
      await supabase.from("prod_report_actions").insert({
        report_line_id: lineId,
        actor_id: userRow?.id ?? null,
        action: "rejected",
        payload: {},
      });
      await sendMessage(chatId, "Отчёт отклонён.");
      return new Response("ok", { headers: baseHeaders });
    }

    return new Response("ok", { headers: baseHeaders });
  }

  const message = update?.message;
  if (!message?.text) return new Response("ok", { headers: baseHeaders });

  const chatId = message.chat?.id;
  console.log("[tg-bot] chat", {
    id: chatId,
    title: message.chat?.title,
    type: message.chat?.type,
  });
  const text = String(message.text ?? "");
  const textLower = text.trim().toLowerCase();
  const textNormalized = textLower.replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  const cmd = parseCommand(text);
  const chatType = message.chat?.type ?? null;

  const userRow = await upsertTgUser(message.from);
  const isReportCommand =
    chatType === "private" &&
    (textNormalized === "сдать отчет" || textNormalized === "сдать отчёт");
  const isPlansCommand = cmd === "tasks" || (chatType === "private" && textNormalized === "мои планы");

  if (userRow?.id && !cmd && !isReportCommand && !isPlansCommand) {
    const session = await getSession(userRow.id);
    if (session?.kind === "report_comment") {
      const payload = session.payload as any;
      const lineId = payload?.lineId;
      const submissionId = payload?.submissionId;
      if (!lineId) {
        await clearSession(userRow.id);
        await sendMessage(chatId, "Не удалось сохранить комментарий.");
        return new Response("ok", { headers: baseHeaders });
      }
      const comment = text.trim();
      const { error } = await supabase
        .from("prod_report_lines")
        .update({ comment })
        .eq("id", lineId);
      if (error) {
        await sendMessage(chatId, "Не удалось сохранить комментарий.");
      } else {
        await sendMessage(chatId, "Комментарий сохранён.", submissionId
          ? {
              inline_keyboard: [
                [{ text: "Еще позиция", callback_data: `report:more:${submissionId}` }],
                [{ text: "Завершить отчёт", callback_data: `report:finish:${submissionId}` }],
              ],
            }
          : undefined);
      }
      await clearSession(userRow.id);
      return new Response("ok", { headers: baseHeaders });
    }

    if (session?.kind && (session.kind === "report_qty" || session.kind === "report_scrap")) {
      const qty = parseQty(text);
      if (qty === null) {
        await sendMessage(chatId, "Введите число (например 10 или 10,5).");
        return new Response("ok", { headers: baseHeaders });
      }
      const payload = session.payload as any;
      const submissionId = payload?.submissionId;
      const planKind = payload?.planKind;
      const itemId = payload?.itemId;
      const planDate = payload?.planDate;
      if (!submissionId || !planKind || !itemId || !planDate) {
        await sendMessage(chatId, "Не удалось сохранить строку отчёта.");
        await clearSession(userRow.id);
        return new Response("ok", { headers: baseHeaders });
      }
      if (session.kind === "report_qty") {
        await setSession(userRow.id, "report_scrap", {
          submissionId,
          planKind,
          itemId,
          planDate,
          qty,
        });
        await sendMessage(chatId, "Введите брак (числом, можно 0).", {
          inline_keyboard: [[{ text: "0", callback_data: "report:scrap0" }]],
        });
        return new Response("ok", { headers: baseHeaders });
      }

      const lineId = await saveReportLine(
        submissionId,
        planKind,
        itemId,
        planDate,
        Number(payload?.qty ?? 0),
        qty,
      );
      if (!lineId) {
        await sendMessage(chatId, "Не удалось сохранить строку отчёта.");
      } else {
        await sendMessage(chatId, "Строка отчёта сохранена.", {
          inline_keyboard: [
            [
              { text: "Еще позиция", callback_data: `report:more:${submissionId}` },
              { text: "Добавить комментарий", callback_data: `report:comment:${lineId}` },
            ],
            [{ text: "Завершить отчёт", callback_data: `report:finish:${submissionId}` }],
          ],
        });
      }
      await clearSession(userRow.id);
      return new Response("ok", { headers: baseHeaders });
    }
  }

  if (cmd === "start") {
    const payload = parseStartPayload(text);
    if (payload?.startsWith("report_")) {
      const taskId = payload.slice("report_".length);
      if (chatType !== "private") {
        const link = TG_BOT_USERNAME ? `https://t.me/${TG_BOT_USERNAME}?start=report_${taskId}` : null;
        const replyMarkup = link ? { inline_keyboard: [[{ text: "Перейти в личку", url: link }]] } : undefined;
        await sendMessage(chatId, "Сдача отчёта доступна в личке с ботом.", replyMarkup);
        return new Response("ok", { headers: baseHeaders });
      }
      await startReportFlow(chatId, taskId, userRow);
      return new Response("ok", { headers: baseHeaders });
    }
    if (payload === "bind") {
      if (chatType !== "private") {
        const link = TG_BOT_USERNAME ? `https://t.me/${TG_BOT_USERNAME}?start=bind` : null;
        const replyMarkup = link ? { inline_keyboard: [[{ text: "Перейти в личку", url: link }]] } : undefined;
        await sendMessage(chatId, "Перейдите в личку для подтверждения назначения.", replyMarkup);
        return new Response("ok", { headers: baseHeaders });
      }
      await sendMessage(chatId, "Подтвердите назначение: напишите «Принято».");
      return new Response("ok", { headers: baseHeaders });
    }
    if (chatType === "private") {
      await sendMessage(chatId, "Выберите действие:", {
        keyboard: [
          [{ text: "Сдать отчёт" }],
          [{ text: "Мои планы" }],
        ],
        resize_keyboard: true,
        one_time_keyboard: false,
      });
      return new Response("ok", { headers: baseHeaders });
    }
    if (userRow?.status !== "pending") {
      await sendMessage(chatId, "Бот подключен. Команда: /tasks — список задач на сегодня.");
    }
    return new Response("ok", { headers: baseHeaders });
  }

  if (isReportCommand || isPlansCommand) {
    if (chatType !== "private") {
      const link = TG_BOT_USERNAME ? `https://t.me/${TG_BOT_USERNAME}` : null;
      const replyMarkup = link ? { inline_keyboard: [[{ text: "Перейти в личку", url: link }]] } : undefined;
      await sendMessage(chatId, "Список задач доступен в личке с ботом.", replyMarkup);
      return new Response("ok", { headers: baseHeaders });
    }

    try {
      if (isReportCommand) {
        await sendMessage(chatId, "Открываю отчёт…");
      }
      const physWarehouses = userRow?.id ? await getUserPhysWarehouses(userRow.id) : [];
      if (!physWarehouses.length) {
        await sendMessage(chatId, "Нет назначенных складов.");
        return new Response("ok", { headers: baseHeaders });
      }

      const dateISO = toEkatISO(new Date());
      const tasks = await loadTasksForWarehouses(physWarehouses, dateISO);
      if (isPlansCommand) {
        await sendPlanSummary(chatId, dateISO, tasks);
      } else {
        await sendPlanPicker(chatId, tasks, userRow);
      }
    } catch (error) {
      console.error("[tg-bot] report flow error", error);
      await sendMessage(chatId, "Ошибка открытия отчёта. Попробуйте ещё раз.");
    }
    await ensureCyrillicName(userRow, chatId, text, cmd, chatType);
    return new Response("ok", { headers: baseHeaders });
  }

  await ensureCyrillicName(userRow, chatId, text, cmd, chatType);

  if (!cmd) return new Response("ok", { headers: baseHeaders });

  return new Response("ok", { headers: baseHeaders });
});
