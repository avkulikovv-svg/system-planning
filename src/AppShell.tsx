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
  role?: string | null;
  permissions?: string[] | null;
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
  boxVolume?: number;
  unitWeight?: number;
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
type Semi = {
  id: string;
  code: string;
  name: string;
  uom?: string;
  group?: string;
  status?: string;
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
  isDefault: boolean;
};

type StockBalance = {
  id: string;
  itemType: "material" | "product" | "semi";
  itemId: string;
  warehouseId: string;            // virtual warehouse id
  qty: number;                    // >= 0
  updatedAt: string;              // ISO
};

type LedgerEntry = {
  itemType: "material" | "product" | "semi";
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

  const getQty = (itemType: "material" | "product" | "semi", itemId: string, warehouseId: string) => {
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

const PERMISSION_BY_SUBKEY: Record<string, string> = {
  plan: "mfg.plan",
  prodReports: "mfg.prodReports",
  specs: "mfg.specs",
  writeoff: "mfg.writeoff",
  forecast: "sales.forecast",
  prices: "sales.prices",
  wbwh: "sales.wbwh",
  products: "purchase.products",
  materials: "purchase.materials",
  semis: "purchase.semis",
  vendors: "purchase.vendors",
  po: "purchase.po",
  receipts: "purchase.receipts",
  balances: "stock.balances",
  moves: "stock.moves",
  count: "stock.count",
  dashboard: "reports.dashboard",
  kpi: "reports.kpi",
  uom: "settings.uom",
  curr: "settings.curr",
  cats: "settings.cats",
  groups: "settings.groups",
  wh: "settings.wh",
  mpwh: "settings.mpwh",
  users: "settings.users",
  integr: "settings.integrations",
  nums: "settings.nums",
};


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

type InputModalProps = {
  open: boolean;
  title: string;
  label: string;
  placeholder?: string;
  value: string;
  onChange: (val: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel?: string;
};

function InputModal({
  open,
  title,
  label,
  placeholder,
  value,
  onChange,
  onClose,
  onSubmit,
  submitLabel = "Сохранить",
}: InputModalProps) {
  if (!open) return null;
  const canSave = value.trim().length > 0;

  return (
    <Modal onClose={onClose} title={title} width={420}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSave) return;
          onSubmit();
        }}
      >
        <div className="form-row">
          <Label>{label}</Label>
          <input
            className="form-control w-full"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            autoFocus
          />
        </div>

        <div className="modal-footer">
          <div className="flex items-center justify-end gap-2 w-full">
            <button type="button" className="mrp-btn" onClick={onClose}>
              Отмена
            </button>
            <button type="submit" className="mrp-btn mrp-btn--primary" disabled={!canSave}>
              {submitLabel}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}





function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <div className="form-label mb-1">
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
            className="form-control w-full"
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
            className="form-control w-full"
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
            className="form-control w-full"
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
              className="form-control w-full"
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
              className="form-control w-full"
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
            className="form-control w-full"
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
            className="form-control w-full"
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
            className="form-control w-full pr-10"
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
            className="form-control w-full"
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
        <button type="button" className="mrp-btn" onClick={onCancel}>Отмена</button>
        <button type="submit" className="mrp-btn mrp-btn--primary">Сохранить</button>
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
  onSave: (p: Product, opts?: { attachSpecId?: string; detachSpecId?: string }) => void;
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
  specs?: Spec[];
  initialSpecId?: string;
};

