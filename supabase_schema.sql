-- =====================================================================
-- SheetLayout AI — Supabase Database Schema
-- Migration script to store Layout Standardization & RM ERP sheet data
-- =====================================================================

-- 1. Create layout_records table
CREATE TABLE IF NOT EXISTS public.layout_records (
    id BIGSERIAL PRIMARY KEY,
    row_id INTEGER UNIQUE NOT NULL,
    base_part TEXT NOT NULL,
    part_no TEXT NOT NULL,
    status TEXT DEFAULT '',
    layout_name TEXT DEFAULT '',
    rm_erp TEXT DEFAULT '',
    cut_blank TEXT DEFAULT '',
    grade TEXT DEFAULT '',
    no_of_sheets NUMERIC,
    cutting_plan TEXT DEFAULT '',
    thickness NUMERIC,
    length NUMERIC,
    width NUMERIC,
    rm_weight NUMERIC,
    part1 JSONB,
    part2 JSONB,
    part3 JSONB,
    part4 JSONB,
    per_sheet JSONB,
    total_sheet JSONB,
    endbits JSONB,
    po_price NUMERIC,
    wastage_cost NUMERIC,
    image_url TEXT,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Performance Indexes for fast query and lookup
CREATE INDEX IF NOT EXISTS idx_layout_records_part_no ON public.layout_records(part_no);
CREATE INDEX IF NOT EXISTS idx_layout_records_base_part ON public.layout_records(base_part);
CREATE INDEX IF NOT EXISTS idx_layout_records_rm_erp ON public.layout_records(rm_erp);
CREATE INDEX IF NOT EXISTS idx_layout_records_grade ON public.layout_records(grade);
CREATE INDEX IF NOT EXISTS idx_layout_records_status ON public.layout_records(status);

-- 3. Enable Row Level Security (RLS)
ALTER TABLE public.layout_records ENABLE ROW LEVEL SECURITY;

-- 4. Policies
-- Allow anyone to read layout records (public read)
CREATE POLICY "Allow public read on layout_records"
    ON public.layout_records
    FOR SELECT
    USING (true);

-- Allow authenticated / service_role full insert/update/delete access
CREATE POLICY "Allow service role write access on layout_records"
    ON public.layout_records
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- Optional: Comments for documentation
COMMENT ON TABLE public.layout_records IS 'Master standardized sheet metal layout records, blank sizes, and RM ERP data';

-- =====================================================================
-- 5. Manufacturing Orders (MO) Approval Workflow Table
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.manufacturing_orders (
    id BIGSERIAL PRIMARY KEY,
    mo_number TEXT UNIQUE NOT NULL,
    part_no TEXT NOT NULL,
    base_part TEXT DEFAULT '',
    rm_erp TEXT DEFAULT '',
    grade TEXT DEFAULT '',
    is_standard_layout BOOLEAN DEFAULT true,
    layout_name TEXT DEFAULT '',
    thickness NUMERIC,
    length NUMERIC,
    width NUMERIC,
    target_qty INTEGER DEFAULT 1,
    sheets_required NUMERIC DEFAULT 1,
    layout_doc_url TEXT DEFAULT '',
    layout_doc_filename TEXT DEFAULT '',
    constraints_status JSONB DEFAULT '{}'::jsonb,
    workflow_path TEXT NOT NULL, -- 'DIRECT_ERP', 'PURCHASE_ERP', 'KRYSALIS_PURCHASE_ERP'
    current_stage TEXT NOT NULL,  -- 'KRYSALIS', 'PURCHASE', 'ERP', 'COMPLETED', 'REJECTED'
    status TEXT NOT NULL,         -- 'PENDING_KRYSALIS', 'PENDING_PURCHASE', 'PENDING_ERP', 'RELEASED_TO_ERP', 'REJECTED'
    audit_trail JSONB DEFAULT '[]'::jsonb,
    created_by TEXT DEFAULT 'shearing',
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Performance Indexes on manufacturing_orders
CREATE INDEX IF NOT EXISTS idx_mo_number ON public.manufacturing_orders(mo_number);
CREATE INDEX IF NOT EXISTS idx_mo_part_no ON public.manufacturing_orders(part_no);
CREATE INDEX IF NOT EXISTS idx_mo_current_stage ON public.manufacturing_orders(current_stage);
CREATE INDEX IF NOT EXISTS idx_mo_status ON public.manufacturing_orders(status);

-- Enable RLS
ALTER TABLE public.manufacturing_orders ENABLE ROW LEVEL SECURITY;

-- Allow public read and full service role write access
CREATE POLICY "Allow public read on manufacturing_orders"
    ON public.manufacturing_orders
    FOR SELECT
    USING (true);

CREATE POLICY "Allow write access on manufacturing_orders"
    ON public.manufacturing_orders
    FOR ALL
    USING (true)
    WITH CHECK (true);

COMMENT ON TABLE public.manufacturing_orders IS 'MO Approval workflow records with stage tracking, Krysalis, Purchase and ERP signoffs';

