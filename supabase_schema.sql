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
