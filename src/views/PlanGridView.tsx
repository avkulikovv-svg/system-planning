// file: src/views/PlanGridView.tsx
import React from "react";
import { supabase } from "../api/supabaseClient";
import { useSupabaseWarehouses } from "../hooks/useSupabaseDicts";

/* ========= Типы ========= */
type Product = {
  id: string;
  status: string;
  code: string;
  name: string;
  category?: string;
  uom?: string;
  price?: number;
};

type Semi = {
  id: string;
  status: string;
  code: string;
  name: string;
  category?: string;
  uom?: string;
  price?: number;
};

// Унифицированная строка спецификации + поддержка старого поля materialId
type SpecLine = {
  id: string;
  kind?: "mat" | "semi";      // если отсутствует — считаем 'mat'
  refId?: string;             // если отсутствует — используем materialId
  materialId?: string;        // legacy
  qty: number;
  uom: string;
};

type Spec = {
  id: string;
  productId?: string | null;
  productCode: string;
  productName: string;
  lines: SpecLine[];
  updatedAt: string;
};

type StockBalance = {
  id: string;
  itemId: string;
  warehouseId: string; // id виртуальной зоны
  qty: number;
  updatedAt: string; // ISO
};

/* ========= Утилиты/хуки ========= */
const uid = () => Math.random().toString(36).slice(2, 9);

function useLocalState<T>(key: string, initial: T) {
  const [state, setState] = React.useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  React.useEffect(() => {
    localStorage.setItem(key, JSON.stringify(state));
  }, [key, state]);
  return [state, setState] as const;
}

// --- рабочие дни / просрочка ---
const addWorkingDays = (iso: string, k: number) => {
  let d = new Date(iso + "T00:00:00");
  let left = Math.abs(k);
  const dir = k >= 0 ? 1 : -1;
  while (left > 0) {
    d.setDate(d.getDate() + dir);
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d.toISOString().slice(0, 10);
};
const isOverduePlan = (planISO: string, todayISO: string) => {
  const graceEnd = addWorkingDays(planISO, 1);
  return todayISO > graceEnd;
};

/* ========= Стабильная числовая ячейка ========= */
type EditStore = { activeId: string | null; values: Record<string, string>; suppressBlurOnce?: boolean };

export const PlanNumberCell = React.memo(function PlanNumberCell({
  id,
  value,
  onChange,
  storeRef,
  onNav,
  commitOnly,
}: {
  id: string;
  value: number;
  onChange: (n: number) => void;
  storeRef: React.MutableRefObject<EditStore>;
  onNav?: (fromId: string, dir: "left" | "right" | "up" | "down") => void;
  commitOnly?: boolean; // для Факта: проверка/проведение только на коммите
}) {
  const store = storeRef.current;
  const isActive = store.activeId === id;

  const display = isActive ? store.values[id] ?? "" : value === 0 || !Number.isFinite(value) ? "" : String(value);

  const commit = (raw: string) => {
    const s = (raw ?? "").replace(",", ".").trim();
    if (s === "") { onChange(0); return; }
    const n = Number(s);
    if (Number.isFinite(n) && n >= 0) onChange(n);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      className="input-compact"
      data-cell-id={id}
      value={display}
      placeholder="0"
      onFocus={(e) => {
        store.activeId = id;
        store.values[id] = display;
        e.currentTarget.select();
      }}
     onChange={(e) => {
  const next = e.target.value;
  store.values[id] = next;

  // нормализуем
  const s = next.replace(",", ".").trim();

  // ⚡️ если пользователь очистил поле — сразу обнуляем значение в состоянии
  if (s === "") {
    onChange(0);
    return;
  }

  // для "факта" не проводим во время набора
  if (commitOnly) return;

  // живое обновление при валидном числе
  if (!isNaN(Number(s))) onChange(Number(s));
}}

      onBlur={(e) => {
        if (store.suppressBlurOnce) {    // уже коммитили по Enter/Tab — пропускаем второй коммит
          store.suppressBlurOnce = false;
          delete store.values[id];
          if (store.activeId === id) store.activeId = null;
          return;
        }
        commit(store.values[id] ?? display);
        delete store.values[id];
        if (store.activeId === id) store.activeId = null;
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Tab") {
          store.suppressBlurOnce = true; // скажем onBlur не коммитить повторно
          commit(store.values[id] ?? display);
          delete store.values[id];
          if (store.activeId === id) store.activeId = null;
          (e.currentTarget as HTMLInputElement).blur();
          if (e.key === "Enter") e.preventDefault();
          return;
        }
        if (e.key === "Escape") {
          delete store.values[id];
          if (store.activeId === id) store.activeId = null;
          (e.currentTarget as HTMLInputElement).blur();
          return;
        }
        if (onNav && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")) {
          const dir = e.key === "ArrowLeft" ? "left" : e.key === "ArrowRight" ? "right" : e.key === "ArrowUp" ? "up" : "down";
          onNav(id, dir);
          e.preventDefault();
        }
      }}
    />
  );
});



