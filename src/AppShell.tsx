// file: src/AppShell.tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import PlanGridView from "./views/PlanGridView";
import MaterialsView from "./views/MaterialsView";
import { MarketplacesView } from "./views/MarketplacesView";
import { WbWarehousesView } from "./views/WbWarehousesView";
import SettingsMarketplaceWarehouses from "./views/SettingsMarketplaceWarehouses";
import { supabase } from "./api/supabaseClient";
import SpecModal from "./components/specs/SpecModal";
import { fetchSpecsFromSupabase } from "./utils/specSupabase";
import { generateUuid } from "./utils/supabaseItems";
import {
  fetchReceiptsSupabase,
  fetchReceiptLinesSupabase,
  ReceiptLine,
  ReceiptRow,
  rollbackReceiptSupabase,
} from "./utils/receiptsSupabase";
import {
  useSupabaseCategories,
  useSupabaseGroups,
  useSupabaseUoms,
  useSupabaseVendors,
  useSupabaseWarehouses,
  WarehouseRecord,
} from "./hooks/useSupabaseDicts";

// file: src/AppShell.tsx (вверху с остальными импортами)







import SettingsIntegrations from "./SettingsIntegrations";

import {
  Menu as MenuIcon, Factory, BarChart3, ShoppingCart, Boxes, PieChart, Settings,
  Search, Edit3, Plus, Pencil, Trash2, FlaskConical, Check, RotateCcw
} from "lucide-react";



/* ------------ Types ------------ */
export type Sub = { key: string; title: string; route: string; icon?: string };
export type Section = { key: string; title: string; icon: string; subs: Sub[] };

type Profile = {
  id: string;
  email: string | null;
  phone: string | null;
  is_active: boolean;
};

type Product = {
  id?: string;
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

/* === Vendors & Materials === */
type Vendor = { id: string; name: string };
type Material = {
  id: string;
  code: string;
  name: string;
  vendorId: string;
  uom: string;
  moq: number;
  leadTimeDays: number;
  price?: number;
  currency?: string;
  group: string;
};

/* === Spec model === (поддерживаем совместимость с item) */
type SpecLine = {
  id: string;
  kind?: "mat" | "semi";
  materialId?: string;
  item?: string;
  refId?: string;
  qty: number;
  uom: string;
};
type Spec = {
  id: string;
  productId?: string | null;
  productCode: string;
  productName: string;
  lines: SpecLine[];
  note?: string;
  updatedAt: string; // ISO
};

/* === Warehouses / Stock / Docs ========================== */
type Warehouse = {
  id: string;
  name: string;                   // "Логиново" или "Материалы"
  type: "physical" | "virtual";
  parentId?: string | null;       // для virtual — id физ. склада
  isActive: boolean;
};

type StockBalance = {
  id: string;
  itemType: "material" | "product";
  itemId: string;
  warehouseId: string;            // virtual warehouse id
  qty: number;                    // >= 0
  updatedAt: string;              // ISO
};

type LedgerEntry = {
  itemType: "material" | "product";
  itemId: string;
  warehouseId: string;
  delta: number;                  // + приход, - списание
};

/* ——— Документы ——— */
type ProdReport = {
  id: string;
  number: string;
  date: string;                   // ISO
  status: "draft" | "posted";
  productId: string;
  qty: number;
  physWarehouseId: string;
  fgZoneId: string;               // зона ГП
  matZoneId: string;              // зона Материалы (для backflush)
  ledger?: LedgerEntry[];         // проводки при проведении
};


/* === MFG Plan (план партии) ============================= */



/* ====== Unified action icon button ====== */
// Removed unused ActionIcon component to fix compile error.


function useStockBalances() {
  return useLocalState<StockBalance[]>("mrp.stock.balances.v1", []);
}
/* === StockRepo: проводки/остатки ======================== */
function useStockRepo() {
  const [balances, setBalances] = useStockBalances();

  const getQty = (itemType: "material" | "product", itemId: string, warehouseId: string) => {
    return balances.find(b => b.itemType === itemType && b.itemId === itemId && b.warehouseId === warehouseId)?.qty ?? 0;
  };

  const applyLedger = (entries: LedgerEntry[]) => {
    setBalances(prev => {
      const map = new Map(prev.map(b => [`${b.itemType}:${b.itemId}:${b.warehouseId}`, b]));
      for (const e of entries) {
        const key = `${e.itemType}:${e.itemId}:${e.warehouseId}`;
        const cur = map.get(key) ?? { id: uid(), itemType: e.itemType, itemId: e.itemId, warehouseId: e.warehouseId, qty: 0, updatedAt: new Date().toISOString() } as StockBalance;
        const next = cur.qty + e.delta;
        if (next < 0) throw new Error(`Недостаточно остатка для ${key}: ${cur.qty} + (${e.delta})`);
        cur.qty = next;
        cur.updatedAt = new Date().toISOString();
        map.set(key, cur);
      }
      return Array.from(map.values());
    });
  };

  const revertLedger = (entries: LedgerEntry[]) => applyLedger(entries.map(e => ({ ...e, delta: -e.delta })));

  return { balances, applyLedger, revertLedger, getQty };
}

/* ------------ NAV ------------ */
const DEFAULT_NAV: Section[] = [
  {
    key: "mfg", title: "Производство", icon: "Factory",
    subs: [
      { key: "plan", title: "План партии", route: "/app/mfg/plan" },
      { key: "prodReports", title: "Отчёты о производстве", route: "/app/mfg/prod-reports" }, // NEW
      { key: "specs", title: "Спецификации", route: "/app/mfg/specs" },
      { key: "writeoff", title: "Списания", route: "/app/mfg/writeoff" },
    ],
  },
  {
    key: "sales", title: "Продажи", icon: "BarChart3",
    subs: [
      { key: "forecast", title: "Прогноз", route: "/app/sales/forecast" },
      { key: "prices", title: "Цены/Прайсы", route: "/app/sales/prices" },
      { key: "mp", title: "Маркетплейсы", route: "/app/sales/mp" },
      { key: "wbwh", title: "Склады WB", route: "/app/sales/wb-warehouses" },
    ],
  },
  {
  key: "purchase", title: "Закупки", icon: "ShoppingCart",
  subs: [
    { key: "products",  title: "Товары",        route: "/app/purchase/products" },
    { key: "materials", title: "Материалы",     route: "/app/purchase/materials" },
    { key: "semis",     title: "Полуфабрикаты", route: "/app/purchase/semis" }, // ← добавить
    { key: "specs",     title: "Спецификации",  route: "/app/purchase/specs" },
    { key: "vendors",   title: "Поставщики",    route: "/app/purchase/vendors" },
    { key: "po",        title: "Заказы поставщикам", route: "/app/purchase/po" },
    { key: "receipts",  title: "Поступления",   route: "/app/purchase/receipts" },
  ],
},
  {
    key: "stock", title: "Склад", icon: "Boxes",
    subs: [
      { key: "balances", title: "Остатки", route: "/app/stock/balances" },
      { key: "moves", title: "Перемещения", route: "/app/stock/moves" },
      { key: "count", title: "Инвентаризация", route: "/app/stock/count" },
    ],
  },
  {
    key: "reports", title: "Отчёты", icon: "PieChart",
    subs: [
      { key: "dashboard", title: "Дашборд", route: "/app/reports/dashboard" },
      { key: "kpi", title: "KPI", route: "/app/reports/kpi" },
    ],
  },
  {
    key: "settings", title: "Настройки", icon: "Settings",
    subs: [
      { key: "uom", title: "Единицы", route: "/app/settings/uom" },
      { key: "curr", title: "Валюты", route: "/app/settings/curr" },
      { key: "cats", title: "Категории", route: "/app/settings/cats" },
      { key: "groups", title: "Группы", route: "/app/settings/groups" },
      { key: "wh", title: "Склады", route: "/app/settings/wh" },
      { key: "mpwh", title: "МП склады", route: "/app/settings/mpwh" },
      { key: "users", title: "Пользователи/Роли", route: "/app/settings/users" },
      { key: "integr", title: "Интеграции", route: "/app/settings/integr" },
      { key: "nums", title: "Нумераторы", route: "/app/settings/nums" },
    ],
  },
];


/* ------------ Helpers ------------ */
const IconFor = ({ name, className = "w-5 h-5" }: { name?: string; className?: string }) => {
  switch (name) {
    case "Factory":       return <Factory className={className} />;
    case "BarChart3":     return <BarChart3 className={className} />;
    case "ShoppingCart":  return <ShoppingCart className={className} />;
    case "Boxes":         return <Boxes className={className} />;
    case "PieChart":      return <PieChart className={className} />;
    case "Settings":      return <Settings className={className} />;
    default:              return <Boxes className={className} />;
  }
};

const useLocalState = <T,>(key: string, initial: T) => {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch { return initial; }
  });
  useEffect(() => { localStorage.setItem(key, JSON.stringify(state)); }, [key, state]);
  return [state, setState] as const;
};

const uid = () => Math.random().toString(36).slice(2, 9);
const genCode = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;


/* ---------- Modal (c горизонтальным скроллом) ---------- */
type ModalProps = {
  onClose: () => void;
  title?: string;
  icon?: React.ReactNode;
  width?: number | string;
  z?: number;                   // оффсет относительно базового слоя
  children: React.ReactNode;
};

function Modal({ onClose, title, icon, width, z = 0, children }: ModalProps) {
  // ...
  const baseZ = 10000;          // соответствует .modal-shell { z-index: 10000 } в index.css

  const styleWin: React.CSSProperties = {
    zIndex: baseZ + z + 1,
    maxWidth: "96vw",
    width: typeof width === "number" ? `${width}px` : (width ?? "auto"),
  };

  return (
    <div className="modal-shell" style={{ zIndex: baseZ + z }}>
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-window" style={styleWin}>
        {(title || icon) && (
          <div className="modal-header">
            <div className="modal-title">
              {icon && <span className="modal-icon">{icon}</span>}
              {title}
            </div>
            <button className="act act--ghost" onClick={onClose}>✕</button>
          </div>
        )}

        {/* Вьюпорт с ОТКЛАДКОЙ по обеим осям.
            Если контент шире окна — появляется горизонтальный скролл */}
        <div className="modal-body-viewport">
          {/* Контент имеет "естественную" ширину.
              Если она >100% окна — скроллится горизонтально */}
          <div className="modal-body-content">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}





function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <div className="text-xs text-slate-500 mb-1">
      {children}{required && <span className="ml-1 text-rose-500">*</span>}
    </div>
  );
}

