-- Safe cleanup of duplicate spec versions (created by repeated save with no changes)
-- 1) Run the "preview" query first and review counts.
-- 2) If ok, run the delete block.

-- Preview duplicates (no changes)
with lines as (
  select
    spec_id,
    jsonb_agg(
      jsonb_build_object(
        'kind', kind,
        'ref_item_id', ref_item_id,
        'qty', qty,
        'uom', coalesce(uom, '')
      )
      order by kind, ref_item_id, qty, coalesce(uom, '')
    ) as lines
  from public.spec_lines
  group by spec_id
),
spec_payload as (
  select
    s.id,
    upper(s.spec_code) as spec_code_norm,
    s.spec_code,
    s.spec_name,
    s.linked_product_id,
    s.effective_from,
    s.version,
    s.updated_at,
    s.created_at,
    coalesce(l.lines, '[]'::jsonb) as lines,
    md5(
      coalesce(s.spec_name, '') || '|' ||
      coalesce(s.linked_product_id::text, '') || '|' ||
      coalesce(s.effective_from::text, '') || '|' ||
      coalesce(l.lines::text, '')
    ) as payload_hash
  from public.specs s
  left join lines l on l.spec_id = s.id
),
ranked as (
  select
    *,
    row_number() over (
      partition by spec_code_norm, payload_hash
      order by version desc nulls last, updated_at desc nulls last, created_at desc nulls last
    ) as rn
  from spec_payload
),
referenced as (
  select spec_version_id as id
  from public.prod_reports
  where spec_version_id is not null
  union
  select spec_version_id as id
  from public.prod_scrap_reports
  where spec_version_id is not null
)
select
  r.id,
  r.spec_code,
  r.version,
  r.updated_at
from ranked r
where r.rn > 1
  and r.id not in (select id from referenced)
order by r.spec_code, r.version desc;

-- Delete duplicates (only after review)
-- begin;
-- create temp table tmp_spec_dupes as
-- with lines as (
--   select
--     spec_id,
--     jsonb_agg(
--       jsonb_build_object(
--         'kind', kind,
--         'ref_item_id', ref_item_id,
--         'qty', qty,
--         'uom', coalesce(uom, '')
--       )
--       order by kind, ref_item_id, qty, coalesce(uom, '')
--     ) as lines
--   from public.spec_lines
--   group by spec_id
-- ),
-- spec_payload as (
--   select
--     s.id,
--     upper(s.spec_code) as spec_code_norm,
--     s.spec_code,
--     s.spec_name,
--     s.linked_product_id,
--     s.effective_from,
--     s.version,
--     s.updated_at,
--     s.created_at,
--     coalesce(l.lines, '[]'::jsonb) as lines,
--     md5(
--       coalesce(s.spec_name, '') || '|' ||
--       coalesce(s.linked_product_id::text, '') || '|' ||
--       coalesce(s.effective_from::text, '') || '|' ||
--       coalesce(l.lines::text, '')
--     ) as payload_hash
--   from public.specs s
--   left join lines l on l.spec_id = s.id
-- ),
-- ranked as (
--   select
--     *,
--     row_number() over (
--       partition by spec_code_norm, payload_hash
--       order by version desc nulls last, updated_at desc nulls last, created_at desc nulls last
--     ) as rn
--   from spec_payload
-- ),
-- referenced as (
--   select spec_version_id as id
--   from public.prod_reports
--   where spec_version_id is not null
--   union
--   select spec_version_id as id
--   from public.prod_scrap_reports
--   where spec_version_id is not null
-- )
-- select r.id
-- from ranked r
-- where r.rn > 1
--   and r.id not in (select id from referenced);
--
-- delete from public.spec_lines
-- where spec_id in (select id from tmp_spec_dupes);
--
-- delete from public.specs
-- where id in (select id from tmp_spec_dupes);
--
-- commit;
