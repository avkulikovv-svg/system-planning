// file: src/AppShell.tsx
import SettingsIntegrations from "./SettingsIntegrations";
import React, { useEffect, useState, useMemo, useRef, type ReactNode } from "react";
import {
  Menu as MenuIcon,
  Factory, BarChart3, ShoppingCart, Boxes, PieChart, Settings,
  Search, Edit3, Plus, Pencil, Trash2
} from "lucide-react";


/* ------------ Types ------------ */
export type Sub = { key: string; title: string; route: string; icon?: string };
export type Section = { key: string; title: string; icon: string; subs: Sub[] };

type Product = {
  id?: string;
  status: string;
  code: string;
  name: string;
  category?: string;
  uom?: string;
  price?: number;
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
  category: string;
};

/* === Spec model === (поддерживаем совместимость с item) */
type SpecLine = { id: string; materialId?: string; item?: string; qty: number; uom: string };
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

type Receipt = {
  id: string;
  number: string;
  date: string;                   // ISO
  status: "draft" | "posted";
  vendorId?: string;
  physWarehouseId: string;
  defaultZoneId: string;          // зона для строк по умолч.
  fromPoId?: string | null;       // связь с заказом (опц.)
  lines: {
    id: string;
    materialId: string;
    qty: number;
    zoneId?: string;              // если не указано — defaultZoneId
    price?: number;
    currency?: string;
  }[];
  ledger?: LedgerEntry[];
};

/* === MFG Plan (план партии) ============================= */
type PlanOrder = {
  id: string;
  number: string;
  date: string;                  // ISO
  status: "draft" | "approved" | "released" | "done" | "cancelled";
  productId: string;
  qty: number;
  dueDate?: string;              // ISO (опц.)
  physWarehouseId: string;
  fgZoneId: string;              // куда ляжет ГП после производства
  matZoneId: string;             // откуда спишутся материалы при производстве
  needs?: {                      // снимок расчёта потребности/дефицита
    materialId: string;
    need: number;
    available: number;
    shortage: number;
  }[];
  linkedProdReportId?: string;   // если из плана создали отчёт
};

function usePlans() {
  return useLocalState<PlanOrder[]>("mrp.mfg.plans.v1", []);
}



/* === initial seed складов (иерархия) ==================== */
const seedWarehousesV2 = (): Warehouse[] => {
  const phys1 = uid(), phys2 = uid();
  return [
    { id: phys1, name: "Логиново", type: "physical", isActive: true },
    { id: phys2, name: "Основной", type: "physical", isActive: true },
    { id: uid(), name: "Материалы", type: "virtual", parentId: phys1, isActive: true },
    { id: uid(), name: "Готовая продукция", type: "virtual", parentId: phys1, isActive: true },
    { id: uid(), name: "Материалы", type: "virtual", parentId: phys2, isActive: true },
    { id: uid(), name: "Готовая продукция", type: "virtual", parentId: phys2, isActive: true },
  ];
};

/* === общие хуки-хранилища =============================== */
function useWarehousesV2() {
  return useLocalState<Warehouse[]>("mrp.dict.warehouses.v2", seedWarehousesV2());
}
function useStockBalances() {
  return useLocalState<StockBalance[]>("mrp.stock.balances.v1", []);
}
function useProdReports() {
  return useLocalState<ProdReport[]>("mrp.mfg.prodReports.v1", []);
}
function useReceipts() {
  return useLocalState<Receipt[]>("mrp.purchase.receipts.v1", []);
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

/* === helpers по складам ================================ */
function splitWarehouses(whs: Warehouse[]) {
  const physical = whs.filter(w => w.type === "physical" && w.isActive);
  const virtual  = whs.filter(w => w.type === "virtual" && w.isActive);
  const zonesByPhys = (physId: string) => virtual.filter(v => v.parentId === physId);
  const findZoneByName = (physId: string, name = "") =>
    virtual.find(v => v.parentId === physId && v.name.trim().toLowerCase() === name.trim().toLowerCase());
  return { physical, virtual, zonesByPhys, findZoneByName };
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
    ],
  },
  {
    key: "purchase", title: "Закупки", icon: "ShoppingCart",
    subs: [
      { key: "products", title: "Товары", route: "/app/purchase/products" },
      { key: "materials", title: "Материалы", route: "/app/purchase/materials" },
      { key: "specs", title: "Спецификации", route: "/app/purchase/specs" },
      { key: "vendors", title: "Поставщики", route: "/app/purchase/vendors" },
      { key: "po", title: "Заказы поставщикам", route: "/app/purchase/po" },
      { key: "receipts", title: "Поступления", route: "/app/purchase/receipts" },             // NEW
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
      { key: "wh", title: "Склады", route: "/app/settings/wh" },
      { key: "users", title: "Пользователи/Роли", route: "/app/settings/users" },
      { key: "integr", title: "Интеграции", route: "/app/settings/integr" },
      { key: "nums", title: "Нумераторы", route: "/app/settings/nums" },
    ],
  },
];


/* ------------ Helpers ------------ */
const IconFor = ({ name, className = "w-5 h-5" }: { name?: string; className?: string }) => {
  switch (name) {
    case "Factory": return <Factory className={className} />;
    case "BarChart3": return <BarChart3 className={className} />;
    case "ShoppingCart": return <ShoppingCart className={className} />;
    case "Boxes": return <Boxes className={className} />;
    case "PieChart": return <PieChart className={className} />;
    case "Settings": return <Settings className={className} />;
    default: return <Boxes className={className} />;
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

/* ===================== MODAL (портал) ===================== */


function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <div className="text-xs text-slate-500 mb-1">
      {children}{required && <span className="ml-1 text-rose-500">*</span>}
    </div>
  );
}

