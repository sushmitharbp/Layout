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

DEFAULT_SUPABASE_URL = "https://otqxytgeqijdszggxgif.supabase.co"
DEFAULT_SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im90cXh5dGdlcWlqZHN6Z2d4Z2lmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA2NTA2MTYsImV4cCI6MjEwNjIyNjYxNn0.YY67ogTibPKhhYK3A3fAP4r7nAeQZsztT-YGZbrogJE"

SUPABASE_URL = (os.getenv("SUPABASE_URL") or DEFAULT_SUPABASE_URL).strip().rstrip("/")
SUPABASE_KEY = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY") or os.getenv("SUPABASE_ANON_KEY") or DEFAULT_SUPABASE_KEY).strip()

logger = logging.getLogger("sheetlayout.db_clean")

def _get_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation"
    }

def _safe_supabase_get(endpoint_url, company_id=None, timeout=10):
    """
    Executes a GET query to Supabase PostgREST with company_id tenant isolation.
    If company_id is provided, appends company_id=eq.{company_id}.
    If the remote table does not yet have the company_id column (HTTP 400),
    gracefully falls back:
    - For PEI2: returns existing rows (all legacy Supabase rows belong to PEI2).
    - For PEPIPL (or other tenants): returns [] to ensure zero data leakage.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        return []

    c_id = (company_id or "").strip().upper() if company_id else None

    if c_id:
        separator = "&" if "?" in endpoint_url else "?"
        tenant_url = f"{endpoint_url}{separator}company_id=eq.{c_id}"
        try:
            res = requests.get(tenant_url, headers=_get_headers(), timeout=timeout)
            if res.status_code == 200:
                return res.json()
            if res.status_code == 400 and ("company_id" in res.text or "column" in res.text):
                # Migration script not yet executed in Supabase SQL editor
                logger.debug(f"company_id column not present on table yet; applying fallback for {c_id}")
                if c_id == "PEI2":
                    fb = requests.get(endpoint_url, headers=_get_headers(), timeout=timeout)
                    if fb.status_code == 200:
                        return fb.json()
                else:
                    return []
            else:
                logger.warning(f"Supabase GET status {res.status_code}: {res.text}")
        except Exception as e:
            logger.error(f"Supabase GET exception on {tenant_url}: {e}")
            return []

    try:
        res = requests.get(endpoint_url, headers=_get_headers(), timeout=timeout)
        if res.status_code == 200:
            return res.json()
        return []
    except Exception as e:
        logger.error(f"Supabase GET exception on {endpoint_url}: {e}")
        return []

def _safe_supabase_post(endpoint_url, payload, timeout=10):
    """
    Executes a POST insert into Supabase table.
    If table does not yet have company_id column, strips it and retries safely.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        return False, "Database not configured", None
    try:
        res = requests.post(endpoint_url, headers=_get_headers(), json=payload, timeout=timeout)
        if res.status_code in (200, 201):
            return True, None, (res.json()[0] if res.json() else payload)
        if res.status_code == 400 and "company_id" in res.text:
            cleaned = dict(payload)
            cleaned.pop("company_id", None)
            cleaned.pop("branch_code", None)
            res2 = requests.post(endpoint_url, headers=_get_headers(), json=cleaned, timeout=timeout)
            if res2.status_code in (200, 201):
                return True, None, (res2.json()[0] if res2.json() else cleaned)
            return False, res2.text, None
        return False, res.text, None
    except Exception as e:
        return False, str(e), None

# ============================================================================
# 1. PARTS MASTER
# ============================================================================

def search_parts(query="", limit=30, company_id=None):
    """Search parts by part_no or part_desc scoped by company_id, with alphanumeric matching support"""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return []
    
    url = f"{SUPABASE_URL}/rest/v1/parts?select=*&limit={limit}"
    if query:
        q = query.strip()
        clean_q = re.sub(r'[^A-Z0-9]', '', q.upper())
        if clean_q and clean_q != q.upper():
            base_pfx = clean_q.split("ITEM")[0] if "ITEM" in clean_q else clean_q
            url += f"&or=(part_no.ilike.*{q}*,part_desc.ilike.*{q}*,part_no.ilike.*{clean_q}*,part_no.ilike.*{base_pfx}*)"
        else:
            url += f"&or=(part_no.ilike.*{q}*,part_desc.ilike.*{q}*)"
    url += "&order=part_no.asc"

    return _safe_supabase_get(url, company_id=company_id)

