-- ============================================================================
-- SheetLayout AI — 5 Realistic Seed Records per Table
-- Extracted directly from:
-- 1. Unit 1 - Daily Stock Report 27.09.26.xlsx (RM Stock)
-- 2. Copy of Layout Standardization.xlsx (Parts & Dimensions)
-- 3. ERP Entry - 2.xlsx (Historical MOs)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. ENABLE PERMISSIONS (RLS POLICIES)
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- 1. RAW MATERIAL MASTER (rm) - 5 Real Sheets from Main Store Stock
-- ----------------------------------------------------------------------------
INSERT INTO public.rm (rm_code, available_sheets, weight_per_sheet)
VALUES 
    ('CR-1-2500-1250', 162, 24.530),
    ('HR-2-2500-1250', 156, 49.060),
    ('CR-2-2500-1250', 168, 49.060),
    ('HR-2.5-2500-1250', 16, 61.330),
    ('HR-3-2500-1250', 53, 73.590)
ON CONFLICT (rm_code) DO UPDATE 
SET available_sheets = EXCLUDED.available_sheets, 
    weight_per_sheet = EXCLUDED.weight_per_sheet;

-- ----------------------------------------------------------------------------
-- 2. PARTS MASTER (parts) - 5 Real Fabricated Sheet Metal Components
-- ----------------------------------------------------------------------------
INSERT INTO public.parts (part_no, part_desc, grade, thickness, length, width, weight, offtake, strip_per_blank_qty, standard_rm)
VALUES
    ('X5L00214 - Item 1', 'Bracket Reinforcement Plate', 'HR', 3.00, 181.00, 59.00, 0.250, 48, 4, 'HR-3-2500-1250'),
    ('F2J02714 - Item 1', 'Lower Support Flange', 'HR', 3.00, 494.00, 336.00, 3.910, 15, 3, 'HR-3-2500-1250'),
    ('F4M05114 - Item 1', 'Longitudinal Stiffener Channel', 'HR', 2.00, 1250.00, 162.00, 3.180, 14, 2, 'HR-2-2500-1250'),
    ('F1S65913 - Item 1', 'Mounting Gusset Lug', 'HR', 3.00, 192.00, 75.00, 0.340, 40, 4, 'HR-3-2500-1250'),
    ('B0S10705 - Item 3', 'Cross Member Guide Strip', 'HR', 3.00, 400.00, 64.60, 0.610, 32, 4, 'HR-3-2500-1250')
ON CONFLICT (part_no) DO UPDATE
SET grade = EXCLUDED.grade,
    thickness = EXCLUDED.thickness,
    length = EXCLUDED.length,
    width = EXCLUDED.width,
    offtake = EXCLUDED.offtake,
    strip_per_blank_qty = EXCLUDED.strip_per_blank_qty,
    standard_rm = EXCLUDED.standard_rm;

-- ----------------------------------------------------------------------------
-- 3. MRP (mrp) - 5 Monthly Schedules (Current Demand vs FG Stock)
-- ----------------------------------------------------------------------------
INSERT INTO public.mrp (month_year, part_no, monthly_schedule, current_stock, status)
VALUES
    ('2026-10', 'X5L00214 - Item 1', 500, 80, 'ACTIVE'),
    ('2026-10', 'F2J02714 - Item 1', 180, 30, 'ACTIVE'),
    ('2026-10', 'F4M05114 - Item 1', 250, 40, 'ACTIVE'),
    ('2026-10', 'F1S65913 - Item 1', 400, 120, 'ACTIVE'),
    ('2026-10', 'B0S10705 - Item 3', 320, 60, 'ACTIVE')
ON CONFLICT (month_year, part_no) DO UPDATE
SET monthly_schedule = EXCLUDED.monthly_schedule,
    current_stock = EXCLUDED.current_stock;

-- ----------------------------------------------------------------------------
-- 4. MOS (mos) - 5 Historical ERP MOs (From ERP Cutting Orders)
-- ----------------------------------------------------------------------------
INSERT INTO public.mos (date, mo_number, part_no, already_produced_stock, rem_stock_toproduce)
VALUES
    ('2026-09-15', 'MCP/26-27/01102', 'X5L00214 - Item 1', 240, 260),
    ('2026-09-18', 'MCP/26-27/01145', 'F2J02714 - Item 1', 90, 90),
    ('2026-09-22', 'MCP/26-27/01201', 'F4M05114 - Item 1', 140, 110),
    ('2026-09-25', 'MCP/26-27/01268', 'F1S65913 - Item 1', 200, 200),
    ('2026-09-28', 'MCP/26-27/01310', 'B0S10705 - Item 3', 160, 160)
