"""
SheetLayout AI — Clean Database Access Layer (v2)
Connects directly to the 7 clean tables in Supabase:
- parts, rm, mrp, mos, app_mo, endbits, endbit_mo
"""

import os
import json
import re
import logging
from datetime import datetime
import requests
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY") or os.getenv("SUPABASE_ANON_KEY")

logger = logging.getLogger("sheetlayout.db_clean")

def _get_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation"
    }

# ============================================================================
# 1. PARTS MASTER
# ============================================================================

def search_parts(query="", limit=30):
    """Search parts by part_no or part_desc"""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return []
    
    url = f"{SUPABASE_URL}/rest/v1/parts?select=*&limit={limit}"
    if query:
        q = query.strip()
        url += f"&or=(part_no.ilike.*{q}*,part_desc.ilike.*{q}*)"
    url += "&order=part_no.asc"

    try:
        res = requests.get(url, headers=_get_headers(), timeout=10)
        if res.status_code == 200:
            return res.json()
        logger.error(f"search_parts error: {res.status_code} - {res.text}")
        return []
    except Exception as e:
        logger.error(f"search_parts exception: {e}")
        return []

def get_part(part_no):
    """Fetch a single part by part_no"""
    if not SUPABASE_URL or not SUPABASE_KEY or not part_no:
        return None
    url = f"{SUPABASE_URL}/rest/v1/parts?part_no=eq.{part_no}&limit=1"
    try:
        res = requests.get(url, headers=_get_headers(), timeout=10)
        if res.status_code == 200:
            data = res.json()
            return data[0] if data else None
        return None
    except Exception as e:
        logger.error(f"get_part exception: {e}")
        return None

def get_parts_by_spec(grade=None, thickness=None, limit=60):
    """
    Fetch parts with matching grade and thickness from the parts master.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        return []
    url = f"{SUPABASE_URL}/rest/v1/parts?select=*&limit={limit}"
    if grade:
        url += f"&grade=ilike.*{grade.strip()}*"
    if thickness is not None:
        try:
            thk_val = float(thickness)
            url += f"&thickness=eq.{thk_val}"
        except Exception:
            pass
    try:
        res = requests.get(url, headers=_get_headers(), timeout=10)
        if res.status_code == 200:
            return res.json()
        return []
    except Exception as e:
        logger.error(f"get_parts_by_spec exception: {e}")
        return []

def create_part(data):
    """
    Inserts a new Part record into public.parts table in Supabase.
    Optionally initializes an MRP demand record if monthly_schedule is provided.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        return {"success": False, "error": "Database not configured"}

    part_no = (data.get("part_no") or "").strip()
    if not part_no:
        return {"success": False, "error": "Part Number is required"}

    # Check if already exists
    existing = get_part(part_no)
    if existing:
        return {"success": False, "error": f"Part Number '{part_no}' already exists in Parts Master."}

    grade = (data.get("grade") or "HR").strip().upper()
    part_desc = (data.get("part_desc") or "").strip()
    
    try:
        thickness = round(float(data.get("thickness") or 0.0), 2)
        length = round(float(data.get("length") or 0.0), 2)
        width = round(float(data.get("width") or 0.0), 2)
    except (ValueError, TypeError):
        return {"success": False, "error": "Thickness, Length, and Width must be valid numbers"}

    if thickness <= 0 or length <= 0 or width <= 0:
        return {"success": False, "error": "Thickness, Length, and Width must all be greater than zero"}

    try:
        weight = float(data.get("weight") or 0.0)
    except (ValueError, TypeError):
        weight = 0.0

    if weight <= 0:
        weight = round((thickness * length * width * 7.85) / 1000000.0, 3)

    try:
        offtake = max(1, int(float(data.get("offtake") or 1)))
    except (ValueError, TypeError):
        offtake = 1

    try:
        strip_qty = max(1, int(float(data.get("strip_per_blank_qty") or 1)))
    except (ValueError, TypeError):
        strip_qty = 1

    standard_rm = (data.get("standard_rm") or "").strip() or None
    if standard_rm:
        rm_check = get_rm(standard_rm)
        if not rm_check:
            standard_rm = None

    payload = {
        "part_no": part_no,
        "part_desc": part_desc,
        "grade": grade,
        "thickness": thickness,
        "length": length,
        "width": width,
        "weight": weight,
        "offtake": offtake,
        "strip_per_blank_qty": strip_qty,
        "standard_rm": standard_rm
    }

    url = f"{SUPABASE_URL}/rest/v1/parts"
    try:
        res = requests.post(url, headers=_get_headers(), json=payload, timeout=10)
        if res.status_code not in (200, 201):
            return {"success": False, "error": f"Database insertion failed: {res.text}"}

        created = res.json()[0] if res.json() else payload

        # Optional: Initialize MRP record if schedule or stock provided
        monthly_schedule = data.get("monthly_schedule")
        current_stock = data.get("current_stock")
        if monthly_schedule is not None or current_stock is not None:
            try:
                mrp_id = get_next_id("mrp")
                month_year = data.get("month_year") or datetime.now().strftime("%Y_%m")
                mrp_payload = {
                    "id": mrp_id,
                    "month_year": month_year,
                    "part_no": part_no,
                    "monthly_schedule": int(float(monthly_schedule or 0)),
                    "current_stock": int(float(current_stock or 0)),
                    "status": "ACTIVE"
                }
                requests.post(f"{SUPABASE_URL}/rest/v1/mrp", headers=_get_headers(), json=mrp_payload, timeout=5)
            except Exception as me:
                logger.warning(f"Failed to auto-create MRP for new part: {me}")

        return {"success": True, "part_no": part_no, "data": created}
    except Exception as e:
        logger.error(f"create_part exception: {e}")
        return {"success": False, "error": str(e)}

