-- Add external supply id for marketplace supply plans and prevent duplicates

alter table public.mp_supply_plans
  add column if not exists external_supply_id text;

create unique index if not exists mp_supply_plans_external_unique
  on public.mp_supply_plans (channel_id, external_supply_id, item_id);
