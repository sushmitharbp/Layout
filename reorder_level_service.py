"""
SheetLayout AI — Raw Material Reorder Level & Dynamic RYG Inventory Intelligence Service
Supports:
1. AL (Ashok Leyland - Unit 1) 36 RM Standards
2. VST (VST Tractors - Unit 2) 13 RM Standards

Dynamic RYG Classification Logic (per client formula):
- BLACK  : Stock == 0 or Sheet Stock == 0 (Stockout / Zero Stock)
- RED    : 0 < Stock in KGS < 50% of Max QTY (Critical Reorder)
- YELLOW : 50% <= Stock in KGS < 75% of Max QTY (Buffer Warning)
- GREEN  : 75% <= Stock in KGS <= 100% of Max QTY (Optimal Target Range)
- WHITE  : Stock in KGS > 100% of Max QTY (Excess / Overstock)
"""

import os
import re
import json
import time
import logging
from datetime import datetime
from typing import Dict, Any, List, Optional

logger = logging.getLogger("ReorderLevelService")

# ============================================================================
# 1. AL (ASHOK LEYLAND) 36 RM STANDARDS MASTER NORMS
# Source: Reorder_level/RM Revised RYG .xlsx (AL-RYG & AL - Norms)
# Total Max Qty = 184,500 kg (184.5 Tons)
# ============================================================================
AL_RM_STANDARDS = [
    {"sl_no": 1,  "rm_code": "BSK-3.8-1905-1700", "max_qty": 2000,  "grade": "BSK", "thickness": 3.8, "length": 1905.0, "width": 1700.0, "weight_per_sheet": 96.60},
    {"sl_no": 2,  "rm_code": "BSK-3.8-2500-1500", "max_qty": 8000,  "grade": "BSK", "thickness": 3.8, "length": 2500.0, "width": 1500.0, "weight_per_sheet": 111.86},
    {"sl_no": 3,  "rm_code": "BSK-4.8-2400-1500", "max_qty": 4000,  "grade": "BSK", "thickness": 4.8, "length": 2400.0, "width": 1500.0, "weight_per_sheet": 135.65},
    {"sl_no": 4,  "rm_code": "BSK-4.8-2500-1500", "max_qty": 15000, "grade": "BSK", "thickness": 4.8, "length": 2500.0, "width": 1500.0, "weight_per_sheet": 141.30},
    {"sl_no": 5,  "rm_code": "BSK-4.8-2850-1500", "max_qty": 4000,  "grade": "BSK", "thickness": 4.8, "length": 2850.0, "width": 1500.0, "weight_per_sheet": 161.08},
    {"sl_no": 6,  "rm_code": "BSK-5.8-2500-1250", "max_qty": 2000,  "grade": "BSK", "thickness": 5.8, "length": 2500.0, "width": 1250.0, "weight_per_sheet": 142.28},
    {"sl_no": 7,  "rm_code": "BSK-5.8-2500-1500", "max_qty": 8000,  "grade": "BSK", "thickness": 5.8, "length": 2500.0, "width": 1500.0, "weight_per_sheet": 170.74},
    {"sl_no": 8,  "rm_code": "BSK-7.8-2500-1500", "max_qty": 5000,  "grade": "BSK", "thickness": 7.8, "length": 2500.0, "width": 1500.0, "weight_per_sheet": 229.61},
    {"sl_no": 9,  "rm_code": "CR-1.0-2700-1250",  "max_qty": 1500,  "grade": "CR",  "thickness": 1.0, "length": 2700.0, "width": 1250.0, "weight_per_sheet": 26.49},
    {"sl_no": 10, "rm_code": "CR-1.5-2500-1250",  "max_qty": 3500,  "grade": "CR",  "thickness": 1.5, "length": 2500.0, "width": 1250.0, "weight_per_sheet": 36.80},
    {"sl_no": 11, "rm_code": "CR-1-2500-1250",    "max_qty": 3500,  "grade": "CR",  "thickness": 1.0, "length": 2500.0, "width": 1250.0, "weight_per_sheet": 24.53},
    {"sl_no": 12, "rm_code": "CR-2-2500-1250",    "max_qty": 4000,  "grade": "CR",  "thickness": 2.0, "length": 2500.0, "width": 1250.0, "weight_per_sheet": 49.06},
    {"sl_no": 13, "rm_code": "CR-2-2500-1500",    "max_qty": 5000,  "grade": "CR",  "thickness": 2.0, "length": 2500.0, "width": 1500.0, "weight_per_sheet": 58.88},
    {"sl_no": 14, "rm_code": "HR-2-2500-1250",    "max_qty": 10000, "grade": "HR",  "thickness": 2.0, "length": 2500.0, "width": 1250.0, "weight_per_sheet": 49.06},
    {"sl_no": 15, "rm_code": "HR-3.8-2500-1250",  "max_qty": 7000,  "grade": "HR",  "thickness": 3.8, "length": 2500.0, "width": 1250.0, "weight_per_sheet": 93.22},
    {"sl_no": 16, "rm_code": "HR-3.8-2600-1250",  "max_qty": 2500,  "grade": "HR",  "thickness": 3.8, "length": 2600.0, "width": 1250.0, "weight_per_sheet": 96.95},
    {"sl_no": 17, "rm_code": "HR-3-2220-1250",    "max_qty": 1000,  "grade": "HR",  "thickness": 3.0, "length": 2220.0, "width": 1250.0, "weight_per_sheet": 65.35},
    {"sl_no": 18, "rm_code": "HR-3-2500-1250",    "max_qty": 6000,  "grade": "HR",  "thickness": 3.0, "length": 2500.0, "width": 1250.0, "weight_per_sheet": 73.59},
    {"sl_no": 19, "rm_code": "HR-3-2500-1500",    "max_qty": 5000,  "grade": "HR",  "thickness": 3.0, "length": 2500.0, "width": 1500.0, "weight_per_sheet": 88.31},
    {"sl_no": 20, "rm_code": "HR-3-2700-1250",    "max_qty": 1500,  "grade": "HR",  "thickness": 3.0, "length": 2700.0, "width": 1250.0, "weight_per_sheet": 79.48},
    {"sl_no": 21, "rm_code": "HR-4.8-2500-1250",  "max_qty": 7000,  "grade": "HR",  "thickness": 4.8, "length": 2500.0, "width": 1250.0, "weight_per_sheet": 117.75},
    {"sl_no": 22, "rm_code": "HR-4.8-2500-1500",  "max_qty": 4000,  "grade": "HR",  "thickness": 4.8, "length": 2500.0, "width": 1500.0, "weight_per_sheet": 141.30},
    {"sl_no": 23, "rm_code": "HR-5.8-2500-1250",  "max_qty": 7000,  "grade": "HR",  "thickness": 5.8, "length": 2500.0, "width": 1250.0, "weight_per_sheet": 142.28},
    {"sl_no": 24, "rm_code": "HR-7.8-2500-1250",  "max_qty": 7000,  "grade": "HR",  "thickness": 7.8, "length": 2500.0, "width": 1250.0, "weight_per_sheet": 191.34},
    {"sl_no": 25, "rm_code": "HR-9.8-2500-1250",  "max_qty": 1500,  "grade": "HR",  "thickness": 9.8, "length": 2500.0, "width": 1250.0, "weight_per_sheet": 240.41},
    {"sl_no": 26, "rm_code": "YS-4.8-2350-1500",  "max_qty": 6500,  "grade": "YS",  "thickness": 4.8, "length": 2350.0, "width": 1500.0, "weight_per_sheet": 132.82},
    {"sl_no": 27, "rm_code": "YS-4.8-2500-1500",  "max_qty": 6000,  "grade": "YS",  "thickness": 4.8, "length": 2500.0, "width": 1500.0, "weight_per_sheet": 141.30},
    {"sl_no": 28, "rm_code": "YS-5.8-2190-1350",  "max_qty": 1500,  "grade": "YS",  "thickness": 5.8, "length": 2190.0, "width": 1350.0, "weight_per_sheet": 134.61},
    {"sl_no": 29, "rm_code": "YS-5.8-2260-1350",  "max_qty": 4000,  "grade": "YS",  "thickness": 5.8, "length": 2260.0, "width": 1350.0, "weight_per_sheet": 138.91},
    {"sl_no": 30, "rm_code": "YS-5.8-2350-1350",  "max_qty": 5000,  "grade": "YS",  "thickness": 5.8, "length": 2350.0, "width": 1350.0, "weight_per_sheet": 144.44},
    {"sl_no": 31, "rm_code": "YS-5.8-2500-1500",  "max_qty": 5000,  "grade": "YS",  "thickness": 5.8, "length": 2500.0, "width": 1500.0, "weight_per_sheet": 170.74},
    {"sl_no": 32, "rm_code": "YS-7.0-2500-1500",  "max_qty": 5000,  "grade": "YS",  "thickness": 7.0, "length": 2500.0, "width": 1500.0, "weight_per_sheet": 206.06},
    {"sl_no": 33, "rm_code": "YS-7.8-2260-1500",  "max_qty": 4000,  "grade": "YS",  "thickness": 7.8, "length": 2260.0, "width": 1500.0, "weight_per_sheet": 207.57},
    {"sl_no": 34, "rm_code": "YS-7.8-2500-1500",  "max_qty": 5000,  "grade": "YS",  "thickness": 7.8, "length": 2500.0, "width": 1500.0, "weight_per_sheet": 229.61},
    {"sl_no": 35, "rm_code": "YS-7-2420-1500",    "max_qty": 2500,  "grade": "YS",  "thickness": 7.0, "length": 2420.0, "width": 1500.0, "weight_per_sheet": 199.47},
    {"sl_no": 36, "rm_code": "YS-7-2520-1500",    "max_qty": 15000, "grade": "YS",  "thickness": 7.0, "length": 2520.0, "width": 1500.0, "weight_per_sheet": 207.71},
]

