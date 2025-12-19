// file: src/SpecModal.tsx
import React from "react";
import { supabase } from "../../api/supabaseClient";
import { upsertSpecSupabase } from "../../utils/specSupabase";
import { useSupabaseUoms, useSupabaseVendors } from "../../hooks/useSupabaseDicts";

/* ========= Типы ========= */
type Material = { id: string; code: string; name: string; uom?: string; category?: string; status?: string; vendorId?: string };
type Semi     = { id: string; code: string; name: string; uom?: string; category?: string; status?: string };
type Vendor   = { id: string; name: string };

type SpecLine = {
  id: string;
  kind?: "mat" | "semi"; // default: 'mat'
  refId?: string;        // id материала / ПФ
  // legacy:
  materialId?: string;
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

type ProductRef = { id?: string; code?: string; name?: string };

type Props = {
  open: boolean;
  onClose: () => void;
  spec?: Spec | null;
  productRef?: ProductRef;
  onSaved?: (id: string) => void;
};

/* ========= Утилиты ========= */
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
  React.useEffect(() => { localStorage.setItem(key, JSON.stringify(state)); }, [key, state]);
  return [state, setState] as const;
}
const normalizeLine = (ln: SpecLine): SpecLine => {
  const kind = ln.kind ?? "mat";
  const refId = ln.refId ?? ln.materialId ?? "";
  return { id: ln.id || uid(), kind, refId, qty: ln.qty || 0, uom: ln.uom || "" };
};

/* ========= Источники ========= */
const useMaterials = () => useLocalState<Material[]>("mrp.materials.v1", []);
const useSemis     = () => useLocalState<Semi[]>("mrp.semis.v1", []);
const useSpecs     = () => useLocalState<Spec[]>("mrp.specs.v1", []);
const isUuid = (s?: string | null) =>
  !!s &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s ?? "");

