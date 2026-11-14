"""
SheetLayout AI — Part Co-Production & Yield Optimization Agent
Autonomous Agent that recommends co-production companion parts for sheet metal cutting:
1. 100% Database-Driven Connection (Supabase clean schema v2 via db_clean).
   Zero Excel workbooks or static Excel caches used.
2. Filters parts matching Grade & Thickness of the active sheet directly from public.parts in database.
3. Multi-objective ranking & filtering based on:
   - "Higher Yield": Maximizes composite sheet area utilization (2D OptiCutter engine).
   - "More Quantity to Produce": Parts with high pending deficit/monthly schedule demand from public.mrp.
   - "Less Quantity to Produce": Parts with small pending deficit (quick scrap fillers/small batches).
   - "Recommended": Balanced composite score.
4. Provides Gemini LLM reasoning synthesis with deterministic manufacturing fallback.
"""

import os
import re
import math
import json
import urllib.request
import urllib.error
from typing import Dict, List, Any, Optional

import db_clean as db
from cut_optimizer import CutListOptimizer2D

def norm_str(s: Any) -> str:
    if not s:
        return ""
    return str(s).strip()

def norm_key(s: Any) -> str:
    if not s:
        return ""
    return re.sub(r'[^a-zA-Z0-9]', '', str(s)).lower()