function ProductForm({
  initial,
  onSave,
  onCancel,
  dicts,
  ensureUniqueCode,
  openSpecFor,
  specs,
  initialSpecId,
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

  const boxVolumeM3 = React.useMemo(() => {
    const l = Number(m.boxLength ?? 0);
    const w = Number(m.boxWidth ?? 0);
    const h = Number(m.boxHeight ?? 0);
    if (l <= 0 || w <= 0 || h <= 0) return null;
    return (l * w * h) / 1_000_000;
  }, [m.boxLength, m.boxWidth, m.boxHeight]);

  const unitWeight = Number(m.unitWeight ?? 0);
  const unitsPerBox = Number(m.unitsPerBox ?? 0);
  const boxWeightCalc = unitWeight > 0 && unitsPerBox > 0 ? unitWeight * unitsPerBox : null;
  const boxDensity = boxVolumeM3 && boxWeightCalc ? boxWeightCalc / boxVolumeM3 : null;
  const boxClass =
    boxDensity == null
      ? ""
      : boxDensity >= 200
        ? "Тяжёлый"
        : boxDensity >= 50
          ? "Нормальный"
          : "Лёгкий";

  const palletInfo = React.useMemo(() => {
    const l = Number(m.boxLength ?? 0);
    const w = Number(m.boxWidth ?? 0);
    const h = Number(m.boxHeight ?? 0);
    if (!boxVolumeM3 || l <= 0 || w <= 0 || h <= 0 || !boxWeightCalc) {
      return { maxBoxes: null, orientation: "" };
    }

    const PAL_W_CM = 120;
    const PAL_D_CM = 80;
    const PAL_TOTAL_H_CM = 180;
    const PAL_SELF_H_CM = 14;
    const PAL_AVAIL_H_CM = PAL_TOTAL_H_CM - PAL_SELF_H_CM;
    const PAL_VOL_M3 = 1.2 * 0.8 * 1.8;
    const PAL_MAX_KG = 500;

    const limVol = Math.floor(PAL_VOL_M3 / boxVolumeM3);
    const limKg = Math.floor(PAL_MAX_KG / boxWeightCalc);

    const perms = [
      { dims: [l, w, h], tag: "нормально" },
      { dims: [w, l, h], tag: "нормально" },
      { dims: [l, h, w], tag: "стоя" },
      { dims: [h, l, w], tag: "стоя" },
      { dims: [w, h, l], tag: "стоя" },
      { dims: [h, w, l], tag: "стоя" },
    ];

    let bestCnt = 0;
    let bestTag = "";
    let bestBase: [number, number] = [0, 0];

    perms.forEach((p) => {
      if (p.tag === "стоя" && (h * 2 < l || h * 2 < w)) return;

      const [d1, d2, d3] = p.dims;
      const baseCount =
        Math.floor(PAL_W_CM / d1) *
        Math.floor(PAL_D_CM / d2) *
        Math.floor(PAL_AVAIL_H_CM / d3);
      const cnt = Math.min(limVol, limKg, baseCount);

      if (cnt > bestCnt) {
        bestCnt = cnt;
        bestTag = p.tag;
        bestBase = [d1, d2];
      }
    });

    if (!bestCnt) return { maxBoxes: null, orientation: "" };

    return {
      maxBoxes: bestCnt,
      orientation:
        bestTag === "стоя"
          ? `стоя (основание: ${bestBase[0]}×${bestBase[1]})`
          : "нормально",
    };
  }, [m.boxLength, m.boxWidth, m.boxHeight, boxVolumeM3, boxWeightCalc]);

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
    const detachSpecId = !specId && initialSpecId ? initialSpecId : undefined;
    onSave({ ...m, code }, { attachSpecId: specId || undefined, detachSpecId });
  };

  const [specId, setSpecId] = React.useState<string>(initialSpecId || "");
  React.useEffect(() => setSpecId(initialSpecId || ""), [initialSpecId]);

  return (
    <form onSubmit={save}>
      <div className="form-grid-2">
        {/* Статус */}
        <div>
          <Label>Статус</Label>
          <select
            className="w-full mrp-select"
            value={m.status}
            onChange={(e) => setM({ ...m, status: e.target.value as any })}
          >
            {dicts.statuses.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        {/* Код */}
        <div>
          <Label>Артикул (code)</Label>
          <input
            className="form-control w-full"
            value={m.code}
            onChange={(e) => setM({ ...m, code: e.target.value })}
            placeholder="например PRD-1001"
          />
        </div>

        {/* Наименование + Спецификация */}
        <div className="form-span-2">
          <Label>Наименование</Label>
          <div className="flex gap-2">
            <input
              className="form-control flex-1"
              value={m.name}
              onChange={(e) => setM({ ...m, name: e.target.value })}
            />
            <button
              type="button"
              className="mrp-btn mrp-btn--ghost mrp-btn--xs"
              onClick={() => openSpecFor({ id: m.id || undefined, code: m.code, name: m.name })}
            >
              Спецификация…
            </button>
          </div>
        </div>

        {specs?.length ? (
          <div className="form-span-2">
            <Label>Спецификация (выбрать существующую)</Label>
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

        {/* Категория */}
        <div>
          <Label>Категория</Label>
          <div className="flex items-center gap-2">
            <select
              className="form-control w-full"
              value={m.category}
              onChange={(e) => setM({ ...m, category: e.target.value })}
            >
              <option value=""></option>
              {dicts.categories.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <button
              type="button"
              className="mrp-icon-btn"
              title="Добавить категорию"
              onClick={async () => {
                const name = prompt("Новая категория");
                if (name) await dicts.addCategory(name);
              }}
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Единица */}
        <div>
          <Label>Ед. изм.</Label>
          <div className="flex items-center gap-2">
            <select
              className="form-control w-full"
              value={m.uom}
              onChange={(e) => setM({ ...m, uom: e.target.value })}
            >
              {dicts.uoms.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
            <button
              type="button"
              className="mrp-icon-btn"
              title="Добавить единицу"
              onClick={async () => {
                const u = prompt("Новая единица");
                if (u) await dicts.addUom(u);
              }}
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Цена */}
        <div>
          <Label>Цена</Label>
          <div className="relative">
            <input
              type="number"
              step="0.01"
              className="form-control w-full pr-10"
              value={m.price ?? ""}
              onChange={(e) => {
                const raw = e.target.value;
                setM({ ...m, price: raw === "" ? undefined : Number(raw) });
              }}
              placeholder="0.00"
            />
            <span className="absolute right-3 top-2.5 text-slate-400 select-none">₽</span>
          </div>
        </div>

        {/* Маркетплейсы блок */}
        <div className="form-span-2 mt-2 text-sm font-semibold text-slate-600">Маркетплейсы</div>

        <div>
          <Label>SKU WB</Label>
          <input
            className="form-control w-full"
            value={m.wbSku ?? ""}
            onChange={(e) => setM({ ...m, wbSku: e.target.value || undefined })}
            placeholder="Например, WB123456"
          />
        </div>

        <div>
          <Label>SKU Ozon</Label>
          <input
            className="form-control w-full"
            value={m.ozonSku ?? ""}
            onChange={(e) => setM({ ...m, ozonSku: e.target.value || undefined })}
          />
        </div>

        <div>
          <Label>Штрихкод / EAN</Label>
          <input
            className="form-control w-full"
            value={m.barcode ?? ""}
            onChange={(e) => setM({ ...m, barcode: e.target.value || undefined })}
            placeholder="460…"
          />
        </div>

        <div>
          <Label>Категория WB</Label>
          <input
            className="form-control w-full"
            value={m.mpCategoryWb ?? ""}
            onChange={(e) => setM({ ...m, mpCategoryWb: e.target.value || undefined })}
            placeholder="Из классификатора WB"
          />
        </div>

        <div>
          <Label>Категория Ozon</Label>
          <input
            className="form-control w-full"
            value={m.mpCategoryOzon ?? ""}
            onChange={(e) => setM({ ...m, mpCategoryOzon: e.target.value || undefined })}
          />
        </div>

        {/* Упаковка */}
        <div className="form-span-2 mt-2 text-sm font-semibold text-slate-600">Упаковка</div>

        <div>
          <Label>Длина коробки, см</Label>
          <input
            type="number"
            step="0.1"
            className="form-control w-full"
            value={m.boxLength ?? ""}
            onChange={(e) => setM({ ...m, boxLength: parseNumber(e.target.value) })}
          />
        </div>

        <div>
          <Label>Ширина коробки, см</Label>
          <input
            type="number"
            step="0.1"
            className="form-control w-full"
            value={m.boxWidth ?? ""}
            onChange={(e) => setM({ ...m, boxWidth: parseNumber(e.target.value) })}
          />
        </div>

        <div>
          <Label>Высота коробки, см</Label>
          <input
            type="number"
            step="0.1"
            className="form-control w-full"
            value={m.boxHeight ?? ""}
            onChange={(e) => setM({ ...m, boxHeight: parseNumber(e.target.value) })}
          />
        </div>

        <div>
          <Label>Вес 1 шт, кг</Label>
          <input
            type="number"
            step="0.001"
            className="form-control w-full"
            value={m.unitWeight ?? ""}
            onChange={(e) => setM({ ...m, unitWeight: parseNumber(e.target.value) })}
          />
        </div>

        <div>
          <Label>Вес коробки, кг (расчёт)</Label>
          <input
            className="form-control w-full"
            value={boxWeightCalc == null ? "" : boxWeightCalc.toFixed(3)}
            placeholder="—"
            readOnly
          />
        </div>

        <div>
          <Label>Объём короба, м³</Label>
          <input
            className="form-control w-full"
            value={boxVolumeM3 == null ? "" : boxVolumeM3.toFixed(4)}
            placeholder="—"
            readOnly
          />
        </div>

        <div>
          <Label>Характеристика короба</Label>
          <input
            className="form-control w-full"
            value={boxClass}
            placeholder="—"
            readOnly
          />
        </div>

        <div>
          <Label>Коробов на паллете (расчёт)</Label>
          <input
            className="form-control w-full"
            value={palletInfo.maxBoxes == null ? "" : String(palletInfo.maxBoxes)}
            placeholder="—"
            readOnly
          />
        </div>

        <div>
          <Label>Ориентация короба (расчёт)</Label>
          <input
            className="form-control w-full"
            value={palletInfo.orientation}
            placeholder="—"
            readOnly
          />
        </div>

        <div>
          <Label>Штук в коробке</Label>
          <input
            type="number"
            step="1"
            className="form-control w-full"
            value={m.unitsPerBox ?? ""}
            onChange={(e) => setM({ ...m, unitsPerBox: parseNumber(e.target.value) })}
          />
        </div>

        <div>
          <Label>Штук на паллете</Label>
          <input
            type="number"
            step="1"
            className="form-control w-full"
            value={m.unitsPerPallet ?? ""}
            onChange={(e) => setM({ ...m, unitsPerPallet: parseNumber(e.target.value) })}
          />
        </div>

        <div>
          <Label>Вес паллеты, кг</Label>
          <input
            type="number"
            step="0.1"
            className="form-control w-full"
            value={m.palletWeight ?? ""}
            onChange={(e) => setM({ ...m, palletWeight: parseNumber(e.target.value) })}
          />
        </div>
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <button type="button" className="mrp-btn" onClick={onCancel}>Отмена</button>
        <button type="submit" className="mrp-btn mrp-btn--primary">Сохранить</button>
      </div>
    </form>
  );
}


/* ===================== PRODUCTS VIEW ===================== */
function ProductsView() {
  type StockRow = { itemId: string; warehouseId: string; qty: number };
  type ProductsCache = {
    items?: Product[];
    warehouses?: Warehouse[];
    stockRows?: StockRow[];
    tsItems?: number;
    tsWarehouses?: number;
    tsStock?: number;
  };
  const PRODUCTS_CACHE_KEY = "mrp.products.cache.v1";
  const PRODUCTS_CACHE_STATIC_TTL = 30 * 60 * 1000;
  const PRODUCTS_CACHE_DYNAMIC_TTL = 2 * 60 * 1000;
  const readProductsCache = (): ProductsCache | null => {
    try {
      const raw = localStorage.getItem(PRODUCTS_CACHE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as ProductsCache;
    } catch {
      return null;
    }
  };
  const writeProductsCache = (patch: Partial<ProductsCache>) => {
    const now = Date.now();
    const current = readProductsCache() || {};
    const next: ProductsCache = { ...current, ...patch };
    if (patch.items) next.tsItems = now;
    if (patch.warehouses) next.tsWarehouses = now;
    if (patch.stockRows) next.tsStock = now;
    try {
      localStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify(next));
    } catch {}
  };
  const isProductsStaticFresh = (
    cache: ProductsCache | null,
    key: "items" | "warehouses"
  ) => {
    const ts = key === "items" ? cache?.tsItems : cache?.tsWarehouses;
    return typeof ts === "number" && Date.now() - ts < PRODUCTS_CACHE_STATIC_TTL;
  };
  const isProductsDynamicFresh = (cache: ProductsCache | null) => {
    const ts = cache?.tsStock;
    return typeof ts === "number" && Date.now() - ts < PRODUCTS_CACHE_DYNAMIC_TTL;
  };
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
    p.id ? specs.find((s) => s.productId === p.id) : undefined;
  const unlinkSpecsForProduct = React.useCallback(
    async (productId: string) => {
      if (!productId) return;
      const { error } = await supabase
        .from("specs")
        .update({
          linked_product_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq("linked_product_id", productId);
      if (error) {
        console.error("Ошибка отвязки спецификаций:", error);
        alert("Не удалось отвязать спецификации, смотри консоль");
        return;
      }
      await syncSpecs();
    },
    [syncSpecs],
  );
  const linkSpecToProduct = React.useCallback(
    async (specId: string, product: Product) => {
      if (!specId) return;
      const productId = product?.id?.trim();
      if (!productId) return;
      const { error: unlinkError } = await supabase
        .from("specs")
        .update({
          linked_product_id: null,
          updated_at: new Date().toISOString(),
        })
        .eq("linked_product_id", productId)
        .neq("id", specId);
      if (unlinkError) {
        console.error("Ошибка отвязки старых спецификаций:", unlinkError);
        alert("Не удалось отвязать старые спецификации, смотри консоль");
        return;
      }
      const { error } = await supabase
        .from("specs")
        .update({
          linked_product_id: productId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", specId);
      if (error) {
        console.error("Ошибка привязки спецификации:", error);
        alert("Не удалось привязать спецификацию, смотри консоль");
        return;
      }
      await syncSpecs();
    },
    [syncSpecs],
  );

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
    const cache = readProductsCache();
    if (isProductsStaticFresh(cache, "warehouses") && Array.isArray(cache?.warehouses)) {
      setWarehouses(cache.warehouses);
      return;
    }
    const { data, error } = await supabase
      .from("warehouses")
      .select("id, name, type, parent_id, is_active, is_default")
      .order("name", { ascending: true });
    if (error) {
      console.error("ProductsView load warehouses", error);
      return;
    }
    const mapped: Warehouse[] = (data || []).map((row: any) => ({
      id: row.id,
      name: row.name,
      type: row.type === "physical" ? "physical" : "virtual",
      parentId: row.parent_id,
      isActive: row.is_active ?? true,
      isDefault: row.is_default ?? false,
    }));
    setWarehouses(mapped);
    writeProductsCache({ warehouses: mapped });
  }, []);

  const loadStockBalances = useCallback(async (force = false) => {
    const cache = readProductsCache();
    if (!force && isProductsDynamicFresh(cache) && Array.isArray(cache?.stockRows)) {
      setStockRows(cache.stockRows);
      return;
    }
    const { data, error } = await supabase
      .from("stock_balances")
      .select("item_id, warehouse_id, qty");
    if (error) {
      console.error("ProductsView load stock_balances", error);
      return;
    }
    const mapped = (data || []).map((row: any) => ({
      itemId: row.item_id,
      warehouseId: row.warehouse_id,
      qty: Number(row.qty) || 0,
    }));
    setStockRows(mapped);
    writeProductsCache({ stockRows: mapped });
  }, []);

  const loadProducts = useCallback(async (force = false) => {
    const cache = readProductsCache();
    if (!force && isProductsStaticFresh(cache, "items") && Array.isArray(cache?.items)) {
      setItems(cache.items);
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("items")
        .select(
          "id, status, code, name, category, uom, price, wb_sku, ozon_sku, barcode, mp_category_wb, mp_category_ozon, box_length, box_width, box_height, box_volume, unit_weight, box_weight, units_per_box, units_per_pallet, pallet_weight"
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
        boxVolume: row.box_volume ?? undefined,
        unitWeight: row.unit_weight ?? undefined,
        boxWeight: row.box_weight ?? undefined,
        unitsPerBox: row.units_per_box ?? undefined,
        unitsPerPallet: row.units_per_pallet ?? undefined,
        palletWeight: row.pallet_weight ?? undefined,
      }));
      setItems(mapped);
      writeProductsCache({ items: mapped });
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
    loadStockBalances(true);
  };

  const openCreate = () => {
    setEditing(null);
    setProdModalOpen(true);
  };
  const openEdit = (p: Product) => {
    setEditing(p);
    setProdModalOpen(true);
  };

  useEffect(() => {
    const raw = localStorage.getItem("mrp.openProductId");
    if (!raw || !items.length) return;
    let key = raw;
    try { key = JSON.parse(raw); } catch {}
    const target = items.find((p) => p.id === key || p.code === key);
    if (target) {
      localStorage.removeItem("mrp.openProductId");
      openEdit(target);
    }
  }, [items]);

  const saveProduct = async (
    p: Product,
    opts?: { attachSpecId?: string; detachSpecId?: string }
  ) => {
    const id = p.id && isUuid(p.id) ? p.id : generateUuid();
    const unitWeight = Number(p.unitWeight ?? 0);
    const unitsPerBox = Number(p.unitsPerBox ?? 0);
    const boxWeightCalc = unitWeight > 0 && unitsPerBox > 0 ? unitWeight * unitsPerBox : null;
    const boxVolumeCalc =
      p.boxLength && p.boxWidth && p.boxHeight
        ? (Number(p.boxLength) * Number(p.boxWidth) * Number(p.boxHeight)) / 1_000_000
        : null;
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
      box_volume: boxVolumeCalc,
      unit_weight: p.unitWeight ?? null,
      box_weight: boxWeightCalc,
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
    if (!opts?.attachSpecId && id) {
      await unlinkSpecsForProduct(id);
    } else if (opts?.detachSpecId && opts.detachSpecId !== opts.attachSpecId) {
      await unlinkSpecsForProduct(id);
    }
    if (opts?.attachSpecId) {
      await linkSpecToProduct(opts.attachSpecId, { ...p, id });
    }
    setProdModalOpen(false);
    await loadProducts(true);
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
    await loadProducts(true);
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

  const warehouseTypeById: Record<string, Warehouse["type"]> = React.useMemo(() => {
    const lookup: Record<string, Warehouse["type"]> = {};
    warehouses.forEach((w) => {
      lookup[w.id] = w.type;
    });
    return lookup;
  }, [warehouses]);

  const stockByPhysical = React.useMemo(() => {
    const res = new Map<string, Map<string, number>>();
    physicalWarehouses.forEach((phys) => res.set(phys.id, new Map()));
    for (const row of stockRows) {
      if (!productIds.has(row.itemId)) continue;
      const whType = warehouseTypeById[row.warehouseId];
      const physId = whType === "physical" ? row.warehouseId : parentByWarehouse[row.warehouseId];
      if (!physId || !res.has(physId)) continue;
      const map = res.get(physId)!;
      map.set(row.itemId, (map.get(row.itemId) ?? 0) + row.qty);
    }
    return res;
  }, [stockRows, physicalWarehouses, parentByWarehouse, productIds, warehouseTypeById]);

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
            specs={specs}
            initialSpecId={editing ? findSpecForProduct(editing)?.id : undefined}
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
  const [avatarOpen, setAvatarOpen] = useState(false);
  const avatarRef = useRef<HTMLDivElement | null>(null);

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

  const userLabel = profile?.email ?? session?.user?.email ?? "";
  const permissions = useMemo(() => new Set((profile?.permissions ?? []).filter(Boolean)), [profile?.permissions]);
  const isAdmin = profile?.role === "admin";
  const hasPermission = useCallback(
    (perm: string) =>
      isAdmin ||
      permissions.has(perm) ||
      permissions.has(`${perm}.read`) ||
      permissions.has(`${perm}.write`),
    [isAdmin, permissions],
  );

  const canAccessMarketplaces = useMemo(
    () =>
      hasPermission("sales.marketplaces.wb") ||
      hasPermission("sales.marketplaces.ozon") ||
      hasPermission("sales.marketplaces.reports"),
    [hasPermission],
  );
  const canAccessWb = useMemo(
    () => hasPermission("sales.marketplaces.wb"),
    [hasPermission],
  );
  const canAccessOzon = useMemo(
    () => hasPermission("sales.marketplaces.ozon"),
    [hasPermission],
  );
  const userInitials = useMemo(() => {
    const raw = (userLabel ?? "").trim();
    if (!raw) return "U";
    const namePart = raw.split("@")[0];
    const parts = namePart.split(/[.\s_-]+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
    }
    return namePart.slice(0, 2).toUpperCase();
  }, [userLabel]);

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
          .select("id,email,phone,is_active,role,permissions")
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
            .select("id,email,phone,is_active,role,permissions")
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

  useEffect(() => {
    if (!profile) return;
    const canSee = (subKey: string) => {
      if (isAdmin) return true;
      if (subKey === "mp") return canAccessMarketplaces;
      if (subKey === "wbwh") return canAccessWb;
      const perm = PERMISSION_BY_SUBKEY[subKey];
      return perm ? hasPermission(perm) : true;
    };
    const next = DEFAULT_NAV
      .map((section) => ({
        ...section,
        subs: (section.subs ?? []).filter((sub) => canSee(sub.key)),
      }))
      .filter((section) => (section.subs ?? []).length > 0);
    setNav(next.length ? next : DEFAULT_NAV);
  }, [profile, isAdmin, canAccessMarketplaces, canAccessWb, hasPermission, setNav]);

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

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setAvatarOpen(false);
  };

  const handleSwitchAccount = async () => {
    await supabase.auth.signOut();
    setAuthEmail("");
    setAuthPassword("");
    setAuthMode("signin");
    setAvatarOpen(false);
  };

  useEffect(() => {
    if (!avatarOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (!avatarRef.current) return;
      if (event.target instanceof Node && !avatarRef.current.contains(event.target)) {
        setAvatarOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [avatarOpen]);

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
      <div className="ml-2 flex items-center gap-2">
        <svg
          width="200"
          height="38"
          viewBox="0 0 200 38"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-label="SellSys"
        >
          <rect x="0" y="2" width="3" height="34" fill="#6C63FF" />
          <text
            x="12"
            y="18"
            fontFamily="Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
            fontSize="20"
            fontWeight="600"
            letterSpacing="1.5"
            fill="#E8ECFF"
          >
            SellSys
          </text>
          <text
            x="12"
            y="35"
            fontFamily="Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
            fontSize="11"
            fontWeight="500"
            letterSpacing="0.4"
            fill="#9AA3C7"
          >
            Системное управление
          </text>
        </svg>
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
              <div className="mrp-avatar-wrap" ref={avatarRef}>
                <button
                  type="button"
                  className="mrp-avatar-btn"
                  onClick={() => setAvatarOpen((prev) => !prev)}
                  aria-haspopup="menu"
                  aria-expanded={avatarOpen}
                >
                  <span className="mrp-avatar">{userInitials}</span>
                </button>
                {avatarOpen && (
                  <div className="mrp-avatar-menu" role="menu">
                    <div className="mrp-avatar-meta">
                      <div className="mrp-avatar-name">{userLabel || "Пользователь"}</div>
                    </div>
                    <button type="button" className="mrp-avatar-item" onClick={handleSwitchAccount}>
                      Сменить аккаунт
                    </button>
                    <button type="button" className="mrp-avatar-item is-danger" onClick={handleSignOut}>
                      Выйти
                    </button>
                  </div>
                )}
              </div>
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
          ) : currentSection?.key === "stock" && activeSubKey === "moves" ? (
            <StockMovesView />
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
            <MarketplacesView
              isAdmin={isAdmin}
              canWb={hasPermission("sales.marketplaces.wb")}
              canOzon={hasPermission("sales.marketplaces.ozon")}
              canReports={hasPermission("sales.marketplaces.reports")}
            />
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
          ) : currentSection?.key === "settings" && activeSubKey === "users" ? (
            <SettingsUsers isAdmin={isAdmin} />
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
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"add" | "rename">("add");
  const [modalValue, setModalValue] = useState("");
  const [renameTarget, setRenameTarget] = useState<string | null>(null);

  const add = () => {
    setModalMode("add");
    setModalValue("");
    setRenameTarget(null);
    setModalOpen(true);
  };
  const rename = (val: string) => {
    if (!allowRename) return;
    setModalMode("rename");
    setModalValue(val);
    setRenameTarget(val);
    setModalOpen(true);
  };
  const remove = (val: string) => {
    if (!window.confirm(`Удалить «${val}»?`)) return;
    setItems(prev => prev.filter(x => x !== val));
  };
  const handleSubmit = () => {
    const v = modalValue.trim();
    if (!v) return;
    if (modalMode === "add") {
      setItems(prev => (prev.includes(v) ? prev : [...prev, v]));
    } else if (renameTarget) {
      setItems(prev => prev.map(x => (x === renameTarget ? v : x)));
    }
    setModalOpen(false);
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

      <InputModal
        open={modalOpen}
        title={modalMode === "add" ? title : "Переименование"}
        label={modalMode === "add" ? title : "Новое значение"}
        placeholder={modalMode === "add" ? placeholder : renameTarget ?? ""}
        value={modalValue}
        onChange={setModalValue}
        onClose={() => setModalOpen(false)}
        onSubmit={handleSubmit}
        submitLabel={modalMode === "add" ? "Добавить" : "Сохранить"}
      />
    </div>
  );
}


function SettingsUoms() {
  const { uoms, addUom, renameUom, removeUom } = useSupabaseUoms();

  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"add" | "rename">("add");
  const [modalValue, setModalValue] = useState("");
  const [target, setTarget] = useState<{ id?: string; current?: string }>({});

  const handleAdd = () => {
    setModalMode("add");
    setModalValue("");
    setTarget({});
    setModalOpen(true);
  };
  const handleRename = (id: string, current: string) => {
    setModalMode("rename");
    setModalValue(current);
    setTarget({ id, current });
    setModalOpen(true);
  };
  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Удалить «${name}»?`)) return;
    await removeUom(id);
  };
  const handleSubmit = async () => {
    const value = modalValue.trim();
    if (!value) return;
    if (modalMode === "add") {
      await addUom(value);
    } else if (target.id && value !== target.current) {
      await renameUom(target.id, value);
    }
    setModalOpen(false);
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

      <InputModal
        open={modalOpen}
        title={modalMode === "add" ? "Новая единица измерения" : "Переименование"}
        label={modalMode === "add" ? "Единица измерения" : "Новое название"}
        placeholder={modalMode === "add" ? "Например: кг" : target.current}
        value={modalValue}
        onChange={setModalValue}
        onClose={() => setModalOpen(false)}
        onSubmit={handleSubmit}
        submitLabel={modalMode === "add" ? "Добавить" : "Сохранить"}
      />
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

  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"add" | "rename">("add");
  const [modalValue, setModalValue] = useState("");
  const [target, setTarget] = useState<{ id?: string; current?: string }>({});

  const handleAdd = () => {
    setModalMode("add");
    setModalValue("");
    setTarget({});
    setModalOpen(true);
  };
  const handleRename = (id: string, current: string) => {
    setModalMode("rename");
    setModalValue(current);
    setTarget({ id, current });
    setModalOpen(true);
  };
  const handleRemove = async (id: string, name: string) => {
    if (!window.confirm(`Удалить группу «${name}»?`)) return;
    await removeGroup(id, name);
  };
  const handleSubmit = async () => {
    const v = modalValue.trim();
    if (!v) return;
    if (modalMode === "add") {
      await addGroup(v);
    } else if (target.id && v !== target.current) {
      await renameGroup(target.id, target.current ?? "", v);
    }
    setModalOpen(false);
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

      <InputModal
        open={modalOpen}
        title={modalMode === "add" ? "Новая группа" : "Переименование"}
        label={modalMode === "add" ? "Группа" : "Новое название"}
        placeholder={modalMode === "add" ? "Например: Химия" : target.current}
        value={modalValue}
        onChange={setModalValue}
        onClose={() => setModalOpen(false)}
        onSubmit={handleSubmit}
        submitLabel={modalMode === "add" ? "Добавить" : "Сохранить"}
      />
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

  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"add" | "rename">("add");
  const [modalValue, setModalValue] = useState("");
  const [target, setTarget] = useState<{ id?: string; current?: string }>({});

  const handleAdd = () => {
    setModalMode("add");
    setModalValue("");
    setTarget({});
    setModalOpen(true);
  };
  const handleRename = (id: string, current: string) => {
    setModalMode("rename");
    setModalValue(current);
    setTarget({ id, current });
    setModalOpen(true);
  };
  const handleRemove = async (id: string, name: string) => {
    if (!window.confirm(`Удалить «${name}»?`)) return;
    await removeCategory(id);
  };
  const handleSubmit = async () => {
    const v = modalValue.trim();
    if (!v) return;
    if (modalMode === "add") {
      await addCategory(v);
    } else if (target.id && v !== target.current) {
      await renameCategory(target.id, v);
    }
    setModalOpen(false);
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

      <InputModal
        open={modalOpen}
        title={modalMode === "add" ? "Новая категория" : "Переименование"}
        label={modalMode === "add" ? "Категория" : "Новое название"}
        placeholder={modalMode === "add" ? "Например: Посуда" : target.current}
        value={modalValue}
        onChange={setModalValue}
        onClose={() => setModalOpen(false)}
        onSubmit={handleSubmit}
        submitLabel={modalMode === "add" ? "Добавить" : "Сохранить"}
      />
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
    updateWarehouse,
    deleteWarehouse,
    setDefaultWarehouse,
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
  const [whModalOpen, setWhModalOpen] = useState(false);
  const [whModalMode, setWhModalMode] = useState<"addPhysical" | "addZone" | "rename" | "chat">("addPhysical");
  const [whModalValue, setWhModalValue] = useState("");
  const [whTarget, setWhTarget] = useState<{ id?: string; current?: string; physId?: string; tgChatId?: string | null }>({});

  const handleRename = (id: string, curName: string) => {
    setWhModalMode("rename");
    setWhModalValue(curName);
    setWhTarget({ id, current: curName });
    setWhModalOpen(true);
  };
  const handleChat = (id: string, tgChatId: string | null) => {
    setWhModalMode("chat");
    setWhModalValue(tgChatId ?? "");
    setWhTarget({ id, tgChatId });
    setWhModalOpen(true);
  };
  const handleAddPhysical = () => {
    setWhModalMode("addPhysical");
    setWhModalValue("");
    setWhTarget({});
    setWhModalOpen(true);
  };
  const handleAddZone = (physId: string) => {
    setWhModalMode("addZone");
    setWhModalValue("");
    setWhTarget({ physId });
    setWhModalOpen(true);
  };
  const handleWhSubmit = async () => {
    const name = whModalValue.trim();
    if (whModalMode === "addPhysical") {
      if (!name) return;
      await addPhysical(name);
    } else if (whModalMode === "addZone") {
      if (!name) return;
      if (!whTarget.physId) return;
      await addZone(whTarget.physId, name);
    } else if (whModalMode === "rename") {
      if (!name) return;
      if (!whTarget.id || name === whTarget.current) return;
      await renameWarehouse(whTarget.id, name);
    } else if (whModalMode === "chat") {
      if (!whTarget.id) return;
      const next = name ? name : null;
      await updateWarehouse(whTarget.id, { tgChatId: next });
    }
    setWhModalOpen(false);
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
              <th className="text-left px-2 py-1 w-[110px]">Основной</th>
              <th className="text-left px-2 py-1 w-[160px]">TG чат ID</th>
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
                    <label className="flex items-center gap-2 text-xs text-slate-600">
                      <input
                        type="radio"
                        name="default-warehouse"
                        checked={p.isDefault}
                        onChange={() => setDefaultWarehouse(p.id)}
                      />
                      По умолчанию
                    </label>
                  </td>
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-600">{p.tgChatId || "—"}</span>
                      <button
                        className="mrp-btn mrp-btn--ghost mrp-btn--xs"
                        type="button"
                        onClick={() => handleChat(p.id, p.tgChatId)}
                      >
                        Изменить
                      </button>
                    </div>
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
            {physical.length === 0 && <tr><td colSpan={5} className="px-2 py-4 text-center text-slate-400">Пока нет складов</td></tr>}
          </tbody>
        </table>
        </div>
      </div>

      <InputModal
        open={whModalOpen}
        title={
          whModalMode === "addPhysical"
            ? "Физический склад"
            : whModalMode === "addZone"
              ? "Новая зона"
              : whModalMode === "rename"
                ? "Переименование"
                : "Telegram чат"
        }
        label={
          whModalMode === "addPhysical"
            ? "Название склада"
            : whModalMode === "addZone"
              ? "Название зоны"
              : whModalMode === "rename"
                ? "Новое название"
                : "Chat ID"
        }
        placeholder={whModalMode === "rename" ? whTarget.current : undefined}
        value={whModalValue}
        onChange={setWhModalValue}
        onClose={() => setWhModalOpen(false)}
        onSubmit={handleWhSubmit}
        submitLabel={whModalMode === "rename" || whModalMode === "chat" ? "Сохранить" : "Добавить"}
      />
    </div>
  );
}

function SettingsUsers({ isAdmin }: { isAdmin: boolean }) {
  type TgUser = {
    id: string;
    tg_user_id: number | null;
    username: string | null;
    first_name: string | null;
    last_name: string | null;
    role: "executor" | "controller";
    status: "pending" | "active" | "disabled";
    is_global_controller: boolean;
  };

  const [users, setUsers] = useState<TgUser[]>([]);
  const [appUsers, setAppUsers] = useState<Array<Profile & { last_sign_in_at?: string | null }>>([]);
  const [permDirty, setPermDirty] = useState<Record<string, boolean>>({});
  const [permQuery, setPermQuery] = useState("");
  const [permRoleFilter, setPermRoleFilter] = useState<
    "all" | "admin" | "marketplace_wb" | "marketplace_ozon" | "purchasing" | "sales" | "dealer"
  >("all");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [bindings, setBindings] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newRole, setNewRole] = useState<"executor" | "controller">("controller");
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const { warehouses, physical, virtual } = useSupabaseWarehouses();
  type RoleKey = "admin" | "marketplace_wb" | "marketplace_ozon" | "purchasing" | "sales" | "dealer";
  type PermissionItem = { key: string; label: string; readKey: string; writeKey?: string | null };
  type PermissionGroup = { key: string; title: string; items: PermissionItem[] };

  const ROLE_LABELS: Record<RoleKey, string> = {
    admin: "Админ",
    marketplace_wb: "Маркетплейс WB",
    marketplace_ozon: "Маркетплейс Ozon",
    purchasing: "Закупки",
    sales: "Продажи",
    dealer: "Дилер",
  };

  const ROLE_PRESETS: Record<RoleKey, string[]> = {
    admin: [],
    marketplace_wb: [
      "sales.marketplaces.wb.read",
      "sales.marketplaces.wb.write",
      "sales.marketplaces.reports.read",
    ],
    marketplace_ozon: [
      "sales.marketplaces.ozon.read",
      "sales.marketplaces.ozon.write",
      "sales.marketplaces.reports.read",
    ],
    purchasing: [
      "purchase.products.read",
      "purchase.products.write",
      "purchase.materials.read",
      "purchase.materials.write",
      "purchase.semis.read",
      "purchase.semis.write",
      "purchase.vendors.read",
      "purchase.vendors.write",
      "purchase.po.read",
      "purchase.po.write",
      "purchase.receipts.read",
      "purchase.receipts.write",
      "stock.balances.read",
    ],
    sales: [
      "sales.forecast.read",
      "sales.prices.read",
      "sales.marketplaces.wb.read",
      "sales.marketplaces.ozon.read",
      "sales.marketplaces.reports.read",
      "sales.wbwh.read",
    ],
    dealer: [
      "reports.dashboard.read",
      "stock.balances.read",
      "sales.forecast.read",
      "sales.prices.read",
    ],
  };

  const permissionsCatalog = useMemo<PermissionGroup[]>(
    () => [
      {
        key: "sales",
        title: "Продажи",
        items: [
          { key: "sales.forecast", label: "Прогноз", readKey: "sales.forecast.read", writeKey: "sales.forecast.write" },
          { key: "sales.prices", label: "Цены/Прайсы", readKey: "sales.prices.read", writeKey: "sales.prices.write" },
          { key: "sales.marketplaces.wb", label: "Маркетплейсы • WB", readKey: "sales.marketplaces.wb.read", writeKey: "sales.marketplaces.wb.write" },
          { key: "sales.marketplaces.ozon", label: "Маркетплейсы • Ozon", readKey: "sales.marketplaces.ozon.read", writeKey: "sales.marketplaces.ozon.write" },
          { key: "sales.marketplaces.reports", label: "Маркетплейс‑отчёты", readKey: "sales.marketplaces.reports.read" },
          { key: "sales.wbwh", label: "Склады WB", readKey: "sales.wbwh.read", writeKey: "sales.wbwh.write" },
        ],
      },
      {
        key: "purchase",
        title: "Закупки",
        items: [
          { key: "purchase.products", label: "Товары", readKey: "purchase.products.read", writeKey: "purchase.products.write" },
          { key: "purchase.materials", label: "Материалы", readKey: "purchase.materials.read", writeKey: "purchase.materials.write" },
          { key: "purchase.semis", label: "Полуфабрикаты", readKey: "purchase.semis.read", writeKey: "purchase.semis.write" },
          { key: "purchase.vendors", label: "Поставщики", readKey: "purchase.vendors.read", writeKey: "purchase.vendors.write" },
          { key: "purchase.po", label: "Заказы поставщикам", readKey: "purchase.po.read", writeKey: "purchase.po.write" },
          { key: "purchase.receipts", label: "Поступления", readKey: "purchase.receipts.read", writeKey: "purchase.receipts.write" },
        ],
      },
      {
        key: "mfg",
        title: "Производство",
        items: [
          { key: "mfg.plan", label: "План партии", readKey: "mfg.plan.read", writeKey: "mfg.plan.write" },
          { key: "mfg.prodReports", label: "Отчёты о производстве", readKey: "mfg.prodReports.read", writeKey: "mfg.prodReports.write" },
          { key: "mfg.specs", label: "Спецификации", readKey: "mfg.specs.read", writeKey: "mfg.specs.write" },
          { key: "mfg.writeoff", label: "Списания", readKey: "mfg.writeoff.read", writeKey: "mfg.writeoff.write" },
        ],
      },
      {
        key: "stock",
        title: "Склад",
        items: [
          { key: "stock.balances", label: "Остатки", readKey: "stock.balances.read" },
          { key: "stock.moves", label: "Перемещения", readKey: "stock.moves.read", writeKey: "stock.moves.write" },
          { key: "stock.count", label: "Инвентаризация", readKey: "stock.count.read", writeKey: "stock.count.write" },
        ],
      },
      {
        key: "reports",
        title: "Отчёты",
        items: [
          { key: "reports.dashboard", label: "Дашборд", readKey: "reports.dashboard.read" },
          { key: "reports.kpi", label: "KPI", readKey: "reports.kpi.read" },
        ],
      },
      {
        key: "settings",
        title: "Настройки",
        items: [
          { key: "settings.uom", label: "Единицы", readKey: "settings.uom.read", writeKey: "settings.uom.write" },
          { key: "settings.curr", label: "Валюты", readKey: "settings.curr.read", writeKey: "settings.curr.write" },
          { key: "settings.cats", label: "Категории", readKey: "settings.cats.read", writeKey: "settings.cats.write" },
          { key: "settings.groups", label: "Группы", readKey: "settings.groups.read", writeKey: "settings.groups.write" },
          { key: "settings.wh", label: "Склады", readKey: "settings.wh.read", writeKey: "settings.wh.write" },
          { key: "settings.mpwh", label: "МП склады", readKey: "settings.mpwh.read", writeKey: "settings.mpwh.write" },
          { key: "settings.users", label: "Пользователи/Роли", readKey: "settings.users.read", writeKey: "settings.users.write" },
          { key: "settings.integrations", label: "Интеграции", readKey: "settings.integrations.read", writeKey: "settings.integrations.write" },
          { key: "settings.nums", label: "Нумераторы", readKey: "settings.nums.read", writeKey: "settings.nums.write" },
        ],
      },
    ],
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("tg_users")
        .select("id, tg_user_id, username, first_name, last_name, role, status, is_global_controller")
        .order("created_at", { ascending: false });
      if (error) throw error;
      setUsers((data || []) as TgUser[]);
      if (isAdmin) {
        const { data: authUsers, error: authErr } = await supabase.rpc("list_auth_users");
        if (authErr) throw authErr;
        const authList = (authUsers || []) as Array<{ id: string; email: string | null; phone: string | null; last_sign_in_at?: string | null }>;
        const ids = authList.map((u) => u.id);
        const { data: profiles, error: profErr } = await supabase
          .from("profiles")
          .select("id,email,phone,is_active,role,permissions")
          .in("id", ids);
        if (profErr) throw profErr;
        const profileMap = new Map((profiles || []).map((p: any) => [p.id, p]));
        const merged = authList.map((u) => {
          const p = profileMap.get(u.id);
          return {
            id: u.id,
            email: u.email ?? p?.email ?? null,
            phone: u.phone ?? p?.phone ?? null,
            is_active: p?.is_active ?? true,
            role: p?.role ?? "dealer",
            permissions: p?.permissions ?? [],
            last_sign_in_at: u.last_sign_in_at ?? null,
          } as Profile & { last_sign_in_at?: string | null };
        });
        setAppUsers(merged);
      } else {
        setAppUsers([]);
      }
      const { data: linkRows, error: linkErr } = await supabase
        .from("tg_user_warehouses")
        .select("tg_user_id, warehouse_id, is_active");
      if (linkErr) throw linkErr;
      const nextBindings: Record<string, string[]> = {};
      (linkRows || []).forEach((row: any) => {
        if (!row.is_active) return;
        if (!nextBindings[row.tg_user_id]) nextBindings[row.tg_user_id] = [];
        nextBindings[row.tg_user_id].push(row.warehouse_id);
      });
      setBindings(nextBindings);
    } catch (error) {
      console.error("SettingsUsers: load tg_users", error);
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleAdd = async () => {
    const username = newUsername.trim().replace(/^@/, "");
    if (!username) return;
    try {
      const { error } = await supabase.from("tg_users").insert({
        username,
        role: newRole,
        status: "pending",
      });
      if (error) throw error;
      setNewUsername("");
      await refresh();
    } catch (error) {
      console.error("SettingsUsers: add", error);
      alert("Не удалось добавить пользователя");
    }
  };

  const notifyController = async (userId: string, warehouseIds: string[]) => {
    if (!warehouseIds.length) return;
    try {
      await Promise.all(
        warehouseIds.map((warehouseId) =>
          supabase.functions.invoke("tg-notify-controller", {
            body: { tgUserId: userId, warehouseId },
          }),
        ),
      );
    } catch (error) {
      console.error("SettingsUsers: notify controller", error);
    }
  };

  const handleUpdate = async (id: string, patch: Partial<TgUser>) => {
    try {
      const { error } = await supabase.from("tg_users").update(patch).eq("id", id);
      if (error) throw error;
      if (patch.role === "controller") {
        const currentBindings = bindings[id] || [];
        await notifyController(id, currentBindings);
      }
      await refresh();
    } catch (error) {
      console.error("SettingsUsers: update", error);
      alert("Не удалось обновить пользователя");
    }
  };

  const handleRemove = async (id: string) => {
    if (!window.confirm("Удалить пользователя?")) return;
    try {
      const { error } = await supabase.from("tg_users").delete().eq("id", id);
      if (error) throw error;
      await refresh();
    } catch (error) {
      console.error("SettingsUsers: delete", error);
      alert("Не удалось удалить пользователя");
    }
  };

  const handleToggleWarehouse = async (userId: string, warehouseId: string, checked: boolean) => {
    try {
      if (checked) {
        const { error } = await supabase
          .from("tg_user_warehouses")
          .upsert({ tg_user_id: userId, warehouse_id: warehouseId, is_active: true }, { onConflict: "tg_user_id,warehouse_id" });
        if (error) throw error;
        setBindings((prev) => ({
          ...prev,
          [userId]: Array.from(new Set([...(prev[userId] || []), warehouseId])),
        }));
        const user = users.find((u) => u.id === userId);
        if (user?.role === "controller") {
          await notifyController(userId, [warehouseId]);
        }
      } else {
        const { error } = await supabase
          .from("tg_user_warehouses")
          .delete()
          .match({ tg_user_id: userId, warehouse_id: warehouseId });
        if (error) throw error;
        setBindings((prev) => ({
          ...prev,
          [userId]: (prev[userId] || []).filter((id) => id !== warehouseId),
        }));
      }
    } catch (error) {
      console.error("SettingsUsers: toggle warehouse", error);
      alert("Не удалось обновить привязку склада");
    }
  };

  const updateUserPermissions = (userId: string, updater: (current: Set<string>) => void) => {
    setAppUsers((prev) =>
      prev.map((u) => {
        if (u.id !== userId) return u;
        const current = new Set(u.permissions ?? []);
        updater(current);
        return { ...u, permissions: Array.from(current) };
      }),
    );
    setPermDirty((prev) => ({ ...prev, [userId]: true }));
  };

  const toggleRead = (userId: string, readKey: string, writeKey: string | null | undefined, checked: boolean) => {
    updateUserPermissions(userId, (current) => {
      if (checked) {
        current.add(readKey);
      } else {
        current.delete(readKey);
        if (writeKey) current.delete(writeKey);
      }
    });
  };

  const toggleWrite = (userId: string, readKey: string, writeKey: string, checked: boolean) => {
    updateUserPermissions(userId, (current) => {
      if (checked) {
        current.add(readKey);
        current.add(writeKey);
      } else {
        current.delete(writeKey);
      }
    });
  };

  const toggleGroup = (userId: string, perms: string[], checked: boolean) => {
    updateUserPermissions(userId, (current) => {
      perms.forEach((p) => {
        if (checked) current.add(p);
        else current.delete(p);
      });
    });
  };

  const isGroupChecked = (permissions: Set<string>, perms: string[]) =>
    perms.length > 0 && perms.every((p) => permissions.has(p));

  const toggleGroupRow = (groupKey: string) => {
    setExpandedGroups((prev) => ({ ...prev, [groupKey]: !(prev[groupKey] ?? true) }));
  };

  const savePermissions = async (userId: string, permissions: string[], role?: string | null) => {
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ permissions, role: role ?? "dealer" })
        .eq("id", userId);
      if (error) throw error;
      setPermDirty((prev) => ({ ...prev, [userId]: false }));
    } catch (error) {
      console.error("SettingsUsers: update permissions", error);
      alert("Не удалось сохранить права");
    }
  };

  const stageRoleChange = (userId: string, role: string) => {
    const nextRole = role as RoleKey;
    const preset = ROLE_PRESETS[nextRole] ?? [];
    setAppUsers((prev) =>
      prev.map((u) =>
        u.id === userId ? { ...u, role: nextRole, permissions: preset } : u,
      ),
    );
    setPermDirty((prev) => ({ ...prev, [userId]: true }));
  };

  const filteredAppUsers = useMemo(() => {
    const q = permQuery.trim().toLowerCase();
    return appUsers.filter((u) => {
      if (permRoleFilter !== "all" && (u.role ?? "dealer") !== permRoleFilter) return false;
      if (!q) return true;
      const target = `${u.email ?? ""}`.toLowerCase();
      return target.includes(q);
    });
  }, [appUsers, permQuery, permRoleFilter]);

  const permissionsGridTemplate = useMemo(() => {
    const cols = Math.max(filteredAppUsers.length, 1);
    return `minmax(240px, 1.1fr) repeat(${cols}, minmax(220px, 1fr))`;
  }, [filteredAppUsers.length]);
  const permissionsGridStyle = useMemo(
    () => ({ ["--perm-grid-cols" as any]: permissionsGridTemplate } as React.CSSProperties),
    [permissionsGridTemplate],
  );

  const warehouseLabel = (warehouseId: string) => {
    const wh = warehouses.find((w) => w.id === warehouseId);
    if (!wh) return "";
    if (wh.type === "virtual") {
      const parent = warehouses.find((w) => w.id === wh.parentId);
      return parent ? `${parent.name} / ${wh.name}` : wh.name;
    }
    return wh.name;
  };

  return (
    <div className="mrp-page settings-wrap">
      <div className="mrp-card mrp-card--compact">
        <div className="mrp-toolbar mrp-toolbar--compact mb-2">
          <div className="mrp-toolbar__left">
            <div className="mrp-field">
              <span className="mrp-field__label">Ник в Telegram</span>
              <input
                className="mrp-input"
                placeholder="@username"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
              />
            </div>
            <div className="mrp-field">
              <span className="mrp-field__label">Роль</span>
              <select className="mrp-select" value={newRole} onChange={(e) => setNewRole(e.target.value as any)}>
                <option value="controller">Контролёр</option>
                <option value="executor">Исполнитель</option>
              </select>
            </div>
          </div>
          <div className="mrp-toolbar__right">
            <button className="mrp-btn mrp-btn--primary" onClick={handleAdd} disabled={loading}>
              Добавить
            </button>
          </div>
        </div>

        <div className="mrp-hscroll">
          <table className="mrp-table text-sm table-compact">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-2 py-1">Ник</th>
                <th className="text-left px-2 py-1">Имя</th>
                <th className="text-left px-2 py-1">Telegram ID</th>
                <th className="text-left px-2 py-1">Роль</th>
                <th className="text-left px-2 py-1">Статус</th>
                <th className="text-left px-2 py-1">Глобальный</th>
                <th className="text-left px-2 py-1">Склады/Зоны</th>
                <th className="text-left px-2 py-1 w-[90px]">Действия</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <React.Fragment key={u.id}>
                  <tr className="border-t border-slate-100">
                    <td className="px-2 py-1">@{u.username || "—"}</td>
                    <td className="px-2 py-1">
                      {[u.first_name, u.last_name].filter(Boolean).join(" ") || "—"}
                    </td>
                    <td className="px-2 py-1">{u.tg_user_id ?? "—"}</td>
                    <td className="px-2 py-1">
                      <select
                        className="mrp-select"
                        value={u.role}
                        onChange={(e) => handleUpdate(u.id, { role: e.target.value as TgUser["role"] })}
                      >
                        <option value="controller">Контролёр</option>
                        <option value="executor">Исполнитель</option>
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      <select
                        className="mrp-select"
                        value={u.status}
                        onChange={(e) => handleUpdate(u.id, { status: e.target.value as TgUser["status"] })}
                      >
                        <option value="pending">Ожидает</option>
                        <option value="active">Активен</option>
                        <option value="disabled">Отключён</option>
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="checkbox"
                        checked={u.is_global_controller}
                        onChange={(e) => handleUpdate(u.id, { is_global_controller: e.target.checked })}
                      />
                    </td>
                    <td className="px-2 py-1">
                      <button
                        className="mrp-btn mrp-btn--ghost mrp-btn--xs"
                        onClick={() => setExpandedUserId(expandedUserId === u.id ? null : u.id)}
                      >
                        {expandedUserId === u.id ? "Скрыть" : "Настроить"}
                      </button>
                      <div className="text-xs text-slate-400 mt-1">
                        {(bindings[u.id] || []).map(warehouseLabel).filter(Boolean).join(", ") || "—"}
                      </div>
                    </td>
                    <td className="px-2 py-1">
                      <button className="mrp-btn mrp-btn--ghost mrp-btn--xs" onClick={() => handleRemove(u.id)}>
                        Удалить
                      </button>
                    </td>
                  </tr>
                  {expandedUserId === u.id && (
                    <tr className="border-t border-slate-100 bg-slate-50/40">
                      <td colSpan={8} className="px-3 py-3">
                        <div className="text-xs text-slate-500 mb-2">Привязка к складам и зонам</div>
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          {physical.map((p) => (
                            <label key={p.id} className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={(bindings[u.id] || []).includes(p.id)}
                                onChange={(e) => handleToggleWarehouse(u.id, p.id, e.target.checked)}
                              />
                              <span>{p.name}</span>
                            </label>
                          ))}
                          {virtual.map((v) => {
                            const parent = warehouses.find((w) => w.id === v.parentId);
                            const label = parent ? `${parent.name} / ${v.name}` : v.name;
                            return (
                              <label key={v.id} className="flex items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  checked={(bindings[u.id] || []).includes(v.id)}
                                  onChange={(e) => handleToggleWarehouse(u.id, v.id, e.target.checked)}
                                />
                                <span>{label}</span>
                              </label>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-2 py-4 text-center text-slate-400">
                    Пока нет пользователей
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {isAdmin && (
        <div className="mrp-card mrp-card--compact mt-6 settings-users-perms">
          <div className="mrp-toolbar mrp-toolbar--compact mb-2">
            <div className="mrp-toolbar__left">
              <div className="mrp-toolbar__title">Права доступа</div>
            </div>
            <div className="mrp-toolbar__right flex flex-wrap gap-2">
              <select
                className="mrp-select"
                value={permRoleFilter}
                onChange={(e) => setPermRoleFilter(e.target.value as any)}
              >
                <option value="all">Все сотрудники</option>
                <option value="admin">Админы</option>
                <option value="marketplace_wb">Маркетплейс WB</option>
                <option value="marketplace_ozon">Маркетплейс Ozon</option>
                <option value="purchasing">Закупки</option>
                <option value="sales">Продажи</option>
                <option value="dealer">Дилеры</option>
              </select>
              <input
                className="mrp-input"
                placeholder="Поиск по email"
                value={permQuery}
                onChange={(e) => setPermQuery(e.target.value)}
              />
            </div>
          </div>

          <div className="mrp-hscroll">
            <div className="permissions-grid-wrap" style={permissionsGridStyle}>
              <div className="permissions-grid permissions-grid--header">
                <div className="permissions-label">Роли</div>
                {filteredAppUsers.length > 0 ? (
                  filteredAppUsers.map((u) => (
                    <div key={u.id} className="permissions-user-card">
                      <div className="permissions-user-head">
                        <div className="permissions-avatar">
                          {(u.email ?? "U").slice(0, 2).toUpperCase()}
                        </div>
                        <div className="permissions-meta">
                          <div className="permissions-email">{u.email ?? "—"}</div>
                          <div className="permissions-last">
                            {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString("ru-RU") : "—"}
                          </div>
                        </div>
                        {permDirty[u.id] && <div className="permissions-dirty" title="Есть изменения" />}
                      </div>
                      <div className="permissions-actions">
                        <select
                          className="mrp-select mrp-select--sm"
                          value={u.role ?? "dealer"}
                          onChange={(e) => stageRoleChange(u.id, e.target.value)}
                        >
                          {Object.entries(ROLE_LABELS).map(([key, label]) => (
                            <option key={key} value={key}>
                              {label}
                            </option>
                          ))}
                        </select>
                        <button
                          className="mrp-btn mrp-btn--primary mrp-btn--xs"
                          disabled={!permDirty[u.id]}
                          onClick={() => savePermissions(u.id, u.permissions ?? [], u.role)}
                        >
                          Сохранить
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="permissions-empty">Пользователей нет</div>
                )}
              </div>

              <div className="permissions-matrix">
                {permissionsCatalog.map((group) => {
                  const groupKeys = group.items.flatMap((i) =>
                    i.writeKey ? [i.readKey, i.writeKey] : [i.readKey],
                  );
                  const expanded = expandedGroups[group.key] ?? true;
                  return (
                    <div key={group.key} className="permissions-group">
                      <div className="permissions-row permissions-row--group">
                        <button
                          className="mrp-btn mrp-btn--ghost mrp-btn--xs permissions-group-title"
                          onClick={() => toggleGroupRow(group.key)}
                        >
                          {expanded ? "▾" : "▸"} {group.title}
                        </button>
                        {filteredAppUsers.map((u) => {
                          const current = new Set(u.permissions ?? []);
                          const checked = isGroupChecked(current, groupKeys);
                          return (
                            <div key={u.id} className="permissions-cell-center permissions-cell-center--center">
                              <label className="permissions-check-label">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => toggleGroup(u.id, groupKeys, e.target.checked)}
                                />
                                Все
                              </label>
                            </div>
                          );
                        })}
                        {filteredAppUsers.length === 0 && <div />}
                      </div>
                      {expanded &&
                        group.items.map((item) => (
                          <div key={item.key} className="permissions-row">
                            <div className="permissions-item">{item.label}</div>
                            {filteredAppUsers.map((u) => {
                              const current = new Set(u.permissions ?? []);
                              const hasRead = current.has(item.readKey);
                              const hasWrite = item.writeKey ? current.has(item.writeKey) : false;
                              return (
                                <div
                                  key={u.id}
                                  className={`permissions-cell-center ${item.writeKey ? "permissions-cell-duo" : "permissions-cell-single"}`}
                                >
                                  <label className="permissions-check-label">
                                    <input
                                      type="checkbox"
                                      checked={hasRead}
                                      onChange={(e) => toggleRead(u.id, item.readKey, item.writeKey, e.target.checked)}
                                    />
                                    Чт
                                  </label>
                                  {item.writeKey && (
                                    <label className="permissions-check-label">
                                      <input
                                        type="checkbox"
                                        checked={hasWrite}
                                        onChange={(e) => toggleWrite(u.id, item.readKey, item.writeKey, e.target.checked)}
                                      />
                                      Зап
                                    </label>
                                  )}
                                </div>
                              );
                            })}
                            {filteredAppUsers.length === 0 && <div />}
                          </div>
                        ))}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function BalancesView() {
  const [materials] = useLocalState<Material[]>("mrp.materials.v1", []);
  const [products]  = useLocalState<Product[]>("mrp.products.v1", []);
  const [semis]     = useLocalState<Semi[]>("mrp.semis.v1", []);
  const { warehouses, physical, virtual } = useSupabaseWarehouses();
  const { balances } = useStockRepo();

  const [typeFilter, setTypeFilter] = useState<"all"|"material"|"product"|"semi">("all");
  const [whFilter, setWhFilter] = useState<string>("");
  const [q, setQ] = useState("");

  const nameOf = (b: StockBalance) => {
    if (b.itemType === "material") {
      const m = materials.find(x => x.id === b.itemId);
      return { code: m?.code ?? "", name: m?.name ?? "", uom: m?.uom ?? "" };
    } else if (b.itemType === "semi") {
      const s = semis.find(x => x.id === b.itemId);
      return { code: s?.code ?? "", name: s?.name ?? "", uom: s?.uom ?? "" };
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
          <option value="semi">Полуфабрикаты</option>
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
                <td className="px-3 py-2">
                  {r.b.itemType === "material" ? "M" : r.b.itemType === "semi" ? "S" : "P"}
                </td>
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



function StockMovesView() {
  type ItemKind = "product" | "material" | "semi";
  type ItemRow = { id: string; code: string; name: string; kind: ItemKind; uom?: string };
  type TransferRow = {
    id: string;
    itemId: string;
    qty: number;
    fromId?: string;
    toId?: string;
    createdAt: string;
  };

  const { warehouses } = useSupabaseWarehouses();
  const [items, setItems] = useState<ItemRow[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [transfers, setTransfers] = useState<TransferRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [kind, setKind] = useState<ItemKind>("product");
  const [itemId, setItemId] = useState("");
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [qty, setQty] = useState("");
  const [dateISO, setDateISO] = useState(() => new Date().toISOString().slice(0, 10));
  const [search, setSearch] = useState("");
  const [balances, setBalances] = useStockBalances();

  const whName = useCallback(
    (id?: string) => {
      if (!id) return "";
      const w = warehouses.find((x) => x.id === id);
      if (!w) return "";
      if (w.type === "virtual" && w.parentId) {
        const parent = warehouses.find((x) => x.id === w.parentId);
        return parent ? `${parent.name} / ${w.name}` : w.name;
      }
      return w.name;
    },
    [warehouses]
  );

  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items
      .filter((i) => i.kind === kind)
      .filter((i) => !q || `${i.code} ${i.name}`.toLowerCase().includes(q))
      .sort((a, b) => a.code.localeCompare(b.code, "ru", { sensitivity: "base" }));
  }, [items, kind, search]);

  const availableQty = useMemo(() => {
    if (!itemId || !fromId) return null;
    const row = balances.find((b) => b.itemId === itemId && b.warehouseId === fromId);
    return row?.qty ?? null;
  }, [balances, fromId, itemId]);

  const refreshItems = useCallback(async () => {
    setItemsLoading(true);
    try {
      const { data, error } = await supabase
        .from("items")
        .select("id, code, name, kind, uom")
        .in("kind", ["product", "material", "semi"])
        .order("code", { ascending: true });
      if (error) throw error;
      const mapped = (data || []).map((row: any) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        kind: row.kind as ItemKind,
        uom: row.uom ?? undefined,
      }));
      setItems(mapped);
    } catch (err) {
      console.error("moves: load items", err);
      alert("Не удалось загрузить номенклатуру");
    } finally {
      setItemsLoading(false);
    }
  }, []);

  const refreshTransfers = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("stock_movements")
        .select("doc_id, item_id, warehouse_id, qty, created_at")
        .eq("doc_type", "transfer")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      const groups = new Map<string, TransferRow & { rows: any[] }>();
      (data || []).forEach((row: any) => {
        const key = String(row.doc_id || "");
        if (!key) return;
        if (!groups.has(key)) {
          groups.set(key, {
            id: key,
            itemId: row.item_id,
            qty: 0,
            createdAt: row.created_at ?? new Date().toISOString(),
            rows: [],
          });
        }
        const g = groups.get(key)!;
        g.rows.push(row);
        if (row.created_at && row.created_at > g.createdAt) g.createdAt = row.created_at;
        if (!g.itemId) g.itemId = row.item_id;
      });
      const mapped = Array.from(groups.values()).map((g) => {
        const from = g.rows.find((r) => Number(r.qty) < 0);
        const to = g.rows.find((r) => Number(r.qty) > 0);
        return {
          id: g.id,
          itemId: g.itemId,
          qty: Math.abs(Number(from?.qty ?? to?.qty ?? 0)),
          fromId: from?.warehouse_id ?? undefined,
          toId: to?.warehouse_id ?? undefined,
          createdAt: g.createdAt,
        };
      });
      setTransfers(mapped);
    } catch (err) {
      console.error("moves: load transfers", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshBalances = useCallback(async () => {
    if (!items.length) return;
    const { data, error } = await supabase
      .from("stock_balances")
      .select("item_id, warehouse_id, qty, updated_at");
    if (error) {
      console.error("moves: load stock_balances", error);
      return;
    }
    const next = (data || [])
      .map((row: any) => {
        const item = itemsById.get(row.item_id);
        if (!item) return null;
        return {
          id: `${row.warehouse_id}:${row.item_id}`,
          itemType: item.kind,
          itemId: row.item_id,
          warehouseId: row.warehouse_id,
          qty: Number(row.qty) || 0,
          updatedAt: row.updated_at ?? new Date().toISOString(),
        } as StockBalance;
      })
      .filter(Boolean) as StockBalance[];
    setBalances(next);
  }, [items, itemsById, setBalances]);

  useEffect(() => {
    refreshItems();
    refreshTransfers();
  }, [refreshItems, refreshTransfers]);

  useEffect(() => {
    if (items.length) refreshBalances();
  }, [items.length, refreshBalances]);

  const submitMove = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!itemId) {
      alert("Выбери номенклатуру");
      return;
    }
    if (!fromId || !toId || fromId === toId) {
      alert("Укажи разные склады отправки и получения");
      return;
    }
    const qtyNum = Number(String(qty).replace(",", "."));
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      alert("Количество должно быть больше 0");
      return;
    }
    setSaving(true);
    try {
      const { data: balRow, error: balErr } = await supabase
        .from("stock_balances")
        .select("qty")
        .eq("item_id", itemId)
        .eq("warehouse_id", fromId)
        .maybeSingle();
      if (balErr) throw balErr;
      const available = Number(balRow?.qty ?? 0);
      if (available < qtyNum) {
        const ok = window.confirm(`На складе только ${available}. Всё равно переместить?`);
        if (!ok) return;
      }

      const docId = generateUuid();
      const createdAt = dateISO ? new Date(`${dateISO}T00:00:00`).toISOString() : new Date().toISOString();
      const payload = [
        { doc_type: "transfer", doc_id: docId, item_id: itemId, warehouse_id: fromId, qty: -qtyNum, created_at: createdAt },
        { doc_type: "transfer", doc_id: docId, item_id: itemId, warehouse_id: toId, qty: qtyNum, created_at: createdAt },
      ];
      const { error } = await supabase.from("stock_movements").insert(payload);
      if (error) throw error;
      await refreshTransfers();
      await refreshBalances();
      setQty("");
    } catch (err) {
      console.error("moves: save transfer", err);
      alert("Не удалось сохранить перемещение");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mrp-page">
      <div className="mrp-page-head">
        <div className="mrp-title-row">
          <h1 className="mrp-title">Перемещения</h1>
          <span className="mrp-count">{transfers.length}</span>
        </div>
      </div>

      <div className="mrp-card space-y-4">
        <form onSubmit={submitMove} className="grid gap-3 md:grid-cols-6">
          <div className="md:col-span-1">
            <Label>Тип</Label>
            <select className="mrp-select w-full" value={kind} onChange={(e) => setKind(e.target.value as ItemKind)}>
              <option value="product">Товар</option>
              <option value="material">Материал</option>
              <option value="semi">Полуфабрикат</option>
            </select>
          </div>

          <div className="md:col-span-2">
            <Label>Номенклатура</Label>
            <select className="mrp-select w-full" value={itemId} onChange={(e) => setItemId(e.target.value)}>
              <option value="">{itemsLoading ? "Загрузка…" : "Выбери"}</option>
              {filteredItems.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.code} — {i.name}
                </option>
              ))}
            </select>
            <input
              className="form-control mt-2 w-full"
              placeholder="Быстрый поиск по коду/наименованию"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className="md:col-span-1">
            <Label>Откуда</Label>
            <select className="mrp-select w-full" value={fromId} onChange={(e) => setFromId(e.target.value)}>
              <option value="">Выбери склад</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {whName(w.id)}
                </option>
              ))}
            </select>
            {availableQty != null && (
              <div className="text-xs text-slate-400 mt-1">Остаток: {availableQty}</div>
            )}
          </div>

          <div className="md:col-span-1">
            <Label>Куда</Label>
            <select className="mrp-select w-full" value={toId} onChange={(e) => setToId(e.target.value)}>
              <option value="">Выбери склад</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {whName(w.id)}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-1">
            <Label>Кол-во</Label>
            <input
              className="form-control w-full"
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="0"
            />
          </div>

          <div className="md:col-span-1">
            <Label>Дата</Label>
            <input className="form-control w-full" type="date" value={dateISO} onChange={(e) => setDateISO(e.target.value)} />
          </div>

          <div className="md:col-span-6 flex items-center justify-end gap-2">
            <button type="button" className="mrp-btn mrp-btn--ghost" onClick={refreshTransfers} disabled={loading}>
              {loading ? "Обновляем…" : "Обновить"}
            </button>
            <button type="submit" className="mrp-btn mrp-btn--primary" disabled={saving}>
              {saving ? "Сохраняем…" : "Переместить"}
            </button>
          </div>
        </form>
      </div>

      <div className="mrp-card mt-4">
        <div className="mrp-hscroll">
          <table className="mrp-table text-sm">
            <thead>
              <tr>
                <th className="text-left px-2 py-2">Дата</th>
                <th className="text-left px-2 py-2">Номенклатура</th>
                <th className="text-left px-2 py-2">Откуда</th>
                <th className="text-left px-2 py-2">Куда</th>
                <th className="text-right px-2 py-2">Кол-во</th>
              </tr>
            </thead>
            <tbody>
              {transfers.length ? (
                transfers.map((t) => {
                  const item = itemsById.get(t.itemId);
                  return (
                    <tr key={t.id} className="border-t border-slate-100">
                      <td className="px-2 py-2">{new Date(t.createdAt).toLocaleString("ru-RU")}</td>
                      <td className="px-2 py-2">
                        {item ? `${item.code} — ${item.name}` : t.itemId}
                      </td>
                      <td className="px-2 py-2">{whName(t.fromId) || "—"}</td>
                      <td className="px-2 py-2">{whName(t.toId) || "—"}</td>
                      <td className="px-2 py-2 text-right">{t.qty}</td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={5} className="px-2 py-8 text-center text-slate-400">
                    {loading ? "Загружаем…" : "Перемещений нет"}
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



function ProdReportsView() {
  type ReportRow = {
    id: string;
    number: string;
    dateISO: string;
    createdAt?: string | null;
    qty: number;
    status: string;
    kind: "fg" | "semi" | "scrap";
    typeLabel: string;
    product?: { code: string; name: string };
    itemId: string;
    physWarehouseId: string;
    fgZoneId?: string;
    matZoneId?: string;
    semiZoneId?: string | null;
    planKind?: "fg" | "semi" | null;
    planItemId?: string | null;
    planDate?: string | null;
    reason?: string | null;
    baseReportId?: string | null;
    actorName?: string | null;
  };
  type WarehouseMap = Record<string, { id: string; name: string; type: "physical" | "virtual"; parentId?: string | null }>;
  type UserMap = Record<string, { id: string; label: string }>;

  const [reports, setReports] = useState<ReportRow[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseMap>({});
  const [users, setUsers] = useState<UserMap>({});
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [sortState, setSortState] = useState<{
    key: "date" | "number" | "product";
    dir: "asc" | "desc";
  }>({ key: "date", dir: "desc" });
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustRow, setAdjustRow] = useState<ReportRow | null>(null);
  const [adjustQty, setAdjustQty] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [adjustActorId, setAdjustActorId] = useState("");
  const [adjustSaving, setAdjustSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<"fg" | "semi" | "scrap">("fg");
  const [createDate, setCreateDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [createQty, setCreateQty] = useState("");
  const [createItemId, setCreateItemId] = useState("");
  const [createPhysId, setCreatePhysId] = useState("");
  const [createFgZoneId, setCreateFgZoneId] = useState("");
  const [createMatZoneId, setCreateMatZoneId] = useState("");
  const [createSemiZoneId, setCreateSemiZoneId] = useState("");
  const [createLinkPlan, setCreateLinkPlan] = useState(true);
  const [createActorId, setCreateActorId] = useState("");
  const [createSaving, setCreateSaving] = useState(false);
  const [items, setItems] = useState<{ id: string; code: string; name: string; kind: string }[]>([]);
  const [itemsLoaded, setItemsLoaded] = useState(false);
  const userOptions = React.useMemo(() => Object.values(users), [users]);

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

  const refreshUsers = useCallback(async () => {
    const { data, error } = await supabase
      .from("tg_users")
      .select("id, username, first_name, last_name");
    if (error) {
      console.error("prodReports: load tg_users", error);
      return;
    }
    const map: UserMap = {};
    (data || []).forEach((row: any) => {
      const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
      const label = name || (row.username ? `@${row.username}` : "—");
      map[row.id] = { id: row.id, label };
    });
    setUsers(map);
  }, []);

  const refreshReports = useCallback(async () => {
    setLoading(true);
    try {
      const { data: prodData, error: prodError } = await supabase
        .from("prod_reports")
        .select(`
          id,
          number,
          date_iso,
          qty,
          status,
          created_at,
          plan_kind,
          plan_item_id,
          plan_date,
          author_id,
          product_id,
          phys_warehouse_id,
          fg_zone_id,
          mat_zone_id,
          product:product_id (code, name)
        `)
        .order("date_iso", { ascending: false });
      if (prodError) throw prodError;

      const { data: scrapData, error: scrapError } = await supabase
        .from("prod_scrap_reports")
        .select(`
          id,
          number,
          date_iso,
          qty,
          created_at,
          phys_warehouse_id,
          mat_zone_id,
          semi_zone_id,
          item_id,
          plan_kind,
          plan_item_id,
          plan_date,
          author_id,
          item:item_id (code, name)
        `)
        .order("date_iso", { ascending: false });
      if (scrapError) throw scrapError;

      const { data: adjProdData, error: adjProdError } = await supabase
        .from("prod_report_adjustments")
        .select(`
          id,
          report_id,
          product_id,
          delta_qty,
          reason,
          actor_id,
          phys_warehouse_id,
          fg_zone_id,
          mat_zone_id,
          plan_kind,
          plan_item_id,
          plan_date,
          created_at,
          product:product_id (code, name)
        `)
        .order("created_at", { ascending: false });
      if (adjProdError) throw adjProdError;

      const { data: adjScrapData, error: adjScrapError } = await supabase
        .from("prod_scrap_adjustments")
        .select(`
          id,
          report_id,
          item_id,
          delta_qty,
          reason,
          actor_id,
          phys_warehouse_id,
          mat_zone_id,
          semi_zone_id,
          plan_kind,
          plan_item_id,
          plan_date,
          created_at,
          item:item_id (code, name)
        `)
        .order("created_at", { ascending: false });
      if (adjScrapError) throw adjScrapError;

      const mappedProd: ReportRow[] = (prodData || []).map((row: any) => ({
        id: row.id,
        number: row.number,
        dateISO: row.date_iso,
        createdAt: row.created_at ?? null,
        qty: Number(row.qty) || 0,
        status: row.status ?? "posted",
        kind: row.plan_kind === "semi" ? "semi" : "fg",
        typeLabel: row.plan_kind === "semi" ? "Производство полуфабрикатов" : "Производство товара",
        itemId: row.product_id,
        physWarehouseId: row.phys_warehouse_id,
        fgZoneId: row.fg_zone_id,
        matZoneId: row.mat_zone_id,
        planKind: row.plan_kind ?? null,
        planItemId: row.plan_item_id ?? null,
        planDate: row.plan_date ?? null,
        product: row.product ? { code: row.product.code, name: row.product.name } : undefined,
        reason: null,
        baseReportId: row.id,
        actorName: users[row.author_id]?.label ?? "—",
      }));
      const mappedScrap: ReportRow[] = (scrapData || []).map((row: any) => ({
        id: row.id,
        number: row.number,
        dateISO: row.date_iso,
        createdAt: row.created_at ?? null,
        qty: Number(row.qty) || 0,
        status: "posted",
        kind: "scrap",
        typeLabel: "Брак",
        itemId: row.item_id,
        physWarehouseId: row.phys_warehouse_id,
        matZoneId: row.mat_zone_id,
        semiZoneId: row.semi_zone_id,
        planKind: row.plan_kind ?? null,
        planItemId: row.plan_item_id ?? null,
        planDate: row.plan_date ?? null,
        product: row.item ? { code: row.item.code, name: row.item.name } : undefined,
        reason: null,
        baseReportId: row.id,
        actorName: users[row.author_id]?.label ?? "—",
      }));
      const mappedAdjProd: ReportRow[] = (adjProdData || []).map((row: any) => ({
        id: row.id,
        number: `ADJ-${String(row.report_id || row.id).slice(0, 6).toUpperCase()}`,
        dateISO: row.created_at ?? row.plan_date ?? row.plan_date,
        createdAt: row.created_at ?? null,
        qty: Number(row.delta_qty) || 0,
        status: "adjustment",
        kind: row.plan_kind === "semi" ? "semi" : "fg",
        typeLabel: "Корректировка производства",
        itemId: row.product_id,
        physWarehouseId: row.phys_warehouse_id,
        fgZoneId: row.fg_zone_id,
        matZoneId: row.mat_zone_id,
        planKind: row.plan_kind ?? null,
        planItemId: row.plan_item_id ?? null,
        planDate: row.plan_date ?? null,
        product: row.product ? { code: row.product.code, name: row.product.name } : undefined,
        reason: row.reason ?? null,
        baseReportId: row.report_id ?? null,
        actorName: users[row.actor_id]?.label ?? "—",
      }));
      const mappedAdjScrap: ReportRow[] = (adjScrapData || []).map((row: any) => ({
        id: row.id,
        number: `ADJ-${String(row.report_id || row.id).slice(0, 6).toUpperCase()}`,
        dateISO: row.created_at ?? row.plan_date ?? row.plan_date,
        createdAt: row.created_at ?? null,
        qty: Number(row.delta_qty) || 0,
        status: "adjustment",
        kind: "scrap",
        typeLabel: "Корректировка брака",
        itemId: row.item_id,
        physWarehouseId: row.phys_warehouse_id,
        matZoneId: row.mat_zone_id,
        semiZoneId: row.semi_zone_id,
        planKind: row.plan_kind ?? null,
        planItemId: row.plan_item_id ?? null,
        planDate: row.plan_date ?? null,
        product: row.item ? { code: row.item.code, name: row.item.name } : undefined,
        reason: row.reason ?? null,
        baseReportId: row.report_id ?? null,
        actorName: users[row.actor_id]?.label ?? "—",
      }));
      setReports([...mappedAdjProd, ...mappedAdjScrap, ...mappedProd, ...mappedScrap]);
    } catch (err) {
      console.error("prodReports: load reports", err);
    } finally {
      setLoading(false);
    }
  }, [users]);

  useEffect(() => {
    refreshWarehouses();
  }, [refreshWarehouses]);
  useEffect(() => {
    refreshUsers();
  }, [refreshUsers]);
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
      r.product?.name.toLowerCase().includes(q) ||
      r.typeLabel.toLowerCase().includes(q) ||
      (r.reason ?? "").toLowerCase().includes(q)
    );
  });

  const handleSort = (key: "date" | "number" | "product") => {
    setSortState((prev) => {
      if (prev.key !== key) return { key, dir: "asc" };
      return { key, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  };

  const sortArrows = (key: "date" | "number" | "product") => {
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
    if (sortState.key === "date") {
      return [...filtered].sort((a, b) => {
        const aValue = a.createdAt ?? a.dateISO;
        const bValue = b.createdAt ?? b.dateISO;
        const aTime = aValue ? new Date(aValue).getTime() : 0;
        const bTime = bValue ? new Date(bValue).getTime() : 0;
        return (aTime - bTime) * dir;
      });
    }
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

  const openAdjust = (row: ReportRow) => {
    if (row.status === "adjustment") {
      alert("Корректировки нельзя корректировать.");
      return;
    }
    setAdjustRow(row);
    setAdjustQty(String(row.qty));
    setAdjustReason("");
    setAdjustActorId(userOptions[0]?.id ?? "");
    setAdjustOpen(true);
  };

  const submitAdjust = async () => {
    if (!adjustRow) return;
    if (adjustRow.status === "adjustment") {
      alert("Корректировки нельзя корректировать.");
      return;
    }
    if (!adjustActorId) {
      alert("Выберите автора корректировки.");
      return;
    }
    const nextQty = Number(adjustQty);
    if (!Number.isFinite(nextQty) || nextQty < 0) {
      alert("Укажите корректное количество.");
      return;
    }
    const delta = nextQty - adjustRow.qty;
    if (delta === 0) {
      setAdjustOpen(false);
      return;
    }
    setAdjustSaving(true);
    try {
      if (adjustRow.kind === "scrap") {
        const { error } = await supabase.rpc("adjust_production_scrap", {
          p_delta_qty: delta,
          p_item_id: adjustRow.itemId,
          p_phys_warehouse_id: adjustRow.physWarehouseId,
          p_mat_zone_id: adjustRow.matZoneId,
          p_semi_zone_id: adjustRow.semiZoneId ?? null,
          p_plan_kind: adjustRow.planKind ?? null,
          p_plan_item_id: adjustRow.planItemId ?? null,
          p_plan_date: adjustRow.planDate ?? null,
          p_report_id: adjustRow.baseReportId ?? adjustRow.id,
          p_reason: adjustReason || null,
          p_actor_id: adjustActorId,
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.rpc("adjust_production_report", {
          p_delta_qty: delta,
          p_product_id: adjustRow.itemId,
          p_phys_warehouse_id: adjustRow.physWarehouseId,
          p_fg_zone_id: adjustRow.fgZoneId,
          p_mat_zone_id: adjustRow.matZoneId,
          p_plan_kind: adjustRow.planKind ?? null,
          p_plan_item_id: adjustRow.planItemId ?? null,
          p_plan_date: adjustRow.planDate ?? null,
          p_report_id: adjustRow.baseReportId ?? adjustRow.id,
          p_reason: adjustReason || null,
          p_actor_id: adjustActorId,
        });
        if (error) throw error;
      }
      await refreshReports();
      setAdjustOpen(false);
    } catch (err) {
      console.error("prodReports: adjust", err);
      alert("Не удалось выполнить корректировку. См. консоль.");
    } finally {
      setAdjustSaving(false);
    }
  };

  const ensureItems = useCallback(async () => {
    if (itemsLoaded) return;
    const { data, error } = await supabase
      .from("items")
      .select("id, code, name, kind")
      .order("name", { ascending: true });
    if (error) {
      console.error("prodReports: load items", error);
      return;
    }
    setItems((data || []).map((row: any) => ({ id: row.id, code: row.code, name: row.name, kind: row.kind })));
    setItemsLoaded(true);
  }, [itemsLoaded]);

  const openCreate = async () => {
    await ensureItems();
    const physList = Object.values(warehouses).filter((w) => w.type === "physical");
    const defaultPhys = physList[0]?.id ?? "";
    setCreatePhysId(defaultPhys);
    const zones = Object.values(warehouses).filter((w) => w.type === "virtual" && w.parentId === defaultPhys);
    const findZoneId = (pattern: RegExp) => zones.find((z) => pattern.test(z.name))?.id || zones[0]?.id || "";
    setCreateMatZoneId(findZoneId(/материал/i));
    setCreateFgZoneId(findZoneId(/готов/i));
    setCreateSemiZoneId(findZoneId(/полуфаб/i));
    setCreateActorId(userOptions[0]?.id ?? "");
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    const qty = Number(createQty);
    if (!createItemId) {
      alert("Выберите позицию.");
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      alert("Укажите корректное количество.");
      return;
    }
    if (!createPhysId) {
      alert("Выберите склад.");
      return;
    }
    if (!createActorId) {
      alert("Выберите автора отчёта.");
      return;
    }
    if (createType === "scrap") {
      if (!createMatZoneId) {
        alert("Выберите зону материалов.");
        return;
      }
    } else {
      if (!createFgZoneId || !createMatZoneId) {
        alert("Выберите зоны.");
        return;
      }
    }
    setCreateSaving(true);
    try {
      if (createType === "scrap") {
        const { error } = await supabase.rpc("post_production_scrap", {
          p_number: "",
          p_date_iso: createDate,
          p_item_id: createItemId,
          p_qty: qty,
          p_phys_warehouse_id: createPhysId,
          p_mat_zone_id: createMatZoneId,
          p_semi_zone_id: createSemiZoneId || null,
          p_plan_kind: createLinkPlan ? (createType === "scrap" ? null : createType) : null,
          p_plan_item_id: createLinkPlan ? createItemId : null,
          p_plan_date: createLinkPlan ? createDate : null,
          p_actor_id: createActorId,
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.rpc("post_production_report", {
          p_number: "",
          p_date_iso: createDate,
          p_product_id: createItemId,
          p_qty: qty,
          p_phys_warehouse_id: createPhysId,
          p_fg_zone_id: createFgZoneId,
          p_mat_zone_id: createMatZoneId,
          p_plan_kind: createLinkPlan ? createType : null,
          p_plan_item_id: createLinkPlan ? createItemId : null,
          p_plan_date: createLinkPlan ? createDate : null,
          p_actor_id: createActorId,
        });
        if (error) throw error;
      }
      await refreshReports();
      setCreateOpen(false);
    } catch (err) {
      console.error("prodReports: create manual", err);
      alert("Не удалось создать документ. См. консоль.");
    } finally {
      setCreateSaving(false);
    }
  };

  return (
    <div className="mrp-page">
      <div className="mrp-card">
        <div className="mrp-toolbar mb-2">
          <div className="mrp-toolbar__left">
            <button className="mrp-btn mrp-btn--ghost" onClick={refreshReports} disabled={loading}>
              {loading ? "Обновляем…" : "Обновить"}
            </button>
            <button className="mrp-btn mrp-btn--primary" onClick={openCreate}>
              Создать вручную
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
                <th className="text-left px-3 py-2 wbwh-sortable" onClick={() => handleSort("date")}>
                  Дата / Номер{sortArrows("date")}
                </th>
                <th className="text-left px-3 py-2 wbwh-sortable" onClick={() => handleSort("product")}>
                  Товар{sortArrows("product")}
                </th>
                <th className="text-left px-3 py-2 w-[160px]">Тип</th>
                <th className="text-left px-3 py-2 w-[90px]">Кол-во</th>
                <th className="text-left px-3 py-2">Склад (ГП / Мат.)</th>
                <th className="text-left px-3 py-2 w-[120px]">Статус</th>
                <th className="text-left px-3 py-2 w-[200px]">Причина</th>
                <th className="text-left px-3 py-2 w-[140px]">Автор</th>
                <th className="text-left px-3 py-2 w-[140px]">Действия</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((d) => (
                <tr key={d.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    <div className="font-medium">
                      {new Date(d.createdAt ?? d.dateISO).toLocaleString("ru-RU")}
                    </div>
                    <div className="text-slate-500 text-xs">{d.number}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col gap-1">
                      <span className="mrp-code">{d.product?.code ?? "—"}</span>
                      <span className="text-slate-700 text-sm leading-snug line-clamp-2">
                        {d.product?.name ?? "—"}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span className="text-slate-700">{d.typeLabel}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span className={d.status === "adjustment" ? (d.qty > 0 ? "text-emerald-600" : "text-rose-600") : ""}>
                      {d.status === "adjustment" && d.qty > 0 ? `+${d.qty}` : d.qty}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {d.kind === "scrap" ? (
                      <>
                        <div>Мат.: {fmtZone(d.matZoneId) || "—"}</div>
                        <div className="text-xs text-slate-500">ПФ: {fmtZone(d.semiZoneId) || "—"}</div>
                      </>
                    ) : (
                      <>
                        <div>ГП: {fmtZone(d.fgZoneId) || "—"}</div>
                        <div className="text-xs text-slate-500">Мат.: {fmtZone(d.matZoneId) || "—"}</div>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        d.status === "draft"
                          ? "mrp-status mrp-status--draft"
                          : "mrp-status"
                      }
                    >
                      {d.status === "posted"
                        ? "Проведён"
                        : d.status === "draft"
                          ? "Черновик"
                          : d.status === "adjustment"
                            ? "Корректировка"
                            : d.status}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {d.reason || "—"}
                  </td>
                  <td className="px-3 py-2">
                    {d.actorName || "—"}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      className="mrp-btn mrp-btn--ghost mrp-btn--xs"
                      onClick={() => openAdjust(d)}
                      disabled={d.status === "adjustment"}
                      title={d.status === "adjustment" ? "Корректировки нельзя корректировать" : "Корректировать"}
                    >
                      Корректировать
                    </button>
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-slate-400">
                    Документы не найдены
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {adjustOpen && adjustRow && (
        <Modal onClose={() => setAdjustOpen(false)} title="Корректировка отчёта" width={420}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (adjustSaving) return;
              submitAdjust();
            }}
          >
            <div className="form-row">
              <Label>Новое количество</Label>
              <input
                className="form-control w-full"
                type="number"
                inputMode="decimal"
                value={adjustQty}
                onChange={(e) => setAdjustQty(e.target.value)}
                min="0"
              />
            </div>
            <div className="form-row mt-3">
              <Label>Автор</Label>
              <select
                className="form-control w-full"
                value={adjustActorId}
                onChange={(e) => setAdjustActorId(e.target.value)}
              >
                <option value="">— выбрать —</option>
                {userOptions.map((u) => (
                  <option key={u.id} value={u.id}>{u.label}</option>
                ))}
              </select>
            </div>
            <div className="form-row mt-3">
              <Label>Причина (опционально)</Label>
              <input
                className="form-control w-full"
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                placeholder="Например: пересчёт, ошибка ввода"
              />
            </div>
            <div className="modal-footer">
              <div className="flex items-center justify-end gap-2 w-full">
                <button type="button" className="mrp-btn" onClick={() => setAdjustOpen(false)}>
                  Отмена
                </button>
                <button type="submit" className="mrp-btn mrp-btn--primary" disabled={adjustSaving}>
                  {adjustSaving ? "Сохраняем…" : "Применить"}
                </button>
              </div>
            </div>
          </form>
        </Modal>
      )}
      {createOpen && (
        <Modal onClose={() => setCreateOpen(false)} title="Ручной отчёт производства" width={520}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (createSaving) return;
              submitCreate();
            }}
          >
            <div className="form-row">
              <Label>Тип документа</Label>
              <select
                className="form-control w-full"
                value={createType}
                onChange={(e) => setCreateType(e.target.value as any)}
              >
                <option value="fg">Производство товара</option>
                <option value="semi">Производство полуфабрикатов</option>
                <option value="scrap">Брак</option>
              </select>
            </div>
            <div className="form-row mt-3">
              <Label>Дата</Label>
              <input
                className="form-control w-full"
                type="date"
                value={createDate}
                onChange={(e) => setCreateDate(e.target.value)}
              />
            </div>
            <div className="form-row mt-3">
              <Label>Позиция</Label>
              <select
                className="form-control w-full"
                value={createItemId}
                onChange={(e) => setCreateItemId(e.target.value)}
              >
                <option value="">— выбрать —</option>
                {items
                  .filter((it) =>
                    createType === "fg" ? it.kind === "product" : createType === "semi" ? it.kind === "semi" : it.kind === "product" || it.kind === "semi"
                  )
                  .map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.code} — {it.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="form-row mt-3">
              <Label>Количество</Label>
              <input
                className="form-control w-full"
                type="number"
                inputMode="decimal"
                value={createQty}
                onChange={(e) => setCreateQty(e.target.value)}
                min="0"
              />
            </div>
            <div className="form-row mt-3">
              <Label>Автор</Label>
              <select
                className="form-control w-full"
                value={createActorId}
                onChange={(e) => setCreateActorId(e.target.value)}
              >
                <option value="">— выбрать —</option>
                {userOptions.map((u) => (
                  <option key={u.id} value={u.id}>{u.label}</option>
                ))}
              </select>
            </div>
            <div className="form-row mt-3">
              <Label>Склад (физический)</Label>
              <select
                className="form-control w-full"
                value={createPhysId}
                onChange={(e) => {
                  const pid = e.target.value;
                  setCreatePhysId(pid);
                  const zones = Object.values(warehouses).filter((w) => w.type === "virtual" && w.parentId === pid);
                  const findZoneId = (pattern: RegExp) => zones.find((z) => pattern.test(z.name))?.id || zones[0]?.id || "";
                  setCreateMatZoneId(findZoneId(/материал/i));
                  setCreateFgZoneId(findZoneId(/готов/i));
                  setCreateSemiZoneId(findZoneId(/полуфаб/i));
                }}
              >
                <option value="">— выбрать —</option>
                {Object.values(warehouses)
                  .filter((w) => w.type === "physical")
                  .map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
              </select>
            </div>
            {createType !== "scrap" && (
              <div className="form-row mt-3">
                <Label>Зона выпуска</Label>
                <select
                  className="form-control w-full"
                  value={createFgZoneId}
                  onChange={(e) => setCreateFgZoneId(e.target.value)}
                >
                  <option value="">— выбрать —</option>
                  {Object.values(warehouses)
                    .filter((w) => w.type === "virtual" && w.parentId === createPhysId)
                    .map((w) => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                </select>
              </div>
            )}
            <div className="form-row mt-3">
              <Label>Зона материалов</Label>
              <select
                className="form-control w-full"
                value={createMatZoneId}
                onChange={(e) => setCreateMatZoneId(e.target.value)}
              >
                <option value="">— выбрать —</option>
                {Object.values(warehouses)
                  .filter((w) => w.type === "virtual" && w.parentId === createPhysId)
                  .map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
              </select>
            </div>
            {createType === "scrap" && (
              <div className="form-row mt-3">
                <Label>Зона полуфабрикатов (если требуется)</Label>
                <select
                  className="form-control w-full"
                  value={createSemiZoneId}
                  onChange={(e) => setCreateSemiZoneId(e.target.value)}
                >
                  <option value="">— не использовать —</option>
                  {Object.values(warehouses)
                    .filter((w) => w.type === "virtual" && w.parentId === createPhysId)
                    .map((w) => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                </select>
              </div>
            )}
            <div className="form-row mt-3">
              <label className="row-inline text-sm">
                <input
                  type="checkbox"
                  checked={createLinkPlan}
                  onChange={(e) => setCreateLinkPlan(e.target.checked)}
                />
                Привязать к плану на эту дату
              </label>
            </div>
            <div className="modal-footer">
              <div className="flex items-center justify-end gap-2 w-full">
                <button type="button" className="mrp-btn" onClick={() => setCreateOpen(false)}>
                  Отмена
                </button>
                <button type="submit" className="mrp-btn mrp-btn--primary" disabled={createSaving}>
                  {createSaving ? "Создаём…" : "Создать"}
                </button>
              </div>
            </div>
          </form>
        </Modal>
      )}
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
