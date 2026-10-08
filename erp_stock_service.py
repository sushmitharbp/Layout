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
import requests
try:
    import openpyxl
except (ImportError, ModuleNotFoundError):
    openpyxl = None
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY") or os.getenv("SUPABASE_ANON_KEY")

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

            # RM sheet BOM (Master Table with Parent Schedule, Child Item Offtake, Total Qty, and Planning Balances)
            if "RM sheet BOM" in wb.sheetnames:
                ws_b = wb["RM sheet BOM"]
                for idx, r in enumerate(ws_b.iter_rows(values_only=True)):
                    if idx == 0 or not r or len(r) < 3 or not r[1]:
                        continue
                    parent_part = str(r[1] or "").strip()
                    if not parent_part or parent_part.lower() == "part no":
                        continue

                    sl_no = r[0] if isinstance(r[0], (int, float)) else idx
                    child_part = str(r[2] or "").strip() if len(r) > 2 else ""
                    os_part = str(r[3] or "").strip() if len(r) > 3 and str(r[3]).strip() != "-" else ""
                    erp_part = str(r[4] or "").strip() if len(r) > 4 and str(r[4]).strip() != "-" else ""
                    scope = str(r[5] or "").strip() if len(r) > 5 else ""
                    offtake = float(r[6]) if len(r) > 6 and isinstance(r[6], (int, float)) else 1.0
                    grade = str(r[7] or "").strip() if len(r) > 7 else ""

                    blank_l = float(r[8]) if len(r) > 8 and isinstance(r[8], (int, float)) else None
                    blank_w = float(r[9]) if len(r) > 9 and isinstance(r[9], (int, float)) else None
                    blank_t = float(r[10]) if len(r) > 10 and isinstance(r[10], (int, float)) else None
                    blank_wt = float(r[11]) if len(r) > 11 and isinstance(r[11], (int, float)) else None

                    sheet_l = float(r[12]) if len(r) > 12 and isinstance(r[12], (int, float)) else None
                    sheet_w = float(r[13]) if len(r) > 13 and isinstance(r[13], (int, float)) else None
                    sheet_t = float(r[14]) if len(r) > 14 and isinstance(r[14], (int, float)) else blank_t
                    sheet_wt = float(r[15]) if len(r) > 15 and isinstance(r[15], (int, float)) else None

                    sheet_used = str(r[16] or "").strip() if len(r) > 16 and str(r[16]).strip() != "-" else ""
                    compt_sheet = float(r[17]) if len(r) > 17 and isinstance(r[17], (int, float)) else None

                    sched_qty = float(r[18]) if len(r) > 18 and isinstance(r[18], (int, float)) else None
                    total_qty = float(r[19]) if len(r) > 19 and isinstance(r[19], (int, float)) else (sched_qty * offtake if sched_qty is not None else None)
                    inhouse_qty = float(r[20]) if len(r) > 20 and isinstance(r[20], (int, float)) else 0.0
                    outsource_qty = float(r[21]) if len(r) > 21 and isinstance(r[21], (int, float)) else 0.0
                    bal_qty = float(r[22]) if len(r) > 22 and isinstance(r[22], (int, float)) else None

                    sheet_working = float(r[23]) if len(r) > 23 and isinstance(r[23], (int, float)) else None
                    no_sheets = float(r[24]) if len(r) > 24 and isinstance(r[24], (int, float)) else None
                    total_weight = float(r[25]) if len(r) > 25 and isinstance(r[25], (int, float)) else None

                    remarks_1 = str(r[26] or "").strip() if len(r) > 26 and str(r[26]).strip() != "-" else ""
                    remarks_2 = str(r[27] or "").strip() if len(r) > 27 and str(r[27]).strip() != "-" else ""

                    entry = {
                        "sl_no": sl_no,
                        "parent_part": parent_part,
                        "child_part": child_part,
                        "os_part": os_part,
                        "erp_part": erp_part,
                        "scope": "Inhouse (IH)" if scope == "IH" else "Outsource (OS)" if scope == "OS" else scope,
                        "offtake": offtake,
                        "grade": grade,
                        "blank_size": {"length": blank_l, "width": blank_w, "thickness": blank_t, "weight": blank_wt},
                        "sheet_size": {"length": sheet_l, "width": sheet_w, "thickness": sheet_t, "weight": sheet_wt},
                        "existing_sheet_used": sheet_used,
                        "components_per_sheet": compt_sheet,
                        "schedule_qty": sched_qty,
                        "total_qty": total_qty,
                        "inhouse_erp_qty": inhouse_qty,
                        "outsource_erp_qty": outsource_qty,
                        "balance_qty": bal_qty,
                        "sheet_working": sheet_working,
                        "no_of_sheets": no_sheets,
                        "total_sheet_weight": total_weight,
                        "remarks": remarks_1 or remarks_2,
                        "remarks_2": remarks_2,
                        "monthly_schedule": {
                            "part_no": parent_part,
                            "child_part": child_part,
                            "monthly_total": total_qty,
                            "schedule_qty": sched_qty,
                            "offtake": offtake,
                            "fg_pc_stock": inhouse_qty,
                            "balance_planning": bal_qty,
                            "existing_sheet_used": sheet_used,
                            "components_per_sheet": compt_sheet,
                            "no_of_sheets": no_sheets
                        }
                    }

                    k_parent = norm_key(parent_part)
                    if k_parent:
                        if k_parent not in self.mrp_schedule:
                            self.mrp_schedule[k_parent] = []
                        self.mrp_schedule[k_parent].append(entry)

                    if erp_part:
                        k_erp = norm_key(erp_part)
                        if k_erp not in self.mrp_schedule:
                            self.mrp_schedule[k_erp] = []
                        self.mrp_schedule[k_erp].append(entry)

        except Exception as e:
            print(f"Error parsing MRP: {e}")

    # Helper methods for parent and child matching in ERP MO Reports
    @staticmethod
    def _extract_child_item_num(text):
        if not text:
            return None
        m = re.search(r'(?:ITM(?:_NO)?\.?|ITEM|ITME)[ _]*0*(\d+)', str(text), re.IGNORECASE)
        if m:
            return int(m.group(1))
        m2 = re.search(r'item\s*0*(\d+)', str(text), re.IGNORECASE)
        if m2:
            return int(m2.group(1))
        return None

    @classmethod
    def _match_parent_and_child(cls, record_parent_code, target_parent, target_child_num):
        if not record_parent_code or not target_parent:
            return False
        rpc = str(record_parent_code).strip()
        tp = norm_key(target_parent)
        tokens = [norm_key(t) for t in re.split(r'[-_ ]+', rpc)]
        parent_matches = (tp in tokens) or any(t.startswith(tp) or tp.startswith(t) for t in tokens if len(t) >= 5)
        if not parent_matches:
            return False
        if target_child_num is not None:
            rec_child_num = cls._extract_child_item_num(rpc)
            return rec_child_num == target_child_num
        return True

    def get_monthly_mo_produced(self, part_no, target_month=None, child_item_str=None):
        """
        Calculates already MO produced quantity from erp_mo_reports table for that particular month.
        Filters by target_month (e.g. '2026-09'), matches parent code, splits child code,
        and sums total_parent_qty if there are one or more MOs.
        """
        if not part_no:
            return 0.0, []

        if not target_month:
            target_month = "2026-09"

        part_str = str(part_no).strip()
        m_child = re.search(r'^(.*?)\s*[-_]\s*(item\s*\d+[a-zA-Z]?.*)$', part_str, re.IGNORECASE)
        if m_child:
            parent_part = m_child.group(1).strip()
            child_tag = m_child.group(2).strip()
        else:
            parent_part = part_str.split(" - ")[0].split("-Item")[0].strip()
            child_tag = part_str[len(parent_part):].strip(" -_")

        if not child_tag and child_item_str:
            child_tag = str(child_item_str).strip()

        target_child_num = self._extract_child_item_num(child_tag)

        matching_mos = []
        seen_docs = set()

        # 1. Query Supabase erp_mo_reports live
        if SUPABASE_URL and SUPABASE_KEY:
            try:
                month_start = f"{target_month}-01"
                month_end = f"{target_month}-31"
                base_p = parent_part.split("-")[0].strip()

                url = (
                    f"{SUPABASE_URL}/rest/v1/erp_mo_reports?"
                    f"doc_date=gte.{month_start}&doc_date=lte.{month_end}&parent_code=ilike.*{base_p}*&"
                    f"select=mo_doc_no,doc_date,order_status,rm_code,rm_desc,cutting_plan_no,parent_code,parent_desc,parent_qty_per_sheet,total_parent_qty,number_of_sheets"
                )
                res = requests.get(url, headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}, timeout=3)
                if res.status_code == 200:
                    for r in res.json():
                        p_code = r.get("parent_code")
                        if self._match_parent_and_child(p_code, parent_part, target_child_num):
                            doc_no = r.get("mo_doc_no")
                            dedup_key = (doc_no, p_code) if doc_no else id(r)
                            if dedup_key not in seen_docs:
                                seen_docs.add(dedup_key)
                                matching_mos.append({
                                    "mo_doc_no": doc_no,
                                    "doc_date": r.get("doc_date"),
                                    "status": r.get("order_status"),
                                    "parent_code": p_code,
                                    "parent_desc": r.get("parent_desc"),
                                    "qty": float(r.get("total_parent_qty") or 0),
                                    "no_of_sheets": r.get("number_of_sheets")
                                })
            except Exception as e:
                print(f"[ERP Stock Service] Error fetching live monthly MOs: {e}")

        # 2. Local fallback if live returned empty
        if not matching_mos:
            p_norm = norm_key(parent_part)
            cached_mos = self.previous_mos.get(p_norm, [])
            for m in cached_mos:
                d_date = str(m.get("doc_date") or "")
                if d_date.startswith(target_month):
                    p_code = m.get("parent_code")
                    if self._match_parent_and_child(p_code, parent_part, target_child_num):
                        doc_no = m.get("mo_doc_no")
                        dedup_key = (doc_no, p_code) if doc_no else id(m)
                        if dedup_key not in seen_docs:
                            seen_docs.add(dedup_key)
                            matching_mos.append({
                                "mo_doc_no": doc_no,
                                "doc_date": d_date,
                                "status": m.get("status"),
                                "parent_code": p_code,
                                "parent_desc": m.get("parent_desc"),
                                "qty": float(m.get("total_parent_qty") or 0),
                                "no_of_sheets": m.get("no_of_sheets")
                            })

        total_mo_qty = sum(m["qty"] for m in matching_mos)
        return total_mo_qty, matching_mos

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
        """Find RM opening stock in MAIN STORE with live Supabase query"""
        rm_norm = norm_key(rm_code)
        stock_item = None
        
        # Direct key match
        if rm_norm in self.rm_stock:
            stock_item = self.rm_stock[rm_norm]

        # Substring search in rm_stock
        if not stock_item:
            for k, stock in self.rm_stock.items():
                if rm_norm in k or k in rm_norm:
                    stock_item = stock
                    break

        # Search by dimensions in rm_stock_list
        if not stock_item and thickness and length and width:
            t_str = str(thickness).rstrip(".0")
            l_str = str(int(length)) if str(length).endswith(".0") else str(length)
            w_str = str(int(width)) if str(width).endswith(".0") else str(width)

            for s in self.rm_stock_list:
                desc = s.get("item_desc", "")
                if t_str in desc and l_str in desc and w_str in desc:
                    if grade and grade.upper() in desc.upper():
                        stock_item = s
                        break
                    if not stock_item:
                        stock_item = s

        # Query live Supabase PostgreSQL stock to ensure 100% real-time accuracy!
        if stock_item and SUPABASE_URL and SUPABASE_KEY:
            try:
                c = stock_item.get("item_code")
                res = requests.get(
                    f"{SUPABASE_URL}/rest/v1/rm_main_store_stock?item_code=eq.{c}&select=onhand_stock,total_weight",
                    headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"},
                    timeout=2
                )
                if res.status_code == 200 and res.json():
                    stock_item = dict(stock_item)
                    stock_item["onhand_stock"] = float(res.json()[0]["onhand_stock"])
                    if "total_weight" in res.json()[0] and res.json()[0]["total_weight"] is not None:
                        stock_item["total_weight"] = float(res.json()[0]["total_weight"])
            except Exception:
                pass

        return stock_item

    def deduct_rm_stock_in_memory(self, rm_code, sheets, item_code=None):
        """Immediately deduct sheets from in-memory RM stock cache."""
        try:
            sheets = float(sheets or 0)
            if sheets <= 0:
                return
            rm_norm = norm_key(rm_code)
            code_norm = norm_key(item_code) if item_code else ""

            # Update rm_stock dictionary
            for k in [rm_norm, code_norm]:
                if k and k in self.rm_stock:
                    cur = float(self.rm_stock[k].get("onhand_stock") or 0)
                    self.rm_stock[k]["onhand_stock"] = max(0.0, cur - sheets)

            # Update rm_stock_list
            for it in self.rm_stock_list:
                c = it.get("item_code", "")
                d = it.get("item_desc", "")
                if (item_code and c == item_code) or (rm_code and (rm_code in c or rm_code in d)):
                    cur = float(it.get("onhand_stock") or 0)
                    it["onhand_stock"] = max(0.0, cur - sheets)
            print(f"[ERP Stock Cache] In-memory RM stock deducted: -{sheets} sheets for {rm_code or item_code}")
        except Exception as e:
            print(f"[ERP Stock Cache] Error in deduct_rm_stock_in_memory: {e}")

    def add_parts_stock_in_memory(self, part_no, qty, item_code=None):
        """Immediately increment finished goods / WIP parts in-memory stock cache."""
        try:
            qty = float(qty or 0)
            if qty <= 0:
                return
            q_norm = norm_key(part_no)
            code_norm = norm_key(item_code) if item_code else ""

            for k in [q_norm, code_norm]:
                if k and k in self.parts_stock:
                    for it in self.parts_stock[k]:
                        cur = float(it.get("onhand_stock") or 0)
                        it["onhand_stock"] = cur + qty
            print(f"[ERP Stock Cache] In-memory FG stock credited: +{qty} units for {part_no or item_code}")
        except Exception as e:
            print(f"[ERP Stock Cache] Error in add_parts_stock_in_memory: {e}")

    def get_parts_opening_stock(self, part_no):
        """Find finished goods & WIP opening stock in 002 - FG & WIP with live Supabase values"""
        q_norm = norm_key(part_no)
        matches = []
        seen = set()

        for k, items in self.parts_stock.items():
            if q_norm and (q_norm in k or k in q_norm):
                for it in items:
                    c = it["item_code"]
                    if c not in seen:
                        seen.add(c)
                        matches.append(dict(it))

        # Query live Supabase stock for matched items
        if matches and SUPABASE_URL and SUPABASE_KEY:
            try:
                codes = [it["item_code"] for it in matches[:8]]
                or_clause = ",".join([f"item_code.eq.{c}" for c in codes])
                res = requests.get(
                    f"{SUPABASE_URL}/rest/v1/parts_fg_wip_stock?or=({or_clause})&select=item_code,onhand_stock",
                    headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"},
                    timeout=2
                )
                if res.status_code == 200:
                    live_map = {r["item_code"]: float(r["onhand_stock"]) for r in res.json()}
                    for it in matches:
                        if it["item_code"] in live_map:
                            it["onhand_stock"] = live_map[it["item_code"]]
            except Exception:
                pass

        return matches[:10]

    def get_mrp_monthly_schedule(self, part_no):
        """Find monthly schedule and BOM from mrp_rm_sheet_bom for the particular child item of the parent."""
        if not part_no:
            return []

        part_str = str(part_no).strip()
        m_child = re.search(r'^(.*?)\s*[-_]\s*(item\s*\d+[a-zA-Z]?.*)$', part_str, re.IGNORECASE)
        if m_child:
            parent_part = m_child.group(1).strip()
            child_tag = m_child.group(2).strip()
        else:
            parent_part = part_str.split(" - ")[0].split("-Item")[0].strip()
            child_tag = part_str[len(parent_part):].strip(" -_")

        p_norm = norm_key(parent_part)
        c_norm = norm_key(child_tag)

        # Extract numeric index if any (e.g. 'Item 2' -> 2, which matches 'Item 02' and 'Item 2')
        item_num_m = re.search(r'item\s*(\d+)', child_tag, re.IGNORECASE) or re.search(r'(\d+)', child_tag)
        target_num = int(item_num_m.group(1)) if item_num_m else None

        # 1. Match from in-memory cache
        candidate_items = []
        for k, items in self.mrp_schedule.items():
            if p_norm and (p_norm == k or (len(p_norm) >= 5 and (p_norm in k or k in p_norm))):
                for it in items:
                    if it not in candidate_items:
                        candidate_items.append(it)

        if candidate_items:
            if not child_tag:
                return candidate_items

            matched_children = []
            for it in candidate_items:
                r_c_norm = norm_key(it.get("child_part"))
                r_erp_norm = norm_key(it.get("erp_part"))
                if c_norm and (c_norm in r_c_norm or r_c_norm in c_norm or c_norm in r_erp_norm):
                    matched_children.append(it)
                    continue
                if target_num is not None:
                    it_num_m = re.search(r'item\s*(\d+)', it.get("child_part", ""), re.IGNORECASE) or re.search(r'item(\d+)', it.get("erp_part", ""), re.IGNORECASE)
                    if it_num_m and int(it_num_m.group(1)) == target_num:
                        matched_children.append(it)
                        continue

            if matched_children:
                return matched_children
            return candidate_items

        # 2. Live Supabase fallback to mrp_rm_sheet_bom
        if SUPABASE_URL and SUPABASE_KEY and (parent_part or part_no):
            try:
                target_p = parent_part or part_no
                res = requests.get(
                    f"{SUPABASE_URL}/rest/v1/mrp_rm_sheet_bom?parent_part_no=ilike.*{target_p}*&order=id.asc&limit=20",
                    headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"},
                    timeout=3
                )
                if res.status_code == 200 and res.json():
                    rows = res.json()
                    bom_list = []
                    for row in rows:
                        sched_q = float(row.get("schedule_qty") or 0)
                        tot_q = float(row.get("total_qty") or 0)
                        offtake = float(row.get("offtake") or 1.0)
                        if not tot_q and sched_q:
                            tot_q = sched_q * offtake
                        bom_list.append({
                            "sl_no": row.get("sl_no"),
                            "parent_part": row.get("parent_part_no"),
                            "child_part": row.get("child_part_no"),
                            "os_part": row.get("os_part"),
                            "erp_part": row.get("erp_part_no"),
                            "scope": row.get("scope"),
                            "offtake": offtake,
                            "grade": row.get("grade"),
                            "blank_size": {"length": row.get("blank_length"), "width": row.get("blank_width"), "thickness": row.get("blank_thickness"), "weight": row.get("blank_weight")},
                            "sheet_size": {"length": row.get("sheet_length"), "width": row.get("sheet_width"), "thickness": row.get("sheet_thickness"), "weight": row.get("sheet_weight")},
                            "existing_sheet_used": row.get("existing_sheet_used"),
                            "components_per_sheet": row.get("components_per_sheet"),
                            "schedule_qty": sched_q,
                            "total_qty": tot_q,
                            "inhouse_erp_qty": float(row.get("inhouse_erp_qty") or 0),
                            "outsource_erp_qty": float(row.get("outsource_erp_qty") or 0),
                            "balance_qty": float(row.get("balance_qty") or 0),
                            "sheet_working": row.get("sheet_working"),
                            "no_of_sheets": row.get("no_of_sheets"),
                            "total_sheet_weight": row.get("total_sheet_weight"),
                            "remarks": row.get("remarks"),
                            "remarks_2": row.get("remarks_2"),
                            "monthly_schedule": {
                                "part_no": row.get("parent_part_no"),
                                "child_part": row.get("child_part_no"),
                                "monthly_total": tot_q,
                                "schedule_qty": sched_q,
                                "offtake": offtake,
                                "fg_pc_stock": float(row.get("inhouse_erp_qty") or 0),
                                "balance_planning": float(row.get("balance_qty") or 0),
                                "existing_sheet_used": row.get("existing_sheet_used"),
                                "components_per_sheet": row.get("components_per_sheet"),
                                "no_of_sheets": row.get("no_of_sheets")
                            }
                        })
                    
                    if target_num is not None:
                        filtered = [b for b in bom_list if (re.search(r'item\s*(\d+)', b['child_part'] or '', re.IGNORECASE) and int(re.search(r'item\s*(\d+)', b['child_part'] or '', re.IGNORECASE).group(1)) == target_num)]
                        if filtered:
                            return filtered
                    return bom_list
            except Exception:
                pass

        return []

    def get_single_part_planning_data(self, part_no, target_month=None):
        """Calculates MRP target, MO produced qty & count, and remaining qty for a single part."""
        if not part_no:
            return None

        mrp_sched = self.get_mrp_monthly_schedule(part_no)
        primary_item = mrp_sched[0] if mrp_sched else {}

        tot_q = float(primary_item.get("total_qty") or 0)
        ih_q = float(primary_item.get("inhouse_erp_qty") or 0)
        os_q = float(primary_item.get("outsource_erp_qty") or 0)
        bal_from_bom = primary_item.get("balance_qty")

        if bal_from_bom is not None and str(bal_from_bom).strip() != "":
            mrp_monthly = float(bal_from_bom)
        elif tot_q > 0:
            mrp_monthly = tot_q - ih_q - os_q
        elif primary_item.get("schedule_qty"):
            mrp_monthly = float(primary_item.get("schedule_qty"))
        else:
            mrp_monthly = None

        child_tag = primary_item.get("child_part")
        mo_month = target_month or "2026-09"
        total_produced, monthly_mos = self.get_monthly_mo_produced(
            part_no=part_no,
            target_month=mo_month,
            child_item_str=child_tag
        )

        base_part = part_no.split(" - ")[0].split("-Item")[0].strip() if part_no else ""
        if SUPABASE_URL and SUPABASE_KEY and (part_no or base_part):
            try:
                target_p = base_part or part_no
                r_rel = requests.get(
                    f"{SUPABASE_URL}/rest/v1/material_orders?or=(part_no.ilike.*{target_p}*,base_part.ilike.*{target_p}*)&status=in.(RELEASED,RELEASED_TO_ERP)&created_at=gte.{mo_month}-01&created_at=lte.{mo_month}-31T23:59:59",
                    headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"},
                    timeout=2
                )
                if r_rel.status_code == 200:
                    known_mo_numbers = {m.get("mo_doc_no") for m in monthly_mos}
                    for mo in r_rel.json():
                        mo_num = mo.get("mo_number")
                        if mo_num and mo_num not in known_mo_numbers:
                            known_mo_numbers.add(mo_num)
                            qty = float(mo.get("target_qty") or 0)
                            total_produced += qty
                            monthly_mos.append({
                                "mo_doc_no": mo_num,
                                "doc_date": str(mo.get("created_at") or "")[:10],
                                "status": mo.get("status"),
                                "parent_code": mo.get("part_no"),
                                "parent_desc": "Portal Released MO",
                                "qty": qty,
                                "no_of_sheets": mo.get("sheets_required")
                            })
            except Exception:
                pass

        if mrp_monthly is not None:
            remaining_qty = max(0.0, mrp_monthly - total_produced)
        else:
            remaining_qty = None

        return {
            "part_no": part_no,
            "child_part_no": primary_item.get("child_part") or child_tag or part_no,
            "parent_part_no": primary_item.get("parent_part"),
            "mrp_monthly_target": mrp_monthly,
            "parts_produced": total_produced,
            "remaining_quantity": remaining_qty,
            "monthly_mo_count": len(monthly_mos),
            "monthly_mo_records": monthly_mos,
            "total_qty": tot_q,
            "inhouse_erp_qty": ih_q,
            "outsource_erp_qty": os_q,
            "balance_planning": mrp_monthly,
            "offtake": primary_item.get("offtake", 1.0),
            "target_month": mo_month
        }

    def get_part_comprehensive_intelligence(self, part_no, rm_code=None, grade=None, thickness=None, length=None, width=None, sheets_needed=1, target_month=None, extra_parts=None):
        """Aggregate all data sources into one unified intelligence payload with exact child item MRP count and monthly MO produced qty for all parts"""
        rm_stock_info = self.get_rm_opening_stock(rm_code, grade=grade, thickness=thickness, length=length, width=width)
        fg_wip_stock = self.get_parts_opening_stock(part_no)
        previous_mos = self.get_previous_mos(part_no, rm_code=rm_code)
        mrp_sched = self.get_mrp_monthly_schedule(part_no)

        # Stock Feasibility Evaluation
        onhand_sheets = rm_stock_info.get("onhand_stock", 0) if rm_stock_info else 0
        stock_sufficient = (onhand_sheets >= float(sheets_needed)) if (rm_stock_info and onhand_sheets > 0) else False

        # Evaluate planning data for primary part + all layout parts (preserving every layout slot)
        if extra_parts and len(extra_parts) > 0:
            if isinstance(extra_parts, str):
                all_parts = [p.strip() for p in extra_parts.split(",") if p.strip()]
            else:
                all_parts = [p.strip() for p in extra_parts if p and str(p).strip()]
        else:
            all_parts = [part_no]

        parts_planning = []
        for p in all_parts:
            p_data = self.get_single_part_planning_data(p, target_month=target_month)
            if p_data:
                # Make a shallow copy so each layout slot has its own independent dict
                parts_planning.append(dict(p_data))

        primary_plan = parts_planning[0] if parts_planning else {}
        primary_item = mrp_sched[0] if mrp_sched else {}

        # Aggregated planning totals across unique layout parts (to avoid double-counting if layout nests same part in multiple slots)
        unique_parts_map = {}
        for p in parts_planning:
            p_code = p.get("part_no") or p.get("child_part_no") or id(p)
            if p_code not in unique_parts_map:
                unique_parts_map[p_code] = p

        total_mrp_target = None
        mrp_targets = [p["mrp_monthly_target"] for p in unique_parts_map.values() if p.get("mrp_monthly_target") is not None]
        if mrp_targets:
            total_mrp_target = sum(mrp_targets)

        total_parts_produced = sum(p.get("parts_produced", 0) for p in unique_parts_map.values())
        total_mo_count = sum(p.get("monthly_mo_count", 0) for p in unique_parts_map.values())

        all_monthly_mos = []
        seen_mo_docs = set()
        for p in unique_parts_map.values():
            for mo in p.get("monthly_mo_records", []):
                doc_no = mo.get("mo_doc_no")
                if doc_no and doc_no not in seen_mo_docs:
                    seen_mo_docs.add(doc_no)
                    all_monthly_mos.append(mo)
                elif not doc_no:
                    all_monthly_mos.append(mo)

        total_remaining = None
        if total_mrp_target is not None:
            total_remaining = max(0.0, total_mrp_target - total_parts_produced)

        mo_month = target_month or "2026-09"

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
                "monthly_total": primary_plan.get("mrp_monthly_target"),
                "child_part_no": primary_item.get("child_part"),
                "parent_part_no": primary_item.get("parent_part"),
                "erp_part_no": primary_item.get("erp_part"),
                "scope": primary_item.get("scope"),
                "offtake": primary_item.get("offtake", 1.0),
                "parent_schedule_qty": primary_item.get("schedule_qty"),
                "child_total_qty": primary_plan.get("total_qty", 0),
                "inhouse_erp_qty": primary_plan.get("inhouse_erp_qty", 0),
                "outsource_erp_qty": primary_plan.get("outsource_erp_qty", 0),
                "balance_qty": primary_plan.get("mrp_monthly_target"),
                "existing_sheet_used": primary_item.get("existing_sheet_used"),
                "components_per_sheet": primary_item.get("components_per_sheet"),
                "no_of_sheets": primary_item.get("no_of_sheets"),
                "sheet_working": primary_item.get("sheet_working"),
                "remarks": primary_item.get("remarks")
            },
            "planning_summary": {
                "rm_onhand_sheets": onhand_sheets,
                "mrp_monthly_target": primary_plan.get("mrp_monthly_target"),
                "parts_produced": primary_plan.get("parts_produced", 0),
                "remaining_quantity": primary_plan.get("remaining_quantity"),
                "child_part_no": primary_plan.get("child_part_no"),
                "offtake": primary_plan.get("offtake", 1.0),
                "parent_schedule_qty": primary_item.get("schedule_qty"),
                "total_qty": primary_plan.get("total_qty", 0),
                "inhouse_erp_qty": primary_plan.get("inhouse_erp_qty", 0),
                "outsource_erp_qty": primary_plan.get("outsource_erp_qty", 0),
                "balance_planning": primary_plan.get("mrp_monthly_target"),
                "monthly_mo_records": all_monthly_mos if len(parts_planning) > 1 else primary_plan.get("monthly_mo_records", []),
                "monthly_mo_count": total_mo_count if len(parts_planning) > 1 else primary_plan.get("monthly_mo_count", 0),
                "target_month": mo_month,
                # Multi-part breakdown for all parts in the layout
                "parts": parts_planning,
                "is_multi_part": len(parts_planning) > 1,
                "totals": {
                    "mrp_monthly_target": total_mrp_target,
                    "parts_produced": total_parts_produced,
                    "remaining_quantity": total_remaining,
                    "monthly_mo_count": total_mo_count,
                    "parts_count": len(parts_planning)
                }
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
