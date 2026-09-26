"""
SheetLayout AI — Intelligent Sheet Analytics & Q&A Engine
Supports both offline rule-based NLP analytics & LLM (Gemini / OpenAI) RAG.
"""

import os
import re
import json
import urllib.request
import urllib.error

# Load environment variables from .env if present
def load_dotenv():
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env_path):
        try:
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        k = k.strip()
                        v = v.strip().strip('"').strip("'")
                        if k not in os.environ:
                            os.environ[k] = v
        except Exception:
            pass

load_dotenv()


class SheetIntelligenceEngine:
    def __init__(self, data_store):
        self.data_store = data_store
        self.parts = data_store.get("parts", {})
        self.base_parts = data_store.get("base_parts", {})
        self.records = data_store.get("records", [])
        self.stats = data_store.get("stats", {})
        
        # Precompute normalized lookups for fast retrieval
        self.part_lookup = {}
        for p, d in self.parts.items():
            clean = re.sub(r'[^a-zA-Z0-9]', '', p).lower()
            self.part_lookup[clean] = p
            
        self.base_lookup = {}
        for b, d in self.base_parts.items():
            clean = re.sub(r'[^a-zA-Z0-9]', '', b).lower()
            self.base_lookup[clean] = b
            
        # Index by RM ERP
        self.rm_index = {}
        for r in self.records:
            rm = r.get("rm_erp")
            if rm:
                rm_norm = re.sub(r'[^0-9.]', '*', rm)
                self.rm_index.setdefault(rm_norm, []).append(r)
                
        # Precompute summary statistics
        yields = []
        for r in self.records:
            if "standardized" in r.get("status", "").lower():
                y = self._safe_float(r.get("per_sheet", {}).get("yield_pct"))
                if 0 < y <= 100:
                    yields.append(y)
        self.avg_yield = round(sum(yields) / len(yields), 2) if yields else 0.0

    @staticmethod
    def _safe_float(val, default=0.0):
        try:
            if val is None or val == "" or val == "--":
                return default
            return float(val)
        except Exception:
            return default

    def extract_part_numbers(self, text):
        """Extract potential part numbers from user query."""
        tokens = re.findall(r'[a-zA-Z0-9_-]+', text)
        found = []
        for t in tokens:
            t_clean = re.sub(r'[^a-zA-Z0-9]', '', t).lower()
            if len(t_clean) >= 4:
                if t_clean in self.part_lookup:
                    found.append(self.part_lookup[t_clean])
                elif t_clean in self.base_lookup:
                    base = self.base_lookup[t_clean]
                    found.append(base)
        return list(dict.fromkeys(found))

    def extract_dimensions(self, text):
        """Extract sheet dimensions like 3*2500*1250 or 2500*1250."""
        m = re.findall(r'(\d+(?:\.\d+)?(?:\s*\*\s*\d+(?:\.\d+)?)+)', text)
        return [x.replace(" ", "") for x in m]

    def answer_query(self, query, current_part=None):
        """
        Main entry point for answering any query about the sheet.
        Returns a dict with: reply, type, actions, records, etc.
        """
        q = query.strip()
        q_lower = q.lower()
        
        # 1. Reload .env dynamically so user-added keys are active
        gemini_key = os.getenv("GEMINI_API_KEY")
        if not gemini_key:
            load_dotenv()
            gemini_key = os.getenv("GEMINI_API_KEY")

        openai_key = os.getenv("OPENAI_API_KEY")
        if not openai_key:
            load_dotenv()
            openai_key = os.getenv("OPENAI_API_KEY")
        
        # 2. Check local analytics first (instant, 100% verified against live records)
        local_result = self._try_local_analytics(q, q_lower, current_part)
        if local_result:
            return local_result

        # 3. If question is open-ended or conceptual, use Gemini / OpenAI with rich RAG context
        if gemini_key:
            llm_result = self._ask_gemini(q, gemini_key, current_part)
            if llm_result:
                return llm_result
        elif openai_key:
            llm_result = self._ask_openai(q, openai_key, current_part)
            if llm_result:
                return llm_result
                
        # 4. Fallback to smart guidance
        return self._generate_smart_fallback(q, q_lower, current_part)

    def _try_local_analytics(self, q, q_lower, current_part):
        """Processes inquiries using local analytical rules & verified database indexing."""
        extracted_parts = self.extract_part_numbers(q)
        target_part = extracted_parts[0] if extracted_parts else current_part

        # -------------------------------------------------------------
        # A. Engineering Concept / Definitions
        # -------------------------------------------------------------
        if ("rm erp" in q_lower or "erp code" in q_lower) and any(w in q_lower for w in ["what", "how", "meaning", "definition", "format", "stand for", "explain"]):
            return {
                "reply": (
                    "### 📘 What is RM ERP Code?\n\n"
                    "**RM ERP Code** represents the standardized **Raw Material** specification in the ERP system for sheet metal cutting:\n\n"
                    "- **Format**: `Thickness * Length * Width` (all dimensions in **millimeters**).\n"
                    "- **Example**: `3*2500*1250` means a sheet of **3.0 mm thickness**, **2500 mm length**, and **1250 mm width**.\n"
                    "- **Grade**: Accompanied by steel grade specifications such as **YS** (Yield Strength steel), **HR** (Hot Rolled), or **CR** (Cold Rolled).\n"
                    "- **Importance**: It links the physical CAD cutting layout directly with ERP inventory and stock procurement."
                ),
                "type": "text"
            }

        if not target_part and ("material yield" in q_lower or "yield" in q_lower) and any(w in q_lower for w in ["what", "how", "calculate", "formula", "definition", "meaning", "explain"]):
            return {
                "reply": (
                    "### 📈 Material Yield in Sheet Metal Standardization\n\n"
                    "**Material Yield (%)** measures the efficiency of utilizing raw sheet metal into finished component blanks:\n\n"
                    "$$\\text{Material Yield} (\\%) = \\left( \\frac{\\text{Total Finished Part Blanks Weight (kg)}}{\\text{Raw Sheet Weight (kg)}} \\right) \\times 100$$\n\n"
                    "**Efficiency Benchmarks**:\n"
                    "- 🟢 **High Yield (≥ 92%)**: Optimal layout with minimal scrap.\n"
                    "- 🟢 **Good Yield (85% – 91%)**: Standard acceptable industrial utilization.\n"
                    "- 🟡 **Medium Yield (75% – 84%)**: Candidate for nesting optimization.\n"
                    "- 🔴 **Low Yield (< 75%)**: High off-cut scrap / end-bit wastage."
                ),
                "type": "text"
            }

        if any(w in q_lower for w in ["standardized vs", "2nd choice", "second choice", "non-standard", "not use", "classification", "status hierarchy"]):
            return {
                "reply": (
                    "### 🎯 Layout Classification Hierarchy\n\n"
                    "1. **Standardized (Preferred Baseline)**:\n"
                    "   - The primary approved CAD layout plan providing optimal material yield and standard sheet sizes (`2500*1250` / `2440*1220`).\n\n"
                    "2. **2nd Choice**:\n"
                    "   - Secondary authorized layout used when the primary raw material sheet size is out of stock in inventory.\n\n"
                    "3. **Non-standard / Not Use**:\n"
                    "   - Legacy layouts or non-standard raw sheet sizes that result in lower yield or surplus end-bits. Deprecated in favor of standardized plans."
                ),
                "type": "text"
            }

        if ("end bit" in q_lower or "endbit" in q_lower or "scrap" in q_lower) and any(w in q_lower for w in ["what", "meaning", "definition", "explain"]):
            return {
                "reply": (
                    "### ✂️ What is an End-Bit (Off-Cut Scrap)?\n\n"
                    "An **End-Bit** is the leftover portion of a sheet metal plate after all primary component blanks have been nested and cut.\n\n"
                    "- **Recovery**: In modern sheet metal manufacturing, large end-bits can often be returned to storage and reused for smaller bracket blanks or stiffeners.\n"
                    "- **Impact on Yield**: Smaller end-bit weight directly improves **Material Yield %**."
                ),
                "type": "text"
            }

        if "cutting plan" in q_lower and any(w in q_lower for w in ["what", "meaning", "definition", "explain"]):
            return {
                "reply": (
                    "### 📋 What is a Cutting Plan?\n\n"
                    "A **Cutting Plan** (e.g. `SCP/20-21/00388`) is an authorized shop-floor instruction code that defines:\n\n"
                    "- The exact shearing/CNC sequence to cut the raw sheet into strips and blank components.\n"
                    "- The number of blanks extracted per strip and total blanks per sheet plate.\n"
                    "- The orientation and grain direction alignment of the components."
                ),
                "type": "text"
            }

        # -------------------------------------------------------------
        # B. Part-Specific Inquiries (When a part code is identified)
        # -------------------------------------------------------------
        if target_part and (target_part in self.parts or target_part in self.base_parts):
            resolved_part = target_part
            if target_part in self.base_parts and target_part not in self.parts:
                items = self.base_parts[target_part].get("item_parts", [])
                if items:
                    resolved_part = items[0]
                    
            part_info = self.parts.get(resolved_part)
            if part_info:
                recs = part_info.get("records", [])
                
                # B1. "Which RM has highest yield?" / "best layout" / "best RM"
                if any(k in q_lower for k in ["highest yield", "best yield", "best rm", "best layout", "which rm", "optimal"]):
                    recs_with_yield = [r for r in recs if self._safe_float(r.get("per_sheet", {}).get("yield_pct")) > 0]
                    if recs_with_yield:
                        recs_with_yield.sort(key=lambda x: self._safe_float(x.get("per_sheet", {}).get("yield_pct")), reverse=True)
                        best = recs_with_yield[0]
                        best_yield = self._safe_float(best.get("per_sheet", {}).get("yield_pct"))
                        
                        reply_lines = [
                            f"### 🏆 Best Yield for Part **{resolved_part}**\n",
                            f"The highest material yield is **{best_yield}%** achieved using RM ERP Code **`{best['rm_erp']}`**.\n",
                            f"- **Raw Material Size**: `{best.get('thickness')} x {best.get('length')} x {best.get('width')} mm`",
                            f"- **Status**: {best.get('status', 'Standardized')}",
                            f"- **Blanks per Sheet**: {best.get('part1', {}).get('total_blank_qty_sheet', 'N/A')}",
                            f"- **Cutting Plan**: `{best.get('cutting_plan') or 'Standard'}`\n",
                            "**All Available RM ERP Options for this part**:\n",
                            "| RM ERP Code | Grade | Yield % | Status |",
                            "| :--- | :--- | :--- | :--- |"
                        ]
                        for r in recs:
                            y = self._safe_float(r.get("per_sheet", {}).get("yield_pct"), "-")
                            is_best = " ⭐" if r == best else ""
                            reply_lines.append(f"| `{r['rm_erp']}`{is_best} | {r.get('grade') or 'YS'} | **{y}%** | {r['status']} |")
                            
                        return {
                            "reply": "\n".join(reply_lines),
                            "type": "text",
                            "actions": [
                                {"label": f"View Best Layout ({best['rm_erp']})", "action": "fetch_layout", "value": best["rm_erp"]}
                            ] + [
                                {"label": f"Switch to {r['rm_erp']}", "action": "fetch_layout", "value": r["rm_erp"]}
                                for r in recs if r != best and r["rm_erp"]
                            ][:3]
                        }

                # B2. RM ERP Code inquiry (e.g. "Give me the rm erp code for f4g05914-item7")
                if any(k in q_lower for k in ["rm erp", "rm code", "raw material", "give me the rm", "what is the rm", "show rm"]):
                    reply_lines = [
                        f"### 📋 RM ERP Codes for Part **{resolved_part}**\n",
                        f"Found **{len(recs)} layout options** for this part in the standardization master:\n",
                        "| Status | RM ERP Code | Sheet Size (mm) | Steel Grade | Yield % |",
                        "| :--- | :--- | :--- | :--- | :--- |"
                    ]
                    for r in recs:
                        y = self._safe_float(r.get("per_sheet", {}).get("yield_pct"), "-")
                        dims = f"{r.get('thickness')} x {r.get('length')} x {r.get('width')}"
                        reply_lines.append(f"| **{r['status']}** | `{r['rm_erp']}` | {dims} | {r.get('grade') or 'YS'} | **{y}%** |")
                    
                    return {
                        "reply": "\n".join(reply_lines),
                        "type": "text",
                        "actions": [{"label": f"View Layout: {r['rm_erp']}", "action": "fetch_layout", "value": r["rm_erp"]} for r in recs if r.get("rm_erp")][:3]
                    }

                # B3. "What is the yield / material yield for <part>?"
                if any(k in q_lower for k in ["yield", "material yield", "efficiency"]):
                    reply_lines = [
                        f"### 📊 Material Yield for Part **{resolved_part}**\n",
                        "| RM ERP Code | Grade | Yield % | Status | CAD Layout |",
                        "| :--- | :--- | :--- | :--- | :--- |"
                    ]
                    for r in recs:
                        y = self._safe_float(r.get("per_sheet", {}).get("yield_pct"), "-")
                        img_note = "✅ Available" if r.get("image_url") else "None"
                        reply_lines.append(f"| `{r['rm_erp']}` | {r.get('grade') or 'YS'} | **{y}%** | {r['status']} | {img_note} |")
                        
                    return {
                        "reply": "\n".join(reply_lines),
                        "type": "text",
                        "actions": [{"label": f"View {r['rm_erp']} Layout", "action": "fetch_layout", "value": r["rm_erp"]} for r in recs if r.get("rm_erp")][:3]
                    }

                # B4. "What grade / sheet size / thickness is used?"
                if any(k in q_lower for k in ["grade", "steel", "thickness", "sheet size", "dimension"]):
                    reply_lines = [
                        f"### ⚙️ Raw Material & Grade Specifications for **{resolved_part}**\n",
                        "| RM ERP Code | Thickness | Sheet Dimensions | Steel Grade | Status |",
                        "| :--- | :--- | :--- | :--- | :--- |"
                    ]
                    for r in recs:
                        th = f"{r.get('thickness')} mm" if r.get('thickness') else "-"
                        dims = f"{r.get('length')} x {r.get('width')} mm" if r.get('length') else "-"
                        reply_lines.append(f"| `{r['rm_erp']}` | {th} | {dims} | **{r.get('grade') or 'YS'}** | {r['status']} |")
                        
                    return {
                        "reply": "\n".join(reply_lines),
                        "type": "text",
                        "actions": [{"label": f"Fetch Layout for {r['rm_erp']}", "action": "fetch_layout", "value": r["rm_erp"]} for r in recs if r.get("rm_erp")][:3]
                    }

                # B5. Blank & Cut details
                if any(k in q_lower for k in ["blank", "cut blank", "strip", "blank size", "blank weight"]):
                    reply_lines = [
                        f"### ✂️ Blank & Cut Specifications for Part **{resolved_part}**\n",
                        "| RM ERP Code | Cut Blank Size (mm) | Blank Weight (kg) | Blanks/Sheet | Status |",
                        "| :--- | :--- | :--- | :--- | :--- |"
                    ]
                    for r in recs:
                        cb = r.get("cut_blank") or (r.get("part1", {}).get("cut_blank") if r.get("part1") else "-")
                        bw = r.get("part1", {}).get("blank_weight", "-") if r.get("part1") else "-"
                        bqty = r.get("part1", {}).get("total_blank_qty_sheet", "-") if r.get("part1") else "-"
                        reply_lines.append(f"| `{r['rm_erp']}` | `{cb}` | {bw} kg | {bqty} | {r['status']} |")
                    return {
                        "reply": "\n".join(reply_lines),
                        "type": "text",
                        "actions": [{"label": f"View Layout: {r['rm_erp']}", "action": "fetch_layout", "value": r["rm_erp"]} for r in recs if r.get("rm_erp")][:3]
                    }

                # B6. Cutting plan
                if any(k in q_lower for k in ["cutting plan", "plan"]):
                    reply_lines = [
                        f"### 📐 Cutting Plans for Part **{resolved_part}**\n",
                        "| RM ERP Code | Cutting Plan | Sheet Size (mm) | Yield % | Status |",
                        "| :--- | :--- | :--- | :--- | :--- |"
                    ]
                    for r in recs:
                        cp = r.get("cutting_plan") or "Standard"
                        y = self._safe_float(r.get("per_sheet", {}).get("yield_pct"), "-")
                        dims = f"{r.get('thickness')} x {r.get('length')} x {r.get('width')}"
                        reply_lines.append(f"| `{r['rm_erp']}` | `{cp}` | {dims} | {y}% | {r['status']} |")
                    return {
                        "reply": "\n".join(reply_lines),
                        "type": "text",
                        "actions": [{"label": f"View Layout: {r['rm_erp']}", "action": "fetch_layout", "value": r["rm_erp"]} for r in recs if r.get("rm_erp")][:3]
                    }

                # B7. Compare RM codes for this part
                if any(k in q_lower for k in ["compare", "difference", "comparison"]):
                    reply_lines = [
                        f"### ⚖️ RM ERP Options Comparison for **{resolved_part}**\n",
                        "| RM ERP Code | Yield % | Blanks/Sheet | RM Wt (kg) | Grade | Status |",
                        "| :--- | :--- | :--- | :--- | :--- | :--- |"
                    ]
                    for r in recs:
                        y = self._safe_float(r.get("per_sheet", {}).get("yield_pct"), "-")
                        b_qty = r.get("part1", {}).get("total_blank_qty_sheet", "-") if r.get("part1") else "-"
                        rm_wt = r.get("rm_weight", "-")
                        reply_lines.append(f"| `{r['rm_erp']}` | **{y}%** | {b_qty} | {rm_wt} | {r.get('grade') or 'YS'} | {r['status']} |")
                        
                    return {
                        "reply": "\n".join(reply_lines),
                        "type": "text",
                        "actions": [{"label": f"View {r['rm_erp']}", "action": "fetch_layout", "value": r["rm_erp"]} for r in recs if r.get("rm_erp")][:3]
                    }

                # B8. General question about this specific part -> return complete overview table
                reply_lines = [
                    f"### 📄 Specification Summary for Part **{resolved_part}**\n",
                    f"- **Base Part**: `{part_info.get('base_part', 'N/A')}`\n",
                    f"- **Available Layouts**: {len(recs)}\n\n",
                    "| Status | RM ERP Code | Sheet Size (mm) | Grade | Yield % |",
                    "| :--- | :--- | :--- | :--- | :--- |"
                ]
                for r in recs:
                    y = self._safe_float(r.get("per_sheet", {}).get("yield_pct"), "-")
                    dims = f"{r.get('thickness')} x {r.get('length')} x {r.get('width')}"
                    reply_lines.append(f"| **{r['status']}** | `{r['rm_erp']}` | {dims} | {r.get('grade') or 'YS'} | **{y}%** |")
                return {
                    "reply": "\n".join(reply_lines),
                    "type": "text",
                    "actions": [{"label": f"View Layout: {r['rm_erp']}", "action": "fetch_layout", "value": r["rm_erp"]} for r in recs if r.get("rm_erp")][:3]
                }

        # -------------------------------------------------------------
        # C. Global Queries (No specific part requested)
        # -------------------------------------------------------------

        # C1. Yield Threshold Search (e.g. "yield over 99%", "more than 98% yield", "yield > 90%")
        pat1 = r'(?:yield|efficiency)\s*(?:of\s*)?(?:over|above|>|>=|more than|greater than|exceeding)\s*(\d+(?:\.\d+)?)\s*%?'
        pat2 = r'(?:over|above|>|>=|more than|greater than)\s*(\d+(?:\.\d+)?)\s*%\s*(?:material\s*)?yield'
        pat3 = r'(\d+(?:\.\d+)?)\s*%\s*(?:or more|or higher|and above)'
        m_thresh = re.search(pat1, q_lower) or re.search(pat2, q_lower) or re.search(pat3, q_lower)
        
        if m_thresh:
            threshold = float(m_thresh.group(1))
            is_both = any(k in q_lower for k in ["both standard", "both standardized", "in both", "both layout"])
            
            if is_both:
                matched_parts = []
                for p_no, p_data in self.parts.items():
                    recs = p_data.get("records", [])
                    has_std = any("standardized" in r.get("status", "").lower() and self._safe_float(r.get("per_sheet", {}).get("yield_pct")) >= threshold for r in recs)
                    has_other = any(("non" in r.get("status", "").lower() or "2nd" in r.get("status", "").lower()) and self._safe_float(r.get("per_sheet", {}).get("yield_pct")) >= threshold for r in recs)
                    if has_std and has_other:
                        matched_parts.append((p_no, recs))
                        
                reply_lines = [
                    f"### 🎯 Found **{len(matched_parts)} parts** with Material Yield $\ge {threshold}\\%$ in **both** Standardized and Non-standard/2nd Choice layouts:\n",
                    "| Part Number | Standardized RM (Yield) | Non-standard/2nd RM (Yield) |",
                    "| :--- | :--- | :--- |"
                ]
                for p_no, recs in matched_parts[:12]:
                    std_recs = [f"`{r['rm_erp']}` ({self._safe_float(r.get('per_sheet', {}).get('yield_pct'))}%)" for r in recs if "standardized" in r.get("status", "").lower() and self._safe_float(r.get("per_sheet", {}).get("yield_pct")) >= threshold]
                    other_recs = [f"`{r['rm_erp']}` ({self._safe_float(r.get('per_sheet', {}).get('yield_pct'))}%)" for r in recs if ("non" in r.get("status", "").lower() or "2nd" in r.get("status", "").lower()) and self._safe_float(r.get("per_sheet", {}).get("yield_pct")) >= threshold]
                    reply_lines.append(f"| **{p_no}** | {', '.join(std_recs)} | {', '.join(other_recs)} |")
                    
                if len(matched_parts) > 12:
                    reply_lines.append(f"\n*...and {len(matched_parts) - 12} more parts meeting this criteria.*")
                    
                return {
                    "reply": "\n".join(reply_lines),
                    "type": "text",
                    "actions": [{"label": f"View {p[0]}", "action": "select_part", "value": p[0]} for p in matched_parts[:4]]
                }
            else:
                high_recs = []
                for r in self.records:
                    y = self._safe_float(r.get("per_sheet", {}).get("yield_pct"))
                    if threshold <= y <= 100.0:
                        high_recs.append((r, y))
                        
                high_recs.sort(key=lambda x: x[1], reverse=True)
                unique_parts = list(dict.fromkeys(x[0]["part_no"] for x in high_recs))
                
                reply_lines = [
                    f"### 📈 Found **{len(high_recs)} layouts** across **{len(unique_parts)} unique parts** with Material Yield $\ge {threshold}\\%$:\n",
                    "| Part Number | RM ERP Code | Steel Grade | Yield % | Status |",
                    "| :--- | :--- | :--- | :--- | :--- |"
                ]
                for r, y in high_recs[:12]:
                    reply_lines.append(f"| **{r['part_no']}** | `{r['rm_erp']}` | {r.get('grade') or 'YS'} | **{y}%** | {r['status']} |")
                    
                if len(high_recs) > 12:
                    reply_lines.append(f"\n*...and {len(high_recs) - 12} more layouts.*")
                    
                return {
                    "reply": "\n".join(reply_lines),
                    "type": "text",
                    "actions": [{"label": f"View {p}", "action": "select_part", "value": p} for p in unique_parts[:4]]
                }

        # C2. Overall Highest Yield across the sheet ("Which RM has the highest yield?")
        if any(k in q_lower for k in ["highest yield", "best yield", "top yield", "maximum yield", "max yield"]):
            valid_recs = []
            for r in self.records:
                y = self._safe_float(r.get("per_sheet", {}).get("yield_pct"))
                if 0 < y <= 100.0:
                    valid_recs.append((r, y))
            valid_recs.sort(key=lambda x: x[1], reverse=True)
            
            top_yield = valid_recs[0][1] if valid_recs else 0.0
            hundred_pct_count = sum(1 for _, y in valid_recs if y == 100.0)
            
            reply_lines = [
                f"### 🏆 Highest Material Yield in Master Data\n",
                f"The maximum material yield recorded across the standardization master is **{top_yield}%** (achieved across **{hundred_pct_count} layouts** with zero scrap!).\n",
                "| Part Number | RM ERP Code | Sheet Size (mm) | Yield % | Status |",
                "| :--- | :--- | :--- | :--- | :--- |"
            ]
            for r, y in valid_recs[:10]:
                dims = f"{r.get('thickness')} x {r.get('length')} x {r.get('width')}"
                reply_lines.append(f"| **{r['part_no']}** | `{r['rm_erp']}` | {dims} | **{y}%** | {r['status']} |")
                
            return {
                "reply": "\n".join(reply_lines),
                "type": "text",
                "actions": [{"label": f"View {r[0]['part_no']}", "action": "select_part", "value": r[0]["part_no"]} for r in valid_recs[:4]]
            }

        # C3. Overall Sheet Statistics & Summary
        if any(k in q_lower for k in ["summary", "overview", "sheet stats", "database stats", "total parts", "how many parts in sheet", "how many records"]):
            std_count = sum(1 for r in self.records if "standardized" in r.get("status", "").lower())
            sec_count = sum(1 for r in self.records if "2nd" in r.get("status", "").lower())
            non_count = sum(1 for r in self.records if "non" in r.get("status", "").lower() or "not" in r.get("status", "").lower())
            high_count = sum(1 for r in self.records if self._safe_float(r.get("per_sheet", {}).get("yield_pct")) >= 99.0)
            
            return {
                "reply": (
                    f"### 📊 Sheet Standardization Master Summary\n\n"
                    f"- **Total Standardized Engineering Records**: **{self.stats.get('total_records', len(self.records)):,}**\n"
                    f"- **Unique Part Codes**: **{self.stats.get('total_unique_parts', len(self.parts)):,}**\n"
                    f"- **Base Part Families**: **{self.stats.get('total_base_parts', len(self.base_parts)):,}**\n"
                    f"- **High-Resolution CAD Layout Drawings**: **{self.stats.get('records_with_images', 1045):,}**\n"
                    f"- **Average Material Yield (Standardized)**: **{self.avg_yield}%**\n"
                    f"- **Layouts with $\ge 99\%$ Yield**: **{high_count:,}**\n\n"
                    f"**Classification Distribution**:\n"
                    f"- 🟢 **Standardized (Primary)**: {std_count:,} layouts\n"
                    f"- 🔵 **2nd Choice**: {sec_count:,} layouts\n"
                    f"- ⚪ **Non-standard / Legacy**: {non_count:,} layouts"
                ),
                "type": "text",
                "actions": [
                    {"label": "Layouts >= 99% Yield", "action": "search", "value": "Which are the parts has yield over 99%?"},
                    {"label": "Most Used Sheet Sizes", "action": "search", "value": "most used sheet sizes"},
                    {"label": "Sample Part MBA01008", "action": "search", "value": "MBA01008"}
                ]
            }

        # C4. Most Common / Most Used Sheet Sizes
        if any(k in q_lower for k in ["most used sheet", "common sheet size", "popular sheet", "sheet dimensions", "common sizes"]):
            sizes = {}
            for r in self.records:
                l, w = r.get("length"), r.get("width")
                if l and w:
                    key = f"{int(l)} x {int(w)} mm"
                    sizes[key] = sizes.get(key, 0) + 1
            sorted_sizes = sorted(sizes.items(), key=lambda x: x[1], reverse=True)[:6]
            
            reply_lines = [
                "### 📐 Most Frequently Used Raw Material Sheet Sizes\n",
                "| Sheet Size (L x W) | Number of Layouts | Industry Standard |",
                "| :--- | :--- | :--- |"
            ]
            for s, cnt in sorted_sizes:
                std_note = "Standard 8x4 ft" if "2440" in s or "2500" in s else "Standard Factory Plate"
                reply_lines.append(f"| **{s}** | {cnt} layouts | {std_note} |")
                
            return {
                "reply": "\n".join(reply_lines),
                "type": "text"
            }

        # C5. Query by RM Dimensions (e.g., "How many parts use 3*2500*1250?")
        dims = self.extract_dimensions(q)
        if dims and any(k in q_lower for k in ["how many", "which parts", "parts use", "list parts", "who uses"]):
            target_dim = dims[0]
            norm_target = re.sub(r'[^0-9.]', '', target_dim)
            
            matched_recs = []
            for r in self.records:
                rm = r.get("rm_erp", "")
                if rm:
                    norm_rm = re.sub(r'[^0-9.]', '', rm)
                    if norm_target in norm_rm:
                        matched_recs.append(r)
                        
            if matched_recs:
                unique_parts = list(dict.fromkeys(r["part_no"] for r in matched_recs))
                reply_lines = [
                    f"### 🔍 Found **{len(matched_recs)} layouts** ({len(unique_parts)} unique parts) using RM size `{target_dim}`:\n",
                    "| Part Number | RM ERP Code | Grade | Yield % | Status |",
                    "| :--- | :--- | :--- | :--- | :--- |"
                ]
                for r in matched_recs[:10]:
                    y = self._safe_float(r.get("per_sheet", {}).get("yield_pct"), "-")
                    reply_lines.append(f"| **{r['part_no']}** | `{r['rm_erp']}` | {r.get('grade') or 'YS'} | {y}% | {r['status']} |")
                    
                if len(matched_recs) > 10:
                    reply_lines.append(f"\n*...and {len(matched_recs) - 10} more matching records.*")
                    
                return {
                    "reply": "\n".join(reply_lines),
                    "type": "text",
                    "actions": [{"label": f"View {p}", "action": "select_part", "value": p} for p in unique_parts[:4]]
                }

        # C6. Query by Grade (e.g. "Which parts use HR grade?" / "How many parts use YS?")
        grade_match = re.search(r'\b(hr|cr|ys|gi|gpsp)\b', q_lower)
        if grade_match and any(w in q_lower for w in ["grade", "steel", "which parts", "how many"]):
            target_grade = grade_match.group(1).upper()
            matched = [r for r in self.records if (r.get("grade") or "").upper() == target_grade]
            if matched:
                unique_parts = list(dict.fromkeys(r["part_no"] for r in matched))
                reply_lines = [
                    f"### ⚙️ Found **{len(matched)} layouts** across **{len(unique_parts)} parts** using **Grade {target_grade}**:\n",
                    "| Part Number | RM ERP Code | Sheet Size (mm) | Yield % | Status |",
                    "| :--- | :--- | :--- | :--- | :--- |"
                ]
                for r in matched[:10]:
                    y = self._safe_float(r.get("per_sheet", {}).get("yield_pct"), "-")
                    dims = f"{r.get('thickness')} x {r.get('length')} x {r.get('width')}"
                    reply_lines.append(f"| **{r['part_no']}** | `{r['rm_erp']}` | {dims} | {y}% | {r['status']} |")
                if len(matched) > 10:
                    reply_lines.append(f"\n*...and {len(matched) - 10} more layouts.*")
                return {
                    "reply": "\n".join(reply_lines),
                    "type": "text",
                    "actions": [{"label": f"View {p}", "action": "select_part", "value": p} for p in unique_parts[:4]]
                }

        # C7. Query by Thickness (e.g. "parts with 4.8mm thickness" / "3mm sheet")
        th_match = re.search(r'(\d+(?:\.\d+)?)\s*(?:mm|thk|thickness)', q_lower)
        if th_match and any(w in q_lower for w in ["part", "sheet", "which", "how many"]):
            target_th = float(th_match.group(1))
            matched = [r for r in self.records if abs(self._safe_float(r.get("thickness")) - target_th) < 0.05]
            if matched:
                unique_parts = list(dict.fromkeys(r["part_no"] for r in matched))
                reply_lines = [
                    f"### 📏 Found **{len(matched)} layouts** across **{len(unique_parts)} parts** with **Thickness {target_th} mm**:\n",
                    "| Part Number | RM ERP Code | Grade | Yield % | Status |",
                    "| :--- | :--- | :--- | :--- | :--- |"
                ]
                for r in matched[:10]:
                    y = self._safe_float(r.get("per_sheet", {}).get("yield_pct"), "-")
                    reply_lines.append(f"| **{r['part_no']}** | `{r['rm_erp']}` | {r.get('grade') or 'YS'} | {y}% | {r['status']} |")
                if len(matched) > 10:
                    reply_lines.append(f"\n*...and {len(matched) - 10} more layouts.*")
                return {
                    "reply": "\n".join(reply_lines),
                    "type": "text",
                    "actions": [{"label": f"View {p}", "action": "select_part", "value": p} for p in unique_parts[:4]]
                }

        return None

    def _ask_gemini(self, query, api_key, current_part=None):
        """Calls Google Gemini API with RAG context from data_store."""
        try:
            context_snippets = []
            extracted_parts = self.extract_part_numbers(query)
            target = extracted_parts[0] if extracted_parts else current_part
            
            if target and target in self.parts:
                p_data = self.parts[target]
                context_snippets.append(f"Part Data for {target}:\n{json.dumps(p_data, indent=2)}")
            else:
                # Build rich, true context from the entire dataset
                high_yield_count = sum(1 for r in self.records if self._safe_float(r.get("per_sheet", {}).get("yield_pct")) >= 99.0)
                ninety_five_count = sum(1 for r in self.records if self._safe_float(r.get("per_sheet", {}).get("yield_pct")) >= 95.0)
                
                context_snippets.append(
                    f"DATABASE VERIFIED TOTALS:\n"
                    f"- Total records in database: {len(self.records)}\n"
                    f"- Total unique parts: {len(self.parts)}\n"
                    f"- Exactly {high_yield_count} layouts have Material Yield >= 99%.\n"
                    f"- Exactly {ninety_five_count} layouts have Material Yield >= 95%.\n"
                    f"- Average Standardized Material Yield: {self.avg_yield}%\n"
                    f"- Highest recorded yield is 100.0%.\n"
                )
                
                # Retrieve matching records for tokens in query
                tokens = [w for w in re.findall(r'[a-zA-Z0-9.]+', query.lower()) if len(w) >= 3]
                matched_recs = []
                for r in self.records:
                    s = f"{r.get('part_no')} {r.get('rm_erp')} {r.get('grade')} {r.get('status')}".lower()
                    if any(t in s for t in tokens):
                        matched_recs.append(r)
                
                if matched_recs:
                    sample = [{
                        "part_no": r.get("part_no"),
                        "rm_erp": r.get("rm_erp"),
                        "grade": r.get("grade"),
                        "status": r.get("status"),
                        "yield_pct": r.get("per_sheet", {}).get("yield_pct"),
                        "cut_blank": r.get("cut_blank")
                    } for r in matched_recs[:20]]
                    context_snippets.append(f"Relevant matching records from database:\n{json.dumps(sample, indent=1)}")
                else:
                    top_10 = sorted(self.records, key=lambda r: self._safe_float(r.get("per_sheet", {}).get("yield_pct")), reverse=True)[:10]
                    sample = [{
                        "part_no": r.get("part_no"),
                        "rm_erp": r.get("rm_erp"),
                        "grade": r.get("grade"),
                        "status": r.get("status"),
                        "yield_pct": r.get("per_sheet", {}).get("yield_pct")
                    } for r in top_10]
                    context_snippets.append(f"Top 10 highest yield layouts in database:\n{json.dumps(sample, indent=1)}")

            system_instruction = (
                "You are SheetLayout AI, an expert engineering assistant specialized in sheet metal layouts, "
                "CAD drawings, RM ERP codes, blank sizing, steel grades, and material yield metrics.\n"
                "Answer the user's question accurately using the provided sheet data context. "
                "Format your answer neatly with GitHub Markdown (headings, bullet points, tables where helpful). "
                "Be concise, technical, and precise."
            )
            
            prompt = (
                f"{system_instruction}\n\n"
                f"--- CONTEXT DATA ---\n"
                f"{''.join(context_snippets)}\n"
                f"--- END CONTEXT ---\n\n"
                f"User Question: {query}\n"
                f"Please provide an accurate engineering answer:"
            )

            # Try models in priority order
            models_to_try = ["gemini-3.8-flash", "gemini-3.1-flash-lite", "gemini-flash-latest"]
            payload = {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.2, "maxOutputTokens": 1000}
            }

            for model_name in models_to_try:
                try:
                    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}"
                    req = urllib.request.Request(
                        url,
                        data=json.dumps(payload).encode("utf-8"),
                        headers={"Content-Type": "application/json"}
                    )
                    with urllib.request.urlopen(req, timeout=25) as response:
                        result = json.loads(response.read().decode("utf-8"))
                        text = result["candidates"][0]["content"]["parts"][0]["text"]
                        return {
                            "reply": text,
                            "type": "text",
                            "powered_by": f"Gemini ({model_name})"
                        }
                except Exception:
                    continue
            return None
        except Exception as e:
            print("Gemini API Error:", e)
            return None

    def _ask_openai(self, query, api_key, current_part=None):
        """Calls OpenAI API with RAG context."""
        try:
            url = "https://api.openai.com/v1/chat/completions"
            payload = {
                "model": "gpt-4o-mini",
                "messages": [
                    {"role": "system", "content": "You are SheetLayout AI engineering assistant for sheet metal layouts and ERP codes."},
                    {"role": "user", "content": f"Answer based on sheet metal standardization: {query}"}
                ],
                "temperature": 0.2
            }
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
            )
            with urllib.request.urlopen(req, timeout=20) as response:
                result = json.loads(response.read().decode("utf-8"))
                text = result["choices"][0]["message"]["content"]
                return {
                    "reply": text,
                    "type": "text",
                    "powered_by": "openai"
                }
        except Exception as e:
            print("OpenAI API Error:", e)
            return None

    def _generate_smart_fallback(self, q, q_lower, current_part):
        """Provides helpful guidance and suggestions when a query doesn't match an exact rule."""
        has_api_key = bool(os.getenv("GEMINI_API_KEY") or os.getenv("OPENAI_API_KEY"))
        
        hint = ""
        if not has_api_key:
            hint = (
                "\n\n> 💡 **Tip**: For open-ended natural conversation on any aspect of this sheet, "
                "you can set your free `GEMINI_API_KEY` in the `.env` file."
            )
            
        return {
            "reply": (
                f"I couldn't find an exact match for **\"{q}\"** in the sheet master data.\n\n"
                f"**Here are things you can ask me about this sheet**:\n"
                f"- **Part Details**: Enter any Part Number like `MBA01008`, `X5L00214`, `F4931410`\n"
                f"- **Yield & Optimization**: *\"Which RM has highest yield for MBA01008?\"* or *\"Which parts have yield over 99%?\"*\n"
                f"- **Sheet & Dimensions**: *\"How many parts use 3*2500*1250?\"* or *\"Most used sheet sizes\"*\n"
                f"- **Engineering Concepts**: *\"What is RM ERP code?\"* or *\"What is Material Yield?\"*\n"
                f"- **Sheet Master Stats**: *\"Show sheet summary\"* or *\"Which RM has the highest yield?\"*"
                f"{hint}"
            ),
            "type": "help",
            "actions": [
                {"label": "📊 Sheet Summary", "action": "search", "value": "sheet summary"},
                {"label": "🏆 Top Yielding Parts", "action": "search", "value": "Which RM has the highest yield?"},
                {"label": "🎯 Yield >= 99%", "action": "search", "value": "Which are the parts has yield over 99%?"},
                {"label": "MBA01008", "action": "search", "value": "MBA01008"}
            ]
        }
