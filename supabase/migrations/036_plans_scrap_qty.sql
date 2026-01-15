-- Add scrap quantity to production plans

alter table public.plans_fg
  add column if not exists scrap_qty numeric not null default 0;

alter table public.plans_semi
  add column if not exists scrap_qty numeric not null default 0;
