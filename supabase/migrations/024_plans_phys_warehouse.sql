-- Добавляем привязку планов к физ. складу

alter table if exists public.plans_fg
  add column if not exists phys_warehouse_id uuid references public.warehouses (id);

alter table if exists public.plans_semi
  add column if not exists phys_warehouse_id uuid references public.warehouses (id);

-- базовое значение по умолчанию — первый физический склад (если есть), чтобы старые планы не потерялись
do $$
declare
  v_default uuid;
begin
  select id into v_default from public.warehouses where type = 'physical' order by created_at limit 1;
  if v_default is not null then
    update public.plans_fg   set phys_warehouse_id = coalesce(phys_warehouse_id, v_default);
    update public.plans_semi set phys_warehouse_id = coalesce(phys_warehouse_id, v_default);
  end if;
end$$;

create index if not exists plans_fg_phys_idx on public.plans_fg (phys_warehouse_id);
create index if not exists plans_semi_phys_idx on public.plans_semi (phys_warehouse_id);

create unique index if not exists plans_fg_uni on public.plans_fg (product_id, phys_warehouse_id, date_iso);
create unique index if not exists plans_semi_uni on public.plans_semi (semi_id, phys_warehouse_id, date_iso);
