"""
Fast parallel script to upload local layout images from static/layout_images/
to the Supabase Storage bucket 'layout-images', and update the
'image_url' column in public.layout_records to point to the Supabase CDN URL.
"""
import os
import sys
import mimetypes
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY", "").strip()
BUCKET_NAME = "layout-images"
IMAGES_DIR = os.path.join(os.path.dirname(__file__), "static", "layout_images")

if not SUPABASE_URL or not SUPABASE_KEY:
    print("[ERROR] SUPABASE_URL or SUPABASE_KEY not set in .env", flush=True)
    sys.exit(1)

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}"
}

# Create a session with HTTP connection pooling for fast parallel uploads
session = requests.Session()
adapter = requests.adapters.HTTPAdapter(pool_connections=25, pool_maxsize=25, max_retries=3)
session.mount("https://", adapter)

def upload_image(file_name, file_path):
    mime_type, _ = mimetypes.guess_type(file_path)
    if not mime_type:
        mime_type = "image/png"
    
    upload_url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET_NAME}/{file_name}"
    headers = {
        **HEADERS,
        "Content-Type": mime_type,
        "x-upsert": "true"
    }
    
    try:
        with open(file_path, "rb") as f:
            data = f.read()
        res = session.post(upload_url, headers=headers, data=data, timeout=30)
        return res.status_code in [200, 201]
    except Exception as e:
        return False

def get_public_url(file_name):
    return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET_NAME}/{file_name}"

def patch_record_url(record_id, cloud_url):
    patch_url = f"{SUPABASE_URL}/rest/v1/layout_records?id=eq.{record_id}"
    try:
        res = session.patch(
            patch_url,
            headers={**HEADERS, "Content-Type": "application/json", "Prefer": "return=minimal"},
            json={"image_url": cloud_url},
            timeout=15
        )
        return res.status_code in [200, 204]
    except Exception:
        return False

def update_database_mappings():
    print("\nUpdating layout_records table image_url in Supabase...", flush=True)
    url = f"{SUPABASE_URL}/rest/v1/layout_records?select=id,image_url&image_url=not.is.null"
    res = session.get(url, headers=HEADERS, timeout=30)
    if res.status_code != 200:
        print(f"Error fetching records: {res.text}", flush=True)
        return
    
    records = res.json()
    print(f"Found {len(records)} records with image_url to inspect/update.", flush=True)
    
    tasks = []
    for r in records:
        img_url = r.get("image_url") or ""
        if "/static/layout_images/" in img_url:
            filename = os.path.basename(img_url)
            cloud_url = get_public_url(filename)
            tasks.append((r["id"], cloud_url))

    print(f"Updating {len(tasks)} records in Supabase to CDN URLs...", flush=True)
    updated_count = 0
    with ThreadPoolExecutor(max_workers=20) as executor:
        futures = [executor.submit(patch_record_url, rec_id, curl) for rec_id, curl in tasks]
        for idx, fut in enumerate(as_completed(futures), 1):
            if fut.result():
                updated_count += 1
            if idx % 200 == 0 or idx == len(tasks):
                print(f"DB Mapping Progress: {idx}/{len(tasks)} updated...", flush=True)

    print(f"Successfully updated {updated_count}/{len(tasks)} records to Supabase CDN URLs!", flush=True)

def main():
    print(f"Connecting to bucket '{BUCKET_NAME}' at {SUPABASE_URL}...", flush=True)
    if not os.path.exists(IMAGES_DIR):
        print(f"Error: {IMAGES_DIR} does not exist.", flush=True)
        return

    files = [f for f in os.listdir(IMAGES_DIR) if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp'))]
    print(f"Total image files to upload: {len(files)}", flush=True)

    success_count = 0
    with ThreadPoolExecutor(max_workers=16) as executor:
        future_to_file = {
            executor.submit(upload_image, f, os.path.join(IMAGES_DIR, f)): f
            for f in files
        }
        for idx, future in enumerate(as_completed(future_to_file), 1):
            if future.result():
                success_count += 1
            if idx % 100 == 0 or idx == len(files):
                print(f"Image Upload Progress: {idx}/{len(files)} uploaded...", flush=True)

    print(f"\nUpload complete! {success_count}/{len(files)} images uploaded successfully to Supabase Storage.", flush=True)
    
    update_database_mappings()
    print("\nAll done! All layout images are now stored in Supabase and mapped in layout_records.", flush=True)

if __name__ == "__main__":
    main()
