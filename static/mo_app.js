/**
 * SheetLayout AI — Material Order (MO) Approval Portal Client Logic
 * Handles role switching, live part search, constraints checking,
 * dynamic workflow preview, document upload, and team signoffs.
 */

let currentRole = localStorage.getItem("mo_active_role") || "shearing";
let allOrders = [];
let currentFilter = "all";
let selectedPartData = null;
let activeReviewMo = null;

const ROLE_CONFIGS = {
    shearing: {
        name: "Shearing (Production)",
        title: "Shearing Production Workspace",
        desc: "Create Material Orders, select cutting layouts, verify stock constraints, and route for approvals.",
        icon: "fa-industry",
        stage: null,
        pillClass: "shearing",
        showCreateBtn: true
    },
    krysalis: {
        name: "Consultants (Krysalis)",
        title: "Consultants (Krysalis) Layout Review",
        desc: "Review and verify non-standard layout documents, technical blank nesting, and cutting plan feasibility.",
        icon: "fa-compass-drafting",
        stage: "KRYSALIS",
        pillClass: "krysalis",
        showCreateBtn: false
    },
    purchase: {
        name: "Purchase Team",
        title: "Purchase & Procurement Clearance",
        desc: "Review raw material coil stock shortages, material yields, steel grade pricing, and supplier clearances.",
        icon: "fa-cart-shopping",
        stage: "PURCHASE",
        pillClass: "purchase",
        showCreateBtn: false
    },
    erp: {
        name: "ERP Team",
        title: "ERP Master Data & Release Gateway",
        desc: "Final authorization and release of fast-tracked standard orders and purchase-cleared MOs to live ERP.",
        icon: "fa-network-wired",
        stage: "ERP",
        pillClass: "erp",
        showCreateBtn: false
    }
};

