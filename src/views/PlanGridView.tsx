// file: src/views/PlanGridView.tsx
import React from "react";
import { Search } from "lucide-react";
import { supabase } from "../api/supabaseClient";
import { fetchSpecsFromSupabase } from "../utils/specSupabase";
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
  wbSku?: string;
  ozonSku?: string;
  barcode?: string;
  mpCategoryWb?: string;
  mpCategoryOzon?: string;
  boxLength?: number;
  boxWidth?: number;
  boxHeight?: number;
  boxWeight?: number;
  unitsPerBox?: number;
  unitsPerPallet?: number;
  palletWeight?: number;
};

type Semi = {
  id: string;
  status: string;
  code: string;
  name: string;
  category?: string;
  uom?: string;
  price?: number;
  leadDays?: number;
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
const normalizeISO = (value?: string | null) => (value ? String(value).slice(0, 10) : "");
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
const parseISODate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
};
const isoToUtcDate = (iso: string) => {
  const { y, m, d } = parseISODate(iso);
  return new Date(Date.UTC(y, m - 1, d));
};
const utcDateToISO = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
const addDaysISO = (iso: string, delta: number) => {
  const d = isoToUtcDate(iso);
  d.setUTCDate(d.getUTCDate() + delta);
  return utcDateToISO(d);
};

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

const PLAN_GRID_CACHE_KEY = "mrp.plan.grid.cache.v1";
const PLAN_GRID_CACHE_STATIC_TTL = 30 * 60 * 1000;
const PLAN_GRID_CACHE_DYNAMIC_TTL = 2 * 60 * 1000;

type PlanGridCache = {
  tsStatic?: number;
  tsDynamic?: number;
  products?: Product[];
  semis?: Semi[];
  materialsDict?: { id: string; code: string; name: string; uom?: string }[];
  semisDict?: { id: string; code: string; name: string; uom?: string; leadDays?: number }[];
  specs?: Spec[];
  tgUsers?: { id: string; label: string }[];
  stockBalances?: StockBalance[];
};

const isCacheFresh = (ts?: number, ttl = PLAN_GRID_CACHE_STATIC_TTL) =>
  typeof ts === "number" && Date.now() - ts < ttl;

const readPlanGridCache = (): PlanGridCache | null => {
  try {
    const raw = localStorage.getItem(PLAN_GRID_CACHE_KEY);
    return raw ? (JSON.parse(raw) as PlanGridCache) : null;
  } catch {
    return null;
  }
};

const writePlanGridCache = (patch: Partial<PlanGridCache>) => {
  try {
    const current = readPlanGridCache() ?? {};
    const next = { ...current, ...patch };
    localStorage.setItem(PLAN_GRID_CACHE_KEY, JSON.stringify(next));
  } catch {}
};

