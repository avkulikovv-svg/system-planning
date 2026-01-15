-- History for marketplace supply plans (archive shipped/canceled and support restores)

create table if not exists public.mp_supply_plans_history (
  id uuid primary key default gen_random_uuid(),
  source_plan_id uuid not null,
  channel_id uuid not null references public.mp_channels(id) on delete restrict,
  destination_id uuid references public.mp_destinations(id) on delete set null,
  item_id uuid not null references public.items(id) on delete cascade,
  plan_date date not null,
  qty numeric not null,
  status text not null default 'shipped' check (status in ('shipped','canceled','restored')),
  shipment_name text,
  shipment_date date,
  shipped_at timestamptz,
  planned_by text,
  comment text,
  external_supply_id text,
  archived_at timestamptz not null default now(),
  restored_at timestamptz,
  canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists mp_supply_plans_history_source_idx
  on public.mp_supply_plans_history (source_plan_id);
create index if not exists mp_supply_plans_history_channel_idx
  on public.mp_supply_plans_history (channel_id);
create index if not exists mp_supply_plans_history_item_idx
  on public.mp_supply_plans_history (item_id);
create index if not exists mp_supply_plans_history_status_idx
  on public.mp_supply_plans_history (status);

alter table public.mp_supply_plans_history enable row level security;
grant select, insert, update, delete on public.mp_supply_plans_history to anon, authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'mp_supply_plans_history'
      and policyname = 'mp_supply_plans_history_all'
  ) then
    create policy mp_supply_plans_history_all on public.mp_supply_plans_history
      for all using (true) with check (true);
  end if;
end $$;
