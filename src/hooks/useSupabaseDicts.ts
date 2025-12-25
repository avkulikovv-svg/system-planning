import { useCallback, useEffect, useMemo, useState } from "react";
import type { CategoryRecord, ItemGroupRecord, UomRecord, VendorRecord } from "../utils/dictsSupabase";
import {
  createCategorySupabase,
  createItemGroupSupabase,
  createUomSupabase,
  createVendorSupabase,
  deleteCategorySupabase,
  deleteItemGroupSupabase,
  deleteUomSupabase,
  deleteVendorSupabase,
  fetchCategoriesSupabase,
  fetchItemGroupsSupabase,
  fetchUomsSupabase,
  fetchVendorsSupabase,
  renameItemGroupSupabase,
  renameUomSupabase,
  renameVendorSupabase,
  updateCategorySupabase,
} from "../utils/dictsSupabase";
import { supabase } from "../api/supabaseClient";

const sortByName = <T extends { name: string }>(items: T[]) =>
  [...items].sort((a, b) => a.name.localeCompare(b.name, "ru"));

/* ================= UOMs ================ */
export function useSupabaseUoms() {
  const [uoms, setUoms] = useState<UomRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchUomsSupabase();
      setUoms(rows);
    } catch (error) {
      console.error("Failed to load UOMs", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addUom = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const existing = uoms.find(
        (u) => u.name.trim().toLowerCase() === trimmed.toLowerCase()
      );
      if (existing) return existing;
      try {
        const rec = await createUomSupabase(trimmed);
        setUoms((prev) => sortByName([...prev, rec]));
        return rec;
      } catch (error) {
        console.error("Failed to add UOM", error);
        alert("Не удалось добавить единицу измерения в Supabase");
        return null;
      }
    },
    [uoms]
  );

  const renameUom = useCallback(async (id: string, name: string) => {
    try {
      await renameUomSupabase(id, name);
      setUoms((prev) =>
        sortByName(prev.map((u) => (u.id === id ? { ...u, name: name.trim() } : u)))
      );
    } catch (error) {
      console.error("Failed to rename UOM", error);
      alert("Не удалось переименовать единицу измерения");
    }
  }, []);

  const removeUom = useCallback(async (id: string) => {
    try {
      await deleteUomSupabase(id);
      setUoms((prev) => prev.filter((u) => u.id !== id));
    } catch (error) {
      console.error("Failed to delete UOM", error);
      alert("Не удалось удалить единицу измерения");
    }
  }, []);

  return { uoms, loading, refresh, addUom, renameUom, removeUom };
}

/* ================= Item Groups ================ */
export function useSupabaseGroups() {
  const [groups, setGroups] = useState<ItemGroupRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchItemGroupsSupabase();
      setGroups(rows);
    } catch (error) {
      console.error("Failed to load groups", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addGroup = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const existing = groups.find(
        (g) => g.name.trim().toLowerCase() === trimmed.toLowerCase()
      );
      if (existing) return existing;
      try {
        const rec = await createItemGroupSupabase(trimmed);
        setGroups((prev) => sortByName([...prev, rec]));
        return rec;
      } catch (error) {
        console.error("Failed to add group", error);
        alert("Не удалось добавить группу в Supabase");
        return null;
      }
    },
    [groups]
  );

  const renameGroup = useCallback(async (id: string, currentName: string, nextName: string) => {
    try {
      await renameItemGroupSupabase(id, nextName, currentName);
      setGroups((prev) =>
        sortByName(
          prev.map((g) => (g.id === id ? { ...g, name: nextName.trim() } : g))
        )
      );
    } catch (error) {
      console.error("Failed to rename group", error);
      alert("Не удалось переименовать группу");
    }
  }, []);

  const removeGroup = useCallback(async (id: string, name: string) => {
    try {
      await deleteItemGroupSupabase(id, name);
      setGroups((prev) => prev.filter((g) => g.id !== id));
    } catch (error) {
      console.error("Failed to delete group", error);
      alert("Не удалось удалить группу");
    }
  }, []);

  return { groups, loading, refresh, addGroup, renameGroup, removeGroup };
}

