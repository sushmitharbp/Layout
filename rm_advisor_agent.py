"""
SheetLayout AI — LangGraph RM Advisor Agent
Orchestrates an autonomous multi-node StateGraph powered by LangGraph and Google Gemini:

Graph Topology:
  START
    |
  [inspect_inventory_node]
    |
  (decide_shortage_edge)
    |---> (Shortage: True)  ---> [mine_alternatives_node] ---> [rank_candidates_node] ---> [llm_reasoning_node] ---> END
    |---> (Shortage: False) --------------------------------------------------------> [llm_reasoning_node] ---> END

Nodes:
1. inspect_inventory_node: Verifies on-hand inventory constraints & extracts part blank geometries.
2. mine_alternatives_node: Executes deterministic manufacturing tools:
   - Tool A: Alternative CAD Layout Miner (e.g., 2nd-choice standardized layouts).
   - Tool B: Raw Material Sheet Geometric Nesting Simulator.
   - Tool C: Store Offcut Salvage Hunter (zero fresh sheet scrap recovery).
3. rank_candidates_node: Mathematically scores & ranks substitution options by stock feasibility & yield.
4. llm_reasoning_node: Invokes Google Gemini LLM (gemini-3.8-flash) to evaluate production trade-offs
   and synthesize an executive manufacturing engineering verdict.
"""

import os
import re
import math
import json
import urllib.request
import urllib.error
from typing import TypedDict, List, Dict, Any, Optional, Tuple

from dotenv import load_dotenv

try:
    from langgraph.graph import StateGraph, START, END  # type: ignore
    HAS_LANGGRAPH = True
except (ImportError, ModuleNotFoundError):
    StateGraph, START, END = None, None, None
    HAS_LANGGRAPH = False

load_dotenv()


def norm_key(s):
    if not s:
        return ""
    return re.sub(r'[^a-zA-Z0-9]', '', str(s)).lower()


def parse_rm_dims(text: str, fallback_t: float = 0.0) -> Tuple[float, float, float]:
    """
    Extracts (thickness, length, width) where length >= width from RM descriptions, codes, or specs.
    Handles formats such as:
      - '3.8*2500*1500'
      - '3.8*2500*1500 (BSK)'
      - 'BSK-3.8-3420-1500'
      - 'SHEET BSK-3.8-3420-1500'
      - 'SHEET-BSK 46-3.8-2500-1500'
      - 'SHEET YS-3.8-2500-1250'
      - '2500*1500' (with fallback_t)
    """
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


def canonical_rm_key(text: str, fallback_t: float = 0.0) -> str:
    t, l, w = parse_rm_dims(text, fallback_t)
    if l > 0 and w > 0:
        return f"{t:g}*{int(l)}*{int(w)}"
    return norm_key(text)


def extract_rm_grade(text: str) -> str:
    """
    Extracts and standardizes the metallurgical steel grade family
    (e.g., 'BSK', 'YS', 'CR', 'HR', 'SAPH', 'SS', 'MS', 'ALU').
    """
    if not text:
        return ""
    t = str(text).upper()
    for g in ["BSK", "YS", "CR", "HR", "SAPH", "SAP", "ALU", "AL", "SS", "MS"]:
        if g in t:
            return g
    clean = re.sub(r'[^A-Z0-9]', '', t)
    return clean


# =========================================================================
# LangGraph Agent State Definition
# =========================================================================
class RMAdvisorState(TypedDict):
    part_no: str
    current_rm: str
    target_qty: int
    sheets_needed: int
    thickness: Optional[float]
    grade: Optional[str]
    current_onhand: Optional[float]
    shortfall: int
    has_shortage: bool
    cut_length: float
    cut_width: float
    candidate_layouts: List[Dict[str, Any]]
    candidate_sheets: List[Dict[str, Any]]
    candidate_endbits: List[Dict[str, Any]]
    ranked_alternatives: List[Dict[str, Any]]
    llm_verdict: str
    llm_powered_by: str