class PartCoProductionAgent:
    def __init__(self, data_store: Optional[Dict[str, Any]] = None, erp_service: Optional[Any] = None):
        """
        Pure Database-Driven Agent.
        Legacy arguments data_store and erp_service are accepted for backwards compatibility
        but bypassed in favor of live Supabase PostgreSQL database tables.
        """
        self.data_store = data_store
        self.erp_service = erp_service
        self.gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
        self.optimizer = CutListOptimizer2D()

    def suggest_parts(
        self,
        base_part_no: str,
        sheet_length: float,
        sheet_width: float,
        grade: Optional[str] = None,
        thickness: Optional[float] = None,
        base_blanks_qty: Optional[int] = None,
        current_parts: Optional[List[str]] = None,
        filter_mode: str = "all",  # 'all', 'more_qty', 'less_qty', 'max_yield', 'low_stock'
        base_blank_length: Optional[float] = None,
        base_blank_width: Optional[float] = None,
        existing_parts: Optional[List[Dict[str, Any]]] = None,
        company_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Suggests companion parts to manufacture together on the same sheet.
        Prioritization criteria:
        - Grade & Thickness match (from database parts master)
        - Higher Yield (OptiCutter 2D simulation)
        - Strict Base Part Preservation: Base part blanks are placed first with 100% of required quantity.
          Companion parts are advised strictly for the remaining space excluding the base part!
        - More Quantity to Produce vs Less Quantity to Produce (from database MRP table)
        """
        base_part_no = norm_str(base_part_no)
        if not base_part_no:
            return {
                "success": False,
                "error": "No base part provided",
                "recommendations": []
            }

        current_parts = [norm_str(p) for p in (current_parts or []) if norm_str(p)]
        if base_part_no not in current_parts:
            current_parts.append(base_part_no)

        # 1. Fetch base part details directly from Supabase database or caller parameters
        base_part_data = self._get_part_data(base_part_no, company_id=company_id)
        part_grade = norm_str(grade or base_part_data.get("grade") or "HR").upper()
        try:
            part_thick = float(thickness if thickness is not None else (base_part_data.get("thickness") or 1.0))
        except (ValueError, TypeError):
            part_thick = 1.0

        b_len = float(base_blank_length or 0.0)
        b_wid = float(base_blank_width or 0.0)
        if b_len <= 0 or b_wid <= 0:
            b_len = float(base_part_data.get("length") or 0.0)
            b_wid = float(base_part_data.get("width") or 0.0)

        s_len = max(float(sheet_length or 2500.0), float(sheet_width or 1250.0))
        s_wid = min(float(sheet_length or 2500.0), float(sheet_width or 1250.0))

        # Physical boundary check for base part on this sheet
        b_max = max(b_len, b_wid)
        b_min = min(b_len, b_wid)
        s_max = max(s_len, s_wid)
        s_min = min(s_len, s_wid)
        if b_max > s_max or b_min > s_min:
            return {
                "success": False,
                "error": f"Base part {base_part_no} ({b_max:g}×{b_min:g} mm) exceeds sheet dimensions ({s_max:g}×{s_min:g} mm). Please select a fitting RM sheet first.",
                "recommendations": []
            }

        # 2. Compute Baseline Single-Part Yield
        baseline_yield = 0.0
        max_base_blanks = 1
        if b_len > 0 and b_wid > 0:
            baseline_result = self.optimizer.optimize_nesting(
                sheet_length=s_len,
                sheet_width=s_wid,
                blank_length=b_len,
                blank_width=b_wid,
                part_no=base_part_no,
                can_rotate=True
            )
            baseline_yield = float(baseline_result.get("yield_pct", 0.0))
            max_base_blanks = int(baseline_result.get("total_blanks", 0))

        if max_base_blanks < 1:
            return {
                "success": False,
                "error": f"Base part {base_part_no} cannot fit on sheet {s_len:g}×{s_wid:g} mm.",
                "recommendations": []
            }

        actual_base_blanks = int(base_blanks_qty) if base_blanks_qty and int(base_blanks_qty) > 0 else max_base_blanks
        actual_base_blanks = min(actual_base_blanks, max_base_blanks)

        # Locked parts list: Base part must have 100% of its required blanks preserved!
        test_base_qty = actual_base_blanks
        locked_parts = [{"part_no": base_part_no, "length": b_len, "width": b_wid, "qty": test_base_qty}]
        locked_area = test_base_qty * (b_len * b_wid)

        if existing_parts and isinstance(existing_parts, list):
            for ep in existing_parts:
                ep_no = str(ep.get("part_no") or "").strip()
                if not ep_no or ep_no == base_part_no:
                    continue
                ep_l = float(ep.get("length") or 0.0)
                ep_w = float(ep.get("width") or 0.0)
                ep_q = max(1, int(ep.get("qty") or 1))
                if ep_l > 0 and ep_w > 0:
                    locked_parts.append({"part_no": ep_no, "length": ep_l, "width": ep_w, "qty": ep_q})
                    locked_area += (ep_l * ep_w * ep_q)
                    if ep_no not in current_parts:
                        current_parts.append(ep_no)

        sheet_area = s_len * s_wid
        remaining_area = max(0.0, sheet_area - locked_area)

        # 3. Retrieve Candidate Parts with matching Grade & Thickness directly from Supabase database scoped to company
        candidates_raw = self._find_matching_candidates(
            target_grade=part_grade,
            target_thickness=part_thick,
            exclude_parts=current_parts,
            sheet_len=s_len,
            sheet_wid=s_wid,
            company_id=company_id
        )

        # Batch fetch MRP & Stock details from Supabase database scoped to company
        candidate_part_nos = [cand["part_no"] for cand in candidates_raw]
        mrp_batch_map = db.get_mrp_for_parts_batch(candidate_part_nos, company_id=company_id)

        # 4. Evaluate MRP demand and run 2D Combo Nesting in the REMAINING space excluding the base part
        scored_candidates = []
        for cand in candidates_raw:
            c_no = cand["part_no"]
            c_len = cand["length"]
            c_wid = cand["width"]
            c_grade = cand["grade"]
            c_thick = cand["thickness"]

            # MRP & Stock details directly from database
            mrp_info = mrp_batch_map.get(c_no) or {}
            mrp_target = int(mrp_info.get("monthly_schedule") or 0)
            cur_stock = int(mrp_info.get("current_stock") or 0)
            qty_to_prod = int(mrp_info.get("qty_to_produce") or 0)

            # Categorize Stock / Demand Status
            if cur_stock == 0 and mrp_target > 0:
                stock_status = "CRITICAL_ZERO"
                stock_label = "0 Stock (Urgent)"
            elif qty_to_prod >= 100 or (mrp_target > 0 and cur_stock < (0.25 * mrp_target)):
                stock_status = "HIGH_DEMAND"
                stock_label = f"High Demand ({qty_to_prod} to produce)"
            elif 0 < qty_to_prod < 50:
                stock_status = "SMALL_BATCH"
                stock_label = f"Small Batch ({qty_to_prod} to produce)"
            elif qty_to_prod > 0:
                stock_status = "ACTIVE_NEED"
                stock_label = f"Active Need ({qty_to_prod} to produce)"
            else:
                stock_status = "HEALTHY"
                stock_label = f"Stock Safe ({cur_stock} in hand)"

            # Estimate candidate blanks to test in the remaining space excluding the base part
            cand_area = c_len * c_wid
            if cand_area <= 0:
                continue
            test_cand_qty = max(1, min(60, int(remaining_area / cand_area))) if remaining_area > 0 else 2

            # Simulate Multi-Part Nesting: Base part + existing parts placed first!
            test_parts = list(locked_parts) + [
                {"part_no": c_no, "length": c_len, "width": c_wid, "qty": test_cand_qty}
            ]

            combo_nest = self.optimizer.optimize_nesting(
                sheet_length=s_len,
                sheet_width=s_wid,
                parts=test_parts
            )

            comb_yield = float(combo_nest.get("yield_pct", 0.0))
            placed_parts = combo_nest.get("parts_summary", [])
            base_placed = 0
            cand_placed = 0
            for ps in placed_parts:
                if ps.get("part_no") == base_part_no:
                    base_placed = int(ps.get("placed_qty") or ps.get("blanks_placed") or 0)
                elif ps.get("part_no") == c_no:
                    cand_placed = int(ps.get("placed_qty") or ps.get("blanks_placed") or 0)

            # STRICT CHECK: Base part must NOT lose any blanks to the companion part!
            if base_placed < test_base_qty:
                continue

            # Candidate must place at least 1 blank in the remaining space excluding the base part
            if cand_placed < 1:
                continue

            yield_boost = round(comb_yield - baseline_yield, 1)
            if yield_boost < 0:
                continue

            # Recommendation Scoring:
            # 1. Yield Score: Combined yield is fundamental
            yield_score = comb_yield * 2.0 + (yield_boost * 3.5 if yield_boost > 0 else 0)

            # 2. Demand Score (More quantity to produce gets higher score in default/more_qty mode)
            demand_score = 0.0
            if qty_to_prod > 0:
                demand_score += min(30.0, math.log10(qty_to_prod + 1) * 8.0)
            if cur_stock == 0 and mrp_target > 0:
                demand_score += 15.0

            total_score = round(yield_score + demand_score, 2)

            # Assign categorization tag
            if yield_boost >= 5.0:
                category_tag = "YIELD_CHAMPION"
                badge_title = "Yield Champion"
                badge_color = "#059669"
            elif qty_to_prod >= 200:
                category_tag = "HIGH_QUANTITY"
                badge_title = "High Qty Demand"
                badge_color = "#dc2626"
            elif 0 < qty_to_prod <= 50:
                category_tag = "SCRAP_FILLER"
                badge_title = "Quick Scrap Filler"
                badge_color = "#d97706"
            else:
                category_tag = "BALANCED_COMBO"
                badge_title = "Balanced Mate"
                badge_color = "#0284c7"

            scored_candidates.append({
                "part_no": c_no,
                "part_desc": cand.get("part_desc") or "",
                "grade": c_grade,
                "thickness": c_thick,
                "blank_length": c_len,
                "blank_width": c_wid,
                "blank_size_str": f"{c_thick:g} × {c_len:g} × {c_wid:g}",
                "strip_per_blank_qty": cand.get("strip_qty") or 1,
                "offtake": cand.get("offtake") or 1,
                "mrp_monthly_target": mrp_target,
                "current_stock": cur_stock,
                "qty_to_produce": qty_to_prod,
                "remaining_deficit": qty_to_prod,
                "stock_status": stock_status,
                "stock_label": stock_label,
                "baseline_yield": baseline_yield,
                "combined_yield": comb_yield,
                "yield_boost": yield_boost,
                "recommended_blanks": max(1, cand_placed if cand_placed > 0 else test_cand_qty),
                "total_score": total_score,
                "category_tag": category_tag,
                "badge_title": badge_title,
                "badge_color": badge_color
            })

        # 5. Apply Filter Modes:
        # - "more_qty": Prioritize parts with largest pending quantity to produce
        # - "less_qty": Prioritize parts with small pending quantities (scrap fillers)
        # - "max_yield": Prioritize highest sheet area yield
        # - "all": Balanced composite recommendation
        if filter_mode in ("more_qty", "high_demand"):
            filtered = sorted(scored_candidates, key=lambda x: (x["qty_to_produce"], x["combined_yield"]), reverse=True)
        elif filter_mode in ("less_qty", "scrap_filler"):
            with_low_qty = [c for c in scored_candidates if 0 < c["qty_to_produce"] <= 100]
            if with_low_qty:
                filtered = sorted(with_low_qty, key=lambda x: (x["qty_to_produce"], -x["combined_yield"]))
            else:
                filtered = sorted(scored_candidates, key=lambda x: (x["qty_to_produce"] if x["qty_to_produce"] > 0 else 999999, -x["combined_yield"]))
        elif filter_mode in ("max_yield", "yield"):
            filtered = sorted(scored_candidates, key=lambda x: (x["combined_yield"], x["yield_boost"]), reverse=True)
        else:
            filtered = sorted(scored_candidates, key=lambda x: x["total_score"], reverse=True)

        top_recommendations = filtered[:8]

        # 6. Generate AI Commentary
        for cand in top_recommendations:
            cand["ai_rationale"] = self._generate_candidate_rationale(
                base_part_no=base_part_no,
                cand=cand,
                sheet_size=f"{s_len:g} × {s_wid:g}"
            )

        ai_executive_summary = self._generate_executive_summary(
            base_part_no=base_part_no,
            baseline_yield=baseline_yield,
            recommendations=top_recommendations,
            sheet_dims=f"{s_len:g} × {s_wid:g} mm ({part_grade} {part_thick:g}mm)",
            filter_mode=filter_mode
        )

        return {
            "success": True,
            "base_part_no": base_part_no,
            "sheet_dims": f"{s_len:g} × {s_wid:g} mm",
            "grade": part_grade,
            "thickness": part_thick,
            "baseline_yield": baseline_yield,
            "total_candidates_found": len(scored_candidates),
            "filter_mode": filter_mode,
            "recommendations": top_recommendations,
            "ai_executive_summary": ai_executive_summary
        }

    def _get_part_data(self, part_no: str, company_id: Optional[str] = None) -> Dict[str, Any]:
        """Fetch part dimensions and grade directly from Supabase database scoped to company."""
        p_no = norm_str(part_no)
        if not p_no:
            return {}

        # 1. Direct query from Supabase database (db_clean) scoped by company_id
        p = db.get_part(p_no, company_id=company_id)
        if not p:
            # Fallback search if exact part_no has minor formatting differences
            search_res = db.search_parts(p_no, limit=5, company_id=company_id)
            if search_res:
                k = norm_key(p_no)
                for cand in search_res:
                    if norm_key(cand.get("part_no")) == k:
                        p = cand
                        break
                if not p:
                    p = search_res[0]

        if p:
            return {
                "part_no": p.get("part_no") or p_no,
                "part_desc": p.get("part_desc") or "",
                "grade": (p.get("grade") or "HR").strip().upper(),
                "thickness": float(p.get("thickness") or 1.0),
                "length": float(p.get("length") or 0.0),
                "width": float(p.get("width") or 0.0),
                "weight": float(p.get("weight") or 0.0),
                "strip_qty": int(p.get("strip_per_blank_qty") or 1),
                "offtake": int(p.get("offtake") or 1),
                "standard_rm": p.get("standard_rm") or ""
            }

        return {}

    def _find_matching_candidates(
        self,
        target_grade: str,
        target_thickness: float,
        exclude_parts: List[str],
        sheet_len: float,
        sheet_wid: float,
        company_id: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Find parts matching grade and thickness directly from Supabase database scoped to company."""
        candidates = []
        excl_keys = {norm_key(p) for p in exclude_parts if norm_str(p)}

        # Fetch matching parts from database scoped to company_id
        db_parts = db.get_parts_by_spec(grade=target_grade, thickness=target_thickness, limit=200, company_id=company_id)

        # In case the grade is lenient or target_grade parameter was missing
        if not db_parts and target_thickness is not None:
            db_parts = db.get_parts_by_spec(grade=None, thickness=target_thickness, limit=200, company_id=company_id)

        tg_norm = target_grade.upper().strip() if target_grade else ""

        for p in db_parts:
            p_no = str(p.get("part_no") or "").strip()
            if not p_no or norm_key(p_no) in excl_keys:
                continue

            p_grade = str(p.get("grade") or "").upper().strip()
            p_thk = float(p.get("thickness") or 0.0)

            # Check thickness match within 0.05 mm
            if abs(p_thk - target_thickness) > 0.05:
                continue

            # Check grade match
            if tg_norm and p_grade:
                if tg_norm != p_grade and tg_norm not in p_grade and p_grade not in tg_norm:
                    continue

            c_len = float(p.get("length") or 0.0)
            c_wid = float(p.get("width") or 0.0)

            if c_len <= 0 or c_wid <= 0:
                continue

            c_max = max(c_len, c_wid)
            c_min = min(c_len, c_wid)
            sheet_max = max(sheet_len, sheet_wid)
            sheet_min = min(sheet_len, sheet_wid)

            # Strict Physical Size Check:
            # Sheet/plate dimensions must be greater than or equal to candidate blank size
            if sheet_max < c_max or sheet_min < c_min:
                continue

            candidates.append({
                "part_no": p_no,
                "part_desc": p.get("part_desc") or "",
                "grade": p_grade or tg_norm,
                "thickness": p_thk or target_thickness,
                "length": c_len,
                "width": c_wid,
                "strip_qty": int(p.get("strip_per_blank_qty") or 1),
                "offtake": int(p.get("offtake") or 1),
                "standard_rm": p.get("standard_rm") or ""
            })

            if len(candidates) >= 50:
                break

        return candidates

    def _get_part_mrp_stock(self, part_no: str, company_id: Optional[str] = None) -> Dict[str, int]:
        """Fetch MRP target, stock, and qty to produce directly from Supabase database scoped to company."""
        p_no = norm_str(part_no)
        if not p_no:
            return {"mrp_target": 0, "cur_stock": 0, "qty_to_produce": 0}

        mrp = db.get_mrp_for_part(p_no, company_id=company_id)
        if mrp:
            return {
                "mrp_target": int(mrp.get("monthly_schedule") or 0),
                "cur_stock": int(mrp.get("current_stock") or 0),
                "qty_to_produce": int(mrp.get("qty_to_produce") or 0)
            }

        return {"mrp_target": 0, "cur_stock": 0, "qty_to_produce": 0}

    def _generate_candidate_rationale(self, base_part_no: str, cand: Dict[str, Any], sheet_size: str) -> str:
        """Generates concise manufacturing engineering rationale for a candidate."""
        boost = cand.get("yield_boost", 0.0)
        comb_y = cand.get("combined_yield", 0.0)
        c_no = cand.get("part_no")
        c_size = cand.get("blank_size_str")
        deficit = cand.get("remaining_deficit", 0)
        stock = cand.get("current_stock", 0)

        # Yield clause
        if boost > 0:
            yield_clause = f"Lifts sheet yield from {cand['baseline_yield']:.1f}% to {comb_y:.1f}% (+{boost:.1f}% boost)"
        else:
            yield_clause = f"Maintains high sheet efficiency at {comb_y:.1f}%"

        # Quantity to produce clause
        if deficit >= 100:
            qty_clause = f"Fulfills high pending demand of {deficit} units (Stock: {stock})."
        elif 0 < deficit < 50:
            qty_clause = f"Ideal scrap filler to clear small pending batch of {deficit} units without overproducing."
        elif deficit > 0:
            qty_clause = f"Satisfies active monthly requirement of {deficit} units."
        else:
            qty_clause = f"Piggybacks on sheet remnants with {stock} units safely in inventory."

        return f"{yield_clause}. {qty_clause} Blank size ({c_size}) nests seamlessly with {base_part_no} on {sheet_size} stock."

    def _generate_executive_summary(
        self,
        base_part_no: str,
        baseline_yield: float,
        recommendations: List[Dict[str, Any]],
        sheet_dims: str,
        filter_mode: str
    ) -> str:
        """Synthesizes high-level executive verdict from Gemini LLM or engineering fallback."""
        if not recommendations:
            return f"No matching co-production companion parts found in database for {base_part_no} on {sheet_dims}."

        top = recommendations[0]
        top_part = top.get("part_no")
        top_yield = top.get("combined_yield", 0.0)
        top_boost = top.get("yield_boost", 0.0)
        top_deficit = top.get("remaining_deficit", 0)
        top_stock = top.get("current_stock", 0)

        mode_desc = {
            "more_qty": "High Quantity to Produce (Urgent Demand)",
            "less_qty": "Less Quantity to Produce (Scrap Fillers / Small Batches)",
            "max_yield": "Maximum Sheet Yield Boost",
            "all": "Balanced Optimization (Yield + Demand)"
        }.get(filter_mode, "Optimized Co-Production")

        # Attempt Gemini LLM call if API key exists
        if self.gemini_key:
            try:
                models = ["gemini-3.8-flash", "gemini-flash-lite-latest"]
                prompt = (
                    f"You are the Lead Manufacturing & Shearing Optimization AI Agent in an automotive sheet metal stamping plant.\n"
                    f"Primary Part: {base_part_no}\n"
                    f"Sheet: {sheet_dims}\n"
                    f"Baseline Yield: {baseline_yield:.1f}%\n"
                    f"Focus Mode: {mode_desc}\n"
                    f"Top Recommended Part: {top_part} ({top.get('blank_size_str')})\n"
                    f"Combined Yield: {top_yield:.1f}% (+{top_boost:.1f}% boost)\n"
                    f"Pending Quantity to Produce: {top_deficit} units, Stock: {top_stock} units.\n"
                    f"Provide a sharp 2-sentence executive verdict explaining why cutting {top_part} alongside {base_part_no} "
                    f"maximizes sheet yield while addressing the requested production demand."
                )
                for m in models:
                    try:
                        url = f"https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={self.gemini_key}"
                        req_data = json.dumps({
                            "contents": [{"parts": [{"text": prompt}]}],
                            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 140}
                        }).encode("utf-8")
                        req = urllib.request.Request(url, data=req_data, headers={"Content-Type": "application/json"})
                        with urllib.request.urlopen(req, timeout=4) as resp:
                            res = json.loads(resp.read().decode("utf-8"))
                            text = res["candidates"][0]["content"]["parts"][0]["text"].strip()
                            if text:
                                return f"{text} (AI Engine: Gemini)"
                    except Exception:
                        continue
            except Exception:
                pass

        # Deterministic fallback
        return (
            f"Autonomous Recommendation ({mode_desc}): Nesting {top_part} alongside {base_part_no} achieves "
            f"{top_yield:.1f}% sheet yield (+{top_boost:.1f}% boost), while simultaneously manufacturing "
            f"{top_deficit} required units for component {top_part}."
        )
