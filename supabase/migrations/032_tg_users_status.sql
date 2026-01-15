-- Allow pending users without tg_user_id and track status

alter table public.tg_users
  alter column tg_user_id drop not null;

alter table public.tg_users
  add column if not exists status text not null default 'active'
  check (status in ('pending','active','disabled'));
