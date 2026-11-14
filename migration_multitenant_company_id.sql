-- ============================================================================
-- SheetLayout AI — Multi-Tenant Migration: Add company_id to All Tables
-- Target Database: Supabase PostgreSQL (public schema)
-- Note: All existing records are attributed to Unit 2 ('PEI2')
-- ============================================================================

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
CREATE INDEX IF NOT EXISTS idx_parts_company_part_no ON public.parts(company_id, part_no);


-- 3. MRP DEMAND (public.mrp)
ALTER TABLE IF EXISTS public.mrp 
    ADD COLUMN IF NOT EXISTS company_id TEXT NOT NULL DEFAULT 'PEI2';

UPDATE public.mrp 
    SET company_id = 'PEI2' 
    WHERE company_id IS NULL OR company_id = '';

CREATE INDEX IF NOT EXISTS idx_mrp_company_id ON public.mrp(company_id);
CREATE INDEX IF NOT EXISTS idx_mrp_company_part ON public.mrp(company_id, part_no, month_year);


-- 4. MOS (public.mos)
ALTER TABLE IF EXISTS public.mos 
    ADD COLUMN IF NOT EXISTS company_id TEXT NOT NULL DEFAULT 'PEI2';

UPDATE public.mos 
    SET company_id = 'PEI2' 
    WHERE company_id IS NULL OR company_id = '';

CREATE INDEX IF NOT EXISTS idx_mos_company_id ON public.mos(company_id);
CREATE INDEX IF NOT EXISTS idx_mos_company_part ON public.mos(company_id, part_no);


-- 5. APP_MO (APPLICATION MO APPROVAL WORKFLOW)
ALTER TABLE IF EXISTS public.app_mo 
    ADD COLUMN IF NOT EXISTS company_id TEXT NOT NULL DEFAULT 'PEI2';

ALTER TABLE IF EXISTS public.app_mo 
    ADD COLUMN IF NOT EXISTS branch_code TEXT NOT NULL DEFAULT 'PEI2';

UPDATE public.app_mo 
    SET company_id = 'PEI2', branch_code = 'PEI2' 
    WHERE company_id IS NULL OR company_id = '';

CREATE INDEX IF NOT EXISTS idx_app_mo_company_id ON public.app_mo(company_id);
CREATE INDEX IF NOT EXISTS idx_app_mo_company_status ON public.app_mo(company_id, status);
CREATE INDEX IF NOT EXISTS idx_app_mo_company_stage ON public.app_mo(company_id, current_stage);


-- 6. ENDBITS (BATCH-WISE OFFCUT INVENTORY)
ALTER TABLE IF EXISTS public.endbits 
    ADD COLUMN IF NOT EXISTS company_id TEXT NOT NULL DEFAULT 'PEI2';

UPDATE public.endbits 
    SET company_id = 'PEI2' 
    WHERE company_id IS NULL OR company_id = '';

CREATE INDEX IF NOT EXISTS idx_endbits_company_id ON public.endbits(company_id);
CREATE INDEX IF NOT EXISTS idx_endbits_company_qty ON public.endbits(company_id, quantity);


-- 7. ENDBIT_MO (CUTTING FROM ENDBITS)
ALTER TABLE IF EXISTS public.endbit_mo 
    ADD COLUMN IF NOT EXISTS company_id TEXT NOT NULL DEFAULT 'PEI2';

UPDATE public.endbit_mo 
    SET company_id = 'PEI2' 
    WHERE company_id IS NULL OR company_id = '';

CREATE INDEX IF NOT EXISTS idx_endbit_mo_company_id ON public.endbit_mo(company_id);


-- 8. LAYOUT_RECORDS (NESTING RUNS / LEGACY CACHE)
ALTER TABLE IF EXISTS public.layout_records 
    ADD COLUMN IF NOT EXISTS company_id TEXT NOT NULL DEFAULT 'PEI2';

UPDATE public.layout_records 
    SET company_id = 'PEI2' 
    WHERE company_id IS NULL OR company_id = '';

CREATE INDEX IF NOT EXISTS idx_layout_records_company_id ON public.layout_records(company_id);


-- 9. USER ACCOUNTS (public.app_users)
-- Ensures app_users has company_id
ALTER TABLE IF EXISTS public.app_users 
    ADD COLUMN IF NOT EXISTS company_id TEXT NOT NULL DEFAULT 'PEI2';


-- 10. REFRESH ROW LEVEL SECURITY (RLS) POLICIES
-- Enables seamless access for authenticated anon requests scoped by company
ALTER TABLE public.rm ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on rm" ON public.rm;
CREATE POLICY "Allow all on rm" ON public.rm FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.parts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on parts" ON public.parts;
CREATE POLICY "Allow all on parts" ON public.parts FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.mrp ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on mrp" ON public.mrp;
CREATE POLICY "Allow all on mrp" ON public.mrp FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.mos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on mos" ON public.mos;
CREATE POLICY "Allow all on mos" ON public.mos FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.app_mo ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on app_mo" ON public.app_mo;
CREATE POLICY "Allow all on app_mo" ON public.app_mo FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.endbits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on endbits" ON public.endbits;
CREATE POLICY "Allow all on endbits" ON public.endbits FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE public.endbit_mo ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on endbit_mo" ON public.endbit_mo;
CREATE POLICY "Allow all on endbit_mo" ON public.endbit_mo FOR ALL USING (true) WITH CHECK (true);

-- Verification Query: Check counts per company
-- SELECT 'parts' AS tbl, company_id, count(*) FROM public.parts GROUP BY company_id
-- UNION ALL
-- SELECT 'rm' AS tbl, company_id, count(*) FROM public.rm GROUP BY company_id
-- UNION ALL
-- SELECT 'mrp' AS tbl, company_id, count(*) FROM public.mrp GROUP BY company_id
-- UNION ALL
-- SELECT 'app_mo' AS tbl, company_id, count(*) FROM public.app_mo GROUP BY company_id;

