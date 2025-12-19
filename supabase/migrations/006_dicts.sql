-- Справочники (uoms, categories, vendors)

create table if not exists public.uoms (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.uoms (name)
values ('шт'), ('кг'), ('л'), ('м')
on conflict (name) do nothing;

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  kind text not null default 'both' check (kind in ('fg','mat','both')),
  created_at timestamptz not null default now()
);

insert into public.categories (name, kind)
values
  ('Хим. продукция', 'fg'),
  ('Материалы', 'mat')
on conflict (name) do nothing;

create table if not exists public.vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

insert into public.vendors (name)
values ('Поставщик A')
on conflict (name) do nothing;
