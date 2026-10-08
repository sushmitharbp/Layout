"""
SheetLayout AI — Excel to Supabase Exporter & Migrator
Exports all 4 Excel sheets to clean CSV files and (if credentials provided) uploads directly to Supabase.

1. ERP Entry - 2.xlsx -> MO Report          --> public.erp_mo_reports
2. Unit 1 Daily Stock -> MAIN STORE         --> public.rm_main_store_stock
3. Unit 1 Daily Stock -> 002 - FG & WIP     --> public.parts_fg_wip_stock
4. MRP Schedule       -> Schedule by Sales  --> public.mrp_sales_schedules
5. MRP Schedule       -> RM sheet BOM       --> public.mrp_rm_sheet_bom
"""

import os
import re
import csv
import glob
import json
import time
import openpyxl
import requests
from dotenv import load_dotenv

load_dotenv()

EXPORT_DIR = os.path.join(os.path.dirname(__file__), "supabase_csv_exports")
os.makedirs(EXPORT_DIR, exist_ok=True)

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY") or os.getenv("SUPABASE_ANON_KEY")

def clean_val(v):
    if v is None:
        return ""
    if isinstance(v, str):
        v = v.strip()
        if v.startswith("="):
            return ""  # skip uncalculated excel formulas
    return v

def export_mo_report():
    files = glob.glob("*ERP Entry*.xlsx")
    if not files:
        print("[!] No ERP Entry file found.")
        return None
    
    file_path = files[0]
    out_csv = os.path.join(EXPORT_DIR, "1_erp_mo_reports.csv")
    print(f"[*] Parsing '{file_path}' (MO Report)...")
    
    wb = openpyxl.load_workbook(file_path, data_only=True)
    ws = wb["MO Report"]
    
    headers = [
        "mo_doc_no", "doc_date", "order_status", "cutting_order_no", 
        "cutting_order_date", "rm_code", "rm_desc", "uom", 
        "number_of_sheets", "reference_date", "reference_no", 
        "start_date", "due_date", "cutting_plan_no", "parent_code", 
        "parent_desc", "uom_code", "parent_qty_per_sheet", 
        "total_parent_qty", "rm_weight"
    ]
    
    rows_written = 0
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        
        for idx, row in enumerate(ws.iter_rows(values_only=True)):
            if idx == 0 or not row or len(row) < 5:
                continue
            
            mo_doc_no = str(row[0] or "").strip()
            if not mo_doc_no or mo_doc_no == "Doc Date":
                continue
            
            doc_date = str(row[1] or "").split(" ")[0] if row[1] else ""
            order_status = str(row[2] or "").strip()
            cutting_order_no = str(row[3] or "").strip()
            cutting_order_date = str(row[4] or "").split(" ")[0] if len(row) > 4 and row[4] else ""
            rm_code = str(row[5] or "").strip() if len(row) > 5 else ""
            rm_desc = str(row[6] or "").strip() if len(row) > 6 else ""
            uom = str(row[7] or "").strip() if len(row) > 7 else ""
            number_of_sheets = row[8] if len(row) > 8 and isinstance(row[8], (int, float)) else ""
            reference_date = str(row[9] or "").split(" ")[0] if len(row) > 9 and row[9] else ""
            reference_no = str(row[10] or "").strip() if len(row) > 10 and row[10] else ""
            start_date = str(row[11] or "").split(" ")[0] if len(row) > 11 and row[11] else ""
            due_date = str(row[12] or "").split(" ")[0] if len(row) > 12 and row[12] else ""
            cutting_plan_no = str(row[13] or "").strip() if len(row) > 13 and row[13] else ""
            parent_code = str(row[14] or "").strip() if len(row) > 14 and row[14] else ""
            parent_desc = str(row[15] or "").strip() if len(row) > 15 and row[15] else ""
            uom_code = str(row[16] or "").strip() if len(row) > 16 and row[16] else ""
            parent_qty_per_sheet = row[17] if len(row) > 17 and isinstance(row[17], (int, float)) else ""
            total_parent_qty = row[18] if len(row) > 18 and isinstance(row[18], (int, float)) else ""
            rm_weight = row[19] if len(row) > 19 and isinstance(row[19], (int, float)) else ""
            
            writer.writerow([
                mo_doc_no, doc_date, order_status, cutting_order_no,
                cutting_order_date, rm_code, rm_desc, uom,
                number_of_sheets, reference_date, reference_no,
                start_date, due_date, cutting_plan_no, parent_code,
                parent_desc, uom_code, parent_qty_per_sheet,
                total_parent_qty, rm_weight
            ])
            rows_written += 1
            
    print(f"[+] Exported {rows_written} rows to '{out_csv}'")
    return out_csv

