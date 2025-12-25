
-- Seed/refresh specification for DA Soap opaque

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
    'DA_SOAP_OPAQUE',
    'DA Soap opaque',
    (select id from public.items where lower(name) = lower('DA Soap opaque') limit 1),
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
    ('Пропиленгликоль', 0.235),
    ('Стеариновая кислота', 0.148),
    ('Лауриновая кислота', 0.053),
    ('Лаурет сульфат', 0.257),
    ('Лаурет жидкий', 0.016),
    ('Вода горячая', 0.007),
    ('ЭДТА', 0.001),
    ('Вода холодная', 0.056),
    ('Каустическая сода', 0.033),
    ('Сорбитол', 0.020),
    ('Диоксид титана (белое)', 0.003),
    ('Глицерин', 0.080),
    ('Сорбитол', 0.098)
) as m(name, qty)
join public.items i on lower(i.name) = lower(m.name)
order by m.name;
