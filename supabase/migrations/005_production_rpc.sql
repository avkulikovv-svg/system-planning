-- Производственные отчёты и RPC

create table if not exists public.prod_reports (
  id uuid primary key default gen_random_uuid(),
  number text not null,
  date_iso date not null,
  product_id uuid not null references public.items (id),
  qty numeric not null,
  status text not null default 'posted' check (status in ('draft','posted','canceled')),
  phys_warehouse_id uuid not null references public.warehouses (id),
  fg_zone_id uuid not null references public.warehouses (id),
  mat_zone_id uuid not null references public.warehouses (id),
  plan_kind text check (plan_kind in ('fg','semi')),
  plan_item_id uuid references public.items (id),
  plan_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  canceled_at timestamptz
);

create index if not exists prod_reports_date_idx on public.prod_reports (date_iso);
create index if not exists prod_reports_product_idx on public.prod_reports (product_id);

create or replace function public.touch_prod_report()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_prod_reports_touch on public.prod_reports;
create trigger trg_prod_reports_touch
before update on public.prod_reports
for each row
execute function public.touch_prod_report();

create or replace function public.post_production_report(
  p_number text,
  p_date_iso date,
  p_product_id uuid,
  p_qty numeric,
  p_phys_warehouse_id uuid,
  p_fg_zone_id uuid,
  p_mat_zone_id uuid,
  p_plan_kind text default null,
  p_plan_item_id uuid default null,
  p_plan_date date default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report_id uuid;
  v_spec_id uuid;
  v_line record;
  v_plan_item uuid;
  v_now timestamptz := now();
  v_number text;
begin
  if coalesce(p_qty, 0) <= 0 then
    raise exception 'Количество должно быть больше 0';
  end if;

  if p_plan_kind is not null and p_plan_kind not in ('fg','semi') then
    raise exception 'plan_kind % не поддерживается', p_plan_kind;
  end if;

  v_number := coalesce(trim(p_number), 'PR-' || to_char(clock_timestamp(), 'YYMMDDHH24MISSMS'));
  v_plan_item := case when p_plan_kind is not null then coalesce(p_plan_item_id, p_product_id) else null end;

  insert into public.prod_reports (
    number,
    date_iso,
    product_id,
    qty,
    status,
    phys_warehouse_id,
    fg_zone_id,
    mat_zone_id,
    plan_kind,
    plan_item_id,
    plan_date,
    created_at,
    updated_at
  )
  values (
    v_number,
    p_date_iso,
    p_product_id,
    p_qty,
    'posted',
    p_phys_warehouse_id,
    p_fg_zone_id,
    p_mat_zone_id,
    p_plan_kind,
    v_plan_item,
    p_plan_date,
    v_now,
    v_now
  )
  returning id into v_report_id;

  select id
  into v_spec_id
  from public.specs
  where linked_product_id = p_product_id
  order by updated_at desc
  limit 1;

  if v_spec_id is null then
    raise exception 'Не найдена спецификация для продукта %', p_product_id;
  end if;

  for v_line in
    select ref_item_id, qty
    from public.spec_lines
    where spec_id = v_spec_id
  loop
    if v_line.ref_item_id is null or coalesce(v_line.qty, 0) = 0 then
      continue;
    end if;

    insert into public.stock_movements (doc_type, doc_id, item_id, warehouse_id, qty, created_at)
    values ('prod_report', v_report_id, v_line.ref_item_id, p_mat_zone_id, (v_line.qty * p_qty) * -1, v_now);
  end loop;

  insert into public.stock_movements (doc_type, doc_id, item_id, warehouse_id, qty, created_at)
  values ('prod_report', v_report_id, p_product_id, p_fg_zone_id, p_qty, v_now);

  if p_plan_kind = 'fg' and v_plan_item is not null and p_plan_date is not null then
    insert into public.plans_fg (product_id, date_iso, qty, fact_qty, fact_updated_at)
    values (v_plan_item, p_plan_date, 0, p_qty, v_now)
    on conflict (product_id, date_iso)
    do update
    set fact_qty = public.plans_fg.fact_qty + excluded.fact_qty,
        fact_updated_at = v_now;
  elsif p_plan_kind = 'semi' and v_plan_item is not null and p_plan_date is not null then
    insert into public.plans_semi (semi_id, date_iso, qty, fact_qty, fact_updated_at)
    values (v_plan_item, p_plan_date, 0, p_qty, v_now)
    on conflict (semi_id, date_iso)
    do update
    set fact_qty = public.plans_semi.fact_qty + excluded.fact_qty,
        fact_updated_at = v_now;
  end if;

  return v_report_id;
end;
$$;

create or replace function public.rollback_production_report(p_report_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report public.prod_reports%rowtype;
  v_now timestamptz := now();
begin
  select * into v_report
  from public.prod_reports
  where id = p_report_id
  for update;

  if not found then
    raise exception 'Отчёт % не найден', p_report_id;
  end if;

  if v_report.status = 'canceled' then
    return;
  end if;

  delete from public.stock_movements
  where doc_id = p_report_id
    and doc_type = 'prod_report';

  if v_report.plan_kind = 'fg' and v_report.plan_item_id is not null and v_report.plan_date is not null then
    update public.plans_fg
      set fact_qty = greatest(coalesce(fact_qty, 0) - v_report.qty, 0),
          fact_updated_at = v_now
      where product_id = v_report.plan_item_id
        and date_iso = v_report.plan_date;
  elsif v_report.plan_kind = 'semi' and v_report.plan_item_id is not null and v_report.plan_date is not null then
    update public.plans_semi
      set fact_qty = greatest(coalesce(fact_qty, 0) - v_report.qty, 0),
          fact_updated_at = v_now
      where semi_id = v_report.plan_item_id
        and date_iso = v_report.plan_date;
  end if;

  update public.prod_reports
    set status = 'canceled',
        canceled_at = v_now,
        updated_at = v_now
    where id = p_report_id;
end;
$$;