def export_main_store_stock():
    files = glob.glob("*Daily Stock*.xlsx")
    if not files:
        print("[!] No Daily Stock file found.")
        return None
    
    file_path = files[0]
    out_csv = os.path.join(EXPORT_DIR, "2_rm_main_store_stock.csv")
    print(f"[*] Parsing '{file_path}' (MAIN STORE)...")
    
    wb = openpyxl.load_workbook(file_path, data_only=True)
    ws = wb["MAIN STORE"]
    
    headers = [
        "item_code", "item_desc", "uom", "store_desc", "onhand_stock",
        "category_desc", "weight", "total_weight", "std_cost", "last_po_price", "stock_value"
    ]
    
    rows_written = 0
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        
        for idx, row in enumerate(ws.iter_rows(values_only=True)):
            if idx == 0 or not row or not row[0]:
                continue
            
            item_code = str(row[0]).strip()
            item_desc = str(row[1]).strip() if len(row) > 1 and row[1] else ""
            uom = str(row[2]).strip() if len(row) > 2 and row[2] else "NOS"
            store_desc = str(row[3]).strip() if len(row) > 3 and row[3] else "MAIN STORES"
            onhand_stock = row[4] if len(row) > 4 and isinstance(row[4], (int, float)) else 0
            category_desc = str(row[5]).strip() if len(row) > 5 and row[5] else ""
            weight = row[6] if len(row) > 6 and isinstance(row[6], (int, float)) else ""
            total_weight = row[7] if len(row) > 7 and isinstance(row[7], (int, float)) else ""
            std_cost = row[8] if len(row) > 8 and isinstance(row[8], (int, float)) else ""
            last_po_price = row[9] if len(row) > 9 and isinstance(row[9], (int, float)) else ""
            stock_value = row[10] if len(row) > 10 and isinstance(row[10], (int, float)) else ""
            
            writer.writerow([
                item_code, item_desc, uom, store_desc, onhand_stock,
                category_desc, weight, total_weight, std_cost, last_po_price, stock_value
            ])
            rows_written += 1
            
    print(f"[+] Exported {rows_written} rows to '{out_csv}'")
    return out_csv

def export_fg_wip_stock():
    files = glob.glob("*Daily Stock*.xlsx")
    if not files:
        return None
    
    file_path = files[0]
    out_csv = os.path.join(EXPORT_DIR, "3_parts_fg_wip_stock.csv")
    print(f"[*] Parsing '{file_path}' (002 - FG & WIP)...")
    
    wb = openpyxl.load_workbook(file_path, data_only=True)
    ws = wb["002 - FG & WIP"]
    
    headers = [
        "item_code", "item_desc", "uom", "store_desc", "onhand_stock",
        "category_desc", "weight", "total_weight", "std_cost", "std_stock_value", "details"
    ]
    
    rows_written = 0
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        
        for idx, row in enumerate(ws.iter_rows(values_only=True)):
            if idx == 0 or not row or not row[0]:
                continue
            
            item_code = str(row[0]).strip()
            item_desc = str(row[1]).strip() if len(row) > 1 and row[1] else ""
            uom = str(row[2]).strip() if len(row) > 2 and row[2] else "NOS"
            store_desc = str(row[3]).strip() if len(row) > 3 and row[3] else "FG AND WIP STORES"
            onhand_stock = row[4] if len(row) > 4 and isinstance(row[4], (int, float)) else 0
            category_desc = str(row[5]).strip() if len(row) > 5 and row[5] else ""
            weight = row[6] if len(row) > 6 and isinstance(row[6], (int, float)) else ""
            total_weight = row[7] if len(row) > 7 and isinstance(row[7], (int, float)) else ""
            std_cost = row[8] if len(row) > 8 and isinstance(row[8], (int, float)) else ""
            std_stock_value = row[9] if len(row) > 9 and isinstance(row[9], (int, float)) else ""
            details = str(row[10]).strip() if len(row) > 10 and row[10] else ""
            
            writer.writerow([
                item_code, item_desc, uom, store_desc, onhand_stock,
                category_desc, weight, total_weight, std_cost, std_stock_value, details
            ])
            rows_written += 1
            
    print(f"[+] Exported {rows_written} rows to '{out_csv}'")
    return out_csv

