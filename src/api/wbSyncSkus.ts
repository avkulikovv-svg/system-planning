import { supabase } from "./supabaseClient";

type WbSyncResponse = {
  totalCards?: number;
  matchedByCode?: number;
  matchedByBarcode?: number;
  suppliesTotal?: number;
  suppliesMatched?: number;
  updated?: number;
  sample?: unknown;
  error?: string;
};

export async function syncWbSkus(debug = false) {
  const { data, error } = await supabase.functions.invoke<WbSyncResponse>("wb-sync-skus", {
    body: { debug },
  });
  if (error) {
    console.error("syncWbSkus invoke error", error, error?.context);
    const contextError =
      typeof error?.context === "object" && error.context !== null ? (error.context as any).error : undefined;
    throw new Error(contextError || error.message || "Failed to sync WB SKUs");
  }
  if (data?.error) throw new Error(data.error);
  return data ?? {};
}
