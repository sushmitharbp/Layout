"""
SheetLayout AI — Database User & Department Authentication Layer
Interacts with Supabase 'public.app_users' table with automatic local synchronization.
"""

import os
import json
import logging
from datetime import datetime
import requests
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY") or os.getenv("SUPABASE_ANON_KEY")

LOCAL_USERS_FILE = "data_users.json"
logger = logging.getLogger("sheetlayout.user_db")

# Default baseline department credentials
DEFAULT_USERS = [
    {
        "company_id": "PEPIPL",
        "branch_code": "PEPIPL",
        "department": "shearing",
        "username": "shearing",
        "password_hash": "shearing123",
        "display_name": "Shearing Production Floor",
        "is_active": True
    },
    {
        "company_id": "PEPIPL",
        "branch_code": "PEPIPL",
        "department": "krysalis",
        "username": "krysalis",
        "password_hash": "krysalis123",
        "display_name": "Consultants (Krysalis) Design",
        "is_active": True
    },
    {
        "company_id": "PEPIPL",
        "branch_code": "PEPIPL",
        "department": "purchase",
        "username": "purchase",
        "password_hash": "purchase123",
        "display_name": "Purchase Team",
        "is_active": True
    },
    {
        "company_id": "PEPIPL",
        "branch_code": "PEPIPL",
        "department": "erp",
        "username": "erp",
        "password_hash": "erp123",
        "display_name": "ERP Master Gateway",
        "is_active": True
    },
    {
        "company_id": "PEI2",
        "branch_code": "PEI2",
        "department": "shearing",
        "username": "shearing",
        "password_hash": "shearing123",
        "display_name": "Shearing Production Floor (Unit 2)",
        "is_active": True
    },
    {
        "company_id": "PEI2",
        "branch_code": "PEI2",
        "department": "krysalis",
        "username": "krysalis",
        "password_hash": "krysalis123",
        "display_name": "Consultants (Krysalis) Design (Unit 2)",
        "is_active": True
    },
    {
        "company_id": "PEI2",
        "branch_code": "PEI2",
        "department": "purchase",
        "username": "purchase",
        "password_hash": "purchase123",
        "display_name": "Purchase Team (Unit 2)",
        "is_active": True
    },
    {
        "company_id": "PEI2",
        "branch_code": "PEI2",
        "department": "erp",
        "username": "erp",
        "password_hash": "erp123",
        "display_name": "ERP Master Gateway (Unit 2)",
        "is_active": True
    }
]


def _get_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation"
    }


