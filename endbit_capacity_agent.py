"""
SheetLayout AI — End-Bit Capacity & Shearing Calculation Agent
Autonomous manufacturing intelligence to calculate the maximum number of component
blanks that can be physically produced from a selected number of raw sheet end-bits/offcuts,
strictly enforcing geometric boundaries so blanks never exceed end-bit dimensions.

Key Capabilities:
1. Strict Physical Boundary Check: Determines if blank geometry exceeds end-bit dimensions in all orientations.
2. 2D Guillotine Nesting Simulation: Calculates exact blanks extractable per single end-bit.
3. Multi-Endbit Multiplier: Scales capacity across N selected end-bits (Total Parts = Blanks/Endbit * Number of Endbits).
4. Material Yield & Scrap Mass Balance: Computes blank area yield, scrap offcut remnants, and scrap weight.
5. Inverted Target Quantity Analysis: Calculates minimum end-bits required to satisfy a specific production quantity.
6. Conversational Chatbot Handling: Parses natural language queries regarding end-bit parts production.
"""

import math
import re
from typing import Dict, List, Any, Optional, Tuple

from cut_optimizer import CUT_OPTIMIZER_2D


def norm_key(s):
    if not s:
        return ""
    return re.sub(r'[^a-zA-Z0-9]', '', str(s)).lower()


