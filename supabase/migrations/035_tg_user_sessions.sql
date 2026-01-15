-- Telegram user session state for report input

create table if not exists public.tg_user_sessions (
  id uuid primary key default gen_random_uuid(),
  tg_user_id uuid not null references public.tg_users (id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  unique (tg_user_id)
);

create index if not exists tg_user_sessions_user_idx on public.tg_user_sessions (tg_user_id);

alter table public.tg_user_sessions enable row level security;
grant select, insert, update, delete on public.tg_user_sessions to anon, authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'tg_user_sessions'
      and policyname = 'tg_user_sessions_all'
  ) then
    create policy tg_user_sessions_all on public.tg_user_sessions
      for all using (true) with check (true);
  end if;
end $$;
