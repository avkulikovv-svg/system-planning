-- Drop permissive policies and enforce active-user access
do $$
declare
  r record;
begin
  for r in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and policyname in (
        'uoms_all',
        'categories_all',
        'vendors_all',
        'warehouses_all',
        'receipts_all',
        'receipt_items_all',
        'mp_destinations_all',
        'mp_supply_plans_all',
        'mp_supply_plans_history_all',
        'item_barcodes_all',
        'tg_users_all',
        'prod_task_headers_all',
        'prod_task_lines_all',
        'prod_report_submissions_all',
        'prod_report_lines_all',
        'prod_report_actions_all',
        'prod_scrap_reports_all',
        'tg_user_warehouses_all',
        'tg_user_sessions_all',
        'prod_report_adjustments_all',
        'prod_scrap_adjustments_all',
        'item_groups_policy'
      )
  loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end
$$;

do $$
declare
  r record;
begin
  for r in
    select c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname <> 'profiles'
  loop
    execute format('alter table public.%I enable row level security', r.table_name);
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = r.table_name
        and policyname = 'allow_active_user'
    ) then
      execute format(
        'create policy allow_active_user on public.%I for all using (public.is_active_user()) with check (public.is_active_user())',
        r.table_name
      );
    end if;
  end loop;
end
$$;
