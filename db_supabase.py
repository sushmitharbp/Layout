"""
SheetLayout AI — Database Access Module
Integrates Supabase PostgreSQL as the primary data store for sheet layout records,
with automatic fallback to local data_store.json if Supabase is offline or unconfigured.
"""

import os
import json
import logging
import requests
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY") or os.getenv("SUPABASE_ANON_KEY")

DATA_FILE = "data_store.json"

logger = logging.getLogger("sheetlayout.db")

def is_supabase_configured():
    return bool(SUPABASE_URL and SUPABASE_KEY)

def fetch_all_from_supabase():
    """Fetch all layout_records from Supabase using pagination"""
    if not is_supabase_configured():
        return None

    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json"
    }

    all_records = []
    page_size = 1000
    start = 0

    try:
        while True:
            end = start + page_size - 1
            page_headers = headers.copy()
            page_headers["Range"] = f"{start}-{end}"
            
            url = f"{SUPABASE_URL}/rest/v1/layout_records?select=*&order=row_id.asc"
            res = requests.get(url, headers=page_headers, timeout=15)
            
            if res.status_code not in (200, 206):
                logger.warning(f"Supabase returned status {res.status_code}: {res.text}")
                return None
                
            batch = res.json()
            if not batch:
                break
                
            all_records.extend(batch)
            if len(batch) < page_size:
                break
            start += page_size

        if not all_records:
            return None

        # Build in-memory indexes matching data_store format
        parts = {}
        base_parts = {}

        for r in all_records:
            p_no = r.get("part_no")
            b_no = r.get("base_part")

            if p_no:
                if p_no not in parts:
                    parts[p_no] = {
                        "part_no": p_no,
                        "base_part": b_no,
                        "records": []
                    }
                parts[p_no]["records"].append(r)

            if b_no:
                if b_no not in base_parts:
                    base_parts[b_no] = {
                        "base_part": b_no,
                        "item_parts": [],
                        "records_count": 0
                    }
                if p_no and p_no not in base_parts[b_no]["item_parts"]:
                    base_parts[b_no]["item_parts"].append(p_no)
                base_parts[b_no]["records_count"] += 1

        stats = {
            "total_records": len(all_records),
            "total_unique_parts": len(parts),
            "total_base_parts": len(base_parts),
            "records_with_images": sum(1 for r in all_records if r.get("image_url")),
            "records_with_rm_erp": sum(1 for r in all_records if r.get("rm_erp")),
            "source": "Supabase PostgreSQL"
        }

        # Samples for UI
        sample_keys = list(parts.keys())[:10]
        samples = [
            {"part_no": k, "base_part": parts[k]["base_part"], "rm_count": len(parts[k]["records"])}
            for k in sample_keys
        ]

        return {
            "stats": stats,
            "parts": parts,
            "base_parts": base_parts,
            "samples": samples,
            "records": all_records
        }

    except Exception as e:
        logger.error(f"Error connecting to Supabase: {e}")
        return None

def load_data_store():
    """Load data from Supabase if configured, otherwise fallback to local data_store.json"""
    # 1. Try Supabase first
    if is_supabase_configured():
        print(f"[Database] Fetching layout records from Supabase ({SUPABASE_URL})...")
        supabase_data = fetch_all_from_supabase()
        if supabase_data and len(supabase_data["records"]) > 0:
            print(f"[Database] Successfully loaded {len(supabase_data['records'])} records from Supabase PostgreSQL!")
            return supabase_data, "supabase"
        else:
            print("[Database] Supabase returned 0 records or had error, falling back to local data_store.json...")

    # 2. Local Fallback
    print(f"[Database] Loading local '{DATA_FILE}'...")
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        data["stats"]["source"] = "Local data_store.json (Offline)"
        print(f"[Database] Loaded {len(data.get('records', []))} records from local data store.")
        return data, "local"

    raise FileNotFoundError(f"Neither Supabase nor local '{DATA_FILE}' could be loaded.")
