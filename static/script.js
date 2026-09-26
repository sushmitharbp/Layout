/**
 * SheetLayout AI — Interactive Chatbot Controller
 */

// Application State
const state = {
    currentPart: null,
    currentRm: null,
    chatHistory: [],
    zoomLevel: 1.0,
    searchTimeout: null
};

// DOM Elements
const chatFeed = document.getElementById("chatFeed");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const inputClearBtn = document.getElementById("inputClearBtn");
const typingIndicator = document.getElementById("typingIndicator");
const inputAutocomplete = document.getElementById("inputAutocomplete");
const quickSearchInput = document.getElementById("quickSearchInput");
const quickSearchDropdown = document.getElementById("quickSearchDropdown");
const clearChatBtn = document.getElementById("clearChatBtn");
const exportChatBtn = document.getElementById("exportChatBtn");

// Modals
const imageModal = document.getElementById("imageModal");
const modalImage = document.getElementById("modalImage");
const modalLayoutTitle = document.getElementById("modalLayoutTitle");
const modalLayoutSubtitle = document.getElementById("modalLayoutSubtitle");
const downloadImageBtn = document.getElementById("downloadImageBtn");
const modalCloseBtn = document.getElementById("modalCloseBtn");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomResetBtn = document.getElementById("zoomResetBtn");

const helpModal = document.getElementById("helpModal");
const helpModalBtn = document.getElementById("helpModalBtn");
const helpModalCloseBtn = document.getElementById("helpModalCloseBtn");

const mobileMenuBtn = document.getElementById("mobileMenuBtn");
const sidebarCloseBtn = document.getElementById("sidebarCloseBtn");
const sidebar = document.getElementById("sidebar");
const sidebarOverlay = document.getElementById("sidebarOverlay");

function openMobileSidebar() {
    if (sidebar) sidebar.classList.add("open");
    if (sidebarOverlay) sidebarOverlay.classList.add("active");
}

function closeMobileSidebar() {
    if (sidebar) sidebar.classList.remove("open");
    if (sidebarOverlay) sidebarOverlay.classList.remove("active");
}

// ===================================================================
// Initialization
// ===================================================================

document.addEventListener("DOMContentLoaded", () => {
    initEventListeners();
});

function initEventListeners() {
    // Chat Form Submit
    chatForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = chatInput.value.trim();
        if (text) {
            handleSendMessage(text);
        }
    });

    // Chat Input typing & autocomplete
    chatInput.addEventListener("input", (e) => {
        const val = e.target.value.trim();
        inputClearBtn.style.display = val ? "block" : "none";
        debounceSearch(val, inputAutocomplete, (selectedPart) => {
            chatInput.value = selectedPart;
            inputAutocomplete.style.display = "none";
            handleSendMessage(selectedPart);
        });
    });

    inputClearBtn.addEventListener("click", () => {
        chatInput.value = "";
        inputClearBtn.style.display = "none";
        inputAutocomplete.style.display = "none";
        chatInput.focus();
    });

    // Quick Search in Sidebar
    quickSearchInput.addEventListener("input", (e) => {
        const val = e.target.value.trim();
        debounceSearch(val, quickSearchDropdown, (selectedPart) => {
            quickSearchInput.value = "";
            quickSearchDropdown.style.display = "none";
            handleSendMessage(selectedPart);
            if (window.innerWidth <= 768) {
                sidebar.classList.remove("open");
            }
        });
    });

    // Document click to close autocomplete dropdowns
    document.addEventListener("click", (e) => {
        if (!chatInput.contains(e.target) && !inputAutocomplete.contains(e.target)) {
            inputAutocomplete.style.display = "none";
        }
        if (!quickSearchInput.contains(e.target) && !quickSearchDropdown.contains(e.target)) {
            quickSearchDropdown.style.display = "none";
        }
    });

    // Clear Chat
    clearChatBtn.addEventListener("click", () => {
        if (confirm("Reset current chat session?")) {
            resetSession();
        }
    });

    // Export Chat (if present)
    if (exportChatBtn) {
        exportChatBtn.addEventListener("click", exportConversation);
    }

    // Modal controls
    if (modalCloseBtn) modalCloseBtn.addEventListener("click", closeImageModal);
    if (imageModal) {
        imageModal.addEventListener("click", (e) => {
            if (e.target === imageModal) closeImageModal();
        });
    }

    if (zoomInBtn) zoomInBtn.addEventListener("click", () => updateZoom(0.2));
    if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => updateZoom(-0.2));
    if (zoomResetBtn) zoomResetBtn.addEventListener("click", () => resetZoom());

    if (helpModalBtn && helpModal) {
        helpModalBtn.addEventListener("click", () => helpModal.style.display = "flex");
    }
    if (helpModalCloseBtn && helpModal) {
        helpModalCloseBtn.addEventListener("click", () => helpModal.style.display = "none");
    }
    if (helpModal) {
        helpModal.addEventListener("click", (e) => {
            if (e.target === helpModal) helpModal.style.display = "none";
        });
    }

    // Mobile Sidebar
    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener("click", openMobileSidebar);
    }
    if (sidebarCloseBtn) {
        sidebarCloseBtn.addEventListener("click", closeMobileSidebar);
    }
    if (sidebarOverlay) {
        sidebarOverlay.addEventListener("click", closeMobileSidebar);
    }
}

