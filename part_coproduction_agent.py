"""
SheetLayout AI — Part Co-Production & Yield Optimization Agent
Autonomous Agent that recommends co-production companion parts for sheet metal cutting:
1. Filters parts matching Grade & Thickness of the active sheet.
2. In-memory fast evaluation using local DATA_STORE and ERPStockService.
3. Multi-objective ranking & filtering based on:
   - "Higher Yield": Maximizes composite sheet area utilization (2D OptiCutter engine).
   - "More Quantity to Produce": Parts with high pending deficit/monthly schedule demand.
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
        self.data_store = data_store
        self.erp_service = erp_service
        self.gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
        self.optimizer = CutListOptimizer2D()

        # If data_store not passed, attempt to load local data_store.json
        if not self.data_store and os.path.exists("data_store.json"):
            try:
                with open("data_store.json", "r", encoding="utf-8") as f:
                    self.data_store = json.load(f)
            except Exception as e:
                print(f"[PartCoProductionAgent] Error loading data_store.json: {e}")

    def suggest_parts(
        self,
        base_part_no: str,
        sheet_length: float,
        sheet_width: float,
        grade: Optional[str] = None,
        thickness: Optional[float] = None,
        base_blanks_qty: Optional[int] = None,
        current_parts: Optional[List[str]] = None,
        filter_mode: str = "all"  # 'all', 'more_qty', 'less_qty', 'max_yield', 'low_stock'
    ) -> Dict[str, Any]:
        """
        Suggests companion parts to manufacture together on the same sheet.
        Prioritization criteria:
        - Grade & Thickness match
        - Higher Yield (OptiCutter 2D simulation)
        - More Quantity to Produce vs Less Quantity to Produce (MRP demand)
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

        # 1. Fetch base part details from data_store
        base_part_data = self._get_part_data(base_part_no)
        part_grade = norm_str(grade or base_part_data.get("grade") or "HR").upper()
        try:
            part_thick = float(thickness if thickness is not None else (base_part_data.get("thickness") or 1.0))
        except (ValueError, TypeError):
            part_thick = 1.0

        b_len = float(base_part_data.get("length") or 0.0)
        b_wid = float(base_part_data.get("width") or 0.0)

        s_len = max(float(sheet_length or 2500.0), float(sheet_width or 1250.0))
        s_wid = min(float(sheet_length or 2500.0), float(sheet_width or 1250.0))

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

        actual_base_blanks = int(base_blanks_qty) if base_blanks_qty and base_blanks_qty > 0 else max_base_blanks

        # 3. Retrieve Candidate Parts with matching Grade & Thickness from in-memory data_store
        candidates_raw = self._find_matching_candidates(
            target_grade=part_grade,
            target_thickness=part_thick,
            exclude_parts=current_parts,
            sheet_len=s_len,
            sheet_wid=s_wid
        )

        # 4. Evaluate MRP demand and run 2D Combo Nesting
        scored_candidates = []
        for cand in candidates_raw:
            c_no = cand["part_no"]
            c_len = cand["length"]
            c_wid = cand["width"]
            c_grade = cand["grade"]
            c_thick = cand["thickness"]

            # MRP & Stock details
            mrp_info = self._get_part_mrp_stock(c_no)
            mrp_target = mrp_info["mrp_target"]
            cur_stock = mrp_info["cur_stock"]
            qty_to_prod = mrp_info["qty_to_produce"]

            # Categorize Stock / Demand Status
            if cur_stock == 0 and mrp_target > 0:
                stock_status = "CRITICAL_ZERO"
                stock_label = "0 Stock (Urgent)"
            elif qty_to_prod >= 100 or cur_stock < (0.25 * mrp_target):
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

            # Estimate candidate blanks to test
            test_base_qty = max(1, int(actual_base_blanks * 0.75)) if actual_base_blanks > 1 else 1
            cand_area = c_len * c_wid
            base_area = b_len * b_wid if b_len > 0 and b_wid > 0 else 1.0
            sheet_area = s_len * s_wid
            remaining_area = max(0.0, sheet_area - (test_base_qty * base_area))
            test_cand_qty = max(1, min(40, int(remaining_area / cand_area))) if cand_area > 0 else 2

            # Simulate Multi-Part Nesting via CutListOptimizer2D
            combo_nest = self.optimizer.optimize_nesting(
                sheet_length=s_len,
                sheet_width=s_wid,
                parts=[
                    {"part_no": base_part_no, "length": b_len, "width": b_wid, "qty": test_base_qty},
                    {"part_no": c_no, "length": c_len, "width": c_wid, "qty": test_cand_qty}
                ]
            )

            comb_yield = float(combo_nest.get("yield_pct", 0.0))
            placed_parts = combo_nest.get("parts_summary", [])
            cand_placed = 0
            for ps in placed_parts:
                if ps.get("part_no") == c_no:
                    cand_placed = int(ps.get("placed_qty") or ps.get("blanks_placed") or 0)

            yield_boost = round(comb_yield - baseline_yield, 1)

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
        # User requirement:
        # "which will suggest that along with this we can create this part (based on grade and size)
        # which has more quantity to produce ( or we can say as less quantity) with higher yield..like that"
        if filter_mode in ("more_qty", "high_demand"):
            # Sort primarily by highest quantity to produce, keeping yield high
            filtered = sorted(scored_candidates, key=lambda x: (x["qty_to_produce"], x["combined_yield"]), reverse=True)
        elif filter_mode in ("less_qty", "scrap_filler"):
            # Parts with low/manageable quantity to produce (> 0) to quickly finish without over-producing
            with_low_qty = [c for c in scored_candidates if 0 < c["qty_to_produce"] <= 100]
            if with_low_qty:
                filtered = sorted(with_low_qty, key=lambda x: (x["qty_to_produce"], -x["combined_yield"]))
            else:
                filtered = sorted(scored_candidates, key=lambda x: (x["qty_to_produce"] if x["qty_to_produce"] > 0 else 999999, -x["combined_yield"]))
        elif filter_mode in ("max_yield", "yield"):
            # Strictly highest combined yield boost
            filtered = sorted(scored_candidates, key=lambda x: (x["combined_yield"], x["yield_boost"]), reverse=True)
        else:
            # Default / Recommended: composite score
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

    def _get_part_data(self, part_no: str) -> Dict[str, Any]:
        """Fetch part dimensions and grade from data_store"""
        if not self.data_store:
            return {}

        parts = self.data_store.get("parts", {})
        # Direct lookup
        p = parts.get(part_no)
        if not p:
            # Case-insensitive / normalized lookup
            k = norm_key(part_no)
            for pn, pdata in parts.items():
                if norm_key(pn) == k:
                    p = pdata
                    break

        if not p:
            return {}

        recs = p.get("records", [])
        r0 = recs[0] if recs else {}
        p1 = r0.get("part1", {})
        bs = p1.get("blank_size", {})

        thick = float(bs.get("thickness") or r0.get("thickness") or 1.0)
        length = float(bs.get("length") or 0.0)
        width = float(bs.get("width") or 0.0)

        # Parse cut_blank if blank_size length/width missing
        if length <= 0 or width <= 0:
            cb = p1.get("cut_blank") or r0.get("cut_blank")
            if cb:
                nums = [float(x) for x in re.findall(r'\d+(?:\.\d+)?', str(cb))]
                if len(nums) >= 2:
                    length, width = nums[0], nums[1]

        return {
            "part_no": part_no,
            "grade": r0.get("grade") or "HR",
            "thickness": thick,
            "length": length,
            "width": width,
            "strip_qty": p1.get("strip_qty") or 1,
            "offtake": p1.get("blank_qty") or 1
        }

    def _find_matching_candidates(
        self,
        target_grade: str,
        target_thickness: float,
        exclude_parts: List[str],
        sheet_len: float,
        sheet_wid: float
    ) -> List[Dict[str, Any]]:
        """Find parts matching grade and thickness within tolerance"""
        candidates = []
        if not self.data_store:
            return candidates

        parts = self.data_store.get("parts", {})
        excl_keys = {norm_key(p) for p in exclude_parts}

        tg_norm = target_grade.upper().strip()

        for p_no, p_data in parts.items():
            if norm_key(p_no) in excl_keys:
                continue

            recs = p_data.get("records", [])
            if not recs:
                continue

            r0 = recs[0]
            p_grade = str(r0.get("grade") or "").upper().strip()
            p_thk = float(r0.get("thickness") or 0.0)

            # Check thickness match within 0.05 mm
            if abs(p_thk - target_thickness) > 0.05:
                continue

            # Check grade match (lenient matching: e.g. HR in HR, CR in CRCA, or exact)
            if tg_norm and p_grade:
                if tg_norm != p_grade and tg_norm not in p_grade and p_grade not in tg_norm:
                    continue

            p1 = r0.get("part1", {})
            bs = p1.get("blank_size", {})
            c_len = float(bs.get("length") or 0.0)
            c_wid = float(bs.get("width") or 0.0)

            if c_len <= 0 or c_wid <= 0:
                cb = p1.get("cut_blank") or r0.get("cut_blank")
                if cb:
                    nums = [float(x) for x in re.findall(r'\d+(?:\.\d+)?', str(cb))]
                    if len(nums) >= 2:
                        c_len, c_wid = nums[0], nums[1]

            if c_len <= 0 or c_wid <= 0:
                continue

            # Must physically fit on the sheet
            if (c_len > sheet_len and c_len > sheet_wid) or (c_wid > sheet_len and c_wid > sheet_wid):
                continue

            candidates.append({
                "part_no": p_no,
                "part_desc": r0.get("layout_name") or p_data.get("base_part") or "",
                "grade": p_grade or tg_norm,
                "thickness": p_thk or target_thickness,
                "length": c_len,
                "width": c_wid,
                "strip_qty": p1.get("strip_qty") or 1,
                "offtake": p1.get("blank_qty") or 1
            })

            if len(candidates) >= 50:
                break

        return candidates

    def _get_part_mrp_stock(self, part_no: str) -> Dict[str, int]:
        """Fetch MRP target, stock, and qty to produce directly from in-memory cache (0ms latency)."""
        if not self.erp_service:
            return {"mrp_target": 0, "cur_stock": 0, "qty_to_produce": 0}

        part_str = str(part_no).strip()
        parent_part = part_str.split(" - ")[0].split("-Item")[0].strip()
        p_norm = norm_key(parent_part)
        c_norm = norm_key(part_str)

        mrp_target = 0
        cur_stock = 0
        balance_qty = 0

        # 1. Look up MRP schedule in self.erp_service.mrp_schedule
        mrp_items = (
            getattr(self.erp_service, "mrp_schedule", {}).get(p_norm)
            or getattr(self.erp_service, "mrp_schedule", {}).get(c_norm)
            or []
        )
        if mrp_items:
            selected = mrp_items[0]
            # Try to match child item number if present (e.g. 'Item 2' or 'Item 02')
            m_num = re.search(r'item\s*0?(\d+)', part_str, re.IGNORECASE)
            target_num = m_num.group(1) if m_num else None
            if target_num:
                for it in mrp_items:
                    it_child = str(it.get("child_part") or it.get("erp_part") or "")
                    if re.search(rf'item\s*0?{target_num}\b', it_child, re.IGNORECASE):
                        selected = it
                        break

            mrp_target = int(selected.get("total_qty") or selected.get("schedule_qty") or 0)
            balance_qty = int(selected.get("balance_qty") or selected.get("balance_planning") or 0)

        # 2. Look up Parts opening stock in self.erp_service.parts_stock
        stock_items = (
            getattr(self.erp_service, "parts_stock", {}).get(p_norm)
            or getattr(self.erp_service, "parts_stock", {}).get(c_norm)
            or []
        )
        if stock_items:
            cur_stock = int(sum(float(it.get("onhand_stock") or 0.0) for it in stock_items))

        qty_to_prod = balance_qty if balance_qty > 0 else max(0, mrp_target - cur_stock)

        return {
            "mrp_target": mrp_target,
            "cur_stock": cur_stock,
            "qty_to_produce": qty_to_prod
        }

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
            return f"No matching co-production companion parts found for {base_part_no} on {sheet_dims}."

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
