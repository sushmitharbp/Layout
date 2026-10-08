/**
 * SheetLayout AI — Floating Chatbot Widget Client Controller
 * Provides an embedded, floating AI Chatbot in the bottom-right corner
 * allowing instant part querying and layout previews across all pages.
 */

let widgetCurrentPart = null;
let widgetIsOpen = false;

document.addEventListener("DOMContentLoaded", () => {
    initChatWidget();
});

function initChatWidget() {
    // 1. Create Floating Button (FAB)
    const fab = document.createElement("button");
    fab.className = "chat-fab-btn";
    fab.id = "chatWidgetFab";
    fab.setAttribute("aria-label", "Open SheetLayout AI Chatbot");
    fab.innerHTML = `
        <div class="chat-fab-icon"><i class="fa-solid fa-shapes"></i></div>
        <span>Ask Layout AI</span>
        <div class="chat-fab-pulse"></div>
    `;
    fab.onclick = toggleChatWidget;
    document.body.appendChild(fab);

    // 2. Create Floating Chat Panel
    const panel = document.createElement("div");
    panel.className = "chat-widget-panel";
    panel.id = "chatWidgetPanel";
    panel.style.display = "none";
    panel.innerHTML = `
        <!-- Header -->
        <div class="chat-widget-header">
            <div class="chat-widget-title-box">
                <div class="widget-avatar"><i class="fa-solid fa-shapes"></i></div>
                <div>
                    <h3>Layout AI Assistant</h3>
                    <small><i class="fa-solid fa-circle" style="color: #10b981; font-size: 0.55rem;"></i> Master Database Online</small>
                </div>
            </div>
            <div class="chat-widget-controls">
                <a href="/chat-full" target="_blank" class="widget-ctrl-btn" title="Open Fullscreen View" aria-label="Fullscreen">
                    <i class="fa-solid fa-up-right-and-down-left-from-center"></i>
                </a>
                <button type="button" class="widget-ctrl-btn" onclick="toggleChatWidget()" title="Minimize" aria-label="Minimize">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        </div>

        <!-- Message Body -->
        <div class="chat-widget-body" id="widgetChatBody">
            <div class="widget-msg bot">
                <div class="widget-msg-avatar"><i class="fa-solid fa-microchip"></i></div>
                <div class="widget-msg-bubble">
                    <p>Hello! 👋 I am your <strong>SheetLayout AI Assistant</strong>.</p>
                    <p style="margin-top: 4px;">Ask me about <strong>Monthly Yield</strong>, <strong>Scrap Generated</strong>, <strong>Cutting & Production Plans</strong>, or any Part Number.</p>
                    <div class="widget-chips">
                        <button type="button" class="widget-chip" onclick="widgetSendText('monthly yield')">📊 Monthly Yield</button>
                        <button type="button" class="widget-chip" onclick="widgetSendText('this month scrap generated')">✂️ Scrap Generated</button>
                        <button type="button" class="widget-chip" onclick="widgetSendText('cutting plan for MBA01010')">📋 Plan: MBA01010</button>
                        <button type="button" class="widget-chip" onclick="widgetSendText('MBA01008 - Item 1')">MBA01008 - Item 1</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- Footer Input -->
        <div class="chat-widget-footer">
            <div class="widget-autocomplete-box" id="widgetAutocomplete" style="display: none;"></div>
            <form onsubmit="handleWidgetSubmit(event)">
                <div class="widget-input-wrap">
                    <input 
                        type="text" 
                        id="widgetChatInput" 
                        placeholder="Ask anything or enter Part Number..." 
                        autocomplete="off"
                        oninput="onWidgetInput(this.value)"
                    >
                    <button type="submit" class="widget-send-btn" aria-label="Send">
                        <i class="fa-solid fa-paper-plane"></i>
                    </button>
                </div>
            </form>
        </div>
    `;
    document.body.appendChild(panel);
}

function toggleChatWidget() {
    const panel = document.getElementById("chatWidgetPanel");
    const fab = document.getElementById("chatWidgetFab");
    if (!panel) return;

    widgetIsOpen = !widgetIsOpen;
    if (widgetIsOpen) {
        panel.style.display = "flex";
        if (fab) fab.style.display = "none";
        const input = document.getElementById("widgetChatInput");
        if (input) input.focus();
    } else {
        panel.style.display = "none";
        if (fab) fab.style.display = "flex";
    }
}

function widgetSendText(text) {
    const input = document.getElementById("widgetChatInput");
    if (input) input.value = text;
    handleWidgetSubmit(new Event("submit"));
}

