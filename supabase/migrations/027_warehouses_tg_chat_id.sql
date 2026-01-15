-- Telegram chat ID for production department mapping

alter table public.warehouses
  add column if not exists tg_chat_id text;