class RMAdvisorAgent:
    def __init__(self, data_store=None, erp_service=None, endbits_store_file="data_endbits_store.json"):
        self.data_store = data_store or {}
        self.erp_service = erp_service
        self.endbits_store_file = endbits_store_file
        self.graph = self._build_langgraph()

    def set_services(self, data_store=None, erp_service=None):
        if data_store is not None:
            self.data_store = data_store
        if erp_service is not None:
            self.erp_service = erp_service

    def _load_endbits(self):
        if os.path.exists(self.endbits_store_file):
            try:
                with open(self.endbits_store_file, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
        return []

    def _extract_blank_dims(self, record):
        if not record:
            return 0.0, 0.0, 0.0
        part1 = record.get("part1") or {}
        blank_size = part1.get("blank_size") or {}
        l = float(blank_size.get("length") or 0.0)
        w = float(blank_size.get("width") or 0.0)
        t = float(blank_size.get("thickness") or record.get("thickness") or 0.0)

        if (l == 0 or w == 0) and record.get("cut_blank"):
            parts = [float(x) for x in re.findall(r'\d+(?:\.\d+)?', str(record.get("cut_blank")))]
            if len(parts) >= 3:
                l, w, t = parts[0], parts[1], parts[2]
            elif len(parts) == 2:
                l, w = parts[0], parts[1]

        return l, w, t

    # =========================================================================
    # LangGraph Nodes
    # =========================================================================

    def _node_inspect_inventory(self, state: RMAdvisorState) -> Dict[str, Any]:
        """Node 1: Inspects raw material inventory and identifies part geometry."""
        current_rm = state["current_rm"]
        part_no = state["part_no"]
        grade = state.get("grade")
        thickness = state.get("thickness")
        sheets_needed = state["sheets_needed"]

        # 1. Query ERP onhand stock
        onhand = state.get("current_onhand")
        if (onhand is None or onhand < 0) and self.erp_service:
            cur_st = self.erp_service.get_rm_opening_stock(current_rm, grade=grade, thickness=thickness)
            onhand = float(cur_st.get("onhand_stock") or 0.0) if cur_st else 0.0
        else:
            onhand = float(onhand or 0.0)

        has_shortage = onhand < sheets_needed
        shortfall = max(0, sheets_needed - int(onhand))

        t_val = float(thickness or 0.0)
        if (t_val == 0.0 or not t_val) and current_rm:
            rm_t, _, _ = parse_rm_dims(current_rm)
            if rm_t > 0:
                t_val = rm_t

        # 2. Extract blank dimensions from CAD records
        parts_dict = self.data_store.get("parts", {})
        part_info = parts_dict.get(part_no) or {}
        part_layouts = list(part_info.get("layouts", []))
        all_recs = self.data_store.get("records", [])
        norm_p = norm_key(part_no)
        if not part_layouts and all_recs:
            part_layouts = [r for r in all_recs if norm_key(r.get("part_no")) == norm_p]

        cut_len, cut_wid = 0.0, 0.0
        for r in part_layouts:
            cl, cw, ct = self._extract_blank_dims(r)
            if cl > 0 and cw > 0:
                cut_len, cut_wid = cl, cw
                if t_val == 0.0:
                    t_val = ct
                break

        # Fallback to related records for base part if cut dimensions not found
        if (cut_len == 0.0 or cut_wid == 0.0) and all_recs:
            base_p = norm_key(part_no.split("-")[0]) if "-" in part_no else norm_p
            for r in all_recs:
                if norm_key(r.get("part_no", "")).startswith(base_p):
                    cl, cw, ct = self._extract_blank_dims(r)
                    if cl > 0 and cw > 0:
                        cut_len, cut_wid = cl, cw
                        if t_val == 0.0:
                            t_val = ct
                        break

        return {
            "current_onhand": onhand,
            "has_shortage": has_shortage,
            "shortfall": shortfall,
            "cut_length": cut_len,
            "cut_width": cut_wid,
            "thickness": t_val
        }

    def _edge_decide_shortage(self, state: RMAdvisorState) -> str:
        """Conditional routing: route to alternative mining if stock is short."""
        return "mine_alternatives" if state["has_shortage"] else "llm_reasoning"

    def _node_mine_alternatives(self, state: RMAdvisorState) -> Dict[str, Any]:
        """Node 2: Executes CAD layout, standard sheet nesting, and offcut salvage tools with strict grade and thickness checks."""
        part_no = state["part_no"]
        current_rm = state["current_rm"]
        target_qty = state["target_qty"]
        cut_len = state["cut_length"]
        cut_wid = state["cut_width"]
        t_val = state["thickness"]
        grade_str = str(state.get("grade") or "").strip()
        req_grade = extract_rm_grade(grade_str) or extract_rm_grade(current_rm)

        curr_canon = canonical_rm_key(current_rm, t_val)
        seen_rms = {curr_canon, norm_key(current_rm)}
        if current_rm:
            clean_curr = re.sub(r'\s*\([^)]*\)', '', current_rm).strip()
            seen_rms.add(norm_key(clean_curr))

        # Tool A: CAD Layout Mining (Strict Grade & Thickness Check)
        candidate_layouts = []
        parts_dict = self.data_store.get("parts", {})
        part_info = parts_dict.get(part_no) or {}
        part_layouts = list(part_info.get("layouts", []))
        all_recs = self.data_store.get("records", [])
        norm_p = norm_key(part_no)
        for r in all_recs:
            if norm_key(r.get("part_no")) == norm_p and r not in part_layouts:
                part_layouts.append(r)

        # If few layouts, check related part variants (e.g. Item 2 OS)
        if len(part_layouts) <= 2 and all_recs:
            base_p = norm_key(part_no.split("-")[0]) if "-" in part_no else norm_p
            for r in all_recs:
                rp_norm = norm_key(r.get("part_no", ""))
                if rp_norm.startswith(base_p) and r not in part_layouts:
                    part_layouts.append(r)

        for r in part_layouts:
            rm_code = r.get("rm_erp")
            if not rm_code:
                continue

            # Strict Grade Check: Must match part grade
            layout_grade = extract_rm_grade(r.get("grade") or rm_code)
            if req_grade and layout_grade and req_grade != layout_grade:
                continue

            # Strict Thickness Check: Must match part thickness
            layout_t = float(r.get("thickness") or 0.0)
            if t_val > 0 and layout_t > 0 and abs(layout_t - t_val) > 0.05:
                continue

            r_canon = canonical_rm_key(rm_code, layout_t or t_val)
            if r_canon in seen_rms or norm_key(rm_code) in seen_rms:
                continue
            seen_rms.add(r_canon)
            seen_rms.add(norm_key(rm_code))

            st = None
            if self.erp_service:
                st = self.erp_service.get_rm_opening_stock(
                    rm_code,
                    grade=r.get("grade") or req_grade or grade_str,
                    thickness=layout_t or t_val
                )

            onhand = float(st.get("onhand_stock") or 0.0) if st else 0.0
            display_grade = layout_grade or req_grade or grade_str
            item_desc = (st.get("item_desc") or f"{rm_code} ({display_grade})") if st else rm_code

            part1 = r.get("part1") or {}
            parts_per_sheet = float(part1.get("total_blank_qty_sheet") or r.get("per_sheet", {}).get("parts_produced") or 1.0)
            if parts_per_sheet <= 0:
                parts_per_sheet = 1.0

            alt_sheets_needed = math.ceil(target_qty / parts_per_sheet)
            yield_val = float(r.get("per_sheet", {}).get("yield_pct") or 0.0)
            if yield_val == 0 and cut_len > 0 and cut_wid > 0:
                s_len = float(r.get("length") or 0.0)
                s_wid = float(r.get("width") or 0.0)
                if s_len > 0 and s_wid > 0:
                    yield_val = round(((cut_len * cut_wid * parts_per_sheet) / (s_len * s_wid)) * 100, 1)

            is_sufficient = onhand >= alt_sheets_needed
            status_tag = r.get("status") or ("2nd Choice" if "2ndchoice" in (r.get("layout_name") or "").lower() else "Alternative Layout")
            score = 1000 + yield_val + (onhand * 2) if is_sufficient else (200 + onhand * 5)

            reason = (
                f"Verified {status_tag} CAD Layout '{r.get('layout_name', 'Standard')}' [Grade {display_grade}]. "
                f"Store has {int(onhand):,} sheets (requires {alt_sheets_needed}). "
                f"Produces {int(parts_per_sheet)} blanks/sheet with {yield_val}% yield."
            )

            candidate_layouts.append({
                "type": "engineered_layout",
                "tier": 1,
                "tier_label": "Verified CAD Layout",
                "rm_erp": rm_code,
                "item_desc": item_desc,
                "layout_name": r.get("layout_name", ""),
                "status": status_tag,
                "grade": display_grade,
                "thickness": float(layout_t or t_val or 0.0),
                "length": float(r.get("length") or 0.0),
                "width": float(r.get("width") or 0.0),
                "parts_per_sheet": int(parts_per_sheet),
                "sheets_needed": alt_sheets_needed,
                "onhand_stock": onhand,
                "yield_pct": yield_val,
                "stock_sufficient": is_sufficient,
                "score": score,
                "reason": reason,
                "action_payload": {
                    "rm_erp": rm_code,
                    "layout_name": r.get("layout_name", ""),
                    "thickness": float(layout_t or t_val or 0.0),
                    "length": float(r.get("length") or 0.0),
                    "width": float(r.get("width") or 0.0),
                    "grade": display_grade,
                    "yield_pct": yield_val,
                    "sheets_required": alt_sheets_needed,
                    "target_qty": target_qty
                }
            })

        # Tool B: Stock Sheet Geometric Nesting Simulation (Strict Grade & Thickness Check)
        candidate_sheets = []
        if self.erp_service and hasattr(self.erp_service, "rm_stock_list"):
            for s in self.erp_service.rm_stock_list:
                s_onhand = float(s.get("onhand_stock") or 0.0)
                if s_onhand <= 0:
                    continue

                desc = s.get("item_desc", "")
                code = s.get("item_code", "")
                full_text = f"{desc} {code}".upper()

                # Strict Grade Check: Must match part grade!
                item_grade = extract_rm_grade(full_text)
                if req_grade and item_grade and req_grade != item_grade:
                    continue
                if req_grade and not item_grade:
                    continue

                # Strict Thickness Check: Must match part thickness!
                s_th, s_len, s_wid = parse_rm_dims(full_text, fallback_t=t_val)
                if t_val > 0 and abs(s_th - t_val) > 0.05:
                    continue
                if s_len < 400 or s_wid < 300 or s_len > 6000 or s_wid > 3500:
                    continue

                s_canon = f"{s_th:g}*{int(s_len)}*{int(s_wid)}"
                if s_canon in seen_rms or norm_key(code) in seen_rms or norm_key(desc) in seen_rms:
                    continue
                seen_rms.add(s_canon)
                seen_rms.add(norm_key(code))
                seen_rms.add(norm_key(desc))

                display_grade = item_grade or req_grade or grade_str
                grade_label = f"Grade {display_grade}"

                parts_fit = 1
                sim_yield = 75.0
                if cut_len > 0 and cut_wid > 0:
                    n1 = math.floor(s_len / cut_len) * math.floor(s_wid / cut_wid)
                    n2 = math.floor(s_len / cut_wid) * math.floor(s_wid / cut_len)
                    parts_fit = max(1, max(n1, n2))
                    sheet_area = s_len * s_wid
                    blank_area = cut_len * cut_wid
                    sim_yield = min(98.0, round(((parts_fit * blank_area) / sheet_area) * 100, 1))

                req_sheets = math.ceil(target_qty / parts_fit)
                is_suff = s_onhand >= req_sheets
                score = 850 + sim_yield + (s_onhand * 1.5) if is_suff else (150 + s_onhand)

                status_tag = f"In-Stock Sheet [{grade_label}]"
                reason = (
                    f"In-Stock RM Sheet '{desc}' [{grade_label}] has {int(s_onhand):,} sheets on hand. "
                    f"Nesting fits ~{parts_fit} blanks/sheet with estimated {sim_yield}% yield (requires {req_sheets} sheet(s))."
                )

                rm_display = f"{s_canon} ({display_grade})"
                candidate_sheets.append({
                    "type": "stock_sheet",
                    "tier": 2,
                    "tier_label": "Stock Available RM Sheet",
                    "rm_erp": rm_display,
                    "item_code": code,
                    "item_desc": desc,
                    "layout_name": f"Fit-{s_canon}",
                    "status": status_tag,
                    "grade": display_grade,
                    "thickness": s_th or t_val,
                    "length": s_len,
                    "width": s_wid,
                    "parts_per_sheet": parts_fit,
                    "sheets_needed": req_sheets,
                    "onhand_stock": s_onhand,
                    "yield_pct": sim_yield,
                    "stock_sufficient": is_suff,
                    "score": score,
                    "reason": reason,
                    "action_payload": {
                        "rm_erp": rm_display,
                        "layout_name": f"Simulated-{s_canon}",
                        "thickness": s_th or t_val,
                        "length": s_len,
                        "width": s_wid,
                        "grade": display_grade,
                        "yield_pct": sim_yield,
                        "sheets_required": req_sheets,
                        "target_qty": target_qty
                    }
                })

        # Tool C: Store Offcut Salvage Hunter
        candidate_endbits = []
        endbits = self._load_endbits()
        for eb in endbits:
            avail = int(eb.get("available_qty") or 0)
            if avail <= 0:
                continue

            # Strict Grade Check
            eb_grade = extract_rm_grade(eb.get("grade") or eb.get("name") or "")
            if req_grade and eb_grade and req_grade != eb_grade:
                continue

            # Strict Thickness Check
            eb_t = float(eb.get("thickness") or 0.0)
            if t_val > 0 and abs(eb_t - t_val) > 0.05:
                continue

            eb_l = float(eb.get("length") or 0.0)
            eb_w = float(eb.get("width") or 0.0)

            can_cut = False
            blanks_per_eb = 1
            if cut_len > 0 and cut_wid > 0:
                n1 = math.floor(eb_l / cut_len) * math.floor(eb_w / cut_wid)
                n2 = math.floor(eb_l / cut_wid) * math.floor(eb_w / cut_len)
                blanks_per_eb = max(n1, n2)
                can_cut = blanks_per_eb >= 1
            else:
                can_cut = (eb_l >= 200 and eb_w >= 50)

            if can_cut:
                total_producible = blanks_per_eb * avail
                dim_str = eb.get("dimensions") or f"{eb_t}*{eb_l}*{eb_w}"
                score = 500 + min(500, total_producible * 20)
                reason = (
                    f"Store Offcut [{eb.get('name', 'End bit')}] {eb.get('endbit_id')} ({dim_str} mm). "
                    f"{avail} offcut(s) in store can harvest up to {total_producible} blanks with ZERO raw material sheets needed."
                )

                candidate_endbits.append({
                    "type": "endbit_salvage",
                    "tier": 3,
                    "tier_label": "Store Offcut Salvage",
                    "endbit_id": eb.get("endbit_id"),
                    "endbit_name": eb.get("name", "End bit"),
                    "rm_erp": f"EndBit: {dim_str}",
                    "item_desc": f"End Bit Offcut {eb.get('endbit_id')} ({dim_str} mm)",
                    "thickness": eb_t,
                    "length": eb_l,
                    "width": eb_w,
                    "onhand_stock": avail,
                    "parts_producible": total_producible,
                    "yield_pct": 92.0,
                    "stock_sufficient": total_producible >= target_qty,
                    "score": score,
                    "reason": reason,
                    "action_payload": {
                        "is_endbit": True,
                        "endbit_id": eb.get("endbit_id"),
                        "endbit_name": eb.get("name", "End bit"),
                        "thickness": eb_t,
                        "length": eb_l,
                        "width": eb_w,
                        "dim_str": dim_str
                    }
                })

        return {
            "candidate_layouts": candidate_layouts,
            "candidate_sheets": candidate_sheets,
            "candidate_endbits": candidate_endbits
        }

    def _node_rank_candidates(self, state: RMAdvisorState) -> Dict[str, Any]:
        """Node 3: Aggregates and mathematically ranks candidate substitutions."""
        all_alts = (
            state.get("candidate_layouts", []) +
            state.get("candidate_sheets", []) +
            state.get("candidate_endbits", [])
        )
        all_alts.sort(key=lambda x: (1 if x["stock_sufficient"] else 0, x["score"]), reverse=True)

        for idx, alt in enumerate(all_alts):
            alt["rank"] = idx + 1

        return {
            "ranked_alternatives": all_alts[:6]
        }

    def _node_llm_reasoning(self, state: RMAdvisorState) -> Dict[str, Any]:
        """Node 4: Uses Gemini LLM to synthesize an executive manufacturing engineering verdict."""
        has_shortage = state.get("has_shortage", False)
        current_rm = state.get("current_rm", "")
        current_onhand = state.get("current_onhand", 0.0)
        shortfall = state.get("shortfall", 0)
        ranked = state.get("ranked_alternatives", [])
        part_no = state.get("part_no", "")
        target_qty = state.get("target_qty", 1)

        if not has_shortage:
            verdict = f"RM Stock '{current_rm}' is fully sufficient ({int(current_onhand)} sheets available). Fast-track routing to ERP release recommended."
            return {"llm_verdict": verdict, "llm_powered_by": "LangGraph Guardrail"}

        gemini_key = os.getenv("GEMINI_API_KEY")
        if gemini_key and ranked:
            # Prepare compact prompt for Gemini
            top_recs_summary = []
            for r in ranked[:3]:
                top_recs_summary.append(
                    f"- Option {r['rank']} ({r['tier_label']}): RM '{r['rm_erp']}' | Store Stock: {r['onhand_stock']} | Output: {r.get('parts_per_sheet', 1)} blanks/sheet | Yield: {r.get('yield_pct', 0)}% | Sufficient: {r['stock_sufficient']}"
                )
            recs_text = "\n".join(top_recs_summary)

            prompt = (
                f"You are the Chief Manufacturing & Nesting Engineer at SheetLayout AI.\n"
                f"Production Shortage Detected:\n"
                f"• Part: {part_no} (Target Order Qty: {target_qty} units)\n"
                f"• Requested RM: {current_rm} has ONLY {int(current_onhand)} sheets in store (Shortfall: {shortfall} sheets).\n\n"
                f"Verified In-Stock Substitution Candidates:\n{recs_text}\n\n"
                f"Task: In 1 or 2 concise, executive sentences, state the recommended production decision. "
                f"Highlight which RM to switch to, the material yield, and the cost/scrap advantage. Be decisive and professional."
            )

            models_to_try = ["gemini-3.8-flash", "gemini-flash-lite-latest"]
            payload = {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.2, "maxOutputTokens": 250}
            }

            for model_name in models_to_try:
                try:
                    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={gemini_key}"
                    req = urllib.request.Request(
                        url,
                        data=json.dumps(payload).encode("utf-8"),
                        headers={"Content-Type": "application/json"}
                    )
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        res_data = json.loads(resp.read().decode("utf-8"))
                        llm_text = res_data["candidates"][0]["content"]["parts"][0]["text"].strip()
                        if llm_text:
                            return {
                                "llm_verdict": llm_text,
                                "llm_powered_by": f"LangGraph + Gemini ({model_name})"
                            }
                except Exception:
                    continue

        # Deterministic fallback reasoning
        best = ranked[0] if ranked else None
        if best and best["stock_sufficient"]:
            verdict = (
                f"Shortage Alert: Current RM '{current_rm}' is short by {shortfall} sheets. "
                f"Recommended Action: Switch to '{best['rm_erp']}' ({int(best['onhand_stock'])} sheets in store) — {best['reason']}"
            )
        elif best:
            verdict = (
                f"Critical Shortage Alert: Current RM '{current_rm}' is depleted. "
                f"Partial substitution available on '{best['rm_erp']}' ({int(best['onhand_stock'])} sheets), or route to Purchase requisition."
            )
        else:
            verdict = f"Critical Shortage: No compatible sheet stock or CAD layouts found for '{current_rm}'. Route to Purchase Requisition."

        return {
            "llm_verdict": verdict,
            "llm_powered_by": "LangGraph Deterministic Fallback"
        }

    # =========================================================================
    # LangGraph StateGraph Compilation
    # =========================================================================

    def _build_langgraph(self):
        """Constructs and compiles the StateGraph workflow."""
        if not HAS_LANGGRAPH or StateGraph is None:
            return None
        workflow = StateGraph(RMAdvisorState)

        # 1. Add Nodes
        workflow.add_node("inspect_inventory", self._node_inspect_inventory)
        workflow.add_node("mine_alternatives", self._node_mine_alternatives)
        workflow.add_node("rank_candidates", self._node_rank_candidates)
        workflow.add_node("llm_reasoning", self._node_llm_reasoning)

        # 2. Add Edges & Conditional Routing
        workflow.add_edge(START, "inspect_inventory")
        workflow.add_conditional_edges(
            "inspect_inventory",
            self._edge_decide_shortage,
            {
                "mine_alternatives": "mine_alternatives",
                "llm_reasoning": "llm_reasoning"
            }
        )
        workflow.add_edge("mine_alternatives", "rank_candidates")
        workflow.add_edge("rank_candidates", "llm_reasoning")
        workflow.add_edge("llm_reasoning", END)
        return workflow.compile()

    # =========================================================================
    # External Invocation Entrypoint
    # =========================================================================

    def analyze_rm_shortage_and_suggest(
        self,
        part_no: str,
        current_rm: str,
        target_qty: int = 1,
        sheets_needed: int = 1,
        thickness: Optional[float] = None,
        grade: Optional[str] = None,
        current_onhand: Optional[float] = None
    ) -> Dict[str, Any]:
        """
        Executes the LangGraph StateGraph pipeline.
        Returns the final state containing inventory inspection, ranked alternatives, and LLM verdict.
        """
        initial_state: RMAdvisorState = {
            "part_no": part_no or "",
            "current_rm": current_rm or "",
            "target_qty": max(1, int(target_qty or 1)),
            "sheets_needed": max(1, int(sheets_needed or 1)),
            "thickness": float(thickness) if thickness else None,
            "grade": grade or "YS",
            "current_onhand": float(current_onhand) if current_onhand is not None else None,
            "shortfall": 0,
            "has_shortage": False,
            "cut_length": 0.0,
            "cut_width": 0.0,
            "candidate_layouts": [],
            "candidate_sheets": [],
            "candidate_endbits": [],
            "ranked_alternatives": [],
            "llm_verdict": "",
            "llm_powered_by": ""
        }

        # Run through the compiled LangGraph StateGraph or fallback state pipeline
        if self.graph is not None:
            final_state = self.graph.invoke(initial_state)
        else:
            s1 = self._node_inspect_inventory(initial_state)
            initial_state.update(s1)
            if self._edge_decide_shortage(initial_state) == "mine_alternatives":
                s2 = self._node_mine_alternatives(initial_state)
                initial_state.update(s2)
                s3 = self._node_rank_candidates(initial_state)
                initial_state.update(s3)
            s4 = self._node_llm_reasoning(initial_state)
            initial_state.update(s4)
            final_state = initial_state

        return {
            "has_shortage": final_state["has_shortage"],
            "part_no": final_state["part_no"],
            "current_rm": final_state["current_rm"],
            "current_onhand": final_state["current_onhand"],
            "sheets_needed": final_state["sheets_needed"],
            "shortfall": final_state["shortfall"],
            "agent_verdict": final_state["llm_verdict"],
            "powered_by": final_state["llm_powered_by"],
            "total_alternatives_found": len(final_state["ranked_alternatives"]),
            "recommendations": final_state["ranked_alternatives"]
        }
