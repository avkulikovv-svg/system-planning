-- Наполняем планы тестовыми строками

insert into public.plans_fg (product_id, date_iso, qty)
values
  ('e25523a2-6d81-43ac-a2dd-0f291684c8f3', '2025-12-15', 10),
  ('e25523a2-6d81-43ac-a2dd-0f291684c8f3', '2025-12-16', 12),
  ('7baa74fc-a96a-446a-870b-82196e2681fe', '2025-12-15', 8),
  ('7baa74fc-a96a-446a-870b-82196e2681fe', '2025-12-16', 9)
on conflict (product_id, date_iso) do nothing;

insert into public.plans_semi (semi_id, date_iso, qty)
values
  ('ca4ea8c8-5afc-4d11-bfeb-77f84ed04859', '2025-12-15', 6),
  ('ca4ea8c8-5afc-4d11-bfeb-77f84ed04859', '2025-12-16', 7),
  ('18e1c62f-6822-42b0-9916-0710addc894c', '2025-12-15', 5),
  ('18e1c62f-6822-42b0-9916-0710addc894c', '2025-12-16', 4)
on conflict (semi_id, date_iso) do nothing;
