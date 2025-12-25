-- Item groups dictionary and link from items

create table if not exists public.item_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

insert into public.item_groups (name)
select distinct trim(category)
from public.items
where category is not null and btrim(category) <> ''
on conflict (name) do nothing;

alter table if exists public.items
  add column if not exists group_name text;

update public.items
set group_name = category
where (group_name is null or group_name = '')
  and category is not null and btrim(category) <> '';

alter table public.item_groups enable row level security;
grant select, insert, update, delete on public.item_groups to anon, authenticated;
drop policy if exists item_groups_policy on public.item_groups;
create policy item_groups_policy on public.item_groups
  for all using (true) with check (true);
