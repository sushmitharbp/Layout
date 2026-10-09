"""
SheetLayout AI — Purchase AI Clearance & Procurement Agent
Autonomous decision-making engine for the Purchase & Procurement team.
Analyzes failing production constraints (RM Stock Shortage, MRP Schedule Violations,
Quota Deficits, and Layout Constraints) and synthesizes executive procurement decisions:
1. PO Requisition Sizing (exact shortfall sheets, weight kg/MT, minimum batch sizing).
2. Store Stock Substitution Clearance (identifies in-stock compatible alternatives with >0 sheets to avoid lead time).
3. Split Shearing Run Clearance (clear partial run to prevent line stoppage while balance PO arrives).
4. Auto-generated formal procurement approval remarks for 1-click signoff.
"""

import os
import re
import math
import json
import urllib.request
import urllib.error
from typing import Dict, Any, List, Optional, Tuple

from dotenv import load_dotenv

load_dotenv()


def parse_rm_dims(text: str, fallback_t: float = 0.0) -> Tuple[float, float, float]:
    """Extracts (thickness, length, width) where length >= width from RM specs."""
    if not text:
        return 0.0, 0.0, 0.0
    clean_text = str(text).upper()

    m3 = re.findall(r'(\d+(?:\.\d+)?)\s*[*xX-]\s*(\d+(?:\.\d+)?)\s*[*xX-]\s*(\d+(?:\.\d+)?)', clean_text)
    for trio in m3:
        nums = [float(x) for x in trio]
        dims = [x for x in nums if 300 <= x <= 6000]
        thicks = [x for x in nums if 0.4 <= x <= 40]
        if len(dims) == 2 and len(thicks) == 1:
            return thicks[0], max(dims), min(dims)
        elif len(dims) == 2 and fallback_t > 0:
            return fallback_t, max(dims), min(dims)

    nums = [float(x) for x in re.findall(r'\d+(?:\.\d+)?', clean_text)]
    dims = [x for x in nums if 300 <= x <= 6000]
    thicks = [x for x in nums if 0.4 <= x <= 40]

    t = fallback_t
    if fallback_t > 0 and fallback_t in thicks:
        t = fallback_t
    elif thicks:
        t = thicks[0]

    if len(dims) >= 2:
        return t, max(dims[0], dims[1]), min(dims[0], dims[1])

    return t, 0.0, 0.0


