"""
2D Guillotine Cut-List Nesting & Yield Optimizer
Inspired by OptiCutter (opticutter.com) for Sheet Metal & Shearing Operations.
Optimizes rectangular blank placements on standard sheets and offcut end-bits,
calculating exact material yield %, cutting patterns, scrap remnants, and OptiCutter export formats.
Supports both single-part high-density block nesting and multi-part batch guillotine packing.
"""

import math
from typing import Dict, List, Any, Optional, Tuple

PART_COLORS = [
    {"bg": "#72bbf8", "border": "#1d4ed8"},  # Sky Blue
    {"bg": "#86efac", "border": "#15803d"},  # Emerald Green
    {"bg": "#fde047", "border": "#ca8a04"},  # Amber Yellow
    {"bg": "#c4b5fd", "border": "#7c3aed"},  # Purple Lavender
    {"bg": "#fda4af", "border": "#e11d48"},  # Rose Pink
    {"bg": "#fed7aa", "border": "#ea580c"},  # Coral Orange
    {"bg": "#a5f3fc", "border": "#0891b2"},  # Cyan
    {"bg": "#d8b4fe", "border": "#9333ea"},  # Violet
]


class CutListOptimizer2D:
    def __init__(self, default_kerf: float = 0.0):
        self.default_kerf = default_kerf

    def optimize_nesting(
        self,
        sheet_length: float,
        sheet_width: float,
        blank_length: float = 0.0,
        blank_width: float = 0.0,
        part_no: str = "Part",
        can_rotate: bool = True,
        kerf: float = 0.0,
        target_qty: Optional[int] = None,
        strategy_mode: str = "auto",
        parts: Optional[List[Dict[str, Any]]] = None
    ) -> Dict[str, Any]:
        """
        Executes 2D guillotine rectangular bin packing matching OptiCutter.
        If multiple parts are provided, runs multi-part guillotine nesting.
        If single part is provided, runs high-density 2-block guillotine packing.
        """
        s_len = max(float(sheet_length), float(sheet_width))
        s_wid = min(float(sheet_length), float(sheet_width))
        kerf_val = max(0.0, float(kerf))

        if s_len <= 0 or s_wid <= 0:
            return {
                "success": False,
                "error": "Invalid sheet dimensions provided. Length and width must be positive.",
                "total_blanks": 0,
                "yield_pct": 0.0,
                "waste_pct": 100.0,
                "placements": [],
                "remnants": [],
                "parts_summary": []
            }

        # Validate and parse parts list if provided
        parsed_parts = []
        if parts and isinstance(parts, list):
            for idx, p in enumerate(parts):
                if not isinstance(p, dict):
                    continue
                p_len = max(float(p.get("length") or p.get("blank_length") or 0.0), float(p.get("width") or p.get("blank_width") or 0.0))
                p_wid = min(float(p.get("length") or p.get("blank_length") or 0.0), float(p.get("width") or p.get("blank_width") or 0.0))
                p_qty = max(1, int(p.get("qty") or p.get("quantity") or 1))
                p_no = str(p.get("part_no") or f"Part-{idx + 1}").strip()
                color_info = PART_COLORS[idx % len(PART_COLORS)]

                if p_len > 0 and p_wid > 0:
                    parsed_parts.append({
                        "part_no": p_no,
                        "length": p_len,
                        "width": p_wid,
                        "qty": p_qty,
                        "part_idx": idx,
                        "row_id": p.get("row_id"),
                        "color": color_info["bg"],
                        "border_color": color_info["border"]
                    })

        # Multi-part mode: when more than 1 distinct part is provided
        if len(parsed_parts) > 1:
            return self._optimize_multi_part_guillotine(
                s_len=s_len,
                s_wid=s_wid,
                parts_list=parsed_parts,
                kerf_val=kerf_val,
                strategy_mode=strategy_mode,
                can_rotate=can_rotate
            )

        # Single-part mode: either 1 part in parsed_parts or fallback to blank_length/blank_width
        if len(parsed_parts) == 1:
            b_len = parsed_parts[0]["length"]
            b_wid = parsed_parts[0]["width"]
            part_no = parsed_parts[0]["part_no"]
            target_qty = parsed_parts[0]["qty"]
        else:
            b_len = max(float(blank_length), float(blank_width))
            b_wid = min(float(blank_length), float(blank_width))

        if b_len <= 0 or b_wid <= 0:
            return {
                "success": False,
                "error": "Invalid blank dimensions provided. Blank length and width must be positive.",
                "total_blanks": 0,
                "yield_pct": 0.0,
                "waste_pct": 100.0,
                "placements": [],
                "remnants": [],
                "parts_summary": []
            }

        return self._optimize_single_part_guillotine(
            s_len=s_len,
            s_wid=s_wid,
            b_len=b_len,
            b_wid=b_wid,
            part_no=part_no,
            can_rotate=can_rotate,
            kerf_val=kerf_val,
            target_qty=target_qty,
            strategy_mode=strategy_mode
        )

    def _optimize_multi_part_guillotine(
        self,
        s_len: float,
        s_wid: float,
        parts_list: List[Dict[str, Any]],
        kerf_val: float,
        strategy_mode: str,
        can_rotate: bool
    ) -> Dict[str, Any]:
        """
        Industrial 2D Guillotine multi-part nesting matching OptiCutter.
        Nests parts into clean, uniform rectangular blocks (rows × cols) separated by
        straight edge-to-edge guillotine shear cuts. Guarantees 100% physically cuttable
        shop-floor layouts without diagonal offsets, staircases, or overlaps.
        """
        sort_schemes = [
            # 1. Total requested area descending
            ("Area Descending", sorted(parts_list, key=lambda p: (p["length"] * p["width"] * p["qty"]), reverse=True)),
            # 2. Blank area descending
            ("Blank Area Descending", sorted(parts_list, key=lambda p: (p["length"] * p["width"]), reverse=True)),
            # 3. Maximum dimension descending
            ("Max Dimension Descending", sorted(parts_list, key=lambda p: max(p["length"], p["width"]), reverse=True)),
            # 4. Form order
            ("Order Kept", list(parts_list))
        ]

        # Determine rotation options based on strategy_mode
        def get_orientations(part_l: float, part_w: float):
            l = max(part_l, part_w)
            w = min(part_l, part_w)
            if strategy_mode == "longitudinal":
                return [(l, w, False)]
            elif strategy_mode == "transverse":
                return [(w, l, True)]
            else:
                return [(l, w, False), (w, l, True)] if can_rotate else [(l, w, False)]

        candidates = []

        for scheme_name, p_order in sort_schemes:
            for split_axis in ["horiz", "vert", "short"]:
                free_rects = [{"x": 0.0, "y": 0.0, "w": s_len, "h": s_wid}]
                placed_blanks = []
                placed_blocks = []
                remaining_qty = {p["part_idx"]: p["qty"] for p in p_order}

                changed = True
                while changed:
                    changed = False
                    best_block = None
                    best_fr_idx = -1
                    best_part_idx = -1
                    best_block_score = -1

                    for p in p_order:
                        p_idx = p["part_idx"]
                        needed = remaining_qty.get(p_idx, 0)
                        if needed <= 0:
                            continue

                        orientations = get_orientations(p["length"], p["width"])

                        for fr_idx, fr in enumerate(free_rects):
                            for bw, bh, rot in orientations:
                                if bw <= fr["w"] + 0.001 and bh <= fr["h"] + 0.001:
                                    max_cols = int(fr["w"] // (bw + kerf_val))
                                    if (max_cols * bw + max(0, max_cols - 1) * kerf_val) > fr["w"]:
                                        max_cols = max(1, max_cols - 1)

                                    max_rows = int(fr["h"] // (bh + kerf_val))
                                    if (max_rows * bh + max(0, max_rows - 1) * kerf_val) > fr["h"]:
                                        max_rows = max(1, max_rows - 1)

                                    if max_cols <= 0 or max_rows <= 0:
                                        continue

                                    # Find best grid (c, r) to pack up to needed blanks in a clean rectangle
                                    best_c, best_r = 1, 1
                                    max_fit = 0
                                    for r in range(1, max_rows + 1):
                                        c = min(max_cols, math.ceil(needed / r))
                                        count = min(needed, c * r)
                                        if count > max_fit:
                                            max_fit = count
                                            best_c, best_r = c, r

                                    block_w = round(best_c * bw + max(0, best_c - 1) * kerf_val, 1)
                                    block_h = round(best_r * bh + max(0, best_r - 1) * kerf_val, 1)

                                    if block_w > fr["w"] + 0.001 or block_h > fr["h"] + 0.001:
                                        continue

                                    score = max_fit * (p["length"] * p["width"])
                                    if score > best_block_score:
                                        best_block_score = score
                                        best_fr_idx = fr_idx
                                        best_part_idx = p_idx
                                        best_block = {
                                            "part": p,
                                            "bw": bw,
                                            "bh": bh,
                                            "rot": rot,
                                            "cols": best_c,
                                            "rows": best_r,
                                            "block_w": block_w,
                                            "block_h": block_h,
                                            "count": min(needed, best_c * best_r)
                                        }

                    if best_block is not None:
                        changed = True
                        fr = free_rects.pop(best_fr_idx)
                        p = best_block["part"]
                        p_idx = p["part_idx"]
                        bw, bh = best_block["bw"], best_block["bh"]
                        cols, rows = best_block["cols"], best_block["rows"]
                        bl_w, bl_h = best_block["block_w"], best_block["block_h"]

                        # Place aligned blanks inside this rectangular block
                        count_placed = 0
                        needed = remaining_qty[p_idx]
                        for r_idx in range(rows):
                            for c_idx in range(cols):
                                if count_placed >= needed:
                                    break
                                bx = fr["x"] + c_idx * (bw + kerf_val)
                                by = fr["y"] + r_idx * (bh + kerf_val)
                                placed_blanks.append({
                                    "part_no": p["part_no"],
                                    "part_idx": p_idx,
                                    "row_id": p.get("row_id"),
                                    "color": p.get("color", "#72bbf8"),
                                    "border_color": p.get("border_color", "#1d4ed8"),
                                    "x": round(bx, 1),
                                    "y": round(by, 1),
                                    "w": round(bw, 1),
                                    "h": round(bh, 1),
                                    "rotated": best_block["rot"],
                                    "blank_index": len(placed_blanks) + 1
                                })
                                count_placed += 1

                        remaining_qty[p_idx] -= count_placed
                        placed_blocks.append({
                            "x": round(fr["x"], 1),
                            "y": round(fr["y"], 1),
                            "w": round(bl_w, 1),
                            "h": round(bl_h, 1),
                            "part_no": p["part_no"]
                        })

                        # Guillotine split the free rectangle around this BLOCK
                        rem_w = round(fr["w"] - bl_w - kerf_val, 1)
                        rem_h = round(fr["h"] - bl_h - kerf_val, 1)

                        use_horiz = False
                        if split_axis == "horiz":
                            use_horiz = True
                        elif split_axis == "vert":
                            use_horiz = False
                        else:  # shorter axis
                            use_horiz = (rem_w <= rem_h)

                        if use_horiz:
                            # Horizontal cut across parent: right sub-block height = bl_h, bottom sub-block width = fr['w']
                            if rem_w > 0:
                                free_rects.append({"x": round(fr["x"] + bl_w + kerf_val, 1), "y": fr["y"], "w": rem_w, "h": bl_h})
                            if rem_h > 0:
                                free_rects.append({"x": fr["x"], "y": round(fr["y"] + bl_h + kerf_val, 1), "w": fr["w"], "h": rem_h})
                        else:
                            # Vertical cut across parent: right sub-block height = fr['h'], bottom sub-block width = bl_w
                            if rem_w > 0:
                                free_rects.append({"x": round(fr["x"] + bl_w + kerf_val, 1), "y": fr["y"], "w": rem_w, "h": fr["h"]})
                            if rem_h > 0:
                                free_rects.append({"x": fr["x"], "y": round(fr["y"] + bl_h + kerf_val, 1), "w": bl_w, "h": rem_h})

                tot_placed = len(placed_blanks)
                placed_area = sum(b["w"] * b["h"] for b in placed_blanks)
                yield_val = round((placed_area / (s_len * s_wid)) * 100, 2)
                waste_val = round(100.0 - yield_val, 2)
                max_rem = max([fr["w"] * fr["h"] for fr in free_rects], default=0.0)

                candidates.append({
                    "name": f"Guillotine Block Nesting ({split_axis.capitalize()} Cut)",
                    "placements": placed_blanks,
                    "blocks": placed_blocks,
                    "total_blanks": tot_placed,
                    "yield_pct": yield_val,
                    "waste_pct": waste_val,
                    "free_rects": free_rects,
                    "max_rem": max_rem
                })

        if not candidates:
            return {
                "success": False,
                "error": "No parts could fit inside the provided container.",
                "total_blanks": 0,
                "yield_pct": 0.0,
                "waste_pct": 100.0,
                "placements": [],
                "remnants": [],
                "parts_summary": []
            }

        # Select layout that maximizes parts placed, yield %, and largest rectangular offcut
        best = max(
            candidates,
            key=lambda c: (
                c["total_blanks"],
                c["yield_pct"],
                c["max_rem"]
            )
        )

        actual_places = best["placements"]
        tot_count = len(actual_places)
        yield_pct = best["yield_pct"]
        waste_pct = best["waste_pct"]

        # Build parts summary (requested vs placed)
        placed_counts_by_idx = {}
        for p in actual_places:
            idx = p["part_idx"]
            placed_counts_by_idx[idx] = placed_counts_by_idx.get(idx, 0) + 1

        parts_summary = []
        for p in parts_list:
            p_idx = p["part_idx"]
            pl_qty = placed_counts_by_idx.get(p_idx, 0)
            parts_summary.append({
                "part_no": p["part_no"],
                "part_idx": p_idx,
                "row_id": p.get("row_id"),
                "length": p["length"],
                "width": p["width"],
                "requested_qty": p["qty"],
                "placed_qty": pl_qty,
                "color": p["color"],
                "border_color": p["border_color"],
                "status": "FITS_ALL" if pl_qty >= p["qty"] else ("PARTIAL" if pl_qty > 0 else "SHORTAGE"),
                "area_sq_mm": round(p["length"] * p["width"] * pl_qty, 1)
            })

        # Calculate reusable end-bit remnants
        remnant_boxes = []
        for fr in best["free_rects"]:
            fw = round(fr["w"], 1)
            fh = round(fr["h"], 1)
            if (fw >= 50 and fh >= 30) or (fw >= 30 and fh >= 50):
                remnant_boxes.append({
                    "name": "Reusable End-Bit",
                    "length": max(fw, fh),
                    "width": min(fw, fh),
                    "area_sq_mm": round(fw * fh, 1),
                    "x": round(fr["x"], 1),
                    "y": round(fr["y"], 1)
                })
        remnant_boxes.sort(key=lambda r: r["area_sq_mm"], reverse=True)

        # OptiCutter CSV Representation
        csv_lines = [
            f"# OptiCutter Cut List Export ({best['name']})",
            "# Panels (Stock Sheets/Offcuts)",
            "Length,Width,Qty,Material,Label",
            f"{int(s_len)},{int(s_wid)},1,Steel,Sheet-Container",
            "",
            "# Items (Cut Blanks)",
            "Length,Width,Qty,Material,Label,Can Rotate"
        ]
        can_rot_flag = 1 if (strategy_mode == "auto" and can_rotate) else 0
        for ps in parts_summary:
            csv_lines.append(f"{round(ps['length'], 1)},{round(ps['width'], 1)},{ps['requested_qty']},Steel,{ps['part_no']},{can_rot_flag}")
        opticutter_csv = "\n".join(csv_lines) + "\n"

        parts_desc = ", ".join([f"{ps['placed_qty']}x {ps['part_no']}" for ps in parts_summary])
        summary_text = (
            f"Guillotine Block Nesting: Fits {tot_count} blanks ({parts_desc}) "
            f"on {int(s_len)}*{int(s_wid)} mm with {yield_pct}% material yield ({waste_pct}% scrap)."
        )

        return {
            "success": True,
            "is_multi_part": True,
            "sheet_length": s_len,
            "sheet_width": s_wid,
            "kerf": kerf_val,
            "total_blanks": tot_count,
            "total_requested": sum(p["qty"] for p in parts_list),
            "yield_pct": yield_pct,
            "waste_pct": waste_pct,
            "strategy": best["name"],
            "blocks": best.get("blocks", []),
            "placements": actual_places,
            "parts_summary": parts_summary,
            "remnants": remnant_boxes,
            "summary_text": summary_text,
            "opticutter_csv": opticutter_csv,
            "opticutter_url": "https://www.opticutter.com/cut-list-optimizer"
        }

    def _optimize_single_part_guillotine(
        self,
        s_len: float,
        s_wid: float,
        b_len: float,
        b_wid: float,
        part_no: str,
        can_rotate: bool,
        kerf_val: float,
        target_qty: Optional[int],
        strategy_mode: str
    ) -> Dict[str, Any]:
        """
        Single-part industrial-grade guillotine packing matching OptiCutter.
        Evaluates uniform grids and multi-block guillotine split strategies.
        """
        candidates = []

        # Strategy 1: Pure Uniform Lengthwise Grid (0°)
        if strategy_mode in ("auto", "longitudinal"):
            nx = int(s_len // (b_len + kerf_val))
            ny = int(s_wid // (b_wid + kerf_val))
            places = []
            for ix in range(nx):
                for iy in range(ny):
                    places.append({
                        "x": round(ix * (b_len + kerf_val), 1),
                        "y": round(iy * (b_wid + kerf_val), 1),
                        "w": round(b_len, 1),
                        "h": round(b_wid, 1),
                        "rotated": False,
                        "part_no": part_no,
                        "part_idx": 0,
                        "color": PART_COLORS[0]["bg"],
                        "border_color": PART_COLORS[0]["border"]
                    })
            rem_x = s_len - (nx * (b_len + kerf_val))
            rem_y = s_wid - (ny * (b_wid + kerf_val))
            candidates.append({
                "name": "Uniform Lengthwise (0° Fixed)",
                "places": places,
                "count": len(places),
                "rem_x": rem_x,
                "rem_y": rem_y,
                "split_line": None,
                "blocks": [{"x": 0, "w": round(nx * (b_len + kerf_val), 1), "cols": nx, "rows": ny, "bw": b_len, "bh": b_wid, "rem_h": round(rem_y, 1)}],
                "primary_parts": len(places),
                "can_rot_export": 0
            })

        # Strategy 2: Pure Uniform Transverse Grid (90°)
        if strategy_mode in ("auto", "transverse"):
            nx = int(s_len // (b_wid + kerf_val))
            ny = int(s_wid // (b_len + kerf_val))
            places = []
            for ix in range(nx):
                for iy in range(ny):
                    places.append({
                        "x": round(ix * (b_wid + kerf_val), 1),
                        "y": round(iy * (b_len + kerf_val), 1),
                        "w": round(b_wid, 1),
                        "h": round(b_len, 1),
                        "rotated": True,
                        "part_no": part_no,
                        "part_idx": 0,
                        "color": PART_COLORS[0]["bg"],
                        "border_color": PART_COLORS[0]["border"]
                    })
            rem_x = s_len - (nx * (b_wid + kerf_val))
            rem_y = s_wid - (ny * (b_len + kerf_val))
            candidates.append({
                "name": "Uniform Transverse (90° Fixed)",
                "places": places,
                "count": len(places),
                "rem_x": rem_x,
                "rem_y": rem_y,
                "split_line": None,
                "blocks": [{"x": 0, "w": round(nx * (b_wid + kerf_val), 1), "cols": nx, "rows": ny, "bw": b_wid, "bh": b_len, "rem_h": round(rem_y, 1)}],
                "primary_parts": 0,
                "can_rot_export": 0
            })

        # Strategy 3: Multi-Block 2D Guillotine Splits (OptiCutter Industrial Cutting)
        if strategy_mode in ("auto", "hybrid"):
            for (l1, w1, r1), (l2, w2, r2) in [
                ((b_len, b_wid, False), (b_wid, b_len, True)),
                ((b_wid, b_len, True), (b_len, b_wid, False))
            ]:
                nx1 = int(s_len // (l1 + kerf_val))
                ny1 = int(s_wid // (w1 + kerf_val))
                min_cols = 2 if nx1 >= 4 else 1

                for k in range(min_cols, nx1):
                    x_split = round(k * (l1 + kerf_val), 1)
                    x_rem = s_len - x_split
                    min_rem_cols = 2 if int(s_len // l2) >= 4 else 1
                    if x_rem < (min_rem_cols * (l2 + kerf_val)):
                        continue
                    nx2 = int(x_rem // (l2 + kerf_val))
                    ny2 = int(s_wid // (w2 + kerf_val))
                    if nx2 < min_rem_cols or ny2 == 0:
                        continue

                    p1 = []
                    for ix in range(k):
                        for iy in range(ny1):
                            p1.append({
                                "x": round(ix * (l1 + kerf_val), 1),
                                "y": round(iy * (w1 + kerf_val), 1),
                                "w": round(l1, 1),
                                "h": round(w1, 1),
                                "rotated": r1,
                                "part_no": part_no,
                                "part_idx": 0,
                                "color": PART_COLORS[0]["bg"],
                                "border_color": PART_COLORS[0]["border"]
                            })
                    p2 = []
                    for ix in range(nx2):
                        for iy in range(ny2):
                            p2.append({
                                "x": round(x_split + ix * (l2 + kerf_val), 1),
                                "y": round(iy * (w2 + kerf_val), 1),
                                "w": round(l2, 1),
                                "h": round(w2, 1),
                                "rotated": r2,
                                "part_no": part_no,
                                "part_idx": 0,
                                "color": PART_COLORS[0]["bg"],
                                "border_color": PART_COLORS[0]["border"]
                            })

                    combined = p1 + p2
                    block1_rem_y = round(s_wid - ny1 * (w1 + kerf_val), 1)
                    block2_rem_y = round(s_wid - ny2 * (w2 + kerf_val), 1)
                    total_used_x = round(x_split + nx2 * (l2 + kerf_val), 1)
                    rem_x_tot = round(s_len - total_used_x, 1)

                    candidates.append({
                        "name": f"Guillotine 2-Block (Vertical Cut at {int(x_split)}mm)",
                        "places": combined,
                        "count": len(combined),
                        "rem_x": rem_x_tot,
                        "rem_y": min(block1_rem_y, block2_rem_y),
                        "split_line": {"axis": "x", "val": x_split},
                        "blocks": [
                            {"x": 0, "w": x_split, "cols": k, "rows": ny1, "bw": l1, "bh": w1, "rem_h": block1_rem_y},
                            {"x": x_split, "w": round(nx2 * (l2 + kerf_val), 1), "cols": nx2, "rows": ny2, "bw": l2, "bh": w2, "rem_h": block2_rem_y}
                        ],
                        "primary_parts": len(p1) if not r1 else 0,
                        "can_rot_export": 1
                    })

        if not candidates:
            return {
                "success": False,
                "error": "No parts could fit inside the provided container.",
                "total_blanks": 0,
                "yield_pct": 0.0,
                "waste_pct": 100.0,
                "placements": [],
                "remnants": [],
                "parts_summary": []
            }

        best = max(
            candidates,
            key=lambda c: (
                c["count"],
                c.get("primary_parts", 0),
                -round(c.get("rem_x", 0) + c.get("rem_y", 0), 1)
            )
        )

        actual_places = best["places"]
        if target_qty and target_qty > 0 and len(actual_places) > target_qty:
            actual_places = actual_places[:target_qty]

        tot_count = len(actual_places)
        area_parts = tot_count * (b_len * b_wid)
        area_sheet = s_len * s_wid
        yield_pct = round((area_parts / area_sheet) * 100, 2)
        waste_pct = round(100.0 - yield_pct, 2)

        # Compute remaining large offcuts (End Bits)
        remnant_boxes = []
        rem_x = best.get("rem_x", 0)
        rem_y = best.get("rem_y", 0)
        if rem_x >= 100 and s_wid >= 50:
            remnant_boxes.append({
                "name": "Length-Endbit",
                "length": round(s_wid, 1),
                "width": round(rem_x, 1),
                "area_sq_mm": round(s_wid * rem_x, 1)
            })
        if rem_y >= 100 and s_len >= 50:
            remnant_boxes.append({
                "name": "Width-Endbit",
                "length": round(s_len, 1),
                "width": round(rem_y, 1),
                "area_sq_mm": round(s_len * rem_y, 1)
            })

        # OptiCutter CSV Representation
        can_rot_flag = best.get("can_rot_export", 1)
        opticutter_csv = (
            f"# OptiCutter Cut List Export ({best['name']})\n"
            f"# Panels (Stock Sheets/Offcuts)\n"
            f"Length,Width,Qty,Material,Label\n"
            f"{int(s_len)},{int(s_wid)},1,Steel,Sheet-Container\n\n"
            f"# Items (Cut Blanks)\n"
            f"Length,Width,Qty,Material,Label,Can Rotate\n"
            f"{round(b_len, 1)},{round(b_wid, 1)},{tot_count},Steel,{part_no},{can_rot_flag}\n"
        )

        parts_summary = [{
            "part_no": part_no,
            "part_idx": 0,
            "length": b_len,
            "width": b_wid,
            "requested_qty": target_qty or tot_count,
            "placed_qty": tot_count,
            "color": PART_COLORS[0]["bg"],
            "border_color": PART_COLORS[0]["border"],
            "status": "FITS_ALL" if (target_qty is None or tot_count >= target_qty) else "PARTIAL",
            "area_sq_mm": round(area_parts, 1)
        }]

        return {
            "success": True,
            "is_multi_part": False,
            "sheet_length": s_len,
            "sheet_width": s_wid,
            "blank_length": b_len,
            "blank_width": b_wid,
            "part_no": part_no,
            "can_rotate": can_rot_flag == 1,
            "kerf": kerf_val,
            "total_blanks": tot_count,
            "total_requested": target_qty or tot_count,
            "yield_pct": yield_pct,
            "waste_pct": waste_pct,
            "strategy": best["name"],
            "split_line": best.get("split_line"),
            "blocks": best.get("blocks", []),
            "placements": actual_places,
            "parts_summary": parts_summary,
            "remnants": remnant_boxes,
            "summary_text": (
                f"Optimized Nesting: Fits {tot_count} blanks on {int(s_len)}*{int(s_wid)} mm "
                f"with {yield_pct}% material yield ({waste_pct}% scrap) via {best['name']}."
            ),
            "opticutter_csv": opticutter_csv,
            "opticutter_url": "https://www.opticutter.com/cut-list-optimizer"
        }


# Singleton instance
CUT_OPTIMIZER_2D = CutListOptimizer2D()