// ===================================================================
// Core Chat Handling
// ===================================================================

async function handleSendMessage(text) {
    // 1. Append User Message
    appendUserMessage(text);
    chatInput.value = "";
    inputClearBtn.style.display = "none";
    inputAutocomplete.style.display = "none";

    // 2. Show Typing Indicator
    showTyping(true);
    scrollToBottom();

    let data;
    try {
        const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                message: text,
                current_part: state.currentPart,
                current_rm: state.currentRm
            })
        });

        data = await response.json();
    } catch (netErr) {
        showTyping(false);
        appendErrorMessage("Network connection error. Please verify the local server is running.");
        console.error("Network error:", netErr);
        return;
    }

    showTyping(false);
    try {
        renderBotResponse(data);
    } catch (renderErr) {
        console.error("Rendering error:", renderErr);
        appendErrorMessage("Error displaying layout data: " + renderErr.message);
    }
}

function appendUserMessage(text) {
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const wrapper = document.createElement("div");
    wrapper.className = "message-wrapper user animate-in";
    wrapper.innerHTML = `
        <div class="message-bubble user-bubble">
            <div class="bubble-header">
                <span class="sender-name" style="color: rgba(255,255,255,0.85);">You</span>
                <span class="message-time" style="color: rgba(255,255,255,0.7);">${timeStr}</span>
            </div>
            <div class="bubble-content">
                <p>${escapeHtml(text)}</p>
            </div>
        </div>
    `;
    chatFeed.appendChild(wrapper);
    state.chatHistory.push({ sender: "user", text, time: timeStr });
    scrollToBottom();
}

function renderBotResponse(data) {
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const wrapper = document.createElement("div");
    wrapper.className = "message-wrapper bot animate-in";

    let htmlContent = "";

    // Header & Natural Reply
    if (data.reply) {
        htmlContent += `<div class="chat-reply-body">${formatMarkdown(data.reply)}</div>`;
    }

    // Type 1: RM ERP Codes List for a Part
    if (data.type === "part_rm_list" && data.records) {
        state.currentPart = data.part_no;
        htmlContent += renderPartRmList(data);
    }

    // Type 2: Detailed Layout View (Drawing + Specs in exact PRINT sheet format)
    else if ((data.type === "print_sheet" || data.type === "layout_detail") && data.record) {
        state.currentPart = data.part_no;
        state.currentRm = data.record.rm_erp;
        htmlContent += renderPrintSheet(data);
    }

    // Type 3: Multiple Matching Parts Selection (Base Part)
    else if (data.type === "part_choices" && data.items) {
        htmlContent += renderPartChoices(data);
    }

    // Suggestions / Quick action chips
    if (data.actions && data.actions.length > 0) {
        htmlContent += `
            <div class="quick-chips-group">
                <span class="chip-label"><i class="fa-solid fa-angles-right"></i> Quick Actions:</span>
                <div class="chips-container">
                    ${data.actions.map(act => `
                        <button class="chip" onclick="handleActionClick('${escapeHtml(act.action)}', '${escapeHtml(act.value)}')">
                            ${escapeHtml(act.label)}
                        </button>
                    `).join('')}
                </div>
            </div>
        `;
    }

    wrapper.innerHTML = `
        <div class="bot-avatar">
            <i class="fa-solid fa-microchip"></i>
        </div>
        <div class="message-bubble bot-bubble">
            <div class="bubble-header">
                <span class="sender-name">Layout AI Assistant</span>
                <span class="message-time">${timeStr}</span>
            </div>
            <div class="bubble-content">
                ${htmlContent}
            </div>
        </div>
    `;

    chatFeed.appendChild(wrapper);
    state.chatHistory.push({ sender: "bot", data, time: timeStr });
    scrollToBottom();
}

// ===================================================================
// Template Renderers
// ===================================================================

