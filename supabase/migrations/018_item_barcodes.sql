-- Item barcodes lookup + constraints
create table if not exists public.item_barcodes (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  channel text,
  barcode text not null,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists item_barcodes_item_idx on public.item_barcodes(item_id);
create unique index if not exists item_barcodes_unique_barcode on public.item_barcodes(barcode, coalesce(channel, ''));
create unique index if not exists item_barcodes_primary_once on public.item_barcodes(item_id) where is_primary;

alter table public.item_barcodes enable row level security;
grant select, insert, update, delete on public.item_barcodes to anon, authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'item_barcodes'
      and policyname = 'item_barcodes_all'
  ) then
    create policy item_barcodes_all on public.item_barcodes
      for all using (true) with check (true);
  end if;
end $$;
