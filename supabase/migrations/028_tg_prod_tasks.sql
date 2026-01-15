-- Telegram production tasks and reports

create table if not exists public.tg_users (
  id uuid primary key default gen_random_uuid(),
  tg_user_id bigint not null unique,
  username text,
  first_name text,
  last_name text,
  role text not null default 'executor' check (role in ('executor','controller')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.prod_task_headers (
  id uuid primary key default gen_random_uuid(),
  plan_date date not null,
  phys_warehouse_id uuid not null references public.warehouses (id),
  tg_chat_id text,
  status text not null default 'open' check (status in ('open','closed')),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plan_date, phys_warehouse_id)
);

create table if not exists public.prod_task_lines (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.prod_task_headers (id) on delete cascade,
  plan_kind text not null check (plan_kind in ('fg','semi')),
  plan_item_id uuid not null references public.items (id),
  plan_qty numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (task_id, plan_kind, plan_item_id)
);

create table if not exists public.prod_report_submissions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.prod_task_headers (id) on delete cascade,
  tg_user_id uuid not null references public.tg_users (id),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references public.tg_users (id)
);

create table if not exists public.prod_report_lines (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.prod_report_submissions (id) on delete cascade,
  plan_kind text not null check (plan_kind in ('fg','semi')),
  plan_item_id uuid not null references public.items (id),
  plan_date date not null,
  qty numeric not null default 0,
  scrap_qty numeric not null default 0,
  comment text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  approved_at timestamptz,
  approved_by uuid references public.tg_users (id),
  created_at timestamptz not null default now()
);

create table if not exists public.prod_report_actions (
  id uuid primary key default gen_random_uuid(),
  report_line_id uuid not null references public.prod_report_lines (id) on delete cascade,
  actor_id uuid references public.tg_users (id),
  action text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.prod_scrap_reports (
  id uuid primary key default gen_random_uuid(),
  number text not null,
  date_iso date not null,
  item_id uuid not null references public.items (id),
  qty numeric not null,
  phys_warehouse_id uuid not null references public.warehouses (id),
  mat_zone_id uuid not null references public.warehouses (id),
  semi_zone_id uuid references public.warehouses (id),
  plan_kind text check (plan_kind in ('fg','semi')),
  plan_item_id uuid references public.items (id),
  plan_date date,
  created_at timestamptz not null default now()
);

create index if not exists prod_task_headers_wh_idx on public.prod_task_headers (phys_warehouse_id, plan_date);
create index if not exists prod_task_lines_task_idx on public.prod_task_lines (task_id);
create index if not exists prod_report_submissions_task_idx on public.prod_report_submissions (task_id);
create index if not exists prod_report_lines_sub_idx on public.prod_report_lines (submission_id);