// --- рабочие дни / просрочка ---
const addWorkingDays = (iso: string, k: number) => {
  let cur = iso;
  let left = Math.abs(k);
  const dir = k >= 0 ? 1 : -1;
  while (left > 0) {
    cur = addDaysISO(cur, dir);
    const wd = isoToUtcDate(cur).getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return cur;
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
  const [, force] = React.useState(0); // форсируем ререндер для отображения вводимых цифр

  const isActive = store.activeId === id;

  const display = isActive ? store.values[id] ?? "" : value === 0 || !Number.isFinite(value) ? "" : String(value);

  const commit = (raw: string) => {
    const s = (raw ?? "").replace(",", ".").trim();
    if (s === "") { onChange(0); return; }
    const n = Number(s);
    if (Number.isFinite(n) && n >= 0) onChange(n);
  };

  const bump = () => force((v) => v + 1);

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
        bump();
      }}
      onChange={(e) => {
        // только сохраняем ввод в store и перерисовываемся, без живого коммита
        store.values[id] = e.target.value;
        bump();
      }}

      onBlur={(e) => {
        if (store.suppressBlurOnce) {    // уже коммитили по Enter/Tab — пропускаем второй коммит
          store.suppressBlurOnce = false;
          delete store.values[id];
          if (store.activeId === id) store.activeId = null;
          bump();
          return;
        }
        commit(store.values[id] ?? display);
        delete store.values[id];
        if (store.activeId === id) store.activeId = null;
        bump();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Tab") {
          store.suppressBlurOnce = true; // скажем onBlur не коммитить повторно
          commit(store.values[id] ?? display);
          delete store.values[id];
          if (store.activeId === id) store.activeId = null;
          (e.currentTarget as HTMLInputElement).blur();
          if (e.key === "Enter") e.preventDefault();
          bump();
          return;
        }
        if (e.key === "Escape") {
          delete store.values[id];
          if (store.activeId === id) store.activeId = null;
          (e.currentTarget as HTMLInputElement).blur();
          bump();
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
  const [semisDict, setSemisDict] = React.useState<{ id: string; code: string; name: string; uom?: string; leadDays?: number }[]>([]);
  const [stockBalances, setStockBalances] = React.useState<StockBalance[]>([]);
  const [tgUsers, setTgUsers] = React.useState<{ id: string; label: string }[]>([]);
  const [authorId, setAuthorId] = React.useState("");
  const { warehouses, physical, zonesByPhys, findZoneByName, updateWarehouse } = useSupabaseWarehouses();

  React.useEffect(() => {
    const cached = readPlanGridCache();
    if (!cached) return;
    if (cached.products && isCacheFresh(cached.tsStatic)) setProducts(cached.products);
    if (cached.semis && isCacheFresh(cached.tsStatic)) setSemis(cached.semis);
    if (cached.materialsDict && isCacheFresh(cached.tsStatic)) setMaterialsDict(cached.materialsDict);
    if (cached.semisDict && isCacheFresh(cached.tsStatic)) setSemisDict(cached.semisDict);
    if (cached.specs && isCacheFresh(cached.tsStatic)) setSpecs(cached.specs);
    if (cached.tgUsers && isCacheFresh(cached.tsStatic)) setTgUsers(cached.tgUsers);
    if (!authorId && cached.tgUsers?.length) setAuthorId(cached.tgUsers[0].id);
    if (cached.stockBalances && isCacheFresh(cached.tsDynamic, PLAN_GRID_CACHE_DYNAMIC_TTL)) {
      setStockBalances(cached.stockBalances);
    }
  }, [authorId]);

  React.useEffect(() => {
    const loadProducts = async () => {
      const cached = readPlanGridCache();
      if (cached?.products && isCacheFresh(cached.tsStatic)) {
        setProducts(cached.products);
        return;
      }
      const { data, error } = await supabase
        .from("items")
        .select("id, code, name, category, uom, status")
        .eq("kind", "product")
        .order("name", { ascending: true });
      if (error) {
        console.error("load products", error);
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
      setProducts(mapped);
      writePlanGridCache({ products: mapped, tsStatic: Date.now() });
    };
    loadProducts();
  }, []);

  React.useEffect(() => {
    const loadSemis = async () => {
      const cached = readPlanGridCache();
      if (cached?.semis && cached.semisDict && isCacheFresh(cached.tsStatic)) {
        setSemis(cached.semis);
        setSemisDict(cached.semisDict);
        return;
      }
      const { data, error } = await supabase
        .from("items")
        .select("id, code, name, category, uom, status, lead_days")
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
          leadDays: Number(row.lead_days) || 0,
        }));
      setSemis(mapped);
      const nextDict = mapped.map((s) => ({ id: s.id, code: s.code, name: s.name, uom: s.uom, leadDays: s.leadDays }));
      setSemisDict(nextDict);
      writePlanGridCache({ semis: mapped, semisDict: nextDict, tsStatic: Date.now() });
    };
    loadSemis();
  }, []);

  React.useEffect(() => {
    const loadTgUsers = async () => {
      const cached = readPlanGridCache();
      if (cached?.tgUsers && isCacheFresh(cached.tsStatic)) {
        setTgUsers(cached.tgUsers);
        if (!authorId && cached.tgUsers.length) setAuthorId(cached.tgUsers[0].id);
        return;
      }
      const { data, error } = await supabase
        .from("tg_users")
        .select("id, username, first_name, last_name, status")
        .in("status", ["active"]);
      if (error) {
        console.error("load tg_users", error);
        return;
      }
      const mapped = (data || []).map((row: any) => {
        const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
        const label = name || (row.username ? `@${row.username}` : "—");
        return { id: row.id, label };
      });
      setTgUsers(mapped);
      if (!authorId && mapped.length) {
        setAuthorId(mapped[0].id);
      }
      writePlanGridCache({ tgUsers: mapped, tsStatic: Date.now() });
    };
    loadTgUsers();
  }, [authorId]);

  React.useEffect(() => {
    const loadMaterials = async () => {
      const cached = readPlanGridCache();
      if (cached?.materialsDict && isCacheFresh(cached.tsStatic)) {
        setMaterialsDict(cached.materialsDict);
        return;
      }
      const { data, error } = await supabase
        .from("items")
        .select("id, code, name, uom")
        .eq("kind", "material")
        .order("name", { ascending: true });
      if (error) {
        console.error("load materials", error);
        return;
      }
      const mapped =
        (data || []).map((row: any) => ({
          id: row.id,
          code: row.code,
          name: row.name,
          uom: row.uom ?? "шт",
        }));
      setMaterialsDict(mapped);
      writePlanGridCache({ materialsDict: mapped, tsStatic: Date.now() });
    };
    loadMaterials();
  }, []);

  React.useEffect(() => {
    const loadSpecs = async () => {
      const cached = readPlanGridCache();
      if (cached?.specs && isCacheFresh(cached.tsStatic)) {
        setSpecs(cached.specs);
        return;
      }
      try {
        const rows = await fetchSpecsFromSupabase();
        const mapped = rows.map((sp) => ({
          id: sp.id,
          productId: sp.linkedProductId ?? undefined,
          productCode: sp.specCode,
          productName: sp.specName,
          lines: sp.lines.map((ln) => ({
            id: ln.id,
            kind: ln.kind,
            refId: ln.refId,
            qty: ln.qty,
            uom: ln.uom,
          })),
          updatedAt: sp.updatedAt ?? new Date().toISOString(),
        }));
        setSpecs(mapped);
        writePlanGridCache({ specs: mapped, tsStatic: Date.now() });
      } catch (err) {
        console.error("load specs", err);
      }
    };
    loadSpecs();
  }, []);

  const refreshStockBalances = React.useCallback(async (force = false) => {
    const cached = readPlanGridCache();
    if (!force && cached?.stockBalances && isCacheFresh(cached.tsDynamic, PLAN_GRID_CACHE_DYNAMIC_TTL)) {
      setStockBalances(cached.stockBalances);
      return;
    }
    const { data, error } = await supabase.from("stock_balances").select("warehouse_id, item_id, qty, updated_at");
    if (error) {
      console.error("load stock_balances", error);
      return;
    }
    const mapped =
      (data || []).map((row: any) => ({
        id: `${row.warehouse_id}:${row.item_id}`,
        warehouseId: row.warehouse_id,
        itemId: row.item_id,
        qty: Number(row.qty) || 0,
        updatedAt: row.updated_at,
      }));
    setStockBalances(mapped);
    writePlanGridCache({ stockBalances: mapped, tsDynamic: Date.now() });
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
  const fmtShort = React.useCallback((iso: string) => {
    const { m, d } = parseISODate(iso);
    return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
  }, []);

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
  const [startISO, setStartISO] = useLocalState<string>("mrp.plan.startISO", toEkatISO(new Date()));
  const [days, setDays]         = useLocalState<number>("mrp.plan.days", 14);
  const [rtl, setRtl]           = useLocalState<boolean>("mrp.plan.rtl", true);

  const range = React.useMemo(() => {
    const baseISO = normalizeISO(startISO);
    const list: string[] = [];
    for (let i = 0; i < days; i++) {
      list.push(addDaysISO(baseISO, i));
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

  const todayISO = toEkatISO(new Date());
  const editStoreRef = React.useRef<EditStore>({ activeId: null, values: {} });

  // режим: ГП или ПФ
  const [scope, setScope] = useLocalState<"fg" | "semi">("mrp.plan.scope", "fg");

  // склад
  const physDefault = React.useMemo(() => physical[0]?.id ?? "", [physical]);
  const [physId, setPhysId] = useLocalState<string>("mrp.plan.phys", physDefault);
  const physTarget = physId || physDefault;
  const activePhys = React.useMemo(() => physical.find((p) => p.id === physTarget) || null, [physical, physTarget]);
  const [sendTime, setSendTime] = useLocalState<string>("mrp.plan.send_time", "07:45");

  // если список складов обновился и сохранённый id отсутствует — переключаемся на первый доступный
  React.useEffect(() => {
    if (physTarget) return;
    if (physDefault) setPhysId(physDefault);
  }, [physTarget, physDefault, setPhysId]);
  React.useEffect(() => {
    if (!activePhys) return;
    if (activePhys.tgSendTime && activePhys.tgSendTime !== sendTime) {
      setSendTime(activePhys.tgSendTime);
    }
  }, [activePhys, sendTime, setSendTime]);

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

  // планы/факты/брак
  type PlanMap = Record<string, Record<string, number>>;
  const [planMapFG, setPlanMapFG] = React.useState<PlanMap>({});
  const [factMapFG, setFactMapFG] = React.useState<PlanMap>({});
  const [scrapMapFG, setScrapMapFG] = React.useState<PlanMap>({});
  const [planMapSEMI, setPlanMapSEMI] = React.useState<PlanMap>({});
  const [factMapSEMI, setFactMapSEMI] = React.useState<PlanMap>({});
  const [scrapMapSEMI, setScrapMapSEMI] = React.useState<PlanMap>({});

  React.useEffect(() => {
    try {
      localStorage.setItem("mrp.plan.fg.planMap.v1", JSON.stringify(planMapFG));
    } catch (err) {
      console.warn("planMapFG persist failed", err);
    }
  }, [planMapFG]);

  React.useEffect(() => {
    try {
      localStorage.setItem("mrp.plan.semi.planMap.v1", JSON.stringify(planMapSEMI));
    } catch (err) {
      console.warn("planMapSEMI persist failed", err);
    }
  }, [planMapSEMI]);

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

  const updateScrapLocal = React.useCallback((kind: "fg" | "semi", id: string, dateISO: string, val: number) => {
    if (kind === "fg") {
      setScrapMapFG((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), [dateISO]: val } }));
    } else {
      setScrapMapSEMI((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), [dateISO]: val } }));
    }
  }, []);

  const fetchPlans = React.useCallback(
    async (targetScope: "fg" | "semi") => {
      if (!range.length || !physTarget) return;
      const ordered = [...range].sort();
      const startDate = ordered[0];
      const endDate = ordered[ordered.length - 1];
      const table = targetScope === "fg" ? "plans_fg" : "plans_semi";
      const idColumn = targetScope === "fg" ? "product_id" : "semi_id";
      const { data, error } = await supabase
        .from(table)
        .select(`${idColumn}, phys_warehouse_id, date_iso, qty, fact_qty, scrap_qty`)
        .gte("date_iso", startDate)
        .lte("date_iso", endDate)
        .eq("phys_warehouse_id", physTarget);
      if (error) {
        console.error("load plans", error);
        return;
      }
      const nextPlan: PlanMap = {};
      const nextFact: PlanMap = {};
      const nextScrap: PlanMap = {};
      (data || []).forEach((row: any) => {
        const itemId = row[idColumn];
        const dateISO = normalizeISO(row.date_iso);
        if (!itemId || !dateISO) return;
        if (!nextPlan[itemId]) nextPlan[itemId] = {};
        if (!nextFact[itemId]) nextFact[itemId] = {};
        if (!nextScrap[itemId]) nextScrap[itemId] = {};
        nextPlan[itemId][dateISO] = Number(row.qty) || 0;
        nextFact[itemId][dateISO] = Number(row.fact_qty) || 0;
        nextScrap[itemId][dateISO] = Number(row.scrap_qty) || 0;
      });
      if (targetScope === "fg") {
        setPlanMapFG(nextPlan);
        setFactMapFG(nextFact);
        setScrapMapFG(nextScrap);
      } else {
        setPlanMapSEMI(nextPlan);
        setFactMapSEMI(nextFact);
        setScrapMapSEMI(nextScrap);
      }
    },
    [range, physTarget]
  );

  React.useEffect(() => {
    fetchPlans(scope);
  }, [fetchPlans, scope]);

  const upsertPlanValue = React.useCallback(
    async (kind: "fg" | "semi", itemId: string, dateISO: string, qty: number, physWarehouseId: string) => {
      const table = kind === "fg" ? "plans_fg" : "plans_semi";
      const idColumn = kind === "fg" ? "product_id" : "semi_id";
      const payload: Record<string, any> = { [idColumn]: itemId, date_iso: dateISO, qty, phys_warehouse_id: physWarehouseId };
      const { error } = await supabase.from(table).upsert(payload, { onConflict: `${idColumn},phys_warehouse_id,date_iso` });
      if (error) {
        console.error("plan upsert", { payload, error });
        alert(`Не удалось сохранить план: ${error.message || "ошибка Supabase"}`);
        fetchPlans(kind);
      }
    },
    [fetchPlans]
  );

  const planMap = scope === "fg" ? planMapFG : planMapSEMI;
  const factMap = scope === "fg" ? factMapFG : factMapSEMI;
  const scrapMap = scope === "fg" ? scrapMapFG : scrapMapSEMI;

  // список категорий
  const availableCats = React.useMemo(() => {
    const pool = scope === "fg" ? products : semis;
    const set = new Set<string>();
    for (const it of pool) if (it.status !== "archived" && it.category) set.add(it.category);
    return Array.from(set).sort();
  }, [scope, products, semis]);
  const [catFilter, setCatFilter] = useLocalState<string>("mrp.plan.cat", "");
  const [planSearch, setPlanSearch] = useLocalState<string>("mrp.plan.search", "");
  React.useEffect(() => {
    if (catFilter && !availableCats.includes(catFilter)) setCatFilter("");
  }, [availableCats, catFilter, setCatFilter]);

  const [sortState, setSortState] = useLocalState<{
    key: "code" | "name";
    dir: "asc" | "desc";
  }>("mrp.plan.sort", { key: "code", dir: "asc" });

  const handleSort = (key: "code" | "name") => {
    setSortState((prev) => {
      if (prev.key !== key) return { key, dir: "asc" };
      return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  };

  const sortArrows = (key: "code" | "name") => {
    const isActive = sortState.key === key;
    return (
      <span className={`wbwh-sort ${isActive ? "is-active" : ""}`} aria-hidden="true">
        <span className={`wbwh-sort__arrow ${isActive && sortState.dir === "asc" ? "is-selected" : ""}`}>▲</span>
        <span className={`wbwh-sort__arrow ${isActive && sortState.dir === "desc" ? "is-selected" : ""}`}>▼</span>
      </span>
    );
  };
  // строки
  const rows = React.useMemo(() => {
    const q = planSearch.trim().toLowerCase();
    if (scope === "fg") {
      let base = products.filter((p) => p.status !== "archived");
      if (catFilter) base = base.filter((p) => (p.category || "") === catFilter);
      if (q) base = base.filter((p) => (p.code || "").toLowerCase().includes(q) || (p.name || "").toLowerCase().includes(q));
      return base;
    } else {
      let base = semis.filter((s) => s.status !== "archived");
      if (catFilter) base = base.filter((s) => (s.category || "") === catFilter);
      if (q) base = base.filter((s) => (s.code || "").toLowerCase().includes(q) || (s.name || "").toLowerCase().includes(q));
      return base;
    }
  }, [scope, products, semis, catFilter, planSearch]);

  const sortedRows = React.useMemo(() => {
    const dir = sortState.dir === "asc" ? 1 : -1;
    const getValue = (r: Product | Semi) => {
      if (sortState.key === "name") return r.name ?? "";
      return r.code ?? "";
    };
    return [...rows].sort((a, b) =>
      getValue(a).localeCompare(getValue(b), "ru", { sensitivity: "base" }) * dir
    );
  }, [rows, sortState]);

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

  const plannedSemiUpTo = React.useCallback(
    (sid: string, dateISO: string) => {
      const byDate = planMapSEMI[sid] || {};
      let sum = 0;
      for (const [d, q] of Object.entries(byDate)) {
        if (d <= dateISO) sum += Number(q) || 0;
      }
      return sum;
    },
    [planMapSEMI]
  );

  const plannedSemiUsedUpTo = React.useCallback(
    (sid: string, dateISO: string, exclude?: { id: string; dateISO: string }) => {
      let sum = 0;
      for (const [fgId, byDate] of Object.entries(planMapFG)) {
        const per = perUnitById[fgId];
        const one = Number(per?.semi?.[sid] || 0);
        if (one <= 0) continue;
        for (const [d, q] of Object.entries(byDate || {})) {
          if (d > dateISO) continue;
          if (exclude && fgId === exclude.id && d === exclude.dateISO) continue;
          sum += one * (Number(q) || 0);
        }
      }
      return sum;
    },
    [planMapFG, perUnitById]
  );

  const handlePlanChange = (id: string, dateISO: string, val: number) => {
    if (!physTarget) {
      alert("Не выбран склад.");
      return;
    }

    // Если планируем готовую продукцию с полуфабрикатами — проверяем остатки ПФ и предлагаем перенести
    if (scope === "fg" && val > 0) {
      const per = perUnitById[id];
      const semiNeed = per?.semi ?? {};
      const semiIds = Object.keys(semiNeed);
      if (semiIds.length > 0) {
        if (!semiZoneIdForPhys) {
          alert("Не выбрана зона полуфабрикатов для расчёта обеспечения.");
          return;
        }
        const shortages = semiIds
          .map((sid) => {
            const one = Number(semiNeed[sid] || 0);
            const need = one * val;
            const haveBase = getQty("semi", sid, semiZoneIdForPhys) + plannedSemiUpTo(sid, dateISO);
            const reserved = plannedSemiUsedUpTo(sid, dateISO, { id, dateISO });
            const have = Math.max(0, haveBase - reserved);
            const deficit = Math.max(0, need - have);
            return { sid, one, need, have, deficit, lead: Number(semiMap[sid]?.leadDays ?? 0) };
          })
          .filter((x) => x.deficit > 0);

        if (shortages.length > 0) {
          const maxLead = Math.max(...shortages.map((s) => s.lead || 0));
          const suggestDate = maxLead > 0 ? addWorkingDays(dateISO, maxLead) : dateISO;
          const lines = [
            "Не хватает полуфабрикатов:",
            ...shortages.map(
              (s) =>
                `• ${nameOf("semi", s.sid)}: нужно ${s.need}, есть ${s.have}` +
                (s.lead > 0 ? ` (срок ${s.lead} дн.)` : "")
            ),
            "",
            `Предлагаю запланировать выпуск ПФ на ${dateISO} и перенести выпуск товара на ${suggestDate}.`,
          ];
          const ok = window.confirm(lines.join("\n"));
          if (!ok) {
            // пользователь отказался — ставим план как есть
          } else {
            // 1) Обнуляем текущую ячейку
            updatePlanLocal(scope, id, dateISO, 0);
            upsertPlanValue(scope, id, dateISO, 0, physTarget);
            // 2) Ставим план ГП на предложенную дату
            updatePlanLocal(scope, id, suggestDate, val);
            upsertPlanValue(scope, id, suggestDate, val, physTarget);
            // 3) Ставим планы ПФ на исходную дату на размер дефицита
            shortages.forEach((s) => {
              updatePlanLocal("semi", s.sid, dateISO, s.deficit);
              upsertPlanValue("semi", s.sid, dateISO, s.deficit, physTarget);
            });
            return;
          }
        }
      }
    }

    updatePlanLocal(scope, id, dateISO, val);
    upsertPlanValue(scope, id, dateISO, val, physTarget);
  };

  type CovCell = { ok: boolean; canMake: number; title: string };
  const coverage: Record<string, Record<string, CovCell>> = React.useMemo(() => {
    const res: Record<string, Record<string, CovCell>> = {};
    if (!matZoneIdForPhys || !fgZoneIdForPhys) return res; // покажем ❌ в UI, если зона не выбрана

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
    }

    const planSemiByDate = new Map<string, Map<string, number>>();
    if (scope === "fg") {
      for (const [sid, byDate] of Object.entries(planMapSEMI)) {
        for (const [d, q] of Object.entries(byDate || {})) {
          const qty = Number(q) || 0;
          if (qty <= 0) continue;
          let bucket = planSemiByDate.get(d);
          if (!bucket) {
            bucket = new Map();
            planSemiByDate.set(d, bucket);
          }
          bucket.set(sid, (bucket.get(sid) || 0) + qty);
        }
      }
    }

    const addPlannedSemiForDate = (d: string) => {
      const bucket = planSemiByDate.get(d);
      if (!bucket) return;
      for (const [sid, qty] of bucket.entries()) {
        setSemi(sid, qtySemi(sid) + qty);
      }
    };

    if (futureDays.length > 0 && scope === "fg") {
      const firstDay = futureDays[0];
      for (const [d] of planSemiByDate.entries()) {
        if (d < firstDay) addPlannedSemiForDate(d);
      }
    }

    for (const d of futureDays) {
      if (scope === "fg") addPlannedSemiForDate(d);

      for (const r of pool) {
        const id = r.id!;
        const plan = Number(planMap[id]?.[d] || 0);
        if (plan <= 0) continue;

        const per = perUnitById[id] || { mat: {}, semi: {} };
        const hasSpec = !!specExistsById[id] && (Object.keys(per.mat).length > 0 || Object.keys(per.semi).length > 0);

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

        if (Object.keys(per.semi).length > 0 && !semiZoneIdForPhys) {
          res[id][d] = { ok: false, canMake: 0, title: "Не выбрана зона полуфабрикатов." };
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
        const semiHints: string[] = [];
        lines.push(`Можно произвести: ${Math.max(0, Math.floor(maxMake))}`);
        for (const [mid, one] of Object.entries(per.mat)) {
          const need = one * plan, have = qtyMat(mid);
          if (have + 1e-8 < need) lines.push(`• ${nameOf("mat", mid)}: −${Math.round((need - have + 1e-9) * 1000) / 1000}`);
        }
        for (const [sid, one] of Object.entries(per.semi)) {
          const need = one * plan, have = qtySemi(sid);
          if (have + 1e-8 < need) {
            const shortage = Math.round((need - have + 1e-9) * 1000) / 1000;
            const leadDays = Number(semiMap[sid]?.leadDays ?? 0);
            const eta = leadDays > 0 ? addWorkingDays(d, leadDays) : null;
            const semiName = nameOf("semi", sid);

            let line = `• ${semiName}: −${shortage}`;
            if (leadDays > 0) line += ` (срок ${leadDays} дн.)`;
            if (eta) line += ` → ГП с ${fmtShort(eta)}`;
            lines.push(line);

            if (eta) {
              semiHints.push(`${semiName}: ГП ставим не раньше ${fmtShort(eta)}; запланируйте ПФ на ${fmtShort(eta)} (${eta})`);
            } else {
              semiHints.push(`${semiName}: нет остатка, добавьте план выпуска ПФ до ${fmtShort(d)}`);
            }
          }
        }
        if (semiHints.length) {
          lines.push("Предложение по ПФ:");
          semiHints.forEach((h) => lines.push(`• ${h}`));
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
    rows, range, todayISO, planMap, factMap, scrapMap, planMapSEMI, scope,
    perUnitById, specExistsById,
    matZoneIdForPhys, fgZoneIdForPhys, semiZoneIdForPhys,
    getQty, fmtShort, semiMap,
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
    if (!authorId) {
      alert("Выберите автора отчёта.");
      return;
    }
    const per = perUnitById[id];
    const hasSpec = !!specExistsById[id] && per && (Object.keys(per.mat).length > 0 || Object.keys(per.semi).length > 0);
    if (!hasSpec) {
      alert("Нельзя провести факт: для позиции нет корректной спецификации.");
      return;
    }
    if (diff === 0) return;

    if (diff > 0) {
      const { ok, msg } = checkProductionDelta(id, diff);
      if (!ok) {
        if (msg) alert(msg);
        return;
      }
    }

    const fgZone = scope === "fg" ? fgZoneIdForPhys : semiZoneIdForPhys;
    if (!fgZone || !matZoneIdForPhys || !physTarget) {
      alert("Не выбран склад или зоны для проведения производства.");
      return;
    }

    try {
      const { error } = diff > 0
        ? await supabase.rpc("post_production_report", {
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
            p_actor_id: authorId,
          })
        : await supabase.rpc("adjust_production_report", {
            p_delta_qty: diff,
            p_product_id: id,
            p_phys_warehouse_id: physTarget,
            p_fg_zone_id: fgZone,
            p_mat_zone_id: matZoneIdForPhys,
            p_plan_kind: scope,
            p_plan_item_id: id,
            p_plan_date: dateISO,
            p_reason: "Корректировка факта из план-факта",
            p_actor_id: authorId,
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

  const handleScrapChange = async (id: string, dateISO: string, nextVal: number, code: string) => {
    const prev = Number(scrapMap[id]?.[dateISO] || 0);
    const diff = nextVal - prev;
    if (!authorId) {
      alert("Выберите автора отчёта.");
      return;
    }
    const per = perUnitById[id];
    const hasSpec = !!specExistsById[id] && per && (Object.keys(per.mat).length > 0 || Object.keys(per.semi).length > 0);
    if (!hasSpec) {
      alert("Нельзя провести брак: для позиции нет корректной спецификации.");
      return;
    }
    if (diff === 0) return;
    if (!matZoneIdForPhys || !physTarget) {
      alert("Не выбран склад или зона материалов.");
      return;
    }

    try {
      const { error } = diff > 0
        ? await supabase.rpc("post_production_scrap", {
            p_number: `SCR-${scope === "fg" ? "FG" : "SEMI"}-${code || "NO"}-${dateISO}`,
            p_date_iso: dateISO,
            p_item_id: id,
            p_qty: diff,
            p_phys_warehouse_id: physTarget,
            p_mat_zone_id: matZoneIdForPhys,
            p_semi_zone_id: scope === "semi" ? semiZoneIdForPhys : null,
            p_plan_kind: scope,
            p_plan_item_id: id,
            p_plan_date: dateISO,
            p_actor_id: authorId,
          })
        : await supabase.rpc("adjust_production_scrap", {
            p_delta_qty: diff,
            p_item_id: id,
            p_phys_warehouse_id: physTarget,
            p_mat_zone_id: matZoneIdForPhys,
            p_semi_zone_id: scope === "semi" ? semiZoneIdForPhys : null,
            p_plan_kind: scope,
            p_plan_item_id: id,
            p_plan_date: dateISO,
            p_reason: "Корректировка брака из план-факта",
            p_actor_id: authorId,
          });
      if (error) throw error;

      if (diff > 0) {
        const table = scope === "fg" ? "plans_fg" : "plans_semi";
        const idColumn = scope === "fg" ? "product_id" : "semi_id";
        const payload: Record<string, any> = {
          [idColumn]: id,
          date_iso: dateISO,
          phys_warehouse_id: physTarget,
          scrap_qty: nextVal,
        };
        await supabase.from(table).upsert(payload, { onConflict: `${idColumn},phys_warehouse_id,date_iso` });
      }

      updateScrapLocal(scope, id, dateISO, nextVal);
      await fetchPlans(scope);
      await refreshStockBalances();
    } catch (err: any) {
      console.error("post_production_scrap", err);
      alert("Не удалось провести брак через Supabase RPC, см. консоль.");
    }
  };

  const handleSaveSendTime = async () => {
    if (!physTarget) return;
    try {
      await updateWarehouse(physTarget, { tgSendTime: sendTime || null });
    } catch (err) {
      console.error("save tg send time", err);
    }
  };

  const handleSendPlan = async () => {
    if (!physTarget) {
      alert("Не выбран склад.");
      return;
    }
    try {
      const { error } = await supabase.functions.invoke("tg-send-plan", {
        body: {
          physWarehouseId: physTarget,
          dateISO: todayISO,
        },
      });
      if (error) throw error;
      alert("План отправлен в Telegram.");
    } catch (err: any) {
      console.error("tg-send-plan", err);
      alert("Не удалось отправить план в Telegram.");
    }
  };


  // управление диапазоном
  const addLeft = (n: number) => {
    const baseISO = normalizeISO(startISO);
    setStartISO(addDaysISO(baseISO, -n));
    setDays(days + n);
  };
  const addRight = (n: number) => setDays(Math.min(90, days + n));
  const removeRight = (n: number) => setDays(Math.max(1, days - n));

  const fmt = (iso: string) => {
    const { m, d } = parseISODate(iso);
    return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}`;
  };
  const weekday = (iso: string) => ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"][isoToUtcDate(iso).getUTCDay()];
  const dayMeta = (iso: string) => {
    const g = isoToUtcDate(iso).getUTCDay();
    const isWeekend = g === 0 || g === 6;
    const isToday = iso === todayISO;
    return { isWeekend, isToday };
  };

  return (
    <div className="mrp-page">
      <div className="mrp-card">
        {/* toolbar */}
        <div className="mrp-toolbar mb-2">
          <div className="mrp-toolbar__left">
            <div className="mrp-field">
              <span className="mrp-field__label">Период с</span>
              <div className="row-inline">
                <input
                  type="date"
                  className="mrp-input"
                  value={startISO}
                  onChange={(e) => setStartISO(normalizeISO(e.target.value))}
                />
                <input
                  type="number"
                  className="mrp-input num-compact"
                  value={days}
                  onChange={(e) => setDays(Math.min(90, Math.max(1, Number(e.target.value) || 1)))}
                />
              </div>
            </div>

            <div className="mrp-field">
              <span className="mrp-field__label">Сдвиг диапазона</span>
              <div className="row-inline">
                <button type="button" className="mrp-btn mrp-btn--ghost" onClick={() => addLeft(1)}>+1 слева</button>
                <button type="button" className="mrp-btn mrp-btn--ghost" onClick={() => addRight(1)}>+1 справа</button>
                <button type="button" className="mrp-btn mrp-btn--ghost" onClick={() => addLeft(7)}>+7 слева</button>
                <button type="button" className="mrp-btn mrp-btn--ghost" onClick={() => addRight(7)}>+7 справа</button>
                <button type="button" className="mrp-btn mrp-btn--ghost" onClick={() => removeRight(1)}>-1 справа</button>
              </div>
            </div>

            <label className="row-inline text-sm">
              <input type="checkbox" checked={rtl} onChange={(e) => setRtl(e.target.checked)} />
              Справа → налево
            </label>
          </div>

          <div className="mrp-toolbar__right">
            <div className="mrp-field">
              <span className="mrp-field__label">Режим</span>
              <div className="row-inline">
                <button
                  type="button"
                  className={`mrp-btn ${scope === "fg" ? "mrp-btn--primary" : "mrp-btn--ghost"}`}
                  onClick={() => setScope("fg")}
                >
                  Готовая продукция
                </button>
                <button
                  type="button"
                  className={`mrp-btn ${scope === "semi" ? "mrp-btn--primary" : "mrp-btn--ghost"}`}
                  onClick={() => setScope("semi")}
                >
                  Полуфабрикаты
                </button>
              </div>
            </div>

            <div className="mrp-field">
              <span className="mrp-field__label">Склад</span>
              <select className="mrp-select" value={physId} onChange={(e) => setPhysId(e.target.value)}>
                {physical.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            <div className="mrp-field">
              <span className="mrp-field__label">Отправка TG</span>
              <div className="row-inline">
                <input
                  type="time"
                  className="mrp-input num-compact"
                  value={sendTime}
                  onChange={(e) => setSendTime(e.target.value)}
                />
                <button type="button" className="mrp-btn mrp-btn--ghost" onClick={handleSaveSendTime}>
                  Сохранить
                </button>
                <button type="button" className="mrp-btn mrp-btn--primary" onClick={handleSendPlan}>
                  Отправить план
                </button>
              </div>
            </div>

            <div className="mrp-field">
              <span className="mrp-field__label">Автор</span>
              <select className="mrp-select" value={authorId} onChange={(e) => setAuthorId(e.target.value)}>
                <option value="">— выбрать —</option>
                {tgUsers.map((u) => (
                  <option key={u.id} value={u.id}>{u.label}</option>
                ))}
              </select>
            </div>

            <div className="mrp-field">
              <span className="mrp-field__label">Категория</span>
              <select className="mrp-select" value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
                <option value="">(все категории)</option>
                {availableCats.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </div>
            <div className="mrp-search-input mrp-search-input--compact">
              <Search className="w-4 h-4" />
              <input
                type="search"
                placeholder="План партии: код / наименование"
                value={planSearch}
                onChange={(e) => setPlanSearch(e.target.value)}
              />
            </div>
          </div>
        </div>

        {/* таблица */}
        <div className="mrp-hscroll mrp-hscroll--sticky">
          <div className="mrp-hscroll__inner">
            <table className="mrp-table text-sm table-compact plangrid">
            <colgroup>
              <col style={{ width: "var(--code-w)" }} />
              <col style={{ width: "var(--name-w)" }} />
              <col style={{ width: "var(--fg-w)" }} />
              <col style={{ width: "var(--metric-w)" }} />
              {range.map((d) => (
                <col key={d} style={{ width: "var(--date-w)" }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th
                  className="sticky bg-white z-10 code-col text-left px-2 py-2 wbwh-sortable"
                  style={{ left: 0 }}
                  onClick={() => handleSort("code")}
                >
                  Код{sortArrows("code")}
                </th>
                <th
                  className="sticky bg-white z-10 name-col text-left px-2 py-2 wbwh-sortable"
                  style={{ left: "var(--code-w)" }}
                  onClick={() => handleSort("name")}
                >
                  {scope === "fg" ? "Продукт" : "Полуфабрикат"}{sortArrows("name")}
                </th>
                <th className="sticky bg-white z-10 fg-col text-left px-2 py-2" style={{ left: "calc(var(--code-w) + var(--name-w))" }}>
                  {scope === "fg" ? "Остаток ГП" : "Остаток ПФ"}
                </th>
                <th className="sticky bg-white z-10 metric-col text-left px-2 py-2" style={{ left: "calc(var(--code-w) + var(--name-w) + var(--fg-w))" }}>
                  Показатель
                </th>

                {range.map((d) => {
                  const g = isoToUtcDate(d).getUTCDay();
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
              {sortedRows.map((item) => {
                const id = item.id!;
                const code = (item as any).code;

                const PlanRow = (
                  <tr key={`${id}-plan`} className="border-t border-slate-200">
                    <td className="sticky code-col align-top px-2 py-[6px]" rowSpan={4} style={{ left: 0, background: "#fff" }}>
                      <span className="mrp-code">{code || "—"}</span>
                    </td>
                    <td className="sticky name-col align-top px-2 py-[6px]" rowSpan={4} style={{ left: "var(--code-w)", background: "#fff" }}>
                      <span className="plangrid-name text-slate-700 text-sm leading-snug">{item.name}</span>
                    </td>
                    <td className="sticky fg-col align-top px-2 py-[6px]" rowSpan={4} style={{ left: "calc(var(--code-w) + var(--name-w))", background: "#fff" }}>
                      {stockOfRow(id)}
                    </td>
                    <td className="sticky metric-col px-2 py-[6px]" style={{ left: "calc(var(--code-w) + var(--name-w) + var(--fg-w))", background: "#fff" }}>
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
                    <td className="sticky metric-col px-2 py-[6px]" style={{ left: "calc(var(--code-w) + var(--name-w) + var(--fg-w))", background: "#fff" }}>
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

                const ScrapRow = (
                  <tr key={`${id}-scrap`} className="border-t border-slate-100">
                    <td className="sticky metric-col px-2 py-[6px]" style={{ left: "calc(var(--code-w) + var(--name-w) + var(--fg-w))", background: "#fff" }}>
                      Брак
                    </td>
                    {range.map((d) => {
                      const scrapVal = Number(scrapMap[id]?.[d] || 0);
                      return (
                        <td key={d} className="date-col px-2 py-[6px]">
                          <PlanNumberCell
                            id={`${id}:${d}:scrap`}
                            value={scrapVal}
                            onChange={(n) => handleScrapChange(id, d, n, code)}
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
                    <td className="sticky metric-col px-2 py-[6px]" style={{ left: "calc(var(--code-w) + var(--name-w) + var(--fg-w))", background: "#fff" }}>
                      Мат. обеспеч.
                    </td>
                    {range.map((d) => {
                      const planVal = Number(planMap[id]?.[d] || 0);
                      if (d < todayISO || planVal <= 0) return <td key={d} className="date-col text-center px-2 py-[6px]"></td>;

                      const cell = coverage[id]?.[d];
                      const ok   = cell?.ok ?? false;
                      const t    = cell?.title ?? "Нет данных по обеспеченности (не выбрана зона материалов/ПФ или нет спецификации)";

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
                    {ScrapRow}
                    {CoverRow}
                  </React.Fragment>
                );
              })}

              {sortedRows.length === 0 && (
                <tr>
                  <td colSpan={4 + range.length} className="px-3 py-6 text-center text-slate-400">
                    Нет строк для выбранного режима/категории
                  </td>
                </tr>
              )}
            </tbody>

            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export default PlanGridView;
