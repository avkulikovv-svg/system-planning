-- Add uom to spec_lines to preserve units in specs
alter table public.spec_lines
  add column if not exists uom text;

-- Backfill existing rows with a safe default
update public.spec_lines
set uom = coalesce(uom, 'шт')
where uom is null;
