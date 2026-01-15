// file: src/SpecModal.tsx
import React from "react";
import { supabase } from "../../api/supabaseClient";
import { fetchSpecsFromSupabase } from "../../utils/specSupabase";
import { upsertSpecSupabase } from "../../utils/specSupabase";
import { useSupabaseUoms, useSupabaseVendors } from "../../hooks/useSupabaseDicts";

/* ========= Типы ========= */
type Material = { id: string; code: string; name: string; uom?: string; group?: string; status?: string; vendorId?: string };
type Semi     = { id: string; code: string; name: string; uom?: string; group?: string; status?: string };
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
  effectiveFrom?: string;
  version?: number;
  lines: SpecLine[];
  updatedAt: string;
};

type SpecVersionRow = {
  id: string;
  specCode: string;
  specName: string;
  version: number | null;
  effectiveFrom: string | null;
  createdAt: string | null;
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
const mapRecordToSpec = (row: any): Spec => ({
  id: row.id as string,
  productId: row.linkedProductId ?? null,
  productCode: (row.specCode ?? "").toString(),
  productName: (row.specName ?? "").toString(),
  effectiveFrom: row.effectiveFrom ?? null,
  version: row.version ?? undefined,
  updatedAt: row.updatedAt ?? new Date().toISOString(),
  lines: (row.lines ?? []).map((ln: any) => ({
    id: ln.id as string,
    kind: (ln.kind as "mat" | "semi") ?? "mat",
    refId: ln.refId as string,
    qty: Number(ln.qty) || 0,
    uom: ln.uom || "",
  })),
});

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
  const [versionRows, setVersionRows] = React.useState<SpecVersionRow[]>([]);
  const [versionsLoading, setVersionsLoading] = React.useState(false);
  const [selectedVersionId, setSelectedVersionId] = React.useState<string | null>(null);
  const [selectedVersionLines, setSelectedVersionLines] = React.useState<SpecLine[]>([]);
  const [selectedVersionLoading, setSelectedVersionLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    const needMaterials =
      materials.length === 0 ||
      materials.some((m) => !isUuid(m.id) || !m.uom);
    const needSemis =
      semis.length === 0 ||
      semis.some((s) => !isUuid(s.id) || !s.uom);
    if (!needMaterials && !needSemis) return;

    let aborted = false;
    const load = async () => {
      setDictLoading(true);
      try {
        const { data, error } = await supabase
          .from("items")
          .select("id, kind, code, name, uom, group_name, vendor_id, vendor_name")
          .in("kind", ["material", "semi"]);
        if (error) throw error;
        if (aborted) return;
        const base: Array<{
          kind: "material" | "semi";
          id: string;
          code: string;
          name: string;
          uom?: string;
          group?: string;
          vendorId?: string;
        }> = (data || []).map((row: any) => ({
          kind: (row.kind as "material" | "semi") ?? "material",
          id: row.id as string,
          code: row.code as string,
          name: row.name as string,
          uom: row.uom || "",
          group: row.group_name || "",
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
    if (spec) {
      return {
        ...spec,
        effectiveFrom: spec.effectiveFrom || new Date().toISOString().slice(0, 10),
        lines: (spec.lines || []).map(normalizeLine),
      };
    }
    return {
      id: uid(),
      productId: productRef?.id ?? null,
      productCode: productRef?.code ?? "",
      productName: productRef?.name ?? "",
      effectiveFrom: new Date().toISOString().slice(0, 10),
      lines: [],
      updatedAt: new Date().toISOString(),
    };
  }, [spec, productRef?.id, productRef?.code, productRef?.name]);

  const [draft, setDraft] = React.useState<Spec>(initialSpec);
  React.useEffect(() => setDraft(initialSpec), [initialSpec]);
  const latestVersionId = versionRows[0]?.id ?? null;
  const isReadOnly = Boolean(selectedVersionId && draft.id && selectedVersionId !== draft.id);

  const dictFor = (k: "mat"|"semi") => (k === "mat" ? materials : semis);
  const findById = (k: "mat"|"semi", id?: string) => (id ? dictFor(k).find(x => x.id === id) : undefined);

  React.useEffect(() => {
    if (!draft.lines.length) return;
    if (!materials.length && !semis.length) return;
    let changed = false;
    const nextLines = draft.lines.map((ln) => {
      const n = normalizeLine(ln);
      const src = findById(n.kind || "mat", n.refId);
      if (!src?.uom) return n;
      if (!n.uom || (n.uom === "шт" && src.uom !== "шт")) {
        changed = true;
        return { ...n, uom: src.uom };
      }
      return n;
    });
    if (changed) {
      setDraft((d) => ({ ...d, lines: nextLines }));
    }
  }, [draft.lines, materials, semis]);

  const addLine = (kind: "mat" | "semi" = "mat") =>
    isReadOnly
      ? null
      : setDraft(d => ({ ...d, lines: [...d.lines, { id: uid(), kind, refId: "", qty: 0, uom: uoms[0] || "" }] }));

  const updateLine = (id: string, patch: Partial<SpecLine>) =>
    isReadOnly
      ? null
      : setDraft(d => ({ ...d, lines: d.lines.map(ln => ln.id === id ? normalizeLine({ ...ln, ...patch }) : ln) }));

  const removeLine = (id: string) =>
    isReadOnly
      ? null
      : setDraft(d => ({ ...d, lines: d.lines.filter(ln => ln.id !== id) }));

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

  const formatDate = (iso?: string | null) => {
    if (!iso) return "—";
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return iso;
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
  };

  const subtractOneDay = (iso?: string | null) => {
    if (!iso) return null;
    const d = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(d.getTime())) return null;
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  };

  const save = async () => {
    if (saving) return;
    if (isReadOnly) {
      alert("Редактировать можно только последнюю версию спецификации.");
      return;
    }
    const err = validate();
    if (err) { alert(err); return; }
    const codeNorm = (draft.productCode || "").trim().toLowerCase();
    if (codeNorm) {
      const dup = specs.find((s) => (s.productCode || "").trim().toLowerCase() === codeNorm);
      const sameProduct = !!dup?.productId && !!draft.productId && dup.productId === draft.productId;
      if (dup && !sameProduct) {
        const proceed = window.confirm(
          "Код спецификации уже используется (с учётом регистра и пробелов это дубль). Продолжить?"
        );
        if (!proceed) return;
      }
    }
    const clean: Spec = {
      ...draft,
      effectiveFrom: draft.effectiveFrom || new Date().toISOString().slice(0, 10),
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

    let refreshed = false;
    try {
      const rows = await fetchSpecsFromSupabase();
      const mapped = rows.map(mapRecordToSpec);
      setSpecs(mapped);
      try {
        localStorage.setItem("mrp.specs.v1", JSON.stringify(mapped));
      } catch (err) {
        console.warn("SpecModal: failed to persist specs", err);
      }
      refreshed = true;
    } catch (err) {
      console.warn("SpecModal: refresh specs failed, using local update", err);
    }

    if (!refreshed) {
      setSpecs(prev => {
        const filtered = prev.filter(s => {
          if (clean.id && s.id === clean.id) return false;
          if (clean.productId && s.productId === clean.productId) return false;
          if (clean.productCode && s.productCode === clean.productCode) return false;
          return true;
        });
        const next = [clean, ...filtered];
        try {
          localStorage.setItem("mrp.specs.v1", JSON.stringify(next));
        } catch (err) {
          console.warn("SpecModal: failed to persist specs", err);
        }
        return next;
      });
    }
    onSaved?.(clean.id);
    onClose();
    setSaving(false);
  };

  React.useEffect(() => {
    if (!open) return;
    const specCode = (draft.productCode || "").trim();
    if (!specCode) {
      setVersionRows([]);
      return;
    }
    let canceled = false;
    const loadVersions = async () => {
      setVersionsLoading(true);
      try {
        const { data, error } = await supabase
          .from("specs")
          .select("id, spec_code, spec_name, version, effective_from, created_at")
          .eq("spec_code", specCode)
          .order("effective_from", { ascending: false })
          .order("version", { ascending: false });
        if (error) throw error;
        if (canceled) return;
        const mapped = (data || []).map((row: any) => ({
          id: row.id as string,
          specCode: row.spec_code as string,
          specName: row.spec_name as string,
          version: row.version ?? null,
          effectiveFrom: row.effective_from ?? null,
          createdAt: row.created_at ?? null,
        }));
        setVersionRows(mapped);
      } catch (err) {
        console.error("SpecModal: load versions failed", err);
        if (!canceled) setVersionRows([]);
      } finally {
        if (!canceled) setVersionsLoading(false);
      }
    };
    loadVersions();
    return () => {
      canceled = true;
    };
  }, [open, draft.productCode]);

  React.useEffect(() => {
    if (!versionRows.length) {
      setSelectedVersionId(null);
      return;
    }
    if (!selectedVersionId || !versionRows.some((row) => row.id === selectedVersionId)) {
      setSelectedVersionId(versionRows[0].id);
    }
  }, [versionRows, selectedVersionId]);

  React.useEffect(() => {
    if (!selectedVersionId) return;
    if (selectedVersionId === draft.id) {
      setSelectedVersionLines([]);
      return;
    }
    let canceled = false;
    const loadLines = async () => {
      setSelectedVersionLoading(true);
      try {
        const { data, error } = await supabase
          .from("spec_lines")
          .select("id, spec_id, kind, ref_item_id, qty, uom")
          .eq("spec_id", selectedVersionId);
        if (error) throw error;
        if (canceled) return;
        const mapped = (data || []).map((row: any) => ({
          id: row.id as string,
          kind: (row.kind as "mat" | "semi") ?? "mat",
          refId: row.ref_item_id as string,
          qty: Number(row.qty) || 0,
          uom: row.uom || "",
        }));
        setSelectedVersionLines(mapped);
      } catch (err) {
        console.error("SpecModal: load version lines failed", err);
        if (!canceled) setSelectedVersionLines([]);
      } finally {
        if (!canceled) setSelectedVersionLoading(false);
      }
    };
    loadLines();
    return () => {
      canceled = true;
    };
  }, [selectedVersionId, draft.id]);

  if (!open) return null;

  /* ======= UI ======= */
  const visibleLines = selectedVersionId && selectedVersionId !== draft.id
    ? selectedVersionLines
    : draft.lines;
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
        </div>

        <div className="modal-body-viewport" style={{ maxHeight: "78vh" }}>
          {/* Шапка изделия */}
          <div className="ui-form form-grid-2">
            <div>
              <div className="form-label">Код спецификации</div>
              <input
                className="form-control"
                value={draft.productCode}
                disabled={isReadOnly}
                onChange={(e) => setDraft({ ...draft, productCode: e.target.value })}
                placeholder="Введите код спецификации"
              />
            </div>
            <div>
              <div className="form-label">Наименование спецификации</div>
              <input
                className="form-control"
                value={draft.productName}
                disabled={isReadOnly}
                onChange={(e) => setDraft({ ...draft, productName: e.target.value })}
                placeholder="Введите наименование спецификации"
              />
            </div>
          </div>
          <div className="ui-form form-grid-2 mt-2">
            <div>
              <div className="form-label">Дата вступления</div>
              <input
                className="form-control"
                type="date"
                value={draft.effectiveFrom || ""}
                disabled={isReadOnly}
                onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })}
              />
            </div>
          </div>
          {isReadOnly && (
            <div className="mt-2 text-xs text-amber-700">
              Вы открыли старую версию. Редактирование и сохранение отключены.
            </div>
          )}
          <div className="mt-3">
            <div className="text-sm font-semibold mb-2">История версий</div>
            {versionsLoading ? (
              <div className="text-xs text-slate-500">Загружаем версии…</div>
            ) : versionRows.length === 0 ? (
              <div className="text-xs text-slate-500">Версии не найдены.</div>
            ) : (
              <div className="table-wrapper">
                <table className="mrp-table text-sm table-compact">
                  <thead>
                    <tr>
                      <th className="text-left px-2 py-2 w-[80px]">Версия</th>
                      <th className="text-left px-2 py-2 w-[140px]">Активна с</th>
                      <th className="text-left px-2 py-2 w-[140px]">Активна до</th>
                      <th className="text-left px-2 py-2">Создана</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versionRows.map((row, idx) => {
                      const next = versionRows[idx - 1];
                      const activeTo = next?.effectiveFrom ? subtractOneDay(next.effectiveFrom) : null;
                      return (
                        <tr
                          key={row.id}
                          className={`border-t border-slate-200 ${row.id === selectedVersionId ? "bg-slate-50" : ""}`}
                          onClick={() => setSelectedVersionId(row.id)}
                          style={{ cursor: "pointer" }}
                        >
                          <td className="px-2 py-[6px]">v{row.version ?? "—"}</td>
                          <td className="px-2 py-[6px]">{formatDate(row.effectiveFrom)}</td>
                          <td className="px-2 py-[6px]">{formatDate(activeTo)}</td>
                          <td className="px-2 py-[6px]">{formatDate(row.createdAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {dictLoading && (
            <div className="mt-2 text-xs text-slate-500">
              Загружаем номенклатуру из Supabase…
            </div>
          )}

          {selectedVersionLoading && (
            <div className="mt-2 text-xs text-slate-500">
              Загружаем строки выбранной версии…
            </div>
          )}

          {/* Таблица строк (компактная) */}
          <div className="table-wrapper mt-3">
            <table className="mrp-table text-sm table-compact">
              <thead>{headerRow}</thead>
              <tbody>
                {visibleLines.map((ln) => {
                  const n = normalizeLine(ln);
                  const options = dictFor(n.kind);
                  const chosen = findById(n.kind!, n.refId);

                  return (
                    <tr key={n.id} className="border-t border-slate-200">
                      {/* Тип */}
                      <td className="px-2 py-[6px]">
                        <select
                          className="form-control mrp-select"
                          value={n.kind}
                          disabled={isReadOnly}
                          onChange={(e) => updateLine(n.id, { kind: e.target.value as "mat" | "semi", refId: "" })}
                        >
                          <option value="mat">Материал</option>
                          <option value="semi">Полуфабрикат</option>
                        </select>
                      </td>

                      {/* Код (селект по коду, узкий) */}
                      <td className="px-2 py-[6px]" style={{ width: 90 }}>
                        <select
                          className="form-control mrp-select"
                          style={{ width: 90 }}
                          value={n.refId}
                          disabled={isReadOnly}
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
                          className="form-control mrp-select"
                          style={{ minWidth: 220 }}
                          value={n.refId}
                          disabled={isReadOnly}
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
                          value={n.qty === 0 ? "" : n.qty}
                          disabled={isReadOnly}
                          onChange={(e) => {
                            const raw = e.target.value;
                            updateLine(n.id, { qty: raw === "" ? 0 : Number(raw) });
                          }}
                          placeholder="0"
                        />
                      </td>

                      {/* Единица (селект из справочника) */}
                      <td className="px-2 py-[6px]">
                        <select
                          className="form-control mrp-select"
                          value={n.uom || ""}
                          disabled={isReadOnly}
                          onChange={(e) => updateLine(n.id, { uom: e.target.value })}
                        >
                          <option value=""></option>
                          {uoms.map(u => <option key={u} value={u}>{u}</option>)}
                        </select>
                      </td>

                      {/* delete */}
                      <td className="px-2 py-[6px] text-right">
                        <button
                          className="act act--ghost"
                          title="Удалить"
                          onClick={() => removeLine(n.id)}
                          disabled={isReadOnly}
                        >
                          ✖
                        </button>
                      </td>
                    </tr>
                  );
                })}

                {visibleLines.length === 0 && (
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
            <button
              type="button"
              className="mrp-btn mrp-btn--ghost mrp-btn--xs"
              onClick={() => addLine("mat")}
              disabled={isReadOnly}
            >
              + Материал
            </button>
            <button
              type="button"
              className="mrp-btn mrp-btn--ghost mrp-btn--xs"
              onClick={() => addLine("semi")}
              disabled={isReadOnly}
            >
              + Полуфабрикат
            </button>
          </div>
        </div>

        <div className="modal-footer">
          <div className="flex items-center justify-end gap-2 w-full">
            <button className="mrp-btn" onClick={onClose}>Отмена</button>
            <button className="mrp-btn mrp-btn--primary" onClick={save} disabled={saving || isReadOnly}>
              {saving ? "Сохраняем…" : "Сохранить"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
