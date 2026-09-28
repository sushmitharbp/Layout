import werkzeug
if not hasattr(werkzeug, '__version__'):
    try:
        import importlib.metadata
        werkzeug.__version__ = importlib.metadata.version('werkzeug')
    except Exception:
        werkzeug.__version__ = "3.1.3"

import os
import json
import re
import time
from flask import Flask, render_template, request, jsonify, send_from_directory, session, redirect, url_for

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "sheetlayout-super-secret-key-2026")

# Load data store from Supabase database (with fallback to local data_store.json)
from db_supabase import load_data_store

DATA_STORE, DATA_SOURCE = load_data_store()

PARTS = DATA_STORE["parts"]
BASE_PARTS = DATA_STORE["base_parts"]
SAMPLES = DATA_STORE["samples"]
STATS = DATA_STORE["stats"]
ALL_RECORDS = DATA_STORE["records"]

from sheet_intelligence import SheetIntelligenceEngine
SHEET_AI = SheetIntelligenceEngine(DATA_STORE)

print(f"[{DATA_SOURCE.upper()}] Loaded {len(PARTS)} unique parts, {len(BASE_PARTS)} base parts, {len(ALL_RECORDS)} records.")
print("Sheet Intelligence Engine initialized.")

def normalize_key(s):
    if not s: return ""
    return re.sub(r'[^a-zA-Z0-9]', '', str(s)).lower()

# Build fast normalized lookup tables
NORM_PARTS = {}
for p_no, p_data in PARTS.items():
    NORM_PARTS[normalize_key(p_no)] = p_no

NORM_BASE_PARTS = {}
for b_no, b_data in BASE_PARTS.items():
    NORM_BASE_PARTS[normalize_key(b_no)] = b_no


def find_parts_by_query(query):
    """Fuzzy / prefix / normalized search for part numbers"""
    q_clean = query.strip()
    q_norm = normalize_key(q_clean)
    if not q_norm:
        return []

    # 1. Exact match in PARTS
    if q_clean in PARTS:
        return [q_clean]
    
    # 2. Exact match in normalized parts
    if q_norm in NORM_PARTS:
        return [NORM_PARTS[q_norm]]
        
    # 3. Base part match
    if q_clean in BASE_PARTS:
        return BASE_PARTS[q_clean]["item_parts"]
    if q_norm in NORM_BASE_PARTS:
        b_key = NORM_BASE_PARTS[q_norm]
        return BASE_PARTS[b_key]["item_parts"]
        
    # 4. Prefix or substring match
    matches = []
    # Check if query matches base part
    for b_no, b_data in BASE_PARTS.items():
        if q_norm in normalize_key(b_no):
            matches.extend(b_data["item_parts"])
            
    # Check parts
    for p_no in PARTS:
        if q_norm in normalize_key(p_no) and p_no not in matches:
            matches.append(p_no)
            if len(matches) >= 15:
                break
                
    return matches[:15]


DEPARTMENT_CREDENTIALS = {
    "shearing": {
        "username": "shearing",
        "name": "Shearing (Production) Team",
        "title": "Shearing Production Workspace",
        "badge": "Production",
        "icon": "fa-industry",
        "role": "shearing",
        "desc": "Create Manufacturing Orders, select cutting layouts, verify stock constraints, and route for approvals."
    },
    "krysalis": {
        "username": "krysalis",
        "name": "Consultants (Krysalis) Team",
        "title": "Consultants (Krysalis) Layout Review",
        "badge": "Design & Layout",
        "icon": "fa-compass-drafting",
        "role": "krysalis",
        "desc": "Review and verify non-standard layout documents, technical blank nesting, and cutting plan feasibility."
    },
    "purchase": {
        "username": "purchase",
        "name": "Purchase Team",
        "title": "Purchase & Procurement Clearance",
        "badge": "Procurement",
        "icon": "fa-cart-shopping",
        "role": "purchase",
        "desc": "Review raw material coil stock shortages, material yields, steel grade pricing, and supplier clearances."
    },
    "erp": {
        "username": "erp",
        "name": "ERP Team",
        "title": "ERP Master Data & Release Gateway",
        "badge": "ERP Systems",
        "icon": "fa-network-wired",
        "role": "erp",
        "desc": "Final authorization and release of fast-tracked standard orders and purchase-cleared MOs to live ERP."
    }
}


