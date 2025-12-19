import { supabase } from "../api/supabaseClient";

export type ReceiptRow = {
  id: string;
  number: string | null;
  dateISO: string;
  supplierName: string | null;
  vendorId: string | null;
  kind: "material" | "semi" | "product";
  status: "draft" | "posted" | "canceled";
  physWarehouseId: string | null;
  zoneId: string | null;
  itemCount: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ReceiptLine = {
  id: string;
  receiptId: string;
  itemId: string;
  qty: number;
  uom: string | null;
  warehouseId: string;
  itemCode?: string;
  itemName?: string;
  itemUom?: string | null;
};

export async function fetchReceiptsSupabase(limit = 200): Promise<ReceiptRow[]> {
  const { data, error } = await supabase
    .from("receipts")
    .select("id, number, date_iso, supplier_name, vendor_id, kind, status, phys_warehouse_id, zone_id, created_at, updated_at")
    .order("date_iso", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const rows = data ?? [];
  const ids = rows.map((row) => row.id);
  const countMap = new Map<string, number>();

  if (ids.length) {
    const { data: lineRows, error: linesError } = await supabase
      .from("receipt_items")
      .select("receipt_id")
      .in("receipt_id", ids);
    if (linesError) throw linesError;
    (lineRows ?? []).forEach((ln) => {
      const key = ln.receipt_id as string;
      countMap.set(key, (countMap.get(key) ?? 0) + 1);
    });
  }

  return rows.map((row) => ({
    id: row.id as string,
    number: row.number ?? null,
    dateISO: row.date_iso ?? new Date().toISOString(),
    supplierName: row.supplier_name ?? null,
    vendorId: row.vendor_id ?? null,
    kind: (row.kind ?? "material") as ReceiptRow["kind"],
    status: (row.status ?? "posted") as ReceiptRow["status"],
    physWarehouseId: row.phys_warehouse_id ?? null,
    zoneId: row.zone_id ?? null,
    itemCount: countMap.get(row.id as string) ?? 0,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }));
}

export async function fetchReceiptLinesSupabase(receiptId: string): Promise<ReceiptLine[]> {
  const { data, error } = await supabase
    .from("receipt_items")
    .select("id, receipt_id, item_id, qty, uom, warehouse_id, items ( code, name, uom )")
    .eq("receipt_id", receiptId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row: any) => ({
    id: row.id as string,
    receiptId: row.receipt_id as string,
    itemId: row.item_id as string,
    qty: Number(row.qty) || 0,
    uom: row.uom ?? row.items?.uom ?? null,
    warehouseId: row.warehouse_id as string,
    itemCode: row.items?.code ?? undefined,
    itemName: row.items?.name ?? undefined,
    itemUom: row.items?.uom ?? row.uom ?? null,
  }));
}

export async function rollbackReceiptSupabase(id: string): Promise<void> {
  const { error } = await supabase.rpc("rollback_receipt", { p_receipt_id: id });
  if (error) throw error;
}
