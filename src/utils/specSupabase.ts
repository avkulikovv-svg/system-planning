import { supabase } from "../api/supabaseClient";
import { generateUuid, isUuid, resolveItemUuid } from "./supabaseItems";

type SpecLineInput = {
  id?: string;
  kind?: "mat" | "semi";
  refId?: string;
  materialId?: string;
  qty: number;
  uom: string;
};

export type SpecInput = {
  id?: string;
  productId?: string | null;
  productCode?: string;
  productName?: string;
  lines: SpecLineInput[];
};

type DictItem = {
  id: string;
  code: string;
  name: string;
  uom?: string;
  category?: string;
  vendorId?: string;
};

type SpecContext = {
  materials: DictItem[];
  semis?: DictItem[];
  vendors?: { id: string; name: string }[];
};

export type SpecLineRecord = {
  id: string;
  specId: string;
  refId: string;
  kind: "mat" | "semi";
  qty: number;
  uom: string;
};

export type SpecRecord = {
  id: string;
  specCode: string;
  specName: string;
  linkedProductId: string | null;
  updatedAt: string;
  lines: SpecLineRecord[];
};

export async function fetchSpecsFromSupabase(): Promise<SpecRecord[]> {
  const { data: specsData, error: specsErr } = await supabase
    .from("specs")
    .select("id, spec_code, spec_name, linked_product_id, updated_at")
    .order("updated_at", { ascending: false });
  if (specsErr) throw specsErr;

  const { data: linesData, error: linesErr } = await supabase
    .from("spec_lines")
    .select("id, spec_id, kind, ref_item_id, qty");
  if (linesErr) throw linesErr;

  const linesBySpec = new Map<string, SpecLineRecord[]>();
  (linesData || []).forEach((ln: any) => {
    if (!ln?.spec_id) return;
    const line: SpecLineRecord = {
      id: ln.id as string,
      specId: ln.spec_id as string,
      refId: ln.ref_item_id as string,
      kind: (ln.kind as "mat" | "semi") ?? "mat",
      qty: Number(ln.qty) || 0,
      uom: "",
    };
    if (!linesBySpec.has(line.specId)) linesBySpec.set(line.specId, []);
    linesBySpec.get(line.specId)!.push(line);
  });

  return (specsData || []).map((row: any) => ({
    id: row.id as string,
    specCode: row.spec_code as string,
    specName: row.spec_name as string,
    linkedProductId: row.linked_product_id as string | null,
    updatedAt: row.updated_at ?? new Date().toISOString(),
    lines: linesBySpec.get(row.id) ?? [],
  }));
}

const findSource = (ctx: SpecContext, kind: "mat" | "semi", id?: string) => {
  if (!id) return undefined;
  const list = kind === "semi" ? ctx.semis ?? [] : ctx.materials;
  return list.find((x) => x.id === id);
};

export async function upsertSpecSupabase(spec: SpecInput, ctx: SpecContext): Promise<string> {
  const specCodeRaw = spec.productCode?.trim() || spec.id || "";
  const specCode = specCodeRaw ? specCodeRaw : `SPEC-${Date.now()}`;
  let specId = spec.id && isUuid(spec.id) ? spec.id : null;

  if (!specId) {
    const { data, error: selectErr } = await supabase
      .from("specs")
      .select("id")
      .eq("spec_code", specCode)
      .limit(1);
    if (selectErr) throw selectErr;
    if (data?.[0]?.id) specId = data[0].id as string;
  }
  if (!specId) specId = generateUuid();

  let linkedProductUuid: string | null = null;
  const legacyProductId = spec.productId?.trim();
  if (legacyProductId || spec.productCode) {
    try {
      linkedProductUuid = await resolveItemUuid({
        kind: "product",
        code: spec.productCode || specCode,
        name: spec.productName || specCode,
        legacyId: legacyProductId || null,
        createIfMissing: false,
      });
    } catch (err) {
      console.warn("upsertSpecSupabase: resolve product uuid failed", err);
      linkedProductUuid = null;
    }
  }

  const vendorNameById = new Map(ctx.vendors?.map((v) => [v.id, v.name]));

  const linePayload: any[] = [];
  for (const line of spec.lines) {
    const kind = line.kind === "semi" ? "semi" : "mat";
    const refRaw = line.refId || line.materialId || "";
    if (!refRaw) continue;
    const source = findSource(ctx, kind, refRaw);
    const code = source?.code || refRaw;
    const name = source?.name || code;
    const vendorName = source?.vendorId ? vendorNameById.get(source.vendorId) ?? null : null;
    const itemUuid = await resolveItemUuid({
      kind: kind === "semi" ? "semi" : "material",
      code,
      name,
      legacyId: source?.id || refRaw,
      uom: source?.uom || line.uom,
      category: source?.category || null,
      vendorName,
    });
    if (!itemUuid) continue;
    linePayload.push({
      id: generateUuid(),
      spec_id: specId,
      kind,
      ref_item_id: itemUuid,
      qty: line.qty,
    });
  }

  const specRecord = {
    id: specId,
    linked_product_id: linkedProductUuid,
    spec_code: specCode,
    spec_name: spec.productName?.trim() || specCode,
    updated_at: new Date().toISOString(),
  };

  const { error: specErr } = await supabase
    .from("specs")
    .upsert(specRecord, { onConflict: "id" });
  if (specErr) throw specErr;

  const { error: deleteLinesErr } = await supabase
    .from("spec_lines")
    .delete()
    .eq("spec_id", specId);
  if (deleteLinesErr) throw deleteLinesErr;
  if (linePayload.length) {
    const { error: linesErr } = await supabase
      .from("spec_lines")
      .insert(linePayload);
    if (linesErr) throw linesErr;
  }

  return specId;
}

type DeleteFilter = {
  id?: string | null;
  specCode?: string | null;
  linkedProductId?: string | null;
};

export async function deleteSpecSupabase(filter: DeleteFilter) {
  const ids = new Set<string>();

  if (filter.id && isUuid(filter.id)) ids.add(filter.id);

  const fetchBy = async (column: string, value?: string | null) => {
    if (!value) return;
    const { data, error } = await supabase
      .from("specs")
      .select("id")
      .eq(column, value);
    if (error) throw error;
    data?.forEach((row: any) => ids.add(row.id as string));
  };

  if (filter.specCode) await fetchBy("spec_code", filter.specCode);
  if (filter.linkedProductId) {
    await fetchBy("linked_product_id", filter.linkedProductId);
  }

  if (!ids.size) return;
  const list = Array.from(ids);
  const { error: delLines } = await supabase
    .from("spec_lines")
    .delete()
    .in("spec_id", list);
  if (delLines) throw delLines;
  const { error: delSpecs } = await supabase
    .from("specs")
    .delete()
    .in("id", list);
  if (delSpecs) throw delSpecs;
}