# ============================================================================
# 2. VST (VST TRACTORS) 13 RM STANDARDS MASTER NORMS
# Source: Reorder_level/RM Revised RYG .xlsx (VST - RYG & VST Norms)
# Total Max Qty = 44,000 kg (44.0 Tons)
# ============================================================================
VST_RM_STANDARDS = [
    {"sl_no": 1,  "rm_code": "CR-1.6-875-667",      "max_qty": 6000, "grade": "CR",     "thickness": 1.6, "length": 875.0,  "width": 667.0,  "weight_per_sheet": 7.33},
    {"sl_no": 2,  "rm_code": "CR-1.6-1250-290",     "max_qty": 5000, "grade": "CR",     "thickness": 1.6, "length": 1250.0, "width": 290.0,  "weight_per_sheet": 4.55},
    {"sl_no": 3,  "rm_code": "CR-EDD-1.2-525-525",  "max_qty": 5000, "grade": "CR-EDD", "thickness": 1.2, "length": 525.0,  "width": 525.0,  "weight_per_sheet": 2.60},
    {"sl_no": 4,  "rm_code": "HR-5-2500-1250",      "max_qty": 3500, "grade": "HR",     "thickness": 5.0, "length": 2500.0, "width": 1250.0, "weight_per_sheet": 122.66},
    {"sl_no": 5,  "rm_code": "CR-2.5-1150-640",     "max_qty": 4000, "grade": "CR",     "thickness": 2.5, "length": 1150.0, "width": 640.0,  "weight_per_sheet": 14.44},
    {"sl_no": 6,  "rm_code": "CR-EDD-1-475-475",    "max_qty": 5000, "grade": "CR-EDD", "thickness": 1.0, "length": 475.0,  "width": 475.0,  "weight_per_sheet": 1.77},
    {"sl_no": 7,  "rm_code": "CR-2.5-2500-1250",    "max_qty": 2000, "grade": "CR",     "thickness": 2.5, "length": 2500.0, "width": 1250.0, "weight_per_sheet": 61.33},
    {"sl_no": 8,  "rm_code": "CR-EDD-1.2-2500-1500", "max_qty": 3500, "grade": "CR-EDD", "thickness": 1.2, "length": 2500.0, "width": 1500.0, "weight_per_sheet": 35.32},
    {"sl_no": 9,  "rm_code": "CR-EDD-1.2-2500-1250", "max_qty": 3500, "grade": "CR-EDD", "thickness": 1.2, "length": 2500.0, "width": 1250.0, "weight_per_sheet": 29.44},
    {"sl_no": 10, "rm_code": "HR-3-2160-1250",      "max_qty": 2000, "grade": "HR",     "thickness": 3.0, "length": 2160.0, "width": 1250.0, "weight_per_sheet": 63.58},
    {"sl_no": 11, "rm_code": "HR-6-2175-1250",      "max_qty": 1000, "grade": "HR",     "thickness": 6.0, "length": 2175.0, "width": 1250.0, "weight_per_sheet": 128.05},
    {"sl_no": 12, "rm_code": "CR-EDD-1-2500-1250",  "max_qty": 2500, "grade": "CR-EDD", "thickness": 1.0, "length": 2500.0, "width": 1250.0, "weight_per_sheet": 24.53},
    {"sl_no": 13, "rm_code": "HR-6-2500-1250",      "max_qty": 1000, "grade": "HR",     "thickness": 6.0, "length": 2500.0, "width": 1250.0, "weight_per_sheet": 147.19},
]

