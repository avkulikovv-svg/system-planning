
-- Seed/refresh specification for DA Soap crystal (super clear)

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'specs_spec_code_key'
      and conrelid = 'public.specs'::regclass
  ) then
    alter table public.specs add constraint specs_spec_code_key unique (spec_code);
  end if;
end
$$;

with spec_row as (
  insert into public.specs (spec_code, spec_name, linked_product_id, updated_at)
  values (
    'DA_SOAP_SUPER_CLEAR',
    'DA Soap crystal (super clear)',
    (select id from public.items where lower(name) = lower('DA Soap crystal (super clear)') limit 1),
    now()
  )
  on conflict (spec_code)
  do update set
    spec_name = excluded.spec_name,
    linked_product_id = excluded.linked_product_id,
    updated_at = now()
  returning id
)
, deleted as (
  delete from public.spec_lines
  where spec_id in (select id from spec_row)
)
insert into public.spec_lines (spec_id, kind, ref_item_id, qty)
select s.id, 'mat', i.id, m.qty
from spec_row s
cross join (
  values
    ('Пропиленгликоль', 0.256),
    ('Стеариновая кислота', 0.138),
    ('Лауриновая кислота', 0.049),
    ('Лаурет сульфат', 0.262),
    ('Вода горячая', 0.014),
    ('ЭДТА', 0.001),
    ('Вода холодная', 0.056),
    ('Каустическая сода', 0.030),
    ('Глицерин', 0.061),
    ('Сорбитол', 0.134)
) as m(name, qty)
join public.items i on lower(i.name) = lower(m.name)
order by m.name;
