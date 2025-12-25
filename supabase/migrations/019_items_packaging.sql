-- Extra packaging fields for items
alter table public.items add column if not exists box_volume numeric;
alter table public.items add column if not exists boxes_per_pallet numeric;
alter table public.items add column if not exists box_orientation text;
alter table public.items add column if not exists shelf_life_days numeric;
alter table public.items add column if not exists shelf_life_required boolean;
alter table public.items add column if not exists unit_weight numeric;
