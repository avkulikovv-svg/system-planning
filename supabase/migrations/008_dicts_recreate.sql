-- Ensure dictionary tables have expected structure (id/name columns etc.)

-- Helper function for recreating table
-- UOMs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'uoms' AND column_name = 'id'
  ) THEN
    -- drop old table (structure was incompatible)
    DROP TABLE IF EXISTS public.uoms CASCADE;
    CREATE TABLE public.uoms (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.uoms (name)
      VALUES ('шт'), ('кг'), ('л'), ('м')
    ON CONFLICT (name) DO NOTHING;
  END IF;
END $$;

-- Categories
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'categories' AND column_name = 'id'
  ) THEN
    DROP TABLE IF EXISTS public.categories CASCADE;
    CREATE TABLE public.categories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      kind text NOT NULL DEFAULT 'both' CHECK (kind IN ('fg','mat','both')),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.categories (name, kind)
      VALUES ('Хим. продукция', 'fg'), ('Материалы', 'mat')
    ON CONFLICT (name) DO NOTHING;
  END IF;
END $$;

-- Vendors
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'vendors' AND column_name = 'id'
  ) THEN
    DROP TABLE IF EXISTS public.vendors CASCADE;
    CREATE TABLE public.vendors (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.vendors (name) VALUES ('Поставщик A')
    ON CONFLICT (name) DO NOTHING;
  END IF;
END $$;
