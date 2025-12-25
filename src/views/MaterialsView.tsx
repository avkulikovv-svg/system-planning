// file: src/views/MaterialsView.tsx
import React from "react";
import { Plus, Pencil, Trash2, Check, FlaskConical, Search } from "lucide-react";
// file: src/views/MaterialsView.tsx
import SpecModal from "../components/specs/SpecModal";
import { supabase } from "../api/supabaseClient";
import { fetchSpecsFromSupabase } from "../utils/specSupabase";
import { useSupabaseWarehouses } from "../hooks/useSupabaseDicts";
import {
  useSupabaseGroups,
  useSupabaseUoms,
  useSupabaseVendors,
} from "../hooks/useSupabaseDicts";



/* ========= Типы ========= */
type Vendor = { id: string; name: string };

type BaseItem = {
  id: string;
  status: string; // 'active' | 'archived'
  code: string;
  name: string;
  group?: string;
  uom?: string;
  vendorId?: string; // современная модель
  vendorName?: string; // legacy
  price?: number;
  minLot?: number;
  leadDays?: number;
};

type Material = BaseItem & { uom: string };
type Semi = BaseItem;

type Warehouse = {
  id: string;
  name: string;
  type: "physical" | "virtual";
  parentId?: string | null;
  isActive: boolean;
};

type NomenKind = "material" | "semi";
type StockBalanceRow = { item_id: string; qty: number };

/* ===== Спецификации (общий реестр, компактный тип тут) ===== */
type SpecLine = {
  id: string;
  kind?: "mat" | "semi";
  refId?: string;
  materialId?: string;
  semiId?: string;
  itemId?: string;
  quantity?: number;
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

/* ========= Утилиты ========= */
const uid = () => Math.random().toString(36).slice(2, 9);
const isEmpty = (o: Record<string, unknown>) => Object.keys(o).length === 0;

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

/* ========= Форма создания/редактирования (товар/материал) ========= */
function MaterialForm({
  initial,
  onSave,
  onCancel,
  dicts,
  ensureUniqueCode,
  onRequestOpenSpec, // для полуфабрикатов
  specs,
  initialSpecId,
  isSemi,
}: {
  initial: BaseItem | null;
  onSave: (
    m: BaseItem,
    opts?: { attachSpecId?: string; detachSpecId?: string }
  ) => void;
  onCancel: () => void;
  dicts: {
    vendors: Vendor[];
    addVendor: (name: string) => Promise<Vendor | null>;
    uoms: string[];
    groups: string[];
    addGroup: (name: string) => Promise<void>;
  };
  ensureUniqueCode: (code: string, selfId?: string) => boolean;
  onRequestOpenSpec?: (draft: BaseItem) => void;
  specs?: Spec[];
  initialSpecId?: string;
  isSemi?: boolean;
}) {
  const [form, setForm] = React.useState<BaseItem>(() => {
    if (initial) return { ...initial, group: initial.group ?? "" };
    return {
      id: uid(),
      status: "active",
      code: "",
      name: "",
      uom: dicts.uoms[0] || "шт",
      group: "",
      vendorId: "",
      minLot: 1,
      leadDays: 0,
      price: undefined,
    };
  });

  const codeRef = React.useRef<HTMLInputElement>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const vendorRef = React.useRef<HTMLSelectElement>(null);
  const uomRef = React.useRef<HTMLSelectElement>(null);
  const catRef = React.useRef<HTMLSelectElement>(null);
  React.useEffect(() => {
    codeRef.current?.focus();
  }, []);

  const set = <K extends keyof BaseItem>(k: K, v: BaseItem[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const normNum = (raw: string, def = 0) => {
    const s = (raw ?? "").replace(",", ".").trim();
    if (s === "") return def;
    const n = Number(s);
    return Number.isFinite(n) ? n : def;
  };

  type Errs = Partial<Record<"code" | "name" | "uom" | "group", string>>;
  const [showErrors, setShowErrors] = React.useState(false);
  const [specId, setSpecId] = React.useState<string>(initialSpecId || "");

  React.useEffect(() => {
    setSpecId(initialSpecId || "");
  }, [initialSpecId]);

  const computeErrors = (draft: BaseItem): Errs => {
    const e: Errs = {};
    if (!draft.code?.trim()) e.code = "Обязательное поле";
    if (!draft.name?.trim()) e.name = "Обязательное поле";
    if (!draft.uom?.trim()) e.uom = "Выберите единицу";
    if (!draft.group?.trim()) e.group = "Выберите группу";
    if (
      draft.code?.trim() &&
      !ensureUniqueCode(draft.code.trim(), draft.id)
    )
      e.code = "Код уже используется";
    return e;
  };

  const errors = React.useMemo(() => computeErrors(form), [form]);
  const err = (k: keyof Errs) => errors[k];

  const onAddVendor = async () => {
    const nm = (window.prompt("Новый поставщик") ?? "").trim();
    if (!nm) return;
    const v = await dicts.addVendor(nm);
    if (v) {
      set("vendorId", v.id);
      setTimeout(() => vendorRef.current?.focus(), 0);
    }
  };
  const onAddGroup = async () => {
    const nm = (window.prompt("Новая группа") ?? "").trim();
    if (!nm) return;
    await dicts.addGroup(nm);
    set("group", nm);
    setTimeout(() => catRef.current?.focus(), 0);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const eMap = computeErrors(form);
    if (Object.keys(eMap).length) {
      setShowErrors(true);
      if (eMap.code) {
        codeRef.current?.focus();
        return;
      }
      if (eMap.name) {
        nameRef.current?.focus();
        return;
      }
      if (eMap.uom) {
        uomRef.current?.focus();
        return;
      }
      if (eMap.group) {
        catRef.current?.focus();
        return;
      }
      return;
    }
    const cleaned: BaseItem = {
      ...form,
      code: form.code.trim(),
      name: form.name.trim(),
      minLot: Math.max(1, Number(form.minLot || 1)),
      leadDays: Math.max(0, Number(form.leadDays || 0)),
      price:
        form.price == null || Number.isNaN(form.price as any)
          ? undefined
          : Number(form.price),
      group: form.group?.trim() || "",
    };
    const detachSpecId =
      !specId && initialSpecId ? initialSpecId : undefined;
    onSave(cleaned, {
      attachSpecId: specId || undefined,
      detachSpecId,
    });
  };

  return (
    <form onSubmit={submit}>
      {!isEmpty(errors) && showErrors && (
        <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 text-[13px] px-3 py-2">
          Заполните обязательные поля ниже.
        </div>
      )}

      <div className="form-grid-2">
        {/* Код */}
        <div>
          <div className="form-label">Код *</div>
          <input
            ref={codeRef}
            maxLength={32}
            className="form-control"
            data-invalid={!!err("code")}
            value={form.code}
            onChange={(e) => set("code", e.target.value)}
          />
          {showErrors && err("code") && (
            <div className="form-help">{err("code")}</div>
          )}
        </div>

        {/* Ед. изм. */}
        <div>
          <div className="form-label">Ед. изм. *</div>
          <select
            ref={uomRef}
            className="form-control mrp-select"
            data-invalid={!!err("uom")}
            value={form.uom || ""}
            onChange={(e) => set("uom", e.target.value)}
          >
            {dicts.uoms.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          {showErrors && err("uom") && (
            <div className="form-help">{err("uom")}</div>
          )}
        </div>

        {/* Наименование (на 2 колонки) */}
        <div className="form-span-2">
          <div className="form-label">Наименование *</div>
          <div className="spec-inline">
            <input
              ref={nameRef}
              className="form-control"
              data-invalid={!!err("name")}
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
            />
            {isSemi && onRequestOpenSpec && (
              <button
                type="button"
                className="app-pill app-pill--sm"
                title="Открыть спецификацию"
                onClick={() => onRequestOpenSpec(form)}
              >
                <FlaskConical className="w-4 h-4" /> Спецификация…
              </button>
            )}
          </div>
          {showErrors && err("name") && (
            <div className="form-help">{err("name")}</div>
          )}
        </div>

        {isSemi && specs?.length ? (
          <div className="form-span-2">
            <div className="form-label">Спецификация (выбрать существующую)</div>
            <select
              className="form-control mrp-select"
              value={specId}
              onChange={(e) => setSpecId(e.target.value)}
            >
              <option value="">— не выбрана —</option>
              {[...specs]
                .sort((a, b) => {
                  const aKey = `${a.productCode || ""} ${a.productName || ""}`.trim();
                  const bKey = `${b.productCode || ""} ${b.productName || ""}`.trim();
                  return aKey.localeCompare(bKey, "ru");
                })
                .map((sp) => {
                  const label = sp.productCode
                    ? `${sp.productCode} — ${sp.productName}`
                    : sp.productName;
                  return (
                    <option key={sp.id} value={sp.id}>
                      {label}
                    </option>
                  );
                })}
            </select>
          </div>
        ) : null}

        {/* Группа */}
        <div>
          <div className="form-label">Группа *</div>
          <div className="spec-inline">
            <select
              ref={catRef}
              className="form-control mrp-select"
              data-invalid={!!err("group")}
              value={form.group ?? ""}
              onChange={(e) => set("group", e.target.value)}
            >
              <option value=""></option>
              {dicts.groups.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="mrp-icon-btn"
              title="Добавить группу"
              onClick={onAddGroup}
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
          {showErrors && err("group") && (
            <div className="form-help">{err("group")}</div>
          )}
        </div>

        {/* Поставщик (опц.) */}
        <div>
          <div className="form-label">Поставщик</div>
          <div className="spec-inline">
            <select
              ref={vendorRef}
              className="form-control mrp-select"
              value={form.vendorId ?? ""}
              onChange={(e) => set("vendorId", e.target.value || undefined)}
            >
              <option value=""></option>
              {dicts.vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="mrp-icon-btn"
              title="Добавить поставщика"
              onClick={onAddVendor}
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Мин. партия */}
        <div>
          <div className="form-label">Мин. партия</div>
          <input
            type="number"
            min={1}
            step={1}
            className="form-control"
            value={form.minLot ?? ""}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") { set("minLot", undefined as any); return; }
              set("minLot", Math.max(1, normNum(raw, 1)));
            }}
            placeholder="1"
          />
        </div>

        {/* Срок поставки, дней */}
        <div>
          <div className="form-label">Срок поставки, дней</div>
          <input
            type="number"
            min={0}
            step={1}
            className="form-control"
            value={form.leadDays ?? ""}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") { set("leadDays", undefined as any); return; }
              set("leadDays", Math.max(0, normNum(raw, 0)));
            }}
            placeholder="0"
          />
        </div>

        {/* Цена */}
        <div>
          <div className="form-label">Цена (опц.)</div>
          <input
            type="number"
            min={0}
            step="0.01"
            className="form-control"
            value={form.price ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              set("price", v === "" ? undefined : Math.max(0, normNum(v, 0)));
            }}
            placeholder="0.00"
          />
        </div>

      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          className="app-pill app-pill--md"
          onClick={onCancel}
        >
          Отмена
        </button>
        <button type="submit" className="app-pill app-pill--md is-active">
          Сохранить
        </button>
      </div>
    </form>
  );
}