function renderPartRmList(data) {
    const records = data.records || [];
    const stdRec = records.find(r => (r.status || "").toLowerCase().includes("standardized")) || records[0];

    return `
        <div class="part-header-card">
            <div class="part-title-group">
                <h3><i class="fa-solid fa-cube"></i> ${escapeHtml(data.part_no)}</h3>
                <p>Base Part: <strong>${escapeHtml(data.base_part || 'N/A')}</strong></p>
            </div>
            <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                <div class="part-stats-badge">
                    ${records.length} RM ERP Code${records.length > 1 ? 's' : ''} Present
                </div>
                ${stdRec ? `
                    <button class="sheet-action-btn primary" onclick="fetchLayoutForRM('${escapeHtml(stdRec.rm_erp)}', '${escapeHtml(data.part_no)}')">
                        <i class="fa-solid fa-print"></i> Open Standardized Print Sheet
                    </button>
                ` : ''}
            </div>
        </div>

        <div class="rm-cards-grid">
            ${records.map(rec => {
                const statusClass = getStatusClass(rec.status);
                const yieldPct = (rec.per_sheet && rec.per_sheet.yield_pct !== null && rec.per_sheet.yield_pct !== undefined) ? rec.per_sheet.yield_pct : (rec.material_yield_pct !== null && rec.material_yield_pct !== undefined ? rec.material_yield_pct : '--');
                const blankDim = rec.part1 && rec.part1.blank_size ? `${rec.part1.blank_size.length} × ${rec.part1.blank_size.width} × ${rec.part1.blank_size.thickness} mm` : (rec.blank_size ? `${rec.blank_size.length} × ${rec.blank_size.width} × ${rec.blank_size.thickness} mm` : '--');
                const hasImg = !!rec.image_url;

                return `
                    <div class="rm-card ${statusClass}">
                        <div class="rm-card-header">
                            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                                <span class="rm-code-title">${escapeHtml(rec.rm_erp || 'Unspecified RM')}</span>
                                <span class="grade-pill">${escapeHtml(rec.grade || 'YS')}</span>
                            </div>
                            <span class="status-badge ${statusClass}">${escapeHtml(rec.status)}</span>
                        </div>

                        <table class="rm-specs-table">
                            <tr>
                                <td class="label">Cut Blank Size:</td>
                                <td class="val">${escapeHtml(rec.cut_blank || '--')}</td>
                            </tr>
                            <tr>
                                <td class="label">Blank Dimensions:</td>
                                <td class="val">${blankDim}</td>
                            </tr>
                            <tr>
                                <td class="label">Sheet Grade / RM Code:</td>
                                <td class="val"><span class="grade-pill">${escapeHtml(rec.grade || 'YS')}</span></td>
                            </tr>
                        </table>

                        ${yieldPct !== '--' ? `
                            <div class="yield-bar-wrapper">
                                <div class="yield-label-group">
                                    <span>Material Yield</span>
                                    <strong style="color: ${getYieldColor(yieldPct)};">${yieldPct}%</strong>
                                </div>
                                <div class="yield-progress-track">
                                    <div class="yield-progress-fill" style="width: ${Math.min(100, Math.max(0, yieldPct))}%; background-color: ${getYieldColor(yieldPct)};"></div>
                                </div>
                            </div>
                        ` : ''}

                        <button class="fetch-layout-btn" onclick="fetchLayoutForRM('${escapeHtml(rec.rm_erp)}', '${escapeHtml(data.part_no)}')">
                            <i class="fa-solid fa-file-contract"></i>
                            <span>View Print Sheet: ${escapeHtml(rec.rm_erp)} (${escapeHtml(rec.grade || 'YS')}) ${hasImg ? '🖼️' : ''}</span>
                        </button>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

function renderPrintSheet(data) {
    const rec = data.record;
    const planTitle = data.plan_title || (rec.status && rec.status.toLowerCase().includes("2nd") ? "Standardized Layout Plan - 2" : "Standardized Layout Plan - 1");
    const hasImg = !!rec.image_url;
    const cardId = "printSheet_" + Math.random().toString(36).substr(2, 9);

    const p1 = rec.part1 || { part_no: data.part_no, cut_blank: rec.cut_blank, blank_qty: rec.blank_qty, strip_qty: 1, total_blank_qty_sheet: rec.blank_qty, total_blank_qty: rec.blank_qty, blank_weight: rec.blank_weight };
    const p2 = rec.part2;
    const p3 = rec.part3;
    const p4 = rec.part4;

    const ps = rec.per_sheet || {};
    const ts = rec.total_sheet || {};
    const endbits = rec.endbits || [];
    const compRecords = data.comparison_records || [rec];

    const formatNum = (v, suffix = "") => (v !== null && v !== undefined && v !== "") ? `${v}${suffix}` : "-";
    const formatYield = (v) => (v !== null && v !== undefined && v !== "") ? `${v}%` : "-";

    return `
        <div class="excel-print-sheet-wrapper" id="${cardId}">
            <!-- Print Sheet Action Bar -->
            <div class="print-sheet-toolbar">
                <div class="toolbar-title">
                    <i class="fa-solid fa-file-contract"></i>
                    <strong>${escapeHtml(planTitle)}</strong>
                    <span class="grade-pill">${escapeHtml(rec.grade || 'YS')}</span>
                    <span class="mono-text" style="color: #38bdf8; font-weight: 600;">${escapeHtml(rec.rm_erp)}</span>
                    <span class="sheet-status-tag ${getStatusClass(rec.status)}">${escapeHtml(rec.status)}</span>
                </div>
                <div class="toolbar-actions">
                    <button class="sheet-action-btn primary" onclick="printEngineeringDocument('${cardId}')" title="Print in exact Excel sheet format">
                        <i class="fa-solid fa-print"></i>
                        <span>Print Sheet</span>
                    </button>
                    ${hasImg ? `
                        <button class="sheet-action-btn" onclick="openFullscreenModal('${rec.image_url}', '${escapeHtml(data.part_no)} - ${escapeHtml(rec.rm_erp)}')">
                            <i class="fa-solid fa-expand"></i>
                            <span>Fullscreen CAD</span>
                        </button>
                    ` : ''}
                </div>
            </div>

            <!-- Official Engineering PRINT Sheet Document -->
            <div class="excel-document">
                <!-- Row 2: Document Title Header -->
                <div class="doc-header-row">
                    <h2 class="doc-main-title">${escapeHtml(planTitle)}</h2>
                    <div class="doc-part-banner">${escapeHtml(data.part_no)} &nbsp;|&nbsp; RM Code: <strong>${escapeHtml(rec.grade || 'YS')}</strong> - <code>${escapeHtml(rec.rm_erp)}</code></div>
                </div>

                <!-- Row 4-7: Part Numbers & Cut Blank Sizes Table -->
                <table class="excel-table header-parts-table">
                    <tbody>
                        <tr>
                            <td class="lbl-cell" style="width: 14%;">Part Number 1</td>
                            <td class="val-cell strong-text" style="width: 22%;">${escapeHtml(p1.part_no || data.part_no)}</td>
                            <td class="lbl-cell" style="width: 14%;">Cut Blank Size 1</td>
                            <td class="val-cell mono-text" style="width: 20%;">${escapeHtml(p1.cut_blank || '-')}</td>
                            <td class="lbl-cell" style="width: 15%;">No. of Sheet</td>
                            <td class="val-yellow-cell sheet-count-cell" style="width: 15%;">
                                <div class="sheet-count-input-wrap">
                                    <input type="number" 
                                           class="sheet-count-input" 
                                           id="${cardId}_sheet_input" 
                                           value="${rec.no_of_sheets || 1}" 
                                           min="1" 
                                           step="1"
                                           oninput="recalcSheetQuantities('${cardId}')"
                                           onchange="recalcSheetQuantities('${cardId}')"
                                           title="Manually edit sheet count to dynamically recalculate total quantities and total sheet weights">
                                    <span class="sheet-count-unit">Sht</span>
                                </div>
                            </td>
                        </tr>
                        <tr>
                            <td class="lbl-cell">Part Number 2</td>
                            <td class="val-cell">${escapeHtml(p2 ? p2.part_no : '-')}</td>
                            <td class="lbl-cell">Cut Blank Size 2</td>
                            <td class="val-cell mono-text" colspan="3">${escapeHtml(p2 ? p2.cut_blank : '-')}</td>
                        </tr>
                        <tr>
                            <td class="lbl-cell">Part Number 3</td>
                            <td class="val-cell">${escapeHtml(p3 ? p3.part_no : '-')}</td>
                            <td class="lbl-cell">Cut Blank Size 3</td>
                            <td class="val-cell mono-text" colspan="3">${escapeHtml(p3 ? p3.cut_blank : '-')}</td>
                        </tr>
                        <tr>
                            <td class="lbl-cell">Part Number 4</td>
                            <td class="val-cell">${escapeHtml(p4 ? p4.part_no : '-')}</td>
                            <td class="lbl-cell">Cut Blank Size 4</td>
                            <td class="val-cell mono-text" colspan="3">${escapeHtml(p4 ? p4.cut_blank : '-')}</td>
                        </tr>
                    </tbody>
                </table>

                <!-- Row 9: Details Header -->
                <div class="doc-section-bar">
                    <span class="section-title-text">Standardized Layout - Details</span>
                    <span class="cutting-plan-text">Cutting Plan No : <strong>${escapeHtml(rec.cutting_plan || '-')}</strong></span>
                </div>

                <!-- Row 10-12: Primary Technical Specifications Table -->
                <div class="table-scroll-wrapper">
                    <table class="excel-table technical-specs-table">
                        <thead>
                            <tr class="thead-row-1">
                                <th rowspan="2">Sheet Grade</th>
                                <th rowspan="2">Thickness</th>
                                <th rowspan="2">Length</th>
                                <th rowspan="2">Width</th>
                                <th rowspan="2">RM weight</th>
                                <th rowspan="2">Blank wt-1</th>
                                <th rowspan="2">Blank wt-2</th>
                                <th rowspan="2">Blank wt-3</th>
                                <th rowspan="2">Blank wt-4</th>
                                <th colspan="3" class="group-header">Per sheet</th>
                                <th colspan="3" class="group-header">For Total Sheet</th>
                            </tr>
                            <tr class="thead-row-2">
                                <th>Total usage wt</th>
                                <th>End bit Wt (Kg)</th>
                                <th>Mat. Yield</th>
                                <th>Total usage wt</th>
                                <th>End bit Wt (Kg)</th>
                                <th>Mat. Yield</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr class="data-row-yellow">
                                <td class="center-text strong-text">${escapeHtml(rec.grade || 'YS')}</td>
                                <td class="num-cell">${formatNum(rec.thickness)}</td>
                                <td class="num-cell">${formatNum(rec.length)}</td>
                                <td class="num-cell">${formatNum(rec.width)}</td>
                                <td class="num-cell">${formatNum(rec.rm_weight)}</td>
                                <td class="num-cell">${formatNum(p1.blank_weight)}</td>
                                <td class="num-cell">${formatNum(p2 ? p2.blank_weight : 0)}</td>
                                <td class="num-cell">${formatNum(p3 ? p3.blank_weight : 0)}</td>
                                <td class="num-cell">${formatNum(p4 ? p4.blank_weight : 0)}</td>
                                <td class="num-cell strong-text">${formatNum(ps.usage_weight)}</td>
                                <td class="num-cell">${formatNum(ps.endbit_weight)}</td>
                                <td class="num-cell yield-table-cell">${renderYieldBadgeWithLine(ps.yield_pct)}</td>
                                <td class="num-cell strong-text" id="${cardId}_ts_usage" data-per-sheet="${ps.usage_weight !== null && ps.usage_weight !== undefined ? ps.usage_weight : 0}">${formatNum(ts.usage_weight)}</td>
                                <td class="num-cell" id="${cardId}_ts_endbit" data-per-sheet="${ps.endbit_weight !== null && ps.endbit_weight !== undefined ? ps.endbit_weight : 0}">${formatNum(ts.endbit_weight)}</td>
                                <td class="num-cell yield-table-cell">${renderYieldBadgeWithLine(ts.yield_pct)}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <!-- Row 14-21: Blank Quantities, Logistics & End Bits Table -->
                <div class="table-scroll-wrapper">
                    <table class="excel-table quantities-table">
                        <tbody>
                            <tr>
                                <td class="lbl-cell" style="width: 14%;">Part 1 Blank Qty</td>
                                <td class="val-yellow-cell" style="width: 8%;">${formatNum(p1.blank_qty)}</td>
                                <td class="lbl-cell" style="width: 14%;">Part 2 Blank Qty</td>
                                <td class="val-yellow-cell" style="width: 8%;">${formatNum(p2 ? p2.blank_qty : '-')}</td>
                                <td class="lbl-cell" style="width: 14%;">Part 3 Blank Qty</td>
                                <td class="val-yellow-cell" style="width: 8%;">${formatNum(p3 ? p3.blank_qty : '-')}</td>
                                <td class="lbl-cell" style="width: 14%;">Part 4 Blank Qty</td>
                                <td class="val-yellow-cell" style="width: 8%;">${formatNum(p4 ? p4.blank_qty : '-')}</td>
                                <td class="lbl-cell" style="width: 12%;">End bit - 1</td>
                                <td class="val-yellow-cell mono-text" style="width: 18%;">${escapeHtml(endbits[0] ? endbits[0].dim : '-')}</td>
                                <td class="val-yellow-cell center-text" style="width: 8%;">${escapeHtml(endbits[0] ? endbits[0].qty : '-')}</td>
                            </tr>
                            <tr>
                                <td class="lbl-cell">Blank Per Strip Qty</td>
                                <td class="val-yellow-cell">${formatNum(p1.strip_qty)}</td>
                                <td class="lbl-cell">Blank Per Strip Qty</td>
                                <td class="val-yellow-cell">${formatNum(p2 ? p2.strip_qty : '-')}</td>
                                <td class="lbl-cell">Blank Per Strip Qty</td>
                                <td class="val-yellow-cell">${formatNum(p3 ? p3.strip_qty : '-')}</td>
                                <td class="lbl-cell">Blank Per Strip Qty</td>
                                <td class="val-yellow-cell">${formatNum(p4 ? p4.strip_qty : '-')}</td>
                                <td class="lbl-cell">End bit - 2</td>
                                <td class="val-yellow-cell mono-text">${escapeHtml(endbits[1] ? endbits[1].dim : '-')}</td>
                                <td class="val-yellow-cell center-text">${escapeHtml(endbits[1] ? endbits[1].qty : '-')}</td>
                            </tr>
                            <tr>
                                <td class="lbl-cell">Total blank Qty Per sheet</td>
                                <td class="val-yellow-cell strong-text">${formatNum(p1.total_blank_qty_sheet)}</td>
                                <td class="lbl-cell">Total blank Qty Per sheet</td>
                                <td class="val-yellow-cell">${formatNum(p2 ? p2.total_blank_qty_sheet : 0)}</td>
                                <td class="lbl-cell">Total blank Qty Per sheet</td>
                                <td class="val-yellow-cell">${formatNum(p3 ? p3.total_blank_qty_sheet : 0)}</td>
                                <td class="lbl-cell">Total blank Qty Per sheet</td>
                                <td class="val-yellow-cell">${formatNum(p4 ? p4.total_blank_qty_sheet : 0)}</td>
                                <td class="lbl-cell">End bit - 3</td>
                                <td class="val-yellow-cell mono-text">${escapeHtml(endbits[2] ? endbits[2].dim : '-')}</td>
                                <td class="val-yellow-cell center-text">${escapeHtml(endbits[2] ? endbits[2].qty : '-')}</td>
                            </tr>
                            <tr>
                                <td class="lbl-cell">Total blank Qty</td>
                                <td class="val-yellow-cell strong-text" id="${cardId}_p1_total" data-per-sheet="${p1.total_blank_qty_sheet || 0}">${formatNum(p1.total_blank_qty)}</td>
                                <td class="lbl-cell">Total blank Qty</td>
                                <td class="val-yellow-cell" id="${cardId}_p2_total" data-per-sheet="${p2 ? (p2.total_blank_qty_sheet || 0) : 0}">${formatNum(p2 ? p2.total_blank_qty : 0)}</td>
                                <td class="lbl-cell">Total blank Qty</td>
                                <td class="val-yellow-cell" id="${cardId}_p3_total" data-per-sheet="${p3 ? (p3.total_blank_qty_sheet || 0) : 0}">${formatNum(p3 ? p3.total_blank_qty : 0)}</td>
                                <td class="lbl-cell">Total blank Qty</td>
                                <td class="val-yellow-cell" id="${cardId}_p4_total" data-per-sheet="${p4 ? (p4.total_blank_qty_sheet || 0) : 0}">${formatNum(p4 ? p4.total_blank_qty : 0)}</td>
                                <td class="lbl-cell">End bit - 4</td>
                                <td class="val-yellow-cell mono-text">${escapeHtml(endbits[3] ? endbits[3].dim : '-')}</td>
                                <td class="val-yellow-cell center-text">${escapeHtml(endbits[3] ? endbits[3].qty : '-')}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <!-- Row 24-36: Blueprint CAD Layout Drawing Frame -->
                <div class="doc-blueprint-frame">
                    <div class="blueprint-canvas" ${hasImg ? `onclick="openFullscreenModal('${rec.image_url}', '${escapeHtml(data.part_no)} - ${escapeHtml(rec.rm_erp)}')"` : 'style="cursor: default;"'}>
                        ${hasImg ? `
                            <img src="${rec.image_url}" alt="Standardized CAD Layout Drawing" class="blueprint-cad-img" onerror="this.style.display='none'; if(this.nextElementSibling) this.nextElementSibling.style.display='none'; this.parentElement.innerHTML='<div class=\\'blueprint-blank-space\\'></div>';">
                            <div class="blueprint-zoom-hint">
                                <i class="fa-solid fa-magnifying-glass-plus"></i> Click to Zoom / Fullscreen
                            </div>
                        ` : `
                            <!-- Leave picture space blank as requested -->
                            <div class="blueprint-blank-space"></div>
                        `}
                    </div>
                </div>
            </div>
        </div>
    `;
}

function printEngineeringDocument(cardId) {
    const cardEl = document.getElementById(cardId);
    if (!cardEl) return;

    // Sync input attributes so outerHTML captures user entered sheet count
    cardEl.querySelectorAll('input').forEach(inp => {
        inp.setAttribute('value', inp.value);
    });

    // Remove any previous print container
    const oldContainer = document.getElementById("printSectionContainer");
    if (oldContainer) oldContainer.remove();

    // Create a dedicated print container
    const printContainer = document.createElement("div");
    printContainer.id = "printSectionContainer";
    printContainer.className = "print-only-container";
    printContainer.innerHTML = cardEl.querySelector(".excel-document").outerHTML;

    document.body.appendChild(printContainer);

    // Call native window print
    window.print();

    // Clean up print container after print dialog closes
    setTimeout(() => {
        if (printContainer && printContainer.parentNode) {
            printContainer.remove();
        }
    }, 1000);
}

function recalcSheetQuantities(cardId) {
    const inputEl = document.getElementById(`${cardId}_sheet_input`);
    if (!inputEl) return;
    
    let sheets = parseFloat(inputEl.value);
    if (isNaN(sheets) || sheets < 0) {
        sheets = 1;
    }
    inputEl.setAttribute('value', sheets);

    // 1. Recalculate Part 1..4 Total blank Qty
    ['p1', 'p2', 'p3', 'p4'].forEach(pKey => {
        const cellEl = document.getElementById(`${cardId}_${pKey}_total`);
        if (cellEl) {
            const perSheet = parseFloat(cellEl.getAttribute('data-per-sheet')) || 0;
            if (perSheet > 0) {
                const total = Math.round(perSheet * sheets);
                cellEl.textContent = total;
                triggerCellHighlight(cellEl);
            } else {
                cellEl.textContent = '0';
            }
        }
    });

    // 2. Recalculate For Total Sheet: Total usage wt & End bit Wt
    const usageEl = document.getElementById(`${cardId}_ts_usage`);
    if (usageEl) {
        const perSheetUsage = parseFloat(usageEl.getAttribute('data-per-sheet')) || 0;
        if (perSheetUsage > 0) {
            usageEl.textContent = (perSheetUsage * sheets).toFixed(4).replace(/\.?0+$/, "");
            triggerCellHighlight(usageEl);
        } else {
            usageEl.textContent = '-';
        }
    }

    const endbitEl = document.getElementById(`${cardId}_ts_endbit`);
    if (endbitEl) {
        const perSheetEndbit = parseFloat(endbitEl.getAttribute('data-per-sheet')) || 0;
        if (perSheetEndbit > 0) {
            endbitEl.textContent = (perSheetEndbit * sheets).toFixed(4).replace(/\.?0+$/, "");
            triggerCellHighlight(endbitEl);
        } else {
            endbitEl.textContent = '-';
        }
    }
}

function triggerCellHighlight(el) {
    el.classList.remove('cell-updated-pulse');
    void el.offsetWidth;
    el.classList.add('cell-updated-pulse');
}

function renderPartChoices(data) {
    return `
        <div class="part-choices-list">
            ${data.items.map(item => `
                <div class="choice-item-card" onclick="handleSendMessage('${escapeHtml(item.part_no)}')">
                    <div>
                        <div class="choice-part-title">${escapeHtml(item.part_no)}</div>
                        <div class="choice-details">
                            ${item.rm_count} RM ERP Code${item.rm_count > 1 ? 's' : ''} 
                            ${item.rm_codes.length > 0 ? `• Codes: ${item.rm_codes.slice(0, 2).join(', ')}` : ''}
                        </div>
                    </div>
                    <i class="fa-solid fa-chevron-right sample-arrow"></i>
                </div>
            `).join('')}
        </div>
    `;
}

// ===================================================================
// Action Handlers
// ===================================================================

function handleChipClick(partNo) {
    chatInput.value = partNo;
    handleSendMessage(partNo);
}

function selectSamplePart(partNo) {
    closeMobileSidebar();
    chatInput.value = partNo;
    handleSendMessage(partNo);
}

function fetchLayoutForRM(rmCode, partNo) {
    state.currentPart = partNo;
    handleSendMessage(`Fetch layout for ${rmCode}`);
}

function handleActionClick(action, value) {
    if (action === "fetch_layout") {
        handleSendMessage(`Fetch layout for ${value}`);
    } else if (action === "select_part" || action === "search") {
        handleSendMessage(value);
    }
}

// ===================================================================
// Fullscreen Image Modal & Zoom Controls
// ===================================================================

function openFullscreenModal(imgUrl, title) {
    if (!imageModal) return;
    if (modalImage) modalImage.src = imgUrl;
    if (modalLayoutTitle) modalLayoutTitle.textContent = title;
    if (downloadImageBtn) {
        downloadImageBtn.href = imgUrl;
        downloadImageBtn.download = `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;
    }
    resetZoom();
    imageModal.style.display = "flex";
    imageModal.classList.add("active");
}

function closeImageModal() {
    if (imageModal) {
        imageModal.style.display = "none";
        imageModal.classList.remove("active");
    }
}

function updateZoom(delta) {
    state.zoomLevel = Math.max(0.5, Math.min(3.0, state.zoomLevel + delta));
    modalImage.style.transform = `scale(${state.zoomLevel})`;
}

function resetZoom() {
    state.zoomLevel = 1.0;
    modalImage.style.transform = `scale(1.0)`;
}

// ===================================================================
// Search Autocomplete Helpers
// ===================================================================

function debounceSearch(query, dropdownEl, onSelect) {
    clearTimeout(state.searchTimeout);
    if (!query || query.length < 2) {
        dropdownEl.style.display = "none";
        return;
    }

    state.searchTimeout = setTimeout(async () => {
        try {
            const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
            const items = await res.json();

            if (!items || items.length === 0) {
                dropdownEl.style.display = "none";
                return;
            }

            dropdownEl.innerHTML = items.map(item => `
                <div class="autocomplete-item" data-part="${escapeHtml(item.part_no)}">
                    <span class="auto-part">${escapeHtml(item.part_no)}</span>
                    <span class="auto-meta">${item.rm_count} RM codes</span>
                </div>
            `).join('');

            dropdownEl.style.display = "block";

            dropdownEl.querySelectorAll(".autocomplete-item").forEach(el => {
                el.addEventListener("click", () => {
                    const p = el.getAttribute("data-part");
                    onSelect(p);
                });
            });
        } catch (err) {
            console.error(err);
        }
    }, 200);
}

// ===================================================================
// Utilities & Formatting
// ===================================================================

function getYieldColor(v) {
    if (v === null || v === undefined || v === "" || v === "--") return "#64748b";
    const num = parseFloat(v);
    if (isNaN(num)) return "#64748b";
    if (num >= 92) return "#059669"; // High yield (>=92%): Emerald green
    if (num >= 85) return "#16a34a"; // Good yield (85-91%): Leaf green
    if (num >= 75) return "#d97706"; // Medium yield (75-84%): Amber
    return "#dc2626"; // Low yield (<75%): Coral red
}

function renderYieldBadgeWithLine(v) {
    if (v === null || v === undefined || v === "") return "-";
    const num = parseFloat(v);
    if (isNaN(num)) return "-";
    const color = getYieldColor(num);
    const pct = Math.min(100, Math.max(0, num));
    return `
        <div class="yield-badge-cell">
            <span class="yield-pct-text" style="color: ${color};">${num}%</span>
            <div class="yield-mini-line-track">
                <div class="yield-mini-line-fill" style="width: ${pct}%; background-color: ${color};"></div>
            </div>
        </div>
    `;
}

function getStatusClass(status) {
    if (!status) return "";
    const s = status.toLowerCase();
    if (s.includes("standardized")) return "standardized";
    if (s.includes("2nd") || s.includes("second")) return "second-choice";
    if (s.includes("non")) return "non-standard";
    if (s.includes("not")) return "not-use";
    return "";
}

function formatMarkdown(text) {
    if (!text) return "";
    
    const lines = text.split("\n");
    let inTable = false;
    let tableHtml = "";
    let resultLines = [];
    
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (line.startsWith("|") && line.endsWith("|")) {
            // Check if delimiter row like | :--- | :--- |
            if (/^\|(\s*:?-+:?\s*\|)+$/.test(line)) {
                continue; // Skip table header separator
            }
            const cells = line.split("|").slice(1, -1).map(c => c.trim());
            if (!inTable) {
                inTable = true;
                tableHtml = '<div class="chat-table-wrapper"><table class="chat-table"><thead><tr>' +
                    cells.map(c => `<th>${formatInlineMarkdown(c)}</th>`).join('') +
                    '</tr></thead><tbody>';
            } else {
                tableHtml += '<tr>' + cells.map(c => `<td>${formatInlineMarkdown(c)}</td>`).join('') + '</tr>';
            }
        } else {
            if (inTable) {
                inTable = false;
                tableHtml += '</tbody></table></div>';
                resultLines.push(tableHtml);
                tableHtml = "";
            }
            if (line.startsWith("### ")) {
                resultLines.push(`<h4 class="chat-md-h4">${formatInlineMarkdown(line.slice(4))}</h4>`);
            } else if (line.startsWith("## ")) {
                resultLines.push(`<h3 class="chat-md-h3">${formatInlineMarkdown(line.slice(3))}</h3>`);
            } else if (line.startsWith("> ")) {
                resultLines.push(`<blockquote class="chat-md-quote">${formatInlineMarkdown(line.slice(2))}</blockquote>`);
            } else if (line.startsWith("- ") || line.startsWith("* ")) {
                resultLines.push(`<div class="chat-md-bullet"><i class="fa-solid fa-circle-dot"></i> <span>${formatInlineMarkdown(line.slice(2))}</span></div>`);
            } else if (line) {
                resultLines.push(`<p class="chat-md-p">${formatInlineMarkdown(line)}</p>`);
            }
        }
    }
    if (inTable) {
        tableHtml += '</tbody></table></div>';
        resultLines.push(tableHtml);
    }
    return resultLines.join("");
}

function formatInlineMarkdown(str) {
    if (!str) return "";
    return escapeHtml(str)
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`(.*?)`/g, '<code>$1</code>');
}

function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function showTyping(show) {
    typingIndicator.style.display = show ? "flex" : "none";
}

function scrollToBottom() {
    setTimeout(() => {
        chatFeed.scrollTop = chatFeed.scrollHeight;
    }, 50);
}

function appendErrorMessage(msg) {
    const wrapper = document.createElement("div");
    wrapper.className = "message-wrapper bot animate-in";
    wrapper.innerHTML = `
        <div class="bot-avatar" style="background: var(--accent-rose);">
            <i class="fa-solid fa-triangle-exclamation"></i>
        </div>
        <div class="message-bubble bot-bubble" style="border-color: rgba(244, 63, 94, 0.4);">
            <p style="color: var(--accent-rose); font-weight: 500;">${escapeHtml(msg)}</p>
        </div>
    `;
    chatFeed.appendChild(wrapper);
    scrollToBottom();
}

function resetSession() {
    closeMobileSidebar();
    state.currentPart = null;
    state.currentRm = null;
    state.chatHistory = [];
    chatFeed.innerHTML = `
        <div class="message-wrapper bot animate-in">
            <div class="bot-avatar">
                <i class="fa-solid fa-microchip"></i>
            </div>
            <div class="message-bubble bot-bubble">
                <div class="bubble-header">
                    <span class="sender-name">Layout AI Assistant</span>
                    <span class="message-time">Just now</span>
                </div>
                <div class="bubble-content">
                    <p>New session started! Enter a <strong>Part Number</strong> below or select a sample part to view its RM ERP codes and CAD layout drawings.</p>
                </div>
            </div>
        </div>
    `;
}

function exportConversation() {
    if (state.chatHistory.length === 0) {
        alert("No conversation history to export yet.");
        return;
    }
    const blob = new Blob([JSON.stringify(state.chatHistory, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `SheetLayout_Chat_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

// Bind Global Window Handlers for Dynamic HTML Elements
window.selectSamplePart = selectSamplePart;
window.handleChipClick = handleChipClick;
window.fetchLayoutForRM = fetchLayoutForRM;
window.handleActionClick = handleActionClick;
window.resetSession = resetSession;
window.openFullscreenModal = openFullscreenModal;
window.closeImageModal = closeImageModal;
window.printEngineeringDocument = printEngineeringDocument;
window.recalcSheetQuantities = recalcSheetQuantities;
window.handleSendMessage = handleSendMessage;
window.openMobileSidebar = openMobileSidebar;
window.closeMobileSidebar = closeMobileSidebar;
window.getYieldColor = getYieldColor;

