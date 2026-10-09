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
from datetime import datetime
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
from cut_optimizer import CUT_OPTIMIZER_2D

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
        "password": "shearing123",
        "name": "Shearing (Production) Team",
        "title": "Shearing Production Workspace",
        "badge": "Production Floor",
        "icon": "fa-industry",
        "role": "shearing",
        "desc": "Create Manufacturing Orders, select cutting layouts, verify stock constraints, and route for approvals."
    },
    "krysalis": {
        "username": "krysalis",
        "password": "krysalis123",
        "name": "Consultants (Krysalis) Team",
        "title": "Consultants (Krysalis) Layout Review",
        "badge": "Design & Layout",
        "icon": "fa-compass-drafting",
        "role": "krysalis",
        "desc": "Review and verify non-standard layout documents, technical blank nesting, and cutting plan feasibility."
    },
    "purchase": {
        "username": "purchase",
        "password": "purchase123",
        "name": "Purchase Team",
        "title": "Purchase & Procurement Clearance",
        "badge": "Procurement",
        "icon": "fa-cart-shopping",
        "role": "purchase",
        "desc": "Review raw material coil stock shortages, material yields, steel grade pricing, and supplier clearances."
    },
    "erp": {
        "username": "erp",
        "password": "erp123",
        "name": "ERP Team",
        "title": "ERP Master Data & Release Gateway",
        "badge": "ERP Systems",
        "icon": "fa-network-wired",
        "role": "erp",
        "desc": "Final authorization and release of fast-tracked standard orders and purchase-cleared MOs to live ERP."
    }
}


@app.after_request
def add_cache_headers(response):
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

@app.route("/")
def index():
    """First, user must login; otherwise redirect to role workspace"""
    role = session.get("role")
    if not role or role not in DEPARTMENT_CREDENTIALS:
        return redirect(url_for("login"))
    return redirect(url_for("dashboard"))


@app.route("/login", methods=["GET", "POST"])
def login():
    """Department Login page with username and password authentication"""
    error = None
    if request.method == "POST":
        req_data = request.json if request.is_json else request.form
        username = (req_data.get("username") or "").strip().lower()
        password = (req_data.get("password") or "").strip()
        selected_role = (req_data.get("role") or "").strip().lower()

        matched_dept = None
        matched_key = None

        if selected_role in DEPARTMENT_CREDENTIALS:
            dept = DEPARTMENT_CREDENTIALS[selected_role]
            if (not username or username == dept["username"].lower()) and password == dept["password"]:
                matched_dept = dept
                matched_key = selected_role

        if not matched_dept and username:
            for k, dept in DEPARTMENT_CREDENTIALS.items():
                if dept["username"].lower() == username and dept["password"] == password:
                    matched_dept = dept
                    matched_key = k
                    break

        if matched_dept:
            session["role"] = matched_key
            session["user_name"] = matched_dept["name"]
            if request.is_json:
                return jsonify({"success": True, "redirect": url_for("dashboard"), "role": matched_key})
            return redirect(url_for("dashboard"))

        error = "Invalid department credentials. Please verify your username and password."
        if request.is_json:
            return jsonify({"success": False, "error": error}), 401

    if session.get("role") in DEPARTMENT_CREDENTIALS:
        return redirect(url_for("dashboard"))

    return render_template("login.html", departments=DEPARTMENT_CREDENTIALS, error=error)


@app.route("/logout")
def logout():
    """Sign out of current department"""
    session.clear()
    return redirect(url_for("login"))


@app.route("/dashboard")
@app.route("/mo")
@app.route("/mo_portal")
@app.route("/mo-portal")
def dashboard():
    """Role-based Workspace with Floating Chatbot in bottom-right corner"""
    role = session.get("role")
    if not role or role not in DEPARTMENT_CREDENTIALS:
        return redirect(url_for("login"))

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


