import { supabase } from "../api/supabaseClient";

export type ItemKind = "material" | "semi" | "product";

export type ResolveItemOptions = {
  kind: ItemKind;
  code: string;
  name: string;
  legacyId?: string | null;
  uom?: string | null;
  category?: string | null;
  groupName?: string | null;
  vendorName?: string | null;
  createIfMissing?: boolean;
};

const uuidPromises = new Map<string, Promise<string | null>>();

export const isUuid = (s?: string | null) =>
  !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

export const generateUuid = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export async function resolveItemUuid(opts: ResolveItemOptions): Promise<string | null> {
  const createAllowed = opts.createIfMissing !== false;
  const cacheKey = [
    opts.kind,
    opts.code.trim().toLowerCase(),
    opts.legacyId?.trim() ?? "",
    createAllowed ? "1" : "0",
  ].join(":");

  if (!uuidPromises.has(cacheKey)) {
    uuidPromises.set(
      cacheKey,
      (async () => {
        const legacy = opts.legacyId?.trim();
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
          .maybeSingle();
        if (codeErr && codeErr.code !== "PGRST116") throw codeErr;
        if (byCode?.id) return byCode.id as string;

        if (!createAllowed) return null;

        const payload: Record<string, any> = {
          code: opts.code,
          kind: opts.kind,
          status: "active",
          name: opts.name,
          uom: opts.uom || "шт",
          vendor_name: opts.vendorName || null,
          legacy_id: legacy || null,
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
}
