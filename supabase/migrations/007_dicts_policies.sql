-- RLS policies for dictionary tables

-- UOMs
alter table public.uoms enable row level security;
grant select, insert, update, delete on public.uoms to anon, authenticated;
drop policy if exists uoms_select on public.uoms;
drop policy if exists uoms_insert on public.uoms;
drop policy if exists uoms_update on public.uoms;
drop policy if exists uoms_delete on public.uoms;
drop policy if exists uoms_all on public.uoms;
create policy uoms_all on public.uoms for all using (true) with check (true);

-- Categories
alter table public.categories enable row level security;
grant select, insert, update, delete on public.categories to anon, authenticated;
drop policy if exists categories_select on public.categories;
drop policy if exists categories_insert on public.categories;
drop policy if exists categories_update on public.categories;
drop policy if exists categories_delete on public.categories;
drop policy if exists categories_all on public.categories;
create policy categories_all on public.categories for all using (true) with check (true);

-- Vendors
alter table public.vendors enable row level security;
grant select, insert, update, delete on public.vendors to anon, authenticated;
drop policy if exists vendors_select on public.vendors;
drop policy if exists vendors_insert on public.vendors;
drop policy if exists vendors_update on public.vendors;
drop policy if exists vendors_delete on public.vendors;
drop policy if exists vendors_all on public.vendors;
create policy vendors_all on public.vendors for all using (true) with check (true);