@app.route("/")
def index():
    """First, user must login; otherwise redirect to role workspace"""
    role = session.get("role")
    if not role or role not in DEPARTMENT_CREDENTIALS:
        return redirect(url_for("login"))
    return redirect(url_for("dashboard"))


@app.route("/login", methods=["GET", "POST"])
def login():
    """Department Login page"""
    if request.method == "POST":
        role = request.form.get("role") or (request.json or {}).get("role")
        if role in DEPARTMENT_CREDENTIALS:
            session["role"] = role
            session["user_name"] = DEPARTMENT_CREDENTIALS[role]["name"]
            if request.is_json:
                return jsonify({"success": True, "redirect": url_for("dashboard")})
            return redirect(url_for("dashboard"))
        return render_template("login.html", error="Please select a valid department.", departments=DEPARTMENT_CREDENTIALS)

    if session.get("role") in DEPARTMENT_CREDENTIALS:
        return redirect(url_for("dashboard"))

    return render_template("login.html", departments=DEPARTMENT_CREDENTIALS)


@app.route("/logout")
def logout():
    """Sign out of current department"""
    session.clear()
    return redirect(url_for("login"))


@app.route("/dashboard")
@app.route("/mo")
@app.route("/mo_portal")
def dashboard():
    """Role-based Workspace with Floating Chatbot in bottom-right corner"""
    role = session.get("role")
    if not role or role not in DEPARTMENT_CREDENTIALS:
        # Default fallback to shearing for instant access
        session["role"] = "shearing"
        session["user_name"] = DEPARTMENT_CREDENTIALS["shearing"]["name"]
        role = "shearing"

    user_info = DEPARTMENT_CREDENTIALS[role]
    return render_template(
        "mo_portal.html",
        current_role=role,
        user_info=user_info,
        roles=ROLES,
        stats=STATS,
        samples=SAMPLES
    )


@app.route("/chat-full")
def chat_full():
    """Full-screen Chatbot canvas view"""
    return render_template("index.html", stats=STATS, samples=SAMPLES)


@app.route("/api/stats")
def get_stats():
    return jsonify(STATS)


@app.route("/api/samples")
def get_samples():
    return jsonify(SAMPLES)


@app.route("/api/search")
def search_parts():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify([])
    
    q_norm = normalize_key(q)
    results = []
    seen = set()

    # Search in parts
    for p_no in PARTS:
        if q_norm in normalize_key(p_no):
            if p_no not in seen:
                seen.add(p_no)
                records = PARTS[p_no]["records"]
                results.append({
                    "part_no": p_no,
                    "base_part": PARTS[p_no]["base_part"],
                    "rm_count": len(records),
                    "standardized_rm": next((r["rm_erp"] for r in records if "standardized" in r["status"].lower()), records[0]["rm_erp"] if records else None)
                })
        if len(results) >= 10:
            break
            
    return jsonify(results)


@app.route("/api/part/<path:part_no>")
def get_part_details(part_no):
    part_clean = part_no.strip()
    if part_clean in PARTS:
        return jsonify(PARTS[part_clean])
    
    q_norm = normalize_key(part_clean)
    if q_norm in NORM_PARTS:
        return jsonify(PARTS[NORM_PARTS[q_norm]])
    
    # Try finding matches
    matches = find_parts_by_query(part_clean)
    if matches and matches[0] in PARTS:
        return jsonify(PARTS[matches[0]])
        
    return jsonify({"error": "Part not found"}), 404


