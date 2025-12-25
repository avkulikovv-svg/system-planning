-- Marketplace channels, destinations, and supply plans

create table if not exists public.mp_channels (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

insert into public.mp_channels (code, name)
values
  ('WB', 'Wildberries'),
  ('OZON', 'Ozon'),
  ('CLIENT', 'Клиенты/прямые поставки')
on conflict (code) do update set name = excluded.name;

create table if not exists public.mp_destinations (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.mp_channels(id) on delete cascade,
  name text not null,
  external_id text,
  region text,
  address text,
  is_active boolean not null default true,
  meta jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mp_destinations_channel_idx on public.mp_destinations(channel_id);
create unique index if not exists mp_destinations_channel_ext_idx
  on public.mp_destinations(channel_id, external_id);

create table if not exists public.mp_supply_plans (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.mp_channels(id) on delete restrict,
  destination_id uuid references public.mp_destinations(id) on delete set null,
  item_id uuid not null references public.items(id) on delete cascade,
  plan_date date not null,
  qty numeric not null,
  status text not null default 'planned' check (status in ('planned','shipped','canceled')),
  shipment_name text,
  shipment_date date,
  shipped_at timestamptz,
  planned_by text,
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists mp_supply_plans_channel_idx on public.mp_supply_plans(channel_id);
create index if not exists mp_supply_plans_item_idx on public.mp_supply_plans(item_id);
create index if not exists mp_supply_plans_status_idx on public.mp_supply_plans(status);

alter table public.mp_destinations enable row level security;
alter table public.mp_supply_plans enable row level security;

grant select, insert, update, delete on public.mp_channels to anon, authenticated;
grant select, insert, update, delete on public.mp_destinations to anon, authenticated;
grant select, insert, update, delete on public.mp_supply_plans to anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'mp_destinations' and policyname = 'mp_destinations_all') then
    create policy mp_destinations_all on public.mp_destinations for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'mp_supply_plans' and policyname = 'mp_supply_plans_all') then
    create policy mp_supply_plans_all on public.mp_supply_plans for all using (true) with check (true);
  end if;
end $$;

alter table public.items add column if not exists wb_sku text;
alter table public.items add column if not exists ozon_sku text;
alter table public.items add column if not exists barcode text;
alter table public.items add column if not exists mp_category_wb text;
alter table public.items add column if not exists mp_category_ozon text;
alter table public.items add column if not exists box_length numeric;
alter table public.items add column if not exists box_width numeric;
alter table public.items add column if not exists box_height numeric;
alter table public.items add column if not exists box_weight numeric;
alter table public.items add column if not exists units_per_box numeric;
alter table public.items add column if not exists units_per_pallet numeric;
alter table public.items add column if not exists pallet_weight numeric;
