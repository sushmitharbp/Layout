"""
SheetLayout AI — Manufacturing Order (MO) Workflow Engine
Handles MO creation, constraint evaluation, role-based state transitions,
and audit trails for Shearing, Krysalis, Purchase, and ERP teams.
"""

import os
import re
import json
import time
import math
from datetime import datetime
import requests
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY") or os.getenv("SUPABASE_ANON_KEY")
LOCAL_MO_FILE = "data_mo_store.json"
LOCAL_ENDBITS_FILE = "data_endbits_store.json"

DB_TABLES_CONFIG = {
    "material_orders": {
        "title": "Material Orders (MOs)",
        "icon": "fa-clipboard-list",
        "category": "Workflow",
        "badge_class": "badge-workflow",
        "description": "Active and completed Material Order workflows with approval audits",
        "default_sort": "created_at.desc",
        "search_fields": ["mo_number", "part_no", "base_part", "rm_erp", "layout_name"],
        "display_columns": ["mo_number", "part_no", "rm_erp", "sheets_required", "target_qty", "current_stage", "status", "workflow_path", "created_on"]
    },
    "rm_main_store_stock": {
        "title": "RM Main Store Stock",
        "icon": "fa-layer-group",
        "category": "Inventory",
        "badge_class": "badge-inventory",
        "description": "Raw Material coil and sheet opening stock in Main Stores",
        "default_sort": "onhand_stock.desc",
        "search_fields": ["item_code", "item_desc", "store_desc", "category_desc"]
    },
    "parts_fg_wip_stock": {
        "title": "Parts FG & WIP Stock",
        "icon": "fa-boxes-stacked",
        "category": "Inventory",
        "badge_class": "badge-inventory",
        "description": "Finished goods and work-in-progress inventory (002 - FG & WIP)",
        "default_sort": "onhand_stock.desc",
        "search_fields": ["item_code", "item_desc", "category_desc"]
    },
    "endbit_records": {
        "title": "End Bits & Offcuts Store",
        "icon": "fa-scissors",
        "category": "Inventory",
        "badge_class": "badge-inventory",
        "description": "Recorded end bits & offcuts generated from MO sheet cutting, available to produce parts",
        "default_sort": "created_at.desc",
        "search_fields": ["endbit_id", "mo_number", "parent_part_no", "base_part", "rm_erp", "grade", "dim", "status"],
        "display_columns": ["endbit_id", "mo_number", "parent_part_no", "dim", "grade", "available_qty", "used_qty", "status", "created_at"]
    },
    "erp_mo_reports": {
        "title": "ERP MO Reports",
        "icon": "fa-receipt",
        "category": "ERP Records",
        "badge_class": "badge-erp",
        "description": "Historical ERP Cutting Orders and newly executed production orders",
        "default_sort": "id.desc",
        "search_fields": ["mo_doc_no", "parent_code", "rm_code", "cutting_plan_no"]
    },
    "layout_records": {
        "title": "Layout Records",
        "icon": "fa-compass-drafting",
        "category": "Engineering",
        "badge_class": "badge-eng",
        "description": "Master standardized sheet metal nesting layouts and CAD drawings",
        "default_sort": "row_id.asc",
        "search_fields": ["part_no", "base_part", "rm_erp", "layout_name"]
    },
    "mrp_rm_sheet_bom": {
        "title": "MRP RM Sheet BOM",
        "icon": "fa-sitemap",
        "category": "Planning",
        "badge_class": "badge-mrp",
        "description": "Bill of Materials mapping parent assemblies to child parts, MRP schedule targets, and RM sheets",
        "default_sort": "id.asc",
        "search_fields": ["parent_part_no", "child_part_no", "erp_part_no", "existing_sheet_used"]
    }
}

ROLES = {
    "shearing": {
        "id": "shearing",
        "name": "Shearing (Production) Team",
        "badge": "Production",
        "icon": "fa-industry",
        "can_create": True,
        "can_approve_stages": []
    },
    "krysalis": {
        "id": "krysalis",
        "name": "Consultants (Krysalis) Team",
        "badge": "Design & Layout",
        "icon": "fa-compass-drafting",
        "can_create": False,
        "can_approve_stages": ["KRYSALIS"]
    },
    "purchase": {
        "id": "purchase",
        "name": "Purchase Team",
        "badge": "Procurement",
        "icon": "fa-cart-shopping",
        "can_create": False,
        "can_approve_stages": ["PURCHASE"]
    },
    "erp": {
        "id": "erp",
        "name": "ERP Team",
        "badge": "Systems & Master Data",
        "icon": "fa-network-wired",
        "can_create": False,
        "can_approve_stages": ["ERP"]
    }
}