def _load_local_users():
    """Load local user store or initialize with default users"""
    if not os.path.exists(LOCAL_USERS_FILE):
        _save_local_users(DEFAULT_USERS)
        return list(DEFAULT_USERS)
    try:
        with open(LOCAL_USERS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else list(DEFAULT_USERS)
    except Exception as e:
        logger.error(f"Error reading {LOCAL_USERS_FILE}: {e}")
        return list(DEFAULT_USERS)


def _save_local_users(users_list):
    """Save users to local JSON backup store"""
    try:
        with open(LOCAL_USERS_FILE, "w", encoding="utf-8") as f:
            json.dump(users_list, f, indent=2)
    except Exception as e:
        logger.error(f"Error writing to {LOCAL_USERS_FILE}: {e}")


def get_user(company_id, department):
    """
    Fetch a user record by company_id and department.
    Queries Supabase 'app_users' first; falls back to local user store.
    """
    comp = (company_id or "").strip().upper()
    dept = (department or "").strip().lower()

    if not comp or not dept:
        return None

    # 1. Try Supabase app_users table
    if SUPABASE_URL and SUPABASE_KEY:
        try:
            url = f"{SUPABASE_URL}/rest/v1/app_users?company_id=eq.{comp}&department=eq.{dept}&limit=1"
            res = requests.get(url, headers=_get_headers(), timeout=5)
            if res.status_code == 200:
                rows = res.json()
                if rows and len(rows) > 0:
                    return rows[0]
            elif res.status_code != 404:
                logger.warning(f"Supabase app_users query status {res.status_code}: {res.text}")
        except Exception as e:
            logger.debug(f"Supabase app_users lookup skipped/failed: {e}")

    # 2. Fallback to local store
    users = _load_local_users()
    for u in users:
        if u.get("company_id", "").upper() == comp and u.get("department", "").lower() == dept:
            return u

    return None


def verify_user(company_id, department, password):
    """
    Verifies user credentials.
    Returns (True, user_dict) on success, (False, None) on failure.
    """
    if not password:
        return False, None

    user = get_user(company_id, department)
    if not user:
        return False, None

    if not user.get("is_active", True):
        return False, None

    stored_pw = user.get("password_hash") or user.get("password") or ""
    if str(password).strip() == str(stored_pw).strip():
        return True, user

    return False, None


def set_user_password(company_id, department, new_password):
    """
    Sets or updates the password for a company department user.
    Updates Supabase 'app_users' table and synchronizes local store.
    """
    comp = (company_id or "").strip().upper()
    dept = (department or "").strip().lower()
    pw = str(new_password or "").strip()

    if not comp or not dept or not pw:
        return False, "Company ID, Department, and Password cannot be empty."

    if len(pw) < 4:
        return False, "Password must be at least 4 characters long."

    now_iso = datetime.utcnow().isoformat() + "Z"
    updated_in_db = False

    # 1. Update in Supabase app_users table
    if SUPABASE_URL and SUPABASE_KEY:
        try:
            url = f"{SUPABASE_URL}/rest/v1/app_users?company_id=eq.{comp}&department=eq.{dept}"
            patch_payload = {
                "password_hash": pw,
                "updated_at": now_iso
            }
            res = requests.patch(url, headers=_get_headers(), json=patch_payload, timeout=8)
            if res.status_code in (200, 204):
                updated_in_db = True
                logger.info(f"Updated password in Supabase app_users for {comp} / {dept}")
            elif res.status_code == 404:
                # Table might not exist yet; try inserting if table exists
                pass
            else:
                logger.warning(f"Supabase patch failed ({res.status_code}): {res.text}")
        except Exception as e:
            logger.error(f"Error patching Supabase app_users: {e}")

    # 2. Update in local store
    users = _load_local_users()
    found = False
    for u in users:
        if u.get("company_id", "").upper() == comp and u.get("department", "").lower() == dept:
            u["password_hash"] = pw
            u["updated_at"] = now_iso
            found = True
            break

    if not found:
        # Create user record
        users.append({
            "company_id": comp,
            "branch_code": comp,
            "department": dept,
            "username": dept,
            "password_hash": pw,
            "display_name": f"{dept.capitalize()} Team",
            "is_active": True,
            "created_at": now_iso,
            "updated_at": now_iso
        })

    _save_local_users(users)
    return True, "Password updated successfully."


def list_users(company_id=None):
    """List registered users with masked passwords"""
    comp = (company_id or "").strip().upper() if company_id else None

    # Try Supabase first
    if SUPABASE_URL and SUPABASE_KEY:
        try:
            url = f"{SUPABASE_URL}/rest/v1/app_users?select=id,company_id,branch_code,department,username,display_name,is_active,created_at,updated_at"
            if comp:
                url += f"&company_id=eq.{comp}"
            res = requests.get(url, headers=_get_headers(), timeout=5)
            if res.status_code == 200:
                return res.json()
        except Exception:
            pass

    # Fallback to local
    users = _load_local_users()
    out = []
    for u in users:
        if not comp or u.get("company_id", "").upper() == comp:
            safe_u = dict(u)
            safe_u["password_hash"] = "********"
            out.append(safe_u)
    return out


# Ensure local store is initialized on module load
_load_local_users()

