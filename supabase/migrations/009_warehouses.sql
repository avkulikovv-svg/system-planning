-- Warehouses & zones dictionaries

create table if not exists public.warehouses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null check (type in ('physical','virtual')),
  parent_id uuid references public.warehouses(id),
  legacy_id text unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists warehouses_parent_idx on public.warehouses(parent_id);
create index if not exists warehouses_legacy_idx on public.warehouses(legacy_id);

-- seed main warehouse + materials zone (adjust as needed)
insert into public.warehouses (name, type, legacy_id, is_active)
values
  ('Основной склад', 'physical', 'warehouse_main', true),
  ('Материалы', 'virtual', 'zone_materials', true)
on conflict (legacy_id) do nothing;

-- RLS & policies
alter table public.warehouses enable row level security;
grant select, insert, update, delete on public.warehouses to anon, authenticated;
drop policy if exists warehouses_all on public.warehouses;
create policy warehouses_all on public.warehouses for all using (true) with check (true);