def get_part(part_no, company_id=None):
    """Fetch a single part by part_no scoped by company_id, with robust normalization fallback."""
    if not SUPABASE_URL or not SUPABASE_KEY or not part_no:
        return None
    part_clean = str(part_no).strip()
    url = f"{SUPABASE_URL}/rest/v1/parts?part_no=eq.{part_clean}&limit=1"
    rows = _safe_supabase_get(url, company_id=company_id)
    if rows:
        return rows[0]

    # Try case-insensitive lookup
    url_ilike = f"{SUPABASE_URL}/rest/v1/parts?part_no=ilike.{part_clean}&limit=1"
    rows = _safe_supabase_get(url_ilike, company_id=company_id)
    if rows:
        return rows[0]

    # Try normalized alphanumeric match using fast exact 'in' query
    clean_alnum = re.sub(r'[^A-Z0-9]', '', part_clean.upper())
    if clean_alnum:
        variants = [clean_alnum]
        if "ITEM" in clean_alnum:
            if "ITEM0" in clean_alnum:
                variants.append(clean_alnum.replace("ITEM0", "ITEM"))
            else:
                variants.append(re.sub(r'ITEM(\d+)$', r'ITEM0\1', clean_alnum))

        in_list = ",".join(variants)
        url_in = f"{SUPABASE_URL}/rest/v1/parts?part_no=in.({in_list})&limit=1"
        rows = _safe_supabase_get(url_in, company_id=company_id)
        if rows:
            return rows[0]

        base_prefix = clean_alnum.split("ITEM")[0] if "ITEM" in clean_alnum else clean_alnum
        cand_rows = search_parts(base_prefix, limit=30, company_id=company_id)
        for r in cand_rows:
            r_alnum = re.sub(r'[^A-Z0-9]', '', (r.get("part_no") or "").upper())
            if r_alnum in variants:
                return r

    return None

