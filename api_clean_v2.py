"""
SheetLayout AI — Clean API Blueprint (v2)
Exposes REST endpoints for the redesigned Create Material Order modal and 7-table architecture:
- /api/v2/search-parts
- /api/v2/part-details/<part_no>
- /api/v2/rm-stock/<rm_code>
- /api/v2/optimize-cut
- /api/v2/create-mo
- /api/v2/list-mos
"""

import math
from flask import Blueprint, request, jsonify
import db_clean as db
from cut_optimizer import CUT_OPTIMIZER_2D

api_v2_bp = Blueprint('api_v2', __name__, url_prefix='/api/v2')

@api_v2_bp.route('/search-parts', methods=['GET'])
def search_parts_endpoint():
    """Search parts master by query string"""
    q = request.args.get('q', '').strip()
    limit = int(request.args.get('limit', 20))
    parts = db.search_parts(query=q, limit=limit)
    return jsonify({
        "success": True,
        "count": len(parts),
        "parts": parts
    })

@api_v2_bp.route('/part-details/<path:part_no>', methods=['GET'])
def get_part_details_endpoint(part_no):
    """
    Fetch comprehensive part specs, matching RMs from rm table, and live MRP demand.
    """
    part = db.get_part(part_no)
    if not part:
        return jsonify({"success": False, "error": f"Part '{part_no}' not found"}), 404

    grade = part.get('grade')
    thickness = part.get('thickness')

    # 1. Fetch matching RMs from rm table
    matching_rms = db.get_rms_by_spec(grade=grade, thickness=thickness)

    # 2. Fetch MRP demand
    mrp_record = db.get_mrp_for_part(part_no) or {}

    # 3. Fetch past ERP MOs
    past_mos = db.get_mos_for_part(part_no, limit=5)

    return jsonify({
        "success": True,
        "part": part,
        "matching_rms": matching_rms,
        "mrp": {
            "monthly_schedule": mrp_record.get("monthly_schedule", 0),
            "current_stock": mrp_record.get("current_stock", 0),
            "qty_to_produce": mrp_record.get("qty_to_produce", 0)
        },
        "past_mos": past_mos
    })

@api_v2_bp.route('/rm-stock/<path:rm_code>', methods=['GET'])
def get_rm_stock_endpoint(rm_code):
    """Get live stock and weight for an RM sheet"""
    rm = db.get_rm(rm_code)
    if not rm:
        return jsonify({"success": False, "error": "RM not found"}), 404
    return jsonify({
        "success": True,
        "rm_code": rm.get("rm_code"),
        "available_sheets": rm.get("available_sheets", 0),
        "weight_per_sheet": rm.get("weight_per_sheet", 0),
        "total_stock_weight": rm.get("total_stock_weight", 0)
    })

