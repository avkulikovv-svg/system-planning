import { supabase } from "./supabaseClient";

export type MarketplaceSupplyChannel = "OZON" | "WB";

type SyncResponse = {
  channel?: MarketplaceSupplyChannel;
  imported?: number;
  skipped?: number;
  unknown?: number;
  error?: string;
};

export async function syncMarketplaceSupplyPlans(channel: MarketplaceSupplyChannel): Promise<SyncResponse> {
  const { data, error } = await supabase.functions.invoke<SyncResponse>("sync-mp-supply-plans", {
    body: { channel },
  });
  if (error) {
    console.error("syncMarketplaceSupplyPlans invoke error", error, error?.context);
    const contextError =
      typeof error?.context === "object" && error.context !== null ? (error.context as any).error : undefined;
    throw new Error(contextError || error.message || "Failed to sync marketplace plans");
  }
  if (data?.error) throw new Error(data.error);
  return data ?? { channel, imported: 0, skipped: 0, unknown: 0 };
}