/* ========= Компонент ========= */
export default function SpecModal({ open, onClose, spec, productRef, onSaved }: Props) {
  const [materials, setMaterials] = useMaterials();
  const [semis, setSemis] = useSemis();
  const { uoms: uomRecords } = useSupabaseUoms();
  const { vendors } = useSupabaseVendors();
  const uoms = React.useMemo(() => uomRecords.map((u) => u.name), [uomRecords]);
  const [specs, setSpecs] = useSpecs();
  const [dictLoading, setDictLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    const needMaterials = materials.length === 0 || materials.some((m) => !isUuid(m.id));
    const needSemis = semis.length === 0 || semis.some((s) => !isUuid(s.id));
    if (!needMaterials && !needSemis) return;

    let aborted = false;
    const load = async () => {
      setDictLoading(true);
      try {
        const { data, error } = await supabase
          .from("items")
          .select("id, kind, code, name, uom, category, vendor_id, vendor_name")
          .in("kind", ["material", "semi"]);
        if (error) throw error;
        if (aborted) return;
        const base: Array<{
          kind: "material" | "semi";
          id: string;
          code: string;
          name: string;
          uom?: string;
          category?: string;
          vendorId?: string;
        }> = (data || []).map((row: any) => ({
          kind: (row.kind as "material" | "semi") ?? "material",
          id: row.id as string,
          code: row.code as string,
          name: row.name as string,
          uom: row.uom || "",
          category: row.category || "",
          vendorId: row.vendor_id || undefined,
        }));
        if (needMaterials) {
          setMaterials(
            base
              .filter((b) => b.kind === "material")
              .map(({ kind: _kind, ...rest }) => rest) as Material[]
          );
        }
        if (needSemis) {
          setSemis(
            base
              .filter((b) => b.kind === "semi")
              .map(({ kind: _kind, ...rest }) => rest) as Semi[]
          );
        }
      } catch (err) {
        console.error("SpecModal: failed to load dictionaries from Supabase", err);
      } finally {
        if (!aborted) setDictLoading(false);
      }
    };
    load();
    return () => {
      aborted = true;
    };
  }, [open, materials, semis, setMaterials, setSemis]);

  const initialSpec: Spec = React.useMemo(() => {
    if (spec) return { ...spec, lines: (spec.lines || []).map(normalizeLine) };
    return {
      id: uid(),
      productId: productRef?.id ?? null,
      productCode: productRef?.code ?? "",
      productName: productRef?.name ?? "",
      lines: [],
      updatedAt: new Date().toISOString(),
    };
  }, [spec, productRef?.id, productRef?.code, productRef?.name]);

  const [draft, setDraft] = React.useState<Spec>(initialSpec);
  React.useEffect(() => setDraft(initialSpec), [initialSpec]);

  const dictFor = (k: "mat"|"semi") => (k === "mat" ? materials : semis);
  const findById = (k: "mat"|"semi", id?: string) => (id ? dictFor(k).find(x => x.id === id) : undefined);

  const addLine = (kind: "mat" | "semi" = "mat") =>
    setDraft(d => ({ ...d, lines: [...d.lines, { id: uid(), kind, refId: "", qty: 0, uom: uoms[0] || "" }] }));

  const updateLine = (id: string, patch: Partial<SpecLine>) =>
    setDraft(d => ({ ...d, lines: d.lines.map(ln => ln.id === id ? normalizeLine({ ...ln, ...patch }) : ln) }));

  const removeLine = (id: string) =>
    setDraft(d => ({ ...d, lines: d.lines.filter(ln => ln.id !== id) }));

  const validate = (): string | null => {
    if (!draft.productCode?.trim() || !draft.productName?.trim()) return "Не заполнены код/наименование изделия";
    if (draft.lines.length === 0) return "Добавьте хотя бы одну строку";
    for (const ln of draft.lines) {
      const n = normalizeLine(ln);
      if (!n.refId) return "Не выбран код номенклатуры в одной из строк";
      if (!(n.qty > 0)) return "Количество должно быть > 0";
      if (!n.uom?.trim()) return "Единица измерения обязательна";
    }
    return null;
  };

  const [saving, setSaving] = React.useState(false);

  const save = async () => {
    if (saving) return;
    const err = validate();
    if (err) { alert(err); return; }
    const clean: Spec = {
      ...draft,
      lines: draft.lines.map(ln => {
        const n = normalizeLine(ln);
        return { id: n.id, kind: n.kind, refId: n.refId, qty: n.qty, uom: n.uom };
      }),
      updatedAt: new Date().toISOString(),
    };
    setSaving(true);
    try {
      const specId = await upsertSpecSupabase(clean, { materials, semis, vendors });
      clean.id = specId;
    } catch (error) {
      console.error("SpecModal: supabase save failed", error);
      alert("Не удалось сохранить спецификацию в базе, см. консоль для деталей.");
      setSaving(false);
      return;
    }

    setSpecs(prev => {
      const idx = prev.findIndex(s =>
        (s.id && s.id === clean.id) ||
        (!!clean.productId && s.productId === clean.productId) ||
        (!!clean.productCode && s.productCode === clean.productCode)
      );
      let next: Spec[];
      if (idx >= 0) { const copy = prev.slice(); copy[idx] = clean; next = copy; }
      else          next = [clean, ...prev];
      try {
        localStorage.setItem("mrp.specs.v1", JSON.stringify(next));
      } catch (err) {
        console.warn("SpecModal: failed to persist specs", err);
      }
      return next;
    });
    onSaved?.(clean.id);
    onClose();
    setSaving(false);
  };

  if (!open) return null;

  /* ======= UI ======= */
  const headerRow = (
    <tr>
      <th className="text-left px-2 py-2 w-[110px]">Тип</th>
      <th className="text-left px-2 py-2 w-[80px]">Код</th>
      <th className="text-left px-2 py-2">Наименование</th>
      <th className="text-right px-2 py-2 w-[120px]">Кол-во</th>
      <th className="text-left px-2 py-2 w-[120px]">Ед.</th>
      <th className="text-right px-2 py-2 w-[60px]"></th>
    </tr>
  );

  return (
    <div className="modal-shell" role="dialog" aria-modal="true">
      <div className="modal-backdrop" onClick={onClose} />
      <div className="modal-window" style={{ width: "95vw", maxWidth: 1180 }}>
        <div className="modal-header">
          <div className="modal-title">
            <strong>Спецификация</strong>
            <div className="text-sm text-slate-500">
              {(draft.productCode || "").trim()} {draft.productCode ? "— " : ""}{draft.productName || "Без наименования"}
            </div>
          </div>
          <div className="modal-actions">
            <button className="app-pill app-pill--md" onClick={onClose}>Отмена</button>
            <button className="app-pill app-pill--md is-active" onClick={save} disabled={saving}>
              {saving ? "Сохраняем…" : "Сохранить"}
            </button>
          </div>
        </div>

        <div className="modal-body-viewport" style={{ maxHeight: "78vh" }}>
          {/* Шапка изделия */}
          <div className="ui-form form-grid-2">
            <div>
              <div className="form-label">Код спецификации</div>
              <input
                className="form-control"
                value={draft.productCode}
                onChange={(e) => setDraft({ ...draft, productCode: e.target.value })}
                placeholder="Введите код спецификации"
              />
            </div>
            <div>
              <div className="form-label">Наименование спецификации</div>
              <input
                className="form-control"
                value={draft.productName}
                onChange={(e) => setDraft({ ...draft, productName: e.target.value })}
                placeholder="Введите наименование спецификации"
              />
            </div>
          </div>

          {dictLoading && (
            <div className="mt-2 text-xs text-slate-500">
              Загружаем номенклатуру из Supabase…
            </div>
          )}

          {/* Таблица строк (компактная) */}
          <div className="table-wrapper mt-3">
            <table className="min-w-full text-sm table-compact">
              <thead>{headerRow}</thead>
              <tbody>
                {draft.lines.map((ln) => {
                  const n = normalizeLine(ln);
                  const options = dictFor(n.kind);
                  const chosen = findById(n.kind!, n.refId);

                  return (
                    <tr key={n.id} className="border-t border-slate-200">
                      {/* Тип */}
                      <td className="px-2 py-[6px]">
                        <select
                          className="form-control"
                          value={n.kind}
                          onChange={(e) => updateLine(n.id, { kind: e.target.value as "mat" | "semi", refId: "" })}
                        >
                          <option value="mat">Материал</option>
                          <option value="semi">Полуфабрикат</option>
                        </select>
                      </td>

                      {/* Код (селект по коду, узкий) */}
                      <td className="px-2 py-[6px]" style={{ width: 90 }}>
                        <select
                          className="form-control"
                          style={{ width: 90 }}
                          value={n.refId}
                          onChange={(e) => {
                            const refId = e.target.value;
                            // подставим ЕИ по умолчанию из справочника (если есть)
                            const src = findById(n.kind!, refId);
                            updateLine(n.id, { refId, uom: src?.uom || n.uom });
                          }}
                        >
                          <option value="">(выберите код)</option>
                          {options.map((x) => (
                            <option key={x.id} value={x.id}>{x.code}</option>
                          ))}
                        </select>
                      </td>

                      {/* Наименование (селект по имени) */}
                      <td className="px-2 py-[6px]">
                        <select
                          className="form-control"
                          style={{ minWidth: 220 }}
                          value={n.refId}
                          onChange={(e) => {
                            const refId = e.target.value;
                            const src = findById(n.kind!, refId);
                            updateLine(n.id, { refId, uom: src?.uom || n.uom });
                          }}
                        >
                          <option value="">(выберите наименование)</option>
                          {options.map((x) => (
                            <option key={x.id} value={x.id}>{x.name}</option>
                          ))}
                        </select>
                      </td>

                      {/* Кол-во (узко, по правому краю) */}
                      <td className="px-2 py-[6px]">
                        <input
                          className="form-control num-compact text-right"
                          type="number"
                          min={0}
                          step="any"
                          value={Number.isFinite(n.qty) ? n.qty : 0}
                          onChange={(e) => updateLine(n.id, { qty: Number(e.target.value) || 0 })}
                        />
                      </td>

                      {/* Единица (селект из справочника) */}
                      <td className="px-2 py-[6px]">
                        <select
                          className="form-control"
                          value={n.uom || ""}
                          onChange={(e) => updateLine(n.id, { uom: e.target.value })}
                        >
                          <option value=""></option>
                          {uoms.map(u => <option key={u} value={u}>{u}</option>)}
                        </select>
                      </td>

                      {/* delete */}
                      <td className="px-2 py-[6px] text-right">
                        <button className="act" title="Удалить" onClick={() => removeLine(n.id)}>✖</button>
                      </td>
                    </tr>
                  );
                })}

                {draft.lines.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-4 text-center text-slate-500">
                      Пока нет строк. Добавьте материал или полуфабрикат.
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                {headerRow /* дублированная шапка для визуального баланса на длинных списках */}
              </tfoot>
            </table>
          </div>

          <div className="mt-2 flex gap-2">
            <button type="button" className="app-pill app-pill--sm" onClick={() => addLine("mat")}>+ Материал</button>
            <button type="button" className="app-pill app-pill--sm" onClick={() => addLine("semi")}>+ Полуфабрикат</button>          </div>
        </div>
      </div>
    </div>
  );
}