@api_v2_bp.route('/optimize-cut', methods=['POST'])
def optimize_cut_endpoint():
    """
    Runs 2D cut optimizer for selected RM sheet and parts list.
    Payload:
    {
        "rm_sheet": {"length": 2500, "width": 1250, "thickness": 2.0, "grade": "CRCA"},
        "sheets_count": 10,
        "parts": [
            {"part_no": "P1", "length": 350, "width": 180, "target_qty": 100}
        ]
    }
    """
    data = request.get_json() or {}
    rm_info = data.get("rm_sheet", {})
    sheets_count = max(1, int(data.get("sheets_count", 1)))
    parts_list = data.get("parts", [])

    if not parts_list:
        return jsonify({"success": False, "error": "No parts provided for cutting"}), 400

    sheet_w = float(rm_info.get("width", 1250))
    sheet_l = float(rm_info.get("length", 2500))
    sheet_t = float(rm_info.get("thickness", 2.0))
    grade = rm_info.get("grade", "CRCA")

    # Simple mathematical layout & yield computation
    sheet_area = sheet_w * sheet_l
    total_parts_area = 0
    parts_breakdown = []

    for p in parts_list:
        p_no = p.get("part_no")
        pw = float(p.get("width", 100))
        pl = float(p.get("length", 100))
        part_area = pw * pl

        # Calculate best orientation on sheet
        fit1 = (sheet_w // pw) * (sheet_l // pl)
        fit2 = (sheet_w // pl) * (sheet_l // pw)
        per_sheet = max(fit1, fit2, 1)

        total_produced = int(per_sheet * sheets_count)
        total_parts_area += (part_area * total_produced)

        parts_breakdown.append({
            "part_no": p_no,
            "parts_per_sheet": int(per_sheet),
            "total_produced": total_produced,
            "part_area_sqmm": part_area
        })

    # Yield %
    total_sheet_area = sheet_area * sheets_count
    yield_pct = min(99.0, round((total_parts_area / total_sheet_area) * 100, 2)) if total_sheet_area > 0 else 0

    # Endbit estimation
    # Approx remaining area
    remaining_area_per_sheet = max(0, sheet_area - (total_parts_area / sheets_count))
    # Density for steel approx 7.85 g/cm3 = 0.00000785 kg/mm3
    density = 0.00000785
    endbit_wt_single = round(remaining_area_per_sheet * sheet_t * density, 3)
    total_endbit_wt = round(endbit_wt_single * sheets_count, 2)

    endbit_summary = ""
    if yield_pct < 90 and remaining_area_per_sheet > (200 * 500):
        # Suggest an offcut dimension
        est_l = round(sheet_l * (1 - (yield_pct / 100)))
        endbit_summary = f"{grade}-{sheet_t}x{sheet_w}x{est_l}"

    return jsonify({
        "success": True,
        "yield_pct": yield_pct,
        "sheets_count": sheets_count,
        "parts_breakdown": parts_breakdown,
        "total_parts_produced": sum(p["total_produced"] for p in parts_breakdown),
        "endbit_desc": endbit_summary,
        "endbit_weight_single": endbit_wt_single,
        "total_endbit_weight": total_endbit_wt
    })

@api_v2_bp.route('/create-mo', methods=['POST'])
def create_mo_endpoint():
    """
    Submits a new Material Order:
    - Inserts into app_mo
    - Deducts from rm sheet stock
    - Logs generated endbit batch
    - Updates audit trail
    """
    data = request.get_json() or {}
    if not data.get("rm_code"):
        return jsonify({"success": False, "error": "RM Code is required"}), 400

    result = db.create_app_mo(data)
    if result.get("success"):
        return jsonify(result), 201
    return jsonify(result), 400

@api_v2_bp.route('/list-mos', methods=['GET'])
def list_mos_endpoint():
    """Fetch recent app MOs"""
    status = request.args.get('status')
    stage = request.args.get('stage')
    limit = int(request.args.get('limit', 50))
    mos = db.list_app_mos(status=status, stage=stage, limit=limit)
    return jsonify({"success": True, "count": len(mos), "mos": mos})

@api_v2_bp.route('/suggest-coproduction-parts', methods=['GET', 'POST'])
def suggest_coproduction_endpoint():
    """AI Co-Production Agent endpoint in v2 API"""
    from part_coproduction_agent import PartCoProductionAgent
    agent = PartCoProductionAgent()
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
    else:
        data = request.args.to_dict()

    base_part = data.get("base_part") or data.get("part_no")
    sheet_len = float(data.get("sheet_length") or 2500)
    sheet_wid = float(data.get("sheet_width") or 1250)
    grade = data.get("grade")
    thickness = float(data.get("thickness")) if data.get("thickness") else None
    base_blanks = int(data.get("base_blanks")) if data.get("base_blanks") else None
    filter_mode = data.get("filter_mode") or "all"
    current_parts = data.get("current_parts") or []
    if isinstance(current_parts, str):
        current_parts = [p.strip() for p in current_parts.split(",") if p.strip()]

    result = agent.suggest_parts(
        base_part_no=base_part,
        sheet_length=sheet_len,
        sheet_width=sheet_wid,
        grade=grade,
        thickness=thickness,
        base_blanks_qty=base_blanks,
        current_parts=current_parts,
        filter_mode=filter_mode
    )
    return jsonify(result)
