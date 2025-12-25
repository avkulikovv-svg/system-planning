-- Import/update items from spreadsheet extract
begin;

create temporary table tmp_items_import (
  code text,
  name text,
  barcode text,
  unit_weight numeric,
  box_volume numeric,
  box_length numeric,
  box_width numeric,
  box_height numeric,
  units_per_box numeric,
  box_weight numeric,
  boxes_per_pallet numeric,
  box_orientation text,
  shelf_life_days numeric,
  shelf_life_required boolean
) on commit drop;

insert into tmp_items_import values
  ('ДА20002','Б1 (20 шт) 55*40*11 см, мыло','4640423070301',1,0.0242,55,40,11,20,20,25,'нормально',NULL,false),
  ('ДА0022ДА0022','п1 (20 шт) 55*40*11 см, мыло','4640423070288',1,0.0242,55,40,11,20,20,25,'нормально',NULL,false),
  ('ДА20022','с1 (20 шт) 55*40*11 см, мыло','4640423070271',1,0.0242,55,40,11,20,20,25,'нормально',NULL,false),
  ('ДА20004','б5 (4 шт) 55*40*11 см, мыло','4640423070318',5,0.0242,55,40,11,4,20,25,'нормально',NULL,false),
  ('ДА20005','п5 (4 шт) 55*40*11 см, мыло','4640423070295',5,0.0242,55,40,11,4,20,25,'нормально',NULL,false),
  ('ДА20006','с5 (4 шт) 55*40*11 см, мыло','4640423070325',5,0.0242,55,40,11,4,20,25,'нормально',NULL,false),
  ('ДА20007','Б10 (1 шт) 39*28*11 см, мыло','4640423070349',10,0.012012,39,28,11,1,10,50,'нормально',NULL,false),
  ('ДА20008','П10 (1 шт) 39*28*11 см, мыло','4640423070370',10,0.012012,39,28,11,1,10,50,'нормально',NULL,false),
  ('ДА20009','С10 (1 шт) 39*28*11 см, мыло','4640423070387',10,0.012012,39,28,11,1,10,50,'нормально',NULL,false),
  ('AU0506','Ступенька М0506 (по 9  штук)коробка47*36*36, 1 кор нов, по 6 кор в 1 ряд стоя, фанера','2040517782431',2.33,0.060912,47,36,36,9,20.97,18,'стоя (основание: 36×36)',NULL,false),
  ('AU0567','Табурет стремянка деревянный(47*36*36 , 1=2,6 кг=35*35*4.5, 1=9 шт), по 6 кор в 1 ряд стоя, фанера','4640423070097',2.6,0.060912,47,36,36,9,23.4,18,'стоя (основание: 36×36)',NULL,false),
  ('М0585','Подставка для ног М0585, (по 9  штук)коробка47*36*36, по 6 кор в 1 ряд стоя, фанера','4640423070233',2.33,0.060912,47,36,36,9,20.97,18,'стоя (основание: 36×36)',NULL,false),
  ('AU0549','Лестница для собак и кошек прикроватная (по 9 штук)(коробка 47*36*36, фанера','4640423070035',2.33,0.060912,47,36,36,9,20.97,18,'стоя (основание: 36×36)',NULL,false),
  ('М0570','Лестница пандус для собак складная, фанера(по1 шт) (80*19*7 см) 5 кг','4640423070158',5,0.01064,80,19,7,1,5,NULL,'нормально',NULL,false),
  ('М0566','Полочка для кухни, инд 25х25х40 мм, транс 56*32*30, 14 шт., , фанера','4640423070110',1,0.025,25,25,40,14,14,35,'нормально',NULL,false),
  ('М0550','Домик-лесенка для котов и собак(по 7 штук, транс 47*36*40, верх кривой), , фанера','4640423070042',2.9,0.06768,47,36,40,7,20.3,18,'стоя (основание: 36×40)',NULL,false),
  ('AU0101','Домик для кошки номер 1(по 23 штук) (60*50*40см - коробка!) С?, картон','2039502277205',0.42,0.12,60,50,40,23,9.66,12,'стоя (основание: 60×40)',NULL,false),
  ('AU0102','Домик для кошки номер 2(по 23 штуки)  (конурой)(60*50*40см - коробка!) С?, картон','2039502336001',0.42,0.12,60,50,40,23,9.66,12,'стоя (основание: 60×40)',NULL,false),
  ('М0554','Домик для котов и собак с когтеточкой (транс 48*48*45(34) по 9 штук), коробка 46*46*5, , фанера','4640423070073',2.5,0.10368,48,48,45,9,22.5,6,'нормально',NULL,false),
  ('М0552','Домик для котов с когтеточкой (48*48*45, по     9 штук), , фанера','4640423070066',2.5,0.10368,48,48,45,9,22.5,6,'нормально',NULL,false),
  ('М0576','Скамейка садовая деревянная со спинкой (110*25*9см), 1 шт, , фанера','4640423070127',14,0.02475,110,25,9,1,14,35,'нормально',NULL,false),
  ('М0582','Кресло диагональ, , фанера (упак 69*47*7,5)(по 1 шт.)','4640423070165',10,0.0243225,69,47,7.5,1,10,NULL,'нормально',NULL,false),
  ('М0581','Кресло волны, , фанера (67*47*7)(по 1 шт.)','4640423070172',10,0.022043,67,47,7,1,10,NULL,'нормально',NULL,false),
  ('М0579','Кресло, , фанера','',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'',NULL,false),
  ('М0580','Стол, , фанера','',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'',NULL,false),
  ('AU0510','Когтеточка М0510 (по 45 штук, коробка 56*32*30 см)это плоская С+, , фанера','2040245205233',0.5,0.05376,56,32,30,45,22.5,20,'нормально',NULL,false),
  ('AU0511','Когтеточка М0511 (по  8 штук, коробка 60*40*40 см)','2040604026493',0.8,0.096,60,40,40,8,6.4,16,'нормально',NULL,false),
  ('GL0011','Мыло для бритья Ambizioso GL0011 (по 46  штук) 55*40*11 /мерседес, косметика','2039399279603',0.21,0.0242,55,40,11,46,9.66,51,'нормально',NULL,false),
  ('GL0012','Мыло для бритья Fresco GL0012 (по 46  штук) к. 55*40*11/мандарин, косметика','2039399279610',0.21,0.0242,55,40,11,46,9.66,51,'нормально',NULL,false),
  ('GL0013','Мыло для бритья Coraggio GL0013 (по 46 штук)к.55*40*11/аква-джио, косметика','2039399279627',0.21,0.0242,55,40,11,46,9.66,51,'нормально',NULL,false),
  ('AU0011','Специи и приправы (по 25 штук) (60*40*40см - коробка!)С?, фанера','2039449711053',0.35,0.096,60,40,40,25,8.75,16,'нормально',NULL,false),
  ('AU0533','Специи и приправы (по 25 штук) (60*40*40см - коробка!) натуральный, фанера','2041097878125',0.35,0.096,60,40,40,25,8.75,16,'нормально',NULL,false),
  ('WK0485','Соусники М0485 (по 35 штук) д0,75 короб 55*40*11, дерево','2039475014555',0.1,0.0242,55,40,11,35,3.5,60,'нормально',NULL,false),
  ('WK0486','Соусники М0486 (по 35 штук) д0,8  короб 55х40х11, дерево','2039603653731',0.1,0.0242,55,40,11,35,3.5,60,'нормально',NULL,false),
  ('WK0001','Арно 15х21, М0188, короб 56х32х30, дерево','',0.28,0.05376,56,32,30,NULL,NULL,NULL,'',NULL,false),
  ('WK0074WK0074','"Арно", 18х25 (по 25 штук) М0075(к56*32*30), дерево','',0.35,0.05376,56,32,30,25,8.75,20,'нормально',NULL,false),
  ('WK0125','М0125 дуб (по 25 шт)(к.60*40*40), дерево','',0.6,0.096,60,40,40,25,15,16,'нормально',NULL,false),
  ('WK0079','Салфетница деревянная 12х13(по 30 шт) М0152 ассимет, дуб, короб 56х32х30, дерево','2037546684164',0.4,0.05376,56,32,30,30,12,20,'нормально',NULL,false),
  ('WK0493','М0493 салфетница бук(по 30 штук)                     к. 56х32х30','2039858298442',0.4,0.05376,56,32,30,30,12,20,'нормально',NULL,false),
  ('WK0514','М0514 (это как МО125 из  фанеры) (по 25 шт) (к 60*40*40)С?, , фанера','2040522081000',0.6,0.096,60,40,40,25,15,16,'нормально',NULL,false),
  ('DA50001','Глицерин, 1 л.  (по 12 штук) к. 38*30*27 см, мыло','4640423070226',1.1,0.03078,38,30,27,12,13.2,45,'нормально',NULL,true);