/* ===================== MODAL (портал) ===================== */
function Modal({
  onClose,
  title,
  children,
  icon,
  width = 960,
}: {
  onClose: () => void;
  title?: string;
  children: ReactNode;
  icon?: ReactNode;
  width?: number; // можно передать уже в вызовах, если где-то нужен более узкий
}) {
  // блокируем скролл бэкграунда + закрытие по ESC
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div className="modal-overlay" onClick={onClose} aria-modal="true" role="dialog">
      <div
        className="modal-card"
        style={{ maxWidth: `${width}px` }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="modal-header">
          {icon ? (
            <div className="modal-header__icon">{icon}</div>
          ) : (
            <div className="modal-header__icon" />
          )}
          <div className="modal-header__title">
            <div className="modal-title">{title ?? "Диалог"}</div>
          </div>
          <button className="icon-btn" aria-label="Закрыть" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* body */}
        <div className="modal-body">{children}</div>

        {/* footer — по умолчанию пустой; если нужно, делай слот прямо в children */}
        {/* <div className="modal-footer">…</div> */}
      </div>
    </div>,
    document.body
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
    addVendor: (name: string) => Vendor;
    uoms: string[];
    categories: string[];
    addCategory: (name: string) => void;
  };
  ensureUniqueCode: (code: string, selfId?: string) => boolean;
}) {
  const [form, setForm] = React.useState<Material>(() => {
    if (initial) return { ...initial, category: (initial as any).category ?? "" };
    const code = genCode("MAT");
    return {
      id: uid(),
      code,
      name: "",
      vendorId: "",
      uom: dicts.uoms[0] ?? "шт",
      moq: 1,
      leadTimeDays: 0,
      price: undefined,
      currency: "RUB",
      category: "",
    };
  });

  const [showErrors, setShowErrors] = React.useState(false);

  const set = <K extends keyof Material>(k: K, v: Material[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const parseNum = (raw: string) => {
    const s = raw.replace(",", ".").trim();
    if (s === "") return NaN;
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  };

  const computeErrors = (draft: Material) => {
    const e: Record<string, string> = {};
    // code
    if (!draft.code?.trim()) e.code = "Обязательное поле";
    else if (draft.code.length > 20) e.code = "Макс. 20 символов";
    else if (!ensureUniqueCode(draft.code, draft.id)) e.code = "Код уже используется";

    if (!draft.name?.trim()) e.name = "Обязательное поле";
    if (!draft.vendorId) e.vendorId = "Выберите поставщика";
    if (!draft.uom) e.uom = "Обязательное поле";
    if (!draft.category) e.category = "Выберите категорию";
    if (!(draft.moq >= 1)) e.moq = "Минимум 1";
    if (!(draft.leadTimeDays >= 0)) e.leadTimeDays = "Не отрицательное";
    return e;
  };

  const errors  = React.useMemo(() => computeErrors(form), [form]);
  const isValid = React.useMemo(() => Object.keys(errors).length === 0, [errors]);

  // helper для data-invalid
  const err = (
    k: "code" | "name" | "vendorId" | "uom" | "category" | "moq" | "leadTimeDays"
  ) => showErrors && (errors as any)[k];

  // Автофокус на первое «красное» поле после попытки сохранения
  React.useEffect(() => {
    if (!showErrors) return;
    const first = document.querySelector('[data-invalid="true"]') as HTMLElement | null;
    if (first) {
      first.focus();
      first.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [showErrors, errors]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!isValid) { setShowErrors(true); return; }
        onSave(form);
      }}
    >
      <div className="text-lg font-semibold mb-3">
        {initial ? "Материал — редактирование" : "Новый материал"}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* Код */}
        <div>
          <Label required>Код</Label>
          <input
            maxLength={20}
            className="w-full px-3 py-2 rounded-xl border text-sm"
            data-invalid={err("code") || undefined}
            value={form.code}
            onChange={(e) => set("code", e.target.value)}
          />
          {showErrors && errors.code && (
            <div className="text-[11px] text-rose-500 mt-1">{errors.code}</div>
          )}
        </div>

        {/* Наименование */}
        <div>
          <Label required>Наименование</Label>
          <input
            className="w-full px-3 py-2 rounded-xl border text-sm"
            data-invalid={err("name") || undefined}
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
          />
          {showErrors && errors.name && (
            <div className="text-[11px] text-rose-500 mt-1">{errors.name}</div>
          )}
        </div>

        {/* Поставщик */}
        <div>
          <Label required>Поставщик</Label>
          <div className="flex items-center gap-2">
            <select
              className="flex-1 px-3 py-2 rounded-xl border text-sm"
              data-invalid={err("vendorId") || undefined}
              value={form.vendorId}
              onChange={(e) => set("vendorId", e.target.value)}
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
              className="app-pill app-pill--sm"
              title="Добавить поставщика"
              onClick={() => {
                const name = (window.prompt("Название поставщика:") ?? "").trim();
                if (!name) return;
                const v = dicts.addVendor(name);
                set("vendorId", v.id);
              }}
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>
          {showErrors && errors.vendorId && (
            <div className="text-[11px] text-rose-500 mt-1">{errors.vendorId}</div>
          )}
        </div>

        {/* Ед. изм. */}
        <div>
          <Label required>Ед. изм.</Label>
          <select
            className="w-full px-3 py-2 rounded-xl border text-sm"
            data-invalid={err("uom") || undefined}
            value={form.uom}
            onChange={(e) => set("uom", e.target.value)}
          >
            {dicts.uoms.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
          {showErrors && errors.uom && (
            <div className="text-[11px] text-rose-500 mt-1">{errors.uom}</div>
          )}
        </div>

        {/* Категория */}
        <div>
          <Label required>Категория</Label>
          <div className="flex items-center gap-2">
            <select
              className="flex-1 px-3 py-2 rounded-xl border text-sm"
              data-invalid={err("category") || undefined}
              value={form.category}
              onChange={(e) => set("category", e.target.value)}
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
              title="Добавить категорию"
              onClick={() => {
                const v = (window.prompt("Новая категория:") ?? "").trim();
                if (!v) return;
                dicts.addCategory(v);
                set("category", v);
              }}
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>
          {showErrors && errors.category && (
            <div className="text-[11px] text-rose-500 mt-1">{errors.category}</div>
          )}
        </div>

        {/* Мин. партия */}
        <div>
          <Label>Мин. партия</Label>
          <input
            type="number"
            min={1}
            step="1"
            inputMode="numeric"
            className="w-full px-3 py-2 rounded-xl border text-sm"
            data-invalid={err("moq") || undefined}
            value={String(form.moq)}
            onChange={(e) => {
              const n = parseNum(e.target.value);
              set("moq", Number.isNaN(n) ? form.moq : Math.max(1, Math.floor(n)));
            }}
          />
          {showErrors && errors.moq && (
            <div className="text-[11px] text-rose-500 mt-1">{errors.moq}</div>
          )}
        </div>

        {/* Срок поставки */}
        <div>
          <Label>Срок поставки, дней</Label>
          <input
            type="number"
            min={0}
            step="1"
            inputMode="numeric"
            className="w-full px-3 py-2 rounded-xl border text-sm"
            data-invalid={err("leadTimeDays") || undefined}
            value={String(form.leadTimeDays)}
            onChange={(e) => {
              const n = parseNum(e.target.value);
              set(
                "leadTimeDays",
                Number.isNaN(n) ? form.leadTimeDays : Math.max(0, Math.floor(n))
              );
            }}
          />
          {showErrors && errors.leadTimeDays && (
            <div className="text-[11px] text-rose-500 mt-1">{errors.leadTimeDays}</div>
          )}
        </div>

        {/* Цена (опц.) */}
        <div>
          <Label>Цена (опц.)</Label>
          <input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            className="w-full px-3 py-2 rounded-xl border text-sm"
            value={form.price ?? ""}
            onChange={(e) => {
              const n = parseNum(e.target.value);
              set("price", Number.isNaN(n) ? form.price : Math.max(0, n));
            }}
            placeholder="0.00"
          />
        </div>

        {/* Валюта */}
        <div>
          <Label>Валюта</Label>
          <select
            className="w-full px-3 py-2 rounded-xl border text-sm"
            value={form.currency ?? "RUB"}
            onChange={(e) => set("currency", e.target.value)}
          >
            {["RUB", "USD", "EUR"].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-4 flex gap-2 justify-end">
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



/* ===================== SPEC MODAL (привязка к материалам) ===================== */
function SpecModal({
  initial,
  onSave,
  onCancel,
  dict: { uoms, addUom },
  materials,
  vendors,
  upsertMaterialFromSpec, // открыть форму материала и вернуть сохранённый
}: {
  initial: Spec;
  onSave: (s: Spec) => void;
  onCancel: () => void;
  dict: { uoms: string[]; addUom: (name: string) => void };
  materials: Material[];
  vendors: Vendor[];
  upsertMaterialFromSpec: (prefillName?: string) => Promise<Material | null>;
}) {
  const [spec, setSpec] = useState<Spec>(initial);

  const addLine = () => {
    setSpec(s => ({
      ...s,
      lines: [...s.lines, { id: uid(), qty: 1, uom: uoms[0] ?? "шт" }]
    }));
  };
  const setLine = (id: string, patch: Partial<SpecLine>) =>
    setSpec(s => ({ ...s, lines: s.lines.map(l => l.id === id ? { ...l, ...patch } : l) }));
  const removeLine = (id: string) =>
    setSpec(s => ({ ...s, lines: s.lines.filter(l => l.id !== id) }));

  const validate = () =>
    spec.productCode.trim() && spec.productName.trim() &&
    spec.lines.length > 0 &&
    spec.lines.every(l => (l.materialId && Number(l.qty) > 0 && l.uom?.trim()));

  const save = () => { if (!validate()) return; onSave({ ...spec, updatedAt: new Date().toISOString() }); };

  const materialById = (id?: string) => materials.find(m => m.id === id);

  return (
    <form onSubmit={(e) => { e.preventDefault(); save(); }}>
      <div className="text-lg font-semibold mb-3">Спецификация — {spec.productCode} / {spec.productName}</div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <Label>Код товара</Label>
          <input className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" value={spec.productCode} onChange={(e) => setSpec(s => ({ ...s, productCode: e.target.value }))} />
        </div>
        <div>
          <Label>Наименование товара</Label>
          <input className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" value={spec.productName} onChange={(e) => setSpec(s => ({ ...s, productName: e.target.value }))} />
        </div>
      </div>

      <div className="overflow-auto rounded-xl border border-slate-100 bg-white">
        <table className="min-w-full text-sm table-compact">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2 w-[36%]">Материал</th>
              <th className="text-left px-3 py-2 w-[20%]">Поставщик</th>
              <th className="text-left px-3 py-2 w-[12%]">Кол-во</th>
              <th className="text-left px-3 py-2 w-[16%]">Ед. изм.</th>
              <th className="text-left px-3 py-2 w-[16%]">Действия</th>
            </tr>
          </thead>
          <tbody>
            {spec.lines.map(line => {
              const mat = materialById(line.materialId);
              const venName = mat ? (vendors.find(v => v.id === mat.vendorId)?.name ?? "") : "";
              const unlinked = !line.materialId && line.item; // старая строка
              return (
                <tr key={line.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <select
                        className={`flex-1 px-2 py-1 rounded-lg border text-sm ${unlinked ? "border-amber-400" : "border-slate-200"}`}
                        value={line.materialId ?? ""}
                        onChange={(e) => {
                          const id = e.target.value || undefined;
                          const chosen = materials.find(m => m.id === id);
                          setLine(line.id, { materialId: id, uom: chosen?.uom ?? line.uom });
                        }}
                      >
                        <option value=""></option>
                        {materials.map(m => <option key={m.id} value={m.id}>{m.code} — {m.name}</option>)}
                      </select>
                      <button
                        type="button"
                        className="app-pill app-pill--sm"
                        title="Создать материал…"
                        onClick={async () => {
                          const created = await upsertMaterialFromSpec(line.item?.trim() || "");
                          if (created) setLine(line.id, { materialId: created.id, uom: created.uom });
                        }}
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>
                    {unlinked && (
                      <div className="text-[11px] text-amber-600 mt-1">
                        Не привязано («{line.item}») — выберите/создайте материал
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">{venName}</td>
                  <td className="px-3 py-2">
                    <input
                      type="number" min={0} step="0.001" inputMode="decimal"
                      className="w-28 px-2 py-1 rounded-lg border border-slate-200 text-sm"
                      value={line.qty}
                      onChange={(e) => setLine(line.id, { qty: Number(e.target.value) })}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <select
                        className="px-2 py-1 rounded-lg border border-slate-200 text-sm"
                        value={line.uom}
                        onChange={(e) => setLine(line.id, { uom: e.target.value })}
                      >
                        {uoms.map(u => <option key={u} value={u}>{u}</option>)}
                      </select>
                      <button
                        type="button"
                        className="app-pill app-pill--sm"
                        title="Добавить единицу"
                        onClick={() => {
                          const name = (window.prompt("Новая единица измерения:") ?? "").trim();
                          if (!name) return;
                          addUom(name);
                          setLine(line.id, { uom: name });
                        }}
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <button type="button" className="app-pill app-pill--sm" onClick={() => removeLine(line.id)}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <button type="button" className="app-pill app-pill--md" onClick={addLine}><Plus className="w-4 h-4" /> Добавить строку</button>
        <div className="flex gap-2">
          <button type="button" className="app-pill app-pill--md" onClick={onCancel}>Отмена</button>
          <button type="submit" className="app-pill app-pill--md is-active" disabled={!validate()}>Сохранить</button>
        </div>
      </div>
    </form>
  );
}

/* ===================== PRODUCT FORM (с кнопкой "Спецификация…") ===================== */
function ProductForm({
  initial,
  onSave,
  onCancel,
  dicts,
  ensureUniqueCode,
  openSpecFor,
}: {
  initial: Product | null;
  onSave: (p: Product) => void;
  onCancel: () => void;
  dicts: {
    statuses: string[];
    categories: string[];
    uoms: string[];
    addCategory: (name: string) => void;
    addUom: (name: string) => void;
  };
  ensureUniqueCode: (code: string, selfId?: string) => boolean;
  openSpecFor: (p: { id?: string; code: string; name: string }) => void;
}) {
  const [form, setForm] = useState<Product>(
    initial ?? { status: "active", code: "", name: "", category: "", uom: "шт", price: undefined }
  );
  const [showErrors, setShowErrors] = useState(false);

  const codeRef = useRef<HTMLInputElement>(null);
  const catRef  = useRef<HTMLSelectElement>(null);
  const uomRef  = useRef<HTMLSelectElement>(null);

  useEffect(() => { codeRef.current?.focus(); }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); submit(); } };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  });

  const set = <K extends keyof Product>(k: K, v: Product[K]) => setForm((f) => ({ ...f, [k]: v }));

  const computeErrors = (draft: Product) => {
    const e: Record<string, string> = {};
    if (!draft.code?.trim()) e.code = "Обязательное поле";
    if (!draft.name?.trim()) e.name = "Обязательное поле";
    if (!draft.uom?.trim()) e.uom = "Обязательное поле";
    if (!ensureUniqueCode(draft.code, draft.id)) e.code = "Код уже используется";
    if (draft.price != null && !(draft.price >= 0)) e.price = "Неверная цена";
    return e;
  };
  const errors  = useMemo(() => computeErrors(form), [form]);
  const isValid = useMemo(() => Object.keys(errors).length === 0, [errors]);
  const err = (key: string) => showErrors && (errors as any)[key];
  const fld = (bad?: boolean) =>
  `w-full px-3 py-2 rounded-xl border text-sm ${bad ? "border-rose-400 ring-1 ring-rose-300" : "border-slate-200"}`;

  const submit = () => { if (!isValid) { setShowErrors(true); return; } onSave(initial ? { ...initial, ...form } : form); };

  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <div className="text-lg font-semibold mb-3">{initial ? "Редактирование товара" : "Новый товар"}</div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Статус</Label>
          <select className="w-full px-3 py-2 rounded-xl border border-slate-200 text-sm" value={form.status} onChange={(e) => set("status", e.target.value)}>
            {dicts.statuses.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div>
          <Label>Артикул (code)</Label>
          <input
            ref={codeRef}
            className={`w-full px-3 py-2 rounded-xl border text-sm ${showErrors && errors.code ? "border-rose-400" : "border-slate-200"}`}
            value={form.code}
            onChange={(e) => set("code", e.target.value)}
          />
          {showErrors && errors.code && <div className="text-[11px] text-rose-500 mt-1">{errors.code}</div>}
        </div>

        <div className="col-span-2">
          <div className="flex items-center justify-between mb-1">
            <Label>Наименование</Label>
            <button
              type="button"
              className="app-pill app-pill--sm"
              onClick={() => { if (!form.code.trim() || !form.name.trim()) { setShowErrors(true); return; } openSpecFor({ id: form.id, code: form.code, name: form.name }); }}
              title="Открыть спецификацию"
            >
              Спецификация…
            </button>
          </div>
          <input
            className={`w-full px-3 py-2 rounded-xl border text-sm ${showErrors && errors.name ? "border-rose-400" : "border-slate-200"}`}
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
          />
          {showErrors && errors.name && <div className="text-[11px] text-rose-500 mt-1">{errors.name}</div>}
        </div>

        <div>
          <Label>Категория</Label>
          <div className="flex items-center gap-2">
            <select
              ref={catRef}
              className="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-sm"
              value={form.category ?? ""}
              onChange={(e) => set("category", e.target.value)}
            >
              <option value=""></option>
              {dicts.categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <button
              type="button"
              className="app-pill app-pill--sm"
              title="Добавить категорию"
              onClick={() => {
                const v = (window.prompt("Новая категория:") ?? "").trim();
                if (!v) return;
                dicts.addCategory(v);
                set("category", v);
                requestAnimationFrame(() => catRef.current?.focus());
              }}
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>
        </div>

        <div>
          <Label>Ед. изм.</Label>
          <div className="flex items-center gap-2">
            <select
              ref={uomRef}
              className={`flex-1 px-3 py-2 rounded-xl border text-sm ${showErrors && errors.uom ? "border-rose-400" : "border-slate-200"}`}
              value={form.uom ?? ""}
              onChange={(e) => set("uom", e.target.value)}
            >
              {dicts.uoms.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
            <button
              type="button"
              className="app-pill app-pill--sm"
              title="Добавить единицу измерения"
              onClick={() => {
                const v = (window.prompt("Новая единица измерения:") ?? "").trim();
                if (!v) return;
                dicts.addUom(v);
                set("uom", v);
                requestAnimationFrame(() => uomRef.current?.focus());
              }}
            >
              <Plus className="w-3 h-3" />
            </button>
          </div>
          {showErrors && errors.uom && <div className="text-[11px] text-rose-500 mt-1">{errors.uom}</div>}
        </div>

        <div>
          <Label>Цена</Label>
          <div className="relative">
            <input
              type="number" min={0} step="0.01" inputMode="decimal"
              className={`w-full pr-8 px-3 py-2 rounded-xl border text-sm ${showErrors && errors.price ? "border-rose-400" : "border-slate-200"}`}
              value={form.price ?? ""}
              onChange={(e) => {
                const s = e.target.value.replace(",", "."); const n = s === "" ? undefined : Number(s);
                set("price", n as any);
              }}
              placeholder="0.00"
            />
            <span className="absolute right-2 top-2.5 text-slate-400 text-sm">₽</span>
          </div>
          {showErrors && errors.price && <div className="text-[11px] text-rose-500 mt-1">{errors.price}</div>}
        </div>
      </div>

      <div className="mt-4 flex gap-2 justify-end">
        <button type="button" className="app-pill app-pill--md" onClick={onCancel}>Отмена</button>
        <button type="submit" className="app-pill app-pill--md is-active" disabled={!isValid}>Сохранить</button>
      </div>
    </form>
  );
}

/* ===================== PRODUCTS VIEW ===================== */
function ProductsView() {
  const [items, setItems] = useLocalState<Product[]>(
    "mrp.products.v1",
    Array.from({ length: 10 }).map((_, i) => ({
      id: String(1000 + i),
      status: i % 2 ? "active" : "draft",
      code: `PRD-${1000 + i}`,
      name: `Тестовый товар ${i + 1}`,
      category: "Мебель",
      uom: "шт",
      price: 1340,
    }))
  );

  const [uoms, setUoms] = useLocalState<string[]>("mrp.dict.uoms", ["шт", "кг", "м"]);
  const [categories, setCategories] = useLocalState<string[]>("mrp.dict.categories", ["Мебель", "Аксессуары"]);
  const [vendors, setVendors] = useLocalState<Vendor[]>("mrp.vendors.v1", [{ id: uid(), name: "Поставщик A" }]);
  const [materials, setMaterials] = useLocalState<Material[]>("mrp.materials.v1", []);

  const statuses = ["draft", "active", "archived"];
  const addUom = (name: string) => setUoms((prev) => prev.includes(name) ? prev : [...prev, name]);
  const addCategory = (name: string) => setCategories((prev) => prev.includes(name) ? prev : [...prev, name]);
  const addVendor = (name: string): Vendor => {
    const v: Vendor = { id: uid(), name };
    setVendors(prev => [...prev, v]);
    return v;
  };
  const ensureUniqueProductCode = (code: string, selfId?: string) =>
    !items.some(p => p.code.trim().toLowerCase() === code.trim().toLowerCase() && p.id !== selfId);

  const ensureUniqueMaterialCode = (code: string, selfId?: string) =>
    !materials.some(m => m.code.trim().toLowerCase() === code.trim().toLowerCase() && m.id !== selfId);

  /* SPECS */
  const [specs, setSpecs] = useLocalState<Spec[]>("mrp.specs.v1", []);
  const upsertSpec = (spec: Spec) => {
    setSpecs(prev => {
      const i = prev.findIndex(s => s.id === spec.id);
      if (i >= 0) { const copy = [...prev]; copy[i] = spec; return copy; }
      return [spec, ...prev];
    });
  };
  const findSpecForProduct = (p: { id?: string; code: string }) =>
    specs.find(s => (p.id && s.productId === p.id) || s.productCode === p.code);

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
        category: "",
      });
      setMatModalOpen(true);
    });
  };

  const saveMaterial = (m: Material) => {
    setMaterials(prev => {
      const i = prev.findIndex(x => x.id === m.id);
      if (i >= 0) { const copy = [...prev]; copy[i] = m; return copy; }
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

  const openCreate = () => { setEditing(null); setProdModalOpen(true); };
  const openEdit = (p: Product) => { setEditing(p); setProdModalOpen(true); };

  const saveProduct = (p: Product) => {
    setItems((prev) => {
      if (p.id) return prev.map((x) => (x.id === p.id ? { ...x, ...p } : x));
      const id = String(Date.now());
      return [{ ...p, id }, ...prev];
    });
    setProdModalOpen(false);
  };

  const removeProduct = (id?: string) => {
    if (!id) return;
    const target = items.find(x => x.id === id);
    const ok = window.confirm(`Удалить товар «${target?.name ?? id}»? (Спецификация останется)`);
    if (!ok) return;
    setItems((prev) => prev.filter((x) => x.id !== id));
  };

  const openSpec = (p: { id?: string; code: string; name: string }) => {
    const existing = findSpecForProduct(p);
    const base: Spec = existing ?? {
      id: uid(),
      productId: p.id ?? null,
      productCode: p.code,
      productName: p.name,
      lines: [],
      updatedAt: new Date().toISOString(),
    };
    setSpecEditing(base);
    setSpecModalOpen(true);
  };

  return (
    <>
      <div className="app-plate app-plate--solid p-3">
        <div className="flex items-center gap-2 mb-2">
          <input className="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-sm" placeholder="Поиск" />
          <button className="app-pill app-pill--md">Фильтры</button>
          <button onClick={openCreate} className="app-pill app-pill--md is-active inline-flex items-center gap-2">
            <Plus className="w-4 h-4" /> Создать
          </button>
        </div>

        <div className="overflow-auto rounded-xl border border-slate-100 bg-white">
          <table className="min-w-full text-sm table-compact">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">Статус</th>
                <th className="text-left px-3 py-2">Код</th>
                <th className="text-left px-3 py-2">Наименование</th>
                <th className="text-left px-3 py-2">Категория</th>
                <th className="text-left px-3 py-2">Ед.</th>
                <th className="text-left px-3 py-2">Цена</th>
                <th className="text-left px-3 py-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => {
                const sp = findSpecForProduct(p);
                return (
                  <tr key={p.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-2">{p.status}</td>
                    <td className="px-3 py-2">{p.code}</td>
                    <td className="px-3 py-2">{p.name}</td>
                    <td className="px-3 py-2">{p.category}</td>
                    <td className="px-3 py-2">{p.uom}</td>
                    <td className="px-3 py-2">{p.price?.toLocaleString("ru-RU")}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <button className="app-pill app-pill--md" onClick={() => openEdit(p)} title="Редактировать">
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button className="app-pill app-pill--md" onClick={() => openSpec({ id: p.id, code: p.code, name: p.name })} title={sp ? `Редактировать спецификацию (${sp.lines.length} поз.)` : "Создать спецификацию"}>
                          Спецификация…
                        </button>
                        <button className="app-pill app-pill--md" onClick={() => removeProduct(p.id)} title="Удалить">
                          <Trash2 className="w-4 h-4" />
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

      {prodModalOpen && (
        <Modal onClose={() => setProdModalOpen(false)}>
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
        <Modal onClose={() => setSpecModalOpen(false)}>
          <SpecModal
            initial={specEditing}
            onSave={(s) => { upsertSpec(s); setSpecModalOpen(false); }}
            onCancel={() => setSpecModalOpen(false)}
            dict={{ uoms, addUom }}
            materials={materials}
            vendors={vendors}
            upsertMaterialFromSpec={upsertMaterialFromSpec}
          />
        </Modal>
      )}

      {matModalOpen && matEditing && (
        <Modal onClose={cancelMaterial}>
          <MaterialForm
            initial={matEditing}
            onCancel={cancelMaterial}
            onSave={saveMaterial}
            dicts={{ vendors, addVendor, uoms, categories, addCategory }}  // стало
            ensureUniqueCode={ensureUniqueMaterialCode}
          />
        </Modal>
      )}
    </>
  );
}

/* ===================== MATERIALS VIEW ===================== */
function MaterialsView() {
  const [materials, setMaterials] = useLocalState<Material[]>("mrp.materials.v1", []);
  const [vendors, setVendors] = useLocalState<Vendor[]>("mrp.vendors.v1", [{ id: uid(), name: "Поставщик A" }]);
  // справочники
const [uoms] = useLocalState<string[]>("mrp.dict.uoms", ["шт", "кг", "м"]);
const [categories, setCategories] = useLocalState<string[]>("mrp.dict.categories", ["Мебель", "Аксессуары"]); // <—
const addCategory = (name: string) => setCategories(prev => prev.includes(name) ? prev : [...prev, name]);   // <—


  const addVendor = (name: string): Vendor => { const v = { id: uid(), name }; setVendors(prev => [...prev, v]); return v; };
  const ensureUniqueCode = (code: string, selfId?: string) =>
    !materials.some(m => m.code.trim().toLowerCase() === code.trim().toLowerCase() && m.id !== selfId);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Material | null>(null);

  const openCreate = () => { setEditing(null); setModalOpen(true); };
  const openEdit = (m: Material) => { setEditing(m); setModalOpen(true); };

  const save = (m: Material) => {
    setMaterials(prev => {
      const i = prev.findIndex(x => x.id === m.id);
      if (i >= 0) { const copy = [...prev]; copy[i] = m; return copy; }
      return [m, ...prev];
    });
    setModalOpen(false);
  };

  const remove = (id: string) => {
    const target = materials.find(x => x.id === id);
    const ok = window.confirm(`Удалить материал «${target?.name ?? id}»?`);
    if (!ok) return;
    setMaterials(prev => prev.filter(x => x.id !== id));
  };

  const vendorName = (id: string) => vendors.find(v => v.id === id)?.name ?? "";

  return (
    <>
      <div className="app-plate app-plate--solid p-3">
        <div className="flex items-center gap-2 mb-2">
          <input className="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-sm" placeholder="Поиск" />
          <button className="app-pill app-pill--md" onClick={openCreate}><Plus className="w-4 h-4" /> Создать</button>
        </div>

        <div className="overflow-auto rounded-xl border border-slate-100 bg-white">
          <table className="min-w-full text-sm table-compact">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2 nowrap col-code">Код</th>
                <th className="text-left px-3 py-2">Наименование</th>
                <th className="text-left px-3 py-2" style={{width: 160}}>Поставщик</th>
                <th className="text-left px-3 py-2" style={{width: 120}}>Категория</th>
                <th className="text-left px-3 py-2" style={{width: 64}}>Ед.</th>
                <th className="text-left px-3 py-2" style={{width: 100}}>Мин. партия</th>
                <th className="text-left px-3 py-2" style={{width: 90}}>Срок, дни</th>
                <th className="text-left px-3 py-2" style={{width: 110}}>Цена</th>
                <th className="text-left px-3 py-2 nowrap col-actions">Действия</th>
              </tr>
            </thead>
            <tbody>
              {materials.map((m) => (
                <tr key={m.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 nowrap"><div className="truncate-ell">{m.code}</div></td>
                  <td className="px-3 py-2"><div className="truncate-ell">{m.name}</div></td>
                  <td className="px-3 py-2"><div className="truncate-ell">{vendorName(m.vendorId)}</div></td>
                  <td className="px-3 py-2"><div className="truncate-ell">{m.category}</div></td>
                  <td className="px-3 py-2 nowrap">{m.uom}</td>
                  <td className="px-3 py-2 nowrap">{m.moq}</td>
                  <td className="px-3 py-2 nowrap">{m.leadTimeDays}</td>
                  <td className="px-3 py-2 nowrap">{m.price != null ? `${m.price.toLocaleString("ru-RU")} ${m.currency ?? "RUB"}` : ""}</td>
                  <td className="px-3 py-2">
                    <div className="table-actions">
                      <button className="app-pill app-pill--sm" onClick={() => openEdit(m)} title="Редактировать">
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button className="app-pill app-pill--sm" onClick={() => remove(m.id)} title="Удалить">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {materials.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-400">Пока нет материалов</td></tr>
            )}
            </tbody>
          </table>
        </div>
      </div>

      {modalOpen && (
      <Modal onClose={() => setModalOpen(false)}>
        <MaterialForm
          initial={editing}
          onCancel={() => setModalOpen(false)}
          onSave={save}
          dicts={{ vendors, addVendor, uoms, categories, addCategory }}   // <—
          ensureUniqueCode={ensureUniqueCode}
        />
      </Modal>
    )}
    </>
  );
}

/* ===================== VENDORS VIEW (минимум) ===================== */
function VendorsView() {
  const [vendors, setVendors] = useLocalState<Vendor[]>("mrp.vendors.v1", [{ id: uid(), name: "Поставщик A" }]);

  const add = () => {
    const name = (window.prompt("Название поставщика:") ?? "").trim();
    if (!name) return;
    setVendors(prev => [...prev, { id: uid(), name }]);
  };
  const rename = (id: string) => {
    const v = vendors.find(x => x.id === id); if (!v) return;
    const name = (window.prompt("Новое название:", v.name) ?? "").trim();
    if (!name) return;
    setVendors(prev => prev.map(x => x.id === id ? { ...x, name } : x));
  };
  const remove = (id: string) => {
    const v = vendors.find(x => x.id === id);
    if (!v) return;
    if (!window.confirm(`Удалить поставщика «${v.name}»?`)) return;
    setVendors(prev => prev.filter(x => x.id !== id));
  };

  return (
    <div className="app-plate app-plate--solid p-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-sm text-slate-600">Всего: {vendors.length}</div>
        <button className="app-pill app-pill--md is-active" onClick={add}>
          <Plus className="w-4 h-4" /> Добавить
        </button>
      </div>
      <div className="overflow-auto rounded-xl border border-slate-100 bg-white">
        <table className="min-w-full text-sm table-compact">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Название</th>
              <th className="text-left px-3 py-2">Действия</th>
            </tr>
          </thead>
          <tbody>
            {vendors.map(v => (
              <tr key={v.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2">{v.name}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <button className="app-pill app-pill--md" title="Переименовать" onClick={() => rename(v.id)}>
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button className="app-pill app-pill--md" title="Удалить" onClick={() => remove(v.id)}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {vendors.length === 0 && (
              <tr><td colSpan={2} className="px-3 py-6 text-center text-slate-400">Нет поставщиков</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}


/* ===================== SPECS VIEW (как раньше) ===================== */
function SpecsView() {
  const [specs, setSpecs] = useLocalState<Spec[]>("mrp.specs.v1", []);
  const [uoms, setUoms] = useLocalState<string[]>("mrp.dict.uoms", ["шт", "кг", "м"]);
  const addUom = (name: string) => setUoms(prev => prev.includes(name) ? prev : [...prev, name]);

  const [materials] = useLocalState<Material[]>("mrp.materials.v1", []);
  const [vendors] = useLocalState<Vendor[]>("mrp.vendors.v1", []);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Spec | null>(null);

  // простой helper для создания материала из списка спецификаций:
  const upsertMaterialFromSpec = (prefill?: string) => {
    return new Promise<Material | null>((resolve) => {
      // в режиме списка спецификаций не держим форму материалов, поэтому просто скажем пользователю зайти в "Материалы"
      const ok = window.confirm(`Создать материал «${prefill || ""}» сейчас? Откроется раздел «Материалы».`);
      if (!ok) return resolve(null);
      // нет живой навигации — оставляем заглушку
      window.alert("Перейдите в «Закупки → Материалы» и создайте материал. Затем вернитесь к спецификации.");
      resolve(null);
    });
  };

  const openEdit = (s: Spec) => { setEditing(s); setModalOpen(true); };

  const upsert = (spec: Spec) => {
    setSpecs(prev => {
      const i = prev.findIndex(x => x.id === spec.id);
      if (i >= 0) { const copy = [...prev]; copy[i] = spec; return copy; }
      return [spec, ...prev];
    });
  };

  return (
    <>
      <div className="app-plate app-plate--solid p-3">
        <div className="overflow-auto rounded-xl border border-slate-100 bg-white">
          <table className="min-w-full text-sm table-compact">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">Код товара</th>
                <th className="text-left px-3 py-2">Наименование</th>
                <th className="text-left px-3 py-2">Позиций</th>
                <th className="text-left px-3 py-2">Обновлено</th>
                <th className="text-left px-3 py-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {specs.map(s => (
                <tr key={s.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2">{s.productCode}</td>
                  <td className="px-3 py-2">{s.productName}</td>
                  <td className="px-3 py-2">{s.lines.length}</td>
                  <td className="px-3 py-2">{new Date(s.updatedAt).toLocaleString("ru-RU")}</td>
                  <td className="px-3 py-2">
                    <button className="app-pill app-pill--md" onClick={() => openEdit(s)}>Редактировать…</button>
                  </td>
                </tr>
              ))}
              {specs.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">Пока нет спецификаций</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {modalOpen && editing && (
        <Modal onClose={() => setModalOpen(false)}>
          <SpecModal
            initial={editing}
            onSave={(s) => { upsert(s); setModalOpen(false); }}
            onCancel={() => setModalOpen(false)}
            dict={{ uoms, addUom }}
            materials={materials}
            vendors={vendors}
            upsertMaterialFromSpec={upsertMaterialFromSpec}
          />
        </Modal>
      )}
    </>
  );
}

/* ===================== MAIN SHELL ===================== */
export default function AppShell() {
  const [nav, setNav] = useLocalState<Section[]>("mrp.nav.v3", DEFAULT_NAV);
  const [collapsed, setCollapsed] = useLocalState<boolean>("mrp.sidebarCollapsed", false);
  const sidebarW = collapsed ? 68 : 256;

  const [activeSectionKey, setActiveSectionKey] = useLocalState<string>("mrp.activeSection", nav[0]?.key ?? "mfg");
  const currentSection = useMemo(
    () => nav.find(s => s.key === activeSectionKey) ?? nav[0],
    [nav, activeSectionKey]
  );
  const [activeSubKey, setActiveSubKey] = useLocalState<string>("mrp.activeSub", currentSection?.subs?.[0]?.key ?? "");

  useEffect(() => {
    if (!currentSection?.subs.find(x => x.key === activeSubKey)) {
      setActiveSubKey(currentSection?.subs?.[0]?.key ?? "");
    }
  }, [activeSectionKey]); // eslint-disable-line

  const pill = (isActive?: boolean) => `app-pill app-pill--md ${isActive ? "is-active" : ""}`;

  return (
    <div className="min-h-screen w-full bg-transparent text-slate-900">
      {/* -------- Sidebar -------- */}
      <aside id="mrp-sidebar" data-collapsed={collapsed} className={`${collapsed ? "w-[68px]" : "w-64"}`}>
        <div className="sidebar-header">
          <button title="Меню" onClick={() => setCollapsed(v => !v)}>
            <MenuIcon className="w-5 h-5" />
          </button>
          {!collapsed && <div className="ml-2 font-semibold tracking-tight">MRP-lite</div>}
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
        <div className="sticky top-0 z-0 px-0 pt-0">
          <div className="app-plate mrp-toolbar h-12 rounded-2xl shadow-sm border border-slate-200 bg-white flex items-center px-4 gap-3">
            <div className="hidden md:flex items-center gap-2">
              {(currentSection?.subs ?? []).map(t => {
                const active = t.key === activeSubKey;
                return (
                  <button key={t.key} onClick={() => setActiveSubKey(t.key)} className={pill(active)}>
                    {t.title}
                  </button>
                );
              })}
            </div>

            <div className="ml-auto relative" style={{ minWidth: 220 }}>
              <Search className="w-4 h-4 absolute left-2 top-2.5 text-slate-400" />
              <input
                placeholder="Поиск"
                className="pl-8 pr-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
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
            <SettingsUoms />
          ) : currentSection?.key === "settings" && activeSubKey === "curr" ? (
            <SettingsCurrencies />
          ) : currentSection?.key === "settings" && activeSubKey === "cats" ? (
            <SettingsCategories />
          ) : currentSection?.key === "settings" && activeSubKey === "wh" ? (
            <SettingsWarehouses />
            ) : currentSection?.key === "settings" && activeSubKey === "integr" ? (
            <SettingsIntegrations />
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
        <button className="app-pill app-pill--md is-active" onClick={add}>
          <Plus className="w-4 h-4" /> Добавить
        </button>
      </div>
      <div className="overflow-auto rounded-xl border border-slate-100 bg-white">
        <table className="min-w-full text-sm table-compact">
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
                        className="app-pill app-pill--md"
                        title="Переименовать"
                        onClick={() => rename(v)}
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      className="app-pill app-pill--md"
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
  const [uoms, setUoms] = useLocalState<string[]>("mrp.dict.uoms", ["шт", "кг", "м"]);
  return <DictList title="Единицы измерения" items={uoms} setItems={setUoms} />;
}
function SettingsCurrencies() {
  const [curr, setCurr] = useLocalState<string[]>("mrp.dict.currencies", ["RUB","USD","EUR"]);
  // валюты обычно не переименовывают — запретим rename
  return <DictList title="Валюты" items={curr} setItems={setCurr} allowRename={false} placeholder="Новая валюта (например, GBP)" />;
}
function SettingsCategories() {
  const [cats, setCats] = useLocalState<string[]>("mrp.dict.categories", ["Мебель","Аксессуары"]);
  return <DictList title="Категории" items={cats} setItems={setCats} />;
}
function SettingsWarehouses() {
  const [whs, setWhs] = useWarehousesV2();
  const [balances] = useStockBalances();
  const { physical, zonesByPhys } = splitWarehouses(whs);

  const addPhysical = () => {
    const name = (window.prompt("Название физического склада:") ?? "").trim();
    if (!name) return;
    setWhs(prev => [...prev, { id: uid(), name, type: "physical", isActive: true }]);
  };
  const addZone = (physId: string) => {
    const name = (window.prompt("Название зоны (виртуальный склад):") ?? "").trim();
    if (!name) return;
    setWhs(prev => [...prev, { id: uid(), name, type: "virtual", parentId: physId, isActive: true }]);
  };
  const renameWh = (id: string, curName: string) => {
    const name = (window.prompt("Новое название:", curName) ?? "").trim();
    if (!name) return;
    setWhs(prev => prev.map(w => w.id === id ? { ...w, name } : w));
  };
  const canDelete = (id: string) => !balances.some(b => b.warehouseId === id);
  const removeWh = (id: string, name: string) => {
    if (!canDelete(id)) return window.alert(`Нельзя удалить «${name}»: есть связанные остатки.`);
    if (!window.confirm(`Удалить «${name}»?`)) return;
    setWhs(prev => prev.filter(w => w.id !== id && w.parentId !== id)); // физ.+его зоны
  };

  return (
    <div className="app-plate app-plate--solid p-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-sm text-slate-600">Физические склады: {physical.length}</div>
        <button className="app-pill app-pill--md is-active" onClick={addPhysical}><Plus className="w-4 h-4" /> Физический</button>
      </div>

      <div className="overflow-auto rounded-xl border border-slate-100 bg-white">
        <table className="min-w-full text-sm table-compact">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Физический склад</th>
              <th className="text-left px-3 py-2">Зоны (виртуальные)</th>
              <th className="text-left px-3 py-2">Действия</th>
            </tr>
          </thead>
          <tbody>
            {physical.map(p => {
              const zones = zonesByPhys(p.id);
              return (
                <tr key={p.id} className="border-t border-slate-100 align-top">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="font-medium">{p.name}</div>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-2">
                      {zones.map(z => (
                        <div key={z.id} className="inline-flex items-center gap-2 px-2 py-1 rounded-lg border border-slate-200">
                          <span>{z.name}</span>
                          <button className="app-pill app-pill--sm" title="Переименовать" onClick={() => renameWh(z.id, z.name)}><Pencil className="w-4 h-4" /></button>
                          <button className="app-pill app-pill--sm" title="Удалить" onClick={() => removeWh(z.id, z.name)}><Trash2 className="w-4 h-4" /></button>
                        </div>
                      ))}
                      <button className="app-pill app-pill--sm is-active" onClick={() => addZone(p.id)}><Plus className="w-3 h-3" /> Зона</button>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <button className="app-pill app-pill--md" title="Переименовать" onClick={() => renameWh(p.id, p.name)}><Pencil className="w-4 h-4" /></button>
                      <button className="app-pill app-pill--md" title="Удалить" onClick={() => removeWh(p.id, p.name)}><Trash2 className="w-4 h-4" /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {physical.length === 0 && <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-400">Пока нет складов</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BalancesView() {
  const [materials] = useLocalState<Material[]>("mrp.materials.v1", []);
  const [products]  = useLocalState<Product[]>("mrp.products.v1", []);
  const [whs]       = useWarehousesV2();
  const { balances } = useStockRepo();
  const { physical, virtual } = splitWarehouses(whs);

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
    const w = whs.find(x => x.id === id);
    if (!w) return "";
    if (w.type === "virtual") {
      const parent = whs.find(x => x.id === w.parentId);
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
        <select className="px-3 py-2 rounded-xl border text-sm" value={typeFilter} onChange={e => setTypeFilter(e.target.value as any)}>
          <option value="all">Все</option>
          <option value="material">Материалы</option>
          <option value="product">Товары</option>
        </select>

        <select className="px-3 py-2 rounded-xl border text-sm" value={whFilter} onChange={e => setWhFilter(e.target.value)}>
          <option value="">Все склады</option>
          <optgroup label="Физические">
            {physical.map(p => <option key={p.id} value={p.id} disabled>{p.name}</option>)}
          </optgroup>
          <optgroup label="Зоны">
            {virtual.map(v => {
              const parent = whs.find(x => x.id === v.parentId);
              return <option key={v.id} value={v.id}>{parent ? `${parent.name} / ${v.name}` : v.name}</option>;
            })}
          </optgroup>
        </select>

        <input className="flex-1 min-w-[220px] px-3 py-2 rounded-xl border text-sm" placeholder="Код или наименование" value={q} onChange={e => setQ(e.target.value)} />
      </div>

      <div className="overflow-auto rounded-xl border border-slate-100 bg-white">
        <table className="min-w-full text-sm table-compact">
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
  const [reports, setReports] = useProdReports();
  const [products] = useLocalState<Product[]>("mrp.products.v1", []);
  const [specs]    = useLocalState<Spec[]>("mrp.specs.v1", []);
  const [whs, setWhs] = useWarehousesV2();
  const { zonesByPhys, findZoneByName } = splitWarehouses(whs);
  const { applyLedger, revertLedger, getQty } = useStockRepo();

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ProdReport | null>(null);

  const newNumber = () => `PRD-${Date.now().toString().slice(-6)}`;
  const openCreate = () => {
    const phys = whs.find(w => w.type === "physical");
    const fg = phys && findZoneByName(phys.id, "Готовая продукция");
    const mat = phys && findZoneByName(phys.id, "Материалы");
    setEditing({
      id: uid(),
      number: newNumber(),
      date: new Date().toISOString(),
      status: "draft",
      productId: products[0]?.id ?? "",
      qty: 1,
      physWarehouseId: phys?.id ?? "",
      fgZoneId: fg?.id ?? (zonesByPhys(phys?.id ?? "")[0]?.id ?? ""),
      matZoneId: mat?.id ?? (zonesByPhys(phys?.id ?? "")[0]?.id ?? ""),
    });
    setModalOpen(true);
  };
  const openEdit = (r: ProdReport) => { setEditing(r); setModalOpen(true); };

  const addZoneUnder = (physId: string, nameHint: string) => {
    const name = (window.prompt("Название зоны:", nameHint) ?? "").trim();
    if (!name) return;
    const z: Warehouse = { id: uid(), name, type: "virtual", parentId: physId, isActive: true };
    setWhs(prev => [...prev, z]);
    return z;
  };

  const productById = (id: string) => products.find(p => p.id === id);

  const specForProduct = (p: Product | undefined) => {
    if (!p) return undefined;
    return specs.find(s => (p.id && s.productId === p.id) || s.productCode === p.code);
  };

  const computeLedger = (doc: ProdReport): { ok: true; ledger: LedgerEntry[] } | { ok: false; msg: string } => {
    const p = productById(doc.productId);
    if (!p) return { ok: false, msg: "Не выбран товар" };
    if (!doc.fgZoneId || !doc.matZoneId) return { ok: false, msg: "Не выбраны зоны" };
    const sp = specForProduct(p);
    if (!sp) return { ok: false, msg: `Нет спецификации для ${p.code}` };

    const ledger: LedgerEntry[] = [];
    // приход ГП
    ledger.push({ itemType: "product", itemId: p.id!, warehouseId: doc.fgZoneId, delta: doc.qty });

    // обязательный backflush — списание материалов
    for (const line of sp.lines) {
      if (!line.materialId) return { ok: false, msg: `Строка спецификации без привязки к материалу: «${line.item ?? ""}»` };
      const need = line.qty * doc.qty;
      // проверяем остаток
      const have = getQty("material", line.materialId, doc.matZoneId);
      if (have < need) {
        return { ok: false, msg: `Не хватает материала: need ${need} ${line.uom}, есть ${have} (${line.materialId}) в выбранной зоне` };
      }
      ledger.push({ itemType: "material", itemId: line.materialId, warehouseId: doc.matZoneId, delta: -need });
    }
    return { ok: true, ledger };
  };

  const saveDraft = (doc: ProdReport) => {
    setReports(prev => {
      const i = prev.findIndex(x => x.id === doc.id);
      if (i >= 0) { const copy = [...prev]; copy[i] = doc; return copy; }
      return [doc, ...prev];
    });
    setModalOpen(false);
  };

  const post = (doc: ProdReport) => {
    const res = computeLedger(doc);
    if (!("ok" in res) || !res.ok) { return window.alert(res.msg); }
    try {
      applyLedger(res.ledger);
      saveDraft({ ...doc, status: "posted", ledger: res.ledger });
    } catch (e: any) {
      window.alert(e?.message ?? "Ошибка при проведении");
    }
  };
  const unpost = (doc: ProdReport) => {
    if (!doc.ledger || doc.status !== "posted") return;
    try {
      revertLedger(doc.ledger);
      saveDraft({ ...doc, status: "draft", ledger: undefined });
    } catch (e: any) {
      window.alert(e?.message ?? "Ошибка отмены проведения");
    }
  };
  const remove = (id: string) => {
    const d = reports.find(x => x.id === id);
    if (!d) return;
    if (d.status === "posted") return window.alert("Удалять можно только черновики. Отмените проведение.");
    if (!window.confirm(`Удалить документ ${d.number}?`)) return;
    setReports(prev => prev.filter(x => x.id !== id));
  };

  return (
    <>
      <div className="app-plate app-plate--solid p-3">
        <div className="flex items-center gap-2 mb-2">
          <button className="app-pill app-pill--md is-active" onClick={openCreate}><Plus className="w-4 h-4" /> Создать</button>
        </div>

        <div className="overflow-auto rounded-xl border border-slate-100 bg-white">
          <table className="min-w-full text-sm table-compact">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">Номер / Дата</th>
                <th className="text-left px-3 py-2">Товар</th>
                <th className="text-left px-3 py-2">Кол-во</th>
                <th className="text-left px-3 py-2">Склад (ГП / Мат.)</th>
                <th className="text-left px-3 py-2">Статус</th>
                <th className="text-left px-3 py-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {reports.map(d => {
                const p = productById(d.productId);
                const whFg = whs.find(w => w.id === d.fgZoneId);
                const whMat = whs.find(w => w.id === d.matZoneId);
                const fmtZone = (w?: Warehouse) => {
                  if (!w) return "";
                  if (w.type === "virtual") {
                    const parent = whs.find(x => x.id === w.parentId);
                    return parent ? `${parent.name} / ${w.name}` : w.name;
                  }
                  return w.name;
                };
                return (
                  <tr key={d.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">
                      <div className="font-medium">{d.number}</div>
                      <div className="text-slate-500 text-xs">{new Date(d.date).toLocaleString("ru-RU")}</div>
                    </td>
                    <td className="px-3 py-2">{p?.code} — {p?.name}</td>
                    <td className="px-3 py-2">{d.qty}</td>
                    <td className="px-3 py-2">
                      <div>ГП: {fmtZone(whFg)}</div>
                      <div className="text-xs text-slate-500">Мат.: {fmtZone(whMat)}</div>
                    </td>
                    <td className="px-3 py-2">{d.status}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <button className="app-pill app-pill--md" onClick={() => openEdit(d)}>Ред.</button>
                        {d.status === "draft" ? (
                          <button className="app-pill app-pill--md is-active" onClick={() => post(d)}>Провести</button>
                        ) : (
                          <button className="app-pill app-pill--md" onClick={() => unpost(d)}>Отменить проведение</button>
                        )}
                        <button className="app-pill app-pill--md" onClick={() => remove(d.id)}><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {reports.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Нет документов</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {modalOpen && editing && (
        <Modal onClose={() => setModalOpen(false)}>
          <form onSubmit={(e)=>{e.preventDefault(); saveDraft(editing);}}>
            <div className="text-lg font-semibold mb-3">Отчёт о производстве</div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Номер</Label>
                <input className="w-full px-3 py-2 rounded-xl border text-sm" value={editing.number}
                       onChange={e=>setEditing(s=>({...s!, number: e.target.value}))}/>
              </div>
              <div>
                <Label>Дата</Label>
                <input type="datetime-local" className="w-full px-3 py-2 rounded-xl border text-sm"
                       value={editing.date.slice(0,16)}
                       onChange={e=>setEditing(s=>({...s!, date: new Date(e.target.value).toISOString()}))}/>
              </div>

              <div>
                <Label>Товар</Label>
                <select className="w-full px-3 py-2 rounded-xl border text-sm" value={editing.productId}
                        onChange={e=>setEditing(s=>({...s!, productId: e.target.value}))}>
                  {products.map(p => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
                </select>
              </div>
              <div>
                <Label>Кол-во</Label>
                <input type="number" min={0.001} step="0.001" className="w-full px-3 py-2 rounded-xl border text-sm"
                       value={editing.qty} onChange={e=>setEditing(s=>({...s!, qty: Number(e.target.value)}))}/>
              </div>

              <div>
                <Label>Физический склад</Label>
                <select className="w-full px-3 py-2 rounded-xl border text-sm"
                        value={editing.physWarehouseId}
                        onChange={e=>{
                          const physId = e.target.value;
                          const fg = findZoneByName(physId, "Готовая продукция") ?? zonesByPhys(physId)[0];
                          const mat = findZoneByName(physId, "Материалы") ?? zonesByPhys(physId)[0];
                          setEditing(s=>({...s!, physWarehouseId: physId, fgZoneId: fg?.id ?? "", matZoneId: mat?.id ?? ""}));
                        }}>
                  {whs.filter(w=>w.type==="physical").map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </div>

              <div>
                <Label>Зона Готовой продукции</Label>
                <div className="flex items-center gap-2">
                  <select className="flex-1 px-3 py-2 rounded-xl border text-sm" value={editing.fgZoneId}
                          onChange={e=>setEditing(s=>({...s!, fgZoneId: e.target.value}))}>
                    {zonesByPhys(editing.physWarehouseId).map(z => <option key={z.id} value={z.id}>{z.name}</option>)}
                  </select>
                  <button type="button" className="app-pill app-pill--sm" onClick={()=>{
                    const z = addZoneUnder(editing.physWarehouseId, "Готовая продукция");
                    if (z) setEditing(s=>({...s!, fgZoneId: z.id}));
                  }}><Plus className="w-3 h-3" /></button>
                </div>
              </div>

              <div>
                <Label>Зона Материалов (списание)</Label>
                <div className="flex items-center gap-2">
                  <select className="flex-1 px-3 py-2 rounded-xl border text-sm" value={editing.matZoneId}
                          onChange={e=>setEditing(s=>({...s!, matZoneId: e.target.value}))}>
                    {zonesByPhys(editing.physWarehouseId).map(z => <option key={z.id} value={z.id}>{z.name}</option>)}
                  </select>
                  <button type="button" className="app-pill app-pill--sm" onClick={()=>{
                    const z = addZoneUnder(editing.physWarehouseId, "Материалы");
                    if (z) setEditing(s=>({...s!, matZoneId: z.id}));
                  }}><Plus className="w-3 h-3" /></button>
                </div>
              </div>
            </div>

            <div className="mt-4 flex gap-2 justify-end">
              <button type="button" className="app-pill app-pill--md" onClick={()=>setModalOpen(false)}>Отмена</button>
              {editing.status === "draft" ? (
                <>
                  <button type="submit" className="app-pill app-pill--md">Сохранить</button>
                  <button type="button" className="app-pill app-pill--md is-active" onClick={()=>post(editing!)}>Провести</button>
                </>
              ) : (
                <button type="button" className="app-pill app-pill--md" onClick={()=>unpost(editing!)}>Отменить проведение</button>
              )}
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

function ReceiptsView() {
  const [receipts, setReceipts] = useReceipts();
  const [materials] = useLocalState<Material[]>("mrp.materials.v1", []);
  const [vendors] = useLocalState<Vendor[]>("mrp.vendors.v1", [{ id: uid(), name: "Поставщик A" }]);
  const [whs, setWhs] = useWarehousesV2();
  const { zonesByPhys, findZoneByName } = splitWarehouses(whs);
  const { applyLedger, revertLedger } = useStockRepo();

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Receipt | null>(null);

  const newNumber = () => `RCV-${Date.now().toString().slice(-6)}`;
  const openCreate = () => {
    const phys = whs.find(w => w.type === "physical");
    const defZone = phys && findZoneByName(phys.id, "Материалы");
    setEditing({
      id: uid(),
      number: newNumber(),
      date: new Date().toISOString(),
      status: "draft",
      vendorId: vendors[0]?.id,
      physWarehouseId: phys?.id ?? "",
      defaultZoneId: defZone?.id ?? (zonesByPhys(phys?.id ?? "")[0]?.id ?? ""),
      fromPoId: null,
      lines: [],
    });
    setModalOpen(true);
  };
  const openEdit = (r: Receipt) => { setEditing(r); setModalOpen(true); };

  const addZoneUnder = (physId: string) => {
    const name = (window.prompt("Название зоны:", "Материалы") ?? "").trim();
    if (!name) return;
    const z: Warehouse = { id: uid(), name, type: "virtual", parentId: physId, isActive: true };
    setWhs(prev => [...prev, z]);
    return z;
  };

  const addLine = () => {
    const m = materials[0];
    if (!m) return window.alert("Нет материалов");
    setEditing(s => s ? ({ ...s, lines: [...s.lines, { id: uid(), materialId: m.id, qty: 1 }] }) : s);
  };
  const setLine = (id: string, patch: Partial<Receipt["lines"][0]>) =>
    setEditing(s => s ? ({ ...s, lines: s.lines.map(l => l.id === id ? { ...l, ...patch } : l) }) : s);
  const removeLine = (id: string) =>
    setEditing(s => s ? ({ ...s, lines: s.lines.filter(l => l.id !== id) }) : s);

  const computeLedger = (doc: Receipt): { ok: true; ledger: LedgerEntry[] } | { ok: false; msg: string } => {
    if (!doc.defaultZoneId) return { ok: false, msg: "Не выбрана зона" };
    const ledger: LedgerEntry[] = [];
    for (const line of doc.lines) {
      if (!line.materialId) return { ok: false, msg: "Пустая строка (материал)" };
      if (!(line.qty > 0)) return { ok: false, msg: "Кол-во должно быть > 0" };
      const zone = line.zoneId ?? doc.defaultZoneId;
      ledger.push({ itemType: "material", itemId: line.materialId, warehouseId: zone, delta: line.qty });
    }
    if (ledger.length === 0) return { ok: false, msg: "Нет строк для проведения" };
    return { ok: true, ledger };
  };

  const saveDraft = (doc: Receipt) => {
    setReceipts(prev => {
      const i = prev.findIndex(x => x.id === doc.id);
      if (i >= 0) { const copy = [...prev]; copy[i] = doc; return copy; }
      return [doc, ...prev];
    });
    setModalOpen(false);
  };

  const post = (doc: Receipt) => {
    const res = computeLedger(doc);
    if (!res.ok) return window.alert(res.msg);
    try {
      applyLedger(res.ledger);
      saveDraft({ ...doc, status: "posted", ledger: res.ledger });
    } catch (e: any) {
      window.alert(e?.message ?? "Ошибка проведения");
    }
  };
  const unpost = (doc: Receipt) => {
    if (!doc.ledger || doc.status !== "posted") return;
    try {
      revertLedger(doc.ledger);
      saveDraft({ ...doc, status: "draft", ledger: undefined });
    } catch (e: any) {
      window.alert(e?.message ?? "Ошибка отмены");
    }
  };
  const remove = (id: string) => {
    const d = receipts.find(x => x.id === id);
    if (!d) return;
    if (d.status === "posted") return window.alert("Удалять можно только черновики. Отмените проведение.");
    if (!window.confirm(`Удалить документ ${d.number}?`)) return;
    setReceipts(prev => prev.filter(x => x.id !== id));
  };

  const whTitle = (zoneId?: string) => {
    if (!zoneId) return "";
    const z = whs.find(w => w.id === zoneId);
    if (!z) return "";
    const p = whs.find(w => w.id === z.parentId);
    return z.type === "virtual" && p ? `${p.name} / ${z.name}` : z.name;
  };

  return (
    <>
      <div className="app-plate app-plate--solid p-3">
        <div className="flex items-center gap-2 mb-2">
          <button className="app-pill app-pill--md is-active" onClick={openCreate}><Plus className="w-4 h-4" /> Создать</button>
        </div>

        <div className="overflow-auto rounded-xl border border-slate-100 bg-white">
          <table className="min-w-full text-sm table-compact">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-left px-3 py-2">Номер / Дата</th>
                <th className="text-left px-3 py-2">Поставщик</th>
                <th className="text-left px-3 py-2">Склад/Зона</th>
                <th className="text-left px-3 py-2">Строк</th>
                <th className="text-left px-3 py-2">Статус</th>
                <th className="text-left px-3 py-2">Действия</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map(d => {
                const ven = vendors.find(v => v.id === d.vendorId)?.name ?? "";
                return (
                  <tr key={d.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">
                      <div className="font-medium">{d.number}</div>
                      <div className="text-slate-500 text-xs">{new Date(d.date).toLocaleString("ru-RU")}</div>
                    </td>
                    <td className="px-3 py-2">{ven}</td>
                    <td className="px-3 py-2">{whTitle(d.defaultZoneId)}</td>
                    <td className="px-3 py-2">{d.lines.length}</td>
                    <td className="px-3 py-2">{d.status}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <button className="app-pill app-pill--md" onClick={() => openEdit(d)}>Ред.</button>
                        {d.status === "draft" ? (
                          <button className="app-pill app-pill--md is-active" onClick={() => post(d)}>Провести</button>
                        ) : (
                          <button className="app-pill app-pill--md" onClick={() => unpost(d)}>Отменить проведение</button>
                        )}
                        <button className="app-pill app-pill--md" onClick={() => remove(d.id)}><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {receipts.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Нет документов</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {modalOpen && editing && (
        <Modal onClose={() => setModalOpen(false)}>
          <form onSubmit={(e)=>{e.preventDefault(); setModalOpen(false); setReceipts(prev=>{const i=prev.findIndex(x=>x.id===editing.id); if(i>=0){const c=[...prev]; c[i]=editing; return c;} return [editing, ...prev];});}}>
            <div className="text-lg font-semibold mb-3">Поступление</div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Номер</Label>
                <input className="w-full px-3 py-2 rounded-xl border text-sm" value={editing.number}
                       onChange={e=>setEditing(s=>({...s!, number: e.target.value}))}/>
              </div>
              <div>
                <Label>Дата</Label>
                <input type="datetime-local" className="w-full px-3 py-2 rounded-xl border text-sm"
                       value={editing.date.slice(0,16)}
                       onChange={e=>setEditing(s=>({...s!, date: new Date(e.target.value).toISOString()}))}/>
              </div>

              <div>
                <Label>Поставщик (опц.)</Label>
                <select className="w-full px-3 py-2 rounded-xl border text-sm"
                        value={editing.vendorId ?? ""}
                        onChange={e=>setEditing(s=>({...s!, vendorId: e.target.value || undefined}))}>
                  <option value=""></option>
                  {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </div>

              <div>
                <Label>Физический склад</Label>
                <select className="w-full px-3 py-2 rounded-xl border text-sm"
                        value={editing.physWarehouseId}
                        onChange={e=>{
                          const physId = e.target.value;
                          const def = findZoneByName(physId, "Материалы") ?? zonesByPhys(physId)[0];
                          setEditing(s=>({...s!, physWarehouseId: physId, defaultZoneId: def?.id ?? ""}));
                        }}>
                  {whs.filter(w=>w.type==="physical").map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </div>

              <div className="col-span-2">
                <Label>Зона по умолчанию</Label>
                <div className="flex items-center gap-2">
                  <select className="flex-1 px-3 py-2 rounded-xl border text-sm"
                          value={editing.defaultZoneId}
                          onChange={e=>setEditing(s=>({...s!, defaultZoneId: e.target.value}))}>
                    {zonesByPhys(editing.physWarehouseId).map(z => <option key={z.id} value={z.id}>{z.name}</option>)}
                  </select>
                  <button type="button" className="app-pill app-pill--sm" onClick={()=>{
                    const z = addZoneUnder(editing.physWarehouseId);
                    if (z) setEditing(s=>({...s!, defaultZoneId: z.id}));
                  }}><Plus className="w-3 h-3" /></button>
                </div>
              </div>
            </div>

            {/* Строки */}
            <div className="mt-3 overflow-auto rounded-xl border border-slate-100 bg-white">
              <table className="min-w-full text-sm table-compact">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="text-left px-3 py-2 w-[36%]">Материал</th>
                    <th className="text-left px-3 py-2 w-[16%]">Кол-во</th>
                    <th className="text-left px-3 py-2 w-[28%]">Зона</th>
                    <th className="text-left px-3 py-2 w-[20%]">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {editing.lines.map(line => {
                    const mat = materials.find(m => m.id === line.materialId);
                    return (
                      <tr key={line.id} className="border-t border-slate-100">
                        <td className="px-3 py-2">
                          <select className="w-full px-2 py-1 rounded-lg border text-sm" value={line.materialId}
                                  onChange={e=>setLine(line.id, { materialId: e.target.value })}>
                            {materials.map(m => <option key={m.id} value={m.id}>{m.code} — {m.name}</option>)}
                          </select>
                          <div className="text-xs text-slate-500 mt-1">{mat?.uom}</div>
                        </td>
                        <td className="px-3 py-2">
                          <input type="number" min={0.001} step="0.001" className="w-28 px-2 py-1 rounded-lg border text-sm"
                                 value={line.qty} onChange={e=>setLine(line.id, { qty: Number(e.target.value) })}/>
                        </td>
                        <td className="px-3 py-2">
                          <select className="w-full px-2 py-1 rounded-lg border text-sm"
                                  value={line.zoneId ?? editing.defaultZoneId}
                                  onChange={e=>setLine(line.id, { zoneId: e.target.value })}>
                            {zonesByPhys(editing.physWarehouseId).map(z => <option key={z.id} value={z.id}>{z.name}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <button type="button" className="app-pill app-pill--sm" onClick={()=>removeLine(line.id)}><Trash2 className="w-4 h-4" /></button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-3 flex items-center justify-between">
              <button type="button" className="app-pill app-pill--md" onClick={addLine}><Plus className="w-4 h-4" /> Добавить строку</button>
              <div className="flex gap-2">
                <button type="button" className="app-pill app-pill--md" onClick={()=>setModalOpen(false)}>Отмена</button>
                {editing.status === "draft" ? (
                  <>
                    <button type="submit" className="app-pill app-pill--md">Сохранить</button>
                    <button type="button" className="app-pill app-pill--md is-active" onClick={()=>post(editing!)}>Провести</button>
                  </>
                ) : (
                  <button type="button" className="app-pill app-pill--md" onClick={()=>unpost(editing!)}>Отменить проведение</button>
                )}
              </div>
            </div>
          </form>
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

function PlanGridView() {
  // ---- источники данных
  const [products] = useLocalState<Product[]>("mrp.products.v1", []);
  const [specs]    = useLocalState<Spec[]>("mrp.specs.v1", []);
  const [cats]     = useLocalState<string[]>("mrp.dict.categories", []);
  const [whs]      = useWarehousesV2();
  const { zonesByPhys, findZoneByName } = splitWarehouses(whs);
  const { getQty } = useStockRepo();

  // ---- состояние представления
  const todayISO = new Date().toISOString().slice(0,10); // YYYY-MM-DD
  const [startISO, setStartISO] = useLocalState<string>("mrp.plan.startISO", todayISO);
  const [days, setDays]         = useLocalState<number>("mrp.plan.days", 14);
  const [rtl, setRtl]           = useLocalState<boolean>("mrp.plan.rtl", true);
  const [catFilter, setCatFilter] = useLocalState<string>("mrp.plan.cat", "");

  // склад/зоны
  const physDefault = useMemo(() => whs.find(w => w.type === "physical")?.id ?? "", [whs]);
  const [physId, setPhysId]   = useLocalState<string>("mrp.plan.phys", physDefault);
  const defFg = findZoneByName(physId || physDefault, "Готовая продукция") ?? zonesByPhys(physId || physDefault)[0];
  const defMz = findZoneByName(physId || physDefault, "Материалы")        ?? zonesByPhys(physId || physDefault)[0];
  const [fgZoneId, setFgZoneId]   = useLocalState<string>("mrp.plan.fgZone", defFg?.id ?? "");
  const [matZoneId, setMatZoneId] = useLocalState<string>("mrp.plan.matZone", defMz?.id ?? "");

  // ---- хранилища план/факт
  type PlanMap = Record<string, Record<string, number>>; // productId -> YYYY-MM-DD -> qty
  const [planMap, setPlanMap] = useLocalState<PlanMap>("mrp.plan.planMap.v1", {});
  const [factMap, setFactMap] = useLocalState<PlanMap>("mrp.plan.factMap.v1", {});

  const setPlan = (pid: string, dateISO: string, val: number) =>
    setPlanMap(prev => ({ ...prev, [pid]: { ...(prev[pid]||{}), [dateISO]: val } }));

  const setFact = (pid: string, dateISO: string, val: number) =>
    setFactMap(prev => ({ ...prev, [pid]: { ...(prev[pid]||{}), [dateISO]: val } }));

  // ---- диапазон дат
  const range = useMemo(() => {
    const base = new Date(startISO+"T00:00:00");
    const list: string[] = [];
    for (let i=0; i<days; i++){
      const d = new Date(base);
      d.setDate(d.getDate()+i);
      list.push(d.toISOString().slice(0,10));
    }
    return rtl ? list.reverse() : list;
  }, [startISO, days, rtl]);

  const fmt = (iso: string) => {
    const d = new Date(iso+"T00:00:00");
    const dd = String(d.getDate()).padStart(2,"0");
    const mm = String(d.getMonth()+1).padStart(2,"0");
    return `${dd}.${mm}`;
  };
  const weekday = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    return ["Вс","Пн","Вт","Ср","Чт","Пт","Сб"][d.getDay()];
  };
  const dayMeta = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const isToday = iso === new Date().toISOString().slice(0,10);
    return { isWeekend, isToday };
  };

  // ---- фильтрация товаров
  const rows = useMemo(() => {
    const base = products.filter(p => p.status !== "archived");
    return catFilter ? base.filter(p => (p.category||"") === catFilter) : base;
  }, [products, catFilter]);

  // ---- итоги по дням
  const totals = useMemo(() => {
    const res: Record<string, { plan: number; fact: number }> = {};
    for (const d of range) res[d] = { plan: 0, fact: 0 };
    for (const p of rows) {
      const pid = p.id!;
      for (const d of range) {
        res[d].plan += Number(planMap[pid]?.[d] || 0);
        res[d].fact += Number(factMap[pid]?.[d] || 0);
      }
    }
    return res;
  }, [rows, range, planMap, factMap]);

  // ---- поиск спецификации
  const specFor = (p: Product | undefined) => {
    if (!p) return undefined;
    return specs.find(s => (p.id && s.productId === p.id) || s.productCode === p.code);
  };

  // ---- остатки
  const fgBalanceOf = (pid: string) => (fgZoneId ? getQty("product", pid, fgZoneId) : 0);

  // ---- обеспеченность материалов на дату (простая проверка «здесь и сейчас»)
  const covered = (pid: string, dateISO: string): boolean => {
    if (!matZoneId) return true;
    const p = products.find(x => x.id === pid);
    const sp = specFor(p);
    const plan = Number(planMap[pid]?.[dateISO] || 0);
    if (!sp || plan <= 0) return true;
    for (const line of sp.lines) {
      if (!line.materialId) return false; // есть «непривязанные»
      const need = (line.qty || 0) * plan;
      const have = getQty("material", line.materialId, matZoneId);
      if (have + 1e-8 < need) return false;
    }
    return true;
  };

  // ---- кнопки дат
  const addLeft   = (n: number) => { const d = new Date(startISO+"T00:00:00"); d.setDate(d.getDate()-n); setStartISO(d.toISOString().slice(0,10)); setDays(days+n); };
  const addRight  = (n: number) => { setDays(days+n); };
  const removeRight = (n: number) => { setDays(Math.max(1, days-n)); };

  // узкое поле ввода БЕЗ нулей (показывает пусто при 0)
const NumberCell = ({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) => {
  return (
    <input
      type="number"
      inputMode="decimal"
      min={0}
      step="0.001"
      className="input-compact"
      // при 0 показываем пустую строку (но в состоянии хранится 0)
      value={value === 0 || !Number.isFinite(value) ? "" : String(value)}
      placeholder="0"
      onChange={(e) => {
        const s = e.target.value.replace(",", ".").trim();
        if (s === "") { onChange(0); return; }           // пусто = 0 в данных
        const n = Number(s);
        onChange(Number.isFinite(n) && n >= 0 ? n : 0);  // защита от мусора
      }}
    />
  );
};


  return (
    <div className="mrp-page">
      <div className="mrp-card">
        {/* --- компактная шапка/фильтры --- */}
        <div className="mrp-toolbar flex items-center flex-wrap gap-2 mb-2">
          {/* Период */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-600">Период c</span>
            <input type="date" className="input-compact" value={startISO}
                   onChange={e => setStartISO(e.target.value)} />
            <input type="number" className="input-compact w-[56px]" value={days}
                   onChange={e => setDays(Math.max(1, Number(e.target.value)||1))} />
          </div>

          {/* +/- дни */}
          <div className="flex items-center gap-1">
            <button className="app-pill app-pill--sm" onClick={() => addLeft(1)}>+1 слева</button>
            <button className="app-pill app-pill--sm" onClick={() => addRight(1)}>+1 справа</button>
            <button className="app-pill app-pill--sm" onClick={() => addLeft(7)}>+7 слева</button>
            <button className="app-pill app-pill--sm" onClick={() => addRight(7)}>+7 справа</button>
            <button className="app-pill app-pill--sm" onClick={() => removeRight(1)}>-1 справа</button>
          </div>

          {/* RTL */}
          <label className="text-sm inline-flex items-center gap-1 ml-2">
            <input type="checkbox" checked={rtl} onChange={e => setRtl(e.target.checked)} />
            Справа → налево
          </label>

          {/* Категория */}
          <div className="flex items-center gap-2 ml-3">
            <span className="text-xs text-slate-600">Категория</span>
            <select className="input-compact" value={catFilter} onChange={e => setCatFilter(e.target.value)}>
              <option value="">(все)</option>
              {cats.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          {/* Склад/зоны */}
          <div className="flex items-center gap-2 ml-3">
            <span className="text-xs text-slate-600">Склад</span>
            <select className="input-compact" value={physId}
                    onChange={e => {
                      const id = e.target.value;
                      setPhysId(id);
                      const fg = findZoneByName(id, "Готовая продукция") ?? zonesByPhys(id)[0];
                      const mz = findZoneByName(id, "Материалы") ?? zonesByPhys(id)[0];
                      setFgZoneId(fg?.id ?? ""); setMatZoneId(mz?.id ?? "");
                    }}>
              {whs.filter(w=>w.type==="physical").map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>

            <span className="text-xs text-slate-600">ГП</span>
            <select className="input-compact" value={fgZoneId} onChange={e => setFgZoneId(e.target.value)}>
              {zonesByPhys(physId).map(z => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>

            <span className="text-xs text-slate-600">Материалы</span>
            <select className="input-compact" value={matZoneId} onChange={e => setMatZoneId(e.target.value)}>
              {zonesByPhys(physId).map(z => <option key={z.id} value={z.id}>{z.name}</option>)}
            </select>
          </div>
        </div>

        {/* --- таблица в горизонтальном скролле --- */}
        <div className="mrp-hscroll">
          <table className="min-w-full text-sm table-compact plangrid">
            <thead>
              <tr>
                <th className="sticky bg-white z-10 prod-col text-left px-2 py-2" style={{ left: 0 }}>
                  Продукт
                </th>
                <th className="sticky bg-white z-10 fg-col text-left px-2 py-2" style={{ left: "var(--prod-w)" }}>
                  Остаток ГП
                </th>
                <th className="sticky bg-white z-10 metric-col text-left px-2 py-2" style={{ left: "calc(var(--prod-w) + var(--fg-w))" }}>
                  Показатель
                </th>

                {range.map(d => {
                  const { isWeekend, isToday } = dayMeta(d);
                  return (
                    <th
                      key={d}
                      className={`date-col text-center px-2 py-2 ${isWeekend ? "is-weekend" : ""} ${isToday ? "is-today" : ""}`}
                    >
                      <div className="font-semibold">{fmt(d)}</div>
                      <div className="text-[11px] text-slate-500">{weekday(d)}</div>
                    </th>
                  );
                })}
              </tr>
            </thead>

            <tbody>
              {rows.map((p) => {
                const pid = p.id!;

                const PlanRow = (
                  <tr key={`${pid}-plan`} className="border-t border-slate-200">
                    {/* липкие колонки слева — на 3 строки */}
                    <td className="sticky prod-col align-top px-2 py-[6px]" rowSpan={3} style={{ left: 0, background: "#fff" }}>
                      <div className="font-medium truncate">{p.code} — {p.name}</div>
                    </td>
                    <td className="sticky fg-col align-top px-2 py-[6px]" rowSpan={3} style={{ left: "var(--prod-w)", background: "#fff" }}>
                      {fgBalanceOf(pid)}
                    </td>

                    {/* показатель */}
                    <td className="sticky metric-col px-2 py-[6px]" style={{ left: "calc(var(--prod-w) + var(--fg-w))", background: "#fff" }}>
                      План
                    </td>

                    {/* даты: План */}
                    {range.map(d => {
                      const planVal = Number(planMap[pid]?.[d] || 0);
                      return (
                        <td key={d} className="date-col px-2 py-[6px]">
                          <NumberCell value={planVal} onChange={n => setPlan(pid, d, n)} />
                        </td>
                      );
                    })}
                  </tr>
                );

                const FactRow = (
                  <tr key={`${pid}-fact`} className="border-t border-slate-100">
                    <td className="sticky metric-col px-2 py-[6px]" style={{ left: "calc(var(--prod-w) + var(--fg-w))", background: "#fff" }}>
                      Произведено
                    </td>
                    {range.map(d => {
                      const factVal = Number(factMap[pid]?.[d] || 0);
                      return (
                        <td key={d} className="date-col px-2 py-[6px]">
                          <NumberCell value={factVal} onChange={n => setFact(pid, d, n)} />
                        </td>
                      );
                    })}
                  </tr>
                );

                const CoverRow = (
                  <tr key={`${pid}-cover`} className="border-t border-slate-100">
                    <td className="sticky metric-col px-2 py-[6px]" style={{ left: "calc(var(--prod-w) + var(--fg-w))", background: "#fff" }}>
                      Мат. обеспеч.
                    </td>
                    {range.map(d => {
                      const planVal = Number(planMap[pid]?.[d] || 0);
                      if (planVal <= 0) {
                        return <td key={d} className="date-col text-center px-2 py-[6px]"></td>;
                      }
                      const ok = covered(pid, d);
                      return (
                        <td key={d} className="date-col text-center px-2 py-[6px]">
                          <span className={ok ? "text-emerald-500" : "text-rose-500"}>{ok ? "✓" : "✕"}</span>
                        </td>
                      );
                    })}
                  </tr>
                );

                return (
                  <React.Fragment key={pid}>
                    {PlanRow}
                    {FactRow}
                    {CoverRow}
                  </React.Fragment>
                );
              })}

              {rows.length === 0 && (
                <tr>
                  <td colSpan={3 + range.length} className="px-3 py-6 text-center text-slate-400">
                    Нет товаров для выбранной категории
                  </td>
                </tr>
              )}
            </tbody>

            <tfoot>
              <tr className="border-t border-slate-200">
                <td className="prod-col font-medium px-2 py-2" style={{ left: 0, background: "#fff" }}>Итого по дню</td>
                <td className="fg-col px-2 py-2" style={{ left: "var(--prod-w)", background: "#fff" }}></td>
                <td className="metric-col px-2 py-2" style={{ left: "calc(var(--prod-w) + var(--fg-w))", background: "#fff" }}></td>
                {range.map(d => (
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
