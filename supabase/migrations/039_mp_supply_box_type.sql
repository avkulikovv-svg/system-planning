-- Add supply box type (mono/box/etc) for marketplace supply plans

alter table public.mp_supply_plans
  add column if not exists supply_box_type_id integer;

alter table public.mp_supply_plans_history
  add column if not exists supply_box_type_id integer;
