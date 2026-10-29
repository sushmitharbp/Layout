-- ============================================================================
-- SheetLayout AI / MO Approval Engine — Clean Universal Database Schema (v2)
-- Architecture: 7 Modular Tables with Batch-Wise Endbit Inventory & Multi-Part JSONB
-- ============================================================================

-- Enable UUID extension if needed in future
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================================
-- 1. RAW MATERIAL MASTER (RM)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.rm (
    rm_code TEXT PRIMARY KEY,                       -- Unique Combination (e.g., 'CRCA-2.0-1250-2500')
    available_sheets INTEGER DEFAULT 0,             -- Live sheet stock in store
    weight_per_sheet NUMERIC(10, 3) NOT NULL,       -- Single sheet weight (kg)
    total_stock_weight NUMERIC(12, 3) GENERATED ALWAYS AS (available_sheets * weight_per_sheet) STORED,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- 2. PARTS MASTER
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.parts (
    part_no TEXT PRIMARY KEY,                       -- Unique Part Number
    part_desc TEXT DEFAULT '',                      -- Optional component name/description
    grade TEXT NOT NULL,                            -- Material grade (CRCA, HR, etc.)
    thickness NUMERIC(10, 2) NOT NULL,              -- Thickness in mm
    length NUMERIC(10, 2) NOT NULL,                 -- Blank Cut Length in mm
    width NUMERIC(10, 2) NOT NULL,                  -- Blank Cut Width in mm
    weight NUMERIC(10, 3) DEFAULT 0,                -- Finished Part weight in kg
    offtake INTEGER NOT NULL DEFAULT 1,             -- Number of parts produced per sheet
    strip_per_blank_qty INTEGER NOT NULL DEFAULT 1, -- Strip per blank quantity
    standard_rm TEXT REFERENCES public.rm(rm_code) ON UPDATE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_parts_standard_rm ON public.parts(standard_rm);

-- ============================================================================
-- 3. MRP (MONTHLY PRODUCTION SCHEDULE & NET DEMAND)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.mrp (
    id BIGSERIAL PRIMARY KEY,
    month_year TEXT NOT NULL,                       -- Month (e.g., '2026-10')
    part_no TEXT NOT NULL REFERENCES public.parts(part_no) ON UPDATE CASCADE,
    monthly_schedule INTEGER NOT NULL DEFAULT 0,   -- Demand given by Sales
    current_stock INTEGER NOT NULL DEFAULT 0,      -- Live FG/WIP stock from ERP
    -- If schedule > current stock, produce difference; if excess stock, produce 0
    qty_to_produce INTEGER GENERATED ALWAYS AS (
        CASE 
            WHEN monthly_schedule > current_stock THEN monthly_schedule - current_stock 
            ELSE 0 
        END
    ) STORED,
    status TEXT DEFAULT 'ACTIVE',                   -- 'ACTIVE', 'IN_PROGRESS', 'FULFILLED'
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(month_year, part_no)
);

CREATE INDEX IF NOT EXISTS idx_mrp_part_month ON public.mrp(part_no, month_year);

-- ============================================================================
-- 4. MOS (ERP MO HISTORY FEED)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.mos (
    id BIGSERIAL PRIMARY KEY,
    date DATE DEFAULT CURRENT_DATE,
    mo_number TEXT UNIQUE NOT NULL,                 -- MO Document Number from ERP
    part_no TEXT NOT NULL REFERENCES public.parts(part_no) ON UPDATE CASCADE,
    already_produced_stock NUMERIC DEFAULT 0,
    rem_stock_toproduce NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mos_part_no ON public.mos(part_no);
CREATE INDEX IF NOT EXISTS idx_mos_mo_number ON public.mos(mo_number);

-- ============================================================================
-- 5. APP_MO (APPLICATION MO APPROVAL WORKFLOW)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.app_mo (
    id BIGSERIAL PRIMARY KEY,
    date DATE DEFAULT CURRENT_DATE,
    mo_no TEXT UNIQUE NOT NULL,                     -- Generated MO Number (e.g. 'MO-2026-001')
    rm_code TEXT NOT NULL REFERENCES public.rm(rm_code) ON UPDATE CASCADE,
    no_of_rm_sheets NUMERIC DEFAULT 0,              -- Number of RM sheets allocated
    -- Stores multi-part cuts: [{"part_no": "P1", "qty": 100}, {"part_no": "P2", "qty": 50}]
    parts_produced JSONB NOT NULL DEFAULT '[]'::jsonb,
    parts_qty NUMERIC DEFAULT 0,                    -- Total sum of all parts produced
    endbits TEXT,                                   -- Endbit dimension summary
    endbit_weight NUMERIC DEFAULT 0,                -- Weight of endbits generated (kg)
    yield_pct NUMERIC DEFAULT 0,                    -- Sheet utilization percentage (%)
    workflow_path TEXT DEFAULT 'DIRECT_ERP',        -- 'DIRECT_ERP', 'PURCHASE_ERP', 'KRYSALIS_PURCHASE_ERP'
    current_stage TEXT DEFAULT 'KRYSALIS',          -- 'KRYSALIS', 'PURCHASE', 'ERP', 'COMPLETED', 'REJECTED'
    status TEXT DEFAULT 'PENDING',                  -- 'PENDING', 'APPROVED', 'REJECTED'
    remarks TEXT DEFAULT '',                        -- Cutting / approval remarks
    audit_trail JSONB DEFAULT '[]'::jsonb,          -- Audit logs of status changes
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_mo_no ON public.app_mo(mo_no);
CREATE INDEX IF NOT EXISTS idx_app_mo_rm ON public.app_mo(rm_code);
CREATE INDEX IF NOT EXISTS idx_app_mo_stage ON public.app_mo(current_stage);
CREATE INDEX IF NOT EXISTS idx_app_mo_status ON public.app_mo(status);

-- ============================================================================
-- 6. ENDBITS (BATCH-WISE OFFCUT INVENTORY STORE)
-- Option 1: Each MO generates its own tracked row/batch (FIFO ready)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.endbits (
    id BIGSERIAL PRIMARY KEY,                       -- Unique Batch ID for this specific endbit stack
    date DATE DEFAULT CURRENT_DATE,
    mo_no TEXT NOT NULL REFERENCES public.app_mo(mo_no) ON UPDATE CASCADE,
    endbit TEXT NOT NULL,                           -- Dimension/spec (e.g. 'EB-CRCA-2.0-600x1250')
    quantity NUMERIC DEFAULT 0,                     -- Available sheets in this batch
    weight NUMERIC DEFAULT 0,                       -- Single piece weight (kg)
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_endbits_mo_no ON public.endbits(mo_no);
CREATE INDEX IF NOT EXISTS idx_endbits_dimension ON public.endbits(endbit);

-- ============================================================================
-- 7. ENDBIT_MO (CUTTING ORDERS FROM ENDBIT BATCHES)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.endbit_mo (
    id BIGSERIAL PRIMARY KEY,
    date DATE DEFAULT CURRENT_DATE,
    eb_mo_no TEXT UNIQUE NOT NULL,                  -- Unique Endbit MO Number (e.g. 'EB-MO-2026-001')
    endbit_id BIGINT REFERENCES public.endbits(id) ON UPDATE CASCADE, -- The specific batch consumed
    endbit_code TEXT NOT NULL,                      -- Endbit dimension reference (e.g. 'EB-CRCA-2.0-600x1250')
    no_of_eb_sheets NUMERIC DEFAULT 0,              -- Sheets consumed from this endbit batch
    -- Stores multi-part cuts: [{"part_no": "P1", "qty": 20}]
    parts_produced JSONB NOT NULL DEFAULT '[]'::jsonb,
    parts_qty NUMERIC DEFAULT 0,                    -- Total parts produced from endbit
    scrap_weight NUMERIC DEFAULT 0,                 -- Final non-usable scrap weight (kg)
    yield_pct NUMERIC DEFAULT 0,                    -- Material yield (%)
    current_stage TEXT DEFAULT 'KRYSALIS',          -- 'KRYSALIS', 'PURCHASE', 'ERP', 'COMPLETED', 'REJECTED'
    status TEXT DEFAULT 'PENDING',                  -- 'PENDING', 'APPROVED', 'COMPLETED'
    remarks TEXT DEFAULT '',                        -- Production remarks
    audit_trail JSONB DEFAULT '[]'::jsonb,          -- Audit logs
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_endbit_mo_eb_no ON public.endbit_mo(eb_mo_no);
CREATE INDEX IF NOT EXISTS idx_endbit_mo_endbit_id ON public.endbit_mo(endbit_id);
CREATE INDEX IF NOT EXISTS idx_endbit_mo_status ON public.endbit_mo(status);

-- ============================================================================
-- 8. ROW LEVEL SECURITY (RLS) POLICIES — Full Read/Write Access
-- ============================================================================
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

