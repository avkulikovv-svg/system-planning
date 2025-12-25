import { supabase } from "./supabaseClient";

export type WbAcceptanceWarehouse = {
  warehouseId: string;
  name: string;
  canBox: boolean;
  canMonopallet: boolean;
  canSupersafe: boolean;
};

export type WbAcceptanceItem = {
  barcode: string;
  isError: boolean;
  error?: string | null;
  warehouses: WbAcceptanceWarehouse[];
};

type WbAcceptanceResponse = {
  items?: WbAcceptanceItem[];
  error?: string;
  debug?: Record<string, unknown>;
};

export async function fetchWbAcceptanceOptions(
  items: Array<{ barcode: string; quantity?: number }>,
  debug?: boolean,
) {
  const { data, error } = await supabase.functions.invoke<WbAcceptanceResponse>("wb-acceptance-options", {
    body: { items, debug: Boolean(debug) },
  });
  if (error) {
    console.error("fetchWbAcceptanceOptions invoke error", error, error?.context);
    const contextError =
      typeof error?.context === "object" && error.context !== null ? (error.context as any).error : undefined;
    throw new Error(contextError || error.message || "Failed to load WB acceptance options");
  }
  if (data?.error) throw new Error(data.error);
  return { items: data?.items ?? [], debug: data?.debug ?? null };
}
