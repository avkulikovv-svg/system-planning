-- Telegram user warehouse/zone bindings

alter table public.tg_users
  add column if not exists is_global_controller boolean not null default false;

create table if not exists public.tg_user_warehouses (
  id uuid primary key default gen_random_uuid(),
  tg_user_id uuid not null references public.tg_users (id) on delete cascade,
  warehouse_id uuid not null references public.warehouses (id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tg_user_id, warehouse_id)
);

create index if not exists tg_user_warehouses_user_idx on public.tg_user_warehouses (tg_user_id);
create index if not exists tg_user_warehouses_wh_idx on public.tg_user_warehouses (warehouse_id);

alter table public.tg_user_warehouses enable row level security;
grant select, insert, update, delete on public.tg_user_warehouses to anon, authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'tg_user_warehouses'
      and policyname = 'tg_user_warehouses_all'
  ) then
    create policy tg_user_warehouses_all on public.tg_user_warehouses
      for all using (true) with check (true);
  end if;
end $$;