@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.json or {}
    message = (data.get("message") or "").strip()
    current_part = data.get("current_part")
    current_rm = data.get("current_rm")

    if not message:
        return jsonify({
            "reply": "Please enter a Part Number (for example, `MBA01008 - Item 1` or `MBA01008`) to view its RM ERP codes and fetch layout drawings.",
            "type": "help",
            "actions": [{"label": s["part_no"], "action": "search", "value": s["part_no"]} for s in SAMPLES[:4]]
        })

    msg_lower = message.lower()
    
    # 1. Check if user is asking for layout of a specific RM ERP code or current part
    layout_trigger_words = ["layout", "fetch layout", "show layout", "diagram", "blueprint", "image", "drawing"]
    is_layout_request = any(word in msg_lower for word in layout_trigger_words)
    
    # Check if an RM ERP code is directly mentioned in message (e.g. 4.8*2350*1500)
    rm_match = re.search(r'(\d+(?:\.\d+)?\s*\*\s*\d+(?:\.\d+)?\s*\*\s*\d+(?:\.\d+)?)', message)
    target_rm = rm_match.group(1).replace(" ", "") if rm_match else None

    # Case A: User selected an RM ERP code or explicitly requested layout for current part
    if (is_layout_request or target_rm) and current_part and current_part in PARTS:
        records = PARTS[current_part]["records"]
        target_rec = None
        
        if target_rm:
            # find record with this rm
            for r in records:
                if r["rm_erp"] and normalize_key(target_rm) in normalize_key(r["rm_erp"]):
                    target_rec = r
                    break
        elif "2nd" in msg_lower:
            target_rec = next((r for r in records if "2nd" in r["status"].lower()), None)
        elif "non" in msg_lower:
            target_rec = next((r for r in records if "non" in r["status"].lower()), None)
        else:
            # Default to standardized or first with image
            target_rec = next((r for r in records if "standardized" in r["status"].lower() and r["image_url"]), None)
            if not target_rec:
                target_rec = next((r for r in records if r["image_url"]), records[0])

        if target_rec:
            is_second = "2nd" in target_rec.get("status", "").lower()
            plan_title = "Standardized Layout Plan - 2" if is_second else "Standardized Layout Plan - 1"
            reply_text = f"Here is the standardized engineering print sheet for **{current_part}** ({plan_title}) with RM ERP Code `{target_rec['rm_erp']}`."
            
            # Comparison records (all records for this part)
            comp_records = [r for r in records]
            
            return jsonify({
                "reply": reply_text,
                "type": "print_sheet",
                "plan_title": plan_title,
                "part_no": current_part,
                "record": target_rec,
                "comparison_records": comp_records,
                "all_rm_codes": [r["rm_erp"] for r in records if r["rm_erp"]],
                "actions": [
                    {"label": f"Switch to {r['rm_erp']} ({r.get('grade') or 'YS'} - {r['status']})", "action": "fetch_layout", "value": r["rm_erp"]}
                    for r in records if r != target_rec and r["rm_erp"]
                ]
            })

    # Case A.2: Check for ERP Intelligence / MO Report / Stock / MRP Queries
    is_mo_history_query = any(k in msg_lower for k in ["previous mo", "past mo", "mo history", "mo report", "mos created", "earlier mo"])
    is_rm_stock_query = any(k in msg_lower for k in ["rm stock", "main store", "raw material stock", "opening stock of rm", "rm opening"])
    is_part_stock_query = any(k in msg_lower for k in ["parts opening", "parts stock", "fg stock", "wip stock", "opening stock for part", "fg & wip"])
    is_mrp_query = any(k in msg_lower for k in ["monthly schedule", "mrp schedule", "sales schedule", "schedule from mrp", "schedule for the part"])
    is_clearance_query = any(k in msg_lower for k in ["clearance", "stock check", "can we shear", "inventory check"])

    if is_mo_history_query or is_rm_stock_query or is_part_stock_query or is_mrp_query or is_clearance_query:
        # Detect part or rm code from query or current context
        detected_parts = SHEET_AI.extract_part_numbers(message) or find_parts_by_query(message)
        if not detected_parts:
            for t in re.findall(r'[a-zA-Z0-9_-]{4,}', message):
                tk = normalize_key(t)
                if tk in ERP_STOCK_SERVICE.previous_mos or tk in ERP_STOCK_SERVICE.parts_stock or tk in ERP_STOCK_SERVICE.mrp_schedule:
                    detected_parts.append(t)
                    break

        query_part = detected_parts[0] if detected_parts else current_part
        query_rm = target_rm or current_rm
        if not query_rm:
            for t in re.findall(r'[a-zA-Z0-9_.*-]{4,}', message):
                tk = normalize_key(t)
                if tk in ERP_STOCK_SERVICE.rm_stock or tk in ERP_STOCK_SERVICE.previous_mos_by_rm:
                    query_rm = t
                    break

        # If previous MO history requested
        if is_mo_history_query and (query_part or query_rm):
            mos = ERP_STOCK_SERVICE.get_previous_mos(query_part or "", rm_code=query_rm)
            if mos:
                mo_rows = []
                for m in mos[:6]:
                    mo_rows.append(f"• **MO Doc #{m['mo_doc_no']}** | Date: `{m.get('doc_date') or '-'}` | Status: `{m.get('status')}` | Sheets: **{m.get('no_of_sheets') or '-'}** | Plan: `{m.get('cutting_plan_no') or '-'}` | Parent: `{m.get('parent_code') or '-'}`")
                reply = f"Found **{len(mos)} previous Manufacturing Order(s)** in ERP for **{query_part or query_rm}**:\n\n" + "\n".join(mo_rows)
                if len(mos) > 6:
                    reply += f"\n\n*(Showing top 6 of {len(mos)} previous orders)*"
                return jsonify({
                    "reply": reply,
                    "type": "erp_intelligence",
                    "part_no": query_part,
                    "records": mos
                })
            else:
                return jsonify({
                    "reply": f"No previous MO records found in ERP MO Report for **{query_part or query_rm}**.",
                    "type": "info"
                })

        # If RM stock query
        if is_rm_stock_query and (query_rm or query_part):
            rm_code_to_check = query_rm
            if not rm_code_to_check and query_part and query_part in PARTS:
                recs = PARTS[query_part]["records"]
                if recs:
                    rm_code_to_check = recs[0].get("rm_erp")
            
            rm_data = ERP_STOCK_SERVICE.get_rm_opening_stock(rm_code_to_check or "")
            if rm_data:
                wt_val = rm_data.get('total_weight')
                wt_str = f"{float(wt_val):,.1f} kg" if wt_val else "-"
                price_str = f"₹{rm_data.get('last_po_price')}" if rm_data.get('last_po_price') else "N/A"
                reply = (
                    f"📦 **RM Opening Stock (Main Store)** for `{rm_data.get('item_code')}`:\n\n"
                    f"• **Onhand Stock:** **{rm_data.get('onhand_stock')} Sheets**\n"
                    f"• **Total Weight:** {wt_str}\n"
                    f"• **Description:** {rm_data.get('item_desc')}\n"
                    f"• **Last PO Price:** {price_str}\n"
                    f"• **UOM:** {rm_data.get('uom', 'NOS')}"
                )
                return jsonify({"reply": reply, "type": "erp_intelligence", "data": rm_data})
            else:
                return jsonify({"reply": f"No RM stock record found in Main Store for `{rm_code_to_check}`.", "type": "info"})

        # If parts stock (FG & WIP) query
        if is_part_stock_query and query_part:
            fg_items = ERP_STOCK_SERVICE.get_parts_opening_stock(query_part)
            if fg_items:
                total_qty = sum(it.get("onhand_stock", 0) for it in fg_items)
                item_lines = [f"• **{it['item_code']}** ({it.get('category', 'Stock')}): **{it.get('onhand_stock', 0)} Nos**" for it in fg_items[:5]]
                reply = f"🏭 **Parts Opening Stock (002 - FG & WIP)** for **{query_part}**:\n\n• **Total Onhand:** **{total_qty} Nos** across {len(fg_items)} item(s)\n" + "\n".join(item_lines)
                return jsonify({"reply": reply, "type": "erp_intelligence", "items": fg_items})
            else:
                return jsonify({"reply": f"No opening stock records found in 002 - FG & WIP for **{query_part}**.", "type": "info"})

        # If MRP monthly schedule query
        if is_mrp_query and query_part:
            mrp_data = ERP_STOCK_SERVICE.get_mrp_monthly_schedule(query_part)
            if mrp_data:
                first = mrp_data[0].get("monthly_schedule", {})
                w1, w2, w3, w4, w5 = first.get("wk1", 0), first.get("wk2", 0), first.get("wk3", 0), first.get("wk4", 0), first.get("wk5", 0)
                tot = first.get("monthly_total", 0)
                bal = first.get("balance_planning", 0)
                reply = (
                    f"📅 **MRP Monthly Planning Schedule** for **{query_part}**:\n\n"
                    f"• **Total Monthly Target:** **{tot} Nos**\n"
                    f"• **Weekly Plan:** W1: {w1} | W2: {w2} | W3: {w3} | W4: {w4} | W5: {w5}\n"
                    f"• **Stock at Planning:** {first.get('fg_pc_stock', 0)} Nos\n"
                    f"• **Balance for Planning:** {bal} Nos"
                )
                return jsonify({"reply": reply, "type": "erp_intelligence", "mrp": mrp_data})
            else:
                return jsonify({"reply": f"No active schedule found in Sales MRP for **{query_part}**.", "type": "info"})

        # Comprehensive Clearance Query
        if query_part:
            intel = ERP_STOCK_SERVICE.get_part_comprehensive_intelligence(query_part, rm_code=query_rm)
            onhand_rm = intel["rm_opening_stock"].get("onhand_stock", 0) if intel["rm_opening_stock"] else 0
            fg_tot = intel["parts_opening_stock"]["total_onhand_qty"]
            mrp_tot = intel["mrp_schedule"]["monthly_total"] or "-"
            prev_mo_cnt = intel["previous_mos"]["total_found"]
            reply = (
                f"📊 **Complete ERP & Inventory Clearance Intelligence** for **{query_part}**:\n\n"
                f"1. **RM Opening Stock (Main Store):** **{onhand_rm} Sheets** onhand\n"
                f"2. **Parts Opening Stock (002 FG & WIP):** **{fg_tot} Nos** available\n"
                f"3. **Monthly MRP Schedule:** **{mrp_tot} Nos**\n"
                f"4. **Previous MOs Created:** **{prev_mo_cnt} past MO records** logged in ERP MO Report\n"
            )
            return jsonify({"reply": reply, "type": "erp_intelligence", "intel": intel})

    # Case B: Questions & Analytical Inquiries about Sheet Data
    question_triggers = [
        "what", "how", "which", "why", "who", "when", "where",
        "yield", "grade", "steel", "sheet", "summary", "overview", "stat", "stats",
        "best", "highest", "lowest", "max", "min", "top", "compare", "comparison", "difference",
        "most", "popular", "common", "size", "dimension", "thick", "thickness",
        "standardized vs", "2nd choice", "second choice", "non-standard", "cutting plan", "blank",
        "weight", "endbit", "scrap", "erp code", "meaning", "definition", "explain", "help"
    ]
    is_question = any(q_word in msg_lower for q_word in question_triggers) or message.endswith("?")

    if is_question:
        answer_result = SHEET_AI.answer_query(message, current_part=current_part)
        if answer_result:
            return jsonify(answer_result)

    # Case C: Search for Part Number
    # Clean possible prefixes like "show", "get", "part", etc.
    cleaned_query = re.sub(r'^(show|get|fetch|find|search|check|details\s+for|layout\s+for|part\s*(?:number|no|#)?\s*:?)\s+', '', message, flags=re.I).strip()
    
    matches = find_parts_by_query(cleaned_query) or find_parts_by_query(message)
    
    # If single exact or primary match
    if matches and (len(matches) == 1 or matches[0].lower() == cleaned_query.lower()):
        selected_part = matches[0]
        part_data = PARTS[selected_part]
        records = part_data["records"]
        
        std_rec = next((r for r in records if "standardized" in r["status"].lower()), None)
        
        reply_lines = [
            f"Found part **{selected_part}** with **{len(records)} RM ERP Code(s)** present:",
        ]
        
        return jsonify({
            "reply": "\n".join(reply_lines),
            "type": "part_rm_list",
            "part_no": selected_part,
            "base_part": part_data["base_part"],
            "records": records,
            "default_layout": std_rec["image_url"] if std_rec else (records[0]["image_url"] if records else None),
            "actions": [
                {"label": f"View Layout: {r['rm_erp']} ({r.get('grade') or 'YS'} - {r['status']})", "action": "fetch_layout", "value": r["rm_erp"]}
                for r in records if r["rm_erp"]
            ]
        })

    # If multiple parts matched (e.g. user entered base part 'MBA01008' having Item 1 & Item 2)
    if matches:
        is_base = any(cleaned_query.lower() == b.lower() for b in BASE_PARTS)
        reply_title = f"Found **{len(matches)} items** under base part **{cleaned_query.upper()}**:" if is_base else f"Found **{len(matches)} matching parts** for **\"{cleaned_query}\"**:"
        
        summary_items = []
        for m in matches:
            p_recs = PARTS[m]["records"]
            summary_items.append({
                "part_no": m,
                "rm_count": len(p_recs),
                "rm_codes": [f"{r['rm_erp']} ({r.get('grade') or 'YS'})" for r in p_recs if r["rm_erp"]][:3],
                "has_image": any(r["image_url"] for r in p_recs)
            })

        return jsonify({
            "reply": f"{reply_title} Please choose a part number to view its RM ERP codes and layout:",
            "type": "part_choices",
            "items": summary_items,
            "actions": [{"label": m["part_no"], "action": "select_part", "value": m["part_no"]} for m in summary_items]
        })

    # Case D: Fallback to SheetIntelligenceEngine for general or conversational responses
    answer_result = SHEET_AI.answer_query(message, current_part=current_part)
    return jsonify(answer_result)


