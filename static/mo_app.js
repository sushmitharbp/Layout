/**
 * SheetLayout AI — Material Order (MO) Approval Portal Client Logic
 * Handles role switching, live part search, constraints checking,
 * dynamic workflow preview, document upload, and team signoffs.
 */

let currentRole = window.AUTH_ROLE || localStorage.getItem("mo_active_role") || "shearing";
let allOrders = [];
let currentFilter = "all";
let currentFilterStatus = "all";
let currentFilterLayout = "all";
let currentFilterStage = "all";
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
    Promise.all([loadStats(), loadOrders(), loadDbTablesOverview()]).catch(console.error);


    const sheetsInput = document.getElementById("sheetsRequired");
    if (sheetsInput) {
        sheetsInput.addEventListener("input", () => {
            updateAutomatedConstraints();
        });
    }
});

// Role Management
function initRole() {
    if (window.AUTH_ROLE) {
        currentRole = window.AUTH_ROLE;
        localStorage.setItem("mo_active_role", currentRole);
    }
    const select = document.getElementById("roleSelect");
    if (select) select.value = currentRole;
    updateRoleUI();
}

function changeRole(role) {
    if (role !== currentRole) {
        // Enforce logging in to the requested department
        window.location.href = `/logout`;
        return;
    }
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

    // End Bit MO creation controls: strictly reserved for Shearing Production team
    const isShearing = (currentRole === "shearing");

    const sideNavEb = document.getElementById("sideNavCreateEndbitMo");
    if (sideNavEb) sideNavEb.style.display = isShearing ? "flex" : "none";

    const bannerEbBtn = document.getElementById("bannerCreateEbMoBtn");
    if (bannerEbBtn) bannerEbBtn.style.display = isShearing ? "inline-flex" : "none";

    const ebStoreCreateMoBtn = document.getElementById("ebStoreCreateMoBtn");
    if (ebStoreCreateMoBtn) ebStoreCreateMoBtn.style.display = isShearing ? "inline-flex" : "none";

    const ebStoreAddManualBtn = document.getElementById("ebStoreAddManualBtn");
    if (ebStoreAddManualBtn) ebStoreAddManualBtn.style.display = isShearing ? "inline-flex" : "none";

    const actionTh = document.querySelector(".shearing-action-th");
    if (actionTh) actionTh.style.display = isShearing ? "" : "none";

    if (window.allEndbits && window.allEndbits.length > 0) {
        renderEndbitsTable(window.allEndbits);
    }
}

// Stats & Orders Loading
async function loadStats() {
    try {
        const [resMo, resEb] = await Promise.all([
            fetch("/api/mo/stats"),
            fetch("/api/endbits/stats").catch(() => null)
        ]);
        if (resMo.ok) {
            const stats = await resMo.json();
            document.getElementById("statTotal").textContent = stats.total_mos || 0;
            document.getElementById("statKrysalis").textContent = stats.pending_krysalis || 0;
            document.getElementById("statPurchase").textContent = stats.pending_purchase || 0;
            document.getElementById("statErp").textContent = stats.pending_erp || 0;
            document.getElementById("statReleased").textContent = stats.released_to_erp || 0;
        }
        if (resEb && resEb.ok) {
            const ebStats = await resEb.json();
            const ebCountEl = document.getElementById("sideNavEndbitsCount");
            if (ebCountEl) ebCountEl.textContent = ebStats.total_records || 0;
            const ebTotalPill = document.getElementById("ebStoreTotalPill");
            if (ebTotalPill) ebTotalPill.textContent = `${ebStats.total_records || 0} Recorded`;
            const ebTot = document.getElementById("statEbTotal");
            if (ebTot) ebTot.textContent = ebStats.total_records || 0;
            const ebAvail = document.getElementById("statEbAvailable");
            if (ebAvail) ebAvail.textContent = ebStats.total_available_nos || 0;
            const ebParts = document.getElementById("statEbPartsCreated");
            if (ebParts) ebParts.textContent = ebStats.total_parts_made || 0;
            const ebWeight = document.getElementById("statEbWeight");
            if (ebWeight) ebWeight.innerHTML = `${(ebStats.total_weight_kg || 0).toFixed(1)} <small style="font-size: 0.9rem;">kg</small>`;
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
            const sideCount = document.getElementById("sideNavMoCount");
            if (sideCount) sideCount.textContent = allOrders.length;
        }
    } catch (err) {
        console.error("Failed to load MO list:", err);
        const tbody = document.getElementById("moTableBody");
        if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="loading-cell text-danger">Failed to load orders.</td></tr>`;
    }
}

function updateActionCount() {
    let count = 0;
    if (currentRole === "shearing") {
        // For Shearing team (the creators), Rejected MOs require immediate attention/revision
        count = allOrders.filter(o => o.status === "REJECTED").length;
    } else {
        const roleStage = ROLE_CONFIGS[currentRole]?.stage;
        if (roleStage) {
            count = allOrders.filter(o => o.current_stage === roleStage && o.status !== "REJECTED").length;
        }
    }
    const badge = document.getElementById("myActionCount");
    if (badge) badge.textContent = count;
}


// Filtering & Date State
let currentSearchQuery = "";
let currentDatePreset = "all";
let currentDateFrom = "";
let currentDateTo = "";
let filteredOrders = []; // Holds currently active filtered orders for report export

function filterByTab(tab) {
    currentFilter = tab;
    document.querySelectorAll(".mo-tab-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    renderOrders();
}

function handleSearch(query) {
    currentSearchQuery = (query || "").trim().toLowerCase();
    renderOrders();
}

function onDropdownFilterChange() {
    const statusSelect = document.getElementById("filterStatusSelect");
    const layoutSelect = document.getElementById("filterLayoutTypeSelect");
    const stageSelect = document.getElementById("filterStageSelect");
    const resetBtn = document.getElementById("resetFiltersBtn");

    currentFilterStatus = statusSelect?.value || "all";
    currentFilterLayout = layoutSelect?.value || "all";
    currentFilterStage = stageSelect?.value || "all";

    const isFiltered = currentFilterStatus !== "all" || currentFilterLayout !== "all" || currentFilterStage !== "all" || (currentSearchQuery && currentSearchQuery.length > 0);
    if (resetBtn) {
        resetBtn.style.display = isFiltered ? "inline-flex" : "none";
    }

    renderOrders();
}

function resetAllDropdownFilters() {
    currentFilterStatus = "all";
    currentFilterLayout = "all";
    currentFilterStage = "all";
    currentSearchQuery = "";

    const statusSelect = document.getElementById("filterStatusSelect");
    const layoutSelect = document.getElementById("filterLayoutTypeSelect");
    const stageSelect = document.getElementById("filterStageSelect");
    const searchInput = document.getElementById("moSearchInput");
    const resetBtn = document.getElementById("resetFiltersBtn");

    if (statusSelect) statusSelect.value = "all";
    if (layoutSelect) layoutSelect.value = "all";
    if (stageSelect) stageSelect.value = "all";
    if (searchInput) searchInput.value = "";
    if (resetBtn) resetBtn.style.display = "none";

    renderOrders();
}

function formatMoDate(isoStr) {
    if (!isoStr) return "-";
    try {
        const d = new Date(isoStr);
        if (isNaN(d.getTime())) return isoStr;
        return d.toLocaleDateString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric"
        });
    } catch {
        return isoStr;
    }
}

function formatYieldBadge(moOrYield) {
    let raw = moOrYield;
    if (moOrYield && typeof moOrYield === "object") {
        raw = moOrYield.yield_pct !== undefined && moOrYield.yield_pct !== null 
            ? moOrYield.yield_pct 
            : (moOrYield.constraints_status?.yield_pct);
    }
    if (raw === undefined || raw === null || String(raw).trim() === "") {
        return `<span class="yield-badge yield-na">N/A</span>`;
    }
    const cleanStr = String(raw).replace("%", "").trim();
    const num = parseFloat(cleanStr);
    if (!isNaN(num) && num > 0) {
        const isHigh = num >= 90;
        const isMed = num >= 80;
        const cls = isHigh ? "yield-high" : (isMed ? "yield-med" : "yield-low");
        const icon = isHigh ? "fa-arrow-trend-up" : "fa-chart-pie";
        return `<span class="yield-badge ${cls}"><i class="fa-solid ${icon}"></i> ${num.toFixed(1)}%</span>`;
    }
    if (cleanStr.toUpperCase() !== "N/A") {
        return `<span class="yield-badge yield-med">${escapeHtml(cleanStr)}</span>`;
    }
    return `<span class="yield-badge yield-na">N/A</span>`;
}

function renderOrders() {
    const tbody = document.getElementById("moTableBody");
    if (!tbody) return;

    let filtered = [...allOrders];

    // 1. Tab filter
    if (currentFilter === "my_action") {
        if (currentRole === "shearing") {
            // For Shearing team: Action Required shows all REJECTED orders requiring review or revision
            filtered = filtered.filter(o => o.status === "REJECTED");
        } else {
            const roleStage = ROLE_CONFIGS[currentRole]?.stage;
            filtered = roleStage ? filtered.filter(o => o.current_stage === roleStage && o.status !== "REJECTED") : [];
        }
    } else if (currentFilter === "pending") {
        filtered = filtered.filter(o => o.status && o.status.startsWith("PENDING_"));
    } else if (currentFilter === "released") {
        filtered = filtered.filter(o => o.status === "RELEASED_TO_ERP" || o.status === "RELEASED");
    } else if (currentFilter === "rejected") {
        filtered = filtered.filter(o => o.status === "REJECTED");
    }

    // 2. Search filter
    if (currentSearchQuery) {
        filtered = filtered.filter(o => 
            (o.mo_number && o.mo_number.toLowerCase().includes(currentSearchQuery)) ||
            (o.part_no && o.part_no.toLowerCase().includes(currentSearchQuery)) ||
            (o.rm_erp && o.rm_erp.toLowerCase().includes(currentSearchQuery)) ||
            (o.base_part && o.base_part.toLowerCase().includes(currentSearchQuery)) ||
            (o.grade && o.grade.toLowerCase().includes(currentSearchQuery)) ||
            (o.layout_name && o.layout_name.toLowerCase().includes(currentSearchQuery))
        );
    }

    // 3. Status Dropdown Filter
    if (currentFilterStatus && currentFilterStatus !== "all") {
        if (currentFilterStatus === "PENDING_ALL") {
            filtered = filtered.filter(o => o.status && o.status.startsWith("PENDING_"));
        } else if (currentFilterStatus === "RELEASED_TO_ERP") {
            filtered = filtered.filter(o => o.status === "RELEASED_TO_ERP" || o.status === "RELEASED");
        } else {
            filtered = filtered.filter(o => o.status === currentFilterStatus);
        }
    }

    // 4. Layout Type Dropdown Filter
    if (currentFilterLayout && currentFilterLayout !== "all") {
        if (currentFilterLayout === "standard") {
            filtered = filtered.filter(o => o.is_standard_layout !== false);
        } else if (currentFilterLayout === "non_standard") {
            filtered = filtered.filter(o => o.is_standard_layout === false);
        }
    }

    // 5. Current Stage Dropdown Filter
    if (currentFilterStage && currentFilterStage !== "all") {
        filtered = filtered.filter(o => o.current_stage === currentFilterStage);
    }

    filteredOrders = filtered;

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="loading-cell">No Material Orders found matching criteria.</td></tr>`;
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

        let actionBtnText = '<i class="fa-solid fa-eye"></i> View';
        let actionBtnClass = 'btn-secondary';

        if (currentRole === "shearing" && mo.status === "REJECTED") {
            actionBtnText = '<i class="fa-solid fa-pen-to-square"></i> Revise &amp; Resubmit';
            actionBtnClass = 'btn-danger';
        } else if (ROLE_CONFIGS[currentRole]?.stage === mo.current_stage && mo.status !== "REJECTED") {
            actionBtnText = '<i class="fa-solid fa-stamp"></i> Review & Action';
            actionBtnClass = 'btn-primary';
        }

        return `
            <tr>
                <td>
                    <strong class="mo-id-badge">${escapeHtml(mo.mo_number)}</strong>
                    <div class="mo-date-subtext"><i class="fa-regular fa-calendar"></i> ${formatMoDate(mo.created_at)}</div>
                </td>
                <td>
                    <div><strong>${escapeHtml(mo.part_no || "")}</strong></div>
                    <small class="text-muted">Base: ${escapeHtml(mo.base_part || "-")}</small>
                </td>
                <td>
                    <div><code>${escapeHtml(mo.rm_erp || "-")}</code></div>
                    <small class="text-muted">${escapeHtml(mo.grade || "YS")}</small>
                </td>
                <td>${formatYieldBadge(mo)}</td>
                <td>${layoutBadge}</td>
                <td>${routeHtml}</td>
                <td><strong>${escapeHtml(mo.current_stage || "Completed")}</strong></td>
                <td><span class="status-badge ${statusClass}">${statusLabel}</span></td>
                <td style="text-align: right;">
                    <button class="btn ${actionBtnClass}" onclick="openReviewModal('${escapeHtml(mo.mo_number)}')">
                        ${actionBtnText}
                    </button>
                </td>
            </tr>
        `;
    }).join("");

}

// Download Report (Executive PDF Export)
function downloadMoReport() {
    if (!filteredOrders || filteredOrders.length === 0) {
        alert("No Material Orders matching current filters to download.");
        return;
    }

    const todayStr = new Date().toISOString().split("T")[0];
    const filterTag = currentFilter !== "all" ? `_${currentFilter}` : "";
    const filename = `Material_Orders_Report${filterTag}_${todayStr}.pdf`;

    // 1. Check if jsPDF & AutoTable are loaded
    if (window.jspdf && window.jspdf.jsPDF) {
        try {
            generateMoReportPdf(filteredOrders, filename);
            return;
        } catch (err) {
            console.error("[PDF Export] Client generation error, falling back to server:", err);
        }
    }

    // 2. Server-side fallback via /api/mo/export?format=pdf
    const params = new URLSearchParams();
    params.set("format", "pdf");
    if (currentRole) params.set("role", currentRole);
    if (currentFilter && currentFilter !== "all") params.set("tab", currentFilter);
    if (currentFilterStatus && currentFilterStatus !== "all") params.set("status", currentFilterStatus);
    if (currentFilterLayout && currentFilterLayout !== "all") params.set("layout_type", currentFilterLayout);
    if (currentFilterStage && currentFilterStage !== "all") params.set("stage", currentFilterStage);
    const searchVal = document.getElementById("moSearchInput")?.value?.trim();
    if (searchVal) params.set("q", searchVal);

    window.location.href = `/api/mo/export?${params.toString()}`;
}

// Generate PDF Report using jsPDF & AutoTable
function generateMoReportPdf(orders, filename) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({
        orientation: "landscape",
        unit: "mm",
        format: "a4"
    });

    const pageWidth = doc.internal.pageSize.width;  // 297mm
    const pageHeight = doc.internal.pageSize.height; // 210mm
    const margin = 8;

    // --- 1. Top Header Banner ---
    doc.setFillColor(15, 23, 42); // Navy Slate #0f172a
    doc.rect(0, 0, pageWidth, 24, "F");

    // Accent line (Teal #0ea5e9)
    doc.setFillColor(14, 165, 233);
    doc.rect(0, 24, pageWidth, 1.5, "F");

    // Title & Brand
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(15);
    doc.text("SheetLayout AI", margin, 11);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(148, 163, 184); // Slate 400
    doc.text("PRECISION MANUFACTURING ORDER (MO) OPERATIONS REPORT", margin, 17);

    // Generation timestamp & badge on right
    const nowStr = new Date().toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
    });

    doc.setFontSize(8);
    doc.setTextColor(203, 213, 225);
    doc.text(`Generated: ${nowStr}`, pageWidth - margin, 10, { align: "right" });
    
    // Status Tag pill on top right
    doc.setFillColor(30, 41, 59);
    doc.roundedRect(pageWidth - margin - 46, 13.5, 46, 6.5, 1.5, 1.5, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7);
    doc.setTextColor(56, 189, 248); // Sky blue
    doc.text("OFFICIAL MO REPORT", pageWidth - margin - 23, 17.8, { align: "center" });

    // --- 2. Filter Summary Bar ---
    let startY = 31;
    doc.setFillColor(241, 245, 249);
    doc.roundedRect(margin, startY, pageWidth - (margin * 2), 11, 1.5, 1.5, "F");
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.3);
    doc.roundedRect(margin, startY, pageWidth - (margin * 2), 11, 1.5, 1.5, "S");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(51, 65, 85);

    const activeTabLabel = currentFilter ? currentFilter.toUpperCase().replace("_", " ") : "ALL";
    const statusLabel = currentFilterStatus !== "all" ? currentFilterStatus.replace(/_/g, " ") : "ALL";
    const layoutLabel = currentFilterLayout === "standard" ? "Standardized" : (currentFilterLayout === "non_standard" ? "Non-Standard" : "ALL");
    const stageLabel = currentFilterStage !== "all" ? currentFilterStage : "ALL";
    const searchVal = document.getElementById("moSearchInput")?.value?.trim() || "None";
    const roleName = ROLES[currentRole]?.name || currentRole.toUpperCase();

    doc.text(`Tab: `, margin + 3, startY + 6.8);
    doc.setFont("helvetica", "normal");
    doc.text(`${activeTabLabel}`, margin + 11, startY + 6.8);

    doc.setFont("helvetica", "bold");
    doc.text(`Status: `, margin + 40, startY + 6.8);
    doc.setFont("helvetica", "normal");
    doc.text(`${statusLabel}`, margin + 52, startY + 6.8);

    doc.setFont("helvetica", "bold");
    doc.text(`Layout: `, margin + 102, startY + 6.8);
    doc.setFont("helvetica", "normal");
    doc.text(`${layoutLabel}`, margin + 114, startY + 6.8);

    doc.setFont("helvetica", "bold");
    doc.text(`Stage: `, margin + 154, startY + 6.8);
    doc.setFont("helvetica", "normal");
    doc.text(`${stageLabel}`, margin + 165, startY + 6.8);

    doc.setFont("helvetica", "bold");
    doc.text(`Search: `, margin + 208, startY + 6.8);
    doc.setFont("helvetica", "normal");
    doc.text(`${searchVal.length > 18 ? searchVal.slice(0, 16) + '...' : searchVal}`, margin + 221, startY + 6.8);

    // --- 3. Summary Metric Cards ---
    startY = 46;
    const totalOrders = orders.length;
    const totalTargetUnits = orders.reduce((sum, o) => sum + (parseInt(o.target_qty) || 1), 0);
    const totalSheets = orders.reduce((sum, o) => sum + (parseFloat(o.sheets_required) || 1), 0);
    const releasedOrders = orders.filter(o => o.status === "RELEASED").length;
    const pendingOrders = orders.filter(o => (o.status || "").startsWith("PENDING")).length;

    const cards = [
        { label: "TOTAL ORDERS", val: String(totalOrders), bg: [248, 250, 252], border: [203, 213, 225], text: [15, 23, 42] },
        { label: "TARGET QUANTITY", val: `${totalTargetUnits.toLocaleString()} Pcs`, bg: [238, 242, 255], border: [199, 210, 254], text: [67, 56, 202] },
        { label: "SHEETS REQUIRED", val: `${totalSheets.toFixed(1)} Sheets`, bg: [254, 243, 199], border: [253, 230, 138], text: [180, 83, 9] },
        { label: "RELEASED TO PROD", val: String(releasedOrders), bg: [240, 253, 244], border: [187, 247, 208], text: [22, 101, 52] },
        { label: "PENDING APPROVAL", val: String(pendingOrders), bg: [254, 242, 242], border: [254, 202, 202], text: [185, 28, 28] }
    ];

    const cardWidth = (pageWidth - (margin * 2) - ((cards.length - 1) * 3)) / cards.length;
    cards.forEach((c, idx) => {
        const x = margin + (idx * (cardWidth + 3));
        doc.setFillColor(...c.bg);
        doc.roundedRect(x, startY, cardWidth, 12, 1.2, 1.2, "F");
        doc.setDrawColor(...c.border);
        doc.setLineWidth(0.3);
        doc.roundedRect(x, startY, cardWidth, 12, 1.2, 1.2, "S");

        doc.setFont("helvetica", "bold");
        doc.setFontSize(6);
        doc.setTextColor(100, 116, 139);
        doc.text(c.label, x + (cardWidth / 2), startY + 4, { align: "center" });

        doc.setFont("helvetica", "bold");
        doc.setFontSize(9);
        doc.setTextColor(...c.text);
        doc.text(c.val, x + (cardWidth / 2), startY + 9.5, { align: "center" });
    });

    // --- 4. Main Orders Table ---
    const headers = [
        "#",
        "MO Number",
        "Date",
        "Part Number",
        "Base Part",
        "RM ERP Code",
        "Yield %",
        "Thk",
        "Sheets",
        "Target Qty",
        "Stage",
        "Status",
        "Route"
    ];

    const tableRows = orders.map((mo, i) => {
        const dateStr = mo.created_at ? mo.created_at.slice(0, 10) : "-";
        const thkStr = mo.thickness ? `${mo.thickness}mm` : "-";
        const sheetsVal = mo.sheets_required !== undefined ? String(mo.sheets_required) : "1";
        const targetVal = mo.target_qty !== undefined ? String(mo.target_qty) : "1";
        const routeStr = (mo.workflow_path || "DIRECT_ERP").replace("_", " ");
        const yValRaw = mo.yield_pct !== undefined && mo.yield_pct !== null ? mo.yield_pct : (mo.constraints_status?.yield_pct);
        const yNum = parseFloat(String(yValRaw).replace("%", "").trim());
        const yieldStr = (!isNaN(yNum) && yNum > 0) ? `${yNum.toFixed(1)}%` : (yValRaw ? String(yValRaw) : "N/A");
        
        return [
            String(i + 1),
            mo.mo_number || "-",
            dateStr,
            mo.part_no || "-",
            mo.base_part || "-",
            mo.rm_erp || "-",
            yieldStr,
            thkStr,
            sheetsVal,
            targetVal,
            mo.current_stage || "-",
            mo.status || "DRAFT",
            routeStr
        ];
    });

    doc.autoTable({
        head: [headers],
        body: tableRows,
        startY: 62,
        margin: { left: margin, right: margin, bottom: 12 },
        theme: "striped",
        headStyles: {
            fillColor: [15, 23, 42],
            textColor: [255, 255, 255],
            fontStyle: "bold",
            fontSize: 7.5,
            cellPadding: { top: 2.5, bottom: 2.5, left: 1.5, right: 1.5 },
            halign: "left"
        },
        styles: {
            fontSize: 7,
            cellPadding: { top: 2, bottom: 2, left: 1.5, right: 1.5 },
            overflow: "linebreak",
            textColor: [30, 41, 59]
        },
        alternateRowStyles: {
            fillColor: [248, 250, 252]
        },
        columnStyles: {
            0: { cellWidth: 8, halign: "center" },             // #
            1: { cellWidth: 26, fontStyle: "bold" },          // MO Number
            2: { cellWidth: 18, halign: "center" },           // Date
            3: { cellWidth: 46 },                             // Part Number
            4: { cellWidth: 30 },                             // Base Part
            5: { cellWidth: 40 },                             // RM ERP Code
            6: { cellWidth: 14, halign: "center" },           // Thk
            7: { cellWidth: 14, halign: "center" },           // Sheets
            8: { cellWidth: 16, halign: "center" },           // Target Qty
            9: { cellWidth: 18, halign: "center" },           // Stage
            10: { cellWidth: 26, halign: "center", fontStyle: "bold" }, // Status
            11: { cellWidth: 25, halign: "center" }           // Route
        },
        didParseCell: function(data) {
            // Apply colored status badges
            if (data.section === "body" && data.column.index === 10) {
                const status = String(data.cell.raw || "");
                if (status === "RELEASED") {
                    data.cell.styles.textColor = [22, 101, 52];     // Green
                    data.cell.styles.fillColor = [240, 253, 244];
                } else if (status.includes("REJECTED")) {
                    data.cell.styles.textColor = [185, 28, 28];     // Red
                    data.cell.styles.fillColor = [254, 242, 242];
                } else if (status.startsWith("PENDING")) {
                    data.cell.styles.textColor = [180, 83, 9];      // Amber
                    data.cell.styles.fillColor = [254, 243, 199];
                }
            }
        },
        didDrawPage: function(data) {
            // Footer on every page
            const totalPages = doc.internal.getNumberOfPages();
            doc.setDrawColor(226, 232, 240);
            doc.setLineWidth(0.3);
            doc.line(margin, pageHeight - 9, pageWidth - margin, pageHeight - 9);

            doc.setFont("helvetica", "normal");
            doc.setFontSize(6.5);
            doc.setTextColor(148, 163, 184);
            doc.text("SheetLayout AI — Automated Manufacturing Execution System | Confidential Production Planning Document", margin, pageHeight - 5);

            doc.setFont("helvetica", "bold");
            doc.text(`Page ${data.pageNumber} of ${totalPages}`, pageWidth - margin, pageHeight - 5, { align: "right" });
        }
    });

    // Save PDF
    doc.save(filename);
}