class MOWorkflowEngine:
    def __init__(self):
        self.use_supabase = bool(SUPABASE_URL and SUPABASE_KEY)
        self._ensure_local_store()
        self._ensure_local_endbits_store()
        self.session = requests.Session()
        adapter = requests.adapters.HTTPAdapter(pool_connections=20, pool_maxsize=20, max_retries=2)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)
        self._cached_mos = None
        self._cache_time = 0
        self._cache_ttl = 5.0  # 5-second in-memory cache for ultra-fast page loads
        self.erp_service = None

    def set_erp_service(self, erp_service):
        self.erp_service = erp_service

    def _ensure_local_store(self):
        if not os.path.exists(LOCAL_MO_FILE):
            with open(LOCAL_MO_FILE, "w", encoding="utf-8") as f:
                json.dump([], f, indent=2)

    def _ensure_local_endbits_store(self):
        if not os.path.exists(LOCAL_ENDBITS_FILE):
            with open(LOCAL_ENDBITS_FILE, "w", encoding="utf-8") as f:
                json.dump([], f, indent=2)

    def _load_endbits_local(self):
        self._ensure_local_endbits_store()
        try:
            with open(LOCAL_ENDBITS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []

    def _save_endbits_local(self, records):
        self._ensure_local_endbits_store()
        with open(LOCAL_ENDBITS_FILE, "w", encoding="utf-8") as f:
            json.dump(records, f, indent=2)

    def _get_supabase_headers(self):
        return {
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=representation"
        }

    ALLOWED_MO_COLS = {
        "mo_number", "part_no", "base_part", "rm_erp", "grade",
        "is_standard_layout", "layout_name", "thickness", "length", "width",
        "target_qty", "sheets_required", "layout_doc_url", "layout_doc_filename",
        "constraints_status", "workflow_path", "current_stage", "status",
        "audit_trail", "endbits", "created_by", "created_at", "updated_at"
    }

    def _sanitize_mo_for_db(self, mo_dict):
        """Sanitizes an MO record by retaining only schema columns that exist in the Supabase material_orders table."""
        if not isinstance(mo_dict, dict):
            return {}
        # Keep only columns that match allowed set
        return {k: v for k, v in mo_dict.items() if k in self.ALLOWED_MO_COLS}

    def set_layout_records(self, records):
        """Builds in-memory lookup caches to resolve yield_pct and endbits for parts and layouts."""
        self._raw_layout_records = records or []
        self._layout_records_lookup = {}
        self._layout_endbits_lookup = {}
        for r in records or []:
            p = (r.get("part_no") or "").strip().lower()
            rm = (r.get("rm_erp") or "").strip().lower()
            y = None
            if isinstance(r.get("per_sheet"), dict):
                y = r["per_sheet"].get("yield_pct")
            if y is None and isinstance(r.get("total_sheet"), dict):
                y = r["total_sheet"].get("yield_pct")
            if y is None:
                y = r.get("yield_pct") or r.get("material_yield_pct")
            if y is not None:
                try:
                    y_num = float(y)
                    if p and rm:
                        self._layout_records_lookup[(p, rm)] = y_num
                    if p and p not in self._layout_records_lookup:
                        self._layout_records_lookup[p] = y_num
                except (ValueError, TypeError):
                    pass

            ebs = r.get("endbits")
            if ebs and isinstance(ebs, list) and any((e.get("dim") or e.get("qty")) for e in ebs if isinstance(e, dict)):
                layout_meta = {
                    "endbits": ebs,
                    "per_sheet": r.get("per_sheet"),
                    "total_sheet": r.get("total_sheet"),
                    "thickness": r.get("thickness"),
                    "length": r.get("length"),
                    "width": r.get("width"),
                    "grade": r.get("grade")
                }
                if p and rm:
                    self._layout_endbits_lookup[(p, rm)] = layout_meta
                if p and p not in self._layout_endbits_lookup:
                    self._layout_endbits_lookup[p] = layout_meta

        # Perform one-time backfill of end bits from existing MOs if store is empty
        self._backfill_existing_mo_endbits()

    def _backfill_existing_mo_endbits(self):
        """Populates End Bits Store from existing MOs if endbits store has zero records."""
        try:
            cur_ebs = self._load_endbits_local()
            if not cur_ebs:
                mos = self._load_local()
                for m in mos:
                    if not m.get("endbits"):
                        created = self.save_endbits_from_mo(m)
                        if created:
                            m["endbits"] = created
                            if isinstance(m.get("constraints_status"), dict):
                                m["constraints_status"]["endbits"] = created
                with open(LOCAL_MO_FILE, "w", encoding="utf-8") as f:
                    json.dump(mos, f, indent=2)
        except Exception as e:
            print(f"[MO Workflow] Endbits backfill info: {e}")

    def _normalize_mo(self, mo):
        """Ensures yield_pct and endbits are exposed at the top level of the MO record."""
        if not isinstance(mo, dict):
            return mo
        if mo.get("yield_pct") is None:
            c_status = mo.get("constraints_status")
            if isinstance(c_status, dict):
                mo["yield_pct"] = c_status.get("yield_pct")
            elif isinstance(c_status, str):
                try:
                    c_dict = json.loads(c_status)
                    if isinstance(c_dict, dict):
                        mo["yield_pct"] = c_dict.get("yield_pct")
                except Exception:
                    pass
        if mo.get("yield_pct") is None and getattr(self, "_layout_records_lookup", None):
            p = (mo.get("part_no") or "").strip().lower()
            rm = (mo.get("rm_erp") or "").strip().lower()
            y = self._layout_records_lookup.get((p, rm)) or self._layout_records_lookup.get(p)
            if y is not None:
                mo["yield_pct"] = y

        # Ensure endbits are accessible at top-level
        if not mo.get("endbits"):
            c_status = mo.get("constraints_status")
            if isinstance(c_status, dict) and c_status.get("endbits"):
                mo["endbits"] = c_status.get("endbits")
            elif isinstance(c_status, str):
                try:
                    c_dict = json.loads(c_status)
                    if isinstance(c_dict, dict) and c_dict.get("endbits"):
                        mo["endbits"] = c_dict.get("endbits")
                except Exception:
                    pass

        # Ensure parts and stock_deducted are accessible at top-level
        if not mo.get("parts"):
            c_status = mo.get("constraints_status")
            if isinstance(c_status, dict) and c_status.get("parts"):
                mo["parts"] = c_status.get("parts")
            elif isinstance(c_status, str):
                try:
                    c_dict = json.loads(c_status)
                    if isinstance(c_dict, dict) and c_dict.get("parts"):
                        mo["parts"] = c_dict.get("parts")
                except Exception:
                    pass

        if mo.get("stock_deducted") is None:
            c_status = mo.get("constraints_status")
            if isinstance(c_status, dict) and "stock_deducted" in c_status:
                mo["stock_deducted"] = c_status.get("stock_deducted")
            elif isinstance(c_status, str):
                try:
                    c_dict = json.loads(c_status)
                    if isinstance(c_dict, dict) and "stock_deducted" in c_dict:
                        mo["stock_deducted"] = c_dict.get("stock_deducted")
                except Exception:
                    pass

        return mo

    def evaluate_workflow_path(self, is_standard_layout, constraints_satisfied):
        """
        Determines the approval pipeline based on rules:
        1. Standard + All Constraints Satisfied => DIRECT_ERP (Shearing -> ERP)
        2. Standard + Any Constraint Failed     => PURCHASE_ERP (Shearing -> Purchase -> ERP)
        3. Non-Standard Layout                  => KRYSALIS_PURCHASE_ERP (Shearing -> Krysalis -> Purchase -> ERP)
        """
        if not is_standard_layout:
            return {
                "path": "KRYSALIS_PURCHASE_ERP",
                "first_stage": "KRYSALIS",
                "status": "PENDING_KRYSALIS",
                "description": "Non-standard layout requires Krysalis review, Purchase clearance, and final ERP approval."
            }
        
        if not constraints_satisfied:
            return {
                "path": "PURCHASE_ERP",
                "first_stage": "PURCHASE",
                "status": "PENDING_PURCHASE",
                "description": "Constraint check failed. Requires Purchase team approval before ERP."
            }

        return {
            "path": "DIRECT_ERP",
            "first_stage": "ERP",
            "status": "PENDING_ERP",
            "description": "Standardized layout with all constraints satisfied. Fast-tracked directly to ERP approval."
        }

    def create_mo(self, mo_data, created_by_role="shearing"):
        """Create a new Material Order and route to first stage"""
        if created_by_role != "shearing":
            raise PermissionError("Unauthorized: Only the Shearing Production team can create Material Orders.")
        is_std = bool(mo_data.get("is_standard_layout", True))
        constraints = mo_data.get("constraints_status", {})
        constraints_satisfied = bool(constraints.get("all_satisfied", True))
        yield_pct = mo_data.get("yield_pct")
        if yield_pct is not None and isinstance(constraints, dict):
            constraints["yield_pct"] = yield_pct

        routing = self.evaluate_workflow_path(is_std, constraints_satisfied)
        now_iso = datetime.utcnow().isoformat() + "Z"

        mo_id = mo_data.get("mo_number") or f"MO-{int(time.time())}"
        
        audit_entry = {
            "action": "CREATED",
            "actor_role": created_by_role,
            "actor_name": ROLES.get(created_by_role, {}).get("name", "Shearing"),
            "timestamp": now_iso,
            "stage": routing["first_stage"],
            "remarks": mo_data.get("notes") or f"MO initiated by Shearing team. Routing: {routing.get('description', '')}"
        }

        record = {
            "mo_number": mo_id,
            "part_no": mo_data.get("part_no", ""),
            "base_part": mo_data.get("base_part", ""),
            "rm_erp": mo_data.get("rm_erp", ""),
            "grade": mo_data.get("grade", ""),
            "is_standard_layout": is_std,
            "layout_name": mo_data.get("layout_name", ""),
            "yield_pct": yield_pct,
            "thickness": mo_data.get("thickness"),
            "length": mo_data.get("length"),
            "width": mo_data.get("width"),
            "target_qty": mo_data.get("target_qty", 1),
            "sheets_required": mo_data.get("sheets_required", 1),
            "layout_doc_url": mo_data.get("layout_doc_url", ""),
            "layout_doc_filename": mo_data.get("layout_doc_filename", ""),
            "constraints_status": constraints,
            "workflow_path": routing["path"],
            "current_stage": routing["first_stage"],
            "status": routing["status"],
            "audit_trail": [audit_entry],
            "created_by": created_by_role,
            "created_at": now_iso,
            "updated_at": now_iso,
            "stock_deducted": False
        }

        # Live database stock allocation occurs strictly upon final ERP approval
        if isinstance(record.get("constraints_status"), dict):
            record["constraints_status"]["stock_deducted"] = False

        # Process and save end bits (offcuts) produced from this MO layout
        created_endbits = self.save_endbits_from_mo(record, mo_data.get("endbits"))
        record["endbits"] = created_endbits
        if "constraints_status" in record and isinstance(record["constraints_status"], dict):
            record["constraints_status"]["endbits"] = created_endbits
        if created_endbits:
            audit_entry["remarks"] = f"{audit_entry['remarks']} [End Bits Configured: {len(created_endbits)} offcut types]"

        # Save directly to Supabase material_orders table
        saved = False
        if self.use_supabase:
            clean_record = self._sanitize_mo_for_db(record)
            for tbl in ["material_orders"]:
                try:
                    res = requests.post(
                        f"{SUPABASE_URL}/rest/v1/{tbl}",
                        headers=self._get_supabase_headers(),
                        json=clean_record,
                        timeout=10
                    )
                    if res.status_code in (200, 201):
                        saved = True
                        print(f"[MO Workflow] Successfully added {record.get('mo_number')} to Supabase {tbl}")
                        break
                    else:
                        print(f"[MO Workflow] Supabase insert returned {res.status_code} on {tbl}: {res.text}")
                except Exception as e:
                    print(f"[MO Workflow] Supabase insert error on {tbl}: {e}")

        # Always keep local backup store synchronized
        self._save_local(record)

        self._cached_mos = None  # Invalidate cache on new creation
        return record

    def list_mos(self, role=None, stage=None, status=None):
        """List MOs with optional filtering and in-memory short TTL cache"""
        now = time.time()
        if self._cached_mos is not None and (now - self._cache_time) < self._cache_ttl:
            all_mos = self._cached_mos
        else:
            all_mos = []
            if self.use_supabase:
                for tbl in ["material_orders", "manufacturing_orders"]:
                    try:
                        res = self.session.get(
                            f"{SUPABASE_URL}/rest/v1/{tbl}?select=*&order=created_at.desc",
                            headers=self._get_supabase_headers(),
                            timeout=6
                        )
                        if res.status_code == 200:
                            all_mos = res.json()
                            break
                    except Exception as e:
                        print(f"[MO Workflow] Supabase query error on {tbl}: {e}")

            if not all_mos:
                all_mos = self._load_local()

            for m in all_mos:
                self._normalize_mo(m)

            self._cached_mos = all_mos
            self._cache_time = now

        mos = all_mos
        if stage:
            mos = [m for m in mos if m.get("current_stage") == stage]
        if status:
            mos = [m for m in mos if m.get("status") == status]

        return mos


    def get_mo(self, mo_number):
        """Get single MO by MO number"""
        if self.use_supabase:
            for tbl in ["material_orders", "manufacturing_orders"]:
                try:
                    res = requests.get(
                        f"{SUPABASE_URL}/rest/v1/{tbl}?mo_number=eq.{mo_number}&select=*",
                        headers=self._get_supabase_headers(),
                        timeout=10
                    )
                    if res.status_code == 200:
                        items = res.json()
                        if items:
                            return self._normalize_mo(items[0])
                except Exception:
                    pass

        mos = self._load_local()
        for m in mos:
            if m.get("mo_number") == mo_number:
                return self._normalize_mo(m)
        return None

    def approve_mo(self, mo_number, role, remarks="Approved"):
        """Process role approval and advance to next stage in workflow"""
        mo = self.get_mo(mo_number)
        if not mo:
            return None, "Material Order not found."

        current_stage = mo.get("current_stage")
        role_info = ROLES.get(role, {})
        allowed_stages = role_info.get("can_approve_stages", [])

        if current_stage not in allowed_stages:
            return None, f"Role '{role}' is not authorized to approve stage '{current_stage}'."

        now_iso = datetime.utcnow().isoformat() + "Z"
        audit_trail = mo.get("audit_trail", [])
        path = mo.get("workflow_path", "DIRECT_ERP")

        next_stage = None
        next_status = None

        if current_stage == "KRYSALIS":
            next_stage = "PURCHASE"
            next_status = "PENDING_PURCHASE"
        elif current_stage == "PURCHASE":
            next_stage = "ERP"
            next_status = "PENDING_ERP"
        elif current_stage == "ERP":
            next_stage = "COMPLETED"
            next_status = "RELEASED_TO_ERP"
            # Real-time multi-table database execution strictly upon final ERP release
            db_updates = self.execute_mo_completion(mo)
            mo["db_updates"] = db_updates
            rm_info = db_updates.get("rm_stock")
            eb_info = db_updates.get("endbit_stock")
            parts_info = db_updates.get("parts_stock")
            upd_parts = []
            if rm_info:
                upd_parts.append(f"Deducted {rm_info['deducted_sheets']} sheets from RM ({rm_info.get('item_code','')})")
            if eb_info:
                upd_parts.append(f"Deducted {eb_info['deducted']} offcut(s) from End Bits Store ({eb_info.get('endbit_id','')})")
            if parts_info:
                if isinstance(parts_info, list):
                    for pi in parts_info:
                        upd_parts.append(f"Added {pi['added_qty']} units to FG/WIP ({pi['item_code']})")
                elif isinstance(parts_info, dict):
                    upd_parts.append(f"Added {parts_info['added_qty']} units to FG/WIP ({parts_info.get('item_code','')})")
            if db_updates.get("erp_report"):
                upd_parts.append("ERP MO Cutting Report recorded")

            if upd_parts:
                remarks = f"{remarks}. [Database Updated: {'; '.join(upd_parts)}]"

        audit_trail.append({
            "action": "APPROVED",
            "actor_role": role,
            "actor_name": role_info.get("name", role),
            "timestamp": now_iso,
            "stage": current_stage,
            "remarks": remarks
        })

        mo["current_stage"] = next_stage
        mo["status"] = next_status
        mo["updated_at"] = now_iso
        mo["audit_trail"] = audit_trail

        self._update_mo(mo)
        return mo, None

    def execute_mo_completion(self, mo):
        """
        Executes real-time ERP completion across database tables upon final ERP approval:
        For Normal MO:
        1. Deducts sheets_required from rm_main_store_stock (Raw Material Inventory)
        2. Increments target_qty in parts_fg_wip_stock (Finished Goods / WIP Inventory) for all parts
        3. Inserts cutting order record into erp_mo_reports (ERP MO Report History) for all parts
        4. Updates mrp_rm_sheet_bom (increments inhouse_erp_qty, decrements balance_qty)

        For End Bit MO:
        1. Deducts endbits_used from endbit_records (Supabase) and data_endbits_store.json (Local)
        2. Increments produced quantity in parts_fg_wip_stock for all parts produced
        3. Inserts cutting order records into erp_mo_reports for each part produced
        Returns a summary dict of all table updates made.
        """
        updates_summary = {
            "rm_stock": None,
            "endbit_stock": None,
            "parts_stock": None,
            "erp_report": None,
            "mrp_sheet_bom": None
        }

        if mo.get("stock_deducted"):
            print(f"[MO Execution] Stock already deducted for {mo.get('mo_number')}, skipping duplicate execution.")
            return updates_summary

        cs = mo.get("constraints_status") or {}
        if isinstance(cs, str):
            try:
                cs = json.loads(cs)
            except Exception:
                cs = {}

        is_endbit = bool(
            cs.get("is_endbit_mo") or
            cs.get("endbit_id") or
            "ENDBIT" in str(mo.get("rm_erp", "")).upper() or
            "OFFCUT" in str(mo.get("layout_name", "")).upper() or
            mo.get("workflow_path") == "FROM_ENDBIT"
        )

        headers = self._get_supabase_headers() if self.use_supabase else {}
        sheets = float(mo.get("sheets_required") or 1.0)
        target_qty = float(mo.get("target_qty") or 1.0)
        part_no = mo.get("part_no", "")
        rm_erp = mo.get("rm_erp", "")
        now_date = datetime.utcnow().strftime("%Y-%m-%d")
        now_iso = datetime.utcnow().isoformat() + "Z"
        mo_num = mo.get("mo_number", "")

        # Extract list of all child parts produced
        parts_list = mo.get("parts") or cs.get("parts")
        if isinstance(parts_list, str):
            try:
                parts_list = json.loads(parts_list)
            except Exception:
                parts_list = []
        if not parts_list or not isinstance(parts_list, list):
            parts_list = [{
                "part_no": part_no,
                "base_part": mo.get("base_part") or (part_no.split(" - ")[0].strip() if part_no else ""),
                "no_of_parts": target_qty,
                "target_qty": target_qty
            }]

        if is_endbit:
            # =========================================================================
            # END BIT MO EXECUTION: Deduct endbits, update FG stock for each part, post cutting orders
            # =========================================================================
            endbit_id = cs.get("endbit_id") or mo.get("endbit_id") or ""
            endbit_name = cs.get("endbit_name") or mo.get("layout_name") or "End Bit"
            endbits_used = float(mo.get("sheets_required") or 1.0)
            dim_str = f"{mo.get('thickness','')}*{mo.get('length','')}*{mo.get('width','')}"

            # 1. Deduct from End Bits Store (Local + Supabase endbit_records)
            if endbit_id:
                try:
                    all_ebs = self._load_endbits_local()
                    target_eb = None
                    for eb in all_ebs:
                        if eb.get("endbit_id") == endbit_id or eb.get("id") == endbit_id:
                            avail = float(eb.get("available_qty") or 0)
                            new_avail = max(0.0, avail - endbits_used)
                            new_used = float(eb.get("used_qty") or 0) + endbits_used
                            eb["available_qty"] = int(new_avail) if new_avail == int(new_avail) else new_avail
                            eb["used_qty"] = int(new_used) if new_used == int(new_used) else new_used
                            eb["status"] = "CONSUMED" if new_avail <= 0 else "PARTIALLY_USED"
                            eb["updated_at"] = now_iso

                            if "parts_created" not in eb or not isinstance(eb["parts_created"], list):
                                eb["parts_created"] = []

                            for itm in parts_list:
                                p_code = itm.get("part_no", "")
                                p_q = float(itm.get("no_of_parts") or itm.get("target_qty") or 1)
                                tx = {
                                    "id": f"PFE-{int(time.time()*1000)}",
                                    "mo_number": mo_num,
                                    "part_no": p_code,
                                    "parts_produced": p_q,
                                    "endbits_used": endbits_used,
                                    "timestamp": now_iso,
                                    "stage": "COMPLETED",
                                    "remarks": f"MO {mo_num} approved by ERP and completed."
                                }
                                eb["parts_created"].insert(0, tx)

                            target_eb = eb
                            break

                    if target_eb:
                        self._save_endbits_local(all_ebs)
                        if self.use_supabase:
                            try:
                                self.session.patch(
                                    f"{SUPABASE_URL}/rest/v1/endbit_records?endbit_id=eq.{endbit_id}",
                                    headers=headers,
                                    json={
                                        "available_qty": target_eb["available_qty"],
                                        "used_qty": target_eb["used_qty"],
                                        "status": target_eb["status"],
                                        "parts_created": target_eb["parts_created"],
                                        "updated_at": now_iso
                                    },
                                    timeout=6
                                )
                            except Exception as e:
                                print(f"[MO Execution] Supabase endbit_records update error: {e}")

                        updates_summary["endbit_stock"] = {
                            "endbit_id": endbit_id,
                            "previous_qty": target_eb.get("available_qty", 0) + endbits_used,
                            "deducted": endbits_used,
                            "new_qty": target_eb.get("available_qty", 0)
                        }
                        print(f"[MO Execution] End bit {endbit_id} deducted: {endbits_used} Nos. Status: {target_eb.get('status')}")
                except Exception as e:
                    print(f"[MO Execution] Error deducting endbit stock: {e}")

            # 2. Update parts_fg_wip_stock for all parts (Live read & write)
            parts_credited = []
            if self.use_supabase:
                for itm in parts_list:
                    p_item = (itm.get("part_no") or "").strip()
                    if not p_item:
                        continue
                    p_prod = float(itm.get("no_of_parts") or itm.get("target_qty") or 1)
                    try:
                        r_fg = self.session.get(f"{SUPABASE_URL}/rest/v1/parts_fg_wip_stock?item_code=eq.{p_item}", headers=headers, timeout=6)
                        if r_fg.status_code == 200 and r_fg.json():
                            fg_row = r_fg.json()[0]
                            cur_fg = float(fg_row.get("onhand_stock") or 0)
                            new_fg = cur_fg + p_prod
                            self.session.patch(f"{SUPABASE_URL}/rest/v1/parts_fg_wip_stock?id=eq.{fg_row['id']}", headers=headers, json={"onhand_stock": new_fg}, timeout=6)
                            parts_credited.append({
                                "item_code": p_item,
                                "previous_stock": cur_fg,
                                "added_qty": p_prod,
                                "new_stock": new_fg
                            })
                            print(f"[MO Execution] parts_fg_wip_stock updated for {p_item}: {cur_fg} -> {new_fg}")
                        else:
                            new_fg_row = {
                                "item_code": p_item,
                                "item_desc": f"{p_item} (MO {mo_num} from Offcut {endbit_name})",
                                "uom": "NOS",
                                "store_desc": "FG AND WIP STORES",
                                "onhand_stock": p_prod,
                                "category_desc": "FINISHED GOODS"
                            }
                            self.session.post(f"{SUPABASE_URL}/rest/v1/parts_fg_wip_stock", headers=headers, json=new_fg_row, timeout=6)
                            parts_credited.append({
                                "item_code": p_item,
                                "previous_stock": 0,
                                "added_qty": p_prod,
                                "new_stock": p_prod
                            })
                            print(f"[MO Execution] parts_fg_wip_stock inserted new row for {p_item}: {p_prod}")
                    except Exception as e:
                        print(f"[MO Execution] Error updating FG stock for {p_item}: {e}")

                    if self.erp_service:
                        self.erp_service.add_parts_stock_in_memory(p_item, p_prod, item_code=p_item)

            updates_summary["parts_stock"] = parts_credited

            # 3. Insert into erp_mo_reports for each part
            if self.use_supabase:
                for idx, itm in enumerate(parts_list):
                    p_item = (itm.get("part_no") or "").strip()
                    if not p_item:
                        continue
                    p_prod = float(itm.get("no_of_parts") or itm.get("target_qty") or 1)
                    sub_order_no = f"CUT-{mo_num}-{idx+1}" if len(parts_list) > 1 else f"CUT-{mo_num}"
                    try:
                        erp_entry = {
                            "mo_doc_no": mo_num,
                            "doc_date": now_date,
                            "order_status": "COMPLETED",
                            "cutting_order_no": sub_order_no,
                            "cutting_order_date": now_date,
                            "rm_code": f"ENDBIT-{endbit_id or 'MANUAL'}",
                            "rm_desc": f"End Bit Offcut {endbit_name} ({dim_str})",
                            "number_of_sheets": endbits_used,
                            "parent_code": p_item,
                            "parent_qty_per_sheet": round(p_prod / max(1.0, endbits_used), 2),
                            "total_parent_qty": p_prod,
                            "cutting_plan_no": f"OFFCUT-{endbit_id or mo_num}",
                            "uom": "NOS"
                        }
                        self.session.post(f"{SUPABASE_URL}/rest/v1/erp_mo_reports", headers=headers, json=erp_entry, timeout=6)
                    except Exception as e:
                        print(f"[MO Execution] Error writing erp_mo_reports for {p_item}: {e}")

                updates_summary["erp_report"] = f"Created {len(parts_list)} cutting report entries"

            mo["stock_deducted"] = True
            if isinstance(mo.get("constraints_status"), dict):
                mo["constraints_status"]["stock_deducted"] = True
            return updates_summary

        else:
            # =========================================================================
            # NORMAL SHEET MO EXECUTION: Deduct rm_main_store_stock, update parts_fg_wip_stock, erp_mo_reports, mrp
            # =========================================================================
            if not self.use_supabase:
                mo["stock_deducted"] = True
                return updates_summary

            # 1. Update rm_main_store_stock (Deduct sheets_required)
            try:
                rm_row = None
                t = mo.get("thickness")
                l = mo.get("length")
                w = mo.get("width")

                # A. Try exact match on item_code == rm_erp
                if rm_erp:
                    r = self.session.get(f"{SUPABASE_URL}/rest/v1/rm_main_store_stock?item_code=eq.{rm_erp}", headers=headers, timeout=6)
                    if r.status_code == 200 and r.json():
                        rm_row = r.json()[0]

                # B. Match by thickness AND dimensions (e.g. 1.5*2500*1250)
                if not rm_row and t and l and w:
                    t_str = str(t).rstrip(".0")
                    l_int = int(float(l))
                    w_int = int(float(w))
                    dim_q = f"item_desc.ilike.*{t_str}*{l_int}*{w_int}*,item_code.ilike.*{t_str}*{l_int}*{w_int}*"
                    r2 = self.session.get(f"{SUPABASE_URL}/rest/v1/rm_main_store_stock?or=({dim_q})&limit=5", headers=headers, timeout=6)
                    if r2.status_code == 200 and r2.json():
                        rm_row = r2.json()[0]

                # C. If dimensions without thickness, query with limit 50 and match
                if not rm_row and l and w:
                    l_int = int(float(l))
                    w_int = int(float(w))
                    r3 = self.session.get(f"{SUPABASE_URL}/rest/v1/rm_main_store_stock?or=(item_desc.ilike.*{l_int}*{w_int}*,item_code.ilike.*{l_int}*{w_int}*)&limit=50", headers=headers, timeout=6)
                    if r3.status_code == 200 and r3.json():
                        for row in r3.json():
                            desc = f"{row.get('item_desc','')} {row.get('item_code','')}"
                            if t and str(t) in desc:
                                rm_row = row
                                break
                        if not rm_row:
                            rm_row = r3.json()[0]

                if rm_row:
                    cur_stock = float(rm_row.get("onhand_stock") or 0)
                    new_stock = max(0.0, cur_stock - sheets)
                    patch_payload = {"onhand_stock": new_stock}
                    unit_wt = rm_row.get("weight")
                    if unit_wt:
                        patch_payload["total_weight"] = round(new_stock * float(unit_wt), 2)

                    self.session.patch(f"{SUPABASE_URL}/rest/v1/rm_main_store_stock?id=eq.{rm_row['id']}", headers=headers, json=patch_payload, timeout=6)
                    updates_summary["rm_stock"] = {
                        "item_code": rm_row.get("item_code"),
                        "item_desc": rm_row.get("item_desc"),
                        "previous_stock": cur_stock,
                        "deducted_sheets": sheets,
                        "new_stock": new_stock
                    }
                    print(f"[MO Execution] rm_main_store_stock updated for {rm_row.get('item_code')}: {cur_stock} -> {new_stock}")
                    if self.erp_service:
                        self.erp_service.deduct_rm_stock_in_memory(rm_erp, sheets, item_code=rm_row.get("item_code"))
            except Exception as e:
                print(f"[MO Execution] Error updating rm_main_store_stock: {e}")

            # 2. Update parts_fg_wip_stock for all parts (Increment qty)
            parts_credited = []
            try:
                for itm in parts_list:
                    p_code = (itm.get("part_no") or "").strip()
                    if not p_code:
                        continue
                    p_qty = float(itm.get("no_of_parts") or itm.get("target_qty") or target_qty)
                    fg_row = None
                    base_p = itm.get("base_part") or (p_code.split(" - ")[0].strip() if p_code else "")
                    item_match = re.search(r'item\s*(\d+)', p_code, re.IGNORECASE)
                    item_num = item_match.group(1) if item_match else ""

                    # A. Try exact match on item_code == p_code
                    r = self.session.get(f"{SUPABASE_URL}/rest/v1/parts_fg_wip_stock?item_code=eq.{p_code}", headers=headers, timeout=6)
                    if r.status_code == 200 and r.json():
                        fg_row = r.json()[0]

                    # B. Search base_part + Item X
                    if not fg_row and base_p and item_num:
                        q_part = f"item_code.ilike.*{base_p}*ITEM{item_num}*,item_code.ilike.*{base_p}*ITEM*{item_num}*,item_desc.ilike.*{base_p}*ITEM*{item_num}*"
                        r2 = self.session.get(f"{SUPABASE_URL}/rest/v1/parts_fg_wip_stock?or=({q_part})&limit=5", headers=headers, timeout=6)
                        if r2.status_code == 200 and r2.json():
                            fg_row = r2.json()[0]

                    # C. Search base_p prefix
                    if not fg_row and base_p:
                        r3 = self.session.get(f"{SUPABASE_URL}/rest/v1/parts_fg_wip_stock?item_code=ilike.{base_p}%&limit=10", headers=headers, timeout=6)
                        if r3.status_code == 200 and r3.json():
                            for row in r3.json():
                                if "SH" in row.get("item_code", "") or "SHEAR" in row.get("item_desc", ""):
                                    fg_row = row
                                    break
                            if not fg_row:
                                fg_row = r3.json()[0]

                    if fg_row:
                        cur_fg = float(fg_row.get("onhand_stock") or 0)
                        new_fg = cur_fg + p_qty
                        patch_fg = {"onhand_stock": new_fg}
                        self.session.patch(f"{SUPABASE_URL}/rest/v1/parts_fg_wip_stock?id=eq.{fg_row['id']}", headers=headers, json=patch_fg, timeout=6)
                        parts_credited.append({
                            "item_code": fg_row.get("item_code"),
                            "item_desc": fg_row.get("item_desc"),
                            "previous_stock": cur_fg,
                            "added_qty": p_qty,
                            "new_stock": new_fg
                        })
                        print(f"[MO Execution] parts_fg_wip_stock updated for {fg_row.get('item_code')}: {cur_fg} -> {new_fg}")
                    else:
                        new_fg_row = {
                            "item_code": p_code,
                            "item_desc": f"{p_code} (MO {mo_num})",
                            "uom": "NOS",
                            "store_desc": "FG AND WIP STORES",
                            "onhand_stock": p_qty,
                            "category_desc": "FINISHED GOODS"
                        }
                        self.session.post(f"{SUPABASE_URL}/rest/v1/parts_fg_wip_stock", headers=headers, json=new_fg_row, timeout=6)
                        parts_credited.append({
                            "item_code": p_code,
                            "item_desc": new_fg_row["item_desc"],
                            "previous_stock": 0,
                            "added_qty": p_qty,
                            "new_stock": p_qty
                        })
                        print(f"[MO Execution] parts_fg_wip_stock inserted new row for {p_code}: {p_qty}")

                    if self.erp_service:
                        self.erp_service.add_parts_stock_in_memory(p_code, p_qty, item_code=fg_row.get("item_code") if fg_row else p_code)

                updates_summary["parts_stock"] = parts_credited
            except Exception as e:
                print(f"[MO Execution] Error updating parts_fg_wip_stock: {e}")

            # 3. Insert into erp_mo_reports (ERP Cutting Orders Report)
            try:
                r_check = self.session.get(f"{SUPABASE_URL}/rest/v1/erp_mo_reports?mo_doc_no=eq.{mo_num}&limit=1", headers=headers, timeout=6)
                if r_check.status_code == 200 and not r_check.json():
                    for idx, itm in enumerate(parts_list):
                        p_code = (itm.get("part_no") or part_no).strip()
                        p_qty = float(itm.get("no_of_parts") or itm.get("target_qty") or target_qty)
                        sub_order_no = f"CUT-{mo_num}-{idx+1}" if len(parts_list) > 1 else f"CUT-{mo_num}"
                        erp_entry = {
                            "mo_doc_no": mo_num,
                            "doc_date": now_date,
                            "order_status": "COMPLETED",
                            "cutting_order_no": sub_order_no,
                            "cutting_order_date": now_date,
                            "rm_code": rm_erp,
                            "rm_desc": f"RM Sheet ({mo.get('thickness','')}*L{mo.get('length','')}*W{mo.get('width','')})",
                            "number_of_sheets": sheets,
                            "parent_code": p_code,
                            "parent_qty_per_sheet": round(p_qty / max(1.0, sheets), 2),
                            "total_parent_qty": p_qty,
                            "cutting_plan_no": mo.get("layout_name") or mo_num,
                            "uom": "NOS"
                        }
                        res_erp = self.session.post(f"{SUPABASE_URL}/rest/v1/erp_mo_reports", headers=headers, json=erp_entry, timeout=6)
                        if res_erp.status_code in (200, 201):
                            print(f"[MO Execution] erp_mo_reports record added for {mo_num} ({p_code})")
                    updates_summary["erp_report"] = f"Created {len(parts_list)} cutting report entries"
            except Exception as e:
                print(f"[MO Execution] Error inserting erp_mo_reports: {e}")

            # 4. Update mrp_rm_sheet_bom (Child Part Inhouse ERP Qty & Balance Planning)
            try:
                clean_part = part_no.split(" - ")[0].strip()
                m_child = re.search(r'^(.*?)\s*[-_]\s*(item\s*\d+[a-zA-Z]?.*)$', part_no, re.IGNORECASE)
                child_tag = m_child.group(2).strip() if m_child else ""
                item_num_m = re.search(r'item\s*(\d+)', child_tag, re.IGNORECASE) or re.search(r'(\d+)', child_tag)
                target_num = int(item_num_m.group(1)) if item_num_m else None

                r_bom = self.session.get(
                    f"{SUPABASE_URL}/rest/v1/mrp_rm_sheet_bom?parent_part_no=ilike.{clean_part}%&order=id.asc&limit=20",
                    headers=headers, timeout=6
                )
                if r_bom.status_code == 200 and r_bom.json():
                    rows = r_bom.json()
                    target_row = rows[0]
                    if target_num is not None:
                        for r in rows:
                            num_m = re.search(r'item\s*(\d+)', r.get("child_part_no", "") or "", re.IGNORECASE) or re.search(r'item(\d+)', r.get("erp_part_no", "") or "", re.IGNORECASE)
                            if num_m and int(num_m.group(1)) == target_num:
                                target_row = r
                                break

                    cur_inhouse = float(target_row.get("inhouse_erp_qty") or 0)
                    cur_bal = float(target_row.get("balance_qty") or 0)
                    new_inhouse = cur_inhouse + target_qty
                    new_bal = max(0.0, cur_bal - target_qty)
                    self.session.patch(
                        f"{SUPABASE_URL}/rest/v1/mrp_rm_sheet_bom?id=eq.{target_row['id']}",
                        headers=headers,
                        json={"inhouse_erp_qty": new_inhouse, "balance_qty": new_bal},
                        timeout=6
                    )
                    updates_summary["mrp_sheet_bom"] = {
                        "parent_part": target_row.get("parent_part_no"),
                        "child_part": target_row.get("child_part_no"),
                        "inhouse_erp_qty": new_inhouse,
                        "balance_qty": new_bal
                    }
                    print(f"[MO Execution] mrp_rm_sheet_bom updated for {clean_part} ({target_row.get('child_part_no')}): Inhouse {cur_inhouse}->{new_inhouse}, Bal {cur_bal}->{new_bal}")
            except Exception as e:
                print(f"[MO Execution] Error updating mrp_rm_sheet_bom: {e}")

            mo["stock_deducted"] = True
            if isinstance(mo.get("constraints_status"), dict):
                mo["constraints_status"]["stock_deducted"] = True
            return updates_summary

    def complete_mo(self, mo_number, role="erp", remarks="Executed & Released to ERP"):
        """Explicitly mark an MO as completed/done and execute database updates"""
        mo = self.get_mo(mo_number)
        if not mo:
            return None, "Material Order not found."

        now_iso = datetime.utcnow().isoformat() + "Z"
        audit_trail = mo.get("audit_trail", [])

        # Execute DB table updates
        summary = self.execute_mo_completion(mo)

        rm_info = summary.get("rm_stock")
        eb_info = summary.get("endbit_stock")
        parts_info = summary.get("parts_stock")
        upd_notes = []
        if rm_info:
            upd_notes.append(f"Deducted {rm_info['deducted_sheets']} sheets from RM Stock ({rm_info['item_code']})")
        if eb_info:
            upd_notes.append(f"Deducted {eb_info['deducted']} offcut(s) from End Bits Store ({eb_info['endbit_id']})")
        if parts_info:
            if isinstance(parts_info, list):
                for pi in parts_info:
                    upd_notes.append(f"Added {pi['added_qty']} units to FG/WIP Stock ({pi['item_code']})")
            elif isinstance(parts_info, dict):
                upd_notes.append(f"Added {parts_info['added_qty']} units to FG/WIP Stock ({parts_info['item_code']})")
        if summary.get("erp_report"):
            upd_notes.append(f"Posted cutting order to ERP MO Reports #{mo_number}")

        note_str = "; ".join(upd_notes) if upd_notes else "Live DB tables verified."
        exec_remark = f"{remarks}. [Live Tables Updated: {note_str}]"

        audit_trail.append({
            "action": "RELEASED_TO_ERP",
            "actor_role": role,
            "actor_name": ROLES.get(role, {}).get("name", "ERP Team"),
            "timestamp": now_iso,
            "stage": "COMPLETED",
            "remarks": exec_remark
        })

        mo["current_stage"] = "COMPLETED"
        mo["status"] = "RELEASED_TO_ERP"
        mo["updated_at"] = now_iso
        mo["audit_trail"] = audit_trail

        self._update_mo(mo)
        return mo, summary

    def save_endbits_from_mo(self, mo_record, endbits_input=None):
        """
        Extracts, calculates, and records end bits (offcuts) produced from creating an MO.
        Saves each end bit into the End Bits Store (data_endbits_store.json & Supabase).
        """
        mo_id = mo_record.get("mo_number") or ""
        sheets = max(1.0, float(mo_record.get("sheets_required") or 1.0))
        part_no = mo_record.get("part_no", "")
        base_part = mo_record.get("base_part", "")
        rm_erp = mo_record.get("rm_erp", "")
        grade = mo_record.get("grade", "")
        layout_name = mo_record.get("layout_name") or ""
        now_iso = datetime.utcnow().isoformat() + "Z"

        raw_endbits = []
        if endbits_input and isinstance(endbits_input, list):
            raw_endbits = endbits_input
        elif endbits_input and isinstance(endbits_input, str):
            try:
                raw_endbits = json.loads(endbits_input)
            except Exception:
                raw_endbits = []

        # If not provided, try to find from layout records lookup
        if not raw_endbits and getattr(self, "_layout_endbits_lookup", None):
            p_key = (part_no or "").strip().lower()
            rm_key = (rm_erp or "").strip().lower()
            layout_data = self._layout_endbits_lookup.get((p_key, rm_key)) or self._layout_endbits_lookup.get(p_key)
            if layout_data:
                raw_endbits = layout_data.get("endbits") or []

        processed_endbits = []
        if not isinstance(raw_endbits, list):
            raw_endbits = []

        for idx, eb in enumerate(raw_endbits):
            if not isinstance(eb, dict):
                continue
            dim_str = str(eb.get("dim") or "").strip()
            qty_raw = str(eb.get("qty") or "").strip()
            if not dim_str and not qty_raw:
                continue

            # Extract per-sheet quantity
            qty_nums = re.findall(r'[\d\.]+', qty_raw)
            per_sheet_qty = float(qty_nums[0]) if qty_nums else 1.0
            total_qty = round(per_sheet_qty * sheets, 2)
            if total_qty == int(total_qty):
                total_qty = int(total_qty)

            # Parse dimensions: e.g. "730.0*60.9*5.8" or "730*60.9"
            dim_parts = re.findall(r'[\d\.]+', dim_str)
            eb_len = float(dim_parts[0]) if len(dim_parts) > 0 else (mo_record.get("length") or 0.0)
            eb_wid = float(dim_parts[1]) if len(dim_parts) > 1 else (mo_record.get("width") or 0.0)
            eb_thk = float(dim_parts[2]) if len(dim_parts) > 2 else (mo_record.get("thickness") or 0.0)

            # Calculate estimated weight (mild steel density ~ 7.85 g/cm^3)
            eb_wt = eb.get("weight_kg")
            if eb_wt is None and eb_len and eb_wid and eb_thk:
                single_wt = (eb_len * eb_wid * eb_thk * 7.85) / 1000000.0
                eb_wt = round(single_wt * total_qty, 3)

            eb_id = eb.get("endbit_id") or f"EB-{mo_id}-{idx+1}"
            eb_name = eb.get("name") or f"End bit - {idx+1}"

            eb_record = {
                "id": eb_id,
                "endbit_id": eb_id,
                "mo_number": mo_id,
                "parent_part_no": part_no,
                "base_part": base_part,
                "rm_erp": rm_erp,
                "layout_name": layout_name,
                "grade": grade,
                "name": eb_name,
                "dim": dim_str or f"{eb_len}*{eb_wid}*{eb_thk}",
                "thickness": eb_thk,
                "length": eb_len,
                "width": eb_wid,
                "qty_per_sheet": per_sheet_qty,
                "initial_qty": total_qty,
                "available_qty": total_qty,
                "used_qty": 0,
                "weight_kg": eb_wt,
                "status": "AVAILABLE",
                "parts_created": [],
                "created_at": now_iso,
                "updated_at": now_iso
            }
            processed_endbits.append(eb_record)

        if processed_endbits:
            all_ebs = self._load_endbits_local()
            existing_ids = {e.get("endbit_id") for e in processed_endbits}
            all_ebs = [e for e in all_ebs if e.get("endbit_id") not in existing_ids]
            all_ebs = processed_endbits + all_ebs
            self._save_endbits_local(all_ebs)

            if self.use_supabase:
                for eb_r in processed_endbits:
                    try:
                        self.session.post(
                            f"{SUPABASE_URL}/rest/v1/endbit_records",
                            headers=self._get_supabase_headers(),
                            json=eb_r,
                            timeout=4
                        )
                    except Exception:
                        pass

        return processed_endbits

    def add_manual_endbit(self, data, created_by_role="shearing"):
        """
        Manually adds an offcut / end-bit into the store for future use.
        """
        now_ts = int(time.time() * 1000)
        now_iso = datetime.utcnow().isoformat() + "Z"

        eb_id = (data.get("endbit_id") or "").strip()
        if not eb_id:
            eb_id = f"EB-MAN-{now_ts}"

        name = (data.get("name") or "Manual End bit").strip()

        try:
            thickness = float(data.get("thickness") or 4.8)
        except (ValueError, TypeError):
            thickness = 4.8

        try:
            length = float(data.get("length") or 0.0)
        except (ValueError, TypeError):
            length = 0.0

        try:
            width = float(data.get("width") or 0.0)
        except (ValueError, TypeError):
            width = 0.0

        if length <= 0 or width <= 0:
            return None, "Length and Width must be greater than zero."

        try:
            qty = int(float(data.get("quantity") or data.get("available_qty") or 1))
        except (ValueError, TypeError):
            qty = 1

        if qty <= 0:
            qty = 1

        grade = str(data.get("grade") or "YS").strip() or "YS"
        notes = str(data.get("notes") or "").strip()
        parent_part = str(data.get("parent_part_no") or data.get("part_no") or "Shop Floor Offcut").strip()

        # Calculate weight in kg: Length * Width * Thickness * 7.85e-6 * qty
        volume_mm3 = length * width * thickness
        single_wt = round(volume_mm3 * 7.85e-6, 3) if volume_mm3 > 0 else 0.0
        total_wt = round(single_wt * qty, 3)
        dim_str = f"{thickness}*{length}*{width}"

        record = {
            "id": eb_id,
            "endbit_id": eb_id,
            "mo_number": data.get("mo_number") or f"MANUAL-{now_ts}",
            "parent_part_no": parent_part,
            "base_part": data.get("base_part") or parent_part.split(" - ")[0],
            "rm_erp": f"{thickness}*{int(length)}*{int(width)}",
            "layout_name": "Manual Offcut",
            "grade": grade,
            "name": name,
            "dim": dim_str,
            "thickness": thickness,
            "length": length,
            "width": width,
            "qty_per_sheet": 1,
            "initial_qty": qty,
            "available_qty": qty,
            "used_qty": 0,
            "weight_kg": single_wt,
            "total_weight_kg": total_wt,
            "status": "AVAILABLE",
            "notes": notes,
            "is_manual": True,
            "created_by": created_by_role,
            "parts_created": [],
            "created_at": now_iso,
            "updated_at": now_iso
        }

        all_ebs = self._load_endbits_local()
        # Ensure unique ID
        all_ebs = [e for e in all_ebs if e.get("endbit_id") != eb_id]
        all_ebs = [record] + all_ebs
        self._save_endbits_local(all_ebs)

        if self.use_supabase:
            try:
                self.session.post(
                    f"{SUPABASE_URL}/rest/v1/endbit_records",
                    headers=self._get_supabase_headers(),
                    json=record,
                    timeout=5
                )
            except Exception as e:
                print(f"[Manual Endbit] Supabase write notice: {e}")

        print(f"[Manual Endbit] Added end-bit {eb_id} ({dim_str} mm, {qty} Nos) to Store by {created_by_role}")
        return record, None

    def list_endbits(self, status=None, grade=None, mo_number=None, search=None):
        """List recorded end bits with optional filters"""
        all_ebs = self._load_endbits_local()
        filtered = all_ebs
        if status and status.upper() != "ALL":
            filtered = [e for e in filtered if (e.get("status") or "").upper() == status.upper()]
        if grade:
            filtered = [e for e in filtered if (e.get("grade") or "").lower() == grade.lower()]
        if mo_number:
            filtered = [e for e in filtered if (e.get("mo_number") or "") == mo_number]
        if search and search.strip():
            q = search.strip().lower()
            filtered = [
                e for e in filtered
                if q in (e.get("endbit_id") or "").lower() or
                   q in (e.get("mo_number") or "").lower() or
                   q in (e.get("parent_part_no") or "").lower() or
                   q in (e.get("base_part") or "").lower() or
                   q in (e.get("grade") or "").lower() or
                   q in (e.get("dim") or "").lower() or
                   q in (e.get("status") or "").lower()
            ]
        return filtered

    def get_endbit(self, endbit_id):
        """Get a single end bit record by endbit_id"""
        all_ebs = self._load_endbits_local()
        for eb in all_ebs:
            if eb.get("endbit_id") == endbit_id or eb.get("id") == endbit_id:
                return eb
        return None

    def produce_part_from_endbit(self, endbit_id, part_data, role="shearing"):
        """
        Produces parts from an available end bit, updates end bit inventory,
        increments finished goods / WIP stock, and records the cutting order.
        """
        if role != "shearing":
            return None, None, "Unauthorized: Only the Shearing Production team can produce parts or create Material Orders from end bits."
        all_ebs = self._load_endbits_local()
        target_eb = None
        for eb in all_ebs:
            if eb.get("endbit_id") == endbit_id or eb.get("id") == endbit_id:
                target_eb = eb
                break

        if not target_eb:
            return None, None, f"End bit '{endbit_id}' not found."

        avail = float(target_eb.get("available_qty") or 0)
        if avail <= 0:
            return None, None, f"End bit '{endbit_id}' has already been fully consumed (0 available)."

        endbits_used = float(part_data.get("endbits_used") or 1)
        if endbits_used <= 0:
            return None, None, "End bits used must be at least 1."
        if endbits_used > avail:
            return None, None, f"Cannot consume {endbits_used} end bits. Only {avail} available."

        target_part_no = (part_data.get("part_no") or "").strip()
        if not target_part_no:
            return None, None, "Part Number is required to produce parts."

        blanks_per_eb = float(part_data.get("blanks_per_endbit") or 1)
        parts_produced = float(
            part_data.get("total_parts_produced") or
            part_data.get("parts_produced") or
            (endbits_used * blanks_per_eb)
        )
        if parts_produced <= 0:
            return None, None, "Parts produced quantity must be greater than 0."

        notes = (part_data.get("notes") or "").strip()
        now_iso = datetime.utcnow().isoformat() + "Z"
        now_date = datetime.utcnow().strftime("%Y-%m-%d")
        new_mo_num = f"MO-EB-{int(time.time())}"
        new_co_num = f"CUT-EB-{int(time.time())}"

        # 1. Update End Bit state
        new_avail = max(0.0, avail - endbits_used)
        new_used = float(target_eb.get("used_qty") or 0) + endbits_used
        new_status = "CONSUMED" if new_avail <= 0 else "PARTIALLY_USED"

        tx_entry = {
            "id": f"PFE-{int(time.time()*1000)}",
            "part_no": target_part_no,
            "parts_produced": int(parts_produced) if parts_produced == int(parts_produced) else parts_produced,
            "endbits_used": int(endbits_used) if endbits_used == int(endbits_used) else endbits_used,
            "timestamp": now_iso,
            "created_by": role,
            "notes": notes or f"Manufactured {parts_produced} units of {target_part_no} from {endbits_used} offcut end bits ({target_eb.get('dim')})",
            "source_endbit_id": endbit_id,
            "source_mo_number": target_eb.get("mo_number"),
            "mo_number": new_mo_num,
            "cutting_order_no": new_co_num
        }

        if "parts_created" not in target_eb or not isinstance(target_eb["parts_created"], list):
            target_eb["parts_created"] = []
        target_eb["parts_created"].insert(0, tx_entry)
        target_eb["available_qty"] = int(new_avail) if new_avail == int(new_avail) else new_avail
        target_eb["used_qty"] = int(new_used) if new_used == int(new_used) else new_used
        target_eb["status"] = new_status
        target_eb["updated_at"] = now_iso

        self._save_endbits_local(all_ebs)

        # 2. Update Supabase endbit_records if available
        if self.use_supabase:
            try:
                self.session.patch(
                    f"{SUPABASE_URL}/rest/v1/endbit_records?endbit_id=eq.{endbit_id}",
                    headers=self._get_supabase_headers(),
                    json={
                        "available_qty": target_eb["available_qty"],
                        "used_qty": target_eb["used_qty"],
                        "status": target_eb["status"],
                        "parts_created": target_eb["parts_created"],
                        "updated_at": now_iso
                    },
                    timeout=5
                )
            except Exception:
                pass

        # 3. Increment FG / WIP Inventory (parts_fg_wip_stock)
        if self.use_supabase:
            try:
                headers = self._get_supabase_headers()
                r_fg = self.session.get(f"{SUPABASE_URL}/rest/v1/parts_fg_wip_stock?item_code=eq.{target_part_no}", headers=headers, timeout=5)
                if r_fg.status_code == 200 and r_fg.json():
                    fg_row = r_fg.json()[0]
                    cur_fg = float(fg_row.get("onhand_stock") or 0)
                    new_fg = cur_fg + parts_produced
                    self.session.patch(f"{SUPABASE_URL}/rest/v1/parts_fg_wip_stock?id=eq.{fg_row['id']}", headers=headers, json={"onhand_stock": new_fg}, timeout=5)
                else:
                    new_fg_row = {
                        "item_code": target_part_no,
                        "item_desc": f"{target_part_no} (Cut from Endbit {endbit_id})",
                        "uom": "NOS",
                        "store_desc": "FG AND WIP STORES",
                        "onhand_stock": parts_produced,
                        "category_desc": "FINISHED GOODS"
                    }
                    self.session.post(f"{SUPABASE_URL}/rest/v1/parts_fg_wip_stock", headers=headers, json=new_fg_row, timeout=5)
            except Exception as e:
                print(f"[Endbit Part Production] Error updating FG stock: {e}")

        # 4. Insert into erp_mo_reports for auditability
        if self.use_supabase:
            try:
                erp_entry = {
                    "mo_doc_no": new_mo_num,
                    "doc_date": now_date,
                    "order_status": "COMPLETED",
                    "cutting_order_no": f"CUT-EB-{int(time.time())}",
                    "cutting_order_date": now_date,
                    "rm_code": f"ENDBIT-{endbit_id}",
                    "rm_desc": f"End Bit Offcut from MO {target_eb.get('mo_number')} ({target_eb.get('dim')})",
                    "number_of_sheets": endbits_used,
                    "parent_code": target_part_no,
                    "parent_qty_per_sheet": round(parts_produced / max(1.0, endbits_used), 2),
                    "total_parent_qty": parts_produced,
                    "cutting_plan_no": f"OFFCUT-{endbit_id}",
                    "uom": "NOS"
                }
                self.session.post(f"{SUPABASE_URL}/rest/v1/erp_mo_reports", headers=self._get_supabase_headers(), json=erp_entry, timeout=5)
            except Exception as e:
                print(f"[Endbit Part Production] Error writing erp_mo_reports: {e}")

        # 5. Also record as an MO in material_orders / data_mo_store so it shows up in MO list
        endbit_mo = {
            "mo_number": new_mo_num,
            "part_no": target_part_no,
            "base_part": target_part_no.split(" - ")[0].strip(),
            "rm_erp": f"ENDBIT {target_eb.get('dim')}",
            "grade": target_eb.get("grade", ""),
            "is_standard_layout": True,
            "layout_name": f"From Endbit {endbit_id}",
            "thickness": target_eb.get("thickness"),
            "length": target_eb.get("length"),
            "width": target_eb.get("width"),
            "target_qty": int(parts_produced),
            "sheets_required": endbits_used,
            "workflow_path": "FROM_ENDBIT",
            "current_stage": "COMPLETED",
            "status": "RELEASED_TO_ERP",
            "audit_trail": [
                {
                    "action": "CREATED_FROM_ENDBIT",
                    "actor_role": role,
                    "actor_name": ROLES.get(role, {}).get("name", "Shearing"),
                    "timestamp": now_iso,
                    "stage": "COMPLETED",
                    "remarks": f"Manufactured {parts_produced} units of {target_part_no} from {endbits_used} end bits ({endbit_id} of MO {target_eb.get('mo_number')}). Stock updated."
                }
            ],
            "created_by": role,
            "created_at": now_iso,
            "updated_at": now_iso
        }
        self._save_local(endbit_mo)

        return target_eb, tx_entry, None

    def create_mo_from_endbit(self, form_data, created_by_role="shearing"):
        """
        Creates a dedicated Material Order from sheet end bits / offcuts
        without predefined nesting layouts. Dimensions, parts, and counts
        are manually filled by the user.
        """
        if created_by_role != "shearing":
            return None, "Unauthorized: Only the Shearing Production team can create End Bit Material Orders."

        now_iso = datetime.utcnow().isoformat() + "Z"
        now_date = datetime.utcnow().strftime("%Y-%m-%d")
        ts = int(time.time())
        mo_number = (form_data.get("mo_number") or f"MO-EB-{ts}").strip()
        cutting_order_no = f"CUT-EB-{ts}"

        # Parse dynamic parts payload early if available
        parts_data = form_data.get("parts")
        parsed_parts = []
        if isinstance(parts_data, str) and parts_data.strip():
            try:
                parsed_parts = json.loads(parts_data)
            except Exception:
                parsed_parts = []
        elif isinstance(parts_data, list):
            parsed_parts = parts_data

        part_no = (form_data.get("part_no") or "").strip()
        if not part_no and parsed_parts:
            valid_p = [p.get("part_no", "").strip() for p in parsed_parts if p.get("part_no", "").strip()]
            if valid_p:
                part_no = ", ".join(valid_p) if len(valid_p) > 1 else valid_p[0]

        if not part_no:
            return None, "Part Number is mandatory."

        base_part = (form_data.get("base_part") or part_no.split(" - ")[0]).strip()
        grade = (form_data.get("grade") or "YS").strip()

        # Numeric dimensions
        try:
            thickness = float(form_data.get("thickness") or 0)
        except (ValueError, TypeError):
            thickness = 0.0

        try:
            cut_length = float(form_data.get("cut_length") or form_data.get("blank_length") or 0)
            cut_width = float(form_data.get("cut_width") or form_data.get("blank_width") or 0)
        except (ValueError, TypeError):
            cut_length, cut_width = 0.0, 0.0

        try:
            offcut_length = float(form_data.get("offcut_length") or form_data.get("length") or 0)
            offcut_width = float(form_data.get("offcut_width") or form_data.get("width") or 0)
        except (ValueError, TypeError):
            offcut_length, offcut_width = 0.0, 0.0

        # Quantities
        try:
            endbits_used = max(1.0, float(form_data.get("endbits_used") or form_data.get("sheets_required") or 1))
        except (ValueError, TypeError):
            endbits_used = 1.0

        try:
            blanks_per_eb = max(1.0, float(form_data.get("blanks_per_endbit") or 1))
        except (ValueError, TypeError):
            blanks_per_eb = 1.0

        try:
            target_qty = int(form_data.get("target_qty") or form_data.get("total_parts_produced") or round(endbits_used * blanks_per_eb))
        except (ValueError, TypeError):
            target_qty = int(round(endbits_used * blanks_per_eb))

        # Yield %
        yield_pct = form_data.get("yield_pct")
        if yield_pct is not None and str(yield_pct).strip() != "" and "exceed" not in str(yield_pct).lower():
            try:
                yield_val = float(str(yield_pct).replace("%", "").strip())
            except ValueError:
                yield_val = None
        else:
            # Auto-calculate area yield if dimensions provided
            if cut_length > 0 and cut_width > 0 and offcut_length > 0 and offcut_width > 0:
                blank_area = cut_length * cut_width * target_qty
                eb_area = offcut_length * offcut_width * endbits_used
                if blank_area > eb_area:
                    yield_val = None
                else:
                    yield_val = round(min(100.0, (blank_area / eb_area) * 100.0), 2)
            else:
                yield_val = None

        parts_list = []
        if parsed_parts:
            for p in parsed_parts:
                p_no = (p.get("part_no") or "").strip()
                if not p_no:
                    continue
                p_qty = int(p.get("no_of_parts") or p.get("target_qty") or 1)
                parts_list.append({
                    "part_no": p_no,
                    "base_part": (p.get("base_part") or p_no.split(" - ")[0]).strip(),
                    "part_size": p.get("part_size") or f"{p.get('thickness', thickness)}*{p.get('cut_length', 0)}*{p.get('cut_width', 0)}",
                    "cut_length": float(p.get("cut_length") or 0),
                    "cut_width": float(p.get("cut_width") or 0),
                    "thickness": float(p.get("thickness") or thickness),
                    "no_of_parts": p_qty,
                    "yield_pct": p.get("yield_pct")
                })
            if parts_list:
                part_no = ", ".join(p["part_no"] for p in parts_list) if len(parts_list) > 1 else parts_list[0]["part_no"]
                base_part = parts_list[0]["base_part"]
                target_qty = sum(p["no_of_parts"] for p in parts_list)

        # Strict Physical Boundary & Pro-Rata Capacity Verification: Ensure part blanks fit and do not exceed capacity
        eb_max = max(offcut_length, offcut_width)
        eb_min = min(offcut_length, offcut_width)
        if eb_max > 0 and eb_min > 0:
            check_parts = parts_list if parts_list else [{
                "part_no": part_no,
                "cut_length": cut_length,
                "cut_width": cut_width,
                "no_of_parts": target_qty
            }]
            for cp in check_parts:
                p_l = max(float(cp.get("cut_length", 0)), float(cp.get("cut_width", 0)))
                p_w = min(float(cp.get("cut_length", 0)), float(cp.get("cut_width", 0)))
                if p_l > 0 and p_w > 0:
                    if p_l > eb_max or p_w > eb_min:
                        return None, (
                            f"Boundary Error: Part '{cp.get('part_no')}' blank size ({p_l:g} × {p_w:g} mm) "
                            f"exceeds the selected end-bit size ({eb_max:g} × {eb_min:g} mm). "
                            f"Cannot cut this part from this offcut."
                        )
                    opt1 = int(eb_max // p_l) * int(eb_min // p_w)
                    opt2 = int(eb_max // p_w) * int(eb_min // p_l)
                    parts_per_eb = max(opt1, opt2, 1)
                    max_allowed = parts_per_eb * int(endbits_used)
                    req_qty = int(cp.get("no_of_parts") or cp.get("target_qty") or 1)
                    if req_qty > max_allowed:
                        needed = math.ceil(req_qty / parts_per_eb) if parts_per_eb > 0 else 999
                        return None, (
                            f"Capacity Error: Requested {req_qty} parts for '{cp.get('part_no')}' "
                            f"exceeds the raw material capacity of {int(endbits_used)} end-bit(s) "
                            f"({max_allowed} max units producible). "
                            f"Need at least {needed} end-bits to produce {req_qty} units."
                        )

            total_eb_area = offcut_length * offcut_width * endbits_used
            total_part_cut_area = sum(float(cp.get("cut_length", 0)) * float(cp.get("cut_width", 0)) * int(cp.get("no_of_parts", 1)) for cp in check_parts)
            if total_eb_area > 0 and total_part_cut_area > total_eb_area:
                return None, (
                    f"Capacity Error: Total blanks cut area ({total_part_cut_area:,.0f} mm²) exceeds "
                    f"total end-bit area ({total_eb_area:,.0f} mm²). Without sufficient raw material, cannot produce parts."
                )

        endbit_id = (form_data.get("endbit_id") or "").strip()
        endbit_name = (form_data.get("endbit_name") or "").strip()
        source_mo = (form_data.get("source_mo_number") or "").strip()
        work_center = (form_data.get("work_center") or "Shearing Guillotine").strip()
        notes = (form_data.get("notes") or "").strip()
        doc_url = (form_data.get("layout_doc_url") or "").strip()
        doc_filename = (form_data.get("layout_doc_filename") or "").strip()

        # Build offcut dimension string
        dim_str = f"{thickness}*{offcut_length}*{offcut_width}" if (offcut_length and offcut_width) else form_data.get("endbit_dim", "")
        cut_blank_str = f"{cut_length}*{cut_width}*{thickness}" if (cut_length and cut_width) else form_data.get("cut_blank", "")

        # Items to record for FG inventory and ERP cutting reports
        items_to_credit = parts_list if parts_list else [{
            "part_no": part_no,
            "target_qty": target_qty,
            "blanks_per_eb": blanks_per_eb,
            "part_size": cut_blank_str
        }]

        # 1. Audit Entry: Shearing initiates End Bit MO, routing directly to ERP
        audit_entry = {
            "action": "CREATED_FROM_ENDBIT",
            "actor_role": created_by_role,
            "actor_name": ROLES.get(created_by_role, {}).get("name", "Shearing"),
            "timestamp": now_iso,
            "stage": "ERP",
            "remarks": notes or f"Manual End Bit MO created by Shearing: {target_qty} units of {part_no} from {endbits_used} offcut(s) ({endbit_name or endbit_id or 'Shop Floor Offcut'}). Fast-tracked directly to ERP Approval."
        }

        # 2. Constraints status metadata
        constraints_status = {
            "is_endbit_mo": True,
            "endbit_id": endbit_id,
            "endbit_name": endbit_name,
            "source_mo_number": source_mo,
            "work_center": work_center,
            "cut_blank": cut_blank_str,
            "blanks_per_endbit": blanks_per_eb,
            "cutting_order_no": cutting_order_no,
            "all_satisfied": True,
            "yield_pct": yield_val,
            "parts": parts_list if parts_list else None,
            "stock_deducted": False
        }

        # 3. Create Material Order Record with DIRECT_ERP workflow (fast-track direct to ERP, skipping Krysalis and Purchase)
        # Note: Stock deduction and finished goods crediting occur strictly upon final ERP approval
        mo_record = {
            "mo_number": mo_number,
            "part_no": part_no,
            "base_part": base_part,
            "rm_erp": f"ENDBIT {dim_str}" if dim_str else "MANUAL ENDBIT OFFCUT",
            "grade": grade,
            "is_standard_layout": False,
            "layout_name": f"Manual End Bit Shearing ({endbit_name or 'Offcut'})",
            "yield_pct": yield_val,
            "thickness": thickness,
            "length": offcut_length,
            "width": offcut_width,
            "target_qty": target_qty,
            "sheets_required": endbits_used,
            "layout_doc_url": doc_url,
            "layout_doc_filename": doc_filename,
            "constraints_status": constraints_status,
            "workflow_path": "DIRECT_ERP",
            "current_stage": "ERP",
            "status": "PENDING_ERP",
            "parts": parts_list if parts_list else None,
            "part1": parts_list[0] if (parts_list and len(parts_list) > 0) else None,
            "part2": parts_list[1] if (parts_list and len(parts_list) > 1) else None,
            "part3": parts_list[2] if (parts_list and len(parts_list) > 2) else None,
            "part4": parts_list[3] if (parts_list and len(parts_list) > 3) else None,
            "audit_trail": [audit_entry],
            "created_by": created_by_role,
            "created_at": now_iso,
            "updated_at": now_iso,
            "stock_deducted": False
        }

        # Save to local store
        self._save_local(mo_record)

        # Save to Supabase material_orders
        if self.use_supabase:
            try:
                clean_payload = self._sanitize_mo_for_db(mo_record)
                res = requests.post(
                    f"{SUPABASE_URL}/rest/v1/material_orders",
                    headers=self._get_supabase_headers(),
                    json=clean_payload,
                    timeout=10
                )
                if res.status_code in (200, 201):
                    print(f"[Create MO From Endbit] Successfully added {mo_record.get('mo_number')} to Supabase material_orders")
                else:
                    print(f"[Create MO From Endbit] Supabase insert returned {res.status_code}: {res.text}")
            except Exception as e:
                print(f"[Create MO From Endbit] Error inserting Supabase material_orders: {e}")

        # Always keep local backup store synchronized
        self._save_local(mo_record)
        self._cached_mos = None  # Invalidate cache on new creation

        return mo_record, None

    def get_endbit_stats(self):
        """Returns summary statistics for the End Bits Store"""
        all_ebs = self._load_endbits_local()
        total_items = len(all_ebs)
        avail_items = sum(1 for e in all_ebs if (e.get("status") or "").upper() == "AVAILABLE")
        partial_items = sum(1 for e in all_ebs if (e.get("status") or "").upper() == "PARTIALLY_USED")
        consumed_items = sum(1 for e in all_ebs if (e.get("status") or "").upper() == "CONSUMED")
        total_parts_produced = sum(
            sum(p.get("parts_produced", 0) for p in e.get("parts_created", []))
            for e in all_ebs
        )
        total_weight_kg = sum(float(e.get("weight_kg") or 0) for e in all_ebs)
        return {
            "total_endbits": total_items,
            "total_records": total_items,
            "available_endbits": avail_items,
            "total_available_nos": avail_items,
            "partially_used": partial_items,
            "consumed": consumed_items,
            "parts_produced": total_parts_produced,
            "total_parts_made": total_parts_produced,
            "total_weight_kg": round(total_weight_kg, 2)
        }

    def get_db_tables_overview(self):
        """Returns metadata and exact real-time row counts for all database tables"""
        tables = []
        headers = {**self._get_supabase_headers(), "Range": "0-0", "Prefer": "count=exact"}
        for tbl_id, cfg in DB_TABLES_CONFIG.items():
            count = 0
            if tbl_id == "endbit_records":
                count = len(self._load_endbits_local())
            elif self.use_supabase:
                try:
                    res = self.session.get(f"{SUPABASE_URL}/rest/v1/{tbl_id}?select=id", headers=headers, timeout=4)
                    cr = res.headers.get("content-range")
                    if cr and "/" in cr:
                        count = int(cr.split("/")[1])
                except Exception:
                    pass
            tables.append({
                "id": tbl_id,
                "title": cfg["title"],
                "icon": cfg["icon"],
                "category": cfg["category"],
                "badge_class": cfg["badge_class"],
                "description": cfg["description"],
                "count": count
            })
        return tables

    def get_db_table_data(self, table_name, page=1, limit=25, search_query=None):
        """Fetch paginated rows from Supabase table or local store with search filter"""
        if table_name not in DB_TABLES_CONFIG:
            return None, f"Unknown database table: {table_name}"

        cfg = DB_TABLES_CONFIG[table_name]
        limit = min(100, max(5, int(limit)))
        page = max(1, int(page))
        start_idx = (page - 1) * limit
        end_idx = start_idx + limit - 1

        # Local fallback handler for endbit_records
        if table_name == "endbit_records":
            all_ebs = self._load_endbits_local()
            if search_query and search_query.strip():
                sq = search_query.strip().lower()
                all_ebs = [
                    e for e in all_ebs
                    if sq in (e.get("endbit_id") or "").lower() or
                       sq in (e.get("mo_number") or "").lower() or
                       sq in (e.get("parent_part_no") or "").lower() or
                       sq in (e.get("base_part") or "").lower() or
                       sq in (e.get("grade") or "").lower() or
                       sq in (e.get("dim") or "").lower() or
                       sq in (e.get("status") or "").lower()
                ]
            total_count = len(all_ebs)
            total_pages = math.ceil(total_count / limit) if total_count > 0 else 1
            rows = all_ebs[start_idx:end_idx + 1]
            columns = cfg.get("display_columns", self._get_table_all_columns("endbit_records"))
            return {
                "table_name": table_name,
                "title": cfg["title"],
                "category": cfg["category"],
                "description": cfg["description"],
                "page": page,
                "limit": limit,
                "total_rows": total_count,
                "total_pages": total_pages,
                "columns": columns,
                "rows": rows
            }, None

        headers = {
            **self._get_supabase_headers(),
            "Range": f"{start_idx}-{end_idx}",
            "Prefer": "count=exact"
        }

        url = f"{SUPABASE_URL}/rest/v1/{table_name}?select=*"
        if search_query and search_query.strip():
            sq = search_query.strip()
            search_fields = cfg.get("search_fields", [])
            if search_fields:
                or_clause = ",".join([f"{f}.ilike.*{sq}*" for f in search_fields])
                url += f"&or=({or_clause})"

        sort_col = cfg.get("default_sort", "id.desc")
        url += f"&order={sort_col}"

        try:
            res = self.session.get(url, headers=headers, timeout=8)
            rows = res.json() if res.status_code in (200, 206) else []
            cr = res.headers.get("content-range")
            total_count = int(cr.split("/")[1]) if (cr and "/" in cr and cr.split("/")[1].isdigit()) else len(rows)
            total_pages = math.ceil(total_count / limit) if total_count > 0 else 1

            if table_name == "material_orders":
                columns = cfg.get("display_columns", ["mo_number", "part_no", "rm_erp", "sheets_required", "target_qty", "current_stage", "status", "workflow_path", "created_on"])
                for r in rows:
                    raw_dt = r.get("created_at") or r.get("created_on") or ""
                    r["created_on"] = str(raw_dt).split("T")[0].split(" ")[0] if raw_dt else "-"
            else:
                # Except material_orders, all other tables show all columns!
                if rows:
                    columns = list(rows[0].keys())
                else:
                    columns = self._get_table_all_columns(table_name)

                # Filter out separate sl_no column (since the default index column serves as Sl. No.)
                columns = [c for c in columns if c.lower() not in ("sl_no", "slno", "s_no")]

                # In ERP MO reports, don't add or show created_at / created_on
                if table_name == "erp_mo_reports":
                    columns = [c for c in columns if c not in ("created_at", "created_on")]

            return {
                "table_name": table_name,
                "title": cfg["title"],
                "category": cfg["category"],
                "description": cfg["description"],
                "page": page,
                "limit": limit,
                "total_rows": total_count,
                "total_pages": total_pages,
                "columns": columns,
                "rows": rows
            }, None
        except Exception as e:
            return None, str(e)

    def _get_table_all_columns(self, table_name):
        known = {
            "rm_main_store_stock": ['id', 'item_code', 'item_desc', 'uom', 'store_desc', 'onhand_stock', 'category_desc', 'weight', 'total_weight', 'std_cost', 'last_po_price', 'stock_value', 'created_at'],
            "parts_fg_wip_stock": ['id', 'item_code', 'item_desc', 'uom', 'store_desc', 'onhand_stock', 'category_desc', 'weight', 'total_weight', 'std_cost', 'std_stock_value', 'details', 'created_at'],
            "endbit_records": ['id', 'endbit_id', 'mo_number', 'parent_part_no', 'base_part', 'grade', 'name', 'dim', 'thickness', 'length', 'width', 'available_qty', 'used_qty', 'initial_qty', 'weight_kg', 'status', 'created_at'],
            "erp_mo_reports": ['id', 'mo_doc_no', 'doc_date', 'order_status', 'cutting_order_no', 'cutting_order_date', 'rm_code', 'rm_desc', 'uom', 'number_of_sheets', 'reference_date', 'reference_no', 'start_date', 'due_date', 'cutting_plan_no', 'parent_code', 'parent_desc', 'uom_code', 'parent_qty_per_sheet', 'total_parent_qty', 'rm_weight'],
            "layout_records": ['id', 'row_id', 'base_part', 'part_no', 'status', 'layout_name', 'rm_erp', 'cut_blank', 'grade', 'no_of_sheets', 'cutting_plan', 'thickness', 'length', 'width', 'rm_weight', 'part1', 'part2', 'part3', 'part4', 'per_sheet', 'total_sheet', 'endbits', 'po_price', 'wastage_cost', 'image_url', 'created_at', 'updated_at'],
            "mrp_rm_sheet_bom": ['id', 'parent_part_no', 'child_part_no', 'os_part', 'erp_part_no', 'scope', 'offtake', 'grade', 'blank_length', 'blank_width', 'blank_thickness', 'blank_weight', 'sheet_length', 'sheet_width', 'sheet_thickness', 'sheet_weight', 'existing_sheet_used', 'components_per_sheet', 'schedule_qty', 'total_qty', 'inhouse_erp_qty', 'outsource_erp_qty', 'balance_qty', 'sheet_working', 'no_of_sheets', 'total_sheet_weight', 'remarks', 'remarks_2', 'created_at']
        }
        return known.get(table_name, [])


    def reject_mo(self, mo_number, role, reason):
        """Reject an MO with required reason"""
        if not reason or not reason.strip():
            return None, "A clear rejection reason is required."

        mo = self.get_mo(mo_number)
        if not mo:
            return None, "Material Order not found."

        current_stage = mo.get("current_stage")
        role_info = ROLES.get(role, {})
        allowed_stages = role_info.get("can_approve_stages", [])

        if current_stage not in allowed_stages:
            return None, f"Role '{role}' is not authorized to reject stage '{current_stage}'."

        now_iso = datetime.utcnow().isoformat() + "Z"
        audit_trail = mo.get("audit_trail", [])

        audit_trail.append({
            "action": "REJECTED",
            "actor_role": role,
            "actor_name": role_info.get("name", role),
            "timestamp": now_iso,
            "stage": current_stage,
            "remarks": reason
        })

        mo["status"] = "REJECTED"
        mo["updated_at"] = now_iso
        mo["audit_trail"] = audit_trail

        self._update_mo(mo)
        return mo, None

    def resubmit_mo(self, mo_number, form_data, role="shearing"):
        """
        Allows Shearing team to edit and resubmit a rejected Material Order.
        Re-evaluates workflow path and routes to the appropriate stage until final approval.
        """
        if role != "shearing":
            return None, "Unauthorized: Only the Shearing Production team can revise and resubmit Material Orders."

        mo = self.get_mo(mo_number)
        if not mo:
            return None, "Material Order not found."

        now_iso = datetime.utcnow().isoformat() + "Z"
        audit_trail = mo.get("audit_trail") or []

        # Check if it's an End Bit MO
        cs = mo.get("constraints_status") or {}
        if isinstance(cs, str):
            try:
                cs = json.loads(cs)
            except Exception:
                cs = {}

        is_endbit = bool(
            cs.get("is_endbit_mo") or
            cs.get("endbit_id") or
            "ENDBIT" in str(mo.get("rm_erp", "")).upper() or
            (mo.get("workflow_path") == "DIRECT_ERP" and "End Bit" in str(mo.get("layout_name", "")))
        )

        # Update target_qty
        if "target_qty" in form_data and str(form_data["target_qty"]).strip():
            try:
                mo["target_qty"] = int(float(form_data["target_qty"]))
            except (ValueError, TypeError):
                pass

        # Update sheets_required
        if "sheets_required" in form_data and str(form_data["sheets_required"]).strip():
            try:
                mo["sheets_required"] = float(form_data["sheets_required"])
            except (ValueError, TypeError):
                pass

        # Update rm_erp
        if form_data.get("rm_erp"):
            mo["rm_erp"] = str(form_data["rm_erp"]).strip()

        # Update grade
        if form_data.get("grade"):
            mo["grade"] = str(form_data["grade"]).strip()

        # Update thickness, length, width
        for dim_field in ["thickness", "length", "width"]:
            if dim_field in form_data and str(form_data[dim_field]).strip():
                try:
                    mo[dim_field] = float(form_data[dim_field])
                except (ValueError, TypeError):
                    pass

        # Update yield_pct
        if "yield_pct" in form_data and form_data["yield_pct"] is not None and str(form_data["yield_pct"]).strip():
            try:
                mo["yield_pct"] = float(str(form_data["yield_pct"]).replace("%", "").strip())
            except (ValueError, TypeError):
                pass

        if "layout_name" in form_data and form_data["layout_name"]:
            mo["layout_name"] = str(form_data["layout_name"]).strip()

        if form_data.get("layout_doc_url"):
            mo["layout_doc_url"] = str(form_data["layout_doc_url"]).strip()
        if form_data.get("layout_doc_filename"):
            mo["layout_doc_filename"] = str(form_data["layout_doc_filename"]).strip()

        # Update constraints metadata if supplied
        if form_data.get("constraints_status"):
            new_cs = form_data["constraints_status"]
            if isinstance(new_cs, str):
                try:
                    new_cs = json.loads(new_cs)
                except Exception:
                    new_cs = None
            if isinstance(new_cs, dict):
                cs.update(new_cs)
                mo["constraints_status"] = cs

        # Re-evaluate routing
        revision_remarks = form_data.get("revision_notes") or form_data.get("notes") or "MO revised and resubmitted by Shearing team."

        if is_endbit:
            # Endbit MOs go directly to ERP
            routing = {
                "path": "DIRECT_ERP",
                "first_stage": "ERP",
                "status": "PENDING_ERP",
                "description": "End Bit MO fast-tracked directly to ERP Approval."
            }
        else:
            is_std = bool(mo.get("is_standard_layout", True))
            if "is_standard_layout" in form_data:
                is_std = bool(form_data["is_standard_layout"])
                mo["is_standard_layout"] = is_std

            constraints_satisfied = bool(cs.get("all_satisfied", True))
            routing = self.evaluate_workflow_path(is_std, constraints_satisfied)

        audit_trail.append({
            "action": "RESUBMITTED",
            "actor_role": "shearing",
            "actor_name": ROLES.get("shearing", {}).get("name", "Shearing"),
            "timestamp": now_iso,
            "stage": routing["first_stage"],
            "remarks": f"{revision_remarks} (Resubmitted -> {routing['status']})"
        })

        mo["workflow_path"] = routing["path"]
        mo["current_stage"] = routing["first_stage"]
        mo["status"] = routing["status"]
        mo["updated_at"] = now_iso
        mo["audit_trail"] = audit_trail

        self._update_mo(mo)
        return mo, None

    def get_stats(self):
        """Get summary counts for all departments"""
        mos = self.list_mos()
        return {
            "total_mos": len(mos),
            "pending_krysalis": sum(1 for m in mos if m.get("current_stage") == "KRYSALIS"),
            "pending_purchase": sum(1 for m in mos if m.get("current_stage") == "PURCHASE"),
            "pending_erp": sum(1 for m in mos if m.get("current_stage") == "ERP"),
            "released_to_erp": sum(1 for m in mos if m.get("status") == "RELEASED_TO_ERP"),
            "rejected": sum(1 for m in mos if m.get("status") == "REJECTED")
        }

    def _load_local(self):
        self._ensure_local_store()
        try:
            with open(LOCAL_MO_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []

    def _save_local(self, record):
        mos = self._load_local()
        # check duplicate
        updated = False
        for idx, m in enumerate(mos):
            if m.get("mo_number") == record.get("mo_number"):
                mos[idx] = record
                updated = True
                break
        if not updated:
            mos.insert(0, record)
        with open(LOCAL_MO_FILE, "w", encoding="utf-8") as f:
            json.dump(mos, f, indent=2)

    def _update_mo(self, mo):
        self._cached_mos = None  # Invalidate cache on updates
        if self.use_supabase:
            clean_mo = self._sanitize_mo_for_db(mo)
            for tbl in ["material_orders"]:
                try:
                    res = self.session.patch(
                        f"{SUPABASE_URL}/rest/v1/{tbl}?mo_number=eq.{mo['mo_number']}",
                        headers=self._get_supabase_headers(),
                        json=clean_mo,
                        timeout=6
                    )
                    if res.status_code in (200, 204):
                        # If 0 rows matched on patch, insert it
                        updated_rows = res.json() if res.status_code == 200 else []
                        if not updated_rows:
                            self.session.post(
                                f"{SUPABASE_URL}/rest/v1/{tbl}",
                                headers=self._get_supabase_headers(),
                                json=clean_mo,
                                timeout=6
                            )
                        break
                    else:
                        print(f"[MO Workflow] Supabase patch returned {res.status_code} on {tbl}: {res.text}")
                except Exception as e:
                    print(f"[MO Workflow] Supabase patch error on {tbl}: {e}")
        self._save_local(mo)