# =====================================================================
# Manufacturing Order (MO) Approval Workflow Routes
# =====================================================================
from werkzeug.utils import secure_filename
from mo_workflow import MOWorkflowEngine, ROLES
from erp_stock_service import ERPStockService

MO_ENGINE = MOWorkflowEngine()
ERP_STOCK_SERVICE = ERPStockService()
MO_UPLOAD_DIR = os.path.join(app.root_path, "static", "uploads", "mo_documents")
os.makedirs(MO_UPLOAD_DIR, exist_ok=True)
ALLOWED_MO_EXTENSIONS = {"png", "jpg", "jpeg", "pdf", "webp", "dwg", "dxf"}

def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_MO_EXTENSIONS


# =====================================================================
# ERP, Stock & MRP Intelligence Routes
# =====================================================================
@app.route("/api/intelligence/part/<path:part_no>")
def get_part_intelligence(part_no):
    """
    Returns previous MOs, RM opening stock in Main Store,
    FG & WIP opening stock, and MRP monthly schedule for a part.
    """
    rm_code = request.args.get("rm")
    grade = request.args.get("grade")
    thickness = request.args.get("thickness")
    length = request.args.get("length")
    width = request.args.get("width")
    sheets_needed = request.args.get("sheets", 1)

    data = ERP_STOCK_SERVICE.get_part_comprehensive_intelligence(
        part_no=part_no,
        rm_code=rm_code,
        grade=grade,
        thickness=float(thickness) if thickness else None,
        length=float(length) if length else None,
        width=float(width) if width else None,
        sheets_needed=float(sheets_needed) if sheets_needed else 1
    )
    return jsonify(data)