/* ================= Categories ================ */
export function useSupabaseCategories() {
  const [categories, setCategories] = useState<CategoryRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchCategoriesSupabase();
      setCategories(rows);
    } catch (error) {
      console.error("Failed to load categories", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addCategory = useCallback(
    async (name: string, kind: CategoryRecord["kind"] = "both") => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      const existing = categories.find(
        (c) => c.name.trim().toLowerCase() === trimmed.toLowerCase()
      );
      if (existing) return existing;
      try {
        const rec = await createCategorySupabase(trimmed, kind);
        setCategories((prev) => sortByName([...prev, rec]));
        return rec;
      } catch (error) {
        console.error("Failed to add category", error);
        alert("Не удалось добавить категорию в Supabase");
        return null;
      }
    },
    [categories]
  );

  const renameCategory = useCallback(async (id: string, name: string) => {
    try {
      await updateCategorySupabase(id, { name });
      setCategories((prev) =>
        sortByName(prev.map((c) => (c.id === id ? { ...c, name: name.trim() } : c)))
      );
    } catch (error) {
      console.error("Failed to rename category", error);
      alert("Не удалось переименовать категорию");
    }
  }, []);

  const changeCategoryKind = useCallback(async (id: string, kind: CategoryRecord["kind"]) => {
    try {
      await updateCategorySupabase(id, { kind });
      setCategories((prev) => prev.map((c) => (c.id === id ? { ...c, kind } : c)));
    } catch (error) {
      console.error("Failed to update category kind", error);
      alert("Не удалось изменить тип категории");
    }
  }, []);

  const removeCategory = useCallback(async (id: string) => {
    try {
      await deleteCategorySupabase(id);
      setCategories((prev) => prev.filter((c) => c.id !== id));
    } catch (error) {
      console.error("Failed to delete category", error);
      alert("Не удалось удалить категорию");
    }
  }, []);

  return {
    categories,
    loading,
    refresh,
    addCategory,
    renameCategory,
    changeCategoryKind,
    removeCategory,
  };
}

/* ================= Vendors ================ */
export function useSupabaseVendors() {
  const [vendors, setVendors] = useState<VendorRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchVendorsSupabase();
      setVendors(rows);
    } catch (error) {
      console.error("Failed to load vendors", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addVendor = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    try {
      const rec = await createVendorSupabase(trimmed);
      setVendors((prev) => sortByName([...prev, rec]));
      return rec;
    } catch (error) {
      console.error("Failed to add vendor", error);
      alert("Не удалось добавить поставщика");
      return null;
    }
  }, []);

  const renameVendor = useCallback(async (id: string, name: string) => {
    try {
      await renameVendorSupabase(id, name);
      setVendors((prev) =>
        sortByName(prev.map((v) => (v.id === id ? { ...v, name: name.trim() } : v)))
      );
    } catch (error) {
      console.error("Failed to rename vendor", error);
      alert("Не удалось переименовать поставщика");
    }
  }, []);

  const removeVendor = useCallback(async (id: string) => {
    try {
      await deleteVendorSupabase(id);
      setVendors((prev) => prev.filter((v) => v.id !== id));
    } catch (error) {
      console.error("Failed to delete vendor", error);
      alert("Не удалось удалить поставщика");
    }
  }, []);

  return { vendors, loading, refresh, addVendor, renameVendor, removeVendor };
}

/* ================= Warehouses ================ */
export type WarehouseRecord = {
  id: string;
  name: string;
  type: "physical" | "virtual";
  parentId: string | null;
  legacyId: string | null;
  isActive: boolean;
};

const mapWarehouseRow = (row: any): WarehouseRecord => ({
  id: row.id,
  name: row.name,
  type: row.type === "virtual" ? "virtual" : "physical",
  parentId: row.parent_id ?? null,
  legacyId: row.legacy_id ?? null,
  isActive: row.is_active ?? true,
});