# ============================================================================
# 2. RAW MATERIAL (RM)
# ============================================================================

def parse_rm_specs(rm_dict):
    """Parses rm_code into grade, thickness, length, and width"""
    if not rm_dict or not rm_dict.get("rm_code"):
        return rm_dict
    rm_code = str(rm_dict["rm_code"])
    parts = rm_code.split("-")
    grade = parts[0].strip() if len(parts) > 0 else "YS"
    thk = None
    l = 2500.0
    w = 1250.0
    nums = []
    for p in parts[1:]:
        clean = re.sub(r'[^0-9\.]', '', p)
        if clean:
            try:
                nums.append(float(clean))
            except Exception:
                pass
    if len(nums) >= 3:
        thk, l, w = nums[0], nums[1], nums[2]
    elif len(nums) == 2:
        thk, l = nums[0], nums[1]
    elif len(nums) == 1:
        thk = nums[0]
    
    rm_dict["grade"] = grade
    rm_dict["thickness"] = thk
    rm_dict["length"] = l
    rm_dict["width"] = w
    return rm_dict

def get_rms_by_spec(grade=None, thickness=None):
    """
    Fetch RM sheets from rm table with strict grade and thickness parsing.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        return []
    
    url = f"{SUPABASE_URL}/rest/v1/rm?select=*&order=available_sheets.desc"
    try:
        res = requests.get(url, headers=_get_headers(), timeout=10)
        if res.status_code != 200:
            return []
        
        all_rms = [parse_rm_specs(r) for r in res.json()]
        target_thk = float(thickness) if thickness is not None else None
        target_grade = str(grade).strip().upper() if grade else None
        
        filtered = []
        for r in all_rms:
            r_grade = (r.get("grade") or "").upper()
            r_thk = r.get("thickness")
            
            # Grade match
            if target_grade and target_grade not in r_grade and r_grade not in target_grade:
                continue
                
            # Strict thickness match (e.g. 3.0 must not match 16.0 or 3.8)
            if target_thk is not None:
                if r_thk is None or abs(r_thk - target_thk) > 0.05:
                    continue
                    
            filtered.append(r)
            
        return filtered
    except Exception as e:
        logger.error(f"get_rms_by_spec exception: {e}")
        return []

def get_rm(rm_code):
    """Fetch single RM sheet details by rm_code"""
    if not SUPABASE_URL or not SUPABASE_KEY or not rm_code:
        return None
    url = f"{SUPABASE_URL}/rest/v1/rm?rm_code=eq.{rm_code}&limit=1"
    try:
        res = requests.get(url, headers=_get_headers(), timeout=10)
        if res.status_code == 200:
            data = res.json()
            return parse_rm_specs(data[0]) if data else None
        return None
    except Exception as e:
        logger.error(f"get_rm exception: {e}")
        return None

def update_rm_sheets(rm_code, delta_sheets):
    """Deduct (negative) or add (positive) available sheets in rm table"""
    cur = get_rm(rm_code)
    if not cur:
        return False
    new_qty = max(0, int(cur.get("available_sheets", 0) + delta_sheets))
    url = f"{SUPABASE_URL}/rest/v1/rm?rm_code=eq.{rm_code}"
    try:
        res = requests.patch(
            url, 
            headers=_get_headers(), 
            json={"available_sheets": new_qty, "updated_at": datetime.utcnow().isoformat()}, 
            timeout=10
        )
        return res.status_code in (200, 204)
    except Exception as e:
        logger.error(f"update_rm_sheets exception: {e}")
        return False

def create_rm(data):
    """
    Inserts a new Raw Material sheet record into public.rm table in Supabase.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        return {"success": False, "error": "Database not configured"}
    
    rm_code = (data.get("rm_code") or "").strip().upper()
    if not rm_code:
        return {"success": False, "error": "RM Code is required"}
    
    # Check if already exists
    existing = get_rm(rm_code)
    if existing:
        return {"success": False, "error": f"RM Code '{rm_code}' already exists in store."}
    
    try:
        available_sheets = int(float(data.get("available_sheets") or 0))
    except (ValueError, TypeError):
        available_sheets = 0
        
    try:
        weight_per_sheet = round(float(data.get("weight_per_sheet") or 0.0), 3)
    except (ValueError, TypeError):
        weight_per_sheet = 0.0

    if weight_per_sheet <= 0:
        try:
            t = float(data.get("thickness") or 0)
            l = float(data.get("length") or 0)
            w = float(data.get("width") or 0)
            if t > 0 and l > 0 and w > 0:
                weight_per_sheet = round((t * l * w * 7.85) / 1000000.0, 3)
        except Exception:
            pass

    if weight_per_sheet <= 0:
        return {"success": False, "error": "Weight per sheet must be greater than zero."}

    payload = {
        "rm_code": rm_code,
        "available_sheets": max(0, available_sheets),
        "weight_per_sheet": weight_per_sheet
    }

    url = f"{SUPABASE_URL}/rest/v1/rm"
    try:
        res = requests.post(url, headers=_get_headers(), json=payload, timeout=10)
        if res.status_code in (200, 201):
            created = res.json()[0] if res.json() else payload
            return {"success": True, "rm_code": rm_code, "data": parse_rm_specs(created)}
        return {"success": False, "error": f"Database insertion failed: {res.text}"}
    except Exception as e:
        logger.error(f"create_rm exception: {e}")
        return {"success": False, "error": str(e)}

