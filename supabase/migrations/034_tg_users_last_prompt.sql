-- Throttle prompts for missing Telegram user data

alter table public.tg_users
  add column if not exists last_prompt_at timestamptz;
