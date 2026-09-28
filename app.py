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
from flask import Flask, render_template, request, jsonify, send_from_directory

app = Flask(__name__)

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


@app.route("/")
def index():
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


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
