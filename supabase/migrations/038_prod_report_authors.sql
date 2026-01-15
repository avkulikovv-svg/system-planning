-- Track authors for production and scrap reports

alter table public.prod_reports
  add column if not exists author_id uuid references public.tg_users (id);

alter table public.prod_scrap_reports
  add column if not exists author_id uuid references public.tg_users (id);

create index if not exists prod_reports_author_idx on public.prod_reports (author_id);
create index if not exists prod_scrap_reports_author_idx on public.prod_scrap_reports (author_id);

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
  p_plan_date date default null,
  p_actor_id uuid default null
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

  if p_actor_id is null then
    raise exception 'Нужен автор отчёта';
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
    author_id,
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
    p_actor_id,
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
    insert into public.plans_fg (product_id, phys_warehouse_id, date_iso, qty, fact_qty, fact_updated_at)
    values (v_plan_item, p_phys_warehouse_id, p_plan_date, 0, p_qty, v_now)
    on conflict (product_id, phys_warehouse_id, date_iso)
    do update
    set fact_qty = public.plans_fg.fact_qty + excluded.fact_qty,
        fact_updated_at = v_now;
  elsif p_plan_kind = 'semi' and v_plan_item is not null and p_plan_date is not null then
    insert into public.plans_semi (semi_id, phys_warehouse_id, date_iso, qty, fact_qty, fact_updated_at)
    values (v_plan_item, p_phys_warehouse_id, p_plan_date, 0, p_qty, v_now)
    on conflict (semi_id, phys_warehouse_id, date_iso)
    do update
    set fact_qty = public.plans_semi.fact_qty + excluded.fact_qty,
        fact_updated_at = v_now;
  end if;

  return v_report_id;
end;
$$;

create or replace function public.post_production_scrap(
  p_number text,
  p_date_iso date,
  p_item_id uuid,
  p_qty numeric,
  p_phys_warehouse_id uuid,
  p_mat_zone_id uuid,
  p_semi_zone_id uuid default null,
  p_plan_kind text default null,
  p_plan_item_id uuid default null,
  p_plan_date date default null,
  p_actor_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report_id uuid;
  v_spec_id uuid;
  v_line record;
  v_number text;
begin
  if coalesce(p_qty, 0) <= 0 then
    raise exception 'Количество должно быть больше 0';
  end if;

  if p_actor_id is null then
    raise exception 'Нужен автор отчёта';
  end if;

  if p_plan_kind is not null and p_plan_kind not in ('fg','semi') then
    raise exception 'plan_kind % не поддерживается', p_plan_kind;
  end if;

  v_number := coalesce(trim(p_number), 'SCR-' || to_char(clock_timestamp(), 'YYMMDDHH24MISSMS'));

  insert into public.prod_scrap_reports (
    number,
    date_iso,
    item_id,
    qty,
    phys_warehouse_id,
    mat_zone_id,
    semi_zone_id,
    plan_kind,
    plan_item_id,
    plan_date,
    author_id
  )
  values (
    v_number,
    p_date_iso,
    p_item_id,
    p_qty,
    p_phys_warehouse_id,
    p_mat_zone_id,
    p_semi_zone_id,
    p_plan_kind,
    p_plan_item_id,
    p_plan_date,
    p_actor_id
  )
  returning id into v_report_id;

  select id
  into v_spec_id
  from public.specs
  where linked_product_id = p_item_id
  order by updated_at desc
  limit 1;

  if v_spec_id is null then
    raise exception 'Не найдена спецификация для продукта %', p_item_id;
  end if;

  for v_line in
    select ref_item_id, qty, kind
    from public.spec_lines
    where spec_id = v_spec_id
  loop
    if v_line.kind = 'semi' and p_semi_zone_id is not null then
      insert into public.stock_movements (doc_type, doc_id, item_id, warehouse_id, qty, created_at)
      values ('prod_scrap', v_report_id, v_line.ref_item_id, p_semi_zone_id, (v_line.qty * p_qty) * -1, now());
    else
      insert into public.stock_movements (doc_type, doc_id, item_id, warehouse_id, qty, created_at)
      values ('prod_scrap', v_report_id, v_line.ref_item_id, p_mat_zone_id, (v_line.qty * p_qty) * -1, now());
    end if;
  end loop;

  return v_report_id;
end;
$$;
