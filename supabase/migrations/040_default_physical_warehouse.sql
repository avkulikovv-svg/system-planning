alter table public.warehouses
  add column if not exists is_default boolean not null default false;

create unique index if not exists warehouses_default_physical_unique
  on public.warehouses ((type))
  where is_default = true and type = 'physical';