/* ===================== MATERIAL FORM ===================== */
function MaterialForm({
  initial,
  onSave,
  onCancel,
  dicts,
  ensureUniqueCode,
}: {
  initial: Material | null;
  onSave: (m: Material) => void;
  onCancel: () => void;
  dicts: {
    vendors: Vendor[];
    addVendor: (name: string) => Promise<Vendor | null>;
    uoms: string[];
    groups: string[];
    addGroup: (name: string) => Promise<void>;
  };
  ensureUniqueCode: (code: string, selfId?: string) => boolean;
}) {
  // ---------- state ----------
  const [form, setForm] = React.useState<Material>(() => {
    if (initial) {
      return { ...initial, group: (initial as any).group ?? "" };
    }
    const code = genCode("MAT");
    return {
      id: uid(),
      code,
      name: "",
      vendorId: "",
      uom: dicts.uoms[0] || "шт",
      moq: 1,
      leadTimeDays: 0,
      price: undefined,
      currency: "RUB",
      group: "",
    };
  });

  // ---------- refs ----------
  const codeRef   = useRef<HTMLInputElement>(null);
  const nameRef   = useRef<HTMLInputElement>(null);
  const vendorRef = useRef<HTMLSelectElement>(null);
  const uomRef    = useRef<HTMLSelectElement>(null);
  const catRef    = useRef<HTMLSelectElement>(null);

  useEffect(() => { codeRef.current?.focus(); }, []);

  // ---------- helpers ----------
  const set = <K extends keyof Material>(k: K, v: Material[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const normNum = (raw: string, def = 0) => {
    const s = (raw ?? "").replace(",", ".").trim();
    if (s === "") return def;
    const n = Number(s);
    return Number.isFinite(n) ? n : def;
  };

  // ---------- validation ----------
  type Errs = Partial<Record<"code"|"name"|"vendorId"|"uom"|"group", string>>;
  const [showErrors, setShowErrors] = useState(false);

  const computeErrors = (draft: Material): Errs => {
    const e: Errs = {};
    if (!draft.code?.trim()) e.code = "Обязательное поле";
    if (!draft.name?.trim()) e.name = "Обязательное поле";
    if (!draft.vendorId?.trim()) e.vendorId = "Выберите поставщика";
    if (!draft.uom?.trim()) e.uom = "Выберите единицу";
    if (!draft.group?.trim()) e.group = "Выберите группу";
    if (draft.code?.trim()) {
      const ok = ensureUniqueCode(draft.code.trim(), draft.id);
      if (!ok) e.code = "Код уже используется";
    }
    return e;
  };

  const errors = useMemo(() => computeErrors(form), [form]);
  const err = (k: keyof Errs) => errors[k];

  // ---------- actions ----------
  const addVendor = async () => {
    const nm = (window.prompt("Новый поставщик") ?? "").trim();
    if (!nm) return;
    const v = await dicts.addVendor(nm);
    if (v) {
      set("vendorId", v.id);
      setTimeout(() => vendorRef.current?.focus(), 0);
    }
  };

  const addGroup = async () => {
    const nm = (window.prompt("Новая группа") ?? "").trim();
    if (!nm) return;
    await dicts.addGroup(nm);
    set("group", nm);
    setTimeout(() => catRef.current?.focus(), 0);
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const eMap = computeErrors(form);
    if (Object.keys(eMap).length) {
      setShowErrors(true);
      // фокус на первое ошибочное поле
      if (eMap.code)      { codeRef.current?.focus(); return; }
      if (eMap.name)      { nameRef.current?.focus(); return; }
      if (eMap.vendorId)  { vendorRef.current?.focus(); return; }
      if (eMap.uom)       { uomRef.current?.focus(); return; }
      if (eMap.group)     { catRef.current?.focus(); return; }
      return;
    }

    const cleaned: Material = {
      ...form,
      code: form.code.trim(),
      name: form.name.trim(),
      moq: Math.max(1, Number(form.moq || 1)),
      leadTimeDays: Math.max(0, Number(form.leadTimeDays || 0)),
      price: form.price == null || form.price === (NaN as any)
        ? undefined
        : Number(form.price),
      currency: form.currency?.trim() || "RUB",
      group: form.group?.trim() || "",
    };

    onSave(cleaned);
  };

  // ---------- UI ----------
  return (
    <form onSubmit={onSubmit}>
      {/* предупреждение по валидации */}
      {!isEmpty(errors) && showErrors && (
        <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 text-[13px] px-3 py-2">
          Заполните обязательные поля ниже.
        </div>
      )}

      {/* сетка 2 колонки как на референсе */}
      <div className="form-grid-2">
        {/* Код */}
        <div>
          <Label required>Код</Label>
          <input
            ref={codeRef}
            maxLength={20}
            className="w-full px-3 py-2 rounded-xl border text-sm"
            data-invalid={!!err("code")}
            value={form.code}
            onChange={(e) => set("code", e.target.value)}
          />
          {showErrors && err("code") && (
            <div className="text-[11px] text-rose-500 mt-1">{err("code")}</div>
          )}
        </div>

        {/* Ед. изм. */}
        <div>
          <Label required>Ед. изм.</Label>
          <select
            ref={uomRef}
            className="w-full mrp-select"
            data-invalid={!!err("uom")}
            value={form.uom}
            onChange={(e) => set("uom", e.target.value)}
          >
            {dicts.uoms.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
          {showErrors && err("uom") && (
            <div className="text-[11px] text-rose-500 mt-1">{err("uom")}</div>
          )}
        </div>

        {/* Наименование — на 2 колонки */}
        <div className="form-span-2">
          <Label required>Наименование</Label>
          <input
            ref={nameRef}
            className="w-full px-3 py-2 rounded-xl border text-sm"
            data-invalid={!!err("name")}
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
          />
          {showErrors && err("name") && (
            <div className="text-[11px] text-rose-500 mt-1">{err("name")}</div>
          )}
        </div>

        {/* Поставщик */}
        <div>
          <Label required>Поставщик</Label>
          <div className="flex items-center gap-2">
            <select
              ref={vendorRef}
              className="w-full mrp-select"
              data-invalid={!!err("vendorId")}
              value={form.vendorId}
              onChange={(e) => set("vendorId", e.target.value)}
            >
              <option value=""></option>
              {dicts.vendors.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
            <button
              type="button"
              className="mrp-icon-btn"
              title="Добавить поставщика"
              onClick={addVendor}
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
          {showErrors && err("vendorId") && (
            <div className="text-[11px] text-rose-500 mt-1">{err("vendorId")}</div>
          )}
        </div>

        {/* Группа */}
        <div>
          <Label required>Группа</Label>
          <div className="flex items-center gap-2">
            <select
              ref={catRef}
              className="w-full mrp-select"
              data-invalid={!!err("group")}
              value={form.group ?? ""}
              onChange={(e) => set("group", e.target.value)}
            >
              <option value=""></option>
              {dicts.groups.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
            <button
              type="button"
              className="mrp-icon-btn"
              title="Добавить группу"
              onClick={addGroup}
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
          {showErrors && err("group") && (
            <div className="text-[11px] text-rose-500 mt-1">{err("group")}</div>
          )}
        </div>

        {/* Мин. партия */}
        <div>
          <Label>Мин. партия</Label>
          <input
            type="number"
            min={1}
            step={1}
            className="w-full px-3 py-2 rounded-xl border text-sm"
            value={form.moq ?? ""}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") { set("moq", undefined as any); return; }
              set("moq", Math.max(1, normNum(raw, 1)));
            }}
            placeholder="1"
          />
        </div>

        {/* Срок поставки, дней */}
        <div>
          <Label>Срок поставки, дней</Label>
          <input
            type="number"
            min={0}
            step={1}
            className="w-full px-3 py-2 rounded-xl border text-sm"
            value={form.leadTimeDays ?? ""}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") { set("leadTimeDays", undefined as any); return; }
              set("leadTimeDays", Math.max(0, normNum(raw, 0)));
            }}
            placeholder="0"
          />
        </div>

        {/* Цена */}
        <div>
          <Label>Цена (опц.)</Label>
          <div className="relative">
            <input
              type="number"
              min={0}
              step="0.01"
              className="w-full px-3 py-2 rounded-xl border text-sm pr-10"
              value={form.price ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "") { set("price", undefined as any); return; }
                set("price", Math.max(0, normNum(v, 0)));
              }}
              placeholder="0.00"
            />
            <span className="absolute right-3 top-2.5 text-slate-400 select-none">₽</span>
          </div>
        </div>

        {/* Валюта */}
        <div>
          <Label>Валюта</Label>
          <select
            className="w-full mrp-select"
            value={form.currency || "RUB"}
            onChange={(e) => set("currency", e.target.value)}
          >
            {["RUB","USD","EUR"].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>

      {/* footer кнопки формы */}
      <div className="mt-3 flex items-center justify-end gap-2">
        <button type="button" className="app-pill app-pill--md" onClick={onCancel}>Отмена</button>
        <button type="submit" className="app-pill app-pill--md is-active">Сохранить</button>
      </div>
    </form>
  );
}

/* === утилиты для этого файла (у тебя уже есть uid/genCode/isEmpty — оставь свои) === */
function isEmpty(o: Record<string, unknown>) { return Object.keys(o).length === 0; }
const isUuid = (s?: string | null) =>
  !!s &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s
  );
// function uid() { return Math.random().toString(36).slice(2, 9); } // Duplicate, removed



/* ===================== PRODUCT FORM (с кнопкой "Спецификация…") ===================== */
/* ---------- ProductForm (use .code) ---------- */
type ProductFormProps = {
  initial: Product | null;
  onSave: (p: Product) => void;
  onCancel: () => void;
  dicts: {
    statuses: string[];
    categories: string[];
    uoms: string[];
    addCategory: (name: string) => Promise<void>;
    addUom: (name: string) => Promise<void>;
  };
  ensureUniqueCode: (code: string, selfId?: string) => boolean;
  openSpecFor: (p: { id?: string; code: string; name: string }) => void;
};

