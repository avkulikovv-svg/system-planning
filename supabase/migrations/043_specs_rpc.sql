-- Update production RPC to use spec versions and snapshots

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
  v_spec_snapshot jsonb;
  v_line record;
  v_plan_item uuid;
  v_now timestamptz := now();
  v_number text;
  v_effective_date date;
begin
  if coalesce(p_qty, 0) <= 0 then
    raise exception 'Количество должно быть больше 0';
  end if;

  if p_plan_kind is not null and p_plan_kind not in ('fg','semi') then
    raise exception 'plan_kind % не поддерживается', p_plan_kind;
  end if;

  v_number := coalesce(trim(p_number), 'PR-' || to_char(clock_timestamp(), 'YYMMDDHH24MISSMS'));
  v_plan_item := case when p_plan_kind is not null then coalesce(p_plan_item_id, p_product_id) else null end;
  v_effective_date := coalesce(p_date_iso, current_date);

  select id
  into v_spec_id
  from public.specs
  where linked_product_id = p_product_id
    and (effective_from is null or effective_from <= v_effective_date)
  order by effective_from desc nulls last, version desc, updated_at desc
  limit 1;

  if v_spec_id is null then
    raise exception 'Не найдена спецификация для продукта %', p_product_id;
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'ref_item_id', ref_item_id,
      'qty', qty,
      'kind', kind,
      'uom', uom
    )
  )
  into v_spec_snapshot
  from public.spec_lines
  where spec_id = v_spec_id;

  if v_spec_snapshot is null then
    raise exception 'Спецификация % не содержит строк', v_spec_id;
  end if;

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
    spec_version_id,
    spec_snapshot,
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
    v_spec_id,
    v_spec_snapshot,
    v_now,
    v_now
  )
  returning id into v_report_id;

  for v_line in
    select *
    from jsonb_to_recordset(v_spec_snapshot) as x(
      ref_item_id uuid,
      qty numeric,
      kind text,
      uom text
    )
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
  p_plan_date date default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report_id uuid;
  v_spec_id uuid;
  v_spec_snapshot jsonb;
  v_line record;
  v_number text;
  v_effective_date date;
begin
  if coalesce(p_qty, 0) <= 0 then
    raise exception 'Количество должно быть больше 0';
  end if;

  if p_plan_kind is not null and p_plan_kind not in ('fg','semi') then
    raise exception 'plan_kind % не поддерживается', p_plan_kind;
  end if;

  v_number := coalesce(trim(p_number), 'SCR-' || to_char(clock_timestamp(), 'YYMMDDHH24MISSMS'));
  v_effective_date := coalesce(p_date_iso, current_date);

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
    plan_date
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
    p_plan_date
  )
  returning id into v_report_id;

  select id
  into v_spec_id
  from public.specs
  where linked_product_id = p_item_id
    and (effective_from is null or effective_from <= v_effective_date)
  order by effective_from desc nulls last, version desc, updated_at desc
  limit 1;

  if v_spec_id is null then
    raise exception 'Не найдена спецификация для продукта %', p_item_id;
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'ref_item_id', ref_item_id,
      'qty', qty,
      'kind', kind,
      'uom', uom
    )
  )
  into v_spec_snapshot
  from public.spec_lines
  where spec_id = v_spec_id;

  if v_spec_snapshot is null then
    raise exception 'Спецификация % не содержит строк', v_spec_id;
  end if;

  update public.prod_scrap_reports
    set spec_version_id = v_spec_id,
        spec_snapshot = v_spec_snapshot
    where id = v_report_id;

  for v_line in
    select *
    from jsonb_to_recordset(v_spec_snapshot) as x(
      ref_item_id uuid,
      qty numeric,
      kind text,
      uom text
    )
  loop
    if v_line.ref_item_id is null or coalesce(v_line.qty, 0) = 0 then
      continue;
    end if;
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

create or replace function public.adjust_production_report(
  p_report_id uuid,
  p_delta_qty numeric,
  p_product_id uuid,
  p_phys_warehouse_id uuid,
  p_fg_zone_id uuid,
  p_mat_zone_id uuid,
  p_plan_kind text default null,
  p_plan_item_id uuid default null,
  p_plan_date date default null,
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
  v_snapshot jsonb;
  v_line record;
  v_plan_item uuid;
  v_now timestamptz := now();
  v_current numeric;
  v_effective_date date;
begin
  if p_product_id is null or p_phys_warehouse_id is null or p_fg_zone_id is null or p_mat_zone_id is null then
    raise exception 'Недостаточно данных для корректировки отчёта';
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

  select spec_snapshot
  into v_snapshot
  from public.prod_reports
  where id = p_report_id;

  if v_snapshot is null then
    v_effective_date := coalesce(p_plan_date, current_date);
    select id
    into v_spec_id
    from public.specs
    where linked_product_id = p_product_id
      and (effective_from is null or effective_from <= v_effective_date)
    order by effective_from desc nulls last, version desc, updated_at desc
    limit 1;

    if v_spec_id is null then
      raise exception 'Не найдена спецификация для продукта %', p_product_id;
    end if;

    select jsonb_agg(
      jsonb_build_object(
        'ref_item_id', ref_item_id,
        'qty', qty,
        'kind', kind,
        'uom', uom
      )
    )
    into v_snapshot
    from public.spec_lines
    where spec_id = v_spec_id;
  end if;

  if v_snapshot is null then
    raise exception 'Спецификация для корректировки не найдена';
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
    select *
    from jsonb_to_recordset(v_snapshot) as x(
      ref_item_id uuid,
      qty numeric,
      kind text,
      uom text
    )
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
  v_snapshot jsonb;
  v_line record;
  v_plan_item uuid;
  v_now timestamptz := now();
  v_current numeric;
  v_effective_date date;
begin
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

  if p_report_id is not null then
    select spec_snapshot
    into v_snapshot
    from public.prod_reports
    where id = p_report_id;
  end if;

  if v_snapshot is null then
    v_effective_date := coalesce(p_plan_date, current_date);
    select id
    into v_spec_id
    from public.specs
    where linked_product_id = p_item_id
      and (effective_from is null or effective_from <= v_effective_date)
    order by effective_from desc nulls last, version desc, updated_at desc
    limit 1;

    if v_spec_id is null then
      raise exception 'Не найдена спецификация для продукта %', p_item_id;
    end if;

    select jsonb_agg(
      jsonb_build_object(
        'ref_item_id', ref_item_id,
        'qty', qty,
        'kind', kind,
        'uom', uom
      )
    )
    into v_snapshot
    from public.spec_lines
    where spec_id = v_spec_id;
  end if;

  if v_snapshot is null then
    raise exception 'Спецификация для корректировки не найдена';
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
    select *
    from jsonb_to_recordset(v_snapshot) as x(
      ref_item_id uuid,
      qty numeric,
      kind text,
      uom text
    )
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
