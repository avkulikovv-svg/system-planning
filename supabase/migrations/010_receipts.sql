-- Receipts & receipt items normalization + RPCs

-- Ensure receipts table has required columns
create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  number text,
  date_iso date not null default current_date,
  supplier_name text,
  vendor_id uuid references public.vendors(id),
  kind text not null default 'material',
  status text not null default 'posted' check (status in ('draft','posted','canceled')),
  phys_warehouse_id uuid references public.warehouses(id),
  zone_id uuid references public.warehouses(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  canceled_at timestamptz
);

alter table public.receipts
  add column if not exists number text;
alter table public.receipts
  add column if not exists supplier_name text;
alter table public.receipts
  add column if not exists vendor_id uuid references public.vendors(id);
alter table public.receipts
  add column if not exists kind text;
alter table public.receipts
  alter column kind set default 'material';
update public.receipts set kind = 'material' where kind is null;
alter table public.receipts
  add column if not exists status text;
alter table public.receipts
  alter column status set default 'posted';
update public.receipts set status = 'posted' where status is null;
alter table public.receipts drop constraint if exists receipts_status_check;
alter table public.receipts
  add constraint receipts_status_check check (status in ('draft','posted','canceled'));
alter table public.receipts drop constraint if exists receipts_kind_check;
alter table public.receipts
  add constraint receipts_kind_check check (kind in ('material','semi','product'));
alter table public.receipts
  add column if not exists phys_warehouse_id uuid references public.warehouses(id);
alter table public.receipts
  add column if not exists zone_id uuid references public.warehouses(id);
alter table public.receipts
  add column if not exists created_at timestamptz not null default now();
alter table public.receipts
  add column if not exists updated_at timestamptz not null default now();
alter table public.receipts
  add column if not exists canceled_at timestamptz;

create index if not exists receipts_date_idx on public.receipts (date_iso desc);
create index if not exists receipts_vendor_idx on public.receipts (vendor_id);
create index if not exists receipts_status_idx on public.receipts (status);

create or replace function public.touch_receipt()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_receipts_touch on public.receipts;
create trigger trg_receipts_touch
before update on public.receipts
for each row execute function public.touch_receipt();

-- Receipt items
create table if not exists public.receipt_items (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.receipts(id) on delete cascade,
  item_id uuid not null references public.items(id),
  item_kind text not null,
  item_type text not null,
  qty numeric not null,
  uom text,
  warehouse_id uuid not null references public.warehouses(id),
  created_at timestamptz not null default now()
);

alter table public.receipt_items
  add column if not exists created_at timestamptz not null default now();

-- enforce cascade if it wasn't set previously
alter table public.receipt_items
  drop constraint if exists receipt_items_receipt_id_fkey;
alter table public.receipt_items
  add constraint receipt_items_receipt_id_fkey
    foreign key (receipt_id) references public.receipts(id) on delete cascade;

create index if not exists receipt_items_receipt_idx on public.receipt_items (receipt_id);
create index if not exists receipt_items_item_idx on public.receipt_items (item_id);
create index if not exists receipt_items_wh_idx on public.receipt_items (warehouse_id);

-- RLS
alter table public.receipts enable row level security;
grant select, insert, update, delete on public.receipts to anon, authenticated;
drop policy if exists receipts_all on public.receipts;
create policy receipts_all on public.receipts for all using (true) with check (true);

alter table public.receipt_items enable row level security;
grant select, insert, update, delete on public.receipt_items to anon, authenticated;
drop policy if exists receipt_items_all on public.receipt_items;
create policy receipt_items_all on public.receipt_items for all using (true) with check (true);

-- Updated RPC for posting receipts
create or replace function public.post_receipt(
  p_date_iso date,
  p_supplier_name text,
  p_kind text,
  p_items jsonb,
  p_number text default null,
  p_vendor_id uuid default null,
  p_zone_id uuid default null,
  p_phys_warehouse_id uuid default null
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
  v_kind text;
  v_number text;
  v_zone_id uuid;
  v_phys_id uuid;
  v_now timestamptz := now();
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Список строк (p_items) пуст';
  end if;

  v_kind := lower(coalesce(nullif(trim(p_kind), ''), 'material'));
  if v_kind not in ('material','semi','product') then
    raise exception 'Недопустимый тип поступления: %', v_kind;
  end if;

  v_number := coalesce(nullif(trim(p_number), ''), 'RCPT-' || to_char(clock_timestamp(), 'YYMMDDHH24MISSMS'));

  v_zone_id := p_zone_id;
  if v_zone_id is null then
    select (elem->>'warehouse_id')::uuid
    into v_zone_id
    from jsonb_array_elements(p_items) as elem
    where elem ? 'warehouse_id'
    limit 1;
  end if;

  if v_zone_id is null then
    raise exception 'Не указан склад/зона для поступления';
  end if;

  if p_phys_warehouse_id is not null then
    v_phys_id := p_phys_warehouse_id;
  else
    select parent_id into v_phys_id from public.warehouses where id = v_zone_id;
  end if;

  insert into public.receipts (
    number,
    date_iso,
    supplier_name,
    vendor_id,
    kind,
    status,
    phys_warehouse_id,
    zone_id,
    created_at,
    updated_at
  )
  values (
    v_number,
    coalesce(p_date_iso, current_date),
    nullif(p_supplier_name, ''),
    p_vendor_id,
    v_kind,
    'posted',
    v_phys_id,
    v_zone_id,
    v_now,
    v_now
  )
  returning id into v_receipt_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_qty := (v_item->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Количество должно быть больше 0';
    end if;
    v_item_id := (v_item->>'item_id')::uuid;
    if v_item_id is null then
      raise exception 'Строка не содержит item_id';
    end if;
    v_wh_id := coalesce((v_item->>'warehouse_id')::uuid, v_zone_id);
    if v_wh_id is null then
      raise exception 'Строка не содержит warehouse_id';
    end if;
    v_uom := nullif(v_item->>'uom', '');

    insert into public.receipt_items (
      receipt_id,
      item_id,
      item_kind,
      item_type,
      qty,
      uom,
      warehouse_id,
      created_at
    )
    values (
      v_receipt_id,
      v_item_id,
      v_kind,
      v_kind,
      v_qty,
      v_uom,
      v_wh_id,
      v_now
    );

    insert into public.stock_movements (doc_type, doc_id, item_id, warehouse_id, qty, created_at)
    values ('receipt', v_receipt_id, v_item_id, v_wh_id, v_qty, v_now);
  end loop;

  return v_receipt_id;
end;
$$;

-- Rollback function
create or replace function public.rollback_receipt(p_receipt_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_receipt public.receipts%rowtype;
  v_now timestamptz := now();
begin
  select * into v_receipt
  from public.receipts
  where id = p_receipt_id
  for update;

  if not found then
    raise exception 'Поступление % не найдено', p_receipt_id;
  end if;

  if v_receipt.status = 'canceled' then
    return;
  end if;

  delete from public.stock_movements
  where doc_type = 'receipt'
    and doc_id = p_receipt_id;

  update public.receipts
    set status = 'canceled',
        canceled_at = v_now,
        updated_at = v_now
    where id = p_receipt_id;
end;
$$;
