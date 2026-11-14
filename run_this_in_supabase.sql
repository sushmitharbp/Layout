-- ============================================================================
-- SheetLayout AI — ALL-IN-ONE SUPABASE MIGRATION SCRIPT
-- Paste and run this entire script once in your Supabase SQL Editor.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- STEP 1: CREATE USER & DEPARTMENT CREDENTIALS TABLE (public.app_users)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_users (
    id BIGSERIAL PRIMARY KEY,
    company_id TEXT NOT NULL,                         -- 'PEPIPL', 'PEI2'
    branch_code TEXT NOT NULL,                        -- 'PEPIPL', 'PEI2'
    department TEXT NOT NULL,                         -- 'shearing', 'krysalis', 'purchase', 'erp'
    username TEXT NOT NULL,                           -- Login username
    password_hash TEXT NOT NULL,                      -- Password
    display_name TEXT DEFAULT '',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_company_department UNIQUE (company_id, department)
);

-- Full read/write application policy on app_users
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on app_users" ON public.app_users;
CREATE POLICY "Allow all on app_users" ON public.app_users FOR ALL USING (true) WITH CHECK (true);

-- Seed initial department logins
INSERT INTO public.app_users (company_id, branch_code, department, username, password_hash, display_name)
VALUES
    -- Unit 1 (PEPIPL)
    ('PEPIPL', 'PEPIPL', 'shearing', 'shearing', 'shearing123', 'Shearing Production Floor'),
    ('PEPIPL', 'PEPIPL', 'krysalis', 'krysalis', 'krysalis123', 'Consultants (Krysalis) Design'),
    ('PEPIPL', 'PEPIPL', 'purchase', 'purchase', 'purchase123', 'Purchase Team'),
    ('PEPIPL', 'PEPIPL', 'erp',      'erp',      'erp123',      'ERP Master Gateway'),

    -- Unit 2 (PEI2)
    ('PEI2',   'PEI2',   'shearing', 'shearing', 'shearing123', 'Shearing Production Floor (Unit 2)'),
    ('PEI2',   'PEI2',   'krysalis', 'krysalis', 'krysalis123', 'Consultants (Krysalis) Design (Unit 2)'),
    ('PEI2',   'PEI2',   'purchase', 'purchase', 'purchase123', 'Purchase Team (Unit 2)'),
    ('PEI2',   'PEI2',   'erp',      'erp',      'erp123',      'ERP Master Gateway (Unit 2)')
ON CONFLICT (company_id, department)
DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    display_name = EXCLUDED.display_name,
    updated_at = now();


-- ----------------------------------------------------------------------------
-- STEP 2: ADD company_id TO ALL TABLES & ATTRIBUTE EXISTING DATA TO PEI2
-- ----------------------------------------------------------------------------

-- 1. RAW MATERIAL MASTER (public.rm)
ALTER TABLE IF EXISTS public.rm 
    ADD COLUMN IF NOT EXISTS company_id TEXT NOT NULL DEFAULT 'PEI2';
UPDATE public.rm 
    SET company_id = 'PEI2' 
    WHERE company_id IS NULL OR company_id = '';
CREATE INDEX IF NOT EXISTS idx_rm_company_id ON public.rm(company_id);

-- 2. PARTS MASTER (public.parts)
ALTER TABLE IF EXISTS public.parts 
    ADD COLUMN IF NOT EXISTS company_id TEXT NOT NULL DEFAULT 'PEI2';
UPDATE public.parts 
    SET company_id = 'PEI2' 
    WHERE company_id IS NULL OR company_id = '';
CREATE INDEX IF NOT EXISTS idx_parts_company_id ON public.parts(company_id);

-- 3. MRP DEMAND (public.mrp)
ALTER TABLE IF EXISTS public.mrp 
    ADD COLUMN IF NOT EXISTS company_id TEXT NOT NULL DEFAULT 'PEI2';
UPDATE public.mrp 
    SET company_id = 'PEI2' 
    WHERE company_id IS NULL OR company_id = '';
CREATE INDEX IF NOT EXISTS idx_mrp_company_id ON public.mrp(company_id);

-- 4. MOS (public.mos)
ALTER TABLE IF EXISTS public.mos 
    ADD COLUMN IF NOT EXISTS company_id TEXT NOT NULL DEFAULT 'PEI2';
UPDATE public.mos 
    SET company_id = 'PEI2' 
    WHERE company_id IS NULL OR company_id = '';
CREATE INDEX IF NOT EXISTS idx_mos_company_id ON public.mos(company_id);

-- 5. APP_MO (APPLICATION MO WORKFLOW)
ALTER TABLE IF EXISTS public.app_mo 
    ADD COLUMN IF NOT EXISTS company_id TEXT NOT NULL DEFAULT 'PEI2';
ALTER TABLE IF EXISTS public.app_mo 
    ADD COLUMN IF NOT EXISTS branch_code TEXT NOT NULL DEFAULT 'PEI2';
UPDATE public.app_mo 
    SET company_id = 'PEI2', branch_code = 'PEI2' 
    WHERE company_id IS NULL OR company_id = '';
CREATE INDEX IF NOT EXISTS idx_app_mo_company_id ON public.app_mo(company_id);

-- 6. ENDBITS (BATCH-WISE OFFCUT INVENTORY)
ALTER TABLE IF EXISTS public.endbits 
    ADD COLUMN IF NOT EXISTS company_id TEXT NOT NULL DEFAULT 'PEI2';
UPDATE public.endbits 
    SET company_id = 'PEI2' 
    WHERE company_id IS NULL OR company_id = '';
CREATE INDEX IF NOT EXISTS idx_endbits_company_id ON public.endbits(company_id);

-- 7. ENDBIT_MO (CUTTING FROM ENDBITS)
ALTER TABLE IF EXISTS public.endbit_mo 
    ADD COLUMN IF NOT EXISTS company_id TEXT NOT NULL DEFAULT 'PEI2';
UPDATE public.endbit_mo 
    SET company_id = 'PEI2' 
    WHERE company_id IS NULL OR company_id = '';
CREATE INDEX IF NOT EXISTS idx_endbit_mo_company_id ON public.endbit_mo(company_id);

-- 8. LAYOUT_RECORDS (LEGACY NESTING RUNS)
ALTER TABLE IF EXISTS public.layout_records 
    ADD COLUMN IF NOT EXISTS company_id TEXT NOT NULL DEFAULT 'PEI2';
UPDATE public.layout_records 
    SET company_id = 'PEI2' 
    WHERE company_id IS NULL OR company_id = '';
CREATE INDEX IF NOT EXISTS idx_layout_records_company_id ON public.layout_records(company_id);

