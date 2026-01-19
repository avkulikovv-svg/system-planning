import { supabase } from "../api/supabaseClient";
import { isUuid, resolveItemUuid } from "./supabaseItems";

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
  effectiveFrom?: string;
  lines: SpecLineInput[];
};

type DictItem = {
  id: string;
  code: string;
  name: string;
  uom?: string;
  group?: string;
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
  version?: number | null;
  effectiveFrom?: string | null;
  updatedAt: string;
  lines: SpecLineRecord[];
};

export async function fetchSpecsFromSupabase(
  opts?: { includeAll?: boolean }
): Promise<SpecRecord[]> {
  const { data: specsData, error: specsErr } = await supabase
    .from("specs")
    .select("id, spec_code, spec_name, linked_product_id, version, effective_from, updated_at")
    .order("updated_at", { ascending: false });
  if (specsErr) throw specsErr;

  const { data: linesData, error: linesErr } = await supabase
    .from("spec_lines")
    .select("id, spec_id, kind, ref_item_id, qty, uom");
  if (linesErr) throw linesErr;

  const refIds = Array.from(
    new Set((linesData || []).map((ln: any) => ln?.ref_item_id).filter(Boolean))
  ) as string[];
  const uomByItemId = new Map<string, string>();
  if (refIds.length) {
    const chunkSize = 500;
    for (let i = 0; i < refIds.length; i += chunkSize) {
      const chunk = refIds.slice(i, i + chunkSize);
      const { data: itemsData, error: itemsErr } = await supabase
        .from("items")
        .select("id, uom")
        .in("id", chunk);
      if (itemsErr) throw itemsErr;
      (itemsData || []).forEach((row: any) => {
        if (row?.id) uomByItemId.set(row.id as string, row.uom || "");
      });
    }
  }

  const linesBySpec = new Map<string, SpecLineRecord[]>();
  (linesData || []).forEach((ln: any) => {
    if (!ln?.spec_id) return;
    const fallbackUom = uomByItemId.get(ln.ref_item_id as string) || "";
    const line: SpecLineRecord = {
      id: ln.id as string,
      specId: ln.spec_id as string,
      refId: ln.ref_item_id as string,
      kind: (ln.kind as "mat" | "semi") ?? "mat",
      qty: Number(ln.qty) || 0,
      uom: (ln.uom as string) || fallbackUom,
    };
    if (!linesBySpec.has(line.specId)) linesBySpec.set(line.specId, []);
    linesBySpec.get(line.specId)!.push(line);
  });

  const mapped = (specsData || []).map((row: any) => ({
    id: row.id as string,
    specCode: (row.spec_code as string | undefined)?.trim() || "",
    specName: (row.spec_name as string | undefined)?.trim() || "",
    linkedProductId: row.linked_product_id as string | null,
    version: row.version ?? null,
    effectiveFrom: row.effective_from ?? null,
    updatedAt: row.updated_at ?? new Date().toISOString(),
    lines: linesBySpec.get(row.id) ?? [],
  }));

  if (opts?.includeAll) return mapped;

  const sorted = mapped.sort((a, b) => {
    const aEff = a.effectiveFrom || "";
    const bEff = b.effectiveFrom || "";
    if (aEff !== bEff) return bEff.localeCompare(aEff);
    const aVer = Number(a.version ?? 0);
    const bVer = Number(b.version ?? 0);
    if (aVer !== bVer) return bVer - aVer;
    return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
  });

  const seen = new Set<string>();
  const latest: SpecRecord[] = [];
  for (const row of sorted) {
    const rawKey = row.linkedProductId || row.specCode;
    const key = rawKey?.toString().trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    latest.push(row);
  }
  return latest;
}

const findSource = (ctx: SpecContext, kind: "mat" | "semi", id?: string) => {
  if (!id) return undefined;
  const list = kind === "semi" ? ctx.semis ?? [] : ctx.materials;
  return list.find((x) => x.id === id);
};

export async function upsertSpecSupabase(spec: SpecInput, ctx: SpecContext): Promise<string> {
  const specCodeRaw = spec.productCode?.trim() || spec.id || "";
  const specCode = specCodeRaw ? specCodeRaw : `SPEC-${Date.now()}`;

  const linkedProductUuid: string | null = null;

  const vendorNameById = new Map(ctx.vendors?.map((v) => [v.id, v.name]));

  const linePayload: any[] = [];
  for (const line of spec.lines) {
    const kind = line.kind === "semi" ? "semi" : "mat";
    const refRaw = line.refId || line.materialId || "";
    if (!refRaw) continue;
    const source = findSource(ctx, kind, refRaw);
    const code = source?.code || refRaw;
    const name = source?.name || code;
    const lineUom = line.uom || source?.uom || "шт";
    const vendorName = source?.vendorId ? vendorNameById.get(source.vendorId) ?? null : null;
    const itemUuid = await resolveItemUuid({
      kind: kind === "semi" ? "semi" : "material",
      code,
      name,
      legacyId: source?.id || refRaw,
      uom: lineUom,
      groupName: source?.group || null,
      vendorName,
    });
    if (!itemUuid) continue;
    linePayload.push({
      kind,
      ref_item_id: itemUuid,
      qty: line.qty,
      uom: lineUom,
    });
  }

  const { data, error } = await supabase.rpc("upsert_spec_with_lines", {
    p_spec_code: specCode,
    p_spec_name: spec.productName?.trim() || specCode,
    p_linked_product_id: linkedProductUuid,
    p_effective_from: spec.effectiveFrom || new Date().toISOString().slice(0, 10),
    p_lines: linePayload,
  });
  if (error) throw error;
  return data as string;
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
