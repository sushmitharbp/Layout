"""
SheetLayout AI — Password Retrieval & Admin Reset Tool
Run: python show_passwords.py
"""

import sys
import user_db

def display_passwords():
    print("\n" + "=" * 65)
    print("      SHEETLAYOUT AI — REGISTERED DEPARTMENT PASSWORDS")
    print("=" * 65)
    
    users = user_db._load_local_users()
    
    # Try fetching fresh data from Supabase app_users table if available
    if user_db.SUPABASE_URL and user_db.SUPABASE_KEY:
        try:
            import requests
            url = f"{user_db.SUPABASE_URL}/rest/v1/app_users?select=*&order=company_id.asc,department.asc"
            res = requests.get(url, headers=user_db._get_headers(), timeout=5)
            if res.status_code == 200 and res.json():
                users = res.json()
                print("  Source: Supabase PostgreSQL (public.app_users)")
            else:
                print("  Source: Local Synchronization Store (data_users.json)")
        except Exception:
            print("  Source: Local Synchronization Store (data_users.json)")
    else:
        print("  Source: Local Store (data_users.json)")

    print("-" * 65)
    print(f" {'COMPANY ID':<12} | {'DEPARTMENT':<12} | {'PASSWORD':<16} | {'ROLE NAME'}")
    print("-" * 65)

    for u in users:
        comp = u.get("company_id", "PEPIPL")
        dept = u.get("department", "shearing")
        pw = u.get("password_hash") or u.get("password") or "N/A"
        name = u.get("display_name", "")
        print(f" {comp:<12} | {dept:<12} | {pw:<16} | {name}")

    print("=" * 65 + "\n")

def reset_password(company_id, department, new_password):
    ok, msg = user_db.set_user_password(company_id, department, new_password)
    if ok:
        print(f"✓ Successfully reset password for {company_id} ({department}) to: '{new_password}'")
    else:
        print(f"✗ Failed to reset password: {msg}")

if __name__ == "__main__":
    if len(sys.argv) >= 5 and sys.argv[1] == "--reset":
        # Usage: python show_passwords.py --reset PEPIPL shearing newPass123
        reset_password(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        display_passwords()