create temporary table tmp_items_final as
with normalized as (
  select
    nullif(trim(code), '') as code,
    nullif(trim(name), '') as name,
    nullif(trim(barcode), '') as barcode,
    unit_weight,
    box_volume,
    box_length,
    box_width,
    box_height,
    units_per_box,
    box_weight,
    boxes_per_pallet,
    nullif(trim(box_orientation), '') as box_orientation,
    shelf_life_days,
    coalesce(shelf_life_required, false) as shelf_life_required,
    coalesce(box_volume,
      case when box_length is not null and box_width is not null and box_height is not null
        then (box_length * box_width * box_height) / 1000000.0
        else null end
    ) as calc_volume
  from tmp_items_import
  where code is not null and barcode is not null
),
matched as (
  select
    n.*,
    (select id from public.items where lower(code) = lower(n.code) limit 1) as match_code_id,
    (select id from public.items where barcode = n.barcode limit 1) as match_item_barcode_id,
    (select item_id from public.item_barcodes where barcode = n.barcode limit 1) as match_extra_barcode_id
  from normalized n
),
resolved as (
  select
    m.*,
    coalesce(match_code_id, match_item_barcode_id, match_extra_barcode_id) as existing_item_id
  from matched m
),
to_insert as (
  select * from resolved where existing_item_id is null
),
inserted as (
  insert into public.items (
    code, name, barcode, kind, status, uom,
    box_length, box_width, box_height, box_volume,
    units_per_box, box_weight, boxes_per_pallet, box_orientation,
    shelf_life_days, shelf_life_required, unit_weight,
    created_at, updated_at
  )
  select
    r.code,
    coalesce(r.name, r.code),
    r.barcode,
    'product',
    'active',
    'шт',
    r.box_length,
    r.box_width,
    r.box_height,
    r.calc_volume,
    r.units_per_box,
    r.box_weight,
    r.boxes_per_pallet,
    r.box_orientation,
    r.shelf_life_days,
    r.shelf_life_required,
    r.unit_weight,
    now(),
    now()
  from to_insert r
  returning id, lower(code) as code_key, barcode
)
select
  r.*,
  coalesce(r.existing_item_id,
    (select ins.id from inserted ins where ins.code_key = lower(r.code))
  ) as item_id