@app.route("/api/intelligence/rm/<path:rm_code>")
def get_rm_intelligence(rm_code):
    """Returns RM Opening stock in Main Store"""
    grade = request.args.get("grade")
    thickness = request.args.get("thickness")
    length = request.args.get("length")
    width = request.args.get("width")

    stock = ERP_STOCK_SERVICE.get_rm_opening_stock(
        rm_code=rm_code,
        grade=grade,
        thickness=float(thickness) if thickness else None,
        length=float(length) if length else None,
        width=float(width) if width else None
    )
    if not stock:
        return jsonify({"found": False, "rm_code": rm_code})
    return jsonify({"found": True, "stock": stock})


@app.route("/api/mo/roles")
def get_mo_roles():
    """Get all departments and role definitions"""
    return jsonify(ROLES)


@app.route("/api/mo/stats")
def get_mo_stats():
    """Get pending counts for all departments"""
    return jsonify(MO_ENGINE.get_stats())


@app.route("/api/mo/list")
def list_mos():
    """List MOs with optional filters for role, stage, status"""
    role = request.args.get("role")
    stage = request.args.get("stage")
    status = request.args.get("status")
    mos = MO_ENGINE.list_mos(role=role, stage=stage, status=status)
    return jsonify(mos)


@app.route("/api/mo/<mo_number>")
def get_mo_detail(mo_number):
    """Get detailed MO view with complete audit trail"""
    mo = MO_ENGINE.get_mo(mo_number)
    if not mo:
        return jsonify({"error": "Manufacturing Order not found"}), 404
    return jsonify(mo)


