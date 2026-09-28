"""
SheetLayout AI — Supabase Data Migration Tool
Uploads all 1,863 sheet layout records and metadata from data_store.json to Supabase.
"""

import os
import sys
import json
import time
import requests
from dotenv import load_dotenv

# Load .env variables
load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY") or os.getenv("SUPABASE_ANON_KEY")

DATA_FILE = "data_store.json"

def check_credentials():
    if not SUPABASE_URL or not SUPABASE_KEY:
        print("\n" + "=" * 60)
        print("ERROR: Supabase credentials not found!")
        print("=" * 60)
        print("Please set SUPABASE_URL and SUPABASE_KEY (or SUPABASE_SERVICE_ROLE_KEY)")
        print("in your d:\\Layout\\.env file. For example:")
        print("  SUPABASE_URL=https://your-project-id.supabase.co")
        print("  SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...")
        print("=" * 60 + "\n")
        return False
    return True

def get_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=representation"
    }

def test_connection():
    print(f"Testing connection to {SUPABASE_URL}...")
    endpoint = f"{SUPABASE_URL}/rest/v1/layout_records?select=count"
    try:
        res = requests.get(endpoint, headers=get_headers(), timeout=10)
        if res.status_code in (200, 206):
            print("Successfully connected to Supabase table 'layout_records'!")
            return True
        elif res.status_code == 404 or "relation" in res.text.lower():
            print("\nTable 'layout_records' not found in Supabase!")
            print("Please run 'supabase_schema.sql' in your Supabase SQL Editor first.")
            print(f"Response: {res.status_code} - {res.text}")
            return False
        else:
            print(f"Supabase responded with status {res.status_code}: {res.text}")
            return False
    except Exception as e:
        print(f"Connection failed: {e}")
        return False

def upload_records(batch_size=100):
    if not os.path.exists(DATA_FILE):
        print(f"Data file '{DATA_FILE}' not found!")
        return False

    print(f"Loading '{DATA_FILE}'...")
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    records = data.get("records", [])
    total = len(records)
    print(f"Found {total} records to upload.")

    endpoint = f"{SUPABASE_URL}/rest/v1/layout_records?on_conflict=row_id"
    headers = get_headers()

    start_time = time.time()
    uploaded = 0

    for i in range(0, total, batch_size):
        batch = records[i:i + batch_size]
        # Clean records for postgres payload
        payload = []
        for r in batch:
            clean_r = {
                "row_id": r.get("row_id"),
                "base_part": r.get("base_part") or "",
                "part_no": r.get("part_no") or "",
                "status": r.get("status") or "",
                "layout_name": r.get("layout_name") or "",
                "rm_erp": r.get("rm_erp") or "",
                "cut_blank": r.get("cut_blank") or "",
                "grade": r.get("grade") or "",
                "no_of_sheets": r.get("no_of_sheets"),
                "cutting_plan": r.get("cutting_plan") or "",
                "thickness": r.get("thickness"),
                "length": r.get("length"),
                "width": r.get("width"),
                "rm_weight": r.get("rm_weight"),
                "part1": r.get("part1"),
                "part2": r.get("part2"),
                "part3": r.get("part3"),
                "part4": r.get("part4"),
                "per_sheet": r.get("per_sheet"),
                "total_sheet": r.get("total_sheet"),
                "endbits": r.get("endbits"),
                "po_price": r.get("po_price"),
                "wastage_cost": r.get("wastage_cost"),
                "image_url": r.get("image_url")
            }
            payload.append(clean_r)

        try:
            resp = requests.post(endpoint, headers=headers, json=payload, timeout=30)
            if resp.status_code in (200, 201):
                uploaded += len(batch)
                pct = (uploaded / total) * 100
                print(f"[{uploaded}/{total}] ({pct:.1f}%) records uploaded successfully.")
            else:
                print(f"Error on batch {i}-{i+len(batch)}: {resp.status_code} - {resp.text}")
                # Retry individual items or report
        except Exception as ex:
            print(f"Network error on batch {i}: {ex}")

    elapsed = time.time() - start_time
    print(f"\nFinished uploading {uploaded}/{total} records in {elapsed:.1f} seconds!")

    # Verify final count in Supabase
    try:
        verify_res = requests.get(
            f"{SUPABASE_URL}/rest/v1/layout_records?select=row_id",
            headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}", "Range": "0-0", "Prefer": "count=exact"},
            timeout=10
        )
        content_range = verify_res.headers.get("Content-Range", "")
        if "/" in content_range:
            server_count = content_range.split("/")[-1]
            print(f"Verified Supabase total row count: {server_count}")
    except Exception as ex:
        print(f"Could not verify total count: {ex}")

    return uploaded > 0

if __name__ == "__main__":
    if not check_credentials():
        sys.exit(1)

    if not test_connection():
        print("Please check your Supabase URL, key, and make sure 'supabase_schema.sql' has been executed in the SQL Editor.")
        sys.exit(1)

    upload_records()