const isUuid = (s?: string | null) =>
  !!s &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s
  );

const mapItemRow = (row: any): BaseItem => ({
  id: row.id,
  status: row.status ?? "active",
  code: row.code,
  name: row.name,
  uom: row.uom || "шт",
  group: row.group_name || "",
  vendorId: row.vendor_id || "",
  vendorName: row.vendor_name || undefined,
  price: row.price ?? undefined,
  minLot: row.min_lot ?? 1,
  leadDays: row.lead_days ?? 0,
});


/* ========= Экран «Материалы | Полуфабрикаты» ========= */
export default function MaterialsView() {
  const [materialsAll, setMaterialsAll] = useLocalState<Material[]>(
    "mrp.materials.v1",
    []
  );
  const [semisAll, setSemisAll] = useLocalState<Semi[]>("mrp.semis.v1", []);

  const [legacyToUuid, setLegacyToUuid] = React.useState<Record<string, string>>({});

  const [kind, setKind] = useLocalState<NomenKind>("mrp.purch.kind", "material");
  const [query, setQuery] = useLocalState<string>("mrp.purch.search", "");
  const [sortState, setSortState] = React.useState<{
    key: "code" | "name" | "vendor" | "group";
    dir: "asc" | "desc";
  }>({ key: "name", dir: "asc" });

  // словари (единые, Supabase)
  const { uoms: uomRecords } = useSupabaseUoms();
  const { groups: groupRecords, addGroup: addGroupSupabase } = useSupabaseGroups();
  const { vendors, addVendor: addVendorSupabase } = useSupabaseVendors();
  const vendorById = React.useMemo(() => {
    const map = new Map<string, string>();
    vendors.forEach((v) => map.set(v.id, v.name));
    return map;
  }, [vendors]);
  const uoms = React.useMemo(() => uomRecords.map((u) => u.name), [uomRecords]);
  const groups = React.useMemo(() => groupRecords.map((g) => g.name), [groupRecords]);
  const addVendor = React.useCallback(
    (name: string) => addVendorSupabase(name),
    [addVendorSupabase]
  );
  const addGroup = React.useCallback(
    async (name: string) => {
      await addGroupSupabase(name);
    },
    [addGroupSupabase]
  );

  const list = kind === "material" ? materialsAll : semisAll;
  const setList = (arr: BaseItem[]) =>
    kind === "material"
      ? setMaterialsAll(arr as Material[])
      : setSemisAll(arr as Semi[]);

React.useEffect(() => {
  const loadItems = async () => {
    const currentKind = kind === "material" ? "material" : "semi";

    const { data, error } = await supabase
      .from("items")
      .select("*")
      .eq("kind", currentKind)
      .order("name", { ascending: true });

    if (error) {
      console.error("Ошибка загрузки items из Supabase:", error);
      return;
    }

    const mapped: BaseItem[] = (data || []).map(mapItemRow);

    // карта legacy_id → uuid
    const newMap: Record<string, string> = {};
    (data || []).forEach((row: any) => {
      if (row.legacy_id) {
        newMap[row.legacy_id as string] = row.id as string;
      }
    });
    setLegacyToUuid(newMap);

    if (currentKind === "material") {
      setMaterialsAll(mapped as Material[]);
    } else {
      setSemisAll(mapped as Semi[]);
    }
  };

  loadItems();
}, [kind]);



  const items = React.useMemo<BaseItem[]>(() => {
    const norm = (s?: string) => (s || "").toLowerCase().trim();
    const q = norm(query);
    const getVendor = (m: BaseItem) =>
      (m.vendorId ? vendorById.get(m.vendorId) : m.vendorName) || "";
    const filtered = (list || [])
      .filter((m) => (m.status ?? "active") !== "archived")
      .filter(
        (m) =>
          !q ||
          norm(m.code).includes(q) ||
          norm(m.name).includes(q) ||
          norm(m.group).includes(q) ||
          norm(getVendor(m)).includes(q)
      );
    const dir = sortState.dir === "asc" ? 1 : -1;
    const getValue = (m: BaseItem) => {
      if (sortState.key === "code") return m.code || "";
      if (sortState.key === "name") return m.name || "";
      if (sortState.key === "group") return m.group || "";
      return getVendor(m);
    };
    return [...filtered].sort((a, b) =>
      getValue(a).localeCompare(getValue(b), "ru", { sensitivity: "base" }) * dir
    );
  }, [list, query, sortState, vendorById]);

  const handleSort = (key: "code" | "name" | "vendor" | "group") => {
    setSortState((prev) => {
      if (prev.key !== key) return { key, dir: "asc" };
      return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  };

  const sortArrows = (key: "code" | "name" | "vendor" | "group") => {
    const isActive = sortState.key === key;
    return (
      <span className={`wbwh-sort ${isActive ? "is-active" : ""}`} aria-hidden="true">
        <span className={`wbwh-sort__arrow ${isActive && sortState.dir === "asc" ? "is-selected" : ""}`}>▲</span>
        <span className={`wbwh-sort__arrow ${isActive && sortState.dir === "desc" ? "is-selected" : ""}`}>▼</span>
      </span>
    );
  };

  /* ---- склады ---- */
  const {
    warehouses,
    physical,
    zonesByPhys,
    findZoneByName,
  } = useSupabaseWarehouses();

  const warehouseLegacyToUuid = React.useMemo(() => {
    const map: Record<string, string> = {};
    warehouses.forEach((w) => {
      map[w.id] = w.id;
      if (w.legacyId) map[w.legacyId] = w.id;
    });
    return map;
  }, [warehouses]);

  const physDefault = React.useMemo(() => physical[0]?.id ?? "", [physical]);
  const [physId, setPhysId] = useLocalState<string>("mrp.purch.phys", physDefault);

  const pickZone = React.useCallback(
    (pid: string, k: NomenKind) => {
      const zones = zonesByPhys(pid);
      const wanted = k === "material" ? "Материалы" : "Полуфабрикаты";
      return (
        findZoneByName(pid, wanted)?.id ||
        zones.find((z) => new RegExp(wanted, "i").test(z.name))?.id ||
        zones[0]?.id ||
        ""
      );
    },
    [zonesByPhys, findZoneByName]
  );

  const [zoneId, setZoneId] = useLocalState<string>(
    "mrp.purch.zone",
    pickZone(physId || physDefault, kind)
  );

  const currentZoneUuid = React.useMemo(() => {
    if (!zoneId) return "";
    if (isUuid(zoneId)) return zoneId;
    return warehouseLegacyToUuid[zoneId] || "";
  }, [zoneId, warehouseLegacyToUuid]);

  React.useEffect(() => {
    const z = pickZone(physId || physDefault, kind);
    if (z && z !== zoneId) setZoneId(z);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [physId, physDefault, kind, pickZone]);

  /* ---- остатки ---- */
  const [stockByItem, setStockByItem] = React.useState<Record<string, number>>({});

  const refreshStockBalances = React.useCallback(async () => {
    if (!currentZoneUuid) {
      setStockByItem({});
      return;
    }
    const { data, error } = await supabase
      .from("stock_balances")
      .select("item_id, qty")
      .eq("warehouse_id", currentZoneUuid);

    if (error) {
      console.error("Ошибка загрузки stock_balances:", error);
      return;
    }

    const map: Record<string, number> = {};
    const rows = (data as StockBalanceRow[] | null) ?? [];
    rows.forEach((row) => {
      map[row.item_id] = Number(row.qty) || 0;
    });
    setStockByItem(map);
  }, [currentZoneUuid]);

  React.useEffect(() => {
    refreshStockBalances();
  }, [refreshStockBalances]);

  const stockQty = React.useCallback(
    (itemId: string) => stockByItem[itemId] ?? 0,
    [stockByItem]
  );

  /* ---- приход (локальные поля ввода) ---- */
  type RowEdit = { dateISO: string; qty: string; supplierName?: string };
  const [edits, setEdits] = React.useState<Record<string, RowEdit>>({});
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const setEdit = (id: string, patch: Partial<RowEdit>) =>
    setEdits((prev) => ({
      ...prev,
      [id]: { dateISO: todayISO(), qty: "", ...prev[id], ...patch },
    }));

  const stagedCount = React.useMemo(
    () =>
      Object.values(edits).filter(
        (e) => Number((e.qty ?? "").replace(",", ".")) > 0
      ).length,
    [edits]
  );

  const ensureUniqueCode = (code: string, selfId?: string) =>
    !list.some(
      (x) =>
        x.code.trim().toLowerCase() === code.trim().toLowerCase() &&
        x.id !== selfId
    );

  
  const resolveItemUuid = React.useCallback(
    async (it: BaseItem): Promise<string | null> => {
      if (isUuid(it.id)) return it.id;

      const legacyId = it.id?.trim();
      if (!legacyId) {
        console.warn("resolveItemUuid: пустой идентификатор", it);
        return null;
      }

      if (legacyToUuid[legacyId]) return legacyToUuid[legacyId];

      const dbKind = kind === "material" ? "material" : "semi";
      const { data, error } = await supabase
        .from("items")
        .select("id")
        .eq("legacy_id", legacyId)
        .eq("kind", dbKind)
        .limit(1);

      if (error) {
        console.error("resolveItemUuid: supabase error:", error);
        return null;
      }

      let uuid = data?.[0]?.id as string | undefined;
      if (!uuid) {
        const { data: byCode, error: codeErr } = await supabase
          .from("items")
          .select("id, legacy_id")
          .eq("code", it.code)
          .eq("kind", dbKind)
          .limit(1);

        if (codeErr) {
          console.error("resolveItemUuid: supabase error (by code):", codeErr);
          return null;
        }
        uuid = byCode?.[0]?.id as string | undefined;
        const legacyFromRow = byCode?.[0]?.legacy_id as string | undefined;
        if (uuid && legacyFromRow) {
          setLegacyToUuid((prev) => ({ ...prev, [legacyFromRow]: uuid! }));
        }
      } else {
        setLegacyToUuid((prev) => ({ ...prev, [legacyId]: uuid! }));
      }

      if (uuid && isUuid(uuid)) {
        setLegacyToUuid((prev) => ({ ...prev, [legacyId]: uuid }));
        return uuid;
      }

      console.warn("resolveItemUuid: не найден uuid для", {
        legacyId,
        code: it.code,
        dbKind,
      });
      return null;
    },
    [kind, legacyToUuid]
  );

  const resolveWarehouseUuid = React.useCallback(
    async (legacyId: string): Promise<string | null> => {
      if (!legacyId) return null;
      if (isUuid(legacyId)) return legacyId;

      if (warehouseLegacyToUuid[legacyId]) return warehouseLegacyToUuid[legacyId];

      const { data, error } = await supabase
        .from("warehouses")
        .select("id")
        .eq("legacy_id", legacyId)
        .limit(1);

      if (error) {
        console.error("resolveWarehouseUuid: supabase error:", error);
        return null;
      }

      const uuid = data?.[0]?.id as string | undefined;
      if (uuid && isUuid(uuid)) {
        return uuid;
      }

      console.warn("resolveWarehouseUuid: не найден uuid для склада", legacyId);
      return null;
    },
    [warehouseLegacyToUuid]
  );

  const postReceipt = React.useCallback(
    async ({
      dateISO,
      supplierName,
      zoneId,
      items,
    }: {
      dateISO: string;
      supplierName?: string;
      zoneId?: string | null;
      items: { item_id: string; warehouse_id: string; qty: number; uom?: string | null }[];
    }) => {
      const { error } = await supabase.rpc("post_receipt", {
        p_date_iso: dateISO,
        p_supplier_name: supplierName || null,
        p_kind: kind,
        p_items: items,
        p_zone_id: zoneId || null,
      });
      if (error) throw error;
    },
    [kind]
  );

    
  const postOne = async (it: BaseItem) => {
    const e = edits[it.id!];
    if (!e) return;
    if (!zoneId) {
      alert("Не найдена зона хранения для выбранного склада.");
      return;
    }

    const q = Number((e.qty ?? "").replace(",", "."));
    if (!Number.isFinite(q) || q <= 0) {
      alert("Введите положительное число в колонке «Приход».");
      return;
    }

    const ok = window.confirm(
      `Провести приход по «${it.code} — ${it.name}» в количестве ${q}?`
    );
    if (!ok) return;

    const dateISO = e.dateISO || todayISO();

    const dbItemId = await resolveItemUuid(it);
    if (!dbItemId) {
      alert("Не удалось сопоставить номенклатуру с записью в items (Supabase).");
      return;
    }

    const dbWarehouseId = await resolveWarehouseUuid(zoneId);
    if (!dbWarehouseId) {
      alert("Не удалось сопоставить склад/зону с записью в warehouses (Supabase).");
      return;
    }

    try {
      await postReceipt({
        dateISO,
        supplierName: e.supplierName || undefined,
        zoneId: dbWarehouseId,
        items: [
          {
            item_id: dbItemId,
            warehouse_id: dbWarehouseId,
            qty: q,
            uom: it.uom || null,
          },
        ],
      });
      setEdit(it.id!, { qty: "" });
      await refreshStockBalances();
    } catch (err: any) {
      console.error("Supabase post_receipt error:", err);
      alert("Ошибка Supabase (post_receipt): " + err.message);
    }
  };








  const postAll = async () => {
    if (!zoneId) {
      alert("Не найдена зона хранения для выбранного склада.");
      return;
    }

    const rows = items.filter((it) => {
      const e = edits[it.id!];
      const q = Number((e?.qty ?? "").replace(",", "."));
      return Number.isFinite(q) && q > 0;
    });

    if (!rows.length) return;

    const ok = window.confirm(`Провести ${rows.length} строк(и)?`);
    if (!ok) return;

    try {
      for (const it of rows) {
        const e = edits[it.id!]!;
        const q = Number((e.qty ?? "").replace(",", "."));
        const dateISO = e.dateISO || todayISO();

        const dbItemId = await resolveItemUuid(it);
        if (!dbItemId) {
          console.warn(
            "Пропускаю строку — не удалось сопоставить uuid для",
            it
          );
          continue;
        }

        const dbWarehouseId = await resolveWarehouseUuid(zoneId);
        if (!dbWarehouseId) {
          console.warn(
            "Пропускаю строку — не удалось сопоставить склад для zoneId",
            zoneId
          );
          continue;
        }

        await postReceipt({
          dateISO,
          supplierName: e.supplierName || undefined,
          zoneId: dbWarehouseId,
          items: [
            {
              item_id: dbItemId,
              warehouse_id: dbWarehouseId,
              qty: q,
              uom: it.uom || null,
            },
          ],
        });

        setEdit(it.id!, { qty: "" });
      }
      await refreshStockBalances();
    } catch (err: any) {
      console.error("Supabase postAll exception:", err);
      alert("Неожиданная ошибка при записи в Supabase, см. консоль.");
    }
  };








   /* ======= СПЕЦИФИКАЦИИ (общие) ======= */
  const [specs, setSpecs] = useLocalState<Spec[]>("mrp.specs.v1", []);
  const reloadSpecs = React.useCallback(async () => {
    try {
      const rows = await fetchSpecsFromSupabase();
      const next: Spec[] = rows.map((row) => ({
        id: row.id,
        productId: row.linkedProductId ?? undefined,
        productCode: row.specCode,
        productName: row.specName,
        lines: row.lines.map((ln) => ({
          id: ln.id,
          kind: ln.kind,
          refId: ln.refId,
          qty: ln.qty,
          uom: ln.uom,
        })),
        updatedAt: row.updatedAt,
      }));
      setSpecs(next);
      localStorage.setItem("mrp.specs.v1", JSON.stringify(next));
    } catch (err) {
      console.error("reloadSpecs failed", err);
    }
  }, [setSpecs]);

  React.useEffect(() => {
    reloadSpecs();
  }, [reloadSpecs]);
  const findSpecForSemi = (s: Semi) =>
    specs.find((sp) => sp.productId === s.id || sp.productCode === s.code);
  const linkSpecToSemi = React.useCallback(
    async (specId: string, semi: BaseItem) => {
      if (!specId) return;
      const legacyId = semi?.id?.trim();
      if (!legacyId) return;
      const { data, error } = await supabase
        .from("items")
        .select("id")
        .eq("legacy_id", legacyId)
        .eq("kind", "semi")
        .limit(1);
      if (error) {
        console.error("Ошибка поиска полуфабриката:", error);
        return;
      }
      const linkedId = data?.[0]?.id as string | undefined;
      if (!linkedId) return;
      const { error: linkErr } = await supabase
        .from("specs")
        .update({
          linked_product_id: linkedId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", specId);
      if (linkErr) {
        console.error("Ошибка привязки спецификации:", linkErr);
        alert("Не удалось привязать спецификацию, смотри консоль");
        return;
      }
      await reloadSpecs();
    },
    [reloadSpecs],
  );
  const unlinkSpecFromSemi = React.useCallback(
    async (specId: string) => {
      if (!specId) return;
      const { error } = await supabase
        .from("specs")
        .update({
          linked_product_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", specId);
      if (error) {
        console.error("Ошибка отвязки спецификации:", error);
        alert("Не удалось отвязать спецификацию, смотри консоль");
        return;
      }
      await reloadSpecs();
    },
    [reloadSpecs],
  );

  /* ---- планы и параметры диапазона ---- */
const [planMapFG]   = useLocalState<Record<string, Record<string, number>>>("mrp.plan.fg.planMap.v1", {});
const [planMapSEMI] = useLocalState<Record<string, Record<string, number>>>("mrp.plan.semi.planMap.v1", {});
const [planStartISO] = useLocalState<string>("mrp.plan.startISO", new Date().toISOString().slice(0,10));
const [planDays]     = useLocalState<number>("mrp.plan.days", 14);
const [rtl]          = useLocalState<boolean>("mrp.plan.rtl", true);

// диапазон дат как в Плане (UI-порядок)
const range = React.useMemo(() => {
  const base = new Date(planStartISO + "T00:00:00");
  const list: string[] = [];
  for (let i = 0; i < planDays; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    list.push(d.toISOString().slice(0,10));
  }
  return rtl ? list.reverse() : list;
}, [planStartISO, planDays, rtl]);

// хронологический порядок (от ранних к поздним) — для расчётов
const chronoAsc = React.useMemo(() => {
  const c = [...range];
  return rtl ? c.reverse() : c;
}, [range, rtl]);

const today = React.useMemo(() => {
  const d = new Date();
  d.setHours(0,0,0,0);
  return d.toISOString().slice(0,10);
}, []);

/* ---- материалы на единицу из спеки (без рекурсии) ---- */
const perUnitMatForProduct = React.useCallback((productId: string) => {
  const spec = specs.find(sp => sp.productId === productId);
  const map = new Map<string, number>();
  if (spec?.lines?.length) {
    for (const ln of spec.lines) {
      const kind = ln?.kind ?? "mat";
      const mid  = ln?.refId ?? ln?.materialId ?? "";
      const q    = Number(ln?.qty ?? ln?.quantity ?? 0);
      if (kind !== "mat" || !mid || !Number.isFinite(q) || q <= 0) continue;
      map.set(mid, (map.get(mid) ?? 0) + q);
    }
  }
  return map;
}, [specs]);

const perUnitMatForSemi = React.useCallback((semiId: string) => {
  const spec = specs.find(sp => sp.productId === semiId);
  const map = new Map<string, number>();
  if (spec?.lines?.length) {
    for (const ln of spec.lines) {
      const kind = ln?.kind ?? "mat";
      const mid  = ln?.refId ?? ln?.materialId ?? "";
      const q    = Number(ln?.qty ?? ln?.quantity ?? 0);
      if (kind !== "mat" || !mid || !Number.isFinite(q) || q <= 0) continue;
      map.set(mid, (map.get(mid) ?? 0) + q);
    }
  }
  return map;
}, [specs]);

/* ---- ПФ на единицу из спеки ---- */
const perUnitSemiForProduct = React.useCallback((productId: string) => {
  const spec = specs.find(sp => sp.productId === productId);
  const map = new Map<string, number>();
  if (spec?.lines?.length) {
    for (const ln of spec.lines) {
      const kind = ln?.kind ?? "mat";
      if (kind !== "semi") continue;
      const sid  = ln?.refId ?? ln?.semiId ?? ln?.itemId ?? "";
      const q    = Number(ln?.qty ?? ln?.quantity ?? 0);
      if (!sid || !Number.isFinite(q) || q <= 0) continue;
      map.set(sid, (map.get(sid) ?? 0) + q);
    }
  }
  return map;
}, [specs]);

const perUnitSemiForSemi = React.useCallback((semiId: string) => {
  const spec = specs.find(sp => sp.productId === semiId);
  const map = new Map<string, number>();
  if (spec?.lines?.length) {
    for (const ln of spec.lines) {
      const kind = ln?.kind ?? "mat";
      if (kind !== "semi") continue;
      const sid  = ln?.refId ?? ln?.semiId ?? ln?.itemId ?? "";
      const q    = Number(ln?.qty ?? ln?.quantity ?? 0);
      if (!sid || !Number.isFinite(q) || q <= 0) continue;
      map.set(sid, (map.get(sid) ?? 0) + q);
    }
  }
  return map;
}, [specs]);


/* ---- посуточное потребление материалов ---- */
const dailyMat = React.useMemo(() => {
  const out: Record<string, Map<string, number>> = {};
  const bump = (dateISO: string, mid: string, add: number) => {
    if (!out[dateISO]) out[dateISO] = new Map();
    out[dateISO].set(mid, (out[dateISO].get(mid) ?? 0) + add);
  };

  for (const dateISO of chronoAsc) {
    if (dateISO < today) continue; // прошлое не учитываем

    // FG
    for (const [pid, byDate] of Object.entries(planMapFG || {})) {
      const qty = Number(byDate?.[dateISO] ?? 0);
      if (!qty) continue;
      const per = perUnitMatForProduct(pid);
      per.forEach((one, mid) => bump(dateISO, mid, one * qty));
    }

    // SEMI
    for (const [sid, byDate] of Object.entries(planMapSEMI || {})) {
      const qty = Number(byDate?.[dateISO] ?? 0);
      if (!qty) continue;
      const per = perUnitMatForSemi(sid);
      per.forEach((one, mid) => bump(dateISO, mid, one * qty));
    }
  }

  return out;
}, [chronoAsc, today, planMapFG, planMapSEMI, perUnitMatForProduct, perUnitMatForSemi]);

/* ---- посуточное потребление ПФ ---- */
const dailySemi = React.useMemo(() => {
  const out: Record<string, Map<string, number>> = {};
  const bump = (dateISO: string, sid: string, add: number) => {
    if (!out[dateISO]) out[dateISO] = new Map();
    out[dateISO].set(sid, (out[dateISO].get(sid) ?? 0) + add);
  };

  for (const dateISO of chronoAsc) {
    if (dateISO < today) continue;

    // FG → спрос на ПФ
    for (const [pid, byDate] of Object.entries(planMapFG || {})) {
      const qty = Number(byDate?.[dateISO] ?? 0);
      if (!qty) continue;
      const per = perUnitSemiForProduct(pid);
      per.forEach((one, sid) => bump(dateISO, sid, one * qty));
    }

    // SEMI → вложенные ПФ (если используются в ПФ)
    for (const [sid, byDate] of Object.entries(planMapSEMI || {})) {
      const qty = Number(byDate?.[dateISO] ?? 0);
      if (!qty) continue;
      const per = perUnitSemiForSemi(sid);
      per.forEach((one, innerSid) => bump(dateISO, innerSid, one * qty));
    }
  }

  return out;
}, [chronoAsc, today, planMapFG, planMapSEMI, perUnitSemiForProduct, perUnitSemiForSemi]);


/* ---- дни покрытия по материалу (учёт склада/зоны) ---- */
const coverDaysByMatId = React.useMemo(() => {
  const res = new Map<string, number>();
  if (!zoneId) return res;

  const futureDates = chronoAsc.filter(d => d >= today);

  // собрать множество материалов, которые вообще встречаются в спросе
  const allMatIds = new Set<string>();
  futureDates.forEach(d => dailyMat[d]?.forEach((_, mid) => allMatIds.add(mid)));

  for (const mid of allMatIds) {
    const stock = stockQty(mid);
    if (stock <= 0) { res.set(mid, 0); continue; }

    let cum = 0;
    let until = futureDates.length; // не закончится в окне
    for (let i = 0; i < futureDates.length; i++) {
      const d = futureDates[i];
      const need = dailyMat[d]?.get(mid) ?? 0;
      cum += need;
      if (cum >= stock - 1e-9) { until = i; break; }
    }
    res.set(mid, until === futureDates.length ? 999 : until);
  }

  return res;
}, [dailyMat, chronoAsc, today, zoneId, stockQty]);

/* ---- дни покрытия по ПФ ---- */
const coverDaysBySemiId = React.useMemo(() => {
  const res = new Map<string, number>();
  if (!zoneId) return res;

  const futureDates = chronoAsc.filter(d => d >= today);

  const allSemiIds = new Set<string>();
  futureDates.forEach(d => dailySemi[d]?.forEach((_, sid) => allSemiIds.add(sid)));

  for (const sid of allSemiIds) {
    const stock = stockQty(sid);
    if (stock <= 0) { res.set(sid, 0); continue; }

    let cum = 0;
    let until = futureDates.length;
    for (let i = 0; i < futureDates.length; i++) {
      const d = futureDates[i];
      const need = dailySemi[d]?.get(sid) ?? 0;
      cum += need;
      if (cum >= stock - 1e-9) { until = i; break; }
    }
    res.set(sid, until === futureDates.length ? 999 : until);
  }

  return res;
}, [dailySemi, chronoAsc, today, zoneId, stockQty]);


  /* ---- CRUD ---- */
  const [modalOpen, setModalOpen] = React.useState(false);
  const [form, setForm] = React.useState<BaseItem | null>(null);

  const openCreate = () => {
    setForm({
      id: uid(),
      status: "active",
      code: "",
      name: "",
      uom: uoms[0] || "шт",
      group: "",
      vendorId: "",
      price: undefined,
      minLot: 1,
      leadDays: 0,
    });
    setModalOpen(true);
  };

  const openEdit = (it: BaseItem) => {
    setForm({ ...it });
    setModalOpen(true);
  };

const saveForm = async (
  m: BaseItem,
  opts?: { attachSpecId?: string; detachSpecId?: string }
) => {
  const currentKind = kind === "material" ? "material" : "semi";

  const payload: any = {
      kind: currentKind,
      code: m.code,
      name: m.name,
      uom: m.uom || "шт",
      category: m.group?.trim() || "Без категории",
      group_name: m.group || "",
      vendor_name:
        vendors.find((v) => v.id === m.vendorId)?.name ?? m.vendorName ?? null,
      price: m.price ?? null,
      min_lot: m.minLot ?? 1,
      lead_days: m.leadDays ?? 0,
      status: m.status ?? "active",
      legacy_id: isUuid(m.id) ? null : m.id,      // 👈 ВАЖНО: кладём старый id в legacy_id
    };

  let error: any = null;
  if (isUuid(m.id)) {
    const res = await supabase.from("items").update(payload).eq("id", m.id);
    error = res.error;
  } else {
    const res = await supabase.from("items").upsert(payload, {
      onConflict: "legacy_id",
    });
    error = res.error;
  }

  if (error) {
    console.error("Ошибка upsert items:", error);
    alert("Не удалось сохранить запись в базе, смотри консоль");
    return;
  }

  if (currentKind === "semi" && opts?.attachSpecId) {
    await linkSpecToSemi(opts.attachSpecId, m);
  } else if (currentKind === "semi" && opts?.detachSpecId) {
    await unlinkSpecFromSemi(opts.detachSpecId);
  }

  // после сохранения — перезагружаем список из Supabase (на тот же маппинг, что и в useEffect)
  const { data, error: loadError } = await supabase
    .from("items")
    .select("*")
    .eq("kind", currentKind)
    .order("name", { ascending: true });

  if (loadError) {
    console.error("Ошибка перезагрузки items:", loadError);
  } else {
    const mapped: BaseItem[] = (data || []).map(mapItemRow);


    if (currentKind === "material") {
      setMaterialsAll(mapped as Material[]);
    } else {
      setSemisAll(mapped as Semi[]);
    }
  }

  setModalOpen(false);
};


  const deleteOne = async (it: BaseItem) => {
    const ok = window.confirm(`Удалить «${it.code} — ${it.name}»?`);
    if (!ok) return;

    const { error } = await supabase
      .from("items")
      .delete()
      .eq("id", it.id);

    if (error) {
      console.error("Ошибка удаления items:", error);
      alert("Не удалось удалить запись из базы, смотри консоль");
      return;
    }

    const currentKind = kind === "material" ? "material" : "semi";

    const { data, error: loadError } = await supabase
      .from("items")
      .select("*")
      .eq("kind", currentKind)
      .order("name", { ascending: true });

    if (loadError) {
      console.error("Ошибка перезагрузки items после delete:", loadError);
      return;
    }

    const mapped: BaseItem[] = (data || []).map(mapItemRow);

    if (currentKind === "material") {
      setMaterialsAll(mapped as Material[]);
    } else {
      setSemisAll(mapped as Semi[]);
    }
  };


 

  const [specModalOpen, setSpecModalOpen] = React.useState(false);
  const [specEditing, setSpecEditing] = React.useState<Spec | null>(null);

  const openSpecFor = (s: Semi) => {
    const existing = findSpecForSemi(s);
    const base: Spec =
      existing ??
      ({
        id: uid(),
        productId: s.id,
        productCode: s.code,
        productName: s.name,
        lines: [],
        updatedAt: new Date().toISOString(),
      } as Spec);
    setSpecEditing(base);
    setSpecModalOpen(true);
  };

  /* ========= UI ========= */
  const title = kind === "material" ? "Материалы" : "Полуфабрикаты";

  return (
    <div className="mrp-page">
      <div className="mrp-page-head">
        <div className="mrp-title-row">
          <h1 className="mrp-title">{title}</h1>
          <span className="mrp-count">{items.length}</span>
        </div>
        <div className="mrp-actions">
          <button type="button" className="mrp-btn mrp-btn--primary" onClick={openCreate}>
            <Plus className="w-4 h-4" /> Добавить
          </button>
        </div>
      </div>

      <div className="mrp-card">
        <div className="mrp-toolbar">
          <div className="mrp-toolbar__left">
            <button
              type="button"
              className={`mrp-chip ${kind === "material" ? "is-active" : ""}`}
              onClick={() => setKind("material")}
            >
              Материалы
            </button>
            <button
              type="button"
              className={`mrp-chip ${kind === "semi" ? "is-active" : ""}`}
              onClick={() => setKind("semi")}
            >
              Полуфабрикаты
            </button>
            <div className="mrp-search-input">
              <Search className="w-4 h-4" />
              <input
                placeholder={`${title}: код / наименование / группа / поставщик`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>

          <div className="mrp-toolbar__right">
            <div className="mrp-field">
              <span className="mrp-field__label">Склад</span>
              <select
                className="mrp-select"
                value={physId}
                onChange={(e) => setPhysId(e.target.value)}
              >
                {physical.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="mrp-btn mrp-btn--ghost"
              disabled={stagedCount === 0}
              onClick={postAll}
              title={
                stagedCount === 0
                  ? "Нет строк с приходом"
                  : `Провести ${stagedCount}`
              }
            >
              Провести все ({stagedCount})
            </button>
          </div>
        </div>

        {/* Таблица */}
        <div className="mrp-hscroll">
          <table className="mrp-table text-sm">
            <thead>
              <tr>
                <th
                  className="text-left px-2 py-2 w-[170px] wbwh-sortable"
                  onClick={() => handleSort("code")}
                >
                  Код{sortArrows("code")}
                </th>
                <th
                  className="text-left px-2 py-2 wbwh-sortable"
                  onClick={() => handleSort("name")}
                >
                  {title}{sortArrows("name")}
                </th>
                <th
                  className="text-left px-2 py-2 w-[160px] wbwh-sortable"
                  onClick={() => handleSort("vendor")}
                >
                  Поставщик{sortArrows("vendor")}
                </th>
                <th
                  className="text-left px-2 py-2 w-[120px] wbwh-sortable"
                  onClick={() => handleSort("group")}
                >
                  Группа{sortArrows("group")}
                </th>
                <th className="text-left px-2 py-2 w-[60px]">Ед.</th>
                <th className="text-right px-2 py-2 w-[110px]">Остаток</th>
                <th className="text-left px-2 py-2 w-[130px]">Дата</th>
                <th className="text-right px-2 py-2 w-[120px]">Приход</th>
                <th className="text-left px-2 py-2 w-[180px]">Поставщик (ввод)</th>
                <th className="text-left px-2 py-2 w-[200px]">Действия</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const stock = zoneId ? stockQty(it.id!) : 0;
                const e =
                  edits[it.id!] ?? {
                    dateISO: todayISO(),
                    qty: "",
                    supplierName: "",
                  };
                const vendorTitle =
                  vendors.find((v) => v.id === it.vendorId)?.name ??
                  it.vendorName ??
                  "";
                const isSemiRow = kind === "semi";
                const spec = isSemiRow ? findSpecForSemi(it as Semi) : undefined;

                return (
                  <tr
                    key={it.id}
                    className="border-t border-slate-200 hover:bg-slate-50"
                  >
                    <td className="px-2 py-2">
                      <span className="mrp-code">{it.code}</span>
                    </td>
                    <td className="px-2 py-2">{it.name}</td>
                    <td className="px-2 py-2">{vendorTitle}</td>
                    <td className="px-2 py-2">{it.group || ""}</td>
                    <td className="px-2 py-2">{it.uom || ""}</td>
                  {(() => {
                  // выбираем карту покрытия по типу
                  const rawDaysCover =
                    (kind === "material"
                      ? coverDaysByMatId.get(it.id!)
                      : coverDaysBySemiId.get(it.id!)
                    ) ?? 999;
                  const leadDays = Number(it.leadDays ?? 0);
                  const adjDaysCover =
                    rawDaysCover >= 999 ? 999 : rawDaysCover - leadDays;

                  const lo = 3, hi = 10;
                  const t = Math.max(0, Math.min(1, (adjDaysCover - lo) / (hi - lo))); // 0..1
                  const hue = Math.round(0 + t * 120);   // 0=красный → 120=зелёный
                  const bg  = `hsl(${hue} 90% 95% / 1)`;
                  const br  = `hsl(${hue} 85% 55% / 1)`;
                  const title = `Покрытие: ${
                    rawDaysCover >= 999 ? "∞" : rawDaysCover
                  } дн., срок поставки ${leadDays || 0} дн.`;

                  return (
                    <td
                      className="px-2 py-2 text-right tabular-nums"
                      title={title}
                      style={{ background: bg, borderLeft: `4px solid ${br}` }}
                    >
                      {stock}
                    </td>
                  );
                })()}


                    <td className="px-2 py-2">
                      <input
                        type="date"
                        className="form-control"
                        value={e.dateISO}
                        onChange={(ev) =>
                          setEdit(it.id!, { dateISO: ev.target.value })
                        }
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        type="text"
                        inputMode="decimal"
                        className="form-control num-compact text-right"
                        placeholder="0"
                        value={e.qty}
                        onChange={(ev) =>
                          setEdit(it.id!, { qty: ev.target.value })
                        }
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter") postOne(it);
                        }}
                      />
                    </td>
                    <td className="px-2 py-2">
                      <input
                        type="text"
                        className="form-control"
                        placeholder="(необязательно)"
                        value={e.supplierName || ""}
                        onChange={(ev) =>
                          setEdit(it.id!, { supplierName: ev.target.value })
                        }
                      />
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center justify-end gap-3">
                        <button
                          className="act act--ghost"
                          data-action="post"
                          title="Провести приход"
                          onClick={() => postOne(it)}
                        >
                          <Check className="w-4 h-4" />
                        </button>
                        <button
                          className="act act--ghost"
                          data-action="edit"
                          title="Редактировать"
                          onClick={() => openEdit(it)}
                        >
                          <Pencil className="w-4 h-4" />
                        </button>

                        {isSemiRow && (
                          <button
                            className="act act--ghost"
                            data-action="spec"
                            title={
                              spec
                                ? `Редактировать спецификацию (${spec.lines.length} поз.)`
                                : "Создать спецификацию"
                            }
                            onClick={() => openSpecFor(it as Semi)}
                          >
                            <FlaskConical className="w-4 h-4" />
                          </button>
                        )}

                        <button
                          className="act act--ghost"
                          data-action="delete"
                          title="Удалить"
                          onClick={() => deleteOne(it)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}

              {items.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-6 text-center text-slate-400">
                    Нет записей
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-2 text-slate-500 text-xs">
          Раздел переключается между <b>Материалами</b> и <b>Полуфабрикатами</b>.
          Приход влияет на остатки выбранного типа и соответствующей зоны
          хранения.
        </div>
      </div>

      {/* ==== Модалка карточки ==== */}
      {modalOpen && form && (
        <div className="modal-shell" role="dialog" aria-modal="true">
          <div className="modal-backdrop" onClick={() => setModalOpen(false)} />
          <div className="modal-window" style={{ width: 720 }}>
            <div className="modal-header">
              <div className="modal-title">
                {list.some((x) => x.id === form.id) ? "Редактирование" : "Создание"} —{" "}
                {title}
              </div>
              <button
                className="act act--ghost"
                onClick={() => setModalOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="modal-body-viewport">
              <div className="modal-body-content">
                <MaterialForm
                  initial={form}
                  onCancel={() => setModalOpen(false)}
                  onSave={saveForm}
                  dicts={{ vendors, addVendor, uoms, groups, addGroup }}
                  ensureUniqueCode={ensureUniqueCode}
                  isSemi={kind === "semi"}
                  specs={kind === "semi" ? specs : undefined}
                  initialSpecId={
                    kind === "semi" && form
                      ? findSpecForSemi(form as Semi)?.id
                      : undefined
                  }
                  onRequestOpenSpec={
                    kind === "semi"
                      ? (draft) => {
                          // сохраняем карточку и открываем спецификацию
                          saveForm(draft);
                          openSpecFor(draft as Semi);
                        }
                      : undefined
                  }
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==== Модалка спецификации (единый компонент) ==== */}
      {specModalOpen && specEditing && (
        <SpecModal
          open
          onClose={() => {
            setSpecModalOpen(false);
            setSpecEditing(null);
          }}
          onSaved={() => reloadSpecs()}
          spec={specEditing}
        />
      )}
    </div>
  );
}