# ============================================================================
# 3. MRP (MONTHLY DEMAND & SCHEDULE)
# ============================================================================

def get_mrp_for_part(part_no, month_year=None):
    """Fetch MRP record for a part (latest or specific month)"""
    if not SUPABASE_URL or not SUPABASE_KEY or not part_no:
        return None
    
    url = f"{SUPABASE_URL}/rest/v1/mrp?part_no=eq.{part_no}"
    if month_year:
        url += f"&month_year=eq.{month_year}"
    url += "&order=id.desc&limit=1"

    try:
        res = requests.get(url, headers=_get_headers(), timeout=10)
        if res.status_code == 200:
            data = res.json()
            return data[0] if data else None
        return None
    except Exception as e:
        logger.error(f"get_mrp_for_part exception: {e}")
        return None

# ============================================================================
# 4. MOS (ERP MO HISTORY)
# ============================================================================

def get_mos_for_part(part_no, limit=10):
    """Fetch ERP historical cutting orders for this part"""
    if not SUPABASE_URL or not SUPABASE_KEY or not part_no:
        return []
    url = f"{SUPABASE_URL}/rest/v1/mos?part_no=eq.{part_no}&order=date.desc&limit={limit}"
    try:
        res = requests.get(url, headers=_get_headers(), timeout=10)
        if res.status_code == 200:
            return res.json()
        return []
    except Exception as e:
        logger.error(f"get_mos_for_part exception: {e}")
        return []

# ============================================================================
# 5. APP_MO (APPLICATION MO WORKFLOW)
# ============================================================================

