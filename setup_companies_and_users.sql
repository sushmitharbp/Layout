-- ============================================================================
-- SheetLayout AI — Master Multi-Tenant Setup (Companies & Department Credentials)
-- Database: Supabase PostgreSQL (public schema)
-- Sequence:
--   STEP 1: Create 'companies' table & seed Unit 1 (PEPIPL) and Unit 2 (PEI2)
--   STEP 2: Create 'app_users' table with Foreign Key referencing 'companies'
--   STEP 3: Seed 4 Department User Credentials for Unit 1 and 4 for Unit 2
-- ============================================================================

-- ============================================================================
-- STEP 1: CREATE & SEED THE MASTER 'companies' TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.companies (
    company_id TEXT PRIMARY KEY,                       -- e.g. 'PEPIPL', 'PEI2'
    company_name TEXT NOT NULL,                        -- Legal Company Name
    short_name TEXT NOT NULL,                          -- e.g. 'Praveen Unit 1'
    unit_name TEXT NOT NULL,                           -- e.g. 'Unit 1 (Main Stores)'
    branch_code TEXT NOT NULL,                         -- Branch code for ERP
    erp_system TEXT DEFAULT 'ORDS',                    -- 'ORDS', 'SAP', etc.
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable Row Level Security (RLS) on companies
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on companies" ON public.companies;
CREATE POLICY "Allow all on companies" ON public.companies FOR ALL USING (true) WITH CHECK (true);

-- Seed Master Companies (Unit 1 and Unit 2)
INSERT INTO public.companies (company_id, company_name, short_name, unit_name, branch_code, erp_system, is_active)
VALUES
    ('PEPIPL', 'Praveen Engineering Products India Pvt. Ltd. (Unit 1)', 'Praveen Unit 1', 'Unit 1 (Main Stores & Shearing Floor)', 'PEPIPL', 'ORDS', TRUE),
    ('PEI2',   'Praveen Engineering Products India Pvt. Ltd. - Unit 2', 'Praveen Unit 2', 'Unit 2 (Stores & Secondary Shearing)',  'PEI2',   'ORDS', TRUE)
ON CONFLICT (company_id) 
DO UPDATE SET
    company_name = EXCLUDED.company_name,
    short_name   = EXCLUDED.short_name,
    unit_name    = EXCLUDED.unit_name,
    branch_code  = EXCLUDED.branch_code,
    is_active    = EXCLUDED.is_active,
    updated_at   = now();


-- ============================================================================
-- STEP 2: CREATE 'app_users' TABLE (REFERENCES 'companies')
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.app_users (
    id BIGSERIAL PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES public.companies(company_id) ON UPDATE CASCADE ON DELETE RESTRICT,
    branch_code TEXT NOT NULL,                        -- 'PEPIPL', 'PEI2'
    department TEXT NOT NULL,                         -- 'shearing', 'krysalis', 'purchase', 'erp'
    username TEXT NOT NULL,                           -- Login username
    password_hash TEXT NOT NULL,                      -- Password
    display_name TEXT DEFAULT '',                     -- Friendly display name
    is_active BOOLEAN DEFAULT TRUE,                   -- Account active flag
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_company_department UNIQUE (company_id, department)
);

-- Fast lookup indexes
CREATE INDEX IF NOT EXISTS idx_app_users_lookup ON public.app_users(company_id, department);
CREATE INDEX IF NOT EXISTS idx_app_users_company ON public.app_users(company_id);

-- Enable Row Level Security (RLS) on app_users
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on app_users" ON public.app_users;
CREATE POLICY "Allow all on app_users" ON public.app_users FOR ALL USING (true) WITH CHECK (true);


-- ============================================================================
-- STEP 3: SEED 4 DEPARTMENT CREDENTIALS FOR BOTH UNIT 1 & UNIT 2
-- ============================================================================
INSERT INTO public.app_users (company_id, branch_code, department, username, password_hash, display_name, is_active)
VALUES
    -- 🏭 Praveen Unit 1 (PEPIPL) - 4 Departments
    ('PEPIPL', 'PEPIPL', 'shearing', 'shearing_u1', 'shearing123', 'Shearing Production Floor (Unit 1)', TRUE),
    ('PEPIPL', 'PEPIPL', 'krysalis', 'krysalis_u1', 'krysalis123', 'Consultants (Krysalis) Design (Unit 1)', TRUE),
    ('PEPIPL', 'PEPIPL', 'purchase', 'purchase_u1', 'purchase123', 'Purchase Team (Unit 1)', TRUE),
    ('PEPIPL', 'PEPIPL', 'erp',      'erp_u1',      'erp123',      'ERP Master Gateway (Unit 1)', TRUE),

    -- 🏭 Praveen Unit 2 (PEI2) - 4 Departments
    ('PEI2',   'PEI2',   'shearing', 'shearing_u2', 'shearing123', 'Shearing Production Floor (Unit 2)', TRUE),
    ('PEI2',   'PEI2',   'krysalis', 'krysalis_u2', 'krysalis123', 'Consultants (Krysalis) Design (Unit 2)', TRUE),
    ('PEI2',   'PEI2',   'purchase', 'purchase_u2', 'purchase123', 'Purchase Team (Unit 2)', TRUE),
    ('PEI2',   'PEI2',   'erp',      'erp_u2',      'erp123',      'ERP Master Gateway (Unit 2)', TRUE)
ON CONFLICT (company_id, department) 
DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    display_name  = EXCLUDED.display_name,
    is_active     = EXCLUDED.is_active,
    updated_at    = now();

