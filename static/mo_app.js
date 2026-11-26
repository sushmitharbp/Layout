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
    initUnitSwitcher();
    Promise.all([loadStats(), loadOrders(), loadDbTablesOverview()]).catch(console.error);
    startNotificationsPolling();

    const sheetsInput = document.getElementById("sheetsRequired");
    if (sheetsInput) {
        sheetsInput.addEventListener("input", () => {
            updateAutomatedConstraints();
        });
    }

    // Lazy prefetch RYG reorder data in background after initial page render settles
    setTimeout(() => {
        if (typeof loadRygData === "function") {
            loadRygData(true);
        }
    }, 3500);
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

    // ERP Master Data controls: reserved for ERP team
    const isErp = (currentRole === "erp");
    const bannerAddRm = document.getElementById("bannerAddRmBtn");
    const bannerAddPart = document.getElementById("bannerAddPartBtn");
    const bannerAddMrp = document.getElementById("bannerAddMrpBtn");
    if (bannerAddRm) bannerAddRm.style.display = isErp ? "inline-flex" : "none";
    if (bannerAddPart) bannerAddPart.style.display = isErp ? "inline-flex" : "none";
    if (bannerAddMrp) bannerAddMrp.style.display = isErp ? "inline-flex" : "none";

    if (window.allEndbits && window.allEndbits.length > 0) {
        renderEndbitsTable(window.allEndbits);
    }
}

// Stats & Orders Loading
async function loadStats() {
    try {
        const cid = window.AUTH_COMPANY_ID || "";
        const q = cid ? `?company_id=${encodeURIComponent(cid)}` : "";
        const [resMo, resEb] = await Promise.all([
            fetch(`/api/mo/stats${q}`),
            fetch(`/api/endbits/stats${q}`).catch(() => null)
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
        const cid = window.AUTH_COMPANY_ID || "";
        const q = cid ? `?company_id=${encodeURIComponent(cid)}` : "";
        const res = await fetch(`/api/mo/list${q}`);
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
    } else if (currentRole === "purchase") {
        // For Purchase team: only count MOs that come for their approval (NOT endbits and other MOs)
        count = allOrders.filter(o => {
            const isEb = Boolean(o.is_endbit || o.is_end_bit || o.is_endbit_mo || (o.source_endbit_ids && o.source_endbit_ids.length > 0));
            const requiresPurchase = Boolean(o.workflow_path && o.workflow_path.includes("PURCHASE"));
            return !isEb && requiresPurchase && o.current_stage === "PURCHASE" && o.status !== "REJECTED";
        }).length;
    } else {
        const roleStage = ROLE_CONFIGS[currentRole]?.stage;
        if (roleStage) {
            count = allOrders.filter(o => o.current_stage === roleStage && o.status !== "REJECTED").length;
        }
    }
    const badge = document.getElementById("myActionCount");
    if (badge) badge.textContent = count;
}


// Active Unit & Plant State (Option A)
let currentFilterUnit = localStorage.getItem("mo_active_unit") || "ALL";
window._activeUnit = currentFilterUnit;

function initUnitSwitcher() {
    const authBranch = (window.AUTH_BRANCH_CODE || window.AUTH_COMPANY_ID || "").toUpperCase();
    let savedUnit = "ALL";
    if (authBranch === "PEPIPL" || authBranch === "PEI2") {
        savedUnit = authBranch;
        try { localStorage.setItem("mo_active_unit", savedUnit); } catch (e) {}
    } else {
        savedUnit = localStorage.getItem("mo_active_unit") || "ALL";
    }
    window._activeUnit = savedUnit;
    currentFilterUnit = (savedUnit === "ALL" ? "all" : savedUnit);

    const globalSel = document.getElementById("globalUnitSelect");
    if (globalSel) globalSel.value = savedUnit;

    const filterSel = document.getElementById("filterUnitSelect");
    if (filterSel) filterSel.value = currentFilterUnit;

    const modalSel = document.getElementById("modalUnitSelect");
    if (modalSel) modalSel.value = savedUnit;
}

function onGlobalUnitChanged(newUnit) {
    const unitVal = newUnit || "ALL";
    window._activeUnit = unitVal;
    currentFilterUnit = (unitVal === "ALL" ? "all" : unitVal);
    try { localStorage.setItem("mo_active_unit", unitVal); } catch (e) {}

    const filterSel = document.getElementById("filterUnitSelect");
    if (filterSel) filterSel.value = currentFilterUnit;

    const modalSel = document.getElementById("modalUnitSelect");
    if (modalSel) modalSel.value = unitVal;

    // Re-filter table
    renderOrders();

    // If modal is open and has part selected, refresh RM options for new unit
    const partNo = document.getElementById("partNoInput")?.value?.trim();
    if (partNo && typeof selectPartForModal === "function") {
        selectPartForModal(partNo);
    }
}

function onFilterUnitSelectChanged(newUnit) {
    currentFilterUnit = newUnit || "all";
    renderOrders();
}

function onModalUnitChanged(newUnit) {
    const unitVal = newUnit || "ALL";
    window._activeUnit = unitVal;
    try { localStorage.setItem("mo_active_unit", unitVal); } catch (e) {}

    const globalSel = document.getElementById("globalUnitSelect");
    if (globalSel) globalSel.value = unitVal;

    const filterSel = document.getElementById("filterUnitSelect");
    if (filterSel) filterSel.value = (unitVal === "ALL" ? "all" : unitVal);

    // Keep track of currently selected RM to restore selection if available in the new unit
    const prevRm = document.getElementById("rmErpSelect")?.value;

    const partNo = document.getElementById("partNoInput")?.value?.trim();
    if (partNo && typeof selectPartForModal === "function") {
        selectPartForModal(partNo).then(() => {
            if (prevRm) {
                const rmSelect = document.getElementById("rmErpSelect");
                const matchingOpt = Array.from(rmSelect.options).find(o => o.value === prevRm);
                if (matchingOpt) {
                    rmSelect.value = prevRm;
                    onRmErpChanged(prevRm);
                }
            }
        });
    }
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
    const unitSelect = document.getElementById("filterUnitSelect");
    const resetBtn = document.getElementById("resetFiltersBtn");

    currentFilterStatus = statusSelect?.value || "all";
    currentFilterLayout = layoutSelect?.value || "all";
    currentFilterStage = stageSelect?.value || "all";
    currentFilterUnit = unitSelect?.value || "all";

    const isFiltered = currentFilterStatus !== "all" || currentFilterLayout !== "all" || currentFilterStage !== "all" || currentFilterUnit !== "all" || (currentSearchQuery && currentSearchQuery.length > 0);
    if (resetBtn) {
        resetBtn.style.display = isFiltered ? "inline-flex" : "none";
    }

    renderOrders();
}

function resetAllDropdownFilters() {
    currentFilterStatus = "all";
    currentFilterLayout = "all";
    currentFilterStage = "all";
    currentFilterUnit = "all";
    currentSearchQuery = "";

    const statusSelect = document.getElementById("filterStatusSelect");
    const layoutSelect = document.getElementById("filterLayoutTypeSelect");
    const stageSelect = document.getElementById("filterStageSelect");
    const unitSelect = document.getElementById("filterUnitSelect");
    const searchInput = document.getElementById("moSearchInput");
    const resetBtn = document.getElementById("resetFiltersBtn");

    if (statusSelect) statusSelect.value = "all";
    if (layoutSelect) layoutSelect.value = "all";
    if (stageSelect) stageSelect.value = "all";
    if (unitSelect) unitSelect.value = "all";
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

    // For Purchase team: strictly only work for MOs that come for their approval (NOT endbits and other MOs)
    if (currentRole === "purchase") {
        filtered = filtered.filter(o => {
            const isEb = Boolean(o.is_endbit || o.is_end_bit || o.is_endbit_mo || (o.source_endbit_ids && o.source_endbit_ids.length > 0));
            const requiresPurchase = Boolean(o.workflow_path && o.workflow_path.includes("PURCHASE"));
            return !isEb && requiresPurchase;
        });
    }

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
        if (currentRole === "purchase") {
            filtered = filtered.filter(o => o.current_stage === "PURCHASE" && o.status !== "REJECTED");
        } else {
            filtered = filtered.filter(o => o.status && o.status.startsWith("PENDING_"));
        }
    } else if (currentFilter === "released") {
        filtered = filtered.filter(o => o.status === "RELEASED_TO_ERP" || o.status === "RELEASED");
    } else if (currentFilter === "rejected") {
        filtered = filtered.filter(o => o.status === "REJECTED");
    }

    // 2. Search filter
    if (currentSearchQuery) {
        filtered = filtered.filter(o => 
            (o.mo_number && o.mo_number.toLowerCase().includes(currentSearchQuery)) ||
            (o.erp_mo_number && o.erp_mo_number.toLowerCase().includes(currentSearchQuery)) ||
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

    // 6. Unit Dropdown Filter
    if (currentFilterUnit && currentFilterUnit.toLowerCase() !== "all") {
        filtered = filtered.filter(o => {
            const b = (o.branch_code || o.branch || "").toUpperCase();
            return !b || b === currentFilterUnit.toUpperCase();
        });
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
        } else if (currentRole === "purchase") {
            const isEb = Boolean(mo.is_endbit || mo.is_end_bit || mo.is_endbit_mo);
            const requiresPurchase = Boolean(mo.workflow_path && mo.workflow_path.includes("PURCHASE"));
            if (!isEb && requiresPurchase && mo.current_stage === "PURCHASE" && mo.status !== "REJECTED") {
                actionBtnText = '<i class="fa-solid fa-stamp"></i> Review & Action';
                actionBtnClass = 'btn-primary';
            }
        } else if (ROLE_CONFIGS[currentRole]?.stage === mo.current_stage && mo.status !== "REJECTED") {
            actionBtnText = '<i class="fa-solid fa-stamp"></i> Review & Action';
            actionBtnClass = 'btn-primary';
        }

        return `
            <tr>
                <td>
                    <strong class="mo-id-badge">${escapeHtml(mo.mo_number)}</strong>
                    ${mo.erp_mo_number ? `
                        <div style="margin-top: 3px;">
                            <span style="background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; font-size: 0.72rem; font-weight: 700; padding: 1px 6px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px;" title="Live ERP System MO Number">
                                <i class="fa-solid fa-hashtag"></i> ERP: ${escapeHtml(mo.erp_mo_number)}
                            </span>
                        </div>
                    ` : ''}
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


// Stock State Manager for MO Create Modal
function setZeroStockUiState(isZero, rmCode = "") {
    const stockBox = document.getElementById("rmStockBox");
    const stockVal = document.getElementById("rmStockBoxVal");
    const warnEl = document.getElementById("rmZeroStockWarning");
    const rmSelect = document.getElementById("rmErpSelect");
    const submitBtn = document.getElementById("submitMoBtn");
    const routeBanner = document.getElementById("routePreviewBanner");
    const routeTitle = document.getElementById("routeTitle");
    const routeDesc = document.getElementById("routeDesc");

    if (isZero) {
        if (stockBox) {
            stockBox.style.background = "#fee2e2";
            stockBox.style.borderColor = "#f87171";
            stockBox.style.color = "#b91c1c";
        }
        if (stockVal && (stockVal.textContent === "- Sheets" || !stockVal.textContent.includes("0"))) {
            stockVal.textContent = "0 Sheets";
        }
        if (warnEl) {
            warnEl.style.display = "block";
            warnEl.innerHTML = `<i class="fa-solid fa-ban"></i> <strong>0 Sheets Available</strong> — MO cannot be produced. Please select another sheet from the dropdown.`;
        }
        if (rmSelect) {
            rmSelect.style.border = "2px solid #ef4444";
            rmSelect.style.backgroundColor = "#fff5f5";
        }
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.style.opacity = "0.65";
            submitBtn.style.cursor = "not-allowed";
            submitBtn.style.backgroundColor = "#ef4444";
            submitBtn.style.borderColor = "#dc2626";
            submitBtn.style.color = "#ffffff";
            submitBtn.title = "Available RM stock is 0 Sheets. MO cannot be produced. Please select another sheet.";
            submitBtn.innerHTML = `<i class="fa-solid fa-ban"></i> Cannot Produce MO — RM Available is 0 Sheets (Select Another Sheet)`;
        }
        if (routeBanner && routeTitle && routeDesc) {
            routeBanner.className = "workflow-route-preview danger";
            routeBanner.style.border = "2px solid #f87171";
            routeBanner.style.background = "#fef2f2";
            routeTitle.innerHTML = `<i class="fa-solid fa-ban" style="color: #dc2626;"></i> MO Blocked: 0 RM Sheets Available in Store`;
            routeDesc.innerHTML = `<strong style="color: #b91c1c;">MO cannot be produced because 0 sheets are available in store.</strong> Please select another sheet or layout from the RM dropdown to proceed.`;
        }
    } else {
        if (stockBox) {
            stockBox.style.background = "#ecfdf5";
            stockBox.style.borderColor = "#a7f3d0";
            stockBox.style.color = "#059669";
        }
        if (warnEl) {
            warnEl.style.display = "none";
        }
        if (rmSelect) {
            rmSelect.style.border = "";
            rmSelect.style.backgroundColor = "";
        }
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.style.opacity = "";
            submitBtn.style.cursor = "";
            submitBtn.style.backgroundColor = "";
            submitBtn.style.borderColor = "";
            submitBtn.style.color = "";
            submitBtn.title = "";
            submitBtn.innerHTML = `<i class="fa-solid fa-paper-plane"></i> Submit Material Order`;
        }
        if (routeBanner) {
            routeBanner.style.border = "";
            routeBanner.style.background = "";
        }
    }
}

// Complete Reset of Part-dependent fields and cards in MO modal
function resetPartModalFields() {
    selectedPartData = null;
    window._activeBasePartData = null;
    currentIntelData = null;

    // Reset part search badge
    const badgeWrap = document.getElementById("partDescBadgeWrap");
    const badgeText = document.getElementById("partDescBadgeText");
    if (badgeWrap) badgeWrap.style.display = "none";
    if (badgeText) badgeText.textContent = "";

    // Reset technical specification inputs
    const basePartInput = document.getElementById("basePartInput");
    if (basePartInput) {
        basePartInput.value = "";
        basePartInput.readOnly = true;
        basePartInput.required = false;
        basePartInput.placeholder = "Auto-populated";
    }
    const basePartLabel = document.getElementById("basePartLabel");
    if (basePartLabel) basePartLabel.innerHTML = 'Base Part:';

    const gradeInput = document.getElementById("gradeInput");
    if (gradeInput) gradeInput.value = "";
    const thicknessInput = document.getElementById("thicknessInput");
    if (thicknessInput) thicknessInput.value = "";
    const lengthInput = document.getElementById("lengthInput");
    if (lengthInput) lengthInput.value = "";
    const widthInput = document.getElementById("widthInput");
    if (widthInput) widthInput.value = "";
    const sheetSizeInput = document.getElementById("sheetSizeInput");
    if (sheetSizeInput) sheetSizeInput.value = "";
    const offtakeInput = document.getElementById("offtakeInput");
    if (offtakeInput) offtakeInput.value = "";
    const stripInput = document.getElementById("stripPerBlankInput");
    if (stripInput) stripInput.value = "";
    const yieldInput = document.getElementById("yieldPctInput");
    if (yieldInput) yieldInput.value = "";

    // Reset 3 Demand KPI Cards (1. Qty to Produce, 2. MO Produced, 3. Balance to Produce)
    const toProduceEl = document.getElementById("mrpQtyToProduceVal");
    const toProduceSub = document.getElementById("mrpQtyToProduceSub");
    const moProducedEl = document.getElementById("mrpMoProducedVal");
    const moProducedSub = document.getElementById("mrpMoProducedSub");
    const balanceEl = document.getElementById("mrpBalanceVal");
    const balanceSub = document.getElementById("mrpBalanceSub");
    const hintBox = document.getElementById("mrpStockHintBox");
    const hintVal = document.getElementById("mrpStockHintVal");

    if (toProduceEl) toProduceEl.textContent = "- Nos";
    if (toProduceSub) toProduceSub.textContent = "Schedule Target";
    if (moProducedEl) moProducedEl.textContent = "- Nos";
    if (moProducedSub) moProducedSub.textContent = "Total MOs Produced (0 Nos)";
    if (balanceEl) balanceEl.textContent = "- Nos";
    if (balanceSub) balanceSub.textContent = "Net Balance (Qty - Produced)";
    if (hintBox) hintBox.style.display = "none";
    if (hintVal) hintVal.textContent = "0";

    // Reset RM ERP Select dropdown
    const rmSelect = document.getElementById("rmErpSelect");
    if (rmSelect) {
        rmSelect.innerHTML = `
            <option value="">-- Select RM ERP Code --</option>
            <option value="__custom__">⚙️ Custom RM / Layout Code...</option>
        `;
        rmSelect.value = "";
        rmSelect.style.border = "";
        rmSelect.style.backgroundColor = "";
    }

    // Reset RM On Hand stock box & zero stock warning
    const quickStockEl = document.getElementById("rmStockBoxVal");
    if (quickStockEl) quickStockEl.textContent = "- Sheets";
    setZeroStockUiState(false);

    // Reset custom RM search
    const customBox = document.getElementById("customRmBox");
    if (customBox) customBox.style.display = "none";
    const customSearchInput = document.getElementById("customRmSearchInput");
    if (customSearchInput) customSearchInput.value = "";
    const customDropdown = document.getElementById("customRmDropdown");
    if (customDropdown) customDropdown.style.display = "none";

    // Hide inline AI recommendations & ERP intelligence
    window._aiSuggestionsRequestedByUser = false;
    const inlineAiBanner = document.getElementById("inlineAiPartSuggestionsBanner");
    if (inlineAiBanner) inlineAiBanner.style.display = "none";
    const intelCard = document.getElementById("erpIntelligenceCard");
    if (intelCard) intelCard.style.display = "none";
    const historyWrap = document.getElementById("moHistoryTableWrap");
    if (historyWrap) historyWrap.style.display = "none";
    const ebBanner = document.getElementById("layoutEndbitsBanner");
    if (ebBanner) ebBanner.style.display = "none";
    const hiddenJson = document.getElementById("moEndbitsJson");
    if (hiddenJson) hiddenJson.value = "[]";

    // Reset automated constraints & route
    if (typeof updateAutomatedConstraints === "function") {
        updateAutomatedConstraints(null, null);
    }
    if (typeof recalculateWorkflowRoute === "function") {
        recalculateWorkflowRoute();
    }
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

    // Reset Part search & preview badge
    const partNoInput = document.getElementById("partNoInput");
    if (partNoInput) partNoInput.value = "";
    const badgeWrap = document.getElementById("partDescBadgeWrap");
    const badgeText = document.getElementById("partDescBadgeText");
    if (badgeWrap) badgeWrap.style.display = "none";
    if (badgeText) badgeText.textContent = "";
    const partDropdown = document.getElementById("partDropdownResults");
    if (partDropdown) partDropdown.style.display = "none";
    
    // Auto-generate sample MO number & enforce readonly
    const randomMoNum = `MO-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const moNumInput = document.getElementById("moNumber");
    if (moNumInput) {
        moNumInput.value = randomMoNum;
        moNumInput.readOnly = true;
    }

    // Reset auto-calculated & manual target quantity
    const autoQtyVal = document.getElementById("autoTargetQtyDisplay");
    if (autoQtyVal) autoQtyVal.textContent = "- Units";
    const autoQtyHint = document.getElementById("autoQtyHint");
    if (autoQtyHint) autoQtyHint.textContent = "Select part & layout";
    const targetQtyInput = document.getElementById("targetQty");
    if (targetQtyInput) targetQtyInput.value = 1;
    const manualQtyInput = document.getElementById("targetQtyManual");
    if (manualQtyInput) manualQtyInput.value = "";
    const sheetsInput = document.getElementById("sheetsRequired");
    if (sheetsInput) sheetsInput.value = 1;

    // Reset non-standard manual parts container & state
    const nonStdContainer = document.getElementById("nonStdPartsContainer");
    if (nonStdContainer) nonStdContainer.innerHTML = "";
    const nonStdJson = document.getElementById("nonStdPartsJson");
    if (nonStdJson) nonStdJson.value = "[]";
    nonStdPartRowCounter = 0;

    const modalAddList = document.getElementById("modalAdditionalPartsList");
    if (modalAddList) modalAddList.innerHTML = "";
    addModalPartCounter = 0;
    updateModalAddPartsCountBadge();

    window._aiSuggestionsRequestedByUser = false;
    const inlineAiBanner = document.getElementById("inlineAiPartSuggestionsBanner");
    if (inlineAiBanner) inlineAiBanner.style.display = "none";

    // Reset layout standardization UI to Standard by default
    const stdRadio = document.querySelector('input[name="is_standard_layout"][value="true"]');
    if (stdRadio) stdRadio.checked = true;
    updateLayoutTypeUI(true);

    // Reset planning & stock indicators (RM on-hand, MRP Target, Remaining Qty)
    renderDefaultSinglePartKpis(null, null, null, null, null, null, null);

    const layoutPartsBanner = document.getElementById("layoutPartsBanner");
    if (layoutPartsBanner) layoutPartsBanner.style.display = "none";

    // Reset part-specific fields, cards, and RM dropdown
    resetPartModalFields();

    const stdCard = document.getElementById("radioCardStd");
    if (stdCard) {
        stdCard.classList.remove("disabled");
        stdCard.title = "";
    }

    toggleLayoutType(true);
    updateAutomatedConstraints(null, null);
    recalculateWorkflowRoute();
    const ebBanner = document.getElementById("layoutEndbitsBanner");
    if (ebBanner) ebBanner.style.display = "none";
    const hiddenJson = document.getElementById("moEndbitsJson");
    if (hiddenJson) hiddenJson.value = "[]";
    hideRmAgentSuggestions();
    activeOptiCutterLayoutFile = null;
    customOptiCutterUploadedFile = null;
    const layoutFileInput = document.getElementById("layoutDocFile");
    if (layoutFileInput) layoutFileInput.value = "";
    const fileChosenName = document.getElementById("fileChosenName");
    if (fileChosenName) {
        fileChosenName.textContent = "No file selected";
        fileChosenName.style.color = "";
    }
    const docDropzone = document.getElementById("docDropzone");
    if (docDropzone) {
        docDropzone.style.background = "";
        docDropzone.style.borderColor = "";
    }
    const customDrawInput = document.getElementById("optCustomDrawingInput");
    if (customDrawInput) customDrawInput.value = "";
    const customDrawLabel = document.getElementById("optCustomDrawingLabel");
    if (customDrawLabel) {
        customDrawLabel.textContent = "";
        customDrawLabel.style.display = "none";
    }

    if (modal) modal.style.display = "flex";
}

function closeCreateModal() {
    const modal = document.getElementById("createMoModal");
    if (modal) modal.style.display = "none";
    const ebBanner = document.getElementById("layoutEndbitsBanner");
    if (ebBanner) ebBanner.style.display = "none";
    const hiddenJson = document.getElementById("moEndbitsJson");
    if (hiddenJson) hiddenJson.value = "[]";
    const badgeWrap = document.getElementById("partDescBadgeWrap");
    const badgeText = document.getElementById("partDescBadgeText");
    if (badgeWrap) badgeWrap.style.display = "none";
    if (badgeText) badgeText.textContent = "";
    const partDropdown = document.getElementById("partDropdownResults");
    if (partDropdown) partDropdown.style.display = "none";
    hideRmAgentSuggestions();
    setZeroStockUiState(false);
}

// Search Parts for Create Modal
let searchDebounceTimer;
function searchPartsForModal(query) {
    clearTimeout(searchDebounceTimer);
    const dropdown = document.getElementById("partDropdownResults");
    const badgeWrap = document.getElementById("partDescBadgeWrap");
    const badgeText = document.getElementById("partDescBadgeText");

    // Hide badge if input was cleared or user changed the typed text
    if (!query || query.trim().length === 0) {
        if (dropdown) dropdown.style.display = "none";
        resetPartModalFields();
        return;
    }
    if (badgeWrap && selectedPartData && selectedPartData.part_no !== query.trim()) {
        badgeWrap.style.display = "none";
    }
    if (query.trim().length < 2) {
        if (dropdown) dropdown.style.display = "none";
        return;
    }

    searchDebounceTimer = setTimeout(async () => {
        try {
            const modalUnit = document.getElementById("modalUnitSelect")?.value || window._activeUnit || window.AUTH_COMPANY_ID || "PEPIPL";
            const cid = (modalUnit && modalUnit !== "ALL") ? modalUnit : (window.AUTH_COMPANY_ID || "PEPIPL");
            const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&company_id=${encodeURIComponent(cid)}&branch=${encodeURIComponent(cid)}`);
            if (res.ok) {
                const results = await res.json();
                if (dropdown) {
                    if (results.length === 0) {
                        dropdown.innerHTML = `<div class="part-dropdown-item text-muted">No matching parts found.</div>`;
                    } else {
                        dropdown.innerHTML = results.map(r => {
                            const sizeStr = (r.thickness && r.length && r.width) ? `${r.thickness}×${r.length}×${r.width} mm` : (r.thickness ? `${r.thickness}mm` : '');
                            const offtakeStr = r.offtake !== undefined ? `Offtake: ${r.offtake}` : '';
                            const badgeDetails = [r.grade, sizeStr, offtakeStr].filter(Boolean).join(" • ");
                            return `
                                <div class="part-dropdown-item" onmousedown="event.preventDefault(); selectPartForModal('${escapeHtml(r.part_no)}')">
                                    <div style="flex: 1;">
                                        <strong style="color: #0f172a; font-size: 0.88rem;">${escapeHtml(r.part_no)}</strong>
                                        ${r.part_desc ? `<small style="display: block; font-size: 0.76rem; color: #0284c7; font-weight: 600; margin-top: 1px;">${escapeHtml(r.part_desc)}</small>` : ''}
                                    </div>
                                    <span class="badge" style="background: #f1f5f9; color: #0369a1; border: 1px solid #cbd5e1; font-weight: 600; font-size: 0.75rem;">${escapeHtml(badgeDetails || r.base_part)}</span>
                                </div>
                            `;
                        }).join("");
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
    if (!partNo || !partNo.trim()) {
        resetPartModalFields();
        return;
    }
    const cleanPartNo = partNo.trim();
    const input = document.getElementById("partNoInput");
    const dropdown = document.getElementById("partDropdownResults");
    if (input) input.value = cleanPartNo;
    if (dropdown) dropdown.style.display = "none";

    // Cleanly reset previous part data and cards before loading the new part
    resetPartModalFields();
    if (input) input.value = cleanPartNo;

    try {
        const modalUnit = document.getElementById("modalUnitSelect")?.value || window._activeUnit || window.AUTH_COMPANY_ID || "PEPIPL";
        const cid = (modalUnit && modalUnit !== "ALL") ? modalUnit : (window.AUTH_COMPANY_ID || "PEPIPL");
        const unitParam = `?branch=${encodeURIComponent(cid)}&company_id=${encodeURIComponent(cid)}`;
        let res = await fetch(`/api/part/${encodeURIComponent(cleanPartNo)}${unitParam}`);
        let partData = null;
        if (res.ok) {
            partData = await res.json();
        } else {
            // Fallback: search for candidate if direct lookup 404s
            const sRes = await fetch(`/api/search?q=${encodeURIComponent(cleanPartNo)}&company_id=${encodeURIComponent(cid)}&branch=${encodeURIComponent(cid)}`);
            if (sRes.ok) {
                const searchResults = await sRes.json();
                if (searchResults && searchResults.length > 0) {
                    const best = searchResults.find(r => r.part_no.toUpperCase() === cleanPartNo.toUpperCase()) || searchResults[0];
                    if (best && best.part_no) {
                        const fallbackRes = await fetch(`/api/part/${encodeURIComponent(best.part_no)}${unitParam}`);
                        if (fallbackRes.ok) {
                            partData = await fallbackRes.json();
                        }
                    }
                }
            }
        }

        if (partData && (partData.part_no || partData.records)) {
            selectedPartData = partData;
            if (input && selectedPartData.part_no) {
                input.value = selectedPartData.part_no;
            }
            populatePartTechnicalFields(selectedPartData);

            // Populate the 3 Demand Cards:
            // Card 1: Qty to Produce (Net Requirement = Monthly Schedule - In-House Stock)
            // Card 2: MO Produced Qty (Quantity produced by MOs: Excel MOs + App MOs)
            // Card 3: Balance to Produce (Card 1 - Card 2)
            const mrp = selectedPartData.mrp || {};
            const schedQty = (mrp.monthly_schedule !== undefined && mrp.monthly_schedule !== null) ? Number(mrp.monthly_schedule) : null;
            const initStock = (mrp.initial_stock !== undefined && mrp.initial_stock !== null) ? Number(mrp.initial_stock) : 0;
            const excelMo = (mrp.excel_mo_produced !== undefined && mrp.excel_mo_produced !== null) ? Number(mrp.excel_mo_produced) : ((mrp.sheet_mo_produced !== undefined) ? Number(mrp.sheet_mo_produced) : 0);
            const appMo = (mrp.app_mo_produced !== undefined && mrp.app_mo_produced !== null) ? Number(mrp.app_mo_produced) : 0;
            const moProducedQty = (mrp.mo_produced !== undefined && mrp.mo_produced !== null) ? Number(mrp.mo_produced) : (excelMo + appMo);

            // 1. Qty to Produce (First Card: Net Requirement)
            let baseQtyToProduce = null;
            if (mrp.base_qty_to_produce !== undefined && mrp.base_qty_to_produce !== null) {
                baseQtyToProduce = Number(mrp.base_qty_to_produce);
            } else if (schedQty !== null) {
                baseQtyToProduce = Math.max(0, schedQty - initStock);
            } else if (mrp.qty_to_produce !== undefined && mrp.qty_to_produce !== null) {
                baseQtyToProduce = Number(mrp.qty_to_produce);
            }

            // 2. MO Produced Qty (Second Card) = moProducedQty

            // 3. Balance to Produce (Third Card: strictly Card 1 - Card 2)
            let balanceQty = null;
            if (baseQtyToProduce !== null) {
                balanceQty = Math.max(0, baseQtyToProduce - moProducedQty);
            } else if (mrp.balance_to_produce !== undefined && mrp.balance_to_produce !== null) {
                balanceQty = Math.max(0, Number(mrp.balance_to_produce));
            }

            const toProduceEl = document.getElementById("mrpQtyToProduceVal");
            const toProduceSub = document.getElementById("mrpQtyToProduceSub");
            const moProducedEl = document.getElementById("mrpMoProducedVal");
            const moProducedSub = document.getElementById("mrpMoProducedSub");
            const balanceEl = document.getElementById("mrpBalanceVal");
            const balanceSub = document.getElementById("mrpBalanceSub");
            const hintBox = document.getElementById("mrpStockHintBox");
            const hintVal = document.getElementById("mrpStockHintVal");

            // Card 1: Qty to Produce
            if (toProduceEl) {
                toProduceEl.textContent = baseQtyToProduce !== null ? `${baseQtyToProduce.toLocaleString()} Nos` : "- Nos";
            }
            if (toProduceSub) {
                if (schedQty !== null && initStock > 0) {
                    toProduceSub.textContent = `Schedule Net (${schedQty.toLocaleString()} - ${initStock.toLocaleString()} Stock)`;
                } else if (schedQty !== null) {
                    toProduceSub.textContent = `Schedule Target: ${schedQty.toLocaleString()} Nos`;
                } else {
                    toProduceSub.textContent = "Target Requirement";
                }
            }

            // Card 2: MO Produced Qty
            if (moProducedEl) {
                moProducedEl.textContent = `${moProducedQty.toLocaleString()} Nos`;
            }
            if (moProducedSub) {
                let moParts = [];
                if (excelMo > 0) moParts.push(`${excelMo.toLocaleString()} Excel`);
                if (appMo > 0) moParts.push(`${appMo.toLocaleString()} App`);
                moProducedSub.textContent = moParts.length > 0
                    ? `${moParts.join(" + ")} MOs`
                    : "Total MOs Produced (0 Nos)";
            }

            // Card 3: Balance to Produce (Card 1 - Card 2)
            if (balanceEl) {
                balanceEl.textContent = balanceQty !== null ? `${balanceQty.toLocaleString()} Nos` : "- Nos";
            }
            if (balanceSub) {
                if (baseQtyToProduce !== null) {
                    balanceSub.textContent = `Net Balance (${baseQtyToProduce.toLocaleString()} - ${moProducedQty.toLocaleString()})`;
                } else {
                    balanceSub.textContent = "Net Balance (Qty - Produced)";
                }
            }

            if (hintBox) {
                if (baseQtyToProduce !== null && balanceQty === 0 && baseQtyToProduce > 0) {
                    hintBox.style.display = "inline-flex";
                    if (hintVal) hintVal.textContent = baseQtyToProduce.toLocaleString();
                } else {
                    hintBox.style.display = "none";
                }
            }

            // Hide inline AI recommendations by default; only show when user clicks AI Advisor
            window._aiSuggestionsRequestedByUser = false;
            const inlineAiBanner = document.getElementById("inlineAiPartSuggestionsBanner");
            if (inlineAiBanner) inlineAiBanner.style.display = "none";

            // Immediately update automated constraints with the selected part data
            if (typeof updateAutomatedConstraints === "function") {
                updateAutomatedConstraints(currentIntelData?.stock_feasibility, getSelectedLayoutRecord());
            }

            // Trigger live intelligence fetch for selected part
            const curRmCode = document.getElementById("rmErpSelect")?.value || selectedPartData.standard_rm || "";
            const curSheetsNeeded = parseFloat(document.getElementById("sheetsRequired")?.value) || 1;
            fetchAndDisplayIntelligence(
                selectedPartData.part_no || cleanPartNo,
                curRmCode,
                selectedPartData.grade,
                selectedPartData.thickness,
                selectedPartData.length,
                selectedPartData.width,
                curSheetsNeeded,
                false,
                [selectedPartData.part_no || cleanPartNo]
            );
        }
    } catch (err) {
        console.error("Failed to load part details:", err);
    }
}

function populatePartTechnicalFields(partData) {
    if (!partData) return;

    const partNoInput = document.getElementById("partNoInput");
    if (partNoInput && partData.part_no) {
        partNoInput.value = partData.part_no;
    }

    const badgeWrap = document.getElementById("partDescBadgeWrap");
    const badgeText = document.getElementById("partDescBadgeText");
    if (badgeWrap && badgeText) {
        const desc = partData.part_desc || "";
        badgeText.textContent = desc ? `${partData.part_no} • ${desc}` : partData.part_no;
        badgeWrap.style.display = "inline-flex";
    }

    // Cache the selected part's real blank specifications
    window._activeBasePartData = {
        part_no: partData.part_no,
        base_part: partData.base_part,
        grade: partData.grade,
        thickness: partData.thickness,
        length: partData.length,
        width: partData.width,
        offtake: partData.offtake,
        strip_per_blank_qty: partData.strip_qty || partData.strip_per_blank_qty || 1
    };

    const basePartInput = document.getElementById("basePartInput");
    if (basePartInput) basePartInput.value = partData.base_part || "";

    if (partData.grade) {
        const gradeInput = document.getElementById("gradeInput");
        if (gradeInput) gradeInput.value = partData.grade;
    }
    if (partData.thickness !== undefined && partData.length !== undefined && partData.width !== undefined) {
        const thkInput = document.getElementById("thicknessInput");
        const lenInput = document.getElementById("lengthInput");
        const widInput = document.getElementById("widthInput");
        const szInput = document.getElementById("sheetSizeInput");
        if (thkInput) thkInput.value = partData.thickness;
        if (lenInput) lenInput.value = partData.length;
        if (widInput) widInput.value = partData.width;
        if (szInput) szInput.value = `${partData.thickness} * ${partData.length} * ${partData.width}`;
    }

    const offtakeInput = document.getElementById("offtakeInput");
    if (offtakeInput) {
        offtakeInput.value = `${partData.offtake || 1} Nos`;
    }

    const stripInput = document.getElementById("stripPerBlankInput");
    if (stripInput) {
        stripInput.value = `${partData.strip_qty || partData.strip_per_blank_qty || 1} Nos`;
    }

    const rmSelect = document.getElementById("rmErpSelect");
    if (rmSelect) {
        rmSelect.innerHTML = "";
        rmSelect.style.border = "";

        // Placeholder option
        const placeholderOpt = document.createElement("option");
        placeholderOpt.value = "";
        placeholderOpt.textContent = "-- Select RM ERP Code --";
        rmSelect.appendChild(placeholderOpt);

        const records = partData.records || [];
        let firstWithStockIdx = -1;
        records.forEach((r, idx) => {
            const opt = document.createElement("option");
            opt.value = r.rm_erp || `RM-${idx}`;
            const avail = (r.available_sheets !== undefined && r.available_sheets !== null) ? Number(r.available_sheets) : null;
            if (avail !== null && avail > 0 && firstWithStockIdx === -1) {
                firstWithStockIdx = idx;
            }

            // Show sheet specifications: (Grade, Thickness, Length, Width) without available sheets
            let dimStr = "";
            if (r.thickness && r.length && r.width) {
                dimStr = `${r.thickness} × ${r.length} × ${r.width} mm`;
            } else if (r.sheet_size) {
                dimStr = `${r.sheet_size} mm`;
            }
            const gradeStr = r.grade || "YS";
            const sheetLabel = dimStr ? `${gradeStr} • ${dimStr}` : (r.rm_erp || gradeStr);
            opt.textContent = (r.rm_erp && !sheetLabel.includes(r.rm_erp)) ? `${sheetLabel} (${r.rm_erp})` : sheetLabel;
            opt.dataset.record = JSON.stringify(r);
            rmSelect.appendChild(opt);
        });

        // Add Custom choice at the bottom
        const customOpt = document.createElement("option");
        customOpt.value = "__custom__";
        customOpt.textContent = "⚙️ Custom RM / Layout Code...";
        rmSelect.appendChild(customOpt);

        if (records.length > 0) {
            // Automatically prefer a layout option with available stock > 0
            const pickIdx = firstWithStockIdx >= 0 ? firstWithStockIdx : 0;
            rmSelect.selectedIndex = pickIdx + 1;
            onRmErpChanged(records[pickIdx].rm_erp);
        } else {
            rmSelect.selectedIndex = 0;
            onRmErpChanged("");
        }
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
        const stripEl = document.getElementById("stripPerBlankInput");
        if (stripEl) stripEl.value = "";
        const offtakeEl = document.getElementById("offtakeInput");
        if (offtakeEl) offtakeEl.value = "";
        const quickStockEl = document.getElementById("rmStockBoxVal");
        if (quickStockEl) quickStockEl.textContent = "- Sheets";
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
        const stdCard = document.getElementById("radioCardStd");
        if (stdCard) {
            stdCard.classList.add("disabled");
            stdCard.title = "Custom layouts are strictly Non-Standard.";
        }
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
    if (record.grade) {
        document.getElementById("gradeInput").value = record.grade;
    }

    // Preserve the active Part Blank Size!
    // #sheetSizeInput represents the Part Blank Size (T x L x W), NOT the RM sheet dimensions.
    const basePart = window._activeBasePartData;
    if (basePart && basePart.length && basePart.width) {
        document.getElementById("thicknessInput").value = basePart.thickness !== undefined ? basePart.thickness : (record.thickness || "");
        document.getElementById("lengthInput").value = basePart.length || "";
        document.getElementById("widthInput").value = basePart.width || "";
        document.getElementById("sheetSizeInput").value = `${basePart.thickness !== undefined ? basePart.thickness : (record.thickness || '-')} * ${basePart.length} * ${basePart.width}`;
    } else {
        const p1CutBlank = record.part1?.cut_blank || record.cut_blank;
        if (p1CutBlank) {
            document.getElementById("sheetSizeInput").value = p1CutBlank;
        } else if (record.thickness && record.length && record.width) {
            document.getElementById("sheetSizeInput").value = `${record.thickness} * ${record.length} * ${record.width}`;
        }
        if (record.thickness) document.getElementById("thicknessInput").value = record.thickness;
        if (record.length) document.getElementById("lengthInput").value = record.length;
        if (record.width) document.getElementById("widthInput").value = record.width;
    }

    // Strip per blank quantity
    const stripVal = record.part1?.strip_qty || record.strip_qty || record.part1?.strip_per_blank_qty || record.strip_per_blank_qty || 1;
    const stripEl = document.getElementById("stripPerBlankInput");
    if (stripEl) stripEl.value = `${stripVal} Nos`;

    // Immediately display the available stock cached on the record for instant UI feedback
    const quickStockEl = document.getElementById("rmStockBoxVal");
    if (quickStockEl && record.available_sheets !== undefined && record.available_sheets !== null) {
        const cachedAvail = parseFloat(record.available_sheets) || 0;
        quickStockEl.textContent = `${cachedAvail} Sheets`;
        if (cachedAvail <= 0) {
            setZeroStockUiState(true, rmCode);
        } else {
            setZeroStockUiState(false, rmCode);
        }
    }

    // Live RM Available Stock with active unit branch filtering
    if (rmCode && rmCode !== "__custom__") {
        const activeUnit = document.getElementById("modalUnitSelect")?.value || window._activeUnit || window.AUTH_COMPANY_ID || "PEPIPL";
        const unitParam = `?branch=${encodeURIComponent(activeUnit && activeUnit !== "ALL" ? activeUnit : (window.AUTH_COMPANY_ID || "PEPIPL"))}`;
        fetch(`/api/v2/rm-stock/${encodeURIComponent(rmCode)}${unitParam}`)
            .then(res => res.json())
            .then(data => {
                if (data.success && data.available_sheets !== undefined) {
                    const liveAvail = parseFloat(data.available_sheets) || 0;
                    if (quickStockEl) quickStockEl.textContent = `${liveAvail} Sheets`;
                    if (liveAvail <= 0) {
                        setZeroStockUiState(true, rmCode);
                    } else {
                        setZeroStockUiState(false, rmCode);
                    }
                }
            })
            .catch(() => {});
    }

    const yieldInput = document.getElementById("yieldPctInput");
    if (yieldInput) {
        const yVal = record.per_sheet?.yield_pct ?? record.total_sheet?.yield_pct ?? record.yield_pct ?? record.material_yield_pct;
        if (yVal !== undefined && yVal !== null && String(yVal).trim() !== "" && String(yVal).trim() !== "N/A" && String(yVal).trim() !== "94.2") {
            const yNum = parseFloat(String(yVal).replace("%", "").trim());
            yieldInput.value = !isNaN(yNum) && yNum > 0 ? `${yNum.toFixed(1)}%` : "";
        } else {
            yieldInput.value = "";
        }
    }

    // Auto-detect if standard or non-standard: ALL custom layouts strictly come under Non-Standard
    const isCustom = opt.dataset.isCustom === "true" ||
                     opt.value === "__custom__" ||
                     (record.status || "").toLowerCase().includes("custom") ||
                     (record.layout_name || "").toLowerCase().includes("custom") ||
                     (record.rm_erp || "").toLowerCase().includes("custom");
    let isStandard = false;
    if (!isCustom) {
        const statusLower = (record.status || "").toLowerCase();
        isStandard = !statusLower.includes("non") && !statusLower.includes("not use") && !statusLower.includes("custom");
    }
    
    // Set radio buttons without allowing user to unlock (strictly auto-locked)
    const stdRadio = document.querySelector('input[name="is_standard_layout"][value="true"]');
    const nonStdRadio = document.querySelector('input[name="is_standard_layout"][value="false"]');
    const stdCard = document.getElementById("radioCardStd");

    if (isCustom) {
        if (nonStdRadio) nonStdRadio.checked = true;
        if (stdCard) {
            stdCard.classList.add("disabled");
            stdCard.title = "Custom layouts are strictly Non-Standard.";
        }
        updateLayoutTypeUI(false);
    } else {
        if (stdCard) {
            stdCard.classList.remove("disabled");
            stdCard.title = "";
        }
        if (isStandard && stdRadio) {
            stdRadio.checked = true;
            updateLayoutTypeUI(true);
        } else if (nonStdRadio) {
            nonStdRadio.checked = true;
            updateLayoutTypeUI(false);
        }
    }

    // Auto-render standard layout companion parts if pre-defined in CAD records
    if (typeof renderStandardLayoutCompanionParts === "function") {
        renderStandardLayoutCompanionParts(record);
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

            const activeUnit = document.getElementById("modalUnitSelect")?.value || window._activeUnit || window.AUTH_COMPANY_ID || "PEPIPL";
            const res = await fetch(`/api/rm-stock/raw-material-sheets?q=${encodeURIComponent(trimmed)}&branch=${encodeURIComponent(activeUnit && activeUnit !== "ALL" ? activeUnit : "PEPIPL")}`);
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

    // CRITICAL: DO NOT overwrite base part size (#sheetSizeInput)!
    // #sheetSizeInput represents the Base Part Blank Size (T x L x W), NOT the Raw Material sheet size!
    // Store custom RM sheet dimensions in window._selectedCustomRmRecord:
    window._selectedCustomRmRecord = record;

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
        const customDim = (record.thickness && record.length && record.width)
            ? `${record.thickness} × ${record.length} × ${record.width} mm`
            : (record.sheet_size || record.item_code);
        customOpt.textContent = `⭐ [Custom] ${gradeVal} • ${customDim} (${record.item_code})`;
        customOpt.dataset.isCustom = "true";
        customOpt.dataset.record = JSON.stringify({
            ...record,
            rm_erp: record.item_code,
            grade: gradeVal,
            length: record.length || 2500,
            width: record.width || 1250,
            thickness: record.thickness || 2.0,
            sheet_size: record.sheet_size || "",
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
    const stdCard = document.getElementById("radioCardStd");
    if (stdCard) {
        stdCard.classList.add("disabled");
        stdCard.title = "Custom layouts are strictly Non-Standard.";
    }
    updateLayoutTypeUI(false);

    // 6. Recalculate target quantity & render all parts breakdown
    recalculateTargetQtyFromLayout();

    // 7. Intelligence & Stock Feasibility
    const onhand = parseFloat(record.onhand_stock) || 0;
    const quickStockEl = document.getElementById("rmStockBoxVal");
    if (quickStockEl) quickStockEl.textContent = `${onhand} Sheets`;
    if (onhand <= 0) {
        setZeroStockUiState(true, record.item_code);
    } else {
        setZeroStockUiState(false, record.item_code);
    }
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

function onSheetsRequiredInput() {
    const sheetsNeeded = Math.max(1, parseFloat(document.getElementById("sheetsRequired")?.value) || 1);
    const stdRows = document.querySelectorAll("#modalAdditionalPartsList .std-companion-part-row");
    stdRows.forEach(row => {
        const bPerSheet = parseFloat(row.dataset.blanksPerSheet) || 1;
        const stripVal = parseFloat(row.dataset.stripQty) || 1;
        const qtyInp = row.querySelector(".add-part-qty");
        if (qtyInp) {
            qtyInp.value = Math.max(1, Math.round(bPerSheet * stripVal * sheetsNeeded));
        }
    });
    recalculateTargetQtyFromLayout();
}
window.onSheetsRequiredInput = onSheetsRequiredInput;

function recalculateTargetQtyFromLayout() {
    const isStd = document.querySelector('input[name="is_standard_layout"]:checked')?.value === "true";
    const rmSelect = document.getElementById("rmErpSelect");
    const opt = rmSelect?.selectedOptions[0];
    let record = opt && opt.dataset.record ? JSON.parse(opt.dataset.record) : null;
    if (!record && window._selectedCustomRmRecord) {
        record = window._selectedCustomRmRecord;
    }
    if (!record) {
        record = {
            part_no: document.getElementById("partNoInput")?.value || "Base Part",
            base_part: document.getElementById("basePartInput")?.value || "",
            sheet_size: "2500*1250",
            status: isStd ? "Standardized" : "Non-Standard"
        };
    }

    const sheetsNeeded = Math.max(1, parseFloat(document.getElementById("sheetsRequired")?.value) || 1);
    const allLayoutParts = [];

    // 1. Primary / Base Part (Row 1)
    const p1PartNo = document.getElementById("partNoInput")?.value?.trim() || record.part1?.part_no || record.part_no || "Base Part";
    const p1BasePart = document.getElementById("basePartInput")?.value?.trim() || (p1PartNo ? p1PartNo.split(" - ")[0] : "");
    const p1Size = document.getElementById("sheetSizeInput")?.value?.trim() || record.part1?.cut_blank || record.cut_blank || "";
    const p1Strip = parseInt(document.getElementById("stripPerBlankInput")?.value) || 1;

    let p1Blanks = 1;
    if (currentCutOptResult?.parts_summary && currentCutOptResult.parts_summary.length > 0) {
        const bpMatch = currentCutOptResult.parts_summary.find(p => p.is_base || (p.part_no && p1PartNo && p.part_no === p1PartNo)) || currentCutOptResult.parts_summary[0];
        if (bpMatch && bpMatch.placed_qty !== undefined) {
            p1Blanks = bpMatch.placed_qty;
        }
    } else if (window._basePartPlacedBlanks) {
        p1Blanks = window._basePartPlacedBlanks;
    } else if (record.part1?.blank_qty) {
        p1Blanks = parseFloat(record.part1.blank_qty) || 1;
    } else if (record.blank_qty) {
        p1Blanks = parseFloat(record.blank_qty) || 1;
    }

    const p1TotalQty = Math.round(sheetsNeeded * p1Blanks * p1Strip);
    allLayoutParts.push({
        label: "Primary (Base Part)",
        part_no: p1PartNo,
        base_part: p1BasePart,
        size: p1Size,
        partQty: p1Blanks,
        blanksPerSheet: p1Blanks,
        stripQty: p1Strip,
        totalQty: p1TotalQty,
        is_base: true
    });

    // 2. Additional Parts from Modal "Parts to Cut on this Sheet" (#modalAdditionalPartsList)
    const modalAddRows = document.querySelectorAll("#modalAdditionalPartsList .modal-add-part-row");
    if (modalAddRows && modalAddRows.length > 0) {
        modalAddRows.forEach((r, idx) => {
            const rowPartNo = r.querySelector(".add-part-no")?.value?.trim() || `Part ${idx + 2}`;
            const rowBasePart = rowPartNo.split(" - ")[0];
            const rowSize = r.querySelector(".add-part-size")?.value?.trim() || "";
            const rowStrip = parseInt(r.querySelector(".add-part-strip")?.value) || 1;
            
            let rowBlanks = 1;
            if (currentCutOptResult?.parts_summary && currentCutOptResult.parts_summary.length > 0) {
                const match = currentCutOptResult.parts_summary.find(p => p.part_no === rowPartNo || (p.row_id && p.row_id === (idx + 2)));
                if (match && match.placed_qty !== undefined) {
                    rowBlanks = match.placed_qty;
                    const qInput = r.querySelector(".add-part-qty");
                    if (qInput) qInput.value = rowBlanks;
                    r.dataset.placedBlanks = rowBlanks;
                } else if (r.dataset.placedBlanks) {
                    rowBlanks = parseInt(r.dataset.placedBlanks, 10) || 1;
                } else {
                    rowBlanks = Math.max(1, parseInt(r.querySelector(".add-part-qty")?.value) || 1);
                }
            } else if (r.dataset.placedBlanks) {
                rowBlanks = parseInt(r.dataset.placedBlanks, 10) || 1;
            } else {
                rowBlanks = Math.max(1, parseInt(r.querySelector(".add-part-qty")?.value) || 1);
            }

            const rowTotalQty = Math.round(sheetsNeeded * rowBlanks * rowStrip);
            allLayoutParts.push({
                label: `Added Part ${idx + 1}`,
                part_no: rowPartNo,
                base_part: rowBasePart,
                size: rowSize,
                partQty: rowBlanks,
                blanksPerSheet: rowBlanks,
                stripQty: rowStrip,
                totalQty: rowTotalQty,
                is_base: false
            });

            // Update live output badge on this added part card
            let outBadge = r.querySelector(".add-part-output-badge");
            if (!outBadge) {
                outBadge = document.createElement("div");
                outBadge.className = "add-part-output-badge";
                outBadge.style.cssText = "margin-top: 6px; padding: 4px 10px; background: #f0fdf4; border: 1px solid #86efac; border-radius: 6px; font-size: 0.76rem; color: #166534; display: flex; align-items: center; justify-content: space-between;";
                r.appendChild(outBadge);
            }
            outBadge.innerHTML = `
                <span><i class="fa-solid fa-shapes" style="color: #16a34a;"></i> <strong>${escapeHtml(rowPartNo)} Output:</strong> ${rowTotalQty.toLocaleString()} Nos</span>
                <span style="font-weight: 700; color: #047857;">${rowBlanks} blanks/sheet × ${sheetsNeeded} sheet${sheetsNeeded > 1 ? 's' : ''}</span>
            `;
        });
    }

    // 3. Child parts 2, 3, 4 from Standard Layout record (preserved strictly for PEPIPL standard layout from layout_records)
    const activeComp = (window.AUTH_BRANCH_CODE || window.AUTH_COMPANY_ID || document.getElementById("modalUnitSelect")?.value || "PEPIPL").toUpperCase();
    const isPepipl = (activeComp === "PEPIPL" || activeComp === "ALL");
    if (isStd && isPepipl && record) {
        [record.part2, record.part3, record.part4].forEach((child, cIdx) => {
            if (child && child.part_no) {
                const cleanChild = child.part_no.toUpperCase().replace(/[^A-Z0-9]/g, "");
                const alreadyExists = allLayoutParts.some(p => {
                    const cleanP = (p.part_no || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
                    return cleanP && cleanChild && cleanP === cleanChild;
                });
                if (!alreadyExists) {
                    const cPartQty = parseFloat(child.blank_qty) || 1;
                    const cStripQty = parseFloat(child.strip_qty) || 1;
                    const cTotalQty = Math.round(sheetsNeeded * cPartQty * cStripQty);
                    allLayoutParts.push({
                        label: `Part ${cIdx + 2}`,
                        part_no: child.part_no,
                        base_part: child.part_no.split(" - ")[0],
                        size: child.cut_blank || "",
                        partQty: cPartQty,
                        blanksPerSheet: cPartQty,
                        stripQty: cStripQty,
                        totalQty: cTotalQty,
                        is_base: false
                    });
                }
            }
        });
    }

    // 4. Sum of all parts output
    const computedTargetQty = allLayoutParts.reduce((sum, p) => sum + p.totalQty, 0);

    // Sync with targetQty hidden input & manual input
    const manualInput = document.getElementById("targetQtyManual");
    const targetQtyInput = document.getElementById("targetQty");
    if (manualInput) manualInput.value = computedTargetQty;
    if (targetQtyInput) targetQtyInput.value = computedTargetQty;

    // 5. Update Current Plan Display Box
    const autoQtyVal = document.getElementById("autoTargetQtyDisplay");
    if (autoQtyVal) {
        if (allLayoutParts.length > 1) {
            autoQtyVal.innerHTML = `
                <div style="display: flex; align-items: baseline; gap: 8px;">
                    <span>${computedTargetQty.toLocaleString()} Units</span>
                    <span class="badge" style="background: #e0f2fe; color: #0284c7; font-size: 0.82rem; padding: 2px 10px; border-radius: 12px; font-weight: 700;">
                        <i class="fa-solid fa-shapes"></i> ${allLayoutParts.length} Parts Total
                    </span>
                </div>
            `;
        } else {
            autoQtyVal.innerHTML = `${computedTargetQty.toLocaleString()} Units`;
        }
    }

    // 6. Update Auto Qty Hint with itemized count for ALL parts
    const autoQtyHint = document.getElementById("autoQtyHint");
    if (autoQtyHint) {
        if (allLayoutParts.length > 1) {
            const partsPillsHtml = allLayoutParts.map((p, idx) => `
                <span style="display: inline-flex; align-items: center; gap: 5px; background: #ffffff; border: 1.5px solid #cbd5e1; border-radius: 6px; padding: 3px 8px; font-size: 0.78rem;">
                    <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${idx === 0 ? '#0284c7' : '#7c3aed'};"></span>
                    <strong>${escapeHtml(p.part_no)}:</strong>
                    <span style="color: #047857; font-weight: 800;">${p.totalQty.toLocaleString()} Nos</span>
                    <small style="color: #64748b;">(${p.blanksPerSheet}/sheet × ${sheetsNeeded} sh)</small>
                </span>
            `).join("");
            autoQtyHint.innerHTML = `
                <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px;">
                    ${partsPillsHtml}
                </div>
                <div style="font-size: 0.74rem; color: #64748b; margin-top: 4px;">
                    <i class="fa-solid fa-calculator"></i> Total Output: <strong>${computedTargetQty.toLocaleString()} Units</strong> across ${allLayoutParts.length} parts (${sheetsNeeded} sheet${sheetsNeeded > 1 ? 's' : ''} total)
                </div>
            `;
        } else {
            autoQtyHint.textContent = `${sheetsNeeded} sheet(s) × ${allLayoutParts[0].blanksPerSheet} blanks/sheet = ${computedTargetQty.toLocaleString()} Units`;
        }
    }

    // 7. Update Layout Parts & Off-take Banner (ALWAYS VISIBLE for all parts!)
    const banner = document.getElementById("layoutPartsBanner");
    const partsList = document.getElementById("layoutPartsList");
    const planBadge = document.getElementById("layoutPlanBadge");
    const thumbWrap = document.getElementById("layoutThumbWrap");
    const thumbImg = document.getElementById("layoutThumbImg");

    if (banner && partsList) {
        banner.style.display = "flex";
        if (planBadge) {
            const yVal = document.getElementById("yieldPctInput")?.value || record.per_sheet?.yield_pct || record.yield_pct;
            const yStr = yVal && String(yVal).trim() !== "" && String(yVal).trim() !== "N/A" ? ` • Yield: ${String(yVal).replace('%', '')}%` : "";
            planBadge.textContent = `${allLayoutParts.length} Part${allLayoutParts.length > 1 ? 's' : ''} on Sheet` + yStr;
        }

        let partsHtml = "";
        allLayoutParts.forEach((p, idx) => {
            const chipClass = idx === 0 ? "layout-part-chip primary" : "layout-part-chip";
            const icon = idx === 0 ? "fa-solid fa-star" : "fa-solid fa-shapes";
            const formattedSize = p.size ? formatPartSize(p.size) : "";
            partsHtml += `
                <div class="${chipClass}" style="margin-bottom: 6px;">
                    <span class="part-chip-name" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
                        <span><i class="${icon}"></i> ${escapeHtml(p.part_no)} ${idx === 0 ? '(Base Part)' : ''}</span>
                        ${formattedSize ? `<span class="part-kpi-size-badge"><i class="fa-solid fa-ruler-combined"></i> Size: <strong>${escapeHtml(formattedSize)}</strong></span>` : ''}
                    </span>
                    <span class="part-chip-qty" style="color: #047857; font-weight: 800;">
                        ${p.totalQty.toLocaleString()} Nos
                        <small style="color: #64748b; font-weight: normal;">(${sheetsNeeded} sheet${sheetsNeeded > 1 ? 's' : ''} × ${p.blanksPerSheet} blanks/sheet)</small>
                    </span>
                </div>
            `;
        });
        partsList.innerHTML = partsHtml;

        // Thumbnail preview if image exists
        if (thumbWrap && thumbImg) {
            if (activeOptiCutterLayoutFile) {
                try {
                    thumbImg.src = URL.createObjectURL(activeOptiCutterLayoutFile);
                    thumbWrap.style.display = "flex";
                } catch(e) {}
            } else if (record.image_url) {
                thumbImg.src = record.image_url;
                thumbWrap.style.display = "flex";
            } else {
                thumbWrap.style.display = "none";
            }
        }
    }

    // Render End Bits (Offcuts) Preview for this layout & sheets if standard
    if (typeof renderLayoutEndbits === "function" && isStd) {
        renderLayoutEndbits(record, sheetsNeeded);
    }

    if (typeof updateAutomatedConstraints === "function") {
        updateAutomatedConstraints(currentIntelData?.stock_feasibility, record);
    }
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
    const nonStdPartsBox = document.getElementById("nonStdPartsBox");
    if (nonStdPartsBox) nonStdPartsBox.style.display = "none";
    const layoutPartsBanner = document.getElementById("layoutPartsBanner");
    if (layoutPartsBanner) layoutPartsBanner.style.display = "flex";

    // Dynamic Plan Mode UI: Auto-Calculated for both Standard & Non-Standard Layouts
    const autoDisplay = document.getElementById("autoQtyDisplayBox");
    const manualBox = document.getElementById("manualQtyInputBox");
    const badge = document.getElementById("currentPlanBadge");

    if (autoDisplay) autoDisplay.style.display = "flex";
    if (manualBox) manualBox.style.display = "none";
    if (badge) {
        badge.className = "badge-auto";
        badge.innerHTML = '<i class="fa-solid fa-calculator"></i> Auto-Fetched';
    }

    if (isStandard) {
        const record = getSelectedLayoutRecord();
        if (typeof renderStandardLayoutCompanionParts === "function") {
            renderStandardLayoutCompanionParts(record);
        }
    } else {
        const list = document.getElementById("modalAdditionalPartsList");
        if (list) {
            list.querySelectorAll(".std-companion-part-row").forEach(r => r.remove());
            if (typeof updateModalAddPartsCountBadge === "function") {
                updateModalAddPartsCountBadge();
            }
        }
    }

    recalculateTargetQtyFromLayout();

    updateAutomatedConstraints(currentIntelData?.stock_feasibility, getSelectedLayoutRecord());
}

function onManualTargetQtyInput(val) {
    const hiddenTarget = document.getElementById("targetQty");
    const num = Math.max(1, parseInt(val, 10) || 1);
    if (hiddenTarget) {
        hiddenTarget.value = num;
    }

    // Reflect manual plan in Primary Part Chip
    const primaryChipQty = document.querySelector("#layoutPartsList .layout-part-chip.primary .part-chip-qty");
    if (primaryChipQty) {
        primaryChipQty.innerHTML = `${num.toLocaleString()} Nos <small>(Manual Plan)</small>`;
    }

    // Live update constraints verification check
    const record = getSelectedLayoutRecord();
    updateAutomatedConstraints(currentIntelData?.stock_feasibility, record);
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
    const rmSelect = document.getElementById("rmErpSelect");
    const opt = rmSelect?.selectedOptions[0];
    const isCustom = opt && (
        opt.dataset.isCustom === "true" || 
        opt.value === "__custom__" || 
        (opt.textContent || "").toLowerCase().includes("custom")
    );
    if (isCustom && isStandard) {
        const nonStdRadio = document.querySelector('input[name="is_standard_layout"][value="false"]');
        if (nonStdRadio) nonStdRadio.checked = true;
        updateLayoutTypeUI(false);
        return;
    }
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
    } else if (currentIntelData && currentIntelData.stock_feasibility && typeof currentIntelData.stock_feasibility.is_sufficient !== "undefined") {
        isStockSufficient = !!currentIntelData.stock_feasibility.is_sufficient;
        onhandSheets = currentIntelData.stock_feasibility.sheets_onhand;
    } else if (currentIntelData && currentIntelData.rm_opening_stock) {
        onhandSheets = currentIntelData.rm_opening_stock.onhand_stock || 0;
        isStockSufficient = onhandSheets >= sheetsNeeded;
    }

    // Double check with quick stock display and layout record available_sheets
    const quickStockVal = parseFloat((document.getElementById("rmStockBoxVal")?.textContent || "").replace(/[^\d\.]/g, "")) || 0;
    const quickStockText = (document.getElementById("rmStockBoxVal")?.textContent || "").trim();
    if (!isStockSufficient) {
        if (quickStockVal >= sheetsNeeded) {
            isStockSufficient = true;
            onhandSheets = quickStockVal;
        } else if (layoutRecord && layoutRecord.available_sheets !== undefined) {
            const recStock = parseFloat(layoutRecord.available_sheets) || 0;
            if (recStock >= sheetsNeeded) {
                isStockSufficient = true;
                onhandSheets = recStock;
            }
        }
    }

    const isZeroStock = (onhandSheets !== null && onhandSheets <= 0) || (quickStockText === "0 Sheets" || (!isNaN(quickStockVal) && quickStockVal <= 0 && quickStockText !== "- Sheets"));
    if (isZeroStock) {
        isStockSufficient = false;
        setZeroStockUiState(true);
    } else if (onhandSheets !== null && onhandSheets > 0) {
        setZeroStockUiState(false);
    }

    if (stockHidden) {
        stockHidden.value = isStockSufficient ? "true" : "false";
    }

    // 2. Constraint 2: MRP Target Availability Check (mrp > 0; if 0, N/A, null, or missing for ANY part, constraint fails!)
    let isMrpAvailable = true;
    let mrpFailureReason = null;
    const plan = currentIntelData?.planning_summary;
    const planParts = plan?.parts;

    // Helper to extract a numeric target (>0) from any part/plan/mrp object
    function extractNumericTarget(obj) {
        if (!obj || typeof obj !== "object") return 0;
        const keys = [
            "mrp_monthly_target",
            "qty_to_produce",
            "base_qty_to_produce",
            "monthly_schedule",
            "monthly_target",
            "total_qty",
            "balance_planning",
            "target_qty"
        ];
        for (const k of keys) {
            const v = obj[k];
            if (v !== null && v !== undefined && v !== "N/A" && v !== "") {
                const num = parseFloat(v);
                if (!isNaN(num) && num > 0) return num;
            }
        }
        return 0;
    }

    // Helper to normalize part number strings (e.g. F5P03014 - Item 1 vs F5P03014ITEM01)
    function normPart(p) {
        if (!p) return "";
        return String(p).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/ITEM0*(\d+)/g, 'ITEM$1');
    }

    // Collect all parts in the layout to ensure every part has a valid > 0 MRP target
    const layoutPartsList = [];
    if (layoutRecord) {
        if (layoutRecord.part1) layoutPartsList.push(layoutRecord.part1);
        else if (layoutRecord.part_no) layoutPartsList.push(layoutRecord);
        [layoutRecord.part2, layoutRecord.part3, layoutRecord.part4].forEach(child => {
            if (child && child.part_no) layoutPartsList.push(child);
        });
    }

    // Fallback MRP target from selectedPartData (or selectedPartData.mrp, or Card 1 displayed target)
    const activeCard1Target = parseFloat((document.getElementById("mrpQtyToProduceVal")?.textContent || "").replace(/[^\d\.]/g, "")) || 0;
    const activeCard3Balance = parseFloat((document.getElementById("mrpBalanceVal")?.textContent || "").replace(/[^\d\.]/g, "")) || 0;
    const selectedPartTarget = extractNumericTarget(selectedPartData?.mrp) || extractNumericTarget(selectedPartData) || activeCard1Target;
    const currentSelectedPartNorm = normPart(selectedPartData?.part_no || document.getElementById("partNoInput")?.value);

    if (planParts && planParts.length > 0) {
        // Multi-part layout or multiple parts in plan: check EACH part
        for (const p of planParts) {
            const pNorm = normPart(p.part_no || p.child_part_no);
            const isCurrentPart = pNorm && currentSelectedPartNorm && (pNorm === currentSelectedPartNorm || pNorm.includes(currentSelectedPartNorm) || currentSelectedPartNorm.includes(pNorm));
            const pTarget = extractNumericTarget(p) || (isCurrentPart ? selectedPartTarget : 0);
            if (pTarget <= 0) {
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
                const lpNorm = normPart(lpNo);
                const isCurrentPart = lpNorm && currentSelectedPartNorm && (lpNorm === currentSelectedPartNorm || lpNorm.includes(currentSelectedPartNorm) || currentSelectedPartNorm.includes(lpNorm));
                const matched = planParts.find(p => {
                    const pNorm = normPart(p.part_no || p.child_part_no);
                    return pNorm && (pNorm === lpNorm || pNorm.includes(lpNorm) || lpNorm.includes(pNorm));
                });
                const lpTarget = extractNumericTarget(matched) || extractNumericTarget(lp) || (isCurrentPart ? selectedPartTarget : 0);
                if (lpTarget <= 0) {
                    isMrpAvailable = false;
                    mrpFailureReason = `No MRP Target for ${lpNo} (N/A)`;
                    break;
                }
            }
        }
    } else if (plan) {
        const target = extractNumericTarget(plan) || selectedPartTarget;
        if (target <= 0) {
            isMrpAvailable = false;
            mrpFailureReason = "No MRP Target (N/A)";
        }
    } else if (selectedPartTarget > 0) {
        // plan not loaded yet or offline, but selectedPartData has valid MRP demand
        isMrpAvailable = true;
        mrpFailureReason = null;
    } else {
        const inputPart = document.getElementById("partNoInput")?.value?.trim();
        if (inputPart) {
            isMrpAvailable = false;
            mrpFailureReason = "No MRP Target (N/A)";
        } else {
            isMrpAvailable = true; // Neutral when no part selected
            mrpFailureReason = null;
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
                let remQty = (p.remaining_quantity !== null && p.remaining_quantity !== undefined)
                    ? parseFloat(p.remaining_quantity)
                    : null;
                const pNorm = normPart(p.part_no || p.child_part_no);
                const isCurrentPart = pNorm && currentSelectedPartNorm && (pNorm === currentSelectedPartNorm || pNorm.includes(currentSelectedPartNorm) || currentSelectedPartNorm.includes(pNorm));
                if ((remQty === null || remQty <= 0) && isCurrentPart && activeCard3Balance > 0) {
                    remQty = activeCard3Balance;
                }
                if (remQty !== null) {
                    if (remQty < partCurrentPlan) {
                        isRemainingSufficient = false;
                    }
                }
            });
        } else {
            const currentPlanTotal = parseFloat(document.getElementById("targetQty")?.value) || sheetsNeeded;
            let planRem = (plan && plan.remaining_quantity !== null && plan.remaining_quantity !== undefined)
                ? parseFloat(plan.remaining_quantity)
                : null;
            if ((planRem === null || planRem <= 0) && activeCard3Balance > 0) {
                planRem = activeCard3Balance;
            }
            if (planRem !== null && planRem < currentPlanTotal) {
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
    if (isZeroStock) {
        failedConstraints.push("0 RM Sheets in Store (Cannot Produce MO)");
    } else if (!isStockSufficient) {
        failedConstraints.push("RM Stock Shortfall");
    }

    const currentPartVal = document.getElementById("partNoInput")?.value;
    if (currentPartVal) {
        triggerRmAgentSuggestions({
            part_no: currentPartVal,
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
        if (verdict) verdict.textContent = "AI Agent scanning in-store endbits for this part size, then evaluating fresh RM sheets...";
        if (badge) badge.textContent = "Analyzing...";
        list.innerHTML = `
            <div style="text-align: center; padding: 14px; color: #0284c7; font-size: 0.82rem;">
                <i class="fa-solid fa-circle-notch fa-spin"></i> Checking store offcuts &amp; raw material sheets...
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
            const activeUnit = document.getElementById("modalUnitSelect")?.value || window._activeUnit || window.AUTH_COMPANY_ID || "PEPIPL";
            qParams.set("branch", activeUnit && activeUnit !== "ALL" ? activeUnit : (window.AUTH_COMPANY_ID || "PEPIPL"));

            const res = await fetch(`/api/agent/suggest-rm-alternatives?${qParams.toString()}`);
            if (!res.ok) {
                hideRmAgentSuggestions();
                return;
            }

            const data = await res.json();

            // Strictly filter out any alternative with 0 sheets / 0 available stock
            if (data.recommendations && Array.isArray(data.recommendations)) {
                data.recommendations = data.recommendations.filter(r => {
                    const st = parseFloat(r.onhand_stock !== undefined ? r.onhand_stock : r.available_qty) || 0;
                    return st > 0;
                });
            }

            if (!data.recommendations || data.recommendations.length === 0) {
                if (data.has_shortage) {
                    activeRmAgentRecommendations = [];
                    if (verdict) verdict.textContent = data.agent_verdict || "Critical Shortage: No alternative in-stock RM sheets or offcuts found in store.";
                    if (badge) badge.textContent = "0 Options";
                    list.innerHTML = `
                        <div class="rm-agent-card partial" style="justify-content: center; text-align: center; padding: 14px;">
                            <div style="font-size: 0.82rem; color: #b45309;">
                                <i class="fa-solid fa-triangle-exclamation"></i> No compatible in-store offcuts or RM sheets found in the store. 
                                <strong>Order must be routed to Purchase Clearance.</strong>
                            </div>
                        </div>
                    `;
                } else {
                    hideRmAgentSuggestions();
                }
                return;
            }

            activeRmAgentRecommendations = data.recommendations;
            if (verdict) verdict.textContent = data.agent_verdict;
            const ebCount = data.endbits_count || data.recommendations.filter(r => r.type === 'endbit_salvage').length;
            const rmCount = data.recommendations.length - ebCount;
            const engineLabel = data.powered_by ? `<span style="background: rgba(255,255,255,0.25); padding: 2px 7px; border-radius: 10px; margin-left: 6px;"><i class="fa-solid fa-diagram-project"></i> ${escapeHtml(data.powered_by)}</span>` : '';
            
            let badgeText = "";
            if (ebCount > 0 && rmCount > 0) {
                badgeText = `✂️ ${ebCount} Endbit${ebCount > 1 ? 's' : ''} • 📄 ${rmCount} RM Sheet${rmCount > 1 ? 's' : ''}`;
            } else if (ebCount > 0) {
                badgeText = `✂️ ${ebCount} Endbit${ebCount > 1 ? 's' : ''} Ready`;
            } else {
                badgeText = `📄 ${rmCount} RM Option${rmCount > 1 ? 's' : ''}`;
            }
            if (badge) badge.innerHTML = `${badgeText}${engineLabel}`;

            list.innerHTML = data.recommendations.map((rec, idx) => {
                const isSuff = rec.stock_sufficient;
                const isEndbit = rec.type === 'endbit_salvage';
                const typeClass = rec.type === 'engineered_layout' ? 'layout' : (isEndbit ? 'endbit' : 'sheet');

                return `
                    <div class="rm-agent-card ${isEndbit ? 'sufficient' : (isSuff ? 'sufficient' : 'partial')}" style="${isEndbit ? 'border-left: 4.5px solid #10b981; background: #f0fdf4;' : ''}">
                        <div class="rm-agent-card-info">
                            <div class="rm-agent-card-tags">
                                <span class="rm-agent-pill-type ${typeClass}" style="${isEndbit ? 'background: #dcfce7; color: #15803d; font-weight: 800;' : ''}">
                                    ${escapeHtml(rec.tier_label)}
                                </span>
                                ${isEndbit 
                                    ? `<span style="background: #ecfdf5; color: #047857; font-size: 0.72rem; font-weight: 700; padding: 2px 8px; border-radius: 4px; border: 1px solid #a7f3d0;"><i class="fa-solid fa-leaf"></i> 0 Virgin Sheets</span>` 
                                    : (isSuff 
                                        ? `<span style="background: #dcfce7; color: #15803d; font-size: 0.7rem; font-weight: 700; padding: 2px 6px; border-radius: 4px;"><i class="fa-solid fa-check"></i> Stock Ready</span>` 
                                        : `<span style="background: #fef9c3; color: #854d0e; font-size: 0.7rem; font-weight: 700; padding: 2px 6px; border-radius: 4px;"><i class="fa-solid fa-triangle-exclamation"></i> Partial Stock</span>`)}
                                ${rec.yield_pct ? `<span style="background: #e0f2fe; color: #0369a1; font-size: 0.7rem; font-weight: 700; padding: 2px 6px; border-radius: 4px;"><i class="fa-solid fa-chart-pie"></i> ${rec.yield_pct}% Yield</span>` : ''}
                            </div>
                            <div class="rm-agent-card-title">
                                ${escapeHtml(rec.rm_erp)} ${rec.layout_name ? `• <span style="font-weight: 600; color: #64748b; font-size: 0.8rem;">Layout: ${escapeHtml(rec.layout_name)}</span>` : ''}
                            </div>
                            <div class="rm-agent-card-desc">
                                ${escapeHtml(rec.reason)}
                            </div>
                            <div class="rm-agent-metrics">
                                <span><i class="fa-solid fa-warehouse"></i> Store Stock: <strong>${rec.onhand_stock} ${isEndbit ? 'Offcut(s)' : 'sheets'}</strong></span>
                                ${isEndbit 
                                    ? `<span><i class="fa-solid fa-cubes-stacked"></i> Can Harvest: <strong>${rec.parts_producible || rec.parts_per_sheet || 1} blanks</strong></span>` 
                                    : (rec.sheets_needed ? `<span><i class="fa-solid fa-layer-group"></i> Needed: <strong>${rec.sheets_needed} sheets</strong></span>` : '')}
                                ${!isEndbit && rec.parts_per_sheet ? `<span><i class="fa-solid fa-cubes"></i> Blanks/sheet: <strong>${rec.parts_per_sheet}</strong></span>` : ''}
                            </div>
                        </div>
                        <div>
                            <button type="button" class="btn-apply-rm-agent ${isEndbit ? 'endbit' : ''}" onclick="applyRmAgentRecommendation(${idx})" style="${isEndbit ? 'background: #059669; font-weight: 700; padding: 8px 14px;' : ''}">
                                ${isEndbit ? `<i class="fa-solid fa-scissors"></i> Shear from Endbit` : `<i class="fa-solid fa-check"></i> Select This RM`}
                            </button>
                        </div>
                    </div>
                `;
            }).join("");

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
        const ebMsg = "✂️ AI RM Advisor Recommendation:\n\n" +
                      "Offcut: [" + (rec.endbit_name || 'End Bit') + "] #" + (rec.endbit_id || '') + "\n" +
                      "Dimensions: " + (payload.dim_str || '') + " mm (Grade: " + (payload.grade || '') + ")\n" +
                      "Capacity: Can produce up to " + (rec.parts_producible || 1) + " blanks with ZERO virgin sheets!\n\n" +
                      "• Click OK to open the End-Bit MO portal with this offcut pre-selected for shearing.\n" +
                      "• Click Cancel to stay in this window.";
        if (confirm(ebMsg)) {
            closeCreateModal();
            showCreateEndbitMoView(payload.endbit_id);
        }
        return;
    }

    const rmSelect = document.getElementById("rmErpSelect");
    if (!rmSelect) return;

    // Cache the selected recommendation globally for OptiCutter and 2D nesting
    window._selectedRmAgentRecord = rec;

    let targetOpt = Array.from(rmSelect.options).find(o => o.value === rec.rm_erp || (o.value && o.value.toLowerCase() === rec.rm_erp.toLowerCase()));

    const basePart = window._activeBasePartData || {};
    const pThk = basePart.thickness !== undefined ? basePart.thickness : rec.thickness;
    const pLen = basePart.length !== undefined ? basePart.length : '';
    const pWid = basePart.width !== undefined ? basePart.width : '';
    const cutBlankStr = (pLen && pWid) ? `${pThk}*${pLen}*${pWid}` : (document.getElementById("sheetSizeInput")?.value || '');

    const recordData = {
        rm_erp: rec.rm_erp,
        layout_name: rec.layout_name || 'Standard',
        grade: rec.grade || basePart.grade || 'YS',
        thickness: rec.thickness || pThk,
        length: rec.length,
        width: rec.width,
        sheet_length: rec.length,
        sheet_width: rec.width,
        sheet_size: `${rec.thickness || pThk}*${rec.length}*${rec.width}`,
        available_sheets: rec.onhand_stock,
        onhand_stock: rec.onhand_stock,
        status: rec.status || 'AI Recommended RM',
        per_sheet: {
            yield_pct: rec.yield_pct,
            parts_produced: rec.parts_per_sheet
        },
        part1: {
            total_blank_qty_sheet: rec.parts_per_sheet,
            cut_blank: cutBlankStr,
            blank_size: {
                thickness: pThk,
                length: pLen,
                width: pWid
            }
        }
    };

    if (!targetOpt) {
        targetOpt = document.createElement("option");
        targetOpt.value = rec.rm_erp;
        const recDim = (rec.thickness && rec.length && rec.width) ? `${rec.thickness} × ${rec.length} × ${rec.width} mm` : '';
        const recGrade = rec.grade || basePart.grade || 'YS';
        targetOpt.textContent = recDim ? `✨ ${recGrade} • ${recDim} (${rec.rm_erp})` : `✨ ${rec.rm_erp} (${recGrade})`;
        // Insert right before custom option
        rmSelect.insertBefore(targetOpt, rmSelect.lastElementChild);
    }

    // Always update targetOpt.dataset.record with the fresh recommendation specifications!
    targetOpt.dataset.record = JSON.stringify(recordData);

    rmSelect.value = targetOpt.value;
    onRmErpChanged(targetOpt.value);

    // Toast confirmation
    alert(`🎉 AI RM Selection Applied!\n\n` +
          `• Selected RM: ${rec.rm_erp}\n` +
          `• Layout: ${rec.layout_name || 'Standard'}\n` +
          `• Store Stock: ${rec.onhand_stock} sheets available\n` +
          `• Estimated Yield: ${rec.yield_pct}%\n\n` +
          `The layout specifications and sheet calculations have been updated!`);
}

async function submitCreateMo(e) {
    e.preventDefault();
    const form = document.getElementById("createMoForm");
    const formData = new FormData(form);

    const activeUnit = document.getElementById("modalUnitSelect")?.value || window._activeUnit || window.AUTH_COMPANY_ID || "PEPIPL";
    const cid = (activeUnit && activeUnit !== "ALL") ? activeUnit : (window.AUTH_COMPANY_ID || "PEPIPL");
    formData.set("company_id", cid);
    formData.set("branch_code", cid);

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

    // 0 Available Sheets Guard: MO cannot be produced if RM available is 0!
    const quickStockText = (document.getElementById("rmStockBoxVal")?.textContent || "").trim();
    const quickStockNum = parseFloat(quickStockText.replace(/[^\d\.]/g, ""));
    const isZeroStock = (quickStockText === "0 Sheets" || quickStockText.startsWith("0 ") || (!isNaN(quickStockNum) && quickStockNum <= 0 && quickStockText !== "- Sheets"));
    if (isZeroStock) {
        alert(`❌ Cannot Produce Material Order!\n\nAvailable stock for Raw Material (${rmErp}) is 0 Sheets in Tara ERP.\nYou cannot produce this MO on this sheet. Please select another sheet or layout from the RM ERP Code dropdown.`);
        const rmSelect = document.getElementById("rmErpSelect");
        if (rmSelect) {
            rmSelect.focus();
            rmSelect.style.border = "2px solid #ef4444";
            rmSelect.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        return;
    }

    const isStd = formData.get("is_standard_layout") === "true";

    // Multi-part collection (Base Part + Added Parts from #modalAdditionalPartsList)
    const modalAddRows = document.querySelectorAll("#modalAdditionalPartsList .modal-add-part-row");
    const collectedParts = [];
    const basePartNo = document.getElementById("partNoInput")?.value?.trim();
    const basePartBase = document.getElementById("basePartInput")?.value?.trim() || (basePartNo ? basePartNo.split(" - ")[0] : "");
    const basePartSize = document.getElementById("sheetSizeInput")?.value?.trim() || "";
    const basePartGrade = document.getElementById("gradeInput")?.value?.trim() || "HR";
    const basePartStrip = parseInt(document.getElementById("stripPerBlankInput")?.value) || 1;
    const sheetsNeeded = Math.max(1, parseFloat(document.getElementById("sheetsRequired")?.value) || 1);

    let baseBlanks = window._basePartPlacedBlanks || 1;
    if (currentCutOptResult?.parts_summary?.length > 0) {
        const bpMatch = currentCutOptResult.parts_summary.find(p => p.is_base || (p.part_no && basePartNo && p.part_no === basePartNo)) || currentCutOptResult.parts_summary[0];
        if (bpMatch && bpMatch.placed_qty) baseBlanks = bpMatch.placed_qty;
    }
    const baseTotalQty = baseBlanks * basePartStrip * sheetsNeeded;

    if (basePartNo) {
        collectedParts.push({
            part_no: basePartNo,
            base_part: basePartBase,
            size: basePartSize,
            cut_blank: basePartSize,
            grade: basePartGrade,
            strip_qty: basePartStrip,
            strip_per_blank_qty: basePartStrip,
            blank_qty: baseBlanks,
            blanks_per_sheet: baseBlanks,
            target_qty: baseTotalQty,
            is_base: true
        });
    }

    if (modalAddRows && modalAddRows.length > 0) {
        modalAddRows.forEach((r, idx) => {
            const pNo = r.querySelector(".add-part-no")?.value?.trim();
            const pGrade = r.querySelector(".add-part-grade")?.value?.trim() || basePartGrade;
            const pSize = r.querySelector(".add-part-size")?.value?.trim() || "";
            const pStrip = parseInt(r.querySelector(".add-part-strip")?.value) || 1;
            let pBlanks = parseInt(r.querySelector(".add-part-qty")?.value) || 1;
            if (currentCutOptResult?.parts_summary?.length > 0) {
                const match = currentCutOptResult.parts_summary.find(p => p.part_no === pNo || (p.row_id && p.row_id === (idx + 2)));
                if (match && match.placed_qty) pBlanks = match.placed_qty;
            }
            const pTotal = pBlanks * pStrip * sheetsNeeded;
            if (pNo) {
                collectedParts.push({
                    part_no: pNo,
                    base_part: pNo.split(" - ")[0],
                    size: pSize,
                    cut_blank: pSize,
                    grade: pGrade,
                    strip_qty: pStrip,
                    strip_per_blank_qty: pStrip,
                    blank_qty: pBlanks,
                    blanks_per_sheet: pBlanks,
                    target_qty: pTotal,
                    is_base: false
                });
            }
        });
    }

    if (collectedParts.length > 0) {
        formData.set("parts", JSON.stringify(collectedParts));
        const totalTargetQty = collectedParts.reduce((sum, p) => sum + p.target_qty, 0);
        formData.set("target_qty", totalTargetQty);
    } else if (!isStd) {
        const nonStdPartsJson = document.getElementById("nonStdPartsJson")?.value;
        if (nonStdPartsJson && nonStdPartsJson !== "[]") {
            try {
                const partsArr = JSON.parse(nonStdPartsJson);
                if (partsArr && partsArr.length > 0) {
                    formData.set("parts", nonStdPartsJson);
                    const totalPartsQty = partsArr.reduce((sum, p) => sum + (parseInt(p.no_of_parts || p.target_qty) || 1), 0);
                    if (totalPartsQty > 0) {
                        formData.set("target_qty", totalPartsQty);
                    }
                }
            } catch (err) {
                console.warn("Failed to parse nonStdPartsJson:", err);
            }
        }
    }
    let file = formData.get("layout_doc");
    if ((!file || !file.name) && activeOptiCutterLayoutFile) {
        formData.set("layout_doc", activeOptiCutterLayoutFile);
        file = activeOptiCutterLayoutFile;
    }

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
            fetchNotifications(true);
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
function formatPartSize(sz) {
    if (!sz) return "";
    const str = String(sz).trim().replace(/^\*/, "").replace(/\*$/, "");
    if (!str || str === "N/A" || str === "-") return "";
    const parts = str.split("*").map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
        const cleaned = parts.map(p => {
            const n = parseFloat(p);
            return (!isNaN(n) && Number.isFinite(n)) ? (n % 1 === 0 ? n.toFixed(0) : String(n)) : p;
        });
        return cleaned.join(" × ") + " mm";
    }
    return str.includes("mm") ? str : `${str} mm`;
}

function renderReviewConstraints(mo) {
    const el = document.getElementById("reviewConstraintNotice");
    if (!el) return;

    let cs = mo.constraints_status;
    if (typeof cs === "string") {
        try { cs = JSON.parse(cs); } catch(e) { cs = {}; }
    }
    if (!cs || typeof cs !== "object") {
        el.style.display = "none";
        return;
    }

    const rawFailed = Array.isArray(cs.failed_constraints) ? cs.failed_constraints : [];
    const hasFailedStock = cs.stock_available === false || rawFailed.some(f => f.includes("Stock"));
    const hasFailedMrp = cs.mrp_available === false || rawFailed.some(f => f.includes("MRP"));
    const hasFailedRem = cs.remaining_quota_satisfied === false || rawFailed.some(f => f.includes("Remaining") || f.includes("Demand"));
    const hasFailedYield = cs.yield_satisfied === false || rawFailed.some(f => f.includes("Yield"));

    const failedList = [];
    if (hasFailedStock) {
        failedList.push({
            title: "RM Main Store Stock Shortfall",
            detail: "Insufficient sheets on hand in Main Store inventory"
        });
    }
    if (hasFailedMrp) {
        failedList.push({
            title: "MRP Monthly Schedule Demand Missing",
            detail: "No active BOM schedule / monthly target found in MRP"
        });
    }
    if (hasFailedRem) {
        failedList.push({
            title: "Plan Exceeds Remaining Demand",
            detail: "Target quantity exceeds outstanding monthly production quota"
        });
    }
    if (hasFailedYield) {
        failedList.push({
            title: "Layout Standardization / Low Yield",
            detail: "Non-standard layout requires Krysalis technical review"
        });
    }

    // Include any custom failed constraints from rawFailed
    rawFailed.forEach(f => {
        const alreadyIncluded = failedList.some(item =>
            item.title.toLowerCase().includes(f.toLowerCase()) ||
            f.toLowerCase().includes(item.title.toLowerCase())
        );
        if (!alreadyIncluded) {
            failedList.push({
                title: f,
                detail: "Constraint check failed"
            });
        }
    });

    const allOk = failedList.length === 0 && (cs.all_satisfied !== false);

    if (allOk) {
        el.innerHTML = `
            <div style="background: #f0fdf4; border: 1.5px solid #86efac; border-radius: 8px; padding: 10px 16px;">
                <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
                    <div style="display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 0.88rem; color: #166534;">
                        <i class="fa-solid fa-circle-check"></i>
                        <span>Automated Technical &amp; Planning Safety Verification</span>
                    </div>
                    <span class="constraint-status-badge pass" style="padding: 3px 10px; border-radius: 16px; font-weight: 700; font-size: 0.78rem; display: inline-flex; align-items: center; gap: 6px; background: #dcfce7; color: #15803d; border: 1px solid #86efac;">
                        <i class="fa-solid fa-square-check"></i> All Constraints Satisfied
                    </span>
                </div>
            </div>
        `;
    } else {
        el.innerHTML = `
            <div style="background: #fffbeb; border: 1.5px solid #fcd34d; border-radius: 8px; padding: 12px 16px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 8px;">
                    <div style="display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 0.88rem; color: #92400e;">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        <span>Automated Technical &amp; Planning Safety Verification</span>
                    </div>
                    <span class="constraint-status-badge fail" style="padding: 3px 10px; border-radius: 16px; font-weight: 700; font-size: 0.78rem; display: inline-flex; align-items: center; gap: 6px; background: #fef2f2; color: #dc2626; border: 1px solid #fca5a5;">
                        <i class="fa-solid fa-circle-xmark"></i> ${failedList.length} Constraint${failedList.length > 1 ? 's' : ''} Failed
                    </span>
                </div>
                <div style="display: flex; flex-direction: column; gap: 6px; font-size: 0.8rem;">
                    ${failedList.map(item => `
                        <div style="display: flex; align-items: center; gap: 8px; color: #b91c1c; background: #ffffff; padding: 8px 12px; border-radius: 6px; border: 1px solid #fecaca;">
                            <i class="fa-solid fa-xmark" style="color: #dc2626; font-weight: 900; font-size: 0.85rem;"></i>
                            <span style="font-weight: 700;">${escapeHtml(item.title)}</span>
                            ${item.detail ? `<span style="color: #64748b; font-size: 0.75rem;">— ${escapeHtml(item.detail)}</span>` : ''}
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    el.style.display = "block";
}

function renderReviewLayoutParts(mo) {
    const banner = document.getElementById("reviewLayoutPartsBanner");
    if (banner) banner.style.display = "none";
}

function formatEndbitName(eb, fallbackGrade = null) {
    if (!eb) return "offcut";
    const grade = (eb.grade || fallbackGrade || "hr").toString().trim().toLowerCase();

    // Collect available dimension numbers
    let nums = [];
    const dimStr = eb.dimensions || eb.dim || "";
    if (dimStr) {
        nums = (dimStr.toString().match(/[\d\.]+/g) || []).map(Number).filter(n => !isNaN(n) && n > 0);
    }
    if (nums.length === 0) {
        [eb.thickness, eb.length, eb.width].forEach(v => {
            const fv = parseFloat(v);
            if (!isNaN(fv) && fv > 0) nums.push(fv);
        });
    } else if (eb.thickness && parseFloat(eb.thickness) > 0) {
        const tv = parseFloat(eb.thickness);
        if (!nums.some(n => Math.abs(n - tv) < 0.01)) {
            nums.push(tv);
        }
    }

    const cleanNum = n => (Number.isInteger(n) ? n.toString() : parseFloat(n.toFixed(2)).toString());

    if (nums.length >= 3) {
        const sorted = [...nums.slice(0, 3)].sort((a, b) => a - b);
        const t = sorted[0];
        const minP = sorted[1];
        const maxP = sorted[2];
        return `${grade} - ${cleanNum(t)}*${cleanNum(minP)}*${cleanNum(maxP)}`;
    } else if (nums.length === 2) {
        const minP = Math.min(nums[0], nums[1]);
        const maxP = Math.max(nums[0], nums[1]);
        return `${grade} - ${cleanNum(minP)}*${cleanNum(maxP)}`;
    } else if (dimStr) {
        return `${grade} - ${dimStr}`;
    } else if (eb.name && eb.name.includes(" - ") && !eb.name.toLowerCase().startsWith("end bit")) {
        return eb.name;
    }
    return `${grade} - endbit`;
}

/**
 * Calculates offcut/endbit weight strictly using the formula:
 * (thickness * length * width * 7.85) / 1000000
 */
function calculateEndbitWeight(eb, fallbackThickness = null) {
    if (!eb) return 0;
    if (eb.weight_kg !== undefined && eb.weight_kg !== null && parseFloat(eb.weight_kg) > 0) {
        return parseFloat(parseFloat(eb.weight_kg).toFixed(3));
    }
    let t = parseFloat(eb.thickness || fallbackThickness || 0);
    let l = parseFloat(eb.length || 0);
    let w = parseFloat(eb.width || 0);

    if (!t || !l || !w) {
        const dimStr = eb.dimensions || eb.dim || eb.name || "";
        const nums = (dimStr.toString().match(/[\d\.]+/g) || []).map(Number).filter(n => !isNaN(n) && n > 0);
        if (nums.length >= 3) {
            const sorted = [...nums.slice(0, 3)].sort((a, b) => a - b);
            t = t > 0 ? t : sorted[0];
            const remaining = sorted.filter(n => Math.abs(n - t) > 0.001);
            if (remaining.length >= 2) {
                w = remaining[0];
                l = remaining[1];
            } else {
                w = sorted[1];
                l = sorted[2];
            }
        } else if (nums.length === 2 && t > 0) {
            w = Math.min(nums[0], nums[1]);
            l = Math.max(nums[0], nums[1]);
        }
    }

    if (t > 0 && l > 0 && w > 0) {
        const wt = (t * l * w * 7.85) / 1000000.0;
        return parseFloat(wt.toFixed(3));
    }
    return 0;
}

function formatEndbitWeight(eb, fallbackThickness = null) {
    const wt = calculateEndbitWeight(eb, fallbackThickness);
    return wt > 0 ? `${wt} kg` : "-";
}

function renderReviewLayoutEndbits(mo) {
    const banner = document.getElementById("reviewLayoutEndbitsBanner");
    const list = document.getElementById("reviewLayoutEndbitsList");
    const countBadge = document.getElementById("reviewEndbitsSummaryBadge");
    if (!banner || !list) return;

    let ebList = mo.endbits;
    if ((!ebList || !ebList.length) && mo.constraints_status && mo.constraints_status.endbits) {
        ebList = mo.constraints_status.endbits;
    }
    if ((!ebList || !ebList.length) && mo.layout_record?.endbits) {
        ebList = mo.layout_record.endbits;
    }

    if (!ebList || !Array.isArray(ebList) || ebList.length === 0) {
        banner.style.display = "none";
        list.innerHTML = "";
        return;
    }

    const sheetsNeeded = parseInt(mo.sheets_required) || 1;
    if (countBadge) {
        countBadge.textContent = `${ebList.length} Offcut Specification${ebList.length > 1 ? 's' : ''}`;
    }

    let cardsHtml = "";
    ebList.forEach((eb, idx) => {
        const ebName = formatEndbitName(eb, mo.grade);
        const qtyPerSheet = parseFloat(eb.qty_per_sheet) || parseFloat(eb.qty) || 1;
        const producedQty = eb.total_qty || Math.round(qtyPerSheet * sheetsNeeded) || 1;
        const gradeVal = eb.grade || mo.grade || "HR";
        const wtDisplay = formatEndbitWeight(eb, mo.thickness || mo.material_thickness);
        const ebId = eb.endbit_id || `EB-${mo.mo_number}-${idx + 1}`;
        const availQty = eb.available_qty !== undefined ? eb.available_qty : producedQty;

        cardsHtml += `
            <div class="endbit-mini-card neat-endbit-card">
                <div class="reb-clean-field">
                    <span class="reb-clean-label">End Bit Name</span>
                    <strong class="reb-clean-val reb-name-val"><i class="fa-solid fa-scissors" style="color: #0284c7; margin-right: 5px;"></i>${escapeHtml(ebName)}</strong>
                </div>
                <div class="reb-clean-row">
                    <div class="reb-clean-field">
                        <span class="reb-clean-label">No. of End Bits Produced</span>
                        <strong class="reb-clean-val">${producedQty} Nos</strong>
                    </div>
                    <div class="reb-clean-field">
                        <span class="reb-clean-label">Weight</span>
                        <strong class="reb-clean-val" style="color: #047857;">${escapeHtml(wtDisplay)}</strong>
                    </div>
                    <div class="reb-clean-field" style="text-align: right;">
                        <span class="reb-clean-label">Grade</span>
                        <span class="reb-grade-pill">${escapeHtml(gradeVal)}</span>
                    </div>
                </div>
                ${(currentRole === 'shearing' && availQty > 0) ? `
                <div style="margin-top: 10px; padding-top: 8px; border-top: 1px solid #f1f5f9;">
                    <button type="button" class="btn btn-primary btn-sm" style="width: 100%;" onclick="closeReviewModal(); openProducePartModal('${escapeHtml(ebId)}')">
                        <i class="fa-solid fa-shapes"></i> Create Part from this End Bit
                    </button>
                </div>
                ` : ''}
            </div>
        `;
    });

    list.innerHTML = cardsHtml;
    banner.style.display = "block";
}

async function openReviewModal(moNumber) {
    if (!moNumber) return;
    const modal = document.getElementById("reviewModal");
    try {
        const cleanMoNum = String(moNumber).trim();
        const res = await fetch(`/api/mo/${encodeURIComponent(cleanMoNum)}`);
        if (!res.ok) {
            const errJson = await res.json().catch(() => ({}));
            alert(`Unable to load Material Order details for "${cleanMoNum}": ${errJson.error || res.statusText || 'Record not found'}`);
            return;
        }
        activeReviewMo = await res.json();
        if (typeof activeReviewMo.parts === "string") {
            try { activeReviewMo.parts = JSON.parse(activeReviewMo.parts); } catch(e) {}
        }
        if (typeof activeReviewMo.parts_produced === "string") {
            try { activeReviewMo.parts_produced = JSON.parse(activeReviewMo.parts_produced); } catch(e) {}
        }
        if (!activeReviewMo.parts && Array.isArray(activeReviewMo.parts_produced)) {
            activeReviewMo.parts = activeReviewMo.parts_produced;
        }

        renderReviewModal(activeReviewMo);
        if (modal) modal.style.display = "flex";

        // Gather all parts from activeReviewMo (parts or layout_parts)
        const allParts = [];
        if (activeReviewMo.parts && Array.isArray(activeReviewMo.parts)) {
            activeReviewMo.parts.forEach(p => {
                const pNo = p.part_no || p.child_part_no;
                if (pNo && !allParts.includes(pNo)) allParts.push(pNo);
            });
        }
        if (activeReviewMo.layout_parts && Array.isArray(activeReviewMo.layout_parts)) {
            activeReviewMo.layout_parts.forEach(p => {
                const pNo = p.part_no || p.child_part_no;
                if (pNo && !allParts.includes(pNo)) allParts.push(pNo);
            });
        }
        if (activeReviewMo.part_no && !allParts.includes(activeReviewMo.part_no)) {
            allParts.unshift(activeReviewMo.part_no);
        }

        // Fetch ERP & Stock intelligence for the reviewed MO
        fetchAndDisplayIntelligence(
            activeReviewMo.part_no,
            activeReviewMo.rm_erp,
            activeReviewMo.grade,
            activeReviewMo.thickness,
            activeReviewMo.length,
            activeReviewMo.width,
            activeReviewMo.sheets_required || 1,
            true,
            allParts
        );
    } catch (err) {
        console.error("Failed to load MO details:", err);
        alert(`Error opening Material Order: ${err.message}`);
    }
}

function closeReviewModal() {
    activeReviewMo = null;
    activePurchaseAiDecision = null;
    reviewIntelData = null;
    const pCard = document.getElementById("purchaseAiCard");
    if (pCard) pCard.style.display = "none";
    const erpInput = document.getElementById("erpMoNumberInput");
    if (erpInput) erpInput.value = "";
    const revRm = document.getElementById("reviewRmSummaryBar");
    if (revRm) revRm.innerHTML = "";
    const revPd = document.getElementById("reviewPartDetailsContainer");
    if (revPd) { revPd.innerHTML = ""; revPd.style.display = "none"; }
    const revKpi = document.getElementById("reviewMoKpiContainer");
    if (revKpi) { revKpi.innerHTML = ""; revKpi.style.display = "none"; }
    const revCs = document.getElementById("reviewConstraintNotice");
    if (revCs) revCs.style.display = "none";
    const revLp = document.getElementById("reviewLayoutPartsBanner");
    if (revLp) revLp.style.display = "none";
    const revEb = document.getElementById("reviewLayoutEndbitsBanner");
    if (revEb) revEb.style.display = "none";
    const revIntel = document.getElementById("reviewErpIntelCard");
    if (revIntel) revIntel.style.display = "none";
    document.getElementById("reviewModal").style.display = "none";
}

/**
 * 1. Renders First Line in Review Modal:
 * RM ERP Code, RM Grade, Yield %, and No. of Sheets (Required)
 */
function renderReviewRmSummary(mo) {
    const bar = document.getElementById("reviewRmSummaryBar");
    if (!bar) return;

    const rmErp = mo.rm_erp || '-';
    const gradeVal = (mo.grade || mo.material_grade || 'YS').toUpperCase();
    const yieldBadgeHtml = formatYieldBadge(mo);
    const reqSheets = mo.sheets_required || 1;

    bar.innerHTML = `
        <div class="review-rm-col">
            <span class="review-rm-label">RM ERP Code</span>
            <div class="review-rm-val">
                <code class="review-rm-code"><i class="fa-solid fa-barcode" style="margin-right: 5px; color: #0284c7;"></i>${escapeHtml(rmErp)}</code>
            </div>
        </div>
        <div class="review-rm-col">
            <span class="review-rm-label">RM Grade</span>
            <div class="review-rm-val">
                <span class="reb-grade-pill">${escapeHtml(gradeVal)}</span>
            </div>
        </div>
        <div class="review-rm-col">
            <span class="review-rm-label">Yield %</span>
            <div class="review-rm-val">
                ${yieldBadgeHtml}
            </div>
        </div>
        <div class="review-rm-col">
            <span class="review-rm-label">No. of Sheets</span>
            <div class="review-rm-val" style="color: #0369a1;">
                <i class="fa-solid fa-layer-group" style="color: #0284c7; margin-right: 4px;"></i>
                <strong>${reqSheets} Sheets</strong>
            </div>
        </div>
    `;
    bar.style.display = "grid";
}

/**
 * 2. Renders Part Details table in Review Modal:
 * Part Number, Size, No. of Parts, No. of Blanks, Yield %
 * Supports single-part and multi-part layout orders seamlessly
 */
function renderReviewPartDetails(mo) {
    const container = document.getElementById("reviewPartDetailsContainer");
    if (!container) return;

    // Gather parts from all possible sources
    let partsList = [];
    if (mo.parts && Array.isArray(mo.parts) && mo.parts.length > 0) {
        partsList = [...mo.parts];
    } else if (mo.constraints_status?.parts && Array.isArray(mo.constraints_status.parts) && mo.constraints_status.parts.length > 0) {
        partsList = [...mo.constraints_status.parts];
    } else if (mo.layout_record?.parts && Array.isArray(mo.layout_record.parts) && mo.layout_record.parts.length > 0) {
        partsList = [...mo.layout_record.parts];
    }

    if (partsList.length === 0) {
        if (mo.part1 && typeof mo.part1 === 'object' && mo.part1.part_no) {
            partsList.push(mo.part1);
            if (mo.part2 && typeof mo.part2 === 'object' && mo.part2.part_no) partsList.push(mo.part2);
            if (mo.part3 && typeof mo.part3 === 'object' && mo.part3.part_no) partsList.push(mo.part3);
            if (mo.part4 && typeof mo.part4 === 'object' && mo.part4.part_no) partsList.push(mo.part4);
        } else if (mo.layout_record?.part1?.part_no) {
            partsList.push(mo.layout_record.part1);
            if (mo.layout_record.part2?.part_no) partsList.push(mo.layout_record.part2);
        }
    }

    if (partsList.length === 0) {
        partsList.push({
            part_no: mo.part_no || '-',
            base_part: mo.base_part || '-',
            part_size: mo.part_size || mo.cut_blank || (mo.thickness && mo.length && mo.width ? `${mo.thickness}*${mo.length}*${mo.width}` : '-'),
            no_of_parts: mo.no_of_parts || mo.target_qty || 1,
            strip_per_blank_qty: mo.strip_per_blank_qty || mo.strip_qty || 1,
            blank_qty: mo.blank_qty || mo.blanks_per_sheet || mo.blanks || 1,
            yield_pct: mo.yield_pct ? `${mo.yield_pct}%` : `${formatYieldBadge(mo)}`,
            is_primary: true
        });
    }

    const isMulti = partsList.length > 1;
    let totalParts = 0;
    let totalBlanks = 0;

    const rowsHtml = partsList.map((p, idx) => {
        const pNo = p.part_no || p.child_part_no || mo.part_no || '-';
        let pSize = p.part_size || p.size || p.cut_blank || '';
        if (!pSize && (p.cut_length || p.blank_length) && (p.cut_width || p.blank_width)) {
            const thk = p.thickness || mo.thickness || '';
            const l = p.cut_length || p.blank_length;
            const w = p.cut_width || p.blank_width;
            pSize = thk ? `${thk}*${l}*${w}` : `${l}*${w}`;
        }
        if (!pSize) pSize = mo.cut_blank || `${mo.thickness || ''}*${mo.length || ''}*${mo.width || ''}`.replace(/^\*/, '') || '-';

        const nParts = parseInt(p.no_of_parts || p.target_qty || 1) || 1;
        
        let stripQty = parseInt(
            p.strip_per_blank_qty || 
            p.strip_qty || 
            p.strip || 
            p.strip_per_blank || 
            p.blank_per_strip ||
            (p.part1 && (p.part1.strip_per_blank_qty || p.part1.strip_qty)) ||
            (mo.layout_record?.part1?.strip_qty || mo.layout_record?.strip_qty) ||
            (idx === 0 && (mo.strip_per_blank_qty || mo.strip_qty))
        ) || 0;

        if (!stripQty) {
            const intelParts = reviewIntelData?.planning_summary?.parts || currentIntelData?.planning_summary?.parts;
            if (intelParts && Array.isArray(intelParts)) {
                const match = intelParts.find(x => x.part_no === pNo || x.child_part_no === pNo);
                if (match && (match.strip_per_blank_qty || match.strip_qty)) {
                    stripQty = parseInt(match.strip_per_blank_qty || match.strip_qty);
                }
            }
        }
        if (!stripQty) stripQty = 1;

        const nBlanks = parseInt(
            p.blank_qty || 
            p.blanks_per_sheet || 
            p.no_of_blanks || 
            p.blanks || 
            (p.part1 && (p.part1.blank_qty || p.part1.blanks_per_sheet)) ||
            (mo.layout_record?.part1?.blank_qty || mo.layout_record?.blank_qty) ||
            1
        ) || 1;

        totalParts += nParts;
        totalBlanks += nBlanks;

        let yPct = p.yield_pct || (p.yield ? `${p.yield}%` : '');
        if (!yPct) {
            yPct = (mo.yield_pct !== undefined && mo.yield_pct !== null) ? `${mo.yield_pct}%` : '-';
        }

        const isPrim = p.is_primary || idx === 0;

        return `
            <tr>
                <td>
                    <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                        <code class="review-part-code">${escapeHtml(pNo)}</code>
                        ${isMulti ? `<span style="font-size: 0.68rem; font-weight: 700; padding: 1px 6px; border-radius: 4px; ${isPrim ? 'background: #e0f2fe; color: #0369a1;' : 'background: #f1f5f9; color: #64748b;'}">${isPrim ? '★ Part 1' : `Part ${idx + 1}`}</span>` : ''}
                    </div>
                    ${p.base_part && p.base_part !== pNo ? `<small class="text-muted" style="display: block; font-size: 0.72rem; margin-top: 2px;">Base: ${escapeHtml(p.base_part)}</small>` : ''}
                </td>
                <td>
                    <code class="review-part-dim">${escapeHtml(pSize)} mm</code>
                </td>
                <td>
                    <strong style="color: #0f172a; font-size: 0.92rem;">${nParts}</strong> <span style="font-size: 0.75rem; color: #64748b;">Nos</span>
                </td>
                <td>
                    <strong style="color: #0369a1; font-size: 0.92rem;">${stripQty}</strong> <span style="font-size: 0.75rem; color: #64748b;">Nos</span>
                    ${nBlanks > 1 ? `<small class="text-muted" style="display: block; font-size: 0.72rem; margin-top: 1px;">(${nBlanks} blanks/sh)</small>` : ''}
                </td>
                <td>
                    <span class="reb-grade-pill" style="background: #ecfdf5; color: #047857; font-weight: 700; font-size: 0.82rem;">${escapeHtml(yPct)}</span>
                </td>
            </tr>
        `;
    }).join("");

    container.innerHTML = `
        <div class="review-part-details-header">
            <div class="review-part-title">
                <i class="fa-solid fa-shapes" style="color: #0284c7;"></i>
                <span>Part Details</span>
                <span class="review-part-count-badge">${partsList.length} Part${partsList.length > 1 ? 's' : ''}</span>
            </div>
            ${isMulti ? `
            <div style="font-size: 0.78rem; color: #475569; background: #f8fafc; border: 1px solid #e2e8f0; padding: 3px 10px; border-radius: 6px;">
                Total Parts: <strong style="color: #0f172a;">${totalParts}</strong> | Total Blanks: <strong style="color: #0369a1;">${totalBlanks}</strong>
            </div>
            ` : ''}
        </div>
        <div class="mo-table-responsive" style="overflow-x: auto;">
            <table class="mo-table review-parts-table">
                <thead>
                    <tr>
                        <th style="width: 30%;">Part Number</th>
                        <th style="width: 24%;">Size</th>
                        <th style="width: 16%;">No. of Parts</th>
                        <th style="width: 18%;">Strip / Blank Qty</th>
                        <th style="width: 12%;">Yield %</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
        </div>
    `;
    container.style.display = "block";
}

function renderReviewModal(mo) {
    document.getElementById("reviewMoTitle").textContent = `${mo.mo_number} — ${mo.part_no}`;
    document.getElementById("reviewMoSubtitle").textContent = 
        `Base: ${mo.base_part || '-'} | RM ERP: ${mo.rm_erp || '-'} | Grade: ${mo.grade || 'YS'}`;

    // Render Stepper (flow kept as it is)
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

    // 1. Render First Line: RM ERP Code, RM Grade, Yield %, and No. of Sheets (Required)
    renderReviewRmSummary(mo);

    // 2. Render Part Details: Part Number, Size, No. of Parts, No. of Blanks, then Yield
    renderReviewPartDetails(mo);

    // Clear legacy grid if present
    const grid = document.getElementById("reviewDetailsGrid");
    if (grid) grid.innerHTML = "";

    // Render Constraints & Safety Status
    renderReviewConstraints(mo);

    // 3. Render 4 KPI Cards: RM Sheets On Hand, Qty to Produce, MO Produced Qty, Balance to Produce
    const initToProduce = (mo.qty_to_produce !== undefined && mo.qty_to_produce !== null)
        ? mo.qty_to_produce
        : (mo.mrp_monthly_target !== undefined && mo.mrp_monthly_target !== null && mo.initial_stock !== undefined
            ? Math.max(0, mo.mrp_monthly_target - mo.initial_stock)
            : (mo.mrp_monthly_target !== undefined ? mo.mrp_monthly_target : null));

    const partsProdCount = Number(mo.parts_produced || 0);
    const initRem = (initToProduce !== null && initToProduce !== undefined)
        ? Math.max(0, Number(initToProduce) - partsProdCount)
        : (mo.remaining_quantity !== undefined && mo.remaining_quantity !== null
            ? Math.max(0, Number(mo.remaining_quantity) - partsProdCount)
            : null);

    renderDefaultSinglePartKpis(
        (mo.rm_onhand !== undefined && mo.rm_onhand !== null) ? mo.rm_onhand : null,
        mo.rm_erp ? { item_code: mo.rm_erp } : null,
        initToProduce,
        null,
        mo.parts_produced || 0,
        initRem,
        null,
        true
    );

    // 4. Render End Bits Section in Review Modal
    renderReviewLayoutEndbits(mo);

    // Render Document Attachment or Layout Drawing Preview if available
    const docSec = document.getElementById("reviewDocSection");
    const docCard = document.getElementById("docPreviewCard");
    const hasDoc = Boolean(mo.layout_doc_url);
    const isStd = mo.is_standard_layout !== false && String(mo.is_standard_layout).toLowerCase() !== "false";
    
    // For Non-Standard layout: ONLY the custom attached image/document is shown. Extra standard layout image is NOT shown!
    const imgUrl = isStd ? (mo.image_url || mo.layout_record?.image_url) : null;

    if (hasDoc || imgUrl) {
        docSec.style.display = "block";
        let docHtml = "";
        if (hasDoc) {
            const isCustomImg = /\.(png|jpe?g|svg|webp|gif)$/i.test(mo.layout_doc_filename || mo.layout_doc_url || '') || String(mo.layout_doc_url).startsWith('data:image/');
            if (isCustomImg) {
                docHtml += `
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; background: #fff; padding: 10px 14px; border-radius: 8px; border: 1.5px solid #0284c7; margin-bottom: ${imgUrl ? '10px' : '0'};">
                        <div style="display: flex; align-items: center; gap: 12px;">
                            <img src="${escapeHtml(mo.layout_doc_url)}" alt="Custom Attached Layout Drawing" style="width: 60px; height: 42px; object-fit: contain; border: 1px solid #cbd5e1; border-radius: 4px; cursor: pointer; background: #f8fafc;" onclick="window.open('${escapeHtml(mo.layout_doc_url)}', '_blank')">
                            <div>
                                <strong style="color: #0369a1;"><i class="fa-solid fa-file-image"></i> ${escapeHtml(mo.layout_doc_filename || 'Custom Attached Layout Drawing')}</strong>
                                <small class="text-muted" style="display: block;">Custom uploaded layout verification drawing</small>
                            </div>
                        </div>
                        <a href="${escapeHtml(mo.layout_doc_url)}" target="_blank" class="btn btn-secondary btn-sm" style="color: #0284c7; border-color: #0284c7;">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i> View Drawing
                        </a>
                    </div>
                `;
            } else {
                docHtml += `
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; background: #fff; padding: 10px 14px; border-radius: 8px; border: 1px solid #e2e8f0; margin-bottom: ${imgUrl ? '10px' : '0'};">
                        <div>
                            <strong><i class="fa-solid fa-file-pdf"></i> ${escapeHtml(mo.layout_doc_filename || 'Custom Layout Document')}</strong>
                            <small class="text-muted block">Custom uploaded layout verification document</small>
                        </div>
                        <a href="${escapeHtml(mo.layout_doc_url)}" target="_blank" class="btn btn-secondary btn-sm">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i> Open Document
                        </a>
                    </div>
                `;
            }
        }
        if (imgUrl) {
            docHtml += `
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; background: #fff; padding: 10px 14px; border-radius: 8px; border: 1px solid #e2e8f0;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <img src="${escapeHtml(imgUrl)}" alt="Layout Drawing Preview" style="width: 60px; height: 42px; object-fit: contain; border: 1px solid #cbd5e1; border-radius: 4px; cursor: pointer; background: #f8fafc;" onclick="window.open('${escapeHtml(imgUrl)}', '_blank')">
                        <div>
                            <strong style="color: #1e293b;"><i class="fa-solid fa-image"></i> Layout Drawing Preview</strong>
                            <small class="text-muted" style="display: block;">Click thumbnail to inspect full drawing</small>
                        </div>
                    </div>
                    <a href="${escapeHtml(imgUrl)}" target="_blank" class="btn btn-secondary btn-sm">
                        <i class="fa-solid fa-arrow-up-right-from-square"></i> View Drawing
                    </a>
                </div>
            `;
        }
        docCard.innerHTML = docHtml;
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
    let canAction = false;
    if (currentRole === "purchase") {
        const isEb = Boolean(mo.is_endbit || mo.is_end_bit || mo.is_endbit_mo || (mo.source_endbit_ids && mo.source_endbit_ids.length > 0));
        const requiresPurchase = Boolean(mo.workflow_path && mo.workflow_path.includes("PURCHASE"));
        canAction = !isEb && requiresPurchase && mo.current_stage === "PURCHASE" && mo.status !== "REJECTED";
    } else {
        canAction = ROLE_CONFIGS[currentRole]?.stage === mo.current_stage && mo.status !== "REJECTED";
    }
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

    // Toggle ERP MO Number input visibility (Mandatory for ERP Release)
    const erpMoGroup = document.getElementById("erpMoNumberGroup");
    const erpMoInput = document.getElementById("erpMoNumberInput");
    const isErpRelease = (mo.current_stage === "ERP") || (currentRole === "erp" && mo.status === "PENDING_ERP");
    if (erpMoGroup) {
        if (isErpRelease && (canAction || (currentRole === "erp" && mo.status === "PENDING_ERP"))) {
            erpMoGroup.style.display = "block";
            if (erpMoInput) {
                erpMoInput.value = mo.erp_mo_number || "";
            }
        } else {
            erpMoGroup.style.display = "none";
            if (erpMoInput) {
                erpMoInput.value = "";
            }
        }
    }

    // Purchase AI Decision Agent hidden as per request
    const pAiCard = document.getElementById("purchaseAiCard");
    if (pAiCard) pAiCard.style.display = "none";
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

    // Validate and capture ERP MO Number if releasing to live ERP
    const erpMoInput = document.getElementById("erpMoNumberInput");
    const erpMoNumber = erpMoInput ? erpMoInput.value.trim() : "";
    const isErpRelease = (activeReviewMo.current_stage === "ERP") || (currentRole === "erp" && activeReviewMo.status === "PENDING_ERP");
    if (isErpRelease) {
        if (!erpMoNumber) {
            alert("⚠️ ERP System MO Number is required!\n\nPlease enter the MO number created in your live ERP software to proceed with the release.");
            erpMoInput?.focus();
            if (erpMoInput) {
                erpMoInput.style.boxShadow = "0 0 0 3px rgba(220, 38, 38, 0.4)";
                setTimeout(() => { if (erpMoInput) erpMoInput.style.boxShadow = ""; }, 2500);
            }
            return;
        }
    }

    try {
        const res = await fetch(`/api/mo/${encodeURIComponent(activeReviewMo.mo_number)}/approve`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Role": currentRole
            },
            body: JSON.stringify({ role: currentRole, remarks, erp_mo_number: erpMoNumber })
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
            fetchNotifications(true);
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
            fetchNotifications(true);
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

/* =========================================================================
   PURCHASE AI CLEARANCE & PROCUREMENT DECISION ASSISTANT CLIENT LOGIC
   ========================================================================= */
let activePurchaseAiDecision = null;

async function fetchAndDisplayPurchaseAi(mo) {
    const card = document.getElementById("purchaseAiCard");
    if (card) card.style.display = "none";
    return; // Disabled as of now: Purchase AI agent hidden
}

function applyPurchasePoRemarks() {
    if (!activePurchaseAiDecision?.decision?.recommended_remarks_po) {
        return;
    }
    const remarksInput = document.getElementById("approvalRemarks");
    if (remarksInput) {
        remarksInput.value = activePurchaseAiDecision.decision.recommended_remarks_po;
        remarksInput.focus();
        remarksInput.style.transition = "box-shadow 0.3s";
        remarksInput.style.boxShadow = "0 0 0 3px rgba(245, 158, 11, 0.4)";
        setTimeout(() => { remarksInput.style.boxShadow = ""; }, 1200);
    }
}

function applyPurchaseSubstitutionRemarks() {
    if (!activePurchaseAiDecision?.decision?.recommended_remarks_substitute) {
        return;
    }
    const remarksInput = document.getElementById("approvalRemarks");
    if (remarksInput) {
        remarksInput.value = activePurchaseAiDecision.decision.recommended_remarks_substitute;
        remarksInput.focus();
        remarksInput.style.transition = "box-shadow 0.3s";
        remarksInput.style.boxShadow = "0 0 0 3px rgba(34, 197, 94, 0.4)";
        setTimeout(() => { remarksInput.style.boxShadow = ""; }, 1200);
    }
}

function applyPurchasePartialRemarks() {
    if (!activePurchaseAiDecision?.decision?.recommended_remarks_partial) {
        return;
    }
    const remarksInput = document.getElementById("approvalRemarks");
    if (remarksInput) {
        remarksInput.value = activePurchaseAiDecision.decision.recommended_remarks_partial;
        remarksInput.focus();
        remarksInput.style.transition = "box-shadow 0.3s";
        remarksInput.style.boxShadow = "0 0 0 3px rgba(234, 179, 8, 0.4)";
        setTimeout(() => { remarksInput.style.boxShadow = ""; }, 1200);
    }
}

async function quickApproveWithPurchaseAi() {
    if (!activePurchaseAiDecision || !activeReviewMo) {
        alert("Please wait for the AI Decision Assistant to finish analyzing constraints.");
        return;
    }
    const remarksInput = document.getElementById("approvalRemarks");
    const remarksText = activePurchaseAiDecision.decision?.recommended_remarks_po || 
                        activePurchaseAiDecision.decision?.recommended_remarks_substitute || 
                        "Procurement clearance authorized by Purchase AI Agent.";
    if (remarksInput) {
        remarksInput.value = remarksText;
    }
    await confirmApproveMo();
}

// ERP, Stock & MRP Intelligence Functions
let currentIntelData = null;
let reviewIntelData = null;

async function fetchAndDisplayIntelligence(partNo, rmCode, grade, thickness, length, width, sheetsNeeded, isReview = false, allLayoutParts = []) {
    if (!partNo) return;
    const cardId = isReview ? "reviewErpIntelCard" : "erpIntelligenceCard";
    const card = document.getElementById(cardId);
    if (card) {
        card.style.display = "none";
    }

    const badge = document.getElementById(isReview ? "reviewStockStatusBadge" : "stockStatusBadge");
    if (badge) {
        badge.className = "intel-badge";
        badge.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Checking Inventory &amp; MOs...`;
    }

    try {
        const activeUnit = document.getElementById("modalUnitSelect")?.value || window._activeUnit || window.AUTH_COMPANY_ID || "PEPIPL";
        const cid = (activeUnit && activeUnit !== "ALL") ? activeUnit : (window.AUTH_COMPANY_ID || "PEPIPL");
        const params = new URLSearchParams({
            rm: rmCode || "",
            grade: grade || "",
            thickness: thickness || "",
            length: length || "",
            width: width || "",
            sheets: sheetsNeeded || 1,
            company_id: cid,
            branch: cid
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
        } else {
            reviewIntelData = intel;
            if (activeReviewMo) {
                renderReviewPartDetails(activeReviewMo);
                renderReviewLayoutEndbits(activeReviewMo);
            }
        }

        renderIntelligenceCard(intel, isReview);
    } catch (err) {
        console.error("Failed to load ERP & Stock intelligence:", err);
    }
}

function renderDefaultSinglePartKpis(rmOnHand, rm, mrpTarget, mrp, partsProduced, remainingQty, plan, isReview = false) {
    const rmValStr = (rmOnHand !== null && rmOnHand !== undefined)
        ? `${rmOnHand} Sheets`
        : (rm?.onhand_stock !== undefined ? `${rm.onhand_stock} Sheets` : (isReview && activeReviewMo?.rm_onhand !== undefined && activeReviewMo?.rm_onhand !== null ? `${activeReviewMo.rm_onhand} Sheets` : "- Sheets"));
    const rmSubStr = rm?.item_code 
        ? `${rm.item_code} (Main Store)` 
        : (isReview && activeReviewMo?.rm_erp ? `${activeReviewMo.rm_erp} (Main Store)` : "Select RM & part");

    const quickStockEl = document.getElementById("rmStockBoxVal");
    if (quickStockEl && !isReview && rmOnHand !== null && rmOnHand !== undefined && String(rmOnHand).trim() !== "") {
        quickStockEl.textContent = rmValStr;
    }

    const container = document.getElementById(isReview ? "reviewMoKpiContainer" : "moKpiContainer");
    if (!container) return;

    // Target Qty to Produce: prioritize net qty_to_produce (Schedule - In-House Stock = 1st card)
    const toProduceVal = (plan?.qty_to_produce !== undefined && plan?.qty_to_produce !== null)
        ? plan.qty_to_produce
        : (mrpTarget !== null && mrpTarget !== undefined
            ? mrpTarget
            : (isReview && activeReviewMo?.qty_to_produce !== undefined && activeReviewMo?.qty_to_produce !== null
                ? activeReviewMo.qty_to_produce
                : (isReview && activeReviewMo?.mrp_monthly_target !== undefined && activeReviewMo?.mrp_monthly_target !== null
                    ? activeReviewMo.mrp_monthly_target
                    : null)));
    const toProduceValStr = (toProduceVal !== null && toProduceVal !== undefined)
        ? `${Number(toProduceVal).toLocaleString()} Nos`
        : "- Nos";
    const childPart = plan?.child_part_no || mrp?.child_part_no || (isReview ? (activeReviewMo?.part_no || "") : "");
    const mrpSubStr = childPart ? `${childPart} (Target Requirement)` : "Target Requirement";

    const moCount = (plan && plan.monthly_mo_count !== undefined)
        ? plan.monthly_mo_count
        : (plan?.monthly_mo_records ? plan.monthly_mo_records.length : (isReview ? (activeReviewMo?.monthly_mo_count || 0) : 0));
    const partsCount = (partsProduced !== null && partsProduced !== undefined)
        ? Number(partsProduced).toLocaleString()
        : (isReview && activeReviewMo?.parts_produced !== undefined && activeReviewMo?.parts_produced !== null ? Number(activeReviewMo.parts_produced).toLocaleString() : "0");
    const partsValStr = (plan || (isReview && (activeReviewMo?.parts_produced !== undefined || partsProduced > 0))) ? `${partsCount} Nos` : "- Nos";
    const moSubStr = `${moCount} MO${moCount === 1 ? '' : 's'} produced`;

    // Card 3: Balance to Produce strictly = max(0, Card 1 - Card 2)
    const numToProduce = (toProduceVal !== null && toProduceVal !== undefined) ? Number(toProduceVal) : null;
    const numProduced = Number(String(partsCount).replace(/,/g, '')) || 0;
    const finalBal = (numToProduce !== null)
        ? Math.max(0, numToProduce - numProduced)
        : (remainingQty !== null && remainingQty !== undefined
            ? Math.max(0, Number(remainingQty) - numProduced)
            : (isReview && activeReviewMo?.remaining_quantity !== undefined && activeReviewMo?.remaining_quantity !== null
                ? Math.max(0, Number(activeReviewMo.remaining_quantity) - numProduced)
                : null));
    const remValStr = (finalBal !== null && finalBal !== undefined)
        ? `${Number(finalBal).toLocaleString()} Nos`
        : "- Nos";
    const remSubStr = "MRP Bal - MO Produced";

    const targetPartNo = isReview 
        ? (activeReviewMo?.part_no || plan?.part_no || "") 
        : (document.getElementById("partNoInput")?.value || plan?.part_no || "");
    const layoutRec = isReview ? (activeReviewMo?.layout_record || activeReviewMo) : getSelectedLayoutRecord();
    let partSizeRaw = plan?.part_size || plan?.cut_blank || layoutRec?.cut_blank || layoutRec?.part1?.cut_blank || (isReview ? (activeReviewMo?.part_size || activeReviewMo?.cut_blank) : "");
    const formattedPartSize = formatPartSize(partSizeRaw);

    // Collect all parts for KPI indicators (Multi-Part support)
    let allPartsList = [];
    if (plan?.parts && Array.isArray(plan.parts) && plan.parts.length > 0) {
        allPartsList = plan.parts.map(p => ({ ...p }));
    }

    if (isReview && activeReviewMo) {
        let revParts = activeReviewMo.parts;
        if (typeof revParts === "string") {
            try { revParts = JSON.parse(revParts); } catch(e) { revParts = []; }
        }
        if (!revParts && activeReviewMo.parts_produced) {
            revParts = activeReviewMo.parts_produced;
            if (typeof revParts === "string") {
                try { revParts = JSON.parse(revParts); } catch(e) { revParts = []; }
            }
        }
        if (Array.isArray(revParts) && revParts.length > 0) {
            revParts.forEach(rp => {
                const rpNo = rp.part_no || rp.child_part_no;
                if (!rpNo) return;
                const existing = allPartsList.find(p => (p.part_no === rpNo || p.child_part_no === rpNo));
                if (existing) {
                    if (!existing.part_size && (rp.size || rp.cut_blank)) existing.part_size = rp.size || rp.cut_blank;
                    if (rp.target_qty) existing.target_qty = rp.target_qty;
                } else {
                    allPartsList.push({
                        part_no: rpNo,
                        child_part_no: rpNo,
                        part_size: rp.size || rp.cut_blank || "",
                        mrp_monthly_target: rp.mrp_monthly_target || null,
                        parts_produced: rp.parts_produced || 0,
                        remaining_quantity: rp.remaining_quantity || null,
                        target_qty: rp.target_qty
                    });
                }
            });
        }
    } else if (!isReview) {
        const modalAddRows = document.querySelectorAll("#modalAdditionalPartsList .modal-add-part-row");
        if (modalAddRows && modalAddRows.length > 0) {
            modalAddRows.forEach((r, idx) => {
                const rowPartNo = r.querySelector(".add-part-no")?.value?.trim();
                if (!rowPartNo) return;
                const rowSize = r.querySelector(".add-part-size")?.value?.trim() || "";
                const existing = allPartsList.find(p => (p.part_no === rowPartNo || p.child_part_no === rowPartNo));
                if (existing) {
                    if (!existing.part_size && rowSize) existing.part_size = rowSize;
                } else {
                    const toPTxt = r.querySelector(`#addPartToProduce_${idx}`)?.textContent?.replace(/[^0-9]/g, "") || "";
                    const moPTxt = r.querySelector(`#addPartMoProduced_${idx}`)?.textContent?.replace(/[^0-9]/g, "") || "";
                    const balTxt = r.querySelector(`#addPartBalance_${idx}`)?.textContent?.replace(/[^0-9]/g, "") || "";
                    allPartsList.push({
                        part_no: rowPartNo,
                        child_part_no: rowPartNo,
                        part_size: rowSize,
                        mrp_monthly_target: toPTxt ? parseInt(toPTxt) : null,
                        parts_produced: moPTxt ? parseInt(moPTxt) : 0,
                        remaining_quantity: balTxt ? parseInt(balTxt) : null
                    });
                }
            });
        }
    }

    if (allPartsList.length === 0 && targetPartNo) {
        allPartsList.push({
            part_no: targetPartNo,
            child_part_no: childPart || targetPartNo,
            part_size: formattedPartSize,
            mrp_monthly_target: mrpTarget,
            parts_produced: partsProduced,
            remaining_quantity: remainingQty,
            monthly_mo_count: moCount
        });
    }

    const isMulti = allPartsList.length > 1;

    if (!isMulti) {
        // Classic Single-Part 4-Card Row
        container.innerHTML = `
            ${(!isReview && targetPartNo) ? `
            <div class="part-kpi-header" style="margin-bottom: 8px;">
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                    <span class="part-kpi-badge primary">
                        <i class="fa-solid fa-star"></i>
                        Primary Part: <strong>${escapeHtml(targetPartNo)}</strong>
                    </span>
                    ${formattedPartSize ? `
                    <span class="part-kpi-size-badge">
                        <i class="fa-solid fa-ruler-combined"></i>
                        Part Size: <strong>${escapeHtml(formattedPartSize)}</strong>
                    </span>` : ''}
                </div>
            </div>
            ` : ''}
            <div class="mo-kpi-row" id="${isReview ? 'reviewMoKpiRow' : 'moKpiRow'}">
                <div class="mo-kpi-card kpi-rm-stock">
                    <div class="mo-kpi-icon"><i class="fa-solid fa-layer-group"></i></div>
                    <div class="mo-kpi-content">
                        <span class="mo-kpi-label">RM Sheets (On Hand)</span>
                        <div class="mo-kpi-value" id="${isReview ? 'kpiReviewRmOnHand' : 'kpiRmOnHand'}">${rmValStr}</div>
                        <small class="mo-kpi-subtext" id="${isReview ? 'kpiReviewRmSubtext' : 'kpiRmSubtext'}" title="${escapeHtml(rmSubStr)}">${escapeHtml(rmSubStr)}</small>
                    </div>
                </div>

                <div class="mo-kpi-card kpi-mrp-qty">
                    <div class="mo-kpi-icon"><i class="fa-solid fa-industry"></i></div>
                    <div class="mo-kpi-content">
                        <span class="mo-kpi-label">Qty to Produce</span>
                        <div class="mo-kpi-value" id="${isReview ? 'kpiReviewMrpTarget' : 'kpiMrpTarget'}">${toProduceValStr}</div>
                        <small class="mo-kpi-subtext" id="${isReview ? 'kpiReviewMrpSubtext' : 'kpiMrpSubtext'}" title="${escapeHtml(mrpSubStr)}">${escapeHtml(mrpSubStr)}</small>
                    </div>
                </div>

                <div class="mo-kpi-card kpi-mo-produced">
                    <div class="mo-kpi-icon"><i class="fa-solid fa-clipboard-check"></i></div>
                    <div class="mo-kpi-content">
                        <span class="mo-kpi-label">MO Produced Qty</span>
                        <div class="mo-kpi-value" id="${isReview ? 'kpiReviewMoProduced' : 'kpiMoProduced'}">${partsValStr}</div>
                        <small class="mo-kpi-subtext" id="${isReview ? 'kpiReviewMoProducedSubtext' : 'kpiMoProducedSubtext'}" title="${moCount} MO${moCount === 1 ? '' : 's'} produced (${partsCount} parts in ${plan?.target_month || 'month'})">${escapeHtml(moSubStr)}</small>
                    </div>
                </div>

                <div class="mo-kpi-card kpi-remaining-qty">
                    <div class="mo-kpi-icon"><i class="fa-solid fa-scale-balanced"></i></div>
                    <div class="mo-kpi-content">
                        <span class="mo-kpi-label">Balance to Produce</span>
                        <div class="mo-kpi-value" id="${isReview ? 'kpiReviewRemainingQty' : 'kpiRemainingQty'}">${remValStr}</div>
                        <small class="mo-kpi-subtext" id="${isReview ? 'kpiReviewRemainingSubtext' : 'kpiRemainingSubtext'}" title="${escapeHtml(remSubStr)}">${escapeHtml(remSubStr)}</small>
                    </div>
                </div>
            </div>
        `;
    } else {
        // Multi-Part: Sheet-Level RM Stock Card + Individual 3-Card Planning Sets for ALL Parts
        container.innerHTML = `
            <div class="multi-part-kpis-wrapper" id="${isReview ? 'reviewMultiPartKpisWrapper' : 'multiPartKpisWrapper'}">
                <!-- 1. Sheet-Level RM Sheets On Hand (Shared across all parts on this sheet) -->
                <div class="mo-kpi-card kpi-rm-stock" style="margin-bottom: 12px; display: flex; align-items: center; gap: 14px; background: #f0f9ff; border: 1.5px solid #bae6fd; border-radius: 8px; padding: 12px 18px;">
                    <div class="mo-kpi-icon" style="font-size: 1.3rem; color: #0284c7; background: #e0f2fe; width: 42px; height: 42px; border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                        <i class="fa-solid fa-layer-group"></i>
                    </div>
                    <div class="mo-kpi-content" style="flex: 1;">
                        <div style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 6px;">
                            <span class="mo-kpi-label" style="font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; color: #0369a1;">
                                RM Sheets (On Hand) — Sheet Level Inventory
                            </span>
                            <span style="font-size: 0.78rem; color: #0284c7; font-weight: 700; background: #e0f2fe; padding: 2px 10px; border-radius: 12px; border: 1px solid #bae6fd;">
                                <i class="fa-solid fa-shapes"></i> Multi-Part Sheet (${allPartsList.length} Parts Total)
                            </span>
                        </div>
                        <div style="display: flex; align-items: baseline; gap: 12px; margin-top: 4px; flex-wrap: wrap;">
                            <div class="mo-kpi-value" id="${isReview ? 'kpiReviewRmOnHand' : 'kpiRmOnHand'}" style="font-size: 1.3rem; font-weight: 800; color: #0c4a6e;">${rmValStr}</div>
                            <small class="mo-kpi-subtext" id="${isReview ? 'kpiReviewRmSubtext' : 'kpiRmSubtext'}" style="color: #0369a1; font-weight: 600; font-size: 0.82rem;" title="${escapeHtml(rmSubStr)}">${escapeHtml(rmSubStr)}</small>
                        </div>
                    </div>
                </div>

                <!-- 2. Individual Planning Indicators (MRP Target, Produced, Remaining) for Every Part -->
                <div style="display: flex; flex-direction: column; gap: 10px;">
                    ${allPartsList.map((p, idx) => {
                        const pNo = p.part_no || p.child_part_no || (idx === 0 ? targetPartNo : `Part ${idx + 1}`);
                        const pSize = formatPartSize(p.part_size || (idx === 0 ? formattedPartSize : ""));
                        const pSched = (p.mrp_monthly_target !== null && p.mrp_monthly_target !== undefined) ? Number(p.mrp_monthly_target) : null;
                        const pInitStock = (p.initial_stock !== null && p.initial_stock !== undefined) ? Number(p.initial_stock) : 0;
                        const pBaseQty = (p.base_qty_to_produce !== null && p.base_qty_to_produce !== undefined)
                            ? Number(p.base_qty_to_produce)
                            : ((p.qty_to_produce !== null && p.qty_to_produce !== undefined)
                                ? Number(p.qty_to_produce)
                                : (pSched !== null ? Math.max(0, pSched - pInitStock) : (idx === 0 && toProduceVal !== null ? Number(toProduceVal) : null)));
                        const pToProduce = pBaseQty !== null ? `${pBaseQty.toLocaleString()} Nos` : "- Nos";

                        const pProducedCount = (p.mo_produced !== null && p.mo_produced !== undefined)
                            ? Number(p.mo_produced)
                            : ((p.parts_produced !== null && p.parts_produced !== undefined) ? Number(p.parts_produced) : 0);
                        const pProducedVal = `${pProducedCount.toLocaleString()} Nos`;

                        const pExcelMo = Number(p.excel_mo_produced || 0);
                        const pAppMo = Number(p.app_mo_produced || 0);
                        let pMoSub = `${pProducedCount.toLocaleString()} Nos produced`;
                        if (pExcelMo > 0 && pAppMo > 0) {
                            pMoSub = `${pExcelMo.toLocaleString()} Excel + ${pAppMo.toLocaleString()} App`;
                        } else if (pExcelMo > 0) {
                            pMoSub = `${pExcelMo.toLocaleString()} Excel MOs`;
                        } else if (pAppMo > 0) {
                            pMoSub = `${pAppMo.toLocaleString()} App MOs`;
                        }

                        const pBalanceCount = (pBaseQty !== null)
                            ? Math.max(0, pBaseQty - pProducedCount)
                            : ((p.balance_to_produce !== null && p.balance_to_produce !== undefined)
                                ? Math.max(0, Number(p.balance_to_produce))
                                : ((p.remaining_quantity !== null && p.remaining_quantity !== undefined)
                                    ? Math.max(0, Number(p.remaining_quantity))
                                    : null));
                        let pRem = pBalanceCount !== null ? `${pBalanceCount.toLocaleString()} Nos` : "- Nos";
                        if (pBalanceCount === 0 && pBaseQty !== null && pBaseQty > 0) {
                            pRem = `0 Nos <small style="display:inline-block; margin-left:4px; font-size:0.68rem; font-weight:700; color:#059669; background:#d1fae5; border:1px solid #a7f3d0; padding:1px 5px; border-radius:4px;"><i class="fa-solid fa-circle-check"></i> Complete</small>`;
                        } else if (pBalanceCount === 0 && pBaseQty === 0) {
                            pRem = `0 Nos <small style="display:inline-block; margin-left:4px; font-size:0.68rem; font-weight:700; color:#059669; background:#d1fae5; border:1px solid #a7f3d0; padding:1px 5px; border-radius:4px;"><i class="fa-solid fa-circle-check"></i> Stock OK</small>`;
                        }
                        const pTargetQty = p.target_qty ? `${Number(p.target_qty).toLocaleString()} Nos` : "";

                        return `
                        <div class="multi-part-kpi-card" style="background: #ffffff; border: 1.5px solid ${idx === 0 ? '#bfdbfe' : '#e2e8f0'}; border-radius: 8px; padding: 12px 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.03);">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 8px; border-bottom: 1px solid #f1f5f9; padding-bottom: 8px;">
                                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                                    <span class="part-kpi-badge ${idx === 0 ? 'primary' : 'secondary'}" style="${idx === 0 ? 'background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe;' : 'background: #f8fafc; color: #475569; border: 1px solid #cbd5e1;'} padding: 3px 10px; border-radius: 6px; font-size: 0.82rem; font-weight: 700; display: inline-flex; align-items: center; gap: 6px;">
                                        <i class="${idx === 0 ? 'fa-solid fa-star' : 'fa-solid fa-shapes'}" style="${idx === 0 ? 'color: #3b82f6;' : 'color: #64748b;'}"></i>
                                        ${idx === 0 ? 'Base / Primary Part' : `Added Part ${idx}`}: <strong>${escapeHtml(pNo)}</strong>
                                    </span>
                                    ${pSize ? `
                                    <span class="part-kpi-size-badge" style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 3px 8px; border-radius: 6px; font-size: 0.78rem; color: #334155; font-weight: 600; display: inline-flex; align-items: center; gap: 5px;">
                                        <i class="fa-solid fa-ruler-combined" style="color: #64748b;"></i>
                                        Part Size: <strong>${escapeHtml(pSize)}</strong>
                                    </span>` : ''}
                                </div>
                                ${pTargetQty ? `
                                <span class="part-kpi-output-badge" style="background: #ecfdf5; border: 1px solid #86efac; color: #166534; padding: 2px 10px; border-radius: 6px; font-size: 0.78rem; font-weight: 700;">
                                    <i class="fa-solid fa-industry"></i> Plan Output: ${pTargetQty}
                                </span>` : ''}
                            </div>

                            <div class="mo-kpi-row" style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px;">
                                <div class="mo-kpi-card kpi-mrp-qty">
                                    <div class="mo-kpi-icon"><i class="fa-solid fa-industry"></i></div>
                                    <div class="mo-kpi-content">
                                        <span class="mo-kpi-label">Qty to Produce</span>
                                        <div class="mo-kpi-value">${pToProduce}</div>
                                        <small class="mo-kpi-subtext" title="${escapeHtml(pNo)} (Target Requirement)">${escapeHtml(pNo)} (Target Requirement)</small>
                                    </div>
                                </div>

                                <div class="mo-kpi-card kpi-mo-produced">
                                    <div class="mo-kpi-icon"><i class="fa-solid fa-clipboard-check"></i></div>
                                    <div class="mo-kpi-content">
                                        <span class="mo-kpi-label">MO Produced Qty</span>
                                        <div class="mo-kpi-value">${pProducedVal}</div>
                                        <small class="mo-kpi-subtext" title="${escapeHtml(pMoSub)}">${escapeHtml(pMoSub)}</small>
                                    </div>
                                </div>

                                <div class="mo-kpi-card kpi-remaining-qty">
                                    <div class="mo-kpi-icon"><i class="fa-solid fa-scale-balanced"></i></div>
                                    <div class="mo-kpi-content">
                                        <span class="mo-kpi-label">Balance to Produce</span>
                                        <div class="mo-kpi-value">${pRem}</div>
                                        <small class="mo-kpi-subtext" title="Target - MO Produced">Target - MO Produced</small>
                                    </div>
                                </div>
                            </div>
                        </div>
                        `;
                    }).join("")}
                </div>
            </div>
        `;
    }
    container.style.display = "block";
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

    // 5. Update Key Planning Indicators in Create MO Modal and Review Modal (RM Sheets On Hand, MRP Monthly Target, Remaining Quantity)
    const plan = intel.planning_summary || {};
    const isMulti = plan.is_multi_part && plan.parts && plan.parts.length > 1;

    const rmOnHand = (plan.rm_onhand_sheets !== undefined && plan.rm_onhand_sheets !== null)
        ? plan.rm_onhand_sheets
        : (rm ? rm.onhand_stock : null);

    const toProduceTarget = (plan.qty_to_produce !== undefined && plan.qty_to_produce !== null)
        ? plan.qty_to_produce
        : (plan.mrp_monthly_target !== undefined && plan.mrp_monthly_target !== null && plan.current_stock !== undefined
            ? Math.max(0, plan.mrp_monthly_target - plan.current_stock)
            : (plan.mrp_monthly_target || (mrp && mrp.monthly_total !== undefined && mrp.monthly_total !== null ? mrp.monthly_total : null)));

    const partsProduced = plan.parts_produced || 0;
    const remainingQty = (plan.remaining_quantity !== undefined && plan.remaining_quantity !== null)
        ? plan.remaining_quantity
        : (toProduceTarget !== null ? Math.max(0, toProduceTarget - partsProduced) : null);

    const container = document.getElementById(isReview ? "reviewMoKpiContainer" : "moKpiContainer");

    if (isReview) {
        const revBanner = document.getElementById("reviewLayoutPartsBanner");
        if (revBanner) revBanner.style.display = "none";

        if (container) {
            container.style.display = "block";
            renderDefaultSinglePartKpis(rmOnHand, rm, toProduceTarget, mrp, partsProduced, remainingQty, plan, true);
        }
        const revCard = document.getElementById("reviewErpIntelCard");
        if (revCard) revCard.style.display = "none";
        if (activeReviewMo) {
            renderReviewLayoutEndbits(activeReviewMo);
        }
    } else {
        if (container) {
            container.style.display = "block";
            renderDefaultSinglePartKpis(rmOnHand, rm, toProduceTarget, mrp, partsProduced, remainingQty, plan, false);
        }
        recalculateTargetQtyFromLayout();
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

    // Validate and capture ERP MO Number
    const erpMoInput = document.getElementById("erpMoNumberInput");
    const erpMoNumber = erpMoInput ? erpMoInput.value.trim() : "";
    if (!erpMoNumber) {
        alert("⚠️ ERP System MO Number is required!\n\nPlease enter the MO number created in your live ERP software to proceed with the release.");
        erpMoInput?.focus();
        if (erpMoInput) {
            erpMoInput.style.boxShadow = "0 0 0 3px rgba(220, 38, 38, 0.4)";
            setTimeout(() => { if (erpMoInput) erpMoInput.style.boxShadow = ""; }, 2500);
        }
        return;
    }

    try {
        const res = await fetch(`/api/mo/${encodeURIComponent(moNum)}/complete`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Role": currentRole
            },
            body: JSON.stringify({ role: currentRole, remarks, erp_mo_number: erpMoNumber })
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
            fetchNotifications(true);
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
    const tabs = ["navTabWorkflow", "navTabEndbits", "navTabDbTables", "navTabReorderLevel"];
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

// Close DB panel & Notification panel when clicking outside
document.addEventListener("click", function(evt) {
    const panel = document.getElementById("dbTablesPanel");
    const navBtn = document.getElementById("navTabDbTables");
    if (panel && panel.style.display !== "none") {
        if (!panel.contains(evt.target) && !navBtn?.contains(evt.target)) {
            panel.style.display = "none";
        }
    }

    const notifPanel = document.getElementById("notifDropdownPanel");
    const notifWrap = document.getElementById("notifBellWrap");
    if (notifPanel && notifPanel.style.display !== "none") {
        if (!notifWrap?.contains(evt.target)) {
            notifPanel.style.display = "none";
        }
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
    const rygView = document.getElementById("reorderLevelView");
    const summaryView = document.getElementById("summaryView");
    if (workflowView) workflowView.style.display = "flex";
    if (explorerView) explorerView.style.display = "none";
    if (ebView) ebView.style.display = "none";
    if (createEbView) createEbView.style.display = "none";
    if (rygView) rygView.style.display = "none";
    if (summaryView) summaryView.style.display = "none";

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
    const rygView = document.getElementById("reorderLevelView");
    const summaryView = document.getElementById("summaryView");
    if (workflowView) workflowView.style.display = "none";
    if (explorerView) explorerView.style.display = "none";
    if (ebView) ebView.style.display = "flex";
    if (createEbView) createEbView.style.display = "none";
    if (rygView) rygView.style.display = "none";
    if (summaryView) summaryView.style.display = "none";

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
    const rygView = document.getElementById("reorderLevelView");
    const summaryView = document.getElementById("summaryView");
    if (workflowView) workflowView.style.display = "none";
    if (explorerView) explorerView.style.display = "none";
    if (ebView) ebView.style.display = "none";
    if (createEbView) createEbView.style.display = "flex";
    if (rygView) rygView.style.display = "none";
    if (summaryView) summaryView.style.display = "none";

    setActiveNavTab("navTabEndbits");
    // Reset layout attachment state
    activeEbOptiCutterLayoutFile = null;
    const ebFileInput = document.getElementById("ebLayoutDocFile");
    if (ebFileInput) ebFileInput.value = "";
    const ebChosenName = document.getElementById("ebFileChosenName");
    if (ebChosenName) {
        ebChosenName.textContent = "No file selected";
        ebChosenName.style.color = "";
    }
    const ebDropzone = document.getElementById("ebDocDropzone");
    if (ebDropzone) {
        ebDropzone.style.background = "#f8fafc";
        ebDropzone.style.borderColor = "#cbd5e1";
    }
    const ebStatusBadge = document.getElementById("ebDocStatusBadge");
    if (ebStatusBadge) {
        ebStatusBadge.innerHTML = "Auto-attaches via 2D Optimizer or upload";
    }

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
    const rygView = document.getElementById("reorderLevelView");
    const summaryView = document.getElementById("summaryView");
    if (workflowView) workflowView.style.display = "none";
    if (explorerView) explorerView.style.display = "flex";
    if (ebView) ebView.style.display = "none";
    if (createEbView) createEbView.style.display = "none";
    if (rygView) rygView.style.display = "none";
    if (summaryView) summaryView.style.display = "none";

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

        // Toggle Add buttons for ERP team in table header
        const isErp = (currentRole === "erp");
        const tableAddRm = document.getElementById("tableAddRmBtn");
        const tableAddPart = document.getElementById("tableAddPartBtn");
        const tableAddMrp = document.getElementById("tableAddMrpBtn");
        if (tableAddRm) tableAddRm.style.display = (isErp && currentDbTable === "rm") ? "inline-flex" : "none";
        if (tableAddPart) tableAddPart.style.display = (isErp && currentDbTable === "parts") ? "inline-flex" : "none";
        if (tableAddMrp) tableAddMrp.style.display = (isErp && currentDbTable === "mrp") ? "inline-flex" : "none";

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

    // Special handling for qty_to_produce (e.g. in MRP table)
    if (col === "qty_to_produce") {
        const sched = parseFloat(row?.monthly_schedule) || 0;
        const curStock = parseFloat(row?.current_stock) || 0;
        const remaining = sched > curStock ? (sched - curStock) : 0;
        
        if (remaining <= 0 || curStock >= sched) {
            return `
                <div style="display: inline-flex; align-items: center; gap: 6px;">
                    <strong style="color: #059669; font-size: 0.92rem;">0 Nos</strong>
                    <span class="mrp-stock-hint-badge" title="In-House Stock (${curStock.toLocaleString()} Nos) covers monthly schedule (${sched.toLocaleString()} Nos). Remaining qty to produce is 0." style="display: inline-flex; align-items: center; gap: 4px; background: #ecfdf5; border: 1px solid #86efac; color: #065f46; padding: 2px 8px; border-radius: 12px; font-size: 0.72rem; font-weight: 700; cursor: help;">
                        <i class="fa-solid fa-circle-check" style="color: #10b981;"></i> Stock: ${curStock.toLocaleString()} Nos
                    </span>
                </div>
            `;
        }
        return `<strong style="color: #b45309; font-size: 0.92rem;">${remaining.toLocaleString()} Nos</strong>`;
    }

    if (col === "monthly_schedule" || col === "current_stock") {
        const n = parseFloat(val);
        return !isNaN(n) ? `<strong>${n.toLocaleString()} Nos</strong>` : escapeHtml(String(val));
    }

    if (col === "offtake") {
        const n = parseFloat(val);
        return !isNaN(n) ? `<span style="font-weight: 700; color: #0284c7; background: #f0fdf4; border: 1px solid #86efac; padding: 2px 8px; border-radius: 6px; font-size: 0.8rem;"><i class="fa-solid fa-shapes" style="font-size: 0.75rem; margin-right: 3px;"></i>${n.toLocaleString()} Nos</span>` : escapeHtml(String(val));
    }

    // Special formatting for parts_produced in app_mo / endbit_mo
    if (col === "parts_produced") {
        let parts = val;
        if (typeof parts === "string") {
            try { parts = JSON.parse(parts); } catch(e) {}
        }
        if (Array.isArray(parts) && parts.length > 0) {
            return `
                <div style="display: flex; flex-direction: column; gap: 4px; min-width: 170px;">
                    ${parts.map((p, i) => {
                        const pNo = (typeof p === "object") ? (p.part_no || p.base_part || `Part ${i+1}`) : String(p);
                        const isBase = (typeof p === "object") ? (p.is_base !== false && (p.is_base || i === 0)) : (i === 0);
                        const tagHtml = isBase 
                            ? `<span style="font-size: 0.65rem; background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; padding: 1px 5px; border-radius: 3px; font-weight: 700;">Base</span>` 
                            : `<span style="font-size: 0.65rem; background: #f8fafc; color: #64748b; border: 1px solid #e2e8f0; padding: 1px 5px; border-radius: 3px;">Co-Part</span>`;
                        return `
                            <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px; background: #ffffff; border: 1px solid #e2e8f0; padding: 2px 7px; border-radius: 4px; font-size: 0.76rem;">
                                <code style="font-weight: 700; color: #1e293b;">${escapeHtml(pNo)}</code>
                                ${tagHtml}
                            </div>
                        `;
                    }).join("")}
                </div>
            `;
        }
    }

    // Special formatting for parts_qty in app_mo / endbit_mo: show breakdown for ALL parts + total
    if (col === "parts_qty") {
        let parts = row?.parts_produced;
        if (typeof parts === "string") {
            try { parts = JSON.parse(parts); } catch(e) {}
        }
        if (Array.isArray(parts) && parts.length > 0) {
            const qtyItems = parts.map((p, i) => {
                const pNo = (typeof p === "object") ? (p.part_no || p.base_part || `Part ${i+1}`) : `Part ${i+1}`;
                const q = (typeof p === "object") ? (parseFloat(p.qty ?? p.target_qty ?? p.blank_qty) || 0) : 0;
                const isBase = (typeof p === "object") ? (p.is_base !== false && (p.is_base || i === 0)) : (i === 0);
                return { part_no: pNo, qty: q, is_base: isBase };
            });
            const partsSum = qtyItems.reduce((acc, itm) => acc + itm.qty, 0);
            const totalVal = partsSum > 0 ? partsSum : (parseFloat(val) || 0);

            if (qtyItems.length > 1 && partsSum > 0) {
                return `
                    <div style="display: flex; flex-direction: column; gap: 3px; min-width: 160px; background: #f8fafc; border: 1px solid #e2e8f0; padding: 5px 8px; border-radius: 5px;">
                        ${qtyItems.map(itm => `
                            <div style="display: flex; align-items: center; justify-content: space-between; font-size: 0.74rem; color: #334155;">
                                <span style="color: #64748b; font-size: 0.7rem; max-width: 95px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(itm.part_no)}">
                                    ${escapeHtml(itm.part_no.split(' - ')[0])} ${itm.is_base ? '<span style="font-size: 0.62rem; color: #0284c7;">(Base)</span>' : ''}:
                                </span>
                                <strong style="color: #0369a1;">${itm.qty.toLocaleString()} Nos</strong>
                            </div>
                        `).join("")}
                        <div style="border-top: 1.5px dashed #cbd5e1; padding-top: 3px; margin-top: 2px; display: flex; align-items: center; justify-content: space-between;">
                            <span style="font-size: 0.72rem; font-weight: 700; color: #0f172a;"><i class="fa-solid fa-calculator" style="font-size: 0.68rem; margin-right: 3px;"></i>Total:</span>
                            <strong style="color: #059669; font-size: 0.84rem;">${totalVal.toLocaleString()} Nos</strong>
                        </div>
                    </div>
                `;
            } else {
                return `<strong style="color: #059669; font-size: 0.88rem;"><i class="fa-solid fa-shapes" style="font-size: 0.75rem; margin-right: 4px;"></i>${totalVal.toLocaleString()} Nos</strong>`;
            }
        }
        const n = parseFloat(val);
        return !isNaN(n) ? `<strong style="color: #059669; font-size: 0.88rem;"><i class="fa-solid fa-shapes" style="font-size: 0.75rem; margin-right: 4px;"></i>${n.toLocaleString()} Nos</strong>` : escapeHtml(String(val));
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

function formatPdfCell(key, val, row) {
    if (val === null || val === undefined || val === "") return "-";

    // 1. parts_produced: format clean readable list of parts (no raw JSON)
    if (key === "parts_produced") {
        let parts = val;
        if (typeof parts === "string") {
            try { parts = JSON.parse(parts); } catch(e) {}
        }
        if (Array.isArray(parts) && parts.length > 0) {
            return parts.map(p => {
                const pNo = (typeof p === "object") ? (p.part_no || p.base_part || "Part") : String(p);
                const q = (typeof p === "object") ? (p.qty ?? p.target_qty ?? p.blank_qty) : null;
                const isBase = (typeof p === "object") ? (p.is_base !== false && (p.is_base || false)) : false;
                const baseTag = isBase ? " [Base]" : "";
                return q ? `${pNo}${baseTag} (${Number(q).toLocaleString()} Nos)` : `${pNo}${baseTag}`;
            }).join("\n");
        }
        if (typeof val === "object") return JSON.stringify(val);
        return String(val);
    }

    // 2. quantities: parts_qty / target_qty / monthly_schedule / current_stock
    if (key === "parts_qty" || key === "target_qty" || key === "monthly_schedule" || key === "current_stock" || key === "qty_to_produce" || key === "offtake") {
        const n = parseFloat(val);
        return !isNaN(n) ? `${Number(n).toLocaleString()} Nos` : String(val);
    }

    // 3. sheet counts / quantities
    if (key === "no_of_rm_sheets" || key === "no_of_eb_sheets" || key === "available_sheets" || key === "quantity") {
        const n = parseFloat(val);
        return !isNaN(n) ? `${Number(n).toLocaleString()}` : String(val);
    }

    // 4. yield_pct
    if (key === "yield_pct") {
        const n = parseFloat(val);
        return !isNaN(n) ? `${n.toFixed(1)}%` : String(val);
    }

    // 5. weights
    if (key.includes("weight") || key === "weight") {
        const n = parseFloat(val);
        return !isNaN(n) ? `${n.toFixed(2)} kg` : String(val);
    }

    // 6. Dates
    if (key === "date" || key.endsWith("_date") || key === "created_at" || key === "created_on") {
        return String(val).split("T")[0].split(" ")[0];
    }

    // 7. Status & Stage
    if (key === "status" || key === "current_stage" || key === "workflow_path") {
        return String(val).replace(/_/g, " ");
    }

    // 8. Endbits text
    if (key === "endbits") {
        if (!val || val === "[]" || val === "None" || val === "none") return "-";
        if (typeof val === "string" && (val.startsWith("[") || val.startsWith("{"))) {
            try {
                const parsed = JSON.parse(val.replace(/'/g, '"'));
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return parsed.map(eb => `${eb.dim || eb.name || eb.endbit_id || 'EB'} (${eb.available_qty || eb.qty_per_sheet || 1} pcs)`).join("\n");
                }
            } catch (e) {
                return val.length > 30 ? val.slice(0, 28) + "..." : val;
            }
        }
        return String(val);
    }

    if (typeof val === "object") {
        return JSON.stringify(val);
    }

    return String(val);
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
        doc.setFillColor(15, 23, 42); // Deep Slate #0f172a
        doc.rect(0, 0, pageWidth, 20, "F");
        doc.setFillColor(37, 99, 235); // Blue accent line
        doc.rect(0, 20, pageWidth, 1.2, "F");

        doc.setTextColor(255, 255, 255);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(13);
        doc.text("SheetLayout AI", margin, 9);

        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.setTextColor(148, 163, 184);
        doc.text(`DATABASE TABLE REPORT — ${String(tableName).toUpperCase()}`, margin, 15);

        const nowStr = new Date().toLocaleString("en-IN", {
            day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
        });
        doc.setFontSize(7.5);
        doc.text(`Generated: ${nowStr} | Total Rows: ${currentTableData.total_rows || currentTableData.rows.length}`, pageWidth - margin, 13, { align: "right" });

        // Curated column schemas with dedicated widths (Total 281mm for A4 landscape)
        const tableSpecs = {
            app_mo: [
                { dataKey: "date", header: "Date", cellWidth: 22, halign: "center" },
                { dataKey: "mo_no", header: "MO Number", cellWidth: 26, fontStyle: "bold" },
                { dataKey: "rm_code", header: "Raw Material", cellWidth: 34 },
                { dataKey: "no_of_rm_sheets", header: "Sheets", cellWidth: 15, halign: "center" },
                { dataKey: "parts_produced", header: "Parts Produced", cellWidth: 60 },
                { dataKey: "parts_qty", header: "Parts Qty", cellWidth: 22, halign: "center", fontStyle: "bold" },
                { dataKey: "yield_pct", header: "Yield %", cellWidth: 18, halign: "center" },
                { dataKey: "current_stage", header: "Stage", cellWidth: 22, halign: "center" },
                { dataKey: "status", header: "Status", cellWidth: 24, halign: "center" },
                { dataKey: "remarks", header: "Remarks", cellWidth: 26 }
            ],
            endbit_mo: [
                { dataKey: "date", header: "Date", cellWidth: 24, halign: "center" },
                { dataKey: "eb_mo_no", header: "EB MO No", cellWidth: 28, fontStyle: "bold" },
                { dataKey: "endbit_code", header: "Endbit Used", cellWidth: 40 },
                { dataKey: "no_of_eb_sheets", header: "EB Qty", cellWidth: 18, halign: "center" },
                { dataKey: "parts_produced", header: "Parts Produced", cellWidth: 65 },
                { dataKey: "parts_qty", header: "Parts Qty", cellWidth: 24, halign: "center", fontStyle: "bold" },
                { dataKey: "yield_pct", header: "Yield %", cellWidth: 20, halign: "center" },
                { dataKey: "status", header: "Status", cellWidth: 28, halign: "center" },
                { dataKey: "remarks", header: "Remarks", cellWidth: 24 }
            ],
            rm: [
                { dataKey: "rm_code", header: "RM Sheet Code", cellWidth: 55, fontStyle: "bold" },
                { dataKey: "available_sheets", header: "Available Sheets", cellWidth: 40, halign: "center" },
                { dataKey: "weight_per_sheet", header: "Weight / Sheet (kg)", cellWidth: 45, halign: "right" },
                { dataKey: "total_stock_weight", header: "Total Weight (kg)", cellWidth: 50, halign: "right", fontStyle: "bold" },
                { dataKey: "created_at", header: "Registered Date", cellWidth: 40, halign: "center" }
            ],
            parts: [
                { dataKey: "part_no", header: "Part Number", cellWidth: 38, fontStyle: "bold" },
                { dataKey: "part_desc", header: "Description", cellWidth: 46 },
                { dataKey: "grade", header: "Grade", cellWidth: 20, halign: "center" },
                { dataKey: "thickness", header: "Thick", cellWidth: 18, halign: "center" },
                { dataKey: "length", header: "Length", cellWidth: 18, halign: "center" },
                { dataKey: "width", header: "Width", cellWidth: 18, halign: "center" },
                { dataKey: "offtake", header: "Offtake", cellWidth: 20, halign: "center" },
                { dataKey: "weight", header: "Weight", cellWidth: 22, halign: "right" },
                { dataKey: "standard_rm", header: "Standard RM", cellWidth: 50 }
            ],
            mrp: [
                { dataKey: "month_year", header: "Month-Year", cellWidth: 30, halign: "center" },
                { dataKey: "part_no", header: "Part Number", cellWidth: 48, fontStyle: "bold" },
                { dataKey: "monthly_schedule", header: "Monthly Schedule", cellWidth: 38, halign: "right" },
                { dataKey: "current_stock", header: "Current Stock", cellWidth: 38, halign: "right" },
                { dataKey: "qty_to_produce", header: "Qty to Produce", cellWidth: 40, halign: "right", fontStyle: "bold" },
                { dataKey: "status", header: "Status", cellWidth: 35, halign: "center" }
            ],
            endbits: [
                { dataKey: "date", header: "Date", cellWidth: 30, halign: "center" },
                { dataKey: "mo_no", header: "Source MO", cellWidth: 40, fontStyle: "bold" },
                { dataKey: "endbit", header: "Endbit Spec / Dimension", cellWidth: 90 },
                { dataKey: "quantity", header: "Available Qty", cellWidth: 35, halign: "center" },
                { dataKey: "weight", header: "Weight (kg)", cellWidth: 35, halign: "right" }
            ]
        };

        let selectedColsConfig = tableSpecs[currentDbTable];
        if (!selectedColsConfig) {
            // Fallback for custom or unknown tables: exclude technical columns
            const allCols = (currentTableData.columns || Object.keys(currentTableData.rows[0]))
                .filter(c => !["id", "audit_trail", "created_at", "updated_at", "layout_doc_url", "sl_no", "slno", "s_no"].includes(c.toLowerCase()));
            const colWidth = Math.max(20, Math.floor(269 / Math.max(1, allCols.length)));
            selectedColsConfig = allCols.map(c => ({
                dataKey: c,
                header: formatColumnName(c),
                cellWidth: colWidth
            }));
        }

        const tableColumns = [
            { header: "Sl.", dataKey: "_row_num" },
            ...selectedColsConfig.map(c => ({ header: c.header, dataKey: c.dataKey }))
        ];

        const columnStyles = {
            _row_num: { cellWidth: 12, halign: "center", fontStyle: "bold" }
        };
        selectedColsConfig.forEach(c => {
            columnStyles[c.dataKey] = {
                cellWidth: c.cellWidth || "auto",
                halign: c.halign || "left",
                fontStyle: c.fontStyle || "normal"
            };
        });

        const tableRows = currentTableData.rows.map((r, idx) => {
            const rowNum = (currentTableData.page - 1) * currentTableData.limit + idx + 1;
            const rowObj = { _row_num: String(rowNum) };
            selectedColsConfig.forEach(c => {
                rowObj[c.dataKey] = formatPdfCell(c.dataKey, r[c.dataKey], r);
            });
            return rowObj;
        });

        doc.autoTable({
            columns: tableColumns,
            body: tableRows,
            startY: 25,
            margin: { left: margin, right: margin, bottom: 12 },
            theme: "grid",
            columnStyles: columnStyles,
            styles: {
                font: "helvetica",
                fontSize: 7.5,
                cellPadding: { top: 2.2, bottom: 2.2, left: 2, right: 2 },
                textColor: [30, 41, 59],
                lineColor: [203, 213, 225],
                lineWidth: 0.15,
                overflow: "linebreak",
                valign: "middle"
            },
            headStyles: {
                fillColor: [15, 23, 42],
                textColor: [255, 255, 255],
                fontStyle: "bold",
                fontSize: 8,
                halign: "center",
                valign: "middle",
                minCellHeight: 8
            },
            alternateRowStyles: {
                fillColor: [248, 250, 252]
            },
            didDrawPage: function(data) {
                const pageCount = doc.internal.getNumberOfPages();
                const pageHeight = doc.internal.pageSize.height;
                doc.setDrawColor(226, 232, 240);
                doc.setLineWidth(0.3);
                doc.line(margin, pageHeight - 8, pageWidth - margin, pageHeight - 8);

                doc.setFontSize(7);
                doc.setTextColor(148, 163, 184);
                doc.text("SheetLayout AI — Confidential Production Report", margin, pageHeight - 4);
                doc.text(`Page ${data.pageNumber} of ${pageCount}`, pageWidth - margin, pageHeight - 4, { align: "right" });
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

        const gradeVal = record.grade || "YS";
        const ebName = formatEndbitName({
            grade: gradeVal,
            thickness: thick,
            length: len,
            width: wid,
            dim: dimStr,
            name: eb.name
        }, gradeVal);

        validEndbits.push({
            name: ebName,
            dim: dimStr,
            thickness: thick,
            length: len,
            width: wid,
            qty_per_sheet: qtyPerSheet,
            total_qty: totalQty,
            weight_kg: parseFloat(pieceWeight.toFixed(3)),
            total_weight_kg: parseFloat(totalWeight.toFixed(3))
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
        const wtDisplay = formatEndbitWeight(eb, record.thickness || record.mat_thickness);
        cardsHtml += `
            <div class="endbit-mini-card neat-endbit-card">
                <div class="reb-clean-field">
                    <span class="reb-clean-label">End Bit Name</span>
                    <strong class="reb-clean-val reb-name-val"><i class="fa-solid fa-scissors" style="color: #0284c7; margin-right: 5px;"></i>${escapeHtml(eb.name || formatEndbitName(eb, gradeVal))}</strong>
                </div>
                <div class="reb-clean-row">
                    <div class="reb-clean-field">
                        <span class="reb-clean-label">No. of End Bits Produced</span>
                        <strong class="reb-clean-val">${eb.total_qty} Nos</strong>
                    </div>
                    <div class="reb-clean-field">
                        <span class="reb-clean-label">Weight</span>
                        <strong class="reb-clean-val" style="color: #047857;">${escapeHtml(wtDisplay)}</strong>
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
        const ebName = formatEndbitName(eb, mo.grade || mo.material_grade);
        const producedQty = eb.initial_qty || eb.total_qty || eb.qty || 1;
        const gradeVal = eb.grade || mo.grade || mo.material_grade || "YS";
        const wtDisplay = formatEndbitWeight(eb, mo.thickness || mo.material_thickness);
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
                        <div class="reb-clean-field">
                            <span class="reb-clean-label">Weight</span>
                            <strong class="reb-clean-val" style="color: #047857;">${escapeHtml(wtDisplay)}</strong>
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
        tbody.innerHTML = `<tr><td colspan="6" class="loading-cell"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading end bits store...</td></tr>`;
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
            tbody.innerHTML = `<tr><td colspan="6" class="loading-cell text-danger">Failed to load end bits: ${escapeHtml(err.message)}</td></tr>`;
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
                <td colspan="${isShearing ? 6 : 5}" class="loading-cell text-muted" style="padding: 40px 20px;">
                    <i class="fa-solid fa-scissors" style="font-size: 2rem; color: #cbd5e1; margin-bottom: 10px; display: block;"></i>
                    No end bits found matching your filter criteria.<br>
                    <small>When a Material Order is submitted with offcuts, they appear here.</small>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = endbits.map(eb => {
        const ebName = formatEndbitName(eb);
        const ebId = eb.endbit_id || "";
        const produced = eb.initial_qty || eb.total_qty || eb.available_qty || 1;
        const gradeVal = (eb.grade || "YS").toUpperCase();
        const moNum = eb.source_mo_number || eb.mo_number || "-";
        const avail = eb.available_qty !== undefined ? eb.available_qty : produced;
        const wtDisplay = formatEndbitWeight(eb);

        return `
            <tr>
                <td>
                    <code style="font-weight: 700; color: #0369a1; font-size: 0.9rem;"><i class="fa-solid fa-scissors" style="margin-right: 5px; color: #0284c7;"></i>${escapeHtml(ebName)}</code>
                    ${ebId ? `<small class="text-muted" style="display: block; font-size: 0.75rem; margin-top: 2px;">${escapeHtml(ebId)}</small>` : ''}
                </td>
                <td><strong style="color: #0f172a; font-size: 0.92rem;">${produced} Nos</strong></td>
                <td><span class="reb-grade-pill">${escapeHtml(gradeVal)}</span></td>
                <td><strong style="color: #047857; font-size: 0.92rem;">${escapeHtml(wtDisplay)}</strong></td>
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

        // Table Columns: End Bit Name, No. of End Bits Produced, Grade, Weight (kg), Source MO #
        const tableColumns = [
            { header: "End Bit Name", dataKey: "endbit_id" },
            { header: "No. of End Bits Produced", dataKey: "qty" },
            { header: "Grade", dataKey: "grade" },
            { header: "Weight (kg)", dataKey: "weight" },
            { header: "Source MO #", dataKey: "source_mo" }
        ];

        const tableRows = allEndbits.map(eb => {
            const ebName = formatEndbitName(eb);
            const produced = eb.initial_qty || eb.total_qty || eb.available_qty || 1;
            const gradeVal = (eb.grade || "YS").toUpperCase();
            const moNum = eb.source_mo_number || eb.mo_number || "-";
            const wtDisplay = formatEndbitWeight(eb);
            return {
                endbit_id: ebName,
                qty: `${produced} Nos`,
                grade: gradeVal,
                weight: wtDisplay,
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
    if (nameInput) nameInput.value = "ys - 4.8*0*0";
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
    const grade = (document.getElementById("manEbGrade")?.value || "ys").trim().toLowerCase();
    const nameInput = document.getElementById("manEbName");

    if (nameInput) {
        nameInput.value = formatEndbitName({
            grade: grade,
            thickness: thick,
            length: len,
            width: wid
        });
    }

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
   ERP MASTER DATA MANAGEMENT (ADD RM SHEET & ADD PART MASTER)
   ========================================================================= */

function openAddRmModal() {
    if (currentRole !== "erp") {
        alert("Access Restricted: Only the ERP Team can add new Raw Material sheets to Master Data.");
        return;
    }
    const modal = document.getElementById("addRmModal");
    if (!modal) return;

    // Reset fields to sensible defaults
    const gradeInp = document.getElementById("newRmGrade");
    const thkInp = document.getElementById("newRmThickness");
    const lenInp = document.getElementById("newRmLength");
    const widInp = document.getElementById("newRmWidth");
    const sheetsInp = document.getElementById("newRmSheets");

    if (gradeInp) gradeInp.value = "CRCA";
    if (thkInp) thkInp.value = "2.0";
    if (lenInp) lenInp.value = "2500";
    if (widInp) widInp.value = "1250";
    if (sheetsInp) sheetsInp.value = "50";

    calculateRmCodeAndWeight();
    modal.style.display = "flex";
}

function closeAddRmModal() {
    const modal = document.getElementById("addRmModal");
    if (modal) modal.style.display = "none";
}

function calculateRmCodeAndWeight(isManualWeightEdit = false) {
    const grade = (document.getElementById("newRmGrade")?.value || "CRCA").trim().toUpperCase();
    const thk = parseFloat(document.getElementById("newRmThickness")?.value) || 0;
    const len = parseFloat(document.getElementById("newRmLength")?.value) || 0;
    const wid = parseFloat(document.getElementById("newRmWidth")?.value) || 0;
    const sheets = parseInt(document.getElementById("newRmSheets")?.value) || 0;

    const rmCodeInput = document.getElementById("newRmCode");
    if (rmCodeInput) {
        const thkStr = (thk % 1 === 0) ? thk.toFixed(1) : String(thk);
        const maxDim = Math.max(len, wid);
        const minDim = Math.min(len, wid);
        rmCodeInput.value = `${grade}-${thkStr}-${Math.round(maxDim)}-${Math.round(minDim)}`;
    }

    const unitWtInput = document.getElementById("newRmUnitWeight");
    let unitWeight = parseFloat(unitWtInput?.value) || 0;

    if (!isManualWeightEdit && thk > 0 && len > 0 && wid > 0) {
        // Density 7.85 kg/dm3 -> (T * L * W * 7.85) / 1,000,000
        unitWeight = Math.round((thk * len * wid * 7.85) / 10000.0) / 100.0;
        if (unitWtInput) unitWtInput.value = unitWeight.toFixed(2);
    }

    const totalStockWeight = Math.round(unitWeight * sheets * 100) / 100;

    const dimPrev = document.getElementById("newRmDimPreview");
    const wtPrev = document.getElementById("newRmWeightPreview");
    const totalPrev = document.getElementById("newRmTotalStockWeight");

    if (dimPrev) dimPrev.textContent = `${thk} × ${len} × ${wid} mm`;
    if (wtPrev) wtPrev.textContent = `Calculated Unit Weight: ~${unitWeight.toFixed(2)} kg`;
    if (totalPrev) totalPrev.textContent = `~${totalStockWeight.toLocaleString("en-IN", {minimumFractionDigits: 2, maximumFractionDigits: 2})} kg (${sheets} Sheets)`;
}

async function submitAddRmForm(e) {
    e.preventDefault();
    const form = document.getElementById("addRmForm");
    if (!form) return;

    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());

    const submitBtn = document.getElementById("submitAddRmBtn");
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Saving RM Sheet...`;
    }

    try {
        const res = await fetch("/api/rm/create", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Role": currentRole
            },
            body: JSON.stringify(data)
        });

        if (res.ok) {
            const resp = await res.json();
            alert(`🎉 Raw Material Sheet Successfully Recorded!\n\n` +
                  `• RM Code: ${resp.rm_code}\n` +
                  `• Opening Stock: ${data.available_sheets} Sheets\n` +
                  `• Unit Weight: ${data.weight_per_sheet} kg\n\n` +
                  `This RM is now active in the live store and ready for shearing production!`);

            closeAddRmModal();
            if (currentDbTable === "rm") {
                await loadDbTableData();
            }
            await loadStats();
        } else {
            const err = await res.json();
            alert(`Failed to save RM sheet: ${err.error || 'Server error'}`);
        }
    } catch (err) {
        console.error("RM sheet submission failed:", err);
        alert("Failed to save RM sheet. Please check network connection.");
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save RM Sheet to Store`;
        }
    }
}

function openAddPartModal() {
    if (currentRole !== "erp") {
        alert("Access Restricted: Only the ERP Team can add new Part specifications to Master Data.");
        return;
    }
    const modal = document.getElementById("addPartModal");
    if (!modal) return;

    // Reset defaults
    const partNo = document.getElementById("newPartNo");
    const basePart = document.getElementById("newBasePart");
    const desc = document.getElementById("newPartDesc");
    const grade = document.getElementById("newPartGrade");
    const thk = document.getElementById("newPartThickness");
    const len = document.getElementById("newPartLength");
    const wid = document.getElementById("newPartWidth");
    const offtake = document.getElementById("newPartOfftake");
    const stripQty = document.getElementById("newPartStripQty");
    const sched = document.getElementById("newPartMonthlySched");
    const stock = document.getElementById("newPartCurrentStock");

    if (partNo) partNo.value = "";
    if (basePart) basePart.value = "";
    if (desc) desc.value = "";
    if (grade) grade.value = "BSK";
    if (thk) thk.value = "5.8";
    if (len) len.value = "200";
    if (wid) wid.value = "151";
    if (offtake) offtake.value = "2";
    if (stripQty) stripQty.value = "1";
    if (sched) sched.value = "";
    if (stock) stock.value = "0";

    calculatePartWeight();
    populateStandardRmDropdownForPartModal();
    modal.style.display = "flex";
}

function closeAddPartModal() {
    const modal = document.getElementById("addPartModal");
    if (modal) modal.style.display = "none";
}

function onNewPartNoInput(val) {
    const basePartInput = document.getElementById("newBasePart");
    if (basePartInput) {
        basePartInput.value = (val || "").trim().split(" - ")[0].split(" / ")[0];
    }
}

function calculatePartWeight() {
    const thk = parseFloat(document.getElementById("newPartThickness")?.value) || 0;
    const len = parseFloat(document.getElementById("newPartLength")?.value) || 0;
    const wid = parseFloat(document.getElementById("newPartWidth")?.value) || 0;

    let partWeight = 0;
    if (thk > 0 && len > 0 && wid > 0) {
        partWeight = Math.round((thk * len * wid * 7.85) / 1000.0) / 1000.0;
    }

    const wtInput = document.getElementById("newPartWeight");
    if (wtInput) wtInput.value = partWeight.toFixed(3);

    const dimPrev = document.getElementById("newPartDimPreview");
    const wtPrev = document.getElementById("newPartWeightPreview");

    if (dimPrev) dimPrev.textContent = `${thk} × ${len} × ${wid} mm`;
    if (wtPrev) wtPrev.textContent = `Calculated Blank Weight: ~${partWeight.toFixed(3)} kg`;
}

async function populateStandardRmDropdownForPartModal() {
    const select = document.getElementById("newPartStandardRm");
    if (!select) return;

    const grade = (document.getElementById("newPartGrade")?.value || "").trim();
    const thk = parseFloat(document.getElementById("newPartThickness")?.value) || 0;

    select.innerHTML = `<option value="">-- Select Standard RM Sheet --</option>`;

    try {
        const res = await fetch(`/api/clean/rms?grade=${encodeURIComponent(grade)}&thickness=${encodeURIComponent(thk)}`);
        if (res.ok) {
            const rms = await res.json();
            if (rms && rms.length > 0) {
                rms.forEach(r => {
                    const opt = document.createElement("option");
                    opt.value = r.rm_code;
                    opt.textContent = `${r.rm_code} (${r.available_sheets} sheets in store)`;
                    select.appendChild(opt);
                });
            }
        }
    } catch (e) {
        console.warn("Could not load suggested standard RM:", e);
    }
}

async function submitAddPartForm(e) {
    e.preventDefault();
    const form = document.getElementById("addPartForm");
    if (!form) return;

    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());

    const submitBtn = document.getElementById("submitAddPartBtn");
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Saving Part...`;
    }

    try {
        const res = await fetch("/api/part/create", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Role": currentRole
            },
            body: JSON.stringify(data)
        });

        if (res.ok) {
            const resp = await res.json();
            alert(`🎉 Part Master Successfully Created!\n\n` +
                  `• Part No: ${resp.part_no}\n` +
                  `• Grade: ${data.grade}\n` +
                  `• Blank Size: ${data.thickness} × ${data.length} × ${data.width} mm\n` +
                  `• Offtake: ${data.offtake} Nos\n\n` +
                  `This part is now available immediately in the Master Catalog, autocompletes, and live MO generation!`);

            closeAddPartModal();
            if (currentDbTable === "parts") {
                await loadDbTableData();
            }
            await loadStats();
        } else {
            const err = await res.json();
            alert(`Failed to save part master: ${err.error || 'Server error'}`);
        }
    } catch (err) {
        console.error("Part master submission failed:", err);
        alert("Failed to save part. Please check network connection.");
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save Part Master`;
        }
    }
}

/* =========================================================================
   ADD / UPDATE MRP MONTHLY SCHEDULE (ERP MASTER DATA)
   ========================================================================= */

let mrpPartSearchDebounceTimer = null;
let pendingMrpCsvRows = [];

function switchMrpTab(tabName) {
    const csvTab = document.getElementById("mrpTabCsvView");
    const manualTab = document.getElementById("mrpTabManualView");
    const btnCsv = document.getElementById("tabBtnMrpCsv");
    const btnManual = document.getElementById("tabBtnMrpManual");

    if (tabName === "manual") {
        if (csvTab) csvTab.style.display = "none";
        if (manualTab) manualTab.style.display = "block";
        if (btnCsv) {
            btnCsv.style.borderBottom = "2.5px solid transparent";
            btnCsv.style.color = "#64748b";
            btnCsv.style.fontWeight = "600";
        }
        if (btnManual) {
            btnManual.style.borderBottom = "2.5px solid #7c3aed";
            btnManual.style.color = "#7c3aed";
            btnManual.style.fontWeight = "700";
        }
        setTimeout(() => { document.getElementById("newMrpPartNo")?.focus(); }, 150);
    } else {
        if (csvTab) csvTab.style.display = "block";
        if (manualTab) manualTab.style.display = "none";
        if (btnCsv) {
            btnCsv.style.borderBottom = "2.5px solid #7c3aed";
            btnCsv.style.color = "#7c3aed";
            btnCsv.style.fontWeight = "700";
        }
        if (btnManual) {
            btnManual.style.borderBottom = "2.5px solid transparent";
            btnManual.style.color = "#64748b";
            btnManual.style.fontWeight = "600";
        }
    }
}

function downloadMrpSampleCsv() {
    const csvContent = "part_no,monthly_schedule,current_stock,month_year\n" +
                       "MBA01008ITEM02,500,67,2026-11\n" +
                       "B0103401ITEM05,1911,845,2026-11\n" +
                       "117102VB1AITEM01,250,50,2026-11\n";
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "mrp_schedule_template.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

function handleMrpCsvFileSelected(e) {
    const file = e?.target?.files?.[0];
    if (!file) return;

    const label = document.getElementById("mrpCsvDropzoneLabel");
    const sub = document.getElementById("mrpCsvDropzoneSub");
    if (label) label.textContent = `Selected: ${file.name}`;
    if (sub) sub.textContent = `Size: ${(file.size / 1024).toFixed(1)} KB — Click to change file`;

    const reader = new FileReader();
    reader.onload = function(evt) {
        const text = evt.target.result || "";
        parseAndPreviewMrpCsv(text, file.name);
    };
    reader.onerror = function() {
        alert("Failed to read CSV file. Please make sure it is a valid text/csv format.");
    };
    reader.readAsText(file, "UTF-8");
}

function parseAndPreviewMrpCsv(csvText, filename) {
    pendingMrpCsvRows = [];
    const lines = csvText.split(/\r\n|\n|\r/).filter(l => l.trim().length > 0);
    if (lines.length < 2) {
        alert("The selected CSV file must have at least a header row and 1 data row.");
        return;
    }

    // Split headers
    const rawHeaders = lines[0].split(",").map(h => h.replace(/^["']|["']$/g, "").trim().toLowerCase());

    // Map header indices
    const partIdx = rawHeaders.findIndex(h => ["part_no", "part no", "part", "item_no", "item no", "component"].includes(h));
    const schedIdx = rawHeaders.findIndex(h => ["monthly_schedule", "monthly schedule", "schedule", "target", "monthly target", "mrp_qty", "qty", "demand"].includes(h));
    const stockIdx = rawHeaders.findIndex(h => ["current_stock", "current stock", "stock", "in_house_stock", "in house stock", "on_hand", "inventory"].includes(h));
    const monthIdx = rawHeaders.findIndex(h => ["month_year", "month-year", "month", "period"].includes(h));

    if (partIdx === -1) {
        alert("Missing required column 'part_no' in CSV header.\nRequired columns are: part_no, monthly_schedule, current_stock.");
        return;
    }

    const defaultMonth = document.getElementById("csvMrpMonthYear")?.value || "";

    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",").map(c => c.replace(/^["']|["']$/g, "").trim());
        const pNo = cols[partIdx] || "";
        if (!pNo) continue;

        const sched = schedIdx !== -1 ? Math.max(0, parseInt(cols[schedIdx], 10) || 0) : 0;
        const stock = stockIdx !== -1 ? Math.max(0, parseInt(cols[stockIdx], 10) || 0) : 0;
        const mYear = (monthIdx !== -1 && cols[monthIdx]) ? cols[monthIdx] : defaultMonth;

        pendingMrpCsvRows.push({
            part_no: pNo,
            monthly_schedule: sched,
            current_stock: stock,
            month_year: mYear
        });
    }

    if (pendingMrpCsvRows.length === 0) {
        alert("No valid part rows found in the CSV. Please check formatting.");
        return;
    }

    // Render Preview
    const previewContainer = document.getElementById("mrpCsvPreviewContainer");
    const badge = document.getElementById("mrpCsvFileBadge");
    const countSpan = document.getElementById("mrpCsvRowCount");
    const tbody = document.getElementById("mrpCsvPreviewTableBody");
    const submitBtn = document.getElementById("submitMrpCsvBtn");

    if (badge) badge.textContent = filename || "file.csv";
    if (countSpan) countSpan.textContent = pendingMrpCsvRows.length;

    if (tbody) {
        tbody.innerHTML = pendingMrpCsvRows.slice(0, 8).map((r, idx) => {
            const net = Math.max(0, r.monthly_schedule - r.current_stock);
            return `
                <tr style="border-bottom: 1px solid #f1f5f9;">
                    <td style="padding: 6px 10px; color: #94a3b8; font-weight: 600;">${idx + 1}</td>
                    <td style="padding: 6px 10px; font-weight: 700; color: #1e293b;">${r.part_no}</td>
                    <td style="padding: 6px 10px; text-align: center; color: #6d28d9; font-weight: 700;">${r.monthly_schedule.toLocaleString()}</td>
                    <td style="padding: 6px 10px; text-align: center; color: #059669; font-weight: 700;">${r.current_stock.toLocaleString()}</td>
                    <td style="padding: 6px 10px; text-align: center; color: #b45309; font-weight: 700;">${net.toLocaleString()}</td>
                </tr>
            `;
        }).join("");
    }

    if (previewContainer) previewContainer.style.display = "block";
    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i> Upload &amp; Import ${pendingMrpCsvRows.length} Parts`;
    }
}

async function submitMrpCsvUpload(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!pendingMrpCsvRows || pendingMrpCsvRows.length === 0) {
        alert("Please select a CSV file first.");
        return;
    }

    const monthYear = document.getElementById("csvMrpMonthYear")?.value || "";
    const submitBtn = document.getElementById("submitMrpCsvBtn");
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Importing ${pendingMrpCsvRows.length} Parts...`;
    }

    try {
        const res = await fetch("/api/mrp/upload-csv", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Role": currentRole
            },
            body: JSON.stringify({
                rows: pendingMrpCsvRows,
                month_year: monthYear
            })
        });

        if (res.ok) {
            const data = await res.json();
            let summary = `🎉 MRP Schedule CSV Successfully Imported!\n\n` +
                          `• Total Processed: ${data.total_rows || pendingMrpCsvRows.length} parts\n` +
                          `• New Records Created: ${data.created || 0}\n` +
                          `• Existing Records Updated: ${data.updated || 0}\n`;

            if (data.skipped && data.skipped.length > 0) {
                summary += `\n⚠️ Warnings / Skipped (${data.skipped.length}):\n${data.skipped.slice(0, 5).join('\n')}`;
            }

            summary += `\n\nAll monthly demand targets and inventory counts are now active.`;
            alert(summary);

            closeAddMrpModal();
            if (currentDbTable === "mrp" || currentDbTable === "parts") {
                await loadDbTableData();
            }
            await loadStats();
        } else {
            const err = await res.json();
            alert(`Failed to import MRP CSV: ${err.error || 'Server error'}`);
        }
    } catch (err) {
        console.error("MRP CSV import failed:", err);
        alert("Failed to upload MRP CSV. Please check network connection.");
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i> Upload &amp; Import MRP Schedule`;
        }
    }
}

function openAddMrpModal(prefillPartNo = null) {
    if (currentRole !== "erp") {
        alert("Access Restricted: Only the ERP Team can manage MRP Monthly Schedules.");
        return;
    }
    const modal = document.getElementById("addMrpModal");
    if (!modal) return;

    // Reset CSV upload state
    pendingMrpCsvRows = [];
    const fileInput = document.getElementById("mrpCsvFileInput");
    if (fileInput) fileInput.value = "";
    const previewContainer = document.getElementById("mrpCsvPreviewContainer");
    if (previewContainer) previewContainer.style.display = "none";
    const dropzoneLabel = document.getElementById("mrpCsvDropzoneLabel");
    if (dropzoneLabel) dropzoneLabel.textContent = "Click to select CSV file, or drag and drop here";
    const dropzoneSub = document.getElementById("mrpCsvDropzoneSub");
    if (dropzoneSub) dropzoneSub.textContent = "Supports standard .csv spreadsheets exported from Excel or ERP";
    const submitCsvBtn = document.getElementById("submitMrpCsvBtn");
    if (submitCsvBtn) {
        submitCsvBtn.disabled = true;
        submitCsvBtn.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i> Upload &amp; Import MRP Schedule`;
    }

    // Reset Form Fields for Single Part
    const partNoInput = document.getElementById("newMrpPartNo");
    const dropdown = document.getElementById("newMrpPartDropdown");
    const badge = document.getElementById("newMrpPartBadge");
    const monthInput = document.getElementById("newMrpMonthYear");
    const csvMonthInput = document.getElementById("csvMrpMonthYear");
    const scheduleInput = document.getElementById("newMrpMonthlySchedule");
    const stockInput = document.getElementById("newMrpCurrentStock");

    if (partNoInput) partNoInput.value = "";
    if (dropdown) { dropdown.innerHTML = ""; dropdown.style.display = "none"; }
    if (badge) badge.style.display = "none";
    if (scheduleInput) scheduleInput.value = "";
    if (stockInput) stockInput.value = "0";

    // Set Default Month (YYYY-MM)
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const currentMonthVal = `${yyyy}-${mm}`;
    if (monthInput) monthInput.value = currentMonthVal;
    if (csvMonthInput) csvMonthInput.value = currentMonthVal;

    updateMrpModalKpis();
    modal.style.display = "flex";

    if (prefillPartNo) {
        switchMrpTab("manual");
        if (partNoInput) partNoInput.value = prefillPartNo;
        selectMrpPart(encodeURIComponent(prefillPartNo));
    } else {
        switchMrpTab("csv");
    }
}

function closeAddMrpModal() {
    const modal = document.getElementById("addMrpModal");
    if (modal) modal.style.display = "none";
    const dropdown = document.getElementById("newMrpPartDropdown");
    if (dropdown) dropdown.style.display = "none";
}

function onNewMrpPartSearch(val) {
    clearTimeout(mrpPartSearchDebounceTimer);
    const dropdown = document.getElementById("newMrpPartDropdown");
    if (!dropdown) return;

    const query = (val || "").trim();
    if (query.length < 2) {
        dropdown.innerHTML = "";
        dropdown.style.display = "none";
        return;
    }

    mrpPartSearchDebounceTimer = setTimeout(async () => {
        try {
            const companyId = (window.currentCompanyId || "PEPIPL").toUpperCase();
            const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&company_id=${encodeURIComponent(companyId)}`);
            if (res.ok) {
                const parts = await res.json();
                if (!parts || parts.length === 0) {
                    dropdown.innerHTML = `<div style="padding: 10px 14px; font-size: 0.82rem; color: #94a3b8;">No matching parts found in catalog</div>`;
                    dropdown.style.display = "block";
                    return;
                }

                dropdown.innerHTML = parts.slice(0, 15).map(p => {
                    const pNo = p.part_no || p.name || "";
                    const desc = p.description || p.part_desc || "";
                    const grade = p.grade || "";
                    const size = (p.thickness && p.length && p.width) ? `${p.thickness}×${p.length}×${p.width} mm` : "";
                    const safePNo = encodeURIComponent(pNo);
                    const safeDesc = encodeURIComponent(desc);
                    const safeGrade = encodeURIComponent(grade);
                    const safeSize = encodeURIComponent(size);

                    return `
                        <div class="mrp-part-opt" style="padding: 9px 14px; border-bottom: 1px solid #f1f5f9; cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: background 0.15s;" 
                             onmouseover="this.style.background='#f8fafc'" 
                             onmouseout="this.style.background='#ffffff'"
                             onclick="selectMrpPart('${safePNo}', '${safeGrade}', '${safeDesc}', '${safeSize}')">
                            <div>
                                <strong style="font-size: 0.88rem; color: #1e293b;">${pNo}</strong>
                                ${desc ? `<div style="font-size: 0.76rem; color: #64748b;">${desc}</div>` : ''}
                            </div>
                            <div style="text-align: right;">
                                ${grade ? `<span style="background: #e0f2fe; color: #0284c7; padding: 2px 6px; border-radius: 4px; font-size: 0.72rem; font-weight: 700; margin-right: 4px;">${grade}</span>` : ''}
                                ${size ? `<span style="font-size: 0.74rem; color: #64748b;">${size}</span>` : ''}
                            </div>
                        </div>
                    `;
                }).join("");
                dropdown.style.display = "block";
            }
        } catch (e) {
            console.error("MRP part search error:", e);
        }
    }, 250);
}

async function selectMrpPart(safePartNo, safeGrade = '', safeDesc = '', safeSize = '') {
    const partNo = decodeURIComponent(safePartNo || "");
    const grade = decodeURIComponent(safeGrade || "");
    const desc = decodeURIComponent(safeDesc || "");
    const size = decodeURIComponent(safeSize || "");

    const input = document.getElementById("newMrpPartNo");
    const dropdown = document.getElementById("newMrpPartDropdown");
    const badge = document.getElementById("newMrpPartBadge");
    const badgeTitle = document.getElementById("newMrpPartBadgeTitle");
    const badgeGrade = document.getElementById("newMrpPartBadgeGrade");
    const badgeMeta = document.getElementById("newMrpPartBadgeMeta");

    if (input) input.value = partNo;
    if (dropdown) dropdown.style.display = "none";

    if (badge) {
        badge.style.display = "block";
        if (badgeTitle) badgeTitle.textContent = partNo;
        if (badgeGrade) {
            badgeGrade.textContent = grade || "Part Catalog";
            badgeGrade.style.display = grade ? "inline-block" : "none";
        }
        if (badgeMeta) {
            const metaParts = [];
            if (desc) metaParts.push(desc);
            if (size) metaParts.push(`Blank: ${size}`);
            badgeMeta.textContent = metaParts.length > 0 ? metaParts.join(" • ") : "Component registered in Master Catalog";
        }
    }

    // Try fetching existing MRP schedule & stock for this part
    await loadExistingMrpForModal(partNo);
}

async function loadExistingMrpForModal(partNo) {
    if (!partNo) return;
    const month = document.getElementById("newMrpMonthYear")?.value || "";
    const companyId = (window.currentCompanyId || "PEPIPL").toUpperCase();

    try {
        const res = await fetch(`/api/part/${encodeURIComponent(partNo)}?company_id=${encodeURIComponent(companyId)}`);
        if (res.ok) {
            const data = await res.json();
            const schedInput = document.getElementById("newMrpMonthlySchedule");
            const stockInput = document.getElementById("newMrpCurrentStock");

            if (data.mrp && typeof data.mrp.monthly_schedule !== "undefined" && data.mrp.monthly_schedule !== null) {
                if (schedInput && !schedInput.value) {
                    schedInput.value = data.mrp.monthly_schedule;
                }
            }
            if (data.mrp && typeof data.mrp.current_stock !== "undefined" && data.mrp.current_stock !== null) {
                if (stockInput && (stockInput.value === "0" || !stockInput.value)) {
                    stockInput.value = data.mrp.current_stock;
                }
            }
            updateMrpModalKpis();
        }
    } catch (e) {
        console.warn("Could not prefill existing MRP for modal:", e);
    }
}

function onMrpMonthChange() {
    const partNo = document.getElementById("newMrpPartNo")?.value;
    if (partNo) loadExistingMrpForModal(partNo);
    updateMrpModalKpis();
}

function updateMrpModalKpis() {
    const sched = Math.max(0, parseInt(document.getElementById("newMrpMonthlySchedule")?.value, 10) || 0);
    const stock = Math.max(0, parseInt(document.getElementById("newMrpCurrentStock")?.value, 10) || 0);
    const toProduce = Math.max(0, sched - stock);

    const prevSched = document.getElementById("mrpModalPreviewSchedule");
    const prevStock = document.getElementById("mrpModalPreviewStock");
    const prevToProduce = document.getElementById("mrpModalPreviewToProduce");
    const prevToProduceSub = document.getElementById("mrpModalPreviewToProduceSub");

    if (prevSched) prevSched.textContent = `${sched.toLocaleString()} Nos`;
    if (prevStock) prevStock.textContent = `${stock.toLocaleString()} Nos`;
    if (prevToProduce) prevToProduce.textContent = `${toProduce.toLocaleString()} Nos`;
    if (prevToProduceSub) {
        if (stock >= sched && sched > 0) {
            prevToProduceSub.innerHTML = `<span style="color: #15803d; font-weight: 700;"><i class="fa-solid fa-check"></i> Fully Covered by Stock</span>`;
        } else {
            prevToProduceSub.textContent = `Net Requirement (${sched} - ${stock})`;
        }
    }
}

async function submitAddMrpForm(e) {
    if (e && e.preventDefault) e.preventDefault();
    const form = document.getElementById("addMrpForm");
    if (!form) return;

    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());

    const submitBtn = document.getElementById("submitAddMrpBtn");
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> Saving Schedule...`;
    }

    try {
        const res = await fetch("/api/mrp/create", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Role": currentRole
            },
            body: JSON.stringify(data)
        });

        if (res.ok) {
            const resp = await res.json();
            const actionText = resp.action === "updated" ? "Updated" : "Saved";
            alert(`🎉 MRP Demand Schedule Successfully ${actionText}!\n\n` +
                  `• Part No: ${resp.part_no}\n` +
                  `• Month: ${resp.month_year}\n` +
                  `• Schedule Target: ${resp.monthly_schedule} Nos\n` +
                  `• In-House Stock: ${resp.current_stock} Nos\n` +
                  `• Net to Produce: ${resp.qty_to_produce} Nos\n\n` +
                  `The updated MRP targets are immediately active in the ERP system and MO creation.`);

            closeAddMrpModal();
            if (currentDbTable === "mrp" || currentDbTable === "parts") {
                await loadDbTableData();
            }
            await loadStats();
        } else {
            const err = await res.json();
            alert(`Failed to save MRP schedule: ${err.error || 'Server error'}`);
        }
    } catch (err) {
        console.error("MRP schedule submission failed:", err);
        alert("Failed to save MRP schedule. Please check network connection.");
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Save MRP Schedule`;
        }
    }
}

// Window bindings
window.openAddMrpModal = openAddMrpModal;
window.closeAddMrpModal = closeAddMrpModal;
window.switchMrpTab = switchMrpTab;
window.downloadMrpSampleCsv = downloadMrpSampleCsv;
window.handleMrpCsvFileSelected = handleMrpCsvFileSelected;
window.submitMrpCsvUpload = submitMrpCsvUpload;
window.onNewMrpPartSearch = onNewMrpPartSearch;
window.selectMrpPart = selectMrpPart;
window.onMrpMonthChange = onMrpMonthChange;
window.updateMrpModalKpis = updateMrpModalKpis;
window.submitAddMrpForm = submitAddMrpForm;

// Close MRP part dropdown on outside click
document.addEventListener("click", (e) => {
    const dropdown = document.getElementById("newMrpPartDropdown");
    const input = document.getElementById("newMrpPartNo");
    if (dropdown && dropdown.style.display !== "none") {
        if (!dropdown.contains(e.target) && e.target !== input) {
            dropdown.style.display = "none";
        }
    }
});

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
            const ebName = formatEndbitName(eb);
            const dimStr = eb.dimensions || eb.dim || `${eb.thickness}*${eb.length}*${eb.width}`;
            opt.textContent = `[${ebName}] ${eb.endbit_id} • ${dimStr} mm`;
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
                const ebName = formatEndbitName(eb);
                return `
                    <button type="button" class="eb-chip-btn ${isSelected ? 'active' : ''}" onclick="selectEbFromChip('${escapeHtml(eb.endbit_id)}')" style="background: ${isSelected ? '#0284c7' : '#f1f5f9'}; color: ${isSelected ? '#fff' : '#334155'}; border: 1px solid ${isSelected ? '#0284c7' : '#cbd5e1'}; padding: 5px 10px; border-radius: 6px; font-size: 0.8rem; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;">
                        <i class="fa-solid fa-scissors"></i>
                        <strong>${escapeHtml(ebName)}</strong>
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

/**
 * Calculates optimal 2D guillotine cut capacity matching OptiCutter.
 * Evaluates uniform grids and multi-block guillotine splits (both vertical and horizontal cuts).
 */
function calculateMaxGuillotineBlanks(sheetLen, sheetWid, blankLen, blankWid, kerf = 0) {
    const sL = Math.max(parseFloat(sheetLen) || 0, parseFloat(sheetWid) || 0);
    const sW = Math.min(parseFloat(sheetLen) || 0, parseFloat(sheetWid) || 0);
    const bL = Math.max(parseFloat(blankLen) || 0, parseFloat(blankWid) || 0);
    const bW = Math.min(parseFloat(blankLen) || 0, parseFloat(blankWid) || 0);
    if (sL <= 0 || sW <= 0 || bL <= 0 || bW <= 0) return 0;
    if (bL > sL || bW > sW) return 0;

    const k = Math.max(0, parseFloat(kerf) || 0);
    let best = 0;

    // 1. Uniform 0 deg
    best = Math.max(best, Math.floor(sL / (bL + k)) * Math.floor(sW / (bW + k)));
    // 2. Uniform 90 deg
    best = Math.max(best, Math.floor(sL / (bW + k)) * Math.floor(sW / (bL + k)));

    const pairs = [
        { l1: bL, w1: bW, l2: bW, w2: bL },
        { l1: bW, w1: bL, l2: bL, w2: bW }
    ];

    // 3. Vertical splits (along sL)
    pairs.forEach(({ l1, w1, l2, w2 }) => {
        const nx1 = Math.floor(sL / (l1 + k));
        const ny1 = Math.floor(sW / (w1 + k));
        for (let col = 1; col < nx1; col++) {
            const remL = sL - col * (l1 + k);
            const nx2 = Math.floor(remL / (l2 + k));
            const ny2 = Math.floor(sW / (w2 + k));
            if (nx2 > 0 && ny2 > 0) {
                best = Math.max(best, col * ny1 + nx2 * ny2);
            }
        }
    });

    // 4. Horizontal splits (along sW)
    pairs.forEach(({ l1, w1, l2, w2 }) => {
        const nx1 = Math.floor(sL / (l1 + k));
        const ny1 = Math.floor(sW / (w1 + k));
        for (let row = 1; row < ny1; row++) {
            const remW = sW - row * (w1 + k);
            const nx2 = Math.floor(sL / (l2 + k));
            const ny2 = Math.floor(remW / (w2 + k));
            if (nx2 > 0 && ny2 > 0) {
                best = Math.max(best, nx1 * row + nx2 * ny2);
            }
        }
    });

    return best;
}

function checkRowEbCapacity(rowId, autoApply = false) {
    const feedbackEl = document.getElementById(`ebAgentFeedback_${rowId}`);
    const sizeInput = document.getElementById(`ebPartSize_${rowId}`);
    const qtyInput = document.getElementById(`ebPartQty_${rowId}`);
    const yieldInput = document.getElementById(`ebPartYield_${rowId}`);
    const rowEl = document.getElementById(`ebPartRow_${rowId}`);

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

    // Optimal 2D guillotine cut capacity matching OptiCutter
    const guillotineBlanks = calculateMaxGuillotineBlanks(ebMax, ebMin, bMax, bMin);
    const opt1 = Math.floor(ebMax / bMax) * Math.floor(ebMin / bMin);
    const opt2 = Math.floor(ebMax / bMin) * Math.floor(ebMin / bMax);
    let partsPerEb = Math.max(guillotineBlanks, opt1, opt2, 1);

    // If OptiCutter has verified a placement on this row or layout is attached, honor verified count
    if (rowEl && rowEl.dataset.opticutterBlanks) {
        partsPerEb = Math.max(partsPerEb, parseInt(rowEl.dataset.opticutterBlanks) || 0);
    }

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

    const totalCutArea = enteredQty * cutLen * cutWid;
    const isOptiCutterVerified = Boolean((rowEl && rowEl.dataset.opticutterBlanks) || activeEbOptiCutterLayoutFile);
    // Capacity shortage check: strictly only flag shortage if entered quantity exceeds maximum guillotine capacity AND total raw material area
    const hasCapacityShortage = (enteredQty > totalMaxParts) && (totalCutArea > totalPlateArea || !isOptiCutterVerified);
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
                        <span style="display: block; margin-top: 2px;">${endbitsCount} selected end-bit(s) can produce <strong>${totalMaxParts} parts</strong> (${partsPerEb} blanks/plate).</span>
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

        const verificationBadge = isOptiCutterVerified ?
            `<span style="color: #0369a1; font-weight: 700; background: #e0f2fe; padding: 1px 6px; border-radius: 3px; font-size: 0.72rem; margin-left: 4px;"><i class="fa-solid fa-circle-check"></i> OptiCutter 2D Nesting Verified</span>` :
            `<span style="color: #059669; font-weight: 700; font-size: 0.72rem; margin-left: 4px;">(2D Guillotine Nesting)</span>`;

        feedbackEl.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; background: #f0fdf4; border: 1px solid #86efac; border-radius: 6px; padding: 5px 10px; font-size: 0.78rem; color: #166534;">
                <div style="display: flex; align-items: center; gap: 6px;">
                    <i class="fa-solid fa-calculator" style="color: #16a34a;"></i>
                    <span><strong>Agent Capacity:</strong> Fits <strong>${partsPerEb} blanks/endbit</strong> × <strong>${endbitsCount} endbits</strong> = <strong style="color: #15803d; font-size: 0.88rem;">${totalMaxParts} Max Parts</strong> (${maxCapacityYield}% Max Yield) ${verificationBadge}</span>
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
    const rowEl = document.getElementById(`ebPartRow_${rowId}`);
    const endbitsUsedInput = document.getElementById("ebEndbitsUsed");
    const endbitsCount = Math.max(1, parseInt(endbitsUsedInput?.value) || 1);

    if (rowEl) {
        rowEl.dataset.opticutterBlanks = Math.ceil(maxParts / endbitsCount);
    }
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
            const guillotineBlanks = calculateMaxGuillotineBlanks(ebMax, ebMin, bMax, bMin);
            const opt1 = Math.floor(ebMax / bMax) * Math.floor(ebMin / bMin);
            const opt2 = Math.floor(ebMax / bMin) * Math.floor(ebMin / bMin);
            let partsPerEb = Math.max(guillotineBlanks, opt1, opt2, 1);

            const rowEl = Array.from(rows).find(r => r.querySelector(".eb-part-no")?.value?.trim() === p.part_no);
            if (rowEl && rowEl.dataset.opticutterBlanks) {
                partsPerEb = Math.max(partsPerEb, parseInt(rowEl.dataset.opticutterBlanks) || 0);
            }
            const maxPartsAllowed = partsPerEb * endbitsCount;
            const isOptiCutterVerified = Boolean((rowEl && rowEl.dataset.opticutterBlanks) || activeEbOptiCutterLayoutFile);
            const partTotalCutArea = p.cut_length * p.cut_width * p.no_of_parts;

            if (p.no_of_parts > maxPartsAllowed && (partTotalCutArea > totalOffcutArea || !isOptiCutterVerified)) {
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

    // Include layout document from file input or auto-attached OptiCutter file
    const ebFile = formData.get("layout_doc");
    if ((!ebFile || !ebFile.name) && activeEbOptiCutterLayoutFile) {
        formData.set("layout_doc", activeEbOptiCutterLayoutFile);
    }

    // Pass calculated blanks_per_endbit to backend
    const firstRowBlanks = rows[0]?.dataset?.opticutterBlanks ? parseInt(rows[0].dataset.opticutterBlanks) : calculateMaxGuillotineBlanks(ebMax, ebMin, parts[0].cut_length, parts[0].cut_width);
    formData.set("blanks_per_endbit", Math.max(1, firstRowBlanks || 1));

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
            formData.set("endbit_name", formatEndbitName(currentSelectedEndbit));
            formData.set("source_mo_number", currentSelectedEndbit.source_mo_number || currentSelectedEndbit.mo_number || "");
        }
    } else {
        const ebGrade = document.getElementById("ebGradeInput")?.value || "ys";
        const ebThick = parseFloat(document.getElementById("ebThickness")?.value) || 4.8;
        const ebLen = parseFloat(document.getElementById("ebOffcutLength")?.value) || 0;
        const ebWid = parseFloat(document.getElementById("ebOffcutWidth")?.value) || 0;
        formData.set("endbit_id", "");
        formData.set("endbit_name", formatEndbitName({
            grade: ebGrade,
            thickness: ebThick,
            length: ebLen,
            width: ebWid
        }));
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
            fetchNotifications(true);
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
let activeOptiCutterLayoutFile = null;
let activeEbOptiCutterLayoutFile = null;
let customOptiCutterUploadedFile = null;

function onOptCustomDrawingSelected(input) {
    if (input.files && input.files[0]) {
        customOptiCutterUploadedFile = input.files[0];
        const label = document.getElementById("optCustomDrawingLabel");
        if (label) {
            label.textContent = `Attached: ${input.files[0].name} (${(input.files[0].size / 1024).toFixed(1)} KB)`;
            label.style.display = "inline-block";
        }
    }
}

function onEbFileSelected(input) {
    const nameSpan = document.getElementById("ebFileChosenName");
    const dropzone = document.getElementById("ebDocDropzone");
    if (input.files && input.files[0]) {
        activeEbOptiCutterLayoutFile = input.files[0];
        if (nameSpan) {
            nameSpan.innerHTML = `<i class="fa-solid fa-circle-check" style="color: #059669;"></i> Attached: <strong>${escapeHtml(input.files[0].name)}</strong> <small>(${(input.files[0].size / 1024).toFixed(1)} KB)</small>`;
            nameSpan.style.color = "#047857";
        }
        if (dropzone) {
            dropzone.style.background = "#f0fdf4";
            dropzone.style.borderColor = "#10b981";
        }
    } else {
        activeEbOptiCutterLayoutFile = null;
        if (nameSpan) {
            nameSpan.textContent = "No file selected";
            nameSpan.style.color = "";
        }
        if (dropzone) {
            dropzone.style.background = "#f8fafc";
            dropzone.style.borderColor = "#cbd5e1";
        }
    }
}

/**
 * Converts the visual SVG cutting map from OptiCutter into a PNG or SVG File object.
 */
async function generateOptiCutterLayoutFile(filename = "OptiCutter_Layout_Plan.png") {
    if (customOptiCutterUploadedFile) {
        return customOptiCutterUploadedFile;
    }

    const svg = document.querySelector("#optSvgContainer svg");
    if (!svg) return null;

    return new Promise((resolve) => {
        try {
            let svgString = new XMLSerializer().serializeToString(svg);
            if (!svgString.includes('xmlns="http://www.w3.org/2000/svg"')) {
                svgString = svgString.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
            }

            const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
            const url = URL.createObjectURL(svgBlob);
            const img = new Image();

            const viewBox = svg.viewBox?.baseVal;
            const origW = (viewBox && viewBox.width > 0) ? viewBox.width : (parseFloat(svg.getAttribute("width")) || 1200);
            const origH = (viewBox && viewBox.height > 0) ? viewBox.height : (parseFloat(svg.getAttribute("height")) || 800);

            const targetW = 1600;
            const targetH = Math.max(300, Math.round((origH / origW) * targetW));

            img.onload = () => {
                try {
                    const canvas = document.createElement("canvas");
                    canvas.width = targetW;
                    canvas.height = targetH;
                    const ctx = canvas.getContext("2d");

                    ctx.fillStyle = "#ffffff";
                    ctx.fillRect(0, 0, targetW, targetH);
                    ctx.drawImage(img, 0, 0, targetW, targetH);
                    URL.revokeObjectURL(url);

                    canvas.toBlob((pngBlob) => {
                        if (pngBlob) {
                            const file = new File([pngBlob], filename, { type: "image/png", lastModified: Date.now() });
                            resolve(file);
                        } else {
                            const file = new File([svgBlob], filename.replace(/\.png$/, ".svg"), { type: "image/svg+xml", lastModified: Date.now() });
                            resolve(file);
                        }
                    }, "image/png");
                } catch (err) {
                    console.warn("Canvas conversion fallback to SVG file:", err);
                    URL.revokeObjectURL(url);
                    const file = new File([svgBlob], filename.replace(/\.png$/, ".svg"), { type: "image/svg+xml", lastModified: Date.now() });
                    resolve(file);
                }
            };

            img.onerror = () => {
                URL.revokeObjectURL(url);
                const file = new File([svgBlob], filename.replace(/\.png$/, ".svg"), { type: "image/svg+xml", lastModified: Date.now() });
                resolve(file);
            };

            img.src = url;
        } catch (e) {
            console.error("Failed to generate layout file from SVG:", e);
            resolve(null);
        }
    });
}

// ============================================================================
// Modal "Parts to Cut on this Sheet" (Add Part Section) Logic
// ============================================================================
let addModalPartCounter = 0;

function addModalAdditionalPartRow() {
    const list = document.getElementById("modalAdditionalPartsList");
    if (!list) return;

    const rowIdx = addModalPartCounter++;
    const row = document.createElement("div");
    row.className = "modal-add-part-card modal-add-part-row";
    row.id = `modalAddPartRow_${rowIdx}`;

    row.innerHTML = `
        <!-- Row 1: Part Inputs Grid -->
        <div class="modal-add-part-grid">
            <div class="form-col" style="position: relative;">
                <label>Part Number <span style="color:#ef4444;">*</span></label>
                <div class="part-search-input-wrap">
                    <i class="fa-solid fa-barcode"></i>
                    <input type="text" class="add-part-no" id="addPartNo_${rowIdx}" placeholder="Type Part Number..." autocomplete="off" oninput="searchAdditionalPartForModal(${rowIdx}, this.value)" style="height: 38px !important; font-size: 0.85rem; padding-left: 32px !important;">
                    <div class="part-dropdown-results add-part-dropdown" id="addPartDropdown_${rowIdx}" style="display: none;"></div>
                </div>
            </div>

            <div class="form-col">
                <label>Grade</label>
                <input type="text" class="add-part-grade" id="addPartGrade_${rowIdx}" readonly placeholder="Auto" style="height: 38px !important; font-size: 0.85rem; text-align: center; font-weight: 700; color: #0284c7; background: #fff; border: 1.5px solid #cbd5e1; border-radius: 6px;">
            </div>

            <div class="form-col">
                <label>Size (T × L × W)</label>
                <input type="text" class="add-part-size" id="addPartSize_${rowIdx}" readonly placeholder="Auto" style="height: 38px !important; font-size: 0.85rem; text-align: center; font-weight: 600; background: #fff; border: 1.5px solid #cbd5e1; border-radius: 6px;">
                <input type="hidden" class="add-part-len" id="addPartLen_${rowIdx}">
                <input type="hidden" class="add-part-wid" id="addPartWid_${rowIdx}">
                <input type="hidden" class="add-part-thick" id="addPartThick_${rowIdx}">
            </div>

            <div class="form-col">
                <label>Strip/Blank</label>
                <input type="text" class="add-part-strip" id="addPartStrip_${rowIdx}" readonly placeholder="Auto" style="height: 38px !important; font-size: 0.85rem; text-align: center; font-weight: 700; color: #0369a1; background: #f0f9ff; border: 1.5px solid #bae6fd; border-radius: 6px;">
            </div>

            <div class="form-col">
                <label>Offtake</label>
                <input type="text" class="add-part-offtake" id="addPartOfftake_${rowIdx}" readonly placeholder="Auto" style="height: 38px !important; font-size: 0.85rem; text-align: center; font-weight: 700; color: #0284c7; background: #f0fdf4; border: 1.5px solid #86efac; border-radius: 6px;">
            </div>

            <div class="form-col">
                <label>Blanks Qty <span style="color:#ef4444;">*</span></label>
                <input type="number" min="1" step="1" class="add-part-qty" id="addPartQty_${rowIdx}" value="1" oninput="onAddPartQtyChanged()" style="height: 38px !important; font-size: 0.95rem; text-align: center; font-weight: 700; background: #fff; border: 1.5px solid #cbd5e1; border-radius: 6px;">
            </div>

            <div class="form-col" style="justify-content: flex-end;">
                <button type="button" class="btn btn-sm btn-danger" onclick="removeModalAdditionalPartRow(${rowIdx})" style="height: 38px; width: 38px; min-width: 38px; padding: 0; border-radius: 6px; background: #fee2e2; border: 1.5px solid #fca5a5; color: #b91c1c; cursor: pointer; display: flex; align-items: center; justify-content: center;" title="Remove this part">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>

        <!-- Row 3: 3 Cards/Tabs for this Added Part: 1. Qty to Produce, 2. MO Produced Qty, 3. Balance to Produce -->
        <div class="modal-add-part-mrp-tabs" id="addPartMrpRow_${rowIdx}">
            <div class="modal-add-part-mrp-card" style="background: #fffbeb; border: 1.5px solid #fde68a;">
                <div style="width: 28px; height: 28px; border-radius: 5px; background: #fef3c7; color: #d97706; display: flex; align-items: center; justify-content: center; font-size: 0.9rem; flex-shrink: 0;">
                    <i class="fa-solid fa-industry"></i>
                </div>
                <div class="card-info">
                    <span class="card-title" style="color: #b45309;">Qty to Produce</span>
                    <div class="card-val" id="addPartToProduce_${rowIdx}" style="color: #92400e;">- Nos</div>
                </div>
            </div>

            <div class="modal-add-part-mrp-card" style="background: #f0f9ff; border: 1.5px solid #bae6fd;">
                <div style="width: 28px; height: 28px; border-radius: 5px; background: #e0f2fe; color: #0284c7; display: flex; align-items: center; justify-content: center; font-size: 0.9rem; flex-shrink: 0;">
                    <i class="fa-solid fa-clipboard-check"></i>
                </div>
                <div class="card-info">
                    <span class="card-title" style="color: #0369a1;">MO Produced Qty</span>
                    <div class="card-val" id="addPartMoProduced_${rowIdx}" style="color: #075985;">- Nos</div>
                </div>
            </div>

            <div class="modal-add-part-mrp-card" style="background: #ecfdf5; border: 1.5px solid #a7f3d0;">
                <div style="width: 28px; height: 28px; border-radius: 5px; background: #d1fae5; color: #059669; display: flex; align-items: center; justify-content: center; font-size: 0.9rem; flex-shrink: 0;">
                    <i class="fa-solid fa-scale-balanced"></i>
                </div>
                <div class="card-info">
                    <span class="card-title" style="color: #047857;">Balance to Produce</span>
                    <div class="card-val" id="addPartBalance_${rowIdx}" style="color: #065f46;">- Nos</div>
                </div>
            </div>
        </div>
    `;

    list.appendChild(row);
    updateModalAddPartsCountBadge();

    const input = document.getElementById(`addPartNo_${rowIdx}`);
    if (input) input.focus();
}

function removeModalAdditionalPartRow(rowIdx) {
    const row = document.getElementById(`modalAddPartRow_${rowIdx}`);
    if (row) row.remove();
    updateModalAddPartsCountBadge();
    onAddPartQtyChanged();
}

function updateModalAddPartsCountBadge() {
    const badge = document.getElementById("addPartsCountBadge");
    const count = document.querySelectorAll("#modalAdditionalPartsList .modal-add-part-row").length;
    if (badge) {
        badge.textContent = count === 0 ? "1 Part" : `${1 + count} Parts`;
    }
}

let addPartSearchTimer = null;
function searchAdditionalPartForModal(rowIdx, query) {
    clearTimeout(addPartSearchTimer);
    const dropdown = document.getElementById(`addPartDropdown_${rowIdx}`);
    if (!query || query.trim().length < 2) {
        if (dropdown) dropdown.style.display = "none";
        return;
    }

    addPartSearchTimer = setTimeout(async () => {
        try {
            const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`);
            if (res.ok) {
                const results = await res.json();
                if (dropdown) {
                    if (results.length === 0) {
                        dropdown.innerHTML = `<div class="part-dropdown-item text-muted">No matching parts found.</div>`;
                    } else {
                        dropdown.innerHTML = results.map(r => {
                            const sizeStr = (r.thickness && r.length && r.width) ? `${r.thickness}×${r.length}×${r.width} mm` : '';
                            const metaBadge = [r.grade, sizeStr, `Offtake: ${r.offtake || 1} Nos`].filter(Boolean).join(' • ');
                            return `
                                <div class="part-dropdown-item" onclick="selectAdditionalPartForModal(${rowIdx}, '${escapeHtml(r.part_no)}')">
                                    <div>
                                        <strong>${escapeHtml(r.part_no)}</strong>
                                        <small class="text-muted"> (${r.rm_count} RM codes)</small>
                                    </div>
                                    <span class="badge" style="background:#e0f2fe; color:#0369a1; font-weight:600; font-size:0.75rem;">${escapeHtml(metaBadge || r.base_part)}</span>
                                </div>
                            `;
                        }).join("");
                    }
                    dropdown.style.display = "block";
                }
            }
        } catch (e) {
            console.error("Additional part search error:", e);
        }
    }, 200);
}

async function selectAdditionalPartForModal(rowIdx, partNo) {
    const input = document.getElementById(`addPartNo_${rowIdx}`);
    const dropdown = document.getElementById(`addPartDropdown_${rowIdx}`);
    if (input) input.value = partNo;
    if (dropdown) dropdown.style.display = "none";

    try {
        const modalUnit = document.getElementById("modalUnitSelect")?.value || window._activeUnit || window.AUTH_COMPANY_ID || "PEPIPL";
        const cid = (modalUnit && modalUnit !== "ALL") ? modalUnit : (window.AUTH_COMPANY_ID || "PEPIPL");
        const unitParam = `?branch=${encodeURIComponent(cid)}&company_id=${encodeURIComponent(cid)}`;
        const res = await fetch(`/api/part/${encodeURIComponent(partNo)}${unitParam}`);
        if (!res.ok) return;
        const data = await res.json();
        const records = data.records || [];
        const r = records[0] || {};
        const p1 = r.part1 || {};

        const gradeEl = document.getElementById(`addPartGrade_${rowIdx}`);
        const sizeEl = document.getElementById(`addPartSize_${rowIdx}`);
        const lenEl = document.getElementById(`addPartLen_${rowIdx}`);
        const widEl = document.getElementById(`addPartWid_${rowIdx}`);
        const thickEl = document.getElementById(`addPartThick_${rowIdx}`);
        const stripEl = document.getElementById(`addPartStrip_${rowIdx}`);
        const offtakeEl = document.getElementById(`addPartOfftake_${rowIdx}`);
        const qtyEl = document.getElementById(`addPartQty_${rowIdx}`);

        const gradeVal = r.grade || data.grade || "HR";
        const thickVal = parseFloat(r.thickness || data.thickness || 0);

        let pL = 0, pW = 0;
        if (p1.blank_size?.length && p1.blank_size?.width) {
            pL = parseFloat(p1.blank_size.length);
            pW = parseFloat(p1.blank_size.width);
        } else if (p1.cut_blank) {
            const d = parseDimString(p1.cut_blank, thickVal);
            pL = d.l; pW = d.w;
        } else if (r.length && r.width) {
            pL = parseFloat(r.length);
            pW = parseFloat(r.width);
        }

        if (gradeEl) gradeEl.value = gradeVal;
        if (sizeEl) sizeEl.value = (p1.cut_blank || `${thickVal}*${pL}*${pW}`);
        if (lenEl) lenEl.value = pL;
        if (widEl) widEl.value = pW;
        if (thickEl) thickEl.value = thickVal;

        const stripVal = p1.strip_qty || r.strip_qty || 1;
        if (stripEl) stripEl.value = `${stripVal} Nos`;

        const offtakeVal = data.offtake || r.offtake || Math.max(1, Math.round((parseFloat(p1.blank_qty) || 1) * stripVal));
        if (offtakeEl) offtakeEl.value = `${offtakeVal} Nos`;

        if (qtyEl && (!qtyEl.value || qtyEl.value === "1")) {
            qtyEl.value = offtakeVal;
        }

        // Populate the 3 MRP Cards for this added part (1. Qty to Produce, 2. MO Produced Qty, 3. Balance to Produce)
        const mrp = data.mrp || {};
        const sched = Number(mrp.monthly_schedule || 0);
        const curStock = Number(mrp.current_stock || 0);
        const initStock = mrp.initial_stock !== undefined ? Number(mrp.initial_stock) : curStock;
        const producedMo = mrp.app_mo_produced !== undefined ? Number(mrp.app_mo_produced) : 0;

        // Card 1: Qty to Produce = Math.max(0, sched - initStock)
        const qtyToProduce = Math.max(0, sched - initStock);
        // Card 2: MO Produced = producedMo
        // Card 3: Balance = Math.max(0, qtyToProduce - producedMo)
        const balance = Math.max(0, qtyToProduce - producedMo);

        const toPEl = document.getElementById(`addPartToProduce_${rowIdx}`);
        const moPEl = document.getElementById(`addPartMoProduced_${rowIdx}`);
        const balEl = document.getElementById(`addPartBalance_${rowIdx}`);
        const mrpQEl = document.getElementById(`addPartMrpQty_${rowIdx}`);
        const curSEl = document.getElementById(`addPartCurStock_${rowIdx}`);

        if (toPEl) {
            toPEl.textContent = mrp.monthly_schedule !== undefined ? `${qtyToProduce.toLocaleString()} Nos` : "- Nos";
        }
        if (moPEl) {
            moPEl.textContent = mrp.monthly_schedule !== undefined ? `${producedMo.toLocaleString()} Nos` : "- Nos";
        }
        if (balEl) {
            if (mrp.monthly_schedule !== undefined) {
                if (balance === 0 && qtyToProduce > 0) {
                    balEl.innerHTML = `0 Nos <small style="display:inline-block; margin-left:4px; font-size:0.68rem; font-weight:700; color:#059669; background:#d1fae5; border:1px solid #a7f3d0; padding:1px 5px; border-radius:4px;"><i class="fa-solid fa-circle-check"></i> Complete</small>`;
                } else {
                    balEl.textContent = `${balance.toLocaleString()} Nos`;
                }
            } else {
                balEl.textContent = "- Nos";
            }
        }
        if (mrpQEl) mrpQEl.textContent = mrp.monthly_schedule !== undefined ? `${sched.toLocaleString()} Nos` : "- Nos";
        if (curSEl) curSEl.textContent = mrp.current_stock !== undefined ? `${curStock.toLocaleString()} Nos` : "- Nos";

        onAddPartQtyChanged();
    } catch (e) {
        console.error("Error loading additional part details:", e);
    }
}

function refreshModalIntelligenceForCurrentParts() {
    const basePartNo = document.getElementById("partNoInput")?.value?.trim();
    if (!basePartNo) return;
    const rmSelect = document.getElementById("rmErpSelect");
    const selOpt = rmSelect?.selectedOptions[0];
    let rmCode = selOpt?.value || "";
    if (rmCode === "__custom__" && window._selectedCustomRmRecord) {
        rmCode = window._selectedCustomRmRecord.rm_code || "";
    }
    const grade = document.getElementById("gradeInput")?.value?.trim() || "";
    const thickness = document.getElementById("thicknessInput")?.value?.trim() || "";
    const length = document.getElementById("sheetLengthInput")?.value?.trim() || "";
    const width = document.getElementById("sheetWidthInput")?.value?.trim() || "";
    const sheetsNeeded = Math.max(1, parseFloat(document.getElementById("sheetsRequired")?.value) || 1);

    const allParts = [basePartNo];
    document.querySelectorAll("#modalAdditionalPartsList .add-part-no").forEach(inp => {
        const val = inp.value?.trim();
        if (val && !allParts.includes(val)) allParts.push(val);
    });

    fetchAndDisplayIntelligence(
        basePartNo,
        rmCode,
        grade,
        thickness,
        length,
        width,
        sheetsNeeded,
        false,
        allParts
    );
}

function onAddPartQtyChanged() {
    recalculateTargetQtyFromLayout();
    refreshModalIntelligenceForCurrentParts();
    if (window._aiSuggestionsRequestedByUser && typeof fetchAiPartSuggestions === "function") {
        fetchAiPartSuggestions(activeAiFilterMode || "all");
    }
}

/**
 * Standard Layout Companion Parts Renderer (Preserved strictly for PEPIPL standard CAD layouts)
 * Injects pre-defined companion parts from layout_records into 'Parts to Cut on this Sheet'
 * and fetches their live MRP Demand stat cards (MRP Quantity, Current Stock, Qty to Produce).
 */
function renderStandardLayoutCompanionParts(record) {
    const list = document.getElementById("modalAdditionalPartsList");
    if (!list) return;

    const stdRadio = document.querySelector('input[name="is_standard_layout"][value="true"]');
    const isStd = stdRadio ? stdRadio.checked : true;
    const activeComp = (window.AUTH_BRANCH_CODE || window.AUTH_COMPANY_ID || document.getElementById("modalUnitSelect")?.value || "PEPIPL").toUpperCase();
    const isPepipl = (activeComp === "PEPIPL" || activeComp === "ALL");

    // Remove any previously rendered standard companion rows
    const oldStdRows = list.querySelectorAll(".std-companion-part-row");
    oldStdRows.forEach(r => r.remove());

    if (!isStd || !isPepipl || !record) {
        updateModalAddPartsCountBadge();
        return;
    }

    const stdChildParts = [];
    [record.part2, record.part3, record.part4].forEach((child, cIdx) => {
        if (child && child.part_no && child.part_no.trim() !== "") {
            stdChildParts.push({ ...child, childIdx: cIdx + 2 });
        }
    });

    if (stdChildParts.length === 0) {
        updateModalAddPartsCountBadge();
        return;
    }

    // Hide inline AI recommendations when standard layout already defines exact companion parts
    const inlineBanner = document.getElementById("inlineAiPartSuggestionsBanner");
    if (inlineBanner) inlineBanner.style.display = "none";

    const sheetsNeeded = Math.max(1, parseFloat(document.getElementById("sheetsRequired")?.value) || 1);
    const thickVal = parseFloat(document.getElementById("thicknessInput")?.value) || parseFloat(record.thickness) || 0;

    stdChildParts.forEach(child => {
        const rowIdx = addModalPartCounter++;
        const row = document.createElement("div");
        row.className = "modal-add-part-card modal-add-part-row std-companion-part-row";
        row.id = `modalAddPartRow_${rowIdx}`;
        row.dataset.stdPart = "true";
        row.dataset.childIdx = child.childIdx;

        let pL = 0, pW = 0;
        if (child.blank_size?.length && child.blank_size?.width) {
            pL = parseFloat(child.blank_size.length);
            pW = parseFloat(child.blank_size.width);
        } else if (child.cut_blank) {
            const d = parseDimString(child.cut_blank, thickVal);
            pL = d.l; pW = d.w;
        }

        const blanksPerSheet = parseFloat(child.blank_qty) || 1;
        const stripVal = parseFloat(child.strip_qty) || 1;
        const blanksTotal = Math.max(1, Math.round(blanksPerSheet * stripVal * sheetsNeeded));
        const sizeStr = (pL > 0 && pW > 0) ? `${thickVal}*${pL}*${pW}` : (child.cut_blank || "");
        const gradeVal = record.grade || child.grade || "HR";
        const offtakeVal = Math.max(1, Math.round(blanksPerSheet * stripVal));

        row.dataset.blanksPerSheet = blanksPerSheet;
        row.dataset.stripQty = stripVal;

        row.innerHTML = `
            <!-- Row 1: Part Technical Grid -->
            <div class="modal-add-part-grid">
                <div class="form-col" style="position: relative;">
                    <label style="display: flex; align-items: center; justify-content: space-between;">
                        <span>Part Number</span>
                        <span style="font-size:0.68rem; font-weight:700; background:#e0f2fe; color:#0284c7; padding:1px 6px; border-radius:4px;"><i class="fa-solid fa-shapes"></i> Standard Layout Part</span>
                    </label>
                    <div class="part-search-input-wrap">
                        <i class="fa-solid fa-link" style="color: #0284c7;"></i>
                        <input type="text" class="add-part-no" id="addPartNo_${rowIdx}" value="${escapeHtml(child.part_no)}" readonly style="height: 38px !important; font-size: 0.85rem; padding-left: 32px !important; font-weight: 700; background: #f8fafc; color: #0f172a;">
                    </div>
                </div>

                <div class="form-col">
                    <label>Grade</label>
                    <input type="text" class="add-part-grade" id="addPartGrade_${rowIdx}" value="${escapeHtml(gradeVal)}" readonly style="height: 38px !important; font-size: 0.85rem; text-align: center; font-weight: 700; color: #0284c7; background: #fff; border: 1.5px solid #cbd5e1; border-radius: 6px;">
                </div>

                <div class="form-col">
                    <label>Size (T × L × W)</label>
                    <input type="text" class="add-part-size" id="addPartSize_${rowIdx}" value="${escapeHtml(sizeStr)}" readonly style="height: 38px !important; font-size: 0.85rem; text-align: center; font-weight: 600; background: #fff; border: 1.5px solid #cbd5e1; border-radius: 6px;">
                    <input type="hidden" class="add-part-len" id="addPartLen_${rowIdx}" value="${pL}">
                    <input type="hidden" class="add-part-wid" id="addPartWid_${rowIdx}" value="${pW}">
                    <input type="hidden" class="add-part-thick" id="addPartThick_${rowIdx}" value="${thickVal}">
                </div>

                <div class="form-col">
                    <label>Strip/Blank</label>
                    <input type="text" class="add-part-strip" id="addPartStrip_${rowIdx}" value="${stripVal} Nos" readonly style="height: 38px !important; font-size: 0.85rem; text-align: center; font-weight: 700; color: #0369a1; background: #f0f9ff; border: 1.5px solid #bae6fd; border-radius: 6px;">
                </div>

                <div class="form-col">
                    <label>Offtake</label>
                    <input type="text" class="add-part-offtake" id="addPartOfftake_${rowIdx}" value="${offtakeVal} Nos" readonly style="height: 38px !important; font-size: 0.85rem; text-align: center; font-weight: 700; color: #0284c7; background: #f0fdf4; border: 1.5px solid #86efac; border-radius: 6px;">
                </div>

                <div class="form-col">
                    <label>Blanks Qty</label>
                    <input type="number" min="1" step="1" class="add-part-qty" id="addPartQty_${rowIdx}" value="${blanksTotal}" readonly oninput="onAddPartQtyChanged()" style="height: 38px !important; font-size: 0.95rem; text-align: center; font-weight: 700; background: #f8fafc; border: 1.5px solid #cbd5e1; border-radius: 6px; color: #0f172a;">
                </div>

                <div class="form-col" style="justify-content: flex-end;">
                    <button type="button" class="btn btn-sm btn-ghost" onclick="removeModalAdditionalPartRow(${rowIdx})" style="height: 38px; width: 38px; min-width: 38px; padding: 0; border-radius: 6px; background: #f1f5f9; border: 1px solid #cbd5e1; color: #64748b; cursor: pointer; display: flex; align-items: center; justify-content: center;" title="Remove this companion part from MO">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>

            <!-- Row 2: 3 Cards/Tabs for this Added Part: 1. Qty to Produce, 2. MO Produced Qty, 3. Balance to Produce -->
            <div class="modal-add-part-mrp-tabs" id="addPartMrpRow_${rowIdx}">
                <div class="modal-add-part-mrp-card" style="background: #fffbeb; border: 1.5px solid #fde68a;">
                    <div style="width: 28px; height: 28px; border-radius: 5px; background: #fef3c7; color: #d97706; display: flex; align-items: center; justify-content: center; font-size: 0.9rem; flex-shrink: 0;">
                        <i class="fa-solid fa-industry"></i>
                    </div>
                    <div class="card-info">
                        <span class="card-title" style="color: #b45309;">Qty to Produce</span>
                        <div class="card-val" id="addPartToProduce_${rowIdx}" style="color: #92400e;"><i class="fa-solid fa-spinner fa-spin" style="font-size:0.8rem;"></i> Loading...</div>
                    </div>
                </div>

                <div class="modal-add-part-mrp-card" style="background: #f0f9ff; border: 1.5px solid #bae6fd;">
                    <div style="width: 28px; height: 28px; border-radius: 5px; background: #e0f2fe; color: #0284c7; display: flex; align-items: center; justify-content: center; font-size: 0.9rem; flex-shrink: 0;">
                        <i class="fa-solid fa-clipboard-check"></i>
                    </div>
                    <div class="card-info">
                        <span class="card-title" style="color: #0369a1;">MO Produced Qty</span>
                        <div class="card-val" id="addPartMoProduced_${rowIdx}" style="color: #075985;"><i class="fa-solid fa-spinner fa-spin" style="font-size:0.8rem;"></i> Loading...</div>
                    </div>
                </div>

                <div class="modal-add-part-mrp-card" style="background: #ecfdf5; border: 1.5px solid #a7f3d0;">
                    <div style="width: 28px; height: 28px; border-radius: 5px; background: #d1fae5; color: #059669; display: flex; align-items: center; justify-content: center; font-size: 0.9rem; flex-shrink: 0;">
                        <i class="fa-solid fa-scale-balanced"></i>
                    </div>
                    <div class="card-info">
                        <span class="card-title" style="color: #047857;">Balance to Produce</span>
                        <div class="card-val" id="addPartBalance_${rowIdx}" style="color: #065f46;"><i class="fa-solid fa-spinner fa-spin" style="font-size:0.8rem;"></i> Loading...</div>
                    </div>
                </div>
            </div>
        `;

        list.appendChild(row);

        // Fetch live MRP stats for this child part
        fetchChildPartMrpStats(child.part_no, activeComp, rowIdx);
    });

    updateModalAddPartsCountBadge();
}

/**
 * Fetches live MRP stats (MRP Quantity, Current Stock, Qty to Produce) from clean Supabase DB
 * for a child part row in the modal.
 */
async function fetchChildPartMrpStats(partNo, companyId, rowIdx) {
    if (!partNo) return;
    try {
        const cid = companyId || window.AUTH_COMPANY_ID || "PEPIPL";
        const unitParam = `?branch=${encodeURIComponent(cid)}&company_id=${encodeURIComponent(cid)}`;
        const res = await fetch(`/api/part/${encodeURIComponent(partNo)}${unitParam}`);
        if (!res.ok) {
            const toPEl = document.getElementById(`addPartToProduce_${rowIdx}`);
            const moPEl = document.getElementById(`addPartMoProduced_${rowIdx}`);
            const balEl = document.getElementById(`addPartBalance_${rowIdx}`);
            const mrpQEl = document.getElementById(`addPartMrpQty_${rowIdx}`);
            const curSEl = document.getElementById(`addPartCurStock_${rowIdx}`);
            if (toPEl) toPEl.textContent = "- Nos";
            if (moPEl) moPEl.textContent = "- Nos";
            if (balEl) balEl.textContent = "- Nos";
            if (mrpQEl) mrpQEl.textContent = "- Nos";
            if (curSEl) curSEl.textContent = "- Nos";
            return;
        }

        const data = await res.json();
        const mrp = data.mrp || {};
        const sched = (mrp.monthly_schedule !== undefined && mrp.monthly_schedule !== null) ? Number(mrp.monthly_schedule) : null;
        const curStock = (mrp.current_stock !== undefined && mrp.current_stock !== null) ? Number(mrp.current_stock) : null;
        const initStock = mrp.initial_stock !== undefined && mrp.initial_stock !== null ? Number(mrp.initial_stock) : (curStock || 0);
        const excelMo = (mrp.excel_mo_produced !== undefined && mrp.excel_mo_produced !== null) ? Number(mrp.excel_mo_produced) : ((mrp.sheet_mo_produced !== undefined) ? Number(mrp.sheet_mo_produced) : 0);
        const appMo = (mrp.app_mo_produced !== undefined && mrp.app_mo_produced !== null) ? Number(mrp.app_mo_produced) : 0;
        const producedMo = (mrp.mo_produced !== undefined && mrp.mo_produced !== null) ? Number(mrp.mo_produced) : (excelMo + appMo);

        const toPEl = document.getElementById(`addPartToProduce_${rowIdx}`);
        const moPEl = document.getElementById(`addPartMoProduced_${rowIdx}`);
        const balEl = document.getElementById(`addPartBalance_${rowIdx}`);
        const mrpQEl = document.getElementById(`addPartMrpQty_${rowIdx}`);
        const curSEl = document.getElementById(`addPartCurStock_${rowIdx}`);

        const baseQtyToProduce = (mrp.base_qty_to_produce !== undefined && mrp.base_qty_to_produce !== null)
            ? Number(mrp.base_qty_to_produce)
            : (sched !== null ? Math.max(0, sched - initStock) : (mrp.qty_to_produce !== undefined ? Number(mrp.qty_to_produce) : null));

        const balance = (mrp.balance_to_produce !== undefined && mrp.balance_to_produce !== null)
            ? Math.max(0, Number(mrp.balance_to_produce))
            : (baseQtyToProduce !== null ? Math.max(0, baseQtyToProduce - producedMo) : null);

        if (toPEl) toPEl.textContent = baseQtyToProduce !== null ? `${baseQtyToProduce.toLocaleString()} Nos` : "- Nos";
        if (moPEl) moPEl.textContent = `${producedMo.toLocaleString()} Nos`;
        if (balEl) {
            if (balance === 0 && baseQtyToProduce !== null && baseQtyToProduce > 0) {
                balEl.innerHTML = `0 Nos <small style="display:inline-block; margin-left:4px; font-size:0.68rem; font-weight:700; color:#059669; background:#d1fae5; border:1px solid #a7f3d0; padding:1px 5px; border-radius:4px;"><i class="fa-solid fa-circle-check"></i> Complete</small>`;
            } else if (balance === 0 && baseQtyToProduce === 0) {
                balEl.innerHTML = `0 Nos <small style="display:inline-block; margin-left:4px; font-size:0.68rem; font-weight:700; color:#059669; background:#d1fae5; border:1px solid #a7f3d0; padding:1px 5px; border-radius:4px;"><i class="fa-solid fa-circle-check"></i> Stock OK</small>`;
            } else {
                balEl.textContent = balance !== null ? `${balance.toLocaleString()} Nos` : "- Nos";
            }
        }

        if (mrpQEl) mrpQEl.textContent = sched !== null ? `${sched.toLocaleString()} Nos` : "- Nos";
        if (curSEl) curSEl.textContent = curStock !== null ? `${curStock.toLocaleString()} Nos` : "- Nos";
    } catch (e) {
        console.error("fetchChildPartMrpStats error:", e);
    }
}

window.addModalAdditionalPartRow = addModalAdditionalPartRow;
window.removeModalAdditionalPartRow = removeModalAdditionalPartRow;
window.searchAdditionalPartForModal = searchAdditionalPartForModal;
window.selectAdditionalPartForModal = selectAdditionalPartForModal;
window.onAddPartQtyChanged = onAddPartQtyChanged;
window.refreshModalIntelligenceForCurrentParts = refreshModalIntelligenceForCurrentParts;
window.renderStandardLayoutCompanionParts = renderStandardLayoutCompanionParts;
window.fetchChildPartMrpStats = fetchChildPartMrpStats;

// ============================================================================
// AI PART CO-PRODUCTION & YIELD ADVISOR AGENT
// Autonomous companion part recommender: First priority = Highest Sheet Yield Boost,
// Second priority = Low stock / pending MRP demand
// ============================================================================
let activeAiFilterMode = "all";
let currentAiSuggestionsData = null;
let isAiSuggestionsLoading = false;

function getActiveMoSheetDimensions() {
    let sLen = 0;
    let sWid = 0;
    const thickVal = parseFloat(document.getElementById("thicknessInput")?.value) || 0;
    const rmSelect = document.getElementById("rmErpSelect");
    const selOpt = rmSelect?.selectedOptions[0];
    let rmRec = selOpt?.dataset?.record ? JSON.parse(selOpt.dataset.record) : null;
    if (window._selectedRmAgentRecord && (!rmRec || rmRec.rm_erp === window._selectedRmAgentRecord.rm_erp)) {
        rmRec = { ...(rmRec || {}), ...window._selectedRmAgentRecord };
    }
    if (!rmRec && window._selectedCustomRmRecord) {
        rmRec = window._selectedCustomRmRecord;
    }
    if (rmRec) {
        sLen = parseFloat(rmRec.sheet_length || rmRec.length || 0);
        sWid = parseFloat(rmRec.sheet_width || rmRec.width || 0);
        if ((!sLen || !sWid) && rmRec.sheet_size) {
            const sd = parseDimString(rmRec.sheet_size, thickVal);
            if (sd.l > 0 && sd.w > 0) { sLen = sd.l; sWid = sd.w; }
        }
        if ((!sLen || !sWid) && (rmRec.rm_erp || rmRec.item_code)) {
            const sd = parseDimString(rmRec.rm_erp || rmRec.item_code, thickVal);
            if (sd.l > 0 && sd.w > 0) { sLen = sd.l; sWid = sd.w; }
        }
    }
    if ((!sLen || !sWid) && selOpt && selOpt.value) {
        const sd = parseDimString(selOpt.value, thickVal);
        if (sd.l > 0 && sd.w > 0) { sLen = sd.l; sWid = sd.w; }
    }
    if (!sLen || !sWid) {
        sLen = 2500;
        sWid = 1250;
    }
    return { length: Math.max(sLen, sWid), width: Math.min(sLen, sWid) };
}

async function fetchAiPartSuggestions(filterMode = "all") {
    activeAiFilterMode = filterMode;
    const basePartNo = document.getElementById("partNoInput")?.value?.trim();
    if (!basePartNo) {
        const inlineBanner = document.getElementById("inlineAiPartSuggestionsBanner");
        if (inlineBanner) inlineBanner.style.display = "none";
        return;
    }

    const sheetDims = getActiveMoSheetDimensions();
    const sLen = sheetDims.length;
    const sWid = sheetDims.width;
    const grade = document.getElementById("gradeInput")?.value?.trim() || "";
    const thickness = parseFloat(document.getElementById("thicknessInput")?.value) || 0;

    const basePart = window._activeBasePartData || {};
    const bLen = parseFloat(document.getElementById("lengthInput")?.value) || parseFloat(basePart.length) || 0;
    const bWid = parseFloat(document.getElementById("widthInput")?.value) || parseFloat(basePart.width) || 0;

    const rmSelect = document.getElementById("rmErpSelect");
    const selOpt = rmSelect?.selectedOptions[0];
    let rmRec = selOpt?.dataset?.record ? JSON.parse(selOpt.dataset.record) : null;
    if (window._selectedRmAgentRecord && (!rmRec || rmRec.rm_erp === window._selectedRmAgentRecord.rm_erp)) {
        rmRec = { ...(rmRec || {}), ...window._selectedRmAgentRecord };
    }

    let baseBlanks = 0;
    if (rmRec?.part1?.total_blank_qty_sheet) {
        baseBlanks = parseInt(rmRec.part1.total_blank_qty_sheet, 10);
    } else if (rmRec?.parts_per_sheet) {
        baseBlanks = parseInt(rmRec.parts_per_sheet, 10);
    } else if (window._selectedRmAgentRecord?.parts_per_sheet) {
        baseBlanks = parseInt(window._selectedRmAgentRecord.parts_per_sheet, 10);
    }
    if (!baseBlanks || baseBlanks < 1) {
        const autoDisp = parseInt(document.getElementById("autoTargetQtyDisplay")?.textContent, 10);
        if (!isNaN(autoDisp) && autoDisp > 0) baseBlanks = autoDisp;
    }

    // Collect all currently added parts so we don't suggest duplicates
    const currentParts = [basePartNo];
    const existingParts = [];
    document.querySelectorAll("#modalAdditionalPartsList .modal-add-part-row").forEach((r, idx) => {
        const pNo = r.querySelector(".add-part-no")?.value?.trim();
        let pL = parseFloat(r.querySelector(".add-part-len")?.value) || 0;
        let pW = parseFloat(r.querySelector(".add-part-wid")?.value) || 0;
        const pThick = parseFloat(r.querySelector(".add-part-thick")?.value) || thickness || 0;
        const sizeVal = r.querySelector(".add-part-size")?.value?.trim() || "";
        if ((!pL || !pW) && sizeVal) {
            const d = parseDimString(sizeVal, pThick);
            if (d.l > 0 && d.w > 0) { pL = d.l; pW = d.w; }
        }
        const pQty = Math.max(1, parseInt(r.querySelector(".add-part-qty")?.value) || 1);
        if (pNo && !currentParts.includes(pNo)) currentParts.push(pNo);
        if (pNo && pL > 0 && pW > 0) {
            existingParts.push({
                part_no: pNo,
                length: Math.max(pL, pW),
                width: Math.min(pL, pW),
                qty: pQty
            });
        }
    });

    isAiSuggestionsLoading = true;
    const modalCardsContainer = document.getElementById("aiAdvisorCardsContainer");
    if (modalCardsContainer && document.getElementById("modalAiPartSuggestions")?.style.display === "flex") {
        modalCardsContainer.innerHTML = `
            <div style="padding: 30px; text-align: center; color: #6d28d9;">
                <i class="fa-solid fa-spinner fa-spin fa-2x" style="margin-bottom: 10px;"></i>
                <div style="font-weight: 700;">AI Agent Nesting Simulator Running...</div>
                <small style="color: #64748b;">Evaluating 2D guillotine cut yield and MRP inventory for companion parts in remaining sheet space</small>
            </div>
        `;
    }

    try {
        const params = new URLSearchParams({
            base_part: basePartNo,
            sheet_length: sLen,
            sheet_width: sWid,
            grade: grade,
            thickness: thickness,
            base_blanks: baseBlanks,
            base_blank_length: bLen,
            base_blank_width: bWid,
            filter_mode: filterMode,
            current_parts: currentParts.join(","),
            existing_parts: JSON.stringify(existingParts)
        });

        const res = await fetch(`/api/intelligence/suggest-parts?${params.toString()}`);
        if (!res.ok) {
            console.error("AI suggestions fetch failed:", res.status);
            return;
        }

        const data = await res.json();
        currentAiSuggestionsData = data;

        // Render inline quick-cards
        renderInlineAiPartSuggestions(data);

        // Render full modal content if modal is open
        if (document.getElementById("modalAiPartSuggestions")?.style.display === "flex") {
            renderAiAdvisorModalContent(data);
        }
    } catch (err) {
        console.error("Failed to load AI companion parts:", err);
    } finally {
        isAiSuggestionsLoading = false;
    }
}

function renderInlineAiPartSuggestions(data) {
    const banner = document.getElementById("inlineAiPartSuggestionsBanner");
    const cardsWrap = document.getElementById("inlineAiSuggestionsCards");
    if (!banner || !cardsWrap) return;

    // Strictly suppress automatic display; only show if explicitly requested by user
    if (!window._aiSuggestionsRequestedByUser) {
        banner.style.display = "none";
        return;
    }

    const recs = data?.recommendations || [];
    if (!data || !data.success || recs.length === 0) {
        banner.style.display = "none";
        return;
    }

    // Show top 3-4 recommendation cards inline
    const topCandidates = recs.slice(0, 3);
    cardsWrap.innerHTML = topCandidates.map((cand, idx) => {
        const boostVal = parseFloat(cand.yield_boost || 0);
        const boostSign = boostVal > 0 ? `+${boostVal.toFixed(1)}%` : `${boostVal.toFixed(1)}%`;
        const boostColor = boostVal > 0 ? "#059669" : "#64748b";
        const qtyProduce = parseInt(cand.qty_to_produce || 0);
        const curStock = parseInt(cand.current_stock || 0);

        let qtyBadgeBg = "#fef3c7";
        let qtyBadgeColor = "#b45309";
        let qtyLabel = `${qtyProduce.toLocaleString()} to produce`;
        if (qtyProduce >= 100) {
            qtyBadgeBg = "#fee2e2";
            qtyBadgeColor = "#b91c1c";
            qtyLabel = `🔥 High Demand: ${qtyProduce.toLocaleString()} Nos`;
        } else if (qtyProduce > 0 && qtyProduce < 50) {
            qtyBadgeBg = "#fef9c3";
            qtyBadgeColor = "#854d0e";
            qtyLabel = `⚡ Scrap Filler: ${qtyProduce} Nos`;
        } else if (qtyProduce === 0) {
            qtyBadgeBg = "#f1f5f9";
            qtyBadgeColor = "#475569";
            qtyLabel = `Stock: ${curStock.toLocaleString()} Nos`;
        }

        return `
            <div style="background: #ffffff; border: 1.5px solid #cbd5e1; border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; justify-content: space-between; box-shadow: 0 1px 3px rgba(0,0,0,0.05); transition: border-color 0.2s;">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 5px;">
                    <div>
                        <strong style="font-size: 0.88rem; color: #1e293b; display: block;">${escapeHtml(cand.part_no)}</strong>
                        <div style="font-size: 0.72rem; color: #64748b;">${escapeHtml(cand.grade)} • ${escapeHtml(cand.blank_size_str)} mm</div>
                    </div>
                    <span style="font-size: 0.68rem; font-weight: 800; background: #e0f2fe; color: #0369a1; padding: 2px 7px; border-radius: 4px;">
                        #${idx + 1} Fit
                    </span>
                </div>
                
                <div style="display: flex; align-items: center; gap: 6px; margin: 5px 0; flex-wrap: wrap;">
                    <span style="font-size: 0.72rem; font-weight: 700; background: #ecfdf5; color: ${boostColor}; border: 1px solid #a7f3d0; padding: 2px 6px; border-radius: 4px;" title="Combined Multi-Part Sheet Yield">
                        <i class="fa-solid fa-arrow-trend-up"></i> ${cand.combined_yield.toFixed(1)}% (${boostSign})
                    </span>
                    <span style="font-size: 0.72rem; font-weight: 700; background: ${qtyBadgeBg}; color: ${qtyBadgeColor}; padding: 2px 6px; border-radius: 4px;" title="Pending MRP Demand / In-Hand Stock">
                        ${escapeHtml(qtyLabel)}
                    </span>
                </div>

                <div style="margin-top: 8px; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #f1f5f9; padding-top: 6px;">
                    <small style="font-size: 0.72rem; color: #64748b; font-weight: 600;">Nests ${cand.recommended_blanks} blanks</small>
                    <button type="button" class="btn btn-sm btn-primary" onclick="addSuggestedPartToCutList('${escapeHtml(cand.part_no)}', ${cand.recommended_blanks})" style="font-size: 0.74rem; padding: 3px 10px; font-weight: 700; border-radius: 5px; background: #0284c7; color: #fff; border: none; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; box-shadow: 0 1px 2px rgba(2, 132, 199, 0.2);">
                        <i class="fa-solid fa-plus"></i> Add to Sheet
                    </button>
                </div>
            </div>
        `;
    }).join("");

    banner.style.display = "block";
}

function openAiPartSuggestionsModal() {
    const basePartNo = document.getElementById("partNoInput")?.value?.trim();
    if (!basePartNo) {
        alert("Please select a primary part first before opening the AI Co-Production Advisor.");
        return;
    }

    window._aiSuggestionsRequestedByUser = true;
    const modal = document.getElementById("modalAiPartSuggestions");
    if (!modal) return;

    // Populate Context Ribbon with actual sheet dimensions
    const grade = document.getElementById("gradeInput")?.value?.trim() || "HR";
    const thickness = document.getElementById("thicknessInput")?.value?.trim() || "0";
    const sheetDims = getActiveMoSheetDimensions();
    const sLen = sheetDims.length;
    const sWid = sheetDims.width;

    const baseEl = document.getElementById("aiAdvisorBasePartDisplay");
    const gradeEl = document.getElementById("aiAdvisorGradeDisplay");
    const sheetEl = document.getElementById("aiAdvisorSheetSizeDisplay");
    const baseYieldEl = document.getElementById("aiAdvisorBaselineYieldDisplay");

    if (baseEl) baseEl.textContent = basePartNo;
    if (gradeEl) gradeEl.textContent = `${grade} (${thickness} mm)`;
    if (sheetEl) sheetEl.textContent = `${sLen} × ${sWid} mm`;
    if (baseYieldEl) baseYieldEl.textContent = currentAiSuggestionsData?.baseline_yield ? `${currentAiSuggestionsData.baseline_yield.toFixed(1)}%` : "-%";

    modal.style.display = "flex";

    // Reset tabs
    document.querySelectorAll(".ai-filter-tab").forEach(tab => {
        if (tab.getAttribute("data-mode") === (activeAiFilterMode || "all")) {
            tab.style.background = "#7c3aed";
            tab.style.color = "#fff";
            tab.style.borderColor = "#7c3aed";
        } else {
            tab.style.background = "#fff";
            tab.style.color = "#334155";
            tab.style.borderColor = "#cbd5e1";
        }
    });

    fetchAiPartSuggestions(activeAiFilterMode || "all");
}

function closeAiPartSuggestionsModal() {
    const modal = document.getElementById("modalAiPartSuggestions");
    if (modal) modal.style.display = "none";
}

function setAiAdvisorFilterMode(mode, btn) {
    activeAiFilterMode = mode;
    // Sync modal tabs
    document.querySelectorAll(".ai-filter-tab").forEach(tab => {
        if (tab.getAttribute("data-mode") === mode) {
            tab.style.background = "#7c3aed";
            tab.style.color = "#fff";
            tab.style.borderColor = "#7c3aed";
        } else {
            tab.style.background = "#fff";
            tab.style.color = "#334155";
            tab.style.borderColor = "#cbd5e1";
        }
    });

    // Sync inline chips
    const chipMap = {
        all: "chipAiAll",
        more_qty: "chipAiMoreQty",
        less_qty: "chipAiLessQty",
        max_yield: "chipAiMaxYield"
    };
    document.querySelectorAll(".inline-ai-chip").forEach(chip => {
        chip.style.background = "#fff";
        chip.style.color = "#334155";
        chip.style.borderColor = "#cbd5e1";
    });
    const activeChipId = chipMap[mode];
    if (activeChipId) {
        const c = document.getElementById(activeChipId);
        if (c) {
            c.style.background = "#059669";
            c.style.color = "#fff";
            c.style.borderColor = "#059669";
        }
    }

    fetchAiPartSuggestions(mode);
}

function renderAiAdvisorModalContent(data) {
    const container = document.getElementById("aiAdvisorCardsContainer");
    const execText = document.getElementById("aiAdvisorExecutiveText");
    const baseYieldEl = document.getElementById("aiAdvisorBaselineYieldDisplay");
    if (!container) return;

    if (baseYieldEl && data.baseline_yield) {
        baseYieldEl.textContent = `${data.baseline_yield.toFixed(1)}%`;
    }

    if (execText && data.ai_executive_summary) {
        execText.innerHTML = `<strong>Autonomous Recommendation:</strong> ${escapeHtml(data.ai_executive_summary)}`;
    }

    const recs = data.recommendations || [];
    if (recs.length === 0) {
        container.innerHTML = `
            <div style="background: #ffffff; border: 1.5px dashed #cbd5e1; border-radius: 8px; padding: 30px; text-align: center; color: #64748b;">
                <i class="fa-solid fa-shapes fa-2x" style="margin-bottom: 10px; color: #94a3b8;"></i>
                <div style="font-weight: 700; color: #1e293b;">No matching candidate parts found for this filter</div>
                <small>Try selecting "Top Ranked" or verifying that parts with grade "${escapeHtml(data.grade)}" and thickness "${data.thickness}mm" exist in the parts master.</small>
            </div>
        `;
        return;
    }

    container.innerHTML = recs.map((cand, idx) => {
        const boostVal = parseFloat(cand.yield_boost || 0);
        const boostSign = boostVal > 0 ? `+${boostVal.toFixed(1)}%` : `${boostVal.toFixed(1)}%`;
        const boostColor = boostVal > 0 ? "#059669" : "#64748b";

        const isUrgent = cand.stock_status === "CRITICAL_ZERO" || cand.stock_status === "LOW_STOCK";
        const stockBadgeBg = isUrgent ? "#fee2e2" : "#fef3c7";
        const stockBadgeColor = isUrgent ? "#b91c1c" : "#b45309";

        return `
            <div class="ai-candidate-card" style="background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 10px; padding: 14px 16px; box-shadow: 0 2px 4px rgba(0,0,0,0.03); transition: all 0.2s; position: relative;">
                <!-- Card Header -->
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px; flex-wrap: wrap; gap: 8px;">
                    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                        <span style="background: #7c3aed; color: #fff; font-size: 0.72rem; font-weight: 800; padding: 2px 8px; border-radius: 12px;">
                            #${idx + 1} Best Match
                        </span>
                        <span style="background: ${cand.badge_color}18; color: ${cand.badge_color}; border: 1px solid ${cand.badge_color}40; font-size: 0.72rem; font-weight: 700; padding: 2px 8px; border-radius: 6px;">
                            <i class="fa-solid fa-tag"></i> ${escapeHtml(cand.badge_title)}
                        </span>
                        <h4 style="margin: 0; font-size: 0.96rem; font-weight: 800; color: #1e293b;">
                            ${escapeHtml(cand.part_no)}
                        </h4>
                        <span style="background: #e0f2fe; color: #0284c7; font-size: 0.72rem; font-weight: 700; padding: 2px 7px; border-radius: 4px;">
                            ${escapeHtml(cand.grade)} ${cand.thickness}mm Match
                        </span>
                    </div>

                    <button type="button" class="btn btn-sm btn-primary" onclick="addSuggestedPartToCutList('${escapeHtml(cand.part_no)}', ${cand.recommended_blanks})" style="font-size: 0.8rem; font-weight: 700; padding: 5px 14px; border-radius: 6px; background: linear-gradient(135deg, #0284c7 0%, #0369a1 100%); color: #fff; border: none; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 2px 4px rgba(2, 132, 199, 0.25);">
                        <i class="fa-solid fa-plus"></i> Add to Sheet (${cand.recommended_blanks} Blanks)
                    </button>
                </div>

                <!-- Two-Column Grid: Left: Blank Geometry & Yield / Right: MRP Demand & Inventory -->
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 10px;">
                    <!-- Left: 2D Yield Simulation -->
                    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                            <span style="font-size: 0.72rem; font-weight: 700; color: #475569; text-transform: uppercase;">
                                <i class="fa-solid fa-vector-square" style="color: #0284c7;"></i> Blank Geometry
                            </span>
                            <span style="font-size: 0.75rem; font-weight: 700; color: #1e293b;">
                                ${escapeHtml(cand.blank_size_str)} mm
                            </span>
                        </div>

                        <!-- Yield Comparison Meter -->
                        <div style="margin-top: 8px;">
                            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.74rem; font-weight: 700; margin-bottom: 3px;">
                                <span style="color: #64748b;">Single Yield: ${cand.baseline_yield.toFixed(1)}%</span>
                                <span style="color: ${boostColor};">Combo Yield: ${cand.combined_yield.toFixed(1)}% (${boostSign})</span>
                            </div>
                            <div style="height: 10px; background: #e2e8f0; border-radius: 5px; overflow: hidden; display: flex;">
                                <div style="width: ${Math.min(100, cand.baseline_yield)}%; background: #94a3b8;" title="Baseline Single-Part Yield"></div>
                                <div style="width: ${Math.max(0, cand.combined_yield - cand.baseline_yield)}%; background: #10b981;" title="Yield Boost"></div>
                            </div>
                        </div>
                    </div>

                    <!-- Right: MRP Demand & Stock -->
                    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                            <span style="font-size: 0.72rem; font-weight: 700; color: #475569; text-transform: uppercase;">
                                <i class="fa-solid fa-boxes-stacked" style="color: #7c3aed;"></i> MRP Inventory Status
                            </span>
                            <span style="font-size: 0.7rem; font-weight: 700; background: ${stockBadgeBg}; color: ${stockBadgeColor}; padding: 1px 6px; border-radius: 4px;">
                                ${escapeHtml(cand.stock_label)}
                            </span>
                        </div>
                        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; text-align: center; margin-top: 6px;">
                            <div style="background: #fff; padding: 4px; border-radius: 4px; border: 1px solid #e2e8f0;">
                                <span style="font-size: 0.65rem; color: #64748b; display: block;">Monthly Demand</span>
                                <strong style="font-size: 0.8rem; color: #4338ca;">${cand.mrp_monthly_target.toLocaleString()}</strong>
                            </div>
                            <div style="background: #fff; padding: 4px; border-radius: 4px; border: 1px solid #e2e8f0;">
                                <span style="font-size: 0.65rem; color: #64748b; display: block;">Current Stock</span>
                                <strong style="font-size: 0.8rem; color: #047857;">${cand.current_stock.toLocaleString()}</strong>
                            </div>
                            <div style="background: #fff; padding: 4px; border-radius: 4px; border: 1px solid #e2e8f0;">
                                <span style="font-size: 0.65rem; color: #64748b; display: block;">To Produce</span>
                                <strong style="font-size: 0.8rem; color: #b45309;">${cand.qty_to_produce.toLocaleString()}</strong>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- AI Engineering Justification Note -->
                <div style="background: #fbfbfe; border-left: 3px solid #7c3aed; padding: 6px 10px; border-radius: 0 4px 4px 0; font-size: 0.76rem; color: #4b5563; line-height: 1.4;">
                    <i class="fa-solid fa-sparkles" style="color: #8b5cf6; margin-right: 4px;"></i>
                    <strong>AI Rationale:</strong> ${escapeHtml(cand.ai_rationale)}
                </div>
            </div>
        `;
    }).join("");
}

async function addSuggestedPartToCutList(partNo, blanksQty = 1) {
    if (!partNo) return;

    // 1. Add a new row to modalAdditionalPartsList
    addModalAdditionalPartRow();

    // 2. Locate the row index of the newly added card
    const rows = document.querySelectorAll("#modalAdditionalPartsList .modal-add-part-row");
    const lastRow = rows[rows.length - 1];
    if (!lastRow) return;
    const rowIdx = parseInt(lastRow.id.replace("modalAddPartRow_", ""));

    // 3. Populate part details via selectAdditionalPartForModal
    await selectAdditionalPartForModal(rowIdx, partNo);

    // 4. Set the recommended blanks qty
    const qtyInput = document.getElementById(`addPartQty_${rowIdx}`);
    if (qtyInput && blanksQty) {
        qtyInput.value = blanksQty;
    }

    // 5. Trigger recalculation and OptiCutter update
    onAddPartQtyChanged();

    // 6. Close the modal if open
    closeAiPartSuggestionsModal();

    // 7. Visual highlight on the added row
    lastRow.scrollIntoView({ behavior: "smooth", block: "nearest" });
    lastRow.style.transition = "background-color 0.4s ease, border-color 0.4s ease";
    lastRow.style.backgroundColor = "#eff6ff";
    lastRow.style.borderColor = "#0284c7";
    setTimeout(() => {
        lastRow.style.backgroundColor = "";
        lastRow.style.borderColor = "";
    }, 1800);

    // Refresh inline AI suggestions excluding this newly added part
    fetchAiPartSuggestions(activeAiFilterMode || "all");
}

window.fetchAiPartSuggestions = fetchAiPartSuggestions;
window.openAiPartSuggestionsModal = openAiPartSuggestionsModal;
window.closeAiPartSuggestionsModal = closeAiPartSuggestionsModal;
window.setAiAdvisorFilterMode = setAiAdvisorFilterMode;
window.addSuggestedPartToCutList = addSuggestedPartToCutList;

/**
 * Opens 2D Cut Optimizer for Normal MO Modal (Standard or Custom RM)
 */
async function openCutOptimizerForModal() {
    cutOptCallingContext = "moModal";

    const sheetSizeStr = document.getElementById("sheetSizeInput")?.value || "";
    const thickVal = parseFloat(document.getElementById("thicknessInput")?.value) || 0;

    // Determine Sheet Dimensions from selected RM Sheet (Standard, Agent Recommended, or Custom RM)
    let sLen = 0;
    let sWid = 0;
    const rmSelect = document.getElementById("rmErpSelect");
    const selOpt = rmSelect?.selectedOptions[0];
    let rmRec = selOpt?.dataset?.record ? JSON.parse(selOpt.dataset.record) : null;
    if (window._selectedRmAgentRecord && (!rmRec || rmRec.rm_erp === window._selectedRmAgentRecord.rm_erp)) {
        rmRec = { ...(rmRec || {}), ...window._selectedRmAgentRecord };
    }
    if (!rmRec && window._selectedCustomRmRecord) {
        rmRec = window._selectedCustomRmRecord;
    }
    if (rmRec) {
        sLen = parseFloat(rmRec.sheet_length || rmRec.length || 0);
        sWid = parseFloat(rmRec.sheet_width || rmRec.width || 0);
        if ((!sLen || !sWid) && rmRec.sheet_size) {
            const sd = parseDimString(rmRec.sheet_size, thickVal);
            if (sd.l > 0 && sd.w > 0) { sLen = sd.l; sWid = sd.w; }
        }
        if ((!sLen || !sWid) && (rmRec.rm_erp || rmRec.item_code)) {
            const sd = parseDimString(rmRec.rm_erp || rmRec.item_code, thickVal);
            if (sd.l > 0 && sd.w > 0) { sLen = sd.l; sWid = sd.w; }
        }
    }
    if ((!sLen || !sWid) && selOpt && selOpt.value) {
        const sd = parseDimString(selOpt.value, thickVal);
        if (sd.l > 0 && sd.w > 0) { sLen = sd.l; sWid = sd.w; }
    }
    if (!sLen || !sWid) {
        sLen = 2500;
        sWid = 1250;
    }

    // Determine Base Part Blank dimensions (from sheetSizeInput or layoutRec)
    let bLen = 0;
    let bWid = 0;
    const partNo = document.getElementById("partNoInput")?.value?.trim() || "Part";
    const layoutRec = typeof getSelectedLayoutRecord === "function" ? getSelectedLayoutRecord() : null;

    if (sheetSizeStr) {
        const d = parseDimString(sheetSizeStr, thickVal);
        if (d.l > 0 && d.w > 0) {
            bLen = d.l;
            bWid = d.w;
        }
    }

    if ((!bLen || !bWid) && layoutRec) {
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

    // 1. Check for parts added in the modal's Add Part section (modalAdditionalPartsList)
    const modalAddRows = document.querySelectorAll("#modalAdditionalPartsList .modal-add-part-row");
    const modalAddPartsList = [];
    if (modalAddRows && modalAddRows.length > 0) {
        modalAddRows.forEach((r, idx) => {
            const pNo = r.querySelector(".add-part-no")?.value?.trim();
            let pL = parseFloat(r.querySelector(".add-part-len")?.value) || 0;
            let pW = parseFloat(r.querySelector(".add-part-wid")?.value) || 0;
            const pThick = parseFloat(r.querySelector(".add-part-thick")?.value) || thickVal || 0;
            const sizeVal = r.querySelector(".add-part-size")?.value?.trim() || "";
            if ((!pL || !pW) && sizeVal) {
                const d = parseDimString(sizeVal, pThick);
                if (d.l > 0 && d.w > 0) { pL = d.l; pW = d.w; }
            }
            const pQty = Math.max(1, parseInt(r.querySelector(".add-part-qty")?.value) || 1);
            if (pNo && pL > 0 && pW > 0) {
                modalAddPartsList.push({
                    row_id: idx + 2,
                    part_no: pNo,
                    length: Math.max(pL, pW),
                    width: Math.min(pL, pW),
                    qty: pQty
                });
            }
        });
    }

    // Check for multiple parts in non-standard layout container or modal additional parts
    const nonStdRows = document.querySelectorAll("#nonStdPartsContainer .eb-part-card-row");
    const nonStdPartsList = [];
    if (modalAddPartsList.length > 0) {
        const optSheetsCount = Math.max(1, parseFloat(document.getElementById("sheetsRequired")?.value) || 1);
        let baseQty = window._basePartPlacedBlanks;
        if (!baseQty && layoutRec?.part1?.blank_qty) {
            baseQty = Math.round((parseFloat(layoutRec.part1.blank_qty) || 1) * optSheetsCount);
        }
        if (!baseQty) {
            baseQty = Math.max(1, parseInt(document.getElementById("targetQtyManual")?.value || document.getElementById("targetQty")?.value || 1, 10));
        }
        nonStdPartsList.push({
            row_id: 1,
            part_no: partNo || "Base Part",
            length: Math.max(bLen, bWid),
            width: Math.min(bLen, bWid),
            qty: baseQty,
            is_base: true
        }, ...modalAddPartsList);
    } else if (nonStdRows && nonStdRows.length > 0) {
        nonStdRows.forEach((r, idx) => {
            const rowId = r.dataset.rowId || (idx + 1);
            let pNo = r.querySelector(".nonstd-part-no")?.value?.trim() || "";
            let pL = parseFloat(r.querySelector(".nonstd-cut-len")?.value) || 0;
            let pW = parseFloat(r.querySelector(".nonstd-cut-wid")?.value) || 0;
            const rThick = parseFloat(r.querySelector(".nonstd-thickness")?.value) || thickVal || 0;

            const sizeVal = r.querySelector(".nonstd-part-size")?.value?.trim() || "";
            if ((!pL || !pW) && sizeVal) {
                const d = parseDimString(sizeVal, rThick);
                if (d.l > 0 && d.w > 0) {
                    pL = d.l;
                    pW = d.w;
                }
            }
            // Fallback for Row 1 if empty: use primary part dimensions bLen, bWid!
            if ((!pL || !pW) && idx === 0 && bLen > 0 && bWid > 0) {
                pL = bLen;
                pW = bWid;
                if (!pNo) pNo = partNo;
            }

            const qty = Math.max(1, parseInt(r.querySelector(".nonstd-part-qty")?.value) || 1);
            if (pL > 0 && pW > 0) {
                nonStdPartsList.push({
                    row_id: rowId,
                    part_no: pNo || (idx === 0 ? partNo : `Part-${idx + 1}`),
                    length: Math.max(pL, pW),
                    width: Math.min(pL, pW),
                    qty: qty
                });
            }
        });
    }

    // CRITICAL: Ensure the Base Part from the modal is combined with the added parts!
    if (nonStdPartsList.length > 0 && bLen > 0 && bWid > 0 && partNo && partNo !== "Part") {
        const cleanBase = (partNo || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        const basePartAlreadyIncluded = nonStdPartsList.some(p => {
            const cleanP = (p.part_no || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
            return cleanP && cleanBase && (cleanP.includes(cleanBase) || cleanBase.includes(cleanP));
        });
        if (!basePartAlreadyIncluded) {
            const baseQty = Math.max(1, parseInt(document.getElementById("targetQtyManual")?.value || document.getElementById("targetQty")?.value || 1, 10));
            nonStdPartsList.unshift({
                row_id: 0,
                part_no: partNo,
                length: Math.max(bLen, bWid),
                width: Math.min(bLen, bWid),
                qty: baseQty
            });
        }
    }

    // Support multi-part layouts from standard layout record as well (preserved strictly for PEPIPL standard layout from layout_records)
    const activeOptComp = (window.AUTH_BRANCH_CODE || window.AUTH_COMPANY_ID || document.getElementById("modalUnitSelect")?.value || "PEPIPL").toUpperCase();
    const isPepiplOpt = (activeOptComp === "PEPIPL" || activeOptComp === "ALL");
    const isStd = document.querySelector('input[name="is_standard_layout"]:checked')?.value === "true";
    if (isPepiplOpt && isStd && nonStdPartsList.length <= 1 && layoutRec) {
        const lrParts = [];
        [layoutRec.part1, layoutRec.part2, layoutRec.part3, layoutRec.part4].forEach((child, cIdx) => {
            if (child && child.part_no) {
                let cL = 0, cW = 0;
                if (child.blank_size?.length && child.blank_size?.width) {
                    cL = parseFloat(child.blank_size.length);
                    cW = parseFloat(child.blank_size.width);
                } else if (child.cut_blank) {
                    const d = parseDimString(child.cut_blank, thickVal);
                    cL = d.l; cW = d.w;
                }
                const bq = parseFloat(child.blank_qty) || 1;
                const sq = parseFloat(child.strip_qty) || 1;
                const cQty = Math.max(1, Math.round(bq * sq));
                if (cL > 0 && cW > 0) {
                    lrParts.push({
                        row_id: cIdx + 1,
                        part_no: child.part_no,
                        length: Math.max(cL, cW),
                        width: Math.min(cL, cW),
                        qty: cQty
                    });
                }
            }
        });
        if (lrParts.length > 1) {
            nonStdPartsList.length = 0;
            nonStdPartsList.push(...lrParts);
        }
    }

    if (nonStdPartsList.length > 0) {
        currentCutOptPartsList = nonStdPartsList;
    } else {
        currentCutOptPartsList = [];
    }

    const multiSec = document.getElementById("optMultiPartsSection");
    const multiCountEl = document.getElementById("optMultiPartsCount");

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
    if (kfEl) kfEl.value = 0;

    if (currentCutOptPartsList.length > 1) {
        // Multi-Part Batch Mode
        if (multiSec) multiSec.style.display = "block";
        if (multiCountEl) multiCountEl.textContent = currentCutOptPartsList.length;
        renderOptMultiPartBadges(currentCutOptPartsList);

        if (plEl) plEl.value = `${currentCutOptPartsList.length} Parts Batch`;
        if (blEl) {
            blEl.value = currentCutOptPartsList[0].length;
            blEl.disabled = true;
        }
        if (bwEl) {
            bwEl.value = currentCutOptPartsList[0].width;
            bwEl.disabled = true;
        }
    } else {
        if (multiSec) multiSec.style.display = "none";
        if (blEl) {
            blEl.value = Math.max(bLen, bWid);
            blEl.disabled = false;
        }
        if (bwEl) {
            bwEl.value = Math.min(bLen, bWid);
            bwEl.disabled = false;
        }
        if (plEl) plEl.value = partNo;
    }

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
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sLen} ${svgHeightView}" style="width: 100%; height: 100%; max-height: 380px; display: block;" preserveAspectRatio="xMidYMid meet">
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
 * directly into the active Material Order form, and automatically generates
 * and attaches the visual layout drawing to attachments for both MO and End Bit MO.
 */
async function applyCutOptimizerResults() {
    if (!currentCutOptResult) {
        alert("Please run the 2D Cut Optimization first.");
        return;
    }

    const yieldVal = currentCutOptResult.yield_pct;
    const totalBlanks = currentCutOptResult.total_blanks || 0;

    if (cutOptCallingContext === "endbitMo") {
        // ---------------------------------------------------------------------
        // 1. END BIT MO CONTEXT
        // ---------------------------------------------------------------------
        const endbitsUsedInput = document.getElementById("ebEndbitsUsed");
        const endbitsCount = Math.max(1, parseInt(endbitsUsedInput?.value) || 1);

        const totalYieldDisplay = document.getElementById("ebTotalYieldDisplay");
        const yieldHidden = document.getElementById("ebYieldInput");
        if (yieldHidden) yieldHidden.value = `${yieldVal}%`;
        if (totalYieldDisplay) totalYieldDisplay.innerHTML = `<span style="color: #059669; font-weight: 700;">${yieldVal}%</span>`;

        const rows = document.querySelectorAll(".eb-part-card-row");

        if (currentCutOptResult.is_multi_part && currentCutOptResult.parts_summary && currentCutOptResult.parts_summary.length > 0) {
            // Multi-part nesting
            currentCutOptResult.parts_summary.forEach((ps, idx) => {
                let targetRow = null;
                if (ps.row_id) {
                    targetRow = document.getElementById(`ebPartRow_${ps.row_id}`);
                }
                if (!targetRow && rows[idx]) {
                    targetRow = rows[idx];
                }
                if (targetRow) {
                    targetRow.dataset.opticutterBlanks = ps.placed_qty;
                    const qInput = targetRow.querySelector(".eb-part-qty");
                    if (qInput) qInput.value = ps.placed_qty * endbitsCount;
                    const yInput = targetRow.querySelector(".eb-part-yield");
                    const sLen = parseFloat(document.getElementById("optSheetLength")?.value) || 1;
                    const sWid = parseFloat(document.getElementById("optSheetWidth")?.value) || 1;
                    const partYield = Math.min(100, Math.round(((ps.placed_qty * ps.length * ps.width) / (sLen * sWid)) * 1000) / 10);
                    if (yInput) {
                        yInput.value = `${partYield}%`;
                        yInput.style.color = "#059669";
                    }
                    const rowId = targetRow.dataset.rowId;
                    if (rowId) checkRowEbCapacity(rowId, false);
                }
            });
        } else if (rows.length > 0 && totalBlanks > 0) {
            // Single-part nesting
            const firstRow = rows[0];
            firstRow.dataset.opticutterBlanks = totalBlanks;
            const qInput = firstRow.querySelector(".eb-part-qty");
            if (qInput) qInput.value = totalBlanks * endbitsCount;
            const yInput = firstRow.querySelector(".eb-part-yield");
            if (yInput) {
                yInput.value = `${yieldVal}%`;
                yInput.style.color = "#059669";
            }
            const rowId = firstRow.dataset.rowId;
            if (rowId) checkRowEbCapacity(rowId, false);
        }

        if (typeof recalculateAllEbTotals === "function") {
            recalculateAllEbTotals();
        }

        // Generate and auto-attach OptiCutter layout image to End Bit MO attachment
        const fname = customOptiCutterUploadedFile?.name || `OptiCutter_Endbit_Layout_${Date.now()}.png`;
        const ebFile = await generateOptiCutterLayoutFile(fname);
        if (ebFile) {
            activeEbOptiCutterLayoutFile = ebFile;
            const ebFileInput = document.getElementById("ebLayoutDocFile");
            if (ebFileInput) {
                try {
                    const dt = new DataTransfer();
                    dt.items.add(ebFile);
                    ebFileInput.files = dt.files;
                } catch (e) {
                    console.log("DataTransfer not supported:", e);
                }
            }
            const ebChosenName = document.getElementById("ebFileChosenName");
            if (ebChosenName) {
                ebChosenName.innerHTML = `<i class="fa-solid fa-circle-check" style="color: #059669;"></i> <strong>Attached from OptiCutter:</strong> ${escapeHtml(ebFile.name)} <span style="color: #64748b; font-size: 0.75rem;">(${(ebFile.size / 1024).toFixed(1)} KB)</span>`;
                ebChosenName.style.color = "#047857";
            }
            const ebDropzone = document.getElementById("ebDocDropzone");
            if (ebDropzone) {
                ebDropzone.style.background = "#f0fdf4";
                ebDropzone.style.borderColor = "#10b981";
            }
            const ebStatusBadge = document.getElementById("ebDocStatusBadge");
            if (ebStatusBadge) {
                ebStatusBadge.innerHTML = `<span style="color: #059669; font-weight: 700;"><i class="fa-solid fa-circle-check"></i> 2D Layout Drawing Attached</span>`;
            }
        }

        // Re-calculate all totals after file is attached
        if (typeof recalculateAllEbTotals === "function") {
            recalculateAllEbTotals();
        }

        closeCutOptimizerModal();
        alert(`✅ Applied 2D Cut Optimization (${yieldVal}% Yield, ${totalBlanks * endbitsCount} Parts) & attached OptiCutter layout drawing to End Bit MO!`);
    } else {
        // ---------------------------------------------------------------------
        // 2. NORMAL CREATE MO CONTEXT (moModal)
        // ---------------------------------------------------------------------
        const yieldInput = document.getElementById("yieldPctInput");
        if (yieldInput) {
            yieldInput.value = `${yieldVal}%`;
        }
        const nonStdYieldEl = document.getElementById("nonStdTotalYieldDisplay");
        if (nonStdYieldEl) {
            nonStdYieldEl.textContent = `${yieldVal}%`;
        }

        // Automatically mark layout as Non-Standard (custom OptiCutter 2D nesting)
        const nonStdRadio = document.querySelector('input[name="is_standard_layout"][value="false"]');
        if (nonStdRadio) nonStdRadio.checked = true;
        updateLayoutTypeUI(false);

        // Multi-part nesting synchronization from OptiCutter results
        if (currentCutOptResult.parts_summary && currentCutOptResult.parts_summary.length > 0) {
            const modalAddRows = document.querySelectorAll("#modalAdditionalPartsList .modal-add-part-row");
            const basePartNo = document.getElementById("partNoInput")?.value?.trim();

            currentCutOptResult.parts_summary.forEach((ps, idx) => {
                if (ps.is_base || (basePartNo && ps.part_no && ps.part_no === basePartNo) || idx === 0) {
                    window._basePartPlacedBlanks = ps.placed_qty;
                }
                if (modalAddRows && modalAddRows.length > 0) {
                    modalAddRows.forEach((row, rIdx) => {
                        const rowPartNo = row.querySelector(".add-part-no")?.value?.trim();
                        if (rowPartNo && ps.part_no && (rowPartNo === ps.part_no || (ps.row_id && ps.row_id === (rIdx + 2)))) {
                            const qInput = row.querySelector(".add-part-qty");
                            if (qInput) qInput.value = ps.placed_qty;
                            row.dataset.placedBlanks = ps.placed_qty;
                        }
                    });
                }
            });
        } else if (totalBlanks > 0) {
            window._basePartPlacedBlanks = totalBlanks;
        }

        // Recalculate and render full multi-part counts breakdown in UI
        recalculateTargetQtyFromLayout();

        // Auto-populate generated remnants into End Bits Offcuts if any exist
        if (currentCutOptResult.remnants && currentCutOptResult.remnants.length > 0) {
            const ebBanner = document.getElementById("layoutEndbitsBanner");
            const ebList = document.getElementById("layoutEndbitsList");
            const hiddenJson = document.getElementById("moEndbitsJson");
            const sheetsInput = document.getElementById("sheetsRequired");
            const sheetsNeeded = Math.max(1, parseFloat(sheetsInput?.value) || 1);
            const thickness = parseFloat(document.getElementById("thicknessInput")?.value) || 2.0;

            const optGrade = document.getElementById("gradeInput")?.value || "YS";
            const optEndbits = currentCutOptResult.remnants.map((r, i) => {
                const ebName = formatEndbitName({
                    grade: optGrade,
                    thickness: thickness,
                    length: r.length,
                    width: r.width
                }, optGrade);
                return {
                    name: ebName,
                    dim: `${thickness}*${r.length}*${r.width}`,
                    thickness: thickness,
                    length: r.length,
                    width: r.width,
                    qty_per_sheet: 1,
                    total_qty: sheetsNeeded,
                    grade: optGrade
                };
            });

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

        // Generate and auto-attach OptiCutter layout image into Material Order
        const fname = customOptiCutterUploadedFile?.name || `OptiCutter_Layout_Plan_${Date.now()}.png`;
        const moFile = await generateOptiCutterLayoutFile(fname);
        if (moFile) {
            activeOptiCutterLayoutFile = moFile;
            const moFileInput = document.getElementById("layoutDocFile");
            if (moFileInput) {
                try {
                    const dt = new DataTransfer();
                    dt.items.add(moFile);
                    moFileInput.files = dt.files;
                } catch (e) {
                    console.log("DataTransfer not supported:", e);
                }
            }
            const fileChosenName = document.getElementById("fileChosenName");
            if (fileChosenName) {
                fileChosenName.innerHTML = `<i class="fa-solid fa-circle-check" style="color: #059669;"></i> <strong>Attached from OptiCutter:</strong> ${escapeHtml(moFile.name)} <span style="color: #64748b; font-size: 0.75rem;">(${(moFile.size / 1024).toFixed(1)} KB)</span>`;
                fileChosenName.style.color = "#047857";
            }
            const docDropzone = document.getElementById("docDropzone");
            if (docDropzone) {
                docDropzone.style.background = "#f0fdf4";
                docDropzone.style.borderColor = "#10b981";
            }

            // Thumbnail preview update in layout parts banner
            const thumbWrap = document.getElementById("layoutThumbWrap");
            const thumbImg = document.getElementById("layoutThumbImg");
            if (thumbWrap && thumbImg) {
                try {
                    thumbImg.src = URL.createObjectURL(moFile);
                    thumbWrap.style.display = "flex";
                } catch (e) {}
            }
        }

        // Re-evaluate constraints and workflow route with updated yield & non-standard status
        if (typeof updateAutomatedConstraints === "function") {
            updateAutomatedConstraints();
        }
        if (typeof recalculateWorkflowRoute === "function") {
            recalculateWorkflowRoute();
        }

        closeCutOptimizerModal();
        alert(`✅ Applied 2D Cut Optimization (${yieldVal}% Yield) & attached OptiCutter layout drawing to Material Order!`);
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
window.onOptCustomDrawingSelected = onOptCustomDrawingSelected;
window.onEbFileSelected = onEbFileSelected;

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
            fetchNotifications(true);
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

// =========================================================================
// Real-time Notification Engine & In-App Activity Center Logic
// =========================================================================

let lastKnownNotifIds = new Set();
let notifsInitialFetchDone = false;
let notificationsPollInterval = null;

function formatNotifTime(isoString) {
    if (!isoString) return "";
    try {
        const d = new Date(isoString);
        const now = new Date();
        const diffSec = Math.floor((now - d) / 1000);
        if (diffSec < 45) return "Just now";
        if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
        if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
        if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
        return d.toLocaleDateString([], { month: "short", day: "numeric" });
    } catch (e) {
        return "";
    }
}

let currentNotifTab = "unread";
let cachedNotifications = [];

function switchNotifTab(tab, e) {
    if (e) {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
    }
    currentNotifTab = tab || "unread";
    const unreadBtn = document.getElementById("notifTabBtnUnread");
    const allBtn = document.getElementById("notifTabBtnAll");
    if (unreadBtn) unreadBtn.classList.toggle("active", currentNotifTab === "unread");
    if (allBtn) allBtn.classList.toggle("active", currentNotifTab === "all");
    renderNotificationsList(cachedNotifications);
}

function toggleNotificationsDropdown(e) {
    if (e) {
        if (typeof e.stopPropagation === "function") e.stopPropagation();
    }
    const panel = document.getElementById("notifDropdownPanel");
    if (!panel) return;
    const isHidden = panel.style.display === "none" || !panel.style.display;
    panel.style.display = isHidden ? "flex" : "none";
    if (isHidden) {
        fetchNotifications(true);
    }
}

async function fetchNotifications(silent = false) {
    try {
        const res = await fetch(`/api/notifications?limit=50&_t=${Date.now()}`, {
            headers: {
                "X-Role": currentRole
            }
        });
        if (!res.ok) return;
        const data = await res.json();
        const notifs = data.notifications || [];
        const unreadCount = data.unread_count || 0;
        cachedNotifications = notifs;

        // Update bell badge
        const badge = document.getElementById("notifBadge");
        if (badge) {
            if (unreadCount > 0) {
                badge.textContent = unreadCount > 99 ? "99+" : unreadCount;
                badge.style.display = "inline-flex";
            } else {
                badge.style.display = "none";
            }
        }

        // Update dropdown header counter
        const unreadText = document.getElementById("notifUnreadCount");
        if (unreadText) {
            unreadText.textContent = `${unreadCount} Unread`;
        }

        // Update tab count badges
        const tabUnreadNum = document.getElementById("notifTabUnreadNum");
        if (tabUnreadNum) tabUnreadNum.textContent = unreadCount;
        const tabAllNum = document.getElementById("notifTabAllNum");
        if (tabAllNum) tabAllNum.textContent = notifs.length;

        // Render notifications in dropdown panel according to active tab
        renderNotificationsList(notifs);

        // Check for newly arrived unread notifications to trigger floating toast
        if (notifsInitialFetchDone) {
            let hasNewAction = false;
            // Iterate in reverse (oldest to newest) to display toasts chronologically
            const reversed = [...notifs].reverse();
            reversed.forEach(n => {
                if (!lastKnownNotifIds.has(n.id)) {
                    lastKnownNotifIds.add(n.id);
                    if (!n.is_read) {
                        showMoToast(n);
                        hasNewAction = true;
                    }
                }
            });
            // If new notifications arrived from other teams, refresh orders table and stats dynamically
            if (hasNewAction) {
                loadOrders();
                loadStats();
            }
        } else {
            // First page load: record initial IDs without firing popups
            notifs.forEach(n => lastKnownNotifIds.add(n.id));
            notifsInitialFetchDone = true;
        }

    } catch (err) {
        console.error("Failed to fetch notifications:", err);
    }
}

function renderNotificationsList(notifs) {
    const listEl = document.getElementById("notifPanelList");
    if (!listEl) return;

    const allItems = notifs || [];
    const itemsToRender = (currentNotifTab === "unread")
        ? allItems.filter(n => !n.is_read)
        : allItems;

    if (itemsToRender.length === 0) {
        if (currentNotifTab === "unread") {
            listEl.innerHTML = `
                <div class="notif-empty-state">
                    <i class="fa-solid fa-circle-check" style="color: #10b981; font-size: 2rem;"></i>
                    <strong style="color: #1e293b; font-size: 0.88rem;">All Caught Up!</strong>
                    <span style="font-size: 0.75rem; color: #64748b;">No unread notifications. Messages you click or open are marked done.</span>
                </div>
            `;
        } else {
            listEl.innerHTML = `
                <div class="notif-empty-state">
                    <i class="fa-regular fa-bell-slash"></i>
                    <span>No notifications in history</span>
                </div>
            `;
        }
        return;
    }

    listEl.innerHTML = itemsToRender.map(n => {
        const isUnread = !n.is_read;
        const priority = n.priority || "normal";
        const notifType = n.type || "";

        let iconClass = "fa-bell";
        let colClass = "info";
        let itemExtraClass = "";

        if (priority === "urgent" || notifType === "MO_REJECTED") {
            iconClass = "fa-triangle-exclamation";
            colClass = "urgent";
            itemExtraClass = isUnread ? "urgent" : "";
        } else if (priority === "success" || notifType === "MO_APPROVED") {
            iconClass = "fa-circle-check";
            colClass = "success";
            itemExtraClass = isUnread ? "success" : "";
        } else if (notifType === "MO_CREATED" || notifType === "MO_ROUTED" || notifType === "MO_RESUBMITTED") {
            iconClass = "fa-file-invoice";
            colClass = "info";
        }

        const timeStr = formatNotifTime(n.created_at);
        const unreadClass = isUnread ? "unread" : "read";
        const moNum = n.mo_number || "";

        return `
            <div class="notif-item ${unreadClass} ${itemExtraClass}" onclick="onNotificationClick('${escapeHtml(n.id)}', '${escapeHtml(moNum)}')">
                <div class="notif-icon-col ${colClass}">
                    <i class="fa-solid ${iconClass}"></i>
                </div>
                <div class="notif-content-col">
                    <div class="notif-title-row">
                        <span class="notif-item-title">${escapeHtml(n.title)}</span>
                        <div style="display: flex; align-items: center; gap: 4px;">
                            <span class="notif-item-time">${timeStr}</span>
                            <button type="button" class="notif-dismiss-btn" onclick="dismissNotification('${escapeHtml(n.id)}', event)" title="Dismiss message">
                                <i class="fa-solid fa-xmark"></i>
                            </button>
                        </div>
                    </div>
                    <p class="notif-item-msg">${escapeHtml(n.message)}</p>
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 4px;">
                        ${moNum ? `<span class="notif-item-chip"><i class="fa-solid fa-hashtag" style="font-size:0.6rem;"></i> ${escapeHtml(moNum)}</span>` : "<span></span>"}
                        ${!isUnread ? `<span class="notif-done-pill"><i class="fa-solid fa-check"></i> Done</span>` : ""}
                    </div>
                </div>
            </div>
        `;
    }).join("");
}

function showMoToast(notif) {
    const container = document.getElementById("moToastContainer");
    if (!container) return;

    const toast = document.createElement("div");
    const priority = notif.priority || "normal";
    const notifType = notif.type || "";
    let toastType = "info";
    let iconClass = "fa-bell";

    if (priority === "urgent" || notifType === "MO_REJECTED") {
        toastType = "urgent";
        iconClass = "fa-triangle-exclamation";
    } else if (priority === "success" || notifType === "MO_APPROVED") {
        toastType = "success";
        iconClass = "fa-circle-check";
    } else {
        toastType = "info";
        iconClass = "fa-file-invoice";
    }

    toast.className = `mo-toast-card ${toastType}`;
    toast.title = "Click to inspect Material Order";
    toast.innerHTML = `
        <div class="notif-icon-col ${toastType}" style="width:28px; height:28px; font-size:0.85rem;">
            <i class="fa-solid ${iconClass}"></i>
        </div>
        <div style="flex:1; min-width:0;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:6px;">
                <strong style="font-size:0.82rem; color:#1e293b;">${escapeHtml(notif.title)}</strong>
                <span style="font-size:0.68rem; color:#94a3b8;">Just now</span>
            </div>
            <div style="font-size:0.75rem; color:#475569; margin-top:2px; line-height:1.3;">${escapeHtml(notif.message)}</div>
            ${notif.mo_number ? `<span class="notif-item-chip" style="margin-top:4px;"><i class="fa-solid fa-arrow-up-right-from-square" style="font-size:0.6rem;"></i> Open ${escapeHtml(notif.mo_number)}</span>` : ""}
        </div>
    `;

    toast.onclick = () => {
        onNotificationClick(notif.id, notif.mo_number);
        toast.remove();
    };

    container.appendChild(toast);

    // Auto remove toast after 6.5s
    setTimeout(() => {
        if (toast.parentNode) {
            toast.style.transition = "opacity 0.3s ease, transform 0.3s ease";
            toast.style.opacity = "0";
            toast.style.transform = "translateX(50px)";
            setTimeout(() => toast.remove(), 300);
        }
    }, 6500);
}

async function onNotificationClick(notifId, moNumber) {
    // Hide dropdown panel
    const panel = document.getElementById("notifDropdownPanel");
    if (panel) panel.style.display = "none";

    // Optimistically mark this notification as read in cache
    const targetItem = cachedNotifications.find(n => String(n.id) === String(notifId));
    if (targetItem) {
        targetItem.is_read = true;
    }
    const unreadCount = cachedNotifications.filter(n => !n.is_read).length;
    const badge = document.getElementById("notifBadge");
    if (badge) {
        if (unreadCount > 0) {
            badge.textContent = unreadCount > 99 ? "99+" : unreadCount;
            badge.style.display = "inline-flex";
        } else {
            badge.style.display = "none";
        }
    }
    const unreadText = document.getElementById("notifUnreadCount");
    if (unreadText) unreadText.textContent = `${unreadCount} Unread`;
    const tabUnreadNum = document.getElementById("notifTabUnreadNum");
    if (tabUnreadNum) tabUnreadNum.textContent = unreadCount;
    renderNotificationsList(cachedNotifications);

    // Mark as read in backend
    try {
        await fetch("/api/notifications/mark-read", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Role": currentRole
            },
            body: JSON.stringify({ notif_id: notifId, role: currentRole })
        });
    } catch (e) {
        console.error("Error marking notification as read:", e);
    }

    // Refresh notification badge and count
    fetchNotifications(true);

    // Open target MO modal for review / clearance
    if (moNumber) {
        openReviewModal(moNumber);
    }
}

async function dismissNotification(notifId, e) {
    if (e) {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
    }

    // Optimistically remove from cached notifications
    cachedNotifications = cachedNotifications.filter(n => String(n.id) !== String(notifId));
    const unreadCount = cachedNotifications.filter(n => !n.is_read).length;
    const badge = document.getElementById("notifBadge");
    if (badge) {
        if (unreadCount > 0) {
            badge.textContent = unreadCount > 99 ? "99+" : unreadCount;
            badge.style.display = "inline-flex";
        } else {
            badge.style.display = "none";
        }
    }
    const unreadText = document.getElementById("notifUnreadCount");
    if (unreadText) unreadText.textContent = `${unreadCount} Unread`;
    const tabUnreadNum = document.getElementById("notifTabUnreadNum");
    if (tabUnreadNum) tabUnreadNum.textContent = unreadCount;
    const tabAllNum = document.getElementById("notifTabAllNum");
    if (tabAllNum) tabAllNum.textContent = cachedNotifications.length;
    renderNotificationsList(cachedNotifications);

    try {
        await fetch("/api/notifications/dismiss", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Role": currentRole
            },
            body: JSON.stringify({ notif_id: notifId, role: currentRole })
        });
        await fetchNotifications(true);
    } catch (err) {
        console.error("Failed to dismiss notification:", err);
    }
}

async function markAllNotificationsAsRead(e) {
    if (e) {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
    }

    // Immediate optimistic UI response: mark all items read
    cachedNotifications.forEach(n => {
        n.is_read = true;
    });

    const badge = document.getElementById("notifBadge");
    if (badge) {
        badge.textContent = "0";
        badge.style.display = "none";
    }
    const unreadCountEl = document.getElementById("notifUnreadCount");
    if (unreadCountEl) {
        unreadCountEl.textContent = "0 Unread";
    }
    const tabUnreadNum = document.getElementById("notifTabUnreadNum");
    if (tabUnreadNum) tabUnreadNum.textContent = 0;

    // Immediately re-render (which will show 'All Caught Up!' if in unread tab)
    renderNotificationsList(cachedNotifications);

    try {
        await fetch("/api/notifications/mark-read", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Role": currentRole
            },
            body: JSON.stringify({ notif_id: null, role: currentRole })
        });
        await fetchNotifications(true);
    } catch (err) {
        console.error("Failed to mark all notifications as read:", err);
    }
}

async function clearAllNotifications(e) {
    if (e) {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
    }

    // Optimistically clear all notifications from dropdown
    cachedNotifications = [];
    const badge = document.getElementById("notifBadge");
    if (badge) {
        badge.textContent = "0";
        badge.style.display = "none";
    }
    const unreadCountEl = document.getElementById("notifUnreadCount");
    if (unreadCountEl) {
        unreadCountEl.textContent = "0 Unread";
    }
    const tabUnreadNum = document.getElementById("notifTabUnreadNum");
    if (tabUnreadNum) tabUnreadNum.textContent = 0;
    const tabAllNum = document.getElementById("notifTabAllNum");
    if (tabAllNum) tabAllNum.textContent = 0;

    renderNotificationsList(cachedNotifications);

    try {
        await fetch("/api/notifications/clear", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Role": currentRole
            },
            body: JSON.stringify({ role: currentRole })
        });
        await fetchNotifications(true);
    } catch (err) {
        console.error("Failed to clear all notifications:", err);
    }
}

function startNotificationsPolling() {
    if (notificationsPollInterval) clearInterval(notificationsPollInterval);
    fetchNotifications();
    notificationsPollInterval = setInterval(() => {
        fetchNotifications(true);
    }, 8000);
}

// Window bindings for notification center
window.toggleNotificationsDropdown = toggleNotificationsDropdown;
window.switchNotifTab = switchNotifTab;
window.markAllNotificationsAsRead = markAllNotificationsAsRead;
window.clearAllNotifications = clearAllNotifications;
window.dismissNotification = dismissNotification;
window.onNotificationClick = onNotificationClick;
window.fetchNotifications = fetchNotifications;
window.startNotificationsPolling = startNotificationsPolling;






// =========================================================================
// NON-STANDARD MULTI-PART MANUFACTURING & MANUAL ADDING LOGIC
// (Matches End Bit MO Creation Workflow: Part #, Size, Qty, Yield, Agent Capacity)
// =========================================================================

let nonStdPartRowCounter = 0;
let nonStdSearchDebounceTimer = null;

function addNonStdPartRow(defaultPart = null) {
    nonStdPartRowCounter++;
    const rowId = nonStdPartRowCounter;
    const container = document.getElementById("nonStdPartsContainer");
    if (!container) return;

    const row = document.createElement("div");
    row.className = "eb-part-card-row has-blank-per-strip";
    row.id = `nonStdPartRow_${rowId}`;
    row.dataset.rowId = rowId;

    row.innerHTML = `
        <div class="form-group relative">
            <label>Part Number <span class="required">*</span></label>
            <div class="part-search-input-wrap">
                <i class="fa-solid fa-shapes"></i>
                <input type="text" class="nonstd-part-no" id="nonStdPartNo_${rowId}" placeholder="Search or type part #..." autocomplete="off" required oninput="onNonStdPartRowSearch(this, ${rowId})">
                <div class="part-dropdown-results eb-row-dropdown" id="nonStdDropdown_${rowId}" style="display: none;"></div>
            </div>
            <input type="hidden" class="nonstd-base-part" id="nonStdBasePart_${rowId}" value="">
        </div>
        <div class="form-group">
            <label>Part Size (T*L*W) <span class="required">*</span></label>
            <input type="text" class="nonstd-part-size" id="nonStdPartSize_${rowId}" placeholder="e.g. 2*300*150" required oninput="onNonStdPartRowSizeInput(this, ${rowId})">
            <input type="hidden" class="nonstd-cut-len" id="nonStdCutLen_${rowId}" value="">
            <input type="hidden" class="nonstd-cut-wid" id="nonStdCutWid_${rowId}" value="">
            <input type="hidden" class="nonstd-thickness" id="nonStdThick_${rowId}" value="">
        </div>
        <div class="form-group">
            <label>No. of Parts <span class="required">*</span></label>
            <input type="number" min="1" step="1" value="1" class="nonstd-part-qty" id="nonStdPartQty_${rowId}" required oninput="onNonStdQtyChange(${rowId})">
        </div>
        <div class="form-group">
            <label>Blank Per Strip <span class="required">*</span></label>
            <input type="number" min="1" step="1" value="1" class="nonstd-blank-per-strip" id="nonStdBlankPerStrip_${rowId}" placeholder="1" required oninput="onNonStdQtyChange(${rowId})">
        </div>
        <div class="form-group">
            <label><i class="fa-solid fa-chart-pie"></i> Yield %</label>
            <input type="text" readonly class="nonstd-part-yield" id="nonStdPartYield_${rowId}" placeholder="Auto" style="font-weight: 700; color: #059669; background: #fff !important;">
        </div>
        <div style="display: flex; align-items: flex-end;">
            <button type="button" class="btn-remove-eb-part" onclick="removeNonStdPartRow(${rowId})" title="Remove this part">
                <i class="fa-solid fa-trash-can"></i>
            </button>
        </div>
        <div class="eb-agent-feedback-bar" id="nonStdAgentFeedback_${rowId}" style="grid-column: 1 / -1; display: none; margin-top: 4px;"></div>
    `;

    container.appendChild(row);

    if (defaultPart) {
        onSelectNonStdRowPart(rowId, defaultPart);
    }

    updateNonStdRemoveButtonsVisibility();
    checkRowNonStdCapacity(rowId, false);
    recalculateAllNonStdTotals();
}

function removeNonStdPartRow(rowId) {
    const row = document.getElementById(`nonStdPartRow_${rowId}`);
    if (row) {
        row.remove();
        updateNonStdRemoveButtonsVisibility();
        recalculateAllNonStdTotals();
    }
}

function updateNonStdRemoveButtonsVisibility() {
    const rows = document.querySelectorAll("#nonStdPartsContainer .eb-part-card-row");
    rows.forEach(r => {
        const btn = r.querySelector(".btn-remove-eb-part");
        if (btn) {
            btn.style.display = rows.length > 1 ? "inline-flex" : "none";
        }
    });
}

function onNonStdPartRowSearch(inputEl, rowId) {
    clearTimeout(nonStdSearchDebounceTimer);
    const dropdown = document.getElementById(`nonStdDropdown_${rowId}`);
    if (!dropdown) return;

    const trimmed = (inputEl.value || "").trim();

    // Sync first row with primary partNoInput
    const allRows = document.querySelectorAll("#nonStdPartsContainer .eb-part-card-row");
    if (allRows.length > 0 && allRows[0].id === `nonStdPartRow_${rowId}`) {
        const pMain = document.getElementById("partNoInput");
        if (pMain) pMain.value = trimmed;
    }

    if (trimmed.length < 1) {
        dropdown.style.display = "none";
        dropdown.innerHTML = "";
        recalculateAllNonStdTotals();
        return;
    }

    nonStdSearchDebounceTimer = setTimeout(async () => {
        try {
            const thick = document.getElementById("thicknessInput")?.value || "";
            const grade = document.getElementById("gradeInput")?.value || "";
            let results = [];
            const res = await fetch(`/api/parts/search-blank?query=${encodeURIComponent(trimmed)}&thickness=${encodeURIComponent(thick)}&grade=${encodeURIComponent(grade)}`);
            if (res.ok) {
                results = await res.json();
            }
            if (!results || results.length === 0) {
                const res2 = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`);
                if (res2.ok) {
                    const r2 = await res2.json();
                    results = (r2 || []).map(item => ({
                        part_no: item.part_no,
                        base_part: item.base_part,
                        grade: grade || 'YS'
                    }));
                }
            }
            renderNonStdRowDropdown(results, rowId);
        } catch (e) {
            console.error("Non-std part search error:", e);
        }
    }, 200);
}

function renderNonStdRowDropdown(parts, rowId) {
    const dropdown = document.getElementById(`nonStdDropdown_${rowId}`);
    if (!dropdown) return;

    if (!parts || parts.length === 0) {
        dropdown.innerHTML = `<div class="part-dropdown-empty" style="padding: 8px 12px; color: #64748b; font-size: 0.82rem;"><i class="fa-solid fa-circle-question"></i> No master part found. Continue typing custom part #.</div>`;
        dropdown.style.display = "block";
        return;
    }

    dropdown.innerHTML = parts.slice(0, 10).map(p => {
        const blankStr = (p.cut_blank || (p.blank_length && p.blank_width ? `${p.thickness || ''}*${p.blank_length}*${p.blank_width}` : "")).replace(/^\*/, '');
        return `
            <div class="part-dropdown-item" style="padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #f1f5f9;" onclick='onSelectNonStdRowPart(${rowId}, ${JSON.stringify(p).replace(/'/g, "&#39;")})'>
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <strong style="color: #1e293b; font-size: 0.85rem;"><i class="fa-solid fa-shapes" style="color: #0284c7; margin-right: 5px;"></i>${escapeHtml(p.part_no)}</strong>
                    <small style="color: #64748b;">${escapeHtml(p.base_part || '')}</small>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 0.74rem; color: #64748b; margin-top: 2px;">
                    <span>Size: <strong>${escapeHtml(blankStr || 'Enter size')}</strong></span>
                    <span>Grade: ${escapeHtml(p.grade || 'YS')}</span>
                </div>
            </div>
        `;
    }).join("");
    dropdown.style.display = "block";
}

function onSelectNonStdRowPart(rowId, part) {
    const pInput = document.getElementById(`nonStdPartNo_${rowId}`);
    if (pInput) pInput.value = part.part_no;

    const bInput = document.getElementById(`nonStdBasePart_${rowId}`);
    if (bInput) bInput.value = part.base_part || (part.part_no ? part.part_no.split(" - ")[0] : "");

    const sizeInput = document.getElementById(`nonStdPartSize_${rowId}`);
    const cutLenInput = document.getElementById(`nonStdCutLen_${rowId}`);
    const cutWidInput = document.getElementById(`nonStdCutWid_${rowId}`);
    const thickInput = document.getElementById(`nonStdThick_${rowId}`);

    const sheetThick = parseFloat(document.getElementById("thicknessInput")?.value) || 2.0;
    const tVal = part.thickness || sheetThick;
    const lVal = part.blank_length || part.cut_length || "";
    const wVal = part.blank_width || part.cut_width || "";

    if (cutLenInput && lVal) cutLenInput.value = lVal;
    if (cutWidInput && wVal) cutWidInput.value = wVal;
    if (thickInput) thickInput.value = tVal;
    if (sizeInput && lVal && wVal) {
        sizeInput.value = `${tVal}*${lVal}*${wVal}`;
    } else if (sizeInput && part.size) {
        sizeInput.value = part.size;
        onNonStdPartRowSizeInput(sizeInput, rowId);
    }

    if (part.qty && document.getElementById(`nonStdPartQty_${rowId}`)) {
        document.getElementById(`nonStdPartQty_${rowId}`).value = part.qty;
    }
    const blankStripInput = document.getElementById(`nonStdBlankPerStrip_${rowId}`);
    if (blankStripInput) {
        blankStripInput.value = part.blank_per_strip || part.blank_qty || 1;
    }

    const dropdown = document.getElementById(`nonStdDropdown_${rowId}`);
    if (dropdown) dropdown.style.display = "none";

    // Sync first row with primary fields
    const allRows = document.querySelectorAll("#nonStdPartsContainer .eb-part-card-row");
    if (allRows.length > 0 && allRows[0].id === `nonStdPartRow_${rowId}`) {
        const pMain = document.getElementById("partNoInput");
        if (pMain) pMain.value = part.part_no;
        const bMain = document.getElementById("basePartInput");
        if (bMain) bMain.value = bInput?.value || "";
        const gMain = document.getElementById("gradeInput");
        if (gMain && (!gMain.value || gMain.value === "YS") && part.grade) {
            gMain.value = part.grade;
        }
    }

    checkRowNonStdCapacity(rowId, false);
    recalculateAllNonStdTotals();
}

function onNonStdPartRowSizeInput(inputEl, rowId) {
    const thickInput = document.getElementById(`nonStdThick_${rowId}`);
    const sheetThick = parseFloat(document.getElementById("thicknessInput")?.value) || parseFloat(thickInput?.value) || 2.0;
    const d = parseDimString(inputEl.value, sheetThick);
    const cutLenInput = document.getElementById(`nonStdCutLen_${rowId}`);
    const cutWidInput = document.getElementById(`nonStdCutWid_${rowId}`);

    if (d.t > 0 && thickInput) thickInput.value = d.t;
    if (d.l > 0 && cutLenInput) cutLenInput.value = d.l;
    if (d.w > 0 && cutWidInput) cutWidInput.value = d.w;

    checkRowNonStdCapacity(rowId, false);
    recalculateAllNonStdTotals();
}

function onNonStdQtyChange(rowId) {
    checkRowNonStdCapacity(rowId, false);
    recalculateAllNonStdTotals();
}

function capNonStdPartQty(rowId, maxQty) {
    const qtyInput = document.getElementById(`nonStdPartQty_${rowId}`);
    if (qtyInput) {
        qtyInput.value = maxQty;
    }
    checkRowNonStdCapacity(rowId, false);
    recalculateAllNonStdTotals();
}

function checkRowNonStdCapacity(rowId, autoApply = false) {
    const feedbackEl = document.getElementById(`nonStdAgentFeedback_${rowId}`);
    const sizeInput = document.getElementById(`nonStdPartSize_${rowId}`);
    const qtyInput = document.getElementById(`nonStdPartQty_${rowId}`);
    const yieldInput = document.getElementById(`nonStdPartYield_${rowId}`);

    const sheetsRequiredInput = document.getElementById("sheetsRequired");
    const sheetsCount = Math.max(1, parseFloat(sheetsRequiredInput?.value) || 1);

    let sheetLen = parseFloat(document.getElementById("lengthInput")?.value) || 0;
    let sheetWid = parseFloat(document.getElementById("widthInput")?.value) || 0;
    const sheetSizeStr = document.getElementById("sheetSizeInput")?.value || "";
    const sheetThick = parseFloat(document.getElementById("thicknessInput")?.value) || 2.0;

    if ((sheetLen <= 0 || sheetWid <= 0) && sheetSizeStr) {
        const sd = parseDimString(sheetSizeStr, sheetThick);
        if (sd.l > 0 && sd.w > 0) {
            sheetLen = sd.l;
            sheetWid = sd.w;
        }
    }

    let cutLen = parseFloat(document.getElementById(`nonStdCutLen_${rowId}`)?.value) || 0;
    let cutWid = parseFloat(document.getElementById(`nonStdCutWid_${rowId}`)?.value) || 0;

    if ((cutLen === 0 || cutWid === 0) && sizeInput && sizeInput.value) {
        const rowThick = parseFloat(document.getElementById(`nonStdThick_${rowId}`)?.value) || sheetThick;
        const d = parseDimString(sizeInput.value, rowThick);
        if (d.l > 0) cutLen = d.l;
        if (d.w > 0) cutWid = d.w;
    }

    if (!feedbackEl) return { fits: true, exceeds: false, maxParts: 0, partsPerSheet: 0, hasShortage: false };

    if (sheetLen <= 0 || sheetWid <= 0 || cutLen <= 0 || cutWid <= 0) {
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
        if (yieldInput) yieldInput.value = "Auto";
        return { fits: true, exceeds: false, maxParts: 0, partsPerSheet: 0, hasShortage: false };
    }

    const sMax = Math.max(sheetLen, sheetWid);
    const sMin = Math.min(sheetLen, sheetWid);
    const bMax = Math.max(cutLen, cutWid);
    const bMin = Math.min(cutLen, cutWid);

    // 1. Boundary Check
    if (bMax > sMax || bMin > sMin) {
        feedbackEl.style.display = "block";
        feedbackEl.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; background: #fef2f2; border: 1.5px solid #f87171; border-radius: 6px; padding: 6px 12px; font-size: 0.78rem; color: #991b1b;">
                <div style="display: flex; align-items: center; gap: 6px;">
                    <i class="fa-solid fa-triangle-exclamation" style="color: #dc2626; font-size: 0.95rem;"></i>
                    <span><strong>Exceeds Sheet Size:</strong> Blank (${bMax} × ${bMin} mm) exceeds sheet (${sMax} × ${sMin} mm). <strong>0 parts producible.</strong></span>
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
        return { fits: false, exceeds: true, maxParts: 0, partsPerSheet: 0, hasShortage: true };
    }

    // Blank fits within sheet
    if (sizeInput) {
        sizeInput.style.borderColor = "#10b981";
        sizeInput.style.backgroundColor = "#f0fdf4";
    }

    const opt1 = Math.floor(sMax / bMax) * Math.floor(sMin / bMin);
    const opt2 = Math.floor(sMax / bMin) * Math.floor(sMin / bMax);
    const partsPerSheet = Math.max(opt1, opt2, 1);
    const totalMaxParts = partsPerSheet * sheetsCount;
    const totalSheetArea = sheetLen * sheetWid * sheetsCount;
    const maxCapacityYield = Math.min(100, Math.round(((totalMaxParts * cutLen * cutWid) / totalSheetArea) * 1000) / 10);

    const noOfParts = Math.max(1, parseInt(document.getElementById(`nonStdPartQty_${rowId}`)?.value) || 1);
    const blanksPerStrip = Math.max(1, parseInt(document.getElementById(`nonStdBlankPerStrip_${rowId}`)?.value) || 1);
    const partsPerSheetConfig = noOfParts * blanksPerStrip;
    let enteredQty = partsPerSheetConfig * sheetsCount;

    if (autoApply) {
        enteredQty = totalMaxParts;
        if (qtyInput) {
            qtyInput.value = Math.max(1, partsPerSheet);
            qtyInput.style.borderColor = "";
            qtyInput.style.backgroundColor = "";
        }
        const bInput = document.getElementById(`nonStdBlankPerStrip_${rowId}`);
        if (bInput) {
            bInput.value = 1;
        }
        if (yieldInput) {
            yieldInput.value = `${maxCapacityYield}%`;
            yieldInput.style.color = "#059669";
        }
    }

    const actualRowYield = Math.min(100, Math.round(((enteredQty * cutLen * cutWid) / totalSheetArea) * 1000) / 10);
    if (!autoApply && yieldInput) {
        yieldInput.value = `${actualRowYield}%`;
        yieldInput.style.color = "#059669";
    }

    const hasCapacityShortage = enteredQty > totalMaxParts;
    feedbackEl.style.display = "block";

    if (hasCapacityShortage) {
        if (qtyInput) {
            qtyInput.style.borderColor = "#f59e0b";
            qtyInput.style.backgroundColor = "#fffbeb";
        }
        feedbackEl.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; background: #fffbeb; border: 1.5px solid #fcd34d; border-radius: 6px; padding: 6px 12px; font-size: 0.78rem; color: #92400e;">
                <div style="display: flex; align-items: center; gap: 6px;">
                    <i class="fa-solid fa-circle-exclamation" style="color: #d97706; font-size: 0.95rem;"></i>
                    <span>Config <strong>${noOfParts} × ${blanksPerStrip} = ${partsPerSheetConfig}/sheet (${enteredQty} parts total)</strong> exceeds sheet capacity (Max: <strong>${totalMaxParts} parts</strong> @ ${partsPerSheet} blanks/sheet).</span>
                </div>
                <button type="button" class="btn btn-sm" onclick="capNonStdPartQty(${rowId}, ${totalMaxParts})" style="background: #d97706; color: #fff; font-weight: 700; font-size: 0.72rem; padding: 2px 8px; border-radius: 4px; border: none; cursor: pointer;">
                    Cap to ${totalMaxParts} Parts
                </button>
            </div>
        `;
    } else {
        if (qtyInput) {
            qtyInput.style.borderColor = "";
            qtyInput.style.backgroundColor = "";
        }
        feedbackEl.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; background: #f0fdf4; border: 1px solid #86efac; border-radius: 6px; padding: 5px 12px; font-size: 0.78rem; color: #166534;">
                <div style="display: flex; align-items: center; gap: 6px;">
                    <i class="fa-solid fa-circle-check" style="color: #16a34a;"></i>
                    <span>Config: <strong>${noOfParts} parts × ${blanksPerStrip} blanks/strip = ${partsPerSheetConfig} units/sheet</strong> • Total: <strong>${enteredQty} units</strong> from ${sheetsCount} sheet(s) (${actualRowYield}% yield).</span>
                </div>
            </div>
        `;
    }

    return {
        fits: true,
        exceeds: false,
        maxParts: totalMaxParts,
        partsPerSheet: partsPerSheet,
        hasShortage: hasCapacityShortage
    };
}

function runNonStdCapacityAgentForAllRows() {
    const rows = document.querySelectorAll("#nonStdPartsContainer .eb-part-card-row");
    if (!rows || rows.length === 0) return;
    let anyExceeded = false;
    rows.forEach(r => {
        const rowId = r.dataset.rowId;
        const res = checkRowNonStdCapacity(rowId, true);
        if (res.exceeds) anyExceeded = true;
    });
    recalculateAllNonStdTotals();
    if (anyExceeded) {
        alert("⚠️ Notice: One or more part blanks exceed the sheet dimensions and cannot be cut from this sheet.");
    }
}

function recalculateAllNonStdTotals() {
    const sheetsRequiredInput = document.getElementById("sheetsRequired");
    let sheetsCount = Math.max(1, parseFloat(sheetsRequiredInput?.value) || 1);

    let sheetLen = parseFloat(document.getElementById("lengthInput")?.value) || 0;
    let sheetWid = parseFloat(document.getElementById("widthInput")?.value) || 0;
    const sheetSizeStr = document.getElementById("sheetSizeInput")?.value || "";
    const sheetThick = parseFloat(document.getElementById("thicknessInput")?.value) || 2.0;

    if ((sheetLen <= 0 || sheetWid <= 0) && sheetSizeStr) {
        const sd = parseDimString(sheetSizeStr, sheetThick);
        if (sd.l > 0 && sd.w > 0) {
            sheetLen = sd.l;
            sheetWid = sd.w;
        }
    }

    const totalSheetArea = (sheetLen > 0 && sheetWid > 0) ? (sheetLen * sheetWid * sheetsCount) : 0;

    const rows = document.querySelectorAll("#nonStdPartsContainer .eb-part-card-row");
    const partsList = [];
    let grandTotalParts = 0;
    let grandTotalCutArea = 0;
    let anyBoundaryError = false;

    rows.forEach((row, idx) => {
        const rowId = row.dataset.rowId;
        const pNo = document.getElementById(`nonStdPartNo_${rowId}`)?.value?.trim() || "";
        const bPart = document.getElementById(`nonStdBasePart_${rowId}`)?.value?.trim() || (pNo ? pNo.split(" - ")[0] : "");
        const pSize = document.getElementById(`nonStdPartSize_${rowId}`)?.value?.trim() || "";
        let cutLen = parseFloat(document.getElementById(`nonStdCutLen_${rowId}`)?.value) || 0;
        let cutWid = parseFloat(document.getElementById(`nonStdCutWid_${rowId}`)?.value) || 0;
        const thick = parseFloat(document.getElementById(`nonStdThick_${rowId}`)?.value) || sheetThick;

        if ((cutLen === 0 || cutWid === 0) && pSize) {
            const d = parseDimString(pSize, thick);
            if (d.l > 0) cutLen = d.l;
            if (d.w > 0) cutWid = d.w;
        }

        const noOfParts = Math.max(1, parseInt(document.getElementById(`nonStdPartQty_${rowId}`)?.value) || 1);
        const blankPerStrip = Math.max(1, parseInt(document.getElementById(`nonStdBlankPerStrip_${rowId}`)?.value) || 1);
        
        // Total for part = multiplication of no of parts and blank per strip
        const partUnitsPerSheet = noOfParts * blankPerStrip;
        const partTotalUnits = partUnitsPerSheet * sheetsCount;

        const capRes = checkRowNonStdCapacity(rowId, false);
        if (capRes.exceeds) anyBoundaryError = true;

        const yieldVal = document.getElementById(`nonStdPartYield_${rowId}`)?.value || "";

        const fallbackPNo = pNo || (idx === 0 ? (document.getElementById("partNoInput")?.value?.trim() || "Part 1") : `Part ${idx + 1}`);

        partsList.push({
            part_no: fallbackPNo,
            label: `Part ${idx + 1}`,
            base_part: bPart,
            part_size: pSize,
            cut_length: cutLen,
            cut_width: cutWid,
            thickness: thick,
            no_of_parts: noOfParts,
            blank_per_strip: blankPerStrip,
            blanks_per_sheet: partUnitsPerSheet,
            target_qty: partTotalUnits,
            yield_pct: yieldVal,
            is_primary: idx === 0
        });
        grandTotalParts += partTotalUnits;
        if (cutLen > 0 && cutWid > 0) {
            grandTotalCutArea += (cutLen * cutWid * partTotalUnits);
        }
    });

    // Save serialized JSON
    const hiddenJson = document.getElementById("nonStdPartsJson");
    if (hiddenJson) {
        hiddenJson.value = JSON.stringify(partsList);
    }

    // Combined Yield
    let combinedYieldPct = 0;
    if (totalSheetArea > 0 && grandTotalCutArea > 0) {
        combinedYieldPct = Math.min(99.0, Math.round((grandTotalCutArea / totalSheetArea) * 1000) / 10);
    }

    const totalOutputDisplay = document.getElementById("nonStdTotalOutputDisplay");
    const totalYieldDisplay = document.getElementById("nonStdTotalYieldDisplay");

    if (totalOutputDisplay) {
        if (partsList.length > 1) {
            const partsBreakdownStr = partsList.map((p, idx) => `P${idx + 1}: ${p.target_qty.toLocaleString()}`).join(" + ");
            totalOutputDisplay.innerHTML = `${partsBreakdownStr} = <strong>${grandTotalParts.toLocaleString()} Units</strong>`;
        } else {
            totalOutputDisplay.textContent = `${grandTotalParts.toLocaleString()} Units`;
        }
    }
    if (totalYieldDisplay) {
        totalYieldDisplay.textContent = `${combinedYieldPct}%`;
    }

    // Sync primary outputs with overall MO fields
    const targetQtyInput = document.getElementById("targetQty");
    if (targetQtyInput && grandTotalParts > 0) {
        targetQtyInput.value = grandTotalParts;
    }
    const manualQtyInput = document.getElementById("targetQtyManual");
    if (manualQtyInput && grandTotalParts > 0) {
        manualQtyInput.value = grandTotalParts;
    }

    // Current Plan Auto-Calculated Display Box (shows each part total separately and total sum, identical to Standard Layout)
    const autoQtyDisplay = document.getElementById("autoTargetQtyDisplay");
    if (autoQtyDisplay) {
        if (grandTotalParts > 0) {
            if (partsList.length > 1) {
                const partsBreakdownStr = partsList.map((p, idx) => `P${idx + 1}: ${p.target_qty.toLocaleString()}`).join(" + ");
                autoQtyDisplay.innerHTML = `${partsBreakdownStr} = <strong>${grandTotalParts.toLocaleString()}</strong> <small>Units</small>`;
            } else {
                autoQtyDisplay.innerHTML = `${grandTotalParts.toLocaleString()} <small>Units</small>`;
            }
        } else {
            autoQtyDisplay.textContent = "- Units";
        }
    }
    const autoQtyHint = document.getElementById("autoQtyHint");
    if (autoQtyHint) {
        if (grandTotalParts > 0) {
            if (partsList.length > 1) {
                const formulaStr = partsList.map((p, idx) => `P${idx + 1}: ${p.target_qty.toLocaleString()}`).join(" + ");
                autoQtyHint.textContent = `Sum of ${partsList.length} parts: ${formulaStr} (${sheetsCount} sheet(s) × part qty × blank per strip)`;
                autoQtyHint.title = partsList.map((p, idx) => `Part ${idx + 1} (${p.part_no}): ${sheetsCount} sheet(s) × ${p.no_of_parts} part qty × ${p.blank_per_strip} blank/strip = ${p.target_qty.toLocaleString()} units`).join("\n") + `\nTotal across all parts: ${grandTotalParts.toLocaleString()} units`;
            } else {
                autoQtyHint.textContent = `${sheetsCount} sheet(s) × ${partsList[0].no_of_parts} part qty × ${partsList[0].blank_per_strip} blank per strip`;
                autoQtyHint.title = `${sheetsCount} sheet(s) × ${partsList[0].no_of_parts} part qty × ${partsList[0].blank_per_strip} blank per strip = ${grandTotalParts.toLocaleString()} units`;
            }
        } else {
            autoQtyHint.textContent = "Select part & layout";
        }
    }

    const yieldInput = document.getElementById("yieldPctInput");
    if (yieldInput && combinedYieldPct > 0) {
        yieldInput.value = `${combinedYieldPct}%`;
    }

    // Sync Row 1 with primary part fields if present
    if (partsList.length > 0) {
        const pMain = document.getElementById("partNoInput");
        if (pMain && (!pMain.value || pMain.value === "Custom Part")) {
            pMain.value = partsList[0].part_no;
        }
        const bMain = document.getElementById("basePartInput");
        if (bMain && (!bMain.value || bMain.value === "Custom Base")) {
            bMain.value = partsList[0].base_part;
        }
    }
}

function initNonStdPartsRows() {
    const container = document.getElementById("nonStdPartsContainer");
    if (!container) return;
    if (container.children.length === 0) {
        const curPartNo = document.getElementById("partNoInput")?.value?.trim() || "";
        const curBasePart = document.getElementById("basePartInput")?.value?.trim() || "";
        const curQty = parseInt(document.getElementById("targetQtyManual")?.value || document.getElementById("targetQty")?.value || 1, 10);
        const thickVal = parseFloat(document.getElementById("thicknessInput")?.value) || 2.0;

        let initL = 0;
        let initW = 0;
        let initT = thickVal;
        let initSize = "";

        const lr = typeof getSelectedLayoutRecord === "function" ? getSelectedLayoutRecord() : null;
        if (lr) {
            const p1 = lr.part1 || lr;
            const cb = p1.cut_blank || lr.cut_blank || "";
            if (cb) {
                const d = parseDimString(cb, thickVal);
                if (d.l > 0 && d.w > 0) {
                    initL = d.l; initW = d.w; initT = d.t || initT;
                }
            } else if (p1.blank_size?.length && p1.blank_size?.width) {
                initL = parseFloat(p1.blank_size.length);
                initW = parseFloat(p1.blank_size.width);
                initT = parseFloat(p1.blank_size.thickness) || initT;
            }
        }

        if ((!initL || !initW) && currentIntelData?.planning_summary?.parts?.length > 0) {
            const ip = currentIntelData.planning_summary.parts[0];
            if (ip.cut_blank) {
                const d = parseDimString(ip.cut_blank, thickVal);
                if (d.l > 0 && d.w > 0) {
                    initL = d.l; initW = d.w; initT = d.t || initT;
                }
            }
        }

        if (initL > 0 && initW > 0) {
            initSize = `${initT}*${initL}*${initW}`;
        }

        if (curPartNo) {
            addNonStdPartRow({
                part_no: curPartNo,
                base_part: curBasePart,
                size: initSize,
                blank_length: initL || "",
                blank_width: initW || "",
                thickness: initT,
                qty: 1,
                blank_per_strip: 1
            });
        } else {
            addNonStdPartRow();
        }
    }
}

function renderReviewParts(mo) {
    const sec = document.getElementById("reviewPartsSection");
    const grid = document.getElementById("reviewPartsGrid");
    const countBadge = document.getElementById("reviewPartsCountBadge");
    if (!sec || !grid) return;

    let partsList = mo.parts || mo.parts_list;
    if ((!partsList || !partsList.length) && mo.constraints_status && mo.constraints_status.parts) {
        partsList = mo.constraints_status.parts;
    }
    if (typeof partsList === "string") {
        try { partsList = JSON.parse(partsList); } catch(e) { partsList = []; }
    }

    if (!partsList || !Array.isArray(partsList) || partsList.length <= 1) {
        sec.style.display = "none";
        grid.innerHTML = "";
        return;
    }

    if (countBadge) countBadge.textContent = `${partsList.length} Parts Manufactured`;

    grid.innerHTML = partsList.map((p, idx) => {
        const sizeStr = p.part_size || `${p.thickness || mo.thickness || '-'}*${p.cut_length || p.blank_length || '-'}*${p.cut_width || p.blank_width || '-'}`;
        const pQty = p.target_qty || (p.no_of_parts * (p.blank_per_strip || 1)) || 1;
        const isPrimary = p.is_primary || idx === 0;
        return `
            <div style="background: #ffffff; border: 1.5px solid ${isPrimary ? '#0284c7' : '#e2e8f0'}; border-radius: 8px; padding: 12px 14px; position: relative; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">
                    <div>
                        <span style="font-size: 0.72rem; font-weight: 700; color: ${isPrimary ? '#0284c7' : '#64748b'}; text-transform: uppercase;">
                            ${isPrimary ? '★ Primary Part' : `Nested Part #${idx + 1}`}
                        </span>
                        <div style="font-weight: 700; color: #1e293b; font-size: 0.92rem; margin-top: 2px;">
                            ${escapeHtml(p.part_no || '')}
                        </div>
                    </div>
                    <span style="background: #ecfdf5; color: #047857; font-weight: 700; font-size: 0.8rem; padding: 2px 8px; border-radius: 4px;">
                        ${pQty} Units
                    </span>
                </div>
                <div style="font-size: 0.76rem; color: #475569; display: flex; flex-direction: column; gap: 3px; margin-top: 6px; padding-top: 6px; border-top: 1px dashed #e2e8f0;">
                    <div><strong>Base Part:</strong> ${escapeHtml(p.base_part || '-')}</div>
                    <div><strong>Blank Size:</strong> ${escapeHtml(sizeStr)} mm</div>
                    ${p.blank_per_strip ? `<div><strong>Config:</strong> ${p.no_of_parts || 1} parts × ${p.blank_per_strip} blanks/strip</div>` : ''}
                    ${p.yield_pct ? `<div><strong>Yield:</strong> <span style="color: #059669; font-weight: 700;">${escapeHtml(p.yield_pct)}</span></div>` : ''}
                </div>
            </div>
        `;
    }).join("");

    sec.style.display = "block";
}

// Window bindings
window.addNonStdPartRow = addNonStdPartRow;
window.removeNonStdPartRow = removeNonStdPartRow;
window.onNonStdPartRowSearch = onNonStdPartRowSearch;
window.onSelectNonStdRowPart = onSelectNonStdRowPart;
window.onNonStdPartRowSizeInput = onNonStdPartRowSizeInput;
window.onNonStdQtyChange = onNonStdQtyChange;
window.capNonStdPartQty = capNonStdPartQty;
window.checkRowNonStdCapacity = checkRowNonStdCapacity;
window.runNonStdCapacityAgentForAllRows = runNonStdCapacityAgentForAllRows;
window.recalculateAllNonStdTotals = recalculateAllNonStdTotals;
window.initNonStdPartsRows = initNonStdPartsRows;
window.renderReviewParts = renderReviewParts;

// ============================================================================
// RAW MATERIAL REORDER LEVEL & DYNAMIC RYG INVENTORY CONTROLLER
// Dedicated to Unit 1 (PEPIPL) - 36 RM Standards
// Dynamic sheet stock calculation from live ERP / Store
// Status Rules:
// - BLACK : Sheet Stock == 0 or Stock in KGS == 0 (0% Stockout)
// - RED   : 0 < Stock in KGS < 50% Max QTY (Critical Reorder)
// - YELLOW: 50% <= Stock in KGS < 75% Max QTY (Buffer Warning)
// - GREEN : 75% <= Stock in KGS <= 100% Max QTY (Optimal Stock)
// - WHITE : Stock in KGS > 100% Max QTY (Excess / Overstock)
// ============================================================================

let currentRygCustomer = "AL"; // "AL" or "VST"
let currentRygFilter = "ALL";  // "ALL", "BLACK", "RED", "YELLOW", "GREEN", "WHITE"
let currentRygSearch = "";
let currentRygData = null;
let rygDataCache = { AL: null, VST: null };
let activeRygEditingItem = null;

function showReorderLevelView() {
    const activeUnit = (window.AUTH_BRANCH_CODE || window.AUTH_COMPANY_ID || "").toUpperCase();
    if (activeUnit === "PEI2") {
        alert("Reorder Level (RYG) is configured specifically for Unit 1 (PEPIPL).");
        return;
    }

    currentDbTable = null;
    const panel = document.getElementById("dbTablesPanel");
    if (panel) panel.style.display = "none";

    const workflowView = document.getElementById("moWorkflowView");
    const explorerView = document.getElementById("dbExplorerView") || document.getElementById("dbTableView");
    const ebView = document.getElementById("endbitsStoreView");
    const createEbView = document.getElementById("createEndbitMoView");
    const rygView = document.getElementById("reorderLevelView");
    const summaryView = document.getElementById("summaryView");

    if (workflowView) workflowView.style.display = "none";
    if (explorerView) explorerView.style.display = "none";
    if (ebView) ebView.style.display = "none";
    if (createEbView) createEbView.style.display = "none";
    if (rygView) rygView.style.display = "flex";
    if (summaryView) summaryView.style.display = "none";

    setActiveNavTab("navTabReorderLevel");

    // Instant render from cache if available, then refresh silently
    if (rygDataCache[currentRygCustomer]) {
        applyRygDataToUI(rygDataCache[currentRygCustomer]);
        loadRygData(true);
    } else {
        loadRygData(false);
    }
}

function switchRygCustomer(customer) {
    const cust = (customer || "AL").toUpperCase();
    if (cust !== "AL" && cust !== "VST") return;
    currentRygCustomer = cust;

    // Update switcher buttons UI
    const btnAL = document.getElementById("rygCustomerBtnAL");
    const btnVST = document.getElementById("rygCustomerBtnVST");
    if (btnAL && btnVST) {
        if (cust === "AL") {
            btnAL.style.background = "#0284c7";
            btnAL.style.color = "#ffffff";
            btnAL.style.fontWeight = "700";
            btnVST.style.background = "transparent";
            btnVST.style.color = "#475569";
            btnVST.style.fontWeight = "600";
        } else {
            btnVST.style.background = "#0284c7";
            btnVST.style.color = "#ffffff";
            btnVST.style.fontWeight = "700";
            btnAL.style.background = "transparent";
            btnAL.style.color = "#475569";
            btnAL.style.fontWeight = "600";
        }
    }

    // Update customer header badge
    const badge = document.getElementById("rygCurrentCustomerBadge");
    if (badge) {
        badge.textContent = cust === "AL" ? "Ashok Leyland (AL) • 36 Standards" : "VST Tractors (VST) • 13 Standards";
    }

    // Reset status filter and search
    currentRygFilter = "ALL";
    currentRygSearch = "";
    const searchInput = document.getElementById("rygSearchInput");
    if (searchInput) searchInput.value = "";
    updateRygFilterPillsActiveUI("ALL");

    // Instant switch if cached
    if (rygDataCache[cust]) {
        applyRygDataToUI(rygDataCache[cust]);
        loadRygData(true);
    } else {
        loadRygData(false);
    }
}

function applyRygDataToUI(data) {
    if (!data) return;
    currentRygData = data;

    // Update top KPI Summary Cards
    const sum = data.summary || {};
    const kpiBlack = document.getElementById("rygKpiBlack");
    const kpiRed = document.getElementById("rygKpiRed");
    const kpiYellow = document.getElementById("rygKpiYellow");
    const kpiGreen = document.getElementById("rygKpiGreen");
    const kpiWhite = document.getElementById("rygKpiWhite");
    const kpiTotalStock = document.getElementById("rygKpiTotalStockKgs");
    const kpiTotalMax = document.getElementById("rygKpiTotalMaxQty");
    const kpiCapacityPct = document.getElementById("rygCapacityPct");
    const kpiCapacityBar = document.getElementById("rygCapacityBar");
    const totalPill = document.getElementById("rygGrandTotalPill");

    if (kpiBlack) kpiBlack.textContent = sum.BLACK ?? 0;
    if (kpiRed) kpiRed.textContent = sum.RED ?? 0;
    if (kpiYellow) kpiYellow.textContent = sum.YELLOW ?? 0;
    if (kpiGreen) kpiGreen.textContent = sum.GREEN ?? 0;
    if (kpiWhite) kpiWhite.textContent = sum.WHITE ?? 0;
    if (totalPill) totalPill.textContent = `${sum.grand_total ?? 0} Items`;

    if (kpiTotalStock) {
        kpiTotalStock.textContent = `${Number(sum.total_stock_kgs || 0).toLocaleString('en-IN', {minimumFractionDigits: 1, maximumFractionDigits: 1})} kg`;
    }
    if (kpiTotalMax) {
        kpiTotalMax.textContent = `${Number(sum.total_max_qty || 0).toLocaleString('en-IN')} kg`;
    }
    if (kpiCapacityPct) {
        kpiCapacityPct.textContent = `${sum.overall_capacity_pct ?? 0}%`;
    }
    if (kpiCapacityBar) {
        kpiCapacityBar.style.width = `${Math.min(sum.overall_capacity_pct || 0, 100)}%`;
    }

    // Update Filter pill badge counts
    const pillAll = document.getElementById("rygFilterCntAll");
    const pillBlack = document.getElementById("rygFilterCntBlack");
    const pillRed = document.getElementById("rygFilterCntRed");
    const pillYellow = document.getElementById("rygFilterCntYellow");
    const pillGreen = document.getElementById("rygFilterCntGreen");
    const pillWhite = document.getElementById("rygFilterCntWhite");

    if (pillAll) pillAll.textContent = sum.grand_total ?? 0;
    if (pillBlack) pillBlack.textContent = sum.BLACK ?? 0;
    if (pillRed) pillRed.textContent = sum.RED ?? 0;
    if (pillYellow) pillYellow.textContent = sum.YELLOW ?? 0;
    if (pillGreen) pillGreen.textContent = sum.GREEN ?? 0;
    if (pillWhite) pillWhite.textContent = sum.WHITE ?? 0;

    applyRygFiltersAndRender();
}

function applyRygFiltersAndRender() {
    if (!currentRygData) return;
    const allItems = currentRygData.items || [];
    const q = (currentRygSearch || "").trim().toLowerCase();
    const status = (currentRygFilter || "ALL").toUpperCase();

    let filtered = allItems;
    if (status !== "ALL") {
        filtered = filtered.filter(item => (item.status || "").toUpperCase() === status);
    }
    if (q) {
        filtered = filtered.filter(item => {
            const code = (item.rm_code || "").toLowerCase();
            const grade = (item.grade || "").toLowerCase();
            return code.includes(q) || grade.includes(q);
        });
    }

    // 1. Calculate dynamically aggregated summary for currently filtered items
    let filterMaxQty = 0;
    let filterSheetStock = 0;
    let filterStockKg = 0;

    filtered.forEach(it => {
        filterMaxQty += parseFloat(it.max_qty || 0);
        filterSheetStock += parseFloat(it.sheet_stock || 0);
        filterStockKg += parseFloat(it.stock_in_kgs || it.stock_kg || 0);
    });

    const filterCapacityPct = filterMaxQty > 0 ? ((filterStockKg / filterMaxQty) * 100).toFixed(1) : "0.0";

    const filteredSummary = {
        total_max_qty: filterMaxQty,
        total_sheet_stock: filterSheetStock,
        total_stock_kgs: filterStockKg,
        overall_capacity_pct: filterCapacityPct,
        filtered_count: filtered.length,
        filter_status: status,
        is_filtered: status !== "ALL" || Boolean(q)
    };

    // 2. Update Top Total Stock KPI Card according to active filter
    const totalPill = document.getElementById("rygGrandTotalPill");
    const kpiTotalStock = document.getElementById("rygKpiTotalStockKgs");
    const kpiTotalMax = document.getElementById("rygKpiTotalMaxQty");
    const kpiCapacityPct = document.getElementById("rygCapacityPct");
    const kpiCapacityBar = document.getElementById("rygCapacityBar");

    if (totalPill) {
        if (!filteredSummary.is_filtered) {
            totalPill.textContent = `${filtered.length} Items`;
            totalPill.style.background = "#e2e8f0";
            totalPill.style.color = "#1e293b";
        } else {
            totalPill.textContent = `${filtered.length} Items (${status}${q ? ` • "${q}"` : ""})`;
            totalPill.style.background = "#0284c7";
            totalPill.style.color = "#ffffff";
        }
    }
    if (kpiTotalStock) {
        kpiTotalStock.textContent = `${Number(filterStockKg).toLocaleString('en-IN', {minimumFractionDigits: 1, maximumFractionDigits: 1})} kg`;
    }
    if (kpiTotalMax) {
        kpiTotalMax.textContent = `${Number(filterMaxQty).toLocaleString('en-IN')} kg`;
    }
    if (kpiCapacityPct) {
        kpiCapacityPct.textContent = `${filterCapacityPct}%`;
    }
    if (kpiCapacityBar) {
        kpiCapacityBar.style.width = `${Math.min(parseFloat(filterCapacityPct) || 0, 100)}%`;
    }

    renderRygTable(filtered, filteredSummary);
}

async function loadRygData(silent = false) {
    const tbody = document.getElementById("rygTableBody");
    const cust = currentRygCustomer || "AL";
    // Only show spinner if not silent and we have no cached data yet
    if (!silent && !rygDataCache[cust] && tbody) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align: center; padding: 28px; color: #64748b;">
                    <i class="fa-solid fa-circle-notch fa-spin" style="font-size: 1.2rem; color: #0284c7;"></i>
                    <div style="margin-top: 8px; font-weight: 600; font-size: 0.85rem;">Calculating dynamic reorder levels for ${cust === 'VST' ? 'VST Tractors' : 'Ashok Leyland'} (Unit 1)...</div>
                </td>
            </tr>
        `;
    }

    try {
        const res = await fetch(`/api/reorder-level?customer=${encodeURIComponent(cust)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        // Update memory cache
        rygDataCache[cust] = data;
        applyRygDataToUI(data);

    } catch (err) {
        console.error("Failed to load reorder level RYG data:", err);
        if (tbody && !rygDataCache[cust]) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 24px; color: #ef4444;">
                        <i class="fa-solid fa-triangle-exclamation"></i> Error loading RYG data: ${escapeHtml(err.message || 'Server error')}
                    </td>
                </tr>
            `;
        }
    }
}

function reloadRygData() {
    delete rygDataCache[currentRygCustomer];
    loadRygData(false);
}

function updateRygFilterPillsActiveUI(status) {
    const pills = ["ALL", "BLACK", "RED", "YELLOW", "GREEN", "WHITE"];
    pills.forEach(p => {
        const btn = document.getElementById(`rygFilterPill${p}`);
        if (!btn) return;
        if (p === status) {
            btn.classList.add("active");
            btn.style.boxShadow = "0 0 0 2px #0284c7";
            btn.style.fontWeight = "700";
        } else {
            btn.classList.remove("active");
            btn.style.boxShadow = "none";
            btn.style.fontWeight = "600";
        }
    });
}

function filterRygByStatus(status) {
    currentRygFilter = status || "ALL";
    updateRygFilterPillsActiveUI(currentRygFilter);
    applyRygFiltersAndRender();
}

function handleRygSearch(query) {
    currentRygSearch = (query || "").trim();
    applyRygFiltersAndRender();
}

function exportRygExcel() {
    const params = new URLSearchParams({
        customer: currentRygCustomer || "AL",
        status: currentRygFilter || "ALL",
        q: currentRygSearch || ""
    });
    window.location.href = `/api/reorder-level/export-excel?${params.toString()}`;
}

function exportRygCsv() {
    const params = new URLSearchParams({
        customer: currentRygCustomer || "AL",
        status: currentRygFilter || "ALL",
        q: currentRygSearch || ""
    });
    window.location.href = `/api/reorder-level/export-csv?${params.toString()}`;
}

function renderRygTable(items, summary) {
    const tbody = document.getElementById("rygTableBody");
    if (!tbody) return;

    if (!items || items.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align: center; padding: 32px; color: #94a3b8;">
                    <i class="fa-solid fa-folder-open" style="font-size: 1.5rem; margin-bottom: 6px; display: block;"></i>
                    No RM standards found matching search/filter "${escapeHtml(currentRygSearch || currentRygFilter)}".
                </td>
            </tr>
        `;
    } else {
        let rowsHtml = "";
        items.forEach(row => {
            // Status Badge Style matching user spreadsheet
            let badgeStyle = "";
            let badgeText = row.status || "BLACK";

            switch (badgeText) {
                case "BLACK":
                    badgeStyle = "background: #000000; color: #ffffff; border: 1px solid #111;";
                    break;
                case "RED":
                    badgeStyle = "background: #ff0000; color: #ffffff; font-weight: 800;";
                    break;
                case "YELLOW":
                    badgeStyle = "background: #ffff00; color: #000000; font-weight: 800;";
                    break;
                case "GREEN":
                    badgeStyle = "background: #86efac; color: #065f46; font-weight: 800; border: 1px solid #4ade80;";
                    break;
                case "WHITE":
                default:
                    badgeStyle = "background: #ffffff; color: #0f172a; font-weight: 700; border: 1.5px solid #cbd5e1;";
                    break;
            }

            // Sheet stock badge
            const sheetStockFmt = Number(row.sheet_stock || 0).toLocaleString('en-IN');
            const maxQtyFmt = Number(row.max_qty || 0).toLocaleString('en-IN');
            const stockKgFmt = Number(row.stock_in_kgs || row.stock_kg || 0).toLocaleString('en-IN', {minimumFractionDigits: 1, maximumFractionDigits: 2});

            // Stock % formatting
            const ratioPct = row.ratio_pct ?? (row.ratio !== undefined ? (row.ratio * 100).toFixed(1) : 0);
            let ratioColor = "#475569";
            if (badgeText === "BLACK") ratioColor = "#0f172a";
            else if (badgeText === "RED") ratioColor = "#dc2626";
            else if (badgeText === "YELLOW") ratioColor = "#b45309";
            else if (badgeText === "GREEN") ratioColor = "#15803d";

            rowsHtml += `
                <tr style="border-bottom: 1px solid #e2e8f0; transition: background 0.15s;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='transparent'">
                    <td style="text-align: center; font-weight: 700; color: #64748b; padding: 10px 12px; font-size: 0.82rem;">
                        ${row.sl_no}
                    </td>
                    <td style="padding: 10px 14px;">
                        <div style="font-weight: 800; color: #0f172a; font-size: 0.88rem; font-family: monospace;">
                            ${escapeHtml(row.rm_code)}
                        </div>
                        <div style="font-size: 0.73rem; color: #64748b; margin-top: 2px;">
                            ${escapeHtml(row.grade || '')} • ${row.thickness}×${row.length}×${row.width} mm • ${row.weight_per_sheet} kg/sh
                        </div>
                    </td>
                    <td style="text-align: right; padding: 10px 14px; font-weight: 700; color: #1e293b; font-size: 0.88rem;">
                        ${maxQtyFmt}
                    </td>
                    <td style="text-align: center; padding: 10px 14px;">
                        <span style="font-weight: 800; font-size: 0.92rem; color: ${row.sheet_stock > 0 ? '#0284c7' : '#94a3b8'};">
                            ${sheetStockFmt}
                        </span>
                        <span style="font-size: 0.72rem; color: #94a3b8; display: block;">sheets</span>
                    </td>
                    <td style="text-align: right; padding: 10px 14px; font-weight: 800; font-size: 0.9rem; color: #0f172a;">
                        ${stockKgFmt}
                    </td>
                    <td style="text-align: center; padding: 10px 12px; font-weight: 800; font-size: 0.85rem; color: ${ratioColor};">
                        ${ratioPct}%
                    </td>
                    <td style="text-align: center; padding: 10px 14px;">
                        <span style="display: inline-block; width: 92px; padding: 4px 0; border-radius: 4px; font-size: 0.82rem; letter-spacing: 0.5px; text-transform: uppercase; box-shadow: 0 1px 2px rgba(0,0,0,0.06); ${badgeStyle}">
                            ${badgeText}
                        </span>
                    </td>
                </tr>
            `;
        });
        tbody.innerHTML = rowsHtml;
    }

    // Always update footer totals dynamically matching active filter & spreadsheet
    const sumObj = summary || {};
    const footerLabel = document.getElementById("rygFooterTotalLabel");
    const footerMaxQty = document.getElementById("rygFooterTotalMaxQty");
    const footerSheets = document.getElementById("rygFooterTotalSheets");
    const footerStockKg = document.getElementById("rygFooterTotalStockKgs");
    const footerAvgRatio = document.getElementById("rygFooterAvgRatio");

    const st = sumObj.filter_status;
    if (footerLabel) {
        footerLabel.textContent = (st && st !== "ALL") ? `Total (${st})` : "Total";
    }
    if (footerMaxQty) {
        footerMaxQty.textContent = Number(sumObj.total_max_qty || 0).toLocaleString('en-IN');
    }
    if (footerSheets) {
        footerSheets.textContent = `${Number(sumObj.total_sheet_stock || 0).toLocaleString('en-IN')} Sheets`;
    }
    if (footerStockKg) {
        footerStockKg.textContent = `${Number(sumObj.total_stock_kgs || 0).toLocaleString('en-IN', {minimumFractionDigits: 1, maximumFractionDigits: 1})} kg`;
    }
    if (footerAvgRatio) {
        footerAvgRatio.textContent = `${sumObj.overall_capacity_pct ?? 0}%`;
    }
}

// Quick Stock & Max Qty Adjustment Modal
function openAdjustStockModal(rmCode) {
    if (!currentRygData || !currentRygData.items) return;
    const item = currentRygData.items.find(i => i.rm_code === rmCode);
    if (!item) return;

    activeRygEditingItem = item;

    const modal = document.getElementById("adjustRygStockModal");
    const codeEl = document.getElementById("modalRygRmCode");
    const codeInput = document.getElementById("modalRygRmCodeInput");
    const specEl = document.getElementById("modalRygSpec");
    const custTag = document.getElementById("modalRygCustomerTag");
    const sheetInput = document.getElementById("modalRygSheetStockInput");
    const maxQtyInput = document.getElementById("modalRygMaxQtyInput");
    const wtInput = document.getElementById("modalRygWtPerSheetInput");

    if (codeEl) codeEl.textContent = item.rm_code;
    if (codeInput) codeInput.value = item.rm_code;
    if (wtInput) wtInput.value = item.weight_per_sheet;
    if (specEl) {
        specEl.innerHTML = `Grade: <strong>${escapeHtml(item.grade || '')}</strong> • ${item.thickness} × ${item.length} × ${item.width} mm • Unit Wt: <strong>${item.weight_per_sheet} kg/sheet</strong>`;
    }
    if (custTag) {
        custTag.textContent = `${currentRygCustomer} Standard`;
    }
    if (sheetInput) sheetInput.value = item.sheet_stock;
    if (maxQtyInput) maxQtyInput.value = item.max_qty;

    updateModalRygPreview();

    if (modal) modal.style.display = "flex";
}

function closeAdjustStockModal() {
    const modal = document.getElementById("adjustRygStockModal");
    if (modal) modal.style.display = "none";
    activeRygEditingItem = null;
}

function updateModalRygPreview() {
    const sheetInput = document.getElementById("modalRygSheetStockInput");
    const maxQtyInput = document.getElementById("modalRygMaxQtyInput");
    const wtInput = document.getElementById("modalRygWtPerSheetInput");

    const sheets = parseFloat(sheetInput?.value || 0) || 0;
    const maxQty = parseFloat(maxQtyInput?.value || 1) || 1;
    const wt = parseFloat(wtInput?.value || 0) || 0;

    const stockKgs = Math.round(sheets * wt * 100) / 100;
    const ratio = maxQty > 0 ? (stockKgs / maxQty) : 0;
    const ratioPct = (ratio * 100).toFixed(1);

    // Classification
    let status = "BLACK";
    let badgeBg = "#000000";
    let badgeColor = "#ffffff";
    let border = "1px solid #111";

    if (sheets <= 0 || stockKgs <= 0) {
        status = "BLACK";
        badgeBg = "#000000";
        badgeColor = "#ffffff";
    } else if (ratio < 0.50) {
        status = "RED";
        badgeBg = "#ff0000";
        badgeColor = "#ffffff";
    } else if (ratio < 0.75) {
        status = "YELLOW";
        badgeBg = "#ffff00";
        badgeColor = "#000000";
    } else if (ratio <= 1.00) {
        status = "GREEN";
        badgeBg = "#86efac";
        badgeColor = "#065f46";
    } else {
        status = "WHITE";
        badgeBg = "#ffffff";
        badgeColor = "#0f172a";
        border = "1.5px solid #cbd5e1";
    }

    const prevKgs = document.getElementById("modalRygPreviewKgs");
    const prevRatio = document.getElementById("modalRygPreviewRatio");
    const prevBadge = document.getElementById("modalRygPreviewBadge");

    if (prevKgs) prevKgs.textContent = `${stockKgs.toLocaleString('en-IN', {minimumFractionDigits: 1, maximumFractionDigits: 1})} kg`;
    if (prevRatio) prevRatio.textContent = `${ratioPct}%`;
    if (prevBadge) {
        prevBadge.textContent = status;
        prevBadge.style.background = badgeBg;
        prevBadge.style.color = badgeColor;
        prevBadge.style.border = border;
    }
}

async function saveAdjustStockModal(event) {
    if (event) event.preventDefault();
    if (!activeRygEditingItem) return;

    const rmCode = activeRygEditingItem.rm_code;
    const sheetInput = document.getElementById("modalRygSheetStockInput");
    const maxQtyInput = document.getElementById("modalRygMaxQtyInput");
    const saveBtn = document.getElementById("modalRygSaveBtn");

    const newSheets = parseFloat(sheetInput?.value || 0);
    const newMaxQty = parseFloat(maxQtyInput?.value || 0);

    if (isNaN(newSheets) || newSheets < 0) {
        alert("Please enter a valid non-negative sheet count.");
        return;
    }

    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Saving...`;
    }

    try {
        // 1. Update Sheet Stock
        const res1 = await fetch("/api/reorder-level/update-stock", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rm_code: rmCode, sheet_stock: newSheets })
        });
        if (!res1.ok) throw new Error("Failed to update sheet stock");

        // 2. Update Max Qty if modified
        if (!isNaN(newMaxQty) && newMaxQty > 0 && newMaxQty !== activeRygEditingItem.max_qty) {
            await fetch("/api/reorder-level/update-max-qty", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ rm_code: rmCode, max_qty: newMaxQty })
            });
        }

        closeAdjustStockModal();
        await loadRygData(false);

    } catch (err) {
        console.error("Failed to save RYG adjustments:", err);
        alert(`Error saving adjustments: ${err.message || 'Server error'}`);
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = `<i class="fa-solid fa-check"></i> Save &amp; Recalculate`;
        }
    }
}

// Window bindings for RYG
window.showReorderLevelView = showReorderLevelView;
window.switchRygCustomer = switchRygCustomer;
window.loadRygData = loadRygData;
window.reloadRygData = reloadRygData;
window.filterRygByStatus = filterRygByStatus;
window.handleRygSearch = handleRygSearch;
window.renderRygTable = renderRygTable;
window.exportRygCsv = exportRygCsv;
window.exportRygExcel = exportRygExcel;
window.openAdjustStockModal = openAdjustStockModal;
window.closeAdjustStockModal = closeAdjustStockModal;
window.updateModalRygPreview = updateModalRygPreview;
window.saveAdjustStockModal = saveAdjustStockModal;

// =========================================================================
// LIVE MO PRODUCTION & MATERIAL YIELD SUMMARY PAGE
// =========================================================================
function showSummaryView() {
    currentDbTable = null;
    const panel = document.getElementById("dbTablesPanel");
    if (panel) panel.style.display = "none";

    const workflowView = document.getElementById("moWorkflowView");
    const explorerView = document.getElementById("dbExplorerView") || document.getElementById("dbTableView");
    const ebView = document.getElementById("endbitsStoreView");
    const createEbView = document.getElementById("createEndbitMoView");
    const rygView = document.getElementById("reorderLevelView");
    const summaryView = document.getElementById("summaryView");

    if (workflowView) workflowView.style.display = "none";
    if (explorerView) explorerView.style.display = "none";
    if (ebView) ebView.style.display = "none";
    if (createEbView) createEbView.style.display = "none";
    if (rygView) rygView.style.display = "none";
    if (summaryView) summaryView.style.display = "flex";

    setActiveNavTab("navTabSummary");
    loadSummaryData();
}

async function loadSummaryData() {
    const tbody = document.getElementById("summaryTableBody");
    const q = (document.getElementById("summarySearchInput")?.value || "").trim();
    const status = document.getElementById("summaryStatusFilter")?.value || "";
    const cid = window._activeUnit || window.AUTH_COMPANY_ID || "PEPIPL";

    const params = new URLSearchParams({
        company_id: cid,
        q: q,
        status: status
    });

    try {
        const res = await fetch(`/api/mo/summary?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        renderSummaryView(data);
    } catch (err) {
        console.error("Failed to load MO summary:", err);
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 24px; color: #ef4444;">
                        <i class="fa-solid fa-triangle-exclamation"></i> Error loading live summary: ${escapeHtml(err.message || "Server error")}
                    </td>
                </tr>
            `;
        }
    }
}

function renderSummaryView(data) {
    const sum = (data && data.summary) || {};
    const rows = (data && data.rows) || [];

    // 1. Update 2 Live KPI Cards above the table
    const yieldEl = document.getElementById("summaryMonthlyYieldVal");
    const yieldSub = document.getElementById("summaryMonthlyYieldSub");
    const scrapEl = document.getElementById("summaryScrapWeightVal");
    const scrapSub = document.getElementById("summaryScrapWeightSub");
    const pillEl = document.getElementById("summaryTotalMosPill");

    const totalRmWt = Number(sum.total_rm_weight_kg || 0);
    const totalPartWt = Number(sum.total_part_weight_kg || 0);
    const monthlyYield = Number(sum.monthly_yield_pct || 0);
    const scrapWt = Number(sum.scrap_weight_kg || 0);

    if (yieldEl) yieldEl.textContent = `${monthlyYield.toFixed(2)}%`;
    if (yieldSub) {
        yieldSub.textContent = `(${totalPartWt.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg Parts / ${totalRmWt.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg RM) × 100`;
    }

    if (scrapEl) scrapEl.textContent = `${scrapWt.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg`;
    if (scrapSub) {
        scrapSub.textContent = `${totalRmWt.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg RM - ${totalPartWt.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg Parts Produced`;
    }

    if (pillEl) pillEl.textContent = `${sum.total_mos ?? rows.length} MOs`;

    // 2. Render Table Rows
    const tbody = document.getElementById("summaryTableBody");
    if (tbody) {
        if (rows.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align: center; padding: 32px; color: #94a3b8;">
                        No Material Orders found matching the current filter.
                    </td>
                </tr>
            `;
        } else {
            tbody.innerHTML = rows.map(row => {
                const partsHtml = (row.parts || []).map(p => {
                    const qtyFmt = Number(p.qty || 0).toLocaleString("en-IN");
                    return `
                        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 0;">
                            <strong style="color: #0f172a; font-size: 0.84rem;">${escapeHtml(p.part_no || "-")}</strong>
                            <span style="background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; padding: 1px 8px; border-radius: 12px; font-size: 0.74rem; font-weight: 700;">${qtyFmt} Nos</span>
                        </div>
                    `;
                }).join("");

                const yVal = Number(row.yield_pct || 0);
                const yBg = yVal >= 85 ? "#dcfce7" : (yVal >= 70 ? "#fef9c3" : "#fee2e2");
                const yCol = yVal >= 85 ? "#166534" : (yVal >= 70 ? "#854d0e" : "#991b1b");

                return `
                    <tr>
                        <td>
                            <div style="font-weight: 800; color: #0f172a;">${escapeHtml(row.mo_number || "-")}</div>
                            <small class="text-muted">${escapeHtml(row.date || "")}${row.status ? ` • ${escapeHtml(row.status)}` : ""}</small>
                        </td>
                        <td style="min-width: 220px;">${partsHtml}</td>
                        <td>
                            <div><code>${escapeHtml(row.rm_erp || "-")}</code></div>
                            ${row.grade ? `<small class="text-muted">${escapeHtml(row.grade)}</small>` : ""}
                        </td>
                        <td style="text-align: center; font-weight: 700; color: #0284c7;">
                            ${Number(row.sheets_used || 0).toLocaleString("en-IN")} Sheets
                        </td>
                        <td style="text-align: right; font-weight: 700; color: #0f172a;">
                            ${Number(row.rm_weight_kg || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg
                        </td>
                        <td style="text-align: right; font-weight: 700; color: #059669;">
                            ${Number(row.part_weight_kg || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg
                        </td>
                        <td style="text-align: center;">
                            <span style="display: inline-block; padding: 3px 10px; border-radius: 14px; font-weight: 800; font-size: 0.8rem; background: ${yBg}; color: ${yCol};">
                                ${yVal.toFixed(2)}%
                            </span>
                        </td>
                    </tr>
                `;
            }).join("");
        }
    }

    // 3. Update Footer Totals
    const fSheets = document.getElementById("summaryFooterSheets");
    const fRmWt = document.getElementById("summaryFooterRmWeight");
    const fPartWt = document.getElementById("summaryFooterPartWeight");
    const fYield = document.getElementById("summaryFooterYield");

    if (fSheets) fSheets.textContent = `${Number(sum.total_sheets || 0).toLocaleString("en-IN")} Sheets`;
    if (fRmWt) fRmWt.textContent = `${totalRmWt.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg`;
    if (fPartWt) fPartWt.textContent = `${totalPartWt.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kg`;
    if (fYield) fYield.textContent = `${monthlyYield.toFixed(2)}%`;
}

window.showSummaryView = showSummaryView;
window.loadSummaryData = loadSummaryData;


