import { supabase } from "./supabaseClient";

type WbCategoryRow = {
  barcode: string;
  nmId?: number;
  subjectId?: number;
  subjectName?: string;
  vendorCode?: string;
};

type WbCategoryResponse = {
  items?: WbCategoryRow[];
  error?: string;
  debug?: Record<string, unknown>;
};

export async function fetchWbCategoriesByBarcode(barcodes: string[]) {
  const { data, error } = await supabase.functions.invoke<WbCategoryResponse>("wb-categories-by-barcode", {
    body: { barcodes },
  });
  if (error) {
    console.error("fetchWbCategoriesByBarcode invoke error", error, error?.context);
    const contextError =
      typeof error?.context === "object" && error.context !== null ? (error.context as any).error : undefined;
    throw new Error(contextError || error.message || "Failed to load WB categories");
  }
  if (data?.error) throw new Error(data.error);
  return data?.items ?? [];
}

export async function fetchWbCategoriesByBarcodeAndNmId(
  barcodes: string[],
  nmIds: number[],
  vendorCodes?: string[],
  debug?: boolean,
) {
  const { data, error } = await supabase.functions.invoke<WbCategoryResponse>("wb-categories-by-barcode", {
    body: { barcodes, nmIds, vendorCodes, debug },
  });
  if (error) {
    console.error("fetchWbCategoriesByBarcode invoke error", error, error?.context);
    const contextError =
      typeof error?.context === "object" && error.context !== null ? (error.context as any).error : undefined;
    throw new Error(contextError || error.message || "Failed to load WB categories");
  }
  if (data?.error) throw new Error(data.error);
  return { items: data?.items ?? [], debug: data?.debug };
}
