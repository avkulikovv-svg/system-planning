alter table public.mp_supply_plans
  add column if not exists warehouse_shipped_at timestamptz;

alter table public.mp_supply_plans_history
  add column if not exists warehouse_shipped_at timestamptz;
