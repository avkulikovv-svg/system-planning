-- Миграция: расширяем планы производства факт-колонками и таймстампами

create or replace function public.set_timestamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

alter table if exists public.plans_fg
  add column if not exists fact_qty numeric not null default 0,
  add column if not exists fact_updated_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.plans_semi
  add column if not exists fact_qty numeric not null default 0,
  add column if not exists fact_updated_at timestamptz,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists trg_plans_fg_set_timestamp on public.plans_fg;
create trigger trg_plans_fg_set_timestamp
before update on public.plans_fg
for each row
execute function public.set_timestamp();

drop trigger if exists trg_plans_semi_set_timestamp on public.plans_semi;
create trigger trg_plans_semi_set_timestamp
before update on public.plans_semi
for each row
execute function public.set_timestamp();