// Download Report (Excel/CSV Export alternate option)
function downloadMoReportCsv() {
    if (!filteredOrders || filteredOrders.length === 0) {
        alert("No Material Orders matching current filters to download.");
        return;
    }

    const headers = [
        "MO Number", "Date Created", "Part Number", "Base Part", "RM ERP Code",
        "Grade", "Thickness (mm)", "Length (mm)", "Width (mm)", "Sheets Required",
        "Target Quantity (Units)", "Layout Type", "Layout Name / Plan",
        "Current Stage", "Status", "Workflow Route", "Stock Constraint Satisfied",
        "Yield Constraint Satisfied", "Production Notes"
    ];

    const escapeCsv = (val) => {
        if (val === null || val === undefined) return '""';
        let str = String(val).replace(/"/g, '""');
        return `"${str}"`;
    };

    const rows = filteredOrders.map(mo => {
        const isStd = mo.is_standard_layout !== false ? "Standardized" : "Non-Standard";
        const dateStr = mo.created_at ? new Date(mo.created_at).toLocaleString("en-IN") : "-";
        const constraints = mo.constraints_status || {};

        return [
            escapeCsv(mo.mo_number),
            escapeCsv(dateStr),
            escapeCsv(mo.part_no),
            escapeCsv(mo.base_part),
            escapeCsv(mo.rm_erp),
            escapeCsv(mo.grade),
            escapeCsv(mo.thickness || ""),
            escapeCsv(mo.length || ""),
            escapeCsv(mo.width || ""),
            escapeCsv(mo.sheets_required || 1),
            escapeCsv(mo.target_qty || 1),
            escapeCsv(isStd),
            escapeCsv(mo.layout_name || ""),
            escapeCsv(mo.current_stage || ""),
            escapeCsv(mo.status || ""),
            escapeCsv(mo.workflow_path || ""),
            escapeCsv(constraints.stock_available ? "YES" : "NO"),
            escapeCsv(constraints.yield_satisfied ? "YES" : "NO"),
            escapeCsv(mo.notes || "")
        ].join(",");
    });

    const csvContent = "\uFEFF" + [headers.map(h => `"${h}"`).join(","), ...rows].join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    
    const todayStr = new Date().toISOString().split("T")[0];
    const filterTag = currentFilter !== "all" ? `_${currentFilter}` : "";
    link.setAttribute("href", url);
    link.setAttribute("download", `Material_Orders_Report${filterTag}_${todayStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}


// Modal: Create MO Logic
function openCreateModal() {
    if (currentRole !== "shearing") {
        alert("Access Restricted: Only the Shearing Production team can create or produce Material Orders. Other departments have review-only access.");
        return;
    }
    const modal = document.getElementById("createMoModal");
    const form = document.getElementById("createMoForm");
    if (form) form.reset();
    
    // Auto-generate sample MO number & enforce readonly
    const randomMoNum = `MO-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const moNumInput = document.getElementById("moNumber");
    if (moNumInput) {
        moNumInput.value = randomMoNum;
        moNumInput.readOnly = true;
    }

    // Reset auto-calculated target quantity
    const autoQtyVal = document.getElementById("autoTargetQtyDisplay");
    if (autoQtyVal) autoQtyVal.textContent = "- Units";
    const autoQtyHint = document.getElementById("autoQtyHint");
    if (autoQtyHint) autoQtyHint.textContent = "Select part & layout";
    const targetQtyInput = document.getElementById("targetQty");
    if (targetQtyInput) targetQtyInput.value = 1;
    const sheetsInput = document.getElementById("sheetsRequired");
    if (sheetsInput) sheetsInput.value = 1;

    // Reset planning & stock indicators (RM on-hand, MRP Target, Remaining Qty)
    renderDefaultSinglePartKpis(null, null, null, null, null, null, null);

    const layoutPartsBanner = document.getElementById("layoutPartsBanner");
    if (layoutPartsBanner) layoutPartsBanner.style.display = "none";

    selectedPartData = null;
    currentIntelData = null;
    const intelCard = document.getElementById("erpIntelligenceCard");
    if (intelCard) intelCard.style.display = "none";
    const historyWrap = document.getElementById("moHistoryTableWrap");
    if (historyWrap) historyWrap.style.display = "none";

    const customBox = document.getElementById("customRmBox");
    if (customBox) customBox.style.display = "none";
    const customSearchInput = document.getElementById("customRmSearchInput");
    if (customSearchInput) customSearchInput.value = "";
    const customDropdown = document.getElementById("customRmDropdown");
    if (customDropdown) customDropdown.style.display = "none";

    const yieldInput = document.getElementById("yieldPctInput");
    if (yieldInput) yieldInput.value = "";

    const rmSelect = document.getElementById("rmErpSelect");
    if (rmSelect) {
        rmSelect.innerHTML = `
            <option value="">-- Select RM ERP Code --</option>
            <option value="__custom__">⚙️ Custom RM / Layout Code...</option>
        `;
        rmSelect.value = "";
        rmSelect.style.border = "";
    }

    const basePartInput = document.getElementById("basePartInput");
    const basePartLabel = document.getElementById("basePartLabel");
    if (basePartInput) {
        basePartInput.value = "";
        basePartInput.readOnly = true;
        basePartInput.required = false;
        basePartInput.placeholder = "Auto-populated";
    }
    if (basePartLabel) {
        basePartLabel.innerHTML = 'Base Part:';
    }

    toggleLayoutType(true);
    updateAutomatedConstraints(null, null);
    recalculateWorkflowRoute();
    const ebBanner = document.getElementById("layoutEndbitsBanner");
    if (ebBanner) ebBanner.style.display = "none";
    const hiddenJson = document.getElementById("moEndbitsJson");
    if (hiddenJson) hiddenJson.value = "[]";
    hideRmAgentSuggestions();
    if (modal) modal.style.display = "flex";
}

function closeCreateModal() {
    const modal = document.getElementById("createMoModal");
    if (modal) modal.style.display = "none";
    const ebBanner = document.getElementById("layoutEndbitsBanner");
    if (ebBanner) ebBanner.style.display = "none";
    const hiddenJson = document.getElementById("moEndbitsJson");
    if (hiddenJson) hiddenJson.value = "[]";
    hideRmAgentSuggestions();
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
    rmSelect.style.border = "";

    // Placeholder option
    const placeholderOpt = document.createElement("option");
    placeholderOpt.value = "";
    placeholderOpt.textContent = "-- Select RM ERP Code --";
    rmSelect.appendChild(placeholderOpt);

    const records = partData.records || [];
    records.forEach((r, idx) => {
        const opt = document.createElement("option");
        opt.value = r.rm_erp || `RM-${idx}`;
        opt.textContent = `${r.rm_erp} (${r.grade || 'YS'}) - ${r.status || ''}`;
        opt.dataset.record = JSON.stringify(r);
        rmSelect.appendChild(opt);
    });

    // Add Custom choice at the bottom
    const customOpt = document.createElement("option");
    customOpt.value = "__custom__";
    customOpt.textContent = "⚙️ Custom RM / Layout Code...";
    rmSelect.appendChild(customOpt);

    if (records.length > 0) {
        rmSelect.selectedIndex = 1;
        onRmErpChanged(records[0].rm_erp);
    } else {
        rmSelect.selectedIndex = 0;
        onRmErpChanged("");
    }
}

function onRmErpChanged(rmCode) {
    const rmSelect = document.getElementById("rmErpSelect");
    if (rmSelect) rmSelect.style.border = "";
    const opt = rmSelect ? rmSelect.selectedOptions[0] : null;
    const customBox = document.getElementById("customRmBox");

    // If placeholder/empty selection
    if (!rmCode || rmCode === "") {
        if (customBox) customBox.style.display = "none";
        document.getElementById("gradeInput").value = "";
        document.getElementById("thicknessInput").value = "";
        document.getElementById("lengthInput").value = "";
        document.getElementById("widthInput").value = "";
        document.getElementById("sheetSizeInput").value = "";
        const yieldInput = document.getElementById("yieldPctInput");
        if (yieldInput) yieldInput.value = "";
        updateAutomatedConstraints(null, null);
        return;
    }

    // If Custom choice is picked from dropdown
    if (rmCode === "__custom__" || (opt && opt.value === "__custom__")) {
        // Unlock basePartInput so user can manually enter base part
        const basePartInput = document.getElementById("basePartInput");
        const basePartLabel = document.getElementById("basePartLabel");
        if (basePartInput) {
            basePartInput.readOnly = false;
            basePartInput.required = true;
            basePartInput.placeholder = "Enter Base Part (e.g. MBA01010)";
        }
        if (basePartLabel) {
            basePartLabel.innerHTML = 'Base Part <span class="required">* (Required)</span>:';
        }

        const yieldInput = document.getElementById("yieldPctInput");
        if (yieldInput) yieldInput.value = "N/A";

        if (customBox) {
            customBox.style.display = "block";
            const searchInput = document.getElementById("customRmSearchInput");
            if (searchInput) {
                searchInput.value = "";
                searchInput.focus();
                onCustomRmSearchInput("");
            }
        }
        // Force Non-Standard layout for custom selection (locked)
        const nonStdRadio = document.querySelector('input[name="is_standard_layout"][value="false"]');
        if (nonStdRadio) nonStdRadio.checked = true;
        updateLayoutTypeUI(false);
        return;
    }

    // Hide custom search box if standard part layout is chosen (unless current selection is an active custom layout)
    if (customBox && (!opt || opt.dataset.isCustom !== "true")) {
        customBox.style.display = "none";
    }

    // If switching back to standard layout, make basePartInput readonly again
    if (!opt || opt.dataset.isCustom !== "true") {
        const basePartInput = document.getElementById("basePartInput");
        const basePartLabel = document.getElementById("basePartLabel");
        if (basePartInput) {
            basePartInput.readOnly = true;
            basePartInput.required = false;
            basePartInput.placeholder = "Auto-populated";
        }
        if (basePartLabel) {
            basePartLabel.innerHTML = 'Base Part:';
        }
    }

    if (!opt || !opt.dataset.record) return;

    const record = JSON.parse(opt.dataset.record);
    document.getElementById("gradeInput").value = record.grade || "YS";
    document.getElementById("thicknessInput").value = record.thickness || "";
    document.getElementById("lengthInput").value = record.length || "";
    document.getElementById("widthInput").value = record.width || "";

    document.getElementById("sheetSizeInput").value = 
        record.sheet_size || `${record.thickness || '-'} * ${record.length || '-'} * ${record.width || '-'}`;

    const yieldInput = document.getElementById("yieldPctInput");
    if (yieldInput) {
        const yVal = record.per_sheet?.yield_pct ?? record.total_sheet?.yield_pct ?? record.yield_pct ?? record.material_yield_pct;
        if (yVal !== undefined && yVal !== null && String(yVal).trim() !== "") {
            const yNum = parseFloat(String(yVal).replace("%", "").trim());
            yieldInput.value = !isNaN(yNum) ? `${yNum.toFixed(1)}%` : `${yVal}`;
        } else {
            yieldInput.value = "N/A";
        }
    }

    // Auto-detect if standard or non-standard from record status or custom flag
    const isCustom = opt.dataset.isCustom === "true";
    let isStandard = false;
    if (!isCustom) {
        const statusLower = (record.status || "").toLowerCase();
        isStandard = !statusLower.includes("non") && !statusLower.includes("not use");
    }
    
    // Set radio buttons without allowing user to unlock (strictly auto-locked)
    const stdRadio = document.querySelector('input[name="is_standard_layout"][value="true"]');
    const nonStdRadio = document.querySelector('input[name="is_standard_layout"][value="false"]');
    if (isStandard && stdRadio) {
        stdRadio.checked = true;
        updateLayoutTypeUI(true);
    } else if (nonStdRadio) {
        nonStdRadio.checked = true;
        updateLayoutTypeUI(false);
    }

    // Auto-compute target quantity & populate layout parts
    recalculateTargetQtyFromLayout();

    updateAutomatedConstraints(currentIntelData?.stock_feasibility, record);

    // Live ERP & Stock Intelligence Call
    const partNo = document.getElementById("partNoInput")?.value?.trim() || record.part_no || record.part1?.part_no;
    const sheetsNeeded = parseFloat(document.getElementById("sheetsRequired")?.value) || 1;
    if (partNo) {
        const allParts = [];
        if (record.part1?.part_no) allParts.push(record.part1.part_no);
        else if (record.part_no) allParts.push(record.part_no);
        else allParts.push(partNo);

        [record.part2, record.part3, record.part4].forEach(child => {
            if (child?.part_no) {
                allParts.push(child.part_no);
            }
        });

        fetchAndDisplayIntelligence(
            allParts[0] || partNo,
            record.rm_erp || rmCode,
            record.grade,
            record.thickness,
            record.length,
            record.width,
            sheetsNeeded,
            false,
            allParts
        );
    }
}

// Custom RM Search and Selection Logic (from RM Main Store Stock: Category RAW MATERIAL SHEET)
let customSearchDebounceTimer = null;
window._currentCustomRmResults = [];

async function onCustomRmSearchInput(query) {
    clearTimeout(customSearchDebounceTimer);
    const dropdown = document.getElementById("customRmDropdown");
    if (!dropdown) return;

    const trimmed = (query || "").trim();

    customSearchDebounceTimer = setTimeout(async () => {
        try {
            dropdown.innerHTML = `<div style="padding:12px; color:#6b7280; font-size:12px; text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Searching RM Main Store Stock...</div>`;
            dropdown.style.display = "block";

            const res = await fetch(`/api/rm-stock/raw-material-sheets?q=${encodeURIComponent(trimmed)}`);
            if (!res.ok) throw new Error("Search failed");
            const records = await res.json();
            window._currentCustomRmResults = records || [];

            if (!records || records.length === 0) {
                dropdown.innerHTML = `<div style="padding:12px; color:#9ca3af; font-size:12px; text-align:center;">No matching Raw Material Sheets found in Main Store stock</div>`;
                return;
            }

            let html = "";
            records.forEach((rec, idx) => {
                const stockColor = rec.onhand_stock > 0 ? "#059669" : "#dc2626";
                html += `
                    <div class="custom-rm-item" onclick="onCustomRmItemClicked(${idx})">
                        <div class="custom-rm-item-title">
                            <span class="custom-rm-item-code">${escapeHtml(rec.item_code)}</span>
                            <span class="custom-rm-plan-badge" style="background:${stockColor}; color:#fff; font-weight:600;">
                                <i class="fa-solid fa-layer-group"></i> ${rec.onhand_stock} ${escapeHtml(rec.uom || 'NOS')}
                            </span>
                        </div>
                        <div class="custom-rm-item-sub">
                            Desc: <strong>${escapeHtml(rec.item_desc)}</strong> &bull; Grade: <strong>${escapeHtml(rec.grade)}</strong> &bull; Sheet Size: <strong>${escapeHtml(rec.sheet_size)}</strong>
                        </div>
                    </div>
                `;
            });
            dropdown.innerHTML = html;
            dropdown.style.display = "block";
        } catch (err) {
            console.error("Custom RM search error:", err);
            dropdown.innerHTML = `<div style="padding:12px; color:#ef4444; font-size:12px; text-align:center;">Failed to search RM Main Store stock</div>`;
        }
    }, 150);
}

function onCustomRmItemClicked(index) {
    const record = window._currentCustomRmResults ? window._currentCustomRmResults[index] : null;
    if (!record) return;
    selectCustomRmRecord(record);
}

function selectCustomRmRecord(record) {
    const dropdown = document.getElementById("customRmDropdown");
    if (dropdown) dropdown.style.display = "none";

    const searchInput = document.getElementById("customRmSearchInput");
    if (searchInput) searchInput.value = record.item_code;

    // 1. Grade auto fetched (first 2 letters: e.g. HR, CR, BS, YS, MS)
    const gradeVal = record.grade || record.item_code.substring(0, 2).toUpperCase();
    const gradeInput = document.getElementById("gradeInput");
    if (gradeInput) gradeInput.value = gradeVal;

    // 2. Sheet size auto fetched (T*L*W)
    const sheetSizeInput = document.getElementById("sheetSizeInput");
    if (sheetSizeInput) sheetSizeInput.value = record.sheet_size || "";

    const thicknessInput = document.getElementById("thicknessInput");
    if (thicknessInput) thicknessInput.value = record.thickness || "";

    const lengthInput = document.getElementById("lengthInput");
    if (lengthInput) lengthInput.value = record.length || "";

    const widthInput = document.getElementById("widthInput");
    if (widthInput) widthInput.value = record.width || "";

    const yieldInput = document.getElementById("yieldPctInput");
    if (yieldInput) yieldInput.value = "N/A";

    // 3. Base Part: user has to enter base part, so unlock and focus basePartInput
    const basePartInput = document.getElementById("basePartInput");
    const basePartLabel = document.getElementById("basePartLabel");
    if (basePartInput) {
        basePartInput.readOnly = false;
        basePartInput.required = true;
        basePartInput.placeholder = "Enter Base Part (e.g. MBA01010)";
        if (!basePartInput.value) {
            basePartInput.focus();
        }
    }
    if (basePartLabel) {
        basePartLabel.innerHTML = 'Base Part <span class="required">* (Required)</span>:';
    }

    // 4. Update RM ERP Select with custom record
    const rmSelect = document.getElementById("rmErpSelect");
    if (rmSelect) {
        Array.from(rmSelect.options).forEach(opt => {
            if (opt.dataset.isCustom === "true") {
                opt.remove();
            }
        });

        const customOpt = document.createElement("option");
        customOpt.value = record.item_code;
        customOpt.textContent = `⭐ [Custom RM] ${record.item_code} (${gradeVal}) - Stock: ${record.onhand_stock} ${record.uom || 'NOS'}`;
        customOpt.dataset.isCustom = "true";
        customOpt.dataset.record = JSON.stringify({
            ...record,
            rm_erp: record.item_code,
            grade: gradeVal,
            status: "Non-Standard"
        });

        const customPickerOpt = Array.from(rmSelect.options).find(o => o.value === "__custom__");
        if (customPickerOpt) {
            rmSelect.insertBefore(customOpt, customPickerOpt);
        } else {
            rmSelect.appendChild(customOpt);
        }
        customOpt.selected = true;
    }

    // Keep customRmBox visible to show the chosen custom layout
    const customBox = document.getElementById("customRmBox");
    if (customBox) customBox.style.display = "block";

    // 5. Automatically locked to Non-Standard Layout
    const nonStdRadio = document.querySelector('input[name="is_standard_layout"][value="false"]');
    if (nonStdRadio) nonStdRadio.checked = true;
    updateLayoutTypeUI(false);

    // 6. Target quantity & parts breakdown for custom RM
    const sheetsNeeded = Math.max(1, parseFloat(document.getElementById("sheetsRequired")?.value) || 1);
    const targetQtyInput = document.getElementById("targetQty");
    if (targetQtyInput) targetQtyInput.value = sheetsNeeded;
    const autoQtyDisplay = document.getElementById("autoTargetQtyDisplay");
    if (autoQtyDisplay) autoQtyDisplay.textContent = `${sheetsNeeded} Units`;
    const autoQtyHint = document.getElementById("autoQtyHint");
    if (autoQtyHint) autoQtyHint.textContent = `1 Part per Sheet (${sheetsNeeded} sheets)`;

    const partsBanner = document.getElementById("layoutPartsBanner");
    const partsList = document.getElementById("layoutPartsList");
    const thumbWrap = document.getElementById("layoutThumbWrap");
    if (thumbWrap) thumbWrap.style.display = "none";

    if (partsBanner && partsList) {
        partsBanner.style.display = "flex";
        const pNo = document.getElementById("partNoInput")?.value || "Custom Part";
        const bPart = basePartInput?.value || "Custom Base";
        partsList.innerHTML = `
            <div class="layout-part-chip primary">
                <span class="part-chip-name"><i class="fa-solid fa-shapes"></i> Custom Part: ${escapeHtml(pNo)} (Base: ${escapeHtml(bPart)})</span>
                <span class="part-chip-qty">${sheetsNeeded} Nos <small>(${sheetsNeeded} sheet × 1 blank)</small></span>
                <div class="part-chip-planning-row">
                    <span class="chip-plan-badge" style="background:#2563eb; color:#fff;"><i class="fa-solid fa-layer-group"></i> Sheet: ${escapeHtml(record.sheet_size || '')}</span>
                    <span class="chip-plan-badge chip-plan-mrp" title="Custom part has no pre-defined MRP"><i class="fa-solid fa-bullseye"></i> MRP: <strong>N/A</strong></span>
                    <span class="chip-plan-badge chip-plan-rem" title="Remaining: N/A"><i class="fa-solid fa-hourglass-half"></i> Remaining: <strong>N/A</strong></span>
                </div>
            </div>
        `;
    }

    // 7. Intelligence & Stock Feasibility
    const onhand = parseFloat(record.onhand_stock) || 0;
    currentIntelData = {
        rm_code: record.item_code,
        rm_opening_stock: {
            onhand_stock: onhand,
            uom: record.uom || "NOS",
            store: record.store || "MAIN STORES"
        },
        stock_feasibility: {
            sheets_needed: sheetsNeeded,
            sheets_onhand: onhand,
            is_sufficient: onhand >= sheetsNeeded,
            shortfall: Math.max(0, sheetsNeeded - onhand)
        },
        planning_summary: null
    };

    // Render KPI Cards: RM Stock on hand from RM Main Store stock
    renderDefaultSinglePartKpis(
        onhand,
        null, // No MRP Target (N/A)
        0,    // 0 produced
        null, // Remaining N/A
        record.item_code,
        null,
        currentIntelData.stock_feasibility
    );

    // Update automated constraints: Constraint 1 checks onhand vs sheetsNeeded, Constraint 2 fails (No MRP), routes to purchase!
    updateAutomatedConstraints(currentIntelData.stock_feasibility, {
        rm_erp: record.item_code,
        grade: gradeVal,
        thickness: record.thickness,
        length: record.length,
        width: record.width,
        status: "Non-Standard"
    });
}

function recalculateTargetQtyFromLayout() {
    const rmSelect = document.getElementById("rmErpSelect");
    const opt = rmSelect?.selectedOptions[0];
    if (!opt || !opt.dataset.record) return;

    const record = JSON.parse(opt.dataset.record);
    const sheetsNeeded = Math.max(1, parseFloat(document.getElementById("sheetsRequired")?.value) || 1);

    // Custom RM Layout handling
    if (opt.dataset.isCustom === "true") {
        const totalQty = sheetsNeeded;
        const targetQtyInput = document.getElementById("targetQty");
        if (targetQtyInput) targetQtyInput.value = totalQty;
        const autoQtyDisplay = document.getElementById("autoTargetQtyDisplay");
        if (autoQtyDisplay) autoQtyDisplay.textContent = `${totalQty.toLocaleString()} Units`;
        const autoQtyHint = document.getElementById("autoQtyHint");
        if (autoQtyHint) autoQtyHint.textContent = `Custom Raw Material Sheet (${sheetsNeeded} sheets)`;

        const banner = document.getElementById("layoutPartsBanner");
        const partsList = document.getElementById("layoutPartsList");
        const planBadge = document.getElementById("layoutPlanBadge");
        const thumbWrap = document.getElementById("layoutThumbWrap");
        if (thumbWrap) thumbWrap.style.display = "none";
        if (planBadge) planBadge.textContent = "Custom RM Sheet";

        if (banner && partsList) {
            banner.style.display = "flex";
            const pVal = document.getElementById("partNoInput")?.value || "Custom Part";
            const bVal = document.getElementById("basePartInput")?.value || "Custom Base";
            partsList.innerHTML = `
                <div class="layout-part-chip primary">
                    <span class="part-chip-name"><i class="fa-solid fa-shapes"></i> ${escapeHtml(pVal)} (Base: ${escapeHtml(bVal)})</span>
                    <span class="part-chip-qty">${totalQty.toLocaleString()} Nos <small>(${sheetsNeeded} sheet × 1 blank)</small></span>
                    <div class="part-chip-planning-row">
                        <span class="chip-plan-badge" style="background:#2563eb; color:#fff;"><i class="fa-solid fa-layer-group"></i> Sheet: ${escapeHtml(record.sheet_size || '')}</span>
                        <span class="chip-plan-badge chip-plan-mrp" title="No MRP Target"><i class="fa-solid fa-bullseye"></i> MRP: <strong>N/A</strong></span>
                        <span class="chip-plan-badge chip-plan-rem" title="Remaining: N/A"><i class="fa-solid fa-hourglass-half"></i> Remaining: <strong>N/A</strong></span>
                    </div>
                </div>
            `;
        }
        updateAutomatedConstraints(currentIntelData?.stock_feasibility, record);
        return;
    }

    // Helper to calculate quantities for a part:
    // Quantity = sheet qty * part qty * strip per part qty
    const getPartBreakdown = (partObj) => {
        if (!partObj) return { partQty: 1, stripQty: 1, blanksPerSheet: 1, totalQty: sheetsNeeded };
        const partQty = parseFloat(partObj.blank_qty) || 1;
        const stripQty = parseFloat(partObj.strip_qty) || 1;
        
        let blanksPerSheet = parseFloat(partObj.total_blank_qty_sheet);
        if (!blanksPerSheet || isNaN(blanksPerSheet) || blanksPerSheet <= 0) {
            blanksPerSheet = parseFloat(partObj.total_blank_qty);
        }
        if (!blanksPerSheet || isNaN(blanksPerSheet) || blanksPerSheet <= 0) {
            blanksPerSheet = partQty * stripQty;
        }
        
        const totalQty = Math.round(sheetsNeeded * partQty * stripQty);
        return {
            partQty,
            stripQty,
            blanksPerSheet,
            totalQty
        };
    };

    // Primary part quantities
    const p1Info = getPartBreakdown(record.part1 || {
        blank_qty: record.blank_qty,
        strip_qty: record.strip_qty,
        total_blank_qty_sheet: record.total_blank_qty_sheet
    });

    // Collect all valid parts in layout to calculate total sum across all parts
    const allLayoutParts = [
        { label: "Primary", ...p1Info, part_no: record.part1?.part_no || record.part_no }
    ];

    [record.part2, record.part3, record.part4].forEach((child, cIdx) => {
        if (child && child.part_no) {
            const cInfo = getPartBreakdown(child);
            allLayoutParts.push({
                label: `Part ${cIdx + 2}`,
                ...cInfo,
                part_no: child.part_no
            });
        }
    });

    // Sum of all strips per blank quantity for all the parts (sheet qty * part qty * strip qty)
    const computedTargetQty = allLayoutParts.reduce((sum, p) => sum + p.totalQty, 0);

    // Update targetQty hidden input & auto-display box
    const targetQtyInput = document.getElementById("targetQty");
    if (targetQtyInput) targetQtyInput.value = computedTargetQty;

    const autoQtyVal = document.getElementById("autoTargetQtyDisplay");
    if (autoQtyVal) {
        autoQtyVal.innerHTML = `${computedTargetQty.toLocaleString()} <small>Units</small>`;
    }
    const autoQtyHint = document.getElementById("autoQtyHint");
    if (autoQtyHint) {
        if (allLayoutParts.length > 1) {
            const formulaStr = allLayoutParts.map((p, idx) => `P${idx + 1}: ${p.totalQty.toLocaleString()}`).join(" + ");
            autoQtyHint.textContent = `Sum of ${allLayoutParts.length} parts: ${formulaStr} (${sheetsNeeded} sheet(s) × part qty × strip qty)`;
            autoQtyHint.title = allLayoutParts.map((p, idx) => `${p.label} (${p.part_no || ''}): ${sheetsNeeded} sheet(s) × ${p.partQty} part qty × ${p.stripQty} strip qty = ${p.totalQty.toLocaleString()} units`).join("\n") + `\nTotal across all parts: ${computedTargetQty.toLocaleString()} units`;
        } else {
            autoQtyHint.textContent = `${sheetsNeeded} sheet(s) × ${p1Info.partQty} part qty × ${p1Info.stripQty} strip per part qty`;
            autoQtyHint.title = `${sheetsNeeded} sheet(s) × ${p1Info.partQty} part qty × ${p1Info.stripQty} strip per part qty = ${computedTargetQty.toLocaleString()} units`;
        }
    }

    // Populate Layout Parts & Off-take Banner
    const banner = document.getElementById("layoutPartsBanner");
    const partsList = document.getElementById("layoutPartsList");
    const planBadge = document.getElementById("layoutPlanBadge");
    const thumbWrap = document.getElementById("layoutThumbWrap");
    const thumbImg = document.getElementById("layoutThumbImg");

    if (banner && partsList) {
        banner.style.display = "flex";
        if (planBadge) {
            const yVal = record.per_sheet?.yield_pct ?? record.total_sheet?.yield_pct ?? record.yield_pct ?? record.material_yield_pct;
            const yStr = (yVal !== undefined && yVal !== null && String(yVal).trim() !== "") ? ` • Yield: ${parseFloat(yVal) || yVal}%` : "";
            planBadge.textContent = (record.cutting_plan || record.layout_name || (record.status || "Layout Plan")) + yStr;
        }

        const getPartPlanBadges = (partStr, idx) => {
            if (!currentIntelData?.planning_summary?.parts) return "";
            const planParts = currentIntelData.planning_summary.parts;
            let pPlan = planParts[idx];
            if (!pPlan && partStr) {
                const cleanTarget = (partStr || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
                pPlan = planParts.find(p => {
                    const cleanP = (p.part_no || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
                    const cleanParent = (p.parent_part_no || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
                    return cleanTarget.includes(cleanP) || cleanP.includes(cleanTarget) || (cleanParent && cleanTarget.includes(cleanParent));
                });
            }
            if (!pPlan) return "";
            const mrpTxt = pPlan.mrp_monthly_target !== null && pPlan.mrp_monthly_target !== undefined ? `${Number(pPlan.mrp_monthly_target).toLocaleString()} Nos` : "N/A";
            const moCount = pPlan.monthly_mo_count || 0;
            const partsProd = Number(pPlan.parts_produced || 0).toLocaleString();
            const moTxt = `${moCount} MO${moCount === 1 ? '' : 's'} (${partsProd} Parts)`;
            const remTxt = pPlan.remaining_quantity !== null && pPlan.remaining_quantity !== undefined ? `${Number(pPlan.remaining_quantity).toLocaleString()} Nos` : "N/A";
            return `
                <div class="part-chip-planning-row">
                    <span class="chip-plan-badge chip-plan-mrp" title="MRP Monthly Target"><i class="fa-solid fa-calendar-days"></i> MRP: <strong>${mrpTxt}</strong></span>
                    <span class="chip-plan-badge chip-plan-mo" title="MOs &amp; Parts Produced this month"><i class="fa-solid fa-industry"></i> MO Produced: <strong>${moTxt}</strong></span>
                    <span class="chip-plan-badge chip-plan-rem" title="Remaining Quantity (MRP - MO)"><i class="fa-solid fa-hourglass-half"></i> Remaining: <strong>${remTxt}</strong></span>
                </div>
            `;
        };

        let partsHtml = `
            <div class="layout-part-chip primary">
                <span class="part-chip-name"><i class="fa-solid fa-star"></i> Primary: ${escapeHtml(record.part_no || record.base_part)}</span>
                <span class="part-chip-qty">${p1Info.totalQty.toLocaleString()} Nos <small>(${sheetsNeeded} sheet × ${p1Info.partQty} part qty × ${p1Info.stripQty} strip per part qty)</small></span>
                ${getPartPlanBadges(record.part_no || record.base_part, 0)}
            </div>
        `;

        // Child parts 2, 3, 4 if present
        [record.part2, record.part3, record.part4].forEach((child, cIdx) => {
            if (child && child.part_no) {
                const cInfo = getPartBreakdown(child);
                partsHtml += `
                    <div class="layout-part-chip">
                        <span class="part-chip-name">Part ${cIdx + 2}: ${escapeHtml(child.part_no)}</span>
                        <span class="part-chip-qty">${cInfo.totalQty.toLocaleString()} Nos <small>(${sheetsNeeded} sheet × ${cInfo.partQty} part qty × ${cInfo.stripQty} strip per part qty)</small></span>
                        ${getPartPlanBadges(child.part_no, cIdx + 1)}
                    </div>
                `;
            }
        });

        partsList.innerHTML = partsHtml;

        // Thumbnail preview if image exists
        if (thumbWrap && thumbImg) {
            if (record.image_url) {
                thumbImg.src = record.image_url;
                thumbWrap.style.display = "flex";
            } else {
                thumbWrap.style.display = "none";
            }
        }
    }

    // Render End Bits (Offcuts) Preview for this layout & sheets
    renderLayoutEndbits(record, sheetsNeeded);

    updateAutomatedConstraints(currentIntelData?.stock_feasibility, record);
}

function updateLayoutTypeUI(isStandard) {
    const stdCard = document.getElementById("radioCardStd");
    const nonStdCard = document.getElementById("radioCardNonStd");
    const uploadBox = document.getElementById("docUploadBox");

    const stdRadio = document.querySelector('input[name="is_standard_layout"][value="true"]');
    const nonStdRadio = document.querySelector('input[name="is_standard_layout"][value="false"]');
    if (isStandard && stdRadio) stdRadio.checked = true;
    else if (!isStandard && nonStdRadio) nonStdRadio.checked = true;

    if (stdCard) stdCard.classList.toggle("active", isStandard);
    if (nonStdCard) nonStdCard.classList.toggle("active", !isStandard);
    if (uploadBox) uploadBox.style.display = isStandard ? "none" : "block";

    updateAutomatedConstraints(currentIntelData?.stock_feasibility, getSelectedLayoutRecord());
}

// Dismiss custom dropdown and part dropdown on click outside
document.addEventListener("click", function (e) {
    const customBox = document.getElementById("customRmBox");
    const customDropdown = document.getElementById("customRmDropdown");
    if (customDropdown && customBox && !customBox.contains(e.target)) {
        customDropdown.style.display = "none";
    }

    const partBox = document.querySelector(".part-search-input-wrap");
    const partDropdown = document.getElementById("partDropdownResults");
    if (partDropdown && partBox && !partBox.contains(e.target)) {
        partDropdown.style.display = "none";
    }

    const ebPartDropdown = document.getElementById("ebPartDropdown");
    const ebPartInput = document.getElementById("ebPartNoInput");
    if (ebPartDropdown && !ebPartDropdown.contains(e.target) && e.target !== ebPartInput) {
        ebPartDropdown.style.display = "none";
    }

    const prodDropdown = document.getElementById("producePartDropdown");
    const prodInput = document.getElementById("producePartNoInput");
    if (prodDropdown && !prodDropdown.contains(e.target) && e.target !== prodInput) {
        prodDropdown.style.display = "none";
    }
});

function toggleLayoutType(isStandard) {
    updateLayoutTypeUI(isStandard);

    // If part records exist, switch dropdown to the layout that matches the selected standardization type
    if (selectedPartData && selectedPartData.records) {
        const rmSelect = document.getElementById("rmErpSelect");
        if (rmSelect && rmSelect.options.length > 0) {
            const records = selectedPartData.records;
            let matchingIdx = records.findIndex(r => {
                const st = (r.status || "").toLowerCase();
                const rIsStd = !st.includes("non") && !st.includes("not use");
                return isStandard ? rIsStd : !rIsStd;
            });
            if (matchingIdx >= 0 && rmSelect.options[matchingIdx]) {
                rmSelect.selectedIndex = matchingIdx;
                onRmErpChanged(records[matchingIdx].rm_erp);
            }
        }
    }
}

function getSelectedLayoutRecord() {
    const rmSelect = document.getElementById("rmErpSelect");
    const opt = rmSelect?.selectedOptions[0];
    if (opt && opt.dataset.record) {
        try {
            return JSON.parse(opt.dataset.record);
        } catch (e) {
            return null;
        }
    }
    return null;
}

function updateAutomatedConstraints(feasibility = null, layoutRecord = null) {
    if (!layoutRecord) {
        layoutRecord = getSelectedLayoutRecord();
    }
    
    const stockHidden = document.getElementById("constraintStock");
    const mrpHidden = document.getElementById("constraintMrp");
    const remHidden = document.getElementById("constraintRemaining");
    const yieldHidden = document.getElementById("constraintYield");
    const statusHidden = document.getElementById("constraintsStatus");
    const sheetsNeeded = Math.max(1, parseFloat(document.getElementById("sheetsRequired")?.value) || 1);
    
    // 1. Constraint 1: RM Availability Check (stock on hand >= sheets needed)
    let isStockSufficient = true;
    let onhandSheets = null;

    if (feasibility && typeof feasibility.is_sufficient !== "undefined") {
        isStockSufficient = !!feasibility.is_sufficient;
        onhandSheets = feasibility.sheets_onhand;
    } else if (currentIntelData && currentIntelData.rm_opening_stock) {
        onhandSheets = currentIntelData.rm_opening_stock.onhand_stock || 0;
        isStockSufficient = onhandSheets >= sheetsNeeded;
    } else if (currentIntelData && currentIntelData.stock_feasibility) {
        isStockSufficient = !!currentIntelData.stock_feasibility.is_sufficient;
        onhandSheets = currentIntelData.stock_feasibility.sheets_onhand;
    }

    if (stockHidden) {
        stockHidden.value = isStockSufficient ? "true" : "false";
    }

    // 2. Constraint 2: MRP Target Availability Check (mrp > 0; if 0, N/A, null, or missing for ANY part, constraint fails!)
    let isMrpAvailable = true;
    let mrpFailureReason = null;
    const plan = currentIntelData?.planning_summary;
    const planParts = plan?.parts;

    // Collect all parts in the layout to ensure every part has a valid > 0 MRP target
    const layoutPartsList = [];
    if (layoutRecord) {
        if (layoutRecord.part1) layoutPartsList.push(layoutRecord.part1);
        else if (layoutRecord.part_no) layoutPartsList.push(layoutRecord);
        [layoutRecord.part2, layoutRecord.part3, layoutRecord.part4].forEach(child => {
            if (child && child.part_no) layoutPartsList.push(child);
        });
    }

    if (!currentIntelData || !plan) {
        // Intelligence not available yet or missing planning summary -> constraint fails
        isMrpAvailable = false;
        mrpFailureReason = "No MRP Target (N/A)";
    } else if (planParts && planParts.length > 0) {
        // Multi-part layout or multiple parts in plan: check EACH part
        for (const p of planParts) {
            const target = p.mrp_monthly_target;
            if (target === null || target === undefined || target === "N/A" || isNaN(parseFloat(target)) || parseFloat(target) <= 0) {
                isMrpAvailable = false;
                const pName = p.child_part_no || p.part_no || "Part";
                mrpFailureReason = `No MRP Target for ${pName} (N/A)`;
                break;
            }
        }
        // Also verify if any part in layoutPartsList is missing from planParts or lacks a valid target
        if (isMrpAvailable && layoutPartsList.length > 0) {
            for (const lp of layoutPartsList) {
                const lpNo = lp.part_no || lp.child_part_no;
                if (!lpNo) continue;
                const matched = planParts.find(p => (p.part_no === lpNo || p.child_part_no === lpNo));
                if (!matched || matched.mrp_monthly_target === null || matched.mrp_monthly_target === undefined || matched.mrp_monthly_target === "N/A" || parseFloat(matched.mrp_monthly_target) <= 0) {
                    isMrpAvailable = false;
                    mrpFailureReason = `No MRP Target for ${lpNo} (N/A)`;
                    break;
                }
            }
        }
    } else {
        const target = plan.mrp_monthly_target;
        if (target === null || target === undefined || target === "N/A" || isNaN(parseFloat(target)) || parseFloat(target) <= 0) {
            isMrpAvailable = false;
            mrpFailureReason = "No MRP Target (N/A)";
        }
    }

    if (mrpHidden) {
        mrpHidden.value = isMrpAvailable ? "true" : "false";
    }

    // 3. Constraint 3: Remaining Parts vs Current Plan Check
    // If remaining parts is less than current plan, routes to purchase
    let isRemainingSufficient = true;

    if (currentIntelData) {
        if (planParts && planParts.length > 0 && layoutPartsList.length > 0) {
            planParts.forEach((p, idx) => {
                const layoutItem = layoutPartsList[idx];
                let partBlankQty = 1;
                let partStripQty = 1;
                if (layoutItem) {
                    partBlankQty = parseFloat(layoutItem.blank_qty) || 1;
                    partStripQty = parseFloat(layoutItem.strip_qty) || 1;
                }
                const partCurrentPlan = Math.round(sheetsNeeded * partBlankQty * partStripQty);
                const remQty = (p.remaining_quantity !== null && p.remaining_quantity !== undefined)
                    ? parseFloat(p.remaining_quantity)
                    : null;
                if (remQty !== null) {
                    if (remQty < partCurrentPlan) {
                        isRemainingSufficient = false;
                    }
                }
            });
        } else if (plan && plan.remaining_quantity !== null && plan.remaining_quantity !== undefined) {
            const currentPlanTotal = parseFloat(document.getElementById("targetQty")?.value) || sheetsNeeded;
            if (parseFloat(plan.remaining_quantity) < currentPlanTotal) {
                isRemainingSufficient = false;
            }
        }
    }

    if (remHidden) {
        remHidden.value = isRemainingSufficient ? "true" : "false";
    }

    // Standard layout check
    const isStd = document.querySelector('input[name="is_standard_layout"]:checked')?.value === "true";
    if (yieldHidden) {
        yieldHidden.value = isStd ? "true" : "false";
    }

    // 4. Collect Failed Constraints
    const failedConstraints = [];
    if (!isStockSufficient) {
        failedConstraints.push("RM Stock Shortfall");
        triggerRmAgentSuggestions({
            part_no: document.getElementById("partNoInput")?.value,
            rm_erp: document.getElementById("moRmErpInput")?.value || document.getElementById("rmErpSelect")?.value,
            target_qty: parseInt(document.getElementById("targetQty")?.value) || 1,
            sheets_needed: sheetsNeeded,
            thickness: parseFloat(document.getElementById("thicknessInput")?.value) || 0,
            grade: document.getElementById("gradeInput")?.value || "YS",
            onhand_stock: (onhandSheets !== null && onhandSheets !== undefined) ? onhandSheets : 0
        });
    } else {
        hideRmAgentSuggestions();
    }
    if (!isMrpAvailable) {
        failedConstraints.push(mrpFailureReason || "No MRP Target (N/A)");
    }
    if (!isRemainingSufficient) {
        failedConstraints.push("Plan Exceeds Remaining Demand");
    }

    const allSatisfied = failedConstraints.length === 0;

    if (statusHidden) {
        statusHidden.value = JSON.stringify({
            stock_available: isStockSufficient,
            mrp_available: isMrpAvailable,
            remaining_quota_satisfied: isRemainingSufficient,
            yield_satisfied: isStd,
            all_satisfied: allSatisfied,
            failed_constraints: failedConstraints
        });
    }

    // 5. Render Ultra-Compact Heading Status
    const headingStatusEl = document.getElementById("constraintHeadingStatus");
    if (headingStatusEl) {
        if (allSatisfied) {
            headingStatusEl.innerHTML = `
                <span class="constraint-status-badge pass" id="constraintStatusBadge" title="RM Stock, MRP Target, and Remaining Quota satisfied">
                    <i class="fa-solid fa-square-check"></i> All Constraints Satisfied
                </span>
            `;
        } else {
            const count = failedConstraints.length;
            const names = failedConstraints.join(", ");
            headingStatusEl.innerHTML = `
                <span class="constraint-status-badge fail" id="constraintStatusBadge" title="${names}">
                    <i class="fa-solid fa-triangle-exclamation"></i> ${count} Constraint${count > 1 ? 's' : ''} Failed (${names})
                </span>
            `;
        }
    }

    recalculateWorkflowRoute(failedConstraints);
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

function recalculateWorkflowRoute(failedConstraintsList = null) {
    const isStd = document.querySelector('input[name="is_standard_layout"]:checked')?.value === "true";
    const stockEl = document.getElementById("constraintStock");
    const mrpEl = document.getElementById("constraintMrp");
    const remEl = document.getElementById("constraintRemaining");

    const stockOk = stockEl ? stockEl.value !== "false" : true;
    const mrpOk = mrpEl ? mrpEl.value !== "false" : true;
    const remOk = remEl ? remEl.value !== "false" : true;
    const constraintsMet = stockOk && mrpOk && remOk;

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
        const failNames = (failedConstraintsList && failedConstraintsList.length > 0)
            ? failedConstraintsList.join(", ")
            : [!stockOk && "RM Stock Shortfall", !mrpOk && "No MRP Target (N/A)", !remOk && "Plan Exceeds Remaining Demand"].filter(Boolean).join(", ");
        desc.textContent = `Constraint check failed (${failNames || "Purchase Clearance Required"}). Routed directly to Purchase team for clearance before ERP release.`;
    } else {
        banner.className = "workflow-route-preview";
        title.innerHTML = `<i class="fa-solid fa-bolt"></i> Route: Fast-Track Directly to ERP Release`;
        desc.textContent = "All 3 constraints (RM Stock, MRP Target, Remaining Demand) satisfied. Order skips Krysalis & Purchase and routes directly to ERP release!";
    }
}

/* =========================================================================
   AI RM SUBSTITUTION & SHORTAGE ADVISOR CLIENT LOGIC
   ========================================================================= */
let activeRmAgentRecommendations = [];
let rmAgentFetchDebounce = null;

function hideRmAgentSuggestions() {
    const box = document.getElementById("rmAgentSuggestionBox");
    if (box) box.style.display = "none";
    activeRmAgentRecommendations = [];
}

function triggerRmAgentSuggestions(params) {
    if (!params.part_no) {
        hideRmAgentSuggestions();
        return;
    }

    if (rmAgentFetchDebounce) clearTimeout(rmAgentFetchDebounce);
    rmAgentFetchDebounce = setTimeout(async () => {
        const box = document.getElementById("rmAgentSuggestionBox");
        const list = document.getElementById("rmAgentCardsList");
        const verdict = document.getElementById("rmAgentVerdictText");
        const badge = document.getElementById("rmAgentCountBadge");
        if (!box || !list) return;

        box.style.display = "block";
        if (verdict) verdict.textContent = "AI Agent scanning store sheets and verified CAD layouts...";
        if (badge) badge.textContent = "Analyzing...";
        list.innerHTML = `
            <div style="text-align: center; padding: 14px; color: #0284c7; font-size: 0.82rem;">
                <i class="fa-solid fa-circle-notch fa-spin"></i> Checking store stock and simulating substitution yields...
            </div>
        `;

        try {
            const qParams = new URLSearchParams();
            if (params.part_no) qParams.set("part_no", params.part_no);
            if (params.rm_erp) qParams.set("rm_erp", params.rm_erp);
            if (params.target_qty) qParams.set("target_qty", params.target_qty);
            if (params.sheets_needed) qParams.set("sheets_needed", params.sheets_needed);
            if (params.thickness) qParams.set("thickness", params.thickness);
            if (params.grade) qParams.set("grade", params.grade);
            if (params.onhand_stock !== undefined) qParams.set("onhand_stock", params.onhand_stock);

            const res = await fetch(`/api/agent/suggest-rm-alternatives?${qParams.toString()}`);
            if (!res.ok) {
                hideRmAgentSuggestions();
                return;
            }

            const data = await res.json();
            if (!data.has_shortage) {
                hideRmAgentSuggestions();
                return;
            }

            // Strictly filter out any alternative with 0 sheets / 0 available stock
            if (data.recommendations && Array.isArray(data.recommendations)) {
                data.recommendations = data.recommendations.filter(r => {
                    const st = parseFloat(r.onhand_stock !== undefined ? r.onhand_stock : r.available_qty) || 0;
                    return st > 0;
                });
            }

            if (!data.recommendations || data.recommendations.length === 0) {
                activeRmAgentRecommendations = [];
                if (verdict) verdict.textContent = data.agent_verdict || "Critical Shortage: No alternative in-stock RM sheets or offcuts found in store.";
                if (badge) badge.textContent = "0 Options";
                list.innerHTML = `
                    <div class="rm-agent-card partial" style="justify-content: center; text-align: center; padding: 14px;">
                        <div style="font-size: 0.82rem; color: #b45309;">
                            <i class="fa-solid fa-triangle-exclamation"></i> No compatible in-stock RM sheets or offcuts found in the store. 
                            <strong>Order must be routed to Purchase Clearance.</strong>
                        </div>
                    </div>
                `;
                return;
            }

            activeRmAgentRecommendations = data.recommendations;
            if (verdict) verdict.textContent = data.agent_verdict;
            const engineLabel = data.powered_by ? `<span style="background: rgba(255,255,255,0.25); padding: 2px 7px; border-radius: 10px; margin-left: 6px;"><i class="fa-solid fa-diagram-project"></i> ${escapeHtml(data.powered_by)}</span>` : '';
            if (badge) badge.innerHTML = `${data.recommendations.length} Option${data.recommendations.length > 1 ? 's' : ''}${engineLabel}`;

            list.innerHTML = data.recommendations.map((rec, idx) => {
                const isSuff = rec.stock_sufficient;
                const typeClass = rec.type === 'engineered_layout' ? 'layout' : (rec.type === 'endbit_salvage' ? 'endbit' : 'sheet');
                const isEndbit = rec.type === 'endbit_salvage';

                return `
                    <div class="rm-agent-card ${isSuff ? 'sufficient' : 'partial'}">
                        <div class="rm-agent-card-info">
                            <div class="rm-agent-card-tags">
                                <span class="rm-agent-pill-type ${typeClass}">
                                    ${escapeHtml(rec.tier_label)}
                                </span>
                                ${isSuff 
                                    ? `<span style="background: #dcfce7; color: #15803d; font-size: 0.7rem; font-weight: 700; padding: 2px 6px; border-radius: 4px;"><i class="fa-solid fa-check"></i> Stock Ready</span>` 
                                    : `<span style="background: #fef9c3; color: #854d0e; font-size: 0.7rem; font-weight: 700; padding: 2px 6px; border-radius: 4px;"><i class="fa-solid fa-triangle-exclamation"></i> Partial Stock</span>`}
                                ${rec.yield_pct ? `<span style="background: #e0f2fe; color: #0369a1; font-size: 0.7rem; font-weight: 700; padding: 2px 6px; border-radius: 4px;"><i class="fa-solid fa-chart-pie"></i> ${rec.yield_pct}% Yield</span>` : ''}
                            </div>
                            <div class="rm-agent-card-title">
                                ${escapeHtml(rec.rm_erp)} ${rec.layout_name ? `• <span style="font-weight: 600; color: #64748b; font-size: 0.8rem;">Layout: ${escapeHtml(rec.layout_name)}</span>` : ''}
                            </div>
                            <div class="rm-agent-card-desc">
                                ${escapeHtml(rec.reason)}
                            </div>
                            <div class="rm-agent-metrics">
                                <span><i class="fa-solid fa-warehouse"></i> Store Stock: <strong>${rec.onhand_stock} ${isEndbit ? 'Nos' : 'sheets'}</strong></span>
                                ${rec.sheets_needed ? `<span><i class="fa-solid fa-layer-group"></i> Needed: <strong>${rec.sheets_needed} sheets</strong></span>` : ''}
                                ${rec.parts_per_sheet ? `<span><i class="fa-solid fa-cubes"></i> Blanks/sheet: <strong>${rec.parts_per_sheet}</strong></span>` : ''}
                            </div>
                        </div>
                        <div>
                            <button type="button" class="btn-apply-rm-agent ${isEndbit ? 'endbit' : ''}" onclick="applyRmAgentRecommendation(${idx})">
                                ${isEndbit ? `<i class="fa-solid fa-scissors"></i> Shear Offcut` : `<i class="fa-solid fa-arrows-rotate"></i> Switch RM`}
                            </button>
                        </div>
                    </div>
                `;
            }).join("");

            if (box && data.recommendations && data.recommendations.length > 0) {
                setTimeout(() => {
                    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }, 100);
            }

        } catch (err) {
            console.error("AI RM Advisor fetch failed:", err);
            hideRmAgentSuggestions();
        }
    }, 250);
}

function applyRmAgentRecommendation(idx) {
    const rec = activeRmAgentRecommendations[idx];
    if (!rec) return;

    if (rec.type === 'endbit_salvage') {
        const payload = rec.action_payload || {};
        const ebMsg = "AI Agent Recommendation:\n\nSwitch to shearing this part from store offcut [" + (rec.endbit_name || 'End Bit') + "] " + (rec.endbit_id || '') + "?\n\nThis will take you to the End Bit MO portal with this offcut pre-selected.";
        if (confirm(ebMsg)) {
            closeCreateModal();
            showCreateEndbitMoView(payload.endbit_id);
        }
        return;
    }

    const rmSelect = document.getElementById("rmErpSelect");
    if (!rmSelect) return;

    let targetOpt = Array.from(rmSelect.options).find(o => o.value === rec.rm_erp || (o.value && o.value.toLowerCase() === rec.rm_erp.toLowerCase()));

    if (!targetOpt) {
        targetOpt = document.createElement("option");
        targetOpt.value = rec.rm_erp;
        targetOpt.textContent = `${rec.rm_erp} (${rec.grade || 'YS'}) - ${rec.status || 'AI Substitute'}`;
        targetOpt.dataset.record = JSON.stringify({
            rm_erp: rec.rm_erp,
            layout_name: rec.layout_name,
            grade: rec.grade,
            thickness: rec.thickness,
            length: rec.length,
            width: rec.width,
            status: rec.status,
            per_sheet: {
                yield_pct: rec.yield_pct,
                parts_produced: rec.parts_per_sheet
            },
            part1: {
                total_blank_qty_sheet: rec.parts_per_sheet
            }
        });
        // Insert right before custom option
        rmSelect.insertBefore(targetOpt, rmSelect.lastElementChild);
    }

    rmSelect.value = targetOpt.value;
    onRmErpChanged(targetOpt.value);

    // Toast confirmation
    alert(`🎉 AI RM Substitution Applied!\n\n` +
          `• Switched to RM: ${rec.rm_erp}\n` +
          `• Layout: ${rec.layout_name || 'Standard'}\n` +
          `• Store Stock: ${rec.onhand_stock} sheets available\n` +
          `• Yield: ${rec.yield_pct}%\n\n` +
          `The layout and constraints have been automatically updated!`);
}

async function submitCreateMo(e) {
    e.preventDefault();
    const form = document.getElementById("createMoForm");
    const formData = new FormData(form);

    const rmErp = formData.get("rm_erp");
    if (!rmErp || rmErp.trim() === "" || rmErp === "__custom__") {
        alert("RM ERP Code is mandatory. Please select a valid RM ERP Code / Layout before submitting.");
        const rmSelect = document.getElementById("rmErpSelect");
        if (rmSelect) {
            rmSelect.focus();
            rmSelect.style.border = "2px solid #ef4444";
        }
        return;
    }

    const isStd = formData.get("is_standard_layout") === "true";
    const file = formData.get("layout_doc");

    if (!isStd && (!file || !file.name)) {
        alert("Please upload a layout document. It is mandatory for Non-Standard layouts before Krysalis review.");
        return;
    }

    // Explicitly compute and serialize constraint verification values
    const stockEl = document.getElementById("constraintStock");
    const mrpEl = document.getElementById("constraintMrp");
    const remEl = document.getElementById("constraintRemaining");
    const stockChecked = stockEl ? stockEl.value !== "false" : true;
    const mrpChecked = mrpEl ? mrpEl.value !== "false" : true;
    const remChecked = remEl ? remEl.value !== "false" : true;
    const allSatisfied = stockChecked && mrpChecked && remChecked;

    formData.set("constraint_stock", stockChecked ? "true" : "false");
    formData.set("constraint_mrp", mrpChecked ? "true" : "false");
    formData.set("constraint_remaining", remChecked ? "true" : "false");
    formData.set("constraint_yield", isStd ? "true" : "false");
    formData.set("constraints_status", JSON.stringify({
        stock_available: stockChecked,
        mrp_available: mrpChecked,
        remaining_quota_satisfied: remChecked,
        yield_satisfied: isStd,
        all_satisfied: allSatisfied
    }));

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

    // Render Rejection Alert Banner if MO is rejected
    const alertContainer = document.getElementById("rejectionAlertContainer");
    if (alertContainer) {
        if (mo.status === "REJECTED") {
            const rejectEntry = (mo.audit_trail || []).slice().reverse().find(t => t.action === "REJECTED");
            const rejector = rejectEntry ? (rejectEntry.actor_name || rejectEntry.actor_role) : "Approving Department";
            const rejectTime = rejectEntry ? formatDate(rejectEntry.timestamp) : "";
            const rejectRemarks = rejectEntry?.remarks || "Order was rejected. Please review specifications or re-submit.";

            alertContainer.innerHTML = `
                <div class="rejection-alert-card">
                    <div class="rejection-alert-header">
                        <div class="rejection-alert-title">
                            <i class="fa-solid fa-triangle-exclamation"></i>
                            <span>Order Rejected by ${escapeHtml(rejector)}</span>
                        </div>
                        ${rejectTime ? `<span class="rejection-alert-time"><i class="fa-regular fa-clock"></i> ${rejectTime}</span>` : ""}
                    </div>
                    <div class="rejection-alert-body">
                        <strong>Reason for Rejection:</strong> "${escapeHtml(rejectRemarks)}"
                    </div>
                    <div class="rejection-alert-actions" style="margin-top: 10px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
                        <span class="rejection-alert-guidance">
                            <i class="fa-solid fa-circle-info"></i> Shearing Team: Correct specifications or parameters and resubmit to resume approval pipeline.
                        </span>
                        ${currentRole === "shearing" ? `
                            <button type="button" class="btn btn-warning btn-sm" onclick="openEditResubmitModal('${escapeHtml(mo.mo_number)}')" style="background: #f59e0b; border-color: #d97706; color: #fff; font-weight: 700; box-shadow: 0 2px 6px rgba(245, 158, 11, 0.25);">
                                <i class="fa-solid fa-pen-to-square"></i> Edit &amp; Resubmit MO
                            </button>
                        ` : ''}
                    </div>
                </div>
            `;
        } else {
            alertContainer.innerHTML = "";
        }
    }

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
            <span class="review-label"><i class="fa-solid fa-chart-pie"></i> Layout Yield %</span>
            <span class="review-val">${formatYieldBadge(mo)}</span>
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

    // Render End Bits Section in Review Modal
    renderReviewEndbits(mo);

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
    const btnExecute = document.getElementById("btnExecuteDirect");
    const btnApprove = document.getElementById("btnApproveAdvance");

    if (canAction) {
        actionPanel.style.display = "flex";
        document.getElementById("actionPanelTitle").innerHTML = `<i class="fa-solid fa-stamp"></i> Action Required: ${ROLE_CONFIGS[currentRole].name}`;
        document.getElementById("actionPanelRole").textContent = mo.current_stage;
        document.getElementById("approvalRemarks").value = "";

        if (mo.current_stage === "ERP") {
            if (btnExecute) btnExecute.style.display = "inline-flex";
            if (btnApprove) btnApprove.innerHTML = `<i class="fa-solid fa-check-double"></i> Approve &amp; Release to ERP`;
        } else {
            if (btnExecute) btnExecute.style.display = "none";
            if (btnApprove) btnApprove.innerHTML = `<i class="fa-solid fa-check"></i> Approve &amp; Advance`;
        }
    } else if (currentRole === "erp" && mo.status === "PENDING_ERP") {
        actionPanel.style.display = "flex";
        document.getElementById("actionPanelTitle").innerHTML = `<i class="fa-solid fa-network-wired"></i> Live ERP Final Approval &amp; Release`;
        document.getElementById("actionPanelRole").textContent = "ERP Execution";
        if (btnExecute) btnExecute.style.display = "inline-flex";
        if (btnApprove) btnApprove.style.display = "inline-flex";
        if (btnApprove) btnApprove.innerHTML = `<i class="fa-solid fa-check-double"></i> Approve &amp; Release to ERP`;
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
            await loadDbTablesOverview();
            if (currentDbTable) {
                await loadDbTableData();
            }
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

async function fetchAndDisplayIntelligence(partNo, rmCode, grade, thickness, length, width, sheetsNeeded, isReview = false, allLayoutParts = []) {
    if (!partNo) return;
    const cardId = isReview ? "reviewErpIntelCard" : "erpIntelligenceCard";
    const card = document.getElementById(cardId);
    if (isReview && card) {
        card.style.display = "block";
    } else if (card) {
        card.style.display = "none";
    }

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
        if (allLayoutParts && allLayoutParts.length > 0) {
            allLayoutParts.forEach(p => {
                if (p) params.append("parts", p);
            });
        }
        const res = await fetch(`/api/intelligence/part/${encodeURIComponent(partNo)}?${params.toString()}`);
        if (!res.ok) return;
        const intel = await res.json();
        if (!isReview) {
            currentIntelData = intel;
            recalculateTargetQtyFromLayout();
        }

        renderIntelligenceCard(intel, isReview);
    } catch (err) {
        console.error("Failed to load ERP & Stock intelligence:", err);
    }
}

function renderDefaultSinglePartKpis(rmOnHand, rm, mrpTarget, mrp, partsProduced, remainingQty, plan) {
    const container = document.getElementById("moKpiContainer");
    if (!container) return;

    const rmValStr = (rmOnHand !== null && rmOnHand !== undefined)
        ? `${rmOnHand} Sheets`
        : (rm?.onhand_stock !== undefined ? `${rm.onhand_stock} Sheets` : "- Sheets");
    const rmSubStr = rm?.item_code ? `${rm.item_code} (Main Store)` : "Select RM & part";

    const mrpValStr = (mrpTarget !== null && mrpTarget !== undefined)
        ? `${Number(mrpTarget).toLocaleString()} Nos`
        : "- Nos";
    const childPart = plan?.child_part_no || mrp?.child_part_no || "";
    const mrpSubStr = childPart ? `${childPart} (Balance)` : "Balance demand";

    const moCount = (plan && plan.monthly_mo_count !== undefined)
        ? plan.monthly_mo_count
        : (plan?.monthly_mo_records ? plan.monthly_mo_records.length : 0);
    const partsCount = (partsProduced !== null && partsProduced !== undefined)
        ? Number(partsProduced).toLocaleString()
        : "0";
    const partsValStr = plan ? `${partsCount} Nos` : "- Nos";
    const moSubStr = `${moCount} MO${moCount === 1 ? '' : 's'} produced`;

    const remValStr = (remainingQty !== null && remainingQty !== undefined)
        ? `${Number(remainingQty).toLocaleString()} Nos`
        : "- Nos";
    const remSubStr = "MRP Bal - MO Produced";

    container.innerHTML = `
        <div class="mo-kpi-row" id="moKpiRow">
            <div class="mo-kpi-card kpi-rm-stock">
                <div class="mo-kpi-icon"><i class="fa-solid fa-layer-group"></i></div>
                <div class="mo-kpi-content">
                    <span class="mo-kpi-label">RM Sheets (On Hand)</span>
                    <div class="mo-kpi-value" id="kpiRmOnHand">${rmValStr}</div>
                    <small class="mo-kpi-subtext" id="kpiRmSubtext" title="${escapeHtml(rmSubStr)}">${escapeHtml(rmSubStr)}</small>
                </div>
            </div>

            <div class="mo-kpi-card kpi-mrp-qty">
                <div class="mo-kpi-icon"><i class="fa-solid fa-calendar-days"></i></div>
                <div class="mo-kpi-content">
                    <span class="mo-kpi-label">MRP Monthly Target</span>
                    <div class="mo-kpi-value" id="kpiMrpTarget">${mrpValStr}</div>
                    <small class="mo-kpi-subtext" id="kpiMrpSubtext" title="${escapeHtml(mrpSubStr)}">${escapeHtml(mrpSubStr)}</small>
                </div>
            </div>

            <div class="mo-kpi-card kpi-mo-produced">
                <div class="mo-kpi-icon"><i class="fa-solid fa-industry"></i></div>
                <div class="mo-kpi-content">
                    <span class="mo-kpi-label">Parts Produced</span>
                    <div class="mo-kpi-value" id="kpiMoProduced">${partsValStr}</div>
                    <small class="mo-kpi-subtext" id="kpiMoProducedSubtext" title="${moCount} MO${moCount === 1 ? '' : 's'} produced (${partsCount} parts in ${plan?.target_month || 'month'})">${escapeHtml(moSubStr)}</small>
                </div>
            </div>

            <div class="mo-kpi-card kpi-remaining-qty">
                <div class="mo-kpi-icon"><i class="fa-solid fa-hourglass-half"></i></div>
                <div class="mo-kpi-content">
                    <span class="mo-kpi-label">Remaining Quantity</span>
                    <div class="mo-kpi-value" id="kpiRemainingQty">${remValStr}</div>
                    <small class="mo-kpi-subtext" id="kpiRemainingSubtext" title="${escapeHtml(remSubStr)}">${escapeHtml(remSubStr)}</small>
                </div>
            </div>
        </div>
    `;
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

    // 3. MRP Monthly Schedule & Child Item Planning
    const mrpTotalEl = document.getElementById(`${prefix}IntelMrpTotal`);
    const mrpDetailEl = document.getElementById(`${prefix}IntelMrpDetail`);
    const mrp = intel.mrp_schedule || {};
    if (mrpTotalEl) {
        mrpTotalEl.textContent = mrp.monthly_total !== null && mrp.monthly_total !== undefined 
            ? `${Number(mrp.monthly_total).toLocaleString()} Nos` 
            : "- Nos";
    }
    if (mrpDetailEl) {
        if (mrp.child_part_no) {
            const offtakeStr = mrp.offtake ? ` | Off-take: ${mrp.offtake}` : "";
            const balStr = (mrp.balance_qty !== undefined && mrp.balance_qty !== null) ? ` | Bal: ${Number(mrp.balance_qty).toLocaleString()}` : "";
            const sheetStr = mrp.existing_sheet_used ? ` | Sheet: ${mrp.existing_sheet_used}` : "";
            mrpDetailEl.textContent = `${mrp.child_part_no} (${mrp.scope || 'IH'})${offtakeStr}${balStr}${sheetStr}`;
        } else if (mrp.monthly_total) {
            mrpDetailEl.textContent = `Target: ${Number(mrp.monthly_total).toLocaleString()} Nos (RM Sheet BOM)`;
        } else {
            mrpDetailEl.textContent = "No active BOM schedule in MRP RM Sheet";
        }
    }

    // 4. Previous MOs in ERP
    const moCountEl = document.getElementById(`${prefix}IntelMoCount`);
    const prevMos = intel.previous_mos || { records: [], total_found: 0 };
    if (moCountEl) {
        moCountEl.textContent = `${prevMos.total_found || 0} MOs`;
    }

    // 5. Update Key Planning Indicators in Create MO Modal (RM Sheets On Hand, MRP Monthly Target, Remaining Quantity)
    if (!isReview) {
        const plan = intel.planning_summary || {};
        const isMulti = plan.is_multi_part && plan.parts && plan.parts.length > 1;

        const rmOnHand = (plan.rm_onhand_sheets !== undefined && plan.rm_onhand_sheets !== null)
            ? plan.rm_onhand_sheets
            : (rm ? rm.onhand_stock : null);

        const mrpTarget = (plan.mrp_monthly_target !== undefined && plan.mrp_monthly_target !== null)
            ? plan.mrp_monthly_target
            : (mrp && mrp.monthly_total !== undefined && mrp.monthly_total !== null ? mrp.monthly_total : null);

        const partsProduced = plan.parts_produced || 0;
        const remainingQty = (plan.remaining_quantity !== undefined && plan.remaining_quantity !== null)
            ? plan.remaining_quantity
            : (mrpTarget !== null ? Math.max(0, mrpTarget - partsProduced) : null);

        const container = document.getElementById("moKpiContainer");

        if (isMulti && container) {
            // Render RM stock card on top, then separate 3-card sections for each and every part
            const rmValStr = (rmOnHand !== null && rmOnHand !== undefined) ? `${rmOnHand} Sheets` : "0 Sheets";
            const rmSubStr = rm?.item_code ? `${rm.item_code} (Main Store)` : "Main Store inventory";

            let html = `
                <div class="mo-kpi-row rm-top-row">
                    <div class="mo-kpi-card kpi-rm-stock">
                        <div class="mo-kpi-icon"><i class="fa-solid fa-layer-group"></i></div>
                        <div class="mo-kpi-content">
                            <span class="mo-kpi-label">RM Sheets (On Hand)</span>
                            <div class="mo-kpi-value" id="kpiRmOnHand">${rmValStr}</div>
                            <small class="mo-kpi-subtext" id="kpiRmSubtext" title="${escapeHtml(rmSubStr)}">${escapeHtml(rmSubStr)}</small>
                        </div>
                    </div>
                </div>
            `;

            // Build layout parts list to accurately label Primary Part, Part 2, Part 3, etc.
            const layoutRec = getSelectedLayoutRecord();
            const layoutPartsList = [];
            if (layoutRec) {
                if (layoutRec.part1) layoutPartsList.push({ label: "Primary Part", ...layoutRec.part1, is_primary: true });
                else if (layoutRec.part_no) layoutPartsList.push({ label: "Primary Part", part_no: layoutRec.part_no, is_primary: true });
                [layoutRec.part2, layoutRec.part3, layoutRec.part4].forEach((child, cIdx) => {
                    if (child?.part_no) {
                        layoutPartsList.push({ label: `Part ${cIdx + 2}`, ...child, is_primary: false });
                    }
                });
            }

            plan.parts.forEach((p, idx) => {
                const layoutItem = layoutPartsList[idx];
                const partLabel = layoutItem?.label || p.part_label || (idx === 0 ? "Primary Part" : `Part ${idx + 1}`);
                const partNo = layoutItem?.part_no || p.child_part_no || p.part_no || `Part ${idx + 1}`;
                const isPrimary = idx === 0 || !!layoutItem?.is_primary;
                const badgeClass = isPrimary ? "primary" : "secondary";
                const badgeIcon = isPrimary ? "fa-star" : "fa-puzzle-piece";

                let qtyPerSheet = null;
                if (layoutItem) {
                    qtyPerSheet = parseFloat(layoutItem.total_blank_qty_sheet);
                    if (!qtyPerSheet || isNaN(qtyPerSheet)) {
                        const bq = parseFloat(layoutItem.blank_qty) || 1;
                        const sq = parseFloat(layoutItem.strip_qty) || 1;
                        qtyPerSheet = bq * sq;
                    }
                } else if (p.part_qty) {
                    qtyPerSheet = p.part_qty;
                }

                const pMrp = (p.mrp_monthly_target !== null && p.mrp_monthly_target !== undefined)
                    ? `${Number(p.mrp_monthly_target).toLocaleString()} Nos`
                    : "N/A";
                const pMrpSub = p.child_part_no ? `${p.child_part_no} (Balance)` : "Balance demand";

                const pMoCount = p.monthly_mo_count || 0;
                const pPartsProd = Number(p.parts_produced || 0).toLocaleString();
                const pPartsVal = `${pPartsProd} Nos`;
                const pMoSub = `${pMoCount} MO${pMoCount === 1 ? '' : 's'} produced`;

                const pRem = (p.remaining_quantity !== null && p.remaining_quantity !== undefined)
                    ? `${Number(p.remaining_quantity).toLocaleString()} Nos`
                    : "- Nos";
                const pRemSub = "MRP Bal - MO Produced";

                html += `
                    <div class="part-kpi-section">
                        <div class="part-kpi-header">
                            <span class="part-kpi-badge ${badgeClass}">
                                <i class="fa-solid ${badgeIcon}"></i>
                                ${escapeHtml(partLabel)}: <strong>${escapeHtml(partNo)}</strong>
                                ${p.part_qty ? `<small style="font-weight: normal; margin-left: 4px;">(${p.part_qty} per sheet)</small>` : ''}
                            </span>
                        </div>
                        <div class="mo-kpi-row part-cards-row">
                            <div class="mo-kpi-card kpi-mrp-qty">
                                <div class="mo-kpi-icon"><i class="fa-solid fa-calendar-days"></i></div>
                                <div class="mo-kpi-content">
                                    <span class="mo-kpi-label">MRP Monthly Target</span>
                                    <div class="mo-kpi-value">${pMrp}</div>
                                    <small class="mo-kpi-subtext" title="${escapeHtml(pMrpSub)}">${escapeHtml(pMrpSub)}</small>
                                </div>
                            </div>

                            <div class="mo-kpi-card kpi-mo-produced">
                                <div class="mo-kpi-icon"><i class="fa-solid fa-industry"></i></div>
                                <div class="mo-kpi-content">
                                    <span class="mo-kpi-label">Parts Produced</span>
                                    <div class="mo-kpi-value">${pPartsVal}</div>
                                    <small class="mo-kpi-subtext" title="${pMoCount} MO${pMoCount === 1 ? '' : 's'} produced in ${plan.target_month || 'this month'} (${pPartsProd} parts)">${escapeHtml(pMoSub)}</small>
                                </div>
                            </div>

                            <div class="mo-kpi-card kpi-remaining-qty">
                                <div class="mo-kpi-icon"><i class="fa-solid fa-hourglass-half"></i></div>
                                <div class="mo-kpi-content">
                                    <span class="mo-kpi-label">Remaining Quantity</span>
                                    <div class="mo-kpi-value">${pRem}</div>
                                    <small class="mo-kpi-subtext" title="${escapeHtml(pRemSub)}">${escapeHtml(pRemSub)}</small>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            });

            container.innerHTML = html;
        } else {
            renderDefaultSinglePartKpis(rmOnHand, rm, mrpTarget, mrp, partsProduced, remainingQty, plan);
        }
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
        updateAutomatedConstraints(feas, getSelectedLayoutRecord());
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

// Direct MO Execution Handler
async function executeCurrentMoDirectly() {
    if (!activeReviewMo) return;
    const moNum = activeReviewMo.mo_number;
    const remarks = document.getElementById("approvalRemarks")?.value.trim() || "Executed and Released to Live ERP";

    try {
        const res = await fetch(`/api/mo/${encodeURIComponent(moNum)}/complete`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Role": currentRole
            },
            body: JSON.stringify({ role: currentRole, remarks })
        });

        if (res.ok) {
            const data = await res.json();
            const updates = data.db_updates || {};
            let msg = `🎉 Material Order ${moNum} Executed & Released to ERP!\n\n`;
            msg += `Live Database Tables Updated:\n`;
            if (updates.rm_stock) {
                msg += `• rm_main_store_stock: Deducted ${updates.rm_stock.deducted_sheets} sheets from ${updates.rm_stock.item_code} (New Balance: ${updates.rm_stock.new_stock} sheets)\n`;
            }
            if (updates.parts_stock) {
                msg += `• parts_fg_wip_stock: Added ${updates.parts_stock.added_qty} units to ${updates.parts_stock.item_code} (New Balance: ${updates.parts_stock.new_stock} units)\n`;
            }
            if (updates.erp_report) {
                msg += `• erp_mo_reports: Cutting Order #${updates.erp_report.cutting_order_no} created\n`;
            }
            if (updates.mrp_sheet_bom) {
                msg += `• mrp_rm_sheet_bom (${updates.mrp_sheet_bom.child_part}): Balance updated to ${updates.mrp_sheet_bom.balance_qty} (In-House: ${updates.mrp_sheet_bom.inhouse_erp_qty})\n`;
            }
            alert(msg);

            closeReviewModal();
            await loadStats();
            await loadOrders();
            await loadDbTablesOverview();
            if (currentDbTable) {
                await loadDbTableData();
            }
        } else {
            const err = await res.json();
            alert(`Execution failed: ${err.error || 'Server error'}`);
        }
    } catch (err) {
        console.error("Execute MO failed:", err);
    }
}

// =====================================================================
// Database Tables Explorer Logic
// =====================================================================
let allDbTables = [];
let currentDbTable = null;
let currentDbPage = 1;
let currentDbLimit = 25;
let currentDbSearch = "";
let dbSearchDebounceTimer = null;
let currentTableData = null;

function setActiveNavTab(tabId) {
    const tabs = ["navTabWorkflow", "navTabEndbits", "navTabDbTables"];
    tabs.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle("active", id === tabId);
    });
}

function toggleDbTablesPanel() {
    const panel = document.getElementById("dbTablesPanel");
    if (!panel) return;
    const isHidden = panel.style.display === "none" || !panel.style.display;
    panel.style.display = isHidden ? "flex" : "none";
    if (isHidden) {
        if (!allDbTables || allDbTables.length === 0) {
            loadDbTablesOverview();
        } else {
            renderSidebarTablesList();
        }
    }
}

// Close DB panel when clicking outside
document.addEventListener("click", function(evt) {
    const panel = document.getElementById("dbTablesPanel");
    const navBtn = document.getElementById("navTabDbTables");
    if (!panel || panel.style.display === "none") return;
    if (!panel.contains(evt.target) && !navBtn?.contains(evt.target)) {
        panel.style.display = "none";
    }
});

function toggleMoSidebar() {
    toggleDbTablesPanel();
}

async function loadDbTablesOverview() {
    try {
        const res = await fetch("/api/db/tables");
        if (res.ok) {
            const data = await res.json();
            allDbTables = data.tables || [];
            renderSidebarTablesList();
            const badge = document.getElementById("navDbCountBadge");
            if (badge) badge.textContent = allDbTables.length;
        }
    } catch (err) {
        console.error("Failed to load DB tables overview:", err);
    }
}

function renderSidebarTablesList() {
    const container = document.getElementById("sidebarTablesList");
    if (!container) return;

    if (!allDbTables || allDbTables.length === 0) {
        container.innerHTML = `<div style="padding: 10px; font-size: 0.8rem; color: #94a3b8; text-align: center;">No tables found.</div>`;
        return;
    }

    container.innerHTML = allDbTables.map(tbl => {
        const isActive = currentDbTable === tbl.id;
        const iconClass = tbl.icon || "fa-table";
        const badgeClass = tbl.badge_class || "inventory";
        const countFormatted = Number(tbl.count || 0).toLocaleString("en-IN");

        return `
            <button class="sidebar-table-item ${isActive ? 'active' : ''}" onclick="openDbTable('${escapeHtml(tbl.id)}')">
                <div class="nav-item-left">
                    <div class="nav-item-icon ${badgeClass}">
                        <i class="fa-solid ${iconClass}"></i>
                    </div>
                    <div class="nav-item-text">
                        <span class="nav-item-title">${escapeHtml(tbl.title)}</span>
                        <small class="nav-item-sub"><code>${escapeHtml(tbl.id)}</code></small>
                    </div>
                </div>
                <span class="nav-item-badge" id="badge_${escapeHtml(tbl.id)}">${countFormatted}</span>
            </button>
        `;
    }).join("");
}

async function refreshDbTables() {
    const icon = document.getElementById("refreshTablesIcon");
    if (icon) icon.classList.add("fa-spin");
    await loadDbTablesOverview();
    if (currentDbTable) {
        await loadDbTableData();
    }
    if (icon) {
        setTimeout(() => icon.classList.remove("fa-spin"), 400);
    }
}

function showMoWorkflowView() {
    currentDbTable = null;
    const panel = document.getElementById("dbTablesPanel");
    if (panel) panel.style.display = "none";

    const workflowView = document.getElementById("moWorkflowView");
    const explorerView = document.getElementById("dbExplorerView") || document.getElementById("dbTableView");
    const ebView = document.getElementById("endbitsStoreView");
    const createEbView = document.getElementById("createEndbitMoView");
    if (workflowView) workflowView.style.display = "flex";
    if (explorerView) explorerView.style.display = "none";
    if (ebView) ebView.style.display = "none";
    if (createEbView) createEbView.style.display = "none";

    setActiveNavTab("navTabWorkflow");
    renderSidebarTablesList();
}

async function showEndbitsStoreView() {
    currentDbTable = null;
    const panel = document.getElementById("dbTablesPanel");
    if (panel) panel.style.display = "none";

    const workflowView = document.getElementById("moWorkflowView");
    const explorerView = document.getElementById("dbExplorerView") || document.getElementById("dbTableView");
    const ebView = document.getElementById("endbitsStoreView");
    const createEbView = document.getElementById("createEndbitMoView");
    if (workflowView) workflowView.style.display = "none";
    if (explorerView) explorerView.style.display = "none";
    if (ebView) ebView.style.display = "flex";
    if (createEbView) createEbView.style.display = "none";

    setActiveNavTab("navTabEndbits");
    renderSidebarTablesList();

    await loadEndbitsStoreData();
}

async function showCreateEndbitMoView(preselectedEndbitId = null) {
    if (currentRole !== "shearing") {
        alert("Access Restricted: Only the Shearing Production team can create Material Orders from end bits. Other departments have view-only access to the End Bits Store.");
        showEndbitsStoreView();
        return;
    }

    currentDbTable = null;
    const panel = document.getElementById("dbTablesPanel");
    if (panel) panel.style.display = "none";

    const workflowView = document.getElementById("moWorkflowView");
    const explorerView = document.getElementById("dbExplorerView") || document.getElementById("dbTableView");
    const ebView = document.getElementById("endbitsStoreView");
    const createEbView = document.getElementById("createEndbitMoView");
    if (workflowView) workflowView.style.display = "none";
    if (explorerView) explorerView.style.display = "none";
    if (ebView) ebView.style.display = "none";
    if (createEbView) createEbView.style.display = "flex";

    setActiveNavTab("navTabEndbits");
    renderSidebarTablesList();

    // Populate all end bits into dropdown and chips grid
    await populateEbMoDropdown(preselectedEndbitId);
}

async function openDbTable(tableName) {
    currentDbTable = tableName;
    currentDbPage = 1;
    currentDbSearch = "";

    const panel = document.getElementById("dbTablesPanel");
    if (panel) panel.style.display = "none";

    const searchInput = document.getElementById("dbSearchInput");
    if (searchInput) searchInput.value = "";

    const workflowView = document.getElementById("moWorkflowView");
    const explorerView = document.getElementById("dbExplorerView") || document.getElementById("dbTableView");
    const ebView = document.getElementById("endbitsStoreView");
    const createEbView = document.getElementById("createEndbitMoView");
    if (workflowView) workflowView.style.display = "none";
    if (explorerView) explorerView.style.display = "flex";
    if (ebView) ebView.style.display = "none";
    if (createEbView) createEbView.style.display = "none";

    setActiveNavTab("navTabDbTables");
    renderSidebarTablesList();

    await loadDbTableData();
}

async function loadDbTableData() {
    if (!currentDbTable) return;

    const tbody = document.getElementById("dbTableBody");
    const thead = document.getElementById("dbTableHead");
    if (tbody) {
        tbody.innerHTML = `<tr><td colspan="12" class="loading-cell"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading live data from Supabase <code>${escapeHtml(currentDbTable)}</code>...</td></tr>`;
    }

    try {
        const params = new URLSearchParams({
            page: currentDbPage,
            limit: currentDbLimit,
            q: currentDbSearch
        });

        const res = await fetch(`/api/db/table/${encodeURIComponent(currentDbTable)}?${params.toString()}`);
        if (!res.ok) {
            throw new Error(`Failed to load table data: ${res.status}`);
        }

        const data = await res.json();
        currentTableData = data;

        // Update Header
        const titleEl = document.getElementById("dbTableTitle");
        const catEl = document.getElementById("dbTableCategory");
        const rowsPill = document.getElementById("dbTableRowsPill");
        const descEl = document.getElementById("dbTableDesc");
        const iconEl = document.getElementById("dbTableIcon");

        const cfg = allDbTables.find(t => t.id === currentDbTable);

        if (titleEl) titleEl.textContent = data.title || currentDbTable;
        if (catEl) catEl.textContent = data.category || "Database";
        if (rowsPill) rowsPill.textContent = `${Number(data.total_rows || 0).toLocaleString("en-IN")} Total Rows`;
        if (descEl) descEl.textContent = data.description || "Live Supabase PostgreSQL Table Records";
        if (iconEl && cfg) {
            iconEl.innerHTML = `<i class="fa-solid ${cfg.icon || 'fa-table'}"></i>`;
        }

        // Render Head
        let columns = (data.columns || []).filter(c => !["sl_no", "slno", "s_no"].includes(c.toLowerCase()));
        if (currentDbTable === "erp_mo_reports") {
            columns = columns.filter(c => c !== "created_at" && c !== "created_on");
        }

        const scrollHint = document.getElementById("dbScrollHint");
        if (scrollHint) {
            if (columns.length > 7) {
                scrollHint.style.display = "inline-flex";
                scrollHint.innerHTML = `<i class="fa-solid fa-arrows-left-right"></i> Scroll left-to-right (${columns.length} columns)`;
            } else {
                scrollHint.style.display = "none";
            }
        }

        if (thead) {
            thead.innerHTML = `
                <tr>
                    <th style="min-width: 65px; width: 65px; position: sticky; left: 0; z-index: 12; background: #f8fafc; border-right: 1px solid #e2e8f0; text-align: center;">Sl. No.</th>
                    ${columns.map(c => `<th>${escapeHtml(formatColumnName(c))}</th>`).join("")}
                </tr>
            `;
        }

        // Render Rows
        const rows = data.rows || [];
        if (tbody) {
            if (rows.length === 0) {
                tbody.innerHTML = `<tr><td colspan="${columns.length + 1}" class="loading-cell">No records found matching current query.</td></tr>`;
            } else {
                tbody.innerHTML = rows.map((row, idx) => {
                    const rowNum = (data.page - 1) * data.limit + idx + 1;
                    return `
                        <tr>
                            <td class="text-muted" style="position: sticky; left: 0; z-index: 2; background: #ffffff; font-size: 0.78rem; border-right: 1px solid #f1f5f9; font-weight: 600; text-align: center;">${rowNum}</td>
                            ${columns.map(col => `<td>${formatCellValue(col, row[col], row)}</td>`).join("")}
                        </tr>
                    `;
                }).join("");
            }
        }

        // Render Pagination
        const pagInfo = document.getElementById("dbPaginationInfo");
        const pagePill = document.getElementById("dbCurrentPagePill");
        const prevBtn = document.getElementById("dbPrevBtn");
        const nextBtn = document.getElementById("dbNextBtn");

        if (pagInfo) {
            const startR = (data.page - 1) * data.limit + 1;
            const endR = Math.min(data.page * data.limit, data.total_rows);
            pagInfo.textContent = data.total_rows > 0 ? `Showing ${startR}-${endR} of ${data.total_rows.toLocaleString()} records` : `No records`;
        }
        if (pagePill) pagePill.textContent = `Page ${data.page} of ${Math.max(1, data.total_pages)}`;
        if (prevBtn) prevBtn.disabled = data.page <= 1;
        if (nextBtn) nextBtn.disabled = data.page >= data.total_pages;

    } catch (err) {
        console.error("Failed to load table records:", err);
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="12" class="loading-cell text-danger">Failed to query Supabase table: ${escapeHtml(err.message)}</td></tr>`;
        }
    }
}

function formatColumnName(col) {
    if (!col) return "";
    if (col === "created_on" || col === "created_at") return "Created On";
    return col
        .replace(/_/g, " ")
        .replace(/\b\w/g, l => l.toUpperCase());
}

function formatCellValue(col, val, row) {
    if (val === null || val === undefined || val === "") {
        return `<span class="text-muted">-</span>`;
    }

    // Created On / Created At — Display date only
    if (col === "created_on" || col === "created_at") {
        const dateOnly = String(val).split("T")[0].split(" ")[0];
        return `<span style="font-weight: 500; color: #334155;"><i class="fa-regular fa-calendar" style="color: #64748b; margin-right: 5px;"></i>${escapeHtml(dateOnly)}</span>`;
    }

    // Date fields — show only YYYY-MM-DD
    if (col.endsWith("_date") || col.endsWith("_at")) {
        const dateOnly = String(val).split("T")[0].split(" ")[0];
        return `<span style="color: #334155;">${escapeHtml(dateOnly)}</span>`;
    }

    // Numbers & onhand stock
    if (col === "onhand_stock") {
        const num = parseFloat(val);
        const cls = num > 0 ? "text-success" : "text-danger";
        return `<strong class="${cls}" style="font-size: 0.92rem;"><i class="fa-solid fa-layer-group"></i> ${num.toLocaleString()}</strong>`;
    }

    if (col === "target_qty" || col === "sheets_required" || col === "number_of_sheets" || col === "total_parent_qty" || col === "schedule_qty" || col === "total_qty" || col === "balance_qty" || col === "inhouse_erp_qty" || col === "outsource_erp_qty") {
        const n = parseFloat(val);
        return !isNaN(n) ? `<strong>${n.toLocaleString()}</strong>` : escapeHtml(String(val));
    }

    if (col === "image_url") {
        return `<a href="${escapeHtml(val)}" target="_blank" class="btn btn-secondary btn-sm" style="padding: 2px 8px; font-size: 0.72rem;"><i class="fa-solid fa-image"></i> View CAD</a>`;
    }

    // Code fields
    if (col === "mo_number" || col === "mo_doc_no" || col === "item_code" || col === "part_no" || col === "parent_part_no" || col === "child_part_no" || col === "rm_erp" || col === "cutting_order_no") {
        return `<code style="font-weight: 600; color: #1e293b;">${escapeHtml(String(val))}</code>`;
    }

    // Status badges
    if (col === "status" || col === "order_status") {
        let stClass = "pending-erp";
        if (val === "RELEASED_TO_ERP" || val === "COMPLETED") stClass = "released";
        else if (val === "REJECTED") stClass = "rejected";
        else if (val === "PENDING_KRYSALIS") stClass = "pending-krysalis";
        else if (val === "PENDING_PURCHASE") stClass = "pending-purchase";
        return `<span class="status-badge ${stClass}" style="font-size: 0.72rem;">${escapeHtml(String(val))}</span>`;
    }

    if (typeof val === "object") {
        const jsonStr = JSON.stringify(val);
        return `<span title="${escapeHtml(jsonStr)}" style="cursor: help; background: #f1f5f9; padding: 2px 7px; border-radius: 4px; font-size: 0.72rem; color: #475569; font-family: monospace;">${escapeHtml(jsonStr.length > 25 ? jsonStr.slice(0, 22) + '...' : jsonStr)}</span>`;
    }

    return escapeHtml(String(val));
}

function changeDbPage(delta) {
    currentDbPage += delta;
    if (currentDbPage < 1) currentDbPage = 1;
    loadDbTableData();
}

function handleDbSearch(val) {
    clearTimeout(dbSearchDebounceTimer);
    dbSearchDebounceTimer = setTimeout(() => {
        currentDbSearch = (val || "").trim();
        currentDbPage = 1;
        loadDbTableData();
    }, 280);
}

function reloadCurrentDbTable() {
    loadDbTableData();
}

function exportCurrentDbTableCsv() {
    if (!currentTableData || !currentTableData.rows || currentTableData.rows.length === 0) {
        alert("No table records to export.");
        return;
    }

    let cols = (currentTableData.columns || Object.keys(currentTableData.rows[0]))
        .filter(c => !["sl_no", "slno", "s_no"].includes(c.toLowerCase()));

    if (currentDbTable === "erp_mo_reports") {
        cols = cols.filter(c => c !== "created_at" && c !== "created_on");
    }

    const escapeCsv = (v) => {
        if (v === null || v === undefined) return '""';
        let str = typeof v === "object" ? JSON.stringify(v) : String(v);
        return `"${str.replace(/"/g, '""')}"`;
    };

    const headerLine = ['"Sl. No."', ...cols.map(c => `"${formatColumnName(c)}"` )].join(",");
    const rowLines = currentTableData.rows.map((r, idx) => {
        const rowNum = (currentTableData.page - 1) * currentTableData.limit + idx + 1;
        return [`"${rowNum}"`, ...cols.map(c => escapeCsv(r[c]))].join(",");
    });

    const csvContent = "\uFEFF" + [headerLine, ...rowLines].join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${currentDbTable}_export.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function exportCurrentDbTablePdf() {
    if (!currentTableData || !currentTableData.rows || currentTableData.rows.length === 0) {
        alert("No table records to export.");
        return;
    }

    if (!window.jspdf || !window.jspdf.jsPDF) {
        alert("PDF export library is still loading. Please try again in a moment.");
        return;
    }

    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({
            orientation: "landscape",
            unit: "mm",
            format: "a4"
        });

        const pageWidth = doc.internal.pageSize.width;
        const margin = 8;
        const todayStr = new Date().toISOString().split("T")[0];
        const tableName = currentTableData.title || currentDbTable || "Database Table";

        // Top Banner
        doc.setFillColor(15, 23, 42); // Slate #0f172a
        doc.rect(0, 0, pageWidth, 22, "F");
        doc.setFillColor(37, 99, 235); // Blue accent
        doc.rect(0, 22, pageWidth, 1.5, "F");

        doc.setTextColor(255, 255, 255);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(14);
        doc.text("SheetLayout AI", margin, 10);

        doc.setFont("helvetica", "normal");
        doc.setFontSize(8.5);
        doc.setTextColor(148, 163, 184);
        doc.text(`DATABASE TABLE REPORT — ${String(tableName).toUpperCase()}`, margin, 16);

        const nowStr = new Date().toLocaleString("en-IN", {
            day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
        });
        doc.setFontSize(8);
        doc.text(`Generated: ${nowStr} | Total Rows: ${currentTableData.total_rows || currentTableData.rows.length}`, pageWidth - margin, 14, { align: "right" });

        // Filter columns
        let cols = (currentTableData.columns || Object.keys(currentTableData.rows[0]))
            .filter(c => !["sl_no", "slno", "s_no"].includes(c.toLowerCase()));
        if (currentDbTable === "erp_mo_reports") {
            cols = cols.filter(c => c !== "created_at" && c !== "created_on");
        }

        const tableColumns = [
            { header: "Sl. No.", dataKey: "_row_num" },
            ...cols.map(c => ({ header: formatColumnName(c), dataKey: c }))
        ];

        const tableRows = currentTableData.rows.map((r, idx) => {
            const rowNum = (currentTableData.page - 1) * currentTableData.limit + idx + 1;
            const rowObj = { _row_num: String(rowNum) };
            cols.forEach(c => {
                let val = r[c];
                if (val === null || val === undefined) val = "-";
                else if (typeof val === "object") val = JSON.stringify(val);
                else val = String(val);
                rowObj[c] = val;
            });
            return rowObj;
        });

        doc.autoTable({
            columns: tableColumns,
            body: tableRows,
            startY: 28,
            margin: { left: margin, right: margin },
            theme: "grid",
            styles: {
                fontSize: 7,
                cellPadding: 2.2,
                textColor: [30, 41, 59],
                lineColor: [226, 232, 240],
                lineWidth: 0.1,
                overflow: "linebreak"
            },
            headStyles: {
                fillColor: [241, 245, 249],
                textColor: [15, 23, 42],
                fontStyle: "bold",
                fontSize: 7.5
            },
            alternateRowStyles: {
                fillColor: [248, 250, 252]
            },
            didDrawPage: function(data) {
                const pageCount = doc.internal.getNumberOfPages();
                doc.setFontSize(7.5);
                doc.setTextColor(148, 163, 184);
                doc.text(`Page ${data.pageNumber} of ${pageCount}`, pageWidth - margin, doc.internal.pageSize.height - 6, { align: "right" });
            }
        });

        doc.save(`${currentDbTable || 'table'}_report_${todayStr}.pdf`);
    } catch (err) {
        console.error("Failed to generate DB Table PDF:", err);
        alert("Failed to generate PDF: " + err.message);
    }
}


/* =========================================================================
   END BITS & OFFCUTS MANAGEMENT SYSTEM
   Extracts, calculates, stores, and enables manufacturing parts from end bits
   ========================================================================= */

let allEndbits = [];
let currentEndbitFilterStatus = "ALL";
let currentEndbitSearch = "";
let activeProduceEndbit = null;
let selectedProduceMasterPart = null;
let produceSearchDebounceTimer = null;
let ebSearchDebounceTimer = null;

/**
 * Renders offcuts/endbits preview when creating an MO
 */
function renderLayoutEndbits(record, sheetsNeeded = 1) {
    const banner = document.getElementById("layoutEndbitsBanner");
    const list = document.getElementById("layoutEndbitsList");
    const countBadge = document.getElementById("endbitsSummaryBadge");
    const hiddenJson = document.getElementById("moEndbitsJson");

    if (!banner || !list) return;

    if (!record || !record.endbits || !Array.isArray(record.endbits) || record.endbits.length === 0) {
        banner.style.display = "none";
        list.innerHTML = "";
        if (hiddenJson) hiddenJson.value = "[]";
        return;
    }

    const validEndbits = [];
    record.endbits.forEach((eb, idx) => {
        const dimStr = (eb.dim || eb.dimension || "").trim();
        if (!dimStr) return;

        // Parse quantity per sheet
        const qtyMatch = String(eb.qty || "1").match(/(\d+(?:\.\d+)?)/);
        const qtyPerSheet = qtyMatch ? parseFloat(qtyMatch[1]) : 1;
        const totalQty = Math.round(qtyPerSheet * sheetsNeeded);

        // Parse dimensions: supports "730.0*60.9*5.8" or "1350*60"
        const parts = dimStr.split(/[*xX]/).map(p => parseFloat(p.trim())).filter(p => !isNaN(p) && p > 0);
        let thick = record.thickness || 0;
        let len = 0;
        let wid = 0;
        if (parts.length >= 3) {
            if (parts[0] < parts[1] && parts[0] <= 25) {
                thick = parts[0];
                len = Math.max(parts[1], parts[2]);
                wid = Math.min(parts[1], parts[2]);
            } else {
                len = Math.max(parts[0], parts[1]);
                wid = Math.min(parts[0], parts[1]);
                thick = parts[2];
            }
        } else if (parts.length === 2) {
            len = Math.max(parts[0], parts[1]);
            wid = Math.min(parts[0], parts[1]);
        }

        // Est weight per piece: (L * W * T * 7.85 / 1e6)
        const pieceWeight = (len > 0 && wid > 0 && thick > 0) ? (len * wid * thick * 7.85 / 1000000) : 0;
        const totalWeight = pieceWeight * totalQty;

        validEndbits.push({
            name: eb.name || `End Bit - ${idx + 1}`,
            dim: dimStr,
            thickness: thick,
            length: len,
            width: wid,
            qty_per_sheet: qtyPerSheet,
            total_qty: totalQty,
            total_weight_kg: parseFloat(totalWeight.toFixed(2))
        });
    });

    if (validEndbits.length === 0) {
        banner.style.display = "none";
        list.innerHTML = "";
        if (hiddenJson) hiddenJson.value = "[]";
        return;
    }

    if (hiddenJson) {
        hiddenJson.value = JSON.stringify(validEndbits);
    }

    if (countBadge) {
        countBadge.textContent = `${validEndbits.length} Offcut Specification${validEndbits.length > 1 ? 's' : ''}`;
    }

    let cardsHtml = "";
    validEndbits.forEach((eb) => {
        const gradeVal = record.grade || "YS";
        cardsHtml += `
            <div class="endbit-mini-card neat-endbit-card">
                <div class="reb-clean-field">
                    <span class="reb-clean-label">End Bit Name</span>
                    <strong class="reb-clean-val reb-name-val"><i class="fa-solid fa-scissors" style="color: #0284c7; margin-right: 5px;"></i>${escapeHtml(eb.name)}</strong>
                </div>
                <div class="reb-clean-row">
                    <div class="reb-clean-field">
                        <span class="reb-clean-label">No. of End Bits Produced</span>
                        <strong class="reb-clean-val">${eb.total_qty} Nos</strong>
                    </div>
                    <div class="reb-clean-field" style="text-align: right;">
                        <span class="reb-clean-label">Grade</span>
                        <span class="reb-grade-pill">${escapeHtml(gradeVal)}</span>
                    </div>
                </div>
            </div>
        `;
    });

    list.innerHTML = cardsHtml;
    banner.style.display = "block";
}

/**
 * Renders offcuts/endbits generated by this MO in Review Modal
 * Neatly shows End Bit Name, No. of End Bits Produced, and Grade
 */
function renderReviewEndbits(mo) {
    const sec = document.getElementById("reviewEndbitsSection");
    const grid = document.getElementById("reviewEndbitsGrid");
    const countBadge = document.getElementById("reviewEndbitsCountBadge");

    if (!sec || !grid) return;

    let ebList = mo.endbits;
    if ((!ebList || !ebList.length) && mo.constraints_status && mo.constraints_status.endbits) {
        ebList = mo.constraints_status.endbits;
    }

    if (!ebList || !Array.isArray(ebList) || ebList.length === 0) {
        sec.style.display = "none";
        grid.innerHTML = "";
        return;
    }

    if (countBadge) {
        countBadge.textContent = `${ebList.length} Recorded`;
    }

    const isShearing = (currentRole === "shearing");

    let cardsHtml = "";
    ebList.forEach((eb, idx) => {
        const ebId = eb.endbit_id || `EB-${mo.mo_number}-${idx + 1}`;
        const ebName = eb.name || ebId;
        const producedQty = eb.initial_qty || eb.total_qty || eb.qty || 1;
        const gradeVal = eb.grade || mo.grade || mo.material_grade || "YS";
        const availQty = eb.available_qty !== undefined ? eb.available_qty : producedQty;

        cardsHtml += `
            <div class="review-endbit-card neat-endbit-card">
                <div class="reb-clean-content">
                    <div class="reb-clean-field">
                        <span class="reb-clean-label">End Bit Name</span>
                        <strong class="reb-clean-val reb-name-val"><i class="fa-solid fa-scissors" style="color: #0284c7; margin-right: 5px;"></i>${escapeHtml(ebName)}</strong>
                    </div>
                    <div class="reb-clean-row">
                        <div class="reb-clean-field">
                            <span class="reb-clean-label">No. of End Bits Produced</span>
                            <strong class="reb-clean-val">${producedQty} Nos</strong>
                        </div>
                        <div class="reb-clean-field" style="text-align: right;">
                            <span class="reb-clean-label">Grade</span>
                            <span class="reb-grade-pill">${escapeHtml(gradeVal)}</span>
                        </div>
                    </div>
                </div>
                ${isShearing && availQty > 0 ? `
                <div class="reb-clean-actions">
                    <button type="button" class="btn btn-primary btn-sm" style="width: 100%;" onclick="closeReviewModal(); openProducePartModal('${escapeHtml(ebId)}')">
                        <i class="fa-solid fa-shapes"></i> Create Part from this End Bit
                    </button>
                </div>
                ` : ''}
            </div>
        `;
    });

    grid.innerHTML = cardsHtml;
    sec.style.display = "block";
}

/**
 * Loads End Bits Store table and stats
 */
async function loadEndbitsStoreData() {
    const tbody = document.getElementById("endbitsTableBody");
    const totalPill = document.getElementById("ebStoreTotalPill");
    if (tbody) {
        tbody.innerHTML = `<tr><td colspan="7" class="loading-cell"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading end bits store...</td></tr>`;
    }

    try {
        const queryParams = new URLSearchParams();
        if (currentEndbitFilterStatus && currentEndbitFilterStatus !== "ALL") {
            queryParams.set("status", currentEndbitFilterStatus);
        }
        if (currentEndbitSearch) {
            queryParams.set("search", currentEndbitSearch);
        }

        const [resList, resStats] = await Promise.all([
            fetch(`/api/endbits?${queryParams.toString()}`),
            fetch("/api/endbits/stats")
        ]);

        if (resStats.ok) {
            const stats = await resStats.json();
            const ebTotalEl = document.getElementById("statEbTotal");
            const ebAvailEl = document.getElementById("statEbAvailable");
            const ebPartsEl = document.getElementById("statEbPartsCreated");
            const ebWeightEl = document.getElementById("statEbWeight");
            const sideCountEl = document.getElementById("sideNavEndbitsCount");

            if (ebTotalEl) ebTotalEl.textContent = stats.total_records || 0;
            if (ebAvailEl) ebAvailEl.textContent = stats.total_available_nos || 0;
            if (ebPartsEl) ebPartsEl.textContent = stats.total_parts_made || 0;
            if (ebWeightEl) ebWeightEl.innerHTML = `${(stats.total_weight_kg || 0).toFixed(1)} <small style="font-size: 0.9rem;">kg</small>`;
            if (sideCountEl) sideCountEl.textContent = stats.total_records || 0;
            if (totalPill) totalPill.textContent = `${stats.total_records || 0} Recorded`;
        }

        if (resList.ok) {
            allEndbits = await resList.json();
            renderEndbitsTable(allEndbits);
        } else {
            throw new Error("Failed to fetch end bits list");
        }
    } catch (err) {
        console.error("Error loading endbits store:", err);
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="7" class="loading-cell text-danger">Failed to load end bits: ${escapeHtml(err.message)}</td></tr>`;
        }
    }
}

/**
 * Renders the rows in the End Bits Store View
 */
function renderEndbitsTable(endbits) {
    const tbody = document.getElementById("endbitsTableBody");
    if (!tbody) return;

    const isShearing = (currentRole === "shearing");
    const actionTh = document.querySelector(".shearing-action-th");
    if (actionTh) {
        actionTh.style.display = isShearing ? "" : "none";
    }

    if (!endbits || endbits.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="${isShearing ? 5 : 4}" class="loading-cell text-muted" style="padding: 40px 20px;">
                    <i class="fa-solid fa-scissors" style="font-size: 2rem; color: #cbd5e1; margin-bottom: 10px; display: block;"></i>
                    No end bits found matching your filter criteria.<br>
                    <small>When a Material Order is submitted with offcuts, they appear here.</small>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = endbits.map(eb => {
        const ebName = eb.endbit_id || eb.name || "-";
        const produced = eb.initial_qty || eb.total_qty || eb.available_qty || 1;
        const gradeVal = eb.grade || "YS";
        const moNum = eb.source_mo_number || eb.mo_number || "-";
        const avail = eb.available_qty !== undefined ? eb.available_qty : produced;

        return `
            <tr>
                <td><code style="font-weight: 600; color: #0284c7; font-size: 0.88rem;"><i class="fa-solid fa-scissors" style="margin-right: 5px;"></i>${escapeHtml(ebName)}</code></td>
                <td><strong style="color: #0f172a; font-size: 0.92rem;">${produced} Nos</strong></td>
                <td><span class="reb-grade-pill">${escapeHtml(gradeVal)}</span></td>
                <td>
                    <button class="btn-link-action" onclick="openReviewModal('${escapeHtml(moNum)}')">
                        ${escapeHtml(moNum)}
                    </button>
                </td>
                ${isShearing ? `
                <td>
                    ${avail > 0 ? `
                    <button type="button" class="btn btn-primary btn-sm" onclick="openProducePartModal('${escapeHtml(eb.endbit_id)}')">
                        <i class="fa-solid fa-shapes"></i> Create Part
                    </button>
                    ` : `<span class="text-muted small">Consumed</span>`}
                </td>
                ` : ''}
            </tr>
        `;
    }).join("");
}

function filterEndbitsByStatus(status) {
    currentEndbitFilterStatus = status;
    const tabs = {
        'ALL': 'ebTabAll',
        'AVAILABLE': 'ebTabAvail',
        'PARTIALLY_USED': 'ebTabPart',
        'CONSUMED': 'ebTabCons'
    };
    Object.keys(tabs).forEach(k => {
        const el = document.getElementById(tabs[k]);
        if (el) el.classList.toggle("active", k === status);
    });

    loadEndbitsStoreData();
}

function handleEndbitSearch(val) {
    clearTimeout(ebSearchDebounceTimer);
    ebSearchDebounceTimer = setTimeout(() => {
        currentEndbitSearch = (val || "").trim();
        loadEndbitsStoreData();
    }, 280);
}

function downloadEndbitsReport() {
    if (!allEndbits || allEndbits.length === 0) {
        alert("No end bits recorded to export.");
        return;
    }

    if (!window.jspdf || !window.jspdf.jsPDF) {
        alert("PDF export library is still loading. Please try again in a moment.");
        return;
    }

    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({
            orientation: "landscape",
            unit: "mm",
            format: "a4"
        });

        const pageWidth = doc.internal.pageSize.width;
        const margin = 10;

        // Header Banner
        doc.setFillColor(15, 23, 42); // Slate #0f172a
        doc.rect(0, 0, pageWidth, 22, "F");
        doc.setFillColor(5, 150, 105); // Green accent #059669
        doc.rect(0, 22, pageWidth, 1.5, "F");

        doc.setTextColor(255, 255, 255);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(14);
        doc.text("SheetLayout AI", margin, 10);

        doc.setFont("helvetica", "normal");
        doc.setFontSize(8.5);
        doc.setTextColor(148, 163, 184);
        doc.text("END BITS & OFFCUTS INVENTORY REPORT", margin, 16);

        const nowStr = new Date().toLocaleString("en-IN", {
            day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
        });
        doc.setFontSize(8);
        doc.text(`Generated: ${nowStr} | Total Records: ${allEndbits.length}`, pageWidth - margin, 14, { align: "right" });

        // Table Columns: End Bit Name, No. of End Bits Produced, Grade, Source MO #
        const tableColumns = [
            { header: "End Bit Name", dataKey: "endbit_id" },
            { header: "No. of End Bits Produced", dataKey: "qty" },
            { header: "Grade", dataKey: "grade" },
            { header: "Source MO #", dataKey: "source_mo" }
        ];

        const tableRows = allEndbits.map(eb => {
            const ebName = eb.endbit_id || eb.name || "-";
            const produced = eb.initial_qty || eb.total_qty || eb.available_qty || 1;
            const gradeVal = eb.grade || "YS";
            const moNum = eb.source_mo_number || eb.mo_number || "-";
            return {
                endbit_id: ebName,
                qty: `${produced} Nos`,
                grade: gradeVal,
                source_mo: moNum
            };
        });

        doc.autoTable({
            columns: tableColumns,
            body: tableRows,
            startY: 28,
            margin: { left: margin, right: margin },
            theme: "grid",
            styles: {
                fontSize: 8,
                cellPadding: 3,
                textColor: [30, 41, 59],
                lineColor: [226, 232, 240],
                lineWidth: 0.1
            },
            headStyles: {
                fillColor: [241, 245, 249],
                textColor: [15, 23, 42],
                fontStyle: "bold",
                fontSize: 8.5
            },
            alternateRowStyles: {
                fillColor: [248, 250, 252]
            },
            didDrawPage: function(data) {
                const pageCount = doc.internal.getNumberOfPages();
                doc.setFontSize(7.5);
                doc.setTextColor(148, 163, 184);
                doc.text(`Page ${data.pageNumber} of ${pageCount}`, pageWidth - margin, doc.internal.pageSize.height - 6, { align: "right" });
            }
        });

        doc.save(`End_Bits_Inventory_Report_${todayStr}.pdf`);
    } catch (err) {
        console.error("Failed to generate End Bits PDF:", err);
        alert("Failed to generate PDF: " + err.message);
    }
}


/**
 * Modal to Produce / Create Part from End Bit
 */
async function openProducePartModal(endbitId) {
    if (currentRole !== "shearing") {
        alert("Access Restricted: Only the Shearing Production team can produce parts or create Material Orders from end bits.");
        return;
    }
    let eb = allEndbits.find(e => e.endbit_id === endbitId);
    if (!eb) {
        try {
            const res = await fetch(`/api/endbits/${encodeURIComponent(endbitId)}`);
            if (res.ok) {
                eb = await res.json();
            }
        } catch (e) {
            console.error(e);
        }
    }
    if (!eb) {
        alert("End bit record not found.");
        return;
    }

    activeProduceEndbit = eb;
    selectedProduceMasterPart = null;

    // Fill source summary card
    const badgeId = document.getElementById("prodEbBadgeId");
    if (badgeId) badgeId.textContent = eb.endbit_id;

    const availQty = eb.available_qty !== undefined ? eb.available_qty : eb.initial_qty;
    const stEl = document.getElementById("prodEbStatus");
    if (stEl) {
        stEl.textContent = eb.status || (availQty <= 0 ? "CONSUMED" : "AVAILABLE");
        stEl.className = `eb-badge-status ${availQty > 0 ? 'available' : 'consumed'}`;
    }

    const moNumEl = document.getElementById("prodEbMoNum");
    if (moNumEl) moNumEl.textContent = eb.source_mo_number || eb.mo_number || "-";

    const parentPartEl = document.getElementById("prodEbParentPart");
    if (parentPartEl) parentPartEl.textContent = eb.parent_part_no || "-";

    const gradeEl = document.getElementById("prodEbGrade");
    if (gradeEl) gradeEl.textContent = eb.grade || "YS";

    const dimStr = eb.dimensions || eb.dim || `${eb.thickness || ''}*${eb.length || ''}*${eb.width || ''}`;
    const dimEl = document.getElementById("prodEbDimensions");
    if (dimEl) dimEl.textContent = `${dimStr} mm`;

    const availEl = document.getElementById("prodEbAvailableQty");
    if (availEl) availEl.textContent = `${availQty} Nos`;

    const wtVal = eb.estimated_weight_kg || eb.weight_kg;
    const wtEl = document.getElementById("prodEbWeight");
    if (wtEl) wtEl.textContent = wtVal ? `${parseFloat(wtVal).toFixed(2)} kg` : "-";

    // Hidden inputs
    const hiddenId = document.getElementById("produceEndbitId");
    if (hiddenId) hiddenId.value = eb.endbit_id;

    const hThick = document.getElementById("prodSourceThickness");
    if (hThick) hThick.value = eb.thickness || "";

    const hLen = document.getElementById("prodSourceLength");
    if (hLen) hLen.value = eb.length || "";

    const hWid = document.getElementById("prodSourceWidth");
    if (hWid) hWid.value = eb.width || "";

    const hMax = document.getElementById("prodMaxAvailable");
    if (hMax) hMax.value = availQty;

    // Reset inputs
    const partInput = document.getElementById("producePartNoInput");
    if (partInput) partInput.value = "";

    const dropdown = document.getElementById("producePartDropdown");
    if (dropdown) {
        dropdown.style.display = "none";
        dropdown.innerHTML = "";
    }

    const fitCard = document.getElementById("partFitCheckCard");
    if (fitCard) fitCard.style.display = "none";

    const ebUseInput = document.getElementById("endbitsConsumedInput");
    if (ebUseInput) {
        ebUseInput.value = "1";
        ebUseInput.max = availQty;
    }

    const blanksInput = document.getElementById("blanksPerEndbitInput");
    if (blanksInput) blanksInput.value = "1";

    const availHint = document.getElementById("endbitAvailHint");
    if (availHint) availHint.textContent = `Max: ${availQty} Nos available`;

    const notesInput = document.getElementById("produceNotes");
    if (notesInput) notesInput.value = "";

    recalcProducePartTotals();

    const modal = document.getElementById("producePartModal");
    if (modal) modal.style.display = "flex";
}

function closeProducePartModal() {
    activeProduceEndbit = null;
    selectedProduceMasterPart = null;
    const modal = document.getElementById("producePartModal");
    if (modal) modal.style.display = "none";
}

/**
 * Autocomplete Part Search for End Bit Production
 */
async function searchPartsForProduceModal(query) {
    clearTimeout(produceSearchDebounceTimer);
    const dropdown = document.getElementById("producePartDropdown");
    if (!dropdown) return;

    const trimmed = (query || "").trim();
    if (trimmed.length < 1) {
        dropdown.style.display = "none";
        dropdown.innerHTML = "";
        return;
    }

    produceSearchDebounceTimer = setTimeout(async () => {
        try {
            const thick = activeProduceEndbit?.thickness || "";
            const grade = activeProduceEndbit?.grade || "";
            const res = await fetch(`/api/parts/search-blank?query=${encodeURIComponent(trimmed)}&thickness=${encodeURIComponent(thick)}&grade=${encodeURIComponent(grade)}`);
            if (res.ok) {
                const results = await res.json();
                renderProducePartDropdown(results);
            }
        } catch (e) {
            console.error("Part search error:", e);
        }
    }, 220);
}

function renderProducePartDropdown(parts) {
    const dropdown = document.getElementById("producePartDropdown");
    if (!dropdown) return;

    if (!parts || parts.length === 0) {
        dropdown.innerHTML = `<div class="part-dropdown-empty" style="padding: 10px 14px; color: #64748b; font-size: 0.85rem;"><i class="fa-solid fa-circle-question"></i> No master parts found. You can still type part # manually.</div>`;
        dropdown.style.display = "block";
        return;
    }

    dropdown.innerHTML = parts.map(p => {
        const blankStr = (p.cut_blank || (p.blank_length && p.blank_width ? `${p.blank_length}*${p.blank_width}*${p.thickness || ''}` : ""));
        return `
            <div class="part-dropdown-item" style="padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #f1f5f9;" onclick='selectPartForProduce(${JSON.stringify(p).replace(/'/g, "&#39;")})'>
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <strong style="color: #1e293b; font-size: 0.88rem;"><i class="fa-solid fa-shapes" style="color: #059669; margin-right: 6px;"></i>${escapeHtml(p.part_no)}</strong>
                    <small style="color: #64748b;">${escapeHtml(p.base_part || '')}</small>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 0.76rem; color: #64748b; margin-top: 3px;">
                    <span>Blank: <strong>${escapeHtml(blankStr || 'N/A')}</strong></span>
                    <span>Grade: ${escapeHtml(p.grade || 'YS')}</span>
                </div>
            </div>
        `;
    }).join("");
    dropdown.style.display = "block";
}

function selectPartForProduce(part) {
    selectedProduceMasterPart = part;
    const input = document.getElementById("producePartNoInput");
    if (input) input.value = part.part_no;

    const dropdown = document.getElementById("producePartDropdown");
    if (dropdown) dropdown.style.display = "none";

    // Dimensional fit analysis
    checkAndDisplayFitAnalysis(part);
    recalcProducePartTotals();
}

/**
 * Calculates whether the part blank fits into the end bit offcut
 */
function checkAndDisplayFitAnalysis(part) {
    const fitCard = document.getElementById("partFitCheckCard");
    const fitBadge = document.getElementById("fitStatusBadge");
    const fitDetails = document.getElementById("fitCheckDetails");
    const blanksInput = document.getElementById("blanksPerEndbitInput");

    if (!fitCard || !activeProduceEndbit) return;

    const ebLen = parseFloat(activeProduceEndbit.length) || 0;
    const ebWid = parseFloat(activeProduceEndbit.width) || 0;
    const ebThick = parseFloat(activeProduceEndbit.thickness) || 0;

    const pLen = parseFloat(part.blank_length) || 0;
    const pWid = parseFloat(part.blank_width) || 0;
    const pThick = parseFloat(part.thickness) || ebThick;

    if (ebLen <= 0 || ebWid <= 0 || pLen <= 0 || pWid <= 0) {
        fitCard.style.display = "none";
        return;
    }

    // Normal orientation (Length along length, width along width)
    const fit1 = Math.floor(ebLen / pLen) * Math.floor(ebWid / pWid);
    // Rotated 90 deg orientation
    const fit2 = Math.floor(ebLen / pWid) * Math.floor(ebWid / pLen);

    const maxBlanks = Math.max(fit1, fit2);
    const orientation = fit1 >= fit2 ? "Standard Orientation" : "Rotated 90° Orientation";

    fitCard.style.display = "block";

    if (maxBlanks > 0) {
        if (fitBadge) {
            fitBadge.className = "fit-status-badge fit-pass";
            fitBadge.innerHTML = `<i class="fa-solid fa-circle-check"></i> Compatible (${maxBlanks} Blank${maxBlanks > 1 ? 's' : ''}/piece)`;
        }
        if (fitDetails) {
            fitDetails.innerHTML = `
                <div class="fit-detail-row">
                    <span>End Bit Size:</span>
                    <strong>${ebLen} × ${ebWid} × ${ebThick} mm</strong>
                </div>
                <div class="fit-detail-row">
                    <span>Part Cut Blank:</span>
                    <strong>${pLen} × ${pWid} × ${pThick} mm</strong>
                </div>
                <div class="fit-detail-row" style="color: #059669;">
                    <span>Calculated Yield:</span>
                    <strong>${maxBlanks} blank(s) per offcut (${orientation})</strong>
                </div>
            `;
        }
        if (blanksInput) blanksInput.value = maxBlanks;
    } else {
        if (fitBadge) {
            fitBadge.className = "fit-status-badge fit-fail";
            fitBadge.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Size Warning`;
        }
        if (fitDetails) {
            fitDetails.innerHTML = `
                <div class="fit-detail-row">
                    <span>End Bit Size:</span>
                    <strong>${ebLen} × ${ebWid} × ${ebThick} mm</strong>
                </div>
                <div class="fit-detail-row">
                    <span>Part Cut Blank:</span>
                    <strong>${pLen} × ${pWid} × ${pThick} mm</strong>
                </div>
                <div class="fit-detail-row text-danger">
                    <span>Analysis:</span>
                    <strong>Part blank exceeds end bit dimensions! Cannot cut full blank without shearing adjustment.</strong>
                </div>
            `;
        }
        if (blanksInput) blanksInput.value = 1;
    }
}

function recalcProducePartTotals() {
    const ebUseInput = document.getElementById("endbitsConsumedInput");
    const blanksInput = document.getElementById("blanksPerEndbitInput");
    const displayVal = document.getElementById("totalProduceDisplay");
    const formulaHint = document.getElementById("totalProduceFormulaHint");
    const hiddenTotal = document.getElementById("partsProducedHidden");

    const maxAvail = activeProduceEndbit ? (activeProduceEndbit.available_qty !== undefined ? activeProduceEndbit.available_qty : activeProduceEndbit.initial_qty) : 1;
    
    let endbitsUsed = parseInt(ebUseInput?.value) || 1;
    if (endbitsUsed > maxAvail) {
        endbitsUsed = maxAvail;
        if (ebUseInput) ebUseInput.value = endbitsUsed;
    }
    if (endbitsUsed < 1) {
        endbitsUsed = 1;
        if (ebUseInput) ebUseInput.value = 1;
    }

    let blanksPerEb = parseInt(blanksInput?.value) || 1;
    if (blanksPerEb < 1) {
        blanksPerEb = 1;
        if (blanksInput) blanksInput.value = 1;
    }

    const totalParts = endbitsUsed * blanksPerEb;

    if (hiddenTotal) hiddenTotal.value = totalParts;
    if (displayVal) displayVal.textContent = `${totalParts.toLocaleString()} Units`;
    if (formulaHint) {
        formulaHint.textContent = `${endbitsUsed} end bit(s) × ${blanksPerEb} blank(s) per piece = ${totalParts.toLocaleString()} finished parts produced`;
    }
}

/**
 * Submits part production from end bit
 */
async function submitProducePart(e) {
    e.preventDefault();
    if (currentRole !== "shearing") {
        alert("Access Restricted: Only the Shearing Production team can produce parts or create Material Orders.");
        return;
    }
    if (!activeProduceEndbit) return;

    const partNo = document.getElementById("producePartNoInput")?.value?.trim();
    if (!partNo) {
        alert("Please enter or select a valid Part Number to produce.");
        return;
    }

    const endbitsUsed = parseInt(document.getElementById("endbitsConsumedInput")?.value) || 1;
    const blanksPerEb = parseInt(document.getElementById("blanksPerEndbitInput")?.value) || 1;
    const totalParts = parseInt(document.getElementById("partsProducedHidden")?.value) || (endbitsUsed * blanksPerEb);
    const notes = document.getElementById("produceNotes")?.value?.trim() || "";

    const submitBtn = document.getElementById("submitProduceBtn");
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Recording Production...`;
    }

    try {
        const payload = {
            part_no: partNo,
            endbits_used: endbitsUsed,
            blanks_per_endbit: blanksPerEb,
            total_parts_produced: totalParts,
            notes: notes,
            created_by: currentRole
        };

        const res = await fetch(`/api/endbits/${encodeURIComponent(activeProduceEndbit.endbit_id)}/produce-part`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Role": currentRole
            },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            const data = await res.json();
            alert(`🎉 Part Production Recorded Successfully!\n\n` +
                  `• Part Created: ${data.record.part_no}\n` +
                  `• Total Parts Produced: ${data.record.total_parts_produced} Nos\n` +
                  `• Cutting Order #: ${data.record.cutting_order_no}\n` +
                  `• End Bits Used: ${data.record.endbits_used} (Remaining: ${data.record.remaining_endbits} Nos)\n` +
                  `• Finished Goods Inventory: Updated in parts_fg_wip_stock`);

            closeProducePartModal();
            await loadEndbitsStoreData();
            await loadOrders();
            await loadStats();

            // If current view is DB table for endbits or erp_mo_reports, refresh it
            if (currentDbTable === "endbit_records" || currentDbTable === "erp_mo_reports") {
                loadDbTableData();
            }
        } else {
            const err = await res.json();
            alert(`Failed to record part production: ${err.error || 'Server error'}`);
        }
    } catch (err) {
        console.error("Produce part submit failed:", err);
        alert("Failed to submit part production. Check network connection.");
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<i class="fa-solid fa-check"></i> Produce Parts &amp; Update Stock`;
        }
    }
}

/* =========================================================================
   MANUAL END BIT ADDITION TO STORE INVENTORY
   ========================================================================= */

function openAddManualEndbitModal() {
    if (currentRole !== "shearing") {
        alert("Access Restricted: Only the Shearing Production team can add offcut end bits to the store.");
        return;
    }
    const modal = document.getElementById("addManualEndbitModal");
    if (!modal) return;

    const idInput = document.getElementById("manEbId");
    const nameInput = document.getElementById("manEbName");
    const thickInput = document.getElementById("manEbThickness");
    const lenInput = document.getElementById("manEbLength");
    const widInput = document.getElementById("manEbWidth");
    const qtyInput = document.getElementById("manEbQty");
    const gradeInput = document.getElementById("manEbGrade");
    const parentInput = document.getElementById("manEbParentPart");
    const notesInput = document.getElementById("manEbNotes");

    const genSuffix = Date.now().toString().slice(-6);
    if (idInput) idInput.value = `EB-MAN-${genSuffix}`;
    if (nameInput) nameInput.value = "End bit - Shop Floor Offcut";
    if (thickInput) thickInput.value = "4.8";
    if (lenInput) lenInput.value = "";
    if (widInput) widInput.value = "";
    if (qtyInput) qtyInput.value = "1";
    if (gradeInput) gradeInput.value = "YS";
    if (parentInput) parentInput.value = "";
    if (notesInput) notesInput.value = "";

    calculateManualEbWeight();
    modal.style.display = "flex";
}

function closeAddManualEndbitModal() {
    const modal = document.getElementById("addManualEndbitModal");
    if (modal) modal.style.display = "none";
}

function calculateManualEbWeight() {
    const thick = parseFloat(document.getElementById("manEbThickness")?.value) || 0;
    const len = parseFloat(document.getElementById("manEbLength")?.value) || 0;
    const wid = parseFloat(document.getElementById("manEbWidth")?.value) || 0;
    const qty = parseInt(document.getElementById("manEbQty")?.value) || 1;

    const dimPreview = document.getElementById("manEbDimPreview");
    const weightPreview = document.getElementById("manEbWeightPreview");

    if (dimPreview) {
        dimPreview.textContent = `${thick} * ${len} * ${wid} mm`;
    }

    const volume = len * wid * thick; // mm3
    const weightKg = (volume > 0) ? Math.round(volume * 7.85e-6 * qty * 100) / 100 : 0;

    if (weightPreview) {
        weightPreview.textContent = `Est. Weight: ~${weightKg} kg (${qty} Nos)`;
    }
}

async function submitAddManualEndbit(e) {
    e.preventDefault();
    const form = document.getElementById("addManualEndbitForm");
    if (!form) return;

    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());

    const submitBtn = document.getElementById("submitAddManualEbBtn");
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Saving to Store...`;
    }

    try {
        const res = await fetch("/api/endbits/manual-add", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Role": currentRole
            },
            body: JSON.stringify(data)
        });

        if (res.ok) {
            const eb = await res.json();
            alert(`🎉 End Bit Successfully Recorded into Store!\n\n` +
                  `• ID: ${eb.endbit_id}\n` +
                  `• Name: ${eb.name}\n` +
                  `• Dimensions: ${eb.dim} mm\n` +
                  `• Available Stock: ${eb.available_qty} Nos\n` +
                  `• Location: ${eb.storage_location || 'Main Store'}\n\n` +
                  `This offcut is now active and immediately available for part shearing and AI optimization!`);

            closeAddManualEndbitModal();
            await loadEndbitsStoreData();
            await loadStats();

            // Refresh dropdown in Create End Bit MO page if present
            if (typeof populateEbMoDropdown === "function") {
                await populateEbMoDropdown();
            }
        } else {
            const err = await res.json();
            alert(`Failed to save manual end bit: ${err.error || 'Server error'}`);
        }
    } catch (err) {
        console.error("Manual end bit submission failed:", err);
        alert("Failed to submit manual end bit. Please check network connection.");
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save End Bit to Store`;
        }
    }
}

/* =========================================================================
   CREATE MATERIAL ORDER FOR END BITS (MANUAL OFFCUT SHEARING - NO LAYOUTS)
   ========================================================================= */

let ebPartSearchDebounceTimer = null;
let currentSelectedEndbit = null;

async function populateEbMoDropdown(preselectedId = null) {
    const select = document.getElementById("ebMoSelect");
    const chipsGrid = document.getElementById("ebQuickChipsGrid");
    if (!select) return;

    try {
        const res = await fetch("/api/endbits");
        if (res.ok) {
            allEndbits = await res.json();
        }
    } catch (e) {
        console.error("Failed to fetch endbits:", e);
    }

    // Build select options
    select.innerHTML = `
        <option value="">-- Choose an End Bit Offcut --</option>
        <option value="__manual__">➕ Manual / Shop Floor Offcut (Enter Dimensions Manually)</option>
    `;

    const availableEndbits = (allEndbits || []).filter(e => (e.available_qty || 0) > 0);

    if (availableEndbits.length > 0) {
        const group = document.createElement("optgroup");
        group.label = `Available End Bits in Store (${availableEndbits.length})`;

        availableEndbits.forEach(eb => {
            const opt = document.createElement("option");
            opt.value = eb.endbit_id;
            const dimStr = eb.dimensions || eb.dim || `${eb.thickness}*${eb.length}*${eb.width}`;
            opt.textContent = `[${eb.name || 'End bit'}] ${eb.endbit_id} • ${dimStr} mm`;
            opt.dataset.record = JSON.stringify(eb);
            group.appendChild(opt);
        });
        select.appendChild(group);
    }

    // Build Quick Pick Chips
    if (chipsGrid) {
        if (availableEndbits.length === 0) {
            chipsGrid.innerHTML = `<span class="text-muted" style="font-size: 0.8rem; padding: 4px 8px;">No offcuts in store. Choose "Manual Offcut" above.</span>`;
        } else {
            chipsGrid.innerHTML = availableEndbits.map(eb => {
                const isSelected = preselectedId === eb.endbit_id;
                return `
                    <button type="button" class="eb-chip-btn ${isSelected ? 'active' : ''}" onclick="selectEbFromChip('${escapeHtml(eb.endbit_id)}')" style="background: ${isSelected ? '#0284c7' : '#f1f5f9'}; color: ${isSelected ? '#fff' : '#334155'}; border: 1px solid ${isSelected ? '#0284c7' : '#cbd5e1'}; padding: 5px 10px; border-radius: 6px; font-size: 0.8rem; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
                        <i class="fa-solid fa-scissors"></i>
                        <strong>${escapeHtml(eb.name || 'End bit')}</strong>
                    </button>
                `;
            }).join("");
        }
    }

    resetEbMoForm();
    if (preselectedId) {
        select.value = preselectedId;
        onEbMoSelectionChanged(preselectedId);
    }
}

function selectEbFromChip(ebId) {
    const select = document.getElementById("ebMoSelect");
    if (select) {
        select.value = ebId;
        onEbMoSelectionChanged(ebId);
    }
    const chips = document.querySelectorAll(".eb-chip-btn");
    chips.forEach(c => {
        c.style.background = "#f1f5f9";
        c.style.color = "#334155";
    });
    if (window.event && window.event.currentTarget) {
        window.event.currentTarget.style.background = "#0284c7";
        window.event.currentTarget.style.color = "#fff";
    }
}

let ebPartRowCounter = 0;

function resetEbMoForm() {
    currentSelectedEndbit = null;
    ebPartRowCounter = 0;

    const thick = document.getElementById("ebThickness");
    const offLen = document.getElementById("ebOffcutLength");
    const offWid = document.getElementById("ebOffcutWidth");
    const offDisp = document.getElementById("ebOffcutSizeDisplay");
    const grade = document.getElementById("ebGradeInput");
    const used = document.getElementById("ebEndbitsUsed");
    const select = document.getElementById("ebMoSelect");
    const remarks = document.getElementById("ebRemarks");
    const partsContainer = document.getElementById("ebPartsContainer");
    const badgeTop = document.getElementById("ebAvailBadgeTop");
    const stockHint = document.getElementById("ebAvailStockHint");

    if (thick) thick.value = "4.8";
    if (offLen) offLen.value = "";
    if (offWid) offWid.value = "";
    if (offDisp) offDisp.value = "";
    if (grade) grade.value = "YS";
    if (used) { used.value = "1"; used.removeAttribute("max"); }
    if (select) select.value = "";
    if (remarks) remarks.value = "";
    if (badgeTop) badgeTop.style.display = "none";
    if (stockHint) stockHint.style.display = "none";

    if (partsContainer) {
        partsContainer.innerHTML = "";
        // Always initialize with 1 clean part row
        addEbPartRow();
    }
}

function parseDimString(str, contextThickness = null) {
    if (!str) return { t: 0, l: 0, w: 0 };
    const parts = str.toString().toLowerCase().replace(/mm/g, "").replace(/[xX*×]/g, " ").trim().split(/\s+/).map(Number).filter(n => !isNaN(n) && n > 0);
    const ctxT = (contextThickness !== null && !isNaN(Number(contextThickness)) && Number(contextThickness) > 0) ? Number(contextThickness) : 0;

    if (parts.length >= 3) {
        let tIdx = -1;
        // 1. If context thickness matches one of the values closely (within 0.05mm)
        if (ctxT > 0) {
            tIdx = parts.slice(0, 3).findIndex(p => Math.abs(p - ctxT) < 0.05);
        }
        // 2. Otherwise in sheet metal fabrication, thickness is the smallest value (<= 35mm)
        if (tIdx === -1) {
            let minVal = Infinity;
            let minIdx = 0;
            parts.slice(0, 3).forEach((p, idx) => {
                if (p < minVal) {
                    minVal = p;
                    minIdx = idx;
                }
            });
            tIdx = minIdx;
        }

        const t = parts[tIdx];
        const planar = parts.slice(0, 3).filter((_, idx) => idx !== tIdx);
        const l = Math.max(planar[0] || 0, planar[1] || 0);
        const w = Math.min(planar[0] || 0, planar[1] || 0);
        return { t, l, w };

    } else if (parts.length === 2) {
        const l = Math.max(parts[0], parts[1]);
        const w = Math.min(parts[0], parts[1]);
        return { t: ctxT, l, w };
    } else if (parts.length === 1) {
        return { t: ctxT, l: parts[0], w: 0 };
    }
    return { t: 0, l: 0, w: 0 };
}

function onEbOffcutSizeInput(val) {
    const thickEl = document.getElementById("ebThickness");
    const ctxT = thickEl ? parseFloat(thickEl.value) : 0;
    const d = parseDimString(val, ctxT);
    if (d.t > 0 && thickEl) {
        thickEl.value = d.t;
    }
    if (d.l > 0) {
        const l = document.getElementById("ebOffcutLength");
        if (l) l.value = d.l;
    }
    if (d.w > 0) {
        const w = document.getElementById("ebOffcutWidth");
        if (w) w.value = d.w;
    }
    recalculateAllEbTotals();
}

function onEbMoSelectionChanged(val) {
    const badgeTop = document.getElementById("ebAvailBadgeTop");
    const stockVal = document.getElementById("ebAvailStockVal");
    const stockHint = document.getElementById("ebAvailStockHint");
    const used = document.getElementById("ebEndbitsUsed");

    if (!val || val === "__manual__") {
        currentSelectedEndbit = null;
        if (badgeTop) {
            badgeTop.style.display = val === "__manual__" ? "inline-flex" : "none";
            badgeTop.style.background = "#f8fafc";
            badgeTop.style.borderColor = "#cbd5e1";
            badgeTop.style.color = "#475569";
            if (stockVal) stockVal.textContent = "Manual Offcut";
        }
        if (stockHint) stockHint.style.display = "none";
        if (used) used.removeAttribute("max");
        return;
    }

    const eb = (allEndbits || []).find(e => e.endbit_id === val);
    if (!eb) return;

    currentSelectedEndbit = eb;

    const thickInput = document.getElementById("ebThickness");
    if (thickInput && eb.thickness) thickInput.value = eb.thickness;

    const offLen = document.getElementById("ebOffcutLength");
    if (offLen && eb.length) offLen.value = eb.length;

    const offWid = document.getElementById("ebOffcutWidth");
    if (offWid && eb.width) offWid.value = eb.width;

    const offDisp = document.getElementById("ebOffcutSizeDisplay");
    if (offDisp) {
        const dimStr = eb.dimensions || eb.dim || `${eb.thickness}*${eb.length}*${eb.width}`;
        offDisp.value = dimStr;
    }

    const gradeInput = document.getElementById("ebGradeInput");
    if (gradeInput && eb.grade) gradeInput.value = eb.grade;

    if (used) {
        used.value = "1";
        used.max = eb.available_qty || 1;
    }
    if (badgeTop && stockVal) {
        badgeTop.style.display = "inline-flex";
        badgeTop.style.background = "#ecfdf5";
        badgeTop.style.borderColor = "#6ee7b7";
        badgeTop.style.color = "#047857";
        stockVal.textContent = `${eb.available_qty} Nos`;
    }
    if (stockHint) {
        stockHint.style.display = "inline-block";
        stockHint.textContent = `Max: ${eb.available_qty} Nos`;
    }

    recalculateAllEbTotals();
}

/* =========================================================================
   DYNAMIC PARTS HANDLING: ADD PART, SEARCH, SIZE, QUANTITY, YIELD
   ========================================================================= */

function addEbPartRow(defaultPart = null) {
    ebPartRowCounter++;
    const rowId = ebPartRowCounter;
    const container = document.getElementById("ebPartsContainer");
    if (!container) return;

    const row = document.createElement("div");
    row.className = "eb-part-card-row";
    row.id = `ebPartRow_${rowId}`;
    row.dataset.rowId = rowId;

    row.innerHTML = `
        <div class="form-group relative">
            <label>Part Number <span class="required">*</span></label>
            <div class="part-search-input-wrap">
                <i class="fa-solid fa-shapes"></i>
                <input type="text" class="eb-part-no" id="ebPartNo_${rowId}" placeholder="Search or type part #..." autocomplete="off" required oninput="onEbPartRowSearch(this, ${rowId})">
                <div class="part-dropdown-results eb-row-dropdown" id="ebDropdown_${rowId}" style="display: none;"></div>
            </div>
            <input type="hidden" class="eb-base-part" id="ebBasePart_${rowId}" value="">
        </div>
        <div class="form-group">
            <label>Part Size (T*L*W) <span class="required">*</span></label>
            <input type="text" class="eb-part-size" id="ebPartSize_${rowId}" placeholder="e.g. 4.8*200*6" required oninput="onEbPartRowSizeInput(this, ${rowId})">
            <input type="hidden" class="eb-cut-len" id="ebCutLen_${rowId}" value="">
            <input type="hidden" class="eb-cut-wid" id="ebCutWid_${rowId}" value="">
            <input type="hidden" class="eb-thickness" id="ebThick_${rowId}" value="4.8">
        </div>
        <div class="form-group">
            <label>No. of Parts <span class="required">*</span></label>
            <input type="number" min="1" step="1" value="1" class="eb-part-qty" id="ebPartQty_${rowId}" required oninput="recalculateAllEbTotals()">
        </div>
        <div class="form-group">
            <label><i class="fa-solid fa-chart-pie"></i> Yield %</label>
            <input type="text" readonly class="eb-part-yield" id="ebPartYield_${rowId}" placeholder="Auto" style="font-weight: 700; color: #059669; background: #fff !important;">
        </div>
        <div style="display: flex; align-items: flex-end;">
            <button type="button" class="btn-remove-eb-part" onclick="removeEbPartRow(${rowId})" title="Remove this part">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        </div>
        <div class="eb-agent-feedback-bar" id="ebAgentFeedback_${rowId}" style="grid-column: 1 / -1; display: none; margin-top: 4px;"></div>
    `;

    container.appendChild(row);

    if (defaultPart) {
        onSelectEbRowPart(rowId, defaultPart);
    }

    updateRemoveButtonsVisibility();
    recalculateAllEbTotals();
}

function removeEbPartRow(rowId) {
    const row = document.getElementById(`ebPartRow_${rowId}`);
    if (row) {
        row.remove();
        updateRemoveButtonsVisibility();
        recalculateAllEbTotals();
    }
}

function updateRemoveButtonsVisibility() {
    const rows = document.querySelectorAll(".eb-part-card-row");
    rows.forEach(r => {
        const btn = r.querySelector(".btn-remove-eb-part");
        if (btn) {
            btn.style.display = rows.length > 1 ? "inline-flex" : "none";
        }
    });
}

function onEbPartRowSearch(inputEl, rowId) {
    clearTimeout(ebPartSearchDebounceTimer);
    const dropdown = document.getElementById(`ebDropdown_${rowId}`);
    if (!dropdown) return;

    const trimmed = (inputEl.value || "").trim();
    if (trimmed.length < 1) {
        dropdown.style.display = "none";
        dropdown.innerHTML = "";
        return;
    }

    ebPartSearchDebounceTimer = setTimeout(async () => {
        try {
            const thick = document.getElementById("ebThickness")?.value || "";
            const grade = document.getElementById("ebGradeInput")?.value || "";
            const res = await fetch(`/api/parts/search-blank?query=${encodeURIComponent(trimmed)}&thickness=${encodeURIComponent(thick)}&grade=${encodeURIComponent(grade)}`);
            if (res.ok) {
                const results = await res.json();
                renderEbRowDropdown(results, rowId);
            }
        } catch (e) {
            console.error("Part lookup error:", e);
        }
    }, 200);
}

function renderEbRowDropdown(parts, rowId) {
    const dropdown = document.getElementById(`ebDropdown_${rowId}`);
    if (!dropdown) return;

    if (!parts || parts.length === 0) {
        dropdown.innerHTML = `<div class="part-dropdown-empty" style="padding: 8px 12px; color: #64748b; font-size: 0.82rem;"><i class="fa-solid fa-circle-question"></i> No master part found. Continue typing custom part #.</div>`;
        dropdown.style.display = "block";
        return;
    }

    dropdown.innerHTML = parts.map(p => {
        const blankStr = (p.cut_blank || (p.blank_length && p.blank_width ? `${p.thickness || 4.8}*${p.blank_length}*${p.blank_width}` : ""));
        return `
            <div class="part-dropdown-item" style="padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #f1f5f9;" onclick='onSelectEbRowPart(${rowId}, ${JSON.stringify(p).replace(/'/g, "&#39;")})'>
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <strong style="color: #1e293b; font-size: 0.85rem;"><i class="fa-solid fa-shapes" style="color: #0284c7; margin-right: 5px;"></i>${escapeHtml(p.part_no)}</strong>
                    <small style="color: #64748b;">${escapeHtml(p.base_part || '')}</small>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 0.74rem; color: #64748b; margin-top: 2px;">
                    <span>Size: <strong>${escapeHtml(blankStr || 'N/A')}</strong></span>
                    <span>Grade: ${escapeHtml(p.grade || 'YS')}</span>
                </div>
            </div>
        `;
    }).join("");
    dropdown.style.display = "block";
}

function onSelectEbRowPart(rowId, part) {
    const pInput = document.getElementById(`ebPartNo_${rowId}`);
    if (pInput) pInput.value = part.part_no;

    const bInput = document.getElementById(`ebBasePart_${rowId}`);
    if (bInput) bInput.value = part.base_part || part.part_no.split(" - ")[0];

    const sizeInput = document.getElementById(`ebPartSize_${rowId}`);
    const cutLenInput = document.getElementById(`ebCutLen_${rowId}`);
    const cutWidInput = document.getElementById(`ebCutWid_${rowId}`);
    const thickInput = document.getElementById(`ebThick_${rowId}`);

    const tVal = part.thickness || document.getElementById("ebThickness")?.value || 4.8;
    const lVal = part.blank_length || "";
    const wVal = part.blank_width || "";

    if (cutLenInput) cutLenInput.value = lVal;
    if (cutWidInput) cutWidInput.value = wVal;
    if (thickInput) thickInput.value = tVal;
    if (sizeInput) sizeInput.value = `${tVal}*${lVal}*${wVal}`;

    const dropdown = document.getElementById(`ebDropdown_${rowId}`);
    if (dropdown) dropdown.style.display = "none";

    // Set grade on main end bit if empty or YS
    const gradeInput = document.getElementById("ebGradeInput");
    if (gradeInput && (!gradeInput.value || gradeInput.value === "YS") && part.grade) {
        gradeInput.value = part.grade;
    }

    recalculateAllEbTotals();
}

function onEbPartRowSizeInput(inputEl, rowId) {
    const thickInput = document.getElementById(`ebThick_${rowId}`);
    const ebThickVal = parseFloat(document.getElementById("ebThickness")?.value) || parseFloat(thickInput?.value) || 0;
    const d = parseDimString(inputEl.value, ebThickVal);
    const cutLenInput = document.getElementById(`ebCutLen_${rowId}`);
    const cutWidInput = document.getElementById(`ebCutWid_${rowId}`);

    if (d.t > 0 && thickInput) thickInput.value = d.t;
    if (d.l > 0 && cutLenInput) cutLenInput.value = d.l;
    if (d.w > 0 && cutWidInput) cutWidInput.value = d.w;

    checkRowEbCapacity(rowId, false);
    recalculateAllEbTotals();
}

function checkRowEbCapacity(rowId, autoApply = false) {
    const feedbackEl = document.getElementById(`ebAgentFeedback_${rowId}`);
    const sizeInput = document.getElementById(`ebPartSize_${rowId}`);
    const qtyInput = document.getElementById(`ebPartQty_${rowId}`);
    const yieldInput = document.getElementById(`ebPartYield_${rowId}`);

    const endbitsUsedInput = document.getElementById("ebEndbitsUsed");
    const endbitsCount = Math.max(1, parseInt(endbitsUsedInput?.value) || 1);

    let offLen = parseFloat(document.getElementById("ebOffcutLength")?.value) || 0;
    let offWid = parseFloat(document.getElementById("ebOffcutWidth")?.value) || 0;

    let cutLen = parseFloat(document.getElementById(`ebCutLen_${rowId}`)?.value) || 0;
    let cutWid = parseFloat(document.getElementById(`ebCutWid_${rowId}`)?.value) || 0;

    if ((cutLen === 0 || cutWid === 0) && sizeInput && sizeInput.value) {
        const rowThick = parseFloat(document.getElementById(`ebThick_${rowId}`)?.value) || parseFloat(document.getElementById("ebThickness")?.value) || 0;
        const d = parseDimString(sizeInput.value, rowThick);
        if (d.l > 0) cutLen = d.l;
        if (d.w > 0) cutWid = d.w;
    }

    if (!feedbackEl) return { fits: true, exceeds: false, maxParts: 0, partsPerEb: 0, hasShortage: false };

    if (offLen <= 0 || offWid <= 0 || cutLen <= 0 || cutWid <= 0) {
        feedbackEl.style.display = "none";
        feedbackEl.innerHTML = "";
        if (sizeInput) {
            sizeInput.style.borderColor = "";
            sizeInput.style.backgroundColor = "";
        }
        if (qtyInput) {
            qtyInput.style.borderColor = "";
            qtyInput.style.backgroundColor = "";
        }
        return { fits: true, exceeds: false, maxParts: 0, partsPerEb: 0, hasShortage: false };
    }

    const ebMax = Math.max(offLen, offWid);
    const ebMin = Math.min(offLen, offWid);
    const bMax = Math.max(cutLen, cutWid);
    const bMin = Math.min(cutLen, cutWid);

    // Physical Boundary Check: Does blank exceed end-bit dimensions?
    if (bMax > ebMax || bMin > ebMin) {
        feedbackEl.style.display = "block";
        feedbackEl.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; background: #fef2f2; border: 1.5px solid #f87171; border-radius: 6px; padding: 6px 12px; font-size: 0.78rem; color: #991b1b;">
                <div style="display: flex; align-items: center; gap: 6px;">
                    <i class="fa-solid fa-triangle-exclamation" style="color: #dc2626; font-size: 0.95rem;"></i>
                    <span><strong>Exceeds End-Bit Size:</strong> Blank (${bMax} × ${bMin} mm) exceeds offcut plate (${ebMax} × ${ebMin} mm). <strong>0 parts producible.</strong></span>
                </div>
                <span style="font-weight: 700; color: #dc2626; font-size: 0.75rem; background: #fee2e2; padding: 2px 8px; border-radius: 4px;">Boundary Error</span>
            </div>
        `;
        if (sizeInput) {
            sizeInput.style.borderColor = "#ef4444";
            sizeInput.style.backgroundColor = "#fff5f5";
        }
        if (qtyInput) {
            qtyInput.style.borderColor = "#ef4444";
            qtyInput.style.backgroundColor = "#fff5f5";
        }
        if (yieldInput) {
            yieldInput.value = "0%";
            yieldInput.style.color = "#dc2626";
        }
        return { fits: false, exceeds: true, maxParts: 0, partsPerEb: 0, hasShortage: true };
    }

    // Blank fits within end-bit plate!
    if (sizeInput) {
        sizeInput.style.borderColor = "#10b981";
        sizeInput.style.backgroundColor = "#f0fdf4";
    }

    const opt1 = Math.floor(ebMax / bMax) * Math.floor(ebMin / bMin);
    const opt2 = Math.floor(ebMax / bMin) * Math.floor(ebMin / bMax);
    const partsPerEb = Math.max(opt1, opt2, 1);
    const totalMaxParts = partsPerEb * endbitsCount;
    const totalPlateArea = offLen * offWid * endbitsCount;
    const maxCapacityYield = Math.min(100, Math.round(((totalMaxParts * cutLen * cutWid) / totalPlateArea) * 1000) / 10);

    let enteredQty = Math.max(1, parseInt(qtyInput?.value) || 1);

    if (autoApply) {
        enteredQty = totalMaxParts;
        if (qtyInput) {
            qtyInput.value = totalMaxParts;
            qtyInput.style.borderColor = "";
            qtyInput.style.backgroundColor = "";
        }
        if (yieldInput) {
            yieldInput.value = `${maxCapacityYield}%`;
            yieldInput.style.color = "#059669";
        }
    }

    const hasCapacityShortage = enteredQty > totalMaxParts;
    feedbackEl.style.display = "block";

    if (hasCapacityShortage) {
        const shortage = enteredQty - totalMaxParts;
        const neededEbs = Math.ceil(enteredQty / partsPerEb);

        if (qtyInput) {
            qtyInput.style.borderColor = "#ef4444";
            qtyInput.style.backgroundColor = "#fff1f2";
            qtyInput.title = `Entered ${enteredQty} parts exceeds capacity of ${totalMaxParts} parts from ${endbitsCount} selected end-bit(s).`;
        }
        if (yieldInput) {
            yieldInput.value = "Exceeds RM";
            yieldInput.style.color = "#dc2626";
        }

        feedbackEl.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; background: #fff1f2; border: 1.5px solid #f87171; border-radius: 6px; padding: 6px 12px; font-size: 0.78rem; color: #991b1b; gap: 8px;">
                <div style="display: flex; align-items: flex-start; gap: 8px;">
                    <i class="fa-solid fa-triangle-exclamation" style="color: #dc2626; font-size: 1.1rem; margin-top: 2px;"></i>
                    <div>
                        <span style="font-weight: 700; color: #b91c1c;">⚠️ RM Shortfall (${enteredQty} requested vs ${totalMaxParts} max capacity):</span>
                        <span style="display: block; margin-top: 2px;">${endbitsCount} selected end-bit(s) can only produce <strong>${totalMaxParts} parts</strong> (${partsPerEb} blanks/plate).</span>
                        <span style="display: block; font-size: 0.74rem; color: #7f1d1d; margin-top: 2px;">
                            Deficit of <strong>${shortage} parts</strong>. Need at least <strong>${neededEbs} end-bits</strong> to produce ${enteredQty} parts.
                        </span>
                    </div>
                </div>
                <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
                    <button type="button" class="btn btn-danger btn-xs" onclick="applyEbAgentParts(${rowId}, ${totalMaxParts}, '${maxCapacityYield}%')" style="padding: 4px 10px; font-size: 0.73rem; font-weight: 700; border-radius: 4px; background: #dc2626; border-color: #dc2626; color: #fff; cursor: pointer;">
                        <i class="fa-solid fa-compress"></i> Cap to ${totalMaxParts} Parts
                    </button>
                </div>
            </div>
        `;
    } else {
        if (qtyInput) {
            qtyInput.style.borderColor = "";
            qtyInput.style.backgroundColor = "";
            qtyInput.title = "";
        }
        const requestedPartYield = Math.min(100, Math.round(((enteredQty * cutLen * cutWid) / totalPlateArea) * 1000) / 10);
        if (yieldInput && !autoApply) {
            yieldInput.value = `${requestedPartYield}%`;
            yieldInput.style.color = "#059669";
        }

        feedbackEl.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; background: #f0fdf4; border: 1px solid #86efac; border-radius: 6px; padding: 5px 10px; font-size: 0.78rem; color: #166534;">
                <div style="display: flex; align-items: center; gap: 6px;">
                    <i class="fa-solid fa-calculator" style="color: #16a34a;"></i>
                    <span><strong>Agent Pro-Rata Capacity:</strong> Fits <strong>${partsPerEb} blanks/endbit</strong> × <strong>${endbitsCount} endbits</strong> = <strong style="color: #15803d; font-size: 0.88rem;">${totalMaxParts} Max Parts</strong> (${maxCapacityYield}% Max Yield)</span>
                </div>
                <button type="button" class="btn btn-primary btn-xs" onclick="applyEbAgentParts(${rowId}, ${totalMaxParts}, '${maxCapacityYield}%')" style="padding: 2px 8px; font-size: 0.72rem; font-weight: 600; border-radius: 4px; background: #0284c7; border-color: #0284c7; color: #fff; cursor: pointer;">
                    <i class="fa-solid fa-check"></i> ${enteredQty === totalMaxParts ? 'Optimal Capacity' : `Set to ${totalMaxParts} Max`}
                </button>
            </div>
        `;
    }

    return { 
        fits: true, 
        exceeds: false, 
        maxParts: totalMaxParts, 
        partsPerEb: partsPerEb, 
        yieldVal: maxCapacityYield, 
        hasShortage: hasCapacityShortage,
        enteredQty: enteredQty
    };
}

function applyEbAgentParts(rowId, maxParts, yieldStr) {
    const qtyInput = document.getElementById(`ebPartQty_${rowId}`);
    const yieldInput = document.getElementById(`ebPartYield_${rowId}`);
    if (qtyInput) {
        qtyInput.value = maxParts;
        qtyInput.style.borderColor = "";
        qtyInput.style.backgroundColor = "";
    }
    if (yieldInput) {
        yieldInput.value = yieldStr;
        yieldInput.style.color = "#059669";
    }
    recalculateAllEbTotals();
}

function runEbCapacityAgentForAllRows() {
    const rows = document.querySelectorAll(".eb-part-card-row");
    let anyExceeded = false;
    rows.forEach(r => {
        const rowId = r.dataset.rowId;
        const res = checkRowEbCapacity(rowId, true);
        if (res.exceeds) anyExceeded = true;
    });
    recalculateAllEbTotals();
    if (anyExceeded) {
        alert("⚠️ Notice: One or more part blanks exceed the selected end-bit dimensions and cannot be cut from this offcut.");
    }
}

function recalculateAllEbTotals() {
    const endbitsUsedInput = document.getElementById("ebEndbitsUsed");
    let endbitsCount = parseInt(endbitsUsedInput?.value) || 1;

    if (currentSelectedEndbit && currentSelectedEndbit.available_qty) {
        if (endbitsCount > currentSelectedEndbit.available_qty) {
            endbitsCount = currentSelectedEndbit.available_qty;
            if (endbitsUsedInput) endbitsUsedInput.value = endbitsCount;
        }
    }
    if (endbitsCount < 1) {
        endbitsCount = 1;
        if (endbitsUsedInput) endbitsUsedInput.value = 1;
    }

    const offLen = parseFloat(document.getElementById("ebOffcutLength")?.value) || 0;
    const offWid = parseFloat(document.getElementById("ebOffcutWidth")?.value) || 0;
    const totalOffcutArea = (offLen > 0 && offWid > 0) ? (offLen * offWid * endbitsCount) : 0;

    const rows = document.querySelectorAll(".eb-part-card-row");
    let grandTotalParts = 0;
    let grandTotalCutArea = 0;
    let anyShortage = false;
    let anyBoundaryError = false;
    let totalMaxProducible = 0;

    rows.forEach(row => {
        const rowId = row.dataset.rowId;
        const qtyInput = document.getElementById(`ebPartQty_${rowId}`);
        const sizeInput = document.getElementById(`ebPartSize_${rowId}`);
        let cutLen = parseFloat(document.getElementById(`ebCutLen_${rowId}`)?.value) || 0;
        let cutWid = parseFloat(document.getElementById(`ebCutWid_${rowId}`)?.value) || 0;

        if ((cutLen === 0 || cutWid === 0) && sizeInput && sizeInput.value) {
            const rowThick = parseFloat(document.getElementById(`ebThick_${rowId}`)?.value) || parseFloat(document.getElementById("ebThickness")?.value) || 0;
            const d = parseDimString(sizeInput.value, rowThick);
            if (d.l > 0) cutLen = d.l;
            if (d.w > 0) cutWid = d.w;
        }

        const capRes = checkRowEbCapacity(rowId, false);
        if (capRes.exceeds) anyBoundaryError = true;
        if (capRes.hasShortage) anyShortage = true;
        totalMaxProducible += (capRes.maxParts || 0);

        const qty = Math.max(1, parseInt(qtyInput?.value) || 1);
        grandTotalParts += qty;

        const partArea = cutLen * cutWid * qty;
        grandTotalCutArea += partArea;
    });

    if (totalOffcutArea > 0 && grandTotalCutArea > totalOffcutArea) {
        anyShortage = true;
    }

    // Update grand totals
    const totalOutputDisplay = document.getElementById("ebTotalOutputDisplay");
    const targetHidden = document.getElementById("ebTargetQtyInput");
    const totalYieldDisplay = document.getElementById("ebTotalYieldDisplay");
    const yieldHidden = document.getElementById("ebYieldInput");
    const summaryStrip = document.querySelector(".eb-parts-summary-strip");

    if (targetHidden) targetHidden.value = grandTotalParts;

    if (anyBoundaryError) {
        if (summaryStrip) {
            summaryStrip.style.background = "#fff1f2";
            summaryStrip.style.borderColor = "#f87171";
        }
        if (totalOutputDisplay) totalOutputDisplay.innerHTML = `<span style="color: #dc2626; font-weight: 700;">0 Units</span> <small style="color: #dc2626; font-weight: 700;">(Boundary Error)</small>`;
        if (totalYieldDisplay) totalYieldDisplay.innerHTML = `<span style="color: #dc2626; font-weight: 700; background: #fee2e2; padding: 2px 8px; border-radius: 4px; font-size: 0.82rem;">0% (Invalid Blank)</span>`;
        if (yieldHidden) yieldHidden.value = "0%";
    } else if (anyShortage) {
        if (summaryStrip) {
            summaryStrip.style.background = "#fff1f2";
            summaryStrip.style.borderColor = "#f87171";
        }
        if (totalOutputDisplay) {
            totalOutputDisplay.innerHTML = `<span style="color: #dc2626; font-weight: 700;">${grandTotalParts.toLocaleString()} Units</span> <small style="color: #b91c1c; font-weight: 600; font-size: 0.78rem;">(⚠️ Deficit: Max ${totalMaxProducible} producible)</small>`;
        }
        if (totalYieldDisplay) {
            totalYieldDisplay.innerHTML = `<span style="color: #dc2626; font-weight: 700; background: #fee2e2; padding: 2px 8px; border-radius: 4px; font-size: 0.82rem;">⚠️ Exceeds RM (Shortage)</span>`;
        }
        if (yieldHidden) yieldHidden.value = "";
    } else if (totalOffcutArea > 0 && grandTotalCutArea > 0) {
        if (summaryStrip) {
            summaryStrip.style.background = "#f0fdf4";
            summaryStrip.style.borderColor = "#86efac";
        }
        const totalYieldVal = Math.min(100, Math.round((grandTotalCutArea / totalOffcutArea) * 1000) / 10);
        if (totalOutputDisplay) totalOutputDisplay.textContent = `${grandTotalParts.toLocaleString()} Units`;
        if (totalYieldDisplay) totalYieldDisplay.innerHTML = `<span style="color: #059669; font-weight: 700;">${totalYieldVal}%</span>`;
        if (yieldHidden) yieldHidden.value = `${totalYieldVal}%`;
    } else {
        if (summaryStrip) {
            summaryStrip.style.background = "#f0fdf4";
            summaryStrip.style.borderColor = "#86efac";
        }
        if (totalOutputDisplay) totalOutputDisplay.textContent = "0 Units";
        if (totalYieldDisplay) totalYieldDisplay.textContent = "0%";
        if (yieldHidden) yieldHidden.value = "";
    }
}

async function submitCreateEndbitMo(e) {
    e.preventDefault();
    if (currentRole !== "shearing") {
        alert("Access Restricted: Only the Shearing Production team can create Material Orders.");
        return;
    }

    // Collect all valid parts from dynamic rows
    const rows = document.querySelectorAll(".eb-part-card-row");
    const parts = [];

    rows.forEach(row => {
        const rowId = row.dataset.rowId;
        const pNo = document.getElementById(`ebPartNo_${rowId}`)?.value?.trim();
        const bPart = document.getElementById(`ebBasePart_${rowId}`)?.value?.trim() || (pNo ? pNo.split(" - ")[0] : "");
        const pSize = document.getElementById(`ebPartSize_${rowId}`)?.value?.trim();
        const cutLen = parseFloat(document.getElementById(`ebCutLen_${rowId}`)?.value) || 0;
        const cutWid = parseFloat(document.getElementById(`ebCutWid_${rowId}`)?.value) || 0;
        const thick = parseFloat(document.getElementById(`ebThick_${rowId}`)?.value) || 4.8;
        const qty = parseInt(document.getElementById(`ebPartQty_${rowId}`)?.value) || 1;
        const yieldVal = document.getElementById(`ebPartYield_${rowId}`)?.value || "";

        if (pNo) {
            parts.push({
                part_no: pNo,
                base_part: bPart,
                part_size: pSize,
                cut_length: cutLen,
                cut_width: cutWid,
                thickness: thick,
                no_of_parts: qty,
                target_qty: qty,
                yield_pct: yieldVal
            });
        }
    });

    if (parts.length === 0) {
        alert("Please enter at least one valid Part Number.");
        return;
    }

    // Strict Physical Boundary & Pro-Rata Capacity Verification before submitting
    const offLen = parseFloat(document.getElementById("ebOffcutLength")?.value) || 0;
    const offWid = parseFloat(document.getElementById("ebOffcutWidth")?.value) || 0;
    const endbitsUsedInput = document.getElementById("ebEndbitsUsed");
    const endbitsCount = Math.max(1, parseInt(endbitsUsedInput?.value) || 1);
    const ebMax = Math.max(offLen, offWid);
    const ebMin = Math.min(offLen, offWid);
    const totalOffcutArea = (offLen > 0 && offWid > 0) ? (offLen * offWid * endbitsCount) : 0;

    if (ebMax > 0 && ebMin > 0) {
        for (const p of parts) {
            const bMax = Math.max(p.cut_length, p.cut_width);
            const bMin = Math.min(p.cut_length, p.cut_width);

            // 1. Physical Boundary Check
            if (bMax > ebMax || bMin > ebMin) {
                alert(`❌ Cannot create MO: Part '${p.part_no}' blank size (${bMax} × ${bMin} mm) exceeds the selected end-bit offcut size (${ebMax} × ${ebMin} mm)!\n\nPlease adjust the blank dimensions or select a larger offcut piece.`);
                return;
            }

            // 2. Pro-Rata Capacity Check: Does requested quantity exceed raw material capacity?
            const opt1 = Math.floor(ebMax / bMax) * Math.floor(ebMin / bMin);
            const opt2 = Math.floor(ebMax / bMin) * Math.floor(ebMin / bMax);
            const partsPerEb = Math.max(opt1, opt2, 1);
            const maxPartsAllowed = partsPerEb * endbitsCount;

            if (p.no_of_parts > maxPartsAllowed) {
                const neededEbs = Math.ceil(p.no_of_parts / partsPerEb);
                alert(`❌ Cannot create MO: Raw Material Shortage!\n\nRequested ${p.no_of_parts} parts for '${p.part_no}' exceeds the capacity of ${endbitsCount} selected end-bit(s).\n\n• Maximum Producible: ${maxPartsAllowed} parts (${partsPerEb} blanks/plate)\n• End-bits Required: at least ${neededEbs} end-bits for ${p.no_of_parts} parts\n\nWithout sufficient raw material, you cannot produce these parts. Please click 'Cap to ${maxPartsAllowed} Parts' or increase the number of end-bits.`);
                return;
            }
        }

        // 3. Total Combined Cut Area Check
        const totalCutArea = parts.reduce((sum, p) => sum + (p.cut_length * p.cut_width * p.no_of_parts), 0);
        if (totalOffcutArea > 0 && totalCutArea > totalOffcutArea) {
            alert(`❌ Cannot create MO: Combined cut area of all parts (${Math.round(totalCutArea).toLocaleString()} mm²) exceeds total raw material surface area (${Math.round(totalOffcutArea).toLocaleString()} mm²).\n\nWithout sufficient raw material, you cannot produce these parts. Please adjust quantities or select more end-bits.`);
            return;
        }
    }

    const form = document.getElementById("createEndbitMoForm");
    const formData = new FormData(form);

    // Primary part for high-level lists
    formData.set("part_no", parts[0].part_no);
    formData.set("base_part", parts[0].base_part);
    formData.set("cut_length", parts[0].cut_length);
    formData.set("cut_width", parts[0].cut_width);
    formData.set("thickness", parts[0].thickness);
    formData.set("parts", JSON.stringify(parts));

    const select = document.getElementById("ebMoSelect");
    const chosenEbId = select?.value;
    if (chosenEbId && chosenEbId !== "__manual__") {
        formData.set("endbit_id", chosenEbId);
        if (currentSelectedEndbit) {
            formData.set("endbit_name", currentSelectedEndbit.name || "End bit");
            formData.set("source_mo_number", currentSelectedEndbit.source_mo_number || currentSelectedEndbit.mo_number || "");
        }
    } else {
        formData.set("endbit_id", "");
        formData.set("endbit_name", "Shop Floor Offcut");
    }

    const submitBtn = document.getElementById("submitEbMoBtn");
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Submitting End Bit MO...`;

    try {
        const res = await fetch("/api/mo/create-endbit", {
            method: "POST",
            headers: {
                "X-Role": currentRole
            },
            body: formData
        });

        if (res.ok) {
            const mo = await res.json();
            const partSummary = parts.length > 1 ? `${parts.length} Parts (${parts.map(p => p.part_no).join(', ')})` : parts[0].part_no;
            alert(`🎉 End Bit Material Order Created Successfully!\n\n` +
                  `• MO Number: ${mo.mo_number}\n` +
                  `• Parts: ${partSummary}\n` +
                  `• Total Output: ${mo.target_qty} Units\n` +
                  `• Offcuts Consumed: ${mo.sheets_required} Nos\n` +
                  `• Route: Direct to ERP Approval (Fast-Tracked)\n` +
                  `• Current Stage: PENDING_ERP (Awaiting Final ERP Release)\n\n` +
                  `Upon final ERP approval, offcut deductions and finished goods inventory will be updated live in the database.`);

            await loadStats();
            await loadOrders();
            await loadEndbitsStoreData();
            showMoWorkflowView();
        } else {
            const err = await res.json();
            alert(`Failed to create End Bit MO: ${err.error || 'Server error'}`);
        }
    } catch (err) {
        console.error("End bit MO submission failed:", err);
        alert("Submission failed. Please check network connection.");
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `<i class="fa-solid fa-paper-plane"></i> Create End Bit MO`;
    }
}

/* =========================================================================
   2D CUT LIST & YIELD OPTIMIZER (OPTICUTTER INTEGRATION)
   Multi-strategy guillotine nesting engine for custom RM sheets and end-bits.
   ========================================================================= */

let currentCutOptResult = null;
let cutOptCallingContext = "moModal"; // "moModal" or "endbitMo"

/**
 * Opens 2D Cut Optimizer for Normal MO Modal (Standard or Custom RM)
 */
async function openCutOptimizerForModal() {
    cutOptCallingContext = "moModal";

    let sLen = parseFloat(document.getElementById("lengthInput")?.value) || 0;
    let sWid = parseFloat(document.getElementById("widthInput")?.value) || 0;
    const sheetSizeStr = document.getElementById("sheetSizeInput")?.value || "";
    const thickVal = parseFloat(document.getElementById("thicknessInput")?.value) || 0;

    if ((!sLen || !sWid) && sheetSizeStr) {
        const d = parseDimString(sheetSizeStr, thickVal);
        if (d.l > 0 && d.w > 0) {
            sLen = d.l;
            sWid = d.w;
        }
    }

    if (!sLen || !sWid) {
        sLen = 2500;
        sWid = 1250;
    }

    // Determine Blank dimensions
    let bLen = 0;
    let bWid = 0;
    const partNo = document.getElementById("partNoInput")?.value?.trim() || "Part";
    const layoutRec = typeof getSelectedLayoutRecord === "function" ? getSelectedLayoutRecord() : null;

    if (layoutRec) {
        const p1 = layoutRec.part1 || {};
        const p1Bs = p1.blank_size || {};

        if (p1Bs.length && p1Bs.width) {
            bLen = parseFloat(p1Bs.length) || 0;
            bWid = parseFloat(p1Bs.width) || 0;
        } else if (layoutRec.blank_length && layoutRec.blank_width) {
            bLen = parseFloat(layoutRec.blank_length) || 0;
            bWid = parseFloat(layoutRec.blank_width) || 0;
        }

        if (!bLen || !bWid) {
            const cutBlankStr = layoutRec.cut_blank || p1.cut_blank || "";
            if (cutBlankStr) {
                const recThick = parseFloat(layoutRec.thickness) || thickVal || 0;
                const d = parseDimString(cutBlankStr, recThick);
                if (d.l > 0 && d.w > 0) {
                    bLen = d.l;
                    bWid = d.w;
                }
            }
        }
    }

    // If still missing, try searching blank from backend
    if ((!bLen || !bWid) && partNo) {
        try {
            const thick = document.getElementById("thicknessInput")?.value || "";
            const grade = document.getElementById("gradeInput")?.value || "";
            const res = await fetch(`/api/parts/search-blank?query=${encodeURIComponent(partNo)}&thickness=${encodeURIComponent(thick)}&grade=${encodeURIComponent(grade)}`);
            if (res.ok) {
                const hits = await res.json();
                if (hits && hits.length > 0) {
                    const h = hits[0];
                    bLen = parseFloat(h.blank_length) || 0;
                    bWid = parseFloat(h.blank_width) || 0;
                }
            }
        } catch (e) {
            console.warn("Failed to fetch blank dimensions:", e);
        }
    }

    if (!bLen || !bWid) {
        bLen = 500;
        bWid = 300;
    }

    currentCutOptPartsList = [];
    const multiSec = document.getElementById("optMultiPartsSection");
    if (multiSec) multiSec.style.display = "none";

    // Show modal immediately so user sees responsive feedback
    const modal = document.getElementById("cutOptimizerModal");
    if (modal) modal.style.display = "flex";

    // Populate Modal Inputs (Length >= Width)
    const slEl = document.getElementById("optSheetLength");
    const swEl = document.getElementById("optSheetWidth");
    const blEl = document.getElementById("optBlankLength");
    const bwEl = document.getElementById("optBlankWidth");
    const plEl = document.getElementById("optPartLabel");
    const kfEl = document.getElementById("optKerf");

    if (slEl) slEl.value = Math.max(sLen, sWid);
    if (swEl) swEl.value = Math.min(sLen, sWid);
    if (blEl) {
        blEl.value = Math.max(bLen, bWid);
        blEl.disabled = false;
    }
    if (bwEl) {
        bwEl.value = Math.min(bLen, bWid);
        bwEl.disabled = false;
    }
    if (plEl) plEl.value = partNo;
    if (kfEl) kfEl.value = 0;

    // Run optimization
    await run2DCutOptimization();
}

/**
 * Global state for multi-part cut optimizer batch
 */
let currentCutOptPartsList = [];

/**
 * Renders Part Badges in 2D Cut Optimizer Modal for multi-part batch mode
 */
function renderOptMultiPartBadges(partsList, summaryList = null) {
    const container = document.getElementById("optMultiPartsList");
    if (!container) return;

    const colorPalette = [
        { bg: "#72bbf8", border: "#1d4ed8" },
        { bg: "#86efac", border: "#15803d" },
        { bg: "#fde047", border: "#ca8a04" },
        { bg: "#c4b5fd", border: "#7c3aed" },
        { bg: "#fda4af", border: "#e11d48" },
        { bg: "#fed7aa", border: "#ea580c" },
        { bg: "#a5f3fc", border: "#0891b2" },
        { bg: "#d8b4fe", border: "#9333ea" }
    ];

    const summaryMap = {};
    if (summaryList && Array.isArray(summaryList)) {
        summaryList.forEach(s => {
            summaryMap[s.part_idx] = s;
        });
    }

    container.innerHTML = partsList.map((p, idx) => {
        const col = colorPalette[idx % colorPalette.length];
        const sumItem = summaryMap[idx];
        const placed = sumItem ? sumItem.placed_qty : p.qty;
        const isFull = placed >= p.qty;

        return `
            <div style="background: #f8fafc; border: 1.5px solid ${col.border}; border-left: 6px solid ${col.bg}; border-radius: 6px; padding: 6px 12px; display: flex; align-items: center; gap: 10px; box-shadow: 0 1px 2px rgba(0,0,0,0.04);">
                <div style="display: flex; flex-direction: column;">
                    <strong style="font-size: 0.82rem; color: #1e293b;"><i class="fa-solid fa-shapes" style="color: ${col.border}; margin-right: 4px;"></i>${escapeHtml(p.part_no)}</strong>
                    <span style="font-size: 0.74rem; color: #64748b; font-weight: 600;">${p.length} × ${p.width} mm</span>
                </div>
                <div style="display: flex; align-items: center; gap: 4px;">
                    <span style="font-size: 0.74rem; font-weight: 700; color: #475569;">Qty:</span>
                    <input type="number" min="1" step="1" value="${p.qty}" 
                           style="width: 56px; padding: 2px 4px; font-size: 0.8rem; font-weight: 700; border: 1px solid #cbd5e1; border-radius: 4px; text-align: center; background: #fff;"
                           onchange="updateOptMultiPartQty(${idx}, this.value)">
                </div>
                <div style="font-size: 0.74rem; font-weight: 700; border-radius: 4px; padding: 2px 7px; ${isFull ? 'background: #f0fdf4; color: #15803d; border: 1px solid #86efac;' : 'background: #fffbeb; color: #b45309; border: 1px solid #fde68a;'}">
                    ${sumItem ? `${placed}/${p.qty} Placed` : `${p.qty} Nos`}
                </div>
            </div>
        `;
    }).join("");
}

/**
 * Handles quantity update for a part in the optimizer modal
 */
function updateOptMultiPartQty(idx, val) {
    if (!currentCutOptPartsList || !currentCutOptPartsList[idx]) return;
    const q = Math.max(1, parseInt(val) || 1);
    currentCutOptPartsList[idx].qty = q;
    run2DCutOptimization();
}

/**
 * Opens 2D Cut Optimizer for End Bit MO View
 */
async function openCutOptimizerForEndbit() {
    cutOptCallingContext = "endbitMo";

    let sLen = parseFloat(document.getElementById("ebOffcutLength")?.value) || 0;
    let sWid = parseFloat(document.getElementById("ebOffcutWidth")?.value) || 0;
    const ebThick = parseFloat(document.getElementById("ebThickness")?.value) || 0;
    const ebSizeStr = document.getElementById("ebOffcutSizeDisplay")?.value || "";

    if ((!sLen || !sWid) && ebSizeStr) {
        const d = parseDimString(ebSizeStr, ebThick);
        if (d.l > 0 && d.w > 0) {
            sLen = d.l;
            sWid = d.w;
        }
    }

    if (!sLen || !sWid) {
        sLen = 1500;
        sWid = 600;
    }

    // Inspect ALL part rows in End Bit container
    const rows = document.querySelectorAll(".eb-part-card-row");
    const partsList = [];

    rows.forEach((r, idx) => {
        const rowId = r.dataset.rowId || (idx + 1);
        const pNo = r.querySelector(".eb-part-no")?.value?.trim() || `Part-${idx + 1}`;
        let bLen = parseFloat(r.querySelector(".eb-cut-len")?.value) || 0;
        let bWid = parseFloat(r.querySelector(".eb-cut-wid")?.value) || 0;
        const rowThick = parseFloat(r.querySelector(".eb-thickness")?.value) || ebThick || 0;

        if ((!bLen || !bWid) && r.querySelector(".eb-part-size")?.value) {
            const d = parseDimString(r.querySelector(".eb-part-size").value, rowThick);
            if (d.l > 0 && d.w > 0) {
                bLen = d.l;
                bWid = d.w;
            }
        }

        const qty = Math.max(1, parseInt(r.querySelector(".eb-part-qty")?.value) || 1);

        if (bLen > 0 && bWid > 0) {
            partsList.push({
                row_id: rowId,
                part_no: pNo,
                length: Math.max(bLen, bWid),
                width: Math.min(bLen, bWid),
                qty: qty
            });
        }
    });

    currentCutOptPartsList = partsList;

    // Populate Modal Sheet Inputs (Length >= Width)
    const slEl = document.getElementById("optSheetLength");
    const swEl = document.getElementById("optSheetWidth");
    const blEl = document.getElementById("optBlankLength");
    const bwEl = document.getElementById("optBlankWidth");
    const plEl = document.getElementById("optPartLabel");
    const kfEl = document.getElementById("optKerf");
    const multiSec = document.getElementById("optMultiPartsSection");
    const multiCountEl = document.getElementById("optMultiPartsCount");

    if (slEl) slEl.value = Math.max(sLen, sWid);
    if (swEl) swEl.value = Math.min(sLen, sWid);
    if (kfEl) kfEl.value = 0;

    if (partsList.length > 1) {
        // Multi-Part Batch Mode
        if (multiSec) multiSec.style.display = "block";
        if (multiCountEl) multiCountEl.textContent = partsList.length;
        renderOptMultiPartBadges(partsList);

        if (plEl) plEl.value = `${partsList.length} Parts Batch`;
        if (blEl) {
            blEl.value = partsList[0].length;
            blEl.disabled = true;
            blEl.title = "Multiple parts configured in batch list below";
        }
        if (bwEl) {
            bwEl.value = partsList[0].width;
            bwEl.disabled = true;
            bwEl.title = "Multiple parts configured in batch list below";
        }
    } else {
        // Single Part Mode
        if (multiSec) multiSec.style.display = "none";
        if (blEl) blEl.disabled = false;
        if (bwEl) bwEl.disabled = false;

        const p = partsList[0] || { length: 300, width: 200, part_no: "Part-1" };
        if (blEl) blEl.value = p.length;
        if (bwEl) bwEl.value = p.width;
        if (plEl) plEl.value = p.part_no;
    }

    // Show modal
    const modal = document.getElementById("cutOptimizerModal");
    if (modal) modal.style.display = "flex";

    // Run optimization
    await run2DCutOptimization();
}

/**
 * Closes 2D Cut Optimizer Modal
 */
function closeCutOptimizerModal() {
    const modal = document.getElementById("cutOptimizerModal");
    if (modal) modal.style.display = "none";
}

/**
 * Executes 2D Nesting Optimization via Backend Engine
 */
async function run2DCutOptimization() {
    const sLen = parseFloat(document.getElementById("optSheetLength")?.value) || 0;
    const sWid = parseFloat(document.getElementById("optSheetWidth")?.value) || 0;
    const bLen = parseFloat(document.getElementById("optBlankLength")?.value) || 0;
    const bWid = parseFloat(document.getElementById("optBlankWidth")?.value) || 0;
    const partNo = document.getElementById("optPartLabel")?.value?.trim() || "Part";
    const kerf = parseFloat(document.getElementById("optKerf")?.value) || 0;
    const strategyMode = document.getElementById("optCuttingStrategy")?.value || "auto";

    const svgContainer = document.getElementById("optSvgContainer");
    if (svgContainer) {
        svgContainer.innerHTML = `<span style="color: #0284c7; font-size: 0.85rem;"><i class="fa-solid fa-spinner fa-spin"></i> Calculating optimal 2D guillotine cutting pattern...</span>`;
    }

    const payload = {
        sheet_length: sLen,
        sheet_width: sWid,
        blank_length: bLen,
        blank_width: bWid,
        part_no: partNo,
        strategy: strategyMode,
        kerf: kerf
    };

    if (currentCutOptPartsList && currentCutOptPartsList.length > 1) {
        payload.parts = currentCutOptPartsList;
    }

    try {
        const res = await fetch("/api/optimizer/2d-cut-list", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || "Optimization calculation failed");
        }

        const data = await res.json();
        currentCutOptResult = data;

        // Update KPIs
        const kpiYield = document.getElementById("optKpiYield");
        const kpiBlanks = document.getElementById("optKpiBlanks");
        const kpiBlanksSub = document.getElementById("optKpiBlanksSub");
        const kpiWaste = document.getElementById("optKpiWaste");
        const kpiRemnants = document.getElementById("optKpiRemnants");
        const stratEl = document.getElementById("optPatternStrategy");
        const footEl = document.getElementById("optFooterSummary");

        if (kpiYield) kpiYield.textContent = `${data.yield_pct}%`;
        if (kpiWaste) kpiWaste.textContent = `${data.waste_pct}%`;

        if (data.is_multi_part || (data.parts_summary && data.parts_summary.length > 1)) {
            if (kpiBlanks) kpiBlanks.textContent = `${data.total_blanks} Nos`;
            if (kpiBlanksSub) kpiBlanksSub.textContent = `(${data.parts_summary.length} Parts Included)`;
            // Refresh batch badges with placed counts
            renderOptMultiPartBadges(currentCutOptPartsList, data.parts_summary);
        } else {
            if (kpiBlanks) kpiBlanks.textContent = `${data.total_blanks} Nos`;
            if (kpiBlanksSub) kpiBlanksSub.textContent = "Per Sheet";
        }

        if (kpiRemnants) {
            if (data.remnants && data.remnants.length > 0) {
                const rem = data.remnants[0];
                kpiRemnants.textContent = `${data.remnants.length} Remnant (${rem.length}*${rem.width}mm)`;
            } else {
                kpiRemnants.textContent = "None";
            }
        }
        if (stratEl) stratEl.textContent = `(${data.strategy || 'Guillotine Nesting'})`;
        if (footEl) {
            footEl.innerHTML = `<strong>Result:</strong> ${escapeHtml(data.summary_text || '')}`;
        }

        // Render visual SVG cut layout
        renderOptSvgCutMap(data);

    } catch (err) {
        console.error("2D Nesting error:", err);
        if (svgContainer) {
            svgContainer.innerHTML = `<span style="color: #ef4444; font-size: 0.85rem;"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(err.message)}</span>`;
        }
    }
}

/**
 * Renders Interactive SVG 2D Cut Map with Part Colors & Clear Dimensions
 */
function renderOptSvgCutMap(data) {
    const container = document.getElementById("optSvgContainer");
    if (!container) return;

    if (!data.placements || data.placements.length === 0) {
        container.innerHTML = `
            <div style="text-align: center; color: #94a3b8; padding: 20px;">
                <i class="fa-solid fa-circle-exclamation" style="font-size: 2rem; color: #f59e0b; margin-bottom: 8px;"></i>
                <p style="margin: 0; font-size: 0.9rem; font-weight: 600; color: #475569;">Blank dimension exceeds sheet size!</p>
                <small>The configured parts are too large to fit in ${data.sheet_length}×${data.sheet_width} mm sheet.</small>
            </div>
        `;
        return;
    }

    const sLen = data.sheet_length;
    const sWid = data.sheet_width;
    const strokeWidth = Math.max(1, sLen / 1200);

    let partsSvg = "";
    data.placements.forEach((p, idx) => {
        const tileColor = p.color || "#72bbf8";
        const borderColor = p.border_color || "#1d4ed8";

        // Adaptive dimension text: only draw if tile has enough space to prevent black text blobs
        const canShowW = p.w >= 18 && p.h >= 10;
        const canShowH = p.w >= 12 && p.h >= 18;

        const fontSize = Math.max(7, Math.min(13, Math.min(p.w, p.h) / 2.8));
        const topY = p.y + Math.min(14, p.h * 0.25);
        const leftX = p.x + Math.min(12, p.w * 0.22);
        const centerY = p.y + p.h / 2;

        let dimLabelsSvg = "";
        if (canShowW) {
            dimLabelsSvg += `
                <text x="${p.x + p.w / 2}" y="${topY}" 
                      font-family="system-ui, -apple-system, sans-serif" font-size="${fontSize}" font-weight="600" fill="#0f172a" 
                      text-anchor="middle" dominant-baseline="central">${p.w}</text>
            `;
        }
        if (canShowH) {
            dimLabelsSvg += `
                <text x="${leftX}" y="${centerY}" 
                      font-family="system-ui, -apple-system, sans-serif" font-size="${fontSize}" font-weight="600" fill="#0f172a" 
                      text-anchor="middle" dominant-baseline="central"
                      transform="rotate(-90 ${leftX} ${centerY})">${p.h}</text>
            `;
        }

        partsSvg += `
            <g class="cut-blank-tile" data-index="${idx}">
                <rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" 
                      fill="${tileColor}" stroke="${borderColor}" stroke-width="${strokeWidth}" rx="0" opacity="0.95">
                    <title>Blank #${idx + 1}: ${escapeHtml(p.part_no || 'Part')} &bull; ${p.w} × ${p.h} mm</title>
                </rect>
                ${dimLabelsSvg}
            </g>
        `;
    });

    // Update Top Legend with part swatches
    const legendContainer = document.getElementById("optSvgLegendStrip");
    if (legendContainer) {
        if (data.parts_summary && data.parts_summary.length > 1) {
            let legendHtml = "";
            data.parts_summary.forEach(ps => {
                legendHtml += `
                    <span style="display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; background: #f8fafc; border: 1.5px solid ${ps.border_color}; border-radius: 4px; font-weight: 600;">
                        <span style="display: inline-block; width: 12px; height: 12px; background: ${ps.color}; border: 1px solid ${ps.border_color}; border-radius: 2px;"></span>
                        <span>${escapeHtml(ps.part_no)}: <strong style="color: ${ps.placed_qty >= ps.requested_qty ? '#15803d' : '#b45309'};">${ps.placed_qty}/${ps.requested_qty}</strong> (${ps.length}×${ps.width})</span>
                    </span>
                `;
            });
            legendHtml += `
                <span style="display: inline-flex; align-items: center; gap: 4px;">
                    <span style="display: inline-block; width: 12px; height: 12px; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 2px;"></span> Scrap/Remnant
                </span>
            `;
            legendContainer.innerHTML = legendHtml;
        } else {
            legendContainer.innerHTML = `
                <span style="display: flex; align-items: center; gap: 4px;"><span style="display: inline-block; width: 12px; height: 12px; background: #72bbf8; border: 1px solid #1d4ed8; border-radius: 2px;"></span> Cut Blank</span>
                <span style="display: flex; align-items: center; gap: 4px;"><span style="display: inline-block; width: 12px; height: 12px; background: #fef08a; border: 1px dashed #ca8a04; border-radius: 2px;"></span> Reusable End Bit</span>
                <span style="display: flex; align-items: center; gap: 4px;"><span style="display: inline-block; width: 12px; height: 12px; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 2px;"></span> Scrap</span>
            `;
        }
    }

    // Visual Guillotine Cut Split Line & Block Annotation
    let splitLineSvg = "";
    let blockDimsSvg = "";
    if (data.blocks && data.blocks.length > 0) {
        data.blocks.forEach((b) => {
            // Draw block boundary
            splitLineSvg += `
                <rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="none" stroke="#0f172a" stroke-width="${strokeWidth * 1.5}" />
            `;
            if (b.rem_h && b.rem_h > 0) {
                const remY = sWid - b.rem_h;
                blockDimsSvg += `
                    <rect x="${b.x}" y="${remY}" width="${b.w}" height="${b.rem_h}" fill="#f8fafc" stroke="#94a3b8" stroke-dasharray="4 2" opacity="0.8" />
                    <text x="${b.x + Math.min(22, b.w / 4)}" y="${remY + b.rem_h / 2}" font-family="system-ui, sans-serif" font-size="${Math.max(9, b.rem_h / 4)}" font-weight="600" fill="#64748b" text-anchor="middle" dominant-baseline="central">${b.rem_h}</text>
                `;
            }
        });
    }

    if (data.split_line) {
        if (data.split_line.axis === "x") {
            const sx = data.split_line.val;
            splitLineSvg = `
                <line x1="${sx}" y1="0" x2="${sx}" y2="${sWid}" stroke="#0f172a" stroke-width="${strokeWidth * 1.8}" />
            `;
        } else if (data.split_line.axis === "y") {
            const sy = data.split_line.val;
            splitLineSvg = `
                <line x1="0" y1="${sy}" x2="${sLen}" y2="${sy}" stroke="#0f172a" stroke-width="${strokeWidth * 1.8}" />
            `;
        }
    }

    // Right-edge remnant offcut annotation (if any)
    let remnantSvg = "";
    if (data.rem_x && data.rem_x > 0) {
        const rx = sLen - data.rem_x;
        remnantSvg = `
            <rect x="${rx}" y="0" width="${data.rem_x}" height="${sWid}" fill="#f8fafc" stroke="#94a3b8" stroke-dasharray="4 2" opacity="0.8" />
        `;
    }

    const svgHeightView = (data.blocks && data.blocks.length > 1) ? (sWid + 35) : sWid;
    const svgHtml = `
        <svg viewBox="0 0 ${sLen} ${svgHeightView}" style="width: 100%; height: 100%; max-height: 380px; display: block;" preserveAspectRatio="xMidYMid meet">
            <!-- Sheet Boundary -->
            <rect x="0" y="0" width="${sLen}" height="${sWid}" fill="#f1f5f9" stroke="#64748b" stroke-width="${strokeWidth * 2}" rx="0" />
            
            <!-- Cut Blanks -->
            ${partsSvg}

            <!-- Guillotine Split Line -->
            ${splitLineSvg}

            <!-- Block Annotations & Scrap -->
            ${blockDimsSvg}

            <!-- Remnant Offcuts -->
            ${remnantSvg}
        </svg>
    `;

    container.innerHTML = svgHtml;
}

/**
 * Downloads Pre-formatted OptiCutter CSV file
 */
function exportOptiCutterCsv() {
    let csvContent = currentCutOptResult?.opticutter_csv;

    if (!csvContent) {
        const sLen = document.getElementById("optSheetLength")?.value || 2500;
        const sWid = document.getElementById("optSheetWidth")?.value || 1250;
        const bLen = document.getElementById("optBlankLength")?.value || 500;
        const bWid = document.getElementById("optBlankWidth")?.value || 300;
        const pNo = document.getElementById("optPartLabel")?.value || "Part-1";

        csvContent = `Length,Width,Qty,Material,Label\n${sLen},${sWid},1,Steel,Sheet-Container\n\nLength,Width,Qty,Material,Label,Can Rotate\n${bLen},${bWid},10,Steel,${pNo},1\n`;
    }

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `OptiCutter_Plan_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

/**
 * Applies the calculated 2D Cut Optimization results (Yield %, blanks, remnants)
 * directly into the active Material Order form.
 */
function applyCutOptimizerResults() {
    if (!currentCutOptResult) {
        alert("Please run the 2D Cut Optimization first.");
        return;
    }

    const yieldVal = currentCutOptResult.yield_pct;
    const totalBlanks = currentCutOptResult.total_blanks || 0;

    if (cutOptCallingContext === "endbitMo") {
        // End Bit MO Form Context
        const totalYieldDisplay = document.getElementById("totalYieldDisplay");
        const yieldHidden = document.getElementById("yieldHidden");
        if (yieldHidden) yieldHidden.value = `${yieldVal}%`;
        if (totalYieldDisplay) totalYieldDisplay.innerHTML = `<span style="color: #059669; font-weight: 700;">${yieldVal}%</span>`;

        // If part row exists, update blanks per endbit
        const rows = document.querySelectorAll(".eb-part-card-row");
        if (rows.length > 0 && totalBlanks > 0) {
            const firstRow = rows[0];
            const blanksInput = firstRow.querySelector(".eb-blanks-per-endbit");
            if (blanksInput) {
                blanksInput.value = totalBlanks;
                if (typeof recalculateEbPartRow === "function") {
                    recalculateEbPartRow(firstRow);
                }
            }
        }
        if (typeof recalculateAllEbTotals === "function") {
            recalculateAllEbTotals();
        }
        closeCutOptimizerModal();
        alert(`✅ Applied 2D Cut Optimization: ${yieldVal}% Yield to End Bit Order!`);
    } else {
        // Normal Create MO Context (moModal)
        const yieldInput = document.getElementById("yieldPctInput");
        if (yieldInput) {
            yieldInput.value = `${yieldVal}%`;
        }

        // If blanks per sheet is computed, update target quantity display/calculation
        if (totalBlanks > 0) {
            const sheetsInput = document.getElementById("sheetsRequired");
            const sheetsNeeded = Math.max(1, parseFloat(sheetsInput?.value) || 1);
            const targetQtyInput = document.getElementById("targetQty");
            const autoQtyDisplay = document.getElementById("autoTargetQtyDisplay");
            const autoQtyHint = document.getElementById("autoQtyHint");

            const calculatedTarget = Math.round(sheetsNeeded * totalBlanks);
            if (targetQtyInput) {
                targetQtyInput.value = calculatedTarget;
            }
            if (autoQtyDisplay) {
                autoQtyDisplay.textContent = `${calculatedTarget.toLocaleString()} Units`;
            }
            if (autoQtyHint) {
                autoQtyHint.textContent = `${sheetsNeeded} sheets × ${totalBlanks} blanks/sheet (OptiCutter 2D Nesting)`;
            }
        }

        // Auto-populate generated remnants into End Bits Offcuts if any exist
        if (currentCutOptResult.remnants && currentCutOptResult.remnants.length > 0) {
            const ebBanner = document.getElementById("layoutEndbitsBanner");
            const ebList = document.getElementById("layoutEndbitsList");
            const hiddenJson = document.getElementById("moEndbitsJson");
            const sheetsInput = document.getElementById("sheetsRequired");
            const sheetsNeeded = Math.max(1, parseFloat(sheetsInput?.value) || 1);
            const thickness = parseFloat(document.getElementById("thicknessInput")?.value) || 2.0;

            const optEndbits = currentCutOptResult.remnants.map((r, i) => ({
                name: `Offcut Remnant ${i + 1} (${r.length}×${r.width} mm)`,
                dim: `${thickness}*${r.length}*${r.width}`,
                thickness: thickness,
                length: r.length,
                width: r.width,
                qty_per_sheet: 1,
                total_qty: sheetsNeeded,
                grade: document.getElementById("gradeInput")?.value || "YS"
            }));

            if (hiddenJson) {
                hiddenJson.value = JSON.stringify(optEndbits);
            }
            if (ebBanner && ebList) {
                ebList.innerHTML = optEndbits.map(eb => `
                    <div class="endbit-mini-card neat-endbit-card">
                        <div class="reb-clean-field">
                            <span class="reb-clean-label">End Bit Name</span>
                            <strong class="reb-clean-val reb-name-val"><i class="fa-solid fa-scissors" style="color: #0284c7; margin-right: 5px;"></i>${escapeHtml(eb.name)}</strong>
                        </div>
                        <div class="reb-clean-row">
                            <div class="reb-clean-field">
                                <span class="reb-clean-label">No. of End Bits Produced</span>
                                <strong class="reb-clean-val">${eb.total_qty} Nos</strong>
                            </div>
                            <div class="reb-clean-field" style="text-align: right;">
                                <span class="reb-clean-label">Grade</span>
                                <span class="reb-grade-pill">${escapeHtml(eb.grade)}</span>
                            </div>
                        </div>
                    </div>
                `).join("");
                ebBanner.style.display = "block";
            }
        }

        // Re-evaluate constraints and workflow route with updated yield
        if (typeof updateAutomatedConstraints === "function") {
            updateAutomatedConstraints();
        }
        if (typeof recalculateWorkflowRoute === "function") {
            recalculateWorkflowRoute();
        }

        closeCutOptimizerModal();
        alert(`✅ Applied 2D Cut Optimization: ${yieldVal}% Yield applied to Material Order!`);
    }
}

// Global window bindings for 2D Cut Optimizer
window.openCutOptimizerForModal = openCutOptimizerForModal;
window.openCutOptimizerForEndbit = openCutOptimizerForEndbit;
window.closeCutOptimizerModal = closeCutOptimizerModal;
window.run2DCutOptimization = run2DCutOptimization;
window.applyCutOptimizerResults = applyCutOptimizerResults;
window.exportOptiCutterCsv = exportOptiCutterCsv;
window.updateOptMultiPartQty = updateOptMultiPartQty;

/* =========================================================================
   REVISION & RESUBMISSION OF REJECTED MOS (SHEARING TEAM)
   ========================================================================= */

function openEditResubmitModal(moNumber) {
    if (currentRole !== "shearing") {
        alert("Access Restricted: Only the Shearing Production team can edit and resubmit Material Orders.");
        return;
    }

    const mo = allOrders.find(o => o.mo_number === moNumber) || activeReviewMo;
    if (!mo) {
        alert("Order details not found.");
        return;
    }

    const modal = document.getElementById("editResubmitModal");
    if (!modal) return;

    // Populate Rejection Details
    const rejectEntry = (mo.audit_trail || []).slice().reverse().find(t => t.action === "REJECTED");
    const rejector = rejectEntry ? (rejectEntry.actor_name || rejectEntry.actor_role) : "Approving Department";
    const rejectRemarks = rejectEntry?.remarks || "Order was rejected. Please revise parameters and re-submit.";

    const byEl = document.getElementById("resubmitRejectedByText");
    const reasonEl = document.getElementById("resubmitRejectionReasonText");
    if (byEl) byEl.textContent = `Rejected by ${rejector}`;
    if (reasonEl) reasonEl.textContent = `"${rejectRemarks}"`;

    // Populate Fields
    document.getElementById("resubmitMoNumber").value = mo.mo_number || "";
    document.getElementById("resubmitMoSubtitle").textContent = `Revising Order: ${mo.mo_number} (${mo.part_no || ''})`;
    document.getElementById("resubmitPartNo").value = mo.part_no || "";
    document.getElementById("resubmitBasePart").value = mo.base_part || "";
    document.getElementById("resubmitGrade").value = mo.grade || "YS";
    document.getElementById("resubmitTargetQty").value = mo.target_qty || 1;
    document.getElementById("resubmitSheetsReq").value = mo.sheets_required || 1;
    document.getElementById("resubmitYieldPct").value = mo.yield_pct || (mo.constraints_status?.yield_pct) || "";
    document.getElementById("resubmitRmErp").value = mo.rm_erp || "";
    document.getElementById("resubmitThickness").value = mo.thickness || "";
    document.getElementById("resubmitLength").value = mo.length || "";
    document.getElementById("resubmitWidth").value = mo.width || "";
    document.getElementById("resubmitLayoutName").value = mo.layout_name || "";
    document.getElementById("resubmitRevisionNotes").value = "";

    const docNote = document.getElementById("resubmitExistingDocNote");
    if (docNote) {
        if (mo.layout_doc_filename) {
            docNote.innerHTML = `Current file: <strong>${escapeHtml(mo.layout_doc_filename)}</strong> (Upload new to replace)`;
        } else {
            docNote.textContent = "No document currently attached.";
        }
    }

    modal.style.display = "flex";
}

function closeEditResubmitModal() {
    const modal = document.getElementById("editResubmitModal");
    if (modal) modal.style.display = "none";
}

async function submitResubmitMo(e) {
    e.preventDefault();
    const form = document.getElementById("editResubmitForm");
    if (!form) return;

    const moNum = document.getElementById("resubmitMoNumber")?.value;
    if (!moNum) {
        alert("MO Number is missing.");
        return;
    }

    const submitBtn = document.getElementById("btnSubmitResubmitMo");
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Resubmitting MO...`;
    }

    const formData = new FormData(form);

    try {
        const res = await fetch(`/api/mo/${encodeURIComponent(moNum)}/resubmit`, {
            method: "POST",
            headers: {
                "X-Role": currentRole
            },
            body: formData
        });

        if (res.ok) {
            const updatedMo = await res.json();
            alert(`🎉 Material Order ${updatedMo.mo_number} Resubmitted Successfully!\n\n` +
                  `• Status: ${updatedMo.status}\n` +
                  `• Next Approval Stage: ${updatedMo.current_stage}\n` +
                  `• Route: ${updatedMo.workflow_path}\n\n` +
                  `The order has returned to the approval pipeline and will proceed through review until final release.`);

            closeEditResubmitModal();
            closeReviewModal();
            await loadStats();
            await loadOrders();
            filterByTab("all");
        } else {
            const err = await res.json();
            alert(`Failed to resubmit MO: ${err.error || 'Server error'}`);
        }
    } catch (err) {
        console.error("Resubmit error:", err);
        alert("Network error while resubmitting MO. Please check connection.");
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<i class="fa-solid fa-paper-plane"></i> Resubmit for Approval`;
        }
    }
}

// Window bindings for resubmit modal
window.openEditResubmitModal = openEditResubmitModal;
window.closeEditResubmitModal = closeEditResubmitModal;
window.submitResubmitMo = submitResubmitMo;