function ProductForm({
  initial,
  onSave,
  onCancel,
  dicts,
  ensureUniqueCode,
  openSpecFor,
}: ProductFormProps) {
  const [m, setM] = React.useState<Product>(() =>
    initial ?? {
      id: "",
      status: "draft",
      code: "",
      name: "",
      category: "",
      uom: dicts.uoms[0] ?? "шт",
      price: 0,
    }
  );

  const parseNumber = (value: string): number | undefined => {
    const v = value.replace(",", ".").trim();
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const code = m.code.trim();
    if (!code) {
      alert("Заполни артикул (code)");
      return;
    }
    if (!ensureUniqueCode(code, m.id || undefined)) {
      alert("Артикул (code) уже используется");
      return;
    }
    onSave({ ...m, code });
  };

  return (
    <form onSubmit={save} className="form-grid-2">
      <div>
        <label>Статус</label>
        <select
          className="w-full mrp-select"
          value={m.status}
          onChange={(e) => setM({ ...m, status: e.target.value as any })}
        >
          {dicts.statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label>Артикул (code)</label>
        <input
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm"
          value={m.code}
          onChange={(e) => setM({ ...m, code: e.target.value })}
          placeholder="например PRD-1001"
        />
      </div>

      <div>
        <label>Наименование</label>
        <div className="flex gap-2">
          <input
            className="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-sm"
            value={m.name}
            onChange={(e) => setM({ ...m, name: e.target.value })}
          />
          <button
            type="button"
            className="app-pill app-pill--sm"
            onClick={() =>
              openSpecFor({ id: m.id || undefined, code: m.code, name: m.name })
            }
          >
            Спецификация…
          </button>
        </div>
      </div>

      <div>
        <label>Категория</label>
        <div className="flex gap-2">
          <select
            className="flex-1 mrp-select"
            value={m.category}
            onChange={(e) => setM({ ...m, category: e.target.value })}
          >
            <option value=""></option>
            {dicts.categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="app-pill app-pill--sm"
            onClick={async () => {
              const name = prompt("Новая категория");
              if (name) await dicts.addCategory(name);
            }}
          >
            +
          </button>
        </div>
      </div>

      <div>
        <label>Ед. изм.</label>
        <div className="flex gap-2">
          <select
            className="flex-1 mrp-select"
            value={m.uom}
            onChange={(e) => setM({ ...m, uom: e.target.value })}
          >
            {dicts.uoms.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="app-pill app-pill--sm"
            onClick={async () => {
              const u = prompt("Новая единица");
              if (u) await dicts.addUom(u);
            }}
          >
            +
          </button>
        </div>
      </div>

      <div>
        <label>Цена</label>
        <input
          type="number"
          step="0.01"
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm"
          value={m.price ?? ""}
          onChange={(e) => {
            const raw = e.target.value;
            setM({ ...m, price: raw === "" ? undefined : Number(raw) });
          }}
          placeholder="0.00"
        />
      </div>

      <div className="col-span-2 mt-4">
        <div className="text-sm font-semibold text-slate-600">Маркетплейсы</div>
      </div>

      <div>
        <label>SKU WB</label>
        <input
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm"
          value={m.wbSku ?? ""}
          onChange={(e) => setM({ ...m, wbSku: e.target.value || undefined })}
          placeholder="Например, WB123456"
        />
      </div>

      <div>
        <label>SKU Ozon</label>
        <input
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm"
          value={m.ozonSku ?? ""}
          onChange={(e) => setM({ ...m, ozonSku: e.target.value || undefined })}
        />
      </div>

      <div>
        <label>Штрихкод / EAN</label>
        <input
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm"
          value={m.barcode ?? ""}
          onChange={(e) => setM({ ...m, barcode: e.target.value || undefined })}
          placeholder="460…"
        />
      </div>

      <div>
        <label>Категория WB</label>
        <input
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm"
          value={m.mpCategoryWb ?? ""}
          onChange={(e) =>
            setM({ ...m, mpCategoryWb: e.target.value || undefined })
          }
          placeholder="Из классификатора WB"
        />
      </div>

      <div>
        <label>Категория Ozon</label>
        <input
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm"
          value={m.mpCategoryOzon ?? ""}
          onChange={(e) =>
            setM({ ...m, mpCategoryOzon: e.target.value || undefined })
          }
        />
      </div>

      <div className="col-span-2 mt-4">
        <div className="text-sm font-semibold text-slate-600">Упаковка</div>
      </div>

      <div>
        <label>Длина коробки, см</label>
        <input
          type="number"
          step="0.1"
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm"
          value={m.boxLength ?? ""}
          onChange={(e) =>
            setM({ ...m, boxLength: parseNumber(e.target.value) })
          }
        />
      </div>

      <div>
        <label>Ширина коробки, см</label>
        <input
          type="number"
          step="0.1"
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm"
          value={m.boxWidth ?? ""}
          onChange={(e) =>
            setM({ ...m, boxWidth: parseNumber(e.target.value) })
          }
        />
      </div>

      <div>
        <label>Высота коробки, см</label>
        <input
          type="number"
          step="0.1"
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm"
          value={m.boxHeight ?? ""}
          onChange={(e) =>
            setM({ ...m, boxHeight: parseNumber(e.target.value) })
          }
        />
      </div>

      <div>
        <label>Вес коробки, кг</label>
        <input
          type="number"
          step="0.01"
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm"
          value={m.boxWeight ?? ""}
          onChange={(e) =>
            setM({ ...m, boxWeight: parseNumber(e.target.value) })
          }
        />
      </div>

      <div>
        <label>Штук в коробке</label>
        <input
          type="number"
          step="1"
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm"
          value={m.unitsPerBox ?? ""}
          onChange={(e) =>
            setM({ ...m, unitsPerBox: parseNumber(e.target.value) })
          }
        />
      </div>

      <div>
        <label>Штук на паллете</label>
        <input
          type="number"
          step="1"
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm"
          value={m.unitsPerPallet ?? ""}
          onChange={(e) =>
            setM({ ...m, unitsPerPallet: parseNumber(e.target.value) })
          }
        />
      </div>

      <div>
        <label>Вес паллеты, кг</label>
        <input
          type="number"
          step="0.1"
          className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm"
          value={m.palletWeight ?? ""}
          onChange={(e) =>
            setM({ ...m, palletWeight: parseNumber(e.target.value) })
          }
        />
      </div>

      <div className="col-span-2 flex justify-end gap-2 mt-2">
        <button type="button" className="app-pill app-pill--md" onClick={onCancel}>
          Отмена
        </button>
        <button type="submit" className="app-pill app-pill--md is-active">
          Сохранить
        </button>
      </div>
    </form>
  );
}


/* ===================== PRODUCTS VIEW ===================== */
function ProductsView() {
  type StockRow = { itemId: string; warehouseId: string; qty: number };
  const [items, setItems] = useLocalState<Product[]>("mrp.products.v1", []);
  const [stockRows, setStockRows] = useState<StockRow[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [stockColumns, setStockColumns] = useLocalState<string[]>("mrp.products.stockCols", []);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [sortState, setSortState] = useState<{
    key: "code" | "name" | "category";
    dir: "asc" | "desc";
  }>({ key: "name", dir: "asc" });

  const { uoms: uomRecords, addUom: addUomRecord } = useSupabaseUoms();
  const { categories: categoryRecords, addCategory: addCategoryRecord } = useSupabaseCategories();
  const { groups: groupRecords, addGroup: addGroupRecord } = useSupabaseGroups();
  const { vendors, addVendor: addVendorRecord } = useSupabaseVendors();
  const uoms = React.useMemo(() => uomRecords.map((u) => u.name), [uomRecords]);
  const categories = React.useMemo(() => categoryRecords.map((c) => c.name), [categoryRecords]);
  const groups = React.useMemo(() => groupRecords.map((g) => g.name), [groupRecords]);
  const [materials, setMaterials] = useLocalState<Material[]>("mrp.materials.v1", []);

  const statuses = ["draft", "active", "archived"];
  const addUom = React.useCallback(async (name: string) => {
    await addUomRecord(name);
  }, [addUomRecord]);
  const addCategory = React.useCallback(async (name: string) => {
    await addCategoryRecord(name);
  }, [addCategoryRecord]);
  const addGroup = React.useCallback(async (name: string) => {
    await addGroupRecord(name);
  }, [addGroupRecord]);
  const addVendor = React.useCallback(
    (name: string) => addVendorRecord(name),
    [addVendorRecord]
  );
  const ensureUniqueProductCode = (code: string, selfId?: string) =>
    !items.some((p) => p.code.trim().toLowerCase() === code.trim().toLowerCase() && p.id !== selfId);

  const ensureUniqueMaterialCode = (code: string, selfId?: string) =>
    !materials.some((m) => m.code.trim().toLowerCase() === code.trim().toLowerCase() && m.id !== selfId);

  /* SPECS */
  const [specs, setSpecs] = useLocalState<Spec[]>("mrp.specs.v1", []);
  const syncSpecs = React.useCallback(async () => {
    try {
      const rows = await fetchSpecsFromSupabase();
      const mapped: Spec[] = rows.map((row) => ({
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
      setSpecs(mapped);
    } catch (err) {
      console.error("ProductsView syncSpecs failed", err);
    }
  }, [setSpecs]);
  useEffect(() => { syncSpecs(); }, [syncSpecs]);
  const findSpecForProduct = (p: { id?: string; code: string }) =>
    specs.find((s) => (p.id && s.productId === p.id) || s.productCode === p.code);

  /* MATERIAL FORM from Spec (async) */
  const [matModalOpen, setMatModalOpen] = useState(false);
  const [matEditing, setMatEditing] = useState<Material | null>(null);
  let resolveMatPromise: ((m: Material | null) => void) | null = null;

  const upsertMaterialFromSpec = (prefillName?: string) => {
    return new Promise<Material | null>((resolve) => {
      resolveMatPromise = resolve;
      setMatEditing({
        id: uid(),
        code: genCode("MAT"),
        name: prefillName ?? "",
        vendorId: vendors[0]?.id ?? "",
        uom: uoms[0] ?? "шт",
        moq: 1,
        leadTimeDays: 0,
        price: undefined,
        currency: "RUB",
        group: "",
      });
      setMatModalOpen(true);
    });
  };

  const saveMaterial = (m: Material) => {
    setMaterials((prev) => {
      const i = prev.findIndex((x) => x.id === m.id);
      if (i >= 0) {
        const copy = [...prev];
        copy[i] = m;
        return copy;
      }
      return [m, ...prev];
    });
    setMatModalOpen(false);
    resolveMatPromise?.(m);
    resolveMatPromise = null;
  };
  const cancelMaterial = () => {
    setMatModalOpen(false);
    resolveMatPromise?.(null);
    resolveMatPromise = null;
  };

  /* PRODUCT form & SPEC modal */
  const [prodModalOpen, setProdModalOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);

  const [specModalOpen, setSpecModalOpen] = useState(false);
  const [specEditing, setSpecEditing] = useState<Spec | null>(null);
  const closeSpecModal = () => {
    setSpecModalOpen(false);
    setSpecEditing(null);
    syncSpecs();
  };

  const loadWarehouses = useCallback(async () => {
    const { data, error } = await supabase
      .from("warehouses")
      .select("id, name, type, parent_id, is_active")
      .order("name", { ascending: true });
    if (error) {
      console.error("ProductsView load warehouses", error);
      return;
    }
    setWarehouses(
      (data || []).map((row: any) => ({
        id: row.id,
        name: row.name,
        type: row.type === "physical" ? "physical" : "virtual",
        parentId: row.parent_id,
        isActive: row.is_active ?? true,
      }))
    );
  }, []);

  const loadStockBalances = useCallback(async () => {
    const { data, error } = await supabase
      .from("stock_balances")
      .select("item_id, warehouse_id, qty");
    if (error) {
      console.error("ProductsView load stock_balances", error);
      return;
    }
    setStockRows(
      (data || []).map((row: any) => ({
        itemId: row.item_id,
        warehouseId: row.warehouse_id,
        qty: Number(row.qty) || 0,
      }))
    );
  }, []);

  const loadProducts = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("items")
        .select(
          "id, status, code, name, category, uom, price, wb_sku, ozon_sku, barcode, mp_category_wb, mp_category_ozon, box_length, box_width, box_height, box_weight, units_per_box, units_per_pallet, pallet_weight"
        )
        .eq("kind", "product")
        .order("name", { ascending: true });
      if (error) throw error;
      const mapped: Product[] = (data || []).map((row: any) => ({
        id: row.id,
        status: row.status ?? "active",
        code: row.code,
        name: row.name,
        category: row.category ?? "",
        uom: row.uom ?? "шт",
        price: row.price ?? undefined,
        wbSku: row.wb_sku ?? undefined,
        ozonSku: row.ozon_sku ?? undefined,
        barcode: row.barcode ?? undefined,
        mpCategoryWb: row.mp_category_wb ?? undefined,
        mpCategoryOzon: row.mp_category_ozon ?? undefined,
        boxLength: row.box_length ?? undefined,
        boxWidth: row.box_width ?? undefined,
        boxHeight: row.box_height ?? undefined,
        boxWeight: row.box_weight ?? undefined,
        unitsPerBox: row.units_per_box ?? undefined,
        unitsPerPallet: row.units_per_pallet ?? undefined,
        palletWeight: row.pallet_weight ?? undefined,
      }));
      setItems(mapped);
    } catch (err) {
      console.error("ProductsView load products", err);
    } finally {
      setLoading(false);
    }
  }, [setItems]);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  useEffect(() => {
    loadWarehouses();
    loadStockBalances();
  }, [loadWarehouses, loadStockBalances]);

  const refreshAll = () => {
    loadProducts();
    loadStockBalances();
  };

  const openCreate = () => {
    setEditing(null);
    setProdModalOpen(true);
  };
  const openEdit = (p: Product) => {
    setEditing(p);
    setProdModalOpen(true);
  };

  const saveProduct = async (p: Product) => {
    const id = p.id && isUuid(p.id) ? p.id : generateUuid();
    const payload = {
      id,
      kind: "product",
      status: p.status ?? "active",
      code: p.code.trim(),
      name: p.name.trim(),
      category: p.category ?? "",
      uom: p.uom ?? "",
      price: p.price ?? null,
      wb_sku: p.wbSku?.trim() || null,
      ozon_sku: p.ozonSku?.trim() || null,
      barcode: p.barcode?.trim() || null,
      mp_category_wb: p.mpCategoryWb?.trim() || null,
      mp_category_ozon: p.mpCategoryOzon?.trim() || null,
      box_length: p.boxLength ?? null,
      box_width: p.boxWidth ?? null,
      box_height: p.boxHeight ?? null,
      box_weight: p.boxWeight ?? null,
      units_per_box: p.unitsPerBox ?? null,
      units_per_pallet: p.unitsPerPallet ?? null,
      pallet_weight: p.palletWeight ?? null,
    };
    const { error } = await supabase.from("items").upsert(payload, { onConflict: "id" });
    if (error) {
      console.error("ProductsView save product", error);
      alert("Не удалось сохранить товар в Supabase, см. консоль.");
      return;
    }
    setProdModalOpen(false);
    await loadProducts();
  };

  const removeProduct = async (id?: string) => {
    if (!id) return;
    const target = items.find((x) => x.id === id);
    const ok = window.confirm(`Удалить товар «${target?.name ?? id}»? (Спецификация останется)`);
    if (!ok) return;
    const { error } = await supabase.from("items").delete().eq("id", id);
    if (error) {
      console.error("ProductsView remove product", error);
      alert("Не удалось удалить товар в Supabase, см. консоль.");
      return;
    }
    await loadProducts();
  };

  const openSpec = (p: { id?: string; code: string; name: string }) => {
    const existing = findSpecForProduct(p);
    const base: Spec =
      existing ??
      ({
        id: uid(),
        productId: p.id ?? null,
        productCode: p.code,
        productName: p.name,
        lines: [],
        updatedAt: new Date().toISOString(),
      } as Spec);
    setSpecEditing(base);
    setSpecModalOpen(true);
  };

  const formatQty = (n: number) => (Number(n || 0)).toLocaleString("ru-RU");

  const filteredItems = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (p) =>
        p.code.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        (p.category || "").toLowerCase().includes(q)
    );
  }, [items, query]);

  const sortedItems = React.useMemo(() => {
    const dir = sortState.dir === "asc" ? 1 : -1;
    const getValue = (p: Product) => {
      if (sortState.key === "code") return p.code || "";
      if (sortState.key === "category") return p.category || "";
      return p.name || "";
    };
    return [...filteredItems].sort((a, b) =>
      getValue(a).localeCompare(getValue(b), "ru", { sensitivity: "base" }) * dir
    );
  }, [filteredItems, sortState]);

  const handleSort = (key: "code" | "name" | "category") => {
    setSortState((prev) => {
      if (prev.key !== key) return { key, dir: "asc" };
      return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  };

  const sortArrows = (key: "code" | "name" | "category") => {
    const isActive = sortState.key === key;
    return (
      <span className={`wbwh-sort ${isActive ? "is-active" : ""}`} aria-hidden="true">
        <span className={`wbwh-sort__arrow ${isActive && sortState.dir === "asc" ? "is-selected" : ""}`}>▲</span>
        <span className={`wbwh-sort__arrow ${isActive && sortState.dir === "desc" ? "is-selected" : ""}`}>▼</span>
      </span>
    );
  };

  const physicalWarehouses = React.useMemo(
    () => warehouses.filter((w) => w.type === "physical" && w.isActive),
    [warehouses]
  );
  useEffect(() => {
    if (!stockColumns.length && physicalWarehouses.length) {
      setStockColumns(physicalWarehouses.slice(0, Math.min(2, physicalWarehouses.length)).map((w) => w.id));
    }
  }, [physicalWarehouses, stockColumns.length, setStockColumns]);

  const productIds = React.useMemo(() => new Set(items.map((p) => p.id).filter(Boolean) as string[]), [items]);

  const totalByProduct = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const row of stockRows) {
      if (!productIds.has(row.itemId)) continue;
      map.set(row.itemId, (map.get(row.itemId) ?? 0) + row.qty);
    }
    return map;
  }, [stockRows, productIds]);

  const parentByWarehouse: Record<string, string | undefined> = React.useMemo(() => {
    const lookup: Record<string, string | undefined> = {};
    warehouses.forEach((w) => {
      if (w.type === "virtual" && w.parentId) lookup[w.id] = w.parentId;
    });
    return lookup;
  }, [warehouses]);

  const stockByPhysical = React.useMemo(() => {
    const res = new Map<string, Map<string, number>>();
    physicalWarehouses.forEach((phys) => res.set(phys.id, new Map()));
    for (const row of stockRows) {
      if (!productIds.has(row.itemId)) continue;
      const physId = parentByWarehouse[row.warehouseId];
      if (!physId || !res.has(physId)) continue;
      const map = res.get(physId)!;
      map.set(row.itemId, (map.get(row.itemId) ?? 0) + row.qty);
    }
    return res;
  }, [stockRows, physicalWarehouses, parentByWarehouse, productIds]);

  const updateStockColumn = (index: number, value: string) => {
    setStockColumns((prev) => prev.map((id, idx) => (idx === index ? value : id)));
  };
  const removeStockColumn = (index: number) => {
    setStockColumns((prev) => prev.filter((_, idx) => idx !== index));
  };
  const addStockColumn = () => {
    const available = physicalWarehouses.find((w) => !stockColumns.includes(w.id));
    setStockColumns((prev) => [...prev, available?.id ?? ""]);
  };

  return (
    <>
      <div className="mrp-page">
        <div className="mrp-page-head">
          <div className="mrp-title-row">
            <h1 className="mrp-title">Товары</h1>
            <span className="mrp-count">{filteredItems.length}</span>
          </div>
          <div className="mrp-actions">
            <button className="mrp-btn mrp-btn--ghost" onClick={refreshAll} disabled={loading}>
              {loading ? "Обновляем…" : "Обновить"}
            </button>
            <button onClick={openCreate} className="mrp-btn mrp-btn--primary">
              <Plus className="w-4 h-4" /> Добавить товар
            </button>
          </div>
        </div>

        <div className="mrp-card">
          <div className="mrp-toolbar">
            <div className="mrp-toolbar__left">
              <div className="mrp-search-input">
                <Search className="w-4 h-4" />
                <input
                  placeholder="Поиск по коду, наименованию, категории…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </div>
            <div className="mrp-toolbar__right">
              <button type="button" className="mrp-btn mrp-btn--ghost" onClick={addStockColumn}>
                + Колонка склада
              </button>
            </div>
          </div>

          <div className="mrp-hscroll">
            <table className="mrp-table text-sm">
              <thead>
                <tr>
                  <th className="text-left px-2 py-2">Статус</th>
                  <th className="text-left px-2 py-2 wbwh-sortable" onClick={() => handleSort("code")}>
                    Код{sortArrows("code")}
                  </th>
                  <th className="text-left px-2 py-2 wbwh-sortable" onClick={() => handleSort("name")}>
                    Наименование{sortArrows("name")}
                  </th>
                  <th className="text-left px-2 py-2 wbwh-sortable" onClick={() => handleSort("category")}>
                    Категория{sortArrows("category")}
                  </th>
                  <th className="text-left px-2 py-2">Ед.</th>
                  <th className="text-left px-2 py-2">Цена</th>
                  <th className="text-right px-2 py-2 w-[110px]">Остаток, всего</th>
                  {stockColumns.map((physId, idx) => (
                    <th key={`${physId || "empty"}-${idx}`} className="text-left px-2 py-2 w-[130px] align-top">
                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "nowrap" }}>
                        <select
                          className="mrp-select mrp-select--sm min-w-0 flex-1 max-w-[90px]"
                          value={physId}
                          onChange={(e) => updateStockColumn(idx, e.target.value)}
                        >
                          <option value="">(выберите склад)</option>
                          {physicalWarehouses.map((phys) => (
                            <option key={phys.id} value={phys.id}>
                              {phys.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="mrp-icon-btn"
                          title="Убрать колонку"
                          onClick={() => removeStockColumn(idx)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </th>
                  ))}
                  <th className="text-left px-2 py-2">Действия</th>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((p) => {
                const sp = findSpecForProduct(p);
                const totalQty = p.id ? totalByProduct.get(p.id) ?? 0 : 0;
                const statusValue = (p.status ?? "active").toString();
                const statusKey = statusValue.toLowerCase();
                const statusClass =
                  statusKey === "draft"
                    ? "mrp-status mrp-status--draft"
                    : statusKey === "archived"
                      ? "mrp-status mrp-status--archived"
                      : "mrp-status";
                return (
                  <tr key={p.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-2 py-2">
                      <span className={statusClass}>{statusValue}</span>
                    </td>
                    <td className="px-2 py-2">
                      <span className="mrp-code">{p.code}</span>
                    </td>
                    <td className="px-2 py-2">{p.name}</td>
                    <td className="px-2 py-2">{p.category}</td>
                    <td className="px-2 py-2">{p.uom}</td>
                    <td className="px-2 py-2">{p.price?.toLocaleString("ru-RU")}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatQty(totalQty)}</td>
                    {stockColumns.map((physId, idx) => {
                      if (!physId) {
                        return (
                          <td key={`${p.id}-empty-${idx}`} className="px-2 py-2 text-right tabular-nums text-slate-400">
                            —
                          </td>
                        );
                      }
                      const qty = p.id ? stockByPhysical.get(physId)?.get(p.id) ?? 0 : 0;
                      return (
                        <td key={`${p.id}-${physId}-${idx}`} className="px-2 py-2 text-right tabular-nums">
                          {formatQty(qty)}
                        </td>
                      );
                    })}
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          className="act act--ghost" data-action="edit"
                          title="Редактировать товар"
                          onClick={() => openEdit(p)}
                        >
                          <Pencil />
                        </button>

                        <button
                          type="button"
                          className="act act--ghost" data-action="spec"
                          title={sp ? `Редактировать спецификацию (${sp.lines.length} поз.)` : "Создать спецификацию"}
                          onClick={() => openSpec({ id: p.id, code: p.code, name: p.name })}
                        >
                          <FlaskConical />
                        </button>

                        <button
                          type="button"
                          className="act act--ghost" data-action="delete"
                          title="Удалить товар"
                          onClick={() => removeProduct(p.id)}
                        >
                          <Trash2 />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {prodModalOpen && (
        <Modal
          onClose={() => setProdModalOpen(false)}
          title={editing ? "Редактирование товара" : "Новый товар"}
          icon={<FlaskConical className="w-5 h-5" />}
          width={960}
        >
          <ProductForm
            initial={editing}
            onCancel={() => setProdModalOpen(false)}
            onSave={saveProduct}
            dicts={{ statuses, categories, uoms, addCategory, addUom }}
            ensureUniqueCode={ensureUniqueProductCode}
            openSpecFor={openSpec}
          />
        </Modal>
      )}

      {specModalOpen && specEditing && (
        <SpecModal open spec={specEditing} onClose={closeSpecModal} onSaved={() => syncSpecs()} />
      )}

      {matModalOpen && matEditing && (
        <Modal
          onClose={cancelMaterial}
          title={matEditing ? "Материал — редактирование" : "Новый материал"}
          icon={<FlaskConical className="w-5 h-5" />}
          width={960}
        >
          <MaterialForm
            initial={matEditing}
            onCancel={cancelMaterial}
            onSave={saveMaterial}
            dicts={{ vendors, addVendor, uoms, groups, addGroup }}
            ensureUniqueCode={ensureUniqueMaterialCode}
          />
        </Modal>
      )}
    </>
  );
}


/* ===================== VENDORS VIEW (минимум) ===================== */
function VendorsView() {
  const {
    vendors,
    addVendor: addVendorSupabase,
    renameVendor: renameVendorSupabase,
    removeVendor: removeVendorSupabase,
  } = useSupabaseVendors();
  const [query, setQuery] = useState("");
  const [sortState, setSortState] = useState<{ key: "name"; dir: "asc" | "desc" }>({
    key: "name",
    dir: "asc",
  });

  const add = async () => {
    const name = (window.prompt("Название поставщика:") ?? "").trim();
    if (!name) return;
    await addVendorSupabase(name);
  };
  const rename = async (id: string) => {
    const v = vendors.find((x) => x.id === id);
    if (!v) return;
    const name = (window.prompt("Новое название:", v.name) ?? "").trim();
    if (!name) return;
    await renameVendorSupabase(id, name);
  };
  const remove = async (id: string) => {
    const v = vendors.find((x) => x.id === id);
    if (!v) return;
    if (!window.confirm(`Удалить поставщика «${v.name}»?`)) return;
    await removeVendorSupabase(id);
  };

  const handleSort = () => {
    setSortState((prev) => ({
      key: "name",
      dir: prev.dir === "asc" ? "desc" : "asc",
    }));
  };

  const sortArrows = () => {
    const isActive = sortState.key === "name";
    return (
      <span className={`wbwh-sort ${isActive ? "is-active" : ""}`} aria-hidden="true">
        <span className={`wbwh-sort__arrow ${isActive && sortState.dir === "asc" ? "is-selected" : ""}`}>▲</span>
        <span className={`wbwh-sort__arrow ${isActive && sortState.dir === "desc" ? "is-selected" : ""}`}>▼</span>
      </span>
    );
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const dir = sortState.dir === "asc" ? 1 : -1;
    return [...vendors]
      .filter((v) => !q || v.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, "ru", { sensitivity: "base" }) * dir);
  }, [vendors, query, sortState]);

  return (
    <div className="mrp-page">
      <div className="mrp-page-head">
        <div className="mrp-title-row">
          <h1 className="mrp-title">Поставщики</h1>
          <span className="mrp-count">{filtered.length}</span>
        </div>
        <div className="mrp-actions">
          <button className="mrp-btn mrp-btn--primary" onClick={add}>
            <Plus className="w-4 h-4" /> Добавить
          </button>
        </div>
      </div>

      <div className="mrp-card">
        <div className="mrp-toolbar">
          <div className="mrp-toolbar__left">
            <div className="mrp-search-input">
              <Search className="w-4 h-4" />
              <input
                placeholder="Поиск по названию…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="mrp-hscroll">
          <table className="mrp-table text-sm">
            <thead>
              <tr>
                <th className="text-left px-2 py-2 wbwh-sortable" onClick={handleSort}>
                  Название{sortArrows()}
                </th>
                <th className="text-left px-2 py-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((v) => (
                <tr key={v.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-2 py-2">{v.name}</td>
                  <td className="px-2 py-2 actions-cell">
                    <div className="actions-inline">
                      <button
                        type="button"
                        className="act act--ghost"
                        data-action="edit"
                        title="Переименовать"
                        onClick={() => rename(v.id)}
                      >
                        <Pencil />
                      </button>

                      <button
                        type="button"
                        className="act act--ghost"
                        data-action="delete"
                        title="Удалить"
                        onClick={() => remove(v.id)}
                      >
                        <Trash2 />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={2} className="px-2 py-6 text-center text-slate-400">
                    Нет поставщиков
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}


/* ===================== SPECS VIEW (как раньше) ===================== */
function SpecsView() {
  const [specs, setSpecs] = useLocalState<Spec[]>("mrp.specs.v1", []);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const syncInFlight = React.useRef(false);
  const syncSpecs = React.useCallback(async () => {
    if (syncInFlight.current) return;
    syncInFlight.current = true;
    setSyncing(true);
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
      setLastSync(new Date().toISOString());
    } catch (err) {
      console.error("SpecsView syncSpecs failed", err);
    } finally {
      syncInFlight.current = false;
      setSyncing(false);
    }
  }, [setSpecs]);
  useEffect(() => { syncSpecs(); }, [syncSpecs]);
  useEffect(() => {
    const handler = () => syncSpecs();
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, [syncSpecs]);

  // UI
  const [query, setQuery] = useState("");
  const [sortState, setSortState] = useState<{
    key: "code" | "name";
    dir: "asc" | "desc";
  }>({ key: "name", dir: "asc" });
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Spec | null>(null);

  // создать пустую спецификацию (код/имя можно заполнить в форме)
  const openCreate = () => {
    setEditing({
      id: uid(),
      productId: null,
      productCode: "",
      productName: "",
      lines: [],
      updatedAt: new Date().toISOString(),
    });
    setModalOpen(true);
  };

  const openEdit = (s: Spec) => { setEditing(s); setModalOpen(true); };
  const closeModal = () => {
    setModalOpen(false);
    setEditing(null);
    syncSpecs();
  };

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

  const filtered = specs.filter((s) =>
    [s.productCode, s.productName].some((v) =>
      v?.toLowerCase().includes(query.toLowerCase())
    )
  );

  const sorted = React.useMemo(() => {
    const dir = sortState.dir === "asc" ? 1 : -1;
    const getValue = (s: Spec) =>
      sortState.key === "code" ? s.productCode || "" : s.productName || "";
    return [...filtered].sort((a, b) =>
      getValue(a).localeCompare(getValue(b), "ru", { sensitivity: "base" }) * dir
    );
  }, [filtered, sortState]);

  return (
    <>
      <div className="mrp-page">
        <div className="mrp-page-head">
          <div className="mrp-title-row">
            <h1 className="mrp-title">Спецификации</h1>
            <span className="mrp-count">{filtered.length}</span>
          </div>
          <div className="mrp-actions">
            <button onClick={openCreate} className="mrp-btn mrp-btn--primary">
              <Plus className="w-4 h-4" /> Создать
            </button>
          </div>
        </div>

        <div className="mrp-card">
          <div className="mrp-toolbar">
            <div className="mrp-toolbar__left">
              <div className="mrp-search-input">
                <Search className="w-4 h-4" />
                <input
                  placeholder="Поиск по коду или названию…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </div>
            <div className="mrp-toolbar__right">
              <button
                onClick={syncSpecs}
                className="mrp-btn mrp-btn--ghost"
                disabled={syncing}
                title="Обновить список из Supabase"
              >
                {syncing ? "Обновляем…" : "Обновить"}
              </button>
              {lastSync && (
                <div className="text-xs text-slate-400">
                  Обновлено: {new Date(lastSync).toLocaleString("ru-RU")}
                </div>
              )}
            </div>
          </div>

          <div className="mrp-hscroll">
            <table className="mrp-table text-sm">
              <thead>
                <tr>
                  <th className="text-left px-2 py-2 wbwh-sortable" onClick={() => handleSort("code")}>
                    Код спецификации{sortArrows("code")}
                  </th>
                  <th className="text-left px-2 py-2 wbwh-sortable" onClick={() => handleSort("name")}>
                    Название{sortArrows("name")}
                  </th>
                  <th className="text-left px-2 py-2">Позиций</th>
                  <th className="text-left px-2 py-2">Обновлено</th>
                  <th className="text-left px-2 py-2">Действия</th>
                </tr>
              </thead>
              <tbody>
                {(sorted.length > 0 ? sorted : []).map((s) => (
                  <tr key={s.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-2 py-2">
                      <span className="mrp-code">{s.productCode || "—"}</span>
                    </td>
                    <td className="px-2 py-2">{s.productName || "—"}</td>
                    <td className="px-2 py-2">{s.lines.length}</td>
                    <td className="px-2 py-2">{new Date(s.updatedAt).toLocaleString("ru-RU")}</td>
                    <td className="px-2 py-2 actions-cell">
                      <div className="actions-inline">
                        <button
                          type="button"
                          className="act act--ghost"
                          data-action="edit"
                          title="Редактировать"
                          onClick={() => openEdit(s)}
                        >
                          <Pencil />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {sorted.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-2 py-10 text-center text-slate-400">
                      Спецификаций нет
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {modalOpen && editing && (
        <SpecModal open spec={editing} onClose={closeModal} onSaved={() => syncSpecs()} />
      )}
    </>
  );
}



/* ===================== MAIN SHELL ===================== */
function AuthView({
  mode,
  email,
  password,
  loading,
  error,
  onEmailChange,
  onPasswordChange,
  onSubmit,
  onToggleMode,
}: {
  mode: "signin" | "signup";
  email: string;
  password: string;
  loading: boolean;
  error: string | null;
  onEmailChange: (v: string) => void;
  onPasswordChange: (v: string) => void;
  onSubmit: () => void;
  onToggleMode: () => void;
}) {
  return (
    <div className="mrp-auth">
      <div className="mrp-auth-card">
        <div className="mrp-auth-title">
          {mode === "signin" ? "Вход" : "Регистрация"}
        </div>
        <div className="mrp-auth-subtitle">
          Доступ получают все зарегистрированные пользователи.
        </div>
        <div className="mrp-auth-field">
          <label>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            placeholder="name@company.com"
          />
        </div>
        <div className="mrp-auth-field">
          <label>Пароль</label>
          <input
            type="password"
            value={password}
            onChange={(e) => onPasswordChange(e.target.value)}
            placeholder="Минимум 6 символов"
          />
        </div>
        {error && <div className="mrp-auth-error">{error}</div>}
        <div className="mrp-auth-actions">
          <button className="mrp-btn mrp-btn--primary" onClick={onSubmit} disabled={loading}>
            {loading ? "Подождите..." : mode === "signin" ? "Войти" : "Зарегистрироваться"}
          </button>
          <button className="mrp-btn mrp-btn--ghost" onClick={onToggleMode} disabled={loading}>
            {mode === "signin" ? "Нет аккаунта" : "Уже есть аккаунт"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AppShell() {
  const [nav, setNav] = useLocalState<Section[]>("mrp.nav.v3", DEFAULT_NAV);
  // автоматически добавляем новую вкладку "Группы" в настройки, если у пользователя ещё сохранена старая конфигурация навигации
  useEffect(() => {
    setNav(prev => {
      let updated = false;
      const next = prev.map(section => {
        if (section.key !== "settings") return section;
        const subs = section.subs ?? [];
        if (subs.some(sub => sub.key === "groups")) return section;
        const nextSubs = [...subs];
        const catsIdx = nextSubs.findIndex(sub => sub.key === "cats");
        const groupSub = { key: "groups", title: "Группы", route: "/app/settings/groups" };
        if (catsIdx >= 0) nextSubs.splice(catsIdx + 1, 0, groupSub);
        else nextSubs.push(groupSub);
        updated = true;
        return { ...section, subs: nextSubs };
      });
      return updated ? next : prev;
    });
  }, [setNav]);
  useEffect(() => {
    setNav((prev) => {
      let updated = false;
      const next = prev.map((section) => {
        if (section.key !== "settings") return section;
        const subs = section.subs ?? [];
        if (subs.some((sub) => sub.key === "mpwh")) return section;
        const nextSubs = [...subs];
        const whIdx = nextSubs.findIndex((sub) => sub.key === "wh");
        const mpwhSub = { key: "mpwh", title: "МП склады", route: "/app/settings/mpwh" };
        if (whIdx >= 0) nextSubs.splice(whIdx + 1, 0, mpwhSub);
        else nextSubs.push(mpwhSub);
        updated = true;
        return { ...section, subs: nextSubs };
      });
      return updated ? next : prev;
    });
  }, [setNav]);
  useEffect(() => {
    setNav((prev) => {
      let updated = false;
      const next = prev.map((section) => {
        if (section.key !== "sales") return section;
        const subs = section.subs ?? [];
        if (subs.some((sub) => sub.key === "wbwh")) return section;
        const nextSubs = [...subs];
        const mpIdx = nextSubs.findIndex((sub) => sub.key === "mp");
        const wbwhSub = { key: "wbwh", title: "Склады WB", route: "/app/sales/wb-warehouses" };
        if (mpIdx >= 0) nextSubs.splice(mpIdx + 1, 0, wbwhSub);
        else nextSubs.push(wbwhSub);
        updated = true;
        return { ...section, subs: nextSubs };
      });
      return updated ? next : prev;
    });
  }, [setNav]);
  const [collapsed, setCollapsed] = useLocalState<boolean>("mrp.sidebarCollapsed", false);
  const sidebarW = collapsed ? 68 : 288;

  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");

  const [activeSectionKey, setActiveSectionKey] = useLocalState<string>("mrp.activeSection", nav[0]?.key ?? "mfg");
  const currentSection = useMemo(
    () => nav.find(s => s.key === activeSectionKey) ?? nav[0],
    [nav, activeSectionKey]
  );
  const [activeSubKey, setActiveSubKey] = useLocalState<string>("mrp.activeSub", currentSection?.subs?.[0]?.key ?? "");
  const activeSub = useMemo(
    () => currentSection?.subs?.find((s) => s.key === activeSubKey),
    [currentSection, activeSubKey]
  );

  useEffect(() => {
    if (!currentSection?.subs.find(x => x.key === activeSubKey)) {
      setActiveSubKey(currentSection?.subs?.[0]?.key ?? "");
    }
  }, [activeSectionKey]); // eslint-disable-line

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session ?? null);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
      setAuthError(null);
    });
    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadProfile = async () => {
      if (!session?.user) {
        setProfile(null);
        setAuthLoading(false);
        return;
      }
      setAuthLoading(true);
      try {
        const { data, error } = await supabase
          .from("profiles")
          .select("id,email,phone,is_active")
          .eq("id", session.user.id)
          .maybeSingle();
        if (error) throw error;
        if (!data) {
          const { data: inserted, error: insertError } = await supabase
            .from("profiles")
            .upsert({
              id: session.user.id,
              email: session.user.email,
              phone: session.user.phone,
              is_active: true,
            })
            .select("id,email,phone,is_active")
            .single();
          if (insertError) throw insertError;
          if (!cancelled) setProfile(inserted);
        } else if (!cancelled) {
          setProfile(data);
        }
      } catch (e) {
        if (!cancelled) setAuthError("Не удалось загрузить профиль пользователя.");
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    };
    loadProfile();
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  const submitAuth = async () => {
    const email = authEmail.trim();
    if (!email || !authPassword.trim()) {
      setAuthError("Введите email и пароль.");
      return;
    }
    setAuthLoading(true);
    setAuthError(null);
    try {
      if (authMode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password: authPassword });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password: authPassword });
        if (error) throw error;
        if (!data.session) {
          setAuthError("Проверьте почту для подтверждения регистрации.");
        }
      }
    } catch (e: any) {
      setAuthError(e?.message ?? "Ошибка авторизации.");
    } finally {
      setAuthLoading(false);
    }
  };

  const pill = (isActive?: boolean) => `app-pill app-pill--md ${isActive ? "is-active" : ""}`;

  if (authLoading && !session) {
    return (
      <div className="mrp-auth">
        <div className="mrp-auth-card">Загрузка...</div>
      </div>
    );
  }

  if (!session) {
    return (
      <AuthView
        mode={authMode}
        email={authEmail}
        password={authPassword}
        loading={authLoading}
        error={authError}
        onEmailChange={setAuthEmail}
        onPasswordChange={setAuthPassword}
        onSubmit={submitAuth}
        onToggleMode={() => {
          setAuthMode((prev) => (prev === "signin" ? "signup" : "signin"));
          setAuthError(null);
        }}
      />
    );
  }

  if (profile && !profile.is_active) {
    return (
      <div className="mrp-auth">
        <div className="mrp-auth-card">
          <div className="mrp-auth-title">Доступ отключен</div>
          <div className="mrp-auth-subtitle">
            Ваш доступ временно заблокирован. Обратитесь к администратору.
          </div>
          <button className="mrp-btn mrp-btn--primary" onClick={() => supabase.auth.signOut()}>
            Выйти
          </button>
        </div>
      </div>
    );
  }
  
  return (
    <div className="min-h-screen w-full bg-transparent text-slate-900">
{/* -------- Sidebar -------- */}
<aside
  id="mrp-sidebar"
  data-collapsed={collapsed}
  className="transition-[width] duration-200"
  style={{ width: `${sidebarW}px` }}
>
  <div className="sidebar-header">
    <button title="Меню" onClick={() => setCollapsed(v => !v)}>
      <MenuIcon className="w-5 h-5" />
    </button>
    {!collapsed && (
      <div className="ml-2 flex items-center gap-2 font-semibold tracking-tight">
        <span className="mrp-logo">◆</span>
        <span>MRP‑lite</span>
      </div>
    )}
  </div>

  <nav className="sidenav">
    {nav.map((s) => {
      const active = s.key === currentSection?.key;
      return (
        <button
          key={s.key}
          onClick={() => setActiveSectionKey(s.key)}
          className={pill(active)}
          title={s.title}
        >
          <span className="icon"><IconFor name={s.icon} className="w-5 h-5" /></span>
          {!collapsed && <span className="truncate">{s.title}</span>}
        </button>
      );
    })}

    <div className="mt-2 pt-2" style={{ borderTop: "1px solid var(--plate-br)" }}>
      <button className={pill(false)} title="Редактор меню" onClick={() => setNav([...nav])}>
        <span className="icon"><Edit3 className="w-5 h-5" /></span>
        {!collapsed && <span className="truncate">Редактор меню</span>}
      </button>
    </div>
  </nav>
</aside>


      {/* -------- Main -------- */}
      <main
        id="mrp-root"
        className="min-h-screen flex flex-col bg-transparent transition-[margin] duration-200"
        style={{ marginLeft: `${sidebarW}px`, ["--sidebar-w" as any]: `${sidebarW}px` }}
      >
        {/* Top bar */}
        <div className="sticky top-0 z-10 px-0 pt-0">
          <div className="mrp-topbar">
            <div className="mrp-breadcrumbs">
              <span>{currentSection?.title}</span>
              <span className="mrp-breadcrumbs__sep">/</span>
              <span className="is-active">{activeSub?.title ?? "—"}</span>
            </div>

            <div className="mrp-topbar__right">
              <div className="mrp-search">
                <Search className="w-4 h-4" />
                <input placeholder="Быстрый поиск…" />
                <span className="mrp-kbd">⌘K</span>
              </div>
              <div className="mrp-avatar">AK</div>
            </div>
          </div>
          <div className="mrp-subnav">
            {(currentSection?.subs ?? []).map(t => {
              const active = t.key === activeSubKey;
              return (
                <button key={t.key} onClick={() => setActiveSubKey(t.key)} className={pill(active)}>
                  {t.title}
                </button>
              );
            })}
          </div>
        </div>

        {/* Контент */}
        <div className="flex-1 overflow-auto p-0">
          {currentSection?.key === "purchase" && activeSubKey === "products" ? (
            <ProductsView />
          ) : currentSection?.key === "purchase" && activeSubKey === "materials" ? (
            <MaterialsView />
          ) : currentSection?.key === "purchase" && activeSubKey === "vendors" ? (
            <VendorsView />
          ) : currentSection?.key === "purchase" && activeSubKey === "specs" ? (
            <SpecsView />
          ) : currentSection?.key === "purchase" && activeSubKey === "receipts" ? (
            <ReceiptsView />          
          ) : currentSection?.key === "mfg" && activeSubKey === "plan" ? (
          <PlanGridView />                         
          ) : currentSection?.key === "mfg" && activeSubKey === "prodReports" ? (
            <ProdReportsView />  
          ) : currentSection?.key === "mfg" && activeSubKey === "specs" ? (  
          <SpecsView />                              
          ) : currentSection?.key === "stock" && activeSubKey === "balances" ? (
            <BalancesView />                                   
          ) : currentSection?.key === "settings" && activeSubKey === "uom" ? (
            <div className="settings-wrap">
              <SettingsUoms />
            </div>
          ) : currentSection?.key === "settings" && activeSubKey === "curr" ? (
            <div className="settings-wrap">
              <SettingsCurrencies />
            </div>
          ) : currentSection?.key === "settings" && activeSubKey === "cats" ? (
            <div className="settings-wrap">
              <SettingsCategories />
            </div>
          ) : currentSection?.key === "settings" && activeSubKey === "groups" ? (
            <div className="settings-wrap">
              <SettingsGroups />
            </div>
          ) : currentSection?.key === "sales" && activeSubKey === "mp" ? (
            <MarketplacesView />
          ) : currentSection?.key === "sales" && activeSubKey === "wbwh" ? (
            <WbWarehousesView />
          ) : currentSection?.key === "settings" && activeSubKey === "wh" ? (
            <div className="settings-wrap">
              <SettingsWarehouses />
            </div>
          ) : currentSection?.key === "settings" && activeSubKey === "mpwh" ? (
            <div className="settings-wrap">
              <SettingsMarketplaceWarehouses />
            </div>
          ) : currentSection?.key === "settings" && activeSubKey === "integr" ? (
            <div className="settings-wrap">
              <SettingsIntegrations />
            </div>
          ) : (
            <div className="text-slate-600">
              Здесь будет контент <b>{currentSection?.key}</b> / <b>{activeSubKey}</b>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}


function DictList({
  title, items, setItems, placeholder = "Новое значение", allowRename = true
}: {
  title: string;
  items: string[];
  setItems: (updater: (prev: string[]) => string[]) => void;
  placeholder?: string;
  allowRename?: boolean;
}) {
  const add = () => {
    const v = (window.prompt(placeholder) ?? "").trim();
    if (!v) return;
    setItems(prev => prev.includes(v) ? prev : [...prev, v]);
  };
  const rename = (val: string) => {
    if (!allowRename) return;
    const v = (window.prompt("Новое значение:", val) ?? "").trim();
    if (!v) return;
    setItems(prev => prev.map(x => x === val ? v : x));
  };
  const remove = (val: string) => {
    if (!window.confirm(`Удалить «${val}»?`)) return;
    setItems(prev => prev.filter(x => x !== val));
  };

  return (
    <div className="app-plate app-plate--solid p-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-sm text-slate-600">{title}: {items.length}</div>
        <button className="mrp-btn mrp-btn--primary" onClick={add}>
          <Plus className="w-4 h-4" /> Добавить
        </button>
      </div>
      <div className="overflow-auto rounded-xl border border-slate-100 bg-white">
        <table className="mrp-table text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Значение</th>
              <th className="text-left px-3 py-2">Действия</th>
            </tr>
          </thead>
          <tbody>
            {items.map(v => (
              <tr key={v} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2">{v}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    {allowRename && (
                      <button
                        className="mrp-icon-btn"
                        title="Переименовать"
                        onClick={() => rename(v)}
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      className="mrp-icon-btn"
                      title="Удалить"
                      onClick={() => remove(v)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={2} className="px-3 py-6 text-center text-slate-400">Пусто</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}


function SettingsUoms() {
  const { uoms, addUom, renameUom, removeUom } = useSupabaseUoms();

  const handleAdd = async () => {
    const value = (window.prompt("Новая единица измерения") ?? "").trim();
    if (!value) return;
    await addUom(value);
  };
  const handleRename = async (id: string, current: string) => {
    const value = (window.prompt("Новое название", current) ?? "").trim();
    if (!value || value === current) return;
    await renameUom(id, value);
  };
  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Удалить «${name}»?`)) return;
    await removeUom(id);
  };

  return (
    <div className="app-plate app-plate--solid p-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-sm text-slate-600">Единицы измерения: {uoms.length}</div>
        <button className="mrp-btn mrp-btn--primary" onClick={handleAdd}>
          + Добавить
        </button>
      </div>
      <div className="overflow-auto rounded-xl border border-slate-100 bg-white">
        <table className="mrp-table text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Название</th>
              <th className="text-left px-3 py-2">Действия</th>
            </tr>
          </thead>
          <tbody>
            {uoms.map((u) => (
              <tr key={u.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2">{u.name}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <button
                      className="mrp-icon-btn"
                      title="Переименовать"
                      onClick={() => handleRename(u.id, u.name)}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      className="mrp-icon-btn"
                      title="Удалить"
                      onClick={() => handleDelete(u.id, u.name)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {uoms.length === 0 && (
              <tr>
                <td colSpan={2} className="px-3 py-6 text-center text-slate-400">
                  Пусто
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function SettingsCurrencies() {
  const [curr, setCurr] = useLocalState<string[]>("mrp.dict.currencies", ["RUB","USD","EUR"]);
  // валюты обычно не переименовывают — запретим rename
  return <DictList title="Валюты" items={curr} setItems={setCurr} allowRename={false} placeholder="Новая валюта (например, GBP)" />;
}

function SettingsGroups() {
  const { groups, addGroup, renameGroup, removeGroup } = useSupabaseGroups();

  const handleAdd = async () => {
    const v = (window.prompt("Новая группа") ?? "").trim();
    if (!v) return;
    await addGroup(v);
  };
  const handleRename = async (id: string, current: string) => {
    const v = (window.prompt("Новое название группы", current) ?? "").trim();
    if (!v || v === current) return;
    await renameGroup(id, current, v);
  };
  const handleRemove = async (id: string, name: string) => {
    if (!window.confirm(`Удалить группу «${name}»?`)) return;
    await removeGroup(id, name);
  };

  return (
    <div className="app-plate app-plate--solid p-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-sm text-slate-600">Группы материалов: {groups.length}</div>
        <button className="mrp-btn mrp-btn--primary" onClick={handleAdd}>
          + Добавить
        </button>
      </div>
      <div className="overflow-auto rounded-xl border border-slate-100 bg-white">
        <table className="mrp-table text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Группа</th>
              <th className="text-left px-3 py-2">Действия</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((grp) => (
              <tr key={grp.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2">{grp.name}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <button
                      className="mrp-icon-btn"
                      title="Переименовать"
                      onClick={() => handleRename(grp.id, grp.name)}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      className="mrp-icon-btn"
                      title="Удалить"
                      onClick={() => handleRemove(grp.id, grp.name)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {groups.length === 0 && (
              <tr>
                <td colSpan={2} className="px-3 py-6 text-center text-slate-400">
                  Пусто
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SettingsCategories() {
  const {
    categories,
    addCategory,
    renameCategory,
    changeCategoryKind,
    removeCategory,
  } = useSupabaseCategories();

  const handleAdd = async () => {
    const v = (window.prompt("Новая категория") ?? "").trim();
    if (!v) return;
    await addCategory(v);
  };
  const handleRename = async (id: string, current: string) => {
    const v = (window.prompt("Новое название:", current) ?? "").trim();
    if (!v || v === current) return;
    await renameCategory(id, v);
  };
  const handleRemove = async (id: string, name: string) => {
    if (!window.confirm(`Удалить «${name}»?`)) return;
    await removeCategory(id);
  };

  return (
    <div className="app-plate app-plate--solid p-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-sm text-slate-600">Категории: {categories.length}</div>
        <button className="mrp-btn mrp-btn--primary" onClick={handleAdd}>+ Добавить</button>
      </div>

      <div className="overflow-auto rounded-xl border border-slate-100 bg-white">
        <table className="mrp-table text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Категория</th>
              <th className="text-left px-3 py-2">Тип (ГП/Мат/Обе)</th>
              <th className="text-left px-3 py-2">Действия</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((cat) => (
              <tr key={cat.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2">{cat.name}</td>
                <td className="px-3 py-2">
                  <select
                    className="mrp-select mrp-select--sm"
                    value={cat.kind}
                    onChange={(e) =>
                      changeCategoryKind(cat.id, e.target.value as typeof cat.kind)
                    }
                  >
                    <option value="fg">Готовая продукция</option>
                    <option value="mat">Материалы</option>
                    <option value="both">Обе</option>
                  </select>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <button
                      className="mrp-icon-btn"
                      title="Переименовать"
                      onClick={() => handleRename(cat.id, cat.name)}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      className="mrp-icon-btn"
                      title="Удалить"
                      onClick={() => handleRemove(cat.id, cat.name)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {categories.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-slate-400">
                  Пусто
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}


function SettingsWarehouses() {
  const {
    warehouses,
    physical,
    zonesByPhys,
    addPhysical,
    addZone,
    renameWarehouse,
    deleteWarehouse,
  } = useSupabaseWarehouses();
  const [balances] = useStockBalances();

  const canDelete = (id: string) => !balances.some(b => b.warehouseId === id);
  const handleRemove = async (id: string, name: string) => {
    const record = warehouses.find((w) => w.id === id);
    if (!record) return;
    if (!canDelete(id)) return window.alert(`Нельзя удалить «${name}»: есть связанные остатки.`);
    if (record.type === "physical" && zonesByPhys(id).length > 0) {
      window.alert(`Сначала удалите зоны у «${name}».`);
      return;
    }
    if (!window.confirm(`Удалить «${name}»?`)) return;
    await deleteWarehouse(id);
  };
  const handleRename = async (id: string, curName: string) => {
    const name = (window.prompt("Новое название:", curName) ?? "").trim();
    if (!name || name === curName) return;
    await renameWarehouse(id, name);
  };
  const handleAddPhysical = async () => {
    const name = (window.prompt("Название физического склада:") ?? "").trim();
    if (!name) return;
    await addPhysical(name);
  };
  const handleAddZone = async (physId: string) => {
    const name = (window.prompt("Название зоны (виртуальный склад):") ?? "").trim();
    if (!name) return;
    await addZone(physId, name);
  };

  return (
    <div className="mrp-page">
      <div className="mrp-card mrp-card--compact">
        <div className="mrp-toolbar mrp-toolbar--compact mb-2">
          <div className="mrp-toolbar__left">
            <div className="mrp-field">
              <span className="mrp-field__label">Физические склады</span>
              <div className="text-xs text-slate-600">{physical.length}</div>
            </div>
          </div>
          <div className="mrp-toolbar__right">
            <button className="mrp-btn mrp-btn--primary mrp-btn--xs" onClick={handleAddPhysical}>
              <Plus className="w-4 h-4" /> Физический
            </button>
          </div>
        </div>

        <div className="mrp-hscroll">
          <table className="mrp-table text-sm table-compact">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-2 py-1 w-[180px]">Физический склад</th>
              <th className="text-left px-2 py-1">Зоны (виртуальные)</th>
              <th className="text-left px-2 py-1 w-[90px]">Действия</th>
            </tr>
          </thead>
          <tbody>
            {physical.map(p => {
              const zones = zonesByPhys(p.id);
              return (
                <tr key={p.id} className="border-t border-slate-100 align-top">
                  <td className="px-2 py-1">
                    <div className="font-medium">{p.name}</div>
                  </td>
                  <td className="px-2 py-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {zones.map(z => (
                        <div key={z.id} className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-slate-200">
                          <span className="text-xs">{z.name}</span>
                          <div className="flex items-center gap-1">
                            <button className="mrp-icon-btn mrp-icon-btn--xs" title="Переименовать" onClick={() => handleRename(z.id, z.name)}><Pencil className="w-3.5 h-3.5" /></button>
                            <button className="mrp-icon-btn mrp-icon-btn--xs" title="Удалить" onClick={() => handleRemove(z.id, z.name)}><Trash2 className="w-3.5 h-3.5" /></button>
                          </div>
                        </div>
                      ))}
                      <button className="mrp-btn mrp-btn--ghost mrp-btn--xs" onClick={() => handleAddZone(p.id)}>
                        <Plus className="w-3 h-3" /> Зона
                      </button>
                    </div>
                  </td>
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-2">
                      <button className="mrp-icon-btn mrp-icon-btn--xs" title="Переименовать" onClick={() => handleRename(p.id, p.name)}><Pencil className="w-3.5 h-3.5" /></button>
                      <button className="mrp-icon-btn mrp-icon-btn--xs" title="Удалить" onClick={() => handleRemove(p.id, p.name)}><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {physical.length === 0 && <tr><td colSpan={3} className="px-2 py-4 text-center text-slate-400">Пока нет складов</td></tr>}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

function BalancesView() {
  const [materials] = useLocalState<Material[]>("mrp.materials.v1", []);
  const [products]  = useLocalState<Product[]>("mrp.products.v1", []);
  const { warehouses, physical, virtual } = useSupabaseWarehouses();
  const { balances } = useStockRepo();

  const [typeFilter, setTypeFilter] = useState<"all"|"material"|"product">("all");
  const [whFilter, setWhFilter] = useState<string>("");
  const [q, setQ] = useState("");

  const nameOf = (b: StockBalance) => {
    if (b.itemType === "material") {
      const m = materials.find(x => x.id === b.itemId);
      return { code: m?.code ?? "", name: m?.name ?? "", uom: m?.uom ?? "" };
    } else {
      const p = products.find(x => x.id === b.itemId);
      return { code: p?.code ?? "", name: p?.name ?? "", uom: p?.uom ?? "" };
    }
  };
  const whName = (id: string) => {
    const w = warehouses.find((x) => x.id === id);
    if (!w) return "";
    if (w.type === "virtual") {
      const parent = warehouses.find((x) => x.id === w.parentId);
      return parent ? `${parent.name} / ${w.name}` : w.name;
    }
    return w.name;
  };

  const rows = balances
    .filter(b => typeFilter === "all" || b.itemType === typeFilter)
    .filter(b => !whFilter || b.warehouseId === whFilter)
    .map(b => ({ b, ...nameOf(b) }))
    .filter(r => (r.code + " " + r.name).toLowerCase().includes(q.toLowerCase()))
    .sort((a, z) => a.code.localeCompare(z.code));

  return (
    <div className="app-plate app-plate--solid p-3">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <select className="mrp-select" value={typeFilter} onChange={e => setTypeFilter(e.target.value as any)}>
          <option value="all">Все</option>
          <option value="material">Материалы</option>
          <option value="product">Товары</option>
        </select>

        <select className="mrp-select" value={whFilter} onChange={e => setWhFilter(e.target.value)}>
          <option value="">Все склады</option>
          <optgroup label="Физические">
            {physical.map(p => <option key={p.id} value={p.id} disabled>{p.name}</option>)}
          </optgroup>
          <optgroup label="Зоны">
            {virtual.map(v => {
              const parent = warehouses.find((x) => x.id === v.parentId);
              return <option key={v.id} value={v.id}>{parent ? `${parent.name} / ${v.name}` : v.name}</option>;
            })}
          </optgroup>
        </select>

        <input className="flex-1 min-w-[220px] px-3 py-2 rounded-xl border text-sm" placeholder="Код или наименование" value={q} onChange={e => setQ(e.target.value)} />
      </div>

      <div className="overflow-auto rounded-xl border border-slate-100 bg-white">
        <table className="mrp-table text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Тип</th>
              <th className="text-left px-3 py-2">Код</th>
              <th className="text-left px-3 py-2">Наименование</th>
              <th className="text-left px-3 py-2">Ед.</th>
              <th className="text-left px-3 py-2">Склад/Зона</th>
              <th className="text-left px-3 py-2">Кол-во</th>
              <th className="text-left px-3 py-2">Обновлено</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.b.id} className="border-t border-slate-100">
                <td className="px-3 py-2">{r.b.itemType === "material" ? "M" : "P"}</td>
                <td className="px-3 py-2">{r.code}</td>
                <td className="px-3 py-2">{r.name}</td>
                <td className="px-3 py-2">{r.uom}</td>
                <td className="px-3 py-2">{whName(r.b.warehouseId)}</td>
                <td className="px-3 py-2">{r.b.qty}</td>
                <td className="px-3 py-2">{new Date(r.b.updatedAt).toLocaleString("ru-RU")}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">Нет данных</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}




function ProdReportsView() {
  type ReportRow = {
    id: string;
    number: string;
    dateISO: string;
    qty: number;
    status: string;
    product?: { code: string; name: string };
    physWarehouseId: string;
    fgZoneId: string;
    matZoneId: string;
  };
  type WarehouseMap = Record<string, { id: string; name: string; type: "physical" | "virtual"; parentId?: string | null }>;

  const [reports, setReports] = useState<ReportRow[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseMap>({});
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [sortState, setSortState] = useState<{
    key: "number" | "product";
    dir: "asc" | "desc";
  }>({ key: "number", dir: "desc" });

  const refreshWarehouses = useCallback(async () => {
    const { data, error } = await supabase
      .from("warehouses")
      .select("id, name, type, parent_id");
    if (error) {
      console.error("prodReports: load warehouses", error);
      return;
    }
    const map: WarehouseMap = {};
    (data || []).forEach((row: any) => {
      map[row.id] = {
        id: row.id,
        name: row.name,
        type: row.type === "physical" ? "physical" : "virtual",
        parentId: row.parent_id,
      };
    });
    setWarehouses(map);
  }, []);

  const refreshReports = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("prod_reports")
        .select(`
          id,
          number,
          date_iso,
          qty,
          status,
          phys_warehouse_id,
          fg_zone_id,
          mat_zone_id,
          product:product_id (code, name)
        `)
        .order("date_iso", { ascending: false })
        .limit(200);
      if (error) throw error;
      const mapped: ReportRow[] = (data || []).map((row: any) => ({
        id: row.id,
        number: row.number,
        dateISO: row.date_iso,
        qty: Number(row.qty) || 0,
        status: row.status ?? "posted",
        physWarehouseId: row.phys_warehouse_id,
        fgZoneId: row.fg_zone_id,
        matZoneId: row.mat_zone_id,
        product: row.product ? { code: row.product.code, name: row.product.name } : undefined,
      }));
      setReports(mapped);
    } catch (err) {
      console.error("prodReports: load reports", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshWarehouses();
  }, [refreshWarehouses]);
  useEffect(() => {
    refreshReports();
  }, [refreshReports]);

  const fmtZone = (id?: string) => {
    if (!id) return "";
    const z = warehouses[id];
    if (!z) return "";
    if (z.type === "virtual" && z.parentId && warehouses[z.parentId]) {
      return `${warehouses[z.parentId].name} / ${z.name}`;
    }
    return z.name;
  };

  const filtered = reports.filter((r) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    return (
      r.number.toLowerCase().includes(q) ||
      r.product?.code.toLowerCase().includes(q) ||
      r.product?.name.toLowerCase().includes(q)
    );
  });

  const handleSort = (key: "number" | "product") => {
    setSortState((prev) => {
      if (prev.key !== key) return { key, dir: "asc" };
      return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  };

  const sortArrows = (key: "number" | "product") => {
    const isActive = sortState.key === key;
    return (
      <span className={`wbwh-sort ${isActive ? "is-active" : ""}`} aria-hidden="true">
        <span className={`wbwh-sort__arrow ${isActive && sortState.dir === "asc" ? "is-selected" : ""}`}>▲</span>
        <span className={`wbwh-sort__arrow ${isActive && sortState.dir === "desc" ? "is-selected" : ""}`}>▼</span>
      </span>
    );
  };

  const sorted = React.useMemo(() => {
    const dir = sortState.dir === "asc" ? 1 : -1;
    const getValue = (r: ReportRow) => {
      if (sortState.key === "product") {
        return r.product ? `${r.product.code} ${r.product.name}` : "";
      }
      return r.number ?? "";
    };
    return [...filtered].sort((a, b) =>
      getValue(a).localeCompare(getValue(b), "ru", { sensitivity: "base" }) * dir
    );
  }, [filtered, sortState]);

  return (
    <div className="mrp-page">
      <div className="mrp-card">
        <div className="mrp-toolbar mb-2">
          <div className="mrp-toolbar__left">
            <button className="mrp-btn mrp-btn--ghost" onClick={refreshReports} disabled={loading}>
              {loading ? "Обновляем…" : "Обновить"}
            </button>
            <span className="text-xs text-slate-500">
              Документы создаются автоматически при вводе факта в «Плане партии».
            </span>
            <div className="mrp-search-input">
              <Search className="w-4 h-4" />
              <input
                placeholder="Поиск по номеру или товару"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          <div className="mrp-toolbar__right">
            <div className="mrp-field">
              <span className="mrp-field__label">Всего</span>
              <div className="text-sm text-slate-600">{filtered.length}</div>
            </div>
          </div>
        </div>

        <div className="mrp-hscroll">
          <table className="mrp-table text-sm table-compact">
            <thead>
              <tr>
                <th className="text-left px-3 py-2 wbwh-sortable" onClick={() => handleSort("number")}>
                  Номер / Дата{sortArrows("number")}
                </th>
                <th className="text-left px-3 py-2 wbwh-sortable" onClick={() => handleSort("product")}>
                  Товар{sortArrows("product")}
                </th>
                <th className="text-left px-3 py-2 w-[90px]">Кол-во</th>
                <th className="text-left px-3 py-2">Склад (ГП / Мат.)</th>
                <th className="text-left px-3 py-2 w-[120px]">Статус</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((d) => (
                <tr key={d.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    <div className="font-medium">{d.number}</div>
                    <div className="text-slate-500 text-xs">
                      {new Date(d.dateISO).toLocaleString("ru-RU")}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col gap-1">
                      <span className="mrp-code">{d.product?.code ?? "—"}</span>
                      <span className="text-slate-700 text-sm leading-snug line-clamp-2">
                        {d.product?.name ?? "—"}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2">{d.qty}</td>
                  <td className="px-3 py-2">
                    <div>ГП: {fmtZone(d.fgZoneId) || "—"}</div>
                    <div className="text-xs text-slate-500">Мат.: {fmtZone(d.matZoneId) || "—"}</div>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        d.status === "draft"
                          ? "mrp-status mrp-status--draft"
                          : "mrp-status"
                      }
                    >
                      {d.status === "posted" ? "Проведён" : d.status === "draft" ? "Черновик" : d.status}
                    </span>
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-slate-400">
                    Документы не найдены
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ReceiptsView() {
  const { vendors } = useSupabaseVendors();
  const { warehouses } = useSupabaseWarehouses();

  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [sortState, setSortState] = useState<{
    key: "number" | "vendor";
    dir: "asc" | "desc";
  }>({ key: "number", dir: "asc" });
  const [detailReceipt, setDetailReceipt] = useState<ReceiptRow | null>(null);
  const [detailLines, setDetailLines] = useState<ReceiptLine[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchReceiptsSupabase();
      setReceipts(rows);
    } catch (error) {
      console.error("Failed to load receipts", error);
      alert("Не удалось загрузить поступления из Supabase");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const vendorMap = useMemo(() => {
    const map = new Map<string, string>();
    vendors.forEach((v) => map.set(v.id, v.name));
    return map;
  }, [vendors]);

  const warehouseMap = useMemo(() => {
    const map = new Map<string, WarehouseRecord>();
    warehouses.forEach((w) => map.set(w.id, w));
    return map;
  }, [warehouses]);

  const fmtZone = useCallback(
    (zoneId?: string | null) => {
      if (!zoneId) return "";
      const zone = warehouseMap.get(zoneId);
      if (!zone) return "";
      if (zone.type === "virtual" && zone.parentId) {
        const phys = warehouseMap.get(zone.parentId);
        return phys ? `${phys.name} / ${zone.name}` : zone.name;
      }
      return zone.name;
    },
    [warehouseMap]
  );

  const vendorTitle = useCallback(
    (doc: ReceiptRow) => {
      if (doc.vendorId && vendorMap.get(doc.vendorId)) return vendorMap.get(doc.vendorId);
      return doc.supplierName || "—";
    },
    [vendorMap]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return receipts;
    return receipts.filter((doc) => {
      const vendorTitle = doc.vendorId ? vendorMap.get(doc.vendorId) : "";
      const haystack = [
        doc.number ?? "",
        doc.supplierName ?? "",
        vendorTitle ?? "",
        fmtZone(doc.zoneId),
        doc.status,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [receipts, search, vendorMap, fmtZone]);

  const handleSort = (key: "number" | "vendor") => {
    setSortState((prev) => {
      if (prev.key !== key) return { key, dir: "asc" };
      return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  };

  const sortArrows = (key: "number" | "vendor") => {
    const isActive = sortState.key === key;
    return (
      <span className={`wbwh-sort ${isActive ? "is-active" : ""}`} aria-hidden="true">
        <span className={`wbwh-sort__arrow ${isActive && sortState.dir === "asc" ? "is-selected" : ""}`}>▲</span>
        <span className={`wbwh-sort__arrow ${isActive && sortState.dir === "desc" ? "is-selected" : ""}`}>▼</span>
      </span>
    );
  };

  const sorted = useMemo(() => {
    const dir = sortState.dir === "asc" ? 1 : -1;
    const getValue = (doc: ReceiptRow) => {
      if (sortState.key === "vendor") return vendorTitle(doc);
      return doc.number ?? "";
    };
    return [...filtered].sort((a, b) =>
      getValue(a).localeCompare(getValue(b), "ru", { sensitivity: "base" }) * dir
    );
  }, [filtered, sortState, vendorTitle]);

  const openDetails = useCallback(async (doc: ReceiptRow) => {
    setDetailReceipt(doc);
    setDetailLines([]);
    setDetailLoading(true);
    try {
      const lines = await fetchReceiptLinesSupabase(doc.id);
      setDetailLines(lines);
    } catch (error) {
      console.error("Failed to load receipt lines", error);
      alert("Не удалось загрузить строки поступления");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeDetails = useCallback(() => {
    setDetailReceipt(null);
    setDetailLines([]);
    setDetailLoading(false);
  }, []);

  const cancelReceipt = useCallback(
    async (doc: ReceiptRow) => {
      const label = doc.number?.trim() || doc.id.slice(0, 8);
      if (!window.confirm(`Отменить поступление ${label}?`)) return;
      try {
        await rollbackReceiptSupabase(doc.id);
        await refresh();
      } catch (error) {
        console.error("Failed to cancel receipt", error);
        alert("Не удалось отменить поступление в Supabase");
      }
    },
    [refresh]
  );

  const handleManualCreate = useCallback(() => {
    alert("Ручное создание поступлений пока не реализовано. Документы появляются автоматически при проведении приходов в разделе Материалы.");
  }, []);

  const statusLabel = (status: ReceiptRow["status"]) => {
    if (status === "posted") return "Проведён";
    if (status === "canceled") return "Отменён";
    return "Черновик";
  };

  return (
    <>
      <div className="mrp-page">
        <div className="mrp-page-head">
          <div className="mrp-title-row">
            <h1 className="mrp-title">Поступления</h1>
            <span className="mrp-count">{filtered.length}</span>
          </div>
          <div className="mrp-actions">
            <button onClick={handleManualCreate} className="mrp-btn mrp-btn--primary">
              <Plus className="w-4 h-4" /> Создать
            </button>
          </div>
        </div>

        <div className="mrp-card">
          <div className="mrp-toolbar">
            <div className="mrp-toolbar__left">
              <div className="mrp-search-input">
                <Search className="w-4 h-4" />
                <input
                  placeholder="Поиск по номеру, поставщику, складу…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
            <div className="mrp-toolbar__right">
              <button onClick={refresh} disabled={loading} className="mrp-btn mrp-btn--ghost">
                {loading ? "Обновляем…" : "Обновить"}
              </button>
            </div>
          </div>

          <div className="mrp-hscroll">
            <table className="mrp-table text-sm">
              <thead>
                <tr>
                  <th className="text-left px-2 py-2 wbwh-sortable" onClick={() => handleSort("number")}>
                    Номер / Дата{sortArrows("number")}
                  </th>
                  <th className="text-left px-2 py-2 wbwh-sortable" onClick={() => handleSort("vendor")}>
                    Поставщик{sortArrows("vendor")}
                  </th>
                  <th className="text-left px-2 py-2">Склад/Зона</th>
                  <th className="text-left px-2 py-2">Строк</th>
                  <th className="text-left px-2 py-2">Статус</th>
                  <th className="text-left px-2 py-2">Действия</th>
                </tr>
              </thead>

            {/* ===== TBODY: рендер строк или заглушки без иконок ===== */}
            <tbody>
              {sorted.length > 0 ? (
                sorted.map((d) => {
                  const venTitle = vendorTitle(d) || "—";
                  const whTitle = fmtZone(d.zoneId) || "—";
                  const statusClass =
                    d.status === "posted"
                      ? "mrp-status"
                      : d.status === "canceled"
                      ? "mrp-status mrp-status--archived"
                      : "mrp-status mrp-status--draft";
                  return (
                    <tr key={d.id} className="border-t border-slate-100 hover:bg-slate-50">
                      {/* Номер / Дата */}
                      <td className="px-2 py-2">
                        {(d.number ?? "").trim() || "—"}{" "}
                        <span className="text-slate-400">
                          / {new Date(d.dateISO).toLocaleString("ru-RU")}
                        </span>
                      </td>

                      {/* Поставщик */}
                      <td className="px-2 py-2">{venTitle}</td>

                      {/* Склад/Зона */}
                      <td className="px-2 py-2">{whTitle}</td>

                      {/* Строк */}
                      <td className="px-2 py-2">{d.itemCount}</td>

                      {/* Статус */}
                      <td className="px-2 py-2">
                        <span className={statusClass}>{statusLabel(d.status)}</span>
                      </td>

                      {/* Действия */}
                      <td className="px-2 py-2 actions-cell">
                        <div className="actions-inline">
                          <button
                            type="button"
                            className="act act--ghost"
                            data-action="details"
                            title="Показать строки"
                            onClick={() => openDetails(d)}
                          >
                            <Search />
                          </button>

                          {d.status === "posted" && (
                            <button
                              type="button"
                              className="act act--ghost"
                              data-action="unpost"
                              title="Отменить проведение"
                              onClick={() => cancelReceipt(d)}
                            >
                              <RotateCcw />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={6} className="px-2 py-10 text-center text-slate-400">
                    {loading ? "Загружаем…" : "Поступлений нет"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>

      {/* Детали поступления */}
      {detailReceipt && (
        <Modal
          onClose={closeDetails}
          title="Поступление"
          icon={<FlaskConical className="w-5 h-5" />}
        >
          <div className="space-y-2 text-sm">
            <div className="font-semibold">
              {detailReceipt.number || detailReceipt.id.slice(0, 8)}
            </div>
            <div className="text-slate-500">
              Дата: {new Date(detailReceipt.dateISO).toLocaleString("ru-RU")}
            </div>
            <div>Поставщик: {vendorTitle(detailReceipt)}</div>
            <div>Склад: {fmtZone(detailReceipt.zoneId) || "—"}</div>
            <div>Статус: {statusLabel(detailReceipt.status)}</div>
          </div>

          <div className="mt-4">
            {detailLoading ? (
              <div className="text-center text-slate-500 py-6">Загружаем строки…</div>
            ) : detailLines.length === 0 ? (
              <div className="text-center text-slate-400 py-6">Строки отсутствуют</div>
            ) : (
              <div className="table-wrapper mt-2">
                <table className="mrp-table text-sm">
                  <thead>
                    <tr>
                      <th className="text-left px-2 py-2">Код</th>
                      <th className="text-left px-2 py-2">Наименование</th>
                      <th className="text-right px-2 py-2 w-[120px]">Кол-во</th>
                      <th className="text-left px-2 py-2 w-[80px]">Ед.</th>
                      <th className="text-left px-2 py-2">Склад</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailLines.map((ln) => (
                      <tr key={ln.id} className="border-t border-slate-100">
                        <td className="px-2 py-2">{ln.itemCode || "—"}</td>
                        <td className="px-2 py-2">{ln.itemName || "—"}</td>
                        <td className="px-2 py-2 text-right">{ln.qty}</td>
                        <td className="px-2 py-2">{ln.itemUom || ln.uom || "шт"}</td>
                        <td className="px-2 py-2">{fmtZone(ln.warehouseId) || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}



/**
 * Требуются из твоего файла:
 * - useLocalState
 * - useWarehousesV2, splitWarehouses
 * - useStockRepo   (берём getQty для остатков по зонам)
 * Типы Product, Spec, Warehouse у тебя уже объявлены.
 */
