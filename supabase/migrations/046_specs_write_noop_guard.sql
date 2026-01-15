-- Avoid creating a new spec version when nothing changed
create or replace function public.upsert_spec_with_lines(
  p_spec_code text,
  p_spec_name text,
  p_linked_product_id uuid default null,
  p_effective_from date default null,
  p_lines jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_spec_id uuid := gen_random_uuid();
  v_prev_id uuid;
  v_prev_name text;
  v_prev_linked uuid;
  v_prev_effective date;
  v_version integer;
  v_now timestamptz := now();
  v_linked uuid;
  v_spec_code text;
  v_spec_name text;
  v_effective_from date;
  v_lines_json jsonb := '[]'::jsonb;
  v_line jsonb;
  v_ref uuid;
  v_ref_raw text;
  v_qty numeric;
  v_kind text;
  v_uom text;
begin
  if p_spec_code is null or btrim(p_spec_code) = '' then
    raise exception 'spec_code is required';
  end if;

  v_spec_code := btrim(p_spec_code);
  v_spec_name := coalesce(nullif(btrim(p_spec_name), ''), v_spec_code);
  v_effective_from := coalesce(p_effective_from, current_date);

  if p_lines is not null and jsonb_typeof(p_lines) = 'array' then
    v_lines_json := p_lines;
  end if;

  select id, spec_name, linked_product_id, effective_from
  into v_prev_id, v_prev_name, v_prev_linked, v_prev_effective
  from public.specs
  where upper(spec_code) = upper(v_spec_code)
  order by version desc nulls last, updated_at desc
  limit 1;

  v_linked := coalesce(p_linked_product_id, v_prev_linked);

  if v_prev_id is not null then
    if coalesce(v_prev_name, '') = coalesce(v_spec_name, '')
      and coalesce(v_prev_linked::text, '') = coalesce(v_linked::text, '')
      and coalesce(v_prev_effective, current_date) = v_effective_from
    then
      if not exists (
        (select kind, ref_item_id, qty, uom
         from public.spec_lines
         where spec_id = v_prev_id)
        except
        (select kind, ref_item_id, qty, uom
         from (
           select
             case when line_json->>'kind' = 'semi' then 'semi' else 'mat' end as kind,
             case
               when (line_json->>'ref_item_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                 then (line_json->>'ref_item_id')::uuid
               else null
             end as ref_item_id,
             coalesce((line_json->>'qty')::numeric, 0) as qty,
             nullif(line_json->>'uom', '') as uom
           from jsonb_array_elements(v_lines_json) line_json
         ) nl
         where nl.ref_item_id is not null and nl.qty <> 0)
      )
      and not exists (
        (select kind, ref_item_id, qty, uom
         from (
           select
             case when line_json->>'kind' = 'semi' then 'semi' else 'mat' end as kind,
             case
               when (line_json->>'ref_item_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                 then (line_json->>'ref_item_id')::uuid
               else null
             end as ref_item_id,
             coalesce((line_json->>'qty')::numeric, 0) as qty,
             nullif(line_json->>'uom', '') as uom
           from jsonb_array_elements(v_lines_json) line_json
         ) nl
         where nl.ref_item_id is not null and nl.qty <> 0)
        except
        (select kind, ref_item_id, qty, uom
         from public.spec_lines
         where spec_id = v_prev_id)
      )
      then
        return v_prev_id;
      end if;
    end if;
  end if;

  select coalesce(max(version), 0) + 1
  into v_version
  from public.specs
  where upper(spec_code) = upper(v_spec_code);

  insert into public.specs (
    id,
    spec_code,
    spec_name,
    linked_product_id,
    version,
    effective_from,
    updated_at
  )
  values (
    v_spec_id,
    v_spec_code,
    v_spec_name,
    v_linked,
    v_version,
    v_effective_from,
    v_now
  );

  if v_lines_json is not null and jsonb_typeof(v_lines_json) = 'array' then
    for v_line in select * from jsonb_array_elements(v_lines_json)
    loop
      v_ref_raw := nullif(v_line->>'ref_item_id', '');
      v_ref := case
        when v_ref_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then v_ref_raw::uuid
        else null
      end;
      v_qty := coalesce((v_line->>'qty')::numeric, 0);
      if v_ref is null or v_qty = 0 then
        continue;
      end if;
      v_kind := case when v_line->>'kind' = 'semi' then 'semi' else 'mat' end;
      v_uom := nullif(v_line->>'uom', '');

      insert into public.spec_lines (
        id,
        spec_id,
        kind,
        ref_item_id,
        qty,
        uom
      )
      values (
        gen_random_uuid(),
        v_spec_id,
        v_kind,
        v_ref,
        v_qty,
        v_uom
      );
    end loop;
  end if;

  return v_spec_id;
end;
$$;
