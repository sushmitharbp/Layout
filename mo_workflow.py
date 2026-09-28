"""
SheetLayout AI — Manufacturing Order (MO) Workflow Engine
Handles MO creation, constraint evaluation, role-based state transitions,
and audit trails for Shearing, Krysalis, Purchase, and ERP teams.
"""

import os
import json
import time
from datetime import datetime
import requests
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_KEY") or os.getenv("SUPABASE_ANON_KEY")
LOCAL_MO_FILE = "data_mo_store.json"

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

    def _ensure_local_store(self):
        if not os.path.exists(LOCAL_MO_FILE):
            with open(LOCAL_MO_FILE, "w", encoding="utf-8") as f:
                json.dump([], f, indent=2)

    def _get_supabase_headers(self):
        return {
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=representation"
        }

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
        """Create a new Manufacturing Order and route to first stage"""
        is_std = bool(mo_data.get("is_standard_layout", True))
        constraints = mo_data.get("constraints_status", {})
        constraints_satisfied = constraints.get("all_satisfied", True)

        routing = self.evaluate_workflow_path(is_std, constraints_satisfied)
        now_iso = datetime.utcnow().isoformat() + "Z"

        mo_id = mo_data.get("mo_number") or f"MO-{int(time.time())}"
        
        audit_entry = {
            "action": "CREATED",
            "actor_role": created_by_role,
            "actor_name": ROLES.get(created_by_role, {}).get("name", "Shearing"),
            "timestamp": now_iso,
            "stage": routing["first_stage"],
            "remarks": mo_data.get("notes") or "MO initiated by Shearing team."
        }

        record = {
            "mo_number": mo_id,
            "part_no": mo_data.get("part_no", ""),
            "base_part": mo_data.get("base_part", ""),
            "rm_erp": mo_data.get("rm_erp", ""),
            "grade": mo_data.get("grade", ""),
            "is_standard_layout": is_std,
            "layout_name": mo_data.get("layout_name", ""),
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
            "updated_at": now_iso
        }

        # Try save to Supabase, fallback to local file
        saved = False
        if self.use_supabase:
            try:
                res = requests.post(
                    f"{SUPABASE_URL}/rest/v1/manufacturing_orders",
                    headers=self._get_supabase_headers(),
                    json=record,
                    timeout=10
                )
                if res.status_code in (200, 201):
                    saved = True
            except Exception as e:
                print(f"[MO Workflow] Supabase insert error: {e}")

        if not saved:
            self._save_local(record)

        return record

    def list_mos(self, role=None, stage=None, status=None):
        """List MOs with optional filtering"""
        mos = []
        if self.use_supabase:
            try:
                params = ["select=*&order=created_at.desc"]
                if stage:
                    params.append(f"current_stage=eq.{stage}")
                if status:
                    params.append(f"status=eq.{status}")
                query_str = "&".join(params)
                res = requests.get(
                    f"{SUPABASE_URL}/rest/v1/manufacturing_orders?{query_str}",
                    headers=self._get_supabase_headers(),
                    timeout=10
                )
                if res.status_code == 200:
                    mos = res.json()
            except Exception as e:
                print(f"[MO Workflow] Supabase query error: {e}")

        if not mos:
            mos = self._load_local()
            if stage:
                mos = [m for m in mos if m.get("current_stage") == stage]
            if status:
                mos = [m for m in mos if m.get("status") == status]

        return mos

    def get_mo(self, mo_number):
        """Get single MO by MO number"""
        if self.use_supabase:
            try:
                res = requests.get(
                    f"{SUPABASE_URL}/rest/v1/manufacturing_orders?mo_number=eq.{mo_number}&select=*",
                    headers=self._get_supabase_headers(),
                    timeout=10
                )
                if res.status_code == 200:
                    items = res.json()
                    if items:
                        return items[0]
            except Exception:
                pass

        mos = self._load_local()
        for m in mos:
            if m.get("mo_number") == mo_number:
                return m
        return None

    def approve_mo(self, mo_number, role, remarks="Approved"):
        """Process role approval and advance to next stage in workflow"""
        mo = self.get_mo(mo_number)
        if not mo:
            return None, "Manufacturing Order not found."

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

    def reject_mo(self, mo_number, role, reason):
        """Reject an MO with required reason"""
        if not reason or not reason.strip():
            return None, "A clear rejection reason is required."

        mo = self.get_mo(mo_number)
        if not mo:
            return None, "Manufacturing Order not found."

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
        if self.use_supabase:
            try:
                requests.patch(
                    f"{SUPABASE_URL}/rest/v1/manufacturing_orders?mo_number=eq.{mo['mo_number']}",
                    headers=self._get_supabase_headers(),
                    json=mo,
                    timeout=10
                )
            except Exception:
                pass
        self._save_local(mo)
