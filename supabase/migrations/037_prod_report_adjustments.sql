-- Adjustments for production and scrap reports (corrections)

create table if not exists public.prod_report_adjustments (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references public.prod_reports (id),
  product_id uuid not null references public.items (id),
  delta_qty numeric not null,
  reason text,
  phys_warehouse_id uuid not null references public.warehouses (id),
  fg_zone_id uuid not null references public.warehouses (id),
  mat_zone_id uuid not null references public.warehouses (id),
  plan_kind text check (plan_kind in ('fg','semi')),
  plan_item_id uuid references public.items (id),
  plan_date date,
  actor_id uuid references public.tg_users (id),
  created_at timestamptz not null default now()
);

create table if not exists public.prod_scrap_adjustments (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references public.prod_scrap_reports (id),
  item_id uuid not null references public.items (id),
  delta_qty numeric not null,
  reason text,
  phys_warehouse_id uuid not null references public.warehouses (id),
  mat_zone_id uuid not null references public.warehouses (id),
  semi_zone_id uuid references public.warehouses (id),
  plan_kind text check (plan_kind in ('fg','semi')),
  plan_item_id uuid references public.items (id),
  plan_date date,
  actor_id uuid references public.tg_users (id),
  created_at timestamptz not null default now()
);

create index if not exists prod_report_adjustments_report_idx on public.prod_report_adjustments (report_id);
create index if not exists prod_scrap_adjustments_report_idx on public.prod_scrap_adjustments (report_id);

alter table public.prod_report_adjustments enable row level security;
alter table public.prod_scrap_adjustments enable row level security;
grant select, insert, update, delete on public.prod_report_adjustments to anon, authenticated;
grant select, insert, update, delete on public.prod_scrap_adjustments to anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'prod_report_adjustments' and policyname = 'prod_report_adjustments_all') then
    create policy prod_report_adjustments_all on public.prod_report_adjustments for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'prod_scrap_adjustments' and policyname = 'prod_scrap_adjustments_all') then
    create policy prod_scrap_adjustments_all on public.prod_scrap_adjustments for all using (true) with check (true);
  end if;
end $$;

