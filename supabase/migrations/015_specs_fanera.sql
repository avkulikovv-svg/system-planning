-- Auto-generated specs from CSV

do $$ begin if not exists (select 1 from pg_constraint where conname = 'specs_spec_code_key' and conrelid = 'public.specs'::regclass) then alter table public.specs add constraint specs_spec_code_key unique (spec_code); end if; end $$;


with spec_row as (
  insert into public.specs (spec_code, spec_name, linked_product_id, updated_at)
  values (
    'М0506',
    'М0506',
    (select id from public.items where lower(code) = lower('М0506') or lower(name) = lower('М0506') limit 1),
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
    ('Коробка 350х350х45', 1.0),
    ('Буклет цветной', 1.0),
    ('Инструкция А4, М0506, М0549', 1.0),
    ('Коробка 47x36x36', 0.1111111111),
    ('Наклейка WB М0506', 1.0),
    ('Фанера 15 мм', 0.14),
    ('Комплект крепежа М0506', 1.0)
) as m(name, qty)
join public.items i on lower(i.name) = lower(m.name)
order by m.name;


with spec_row as (
  insert into public.specs (spec_code, spec_name, linked_product_id, updated_at)
  values (
    'М0585',
    'М0585',
    (select id from public.items where lower(code) = lower('М0585') or lower(name) = lower('М0585') limit 1),
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
    ('Коробка 350х350х45', 1.0),
    ('Буклет цветной', 1.0),
    ('Инструкция А4, М0506, М0549', 1.0),
    ('Коробка 47x36x36', 0.1111111111),
    ('Наклейка WB М0585', 1.0),
    ('Фанера 15 мм', 0.14),
    ('Комплект крепежа М0506', 1.0)
) as m(name, qty)
join public.items i on lower(i.name) = lower(m.name)
order by m.name;


with spec_row as (
  insert into public.specs (spec_code, spec_name, linked_product_id, updated_at)
  values (
    'М0549',
    'М0549',
    (select id from public.items where lower(code) = lower('М0549') or lower(name) = lower('М0549') limit 1),
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
    ('Коробка 350х350х45', 1.0),
    ('Буклет цветной', 1.0),
    ('Инструкция А4, М0506, М0549', 1.0),
    ('Коробка 47x36x36', 0.1111111111),
    ('Наклейка WB, М0549', 1.0),
    ('Фанера 15 мм', 0.0909090909),
    ('Фанера 12 мм, сорт 2/4, шт', 0.0526315789),
    ('Ковролин, ФролТ про, серый', 0.12),
    ('Клей коннект,
красный', 0.025),
    ('Комплект крепежа М0506', 1.0)
) as m(name, qty)
join public.items i on lower(i.name) = lower(m.name)
order by m.name;


with spec_row as (
  insert into public.specs (spec_code, spec_name, linked_product_id, updated_at)
  values (
    'М0549-4L',
    'М0549-4L',
    (select id from public.items where lower(code) = lower('М0549-4L') or lower(name) = lower('М0549-4L') limit 1),
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
    ('Коробка 350х350х45', 1.0),
    ('Инструкция А4, М0549-4L', 1.0),
    ('Навесная бирка', 1.0),
    ('Хомут', 1.0),
    ('Коробка 47x36x36', 0.1111111111),
    ('Наклейка, М0549-4L', 2.0),
    ('Фанера 15 мм', 0.0909090909),
    ('Фанера 12 мм, сорт 2/4, шт', 0.0526315789),
    ('Ковролин, ФролТ про, серый', 0.12),
    ('Клей коннект,
красный', 0.025),
    ('Комплект крепежа М0506', 1.0)
) as m(name, qty)
join public.items i on lower(i.name) = lower(m.name)
order by m.name;


with spec_row as (
  insert into public.specs (spec_code, spec_name, linked_product_id, updated_at)
  values (
    'М0567',
    'М0567',
    (select id from public.items where lower(code) = lower('М0567') or lower(name) = lower('М0567') limit 1),
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
    ('Коробка 350х350х45', 1.0),
    ('Буклет цветной', 1.0),
    ('Инструкция А4, М0567', 1.0),
    ('Коробка 47x36x36', 0.1111111111),
    ('Наклейка WB, М0567', 1.0),
    ('Фанера 15 мм', 0.14),
    ('Комплект крепежа М0567', 1.0)
) as m(name, qty)
join public.items i on lower(i.name) = lower(m.name)
order by m.name;


with spec_row as (
  insert into public.specs (spec_code, spec_name, linked_product_id, updated_at)
  values (
    'М0570',
    'М0570',
    (select id from public.items where lower(code) = lower('М0570') or lower(name) = lower('М0570') limit 1),
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
    ('Буклет цветной', 1.0),
    ('Инструкция А4, М0570', 1.0),
    ('Гофрокороб 796*190*65 Т-24С', 1.0),
    ('Наклейка WB, М0570', 1.0),
    ('Фанера 15 мм', 0.1428),
    ('Фанера 12 мм, сорт 2/4, шт', 0.16),
    ('Ковролин, ФролТ про, серый', 0.345),
    ('Гайка усовая, М6', 6.0),
    ('Клей коннект,
красный', 0.025),
    ('Комплект крепежа М0570', 1.0)
) as m(name, qty)
join public.items i on lower(i.name) = lower(m.name)
order by m.name;


with spec_row as (
  insert into public.specs (spec_code, spec_name, linked_product_id, updated_at)
  values (
    'М0576',
    'М0576',
    (select id from public.items where lower(code) = lower('М0576') or lower(name) = lower('М0576') limit 1),
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
    ('Буклет цветной', 1.0),
    ('Инструкция А4, М0576', 1.0),
    ('Коробка 1100*250*90 Т-24', 1.0),
    ('Наклейка WB, М0576', 1.0),
    ('Фанера 18 мм', 0.3),
    ('Фанера 15 мм', 0.5),
    ('Гайка усовая, М6', 7.0),
    ('Комплект крепежа М0576', 1.0)
) as m(name, qty)
join public.items i on lower(i.name) = lower(m.name)
order by m.name;


with spec_row as (
  insert into public.specs (spec_code, spec_name, linked_product_id, updated_at)
  values (
    'М0581',
    'М0581',
    (select id from public.items where lower(code) = lower('М0581') or lower(name) = lower('М0581') limit 1),
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
    ('Буклет цветной', 1.0),
    ('Инструкция А4, М0581', 1.0),
    ('Коробка 796*190*60', 1.0),
    ('Наклейка WB, М0581', 2.0),
    ('Фанера 18 мм', 0.123),
    ('Фанера 15 мм', 0.25),
    ('Гайка усовая, М6', 6.0),
    ('Комплект крепежа М0581', 1.0)
) as m(name, qty)
join public.items i on lower(i.name) = lower(m.name)
order by m.name;


with spec_row as (
  insert into public.specs (spec_code, spec_name, linked_product_id, updated_at)
  values (
    'М0582',
    'М0582',
    (select id from public.items where lower(code) = lower('М0582') or lower(name) = lower('М0582') limit 1),
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
    ('Буклет цветной', 1.0),
    ('Инструкция А4, М0582', 1.0),
    ('Коробка 796*190*60', 1.0),
    ('Наклейка WB, М0582', 1.0),
    ('Фанера 18 мм', 0.123),
    ('Фанера 15 мм', 0.25),
    ('Гайка усовая, М6', 6.0),
    ('Комплект крепежа М0581', 1.0)
) as m(name, qty)
join public.items i on lower(i.name) = lower(m.name)
order by m.name;


with spec_row as (
  insert into public.specs (spec_code, spec_name, linked_product_id, updated_at)
  values (
    'Комплект крепежа М0506',
    'Комплект крепежа М0506',
    (select id from public.items where lower(code) = lower('Комплект крепежа М0506') or lower(name) = lower('Комплект крепежа М0506') limit 1),
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
    ('Винт-конфирмат 6.3*50', 8.0),
    ('Ключ шестигранный 4 мм', 1.0),
    ('Зип пакет 70х100', 1.0)
) as m(name, qty)
join public.items i on lower(i.name) = lower(m.name)
order by m.name;


with spec_row as (
  insert into public.specs (spec_code, spec_name, linked_product_id, updated_at)
  values (
    'Комплект крепежа М0549-4L',
    'Комплект крепежа М0549-4L',
    (select id from public.items where lower(code) = lower('Комплект крепежа М0549-4L') or lower(name) = lower('Комплект крепежа М0549-4L') limit 1),
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
    ('Винт-конфирмат 6.3*50', 8.0),
    ('Ключ шестигранный 4 мм', 1.0),
    ('Заглушка для конфирманта', 1.0),
    ('Зип пакет 70х100', 1.0)
) as m(name, qty)
join public.items i on lower(i.name) = lower(m.name)
order by m.name;


with spec_row as (
  insert into public.specs (spec_code, spec_name, linked_product_id, updated_at)
  values (
    'Комплект крепежа М0567',
    'Комплект крепежа М0567',
    (select id from public.items where lower(code) = lower('Комплект крепежа М0567') or lower(name) = lower('Комплект крепежа М0567') limit 1),
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
    ('Винт-конфирмат 6.3*50', 10.0),
    ('Ключ шестигранный 4 мм', 1.0),
    ('Зип пакет 70х100', 1.0)
) as m(name, qty)
join public.items i on lower(i.name) = lower(m.name)
order by m.name;


with spec_row as (
  insert into public.specs (spec_code, spec_name, linked_product_id, updated_at)
  values (
    'Комплект крепежа М0570',
    'Комплект крепежа М0570',
    (select id from public.items where lower(code) = lower('Комплект крепежа М0570') or lower(name) = lower('Комплект крепежа М0570') limit 1),
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
    ('Винт-конфирмат 6.3*50', 12.0),
    ('Ключ шестигранный 4 мм', 1.0),
    ('Зип пакет 70х100', 1.0),
    ('Винт, М6х30', 2.0)
) as m(name, qty)
join public.items i on lower(i.name) = lower(m.name)
order by m.name;


with spec_row as (
  insert into public.specs (spec_code, spec_name, linked_product_id, updated_at)
  values (
    'Комплект крепежа М0576',
    'Комплект крепежа М0576',
    (select id from public.items where lower(code) = lower('Комплект крепежа М0576') or lower(name) = lower('Комплект крепежа М0576') limit 1),
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
    ('Винт-конфирмат 6.3*50', 33.0),
    ('Ключ шестигранный 4 мм', 1.0),
    ('Зип пакет 80х120', 1.0),
    ('Винт, М6х35', 7.0)
) as m(name, qty)
join public.items i on lower(i.name) = lower(m.name)
order by m.name;


with spec_row as (
  insert into public.specs (spec_code, spec_name, linked_product_id, updated_at)
  values (
    'Комплект крепежа М0581',
    'Комплект крепежа М0581',
    (select id from public.items where lower(code) = lower('Комплект крепежа М0581') or lower(name) = lower('Комплект крепежа М0581') limit 1),
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
    ('Винт-конфирмат 6.3*50', 18.0),
    ('Ключ шестигранный 4 мм', 1.0),
    ('Зип пакет 70х100', 1.0),
    ('Винт, М6х35', 6.0)
) as m(name, qty)
join public.items i on lower(i.name) = lower(m.name)
order by m.name;
