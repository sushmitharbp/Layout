"""
SheetLayout AI — ERP, Stock & MRP Intelligence Service
Parses and indexes:
1. ERP Entry - 2.xlsx -> MO Report (Previous MOs created for parts)
2. Unit 1 - Daily Stock Report 27.09.26.xlsx -> MAIN STORE (RM Opening Stock)
3. Unit 1 - Daily Stock Report 27.09.26.xlsx -> 002 - FG & WIP (Parts Opening Stock)
4. MRP - AL - Sep'26 Schedule.xlsx -> Schedule given by Sales & RM sheet BOM (Monthly Schedule)
"""

import os
import re
import json
import glob
import time
import openpyxl

CACHE_FILE = "erp_stock_cache.json"

def norm_key(s):
    if not s: return ""
    return re.sub(r'[^a-zA-Z0-9]', '', str(s)).lower()

class ERPStockService:
    def __init__(self, auto_load=True):
        self.previous_mos = {}      # norm_key(part) -> [MO records]
        self.previous_mos_by_rm = {} # norm_key(rm) -> [MO records]
        self.rm_stock = {}          # norm_key(rm) -> stock info dict
        self.rm_stock_list = []     # all RM sheet items
        self.parts_stock = {}       # norm_key(part) -> stock info dict
        self.mrp_schedule = {}      # norm_key(part) -> schedule dict
        self.stats = {}

        if auto_load:
            self.load()

    def load(self):
        if os.path.exists(CACHE_FILE):
            try:
                start_t = time.time()
                with open(CACHE_FILE, "r", encoding="utf-8") as f:
                    cached = json.load(f)
                self.previous_mos = cached.get("previous_mos", {})
                self.previous_mos_by_rm = cached.get("previous_mos_by_rm", {})
                self.rm_stock = cached.get("rm_stock", {})
                self.rm_stock_list = cached.get("rm_stock_list", [])
                self.parts_stock = cached.get("parts_stock", {})
                self.mrp_schedule = cached.get("mrp_schedule", {})
                self.stats = cached.get("stats", {})
                print(f"[ERP & Stock Intelligence] Loaded cache in {time.time()-start_t:.2f}s: {len(self.previous_mos)} parts with past MOs, {len(self.rm_stock)} RM items, {len(self.parts_stock)} FG/WIP parts, {len(self.mrp_schedule)} MRP parts.")
                return
            except Exception as e:
                print(f"[ERP & Stock Intelligence] Error reading cache: {e}. Rebuilding...")

        self.rebuild_cache()

    def rebuild_cache(self):
        print("[ERP & Stock Intelligence] Parsing Excel workbooks...")
        start_t = time.time()

        # 1. Parse ERP Entry - 2.xlsx -> MO Report
        self._parse_mo_report()

        # 2. Parse Unit 1 Daily Stock -> MAIN STORE & 002 - FG & WIP
        self._parse_stock_report()

        # 3. Parse MRP -> Schedule given by Sales & RM sheet BOM
        self._parse_mrp_report()

        self.stats = {
            "total_mo_parts": len(self.previous_mos),
            "total_rm_stock_items": len(self.rm_stock),
            "total_fg_wip_parts": len(self.parts_stock),
            "total_mrp_parts": len(self.mrp_schedule),
            "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ")
        }

        # Save cache
        try:
            with open(CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump({
                    "previous_mos": self.previous_mos,
                    "previous_mos_by_rm": self.previous_mos_by_rm,
                    "rm_stock": self.rm_stock,
                    "rm_stock_list": self.rm_stock_list,
                    "parts_stock": self.parts_stock,
                    "mrp_schedule": self.mrp_schedule,
                    "stats": self.stats
                }, f, indent=2)
            print(f"[ERP & Stock Intelligence] Cache built and saved in {time.time()-start_t:.2f}s!")
        except Exception as e:
            print(f"[ERP & Stock Intelligence] Failed to save cache: {e}")

    def _parse_mo_report(self):
        files = glob.glob("*ERP Entry*.xlsx")
        if not files:
            print("ERP Entry file not found.")
            return

        file_path = files[0]
        try:
            wb = openpyxl.load_workbook(file_path, read_only=True)
            if "MO Report" not in wb.sheetnames:
                return
            ws = wb["MO Report"]

            for idx, r in enumerate(ws.iter_rows(values_only=True)):
                if idx == 0 or not r or len(r) < 16:
                    continue

                doc_no = str(r[0] or "").strip()
                if not doc_no or doc_no == "Doc Date":
                    continue

                doc_date = str(r[1] or "").split(" ")[0]
                status = str(r[2] or "").strip()
                cutting_order_no = str(r[3] or "").strip()
                rm_code = str(r[5] or "").strip()
                rm_desc = str(r[6] or "").strip()
                no_of_sheets = r[8] if len(r) > 8 and isinstance(r[8], (int, float)) else None
                cutting_plan_no = str(r[13] or "").strip() if len(r) > 13 else ""
                parent_code = str(r[14] or "").strip() if len(r) > 14 else ""
                parent_desc = str(r[15] or "").strip() if len(r) > 15 else ""
                parent_qty_per_sheet = r[17] if len(r) > 17 and isinstance(r[17], (int, float)) else None
                total_parent_qty = r[18] if len(r) > 18 and isinstance(r[18], (int, float)) else None
                rm_weight = r[19] if len(r) > 19 and isinstance(r[19], (int, float)) else None

                entry = {
                    "mo_doc_no": doc_no,
                    "doc_date": doc_date,
                    "status": status,
                    "cutting_order_no": cutting_order_no,
                    "rm_code": rm_code,
                    "rm_desc": rm_desc,
                    "no_of_sheets": no_of_sheets,
                    "cutting_plan_no": cutting_plan_no,
                    "parent_code": parent_code,
                    "parent_desc": parent_desc,
                    "parent_qty_per_sheet": parent_qty_per_sheet,
                    "total_parent_qty": total_parent_qty,
                    "rm_weight": rm_weight
                }

                # Index by parent code
                k_parent = norm_key(parent_code)
                if k_parent:
                    if k_parent not in self.previous_mos:
                        self.previous_mos[k_parent] = []
                    self.previous_mos[k_parent].append(entry)

                # Index by base prefix if hyphenated (e.g. MBA01010)
                base_cand = parent_code.split("-")[0].strip() if "-" in parent_code else ""
                if base_cand and len(base_cand) >= 4:
                    k_base = norm_key(base_cand)
                    if k_base != k_parent:
                        if k_base not in self.previous_mos:
                            self.previous_mos[k_base] = []
                        self.previous_mos[k_base].append(entry)

                # Index by RM code
                k_rm = norm_key(rm_code)
                if k_rm:
                    if k_rm not in self.previous_mos_by_rm:
                        self.previous_mos_by_rm[k_rm] = []
                    self.previous_mos_by_rm[k_rm].append(entry)

        except Exception as e:
            print(f"Error parsing MO Report: {e}")

    def _parse_stock_report(self):
        files = glob.glob("*Stock*.xlsx")
        if not files:
            print("Daily Stock Report file not found.")
            return

        file_path = files[0]
        try:
            wb = openpyxl.load_workbook(file_path, read_only=True)

            # A. MAIN STORE (RM Sheet Opening Stock)
            if "MAIN STORE" in wb.sheetnames:
                ws_ms = wb["MAIN STORE"]
                for idx, r in enumerate(ws_ms.iter_rows(values_only=True)):
                    if idx == 0 or not r or len(r) < 6:
                        continue
                    item_code = str(r[0] or "").strip()
                    item_desc = str(r[1] or "").strip()
                    uom = str(r[2] or "").strip()
                    store_desc = str(r[3] or "").strip()
                    onhand = float(r[4]) if r[4] is not None and isinstance(r[4], (int, float)) else 0.0
                    category = str(r[5] or "").strip()
                    weight = float(r[6]) if len(r) > 6 and isinstance(r[6], (int, float)) else None
                    total_weight = float(r[7]) if len(r) > 7 and isinstance(r[7], (int, float)) else None
                    std_cost = float(r[8]) if len(r) > 8 and isinstance(r[8], (int, float)) else None
                    last_po_price = float(r[9]) if len(r) > 9 and isinstance(r[9], (int, float)) else None
                    stock_val = float(r[10]) if len(r) > 10 and isinstance(r[10], (int, float)) else None

                    stock_entry = {
                        "item_code": item_code,
                        "item_desc": item_desc,
                        "uom": uom,
                        "store": store_desc or "MAIN STORES",
                        "onhand_stock": onhand,
                        "category": category,
                        "weight": weight,
                        "total_weight": total_weight,
                        "std_cost": std_cost,
                        "last_po_price": last_po_price,
                        "stock_value": stock_val
                    }

                    k_item = norm_key(item_code)
                    if k_item:
                        self.rm_stock[k_item] = stock_entry

                    # Store in rm_stock_list for dimension searches
                    if "SHEET" in item_desc.upper() or any(g in item_code for g in ["BSK", "YS", "CR", "HR", "SAIL"]):
                        self.rm_stock_list.append(stock_entry)

            # B. 002 - FG & WIP (Parts Opening Stock)
            if "002 - FG & WIP" in wb.sheetnames:
                ws_fg = wb["002 - FG & WIP"]
                for idx, r in enumerate(ws_fg.iter_rows(values_only=True)):
                    if idx == 0 or not r or len(r) < 6:
                        continue
                    item_code = str(r[0] or "").strip()
                    item_desc = str(r[1] or "").strip()
                    uom = str(r[2] or "").strip()
                    store_desc = str(r[3] or "").strip()
                    onhand = float(r[4]) if r[4] is not None and isinstance(r[4], (int, float)) else 0.0
                    category = str(r[5] or "").strip()
                    weight = float(r[6]) if len(r) > 6 and isinstance(r[6], (int, float)) else None
                    total_weight = float(r[7]) if len(r) > 7 and isinstance(r[7], (int, float)) else None
                    std_cost = float(r[8]) if len(r) > 8 and isinstance(r[8], (int, float)) else None
                    stock_val = float(r[9]) if len(r) > 9 and isinstance(r[9], (int, float)) else None

                    part_stock_entry = {
                        "item_code": item_code,
                        "item_desc": item_desc,
                        "uom": uom,
                        "store": store_desc or "FG & WIP STORES",
                        "onhand_stock": onhand,
                        "category": category,
                        "weight": weight,
                        "total_weight": total_weight,
                        "std_cost": std_cost,
                        "stock_value": stock_val
                    }

                    k_part = norm_key(item_code)
                    if k_part:
                        if k_part not in self.parts_stock:
                            self.parts_stock[k_part] = []
                        self.parts_stock[k_part].append(part_stock_entry)

                    # Also index base part prefix
                    base_cand = item_code.split("-")[0].split("_")[0].strip()
                    if base_cand and len(base_cand) >= 4:
                        k_base = norm_key(base_cand)
                        if k_base != k_part:
                            if k_base not in self.parts_stock:
                                self.parts_stock[k_base] = []
                            self.parts_stock[k_base].append(part_stock_entry)

        except Exception as e:
            print(f"Error parsing Stock Report: {e}")

    def _parse_mrp_report(self):
        files = glob.glob("*MRP*.xlsx")
        if not files:
            print("MRP file not found.")
            return

        file_path = files[0]
        try:
            wb = openpyxl.load_workbook(file_path, data_only=True)

            # A. Schedule given by Sales (Monthly Demand Schedule)
            sales_sched = {}
            if "Schedule given by Sales" in wb.sheetnames:
                ws_s = wb["Schedule given by Sales"]
                for idx, r in enumerate(ws_s.iter_rows(values_only=True)):
                    if idx == 0 or not r or len(r) < 9:
                        continue
                    part_no = str(r[1] or "").strip()
                    if not part_no: continue

                    total_qty = float(r[8]) if isinstance(r[8], (int, float)) else 0.0
                    wk1 = float(r[3]) if len(r) > 3 and isinstance(r[3], (int, float)) else 0.0
                    wk2 = float(r[4]) if len(r) > 4 and isinstance(r[4], (int, float)) else 0.0
                    wk3 = float(r[5]) if len(r) > 5 and isinstance(r[5], (int, float)) else 0.0
                    wk4 = float(r[6]) if len(r) > 6 and isinstance(r[6], (int, float)) else 0.0
                    wk5 = float(r[7]) if len(r) > 7 and isinstance(r[7], (int, float)) else 0.0
                    fg_stock = float(r[9]) if len(r) > 9 and isinstance(r[9], (int, float)) else 0.0
                    bal_plan = float(r[12]) if len(r) > 12 and isinstance(r[12], (int, float)) else None

                    sales_sched[norm_key(part_no)] = {
                        "part_no": part_no,
                        "monthly_total": total_qty,
                        "wk1": wk1, "wk2": wk2, "wk3": wk3, "wk4": wk4, "wk5": wk5,
                        "fg_pc_stock": fg_stock,
                        "balance_planning": bal_plan
                    }

            # B. RM sheet BOM (Child Part specifications & Scope)
            if "RM sheet BOM" in wb.sheetnames:
                ws_b = wb["RM sheet BOM"]
                for idx, r in enumerate(ws_b.iter_rows(values_only=True)):
                    if idx == 0 or not r or len(r) < 11:
                        continue
                    parent_part = str(r[1] or "").strip()
                    child_part = str(r[2] or "").strip()
                    erp_part = str(r[4] or "").strip()
                    scope = str(r[5] or "").strip()
                    offtake = float(r[6]) if isinstance(r[6], (int, float)) else 1.0
                    grade = str(r[7] or "").strip()
                    blank_l = float(r[8]) if isinstance(r[8], (int, float)) else None
                    blank_w = float(r[9]) if isinstance(r[9], (int, float)) else None
                    blank_t = float(r[10]) if isinstance(r[10], (int, float)) else None
                    blank_wt = float(r[11]) if len(r) > 11 and isinstance(r[11], (int, float)) else None

                    sheet_l = float(r[12]) if len(r) > 12 and isinstance(r[12], (int, float)) else None
                    sheet_w = float(r[13]) if len(r) > 13 and isinstance(r[13], (int, float)) else None
                    sheet_t = float(r[14]) if len(r) > 14 and isinstance(r[14], (int, float)) else None
                    sheet_wt = float(r[15]) if len(r) > 15 and isinstance(r[15], (int, float)) else None

                    k_parent = norm_key(parent_part)
                    sched_info = sales_sched.get(k_parent, {})

                    entry = {
                        "parent_part": parent_part,
                        "child_part": child_part,
                        "erp_part": erp_part,
                        "scope": "Inhouse (IH)" if scope == "IH" else "Outsource (OS)" if scope == "OS" else scope,
                        "offtake": offtake,
                        "grade": grade,
                        "blank_size": {"length": blank_l, "width": blank_w, "thickness": blank_t, "weight": blank_wt},
                        "sheet_size": {"length": sheet_l, "width": sheet_w, "thickness": sheet_t, "weight": sheet_wt},
                        "monthly_schedule": sched_info
                    }

                    if k_parent:
                        if k_parent not in self.mrp_schedule:
                            self.mrp_schedule[k_parent] = []
                        self.mrp_schedule[k_parent].append(entry)

                    if erp_part and erp_part != "-":
                        k_erp = norm_key(erp_part)
                        if k_erp not in self.mrp_schedule:
                            self.mrp_schedule[k_erp] = []
                        self.mrp_schedule[k_erp].append(entry)

            # C. Ensure all parts from Sales Schedule are in mrp_schedule
            for k_part, s_info in sales_sched.items():
                if k_part not in self.mrp_schedule:
                    self.mrp_schedule[k_part] = [{
                        "parent_part": s_info["part_no"],
                        "child_part": "Assembly / Part",
                        "erp_part": s_info["part_no"],
                        "scope": "Sales Schedule",
                        "offtake": 1.0,
                        "grade": "",
                        "blank_size": {},
                        "sheet_size": {},
                        "monthly_schedule": s_info
                    }]

        except Exception as e:
            print(f"Error parsing MRP: {e}")

    # Query APIs
    def get_previous_mos(self, part_no, rm_code=None):
        """Find previous MOs for part number or RM code"""
        q_norm = norm_key(part_no)
        results = []
        seen_docs = set()

        # 1. Exact or partial match in previous_mos
        for k, mos in self.previous_mos.items():
            if q_norm and (q_norm in k or k in q_norm):
                for m in mos:
                    if m["mo_doc_no"] not in seen_docs:
                        seen_docs.add(m["mo_doc_no"])
                        results.append(m)

        # 2. Check by RM code
        if rm_code:
            rm_norm = norm_key(rm_code)
            for k, mos in self.previous_mos_by_rm.items():
                if rm_norm in k or k in rm_norm:
                    for m in mos:
                        if m["mo_doc_no"] not in seen_docs:
                            seen_docs.add(m["mo_doc_no"])
                            results.append(m)

        # Sort by doc_date desc
        results.sort(key=lambda x: str(x.get("doc_date") or ""), reverse=True)
        return results[:15]

    def get_rm_opening_stock(self, rm_code, grade=None, thickness=None, length=None, width=None):
        """Find RM opening stock in MAIN STORE"""
        rm_norm = norm_key(rm_code)
        
        # Direct key match
        if rm_norm in self.rm_stock:
            return self.rm_stock[rm_norm]

        # Substring search in rm_stock
        for k, stock in self.rm_stock.items():
            if rm_norm in k or k in rm_norm:
                return stock

        # Search by dimensions in rm_stock_list
        if thickness and length and width:
            t_str = str(thickness).rstrip(".0")
            l_str = str(int(length)) if str(length).endswith(".0") else str(length)
            w_str = str(int(width)) if str(width).endswith(".0") else str(width)

            for s in self.rm_stock_list:
                desc = s.get("item_desc", "")
                if t_str in desc and l_str in desc and w_str in desc:
                    if grade and grade.upper() in desc.upper():
                        return s
                    return s

        return None

    def get_parts_opening_stock(self, part_no):
        """Find finished goods & WIP opening stock in 002 - FG & WIP"""
        q_norm = norm_key(part_no)
        matches = []
        seen = set()

        for k, items in self.parts_stock.items():
            if q_norm and (q_norm in k or k in q_norm):
                for it in items:
                    c = it["item_code"]
                    if c not in seen:
                        seen.add(c)
                        matches.append(it)

        return matches[:10]

    def get_mrp_monthly_schedule(self, part_no):
        """Find monthly schedule and BOM from MRP"""
        q_norm = norm_key(part_no)
        for k, bom_items in self.mrp_schedule.items():
            if q_norm and (q_norm in k or k in q_norm):
                return bom_items
        return []

    def get_part_comprehensive_intelligence(self, part_no, rm_code=None, grade=None, thickness=None, length=None, width=None, sheets_needed=1):
        """Aggregate all 4 data sources into one unified intelligence payload"""
        rm_stock_info = self.get_rm_opening_stock(rm_code, grade=grade, thickness=thickness, length=length, width=width)
        fg_wip_stock = self.get_parts_opening_stock(part_no)
        previous_mos = self.get_previous_mos(part_no, rm_code=rm_code)
        mrp_sched = self.get_mrp_monthly_schedule(part_no)

        # Stock Feasibility Evaluation
        onhand_sheets = rm_stock_info.get("onhand_stock", 0) if rm_stock_info else 0
        stock_sufficient = (onhand_sheets >= float(sheets_needed)) if (rm_stock_info and onhand_sheets > 0) else False

        return {
            "part_no": part_no,
            "rm_code": rm_code,
            "rm_opening_stock": rm_stock_info,
            "stock_feasibility": {
                "sheets_needed": float(sheets_needed),
                "sheets_onhand": onhand_sheets,
                "is_sufficient": stock_sufficient,
                "shortfall": max(0, float(sheets_needed) - onhand_sheets)
            },
            "parts_opening_stock": {
                "items": fg_wip_stock,
                "total_onhand_qty": sum(it.get("onhand_stock", 0) for it in fg_wip_stock)
            },
            "mrp_schedule": {
                "items": mrp_sched,
                "monthly_total": mrp_sched[0].get("monthly_schedule", {}).get("monthly_total") if mrp_sched else None,
                "weekly_breakdown": {
                    "wk1": mrp_sched[0].get("monthly_schedule", {}).get("wk1") if mrp_sched else 0,
                    "wk2": mrp_sched[0].get("monthly_schedule", {}).get("wk2") if mrp_sched else 0,
                    "wk3": mrp_sched[0].get("monthly_schedule", {}).get("wk3") if mrp_sched else 0,
                    "wk4": mrp_sched[0].get("monthly_schedule", {}).get("wk4") if mrp_sched else 0,
                    "wk5": mrp_sched[0].get("monthly_schedule", {}).get("wk5") if mrp_sched else 0,
                } if mrp_sched else None
            },
            "previous_mos": {
                "records": previous_mos,
                "total_found": len(previous_mos)
            }
        }

if __name__ == "__main__":
    service = ERPStockService(auto_load=False)
    service.rebuild_cache()

    # Test queries
    print("\n--- Test 1: Previous MOs for MBA01010 ---")
    mos = service.get_previous_mos("MBA01010")
    for m in mos[:3]:
        print(f"MO: {m['mo_doc_no']} | Date: {m['doc_date']} | Status: {m['status']} | Sheets: {m['no_of_sheets']} | Parent: {m['parent_code']}")

    print("\n--- Test 2: RM Stock for BSK-4.8-2500-1500 ---")
    st = service.get_rm_opening_stock("BSK-4.8-2500-1500")
    print(st)

    print("\n--- Test 3: Parts FG/WIP Stock for MBA01010 ---")
    fg = service.get_parts_opening_stock("MBA01010")
    print(fg)

    print("\n--- Test 4: MRP Schedule for 113322VE1A ---")
    mrp = service.get_mrp_monthly_schedule("113322VE1A")
    print(mrp)