create or replace function public.adjust_production_report(
  p_delta_qty numeric,
  p_product_id uuid,
  p_phys_warehouse_id uuid,
  p_fg_zone_id uuid,
  p_mat_zone_id uuid,
  p_plan_kind text default null,
  p_plan_item_id uuid default null,
  p_plan_date date default null,
  p_report_id uuid default null,
  p_reason text default null,
  p_actor_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_adjust_id uuid;
  v_spec_id uuid;
  v_line record;
  v_now timestamptz := now();
  v_report public.prod_reports%rowtype;
  v_plan_item uuid;
  v_current numeric;
begin
  if coalesce(p_delta_qty, 0) = 0 then
    raise exception 'Delta должно быть не 0';
  end if;

  if p_report_id is not null then
    select * into v_report
    from public.prod_reports
    where id = p_report_id;
    if not found then
      raise exception 'Отчёт % не найден', p_report_id;
    end if;
    if p_product_id is null then p_product_id := v_report.product_id; end if;
    if p_phys_warehouse_id is null then p_phys_warehouse_id := v_report.phys_warehouse_id; end if;
    if p_fg_zone_id is null then p_fg_zone_id := v_report.fg_zone_id; end if;
    if p_mat_zone_id is null then p_mat_zone_id := v_report.mat_zone_id; end if;
    if p_plan_kind is null then p_plan_kind := v_report.plan_kind; end if;
    if p_plan_item_id is null then p_plan_item_id := v_report.plan_item_id; end if;
    if p_plan_date is null then p_plan_date := v_report.plan_date; end if;
  end if;

  if p_product_id is null or p_phys_warehouse_id is null or p_fg_zone_id is null or p_mat_zone_id is null then
    raise exception 'Недостаточно данных для корректировки';
  end if;

  if p_plan_kind is not null and p_plan_kind not in ('fg','semi') then
    raise exception 'plan_kind % не поддерживается', p_plan_kind;
  end if;

  v_plan_item := case when p_plan_kind is not null then coalesce(p_plan_item_id, p_product_id) else null end;

  if p_plan_kind = 'fg' and v_plan_item is not null and p_plan_date is not null then
    select fact_qty into v_current
    from public.plans_fg
    where product_id = v_plan_item
      and phys_warehouse_id = p_phys_warehouse_id
      and date_iso = p_plan_date;
    if coalesce(v_current, 0) + p_delta_qty < 0 then
      raise exception 'Факт станет отрицательным';
    end if;
  elsif p_plan_kind = 'semi' and v_plan_item is not null and p_plan_date is not null then
    select fact_qty into v_current
    from public.plans_semi
    where semi_id = v_plan_item
      and phys_warehouse_id = p_phys_warehouse_id
      and date_iso = p_plan_date;
    if coalesce(v_current, 0) + p_delta_qty < 0 then
      raise exception 'Факт станет отрицательным';
    end if;
  end if;

  select id
  into v_spec_id
  from public.specs
  where linked_product_id = p_product_id
  order by updated_at desc
  limit 1;

  if v_spec_id is null then
    raise exception 'Не найдена спецификация для продукта %', p_product_id;
  end if;

  insert into public.prod_report_adjustments (
    report_id,
    product_id,
    delta_qty,
    reason,
    phys_warehouse_id,
    fg_zone_id,
    mat_zone_id,
    plan_kind,
    plan_item_id,
    plan_date,
    actor_id,
    created_at
  )
  values (
    p_report_id,
    p_product_id,
    p_delta_qty,
    p_reason,
    p_phys_warehouse_id,
    p_fg_zone_id,
    p_mat_zone_id,
    p_plan_kind,
    v_plan_item,
    p_plan_date,
    p_actor_id,
    v_now
  )
  returning id into v_adjust_id;

  for v_line in
    select ref_item_id, qty
    from public.spec_lines
    where spec_id = v_spec_id
  loop
    if v_line.ref_item_id is null or coalesce(v_line.qty, 0) = 0 then
      continue;
    end if;
    insert into public.stock_movements (doc_type, doc_id, item_id, warehouse_id, qty, created_at)
    values ('prod_report_adjust', v_adjust_id, v_line.ref_item_id, p_mat_zone_id, (v_line.qty * p_delta_qty) * -1, v_now);
  end loop;

  insert into public.stock_movements (doc_type, doc_id, item_id, warehouse_id, qty, created_at)
  values ('prod_report_adjust', v_adjust_id, p_product_id, p_fg_zone_id, p_delta_qty, v_now);

  if p_plan_kind = 'fg' and v_plan_item is not null and p_plan_date is not null then
    update public.plans_fg
      set fact_qty = greatest(coalesce(fact_qty, 0) + p_delta_qty, 0),
          fact_updated_at = v_now
      where product_id = v_plan_item
        and phys_warehouse_id = p_phys_warehouse_id
        and date_iso = p_plan_date;
  elsif p_plan_kind = 'semi' and v_plan_item is not null and p_plan_date is not null then
    update public.plans_semi
      set fact_qty = greatest(coalesce(fact_qty, 0) + p_delta_qty, 0),
          fact_updated_at = v_now
      where semi_id = v_plan_item
        and phys_warehouse_id = p_phys_warehouse_id
        and date_iso = p_plan_date;
  end if;

  return v_adjust_id;
end;
$$;

create or replace function public.adjust_production_scrap(
  p_delta_qty numeric,
  p_item_id uuid,
  p_phys_warehouse_id uuid,
  p_mat_zone_id uuid,
  p_semi_zone_id uuid default null,
  p_plan_kind text default null,
  p_plan_item_id uuid default null,
  p_plan_date date default null,
  p_report_id uuid default null,
  p_reason text default null,
  p_actor_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_adjust_id uuid;
  v_spec_id uuid;
  v_line record;
  v_now timestamptz := now();
  v_report public.prod_scrap_reports%rowtype;
  v_plan_item uuid;
  v_current numeric;
begin
  if coalesce(p_delta_qty, 0) = 0 then
    raise exception 'Delta должно быть не 0';
  end if;

  if p_report_id is not null then
    select * into v_report
    from public.prod_scrap_reports
    where id = p_report_id;
    if not found then
      raise exception 'Отчёт о браке % не найден', p_report_id;
    end if;
    if p_item_id is null then p_item_id := v_report.item_id; end if;
    if p_phys_warehouse_id is null then p_phys_warehouse_id := v_report.phys_warehouse_id; end if;
    if p_mat_zone_id is null then p_mat_zone_id := v_report.mat_zone_id; end if;
    if p_semi_zone_id is null then p_semi_zone_id := v_report.semi_zone_id; end if;
    if p_plan_kind is null then p_plan_kind := v_report.plan_kind; end if;
    if p_plan_item_id is null then p_plan_item_id := v_report.plan_item_id; end if;
    if p_plan_date is null then p_plan_date := v_report.plan_date; end if;
  end if;

  if p_item_id is null or p_phys_warehouse_id is null or p_mat_zone_id is null then
    raise exception 'Недостаточно данных для корректировки брака';
  end if;

  if p_plan_kind is not null and p_plan_kind not in ('fg','semi') then
    raise exception 'plan_kind % не поддерживается', p_plan_kind;
  end if;

  v_plan_item := case when p_plan_kind is not null then coalesce(p_plan_item_id, p_item_id) else null end;

  if p_plan_kind = 'fg' and v_plan_item is not null and p_plan_date is not null then
    select scrap_qty into v_current
    from public.plans_fg
    where product_id = v_plan_item
      and phys_warehouse_id = p_phys_warehouse_id
      and date_iso = p_plan_date;
    if coalesce(v_current, 0) + p_delta_qty < 0 then
      raise exception 'Брак станет отрицательным';
    end if;
  elsif p_plan_kind = 'semi' and v_plan_item is not null and p_plan_date is not null then
    select scrap_qty into v_current
    from public.plans_semi
    where semi_id = v_plan_item
      and phys_warehouse_id = p_phys_warehouse_id
      and date_iso = p_plan_date;
    if coalesce(v_current, 0) + p_delta_qty < 0 then
      raise exception 'Брак станет отрицательным';
    end if;
  end if;

  select id
  into v_spec_id
  from public.specs
  where linked_product_id = p_item_id
  order by updated_at desc
  limit 1;

  if v_spec_id is null then
    raise exception 'Не найдена спецификация для продукта %', p_item_id;
  end if;

  insert into public.prod_scrap_adjustments (
    report_id,
    item_id,
    delta_qty,
    reason,
    phys_warehouse_id,
    mat_zone_id,
    semi_zone_id,
    plan_kind,
    plan_item_id,
    plan_date,
    actor_id,
    created_at
  )
  values (
    p_report_id,
    p_item_id,
    p_delta_qty,
    p_reason,
    p_phys_warehouse_id,
    p_mat_zone_id,
    p_semi_zone_id,
    p_plan_kind,
    v_plan_item,
    p_plan_date,
    p_actor_id,
    v_now
  )
  returning id into v_adjust_id;

  for v_line in
    select ref_item_id, qty, kind
    from public.spec_lines
    where spec_id = v_spec_id
  loop
    if v_line.ref_item_id is null or coalesce(v_line.qty, 0) = 0 then
      continue;
    end if;
    if v_line.kind = 'semi' and p_semi_zone_id is not null then
      insert into public.stock_movements (doc_type, doc_id, item_id, warehouse_id, qty, created_at)
      values ('prod_scrap_adjust', v_adjust_id, v_line.ref_item_id, p_semi_zone_id, (v_line.qty * p_delta_qty) * -1, v_now);
    else
      insert into public.stock_movements (doc_type, doc_id, item_id, warehouse_id, qty, created_at)
      values ('prod_scrap_adjust', v_adjust_id, v_line.ref_item_id, p_mat_zone_id, (v_line.qty * p_delta_qty) * -1, v_now);
    end if;
  end loop;

  if p_plan_kind = 'fg' and v_plan_item is not null and p_plan_date is not null then
    update public.plans_fg
      set scrap_qty = greatest(coalesce(scrap_qty, 0) + p_delta_qty, 0)
      where product_id = v_plan_item
        and phys_warehouse_id = p_phys_warehouse_id
        and date_iso = p_plan_date;
  elsif p_plan_kind = 'semi' and v_plan_item is not null and p_plan_date is not null then
    update public.plans_semi
      set scrap_qty = greatest(coalesce(scrap_qty, 0) + p_delta_qty, 0)
      where semi_id = v_plan_item
        and phys_warehouse_id = p_phys_warehouse_id
        and date_iso = p_plan_date;
  end if;

  return v_adjust_id;
end;
$$;