def get_next_id(table_name):
    """
    Computes next numeric ID for tables with sequence permission restrictions.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        return 1
    url = f"{SUPABASE_URL}/rest/v1/{table_name}?select=id&order=id.desc&limit=1"
    try:
        res = requests.get(url, headers=_get_headers(), timeout=5)
        if res.status_code == 200 and res.json():
            return int(res.json()[0]["id"]) + 1
    except Exception:
        pass
    return 1

def generate_next_mo_number():
    """Generates sequential MO number e.g. MO-2026-0001"""
    prefix = f"MO-{datetime.now().strftime('%Y')}-"
    url = f"{SUPABASE_URL}/rest/v1/app_mo?select=mo_no&order=id.desc&limit=1"
    try:
        res = requests.get(url, headers=_get_headers(), timeout=10)
        if res.status_code == 200 and res.json():
            last = res.json()[0].get("mo_no", "")
            if last.startswith(prefix):
                try:
                    num = int(last.replace(prefix, "")) + 1
                    return f"{prefix}{num:04d}"
                except ValueError:
                    pass
    except Exception:
        pass
    # Fallback with timestamp
    return f"{prefix}{int(datetime.now().timestamp()) % 10000:04d}"

def create_app_mo(data):
    """
    Creates an MO record, deducts RM sheets, logs generated endbits, and records audit trail.
    Assigns explicit ID to prevent PostgreSQL sequence permission errors with anon keys.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        return {"success": False, "error": "Database not configured"}

    mo_no = data.get("mo_no") or generate_next_mo_number()
    rm_code = data.get("rm_code")
    no_of_rm_sheets = float(data.get("no_of_rm_sheets", 0))
    parts_produced = data.get("parts_produced", [])
    parts_qty = float(data.get("parts_qty", 0))
    endbits_desc = data.get("endbits", "")
    endbit_weight = float(data.get("endbit_weight", 0))
    yield_pct = float(data.get("yield_pct", 0))
    remarks = data.get("remarks", "")
    created_by = data.get("created_by", "Shearing Team")
    row_id = data.get("id") or get_next_id("app_mo")

    audit = data.get("audit_trail") or [{
        "stage": "INITIATED",
        "action": "Created Material Order",
        "by": created_by,
        "timestamp": datetime.utcnow().isoformat(),
        "notes": remarks
    }]

    record = {
        "id": row_id,
        "mo_no": mo_no,
        "rm_code": rm_code,
        "no_of_rm_sheets": no_of_rm_sheets,
        "parts_produced": parts_produced,
        "parts_qty": parts_qty,
        "endbits": endbits_desc,
        "endbit_weight": endbit_weight,
        "yield_pct": yield_pct,
        "workflow_path": data.get("workflow_path", "DIRECT_ERP"),
        "current_stage": data.get("current_stage", "KRYSALIS"),
        "status": data.get("status", "PENDING_KRYSALIS"),
        "remarks": remarks,
        "audit_trail": audit
    }

    url = f"{SUPABASE_URL}/rest/v1/app_mo"
    try:
        res = requests.post(url, headers=_get_headers(), json=record, timeout=10)
        if res.status_code not in (200, 201):
            return {"success": False, "error": f"Failed to insert MO: {res.text}"}

        # 1. Deduct sheets from RM stock
        if rm_code and no_of_rm_sheets > 0:
            update_rm_sheets(rm_code, -no_of_rm_sheets)

        # 2. Log generated endbit into endbits table if applicable
        if endbits_desc and no_of_rm_sheets > 0:
            log_endbit_batch(mo_no, endbits_desc, no_of_rm_sheets, endbit_weight)

        return {"success": True, "mo_no": mo_no, "data": res.json()[0] if res.json() else record}

    except Exception as e:
        logger.error(f"create_app_mo exception: {e}")
        return {"success": False, "error": str(e)}

def update_app_mo_status(mo_no, current_stage=None, status=None, audit_entry=None):
    """Updates approval status/stage in Supabase app_mo table"""
    if not SUPABASE_URL or not SUPABASE_KEY or not mo_no:
        return False
    patch_data = {"updated_at": datetime.utcnow().isoformat()}
    if current_stage:
        patch_data["current_stage"] = current_stage
    if status:
        patch_data["status"] = status
    
    # If audit entry provided, fetch current and append
    if audit_entry:
        try:
            get_res = requests.get(f"{SUPABASE_URL}/rest/v1/app_mo?mo_no=eq.{mo_no}&select=audit_trail", headers=_get_headers(), timeout=5)
            if get_res.status_code == 200 and get_res.json():
                current_audit = get_res.json()[0].get("audit_trail") or []
                current_audit.append(audit_entry)
                patch_data["audit_trail"] = current_audit
        except Exception:
            pass

    try:
        url = f"{SUPABASE_URL}/rest/v1/app_mo?mo_no=eq.{mo_no}"
        res = requests.patch(url, headers=_get_headers(), json=patch_data, timeout=10)
        return res.status_code in (200, 204)
    except Exception as e:
        logger.error(f"update_app_mo_status exception: {e}")
        return False