@app.route("/api/layouts/search")
def search_all_layouts():
    """Search across all available layout records by RM code, cutting plan, layout name, or part number"""
    q = request.args.get("q", "").strip().lower()
    results = []
    seen = set()

    for r in ALL_RECORDS:
        key = (r.get("cutting_plan") or "") + "_" + (r.get("rm_erp") or "") + "_" + (r.get("part_no") or "")
        if key in seen:
            continue
        
        if not q:
            seen.add(key)
            results.append(r)
            if len(results) >= 40:
                break
        else:
            searchable = f"{r.get('rm_erp', '')} {r.get('cutting_plan', '')} {r.get('layout_name', '')} {r.get('part_no', '')} {r.get('base_part', '')} {r.get('grade', '')}".lower()
            if q in searchable:
                seen.add(key)
                results.append(r)
                if len(results) >= 40:
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
            "reply": "Please enter a Part Number (for example, `MBA01008 - Item 1` or `MBA01008`), ask for **Monthly Yield**, **Scrap Generated**, or request a **Cutting Plan**.",
            "type": "help",
            "actions": [
                {"label": "Monthly Yield Analysis", "value": "monthly yield"},
                {"label": "Monthly Scrap Report", "value": "this month scrap generated"},
                {"label": "Cutting Plan: MBA01010", "value": "cutting plan for MBA01010"},
                {"label": "Part: MBA01008 - Item 1", "value": "MBA01008 - Item 1"}
            ]
        })

    # 0a. End-Bit Capacity Agent (Calculates pro-rata parts from selected endbits without exceeding endbit size)
    eb_capacity_resp = ENDBIT_CAPACITY_AGENT.handle_natural_language_query(message)
    if eb_capacity_resp:
        return jsonify(eb_capacity_resp)

    # 0b. Production Planner Agent (Monthly Yield, Monthly Scrap, Cutting & Production Plans)
    planner_resp = PRODUCTION_PLANNER_AGENT.handle_user_prompt(message, current_part=current_part, current_rm=current_rm)
    if planner_resp:
        return jsonify(planner_resp)

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
                first = mrp_data[0]
                tot = first.get("total_qty") or first.get("schedule_qty") or 0
                sched = first.get("schedule_qty") or 0
                offtake = first.get("offtake") or 1.0
                bal = first.get("balance_qty") or 0
                inhouse = first.get("inhouse_erp_qty") or 0
                child_p = first.get("child_part") or "Child Item"
                sheet = first.get("existing_sheet_used") or "-"
                reply = (
                    f"📅 **MRP Planning Schedule (RM Sheet BOM)** for **{query_part}**:\n\n"
                    f"• **Child Item:** **{child_p}** (Off-take: **{offtake}**)\n"
                    f"• **Child MRP Required Target:** **{int(tot):,} Nos**\n"
                    f"• **Parent Schedule Quantity:** {int(sched):,} Nos\n"
                    f"• **Inhouse ERP Stock:** {int(inhouse):,} Nos\n"
                    f"• **Balance for Planning:** **{int(bal):,} Nos**\n"
                    f"• **Sheet Assigned:** `{sheet}`"
                )
                return jsonify({"reply": reply, "type": "erp_intelligence", "mrp": mrp_data})
            else:
                return jsonify({"reply": f"No active schedule found in MRP RM Sheet BOM for **{query_part}**.", "type": "info"})

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
# Material Order (MO) Approval Workflow Routes
# =====================================================================
from werkzeug.utils import secure_filename
from mo_workflow import MOWorkflowEngine, ROLES
from erp_stock_service import ERPStockService

MO_ENGINE = MOWorkflowEngine()
MO_ENGINE.set_layout_records(ALL_RECORDS)
ERP_STOCK_SERVICE = ERPStockService()
MO_ENGINE.set_erp_service(ERP_STOCK_SERVICE)
from rm_advisor_agent import RMAdvisorAgent
RM_ADVISOR_AGENT = RMAdvisorAgent(DATA_STORE, ERP_STOCK_SERVICE)
from purchase_advisor_agent import PurchaseAdvisorAgent
PURCHASE_ADVISOR_AGENT = PurchaseAdvisorAgent(DATA_STORE, ERP_STOCK_SERVICE, MO_ENGINE, RM_ADVISOR_AGENT)
from production_planner_agent import ProductionPlannerAgent
PRODUCTION_PLANNER_AGENT = ProductionPlannerAgent(DATA_STORE, ERP_STOCK_SERVICE, MO_ENGINE)
from endbit_capacity_agent import EndbitCapacityAgent
ENDBIT_CAPACITY_AGENT = EndbitCapacityAgent(DATA_STORE, MO_ENGINE)
SHEET_AI.set_services(ERP_STOCK_SERVICE, MO_ENGINE, PRODUCTION_PLANNER_AGENT, ENDBIT_CAPACITY_AGENT)
from cut_optimizer import CUT_OPTIMIZER_2D
MO_UPLOAD_DIR = os.path.join(app.root_path, "static", "uploads", "mo_documents")
os.makedirs(MO_UPLOAD_DIR, exist_ok=True)
ALLOWED_MO_EXTENSIONS = {"png", "jpg", "jpeg", "pdf", "webp", "dwg", "dxf"}

def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_MO_EXTENSIONS


