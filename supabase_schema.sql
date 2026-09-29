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
DROP POLICY IF EXISTS "Allow public read on layout_records" ON public.layout_records;
CREATE POLICY "Allow public read on layout_records"
    ON public.layout_records
    FOR SELECT
    USING (true);

-- Allow authenticated / service_role full insert/update/delete access
DROP POLICY IF EXISTS "Allow service role write access on layout_records" ON public.layout_records;
CREATE POLICY "Allow service role write access on layout_records"
    ON public.layout_records
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- Optional: Comments for documentation
COMMENT ON TABLE public.layout_records IS 'Master standardized sheet metal layout records, blank sizes, and RM ERP data';

-- =====================================================================
-- 5. Material Orders (MO) Approval Workflow Table
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.material_orders (
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

-- Performance Indexes on material_orders
CREATE INDEX IF NOT EXISTS idx_material_orders_mo_num ON public.material_orders(mo_number);
CREATE INDEX IF NOT EXISTS idx_material_orders_part_no ON public.material_orders(part_no);
CREATE INDEX IF NOT EXISTS idx_material_orders_stage ON public.material_orders(current_stage);
CREATE INDEX IF NOT EXISTS idx_material_orders_status ON public.material_orders(status);

-- Enable RLS
ALTER TABLE public.material_orders ENABLE ROW LEVEL SECURITY;

-- Allow public read and full write access
DROP POLICY IF EXISTS "Allow public read on material_orders" ON public.material_orders;
CREATE POLICY "Allow public read on material_orders"
    ON public.material_orders
    FOR SELECT
    USING (true);

DROP POLICY IF EXISTS "Allow write access on material_orders" ON public.material_orders;
CREATE POLICY "Allow write access on material_orders"
    ON public.material_orders
    FOR ALL
    USING (true)
    WITH CHECK (true);

COMMENT ON TABLE public.material_orders IS 'Material Order (MO) workflow records with stage tracking, Krysalis, Purchase and ERP signoffs';

-- Optional backward compatibility view if manufacturing_orders is queried
CREATE OR REPLACE VIEW public.manufacturing_orders AS SELECT * FROM public.material_orders;

-- =====================================================================
-- 6. ERP Entry MO Report Table (Previous MOs Created)
-- Source: ERP Entry - 2.xlsx -> MO Report
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.erp_mo_reports (
    id BIGSERIAL PRIMARY KEY,
    mo_doc_no TEXT NOT NULL,
    doc_date TEXT,
    order_status TEXT DEFAULT '',
    cutting_order_no TEXT DEFAULT '',
    cutting_order_date TEXT,
    rm_code TEXT DEFAULT '',
    rm_desc TEXT DEFAULT '',
    uom TEXT DEFAULT 'NOS',
    number_of_sheets NUMERIC,
    reference_date TEXT,
    reference_no TEXT DEFAULT '',
    start_date TEXT,
    due_date TEXT,
    cutting_plan_no TEXT DEFAULT '',
    parent_code TEXT DEFAULT '',
    parent_desc TEXT DEFAULT '',
    uom_code TEXT DEFAULT '',
    parent_qty_per_sheet NUMERIC,
    total_parent_qty NUMERIC,
    rm_weight NUMERIC,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_erp_mo_doc_no ON public.erp_mo_reports(mo_doc_no);
CREATE INDEX IF NOT EXISTS idx_erp_mo_parent_code ON public.erp_mo_reports(parent_code);
CREATE INDEX IF NOT EXISTS idx_erp_mo_rm_code ON public.erp_mo_reports(rm_code);
CREATE INDEX IF NOT EXISTS idx_erp_mo_cutting_plan ON public.erp_mo_reports(cutting_plan_no);
ALTER TABLE public.erp_mo_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read on erp_mo_reports" ON public.erp_mo_reports FOR SELECT USING (true);
CREATE POLICY "Allow write on erp_mo_reports" ON public.erp_mo_reports FOR ALL USING (true) WITH CHECK (true);

-- =====================================================================
-- 7. RM Opening Stock Table (Main Store Raw Material Inventory)
-- Source: Unit 1 - Daily Stock Report 27.09.26.xlsx -> MAIN STORE
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.rm_main_store_stock (
    id BIGSERIAL PRIMARY KEY,
    item_code TEXT NOT NULL,
    item_desc TEXT DEFAULT '',
    uom TEXT DEFAULT 'NOS',
    store_desc TEXT DEFAULT 'MAIN STORES',
    onhand_stock NUMERIC DEFAULT 0,
    category_desc TEXT DEFAULT '',
    weight NUMERIC,
    total_weight NUMERIC,
    std_cost NUMERIC,
    last_po_price NUMERIC,
    stock_value NUMERIC,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rm_stock_item_code ON public.rm_main_store_stock(item_code);
CREATE INDEX IF NOT EXISTS idx_rm_stock_desc ON public.rm_main_store_stock(item_desc);
ALTER TABLE public.rm_main_store_stock ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read on rm_main_store_stock" ON public.rm_main_store_stock FOR SELECT USING (true);
CREATE POLICY "Allow write on rm_main_store_stock" ON public.rm_main_store_stock FOR ALL USING (true) WITH CHECK (true);

-- =====================================================================
-- 8. Parts Opening Stock Table (002 - FG & WIP Inventory)
-- Source: Unit 1 - Daily Stock Report 27.09.26.xlsx -> 002 - FG & WIP
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.parts_fg_wip_stock (
    id BIGSERIAL PRIMARY KEY,
    item_code TEXT NOT NULL,
    item_desc TEXT DEFAULT '',
    uom TEXT DEFAULT 'NOS',
    store_desc TEXT DEFAULT 'FG AND WIP STORES',
    onhand_stock NUMERIC DEFAULT 0,
    category_desc TEXT DEFAULT '',
    weight NUMERIC,
    total_weight NUMERIC,
    std_cost NUMERIC,
    std_stock_value NUMERIC,
    details TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fg_wip_item_code ON public.parts_fg_wip_stock(item_code);
CREATE INDEX IF NOT EXISTS idx_fg_wip_category ON public.parts_fg_wip_stock(category_desc);
ALTER TABLE public.parts_fg_wip_stock ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read on parts_fg_wip_stock" ON public.parts_fg_wip_stock FOR SELECT USING (true);
CREATE POLICY "Allow write on parts_fg_wip_stock" ON public.parts_fg_wip_stock FOR ALL USING (true) WITH CHECK (true);

-- =====================================================================
-- 9. MRP Monthly Sales Schedule Table
-- Source: MRP - AL - Sep'26 Schedule.xlsx -> Schedule given by Sales
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.mrp_sales_schedules (
    id BIGSERIAL PRIMARY KEY,
    sl_no INTEGER,
    part_no TEXT NOT NULL,
    part_name TEXT DEFAULT '',
    wk1 NUMERIC DEFAULT 0,
    wk2 NUMERIC DEFAULT 0,
    wk3 NUMERIC DEFAULT 0,
    wk4 NUMERIC DEFAULT 0,
    wk5 NUMERIC DEFAULT 0,
    monthly_total NUMERIC DEFAULT 0,
    fg_pc_stock NUMERIC DEFAULT 0,
    godown NUMERIC DEFAULT 0,
    qc NUMERIC DEFAULT 0,
    balance_planning NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mrp_part_no ON public.mrp_sales_schedules(part_no);
ALTER TABLE public.mrp_sales_schedules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read on mrp_sales_schedules" ON public.mrp_sales_schedules FOR SELECT USING (true);
CREATE POLICY "Allow write on mrp_sales_schedules" ON public.mrp_sales_schedules FOR ALL USING (true) WITH CHECK (true);

-- =====================================================================
-- 10. MRP RM Sheet BOM Table
-- Source: MRP - AL - Sep'26 Schedule.xlsx -> RM sheet BOM
-- =====================================================================
CREATE TABLE IF NOT EXISTS public.mrp_rm_sheet_bom (
    id BIGSERIAL PRIMARY KEY,
    sl_no INTEGER,
    parent_part_no TEXT NOT NULL,
    child_part_no TEXT DEFAULT '',
    os_part TEXT DEFAULT '',
    erp_part_no TEXT DEFAULT '',
    scope TEXT DEFAULT '',
    offtake NUMERIC DEFAULT 1,
    grade TEXT DEFAULT '',
    blank_length NUMERIC,
    blank_width NUMERIC,
    blank_thickness NUMERIC,
    blank_weight NUMERIC,
    sheet_length NUMERIC,
    sheet_width NUMERIC,
    sheet_thickness NUMERIC,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mrp_bom_parent ON public.mrp_rm_sheet_bom(parent_part_no);
CREATE INDEX IF NOT EXISTS idx_mrp_bom_erp ON public.mrp_rm_sheet_bom(erp_part_no);
ALTER TABLE public.mrp_rm_sheet_bom ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow public read on mrp_rm_sheet_bom" ON public.mrp_rm_sheet_bom FOR SELECT USING (true);
CREATE POLICY "Allow write on mrp_rm_sheet_bom" ON public.mrp_rm_sheet_bom FOR ALL USING (true) WITH CHECK (true);

-- =====================================================================
-- 11. GRANT PERMISSIONS TO ANON & AUTHENTICATED ROLES
-- (Prevents 'permission denied for table' errors when using anon key)
-- =====================================================================
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;