def get_parts_by_spec(grade=None, thickness=None, limit=60, company_id=None):
    """
    Fetch parts with matching grade and thickness from the parts master scoped by company_id.
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
    return _safe_supabase_get(url, company_id=company_id)

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
    if "stores" not in rm_dict:
        rm_dict["stores"] = {"Main Stores": rm_dict.get("available_sheets", 0)}
    if "branch_code" not in rm_dict:
        rm_dict["branch_code"] = "ALL"
    return rm_dict

def get_all_rms(company_id=None):
    """Fetch all RM sheets from store scoped by company_id"""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return []
    url = f"{SUPABASE_URL}/rest/v1/rm?select=*&order=available_sheets.desc"
    rows = _safe_supabase_get(url, company_id=company_id)
    return [parse_rm_specs(r) for r in rows]

def get_rms_by_spec(grade=None, thickness=None, branch=None, company_id=None):
    """
    Fetch RM sheets matching grade and thickness:
    1. Try live Tara ERP ORDS API first (with optional branch filter e.g. PEPIPL, PEI2).
    2. Fallback to Supabase rm table scoped by company_id.
    """
    target_tenant = (branch or company_id or "").strip()
    b_code = target_tenant if target_tenant and target_tenant.upper() != "ALL" else None

    if thickness is not None:
        try:
            from tara_erp_client import tara_erp_client
            erp_sheets = tara_erp_client.fetch_rm_sheet_details(thickness=float(thickness), grade=grade, branch_code=b_code)
            if erp_sheets:
                return erp_sheets
        except Exception as e:
            logger.warning(f"Tara ERP live RM fetch fallback: {e}")

    if not SUPABASE_URL or not SUPABASE_KEY:
        return []
    
    url = f"{SUPABASE_URL}/rest/v1/rm?select=*&order=available_sheets.desc"
    try:
        raw_rows = _safe_supabase_get(url, company_id=target_tenant)
        all_rms = [parse_rm_specs(r) for r in raw_rows]
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

def get_rm(rm_code, branch=None, company_id=None):
    """Fetch single RM sheet details by rm_code (Tara ERP Live First, then Supabase)"""
    if not rm_code:
        return None

    target_tenant = (branch or company_id or "").strip()
    b_code = target_tenant if target_tenant and target_tenant.upper() != "ALL" else None

    # 1. Try Tara ERP Live API
    try:
        from tara_erp_client import tara_erp_client, extract_grade_from_text
        thk_match = re.search(r'[-*](\d+(?:\.\d+)?)[-*]', rm_code)
        if thk_match:
            thk_val = float(thk_match.group(1))
            grd = extract_grade_from_text(rm_code)
            erp_sheets = tara_erp_client.fetch_rm_sheet_details(thickness=thk_val, grade=grd, branch_code=b_code, include_zero_stock=True)
            for s in erp_sheets:
                if s["rm_code"].upper() == rm_code.upper():
                    return s
    except Exception as e:
        logger.warning(f"Tara ERP single RM fetch fallback: {e}")

    # 2. Supabase rm table fallback
    if not SUPABASE_URL or not SUPABASE_KEY:
        return None
    url = f"{SUPABASE_URL}/rest/v1/rm?rm_code=eq.{rm_code}&limit=1"
    rows = _safe_supabase_get(url, company_id=target_tenant)
    if rows:
        return parse_rm_specs(rows[0])
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

def get_produced_qty_from_app_mo(part_no, company_id=None):
    """
    Computes total quantity already produced for this part across active MOs in app_mo scoped by company_id.
    Excludes REJECTED MOs.
    """
    if not SUPABASE_URL or not SUPABASE_KEY or not part_no:
        return 0.0

    p_clean = str(part_no).strip().lower()
    p_base = p_clean.split(" - ")[0].split(" / ")[0]

    try:
        mos = list_app_mos(limit=250, company_id=company_id)
        total_produced = 0.0

        for mo in mos:
            if str(mo.get("status", "")).upper() == "REJECTED":
                continue
            parts = mo.get("parts_produced")
            if isinstance(parts, str):
                try:
                    parts = json.loads(parts)
                except Exception:
                    parts = []
            if isinstance(parts, list):
                for p in parts:
                    if isinstance(p, dict):
                        cand = str(p.get("part_no") or p.get("base_part") or "").strip().lower()
                        cand_base = cand.split(" - ")[0].split(" / ")[0]
                        if cand == p_clean or cand_base == p_base or cand == p_base or cand_base == p_clean:
                            q = float(p.get("qty") or p.get("target_qty") or p.get("blank_qty") or 0)
                            total_produced += q

        return total_produced
    except Exception as e:
        logger.error(f"get_produced_qty_from_app_mo exception: {e}")
        return 0.0

def get_mrp_for_part(part_no, month_year=None, company_id=None):
    """
    Fetch MRP record for a part (latest or specific month) scoped by company_id and incorporates
    parts already produced from active app_mo records:
    - initial_stock: original current_stock from MRP table
    - app_mo_produced: sum of parts produced from active app_mo orders
    - current_stock: initial_stock + app_mo_produced
    - qty_to_produce: max(0, monthly_schedule - current_stock)
    Supports robust fallback across normalized variants (e.g. MBA01221 - Item 2 vs MBA01221ITEM02).
    """
    if not SUPABASE_URL or not SUPABASE_KEY or not part_no:
        return None
    
    part_clean = str(part_no).strip()
    url = f"{SUPABASE_URL}/rest/v1/mrp?part_no=eq.{part_clean}"
    if month_year:
        url += f"&month_year=eq.{month_year}"
    url += "&order=id.desc&limit=1"

    try:
        rows = _safe_supabase_get(url, company_id=company_id)
        if not rows:
            # Case-insensitive
            url_ilike = f"{SUPABASE_URL}/rest/v1/mrp?part_no=ilike.{part_clean}"
            if month_year:
                url_ilike += f"&month_year=eq.{month_year}"
            url_ilike += "&order=id.desc&limit=1"
            rows = _safe_supabase_get(url_ilike, company_id=company_id)

        if not rows:
            # Try normalized alphanumeric match using fast exact 'in' query
            clean_alnum = re.sub(r'[^A-Z0-9]', '', part_clean.upper())
            variants = [clean_alnum]
            if "ITEM" in clean_alnum:
                if "ITEM0" in clean_alnum:
                    variants.append(clean_alnum.replace("ITEM0", "ITEM"))
                else:
                    variants.append(re.sub(r'ITEM(\d+)$', r'ITEM0\1', clean_alnum))

            in_list = ",".join(variants)
            v_url = f"{SUPABASE_URL}/rest/v1/mrp?part_no=in.({in_list})&order=id.desc&limit=5"
            v_rows = _safe_supabase_get(v_url, company_id=company_id)
            if v_rows:
                rows = v_rows

        if not rows:
            return None
        mrp_row = rows[0]
        actual_part_no = mrp_row.get("part_no") or part_clean
        produced_mo_qty = get_produced_qty_from_app_mo(actual_part_no, company_id=company_id)
        initial_stock = float(mrp_row.get("current_stock") or 0)
        monthly_sched = float(mrp_row.get("monthly_schedule") or 0)

        effective_stock = initial_stock + produced_mo_qty
        effective_qty_to_produce = max(0.0, monthly_sched - effective_stock)

        return {
            **mrp_row,
            "initial_stock": initial_stock,
            "app_mo_produced": produced_mo_qty,
            "current_stock": effective_stock,
            "qty_to_produce": effective_qty_to_produce
        }
    except Exception as e:
        logger.error(f"get_mrp_for_part exception: {e}")
        return None

def get_mrp_for_parts_batch(part_nos, month_year=None, company_id=None):
    """
    Batch fetches MRP records for a list of part numbers from Supabase mrp table scoped by company_id.
    """
    if not SUPABASE_URL or not SUPABASE_KEY or not part_nos:
        return {}

    clean_parts = list({str(p).strip() for p in part_nos if str(p).strip()})
    if not clean_parts:
        return {}

    results = {}
    chunk_size = 50
    for i in range(0, len(clean_parts), chunk_size):
        chunk = clean_parts[i:i + chunk_size]
        joined = ",".join([f'"{p}"' for p in chunk])
        url = f"{SUPABASE_URL}/rest/v1/mrp?part_no=in.({joined})&select=*"
        if month_year:
            url += f"&month_year=eq.{month_year}"

        try:
            rows = _safe_supabase_get(url, company_id=company_id)
            for row in rows:
                p_no = row.get("part_no")
                if p_no and p_no not in results:
                    init_stock = float(row.get("current_stock") or 0)
                    sched = float(row.get("monthly_schedule") or 0)
                    mo_prod = get_produced_qty_from_app_mo(p_no, company_id=company_id)
                    eff_stock = init_stock + mo_prod
                    eff_to_prod = max(0.0, sched - eff_stock)
                    results[p_no] = {
                        **row,
                        "initial_stock": init_stock,
                        "app_mo_produced": mo_prod,
                        "current_stock": eff_stock,
                        "qty_to_produce": eff_to_prod
                    }
        except Exception as e:
            logger.error(f"get_mrp_for_parts_batch exception: {e}")

    return results

def create_or_update_mrp(data):
    """
    Inserts or updates an MRP Demand Schedule record in Supabase public.mrp table.
    Fields:
    - part_no: Component part number (e.g. MBA01008ITEM02)
    - month_year: Target scheduling month (e.g. 2026-11)
    - monthly_schedule: Total units required by MRP
    - current_stock: Current in-house stock count
    - company_id: Tenant scope (PEPIPL or PEI2)
    - status: 'ACTIVE' by default
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        return {"success": False, "error": "Database not configured"}

    part_no = (data.get("part_no") or "").strip()
    if not part_no:
        return {"success": False, "error": "Part Number is required"}

    company_id = (data.get("company_id") or "PEPIPL").strip().upper()
    month_year = (data.get("month_year") or "").strip() or datetime.now().strftime("%Y-%m")
    status = (data.get("status") or "ACTIVE").strip().upper()

    try:
        monthly_schedule = int(float(data.get("monthly_schedule") or 0))
    except (ValueError, TypeError):
        monthly_schedule = 0

    try:
        current_stock = int(float(data.get("current_stock") or 0))
    except (ValueError, TypeError):
        current_stock = 0

    if monthly_schedule < 0:
        return {"success": False, "error": "Monthly Schedule cannot be negative"}
    if current_stock < 0:
        return {"success": False, "error": "Current Stock cannot be negative"}

    # Resolve normalized part_no if part exists in parts master
    resolved_part_no = part_no
    part_rec = get_part(part_no, company_id=company_id)
    if part_rec and part_rec.get("part_no"):
        resolved_part_no = part_rec.get("part_no")

    # Check if an existing MRP record exists for this part and month
    existing_url = f"{SUPABASE_URL}/rest/v1/mrp?part_no=eq.{resolved_part_no}&month_year=eq.{month_year}&limit=1"
    existing_rows = _safe_supabase_get(existing_url, company_id=company_id)
    if not existing_rows and part_no != resolved_part_no:
        existing_url2 = f"{SUPABASE_URL}/rest/v1/mrp?part_no=eq.{part_no}&month_year=eq.{month_year}&limit=1"
        existing_rows = _safe_supabase_get(existing_url2, company_id=company_id)

    now_iso = datetime.utcnow().isoformat() + "Z"

    if existing_rows:
        # Update existing record
        rec_id = existing_rows[0].get("id")
        patch_payload = {
            "monthly_schedule": monthly_schedule,
            "current_stock": current_stock,
            "status": status,
            "updated_at": now_iso
        }
        patch_url = f"{SUPABASE_URL}/rest/v1/mrp?id=eq.{rec_id}"
        try:
            res = requests.patch(patch_url, headers=_get_headers(), json=patch_payload, timeout=10)
            if res.status_code in (200, 204):
                return {
                    "success": True,
                    "action": "updated",
                    "part_no": resolved_part_no,
                    "month_year": month_year,
                    "monthly_schedule": monthly_schedule,
                    "current_stock": current_stock,
                    "qty_to_produce": max(0, monthly_schedule - current_stock)
                }
            return {"success": False, "error": f"Supabase update failed: {res.text}"}
        except Exception as pe:
            return {"success": False, "error": str(pe)}
    else:
        # Insert new MRP record
        mrp_id = get_next_id("mrp")
        insert_payload = {
            "id": mrp_id,
            "company_id": company_id,
            "month_year": month_year,
            "part_no": resolved_part_no,
            "monthly_schedule": monthly_schedule,
            "current_stock": current_stock,
            "status": status,
            "created_at": now_iso,
            "updated_at": now_iso
        }
        ok, err, saved = _safe_supabase_post(f"{SUPABASE_URL}/rest/v1/mrp", insert_payload, timeout=10)
        if ok:
            return {
                "success": True,
                "action": "created",
                "part_no": resolved_part_no,
                "month_year": month_year,
                "monthly_schedule": monthly_schedule,
                "current_stock": current_stock,
                "qty_to_produce": max(0, monthly_schedule - current_stock),
                "data": saved
            }
        return {"success": False, "error": err or "Failed to insert MRP schedule"}

