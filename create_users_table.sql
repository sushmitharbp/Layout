-- ============================================================================
-- SheetLayout AI — Multi-Tenant User & Department Credentials Table
-- Database: Supabase PostgreSQL (Public Schema)
-- Table: public.app_users
-- ============================================================================

-- 1. Create the app_users table
CREATE TABLE IF NOT EXISTS public.app_users (
    id BIGSERIAL PRIMARY KEY,
    company_id TEXT NOT NULL,                         -- Enterprise Client Code: 'PEPIPL', 'PEI2'
    branch_code TEXT NOT NULL,                        -- Operational Branch: 'PEPIPL', 'PEI2'
    department TEXT NOT NULL,                         -- Role/Department: 'shearing', 'krysalis', 'purchase', 'erp'
    username TEXT NOT NULL,                           -- Login identifier / username
    password_hash TEXT NOT NULL,                      -- Password string or hash
    display_name TEXT DEFAULT '',                     -- User or department display name
    is_active BOOLEAN DEFAULT TRUE,                   -- Account active flag
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_company_department UNIQUE (company_id, department)
);

-- 2. Indexes for fast authentication queries
CREATE INDEX IF NOT EXISTS idx_app_users_lookup ON public.app_users(company_id, department);
CREATE INDEX IF NOT EXISTS idx_app_users_company ON public.app_users(company_id);

-- 3. Row Level Security (RLS) Policy — Full read & write for application
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all on app_users" ON public.app_users;
CREATE POLICY "Allow all on app_users" ON public.app_users FOR ALL USING (true) WITH CHECK (true);

-- 4. Seed initial department accounts for Praveen Unit 1 (PEPIPL) and Unit 2 (PEI2)
INSERT INTO public.app_users (company_id, branch_code, department, username, password_hash, display_name)
VALUES
    -- Unit 1 (PEPIPL) Departments
    ('PEPIPL', 'PEPIPL', 'shearing', 'shearing', 'shearing123', 'Shearing Production Floor'),
    ('PEPIPL', 'PEPIPL', 'krysalis', 'krysalis', 'krysalis123', 'Consultants (Krysalis) Design'),
    ('PEPIPL', 'PEPIPL', 'purchase', 'purchase', 'purchase123', 'Purchase Team'),
    ('PEPIPL', 'PEPIPL', 'erp',      'erp',      'erp123',      'ERP Master Gateway'),

    -- Unit 2 (PEI2) Departments
    ('PEI2',   'PEI2',   'shearing', 'shearing', 'shearing123', 'Shearing Production Floor (Unit 2)'),
    ('PEI2',   'PEI2',   'krysalis', 'krysalis', 'krysalis123', 'Consultants (Krysalis) Design (Unit 2)'),
    ('PEI2',   'PEI2',   'purchase', 'purchase', 'purchase123', 'Purchase Team (Unit 2)'),
    ('PEI2',   'PEI2',   'erp',      'erp',      'erp123',      'ERP Master Gateway (Unit 2)')
ON CONFLICT (company_id, department)
DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    display_name = EXCLUDED.display_name,
    updated_at = now();

-- ============================================================================
-- HOW TO SET OR CHANGE PASSWORDS DIRECTLY IN SQL:
-- ============================================================================
-- Example 1: Set Shearing password for Unit 1:
-- UPDATE public.app_users SET password_hash = 'YourNewPasswordHere', updated_at = now() 
-- WHERE company_id = 'PEPIPL' AND department = 'shearing';
--
-- Example 2: Set Shearing password for Unit 2:
-- UPDATE public.app_users SET password_hash = 'YourNewPasswordHere', updated_at = now() 
-- WHERE company_id = 'PEI2' AND department = 'shearing';
--
-- Example 3: View all registered users:
-- SELECT id, company_id, branch_code, department, username, display_name, updated_at FROM public.app_users;
-- ============================================================================