ON CONFLICT (mo_number) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 5. APP_MO (app_mo) - 5 Application Cutting Orders (Approval Pipeline)
-- ----------------------------------------------------------------------------
INSERT INTO public.app_mo (date, mo_no, rm_code, no_of_rm_sheets, parts_produced, parts_qty, endbits, endbit_weight, yield_pct, workflow_path, current_stage, status, remarks)
VALUES
    ('2026-10-02', 'MO-2026-0001', 'HR-3-2500-1250', 5, '[{"part_no": "X5L00214 - Item 1", "qty": 240}]'::jsonb, 240, 'HR-3.0x600x1250', 14.13, 91.50, 'DIRECT_ERP', 'COMPLETED', 'APPROVED', 'Standard nesting shearing batch'),
    ('2026-10-05', 'MO-2026-0002', 'HR-3-2500-1250', 6, '[{"part_no": "F2J02714 - Item 1", "qty": 90}]'::jsonb, 90, 'HR-3.0x450x1250', 10.60, 88.20, 'PURCHASE_ERP', 'PURCHASE', 'PENDING', 'High scrap margin, awaiting purchase review'),
    ('2026-10-08', 'MO-2026-0003', 'HR-2-2500-1250', 10, '[{"part_no": "F4M05114 - Item 1", "qty": 140}]'::jsonb, 140, 'HR-2.0x500x1250', 9.81, 94.00, 'DIRECT_ERP', 'ERP', 'PENDING', 'Fast-track to ERP cutting queue'),
    ('2026-10-12', 'MO-2026-0004', 'HR-3-2500-1250', 5, '[{"part_no": "F1S65913 - Item 1", "qty": 200}]'::jsonb, 200, 'HR-3.0x350x1250', 8.24, 93.10, 'DIRECT_ERP', 'KRYSALIS', 'PENDING', 'Initial layout submitted by Shearing team'),
    ('2026-10-15', 'MO-2026-0005', 'HR-3-2500-1250', 5, '[{"part_no": "B0S10705 - Item 3", "qty": 160}]'::jsonb, 160, 'HR-3.0x550x1250', 12.95, 89.80, 'KRYSALIS_PURCHASE_ERP', 'KRYSALIS', 'PENDING', 'Multi-stage approval initiated')
ON CONFLICT (mo_no) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 6. ENDBITS (endbits) - 5 Tracked Offcut Batches (Generated from app_mo)
-- ----------------------------------------------------------------------------
INSERT INTO public.endbits (date, mo_no, endbit, quantity, weight)
VALUES
    ('2026-10-02', 'MO-2026-0001', 'EB-HR-3.0-600x1250', 5, 14.13),
    ('2026-10-05', 'MO-2026-0002', 'EB-HR-3.0-450x1250', 6, 10.60),
    ('2026-10-08', 'MO-2026-0003', 'EB-HR-2.0-500x1250', 10, 9.81),
    ('2026-10-12', 'MO-2026-0004', 'EB-HR-3.0-350x1250', 5, 8.24),
    ('2026-10-15', 'MO-2026-0005', 'EB-HR-3.0-550x1250', 5, 12.95);

-- ----------------------------------------------------------------------------
-- 7. ENDBIT_MO (endbit_mo) - 5 Cutting Orders utilizing Offcuts
-- ----------------------------------------------------------------------------
INSERT INTO public.endbit_mo (date, eb_mo_no, endbit_id, endbit_code, no_of_eb_sheets, parts_produced, parts_qty, scrap_weight, yield_pct, current_stage, status, remarks)
VALUES
    ('2026-10-04', 'EB-MO-2026-0001', 1, 'EB-HR-3.0-600x1250', 2, '[{"part_no": "X5L00214 - Item 1", "qty": 36}]'::jsonb, 36, 1.85, 87.00, 'COMPLETED', 'APPROVED', 'Cut bracket plates from scrap rack A2'),
    ('2026-10-07', 'EB-MO-2026-0002', 2, 'EB-HR-3.0-450x1250', 3, '[{"part_no": "F1S65913 - Item 1", "qty": 45}]'::jsonb, 45, 1.40, 86.80, 'ERP', 'PENDING', 'Reused offcuts from MO-0002 to save sheets'),
    ('2026-10-10', 'EB-MO-2026-0003', 3, 'EB-HR-2.0-500x1250', 4, '[{"part_no": "F4M05114 - Item 1", "qty": 28}]'::jsonb, 28, 1.20, 89.20, 'KRYSALIS', 'PENDING', 'Zero-waste shearing run'),
    ('2026-10-14', 'EB-MO-2026-0004', 1, 'EB-HR-3.0-600x1250', 2, '[{"part_no": "B0S10705 - Item 3", "qty": 30}]'::jsonb, 30, 1.90, 86.50, 'KRYSALIS', 'PENDING', 'Consumed remaining 2 sheets from Batch #1'),
    ('2026-10-16', 'EB-MO-2026-0005', 4, 'EB-HR-3.0-350x1250', 2, '[{"part_no": "X5L00214 - Item 1", "qty": 24}]'::jsonb, 24, 1.10, 88.00, 'KRYSALIS', 'PENDING', 'Urgent small customer spare batch');
