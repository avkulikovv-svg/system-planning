-- Рефакторим specs: делаем спецификации самостоятельными объектами

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'specs' and column_name = 'product_id'
  ) then
    execute 'alter table public.specs rename column product_id to linked_product_id';
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'specs' and column_name = 'linked_product_id'
  ) then
    execute 'alter table public.specs alter column linked_product_id drop not null';
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'specs' and column_name = 'product_name'
  ) then
    execute 'alter table public.specs rename column product_name to spec_name';
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'specs' and column_name = 'product_code'
  ) then
    execute 'alter table public.specs rename column product_code to spec_code';
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'specs' and column_name = 'spec_name'
  ) then
    execute 'alter table public.specs alter column spec_name set not null';
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'specs' and column_name = 'spec_code'
  ) then
    execute 'alter table public.specs alter column spec_code set not null';
  end if;
end
$$;
