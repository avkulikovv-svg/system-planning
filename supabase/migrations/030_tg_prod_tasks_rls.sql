-- RLS for Telegram production tasks

alter table public.tg_users enable row level security;
alter table public.prod_task_headers enable row level security;
alter table public.prod_task_lines enable row level security;
alter table public.prod_report_submissions enable row level security;
alter table public.prod_report_lines enable row level security;
alter table public.prod_report_actions enable row level security;
alter table public.prod_scrap_reports enable row level security;

grant select, insert, update, delete on public.tg_users to anon, authenticated;
grant select, insert, update, delete on public.prod_task_headers to anon, authenticated;
grant select, insert, update, delete on public.prod_task_lines to anon, authenticated;
grant select, insert, update, delete on public.prod_report_submissions to anon, authenticated;
grant select, insert, update, delete on public.prod_report_lines to anon, authenticated;
grant select, insert, update, delete on public.prod_report_actions to anon, authenticated;
grant select, insert, update, delete on public.prod_scrap_reports to anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'tg_users' and policyname = 'tg_users_all') then
    create policy tg_users_all on public.tg_users for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'prod_task_headers' and policyname = 'prod_task_headers_all') then
    create policy prod_task_headers_all on public.prod_task_headers for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'prod_task_lines' and policyname = 'prod_task_lines_all') then
    create policy prod_task_lines_all on public.prod_task_lines for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'prod_report_submissions' and policyname = 'prod_report_submissions_all') then
    create policy prod_report_submissions_all on public.prod_report_submissions for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'prod_report_lines' and policyname = 'prod_report_lines_all') then
    create policy prod_report_lines_all on public.prod_report_lines for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'prod_report_actions' and policyname = 'prod_report_actions_all') then
    create policy prod_report_actions_all on public.prod_report_actions for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'prod_scrap_reports' and policyname = 'prod_scrap_reports_all') then
    create policy prod_scrap_reports_all on public.prod_scrap_reports for all using (true) with check (true);
  end if;
end $$;
