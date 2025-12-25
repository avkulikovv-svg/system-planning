import { supabase } from "./supabaseClient";

export type MarketplaceChannelCode = "WB" | "OZON";

type SyncResponse = {
  channel?: MarketplaceChannelCode;
  inserted?: number;
  error?: string;
};

export async function syncMarketplaceDestinations(channel: MarketplaceChannelCode): Promise<SyncResponse> {
  const { data, error } = await supabase.functions.invoke<SyncResponse>("sync-mp-warehouses", {
    body: { channel },
  });
  if (error) {
    // surface server response for easier debugging
    console.error("syncMarketplaceDestinations invoke error", error, error?.context);
    const contextError =
      typeof error?.context === "object" && error.context !== null ? (error.context as any).error : undefined;
    throw new Error(contextError || error.message || "Failed to sync marketplaces");
  }
  if (data?.error) throw new Error(data.error);
  return data ?? { channel, inserted: 0 };
}