# =====================================================================
# ERP, Stock & MRP Intelligence Routes
# =====================================================================
@app.route("/api/rm-stock/raw-material-sheets")
def get_raw_material_sheets():
    """Fetch item codes from RM Main Store stock having category description as RAW MATERIAL SHEET"""
    q = request.args.get("q", "").strip().lower()
    results = []

    if hasattr(ERP_STOCK_SERVICE, "rm_stock"):
        for item in ERP_STOCK_SERVICE.rm_stock.values():
            cat = (item.get("category") or "").upper()
            if "RAW MATERIAL SHEET" not in cat:
                continue

            code = (item.get("item_code") or "").strip()
            desc = (item.get("item_desc") or "").strip()
            onhand = float(item.get("onhand_stock") or 0.0)
            uom = item.get("uom") or "NOS"
            weight = item.get("weight")
            store = item.get("store") or "MAIN STORES"

            if q:
                if q not in code.lower() and q not in desc.lower():
                    continue

            # Auto-fetch Grade: first 2 letters
            grade = code[:2].upper()

            # Auto-fetch Sheet Size: thickness * length * width
            nums = re.findall(r'\d+(?:\.\d+)?', code)
            t, l, w = None, None, None
            if len(nums) >= 3:
                w = float(nums[-1])
                l = float(nums[-2])
                t = float(nums[-3])
            elif len(nums) == 2:
                t = float(nums[0])
                l = float(nums[1])
                w = 1250.0

            def _fmt_num(n):
                if n is None: return ""
                return str(int(n)) if n == int(n) else str(n)

            sheet_sz = f"{_fmt_num(t)} * {_fmt_num(l)} * {_fmt_num(w)}" if (t and l and w) else desc

            results.append({
                "item_code": code,
                "item_desc": desc,
                "onhand_stock": onhand,
                "uom": uom,
                "weight": weight,
                "store": store,
                "category": item.get("category") or "RAW MATERIAL SHEET",
                "grade": grade,
                "thickness": t,
                "length": l,
                "width": w,
                "sheet_size": sheet_sz
            })

    results.sort(key=lambda x: x["item_code"])
    return jsonify(results)

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
    month = request.args.get("month", "2026-09")

    extra_parts = request.args.getlist("parts") or request.args.getlist("extra_parts")
    if not extra_parts:
        extra_str = request.args.get("extra_parts")
        if extra_str:
            extra_parts = [p.strip() for p in extra_str.split(",") if p.strip()]

    data = ERP_STOCK_SERVICE.get_part_comprehensive_intelligence(
        part_no=part_no,
        rm_code=rm_code,
        grade=grade,
        thickness=float(thickness) if thickness else None,
        length=float(length) if length else None,
        width=float(width) if width else None,
        sheets_needed=float(sheets_needed) if sheets_needed else 1,
        target_month=month,
        extra_parts=extra_parts
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
        return jsonify({"error": "Material Order not found"}), 404
    return jsonify(mo)


@app.route("/api/mo/create", methods=["POST"])
def create_mo():
    """Shearing team creates an MO with constraints evaluation & optional document upload"""
    if request.form or (request.content_type and "multipart/form-data" in request.content_type):
        form = request.form
        rm_erp_val = (form.get("rm_erp") or "").strip()
        if not rm_erp_val or rm_erp_val == "__custom__":
            return jsonify({"error": "RM ERP Code is mandatory. Please select a valid RM ERP Code."}), 400

        yield_str = str(form.get("yield_pct", "")).replace("%", "").strip()
        try:
            yield_val = float(yield_str) if yield_str and yield_str.lower() != "n/a" else None
        except ValueError:
            yield_val = None

        data = {
            "mo_number": form.get("mo_number"),
            "part_no": form.get("part_no"),
            "base_part": form.get("base_part"),
            "rm_erp": rm_erp_val,
            "grade": form.get("grade"),
            "layout_name": form.get("layout_name"),
            "yield_pct": yield_val,
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
                data["constraints_status"] = {}

        if not data.get("constraints_status"):
            stock_val = form.get("constraint_stock", "true").lower()
            mrp_val = form.get("constraint_mrp", "true").lower()
            rem_val = form.get("constraint_remaining", "true").lower()
            yield_val_c = form.get("constraint_yield", "true").lower()
            stock_ok = stock_val in ("true", "on", "1", "yes")
            mrp_ok = mrp_val in ("true", "on", "1", "yes")
            rem_ok = rem_val in ("true", "on", "1", "yes")
            yield_ok = yield_val_c in ("true", "on", "1", "yes")
            all_ok = stock_ok and mrp_ok and rem_ok
            data["constraints_status"] = {
                "stock_available": stock_ok,
                "mrp_available": mrp_ok,
                "remaining_quota_satisfied": rem_ok,
                "yield_satisfied": yield_ok,
                "all_satisfied": all_ok
            }
        else:
            # Ensure boolean types
            cs = data["constraints_status"]
            cs["stock_available"] = bool(cs.get("stock_available", True))
            cs["mrp_available"] = bool(cs.get("mrp_available", True))
            cs["remaining_quota_satisfied"] = bool(cs.get("remaining_quota_satisfied", True))
            cs["yield_satisfied"] = bool(cs.get("yield_satisfied", True))
            cs["all_satisfied"] = bool(cs.get("all_satisfied", cs["stock_available"] and cs["mrp_available"] and cs["remaining_quota_satisfied"]))

        # Embed yield_pct inside constraints_status JSONB
        if yield_val is not None:
            data["constraints_status"]["yield_pct"] = yield_val

        # Handle endbits json from form
        endbits_str = form.get("endbits")
        if endbits_str:
            try:
                data["endbits"] = json.loads(endbits_str)
            except Exception:
                data["endbits"] = []

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
        rm_erp_val = (data.get("rm_erp") or "").strip()
        if not rm_erp_val or rm_erp_val == "__custom__":
            return jsonify({"error": "RM ERP Code is mandatory. Please select a valid RM ERP Code."}), 400
        if "yield_pct" in data and data["yield_pct"] is not None:
            try:
                data["yield_pct"] = float(str(data["yield_pct"]).replace("%", "").strip())
                if "constraints_status" not in data or not isinstance(data["constraints_status"], dict):
                    data["constraints_status"] = {}
                data["constraints_status"]["yield_pct"] = data["yield_pct"]
            except (ValueError, TypeError):
                data["yield_pct"] = None

    created_by = request.headers.get("X-Role") or session.get("role") or ""
    if created_by != "shearing":
        return jsonify({"error": "Unauthorized: Only the Shearing Production team can create or produce Material Orders. Other departments have view-only access."}), 403
    record = MO_ENGINE.create_mo(data, created_by_role=created_by)
    return jsonify(record), 201


@app.route("/api/mo/create-endbit", methods=["POST"])
def create_endbit_mo():
    """Shearing team creates an MO directly from sheet end bits/offcuts without layouts"""
    created_by = request.headers.get("X-Role") or session.get("role") or ""
    if created_by != "shearing":
        return jsonify({"error": "Unauthorized: Only the Shearing Production team can create Material Orders from end bits. Other departments have view-only access."}), 403
    if request.form or (request.content_type and "multipart/form-data" in request.content_type):
        data = request.form.to_dict()
        if "layout_doc" in request.files:
            file = request.files["layout_doc"]
            if file and file.filename and allowed_file(file.filename):
                filename = secure_filename(f"mo_eb_{int(time.time())}_{file.filename}")
                filepath = os.path.join(MO_UPLOAD_DIR, filename)
                file.save(filepath)
                data["layout_doc_url"] = f"/static/uploads/mo_documents/{filename}"
                data["layout_doc_filename"] = file.filename
    else:
        data = request.json or {}

    record, err = MO_ENGINE.create_mo_from_endbit(data, created_by_role=created_by)
    if err:
        return jsonify({"error": err}), 400
    return jsonify(record), 201


@app.route("/api/agent/endbit-capacity", methods=["GET", "POST"])
def calculate_endbit_capacity_endpoint():
    """
    AI Agent endpoint to calculate maximum parts that can be produced within
    selected end-bits without exceeding the end-bit dimensions.
    """
    if request.method == "POST":
        data = request.json or request.form.to_dict() or {}
    else:
        data = request.args.to_dict()

    endbit_id = data.get("endbit_id")
    eb_l = float(data.get("endbit_length") or data.get("offcut_length") or data.get("length") or 0)
    eb_w = float(data.get("endbit_width") or data.get("offcut_width") or data.get("width") or 0)
    eb_t = float(data.get("endbit_thickness") or data.get("thickness") or 4.8)
    eb_count = int(data.get("endbits_count") or data.get("endbits_used") or 1)

    # If endbit_id provided, look up from MO_ENGINE endbit records if dimensions not supplied
    if endbit_id and (eb_l == 0 or eb_w == 0) and MO_ENGINE and hasattr(MO_ENGINE, "endbit_records"):
        eb_rec = MO_ENGINE.endbit_records.get(endbit_id)
        if eb_rec:
            eb_l = float(eb_rec.get("length") or 0)
            eb_w = float(eb_rec.get("width") or 0)
            eb_t = float(eb_rec.get("thickness") or eb_t)

    # Check if multi-parts payload provided
    parts_payload = data.get("parts")
    if parts_payload:
        if isinstance(parts_payload, str):
            try:
                parts_list = json.loads(parts_payload)
            except Exception:
                parts_list = []
        else:
            parts_list = parts_payload
        if parts_list:
            res = ENDBIT_CAPACITY_AGENT.calculate_multi_part_capacity(
                endbit_length=eb_l,
                endbit_width=eb_w,
                endbit_thickness=eb_t,
                endbits_count=eb_count,
                parts_list=parts_list
            )
            return jsonify(res)

    # Single part calculation
    b_l = float(data.get("blank_length") or data.get("cut_length") or 0)
    b_w = float(data.get("blank_width") or data.get("cut_width") or 0)
    b_t = float(data.get("blank_thickness") or eb_t)
    part_no = data.get("part_no")
    target_qty = int(data.get("target_qty") or data.get("no_of_parts") or 0) if data.get("target_qty") or data.get("no_of_parts") else None

    res = ENDBIT_CAPACITY_AGENT.calculate_endbit_capacity(
        endbit_length=eb_l,
        endbit_width=eb_w,
        endbit_thickness=eb_t,
        endbits_count=eb_count,
        blank_length=b_l,
        blank_width=b_w,
        blank_thickness=b_t,
        part_no=part_no,
        target_qty=target_qty
    )
    return jsonify(res)


@app.route("/api/agent/suggest-rm-alternatives", methods=["GET", "POST"])
def suggest_rm_alternatives():
    """
    AI Agent endpoint: Evaluates RM shortages and returns ranked alternative RM recommendations,
    including alternative verified CAD layouts, in-stock store sheet sizes, and offcut salvage options.
    """
    if request.method == "POST":
        params = request.json or request.form.to_dict() or {}
    else:
        params = request.args.to_dict()

    part_no = params.get("part_no", "").strip()
    current_rm = params.get("rm_erp", "").strip()
    target_qty = int(params.get("target_qty") or 1)
    sheets_needed = int(params.get("sheets_needed") or 1)
    thickness = params.get("thickness")
    grade = params.get("grade")
    current_onhand = params.get("onhand_stock")
    if current_onhand is not None:
        try:
            current_onhand = float(current_onhand)
        except Exception:
            current_onhand = None

    analysis = RM_ADVISOR_AGENT.analyze_rm_shortage_and_suggest(
        part_no=part_no,
        current_rm=current_rm,
        target_qty=target_qty,
        sheets_needed=sheets_needed,
        thickness=thickness,
        grade=grade,
        current_onhand=current_onhand
    )
    if isinstance(analysis, dict) and "recommendations" in analysis:
        analysis["recommendations"] = [
            r for r in analysis["recommendations"]
            if float(r.get("onhand_stock") or r.get("available_qty") or 0.0) > 0
        ]
        analysis["total_alternatives_found"] = len(analysis["recommendations"])
    return jsonify(analysis)


@app.route("/api/agent/purchase-advisor", methods=["GET", "POST"])
def api_purchase_advisor():
    """
    AI Purchase Decision Agent endpoint:
    Evaluates failing constraints (RM store shortage, MRP monthly schedule deficits, quota violations)
    for a Material Order and generates an executive procurement decision, PO sizing,
    in-stock substitution clearance, and 1-click signoff remarks.
    """
    if request.method == "POST":
        params = request.json or request.form.to_dict() or {}
    else:
        params = request.args.to_dict()

    mo_number = params.get("mo_number", "").strip()
    mo_record = {}
    if mo_number and MO_ENGINE:
        mo_record = MO_ENGINE.get_mo(mo_number) or {}

    merged_data = dict(mo_record) if mo_record else {}
    for k, v in params.items():
        if v is not None and v != "":
            merged_data[k] = v

    analysis = PURCHASE_ADVISOR_AGENT.analyze_order_and_decide(merged_data)
    return jsonify(analysis)


# =====================================================================
# Production Planner Agent Routes (Yield, Scrap & Cutting Plans)
# =====================================================================
@app.route("/api/analytics/monthly-yield")
def api_monthly_yield():
    """Returns monthly material yield performance analytics."""
    month = request.args.get("month")
    res = PRODUCTION_PLANNER_AGENT.analyze_monthly_yield(month)
    return jsonify(res)


@app.route("/api/analytics/monthly-scrap")
def api_monthly_scrap():
    """Returns monthly scrap generated, wastage cost, and end-bit recovery metrics."""
    month = request.args.get("month")
    res = PRODUCTION_PLANNER_AGENT.analyze_monthly_scrap(month)
    return jsonify(res)


@app.route("/api/analytics/cutting-plan")
def api_cutting_plan():
    """Generates comprehensive shop-floor cutting and production plan for a part."""
    part_no = request.args.get("part") or request.args.get("part_no") or request.args.get("query")
    target_qty = int(request.args.get("qty")) if request.args.get("qty") else None
    rm_erp = request.args.get("rm_erp")
    res = PRODUCTION_PLANNER_AGENT.generate_cutting_plan(part_query=part_no, target_qty=target_qty, rm_erp=rm_erp)
    return jsonify(res)


@app.route("/api/optimizer/2d-cut-list", methods=["POST", "GET"])
def optimize_2d_cut_list():
    """
    OptiCutter-inspired 2D Guillotine Cut-List Nesting & Yield Optimizer endpoint.
    Calculates exact blank placements, yield %, scrap, and OptiCutter export formats.
    Supports single-part and multi-part batch nesting.
    """
    if request.method == "POST":
        params = request.get_json(silent=True) or request.form.to_dict() or {}
    else:
        params = request.args.to_dict()

    sheet_l = float(params.get("sheet_length") or params.get("length") or 0.0)
    sheet_w = float(params.get("sheet_width") or params.get("width") or 0.0)
    blank_l = float(params.get("blank_length") or params.get("cut_length") or 0.0)
    blank_w = float(params.get("blank_width") or params.get("cut_width") or 0.0)
    part_no = str(params.get("part_no") or "Part")
    strategy_mode = (params.get("strategy") or params.get("strategy_mode") or "auto").strip().lower()
    kerf = float(params.get("kerf") or 0.0)
    target_qty = int(params.get("target_qty")) if params.get("target_qty") else None
    can_rotate = bool(params.get("can_rotate", True))

    parts = params.get("parts")
    if isinstance(parts, str):
        try:
            parts = json.loads(parts)
        except Exception:
            parts = None

    result = CUT_OPTIMIZER_2D.optimize_nesting(
        sheet_length=sheet_l,
        sheet_width=sheet_w,
        blank_length=blank_l,
        blank_width=blank_w,
        part_no=part_no,
        strategy_mode=strategy_mode,
        kerf=kerf,
        target_qty=target_qty,
        can_rotate=can_rotate,
        parts=parts
    )
    return jsonify(result)



@app.route("/api/mo/<mo_number>/approve", methods=["POST"])
def approve_mo(mo_number):
    """Approve an MO and advance workflow to next stage"""
    body = request.json or {}
    role = session.get("role") or request.headers.get("X-Role") or body.get("role") or "shearing"
    remarks = body.get("remarks", "Approved")
    erp_mo_number = body.get("erp_mo_number") or request.args.get("erp_mo_number")
    mo, err = MO_ENGINE.approve_mo(mo_number, role, remarks, erp_mo_number=erp_mo_number)
    if err:
        return jsonify({"error": err}), 400
    return jsonify(mo)


@app.route("/api/mo/<mo_number>/reject", methods=["POST"])
def reject_mo(mo_number):
    """Reject an MO with required reason"""
    body = request.json or {}
    role = session.get("role") or request.headers.get("X-Role") or body.get("role") or "shearing"
    reason = body.get("reason", "")
    mo, err = MO_ENGINE.reject_mo(mo_number, role, reason)
    if err:
        return jsonify({"error": err}), 400
    return jsonify(mo)


@app.route("/api/mo/<mo_number>/resubmit", methods=["POST"])
def resubmit_mo_endpoint(mo_number):
    """Shearing team edits and resubmits a rejected Material Order back into approval workflow"""
    role = session.get("role") or request.headers.get("X-Role") or ""
    if role != "shearing":
        return jsonify({"error": "Unauthorized: Only the Shearing Production team can edit and resubmit Material Orders."}), 403

    if request.form or (request.content_type and "multipart/form-data" in request.content_type):
        data = request.form.to_dict()
        if "layout_doc" in request.files:
            file = request.files["layout_doc"]
            if file and file.filename and allowed_file(file.filename):
                filename = secure_filename(f"mo_rev_{int(time.time())}_{file.filename}")
                filepath = os.path.join(MO_UPLOAD_DIR, filename)
                file.save(filepath)
                data["layout_doc_url"] = f"/static/uploads/mo_documents/{filename}"
                data["layout_doc_filename"] = file.filename
    else:
        data = request.json or {}

    mo, err = MO_ENGINE.resubmit_mo(mo_number, data, role=role)
    if err:
        return jsonify({"error": err}), 400
    return jsonify(mo)


@app.route("/api/mo/<mo_number>/complete", methods=["POST"])
def complete_mo_endpoint(mo_number):
    """Mark an MO as executed and update respective database tables in real-time"""
    body = request.json or {}
    role = session.get("role") or request.headers.get("X-Role") or body.get("role") or "erp"
    remarks = body.get("remarks", "Executed and released to live ERP")
    erp_mo_number = body.get("erp_mo_number") or request.args.get("erp_mo_number")
    mo, updates_summary = MO_ENGINE.complete_mo(mo_number, role=role, remarks=remarks, erp_mo_number=erp_mo_number)
    if not mo:
        return jsonify({"error": "Failed to complete MO."}), 400
    return jsonify({
        "success": True,
        "mo": mo,
        "db_updates": updates_summary
    })


# =====================================================================
# End Bits & Offcuts Recovery API Endpoints
# =====================================================================
@app.route("/api/endbits")
def get_endbits():
    """List recorded end bits / offcuts with optional filters"""
    status = request.args.get("status")
    grade = request.args.get("grade")
    mo = request.args.get("mo")
    q = request.args.get("q")
    endbits = MO_ENGINE.list_endbits(status=status, grade=grade, mo_number=mo, search=q)
    return jsonify(endbits)


@app.route("/api/endbits/stats")
def get_endbit_stats():
    """Get KPI summary statistics for the End Bits Store"""
    stats = MO_ENGINE.get_endbit_stats()
    return jsonify(stats)


@app.route("/api/endbits/manual-add", methods=["POST"])
def add_manual_endbit_endpoint():
    """Manually add an offcut / end-bit into the store inventory for future use"""
    body = request.json or request.form.to_dict() or {}
    role = request.headers.get("X-Role") or session.get("role") or ""
    if role != "shearing":
        return jsonify({"error": "Unauthorized: Only the Shearing Production team can add end bits to the inventory. Other departments have view-only access."}), 403
    record, err = MO_ENGINE.add_manual_endbit(body, created_by_role=role)
    if err:
        return jsonify({"error": err}), 400
    return jsonify(record), 201


@app.route("/api/endbits/<endbit_id>")
def get_endbit_detail(endbit_id):
    """Get single end bit with its parts creation history"""
    eb = MO_ENGINE.get_endbit(endbit_id)
    if not eb:
        return jsonify({"error": "End bit not found"}), 404
    return jsonify(eb)


@app.route("/api/endbits/<endbit_id>/produce-part", methods=["POST"])
def produce_part_from_endbit_endpoint(endbit_id):
    """Produce parts from an existing end bit and record the transaction"""
    body = request.json or {}
    role = request.headers.get("X-Role") or session.get("role") or ""
    if role != "shearing":
        return jsonify({"error": "Unauthorized: Only the Shearing Production team can produce parts or create Material Orders from end bits. Other departments have view-only access."}), 403
    updated_eb, tx_entry, err = MO_ENGINE.produce_part_from_endbit(endbit_id, body, role=role)
    if err:
        return jsonify({"error": err}), 400
    return jsonify({
        "success": True,
        "message": f"Successfully produced {tx_entry['parts_produced']} units of {tx_entry['part_no']} from end bit {endbit_id}",
        "endbit": updated_eb,
        "transaction": tx_entry,
        "record": {
            "part_no": tx_entry.get("part_no"),
            "total_parts_produced": tx_entry.get("parts_produced"),
            "cutting_order_no": tx_entry.get("cutting_order_no") or tx_entry.get("mo_number"),
            "endbits_used": tx_entry.get("endbits_used"),
            "remaining_endbits": updated_eb.get("available_qty")
        }
    })


@app.route("/api/parts/search-blank")
def search_parts_blank():
    """Search master parts with cut blank dimensions (T*L*W) for fit check in end bit recovery"""
    q = (request.args.get("q") or request.args.get("query") or "").strip()
    if not q:
        return jsonify([])
    q_norm = normalize_key(q)
    results = []
    seen = set()
    for p_no in PARTS:
        if q_norm in normalize_key(p_no):
            if p_no not in seen:
                seen.add(p_no)
                records = PARTS[p_no]["records"]
                r0 = records[0] if records else {}
                cb = r0.get("cut_blank") or ""
                p1 = r0.get("part1") or {}
                bs = p1.get("blank_size") or {}
                b_thick = bs.get("thickness") or r0.get("thickness")
                b_len = bs.get("length")
                b_wid = bs.get("width")

                # If blank length/width missing, parse cut_blank string (Length*Width*Thickness or T*L*W)
                if (not b_len or not b_wid) and cb:
                    nums = [float(x) for x in re.findall(r'[\d.]+', cb)]
                    if len(nums) >= 3:
                        t_cand = float(b_thick or 0)
                        if t_cand > 0 and t_cand in nums:
                            rem = [n for n in nums if n != t_cand or nums.count(n) > 1]
                            b_len = max(rem) if rem else nums[0]
                            b_wid = min(rem) if rem else nums[1]
                        else:
                            s_nums = sorted(nums)
                            b_thick = s_nums[0]
                            b_len = max(s_nums[1], s_nums[2])
                            b_wid = min(s_nums[1], s_nums[2])
                    elif len(nums) == 2:
                        b_len = max(nums[0], nums[1])
                        b_wid = min(nums[0], nums[1])

                b_len = float(b_len or 0)
                b_wid = float(b_wid or 0)
                b_thick = float(b_thick or 0)

                results.append({
                    "part_no": p_no,
                    "base_part": PARTS[p_no]["base_part"],
                    "cut_blank": cb or (f"{b_len}*{b_wid}*{b_thick}" if b_len and b_wid else ""),
                    "thickness": b_thick,
                    "length": b_len,
                    "width": b_wid,
                    "blank_length": b_len,
                    "blank_width": b_wid,
                    "grade": r0.get("grade") or "YS",
                    "blank_weight": p1.get("blank_weight")
                })
        if len(results) >= 15:
            break
    return jsonify(results)



@app.route("/api/db/tables")
def get_db_tables():
    """Get real-time list of all 7 database tables with live row counts"""
    tables = MO_ENGINE.get_db_tables_overview()
    return jsonify({"tables": tables})


@app.route("/api/db/table/<table_name>")
def get_db_table_records(table_name):
    """Fetch paginated records from a database table with live search"""
    page = request.args.get("page", 1)
    limit = request.args.get("limit", 25)
    query = request.args.get("q", "")
    data, err = MO_ENGINE.get_db_table_data(table_name, page=page, limit=limit, search_query=query)
    if err:
        return jsonify({"error": err}), 400
    return jsonify(data)


@app.route("/api/mo/export")
def export_mos():
    """Export filtered Material Orders as a downloadable PDF report (or CSV if format=csv)"""
    import io
    from flask import Response

    fmt = (request.args.get("format") or "pdf").lower()
    role = request.args.get("role")
    stage = request.args.get("stage")
    status = request.args.get("status")
    from_date = request.args.get("from_date")
    to_date = request.args.get("to_date")
    search = (request.args.get("q") or "").strip().lower()

    mos = MO_ENGINE.list_mos(role=role, stage=stage, status=status)

    if search:
        mos = [
            m for m in mos if (
                search in (m.get("mo_number") or "").lower() or
                search in (m.get("part_no") or "").lower() or
                search in (m.get("rm_erp") or "").lower() or
                search in (m.get("base_part") or "").lower()
            )
        ]

    if from_date:
        mos = [m for m in mos if (m.get("created_at") or "")[:10] >= from_date]
    if to_date:
        mos = [m for m in mos if (m.get("created_at") or "")[:10] <= to_date]

    layout_type = request.args.get("layout_type")
    if layout_type == "standard":
        mos = [m for m in mos if m.get("is_standard_layout") is not False]
    elif layout_type == "non_standard":
        mos = [m for m in mos if m.get("is_standard_layout") is False]

    today_str = time.strftime("%Y-%m-%d")

    # CSV Format option
    if fmt == "csv":
        import csv
        output = io.StringIO()
        output.write("\ufeff")  # UTF-8 BOM for Excel
        writer = csv.writer(output)

        writer.writerow([
            "MO Number", "Date Created", "Part Number", "Base Part", "RM ERP Code",
            "Grade", "Thickness (mm)", "Length (mm)", "Width (mm)", "Sheets Required",
            "Target Quantity (Units)", "Layout Type", "Layout Name / Plan",
            "Current Stage", "Status", "Workflow Route", "Stock Met", "Yield Met", "Notes"
        ])

        for m in mos:
            constraints = m.get("constraints_status") or {}
            writer.writerow([
                m.get("mo_number", ""),
                m.get("created_at", ""),
                m.get("part_no", ""),
                m.get("base_part", ""),
                m.get("rm_erp", ""),
                m.get("grade", ""),
                m.get("thickness", ""),
                m.get("length", ""),
                m.get("width", ""),
                m.get("sheets_required", 1),
                m.get("target_qty", 1),
                "Standardized" if m.get("is_standard_layout") else "Non-Standard",
                m.get("layout_name", ""),
                m.get("current_stage", ""),
                m.get("status", ""),
                m.get("workflow_path", ""),
                "YES" if constraints.get("stock_available") else "NO",
                "YES" if constraints.get("yield_satisfied") else "NO",
                m.get("notes", "")
            ])

        csv_data = output.getvalue()
        return Response(
            csv_data,
            mimetype="text/csv",
            headers={"Content-Disposition": f"attachment; filename=Material_Orders_Report_{today_str}.csv"}
        )

    # Default: Professional PDF Report via ReportLab
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

    pdf_buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        pdf_buffer,
        pagesize=landscape(A4),
        leftMargin=18,
        rightMargin=18,
        topMargin=18,
        bottomMargin=18
    )
    styles = getSampleStyleSheet()

    title_style = ParagraphStyle(
        'DocTitle',
        parent=styles['Heading1'],
        fontName='Helvetica-Bold',
        fontSize=15,
        leading=18,
        textColor=colors.HexColor('#0f172a')
    )
    subtitle_style = ParagraphStyle(
        'DocSubtitle',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=8,
        textColor=colors.HexColor('#64748b'),
        leading=11
    )
    cell_style = ParagraphStyle(
        'CellText',
        fontName='Helvetica',
        fontSize=6.5,
        leading=8.5,
        textColor=colors.HexColor('#1e293b')
    )
    header_cell_style = ParagraphStyle(
        'HeaderCell',
        fontName='Helvetica-Bold',
        fontSize=7,
        leading=9,
        textColor=colors.white
    )

    elements = []

    # Title & Subtitle Banner
    elements.append(Paragraph("SheetLayout AI — Precision Manufacturing Orders (MO) Report", title_style))
    meta_info = f"Generated: {datetime.now().strftime('%d-%b-%Y %H:%M')} | Records: {len(mos)} | Filter: {(status or 'ALL').upper()}"
    if from_date or to_date:
        meta_info += f" | Date Range: {from_date or 'Start'} to {to_date or 'End'}"
    elements.append(Paragraph(meta_info, subtitle_style))
    elements.append(Spacer(1, 10))

    # Table Header & Rows
    table_data = [[
        Paragraph("#", header_cell_style),
        Paragraph("MO Number", header_cell_style),
        Paragraph("Date", header_cell_style),
        Paragraph("Part Number", header_cell_style),
        Paragraph("Base Part", header_cell_style),
        Paragraph("RM ERP Code", header_cell_style),
        Paragraph("Thk", header_cell_style),
        Paragraph("Sheets", header_cell_style),
        Paragraph("Target Qty", header_cell_style),
        Paragraph("Stage", header_cell_style),
        Paragraph("Status", header_cell_style),
        Paragraph("Route", header_cell_style)
    ]]

    for i, m in enumerate(mos):
        d_str = (m.get("created_at") or "")[:10]
        thk_str = f"{m.get('thickness')}mm" if m.get('thickness') else "-"
        status_val = str(m.get("status") or "DRAFT")
        status_color = "#166534" if status_val == "RELEASED" else ("#b91c1c" if "REJECTED" in status_val else "#b45309")
        status_p = Paragraph(f'<font color="{status_color}"><b>{status_val}</b></font>', cell_style)

        table_data.append([
            Paragraph(str(i + 1), cell_style),
            Paragraph(f"<b>{m.get('mo_number','-')}</b>", cell_style),
            Paragraph(d_str, cell_style),
            Paragraph(m.get("part_no", "-")[:35], cell_style),
            Paragraph(m.get("base_part", "-")[:25], cell_style),
            Paragraph(m.get("rm_erp", "-")[:30], cell_style),
            Paragraph(thk_str, cell_style),
            Paragraph(str(m.get("sheets_required", 1)), cell_style),
            Paragraph(str(m.get("target_qty", 1)), cell_style),
            Paragraph(str(m.get("current_stage", "-")), cell_style),
            status_p,
            Paragraph(str(m.get("workflow_path", "DIRECT_ERP")), cell_style)
        ])

    col_widths = [18, 75, 50, 130, 90, 125, 30, 35, 45, 45, 80, 80]
    t = Table(table_data, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#0f172a')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2.5),
        ('TOPPADDING', (0, 0), (-1, -1), 2.5),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f8fafc')]),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#e2e8f0')),
    ]))
    elements.append(t)

    doc.build(elements)
    pdf_bytes = pdf_buffer.getvalue()

    return Response(
        pdf_bytes,
        mimetype="application/pdf",
        headers={"Content-Disposition": f"attachment; filename=Material_Orders_Report_{today_str}.pdf"}
    )





