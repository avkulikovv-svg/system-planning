import { supabase } from "../api/supabaseClient";

export type UomRecord = { id: string; name: string };
export type CategoryRecord = { id: string; name: string; kind: "fg" | "mat" | "both" };
export type VendorRecord = { id: string; name: string };
export type ItemGroupRecord = { id: string; name: string };

// ----- UOMs -----
export async function fetchUomsSupabase(): Promise<UomRecord[]> {
  const { data, error } = await supabase
    .from("uoms")
    .select("id, name")
    .order("name", { ascending: true });
  if (error) throw error;
  return (data || []) as UomRecord[];
}

export async function createUomSupabase(name: string): Promise<UomRecord> {
  const { data, error } = await supabase
    .from("uoms")
    .insert({ name: name.trim() })
    .select("id, name")
    .single();
  if (error) throw error;
  return data as UomRecord;
}

export async function renameUomSupabase(id: string, name: string): Promise<void> {
  const { error } = await supabase.from("uoms").update({ name: name.trim() }).eq("id", id);
  if (error) throw error;
}

export async function deleteUomSupabase(id: string): Promise<void> {
  const { error } = await supabase.from("uoms").delete().eq("id", id);
  if (error) throw error;
}

// ----- Item groups -----
export async function fetchItemGroupsSupabase(): Promise<ItemGroupRecord[]> {
  const { data, error } = await supabase
    .from("item_groups")
    .select("id, name")
    .order("name", { ascending: true });
  if (error) throw error;
  return (data || []) as ItemGroupRecord[];
}

export async function createItemGroupSupabase(name: string): Promise<ItemGroupRecord> {
  const { data, error } = await supabase
    .from("item_groups")
    .insert({ name: name.trim() })
    .select("id, name")
    .single();
  if (error) throw error;
  return data as ItemGroupRecord;
}

export async function renameItemGroupSupabase(id: string, nextName: string, prevName: string): Promise<void> {
  const trimmed = nextName.trim();
  const { error } = await supabase.from("item_groups").update({ name: trimmed }).eq("id", id);
  if (error) throw error;
  const { error: updErr } = await supabase
    .from("items")
    .update({ group_name: trimmed })
    .eq("group_name", prevName);
  if (updErr) throw updErr;
}

export async function deleteItemGroupSupabase(id: string, name: string): Promise<void> {
  const { error } = await supabase.from("item_groups").delete().eq("id", id);
  if (error) throw error;
  const { error: updErr } = await supabase
    .from("items")
    .update({ group_name: null })
    .eq("group_name", name);
  if (updErr) throw updErr;
}

// ----- Categories -----
export async function fetchCategoriesSupabase(): Promise<CategoryRecord[]> {
  const { data, error } = await supabase
    .from("categories")
    .select("id, name, kind")
    .order("name", { ascending: true });
  if (error) throw error;
  return (data || []) as CategoryRecord[];
}

export async function createCategorySupabase(name: string, kind: "fg" | "mat" | "both" = "both"): Promise<CategoryRecord> {
  const { data, error } = await supabase
    .from("categories")
    .insert({ name: name.trim(), kind })
    .select("id, name, kind")
    .single();
  if (error) throw error;
  return data as CategoryRecord;
}

export async function updateCategorySupabase(id: string, patch: Partial<Pick<CategoryRecord, "name" | "kind">>): Promise<void> {
  const payload: Record<string, string> = {};
  if (patch.name) payload.name = patch.name.trim();
  if (patch.kind) payload.kind = patch.kind;
  const { error } = await supabase.from("categories").update(payload).eq("id", id);
  if (error) throw error;
}

export async function deleteCategorySupabase(id: string): Promise<void> {
  const { error } = await supabase.from("categories").delete().eq("id", id);
  if (error) throw error;
}

// ----- Vendors -----
export async function fetchVendorsSupabase(): Promise<VendorRecord[]> {
  const { data, error } = await supabase
    .from("vendors")
    .select("id, name")
    .order("name", { ascending: true });
  if (error) throw error;
  return (data || []) as VendorRecord[];
}

export async function createVendorSupabase(name: string): Promise<VendorRecord> {
  const { data, error } = await supabase
    .from("vendors")
    .insert({ name: name.trim() })
    .select("id, name")
    .single();
  if (error) throw error;
  return data as VendorRecord;
}

export async function renameVendorSupabase(id: string, name: string): Promise<void> {
  const { error } = await supabase.from("vendors").update({ name: name.trim() }).eq("id", id);
  if (error) throw error;
}

export async function deleteVendorSupabase(id: string): Promise<void> {
  const { error } = await supabase.from("vendors").delete().eq("id", id);
  if (error) throw error;
}