# Baseline Opening Stock snapshot from the revised Excel file (17-Nov-2026)
AL_BASELINE_STOCK_17NOV = {
    "BSK-3.8-1905-1700": 3.0,
    "BSK-3.8-2500-1500": 41.0,
    "BSK-4.8-2400-1500": 71.0,
    "BSK-4.8-2500-1500": 11.0,
    "BSK-4.8-2850-1500": 41.0,
    "BSK-5.8-2500-1250": 36.0,
    "BSK-5.8-2500-1500": 7.0,
    "BSK-7.8-2500-1500": 7.0,
    "CR-1.0-2700-1250": 0.0,
    "CR-1.5-2500-1250": 110.0,
    "CR-1-2500-1250": 0.0,
    "CR-2-2500-1250": 89.0,
    "CR-2-2500-1500": 44.0,
    "HR-2-2500-1250": 219.0,
    "HR-3.8-2500-1250": 68.0,
    "HR-3.8-2600-1250": 0.0,
    "HR-3-2220-1250": 4.0,
    "HR-3-2500-1250": 32.0,
    "HR-3-2500-1500": 116.0,
    "HR-3-2700-1250": 0.0,
    "HR-4.8-2500-1250": 0.0,
    "HR-4.8-2500-1500": 16.0,
    "HR-5.8-2500-1250": 10.0,
    "HR-7.8-2500-1250": 0.0,
    "HR-9.8-2500-1250": 0.0,
    "YS-4.8-2350-1500": 5.0,
    "YS-4.8-2500-1500": 2.0,
    "YS-5.8-2190-1350": 0.0,
    "YS-5.8-2260-1350": 10.0,
    "YS-5.8-2350-1350": 4.0,
    "YS-5.8-2500-1500": 0.0,
    "YS-7.0-2500-1500": 3.0,
    "YS-7.8-2260-1500": 0.0,
    "YS-7.8-2500-1500": 35.0,
    "YS-7-2420-1500": 20.0,
    "YS-7-2520-1500": 58.0
}

VST_BASELINE_STOCK_17NOV = {
    "CR-1.6-875-667": 1730.0,     # ~12,686 kg
    "CR-1.6-1250-290": 190.0,     # ~863 kg
    "CR-EDD-1.2-525-525": 548.0,  # ~1,425 kg
    "HR-5-2500-1250": 46.0,       # ~5,642 kg
    "CR-2.5-1150-640": 0.0,       # 0 kg
    "CR-EDD-1-475-475": 6290.0,   # ~11,133 kg
    "CR-2.5-2500-1250": 143.0,    # ~8,770 kg
    "CR-EDD-1.2-2500-1500": 46.0, # ~1,625 kg
    "CR-EDD-1.2-2500-1250": 192.0,# ~5,652 kg
    "HR-3-2160-1250": 21.0,       # ~1,335 kg
    "HR-6-2175-1250": 38.0,       # ~4,866 kg
    "CR-EDD-1-2500-1250": 549.0,  # ~13,468 kg
    "HR-6-2500-1250": 2.0         # ~285 kg
}