/* ========= Экран: План партии ========= */
function PlanGridView() {
  const [products, setProducts] = React.useState<Product[]>([]);
  const [semis, setSemis] = React.useState<Semi[]>([]);
  const [specs, setSpecs] = React.useState<Spec[]>([]);
  const [materialsDict, setMaterialsDict] = React.useState<{ id: string; code: string; name: string; uom?: string }[]>([]);
  const [semisDict, setSemisDict] = React.useState<{ id: string; code: string; name: string; uom?: string }[]>([]);
  const [stockBalances, setStockBalances] = React.useState<StockBalance[]>([]);
  const { warehouses, physical, zonesByPhys, findZoneByName } = useSupabaseWarehouses();

  React.useEffect(() => {
    const loadProducts = async () => {
      const { data, error } = await supabase
        .from("items")
        .select("id, code, name, category, uom, status")
        .eq("kind", "product")
        .order("name", { ascending: true });
      if (error) {
        console.error("load products", error);
        return;
      }
      setProducts(
        (data || []).map((row: any) => ({
          id: row.id,
          status: row.status ?? "active",
          code: row.code,
          name: row.name,
          category: row.category ?? "",
          uom: row.uom ?? "шт",
        }))
      );
    };
    loadProducts();
  }, []);

  React.useEffect(() => {
    const loadSemis = async () => {
      const { data, error } = await supabase
        .from("items")
        .select("id, code, name, category, uom, status")
        .eq("kind", "semi")
        .order("name", { ascending: true });
      if (error) {
        console.error("load semis", error);
        return;
      }
      const mapped =
        (data || []).map((row: any) => ({
          id: row.id,
          status: row.status ?? "active",
          code: row.code,
          name: row.name,
          category: row.category ?? "",
          uom: row.uom ?? "шт",
        }));
      setSemis(mapped);
      setSemisDict(mapped.map((s) => ({ id: s.id, code: s.code, name: s.name, uom: s.uom })));
    };
    loadSemis();
  }, []);

  React.useEffect(() => {
    const loadMaterials = async () => {
      const { data, error } = await supabase
        .from("items")
        .select("id, code, name, uom")
        .eq("kind", "material")
        .order("name", { ascending: true });
      if (error) {
        console.error("load materials", error);
        return;
      }
      setMaterialsDict(
        (data || []).map((row: any) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          uom: row.uom ?? "шт",
        }))
      );
    };
    loadMaterials();
  }, []);

  React.useEffect(() => {
    const loadSpecs = async () => {
      const { data: specsData, error: specsErr } = await supabase
        .from("specs")
        .select("id, spec_code, spec_name, linked_product_id, updated_at");
      if (specsErr) {
        console.error("load specs", specsErr);
        return;
      }
      const { data: linesData, error: linesErr } = await supabase
        .from("spec_lines")
        .select("id, spec_id, kind, ref_item_id, qty");
      if (linesErr) {
        console.error("load spec lines", linesErr);
        return;
      }
      const linesBySpec = new Map<string, SpecLine[]>();
      (linesData || []).forEach((ln: any) => {
        const entry: SpecLine = {
          id: ln.id,
          kind: (ln.kind as "mat" | "semi") ?? "mat",
          refId: ln.ref_item_id,
          qty: Number(ln.qty) || 0,
          uom: "",
        };
        if (!linesBySpec.has(ln.spec_id)) linesBySpec.set(ln.spec_id, []);
        linesBySpec.get(ln.spec_id)!.push(entry);
      });
      setSpecs(
        (specsData || []).map((sp: any) => ({
          id: sp.id,
          productId: sp.linked_product_id,
          productCode: sp.spec_code,
          productName: sp.spec_name,
          lines: linesBySpec.get(sp.id) ?? [],
          updatedAt: sp.updated_at ?? new Date().toISOString(),
        }))
      );
    };
    loadSpecs();
  }, []);

  const refreshStockBalances = React.useCallback(async () => {
    const { data, error } = await supabase.from("stock_balances").select("warehouse_id, item_id, qty, updated_at");
    if (error) {
      console.error("load stock_balances", error);
      return;
    }
    setStockBalances(
      (data || []).map((row: any) => ({
        id: `${row.warehouse_id}:${row.item_id}`,
        warehouseId: row.warehouse_id,
        itemId: row.item_id,
        qty: Number(row.qty) || 0,
        updatedAt: row.updated_at,
      }))
    );
  }, []);

  React.useEffect(() => {
    refreshStockBalances();
  }, [refreshStockBalances]);

  const getQty = React.useCallback(
    (_itemType: "material" | "semi" | "product", itemId: string, warehouseId: string) =>
      stockBalances.find((b) => b.itemId === itemId && b.warehouseId === warehouseId)?.qty ?? 0,
    [stockBalances]
  );

  const matMap  = React.useMemo(() => Object.fromEntries(materialsDict.map(m => [m.id, m])), [materialsDict]);
  const semiMap = React.useMemo(() => Object.fromEntries(semisDict.map(s => [s.id, s])), [semisDict]);
  const nameOf = (kind: "mat" | "semi", id: string) => (kind === "mat" ? matMap[id]?.name : semiMap[id]?.name) || id;

  // парс/сбор id ячеек
  const parseCellId = (cid: string) => {
    const [pid, dateISO, kind] = cid.split(":");
    return { pid, dateISO, kind: kind as "plan" | "fact" };
  };
  const buildCellId = (pid: string, dateISO: string, kind: "plan" | "fact") => `${pid}:${dateISO}:${kind}`;

  // фокус по id
  const focusCell = (cid: string) => {
    const el = document.querySelector<HTMLInputElement>(`input[data-cell-id="${cid}"]`);
    el?.focus();
    el?.select();
  };

  // next id по направлению
  const [startISO, setStartISO] = useLocalState<string>("mrp.plan.startISO", new Date().toISOString().slice(0, 10));
  const [days, setDays]         = useLocalState<number>("mrp.plan.days", 14);
  const [rtl, setRtl]           = useLocalState<boolean>("mrp.plan.rtl", true);

  const range = React.useMemo(() => {
    const base = new Date(startISO + "T00:00:00");
    const list: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      list.push(d.toISOString().slice(0, 10));
    }
    return rtl ? list.reverse() : list;
  }, [startISO, days, rtl]);

  const nextCellFrom = (fromId: string, dir: "left" | "right" | "up" | "down") => {
    const { pid, dateISO, kind } = parseCellId(fromId);
    const idx = range.indexOf(dateISO);
    if (idx < 0) return;
    if (dir === "left" && idx > 0)             return buildCellId(pid, range[idx - 1], kind);
    if (dir === "right" && idx < range.length - 1) return buildCellId(pid, range[idx + 1], kind);
    if (dir === "up")                          return buildCellId(pid, dateISO, kind === "plan" ? "fact" : "plan");
    if (dir === "down")                        return buildCellId(pid, dateISO, kind === "plan" ? "fact" : "plan");
    return;
  };
  const handleNav = (fromId: string, dir: "left" | "right" | "up" | "down") => {
    const to = nextCellFrom(fromId, dir);
    if (to) focusCell(to);
  };

  const todayISO = new Date().toISOString().slice(0, 10);
  const editStoreRef = React.useRef<EditStore>({ activeId: null, values: {} });

  // режим: ГП или ПФ
  const [scope, setScope] = useLocalState<"fg" | "semi">("mrp.plan.scope", "fg");

  // склад
  const physDefault = React.useMemo(() => physical[0]?.id ?? "", [physical]);
  const [physId, setPhysId] = useLocalState<string>("mrp.plan.phys", physDefault);

  // --- ЗОНЫ (без UI): определяются автоматически по выбранному складу ---
  const fgZoneIdForPhys = React.useMemo(() => {
    const pid = physId || physDefault;
    const zones = zonesByPhys(pid);
    return (
      findZoneByName(pid, "Готовая продукция")?.id ||
      zones.find((z) => /готов/i.test(z.name))?.id ||
      zones[0]?.id || ""
    );
  }, [physId, physDefault, zonesByPhys, findZoneByName]);

  const matZoneIdForPhys = React.useMemo(() => {
    const pid = physId || physDefault;
    const zones = zonesByPhys(pid);
    return (
      findZoneByName(pid, "Материалы")?.id ||
      zones.find((z) => /материал/i.test(z.name))?.id ||
      zones[0]?.id || ""
    );
  }, [physId, physDefault, zonesByPhys, findZoneByName]);

  const semiZoneIdForPhys = React.useMemo(() => {
    const pid = physId || physDefault;
    return (
      findZoneByName(pid, "Полуфабрикаты")?.id ||
      findZoneByName(pid, "Материалы")?.id ||
      zonesByPhys(pid)[0]?.id || ""
    );
  }, [physId, physDefault, zonesByPhys, findZoneByName]);

  // планы/факты
  type PlanMap = Record<string, Record<string, number>>;
  const [planMapFG, setPlanMapFG] = React.useState<PlanMap>({});
  const [factMapFG, setFactMapFG] = React.useState<PlanMap>({});
  const [planMapSEMI, setPlanMapSEMI] = React.useState<PlanMap>({});
  const [factMapSEMI, setFactMapSEMI] = React.useState<PlanMap>({});

  const updatePlanLocal = React.useCallback((kind: "fg" | "semi", id: string, dateISO: string, val: number) => {
    if (kind === "fg") {
      setPlanMapFG((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), [dateISO]: val } }));
    } else {
      setPlanMapSEMI((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), [dateISO]: val } }));
    }
  }, []);

  const updateFactLocal = React.useCallback((kind: "fg" | "semi", id: string, dateISO: string, val: number) => {
    if (kind === "fg") {
      setFactMapFG((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), [dateISO]: val } }));
    } else {
      setFactMapSEMI((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), [dateISO]: val } }));
    }
  }, []);

  const fetchPlans = React.useCallback(
    async (targetScope: "fg" | "semi") => {
      if (!range.length) return;
      const ordered = [...range].sort();
      const startDate = ordered[0];
      const endDate = ordered[ordered.length - 1];
      const table = targetScope === "fg" ? "plans_fg" : "plans_semi";
      const idColumn = targetScope === "fg" ? "product_id" : "semi_id";
      const { data, error } = await supabase
        .from(table)
        .select(`${idColumn}, date_iso, qty, fact_qty`)
        .gte("date_iso", startDate)
        .lte("date_iso", endDate);
      if (error) {
        console.error("load plans", error);
        return;
      }
      const nextPlan: PlanMap = {};
      const nextFact: PlanMap = {};
      (data || []).forEach((row: any) => {
        const itemId = row[idColumn];
        const dateISO = row.date_iso;
        if (!itemId || !dateISO) return;
        if (!nextPlan[itemId]) nextPlan[itemId] = {};
        if (!nextFact[itemId]) nextFact[itemId] = {};
        nextPlan[itemId][dateISO] = Number(row.qty) || 0;
        nextFact[itemId][dateISO] = Number(row.fact_qty) || 0;
      });
      if (targetScope === "fg") {
        setPlanMapFG(nextPlan);
        setFactMapFG(nextFact);
      } else {
        setPlanMapSEMI(nextPlan);
        setFactMapSEMI(nextFact);
      }
    },
    [range]
  );

  React.useEffect(() => {
    fetchPlans(scope);
  }, [fetchPlans, scope]);

  const upsertPlanValue = React.useCallback(
    async (kind: "fg" | "semi", itemId: string, dateISO: string, qty: number) => {
      const table = kind === "fg" ? "plans_fg" : "plans_semi";
      const idColumn = kind === "fg" ? "product_id" : "semi_id";
      const payload: Record<string, any> = { [idColumn]: itemId, date_iso: dateISO, qty };
      const { error } = await supabase.from(table).upsert(payload);
      if (error) {
        console.error("plan upsert", error);
        alert("Не удалось сохранить план. См. консоль.");
        fetchPlans(kind);
      }
    },
    [fetchPlans]
  );

  const planMap = scope === "fg" ? planMapFG : planMapSEMI;
  const factMap = scope === "fg" ? factMapFG : factMapSEMI;

  const handlePlanChange = (id: string, dateISO: string, val: number) => {
    updatePlanLocal(scope, id, dateISO, val);
    upsertPlanValue(scope, id, dateISO, val);
  };

  // список категорий
  const availableCats = React.useMemo(() => {
    const pool = scope === "fg" ? products : semis;
    const set = new Set<string>();
    for (const it of pool) if (it.status !== "archived" && it.category) set.add(it.category);
    return Array.from(set).sort();
  }, [scope, products, semis]);
  const [catFilter, setCatFilter] = useLocalState<string>("mrp.plan.cat", "");
  React.useEffect(() => {
    if (catFilter && !availableCats.includes(catFilter)) setCatFilter("");
  }, [availableCats, catFilter, setCatFilter]);

  // строки
  const rows = React.useMemo(() => {
    if (scope === "fg") {
      let base = products.filter((p) => p.status !== "archived");
      if (catFilter) base = base.filter((p) => (p.category || "") === catFilter);
      return base;
    } else {
      let base = semis.filter((s) => s.status !== "archived");
      if (catFilter) base = base.filter((s) => (s.category || "") === catFilter);
      return base;
    }
  }, [scope, products, semis, catFilter]);

  // итоги
  const totals = React.useMemo(() => {
    const res: Record<string, { plan: number; fact: number }> = {};
    for (const d of range) res[d] = { plan: 0, fact: 0 };
    for (const r of rows) {
      const id = r.id!;
      for (const d of range) {
        res[d].plan += Number(planMap[id]?.[d] || 0);
        res[d].fact += Number(factMap[id]?.[d] || 0);
      }
    }
    return res;
  }, [rows, range, planMap, factMap]);

  // спецификация по item
  const specFor = (id: string | undefined, code: string | undefined) => {
    if (!id && !code) return undefined;
    return specs.find((s) => (id && s.productId === id) || (code && s.productCode === code));
  };

  // остаток строки — по текущему режиму и авто-зоне
  const stockOfRow = (id: string) => {
    if (scope === "fg") return fgZoneIdForPhys ? getQty("product", id, fgZoneIdForPhys) : 0;
    return semiZoneIdForPhys ? getQty("semi", id, semiZoneIdForPhys) : 0;
  };

  // ======= обеспеченность (материалы + ПФ) =======
  const specExistsById = React.useMemo(() => {
    const map: Record<string, boolean> = {};
    const pool = scope === "fg" ? products : semis;
    for (const it of pool) {
      const sp = specFor(it.id, it.code);
      map[it.id] = !!sp && Array.isArray(sp.lines) && sp.lines.length > 0;
    }
    return map;
  }, [scope, products, semis, specs]);

  type PerUnit = { mat: Record<string, number>; semi: Record<string, number> };
  const perUnitById: Record<string, PerUnit> = React.useMemo(() => {
    const map: Record<string, PerUnit> = {};
    const pool = scope === "fg" ? products : semis;

    for (const it of pool) {
      const sp = specFor(it.id, it.code);
      const per: PerUnit = { mat: {}, semi: {} };
      if (sp) {
        for (const ln of sp.lines || []) {
          const kind: "mat" | "semi" = ln.kind ?? "mat";
          const ref = (ln.refId ?? ln.materialId) ?? "";
          const one = ln.qty || 0;
          if (!ref || one <= 0) continue;
          if (kind === "mat") per.mat[ref] = (per.mat[ref] || 0) + one;
          else               per.semi[ref] = (per.semi[ref] || 0) + one;
        }
      }
      map[it.id] = per;
    }
    return map;
  }, [scope, products, semis, specs]);

  type CovCell = { ok: boolean; canMake: number; title: string };
  const coverage: Record<string, Record<string, CovCell>> = React.useMemo(() => {
    const res: Record<string, Record<string, CovCell>> = {};
    if (!matZoneIdForPhys || !fgZoneIdForPhys || !semiZoneIdForPhys) return res;

    const futureDays = range
      .filter((d) => d >= todayISO)
      .slice()
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const matBuf  = new Map<string, number>();
    const semiBuf = new Map<string, number>();
    const qtyMat  = (mid: string) => {
      if (!matBuf.has(mid)) matBuf.set(mid, getQty("material", mid, matZoneIdForPhys));
      return matBuf.get(mid)!;
    };
    const setMat  = (mid: string, q: number) => matBuf.set(mid, q < 0 ? 0 : q);

    const qtySemi = (sid: string) => {
      if (!semiBuf.has(sid)) semiBuf.set(sid, getQty("semi", sid, semiZoneIdForPhys));
      return semiBuf.get(sid)!;
    };
    const setSemi = (sid: string, q: number) => semiBuf.set(sid, q < 0 ? 0 : q);

    const pool = rows;

    for (const r of pool) {
      const id = r.id!;
      res[id] = {};

      const per = perUnitById[id] || { mat: {}, semi: {} };
      const hasSpec = !!specExistsById[id] && (Object.keys(per.mat).length > 0 || Object.keys(per.semi).length > 0);

      for (const d of futureDays) {
        const plan = Number(planMap[id]?.[d] || 0);
        if (plan <= 0) continue;

        const fact = Number(factMap[id]?.[d] || 0);
        const overdue = isOverduePlan(d, todayISO) && fact <= 0;
        if (overdue) {
          res[id][d] = { ok: false, canMake: 0, title: "Просрочено: резерв снят (нет произведённого)" };
          continue;
        }

        if (!hasSpec) {
          res[id][d] = { ok: false, canMake: 0, title: "Нет корректной спецификации" };
          continue;
        }

        let maxMake = Infinity;

        for (const [mid, one] of Object.entries(per.mat)) {
          const have = qtyMat(mid);
          const can  = one > 0 ? Math.floor(have / one + 1e-9) : Infinity;
          if (can < maxMake) maxMake = can;
        }
        for (const [sid, one] of Object.entries(per.semi)) {
          const have = qtySemi(sid);
          const can  = one > 0 ? Math.floor(have / one + 1e-9) : Infinity;
          if (can < maxMake) maxMake = can;
        }
        if (!Number.isFinite(maxMake)) maxMake = 0;

        const lines: string[] = [];
        lines.push(`Можно произвести: ${Math.max(0, Math.floor(maxMake))}`);
        for (const [mid, one] of Object.entries(per.mat)) {
          const need = one * plan, have = qtyMat(mid);
          if (have + 1e-8 < need) lines.push(`• ${nameOf("mat", mid)}: −${Math.round((need - have + 1e-9) * 1000) / 1000}`);
        }
        for (const [sid, one] of Object.entries(per.semi)) {
          const need = one * plan, have = qtySemi(sid);
          if (have + 1e-8 < need) lines.push(`• ${nameOf("semi", sid)}: −${Math.round((need - have + 1e-9) * 1000) / 1000}`);
        }

        const ok = plan <= maxMake;
        const canMake = Math.max(0, Math.floor(maxMake));
        res[id][d] = { ok, canMake, title: lines.join("\n") };

        const produce = Math.min(plan, canMake);
        for (const [mid, one] of Object.entries(per.mat))  setMat(mid,  qtyMat(mid)  - one * produce);
        for (const [sid, one] of Object.entries(per.semi)) setSemi(sid, qtySemi(sid) - one * produce);
      }
    }

    return res;
  }, [
    rows, range, todayISO, planMap, factMap,
    perUnitById, specExistsById,
    matZoneIdForPhys, fgZoneIdForPhys, semiZoneIdForPhys,
    getQty,
  ]);

  const checkProductionDelta = React.useCallback(
    (id: string, diff: number): { ok: boolean; msg?: string } => {
      if (diff <= 0) return { ok: true };
      const per = perUnitById[id];
      if (!per || (Object.keys(per.mat).length === 0 && Object.keys(per.semi).length === 0)) {
        return { ok: false, msg: "Нельзя провести факт: для позиции нет корректной спецификации." };
      }
      if (!matZoneIdForPhys) return { ok: false, msg: "Не выбрана зона материалов." };

      const lacks: string[] = [];
      for (const [mid, one] of Object.entries(per.mat)) {
        const need = (Number(one) || 0) * diff;
        if (need <= 0) continue;
        const have = getQty("material", mid, matZoneIdForPhys);
        if (have + 1e-9 < need) lacks.push(`• ${nameOf("mat", mid)}: нужно ${need}, есть ${have}`);
      }
      if (Object.keys(per.semi).length > 0 && !semiZoneIdForPhys) {
        lacks.push("• Не выбрана зона полуфабрикатов.");
      } else {
        for (const [sid, one] of Object.entries(per.semi)) {
          const need = (Number(one) || 0) * diff;
          if (need <= 0) continue;
          const have = getQty("semi", sid, semiZoneIdForPhys!);
          if (have + 1e-9 < need) lacks.push(`• ${nameOf("semi", sid)}: нужно ${need}, есть ${have}`);
        }
      }
      if (lacks.length) return { ok: false, msg: `Недостаточно сырья:\n${lacks.join("\n")}` };
      return { ok: true };
    },
    [getQty, matZoneIdForPhys, semiZoneIdForPhys, perUnitById, nameOf]
  );

  const handleFactChange = async (id: string, dateISO: string, nextVal: number, code: string) => {
    const prev = Number(factMap[id]?.[dateISO] || 0);
    const diff = nextVal - prev;
    const per = perUnitById[id];
    const hasSpec = !!specExistsById[id] && per && (Object.keys(per.mat).length > 0 || Object.keys(per.semi).length > 0);
    if (!hasSpec) {
      alert("Нельзя провести факт: для позиции нет корректной спецификации.");
      return;
    }
    if (diff < 0) {
      alert("Чтобы уменьшить факт, отмените соответствующий отчёт о производстве.");
      return;
    }
    if (diff === 0) return;

    const { ok, msg } = checkProductionDelta(id, diff);
    if (!ok) {
      if (msg) alert(msg);
      return;
    }

    const fgZone = scope === "fg" ? fgZoneIdForPhys : semiZoneIdForPhys;
    const physTarget = physId || physDefault;
    if (!fgZone || !matZoneIdForPhys || !physTarget) {
      alert("Не выбран склад или зоны для проведения производства.");
      return;
    }

    try {
      const { error } = await supabase.rpc("post_production_report", {
        p_number: `${scope === "fg" ? "FG" : "SEMI"}-${code || "NO"}-${dateISO}`,
        p_date_iso: dateISO,
        p_product_id: id,
        p_qty: diff,
        p_phys_warehouse_id: physTarget,
        p_fg_zone_id: fgZone,
        p_mat_zone_id: matZoneIdForPhys,
        p_plan_kind: scope,
        p_plan_item_id: id,
        p_plan_date: dateISO,
      });
      if (error) throw error;
      updateFactLocal(scope, id, dateISO, nextVal);
      await fetchPlans(scope);
      await refreshStockBalances();
    } catch (err: any) {
      console.error("post_production_report", err);
      alert("Не удалось провести факт через Supabase RPC, см. консоль.");
    }
  };


  // управление диапазоном
  const addLeft = (n: number) => {
    const d = new Date(startISO + "T00:00:00");
    d.setDate(d.getDate() - n);
    setStartISO(d.toISOString().slice(0, 10));
    setDays(days + n);
  };
  const addRight = (n: number) => setDays(Math.min(90, days + n));
  const removeRight = (n: number) => setDays(Math.max(1, days - n));

  const fmt = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
  };
  const weekday = (iso: string) => ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"][new Date(iso + "T00:00:00").getDay()];
  const dayMeta = (iso: string) => {
    const g = new Date(iso + "T00:00:00").getDay();
    const isWeekend = g === 0 || g === 6;
    const isToday = iso === new Date().toISOString().slice(0, 10);
    return { isWeekend, isToday };
  };

  return (
    <div className="mrp-page">
      <div className="mrp-card">
        {/* toolbar */}
        <div className="ui-form form-grid-2 toolbar mb-2">
          {/* левая колонка */}
          <div>
            <div className="form-row">
              <span className="form-label">Период с</span>
              <div className="row-inline">
                <input type="date" className="form-control" value={startISO} onChange={(e) => setStartISO(e.target.value)} />
                <input
                  type="number"
                  className="form-control num-compact"
                  value={days}
                  onChange={(e) => setDays(Math.min(90, Math.max(1, Number(e.target.value) || 1)))}
                />
              </div>
            </div>

            <div className="form-row">
              <span className="form-label">Сдвиг диапазона</span>
              <div className="row-inline">
                <button type="button" className="app-pill app-pill--sm" onClick={() => addLeft(1)}>+1 слева</button>
                <button type="button" className="app-pill app-pill--sm" onClick={() => addRight(1)}>+1 справа</button>
                <button type="button" className="app-pill app-pill--sm" onClick={() => addLeft(7)}>+7 слева</button>
                <button type="button" className="app-pill app-pill--sm" onClick={() => addRight(7)}>+7 справа</button>
                <button type="button" className="app-pill app-pill--sm" onClick={() => removeRight(1)}>-1 справа</button>
              </div>
            </div>

            <div className="form-row">
              <label className="row-inline">
                <input type="checkbox" checked={rtl} onChange={(e) => setRtl(e.target.checked)} />
                Справа → налево
              </label>
            </div>
          </div>

          {/* правая колонка */}
          <div>
            <div className="form-row">
              <span className="form-label">Режим</span>
              <div className="row-inline">
                <button
                  type="button"
                  className={`app-pill app-pill--sm ${scope === "fg" ? "is-active" : ""}`}
                  onClick={() => setScope("fg")}
                >
                  Готовая продукция
                </button>
                <button
                  type="button"
                  className={`app-pill app-pill--sm ${scope === "semi" ? "is-active" : ""}`}
                  onClick={() => setScope("semi")}
                >
                  Полуфабрикаты
                </button>
              </div>
            </div>

            <div className="form-row">
              <div className="row-inline" style={{ gap: 12 }}>
                <div>
                  <span className="form-label">Склад</span>
                  <select className="form-control" value={physId} onChange={(e) => setPhysId(e.target.value)}>
                    {physical.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <span className="form-label">Категория</span>
                  <select className="form-control" value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
                    <option value="">(все категории)</option>
                    {availableCats.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* таблица */}
        <div className="mrp-hscroll">
          <table className="min-w-full text-sm table-compact plangrid">
            <thead>
              <tr>
                <th className="sticky bg-white z-10 prod-col text-left px-2 py-2" style={{ left: 0 }}>
                  {scope === "fg" ? "Продукт" : "Полуфабрикат"}
                </th>
                <th className="sticky bg-white z-10 fg-col text-left px-2 py-2" style={{ left: "var(--prod-w)" }}>
                  {scope === "fg" ? "Остаток ГП" : "Остаток ПФ"}
                </th>
                <th className="sticky bg-white z-10 metric-col text-left px-2 py-2" style={{ left: "calc(var(--prod-w) + var(--fg-w))" }}>
                  Показатель
                </th>

                {range.map((d) => {
                  const g = new Date(d + "T00:00:00").getDay();
                  const isWeekend = g === 0 || g === 6;
                  const isToday = d === todayISO;
                  return (
                    <th key={d} className={`date-col text-center px-2 py-2 ${isWeekend ? "is-weekend" : ""} ${isToday ? "is-today" : ""}`}>
                      <div className="font-semibold">{fmt(d)}</div>
                      <div className="text-[11px] text-slate-500">{weekday(d)}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>

            <tbody>
              {rows.map((item) => {
                const id = item.id!;
                const code = (item as any).code;

                const PlanRow = (
                  <tr key={`${id}-plan`} className="border-t border-slate-200">
                    <td className="sticky prod-col align-top px-2 py-[6px]" rowSpan={3} style={{ left: 0, background: "#fff" }}>
                      <div className="font-medium truncate">
                        {code} — {item.name}
                      </div>
                    </td>
                    <td className="sticky fg-col align-top px-2 py-[6px]" rowSpan={3} style={{ left: "var(--prod-w)", background: "#fff" }}>
                      {stockOfRow(id)}
                    </td>
                    <td className="sticky metric-col px-2 py-[6px]" style={{ left: "calc(var(--prod-w) + var(--fg-w))", background: "#fff" }}>
                      План
                    </td>
                    {range.map((d) => {
                      const planVal = Number(planMap[id]?.[d] || 0);
                      const factVal = Number(factMap[id]?.[d] || 0);
                      const isOver  = planVal > 0 && factVal <= 0 && isOverduePlan(d, todayISO);
                      return (
                        <td
                          key={d}
                          className={`date-col px-2 py-[6px] ${isOver ? "is-overdue tip tip--danger" : ""}`}
                          data-tip={isOver ? "Просрочено: резерв снят (нет произведённого)" : undefined}
                        >
                          <PlanNumberCell
                            id={`${id}:${d}:plan`}
                            value={planVal}
                            onChange={(n) => handlePlanChange(id, d, n)}
                            storeRef={editStoreRef}
                            onNav={handleNav}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );

                const FactRow = (
                  <tr key={`${id}-fact`} className="border-t border-slate-100">
                    <td className="sticky metric-col px-2 py-[6px]" style={{ left: "calc(var(--prod-w) + var(--fg-w))", background: "#fff" }}>
                      Произведено
                    </td>
                    {range.map((d) => {
                      const factVal = Number(factMap[id]?.[d] || 0);
                      return (
                        <td key={d} className="date-col px-2 py-[6px]">
                        <PlanNumberCell
                          id={`${id}:${d}:fact`}
                          value={factVal}
                          onChange={(n) => handleFactChange(id, d, n, code)}
                          storeRef={editStoreRef}
                          onNav={handleNav}
                          commitOnly
                        />

                        </td>
                      );
                    })}
                  </tr>
                );

                const CoverRow = (
                  <tr key={`${id}-cover`} className="border-t border-slate-100">
                    <td className="sticky metric-col px-2 py-[6px]" style={{ left: "calc(var(--prod-w) + var(--fg-w))", background: "#fff" }}>
                      Мат. обеспеч.
                    </td>
                    {range.map((d) => {
                      const planVal = Number(planMap[id]?.[d] || 0);
                      if (d < todayISO || planVal <= 0) return <td key={d} className="date-col text-center px-2 py-[6px]"></td>;

                      const cell = coverage[id]?.[d];
                      const ok   = cell?.ok ?? true;
                      const t    = cell?.title ?? "";

                      return (
                        <td key={d} className="date-col text-center px-2 py-[6px]">
                          <span
                            className={`mrp-cover ${ok ? "ok tip tip--ok" : "bad tip tip--danger"}`}
                            data-tip={t || (ok ? "Достаточно" : "Не хватает")}
                          >
                            {ok ? "✓" : "✕"}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );

                return (
                  <React.Fragment key={id}>
                    {PlanRow}
                    {FactRow}
                    {CoverRow}
                  </React.Fragment>
                );
              })}

              {rows.length === 0 && (
                <tr>
                  <td colSpan={3 + range.length} className="px-3 py-6 text-center text-slate-400">
                    Нет строк для выбранного режима/категории
                  </td>
                </tr>
              )}
            </tbody>

            <tfoot>
              <tr className="border-t border-slate-200">
                <td className="prod-col font-medium px-2 py-2" style={{ left: 0, background: "#fff" }}>
                  Итого по дню
                </td>
                <td className="fg-col px-2 py-2" style={{ left: "var(--prod-w)", background: "#fff" }}></td>
                <td className="metric-col px-2 py-2" style={{ left: "calc(var(--prod-w) + var(--fg-w))", background: "#fff" }}></td>
                {range.map((d) => (
                  <td key={d} className="date-col px-2 py-2">
                    <div className="text-sm font-semibold">{totals[d].plan}</div>
                    <div className="text-sm text-slate-600">{totals[d].fact}</div>
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}

export default PlanGridView;