class PurchaseAdvisorAgent:
    """
    Purchase AI Decision Agent that evaluates failing constraints on Material Orders
    and formulates executive procurement solutions.
    """

    def __init__(self, data_store=None, erp_service=None, mo_engine=None, rm_advisor=None):
        self.data_store = data_store
        self.erp_service = erp_service
        self.mo_engine = mo_engine
        self.rm_advisor = rm_advisor

    def analyze_order_and_decide(self, mo_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Comprehensive constraint evaluation and executive decision synthesis
        for a Material Order in the Purchase approval stage.
        """
        mo_number = mo_data.get("mo_number", "MO-PROD")
        part_no = (mo_data.get("part_no") or "").strip()
        base_part = mo_data.get("base_part") or (part_no.split(" - ")[0].strip() if part_no else "")
        rm_erp = (mo_data.get("rm_erp") or "").strip()
        grade = (mo_data.get("grade") or "").strip() or "YS"
        target_qty = int(mo_data.get("target_qty") or 1)
        sheets_required = float(mo_data.get("sheets_required") or 1)
        yield_pct = mo_data.get("yield_pct")

        # Parse dimensions
        t = float(mo_data.get("thickness") or 0.0)
        l = float(mo_data.get("length") or 0.0)
        w = float(mo_data.get("width") or 0.0)
        if (l == 0 or w == 0) and rm_erp:
            t_p, l_p, w_p = parse_rm_dims(rm_erp, t)
            if t == 0:
                t = t_p
            if l == 0:
                l = l_p
            if w == 0:
                w = w_p

        # Extract constraints
        cs = mo_data.get("constraints_status") or {}
        if isinstance(cs, str):
            try:
                cs = json.loads(cs)
            except Exception:
                cs = {}

        # 1. Fetch Real-time On-Hand RM Inventory from ERP Stock Service
        onhand_stock = None
        if self.erp_service and rm_erp:
            try:
                onhand_stock = self.erp_service.get_stock_for_rm_item(rm_erp)
            except Exception:
                pass

        if onhand_stock is None:
            if "onhand_stock" in cs and cs["onhand_stock"] is not None:
                try:
                    onhand_stock = float(cs["onhand_stock"])
                except Exception:
                    pass
        if onhand_stock is None:
            onhand_stock = 0.0

        shortfall_sheets = max(0.0, sheets_required - onhand_stock)
        has_rm_shortage = shortfall_sheets > 0 or not cs.get("stock_available", True)

        # Calculate Sheet Weight & Shortfall Weight (Steel density = 7.85 g/cm3)
        unit_weight_kg = 0.0
        if t > 0 and l > 0 and w > 0:
            unit_weight_kg = round((t * l * w * 7.85) / 1_000_000.0, 2)
        else:
            unit_weight_kg = 15.0  # Realistic default estimation

        shortfall_weight_kg = round(shortfall_sheets * unit_weight_kg, 2)
        shortfall_tonnage_mt = round(shortfall_weight_kg / 1000.0, 3)

        # 2. Check MRP Schedule and Monthly Balance
        mrp_target = None
        mrp_balance = None
        is_mrp_found = cs.get("mrp_available", True)
        if self.erp_service and part_no:
            try:
                mrp_res = self.erp_service.get_mrp_bom_for_part(part_no)
                if mrp_res:
                    is_mrp_found = True
                    mrp_target = mrp_res.get("planned_monthly_qty")
                    mrp_balance = mrp_res.get("balance_qty")
            except Exception:
                pass

        has_mrp_violation = not is_mrp_found or not cs.get("mrp_available", True)
        has_quota_violation = not cs.get("remaining_quota_satisfied", True)

        # 3. Compile Failing Constraints
        failing_constraints = []
        if has_rm_shortage:
            failing_constraints.append({
                "id": "rm_stock_shortfall",
                "name": "RM Main Store Stock Shortage",
                "severity": "CRITICAL",
                "icon": "fa-layer-group",
                "details": f"Store has {int(onhand_stock)} sheet(s) on-hand; order requires {int(sheets_required)} sheet(s).",
                "deficit_metric": f"-{int(shortfall_sheets)} Sheets ({shortfall_weight_kg} kg deficit)"
            })

        if has_mrp_violation:
            failing_constraints.append({
                "id": "mrp_missing",
                "name": "MRP Schedule Verification Missing",
                "severity": "WARNING",
                "icon": "fa-calendar-xmark",
                "details": "Part not scheduled in current monthly MRP BOM target. Requires off-cycle clearance.",
                "deficit_metric": "Unbudgeted Run"
            })

        if has_quota_violation:
            failing_constraints.append({
                "id": "quota_exceeded",
                "name": "Monthly Production Quota Exceeded",
                "severity": "WARNING",
                "icon": "fa-chart-line",
                "details": f"Target batch of {target_qty} units exceeds remaining planned balance in MRP schedule.",
                "deficit_metric": f"Exceeds Demand Quota"
            })

        if not mo_data.get("is_standard_layout", True):
            failing_constraints.append({
                "id": "non_standard_layout",
                "name": "Non-Standard CAD Nesting Layout",
                "severity": "INFO",
                "icon": "fa-compass-drafting",
                "details": "Layout requires non-standard raw sheet dimensions. Purchasing must verify procurement spec.",
                "deficit_metric": "Custom Sizing"
            })

        # 4. Search Compatible In-Stock Material Substitution (> 0 Sheets Only!)
        viable_substitute = None
        if self.rm_advisor and part_no:
            try:
                alt_analysis = self.rm_advisor.analyze_rm_shortage_and_suggest(
                    part_no=part_no,
                    current_rm=rm_erp,
                    target_qty=target_qty,
                    sheets_needed=int(sheets_required),
                    thickness=t,
                    grade=grade,
                    current_onhand=onhand_stock
                )
                recs = alt_analysis.get("recommendations", [])
                # Strictly filter for positive stock
                in_stock_recs = [
                    r for r in recs 
                    if float(r.get("onhand_stock") or r.get("available_qty") or 0.0) > 0
                ]
                if in_stock_recs:
                    best_alt = in_stock_recs[0]
                    alt_avail = float(best_alt.get("onhand_stock") or best_alt.get("available_qty") or 0.0)
                    viable_substitute = {
                        "rm_erp": best_alt.get("rm_erp"),
                        "type": best_alt.get("type"),
                        "tier_label": best_alt.get("tier_label"),
                        "onhand_stock": alt_avail,
                        "yield_pct": best_alt.get("yield_pct"),
                        "is_sufficient": alt_avail >= sheets_required,
                        "reason": best_alt.get("reason"),
                        "lead_time_days_saved": 5
                    }
            except Exception as e:
                print(f"[Purchase Advisor] Alt RM search error: {e}")

        # 5. Calculate Procurement Requisition Quantities
        # Standard PO bundle sizing: round up to nearest multiple of 5 or minimum 10 sheets
        recommended_po_sheets = max(5, int(math.ceil(shortfall_sheets / 5.0) * 5)) if shortfall_sheets > 0 else 0
        recommended_po_weight_kg = round(recommended_po_sheets * unit_weight_kg, 2)
        recommended_po_tonnage_mt = round(recommended_po_weight_kg / 1000.0, 3)

        # 6. Formulate Executive Purchase Decisions
        decision_code = "APPROVE_PO_REQUISITION"
        decision_title = f"Authorize Coil PO for {recommended_po_sheets} Sheets ({recommended_po_weight_kg} kg) {grade}"
        est_lead_time = "3 to 5 Business Days"

        # Check if partial shearing is viable
        partial_shearing_viable = onhand_stock > 0 and shortfall_sheets > 0

        # LLM Synthesis via Google Gemini
        llm_verdict = self._synthesize_llm_decision(
            mo_number=mo_number,
            part_no=part_no,
            rm_erp=rm_erp,
            grade=grade,
            dims=(t, l, w),
            sheets_required=sheets_required,
            onhand_stock=onhand_stock,
            shortfall_sheets=shortfall_sheets,
            shortfall_weight_kg=shortfall_weight_kg,
            recommended_po_sheets=recommended_po_sheets,
            viable_substitute=viable_substitute,
            failing_constraints=failing_constraints
        )

        # Pre-generate Formatted Approval Remarks for Purchase Officer
        remarks_po = (
            f"[Purchase AI Clearance] Authorized procurement requisition for {recommended_po_sheets} sheets "
            f"({recommended_po_weight_kg} kg, {recommended_po_tonnage_mt} MT) of RM '{rm_erp}' ({grade}, {t}*{int(l)}*{int(w)} mm) "
            f"to resolve {int(shortfall_sheets)}-sheet store shortage for {mo_number}. Lead time: {est_lead_time}."
        )

        remarks_substitute = None
        if viable_substitute:
            remarks_substitute = (
                f"[Purchase AI Clearance] Zero-delay in-store substitution authorized: Cleared Shearing to consume "
                f"{int(sheets_required)} sheets of in-stock '{viable_substitute['rm_erp']}' "
                f"({int(viable_substitute['onhand_stock'])} sheets on hand, {viable_substitute.get('yield_pct', 0)}% yield). "
                f"Saves {viable_substitute.get('lead_time_days_saved', 5)} days supplier lead time."
            )

        remarks_partial = None
        if partial_shearing_viable:
            remarks_partial = (
                f"[Purchase AI Clearance] Split run authorized: Shearing cleared to cut existing {int(onhand_stock)} on-hand sheet(s) "
                f"immediately. Expedited PO logged for balance {int(shortfall_sheets)} sheet(s) ({shortfall_weight_kg} kg)."
            )

        return {
            "status": "success",
            "mo_number": mo_number,
            "part_no": part_no,
            "base_part": base_part,
            "rm_erp": rm_erp,
            "grade": grade,
            "dimensions": {"thickness": t, "length": l, "width": w},
            "has_failing_constraints": len(failing_constraints) > 0,
            "failing_constraints_count": len(failing_constraints),
            "failing_constraints": failing_constraints,
            "metrics": {
                "sheets_required": int(sheets_required),
                "onhand_stock": int(onhand_stock),
                "shortfall_sheets": int(shortfall_sheets),
                "unit_sheet_weight_kg": unit_weight_kg,
                "shortfall_weight_kg": shortfall_weight_kg,
                "shortfall_tonnage_mt": shortfall_tonnage_mt,
                "recommended_po_sheets": recommended_po_sheets,
                "recommended_po_weight_kg": recommended_po_weight_kg,
                "recommended_po_tonnage_mt": recommended_po_tonnage_mt,
                "est_lead_time": est_lead_time
            },
            "viable_substitute": viable_substitute,
            "decision": {
                "decision_code": decision_code,
                "decision_title": decision_title,
                "executive_summary": llm_verdict["summary"],
                "action_strategy": llm_verdict["action_strategy"],
                "powered_by": llm_verdict["powered_by"],
                "recommended_remarks_po": remarks_po,
                "recommended_remarks_substitute": remarks_substitute,
                "recommended_remarks_partial": remarks_partial
            }
        }

    def _synthesize_llm_decision(
        self,
        mo_number: str,
        part_no: str,
        rm_erp: str,
        grade: str,
        dims: Tuple[float, float, float],
        sheets_required: float,
        onhand_stock: float,
        shortfall_sheets: float,
        shortfall_weight_kg: float,
        recommended_po_sheets: int,
        viable_substitute: Optional[Dict[str, Any]],
        failing_constraints: List[Dict[str, Any]]
    ) -> Dict[str, str]:
        """Synthesizes executive procurement reasoning using Google Gemini with deterministic fallback."""
        t, l, w = dims
        gemini_key = os.getenv("GEMINI_API_KEY")

        if gemini_key:
            constraints_summary = "; ".join([f"{c['name']} ({c['deficit_metric']})" for c in failing_constraints])
            sub_info = "None available with positive stock"
            if viable_substitute:
                sub_info = (
                    f"In-Stock RM '{viable_substitute['rm_erp']}' has {viable_substitute['onhand_stock']} sheets "
                    f"({viable_substitute.get('yield_pct', 0)}% yield, saves 5 days lead time)"
                )

            prompt = (
                f"You are the Chief Procurement Officer & AI Supply Chain Director at SheetLayout AI.\n"
                f"A Material Order has been routed to the Purchase Team due to failing manufacturing constraints:\n"
                f"• Order: {mo_number} | Part: {part_no}\n"
                f"• Raw Material: {rm_erp} (Grade: {grade}, Size: {t}*{int(l)}*{int(w)} mm)\n"
                f"• Required Sheets: {int(sheets_required)} | Current Store Stock: {int(onhand_stock)} sheets\n"
                f"• Stock Shortfall: {int(shortfall_sheets)} sheets ({shortfall_weight_kg} kg deficit)\n"
                f"• Failing Constraints: {constraints_summary}\n"
                f"• Store Substitute Option: {sub_info}\n\n"
                f"Task:\n"
                f"1. Provide a 2-sentence Executive Procurement Verdict for the Purchase signoff.\n"
                f"2. State the recommended strategic action (e.g. approve immediate PO requisition of {recommended_po_sheets} sheets, or authorize in-store substitution to prevent line downtime).\n"
                f"STRICT RULE: Only suggest substitutes with positive on-hand stock (> 0 sheets). Never suggest 0 stock items.\n"
                f"Respond in format:\n"
                f"SUMMARY: <2 sentences summary>\n"
                f"STRATEGY: <1 sentence actionable strategy>"
            )

            models_to_try = ["gemini-3.8-flash", "gemini-flash-lite-latest"]
            payload = {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.2, "maxOutputTokens": 200}
            }

            for model_name in models_to_try:
                try:
                    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={gemini_key}"
                    req = urllib.request.Request(
                        url,
                        data=json.dumps(payload).encode("utf-8"),
                        headers={"Content-Type": "application/json"}
                    )
                    with urllib.request.urlopen(req, timeout=8) as resp:
                        res_data = json.loads(resp.read().decode("utf-8"))
                        llm_text = res_data["candidates"][0]["content"]["parts"][0]["text"].strip()
                        summary_part = ""
                        strategy_part = ""
                        for line in llm_text.splitlines():
                            if line.startswith("SUMMARY:"):
                                summary_part = line.replace("SUMMARY:", "").strip()
                            elif line.startswith("STRATEGY:"):
                                strategy_part = line.replace("STRATEGY:", "").strip()
                        if not summary_part:
                            summary_part = llm_text
                        if not strategy_part:
                            strategy_part = f"Authorize PO requisition of {recommended_po_sheets} sheets ({grade}) to fulfill production demand."
                        return {
                            "summary": summary_part,
                            "action_strategy": strategy_part,
                            "powered_by": f"Gemini ({model_name})"
                        }
                except Exception:
                    continue

        # Deterministic fallback
        if viable_substitute and viable_substitute.get("is_sufficient"):
            summary = (
                f"Immediate Clearance Opportunity: While primary RM '{rm_erp}' is short by {int(shortfall_sheets)} sheets, "
                f"compatible RM '{viable_substitute['rm_erp']}' is confirmed in stock ({int(viable_substitute['onhand_stock'])} sheets). "
                f"Authorizing substitution eliminates 5 days of supplier lead time with 0 downtime."
            )
            strategy = f"Authorize immediate RM substitution with '{viable_substitute['rm_erp']}' and advance order to ERP."
        elif shortfall_sheets > 0:
            summary = (
                f"Procurement Shortfall Detected: Order requires {int(sheets_required)} sheets of '{rm_erp}' but store holds "
                f"only {int(onhand_stock)} sheet(s), leaving a {int(shortfall_sheets)}-sheet ({shortfall_weight_kg} kg) deficit. "
                f"Standard bundle order of {recommended_po_sheets} sheets is recommended to satisfy production and buffer safety stock."
            )
            strategy = f"Raise PO requisition for {recommended_po_sheets} sheets ({shortfall_weight_kg} kg) of {grade} coil with standard 3-5 day lead time."
        else:
            summary = (
                f"Constraint Verification Review: Raw material inventory is satisfied, but order requires Purchase authorization "
                f"for layout or MRP schedule compliance before ERP release."
            )
            strategy = "Sign off on off-cycle production clearance and advance order to ERP Gateway."

        return {
            "summary": summary,
            "action_strategy": strategy,
            "powered_by": "Rule-Based Procurement Engine"
        }
