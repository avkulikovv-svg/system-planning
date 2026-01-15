-- Расширяем первичный ключ планов складом, чтобы одна дата могла быть запланирована по каждому складу.

do $$
declare
  v_default uuid;
begin
  -- подстраховка: проставим phys_warehouse_id, если вдруг остались NULL
  select id into v_default from public.warehouses where type = 'physical' order by created_at limit 1;
  if v_default is not null then
    update public.plans_fg   set phys_warehouse_id = coalesce(phys_warehouse_id, v_default);
    update public.plans_semi set phys_warehouse_id = coalesce(phys_warehouse_id, v_default);
  end if;
end$$;

alter table if exists public.plans_fg
  alter column phys_warehouse_id set not null;

alter table if exists public.plans_semi
  alter column phys_warehouse_id set not null;

-- сначала убираем прежние ограничения/индексы
drop index if exists plans_fg_uni;
drop index if exists plans_semi_uni;

alter table if exists public.plans_fg
  drop constraint if exists plans_fg_pkey;

alter table if exists public.plans_semi
  drop constraint if exists plans_semi_pkey;

-- новый состав первичного ключа: товар/ПФ + склад + дата
alter table if exists public.plans_fg
  add constraint plans_fg_pkey primary key (product_id, phys_warehouse_id, date_iso);

alter table if exists public.plans_semi
  add constraint plans_semi_pkey primary key (semi_id, phys_warehouse_id, date_iso);

-- индексы на склад для фильтрации
create index if not exists plans_fg_phys_idx on public.plans_fg (phys_warehouse_id);
create index if not exists plans_semi_phys_idx on public.plans_semi (phys_warehouse_id);
