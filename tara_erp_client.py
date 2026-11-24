"""
SheetLayout AI — Tara ERP (Oracle ORDS) Live API Integration
Praveen Engineering Products India Pvt. Ltd. (PEPIPL)

Implements:
1. OAuth 2.0 Client Credentials Authentication & Automatic Token Lifecycle
2. API 1: RM Sheet Details (Live inventory by Thickness & Material Code)
3. API 2: Sheet Cutting Orders / MO Details (by Part No, Month & Year)
"""

import os
import re
import time
import logging
from datetime import datetime
from typing import Dict, Any, List, Optional
import requests
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger("TaraERPClient")

DEFAULT_AUTH_URL = os.getenv("TARA_ERP_AUTH_URL", "https://cloud.taraerp.com/ords/taralive/oauth/token")
DEFAULT_BASE_URL = os.getenv("TARA_ERP_BASE_URL", "https://cloud.taraerp.com/ords/taralive/PEPIPL_API").rstrip("/")
DEFAULT_CLIENT_ID = os.getenv("TARA_ERP_CLIENT_ID", "hZs61R9Q0gZXvXY7EGTJdg..")
DEFAULT_CLIENT_SECRET = os.getenv("TARA_ERP_CLIENT_SECRET", "v5Y5wTxvnYQ5_IKLuq9HJw..")
DEFAULT_BRANCH_CODES = [b.strip() for b in os.getenv("TARA_ERP_BRANCH_CODES", "PEPIPL,PEI2").split(",") if b.strip()]

EXCLUDED_STORES = {"rejection stores", "rejection stores - unit 2"}


def extract_grade_from_text(code_or_desc: str) -> str:
    """Extracts material grade prefix (e.g., BSK, HR, CR, YS, BK)"""
    if not code_or_desc:
        return ""
    text = str(code_or_desc).upper().strip()
    match = re.search(r'\b(BSK|CRCA|CR|HR|YS|BK|MS|SS)\b', text)
    if match:
        return match.group(1)
    # Check leading token e.g. BSK-4.8-...
    parts = text.split("-")
    if parts and len(parts[0]) <= 6:
        return parts[0].strip()
    return ""