from resolved r;

-- Updates
update public.items i
set name = f.name
from tmp_items_final f
where i.id = f.item_id
  and f.name is not null
  and (i.name is null or i.name = '');

update public.items i
set barcode = f.barcode
from tmp_items_final f
where i.id = f.item_id
  and f.barcode is not null
  and i.barcode is null;

update public.items i
set box_length = f.box_length
from tmp_items_final f
where i.id = f.item_id
  and f.box_length is not null
  and i.box_length is null;

update public.items i
set box_width = f.box_width
from tmp_items_final f
where i.id = f.item_id
  and f.box_width is not null
  and i.box_width is null;

update public.items i
set box_height = f.box_height
from tmp_items_final f
where i.id = f.item_id
  and f.box_height is not null
  and i.box_height is null;

update public.items i
set box_volume = f.calc_volume
from tmp_items_final f
where i.id = f.item_id
  and f.calc_volume is not null
  and i.box_volume is null;

update public.items i
set units_per_box = f.units_per_box
from tmp_items_final f
where i.id = f.item_id
  and f.units_per_box is not null
  and i.units_per_box is null;

update public.items i
set box_weight = f.box_weight
from tmp_items_final f
where i.id = f.item_id
  and f.box_weight is not null
  and i.box_weight is null;

update public.items i
set boxes_per_pallet = f.boxes_per_pallet
from tmp_items_final f
where i.id = f.item_id
  and f.boxes_per_pallet is not null
  and i.boxes_per_pallet is null;

update public.items i
set box_orientation = f.box_orientation
from tmp_items_final f
where i.id = f.item_id
  and f.box_orientation is not null
  and (i.box_orientation is null or i.box_orientation = '');

update public.items i
set shelf_life_days = f.shelf_life_days
from tmp_items_final f
where i.id = f.item_id
  and f.shelf_life_days is not null
  and i.shelf_life_days is null;

update public.items i
set shelf_life_required = f.shelf_life_required
from tmp_items_final f
where i.id = f.item_id
  and i.shelf_life_required is null;

update public.items i
set unit_weight = f.unit_weight
from tmp_items_final f
where i.id = f.item_id
  and f.unit_weight is not null
  and i.unit_weight is null;

-- Barcodes table
insert into public.item_barcodes (item_id, barcode, channel, is_primary, created_at, updated_at)
select distinct
  f.item_id,
  f.barcode,
  null,
  case when i.barcode = f.barcode then true else false end as is_primary,
  now(),
  now()
from tmp_items_final f
join public.items i on i.id = f.item_id
where f.barcode is not null
on conflict do nothing;

commit;