let widgetAutocompleteTimer;
function onWidgetInput(val) {
    clearTimeout(widgetAutocompleteTimer);
    const box = document.getElementById("widgetAutocomplete");
    if (!val || val.length < 2) {
        if (box) box.style.display = "none";
        return;
    }

    widgetAutocompleteTimer = setTimeout(async () => {
        try {
            const res = await fetch(`/api/search?q=${encodeURIComponent(val)}`);
            if (res.ok) {
                const parts = await res.json();
                if (box) {
                    if (parts.length > 0) {
                        box.innerHTML = parts.slice(0, 5).map(p => `
                            <div class="widget-auto-item" onclick="selectWidgetPart('${escapeWidgetHtml(p.part_no)}')">
                                <strong>${escapeWidgetHtml(p.part_no)}</strong>
                                <small style="color: #64748b;">(${p.rm_count} RM codes)</small>
                            </div>
                        `).join("");
                        box.style.display = "block";
                    } else {
                        box.style.display = "none";
                    }
                }
            }
        } catch (e) {
            console.error(e);
        }
    }, 200);
}

function selectWidgetPart(partNo) {
    const input = document.getElementById("widgetChatInput");
    const box = document.getElementById("widgetAutocomplete");
    if (input) input.value = partNo;
    if (box) box.style.display = "none";
    handleWidgetSubmit(new Event("submit"));
}

async function handleWidgetSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();
    const input = document.getElementById("widgetChatInput");
    const body = document.getElementById("widgetChatBody");
    const box = document.getElementById("widgetAutocomplete");
    if (box) box.style.display = "none";

    const text = input ? input.value.trim() : "";
    if (!text) return;
    if (input) input.value = "";

    // Append User Message
    appendWidgetMsg("user", text);

    // Typing indicator
    const typingId = "widgetTyping_" + Date.now();
    const typingEl = document.createElement("div");
    typingEl.className = "widget-msg bot";
    typingEl.id = typingId;
    typingEl.innerHTML = `
        <div class="widget-msg-avatar"><i class="fa-solid fa-microchip"></i></div>
        <div class="widget-msg-bubble"><i class="fa-solid fa-circle-notch fa-spin"></i> Searching database...</div>
    `;
    body.appendChild(typingEl);
    body.scrollTop = body.scrollHeight;

    try {
        const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: text, current_part: widgetCurrentPart })
        });

        const typingNode = document.getElementById(typingId);
        if (typingNode) typingNode.remove();

        if (res.ok) {
            const data = await res.json();
            renderWidgetResponse(data);
        } else {
            appendWidgetMsg("bot", "Sorry, I could not process that request. Please try again.");
        }
    } catch (err) {
        const typingNode = document.getElementById(typingId);
        if (typingNode) typingNode.remove();
        appendWidgetMsg("bot", "Network error. Please check your connection.");
    }
}

function appendWidgetMsg(sender, text) {
    const body = document.getElementById("widgetChatBody");
    if (!body) return;

    const msg = document.createElement("div");
    msg.className = `widget-msg ${sender}`;
    if (sender === "bot") {
        msg.innerHTML = `
            <div class="widget-msg-avatar"><i class="fa-solid fa-microchip"></i></div>
            <div class="widget-msg-bubble">${escapeWidgetHtml(text)}</div>
        `;
    } else {
        msg.innerHTML = `
            <div class="widget-msg-bubble">${escapeWidgetHtml(text)}</div>
        `;
    }
    body.appendChild(msg);
    body.scrollTop = body.scrollHeight;
}

