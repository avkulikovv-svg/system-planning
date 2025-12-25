import { useState, useEffect, useCallback } from "react";
import { supabase } from "./api/supabaseClient";
import {
  createVendorSupabase,
  fetchCategoriesSupabase,
  fetchItemGroupsSupabase,
  fetchUomsSupabase,
  fetchVendorsSupabase,
} from "./utils/dictsSupabase";

/* ===== локальные типы (минимум, чтобы не тащить весь файл) ===== */
type Vendor = { id: string; name: string };
type Material = {
  id: string; code: string; name: string;
  vendorId: string; uom: string; moq: number; leadTimeDays: number;
  price?: number; currency?: string; group?: string;
};
type Product = {
  id: string; status: string; code: string; name: string;
  category?: string; uom?: string; price?: number;
  wbSku?: string; ozonSku?: string; barcode?: string;
  mpCategoryWb?: string; mpCategoryOzon?: string;
  boxLength?: number; boxWidth?: number; boxHeight?: number; boxWeight?: number;
  unitsPerBox?: number; unitsPerPallet?: number; palletWeight?: number;
};
type SpecLine = { id: string; materialId: string; qty: number; uom: string };
type Spec = {
  id: string; productId?: string|null; productCode: string; productName: string;
  lines: SpecLine[]; updatedAt: string;
};
const isUuid = (s?: string | null) =>
  !!s &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const newUuid = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/* ===== простой локальный useLocalState (такой же, как у тебя) ===== */
const useLocalState = <T,>(key: string, initial: T) => {
  const [state, setState] = useState<T>(() => {
    try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : initial; }
    catch { return initial; }
  });
  useEffect(() => { localStorage.setItem(key, JSON.stringify(state)); }, [key, state]);
  return [state, setState] as const;
};

/* ===== CSV helpers (самодостаточные) ===== */
function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cur: string[] = [], cell = "", i = 0, inQ = false;

  const pushCell = () => { cur.push(cell); cell = ""; };
  const pushRow  = () => { rows.push(cur); cur = []; };

  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i+1] === '"') { cell += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      cell += ch; i++; continue;
    } else {
      if (ch === '"') { inQ = true; i++; continue; }
      if (ch === ',') { pushCell(); i++; continue; }
      if (ch === '\r') { i++; continue; }
      if (ch === '\n') { pushCell(); pushRow(); i++; continue; }
      cell += ch; i++; continue;
    }
  }
  pushCell(); if (cur.length > 1 || (cur.length === 1 && cur[0] !== "")) pushRow();
  if (rows.length === 0) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const o: Record<string,string> = {};
    headers.forEach((h, idx) => o[h] = (r[idx] ?? "").trim());
    return o;
  });
}

const csvSaveAs = (filename: string, text: string) => {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
};

const pickFileAsText = (accept = ".csv"): Promise<string> =>
  new Promise((resolve, reject) => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = accept;
    inp.onchange = async () => {
      const f = inp.files?.[0]; if (!f) return reject(new Error("Файл не выбран"));
      const text = await f.text(); resolve(text);
    };
    inp.click();
  });