export function useSupabaseWarehouses() {
  const [warehouses, setWarehouses] = useState<WarehouseRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("warehouses")
        .select("id, name, type, parent_id, legacy_id, is_active")
        .order("name", { ascending: true });
      if (error) throw error;
      setWarehouses((data || []).map(mapWarehouseRow));
    } catch (error) {
      console.error("Failed to load warehouses", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const addWarehouse = useCallback(
    async (payload: { name: string; type: "physical" | "virtual"; parentId?: string | null; legacyId?: string | null }) => {
      const trimmed = payload.name.trim();
      if (!trimmed) return null;
      try {
        const { data, error } = await supabase
          .from("warehouses")
          .insert({
            name: trimmed,
            type: payload.type,
            parent_id: payload.parentId ?? null,
            legacy_id: payload.legacyId ?? null,
          })
          .select("id, name, type, parent_id, legacy_id, is_active")
          .single();
        if (error) throw error;
        const rec = mapWarehouseRow(data);
        setWarehouses((prev) => [...prev, rec]);
        return rec;
      } catch (error) {
        console.error("Failed to add warehouse", error);
        alert("Не удалось добавить склад");
        return null;
      }
    },
    []
  );

  const updateWarehouse = useCallback(
    async (id: string, patch: Partial<{ name: string; parentId: string | null; isActive: boolean; legacyId: string | null }>) => {
      const updates: Record<string, any> = {};
      if (patch.name !== undefined) updates.name = patch.name.trim();
      if (patch.parentId !== undefined) updates.parent_id = patch.parentId;
      if (patch.isActive !== undefined) updates.is_active = patch.isActive;
      if (patch.legacyId !== undefined) updates.legacy_id = patch.legacyId;
      try {
        const { data, error } = await supabase
          .from("warehouses")
          .update(updates)
          .eq("id", id)
          .select("id, name, type, parent_id, legacy_id, is_active")
          .single();
        if (error) throw error;
        const rec = mapWarehouseRow(data);
        setWarehouses((prev) => prev.map((w) => (w.id === rec.id ? rec : w)));
      } catch (error) {
        console.error("Failed to update warehouse", error);
        alert("Не удалось обновить склад");
      }
    },
    []
  );

  const deleteWarehouse = useCallback(async (id: string) => {
    try {
      const { error } = await supabase.from("warehouses").delete().eq("id", id);
      if (error) throw error;
      setWarehouses((prev) => prev.filter((w) => w.id !== id));
    } catch (error) {
      console.error("Failed to delete warehouse", error);
      alert("Не удалось удалить склад");
    }
  }, []);

  const physical = useMemo(() => warehouses.filter((w) => w.type === "physical" && w.isActive), [warehouses]);
  const virtual = useMemo(() => warehouses.filter((w) => w.type === "virtual" && w.isActive), [warehouses]);

  const zonesByPhys = useCallback(
    (physId: string) => virtual.filter((v) => v.parentId === physId),
    [virtual]
  );

  const findZoneByName = useCallback(
    (physId: string, name = "") =>
      zonesByPhys(physId).find((v) => v.name.trim().toLowerCase() === name.trim().toLowerCase()) || null,
    [zonesByPhys]
  );

  const findByLegacy = useCallback(
    (legacyId: string) => warehouses.find((w) => (w.legacyId ?? "").toLowerCase() === legacyId.toLowerCase()) ?? null,
    [warehouses]
  );

  const addPhysical = useCallback((name: string) => addWarehouse({ name, type: "physical" }), [addWarehouse]);
  const addZone = useCallback(
    (physId: string, name: string) => addWarehouse({ name, type: "virtual", parentId: physId }),
    [addWarehouse]
  );

  const renameWarehouse = useCallback(
    (id: string, name: string) => updateWarehouse(id, { name }),
    [updateWarehouse]
  );

  const setWarehouseActive = useCallback(
    (id: string, isActive: boolean) => updateWarehouse(id, { isActive }),
    [updateWarehouse]
  );

  return {
    warehouses,
    physical,
    virtual,
    zonesByPhys,
    findZoneByName,
    findByLegacy,
    loading,
    refresh,
    addPhysical,
    addZone,
    renameWarehouse,
    deleteWarehouse,
    setWarehouseActive,
  };
}