def _norm_code(c: str) -> str:
    """Normalize RM code string for robust key lookup"""
    if not c:
        return ""
    return re.sub(r'[^A-Z0-9]', '', str(c).upper())


def calculate_ryg_status(sheet_stock: float, stock_in_kgs: float, max_qty: float) -> Dict[str, Any]:
    """
    Evaluates client RYG rules:
    - BLACK  : sheet_stock <= 0 or stock_in_kgs <= 0
    - RED    : 0 < ratio < 0.50 (less than 50%)
    - YELLOW : 0.50 <= ratio < 0.75 (50% to 75%)
    - GREEN  : 0.75 <= ratio <= 1.00 (75% to 100%)
    - WHITE  : ratio > 1.00 (greater than 100%)
    """
    if max_qty <= 0:
        ratio = 0.0
    else:
        ratio = float(stock_in_kgs) / float(max_qty)

    ratio_pct = round(ratio * 100, 1)

    if sheet_stock <= 0 or stock_in_kgs <= 0:
        status = "BLACK"
        status_label = "Stockout"
        badge_color = "#0f172a"
        badge_bg = "#f1f5f9"
        badge_border = "#0f172a"
        action_note = "Urgent Purchase Order Required"
    elif ratio < 0.50:
        status = "RED"
        status_label = "Critical Reorder"
        badge_color = "#991b1b"
        badge_bg = "#fee2e2"
        badge_border = "#ef4444"
        action_note = "Below 50% Threshold — Place Reorder"
    elif ratio < 0.75:
        status = "YELLOW"
        status_label = "Buffer Warning"
        badge_color = "#854d0e"
        badge_bg = "#fef9c3"
        badge_border = "#eab308"
        action_note = "Buffer Level 50-75% — Monitor Consumption"
    elif ratio <= 1.00:
        status = "GREEN"
        status_label = "Optimal Range"
        badge_color = "#166534"
        badge_bg = "#dcfce7"
        badge_border = "#22c55e"
        action_note = "Healthy Target Inventory 75-100%"
    else:
        status = "WHITE"
        status_label = "Overstock / Excess"
        badge_color = "#334155"
        badge_bg = "#f8fafc"
        badge_border = "#cbd5e1"
        action_note = "Stock Exceeds 100% Maximum Norm"

    return {
        "status": status,
        "label": status_label,
        "ratio": ratio,
        "ratio_pct": ratio_pct,
        "badge_color": badge_color,
        "badge_bg": badge_bg,
        "badge_border": badge_border,
        "action_note": action_note
    }