const normalizeNumber = (s?: string): number | null => {
  if (s == null) return null;
  const t = s.replace(",", ".").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const keyEq = (a?: string, b?: string) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

const uid = () => Math.random().toString(36).slice(2, 9);
const venIdFromName  = (name: string) => `V:${name.trim()}`;
const matIdFromCode  = (code: string) => `M:${code.trim()}`;
const prodIdFromCode = (code: string) => `P:${code.trim()}`;

const templates = {
  vendors:
`vendor_id,vendor_name
V:ikea,IKEA
V:local,Местный поставщик
`,
  materials:
`material_id,code,name,vendor_id,vendor_name,uom,moq,lead_time_days,price,currency,group
,MAT-001,Наименование 1,V:local,,кг,1,7,0,RUB,Химия
,MAT-002,Наименование 2,,Поставщик А,шт,1,0,,RUB,Упаковка
`,
  products:
`product_id,status,code,name,category,uom,price
,active,PRD-001,Товар 1,Мебель,шт,0
,active,PRD-002,Товар 2,Аксессуары,шт,
`,
  specs:
`product_code,product_id,product_name,material_code,material_id,material_name,qty_per_unit,uom,waste_pct
PRD-001,,Товар 1,MAT-001,,,1.5,кг,
PRD-001,,,MAT-002,,,2,шт,
`,
};

/* ====== Основной экран ====== */
export default function SettingsIntegrations() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [materials, setMaterials] = useLocalState<Material[]>("mrp.materials.v1", []);
  const [products,  setProducts]  = useLocalState<Product[]>("mrp.products.v1", []);
  const [specs,     setSpecs]     = useLocalState<Spec[]>("mrp.specs.v1", []);
  const [uoms, setUoms] = useState<string[]>([]);
  const [cats, setCats] = useState<string[]>([]);
  const [groupsDict, setGroupsDict] = useState<string[]>([]);
  const [specExporting, setSpecExporting] = useState(false);

  const refreshDicts = useCallback(async () => {
    try {
      const [vendorRows, uomRows, catRows, groupRows] = await Promise.all([
        fetchVendorsSupabase(),
        fetchUomsSupabase(),
        fetchCategoriesSupabase(),
        fetchItemGroupsSupabase(),
      ]);
      setVendors(vendorRows);
      setUoms(uomRows.map((u) => u.name));
      setCats(catRows.map((c) => c.name));
      setGroupsDict(groupRows.map((g) => g.name));
    } catch (error) {
      console.error("SettingsIntegrations: load dictionaries", error);
    }
  }, []);

  useEffect(() => {
    refreshDicts();
  }, [refreshDicts]);

  const addIfMissing = (arr: string[], v: string) => v && !arr.includes(v) ? [...arr, v] : arr;

  const importVendorsCsv = async () => {
    const text = await pickFileAsText(".csv");
    const rows = parseCSV(text);
    const existing = new Set(vendors.map((v) => v.name.trim().toLowerCase()));
    let created = 0;
    const errors: string[] = [];
    for (const r of rows) {
      const name = (r.vendor_name || "").trim();
      if (!name) { errors.push("Vendors: пропуск (name пусто)"); continue; }
      const key = name.toLowerCase();
      if (existing.has(key)) continue;
      try {
        await createVendorSupabase(name);
        existing.add(key);
        created++;
      } catch (err) {
        console.error("import vendors csv", err);
        errors.push(`Не удалось создать поставщика ${name}`);
      }
    }
    await refreshDicts();
    alert(`Импорт поставщиков: создано ${created}, ошибок ${errors.length}`);
  };

  const importMaterialsCsv = async () => {
    const text = await pickFileAsText(".csv");
    const rows = parseCSV(text);

    const next = new Map<string, Material>(materials.map(m => [m.id, m]));
    const vnext = new Map<string, Vendor>(vendors.map(v => [v.id, v]));
    let uomsAcc = [...uoms], groupsAcc = [...groupsDict];
    const errors: string[] = [];

    for (const r of rows) {
      const code = (r.code||"").trim();
      const name = (r.name||"").trim();
      if (!code || !name) { errors.push(`Materials: нет code/name (${code}/${name})`); continue; }

      let vendorId = (r.vendor_id||"").trim();
      const vendorName = (r.vendor_name||"").trim();
      if (!vendorId && vendorName) {
        const found = Array.from(vnext.values()).find(v => keyEq(v.name, vendorName));
        vendorId = found ? found.id : venIdFromName(vendorName);
        if (!found) vnext.set(vendorId, { id: vendorId, name: vendorName });
      }

      const uom = (r.uom||"шт").trim();
      const moq = Math.max(1, Number(normalizeNumber(r.moq) ?? 1));
      const ltd = Math.max(0, Number(normalizeNumber(r.lead_time_days) ?? 0));
      const price = normalizeNumber(r.price) ?? undefined;
      const currency = (r.currency||"RUB").trim() || "RUB";
      const group = (r.group||"").trim();
      const id = (r.material_id||"").trim() || matIdFromCode(code);

      uomsAcc = addIfMissing(uomsAcc, uom);
      groupsAcc = addIfMissing(groupsAcc, group);

      next.set(id, { id, code, name, vendorId: vendorId || "", uom, moq, leadTimeDays: ltd, price, currency, group });
    }

    setVendors(Array.from(vnext.values()));
    setMaterials(Array.from(next.values()));
    setUoms(uomsAcc); setGroupsDict(groupsAcc);
    localStorage.setItem("mrp.dataset.version", new Date().toISOString());
    alert(`Импорт материалов: ok ${rows.length - errors.length}, ошибок ${errors.length}`);
  };

  const importProductsCsv = async () => {
    const text = await pickFileAsText(".csv");
    const rows = parseCSV(text);

    const next = new Map<string, Product>(products.map(p => [p.id, p]));
    let uomsAcc = [...uoms], catsAcc = [...cats];
    const errors: string[] = [];

    for (const r of rows) {
      const code = (r.code||"").trim();
      const name = (r.name||"").trim();
      if (!code || !name) { errors.push(`Products: нет code/name (${code}/${name})`); continue; }
      const id = (r.product_id||"").trim() || prodIdFromCode(code);
      const status = (r.status||"active").trim();
      const category = (r.category||"").trim();
      const uom = (r.uom||"шт").trim();
      const price = normalizeNumber(r.price) ?? undefined;

      uomsAcc = addIfMissing(uomsAcc, uom);
      catsAcc = addIfMissing(catsAcc, category);

      next.set(id, { id, status, code, name, category, uom, price });
    }

    setProducts(Array.from(next.values()));
    setUoms(uomsAcc); setCats(catsAcc);
    localStorage.setItem("mrp.dataset.version", new Date().toISOString());
    alert(`Импорт товаров: ok ${rows.length - errors.length}, ошибок ${errors.length}`);
  };

  const importSpecsCsv = async () => {
    const text = await pickFileAsText(".csv");
    const rows = parseCSV(text);

    const prodById  = new Map(products.map(p => [p.id, p]));
    const prodByCode= new Map(products.map(p => [p.code.trim().toLowerCase(), p]));
    const matById   = new Map(materials.map(m => [m.id, m]));
    const matByCode = new Map(materials.map(m => [m.code.trim().toLowerCase(), m]));

    const group = new Map<string, { p: Product, lines: SpecLine[] }>();
    const errors: string[] = [];

    for (const r of rows) {
      const pid = (r.product_id||"").trim();
      const pcode = (r.product_code||"").trim().toLowerCase();
      const p = pid ? prodById.get(pid) : (pcode ? prodByCode.get(pcode) : undefined);
      if (!p) { errors.push(`Specs: товар не найден (id=${pid} code=${r.product_code||""})`); continue; }

      const mid = (r.material_id||"").trim();
      const mcode = (r.material_code||"").trim().toLowerCase();
      let m = mid ? matById.get(mid) : (mcode ? matByCode.get(mcode) : undefined);
      if (!m && r.material_name) {
        m = materials.find(x => keyEq(x.name, r.material_name)) || undefined;
      }
      if (!m) { errors.push(`Specs: не найден материал (prod ${p.code}, material=${r.material_id||r.material_code||r.material_name||"??"})`); continue; }

      const qty = normalizeNumber(r.qty_per_unit);
      const uom = (r.uom||m.uom||"шт").trim();
      if (!qty || qty <= 0) { errors.push(`Specs: qty_per_unit <= 0 (prod ${p.code}, mat ${m.code})`); continue; }

      const lines = group.get(p.id)?.lines ?? [];
      lines.push({ id: uid(), materialId: m.id, qty, uom });
      group.set(p.id, { p, lines });
    }

    // Полная замена спецификаций по продукту
    const next = new Map<string, Spec>();
    for (const [pid, { p, lines }] of group.entries()) {
      const merged = Object.values(lines.reduce<Record<string, SpecLine>>((acc, l) => {
        const k = `${l.materialId}|${l.uom}`;
        acc[k] = acc[k] ? { ...acc[k], qty: acc[k].qty + l.qty } : l;
        return acc;
      }, {}));
      next.set(pid, {
        id: specs.find(s => s.productId === pid || s.productCode === p.code)?.id || uid(),
        productId: p.id, productCode: p.code, productName: p.name,
        lines: merged, updatedAt: new Date().toISOString(),
      });
    }

    // оставляем спецификации тех продуктов, которые не были в CSV
    const rest = specs.filter(s => !next.has(s.productId || ""));
    setSpecs([...rest, ...Array.from(next.values())]);
    localStorage.setItem("mrp.dataset.version", new Date().toISOString());

    alert(`Импорт спецификаций: ок ${next.size}, ошибок ${errors.length}${errors.length?'\n\n'+errors.slice(0,12).join('\n'):''}`);
  };

  const dl = (name: keyof typeof templates) => csvSaveAs(`${name}.template.csv`, templates[name]);
  const exportSpecsToSupabase = async () => {
    if (!specs.length) {
      alert("Нет спецификаций в браузере — выгружать нечего.");
      return;
    }

    const productById = new Map(products.map((p) => [p.id, p]));
    const productByCode = new Map(products.map((p) => [p.code.trim().toLowerCase(), p]));
    const matById = new Map(materials.map((m) => [m.id, m]));
    const matByCode = new Map(materials.map((m) => [m.code.trim().toLowerCase(), m]));
    const vendorById = new Map(vendors.map((v) => [v.id, v.name]));

    const findMaterialForLine = (line: SpecLine): Material | null => {
      const legacyId = line.materialId?.trim();
      if (!legacyId) return null;
      const direct = matById.get(legacyId);
      if (direct) return direct;
      const normalized = legacyId.replace(/^M:/i, "").trim();
      if (normalized) {
        const normLower = normalized.toLowerCase();
        const byCode = matByCode.get(normLower);
        if (byCode) return byCode;
        const byExactId = matById.get(normalized);
        if (byExactId) return byExactId;
        return {
          id: legacyId,
          code: normalized.toUpperCase(),
          name: normalized,
          vendorId: "",
          uom: line.uom || "шт",
          moq: 1,
          leadTimeDays: 0,
          price: undefined,
          group: "",
        };
      }
      return null;
    };

    const uuidPromises = new Map<string, Promise<string | null>>();

    const resolveItemUuid = (opts: {
      kind: "material" | "semi" | "product";
      code: string;
      name: string;
      legacyId?: string | null;
      uom?: string;
      category?: string;
      groupName?: string;
      vendorName?: string | null;
      createIfMissing?: boolean;
    }): Promise<string | null> => {
      const cacheKey = `${opts.kind}:${opts.code.toLowerCase()}:${
        opts.createIfMissing === false ? "ro" : "rw"
      }`;
      if (!uuidPromises.has(cacheKey)) {
        uuidPromises.set(
          cacheKey,
          (async () => {
            const legacy = opts.legacyId?.trim() || null;
            if (legacy) {
              const { data, error } = await supabase
                .from("items")
                .select("id")
                .eq("legacy_id", legacy)
                .eq("kind", opts.kind)
                .maybeSingle();
              if (error) throw error;
              if (data?.id) return data.id as string;
            }

            const { data: byCode, error: codeErr } = await supabase
              .from("items")
              .select("id")
              .eq("code", opts.code)
              .eq("kind", opts.kind)
              .limit(1)
              .maybeSingle();
            if (codeErr && codeErr.code !== "PGRST116") throw codeErr;
            if (byCode?.id) return byCode.id as string;

            if (opts.createIfMissing === false) return null;

            const payload: Record<string, any> = {
              code: opts.code,
              kind: opts.kind,
              status: "active",
              name: opts.name,
              uom: opts.uom || "шт",
              vendor_name: opts.vendorName || null,
              legacy_id: legacy,
              min_lot: 1,
              lead_days: 0,
            };
            if (opts.category) payload.category = opts.category;
            if (opts.groupName) payload.group_name = opts.groupName;
            const { data: inserted, error: insertErr } = await supabase
              .from("items")
              .insert(payload)
              .select("id")
              .single();
            if (insertErr) throw insertErr;
            return inserted.id as string;
          })(),
        );
      }
      return uuidPromises.get(cacheKey)!;
    };

    const deletedSpecs = new Set<string>();
    const deleteExistingSpec = async (specId: string, specCode?: string) => {
      const key = specCode || specId;
      if (deletedSpecs.has(key)) return;

      const ids = new Set<string>();
      const { data: byId, error: errId } = await supabase
        .from("specs")
        .select("id")
        .eq("id", specId);
      if (errId) throw errId;
      byId?.forEach((row: any) => ids.add(row.id));

      if (specCode) {
        const { data: byCode, error: errCode } = await supabase
          .from("specs")
          .select("id")
          .eq("spec_code", specCode);
        if (errCode) throw errCode;
        byCode?.forEach((row: any) => ids.add(row.id));
      }

      if (ids.size) {
        const list = Array.from(ids);
        await supabase.from("spec_lines").delete().in("spec_id", list);
        await supabase.from("specs").delete().in("id", list);
      }

      deletedSpecs.add(key);
    };

    setSpecExporting(true);
    const errors: string[] = [];
    let exported = 0;
    try {
      for (const rawSpec of specs) {
        const product =
          (rawSpec.productId && productById.get(rawSpec.productId)) ||
          (rawSpec.productCode && productByCode.get(rawSpec.productCode.trim().toLowerCase())) ||
          null;
        if (!rawSpec.lines?.length) continue;

        let linkedProductUuid: string | null = null;
        if (product) {
          try {
            linkedProductUuid = await resolveItemUuid({
              kind: "product",
              code: product.code,
              name: product.name,
              legacyId: product.id,
              uom: product.uom,
              category: product.category,
              createIfMissing: false,
            });
          } catch (err) {
            console.warn("resolve product uuid:", err);
            linkedProductUuid = null;
          }
        }

        const specId = isUuid(rawSpec.id) ? rawSpec.id : newUuid();
        const specCode = (rawSpec.productCode || rawSpec.id || specId).trim();
        const specName =
          rawSpec.productName?.trim() ||
          specCode ||
          `Спецификация ${specId.slice(0, 8)}`;

        const linesPayload: any[] = [];
        let skipSpec = false;

        for (const line of rawSpec.lines) {
          const mat = findMaterialForLine(line);
          if (!mat) {
            errors.push(
              `Нет материала ${line.materialId || "(пусто)"} для спецификации ${specCode}`,
            );
            skipSpec = true;
            break;
          }
          try {
            const materialUuid = await resolveItemUuid({
              kind: "material",
              code: mat.code,
              name: mat.name,
              legacyId: mat.id,
              uom: mat.uom,
              groupName: mat.group,
              vendorName: mat.vendorId ? vendorById.get(mat.vendorId) ?? null : null,
            });
            if (!materialUuid) throw new Error("material uuid missing");
            linesPayload.push({
              id: newUuid(),
              spec_id: specId,
              kind: "mat",
              ref_item_id: materialUuid,
              qty: line.qty,
              uom: mat.uom || "шт",
            });
          } catch (err) {
            console.error("resolve material uuid", err);
            errors.push(`Не удалось создать материал ${mat.code} для спецификации ${specCode}`);
            skipSpec = true;
            break;
          }
        }
        if (skipSpec || !linesPayload.length) continue;

        try {
          await deleteExistingSpec(specId, specCode);
          const { error: specErr } = await supabase.from("specs").insert({
            id: specId,
            linked_product_id: linkedProductUuid,
            spec_code: specCode,
            spec_name: specName,
            updated_at: new Date().toISOString(),
          });
          if (specErr) throw specErr;
          const { error: linesErr } = await supabase.from("spec_lines").insert(linesPayload);
          if (linesErr) throw linesErr;
          exported++;
        } catch (err) {
          console.error("supabase spec export", err);
          errors.push(`Не удалось записать спецификацию ${specCode}`);
        }
      }

      alert(
        `Экспорт спецификаций завершён: ${exported} записей, ошибок ${errors.length}${
          errors.length ? `\n\n${errors.slice(0, 8).join("\n")}` : ""
        }`,
      );
    } catch (err) {
      console.error("exportSpecsToSupabase fatal", err);
      alert("Ошибка экспорта спецификаций, подробности в консоли.");
    } finally {
      setSpecExporting(false);
    }
  };

  return (
    <div className="app-plate app-plate--solid p-3">
      <div className="text-lg font-semibold mb-3">Интеграции — импорт CSV</div>

      <div className="grid md:grid-cols-2 gap-3">
        <div className="mrp-card">
          <div className="font-medium mb-2">Поставщики</div>
          <div className="flex gap-2">
            <button className="mrp-btn mrp-btn--primary" onClick={importVendorsCsv}>Импорт .csv</button>
            <button className="mrp-btn mrp-btn--ghost" onClick={()=>dl("vendors")}>Скачать шаблон .csv</button>
          </div>
        </div>

        <div className="mrp-card">
          <div className="font-medium mb-2">Материалы</div>
          <div className="flex gap-2">
            <button className="mrp-btn mrp-btn--primary" onClick={importMaterialsCsv}>Импорт .csv</button>
            <button className="mrp-btn mrp-btn--ghost" onClick={()=>dl("materials")}>Скачать шаблон .csv</button>
          </div>
        </div>

        <div className="mrp-card">
          <div className="font-medium mb-2">Товары</div>
          <div className="flex gap-2">
            <button className="mrp-btn mrp-btn--primary" onClick={importProductsCsv}>Импорт .csv</button>
            <button className="mrp-btn mrp-btn--ghost" onClick={()=>dl("products")}>Скачать шаблон .csv</button>
          </div>
        </div>

        <div className="mrp-card">
          <div className="font-medium mb-2">Спецификации (BOM)</div>
          <div className="flex gap-2">
            <button className="mrp-btn mrp-btn--primary" onClick={importSpecsCsv}>Импорт .csv</button>
            <button className="mrp-btn mrp-btn--ghost" onClick={()=>dl("specs")}>Скачать шаблон .csv</button>
          </div>
        </div>

        <div className="mrp-card">
          <div className="font-medium mb-2">Supabase: выгрузить текущие спецификации</div>
          <p className="text-sm text-slate-500 mb-2">
            Берём спецификации из браузера и полностью заменяем их в таблицах `specs` / `spec_lines` Supabase.
          </p>
          <button
            className="mrp-btn mrp-btn--primary"
            onClick={exportSpecsToSupabase}
            disabled={specExporting}
          >
            {specExporting ? "Экспортируем…" : "Отправить в Supabase"}
          </button>
        </div>
      </div>
    </div>
  );
}