def export_mrp_sales_schedule():
    files = glob.glob("*MRP*.xlsx")
    if not files:
        print("[!] No MRP file found.")
        return None
    
    file_path = files[0]
    out_csv = os.path.join(EXPORT_DIR, "4_mrp_sales_schedules.csv")
    print(f"[*] Parsing '{file_path}' (Schedule given by Sales)...")
    
    wb = openpyxl.load_workbook(file_path, data_only=True)
    ws = wb["Schedule given by Sales"]
    
    headers = [
        "sl_no", "part_no", "part_name", "wk1", "wk2", "wk3", "wk4", "wk5",
        "monthly_total", "fg_pc_stock", "godown", "qc", "balance_planning"
    ]
    
    rows_written = 0
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        
        for idx, row in enumerate(ws.iter_rows(values_only=True)):
            if idx == 0 or not row or len(row) < 2 or not row[1]:
                continue
            
            part_no = str(row[1]).strip()
            if not part_no or part_no.lower() == "part no":
                continue
            
            sl_no = row[0] if isinstance(row[0], (int, float)) else idx
            part_name = str(row[2]).strip() if len(row) > 2 and row[2] else ""
            wk1 = row[3] if len(row) > 3 and isinstance(row[3], (int, float)) else 0
            wk2 = row[4] if len(row) > 4 and isinstance(row[4], (int, float)) else 0
            wk3 = row[5] if len(row) > 5 and isinstance(row[5], (int, float)) else 0
            wk4 = row[6] if len(row) > 6 and isinstance(row[6], (int, float)) else 0
            wk5 = row[7] if len(row) > 7 and isinstance(row[7], (int, float)) else 0
            
            monthly_total = row[8] if len(row) > 8 and isinstance(row[8], (int, float)) else (wk1 + wk2 + wk3 + wk4 + wk5)
            fg_pc_stock = row[9] if len(row) > 9 and isinstance(row[9], (int, float)) else 0
            godown = row[10] if len(row) > 10 and isinstance(row[10], (int, float)) else 0
            qc = row[11] if len(row) > 11 and isinstance(row[11], (int, float)) else 0
            balance_planning = row[12] if len(row) > 12 and isinstance(row[12], (int, float)) else max(0, monthly_total - (fg_pc_stock + godown + qc))
            
            writer.writerow([
                sl_no, part_no, part_name, wk1, wk2, wk3, wk4, wk5,
                monthly_total, fg_pc_stock, godown, qc, balance_planning
            ])
            rows_written += 1
            
    print(f"[+] Exported {rows_written} rows to '{out_csv}'")
    return out_csv

def export_mrp_rm_sheet_bom():
    files = glob.glob("*MRP*.xlsx")
    if not files:
        return None
    
    file_path = files[0]
    wb = openpyxl.load_workbook(file_path, data_only=True)
    if "RM sheet BOM" not in wb.sheetnames:
        return None
    
    out_csv = os.path.join(EXPORT_DIR, "5_mrp_rm_sheet_bom.csv")
    print(f"[*] Parsing '{file_path}' (RM sheet BOM)...")
    ws = wb["RM sheet BOM"]
    
    headers = [
        "sl_no", "parent_part_no", "child_part_no", "os_part", "erp_part_no",
        "scope", "offtake", "grade", "blank_length", "blank_width", "blank_thickness",
        "blank_weight", "sheet_length", "sheet_width", "sheet_thickness",
        "sheet_weight", "existing_sheet_used", "components_per_sheet",
        "schedule_qty", "total_qty", "inhouse_erp_qty", "outsource_erp_qty",
        "balance_qty", "sheet_working", "no_of_sheets", "total_sheet_weight",
        "remarks", "remarks_2"
    ]
    
    def _num(val):
        if val is None or val == "" or val == "-":
            return ""
        if isinstance(val, (int, float)):
            return val
        try:
            return float(str(val).replace(",", "").strip())
        except (ValueError, TypeError):
            return ""

    def _str(val):
        if val is None or val == "-":
            return ""
        return str(val).strip()
    
    rows_written = 0
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        
        for idx, row in enumerate(ws.iter_rows(values_only=True)):
            if idx == 0 or not row or len(row) < 3 or not row[1]:
                continue
            
            parent_part = _str(row[1])
            if not parent_part or parent_part.lower() == "part no":
                continue
            
            sl_no = _num(row[0]) if _num(row[0]) != "" else idx
            child_part = _str(row[2]) if len(row) > 2 else ""
            os_part = _str(row[3]) if len(row) > 3 else ""
            erp_part = _str(row[4]) if len(row) > 4 else ""
            scope = _str(row[5]) if len(row) > 5 else ""
            offtake = _num(row[6]) if len(row) > 6 and _num(row[6]) != "" else 1.0
            grade = _str(row[7]) if len(row) > 7 else ""
            
            b_l = _num(row[8]) if len(row) > 8 else ""
            b_w = _num(row[9]) if len(row) > 9 else ""
            b_t = _num(row[10]) if len(row) > 10 else ""
            b_wt = _num(row[11]) if len(row) > 11 else ""
            
            s_l = _num(row[12]) if len(row) > 12 else ""
            s_w = _num(row[13]) if len(row) > 13 else ""
            s_t = _num(row[14]) if len(row) > 14 else b_t
            
            sheet_wt = _num(row[15]) if len(row) > 15 else ""
            sheet_used = _str(row[16]) if len(row) > 16 else ""
            compt_sheet = _num(row[17]) if len(row) > 17 else ""
            
            sched_qty = _num(row[18]) if len(row) > 18 else ""
            total_qty = _num(row[19]) if len(row) > 19 else ""
            inhouse_qty = _num(row[20]) if len(row) > 20 else ""
            outsource_qty = _num(row[21]) if len(row) > 21 else ""
            bal_qty = _num(row[22]) if len(row) > 22 else ""
            
            sheet_working = _num(row[23]) if len(row) > 23 else ""
            no_sheets = _num(row[24]) if len(row) > 24 else ""
            total_weight = _num(row[25]) if len(row) > 25 else ""
            
            remarks_1 = _str(row[26]) if len(row) > 26 else ""
            remarks_2 = _str(row[27]) if len(row) > 27 else ""
            
            writer.writerow([
                sl_no, parent_part, child_part, os_part, erp_part,
                scope, offtake, grade, b_l, b_w, b_t, b_wt, s_l, s_w, s_t,
                sheet_wt, sheet_used, compt_sheet,
                sched_qty, total_qty, inhouse_qty, outsource_qty,
                bal_qty, sheet_working, no_sheets, total_weight,
                remarks_1, remarks_2
            ])
            rows_written += 1
            
    print(f"[+] Exported {rows_written} rows to '{out_csv}'")
    return out_csv