class ReorderLevelService:
    """Manages Raw Material Reorder Levels and Dynamic RYG Inventory Tracking"""

    def __init__(self):
        # Override store in memory (rm_code -> sheet_stock)
        self.custom_stocks: Dict[str, float] = {}
        # Override store for Max QTY (rm_code -> max_qty)
        self.custom_max_qtys: Dict[str, float] = {}
        # High-performance in-memory cache to guarantee instantaneous UI loads
        self._supabase_cache: Dict[str, Any] = {}
        self._cache_ttl = 180.0  # 3 minutes
        # Tara ERP Live Cache (60s)
        self._tara_cache: Dict[str, Any] = {}
        self._tara_cache_ttl = 60.0

    def _get_tara_erp_rm_map(self, target_company: str = "PEPIPL") -> tuple:
        """Fetches live RM sheet stock from Tara ERP ORDS Main Stores with caching"""
        now = time.time()
        cached = self._tara_cache.get(target_company)
        if cached and (now - cached.get("time", 0)) < self._tara_cache_ttl:
            return cached.get("rm_map", {}), cached.get("dim_map", {})

        erp_rm_map = {}
        erp_dim_map = {}
        try:
            from tara_erp_client import tara_erp_client
            all_thks = set(s["thickness"] for s in AL_RM_STANDARDS + VST_RM_STANDARDS if s.get("thickness"))
            for thk in sorted(all_thks):
                sheets = tara_erp_client.fetch_rm_sheet_details(
                    thickness=thk,
                    branch_code=target_company,
                    include_zero_stock=True
                )
                for s in sheets:
                    c = s.get("rm_code") or s.get("item_code") or ""
                    if c:
                        erp_rm_map[_norm_code(c)] = s
                    t = float(s.get("thickness") or thk or 0)
                    l = float(s.get("length") or s.get("sheet_length") or 0)
                    w = float(s.get("width") or s.get("sheet_width") or 0)
                    if t and l and w:
                        erp_dim_map[f"{t:g}_{l:g}_{w:g}"] = s
                        erp_dim_map[f"{t:g}_{w:g}_{l:g}"] = s
        except Exception as e:
            logger.warning(f"Could not load live Tara ERP RM stock for RYG: {e}")

        self._tara_cache[target_company] = {"time": now, "rm_map": erp_rm_map, "dim_map": erp_dim_map}
        return erp_rm_map, erp_dim_map

    def _get_supabase_rm_map(self, target_company: str) -> Dict[str, Any]:
        """Fetches Supabase RM sheet stock with caching and tight 1.5s timeout"""
        now = time.time()
        cached = self._supabase_cache.get(target_company)
        if cached and (now - cached.get("time", 0)) < self._cache_ttl:
            return cached.get("data", {})

        db_rm_map = {}
        try:
            import db_clean
            if db_clean.SUPABASE_URL and db_clean.SUPABASE_KEY:
                # Fast query with strict 1.5s timeout so it NEVER hangs page loads
                url = f"{db_clean.SUPABASE_URL}/rest/v1/rm?select=*&order=available_sheets.desc"
                rows = db_clean._safe_supabase_get(url, company_id=target_company, timeout=1.5)
                if not rows and target_company == "PEPIPL":
                    rows = db_clean._safe_supabase_get(url, company_id=None, timeout=1.5)
                for r in (rows or []):
                    rcode = r.get("rm_code") or ""
                    if rcode:
                        db_rm_map[_norm_code(rcode)] = r
        except Exception as e:
            logger.warning(f"Could not load live Supabase RM stock: {e}")

        self._supabase_cache[target_company] = {"time": now, "data": db_rm_map}
        return db_rm_map

    def get_reorder_level_data(self, customer: str = "AL", search_query: str = "", status_filter: str = "") -> Dict[str, Any]:
        """
        Builds the complete dynamic RYG table for Unit 1 (PEPIPL):
        Supports both customer programs manufactured at Unit 1:
        - AL (Ashok Leyland) 36 RM Standards (Max QTY: 184,500 kg)
        - VST (VST Tractors) 13 RM Standards (Max QTY: 44,000 kg)
        Both under Unit 1 (PEPIPL) operations!
        """
        cust_norm = (customer or "AL").strip().upper()
        target_company = "PEPIPL"  # Both AL and VST belong to Unit 1 (PEPIPL)
        unit_name = "Unit 1 (PEPIPL)"

        if cust_norm in ("VST", "VST TRACTORS"):
            standards = VST_RM_STANDARDS
            baseline_map = VST_BASELINE_STOCK_17NOV
            cust_name = "VST Tractors (VST)"
            cust_code = "VST"
        else:
            standards = AL_RM_STANDARDS
            baseline_map = AL_BASELINE_STOCK_17NOV
            cust_name = "Ashok Leyland (AL)"
            cust_code = "AL"

        # 1. Fetch live stock from Tara ERP Main Stores (Primary real-time source)
        erp_rm_map, erp_dim_map = self._get_tara_erp_rm_map(target_company)

        # 2. Fetch live stock from Supabase public.rm (cached fallback)
        db_rm_map = self._get_supabase_rm_map(target_company)

        # 3. Build rows
        items = []
        q_clean = search_query.strip().lower()
        filter_status = status_filter.strip().upper() if status_filter else "ALL"

        for std in standards:
            code = std["rm_code"]
            k = _norm_code(code)
            dim_k = f"{float(std.get('thickness', 0)):g}_{float(std.get('length', 0)):g}_{float(std.get('width', 0)):g}"
            erp_item = erp_rm_map.get(k) or erp_dim_map.get(dim_k)

            # Max QTY (support custom runtime revision or default norm)
            max_qty = self.custom_max_qtys.get(code, std["max_qty"])
            wt_per_sheet = std["weight_per_sheet"]

            # Dynamic Sheet Count Resolution:
            # Priority:
            # A) Custom manual stock adjustment made in UI
            # B) Live Tara ERP Main Store available_sheets
            # C) Live Supabase public.rm available_sheets (if found and non-negative)
            # D) Baseline ERP stock snapshot from the revised RYG spreadsheet (17-Nov-2026)
            if code in self.custom_stocks:
                sheet_stock = self.custom_stocks[code]
                stock_source = "Live User Update"
            elif erp_item and erp_item.get("available_sheets") is not None:
                sheet_stock = float(erp_item.get("available_sheets") or 0)
                stock_source = "Tara ERP Live"
            elif k in db_rm_map and db_rm_map[k].get("available_sheets") is not None:
                sheet_stock = float(db_rm_map[k].get("available_sheets") or 0)
                stock_source = "Supabase Store"
            elif code in baseline_map:
                sheet_stock = float(baseline_map[code])
                stock_source = "ERP Snapshot (Nov 17)"
            else:
                sheet_stock = 0.0
                stock_source = "Out of Stock"

            # Compute Stock in KGS
            stock_in_kgs = round(sheet_stock * wt_per_sheet, 2)

            # Evaluate RYG status
            eval_res = calculate_ryg_status(sheet_stock, stock_in_kgs, max_qty)

            row = {
                "sl_no": std["sl_no"],
                "rm_code": code,
                "grade": std["grade"],
                "thickness": std["thickness"],
                "length": std["length"],
                "width": std["width"],
                "weight_per_sheet": wt_per_sheet,
                "max_qty": max_qty,
                "sheet_stock": sheet_stock,
                "stock_in_kgs": stock_in_kgs,
                "stock_source": stock_source,
                "status": eval_res["status"],
                "status_label": eval_res["label"],
                "ratio": eval_res["ratio"],
                "ratio_pct": eval_res["ratio_pct"],
                "badge_color": eval_res["badge_color"],
                "badge_bg": eval_res["badge_bg"],
                "badge_border": eval_res["badge_border"],
                "action_note": eval_res["action_note"]
            }

            # Filter by search & status
            if q_clean and (q_clean not in code.lower() and q_clean not in std["grade"].lower()):
                continue
            if filter_status != "ALL" and eval_res["status"] != filter_status:
                continue

            items.append(row)

        # 4. Compute Summary Counts across all standards (unfiltered for summary stats)
        all_evals = []
        for std in standards:
            code = std["rm_code"]
            k = _norm_code(code)
            dim_k = f"{float(std.get('thickness', 0)):g}_{float(std.get('length', 0)):g}_{float(std.get('width', 0)):g}"
            erp_item = erp_rm_map.get(k) or erp_dim_map.get(dim_k)
            max_q = self.custom_max_qtys.get(code, std["max_qty"])
            wt_sh = std["weight_per_sheet"]

            if code in self.custom_stocks:
                sh = self.custom_stocks[code]
            elif erp_item and erp_item.get("available_sheets") is not None:
                sh = float(erp_item.get("available_sheets") or 0)
            elif k in db_rm_map and db_rm_map[k].get("available_sheets") is not None:
                sh = float(db_rm_map[k].get("available_sheets") or 0)
            elif code in baseline_map:
                sh = float(baseline_map[code])
            else:
                sh = 0.0

            kg = round(sh * wt_sh, 2)
            st = calculate_ryg_status(sh, kg, max_q)
            all_evals.append({
                "code": code,
                "sheet_stock": sh,
                "stock_in_kgs": kg,
                "max_qty": max_q,
                "status": st["status"]
            })

        summary = {
            "BLACK": sum(1 for e in all_evals if e["status"] == "BLACK"),
            "RED": sum(1 for e in all_evals if e["status"] == "RED"),
            "YELLOW": sum(1 for e in all_evals if e["status"] == "YELLOW"),
            "GREEN": sum(1 for e in all_evals if e["status"] == "GREEN"),
            "WHITE": sum(1 for e in all_evals if e["status"] == "WHITE"),
            "grand_total": len(all_evals),
            "total_max_qty": sum(e["max_qty"] for e in all_evals),
            "total_stock_kgs": round(sum(e["stock_in_kgs"] for e in all_evals), 2),
            "total_sheet_stock": sum(e["sheet_stock"] for e in all_evals),
            # Historical trend snapshots
            "history": {
                "dates": ["14-Nov-26", "16-Nov-26", "17-Nov-26"],
                "AL": {
                    "BLACK": [9, 11, 10],
                    "RED": [13, 14, 12],
                    "YELLOW": [5, 3, 3],
                    "GREEN": [0, 2, 2],
                    "WHITE": [9, 6, 9],
                    "total": [36, 36, 36]
                },
                "VST": {
                    "BLACK": [1, 1, 1],
                    "RED": [4, 4, 4],
                    "YELLOW": [1, 1, 1],
                    "GREEN": [0, 0, 0],
                    "WHITE": [7, 7, 7],
                    "total": [13, 13, 13]
                }
            }
        }

        # Overall capacity ratio
        if summary["total_max_qty"] > 0:
            summary["overall_capacity_pct"] = round((summary["total_stock_kgs"] / summary["total_max_qty"]) * 100, 1)
        else:
            summary["overall_capacity_pct"] = 0.0

        return {
            "success": True,
            "customer": cust_code,
            "customer_name": cust_name,
            "unit_name": unit_name,
            "date": datetime.now().strftime("%d.%m.%y"),
            "display_date": datetime.now().strftime("%d-%b-%Y"),
            "summary": summary,
            "total_count": len(items),
            "items": items
        }

    def update_stock(self, rm_code: str, new_sheet_stock: float) -> Dict[str, Any]:
        """Allows instant stock correction from UI or ERP feed"""
        rm_clean = (rm_code or "").strip()
        try:
            val = max(0.0, float(new_sheet_stock))
            self.custom_stocks[rm_clean] = val
            self._supabase_cache.clear()

            # Also attempt to update Supabase public.rm table if present
            try:
                import db_clean
                db_clean.adjust_rm_stock(rm_clean, delta_sheets=0) # will be updated via custom endpoint
            except Exception:
                pass

            return {"success": True, "rm_code": rm_clean, "sheet_stock": val}
        except (ValueError, TypeError) as e:
            return {"success": False, "error": f"Invalid stock number: {e}"}

    def update_max_qty(self, rm_code: str, new_max_qty: float) -> Dict[str, Any]:
        """Allows ERP team to update Max Qty norms dynamically"""
        rm_clean = (rm_code or "").strip()
        try:
            val = max(1.0, float(new_max_qty))
            self.custom_max_qtys[rm_clean] = val
            return {"success": True, "rm_code": rm_clean, "max_qty": val}
        except (ValueError, TypeError) as e:
            return {"success": False, "error": f"Invalid max qty: {e}"}

    def generate_excel_report(self, customer: str = "AL") -> bytes:
        """
        Generates an Excel (.xlsx) workbook with exact background colors
        applied specifically to the RYG column (RED, YELLOW, GREEN, BLACK, WHITE).
        All other data columns retain clean, neutral styling.
        """
        import io
        import mimetypes
        try:
            mimetypes._mimetypes_read_windows_registry = lambda add_type=None: None
        except Exception:
            pass

        import openpyxl
        from openpyxl.styles import PatternFill, Font, Alignment, Border, Side

        data = self.get_reorder_level_data(customer=customer)
        items = data.get("items", [])
        summary = data.get("summary", {})
        cust_label = data.get("customer", customer)
        display_date = data.get("display_date", datetime.now().strftime("%d-%b-%Y"))

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = f"{cust_label} RM RYG"

        # Color fills specifically for the RYG column
        RYG_STYLES = {
            "RED": {
                "fill": PatternFill(start_color="FFFF0000", end_color="FFFF0000", fill_type="solid"),
                "font": Font(name="Calibri", size=11, bold=True, color="FFFFFFFF")
            },
            "YELLOW": {
                "fill": PatternFill(start_color="FFFFFF00", end_color="FFFFFF00", fill_type="solid"),
                "font": Font(name="Calibri", size=11, bold=True, color="FF000000")
            },
            "GREEN": {
                "fill": PatternFill(start_color="FF00B050", end_color="FF00B050", fill_type="solid"),
                "font": Font(name="Calibri", size=11, bold=True, color="FFFFFFFF")
            },
            "BLACK": {
                "fill": PatternFill(start_color="FF000000", end_color="FF000000", fill_type="solid"),
                "font": Font(name="Calibri", size=11, bold=True, color="FFFFFFFF")
            },
            "WHITE": {
                "fill": PatternFill(start_color="FFFFFFFF", end_color="FFFFFFFF", fill_type="solid"),
                "font": Font(name="Calibri", size=11, bold=True, color="FF000000")
            }
        }

        thin = Side(border_style="thin", color="FFCBD5E1")
        cell_border = Border(left=thin, right=thin, top=thin, bottom=thin)
        thick_top = Side(border_style="medium", color="FF0F172A")
        total_border = Border(left=thin, right=thin, top=thick_top, bottom=thick_top)

        # Title Row
        ws.merge_cells("A1:G1")
        title_cell = ws["A1"]
        title_cell.value = f"{cust_label} RM RYG — Unit 1 (PEPIPL) — {display_date}"
        title_cell.font = Font(name="Calibri", size=14, bold=True, color="FF0F172A")
        title_cell.alignment = Alignment(vertical="center", indent=1)
        ws.row_dimensions[1].height = 28

        # Headers
        headers = ["Sl.No.", "ITEM DESCRIPTIONS", "Max QTY", "SHEET STOCK", "STOCK IN KGS", "STOCK %", "RYG"]
        ws.row_dimensions[3].height = 24
        for col_idx, h in enumerate(headers, 1):
            c = ws.cell(row=3, column=col_idx, value=h)
            c.font = Font(name="Calibri", size=11, bold=True, color="FFFFFFFF")
            c.fill = PatternFill(start_color="FF1E293B", end_color="FF1E293B", fill_type="solid")
            c.alignment = Alignment(horizontal="center", vertical="center")
            c.border = cell_border

        # Main Table Rows
        start_row = 4
        for r_idx, it in enumerate(items, start_row):
            ws.row_dimensions[r_idx].height = 20
            # Sl.No.
            c1 = ws.cell(row=r_idx, column=1, value=it.get("sl_no", r_idx - start_row + 1))
            c1.alignment = Alignment(horizontal="center", vertical="center")
            c1.border = cell_border

            # RM Code / Description
            c2 = ws.cell(row=r_idx, column=2, value=it.get("rm_code", ""))
            c2.font = Font(name="Calibri", size=11, bold=True)
            c2.alignment = Alignment(horizontal="left", vertical="center", indent=1)
            c2.border = cell_border

            # Max Qty
            c3 = ws.cell(row=r_idx, column=3, value=it.get("max_qty", 0))
            c3.number_format = "#,##0"
            c3.alignment = Alignment(horizontal="right", vertical="center")
            c3.border = cell_border

            # Sheet Stock
            c4 = ws.cell(row=r_idx, column=4, value=it.get("sheet_stock", 0))
            c4.number_format = "#,##0"
            c4.alignment = Alignment(horizontal="right", vertical="center")
            c4.border = cell_border

            # Stock in KGS
            c5 = ws.cell(row=r_idx, column=5, value=it.get("stock_in_kgs", 0.0))
            c5.number_format = "#,##0.00"
            c5.alignment = Alignment(horizontal="right", vertical="center")
            c5.border = cell_border

            # Stock %
            c6 = ws.cell(row=r_idx, column=6, value=f"{it.get('ratio_pct', 0.0)}%")
            c6.alignment = Alignment(horizontal="right", vertical="center")
            c6.border = cell_border

            # RYG Status (HIGHLIGHTED COLOR WITH BACKGROUND IN THIS COLUMN ONLY)
            status_val = str(it.get("status", "")).strip().upper()
            c7 = ws.cell(row=r_idx, column=7, value=status_val)
            c7.alignment = Alignment(horizontal="center", vertical="center")
            c7.border = cell_border
            style_cfg = RYG_STYLES.get(status_val, RYG_STYLES["WHITE"])
            c7.fill = style_cfg["fill"]
            c7.font = style_cfg["font"]

        # Totals Row
        tot_row = start_row + len(items)
        ws.row_dimensions[tot_row].height = 24
        ws.cell(row=tot_row, column=1, value="").border = total_border

        c_lbl = ws.cell(row=tot_row, column=2, value="Total")
        c_lbl.font = Font(name="Calibri", size=11, bold=True)
        c_lbl.alignment = Alignment(horizontal="center", vertical="center")
        c_lbl.fill = PatternFill(start_color="FFFEF08A", end_color="FFFEF08A", fill_type="solid")
        c_lbl.border = total_border

        # Max Qty sum
        c_tot_mq = ws.cell(row=tot_row, column=3, value=summary.get("total_max_qty", 0))
        c_tot_mq.number_format = "#,##0"
        c_tot_mq.font = Font(name="Calibri", size=11, bold=True)
        c_tot_mq.alignment = Alignment(horizontal="right", vertical="center")
        c_tot_mq.fill = PatternFill(start_color="FFFEF08A", end_color="FFFEF08A", fill_type="solid")
        c_tot_mq.border = total_border

        # Sheet Stock sum
        c_tot_sh = ws.cell(row=tot_row, column=4, value=summary.get("total_sheet_stock", 0))
        c_tot_sh.number_format = "#,##0"
        c_tot_sh.font = Font(name="Calibri", size=11, bold=True)
        c_tot_sh.alignment = Alignment(horizontal="right", vertical="center")
        c_tot_sh.fill = PatternFill(start_color="FFFEF08A", end_color="FFFEF08A", fill_type="solid")
        c_tot_sh.border = total_border

        # Stock in KGS sum
        c_tot_kg = ws.cell(row=tot_row, column=5, value=summary.get("total_stock_kgs", 0.0))
        c_tot_kg.number_format = "#,##0.00"
        c_tot_kg.font = Font(name="Calibri", size=11, bold=True)
        c_tot_kg.alignment = Alignment(horizontal="right", vertical="center")
        c_tot_kg.fill = PatternFill(start_color="FFFEF08A", end_color="FFFEF08A", fill_type="solid")
        c_tot_kg.border = total_border

        # Overall capacity %
        c_tot_pct = ws.cell(row=tot_row, column=6, value=f"{summary.get('overall_capacity_pct', 0.0)}%")
        c_tot_pct.font = Font(name="Calibri", size=11, bold=True)
        c_tot_pct.alignment = Alignment(horizontal="right", vertical="center")
        c_tot_pct.fill = PatternFill(start_color="FFFEF08A", end_color="FFFEF08A", fill_type="solid")
        c_tot_pct.border = total_border

        ws.cell(row=tot_row, column=7, value="").border = total_border

        # Right-side RYG Distribution Summary (Columns I & J, starting row 3)
        ws.cell(row=3, column=9, value="RYG").font = Font(name="Calibri", size=11, bold=True, color="FFFFFFFF")
        ws.cell(row=3, column=9).fill = PatternFill(start_color="FF1E293B", end_color="FF1E293B", fill_type="solid")
        ws.cell(row=3, column=9).alignment = Alignment(horizontal="center", vertical="center")
        ws.cell(row=3, column=9).border = cell_border

        ws.cell(row=3, column=10, value="Count").font = Font(name="Calibri", size=11, bold=True, color="FFFFFFFF")
        ws.cell(row=3, column=10).fill = PatternFill(start_color="FF1E293B", end_color="FF1E293B", fill_type="solid")
        ws.cell(row=3, column=10).alignment = Alignment(horizontal="center", vertical="center")
        ws.cell(row=3, column=10).border = cell_border

        status_order = ["BLACK", "RED", "YELLOW", "GREEN", "WHITE"]
        for s_idx, st in enumerate(status_order, 4):
            ws.row_dimensions[s_idx].height = 20
            c_s = ws.cell(row=s_idx, column=9, value=st)
            c_s.alignment = Alignment(horizontal="center", vertical="center")
            c_s.border = cell_border
            cfg = RYG_STYLES.get(st, RYG_STYLES["WHITE"])
            c_s.fill = cfg["fill"]
            c_s.font = cfg["font"]

            c_cnt = ws.cell(row=s_idx, column=10, value=summary.get(st, 0))
            c_cnt.alignment = Alignment(horizontal="center", vertical="center")
            c_cnt.font = Font(name="Calibri", size=11, bold=True)
            c_cnt.border = cell_border

        gt_row = 4 + len(status_order)
        c_gt_lbl = ws.cell(row=gt_row, column=9, value="Grand Total")
        c_gt_lbl.font = Font(name="Calibri", size=11, bold=True)
        c_gt_lbl.alignment = Alignment(horizontal="center", vertical="center")
        c_gt_lbl.border = cell_border

        c_gt_val = ws.cell(row=gt_row, column=10, value=summary.get("grand_total", len(items)))
        c_gt_val.font = Font(name="Calibri", size=11, bold=True)
        c_gt_val.alignment = Alignment(horizontal="center", vertical="center")
        c_gt_val.border = cell_border

        # Column widths
        col_widths = {
            "A": 9,
            "B": 26,
            "C": 16,
            "D": 15,
            "E": 17,
            "F": 12,
            "G": 14,
            "H": 4,
            "I": 14,
            "J": 12
        }
        for col_name, width in col_widths.items():
            ws.column_dimensions[col_name].width = width

        buffer = io.BytesIO()
        wb.save(buffer)
        buffer.seek(0)
        return buffer.getvalue()


# Singleton Instance
reorder_level_service = ReorderLevelService()