class EndbitCapacityAgent:
    def __init__(self, data_store: Optional[Dict[str, Any]] = None, mo_engine: Any = None):
        self.data_store = data_store or {}
        self.parts = self.data_store.get("parts", {})
        self.base_parts = self.data_store.get("base_parts", {})
        self.records = self.data_store.get("records", [])
        self.mo_engine = mo_engine

    def calculate_endbit_capacity(
        self,
        endbit_length: float,
        endbit_width: float,
        endbit_thickness: float,
        endbits_count: int = 1,
        blank_length: float = 0.0,
        blank_width: float = 0.0,
        blank_thickness: float = 0.0,
        part_no: Optional[str] = None,
        target_qty: Optional[int] = None,
        kerf: float = 0.0
    ) -> Dict[str, Any]:
        """
        Calculates the maximum parts that can be produced from selected end-bits
        without exceeding the end-bit dimensions.
        """
        # 1. Clean and normalize end-bit dimensions (Length >= Width)
        eb_l_raw = float(endbit_length or 0)
        eb_w_raw = float(endbit_width or 0)
        eb_t = float(endbit_thickness or blank_thickness or 4.8)
        eb_count = max(1, int(endbits_count or 1))

        eb_l = max(eb_l_raw, eb_w_raw)
        eb_w = min(eb_l_raw, eb_w_raw)

        # 2. Resolve blank dimensions (from parameters or part catalog)
        b_l_raw = float(blank_length or 0)
        b_w_raw = float(blank_width or 0)
        b_t = float(blank_thickness or eb_t)

        resolved_part_no = (part_no or "Part Blank").strip()

        if (b_l_raw <= 0 or b_w_raw <= 0) and part_no:
            lookup = self._lookup_part_blank(part_no)
            if lookup:
                b_l_raw = lookup["blank_length"]
                b_w_raw = lookup["blank_width"]
                b_t = lookup.get("thickness", b_t)
                resolved_part_no = lookup.get("part_no", resolved_part_no)

        b_l = max(b_l_raw, b_w_raw)
        b_w = min(b_l_raw, b_w_raw)

        # 3. Input Validation
        if eb_l <= 0 or eb_w <= 0:
            return {
                "success": False,
                "fits": False,
                "exceeds_endbit_size": True,
                "error": "Invalid end-bit dimensions. Length and width must be greater than zero.",
                "parts_per_endbit": 0,
                "total_parts_produced": 0,
                "yield_pct": 0.0,
                "waste_pct": 100.0
            }

        if b_l <= 0 or b_w <= 0:
            return {
                "success": False,
                "fits": False,
                "exceeds_endbit_size": False,
                "error": "Blank dimensions are required. Please provide blank length and width.",
                "parts_per_endbit": 0,
                "total_parts_produced": 0,
                "yield_pct": 0.0,
                "waste_pct": 100.0
            }

        # 4. Strict Physical Boundary Check: Does blank exceed end-bit size?
        # A rectangular blank can fit only if in at least one orientation its dimensions <= end-bit dimensions.
        fits_normal = (b_l <= eb_l) and (b_w <= eb_w)
        fits_rotated = (b_w <= eb_l) and (b_l <= eb_w)
        fits_in_endbit = fits_normal or fits_rotated

        eb_area = eb_l * eb_w
        blank_area = b_l * b_w
        total_eb_area = eb_area * eb_count

        if not fits_in_endbit:
            # Blank physically exceeds end-bit dimensions
            exceed_reasons = []
            if b_l > eb_l and b_l > eb_w:
                exceed_reasons.append(f"Blank length ({b_l:g} mm) exceeds both end-bit length ({eb_l:g} mm) and width ({eb_w:g} mm)")
            elif b_w > eb_w and b_w > eb_l:
                exceed_reasons.append(f"Blank width ({b_w:g} mm) exceeds end-bit dimensions ({eb_l:g} × {eb_w:g} mm)")
            else:
                exceed_reasons.append(f"Blank size ({b_l:g} × {b_w:g} mm) does not fit within end-bit plate ({eb_l:g} × {eb_w:g} mm)")

            reason_str = "; ".join(exceed_reasons)
            return {
                "success": True,
                "fits": False,
                "exceeds_endbit_size": True,
                "part_no": resolved_part_no,
                "endbit_size": f"{eb_t:g}*{eb_l:g}*{eb_w:g}",
                "blank_size": f"{b_t:g}*{b_l:g}*{b_w:g}",
                "endbit_dimensions": {"length": eb_l, "width": eb_w, "thickness": eb_t},
                "blank_dimensions": {"length": b_l, "width": b_w, "thickness": b_t},
                "endbits_count": eb_count,
                "parts_per_endbit": 0,
                "total_parts_produced": 0,
                "yield_pct": 0.0,
                "waste_pct": 100.0,
                "reason": reason_str,
                "summary": (
                    f"Part blank ({b_l:g} × {b_w:g} mm) EXCEEDS end-bit offcut size ({eb_l:g} × {eb_w:g} mm). "
                    f"0 parts can be produced from these {eb_count} end-bits."
                ),
                "recommendation": (
                    f"This offcut is too small for part {resolved_part_no}. Select an end-bit with dimensions "
                    f"at least {b_l:g} mm length and {b_w:g} mm width."
                )
            }

        # 5. 2D Guillotine Nesting Simulation (Parts extractable from ONE end-bit)
        nest_res = CUT_OPTIMIZER_2D.optimize_nesting(
            sheet_length=eb_l,
            sheet_width=eb_w,
            blank_length=b_l,
            blank_width=b_w,
            part_no=resolved_part_no,
            can_rotate=False,
            kerf=kerf
        )

        parts_per_eb = nest_res.get("total_blanks", 0)

        # Fallback to direct analytical orientation if optimizer returned 0 despite fitting
        if parts_per_eb == 0 and fits_in_endbit:
            opt1 = int(eb_l // b_l) * int(eb_w // b_w)
            parts_per_eb = max(opt1, 1)

        # 6. Multi-Endbit Calculation
        total_parts_produced = parts_per_eb * eb_count
        total_part_area = total_parts_produced * blank_area

        yield_pct = round(min(100.0, (total_part_area / total_eb_area) * 100.0), 2)
        waste_pct = round(100.0 - yield_pct, 2)

        # Steel density: 7.85 kg / dm^3 -> 7.85e-6 kg / mm^3
        STEEL_DENSITY = 7.85e-6
        single_blank_weight = round(b_l * b_w * b_t * STEEL_DENSITY, 3)
        total_blanks_weight = round(total_parts_produced * single_blank_weight, 2)
        single_eb_weight = round(eb_l * eb_w * eb_t * STEEL_DENSITY, 3)
        total_eb_weight = round(eb_count * single_eb_weight, 2)
        total_scrap_weight = max(0.0, round(total_eb_weight - total_blanks_weight, 2))

        # Check thickness consistency
        thickness_mismatch = abs(eb_t - b_t) > 0.1
        thickness_warning = (
            f"Thickness mismatch: End-bit is {eb_t:g} mm but part blank is {b_t:g} mm."
            if thickness_mismatch else None
        )

        # 7. Target Quantity Feasibility (if user specified desired output)
        target_info = None
        if target_qty and target_qty > 0:
            endbits_needed_for_target = math.ceil(target_qty / parts_per_eb) if parts_per_eb > 0 else 9999
            is_feasible = (target_qty <= total_parts_produced)
            shortfall = max(0, target_qty - total_parts_produced)
            surplus = max(0, total_parts_produced - target_qty)

            target_info = {
                "target_qty": target_qty,
                "feasible": is_feasible,
                "endbits_needed_for_target": endbits_needed_for_target,
                "shortfall": shortfall,
                "surplus": surplus,
                "status_label": "Sufficient End-bits" if is_feasible else f"Shortfall: {shortfall} parts"
            }

        strategy_str = nest_res.get("strategy") or "Guillotine Nesting"
        summary_str = (
            f"From {eb_count} selected end-bit(s) of size {eb_t:g}*{eb_l:g}*{eb_w:g} mm, "
            f"you can produce up to {total_parts_produced} blank(s) of {resolved_part_no} "
            f"({parts_per_eb} blanks per end-bit) with {yield_pct}% material yield."
        )

        return {
            "success": True,
            "fits": True,
            "exceeds_endbit_size": False,
            "part_no": resolved_part_no,
            "endbit_size": f"{eb_t:g}*{eb_l:g}*{eb_w:g}",
            "blank_size": f"{b_t:g}*{b_l:g}*{b_w:g}",
            "endbit_dimensions": {"length": eb_l, "width": eb_w, "thickness": eb_t},
            "blank_dimensions": {"length": b_l, "width": b_w, "thickness": b_t},
            "endbits_count": eb_count,
            "parts_per_endbit": parts_per_eb,
            "total_parts_produced": total_parts_produced,
            "yield_pct": yield_pct,
            "waste_pct": waste_pct,
            "single_blank_weight_kg": single_blank_weight,
            "total_blanks_weight_kg": total_blanks_weight,
            "single_endbit_weight_kg": single_eb_weight,
            "total_endbits_weight_kg": total_eb_weight,
            "total_scrap_weight_kg": total_scrap_weight,
            "thickness_mismatch": thickness_mismatch,
            "thickness_warning": thickness_warning,
            "strategy": strategy_str,
            "placements_sample": nest_res.get("placements", []),
            "remnants": nest_res.get("remnants", []),
            "target_analysis": target_info,
            "summary": summary_str,
            "recommendation": (
                f"Approved for shearing: Cut {parts_per_eb} blanks per end-bit across {eb_count} pieces "
                f"for a net production output of {total_parts_produced} parts."
            )
        }

    def calculate_multi_part_capacity(
        self,
        endbit_length: float,
        endbit_width: float,
        endbit_thickness: float,
        endbits_count: int,
        parts_list: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """
        Evaluates capacity for multiple parts configured in an End-Bit Material Order.
        """
        results = []
        overall_fits = True
        overall_exceeds = False
        total_possible_output = 0

        for p in parts_list:
            p_no = p.get("part_no", "Part")
            b_l = float(p.get("cut_length") or p.get("blank_length") or 0)
            b_w = float(p.get("cut_width") or p.get("blank_width") or 0)
            b_t = float(p.get("thickness") or endbit_thickness or 4.8)
            t_qty = int(p.get("no_of_parts") or p.get("target_qty") or 0)

            calc = self.calculate_endbit_capacity(
                endbit_length=endbit_length,
                endbit_width=endbit_width,
                endbit_thickness=endbit_thickness,
                endbits_count=endbits_count,
                blank_length=b_l,
                blank_width=b_w,
                blank_thickness=b_t,
                part_no=p_no,
                target_qty=t_qty
            )
            if not calc.get("fits"):
                overall_fits = False
                overall_exceeds = True

            total_possible_output += calc.get("total_parts_produced", 0)
            results.append(calc)

        return {
            "success": True,
            "overall_fits": overall_fits,
            "has_exceeded_parts": overall_exceeds,
            "endbits_count": endbits_count,
            "parts_count": len(parts_list),
            "total_possible_output": total_possible_output,
            "part_results": results
        }

    # =========================================================================
    # NATURAL LANGUAGE CHATBOT PARSER & REPORTER
    # =========================================================================

    def handle_natural_language_query(self, message: str) -> Optional[Dict[str, Any]]:
        """
        Detects end-bit capacity questions and produces a professional manufacturing report.
        """
        m_lower = message.lower()

        # Check intent: Must mention endbit/offcut and calculation/parts/capacity
        is_eb_word = any(k in m_lower for k in ["endbit", "end bit", "offcut", "off-cut", "remnant"])
        is_calc_word = any(k in m_lower for k in [
            "how many parts", "no of parts", "number of parts", "calculate", "produce",
            "capacity", "within", "exceeds", "fit in", "blanks can we produce", "can we make"
        ])

        if not (is_eb_word and is_calc_word):
            return None

        # 1. Extract Number of End-bits (e.g., "5 endbits", "3 end bits", "10 offcuts")
        m_count = re.search(r'(\d+)\s*(?:nos?|pieces?|pcs?|units?)?\s*(?:of\s*)?(?:end-?\s*bits?|off-?\s*cuts?)', m_lower)
        if not m_count:
            m_count = re.search(r'(?:end-?\s*bits?|off-?\s*cuts?)\s*(?:count|quantity|number|nos?)?\s*(?:is|of|:)?\s*(\d+)', m_lower)
        endbits_count = int(m_count.group(1)) if m_count else 1

        # 2. Extract End-Bit Dimensions (e.g., "1200*600", "730*60*5.8", "800 x 400")
        eb_dims = self._extract_dims_from_text(message)
        eb_l, eb_w, eb_t = 0.0, 0.0, 4.8
        if eb_dims:
            eb_l = eb_dims.get("length", 0)
            eb_w = eb_dims.get("width", 0)
            eb_t = eb_dims.get("thickness", 4.8)

        # 3. Extract Part Number (e.g., MBA01008, MBA01010, X5L00214)
        detected_part = self._extract_part_from_text(message)

        # 4. Extract Blank Dimensions if explicitly mentioned separately
        b_l, b_w, b_t = 0.0, 0.0, eb_t
        all_dims = self._extract_all_dims_from_text(message)
        if len(all_dims) >= 2:
            # First set is likely end-bit, second is part blank
            eb_set = all_dims[0]
            b_set = all_dims[1]
            eb_l, eb_w, eb_t = eb_set["length"], eb_set["width"], eb_set.get("thickness", 4.8)
            b_l, b_w, b_t = b_set["length"], b_set["width"], b_set.get("thickness", eb_t)
        elif len(all_dims) == 1 and detected_part:
            # Dimension matches endbit; blank comes from part catalog
            lookup = self._lookup_part_blank(detected_part)
            if lookup:
                b_l = lookup["blank_length"]
                b_w = lookup["blank_width"]
                b_t = lookup.get("thickness", eb_t)
        elif len(all_dims) == 1 and not detected_part:
            # Single dimension given without part: assume it's blank or endbit
            d = all_dims[0]
            if "blank" in m_lower or "part" in m_lower:
                b_l, b_w, b_t = d["length"], d["width"], d.get("thickness", 4.8)
            else:
                eb_l, eb_w, eb_t = d["length"], d["width"], d.get("thickness", 4.8)

        # If blank dims still missing but part detected
        if (b_l == 0 or b_w == 0) and detected_part:
            lookup = self._lookup_part_blank(detected_part)
            if lookup:
                b_l = lookup["blank_length"]
                b_w = lookup["blank_width"]
                b_t = lookup.get("thickness", eb_t)

        # If end-bit dims still 0, try to find an active recorded end-bit or default
        if eb_l == 0 or eb_w == 0:
            default_eb = self._find_sample_endbit()
            if default_eb:
                eb_l = default_eb["length"]
                eb_w = default_eb["width"]
                eb_t = default_eb.get("thickness", 4.8)
            else:
                eb_l, eb_w, eb_t = 1200.0, 600.0, 4.8

        if b_l == 0 or b_w == 0:
            if detected_part:
                return {
                    "reply": (
                        f"### End-Bit Capacity Calculation for **{detected_part}**\n\n"
                        f"Could not automatically retrieve blank cut dimensions for `{detected_part}`. "
                        f"Please specify the cut blank size (e.g. `200*150 mm`) or choose an active part."
                    ),
                    "type": "text"
                }
            else:
                return {
                    "reply": (
                        "### End-Bit Parts Capacity Intelligence\n\n"
                        "To calculate how many parts you can produce without exceeding end-bit size, please provide:\n"
                        "- **Part Number** or **Blank Size** (e.g. `MBA01008` or `300*200 mm`)\n"
                        "- **End-Bit Dimensions** (e.g. `1200*600 mm`)\n"
                        "- **Number of End-Bits** (e.g. `5 end-bits`)\n\n"
                        "> **Example Prompt**: *\"How many parts of MBA01010 can we produce from 5 endbits of 1200*600?\"*"
                    ),
                    "type": "help",
                    "actions": [
                        {"label": "5 Endbits 1200*600 (MBA01010)", "value": "calculate parts produced from 5 endbits of 1200*600 for MBA01010"},
                        {"label": "3 Endbits 800*400 (MBA01008)", "value": "calculate parts produced from 3 endbits of 800*400 for MBA01008"},
                        {"label": "10 Endbits 1000*500 (X5L00214)", "value": "calculate parts produced from 10 endbits of 1000*500 for X5L00214"}
                    ]
                }

        # Execute capacity calculation
        res = self.calculate_endbit_capacity(
            endbit_length=eb_l,
            endbit_width=eb_w,
            endbit_thickness=eb_t,
            endbits_count=endbits_count,
            blank_length=b_l,
            blank_width=b_w,
            blank_thickness=b_t,
            part_no=detected_part or "Component Blank"
        )

        return self._format_agent_reply(res)

    # =========================================================================
    # INTERNAL HELPERS
    # =========================================================================

    def _format_agent_reply(self, res: Dict[str, Any]) -> Dict[str, Any]:
        """Formats calculation result into an executive clean Markdown table."""
        part_name = res.get("part_no", "Component Blank")
        eb_size = res.get("endbit_size")
        b_size = res.get("blank_size")
        eb_count = res.get("endbits_count", 1)
        fits = res.get("fits", False)
        exceeds = res.get("exceeds_endbit_size", False)

        lines = [
            f"### End-Bit Shearing Capacity & Boundary Analysis: `{part_name}`",
            f"**Container Offcut:** `{eb_size} mm` ({eb_count} pieces selected) | **Blank Geometry:** `{b_size} mm`\n"
        ]

        if exceeds or not fits:
            lines.extend([
                "| Boundary Parameter | Specification | Engineering Assessment |",
                "| :--- | :--- | :--- |",
                f"| Part Blank Dimensions | **{res['blank_dimensions']['length']} × {res['blank_dimensions']['width']} mm** | Cut Blank Size |",
                f"| End-Bit Dimensions | **{res['endbit_dimensions']['length']} × {res['endbit_dimensions']['width']} mm** | Offcut Plate Size |",
                f"| Boundary Feasibility | **EXCEEDS END-BIT SIZE** | Cannot Fit Inside Offcut |",
                f"| Max Parts Extractable | **0 Blanks** | Physical boundary violation |\n",
                f"> **Engineering Notice:** {res.get('reason', 'Blank dimensions exceed container offcut.')}\n",
                f"**Recommendation:** {res.get('recommendation', 'Select a larger offcut piece.')}"
            ])
            return {
                "reply": "\n".join(lines),
                "type": "endbit_capacity_warning",
                "data": res
            }

        # Successful fit
        parts_per_eb = res.get("parts_per_endbit", 0)
        tot_parts = res.get("total_parts_produced", 0)
        yield_pct = res.get("yield_pct", 0.0)
        waste_pct = res.get("waste_pct", 0.0)
        tot_parts_wt = res.get("total_blanks_weight_kg", 0.0)
        tot_eb_wt = res.get("total_endbits_weight_kg", 0.0)
        tot_scrap_wt = res.get("total_scrap_weight_kg", 0.0)

        lines.extend([
            "| Production Parameter | Capacity Metric | Operational Notes |",
            "| :--- | :--- | :--- |",
            f"| Blanks Per End-Bit | **{parts_per_eb} Blanks / piece** | Optimal 2D guillotine nesting |",
            f"| Selected End-Bits Count | **{eb_count} End-Bits** | Available offcut stock consumed |",
            f"| **Maximum Parts Output** | **{tot_parts:,} Blanks** | Net producible components |",
            f"| Material Yield Efficiency | **{yield_pct}%** | Scrap wastage rate: {waste_pct}% |",
            f"| Finished Blanks Weight | **{tot_parts_wt:,} kg** | Total usable component mass |",
            f"| Offcut Stock Consumed | **{tot_eb_wt:,} kg** | Total offcut mass sheared |",
            f"| Shearing Scrap Generated | **{tot_scrap_wt:,} kg** | Remnant offcut wastage |\n",
            f"### Shearing Pattern & Feasibility Verdict",
            f"- **Boundary Verification:** Passed. Blank dimensions ({b_size} mm) fit comfortably inside offcut ({eb_size} mm).",
            f"- **Execution Strategy:** {res.get('strategy', 'Orthogonal guillotine shearing')}.",
            f"- **Output Summary:** {res.get('summary', '')}\n",
            f"> **Next Step:** To create an official Material Order using this capacity, open the End Bit MO portal."
        ])

        return {
            "reply": "\n".join(lines),
            "type": "endbit_capacity_report",
            "data": res,
            "actions": [
                {"label": "Create End Bit MO", "value": f"create endbit mo for {part_name}"},
                {"label": "Optimize with OptiCutter", "value": "open opticutter"}
            ]
        }

    def _lookup_part_blank(self, part_query: str) -> Optional[Dict[str, Any]]:
        clean = norm_key(part_query)
        # Search direct parts
        for p_name, p_data in self.parts.items():
            if norm_key(p_name) == clean or clean in norm_key(p_name):
                recs = p_data.get("records", [])
                for r in recs:
                    p1 = r.get("part1", {})
                    bs = p1.get("blank_size", {})
                    if bs.get("length") and bs.get("width"):
                        return {
                            "part_no": p_name,
                            "blank_length": float(bs["length"]),
                            "blank_width": float(bs["width"]),
                            "thickness": float(r.get("thickness", 4.8))
                        }
                    cb = r.get("cut_blank") or p1.get("cut_blank")
                    if cb:
                        nums = [float(x) for x in re.findall(r'\d+(?:\.\d+)?', str(cb))]
                        if len(nums) >= 2:
                            return {
                                "part_no": p_name,
                                "blank_length": max(nums[0], nums[1]),
                                "blank_width": min(nums[0], nums[1]),
                                "thickness": float(r.get("thickness", 4.8))
                            }
        return None

    def _extract_part_from_text(self, text: str) -> Optional[str]:
        clean = norm_key(text)
        for p in sorted(self.parts.keys(), key=len, reverse=True):
            if norm_key(p) in clean:
                return p
        for b in sorted(self.base_parts.keys(), key=len, reverse=True):
            if norm_key(b) in clean:
                items = self.base_parts[b].get("item_parts", [])
                return items[0] if items else b
        # Generic alphanumeric token matching part patterns like MBA01010
        m = re.search(r'\b([A-Z0-9]{5,12}(?:\s*-\s*Item\s*\d*)?)\b', text, re.IGNORECASE)
        if m:
            return m.group(1).strip()
        return None

    def _extract_dims_from_text(self, text: str) -> Optional[Dict[str, float]]:
        all_dims = self._extract_all_dims_from_text(text)
        return all_dims[0] if all_dims else None

    def _extract_all_dims_from_text(self, text: str) -> List[Dict[str, float]]:
        results = []
        # Match T*L*W or L*W
        pat3 = r'(\d+(?:\.\d+)?)\s*[*xX]\s*(\d+(?:\.\d+)?)\s*[*xX]\s*(\d+(?:\.\d+)?)'
        for m in re.finditer(pat3, text):
            nums = [float(m.group(1)), float(m.group(2)), float(m.group(3))]
            thicks = [x for x in nums if 0.4 <= x <= 40]
            dims = [x for x in nums if x > 40]
            if len(dims) == 2 and thicks:
                results.append({"thickness": thicks[0], "length": max(dims), "width": min(dims)})
            else:
                results.append({"thickness": min(nums), "length": max(nums), "width": sorted(nums)[1]})

        if not results:
            pat2 = r'(\d+(?:\.\d+)?)\s*[*xX]\s*(\d+(?:\.\d+)?)'
            for m in re.finditer(pat2, text):
                n1, n2 = float(m.group(1)), float(m.group(2))
                if n1 >= 10 and n2 >= 10:
                    results.append({"thickness": 4.8, "length": max(n1, n2), "width": min(n1, n2)})

        return results

    def _find_sample_endbit(self) -> Optional[Dict[str, float]]:
        if self.mo_engine and hasattr(self.mo_engine, "endbit_records"):
            for eb in self.mo_engine.endbit_records.values():
                l = float(eb.get("length") or 0)
                w = float(eb.get("width") or 0)
                if l > 0 and w > 0:
                    return {"length": l, "width": w, "thickness": float(eb.get("thickness", 4.8))}
        return {"length": 1200.0, "width": 600.0, "thickness": 4.8}


# Singleton instance
ENDBIT_CAPACITY_AGENT = EndbitCapacityAgent()