def upload_csv_to_supabase(table_name, csv_path, batch_size=200):
    """Uploads CSV rows to Supabase via REST API"""
    if not SUPABASE_URL or not SUPABASE_KEY:
        print(f"[i] Supabase credentials not set in .env. Skipping direct upload for '{table_name}'.")
        return False
    
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates"
    }
    
    url = f"{SUPABASE_URL}/rest/v1/{table_name}"
    
    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        batch = []
        total_uploaded = 0
        
        for row in reader:
            # Clean numeric and empty fields
            cleaned_row = {}
            for k, v in row.items():
                if v == "":
                    cleaned_row[k] = None
                else:
                    try:
                        if "." in v:
                            cleaned_row[k] = float(v)
                        else:
                            cleaned_row[k] = int(v)
                    except ValueError:
                        cleaned_row[k] = v
            batch.append(cleaned_row)
            
            if len(batch) >= batch_size:
                res = requests.post(url, headers=headers, json=batch)
                if res.status_code in (200, 201, 204):
                    total_uploaded += len(batch)
                    print(f"  --> {table_name}: Uploaded {total_uploaded} rows...")
                else:
                    print(f"  [x] Upload failed ({res.status_code}): {res.text[:200]}")
                    return False
                batch = []
                time.sleep(0.05)
                
        if batch:
            res = requests.post(url, headers=headers, json=batch)
            if res.status_code in (200, 201, 204):
                total_uploaded += len(batch)
                print(f"  --> {table_name}: Completed uploading {total_uploaded} rows!")
            else:
                print(f"  [x] Final batch failed ({res.status_code}): {res.text[:200]}")
                return False
                
    return True

if __name__ == "__main__":
    print("=" * 65)
    print(" SheetLayout AI — 4 Excel Sheets Exporter & Supabase Migrator")
    print("=" * 65)
    
    f1 = export_mo_report()
    f2 = export_main_store_stock()
    f3 = export_fg_wip_stock()
    f4 = export_mrp_sales_schedule()
    f5 = export_mrp_rm_sheet_bom()
    
    print("\n" + "=" * 65)
    print(f" SUCCESS: Clean CSV files created in: {EXPORT_DIR}")
    print("=" * 65)
    print("Files ready for instant import:")
    print(" 1. 1_erp_mo_reports.csv          -> public.erp_mo_reports")
    print(" 2. 2_rm_main_store_stock.csv     -> public.rm_main_store_stock")
    print(" 3. 3_parts_fg_wip_stock.csv      -> public.parts_fg_wip_stock")
    print(" 4. 4_mrp_sales_schedules.csv     -> public.mrp_sales_schedules")
    print(" 5. 5_mrp_rm_sheet_bom.csv        -> public.mrp_rm_sheet_bom")
    
    if SUPABASE_URL and SUPABASE_KEY:
        print("\n[*] Supabase credentials detected! Starting direct REST upload...")
        upload_csv_to_supabase("erp_mo_reports", f1)
        upload_csv_to_supabase("rm_main_store_stock", f2)
        upload_csv_to_supabase("parts_fg_wip_stock", f3)
        upload_csv_to_supabase("mrp_sales_schedules", f4)
        if f5:
            upload_csv_to_supabase("mrp_rm_sheet_bom", f5)
    else:
        print("\n[Tip] You can import these CSVs into Supabase Table Editor via drag-and-drop,")
        print("      or add SUPABASE_URL and SUPABASE_KEY to your .env to upload automatically.")
