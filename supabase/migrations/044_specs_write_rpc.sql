-- Transactional upsert for specs + lines
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
  v_version integer;
  v_now timestamptz := now();
  v_linked uuid;
  v_spec_code text;
  v_line jsonb;
  v_ref uuid;
  v_qty numeric;
  v_kind text;
  v_uom text;
begin
  if p_spec_code is null or btrim(p_spec_code) = '' then
    raise exception 'spec_code is required';
  end if;

  v_spec_code := btrim(p_spec_code);

  v_linked := coalesce(
    p_linked_product_id,
    (
      select linked_product_id
      from public.specs
      where upper(spec_code) = upper(v_spec_code)
      order by version desc nulls last, updated_at desc
      limit 1
    )
  );

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
    coalesce(nullif(btrim(p_spec_name), ''), v_spec_code),
    v_linked,
    v_version,
    coalesce(p_effective_from, current_date),
    v_now
  );

  if p_lines is not null and jsonb_typeof(p_lines) = 'array' then
    for v_line in select * from jsonb_array_elements(p_lines)
    loop
      v_ref := nullif(v_line->>'ref_item_id', '')::uuid;
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
