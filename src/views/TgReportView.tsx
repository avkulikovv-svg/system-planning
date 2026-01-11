import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../api/supabaseClient";

type TgUserRow = {
  id: string;
  tg_user_id: number | null;
  role: "executor" | "controller";
  status: "pending" | "active" | "disabled";
  is_global_controller?: boolean;
};

type WarehouseRow = {
  id: string;
  name: string;
  type: "physical" | "virtual";
  parent_id: string | null;
  is_active?: boolean;
};

type TaskHeader = {
  id: string;
  plan_date: string;
  phys_warehouse_id: string;
  status: string;
};

type TaskLine = {
  plan_kind: "fg" | "semi";
  plan_item_id: string;
  plan_qty: number;
  code: string;
  name: string;
};

const toLocalISO = (d: Date) => {
  const date = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return date.toISOString().slice(0, 10);
};

const parseQty = (value: string) => {
  const trimmed = value.trim().replace(",", ".");
  if (!trimmed) return null;
  const num = Number(trimmed);
  return Number.isFinite(num) ? num : null;
};

export default function TgReportView() {
  const tgUserId = useMemo(() => {
    const webApp = (window as any)?.Telegram?.WebApp;
    return webApp?.initDataUnsafe?.user?.id ?? null;
  }, []);

  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [tgUser, setTgUser] = useState<TgUserRow | null>(null);
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([]);
  const [tasks, setTasks] = useState<TaskHeader[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskLines, setTaskLines] = useState<TaskLine[]>([]);
  const [selectedLine, setSelectedLine] = useState<TaskLine | null>(null);
  const [factValue, setFactValue] = useState("");
  const [scrapValue, setScrapValue] = useState("");
  const [comment, setComment] = useState("");

  useEffect(() => {
    const webApp = (window as any)?.Telegram?.WebApp;
    if (webApp?.ready) webApp.ready();
    if (webApp?.expand) webApp.expand();
  }, []);

  useEffect(() => {
    const load = async () => {
      if (!tgUserId) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const { data: userRow, error: userErr } = await supabase
          .from("tg_users")
          .select("id, tg_user_id, role, status, is_global_controller")
          .eq("tg_user_id", tgUserId)
          .maybeSingle();
        if (userErr) throw userErr;
        if (!userRow) {
          setTgUser(null);
          setLoading(false);
          return;
        }
        setTgUser(userRow as TgUserRow);

        const { data: whRows, error: whErr } = await supabase
          .from("warehouses")
          .select("id, name, type, parent_id, is_active");
        if (whErr) throw whErr;
        const whList = (whRows || []).filter((w: any) => w.is_active !== false);
        setWarehouses(whList as WarehouseRow[]);

        let physWarehouseIds: string[] = [];
        if (userRow.is_global_controller) {
          physWarehouseIds = whList.filter((w: any) => w.type === "physical").map((w: any) => w.id);
        } else {
          const { data: bindings, error: bindErr } = await supabase
            .from("tg_user_warehouses")
            .select("warehouse_id, is_active")
            .eq("tg_user_id", userRow.id);
          if (bindErr) throw bindErr;
          const activeIds = (bindings || []).filter((b: any) => b.is_active !== false).map((b: any) => b.warehouse_id);
          const whMap = new Map(whList.map((w: any) => [w.id, w]));
          physWarehouseIds = Array.from(
            new Set(
              activeIds
                .map((id: string) => whMap.get(id))
                .filter(Boolean)
                .map((w: any) => (w.type === "virtual" ? w.parent_id : w.id))
                .filter(Boolean),
            ),
          );
        }

        if (!physWarehouseIds.length) {
          setTasks([]);
          setLoading(false);
          return;
        }

        const dateISO = toLocalISO(new Date());
        const { data: taskRows, error: taskErr } = await supabase
          .from("prod_task_headers")
          .select("id, plan_date, phys_warehouse_id, status")
          .eq("plan_date", dateISO)
          .in("phys_warehouse_id", physWarehouseIds)
          .order("plan_date", { ascending: false });
        if (taskErr) throw taskErr;
        setTasks((taskRows || []) as TaskHeader[]);
      } catch (error) {
        console.error("tg report load", error);
        setNotice("Не удалось загрузить задания.");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [tgUserId]);

  useEffect(() => {
    const loadLines = async () => {
      if (!selectedTaskId) {
        setTaskLines([]);
        return;
      }
      try {
        const { data: lines, error: lineErr } = await supabase
          .from("prod_task_lines")
          .select("plan_kind, plan_item_id, plan_qty")
          .eq("task_id", selectedTaskId);
        if (lineErr) throw lineErr;
        const itemIds = Array.from(new Set((lines || []).map((l: any) => l.plan_item_id).filter(Boolean)));
        const { data: items, error: itemsErr } = itemIds.length
          ? await supabase.from("items").select("id, code, name").in("id", itemIds)
          : { data: [], error: null };
        if (itemsErr) throw itemsErr;
        const itemMap = new Map<string, { code: string; name: string }>();
        (items || []).forEach((it: any) => itemMap.set(it.id, { code: it.code ?? "", name: it.name ?? "" }));
        const mapped = (lines || []).map((l: any) => ({
          plan_kind: l.plan_kind,
          plan_item_id: l.plan_item_id,
          plan_qty: Number(l.plan_qty) || 0,
          ...(itemMap.get(l.plan_item_id) || { code: "", name: "" }),
        }));
        setTaskLines(mapped as TaskLine[]);
      } catch (error) {
        console.error("tg report load lines", error);
      }
    };
    loadLines();
  }, [selectedTaskId]);

  const warehouseName = (id: string) => {
    const wh = warehouses.find((w) => w.id === id);
    if (!wh) return "";
    return wh.name;
  };

  const handleSubmit = async () => {
    if (!tgUser || !selectedTaskId || !selectedLine) {
      setNotice("Выберите задачу и позицию.");
      return;
    }
    const fact = parseQty(factValue);
    const scrap = parseQty(scrapValue) ?? 0;
    if (fact === null && scrap === 0) {
      setNotice("Введите факт или брак (числом).");
      return;
    }
    setNotice(null);
    try {
      const { data: submission } = await supabase
        .from("prod_report_submissions")
        .select("id")
        .eq("task_id", selectedTaskId)
        .eq("tg_user_id", tgUser.id)
        .eq("status", "pending")
        .maybeSingle();
      const submissionId =
        submission?.id ??
        (
          await supabase
            .from("prod_report_submissions")
            .insert({ task_id: selectedTaskId, tg_user_id: tgUser.id })
            .select("id")
            .maybeSingle()
        ).data?.id;
      if (!submissionId) throw new Error("no submission");

      const task = tasks.find((t) => t.id === selectedTaskId);
      const { error } = await supabase.from("prod_report_lines").insert({
        submission_id: submissionId,
        plan_kind: selectedLine.plan_kind,
        plan_item_id: selectedLine.plan_item_id,
        plan_date: task?.plan_date,
        qty: fact ?? 0,
        scrap_qty: scrap,
        comment: comment || null,
        status: "pending",
      });
      if (error) throw error;
      setNotice("Отчёт отправлен контролёру.");
      setSelectedLine(null);
      setFactValue("");
      setScrapValue("");
      setComment("");
    } catch (error) {
      console.error("tg report submit", error);
      setNotice("Не удалось отправить отчёт.");
    }
  };

  if (!tgUserId) {
    return (
      <div className="tg-app">
        <div className="tg-card">
          <h1>Отчёты по производству</h1>
          <p>Откройте страницу через кнопку в Telegram.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tg-app">
      <div className="tg-card tg-card--header">
        <div>
          <div className="tg-kicker">Производство</div>
          <h1>Сдача отчёта</h1>
          <div className="tg-sub">Сегодня · {toLocalISO(new Date())}</div>
        </div>
        {tgUser?.role === "controller" && <span className="tg-chip">Контролёр</span>}
      </div>

      {loading && <div className="tg-card">Загрузка…</div>}

      {!loading && !tgUser && <div className="tg-card">Пользователь не найден. Напишите боту /start.</div>}

      {!loading && tgUser && (
        <div className="tg-grid">
          <div className="tg-card">
            <div className="tg-title">Задания на сегодня</div>
            {tasks.length === 0 && <div className="tg-muted">Нет задач по вашим складам.</div>}
            {tasks.map((task) => (
              <button
                key={task.id}
                className={`tg-task ${selectedTaskId === task.id ? "is-active" : ""}`}
                onClick={() => {
                  setSelectedTaskId(task.id);
                  setSelectedLine(null);
                }}
              >
                <div>
                  <div className="tg-task__title">{warehouseName(task.phys_warehouse_id)}</div>
                  <div className="tg-muted">{task.plan_date}</div>
                </div>
                <span className="tg-badge">{task.status === "closed" ? "закрыт" : "открыт"}</span>
              </button>
            ))}
          </div>

          <div className="tg-card">
            <div className="tg-title">Позиции</div>
            {selectedTaskId && taskLines.length === 0 && <div className="tg-muted">Нет строк плана.</div>}
            {!selectedTaskId && <div className="tg-muted">Выберите задание слева.</div>}
            {taskLines.map((line) => (
              <button
                key={`${line.plan_kind}-${line.plan_item_id}`}
                className={`tg-line ${selectedLine?.plan_item_id === line.plan_item_id ? "is-active" : ""}`}
                onClick={() => setSelectedLine(line)}
              >
                <div className="tg-line__main">
                  <span className="tg-line__code">{line.code || "—"}</span>
                  <span className="tg-line__name">{line.name}</span>
                </div>
                <span className="tg-line__qty">План: {line.plan_qty}</span>
              </button>
            ))}
          </div>

          <div className="tg-card">
            <div className="tg-title">Ввод факта</div>
            {!selectedLine && <div className="tg-muted">Выберите позицию.</div>}
            {selectedLine && (
              <>
                <div className="tg-field">
                  <label>Факт</label>
                  <input
                    className="tg-input"
                    inputMode="decimal"
                    value={factValue}
                    onChange={(e) => setFactValue(e.target.value)}
                    placeholder="0"
                  />
                </div>
                <div className="tg-field">
                  <label>Брак</label>
                  <input
                    className="tg-input"
                    inputMode="decimal"
                    value={scrapValue}
                    onChange={(e) => setScrapValue(e.target.value)}
                    placeholder="0"
                  />
                </div>
                <div className="tg-field">
                  <label>Комментарий</label>
                  <textarea
                    className="tg-input tg-input--area"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder="При необходимости"
                  />
                </div>
                <button className="tg-primary" onClick={handleSubmit}>
                  Отправить отчёт
                </button>
              </>
            )}
            {notice && <div className="tg-notice">{notice}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
