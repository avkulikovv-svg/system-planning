-- Spec versioning and document snapshots

alter table public.specs
  add column if not exists version integer not null default 1;

alter table public.specs
  add column if not exists effective_from date;

alter table public.specs
  add column if not exists created_at timestamptz not null default now();

update public.specs
set effective_from = coalesce(effective_from, updated_at::date, current_date)
where effective_from is null;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'specs_spec_code_key'
      and conrelid = 'public.specs'::regclass
  ) then
    alter table public.specs drop constraint specs_spec_code_key;
  end if;
end $$;

create unique index if not exists specs_spec_code_version_unique
  on public.specs (spec_code, version);

alter table public.prod_reports
  add column if not exists spec_version_id uuid;

alter table public.prod_reports
  add column if not exists spec_snapshot jsonb;

do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'prod_scrap_reports'
  ) then
    alter table public.prod_scrap_reports
      add column if not exists spec_version_id uuid;

    alter table public.prod_scrap_reports
      add column if not exists spec_snapshot jsonb;
  end if;
end $$;
