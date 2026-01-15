-- Telegram plan send time per warehouse

alter table public.warehouses
  add column if not exists tg_send_time text;