def bulk_import_mrp(rows, company_id=None, default_month_year=None):
    """
    Bulk inserts or updates MRP schedule records from CSV rows for the authenticated company.
    Normalized columns: part_no, monthly_schedule, current_stock, month_year.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        return {"success": False, "error": "Database not configured"}

    company_id = (company_id or "PEPIPL").strip().upper()
    default_month_year = (default_month_year or "").strip() or datetime.now().strftime("%Y-%m")

    if not rows:
        return {"success": False, "error": "No data rows provided in CSV"}

    # 1. Fetch registered parts for this company to allow case & formatting normalization
    parts_url = f"{SUPABASE_URL}/rest/v1/parts?select=part_no&company_id=eq.{company_id}&limit=2000"
    all_parts = _safe_supabase_get(parts_url, company_id=company_id) or []
    part_lookup = {}
    for p in all_parts:
        pno = p.get("part_no") or ""
        if pno:
            part_lookup[pno] = pno
            p_clean = re.sub(r'[^A-Z0-9]', '', pno.upper())
            part_lookup[p_clean] = pno

    # 2. Parse and clean incoming rows
    months_needed = set()
    cleaned_rows = []
    skipped = []

    for idx, r in enumerate(rows):
        # Support flexible column header variations
        raw_pno = str(r.get("part_no") or r.get("part no") or r.get("part") or r.get("item_no") or r.get("item no") or r.get("component") or "").strip()
        if not raw_pno:
            skipped.append(f"Row {idx+1}: Missing part number")
            continue

        raw_sched = r.get("monthly_schedule") or r.get("schedule") or r.get("monthly target") or r.get("monthly_target") or r.get("target") or r.get("mrp_qty") or r.get("qty") or r.get("demand") or 0
        raw_stock = r.get("current_stock") or r.get("stock") or r.get("in_house_stock") or r.get("in house stock") or r.get("on_hand") or r.get("inventory") or 0
        m_year = str(r.get("month_year") or r.get("month-year") or r.get("month") or default_month_year).strip() or default_month_year

        try:
            monthly_schedule = int(float(raw_sched))
        except (ValueError, TypeError):
            monthly_schedule = 0

        try:
            current_stock = int(float(raw_stock))
        except (ValueError, TypeError):
            current_stock = 0

        if monthly_schedule < 0:
            monthly_schedule = 0
        if current_stock < 0:
            current_stock = 0

        # Match part against master catalog
        p_clean = re.sub(r'[^A-Z0-9]', '', raw_pno.upper())
        resolved_part_no = part_lookup.get(raw_pno) or part_lookup.get(p_clean) or raw_pno

        months_needed.add(m_year)
        cleaned_rows.append({
            "part_no": resolved_part_no,
            "raw_part_no": raw_pno,
            "monthly_schedule": monthly_schedule,
            "current_stock": current_stock,
            "month_year": m_year
        })

    if not cleaned_rows:
        return {"success": False, "error": "No valid rows found in CSV", "skipped": skipped}

    # 3. Query existing MRP records for all targeted months
    existing_mrp_map = {}
    for m in months_needed:
        m_url = f"{SUPABASE_URL}/rest/v1/mrp?month_year=eq.{m}&company_id=eq.{company_id}&select=id,part_no,month_year&limit=5000"
        m_rows = _safe_supabase_get(m_url, company_id=company_id) or []
        for mr in m_rows:
            key = (mr.get("part_no"), mr.get("month_year"))
            existing_mrp_map[key] = mr.get("id")

    # 4. Separate rows into updates and inserts
    to_update = []
    to_insert = []
    now_iso = datetime.utcnow().isoformat() + "Z"
    next_id = get_next_id("mrp")

    created_count = 0
    updated_count = 0
    seen_in_batch = set()

    for item in cleaned_rows:
        key = (item["part_no"], item["month_year"])
        if key in seen_in_batch:
            continue
        seen_in_batch.add(key)

        existing_id = existing_mrp_map.get(key)
        if existing_id:
            to_update.append({
                "id": existing_id,
                "part_no": item["part_no"],
                "monthly_schedule": item["monthly_schedule"],
                "current_stock": item["current_stock"],
                "status": "ACTIVE",
                "updated_at": now_iso
            })
        else:
            to_insert.append({
                "id": next_id,
                "company_id": company_id,
                "month_year": item["month_year"],
                "part_no": item["part_no"],
                "monthly_schedule": item["monthly_schedule"],
                "current_stock": item["current_stock"],
                "status": "ACTIVE",
                "created_at": now_iso,
                "updated_at": now_iso
            })
            next_id += 1

    headers = _get_headers()

    # 5. Execute Updates
    for upd in to_update:
        upd_id = upd["id"]
        patch_payload = {
            "monthly_schedule": upd["monthly_schedule"],
            "current_stock": upd["current_stock"],
            "status": upd["status"],
            "updated_at": upd["updated_at"]
        }
        patch_url = f"{SUPABASE_URL}/rest/v1/mrp?id=eq.{upd_id}"
        try:
            res = requests.patch(patch_url, headers=headers, json=patch_payload, timeout=8)
            if res.status_code in (200, 204):
                updated_count += 1
            else:
                skipped.append(f"Update failed for '{upd['part_no']}': {res.text}")
        except Exception as e:
            skipped.append(f"Update error for '{upd['part_no']}': {str(e)}")

    # 6. Execute Inserts in chunks of 50
    batch_size = 50
    post_url = f"{SUPABASE_URL}/rest/v1/mrp"
    for i in range(0, len(to_insert), batch_size):
        chunk = to_insert[i:i + batch_size]
        try:
            res = requests.post(post_url, headers=headers, json=chunk, timeout=12)
            if res.status_code in (200, 201):
                created_count += len(chunk)
            else:
                # Fallback to single row inserts if batch encounters an error (e.g. invalid part FK)
                for single in chunk:
                    try:
                        s_res = requests.post(post_url, headers=headers, json=[single], timeout=6)
                        if s_res.status_code in (200, 201):
                            created_count += 1
                        else:
                            skipped.append(f"Part '{single['part_no']}' not registered in parts master: skipped")
                    except Exception as se:
                        skipped.append(f"Insert error for '{single['part_no']}': {str(se)}")
        except Exception as e:
            skipped.append(f"Batch insert error: {str(e)}")

    return {
        "success": True,
        "company_id": company_id,
        "total_rows": len(cleaned_rows),
        "created": created_count,
        "updated": updated_count,
        "skipped": skipped
    }

def get_mos_for_part(part_no, limit=10, branch=None, company_id=None):
    """Fetch ERP historical cutting orders for this part (Tara ERP Live First, then Supabase) scoped by tenant"""
    if not part_no:
        return []

    target_tenant = (branch or company_id or "").strip()
    b_code = target_tenant if target_tenant and target_tenant.upper() != "ALL" else None

    # 1. Try Tara ERP Live API
    try:
        from tara_erp_client import tara_erp_client
        mo_res = tara_erp_client.fetch_sheet_cutting_orders(part_no=part_no, branch_code=b_code)
        orders = mo_res.get("orders", [])
        if orders:
            formatted = []
            for o in orders[:limit]:
                formatted.append({
                    "mo_number": o.get("cutting_order_no"),
                    "date": (o.get("cutting_order_date") or "")[:10],
                    "part_no": part_no,
                    "already_produced_stock": o.get("parent_qty", 0),
                    "rem_stock_toproduce": 0,
                    "rm_item_code": o.get("rm_item_code"),
                    "no_of_sets": o.get("no_of_sets")
                })
            return formatted
    except Exception as e:
        logger.warning(f"Tara ERP live MO fetch fallback: {e}")

    # 2. Supabase mos table fallback
    if not SUPABASE_URL or not SUPABASE_KEY:
        return []
    url = f"{SUPABASE_URL}/rest/v1/mos?part_no=eq.{part_no}&order=date.desc&limit={limit}"
    return _safe_supabase_get(url, company_id=target_tenant)

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

def ensure_rm_in_db(rm_code: str, grade: str = "", thickness: float = None, length: float = None, width: float = None, company_id: str = "PEPIPL") -> str:
    """
    Ensures that the given rm_code satisfies the foreign key constraint app_mo_rm_code_fkey
    referencing public.rm(rm_code).
    1. Checks if rm_code exists in rm table.
    2. If not, checks normalized variants with grade and hyphens (e.g. 'HR-5.8-2500-1250' vs '5.8*2500*1250').
    3. If still missing, automatically registers the RM row into rm table.
    Returns the valid rm_code present in public.rm.
    """
    if not rm_code or not SUPABASE_URL or not SUPABASE_KEY:
        return rm_code or ""

    raw_clean = str(rm_code).strip()
    headers = _get_headers()

    # 1. Exact match in rm table
    try:
        url_check = f"{SUPABASE_URL}/rest/v1/rm?rm_code=eq.{raw_clean}&select=rm_code&limit=1"
        res = requests.get(url_check, headers=headers, timeout=5)
        if res.status_code == 200 and res.json():
            return raw_clean
    except Exception as e:
        logger.warning(f"Error checking rm existence: {e}")

    # 2. Variant checks (with grade, hyphens)
    grd = (grade or "").strip().upper()
    hyph = raw_clean.replace("*", "-")
    variants = []
    if grd:
        variants.append(f"{grd}-{raw_clean}".replace("*", "-"))
        variants.append(f"{grd}-{raw_clean}")
    variants.append(hyph)
    variants.append(raw_clean.replace(" ", ""))
    variants = [v for v in variants if v and v != raw_clean]

    for v in variants:
        try:
            url_v = f"{SUPABASE_URL}/rest/v1/rm?rm_code=eq.{v}&select=rm_code&limit=1"
            res_v = requests.get(url_v, headers=headers, timeout=5)
            if res_v.status_code == 200 and res_v.json():
                logger.info(f"Resolved RM code from '{raw_clean}' to existing '{v}' in database")
                return v
        except Exception:
            pass

    # 3. If not found anywhere, auto-insert into rm table so foreign key is guaranteed
    chosen_code = variants[0] if (grd and variants and grd in variants[0]) else (f"{grd}-{hyph}" if grd and not hyph.startswith(grd) else hyph)
    weight = 0.0
    if thickness and length and width:
        try:
            weight = round(float(thickness) * float(length) * float(width) * 0.00000785, 3)
        except Exception:
            weight = 0.0

    insert_payload = {
        "rm_code": chosen_code,
        "company_id": company_id or "PEPIPL",
        "available_sheets": 0,
        "weight_per_sheet": weight
    }

    try:
        url_ins = f"{SUPABASE_URL}/rest/v1/rm"
        res_ins = requests.post(url_ins, headers={**headers, "Prefer": "return=representation"}, json=insert_payload, timeout=6)
        if res_ins.status_code in (200, 201):
            logger.info(f"Auto-registered missing RM code '{chosen_code}' in public.rm table")
            return chosen_code
        else:
            logger.warning(f"Failed to auto-register RM code '{chosen_code}': {res_ins.text}")
    except Exception as e:
        logger.error(f"Exception auto-registering RM code: {e}")

    return chosen_code


def create_app_mo(data, company_id=None):
    """
    Creates an MO record, deducts RM sheets, logs generated endbits, and records audit trail.
    Assigns explicit ID to prevent PostgreSQL sequence permission errors with anon keys.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        return {"success": False, "error": "Database not configured"}

    if company_id:
        data["company_id"] = data.get("company_id") or company_id

    mo_no = data.get("mo_no") or generate_next_mo_number()
    raw_rm = data.get("rm_code") or ""
    grade = data.get("grade") or ""
    thk = data.get("thickness")
    lng = data.get("length")
    wdt = data.get("width")
    target_company = data.get("company_id") or company_id or "PEPIPL"

    # Ensure RM code satisfies foreign key constraint
    rm_code = ensure_rm_in_db(raw_rm, grade=grade, thickness=thk, length=lng, width=wdt, company_id=target_company)
    data["rm_code"] = rm_code

    no_of_rm_sheets = float(data.get("no_of_rm_sheets", 0))
    parts_produced = data.get("parts_produced", [])
    parts_qty = float(data.get("parts_qty", 0))

    # Ensure parts_qty represents the complete sum of all parts produced (not just base part)
    if isinstance(parts_produced, str):
        try:
            parts_produced = json.loads(parts_produced)
        except Exception:
            pass

    sum_from_parts = 0.0
    if isinstance(parts_produced, list):
        for p in parts_produced:
            if isinstance(p, dict):
                sum_from_parts += float(p.get("qty") or p.get("target_qty") or p.get("blank_qty") or 0)
            elif isinstance(p, (int, float)):
                sum_from_parts += float(p)

    if sum_from_parts > 0 and (parts_qty == 0 or sum_from_parts != parts_qty):
        parts_qty = sum_from_parts

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

    company_id = data.get("company_id") or "PEI2"
    record = {
        "id": row_id,
        "company_id": company_id,
        "branch_code": data.get("branch_code") or company_id,
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
    ok, err, inserted = _safe_supabase_post(url, record, timeout=10)
    if not ok:
        return {"success": False, "error": f"Failed to insert MO: {err}"}

    # 1. Deduct sheets from RM stock
    if rm_code and no_of_rm_sheets > 0:
        update_rm_sheets(rm_code, -no_of_rm_sheets)

    # 2. Log generated endbit into endbits table if applicable
    if endbits_desc and no_of_rm_sheets > 0:
        log_endbit_batch(mo_no, endbits_desc, no_of_rm_sheets, endbit_weight, company_id=company_id)

    return {"success": True, "mo_no": mo_no, "data": inserted or record}

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

def list_app_mos(status=None, stage=None, limit=50, company_id=None):
    """List application MOs with optional status, stage, and company_id tenant filters"""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return []
    url = f"{SUPABASE_URL}/rest/v1/app_mo?select=*&order=id.desc&limit={limit}"
    if status:
        url += f"&status=eq.{status}"
    if stage:
        url += f"&current_stage=eq.{stage}"
    return _safe_supabase_get(url, company_id=company_id)

# ============================================================================
# 6. ENDBITS (OFFCUT BATCH STORE)
# ============================================================================

def log_endbit_batch(mo_no, endbit_desc, quantity, weight, endbit_id_num=None, company_id=None):
    """Logs a new endbit batch generated from an MO with explicit ID and company_id"""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return None
    url = f"{SUPABASE_URL}/rest/v1/endbits"
    eb_id = endbit_id_num or get_next_id("endbits")
    c_id = company_id or "PEI2"
    payload = {
        "id": eb_id,
        "company_id": c_id,
        "mo_no": mo_no,
        "endbit": endbit_desc,
        "quantity": float(quantity),
        "weight": float(weight)
    }
    ok, err, inserted = _safe_supabase_post(url, payload, timeout=10)
    return ok

def get_available_endbits(company_id=None):
    """Fetch all available endbit batches with stock > 0 scoped by company_id"""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return []
    url = f"{SUPABASE_URL}/rest/v1/endbits?quantity=gt.0&order=id.desc"
    return _safe_supabase_get(url, company_id=company_id)

# ============================================================================
# 7. ENDBIT_MO (CUTTING FROM ENDBITS)
# ============================================================================

def create_endbit_mo(data, company_id=None):
    """Create order cutting parts from an existing endbit batch with explicit ID and company_id"""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return {"success": False, "error": "Database not configured"}
    
    eb_mo_no = data.get("eb_mo_no") or f"EB-MO-{int(datetime.now().timestamp()) % 10000:04d}"
    endbit_id = data.get("endbit_id")
    no_of_eb_sheets = float(data.get("no_of_eb_sheets", 0))
    row_id = data.get("id") or get_next_id("endbit_mo")
    c_id = data.get("company_id") or company_id or "PEI2"

    record = {
        "id": row_id,
        "company_id": c_id,
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
    ok, err, inserted = _safe_supabase_post(url, record, timeout=10)
    if not ok:
        return {"success": False, "error": f"Failed to insert Endbit MO: {err}"}
        
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

    return {"success": True, "eb_mo_no": eb_mo_no, "data": inserted or record}
