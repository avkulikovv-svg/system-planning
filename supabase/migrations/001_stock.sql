-- stock movements + balances + RPC for posting receipts
create extension if not exists "pgcrypto";

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  doc_type text not null,
  doc_id uuid not null,
  item_id uuid not null references public.items (id),
  warehouse_id uuid not null references public.warehouses (id),
  qty numeric not null,
  created_at timestamptz not null default now()
);

create index if not exists stock_movements_item_idx on public.stock_movements (item_id);
create index if not exists stock_movements_wh_idx on public.stock_movements (warehouse_id);
create index if not exists stock_movements_doc_idx on public.stock_movements (doc_id);

create or replace view public.stock_balances as
select
  warehouse_id,
  item_id,
  coalesce(sum(qty), 0)::numeric as qty,
  max(created_at) as updated_at
from public.stock_movements
group by warehouse_id, item_id;

create or replace function public.post_receipt(
  p_date_iso date,
  p_supplier_name text,
  p_kind text,
  p_items jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_receipt_id uuid;
  v_item jsonb;
  v_qty numeric;
  v_item_id uuid;
  v_wh_id uuid;
  v_uom text;
begin
  insert into public.receipts (date_iso, supplier_name)
  values (p_date_iso, p_supplier_name)
  returning id into v_receipt_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item->>'qty')::numeric;
    v_item_id := (v_item->>'item_id')::uuid;
    v_wh_id := (v_item->>'warehouse_id')::uuid;
    v_uom := nullif(v_item->>'uom', '');

    insert into public.receipt_items (
      receipt_id,
      item_id,
      item_kind,
      item_type,
      qty,
      uom,
      warehouse_id
    )
    values (
      v_receipt_id,
      v_item_id,
      p_kind,
      p_kind,
      v_qty,
      v_uom,
      v_wh_id
    );

    insert into public.stock_movements (doc_type, doc_id, item_id, warehouse_id, qty)
    values ('receipt', v_receipt_id, v_item_id, v_wh_id, v_qty);
  end loop;

  return v_receipt_id;
end;
$$;