class TaraERPClient:
    """Client for Praveen Engineers Tara ERP (Oracle ORDS) API."""

    def __init__(
        self,
        auth_url: Optional[str] = None,
        base_url: Optional[str] = None,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        branch_codes: Optional[List[str]] = None,
        timeout: int = 25
    ):
        self.auth_url = auth_url or DEFAULT_AUTH_URL
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.client_id = client_id or DEFAULT_CLIENT_ID
        self.client_secret = client_secret or DEFAULT_CLIENT_SECRET
        self.branch_codes = branch_codes or DEFAULT_BRANCH_CODES
        self.timeout = timeout

        self._token: Optional[str] = None
        self._token_expires_at: float = 0.0

        # Short in-memory cache for RM queries to prevent excessive pagination calls (TTL: 60s)
        self._rm_cache: Dict[str, Any] = {}
        self._rm_cache_ts: float = 0.0
        self._cache_ttl = 60.0

    def get_access_token(self, force_refresh: bool = False) -> str:
        """Fetches a valid OAuth 2.0 Bearer token, refreshing if expired."""
        now = time.time()
        # Keep token if still valid for at least 5 minutes (300s)
        if self._token and not force_refresh and (self._token_expires_at - now > 300):
            return self._token

        logger.info("[Tara ERP] Requesting new OAuth 2.0 access token...")
        try:
            res = requests.post(
                self.auth_url,
                auth=(self.client_id, self.client_secret),
                data={"grant_type": "client_credentials"},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=self.timeout
            )
            if res.status_code != 200:
                raise RuntimeError(f"ERP Token error ({res.status_code}): {res.text}")

            payload = res.json()
            token = payload.get("access_token")
            expires_in = int(payload.get("expires_in") or 3600)
            if not token:
                raise RuntimeError("No access_token found in ERP auth response")

            self._token = token
            self._token_expires_at = now + expires_in
            logger.info(f"[Tara ERP] New access token obtained (expires in {expires_in}s)")
            return self._token
        except Exception as e:
            logger.error(f"[Tara ERP] Authentication failure: {e}")
            raise

    def _get_headers(self) -> Dict[str, str]:
        token = self.get_access_token()
        return {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json"
        }

    def test_connection(self) -> Dict[str, Any]:
        """Tests OAuth token issuance and ping to ERP endpoints (with edited Nov 12 P_BRANCH_CODE parameter)."""
        start_t = time.time()
        try:
            token = self.get_access_token(force_refresh=True)
            # Verify connectivity to live ORDS endpoint using P_BRANCH_CODE
            headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
            test_url = f"{self.base_url}/rm_sheet_details/?P_MATERIAL_CODE=IRN&P_THICKNESS=4.8&P_BRANCH_CODE=PEPIPL&limit=1"
            res = requests.get(test_url, headers=headers, timeout=self.timeout)
            if res.status_code != 200:
                raise RuntimeError(f"ERP Endpoint ping failed ({res.status_code}): {res.text[:200]}")

            latency_ms = round((time.time() - start_t) * 1000, 1)
            return {
                "success": True,
                "status": "CONNECTED",
                "message": "Successfully authenticated with Tara ERP Oracle ORDS (Nov 12 API with P_BRANCH_CODE verified).",
                "latency_ms": latency_ms,
                "auth_url": self.auth_url,
                "base_url": self.base_url,
                "branches": self.branch_codes
            }
        except Exception as e:
            return {
                "success": False,
                "status": "DISCONNECTED",
                "error": str(e),
                "auth_url": self.auth_url
            }

    # =========================================================================
    # API 1: RM Sheet Details (Updated per Nov 12 Edited Spec with P_BRANCH_CODE)
    # =========================================================================

    def fetch_rm_sheet_details(
        self,
        thickness: float,
        grade: Optional[str] = None,
        material_code: str = "IRN",
        branch_code: Optional[str] = None,
        include_zero_stock: bool = False
    ) -> List[Dict[str, Any]]:
        """
        Fetches live RM sheet stock from Tara ERP API.
        - Supports required P_BRANCH_CODE (PEPIPL, PEI2) per Nov 12 edited specification.
        - Automatically queries across all active branches if branch_code is None.
        - Handles ORDS pagination (offset & limit).
        - Aggregates stock across Main & WIP stores while filtering out Rejection stores.
        - Matches material grade (e.g. BSK, CRCA, HR, YS, BK).
        """
        thk_str = f"{float(thickness):g}" if thickness is not None else "4.8"
        # Strictly scope branch (default PEPIPL for Unit 1, PEI2 for Unit 2)
        req_branch = (branch_code or "PEPIPL").strip().upper()
        branches_to_query = self.branch_codes if req_branch == "ALL" else [req_branch]
        branches_key = "_".join(sorted(branches_to_query))
        cache_key = f"{material_code}_{thk_str}_{branches_key}_main_stores_only"
        now = time.time()

        # Check short in-memory cache
        cached_data = self._rm_cache.get(cache_key)
        if cached_data and (now - self._rm_cache_ts < self._cache_ttl):
            raw_items = cached_data
        else:
            raw_items = []
            headers = self._get_headers()

            for br in branches_to_query:
                offset = 0
                page_limit = 200
                while True:
                    url = f"{self.base_url}/rm_sheet_details/?P_MATERIAL_CODE={material_code}&P_THICKNESS={thk_str}&P_BRANCH_CODE={br}&limit={page_limit}&offset={offset}"
                    try:
                        res = requests.get(url, headers=headers, timeout=self.timeout)
                        if res.status_code == 401:
                            headers = self._get_headers()
                            res = requests.get(url, headers=headers, timeout=self.timeout)

                        if res.status_code != 200:
                            logger.error(f"[Tara ERP] RM query returned HTTP {res.status_code} for branch {br}: {res.text}")
                            break

                        data = res.json()
                        items = data.get("items", [])
                        raw_items.extend(items)

                        if not data.get("hasMore") or not items:
                            break
                        offset += len(items)
                    except Exception as e:
                        logger.error(f"[Tara ERP] RM query exception for branch {br}: {e}")
                        break

            # Update cache
            if raw_items:
                self._rm_cache[cache_key] = raw_items
                self._rm_cache_ts = now

        # Aggregate and filter by store & grade
        aggregated: Dict[str, Dict[str, Any]] = {}

        target_grade = (grade or "").strip().upper()

        for it in raw_items:
            store_name = str(it.get("store_desc") or "").strip().upper()
            # STRICT RULE: RM stock must come ONLY from MAIN STORES. Never from FG, WIP, Rejection, Scrap, Maintenance, Welding
            if "MAIN STORE" not in store_name:
                continue
            if any(ex in store_name for ex in ["FG", "WIP", "REJECTION", "SCRAP", "MAINTENANCE", "WELDING"]):
                continue

            br_code = str(it.get("branch_code") or "").strip().upper()
            if req_branch != "ALL" and br_code != req_branch:
                continue

            item_code = str(it.get("item_code") or "").strip()
            if not item_code:
                continue

            extracted_grade = extract_grade_from_text(item_code) or extract_grade_from_text(it.get("item_desc") or "")
            if target_grade and extracted_grade:
                if target_grade not in extracted_grade and extracted_grade not in target_grade:
                    continue

            avail_stock = float(it.get("available_stock") or 0.0)
            sheet_len = float(it.get("length") or 0.0)
            sheet_wid = float(it.get("width") or 0.0)
            sheet_thk = float(it.get("thickness") or thickness or 0.0)
            weight_per_sheet = float(it.get("weight_per_sheet") or 0.0)
            br_code = it.get("branch_code") or ""
            store_desc = it.get("store_desc") or "Store"
            store_key = f"{store_desc} ({br_code})" if br_code else store_desc

            if item_code not in aggregated:
                aggregated[item_code] = {
                    "rm_code": item_code,
                    "item_code": item_code,
                    "item_desc": it.get("item_desc") or item_code,
                    "shape_type": it.get("shape_type") or "Plate/Sheet/EndBit",
                    "grade": extracted_grade or target_grade or "IRN",
                    "thickness": sheet_thk,
                    "length": sheet_len,
                    "width": sheet_wid,
                    "sheet_length": sheet_len,
                    "sheet_width": sheet_wid,
                    "weight_per_sheet": weight_per_sheet,
                    "available_sheets": avail_stock,
                    "total_stock_weight": round(avail_stock * weight_per_sheet, 3),
                    "branch_code": br_code,
                    "branch_name": it.get("branch_name") or "",
                    "stores": {store_key: avail_stock}
                }
            else:
                aggregated[item_code]["available_sheets"] += avail_stock
                aggregated[item_code]["total_stock_weight"] = round(aggregated[item_code]["available_sheets"] * weight_per_sheet, 3)
                aggregated[item_code]["stores"][store_key] = aggregated[item_code]["stores"].get(store_key, 0.0) + avail_stock

        results = list(aggregated.values())
        if not include_zero_stock:
            results = [r for r in results if r["available_sheets"] > 0]

        # Sort by available sheets descending, then sheet area
        results.sort(key=lambda r: (r["available_sheets"], r["length"] * r["width"]), reverse=True)
        return results

    # =========================================================================
    # API 2: Sheet Cutting Orders / MO Details (Updated per Nov 12 Edited Spec)
    # =========================================================================

    def fetch_sheet_cutting_orders(
        self,
        part_no: str,
        month: Optional[str] = None,
        year: Optional[int] = None,
        branch_code: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Fetches cutting orders / MO history for a specific part from Tara ERP API.
        Supports P_BRANCH_CODE per Nov 12 edited specification.
        Example: P_PARENT_CODE=MB909065-ITEM11-PL, P_MONTH=NOVEMBER, P_YEAR=2026, P_BRANCH_CODE=PEI2
        """
        if not part_no:
            return {"total_orders": 0, "total_sets": 0, "total_parent_qty": 0, "orders": []}

        # Normalize month & year
        now_dt = datetime.now()
        month_name = (month or now_dt.strftime("%B")).strip().upper()
        year_num = int(year or now_dt.year)

        branches_to_query = [branch_code.strip()] if branch_code else self.branch_codes

        # Form variations: try both exact, hyphen, and underscore variations
        parent_codes_to_try = [part_no.strip()]
        if "_" in part_no:
            parent_codes_to_try.append(part_no.replace("_", "-"))
        if not part_no.endswith("-PL"):
            parent_codes_to_try.append(f"{part_no.replace('_', '-')}-PL")

        headers = self._get_headers()
        seen_order_nos = set()
        matched_items = []

        for br in branches_to_query:
            for p_code in parent_codes_to_try:
                url = f"{self.base_url}/sheet_cutting_order_details/?P_PARENT_CODE={p_code}&P_MONTH={month_name}&P_YEAR={year_num}&P_BRANCH_CODE={br}"
                try:
                    res = requests.get(url, headers=headers, timeout=self.timeout)
                    if res.status_code == 401:
                        headers = self._get_headers()
                        res = requests.get(url, headers=headers, timeout=self.timeout)

                    if res.status_code == 200:
                        items = res.json().get("items", [])
                        for order in items:
                            ord_no = order.get("cutting_order_no")
                            if ord_no and ord_no not in seen_order_nos:
                                seen_order_nos.add(ord_no)
                                matched_items.append(order)
                except Exception as e:
                    logger.error(f"[Tara ERP] Cutting order query exception for {p_code} branch {br}: {e}")

        total_sets = sum(int(it.get("no_of_sets") or 0) for it in matched_items)
        total_parent_qty = sum(int(it.get("parent_qty") or 0) for it in matched_items)

        # Sort by cutting order date descending
        matched_items.sort(key=lambda m: str(m.get("cutting_order_date") or ""), reverse=True)

        return {
            "part_no": part_no,
            "month": month_name,
            "year": year_num,
            "branches": branches_to_query,
            "total_orders": len(matched_items),
            "total_sets": total_sets,
            "total_parent_qty": total_parent_qty,
            "orders": matched_items
        }


# Singleton Instance
tara_erp_client = TaraERPClient()