# ==========================================
# NOTIFICATION API ENDPOINTS
# ==========================================

@app.route("/api/notifications", methods=["GET"])
def get_notifications_endpoint():
    """Returns real-time notifications for the active authenticated department"""
    role = request.headers.get("X-Role") or request.args.get("role") or session.get("role") or "shearing"
    limit = int(request.args.get("limit", 50))
    res = MO_ENGINE.notification_engine.get_notifications_for_role(role, limit=limit)
    return jsonify(res)


@app.route("/api/notifications/mark-read", methods=["POST"])
def mark_notifications_read_endpoint():
    """Mark a specific notification or all notifications as read for current department"""
    body = request.get_json(silent=True) or {}
    role = request.headers.get("X-Role") or body.get("role") or session.get("role") or "shearing"
    notif_id = body.get("notif_id")
    if notif_id in (None, "", "null", "undefined"):
        notif_id = None
    MO_ENGINE.notification_engine.mark_as_read(role, notif_id=notif_id)
    return jsonify({"success": True})


@app.route("/api/notifications/clear", methods=["POST"])
def clear_notifications_endpoint():
    """Mark all notifications as read / cleared for current department"""
    body = request.get_json(silent=True) or {}
    role = request.headers.get("X-Role") or body.get("role") or session.get("role") or "shearing"
    MO_ENGINE.notification_engine.clear_notifications_for_role(role)
    return jsonify({"success": True})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)