@app.route("/api/mo/create", methods=["POST"])
def create_mo():
    """Shearing team creates an MO with constraints evaluation & optional document upload"""
    if request.content_type and "multipart/form-data" in request.content_type:
        form = request.form
        data = {
            "mo_number": form.get("mo_number"),
            "part_no": form.get("part_no"),
            "base_part": form.get("base_part"),
            "rm_erp": form.get("rm_erp"),
            "grade": form.get("grade"),
            "layout_name": form.get("layout_name"),
            "is_standard_layout": form.get("is_standard_layout", "true").lower() in ("true", "1", "yes"),
            "thickness": float(form.get("thickness", 0)) if form.get("thickness") else None,
            "length": float(form.get("length", 0)) if form.get("length") else None,
            "width": float(form.get("width", 0)) if form.get("width") else None,
            "target_qty": int(form.get("target_qty", 1)) if form.get("target_qty") else 1,
            "sheets_required": float(form.get("sheets_required", 1)) if form.get("sheets_required") else 1,
            "notes": form.get("notes", "")
        }

        # Handle constraints json
        constraints_str = form.get("constraints_status")
        if constraints_str:
            try:
                data["constraints_status"] = json.loads(constraints_str)
            except Exception:
                data["constraints_status"] = {"all_satisfied": True}
        else:
            data["constraints_status"] = {
                "stock_available": form.get("constraint_stock", "true").lower() == "true",
                "yield_satisfied": form.get("constraint_yield", "true").lower() == "true",
                "all_satisfied": (
                    form.get("constraint_stock", "true").lower() == "true" and
                    form.get("constraint_yield", "true").lower() == "true"
                )
            }

        # Handle uploaded document file for non-standard layouts
        if "layout_doc" in request.files:
            file = request.files["layout_doc"]
            if file and file.filename and allowed_file(file.filename):
                filename = secure_filename(f"mo_{int(time.time())}_{file.filename}")
                filepath = os.path.join(MO_UPLOAD_DIR, filename)
                file.save(filepath)
                data["layout_doc_url"] = f"/static/uploads/mo_documents/{filename}"
                data["layout_doc_filename"] = file.filename
    else:
        data = request.json or {}

    created_by = request.headers.get("X-Role", "shearing")
    record = MO_ENGINE.create_mo(data, created_by_role=created_by)
    return jsonify(record), 201


@app.route("/api/mo/<mo_number>/approve", methods=["POST"])
def approve_mo(mo_number):
    """Approve an MO and advance workflow to next stage"""
    body = request.json or {}
    role = body.get("role") or request.headers.get("X-Role") or "shearing"
    remarks = body.get("remarks", "Approved")
    mo, err = MO_ENGINE.approve_mo(mo_number, role, remarks)
    if err:
        return jsonify({"error": err}), 400
    return jsonify(mo)


@app.route("/api/mo/<mo_number>/reject", methods=["POST"])
def reject_mo(mo_number):
    """Reject an MO with required reason"""
    body = request.json or {}
    role = body.get("role") or request.headers.get("X-Role") or "shearing"
    reason = body.get("reason", "")
    mo, err = MO_ENGINE.reject_mo(mo_number, role, reason)
    if err:
        return jsonify({"error": err}), 400
    return jsonify(mo)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)