def list_app_mos(status=None, stage=None, limit=50):
    """List application MOs with optional status or stage filters"""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return []
    url = f"{SUPABASE_URL}/rest/v1/app_mo?select=*&order=id.desc&limit={limit}"
    if status:
        url += f"&status=eq.{status}"
    if stage:
        url += f"&current_stage=eq.{stage}"
    try:
        res = requests.get(url, headers=_get_headers(), timeout=10)
        if res.status_code == 200:
            return res.json()
        return []
    except Exception as e:
        logger.error(f"list_app_mos exception: {e}")
        return []

# ============================================================================
# 6. ENDBITS (OFFCUT BATCH STORE)
# ============================================================================

def log_endbit_batch(mo_no, endbit_desc, quantity, weight, endbit_id_num=None):
    """Logs a new endbit batch generated from an MO with explicit ID"""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return None
    url = f"{SUPABASE_URL}/rest/v1/endbits"
    eb_id = endbit_id_num or get_next_id("endbits")
    payload = {
        "id": eb_id,
        "mo_no": mo_no,
        "endbit": endbit_desc,
        "quantity": float(quantity),
        "weight": float(weight)
    }
    try:
        res = requests.post(url, headers=_get_headers(), json=payload, timeout=10)
        return res.status_code in (200, 201)
    except Exception as e:
        logger.error(f"log_endbit_batch exception: {e}")
        return False

def get_available_endbits():
    """Fetch all available endbit batches with stock > 0"""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return []
    url = f"{SUPABASE_URL}/rest/v1/endbits?quantity=gt.0&order=id.desc"
    try:
        res = requests.get(url, headers=_get_headers(), timeout=10)
        if res.status_code == 200:
            return res.json()
        return []
    except Exception as e:
        logger.error(f"get_available_endbits exception: {e}")
        return []

# ============================================================================
# 7. ENDBIT_MO (CUTTING FROM ENDBITS)
# ============================================================================

def create_endbit_mo(data):
    """Create order cutting parts from an existing endbit batch with explicit ID"""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return {"success": False, "error": "Database not configured"}
    
    eb_mo_no = data.get("eb_mo_no") or f"EB-MO-{int(datetime.now().timestamp()) % 10000:04d}"
    endbit_id = data.get("endbit_id")
    no_of_eb_sheets = float(data.get("no_of_eb_sheets", 0))
    row_id = data.get("id") or get_next_id("endbit_mo")

    record = {
        "id": row_id,
        "eb_mo_no": eb_mo_no,
        "endbit_id": endbit_id,
        "endbit_code": data.get("endbit_code", ""),
        "no_of_eb_sheets": no_of_eb_sheets,
        "parts_produced": data.get("parts_produced", []),
        "parts_qty": float(data.get("parts_qty", 0)),
        "scrap_weight": float(data.get("scrap_weight", 0)),
        "yield_pct": float(data.get("yield_pct", 0)),
        "current_stage": data.get("current_stage", "KRYSALIS"),
        "status": data.get("status", "PENDING"),
        "remarks": data.get("remarks", "")
    }

    url = f"{SUPABASE_URL}/rest/v1/endbit_mo"
    try:
        res = requests.post(url, headers=_get_headers(), json=record, timeout=10)
        if res.status_code not in (200, 201):
            return {"success": False, "error": res.text}
        
        # Deduct quantity from endbits batch
        if endbit_id and no_of_eb_sheets > 0:
            get_eb_url = f"{SUPABASE_URL}/rest/v1/endbits?id=eq.{endbit_id}"
            eb_res = requests.get(get_eb_url, headers=_get_headers(), timeout=10)
            if eb_res.status_code == 200 and eb_res.json():
                cur_eb = eb_res.json()[0]
                new_eb_qty = max(0, float(cur_eb.get("quantity", 0)) - no_of_eb_sheets)
                requests.patch(
                    get_eb_url, 
                    headers=_get_headers(), 
                    json={"quantity": new_eb_qty, "updated_at": datetime.utcnow().isoformat()}, 
                    timeout=10
                )

        return {"success": True, "eb_mo_no": eb_mo_no, "data": record}
    except Exception as e:
        logger.error(f"create_endbit_mo exception: {e}")
        return {"success": False, "error": str(e)}