document.addEventListener("DOMContentLoaded", () => {
    initRole();
    loadStats();
    loadOrders();

    const sheetsInput = document.getElementById("sheetsRequired");
    if (sheetsInput) {
        sheetsInput.addEventListener("input", () => {
            const val = parseFloat(sheetsInput.value) || 0;
            if (currentIntelData && currentIntelData.rm_opening_stock) {
                const onhand = currentIntelData.rm_opening_stock.onhand_stock || 0;
                const isSuff = onhand >= val;
                const stockCheck = document.getElementById("constraintStock");
                const badge = document.getElementById("stockStatusBadge");
                if (stockCheck) stockCheck.checked = isSuff;
                if (badge) {
                    if (isSuff) {
                        badge.className = "intel-badge in-stock";
                        badge.innerHTML = `<i class="fa-solid fa-circle-check"></i> Stock Available (${onhand} Sheets onhand)`;
                    } else {
                        const shortfall = (val - onhand).toFixed(1);
                        badge.className = "intel-badge stock-shortage";
                        badge.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Stock Shortfall: ${shortfall} Sheets required (${onhand} onhand)`;
                    }
                }
                recalculateWorkflowRoute();
            }
        });
    }
});

// Role Management
function initRole() {
    const select = document.getElementById("roleSelect");
    if (select) select.value = currentRole;
    updateRoleUI();
}

function changeRole(role) {
    currentRole = role;
    localStorage.setItem("mo_active_role", role);
    updateRoleUI();
    renderOrders();
    updateActionCount();
}

function updateRoleUI() {
    const roleInfo = ROLE_CONFIGS[currentRole] || ROLE_CONFIGS.shearing;
    const nameSpan = document.getElementById("activeRoleName");
    const pill = document.getElementById("activeRolePill");
    if (nameSpan) nameSpan.textContent = roleInfo.name;
    if (pill) {
        pill.className = `active-role-pill ${roleInfo.pillClass}`;
    }

    // Update banner
    const banner = document.getElementById("deptWorkspaceBanner");
    const bannerTitle = document.getElementById("bannerDeptTitle");
    const bannerDesc = document.getElementById("bannerDeptDesc");
    const bannerIcon = document.getElementById("bannerDeptIcon");
    const bannerBtn = document.getElementById("bannerActionBtn");

    if (banner) banner.className = `dept-workspace-banner ${roleInfo.pillClass}`;
    if (bannerTitle) bannerTitle.textContent = roleInfo.title;
    if (bannerDesc) bannerDesc.textContent = roleInfo.desc;
    if (bannerIcon) bannerIcon.innerHTML = `<i class="fa-solid ${roleInfo.icon}"></i>`;
    if (bannerBtn) {
        bannerBtn.style.display = roleInfo.showCreateBtn ? "inline-flex" : "none";
    }

    const openCreateMoBtn = document.getElementById("openCreateMoBtn");
    if (openCreateMoBtn) {
        openCreateMoBtn.style.display = roleInfo.showCreateBtn ? "inline-flex" : "none";
    }
}

// Stats & Orders Loading
async function loadStats() {
    try {
        const res = await fetch("/api/mo/stats");
        if (res.ok) {
            const stats = await res.json();
            document.getElementById("statTotal").textContent = stats.total_mos || 0;
            document.getElementById("statKrysalis").textContent = stats.pending_krysalis || 0;
            document.getElementById("statPurchase").textContent = stats.pending_purchase || 0;
            document.getElementById("statErp").textContent = stats.pending_erp || 0;
            document.getElementById("statReleased").textContent = stats.released_to_erp || 0;
        }
    } catch (err) {
        console.error("Failed to load MO stats:", err);
    }
}

async function loadOrders() {
    try {
        const res = await fetch("/api/mo/list");
        if (res.ok) {
            allOrders = await res.json();
            renderOrders();
            updateActionCount();
        }
    } catch (err) {
        console.error("Failed to load MO list:", err);
        const tbody = document.getElementById("moTableBody");
        if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="loading-cell text-danger">Failed to load orders.</td></tr>`;
    }
}

function updateActionCount() {
    const roleStage = ROLE_CONFIGS[currentRole]?.stage;
    let count = 0;
    if (roleStage) {
        count = allOrders.filter(o => o.current_stage === roleStage && o.status !== "REJECTED").length;
    }
    const badge = document.getElementById("myActionCount");
    if (badge) badge.textContent = count;
}

// Filtering
function filterByTab(tab) {
    currentFilter = tab;
    document.querySelectorAll(".mo-tab-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    renderOrders();
}

function handleSearch(query) {
    renderOrders(query.trim().toLowerCase());
}

function renderOrders(searchQuery = "") {
    const tbody = document.getElementById("moTableBody");
    if (!tbody) return;

    let filtered = [...allOrders];

    // Tab filter
    if (currentFilter === "my_action") {
        const roleStage = ROLE_CONFIGS[currentRole]?.stage;
        filtered = roleStage ? filtered.filter(o => o.current_stage === roleStage && o.status !== "REJECTED") : [];
    } else if (currentFilter === "pending") {
        filtered = filtered.filter(o => o.status && o.status.startsWith("PENDING_"));
    } else if (currentFilter === "released") {
        filtered = filtered.filter(o => o.status === "RELEASED_TO_ERP");
    } else if (currentFilter === "rejected") {
        filtered = filtered.filter(o => o.status === "REJECTED");
    }

    // Search filter
    if (searchQuery) {
        filtered = filtered.filter(o => 
            (o.mo_number && o.mo_number.toLowerCase().includes(searchQuery)) ||
            (o.part_no && o.part_no.toLowerCase().includes(searchQuery)) ||
            (o.rm_erp && o.rm_erp.toLowerCase().includes(searchQuery)) ||
            (o.base_part && o.base_part.toLowerCase().includes(searchQuery))
        );
    }

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="loading-cell">No Material Orders found matching criteria.</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(mo => {
        const isStd = mo.is_standard_layout !== false;
        const layoutBadge = isStd 
            ? `<span class="layout-type-badge standard"><i class="fa-solid fa-circle-check"></i> Standard</span>`
            : `<span class="layout-type-badge non-standard"><i class="fa-solid fa-triangle-exclamation"></i> Non-Standard</span>`;

        let statusClass = "pending-erp";
        let statusLabel = mo.status || "Pending";
        if (mo.status === "PENDING_KRYSALIS") {
            statusClass = "pending-krysalis";
            statusLabel = "Pending Krysalis";
        } else if (mo.status === "PENDING_PURCHASE") {
            statusClass = "pending-purchase";
            statusLabel = "Pending Purchase";
        } else if (mo.status === "RELEASED_TO_ERP") {
            statusClass = "released";
            statusLabel = "Released to ERP";
        } else if (mo.status === "REJECTED") {
            statusClass = "rejected";
            statusLabel = "Rejected";
        }

        // Stepper visual summary
        let routeHtml = "";
        if (mo.workflow_path === "DIRECT_ERP") {
            routeHtml = `<span class="table-route-pill" title="Fast-Track Standard Route">Shearing <i class="fa-solid fa-arrow-right"></i> ERP (Direct)</span>`;
        } else if (mo.workflow_path === "PURCHASE_ERP") {
            routeHtml = `<span class="table-route-pill" title="Constraint Review Route">Shearing <i class="fa-solid fa-arrow-right"></i> Purchase <i class="fa-solid fa-arrow-right"></i> ERP</span>`;
        } else {
            routeHtml = `<span class="table-route-pill" title="Non-Standard Layout Review Route">Shearing <i class="fa-solid fa-arrow-right"></i> Krysalis <i class="fa-solid fa-arrow-right"></i> Purchase <i class="fa-solid fa-arrow-right"></i> ERP</span>`;
        }

        const canAction = ROLE_CONFIGS[currentRole]?.stage === mo.current_stage && mo.status !== "REJECTED";

        return `
            <tr>
                <td><strong class="mo-id-badge">${escapeHtml(mo.mo_number)}</strong></td>
                <td>
                    <div><strong>${escapeHtml(mo.part_no || "")}</strong></div>
                    <small class="text-muted">Base: ${escapeHtml(mo.base_part || "-")}</small>
                </td>
                <td>
                    <div><code>${escapeHtml(mo.rm_erp || "-")}</code></div>
                    <small class="text-muted">${escapeHtml(mo.grade || "YS")}</small>
                </td>
                <td>${layoutBadge}</td>
                <td>${routeHtml}</td>
                <td><strong>${escapeHtml(mo.current_stage || "Completed")}</strong></td>
                <td><span class="status-badge ${statusClass}">${statusLabel}</span></td>
                <td style="text-align: right;">
                    <button class="btn ${canAction ? 'btn-primary' : 'btn-secondary'}" onclick="openReviewModal('${escapeHtml(mo.mo_number)}')">
                        ${canAction ? '<i class="fa-solid fa-stamp"></i> Review & Action' : '<i class="fa-solid fa-eye"></i> View'}
                    </button>
                </td>
            </tr>
        `;
    }).join("");
}

// Modal: Create MO Logic
function openCreateModal() {
    const modal = document.getElementById("createMoModal");
    const form = document.getElementById("createMoForm");
    if (form) form.reset();
    
    // Auto-generate sample MO number
    const randomMoNum = `MO-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const moNumInput = document.getElementById("moNumber");
    if (moNumInput) moNumInput.value = randomMoNum;

    selectedPartData = null;
    currentIntelData = null;
    const intelCard = document.getElementById("erpIntelligenceCard");
    if (intelCard) intelCard.style.display = "none";
    const historyWrap = document.getElementById("moHistoryTableWrap");
    if (historyWrap) historyWrap.style.display = "none";

    toggleLayoutType(true);
    recalculateWorkflowRoute();
    if (modal) modal.style.display = "flex";
}

function closeCreateModal() {
    const modal = document.getElementById("createMoModal");
    if (modal) modal.style.display = "none";
}

// Search Parts for Create Modal
let searchDebounceTimer;
function searchPartsForModal(query) {
    clearTimeout(searchDebounceTimer);
    const dropdown = document.getElementById("partDropdownResults");
    if (!query || query.length < 2) {
        if (dropdown) dropdown.style.display = "none";
        return;
    }

    searchDebounceTimer = setTimeout(async () => {
        try {
            const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
            if (res.ok) {
                const results = await res.json();
                if (dropdown) {
                    if (results.length === 0) {
                        dropdown.innerHTML = `<div class="part-dropdown-item text-muted">No matching parts found.</div>`;
                    } else {
                        dropdown.innerHTML = results.map(r => `
                            <div class="part-dropdown-item" onclick="selectPartForModal('${escapeHtml(r.part_no)}')">
                                <div>
                                    <strong>${escapeHtml(r.part_no)}</strong>
                                    <small class="text-muted"> (${r.rm_count} RM codes)</small>
                                </div>
                                <span class="badge">${escapeHtml(r.base_part)}</span>
                            </div>
                        `).join("");
                    }
                    dropdown.style.display = "block";
                }
            }
        } catch (err) {
            console.error("Part search error:", err);
        }
    }, 200);
}

async function selectPartForModal(partNo) {
    const input = document.getElementById("partNoInput");
    const dropdown = document.getElementById("partDropdownResults");
    if (input) input.value = partNo;
    if (dropdown) dropdown.style.display = "none";

    try {
        const res = await fetch(`/api/part/${encodeURIComponent(partNo)}`);
        if (res.ok) {
            selectedPartData = await res.json();
            populatePartTechnicalFields(selectedPartData);
        }
    } catch (err) {
        console.error("Failed to load part details:", err);
    }
}

function populatePartTechnicalFields(partData) {
    if (!partData) return;

    document.getElementById("basePartInput").value = partData.base_part || "";

    const rmSelect = document.getElementById("rmErpSelect");
    rmSelect.innerHTML = "";

    const records = partData.records || [];
    records.forEach((r, idx) => {
        const opt = document.createElement("option");
        opt.value = r.rm_erp || `RM-${idx}`;
        opt.textContent = `${r.rm_erp} (${r.grade || 'YS'}) - ${r.status || ''}`;
        opt.dataset.record = JSON.stringify(r);
        rmSelect.appendChild(opt);
    });

    if (records.length > 0) {
        onRmErpChanged(records[0].rm_erp);
    }
}

function onRmErpChanged(rmCode) {
    const rmSelect = document.getElementById("rmErpSelect");
    const opt = rmSelect.selectedOptions[0];
    if (!opt || !opt.dataset.record) return;

    const record = JSON.parse(opt.dataset.record);
    document.getElementById("gradeInput").value = record.grade || "YS";
    document.getElementById("thicknessInput").value = record.thickness || "";
    document.getElementById("lengthInput").value = record.length || "";
    document.getElementById("widthInput").value = record.width || "";

    document.getElementById("sheetSizeInput").value = 
        `${record.thickness || '-'} * ${record.length || '-'} * ${record.width || '-'}`;

    // Auto-detect if standard or non-standard from record status
    const statusLower = (record.status || "").toLowerCase();
    const isStandard = !statusLower.includes("non") && !statusLower.includes("not use");
    
    // Set radio buttons
    const stdRadio = document.querySelector('input[name="is_standard_layout"][value="true"]');
    const nonStdRadio = document.querySelector('input[name="is_standard_layout"][value="false"]');
    if (isStandard && stdRadio) {
        stdRadio.checked = true;
        toggleLayoutType(true);
    } else if (nonStdRadio) {
        nonStdRadio.checked = true;
        toggleLayoutType(false);
    }

    recalculateWorkflowRoute();

    // Live ERP & Stock Intelligence Call
    const partNo = document.getElementById("partNoInput")?.value?.trim();
    const sheetsNeeded = parseFloat(document.getElementById("sheetsRequired")?.value) || 1;
    if (partNo) {
        fetchAndDisplayIntelligence(
            partNo,
            record.rm_erp || rmCode,
            record.grade,
            record.thickness,
            record.length,
            record.width,
            sheetsNeeded,
            false
        );
    }
}

function toggleLayoutType(isStandard) {
    const stdCard = document.getElementById("radioCardStd");
    const nonStdCard = document.getElementById("radioCardNonStd");
    const uploadBox = document.getElementById("docUploadBox");

    if (stdCard) stdCard.classList.toggle("active", isStandard);
    if (nonStdCard) nonStdCard.classList.toggle("active", !isStandard);
    if (uploadBox) uploadBox.style.display = isStandard ? "none" : "block";

    recalculateWorkflowRoute();
}

function onFileSelected(input) {
    const nameSpan = document.getElementById("fileChosenName");
    if (input.files && input.files[0]) {
        nameSpan.textContent = `Attached: ${input.files[0].name} (${(input.files[0].size / 1024).toFixed(1)} KB)`;
        nameSpan.style.color = "#059669";
    } else {
        nameSpan.textContent = "No file selected";
        nameSpan.style.color = "";
    }
}

function recalculateWorkflowRoute() {
    const isStd = document.querySelector('input[name="is_standard_layout"]:checked')?.value === "true";
    const stockOk = document.getElementById("constraintStock")?.checked ?? true;
    const yieldOk = document.getElementById("constraintYield")?.checked ?? true;
    const constraintsMet = stockOk && yieldOk;

    const banner = document.getElementById("routePreviewBanner");
    const title = document.getElementById("routeTitle");
    const desc = document.getElementById("routeDesc");

    if (!banner || !title || !desc) return;

    if (!isStd) {
        banner.className = "workflow-route-preview krysalis";
        title.innerHTML = `<i class="fa-solid fa-compass-drafting"></i> Route: Shearing ➔ Krysalis Review ➔ Purchase ➔ ERP`;
        desc.textContent = "Non-standard layout detected. Requires layout document review by Consultants (Krysalis), followed by Purchase clearance and ERP release.";
    } else if (!constraintsMet) {
        banner.className = "workflow-route-preview warning";
        title.innerHTML = `<i class="fa-solid fa-cart-shopping"></i> Route: Shearing ➔ Purchase Approval ➔ ERP`;
        desc.textContent = "Standardized layout, but one or more constraints (Stock/Yield) are not satisfied. Sent to Purchase team for material/cost clearance.";
    } else {
        banner.className = "workflow-route-preview";
        title.innerHTML = `<i class="fa-solid fa-bolt"></i> Route: Fast-Track Directly to ERP Release`;
        desc.textContent = "Standardized layout with all constraints satisfied. Skips intermediate teams and routes directly for ERP signoff!";
    }
}

async function submitCreateMo(e) {
    e.preventDefault();
    const form = document.getElementById("createMoForm");
    const formData = new FormData(form);

    const isStd = formData.get("is_standard_layout") === "true";
    const file = formData.get("layout_doc");

    if (!isStd && (!file || !file.name)) {
        alert("Please upload a layout document. It is mandatory for Non-Standard layouts before Krysalis review.");
        return;
    }

    const submitBtn = document.getElementById("submitMoBtn");
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Submitting...`;

    try {
        const res = await fetch("/api/mo/create", {
            method: "POST",
            headers: {
                "X-Role": currentRole
            },
            body: formData
        });

        if (res.ok) {
            closeCreateModal();
            await loadStats();
            await loadOrders();
            alert("Material Order created and routed successfully!");
        } else {
            const err = await res.json();
            alert(`Error creating MO: ${err.error || 'Submission failed'}`);
        }
    } catch (err) {
        console.error("Submission failed:", err);
        alert("Failed to submit MO. Please check network connection.");
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `<i class="fa-solid fa-paper-plane"></i> Submit Material Order`;
    }
}

// Modal: Review, Stepper & Approval
async function openReviewModal(moNumber) {
    try {
        const res = await fetch(`/api/mo/${encodeURIComponent(moNumber)}`);
        if (!res.ok) return;
        activeReviewMo = await res.json();
        renderReviewModal(activeReviewMo);
        document.getElementById("reviewModal").style.display = "flex";

        // Fetch ERP & Stock intelligence for the reviewed MO
        fetchAndDisplayIntelligence(
            activeReviewMo.part_no,
            activeReviewMo.rm_erp,
            activeReviewMo.grade,
            activeReviewMo.thickness,
            activeReviewMo.length,
            activeReviewMo.width,
            activeReviewMo.sheets_required || 1,
            true
        );
    } catch (err) {
        console.error("Failed to load MO details:", err);
    }
}

function closeReviewModal() {
    activeReviewMo = null;
    document.getElementById("reviewModal").style.display = "none";
}

function renderReviewModal(mo) {
    document.getElementById("reviewMoTitle").textContent = `${mo.mo_number} — ${mo.part_no}`;
    document.getElementById("reviewMoSubtitle").textContent = 
        `Base: ${mo.base_part || '-'} | RM ERP: ${mo.rm_erp || '-'} | Grade: ${mo.grade || 'YS'}`;

    // Render Stepper
    renderStepper(mo);

    // Render Specs Grid
    const grid = document.getElementById("reviewDetailsGrid");
    grid.innerHTML = `
        <div class="review-item">
            <span class="review-label">MO Number</span>
            <span class="review-val">${escapeHtml(mo.mo_number)}</span>
        </div>
        <div class="review-item">
            <span class="review-label">Part Number</span>
            <span class="review-val">${escapeHtml(mo.part_no)}</span>
        </div>
        <div class="review-item">
            <span class="review-label">Base Part</span>
            <span class="review-val">${escapeHtml(mo.base_part || '-')}</span>
        </div>
        <div class="review-item">
            <span class="review-label">RM ERP Code</span>
            <span class="review-val">${escapeHtml(mo.rm_erp || '-')}</span>
        </div>
        <div class="review-item">
            <span class="review-label">Sheet Dimensions</span>
            <span class="review-val">${mo.thickness || '-'} * ${mo.length || '-'} * ${mo.width || '-'} mm</span>
        </div>
        <div class="review-item">
            <span class="review-label">Target / Sheets Qty</span>
            <span class="review-val">${mo.target_qty || 1} units (${mo.sheets_required || 1} sheets)</span>
        </div>
        <div class="review-item">
            <span class="review-label">Layout Standard</span>
            <span class="review-val">${mo.is_standard_layout ? '✅ Standardized' : '⚠️ Non-Standard'}</span>
        </div>
        <div class="review-item">
            <span class="review-label">Workflow Path</span>
            <span class="review-val"><code>${escapeHtml(mo.workflow_path || '-')}</code></span>
        </div>
        <div class="review-item">
            <span class="review-label">Current Stage</span>
            <span class="review-val"><strong style="color: #2563eb;">${escapeHtml(mo.current_stage || 'Completed')}</strong></span>
        </div>
    `;

    // Render Document Attachment if any
    const docSec = document.getElementById("reviewDocSection");
    const docCard = document.getElementById("docPreviewCard");
    if (mo.layout_doc_url) {
        docSec.style.display = "block";
        docCard.innerHTML = `
            <div>
                <strong><i class="fa-solid fa-file-pdf"></i> ${escapeHtml(mo.layout_doc_filename || 'Layout Document')}</strong>
                <small class="text-muted block">Uploaded by Shearing for Non-Standard layout verification</small>
            </div>
            <a href="${escapeHtml(mo.layout_doc_url)}" target="_blank" class="btn btn-secondary">
                <i class="fa-solid fa-arrow-up-right-from-square"></i> Open Drawing
            </a>
        `;
    } else {
        docSec.style.display = "none";
    }

    // Render Timeline
    const timeline = document.getElementById("auditTimeline");
    const trail = mo.audit_trail || [];
    timeline.innerHTML = trail.map(t => `
        <div class="timeline-item">
            <div class="timeline-header">
                <span class="timeline-role">${escapeHtml(t.actor_name || t.actor_role)} (${t.action})</span>
                <span class="timeline-time">${formatDate(t.timestamp)}</span>
            </div>
            <div class="timeline-remarks">${escapeHtml(t.remarks || 'No remarks.')}</div>
        </div>
    `).join("");

    // Render Approval / Action Panel
    const actionPanel = document.getElementById("actionPanel");
    const canAction = ROLE_CONFIGS[currentRole]?.stage === mo.current_stage && mo.status !== "REJECTED";
    if (canAction) {
        actionPanel.style.display = "flex";
        document.getElementById("actionPanelTitle").innerHTML = `<i class="fa-solid fa-stamp"></i> Action Required: ${ROLE_CONFIGS[currentRole].name}`;
        document.getElementById("actionPanelRole").textContent = mo.current_stage;
        document.getElementById("approvalRemarks").value = "";
    } else {
        actionPanel.style.display = "none";
    }
}

function renderStepper(mo) {
    const wrap = document.getElementById("stepperWrap");
    if (!wrap) return;

    let steps = [];
    if (mo.workflow_path === "DIRECT_ERP") {
        steps = [
            { id: "shearing", title: "Shearing Initiated" },
            { id: "erp", title: "ERP Signoff" }
        ];
    } else if (mo.workflow_path === "PURCHASE_ERP") {
        steps = [
            { id: "shearing", title: "Shearing Initiated" },
            { id: "purchase", title: "Purchase Review" },
            { id: "erp", title: "ERP Signoff" }
        ];
    } else {
        steps = [
            { id: "shearing", title: "Shearing Initiated" },
            { id: "krysalis", title: "Krysalis Review" },
            { id: "purchase", title: "Purchase Clearance" },
            { id: "erp", title: "ERP Signoff" }
        ];
    }

    const currentStage = (mo.current_stage || "").toLowerCase();
    const isCompleted = mo.status === "RELEASED_TO_ERP";
    const isRejected = mo.status === "REJECTED";

    let passedCurrent = false;

    wrap.innerHTML = steps.map((step, idx) => {
        let nodeClass = "step-node";
        let isNodeActive = false;
        let isNodeCompleted = false;

        if (isCompleted) {
            isNodeCompleted = true;
        } else if (isRejected) {
            nodeClass += " rejected";
        } else {
            if (step.id === "shearing") {
                isNodeCompleted = true;
            } else if (step.id === currentStage) {
                isNodeActive = true;
                passedCurrent = true;
            } else if (!passedCurrent) {
                isNodeCompleted = true;
            }
        }

        if (isNodeCompleted) nodeClass += " completed";
        if (isNodeActive) nodeClass += " active";

        const hasLine = idx < steps.length - 1;

        return `
            <div class="${nodeClass}">
                <div class="step-circle">
                    ${isNodeCompleted ? '<i class="fa-solid fa-check"></i>' : (idx + 1)}
                </div>
                <span class="step-title">${step.title}</span>
                ${hasLine ? '<div class="step-line"></div>' : ''}
            </div>
        `;
    }).join("");
}

// Action Handlers
async function confirmApproveMo() {
    if (!activeReviewMo) return;
    const remarks = document.getElementById("approvalRemarks")?.value.trim() || "Approved";

    try {
        const res = await fetch(`/api/mo/${encodeURIComponent(activeReviewMo.mo_number)}/approve`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Role": currentRole
            },
            body: JSON.stringify({ role: currentRole, remarks })
        });

        if (res.ok) {
            const updated = await res.json();
            alert(`Order ${updated.mo_number} approved successfully!`);
            closeReviewModal();
            await loadStats();
            await loadOrders();
        } else {
            const err = await res.json();
            alert(`Approval failed: ${err.error || 'Server error'}`);
        }
    } catch (err) {
        console.error("Approve request failed:", err);
    }
}

async function promptRejectMo() {
    if (!activeReviewMo) return;
    const reason = prompt("Please enter the reason for rejecting this Material Order:");
    if (!reason || !reason.trim()) {
        alert("Rejection reason is required.");
        return;
    }

    try {
        const res = await fetch(`/api/mo/${encodeURIComponent(activeReviewMo.mo_number)}/reject`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Role": currentRole
            },
            body: JSON.stringify({ role: currentRole, reason })
        });

        if (res.ok) {
            const updated = await res.json();
            alert(`Order ${updated.mo_number} has been rejected.`);
            closeReviewModal();
            await loadStats();
            await loadOrders();
        } else {
            const err = await res.json();
            alert(`Rejection failed: ${err.error || 'Server error'}`);
        }
    } catch (err) {
        console.error("Reject request failed:", err);
    }
}

// Helpers
function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function formatDate(isoStr) {
    if (!isoStr) return "";
    try {
        const d = new Date(isoStr);
        return d.toLocaleString("en-US", {
            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
        });
    } catch (e) {
        return isoStr;
    }
}

// ERP, Stock & MRP Intelligence Functions
let currentIntelData = null;

async function fetchAndDisplayIntelligence(partNo, rmCode, grade, thickness, length, width, sheetsNeeded, isReview = false) {
    if (!partNo) return;
    const cardId = isReview ? "reviewErpIntelCard" : "erpIntelligenceCard";
    const card = document.getElementById(cardId);
    if (!card) return;

    card.style.display = "block";
    const badge = document.getElementById(isReview ? "reviewStockStatusBadge" : "stockStatusBadge");
    if (badge) {
        badge.className = "intel-badge";
        badge.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Checking Inventory &amp; MOs...`;
    }

    try {
        const params = new URLSearchParams({
            rm: rmCode || "",
            grade: grade || "",
            thickness: thickness || "",
            length: length || "",
            width: width || "",
            sheets: sheetsNeeded || 1
        });
        const res = await fetch(`/api/intelligence/part/${encodeURIComponent(partNo)}?${params.toString()}`);
        if (!res.ok) return;
        const intel = await res.json();
        if (!isReview) currentIntelData = intel;

        renderIntelligenceCard(intel, isReview);
    } catch (err) {
        console.error("Failed to load ERP & Stock intelligence:", err);
    }
}

function renderIntelligenceCard(intel, isReview = false) {
    const prefix = isReview ? "review" : "";
    
    // 1. RM Opening Stock
    const rmStockEl = document.getElementById(`${prefix}IntelRmStock`);
    const rmDetailEl = document.getElementById(`${prefix}IntelRmDetail`);
    const rm = intel.rm_opening_stock;
    if (rmStockEl) {
        rmStockEl.textContent = rm ? `${rm.onhand_stock || 0} Sheets` : "0 Sheets";
    }
    if (rmDetailEl) {
        if (rm) {
            const wtStr = rm.total_weight ? `${Number(rm.total_weight).toLocaleString()} kg` : "0 kg";
            const priceStr = rm.last_po_price ? ` | PO: ₹${rm.last_po_price}` : "";
            rmDetailEl.textContent = `${rm.item_code} (${wtStr}${priceStr})`;
        } else {
            rmDetailEl.textContent = "Not in Main Store inventory";
        }
    }

    // 2. Parts Opening Stock (FG & WIP)
    const fgStockEl = document.getElementById(`${prefix}IntelFgStock`);
    const fgDetailEl = document.getElementById(`${prefix}IntelFgDetail`);
    const partsStock = intel.parts_opening_stock || {};
    const fgItems = partsStock.items || [];
    if (fgStockEl) {
        fgStockEl.textContent = `${partsStock.total_onhand_qty || 0} Nos`;
    }
    if (fgDetailEl) {
        if (fgItems.length > 0) {
            const categories = [...new Set(fgItems.map(i => i.category || "Stock"))].join(", ");
            fgDetailEl.textContent = `${fgItems.length} SKU(s) in 002 (${categories})`;
        } else {
            fgDetailEl.textContent = "0 Nos in 002 - FG & WIP store";
        }
    }

    // 3. MRP Monthly Schedule
    const mrpTotalEl = document.getElementById(`${prefix}IntelMrpTotal`);
    const mrpDetailEl = document.getElementById(`${prefix}IntelMrpDetail`);
    const mrp = intel.mrp_schedule || {};
    if (mrpTotalEl) {
        mrpTotalEl.textContent = mrp.monthly_total !== null && mrp.monthly_total !== undefined 
            ? `${mrp.monthly_total} Nos` 
            : "- Nos";
    }
    if (mrpDetailEl) {
        if (mrp.weekly_breakdown) {
            const w = mrp.weekly_breakdown;
            mrpDetailEl.textContent = `Wk1:${w.wk1 || 0} | Wk2:${w.wk2 || 0} | Wk3:${w.wk3 || 0} | Wk4:${w.wk4 || 0} | Wk5:${w.wk5 || 0}`;
        } else {
            mrpDetailEl.textContent = "No active monthly schedule in Sales MRP";
        }
    }

    // 4. Previous MOs in ERP
    const moCountEl = document.getElementById(`${prefix}IntelMoCount`);
    const prevMos = intel.previous_mos || { records: [], total_found: 0 };
    if (moCountEl) {
        moCountEl.textContent = `${prevMos.total_found || 0} MOs`;
    }

    // Populate Previous MOs Table
    const tableBody = document.getElementById(isReview ? "reviewMoHistoryTableBody" : "moHistoryTableBody");
    if (tableBody) {
        if (!prevMos.records || prevMos.records.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="6" class="text-muted" style="text-align:center; padding: 12px;">No previous MO records found for this part in ERP MO Report.</td></tr>`;
        } else {
            tableBody.innerHTML = prevMos.records.map(m => {
                const isReleased = (m.status || "").toUpperCase() === "RELEASED";
                const isCompleted = (m.status || "").toUpperCase() === "COMPLETED";
                const badgeStyle = isReleased 
                    ? "background: #e0f2fe; color: #0284c7; padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 0.75rem;" 
                    : isCompleted
                    ? "background: #dcfce7; color: #16a34a; padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 0.75rem;"
                    : "background: #f1f5f9; color: #475569; padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 0.75rem;";
                return `
                    <tr>
                        <td><strong>${escapeHtml(m.mo_doc_no)}</strong></td>
                        <td>${escapeHtml(m.doc_date || '-')}</td>
                        <td><span style="${badgeStyle}">${escapeHtml(m.status || 'LOGGED')}</span></td>
                        <td><strong>${m.no_of_sheets !== null && m.no_of_sheets !== undefined ? m.no_of_sheets : '-'}</strong></td>
                        <td><code>${escapeHtml(m.cutting_plan_no || '-')}</code></td>
                        <td><small title="${escapeHtml(m.parent_desc || '')}">${escapeHtml(m.parent_code || '-')}</small></td>
                    </tr>
                `;
            }).join("");
        }
    }

    // Stock Feasibility Check & Routing Constraint
    const feas = intel.stock_feasibility || {};
    const badge = document.getElementById(isReview ? "reviewStockStatusBadge" : "stockStatusBadge");
    if (badge) {
        if (feas.is_sufficient) {
            badge.className = "intel-badge in-stock";
            badge.innerHTML = `<i class="fa-solid fa-circle-check"></i> Stock Available (${feas.sheets_onhand} Sheets onhand)`;
        } else {
            badge.className = "intel-badge stock-shortage";
            const onhandTxt = feas.sheets_onhand > 0 ? `${feas.sheets_onhand} onhand` : "0 in stock";
            badge.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Stock Shortfall: ${feas.shortfall} Sheets required (${onhandTxt})`;
        }
    }

    if (!isReview) {
        const stockConstraint = document.getElementById("constraintStock");
        if (stockConstraint) {
            stockConstraint.checked = !!feas.is_sufficient;
            recalculateWorkflowRoute();
        }
    }
}

function toggleMoHistoryTable() {
    const wrap = document.getElementById("moHistoryTableWrap");
    if (wrap) {
        wrap.style.display = (wrap.style.display === "none" || !wrap.style.display) ? "block" : "none";
    }
}

function toggleReviewMoHistoryTable() {
    const wrap = document.getElementById("reviewMoHistoryTableWrap");
    if (wrap) {
        wrap.style.display = (wrap.style.display === "none" || !wrap.style.display) ? "block" : "none";
    }
}