function renderWidgetResponse(data) {
    const body = document.getElementById("widgetChatBody");
    if (!body) return;

    if (data.part_no) {
        widgetCurrentPart = data.part_no;
    }

    const msg = document.createElement("div");
    msg.className = "widget-msg bot";

    let extraHtml = "";

    // 1. Part choices or RM list
    if (data.type === "part_details" && data.records) {
        extraHtml = `
            <div style="margin-top: 8px;">
                <strong>${escapeWidgetHtml(data.part_no)}</strong> (${data.rm_count} RM ERP Codes):
                ${data.records.slice(0, 4).map(r => `
                    <div class="widget-rm-card">
                        <div><strong><code>${escapeWidgetHtml(r.rm_erp)}</code></strong> (${escapeWidgetHtml(r.grade || 'YS')})</div>
                        <small style="color: #64748b;">${escapeWidgetHtml(r.status || '')} | Yield: ${r.per_sheet?.yield_pct || '-'}%</small>
                        <div>
                            <button type="button" class="widget-fetch-btn" onclick="widgetSendText('fetch layout ${r.rm_erp}')">
                                <i class="fa-solid fa-compass-drafting"></i> Fetch Layout
                            </button>
                        </div>
                    </div>
                `).join("")}
            </div>
        `;
    }

    // 2. Print sheet / Layout drawing
    if (data.type === "print_sheet" && data.record) {
        const rec = data.record;
        extraHtml = `
            <div class="widget-rm-card">
                <div><strong>${escapeWidgetHtml(data.plan_title || 'Layout Drawing')}</strong></div>
                <small>RM ERP: <code>${escapeWidgetHtml(rec.rm_erp)}</code></small>
                ${rec.image_url ? `
                    <div class="widget-cad-frame">
                        <img src="${rec.image_url}" class="widget-cad-img" alt="Layout Drawing" onclick="window.open('${rec.image_url}', '_blank')">
                        <small style="display:block; color:#64748b; font-size:0.65rem; margin-top:2px;">Click drawing to open full resolution</small>
                    </div>
                ` : '<div style="margin-top:4px; color:#d97706;"><i class="fa-solid fa-info-circle"></i> No CAD drawing file attached for this RM.</div>'}
            </div>
        `;
    }

    // 3. Actions / Quick buttons
    if (data.actions && data.actions.length > 0) {
        extraHtml += `
            <div class="widget-chips">
                ${data.actions.slice(0, 4).map(a => `
                    <button type="button" class="widget-chip" onclick="widgetSendText('${escapeWidgetHtml(a.value || a.label)}')">${escapeWidgetHtml(a.label)}</button>
                `).join("")}
            </div>
        `;
    }

    msg.innerHTML = `
        <div class="widget-msg-avatar"><i class="fa-solid fa-microchip"></i></div>
        <div class="widget-msg-bubble">
            <div>${formatWidgetReply(data.reply || "")}</div>
            ${extraHtml}
        </div>
    `;

    body.appendChild(msg);
    body.scrollTop = body.scrollHeight;
}

function formatWidgetReply(text) {
    if (!text) return "";

    const lines = text.split("\n");
    let inTable = false;
    let tableHtml = "";
    let processed = [];

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (line.startsWith("|") && line.endsWith("|")) {
            const rawCells = line.split("|").slice(1, -1).map(c => c.trim());
            // Check if delimiter row
            if (rawCells.every(c => /^:?-+:?$/.test(c))) {
                continue;
            }
            if (!inTable) {
                inTable = true;
                tableHtml = `<div class="widget-table-scroll"><table class="widget-table"><thead><tr>${rawCells.map(c => `<th>${formatInlineMd(c)}</th>`).join("")}</tr></thead><tbody>`;
            } else {
                tableHtml += `<tr>${rawCells.map(c => `<td>${formatInlineMd(c)}</td>`).join("")}</tr>`;
            }
        } else {
            if (inTable) {
                tableHtml += `</tbody></table></div>`;
                processed.push(tableHtml);
                inTable = false;
                tableHtml = "";
            }
            processed.push(lines[i]);
        }
    }
    if (inTable) {
        tableHtml += `</tbody></table></div>`;
        processed.push(tableHtml);
    }

    let html = processed.join("\n");
    html = html.replace(/^### (.*$)/gim, '<h4 style="margin: 8px 0 4px; color: #0284c7; font-size: 0.92rem;">$1</h4>');
    html = html.replace(/^#### (.*$)/gim, '<h5 style="margin: 6px 0 3px; color: #334155; font-size: 0.85rem;">$1</h5>');
    html = html.replace(/^> (.*$)/gim, '<blockquote style="border-left: 3px solid #0284c7; background: #f0f9ff; margin: 6px 0; padding: 5px 10px; font-size: 0.8rem; color: #0369a1; border-radius: 0 4px 4px 0;">$1</blockquote>');
    html = formatInlineMd(html);
    html = html.replace(/\n/g, '<br>');
    return html;
}

function cleanWidgetLatex(str) {
    if (!str) return "";
    return str
        .replace(/\\lceil\s*([^\\$]*?)\s*\\rceil/g, 'ceil($1)')
        .replace(/\\lfloor\s*([^\\$]*?)\s*\\rfloor/g, 'floor($1)')
        .replace(/\\text\{([^}]+)\}/g, '$1')
        .replace(/\\left/g, '')
        .replace(/\\right/g, '')
        .replace(/\\times/g, '×')
        .replace(/\\ge/g, '≥')
        .replace(/\\le/g, '≤')
        .replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1 / $2)')
        .replace(/\$\$([^$]+)\$\$/g, '$1')
        .replace(/\$([^$]+)\$/g, '$1')
        .replace(/^[0-9]\uFE0F?\u20E3\s*/g, '');
}

function formatInlineMd(str) {
    if (!str) return "";
    let clean = cleanWidgetLatex(str);
    return clean
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/`(.*?)`/g, '<code style="background: rgba(0,0,0,0.06); padding: 1px 4px; border-radius: 3px; font-family: monospace; font-size: 0.82em;">$1</code>');
}

function escapeWidgetHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
