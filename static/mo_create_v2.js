/**
 * SheetLayout AI — Clean v2 Create Material Order Modal Logic
 * Hierarchy:
 * 1. Base Part (Primary Part to Manufacture)
 * 2. Raw Material & Sheets Allocation (Auto-loaded for Base Part) + Total Parts Output
 * 3. Additional Parts to Cut on this Sheet (Optional Combo Nesting)
 * 4. 2D Cut Optimizer & Visual Layout Engine (Opens Visual SVG Cutting Map) + Endbits Banner
 * 5. Remarks & Submit MO
 */

let v2BasePart = null; // { part_no, grade, thickness, length, width, offtake, strip_per_blank_qty, standard_rm, mrp }
let v2AdditionalParts = []; // Array of { part_no, grade, thickness, length, width, offtake, strip_per_blank_qty, mrp }
let v2SelectedRm = null; // { rm_code, available_sheets, weight_per_sheet, length, width }
let v2LastOptimization = null;

document.addEventListener('DOMContentLoaded', () => {
    initV2CreateMoModal();
});

function initV2CreateMoModal() {
    v2BasePart = null;
    v2AdditionalParts = [];
    v2SelectedRm = null;
    v2LastOptimization = null;
}

window.openV2CreateMoModal = function() {
    const modal = document.getElementById('createMoModal');
    if (!modal) return;

    v2BasePart = null;
    v2AdditionalParts = [];
    v2SelectedRm = null;
    v2LastOptimization = null;

    // Reset Base Part Inputs
    const baseInput = document.getElementById('v2BasePartInput');
    if (baseInput) baseInput.value = '';

    document.getElementById('v2BaseGradeBadge').innerText = '-';
    document.getElementById('v2BaseSizeBadge').innerText = '- × - × - mm';
    document.getElementById('v2BaseStripBadge').innerText = '- Nos';

    document.getElementById('v2BaseMrpVal').innerText = '- Nos';
    document.getElementById('v2BaseStockVal').innerText = '- Nos';
    document.getElementById('v2BaseProduceVal').innerText = '- Nos';

    // Reset RM Section
    const rmSelect = document.getElementById('v2RmSelect');
    if (rmSelect) rmSelect.innerHTML = '<option value="">-- Select Base Part First --</option>';

    const stockBox = document.getElementById('v2RmStockDisplay');
    if (stockBox) {
        stockBox.className = 'v2-stock-display-box';
        stockBox.innerHTML = '<i class="fa-solid fa-box-open"></i> Select Base Part';
    }

    const sheetsInput = document.getElementById('v2SheetsInput');
    if (sheetsInput) sheetsInput.value = '1';

    // Reset Total Parts Output
    updateV2TotalPartsProduced();

    // Reset Additional Parts
    const addContainer = document.getElementById('v2AdditionalPartsContainer');
    if (addContainer) addContainer.innerHTML = '';

    // Reset Optimizer & Endbits
    const resultsBox = document.getElementById('v2OpticutterResults');
    if (resultsBox) resultsBox.style.display = 'none';

    const endbitsBanner = document.getElementById('v2EndbitsBanner');
    if (endbitsBanner) endbitsBanner.style.display = 'none';

    modal.style.display = 'flex';
};

window.closeV2CreateMoModal = function() {
    const modal = document.getElementById('createMoModal');
    if (modal) modal.style.display = 'none';
};

// ============================================================================
// 1. BASE PART SEARCH & SELECTION
// ============================================================================
let v2BaseSearchTimeout = null;

window.onV2BasePartSearch = function(query) {
    clearTimeout(v2BaseSearchTimeout);
    const dropdown = document.getElementById('v2BasePartDropdown');
    if (!query || query.trim().length < 1) {
        if (dropdown) dropdown.style.display = 'none';
        return;
    }

    v2BaseSearchTimeout = setTimeout(async () => {
        try {
            const res = await fetch(`/api/v2/search-parts?q=${encodeURIComponent(query.trim())}`);
            const data = await res.json();
            if (data.success && data.parts && data.parts.length > 0) {
                dropdown.innerHTML = data.parts.map(p => `
                    <div class="v2-part-dropdown-item" onclick="selectV2BasePart('${p.part_no}')">
                        <div>
                            <strong>${p.part_no}</strong>
                            <small style="color: #64748b; margin-left: 8px;">${p.part_desc || ''}</small>
                        </div>
                        <span style="font-size: 0.75rem; background: #e2e8f0; padding: 2px 6px; border-radius: 4px;">
                            ${p.grade || ''} | ${p.thickness || ''}mm
                        </span>
                    </div>
                `).join('');
                dropdown.style.display = 'block';
            } else {
                dropdown.innerHTML = '<div style="padding: 10px; color: #94a3b8; font-size: 0.85rem;">No matching parts found in parts table</div>';
                dropdown.style.display = 'block';
            }
        } catch (e) {
            console.error("Base part search error:", e);
        }
    }, 200);
};

window.selectV2BasePart = async function(partNo) {
    const dropdown = document.getElementById('v2BasePartDropdown');
    if (dropdown) dropdown.style.display = 'none';

    const input = document.getElementById('v2BasePartInput');
    if (input) input.value = partNo;

    try {
        const res = await fetch(`/api/v2/part-details/${encodeURIComponent(partNo)}`);
        const data = await res.json();
        if (!data.success) return;

        const part = data.part;
        const mrp = data.mrp;
        const matchingRms = data.matching_rms || [];

        v2BasePart = {
            part_no: part.part_no,
            grade: part.grade,
            thickness: parseFloat(part.thickness || 0),
            length: parseFloat(part.length || 0),
            width: parseFloat(part.width || 0),
            offtake: parseInt(part.offtake || 1),
            strip_per_blank_qty: parseInt(part.strip_per_blank_qty || 1),
            standard_rm: part.standard_rm,
            mrp: mrp
        };

        // Update Base Part Row Badges
        document.getElementById('v2BaseGradeBadge').innerHTML = `<span style="color: #0284c7; font-weight: 700;">${part.grade}</span>`;
        document.getElementById('v2BaseSizeBadge').innerText = `${part.thickness} × ${part.length} × ${part.width} mm`;
        document.getElementById('v2BaseStripBadge').innerText = `${part.strip_per_blank_qty} Nos`;

        // Update Base Part 3 Live Demand Cards
        document.getElementById('v2BaseMrpVal').innerText = `${mrp.monthly_schedule || 0} Nos`;
        document.getElementById('v2BaseStockVal').innerText = `${mrp.current_stock || 0} Nos`;
        document.getElementById('v2BaseProduceVal').innerText = `${mrp.qty_to_produce || 0} Nos`;

        // 2. Auto-load RM Dropdown matching this Base Part!
        populateV2RmDropdown(matchingRms, part.standard_rm);

        // Update Total Parts Output display
        updateV2TotalPartsProduced();

    } catch (e) {
        console.error("Error fetching base part details:", e);
    }
};

// ============================================================================
// 2. RAW MATERIAL SELECTION & TOTAL PARTS CALCULATION
// ============================================================================
function populateV2RmDropdown(matchingRms, standardRm) {
    const rmSelect = document.getElementById('v2RmSelect');
    if (!rmSelect) return;

    if (!matchingRms || matchingRms.length === 0) {
        rmSelect.innerHTML = '<option value="">No matching RM sheets in store</option>';
        const stockBox = document.getElementById('v2RmStockDisplay');
        if (stockBox) {
            stockBox.className = 'v2-stock-display-box low-stock';
            stockBox.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> 0 Sheets In Store';
        }
        return;
    }

    let defaultRm = standardRm || matchingRms[0].rm_code;

    rmSelect.innerHTML = matchingRms.map(rm => `
        <option value="${rm.rm_code}" ${rm.rm_code === defaultRm ? 'selected' : ''}>
            ${rm.rm_code} (${rm.available_sheets} sheets in stock, ${rm.weight_per_sheet}kg/sht)
        </option>
    `).join('');

    onV2RmSelected(defaultRm);
}

window.onV2RmSelected = async function(rmCode) {
    if (!rmCode) return;
    try {
        const res = await fetch(`/api/v2/rm-stock/${encodeURIComponent(rmCode)}`);
        const data = await res.json();
        if (!data.success) return;

        v2SelectedRm = data;

        const stockBox = document.getElementById('v2RmStockDisplay');
        if (stockBox) {
            const qty = data.available_sheets || 0;
            if (qty > 0) {
                stockBox.className = 'v2-stock-display-box';
                stockBox.innerHTML = `<i class="fa-solid fa-circle-check" style="color: #16a34a;"></i> ${qty} Sheets Available`;
            } else {
                stockBox.className = 'v2-stock-display-box low-stock';
                stockBox.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> 0 Sheets (Shortage)`;
            }
        }
        updateV2TotalPartsProduced();
    } catch (e) {
        console.error("Error fetching RM stock:", e);
    }
};

window.updateV2TotalPartsProduced = function() {
    const sheetsInput = document.getElementById('v2SheetsInput');
    const sheets = Math.max(1, parseInt(sheetsInput?.value || 1, 10));

    const totalValEl = document.getElementById('v2TotalPartsVal');
    const formulaEl = document.getElementById('v2TotalPartsFormula');

    if (!v2BasePart) {
        if (totalValEl) totalValEl.innerText = '0 Nos';
        if (formulaEl) formulaEl.innerText = '(Select part)';
        return;
    }

    const baseOfftake = v2BasePart.offtake || 1;
    const baseProduced = sheets * baseOfftake;

    // Additional parts produced
    let addProduced = 0;
    v2AdditionalParts.filter(p => p && p.part_no).forEach(p => {
        addProduced += (sheets * (p.offtake || 1));
    });

    const totalProduced = baseProduced + addProduced;

    if (totalValEl) totalValEl.innerText = `${totalProduced} Units`;
    if (formulaEl) {
        if (addProduced > 0) {
            formulaEl.innerText = `(${sheets} sht × [Base: ${baseOfftake} + Extra: ${addProduced / sheets}])`;
        } else {
            formulaEl.innerText = `(${sheets} sht × ${baseOfftake} offtake)`;
        }
    }
};

// ============================================================================
// 3. ADDITIONAL PARTS (Optional Combo / Nested Parts)
// ============================================================================
window.addV2AdditionalPartRow = function() {
    if (!v2BasePart) {
        alert("Please select the Base Part first.");
        return;
    }

    const container = document.getElementById('v2AdditionalPartsContainer');
    if (!container) return;

    const addIndex = v2AdditionalParts.length;
    v2AdditionalParts.push(null);

    const card = document.createElement('div');
    card.className = 'v2-part-card';
    card.id = `v2AddPartCard_${addIndex}`;
    card.style.background = '#f8fafc';
    card.style.marginTop = '10px';

    card.innerHTML = `
        <div class="v2-part-row">
            <div class="form-group v2-part-search-wrap">
                <label style="font-size: 0.78rem; font-weight: 700; color: #475569;">
                    Additional Part Number <span class="required">*</span>
                </label>
                <input type="text" class="form-control v2-part-search-input" id="v2AddPartInput_${addIndex}" 
                       placeholder="Search Additional Part..." autocomplete="off"
                       oninput="onV2AddPartSearch(${addIndex}, this.value)">
                <div class="v2-part-dropdown" id="v2AddPartDropdown_${addIndex}" style="display: none;"></div>
            </div>

            <div class="form-group">
                <label style="font-size: 0.78rem; font-weight: 700; color: #475569;">Grade</label>
                <div class="v2-badge-box" id="v2AddGradeBadge_${addIndex}">-</div>
            </div>

            <div class="form-group">
                <label style="font-size: 0.78rem; font-weight: 700; color: #475569;">Size (T × L × W)</label>
                <div class="v2-badge-box" id="v2AddSizeBadge_${addIndex}">- × - × - mm</div>
            </div>

            <div class="form-group">
                <label style="font-size: 0.78rem; font-weight: 700; color: #475569;">Strip / Blank Qty</label>
                <div class="v2-badge-box" id="v2AddStripBadge_${addIndex}">- Nos</div>
            </div>

            <button type="button" class="btn btn-sm btn-danger" onclick="removeV2AddPartRow(${addIndex})" 
                    style="height: 40px; padding: 0 10px; border-radius: 8px;" title="Remove this additional part">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>

        <div class="v2-demand-cards-row">
            <div class="v2-demand-card mrp">
                <div class="v2-demand-card-icon"><i class="fa-solid fa-calendar-days"></i></div>
                <div class="v2-demand-card-info">
                    <span class="v2-demand-label">MRP Monthly Schedule</span>
                    <span class="v2-demand-val" id="v2AddMrpVal_${addIndex}">- Nos</span>
                </div>
            </div>

            <div class="v2-demand-card stock">
                <div class="v2-demand-card-icon"><i class="fa-solid fa-boxes-stacked"></i></div>
                <div class="v2-demand-card-info">
                    <span class="v2-demand-label">Current Stock (FG/WIP)</span>
                    <span class="v2-demand-val" id="v2AddStockVal_${addIndex}">- Nos</span>
                </div>
            </div>

            <div class="v2-demand-card produce">
                <div class="v2-demand-card-icon"><i class="fa-solid fa-bullseye"></i></div>
                <div class="v2-demand-card-info">
                    <span class="v2-demand-label">Qty to Produce (Net)</span>
                    <span class="v2-demand-val" id="v2AddProduceVal_${addIndex}">- Nos</span>
                </div>
            </div>
        </div>
    `;

    container.appendChild(card);
};

window.removeV2AddPartRow = function(index) {
    const card = document.getElementById(`v2AddPartCard_${index}`);
    if (card) card.remove();
    v2AdditionalParts[index] = null;
    updateV2TotalPartsProduced();
};

let v2AddSearchTimeout = null;
window.onV2AddPartSearch = function(index, query) {
    clearTimeout(v2AddSearchTimeout);
    const dropdown = document.getElementById(`v2AddPartDropdown_${index}`);
    if (!query || query.trim().length < 1) {
        if (dropdown) dropdown.style.display = 'none';
        return;
    }

    v2AddSearchTimeout = setTimeout(async () => {
        try {
            const res = await fetch(`/api/v2/search-parts?q=${encodeURIComponent(query.trim())}`);
            const data = await res.json();
            if (data.success && data.parts && data.parts.length > 0) {
                dropdown.innerHTML = data.parts.map(p => `
                    <div class="v2-part-dropdown-item" onclick="selectV2AddPart(${index}, '${p.part_no}')">
                        <div>
                            <strong>${p.part_no}</strong>
                            <small style="color: #64748b; margin-left: 8px;">${p.part_desc || ''}</small>
                        </div>
                        <span style="font-size: 0.75rem; background: #e2e8f0; padding: 2px 6px; border-radius: 4px;">
                            ${p.grade || ''} | ${p.thickness || ''}mm
                        </span>
                    </div>
                `).join('');
                dropdown.style.display = 'block';
            } else {
                dropdown.innerHTML = '<div style="padding: 10px; color: #94a3b8; font-size: 0.85rem;">No matching parts found</div>';
                dropdown.style.display = 'block';
            }
        } catch (e) {
            console.error("Additional part search error:", e);
        }
    }, 200);
};

window.selectV2AddPart = async function(index, partNo) {
    const dropdown = document.getElementById(`v2AddPartDropdown_${index}`);
    if (dropdown) dropdown.style.display = 'none';

    const input = document.getElementById(`v2AddPartInput_${index}`);
    if (input) input.value = partNo;

    try {
        const res = await fetch(`/api/v2/part-details/${encodeURIComponent(partNo)}`);
        const data = await res.json();
        if (!data.success) return;

        const part = data.part;
        const mrp = data.mrp;

        v2AdditionalParts[index] = {
            part_no: part.part_no,
            grade: part.grade,
            thickness: parseFloat(part.thickness || 0),
            length: parseFloat(part.length || 0),
            width: parseFloat(part.width || 0),
            offtake: parseInt(part.offtake || 1),
            strip_per_blank_qty: parseInt(part.strip_per_blank_qty || 1),
            mrp: mrp
        };

        document.getElementById(`v2AddGradeBadge_${index}`).innerHTML = `<span style="color: #0284c7; font-weight: 700;">${part.grade}</span>`;
        document.getElementById(`v2AddSizeBadge_${index}`).innerText = `${part.thickness} × ${part.length} × ${part.width} mm`;
        document.getElementById(`v2AddStripBadge_${index}`).innerText = `${part.strip_per_blank_qty} Nos`;

        document.getElementById(`v2AddMrpVal_${index}`).innerText = `${mrp.monthly_schedule || 0} Nos`;
        document.getElementById(`v2AddStockVal_${index}`).innerText = `${mrp.current_stock || 0} Nos`;
        document.getElementById(`v2AddProduceVal_${index}`).innerText = `${mrp.qty_to_produce || 0} Nos`;

        updateV2TotalPartsProduced();

    } catch (e) {
        console.error("Error fetching add part details:", e);
    }
};

// ============================================================================
// 4. 2D CUT OPTIMIZER (Opens Visual SVG Cutting Map Modal & Shows Endbits)
// ============================================================================
window.openCutOptimizerForV2 = async function() {
    if (!v2BasePart) {
        alert("Please select the Base Part first.");
        return;
    }

    const rmSelect = document.getElementById('v2RmSelect');
    const rmCode = rmSelect ? rmSelect.value : '';
    if (!rmCode) {
        alert("Please select a Raw Material Sheet.");
        return;
    }

    // Extract sheet dimensions (e.g. HR-3-2500-1250)
    const nums = rmCode.match(/\d+(\.\d+)?/g) || [3.0, 2500, 1250];
    const sLen = nums[1] ? parseFloat(nums[1]) : 2500;
    const sWid = nums[2] ? parseFloat(nums[2]) : 1250;
    const sThk = nums[0] ? parseFloat(nums[0]) : v2BasePart.thickness;

    // Populate inputs of cutOptimizerModal
    const slEl = document.getElementById("optSheetLength");
    const swEl = document.getElementById("optSheetWidth");
    const blEl = document.getElementById("optBlankLength");
    const bwEl = document.getElementById("optBlankWidth");
    const plEl = document.getElementById("optPartLabel");

    if (slEl) slEl.value = Math.max(sLen, sWid);
    if (swEl) swEl.value = Math.min(sLen, sWid);
    if (blEl) blEl.value = Math.max(v2BasePart.length, v2BasePart.width);
    if (bwEl) bwEl.value = Math.min(v2BasePart.length, v2BasePart.width);
    if (plEl) plEl.value = v2BasePart.part_no;

    // Show cutOptimizerModal
    const optModal = document.getElementById("cutOptimizerModal");
    if (optModal) optModal.style.display = "flex";

    // Run 2D cut optimization to render SVG interactive cutting map
    if (typeof run2DCutOptimization === 'function') {
        await run2DCutOptimization();
    }

    // Hook the Apply button in cutOptimizerModal to feed back to v2 Create MO
    const applyBtn = document.getElementById("btnApplyCutYield");
    if (applyBtn) {
        applyBtn.onclick = function() {
            applyCutOptimizerToV2Modal();
        };
    }
};

/**
 * Feeds the visual optimizer yield, outputs, and endbits back to Create MO Modal
 */
function applyCutOptimizerToV2Modal() {
    const yieldEl = document.getElementById("optKpiYield");
    const blanksEl = document.getElementById("optKpiBlanks");
    const remnantsEl = document.getElementById("optKpiRemnants");

    let yieldVal = 91.5;
    if (yieldEl) {
        const clean = parseFloat(yieldEl.textContent.replace(/[^0-9.]/g, ''));
        if (!isNaN(clean) && clean > 0) yieldVal = clean;
    }

    let blanksVal = 0;
    if (blanksEl) {
        const clean = parseInt(blanksEl.textContent.replace(/[^0-9]/g, ''), 10);
        if (!isNaN(clean) && clean > 0) blanksVal = clean;
    }

    const remnantText = remnantsEl ? remnantsEl.textContent.trim() : "";

    // Close optimizer modal
    if (typeof closeCutOptimizerModal === 'function') {
        closeCutOptimizerModal();
    } else {
        const m = document.getElementById("cutOptimizerModal");
        if (m) m.style.display = "none";
    }

    // 1. Show results strip in Create MO Modal
    const resBox = document.getElementById("v2OpticutterResults");
    if (resBox) {
        resBox.style.display = "grid";
        document.getElementById("v2OptYield").innerText = `${yieldVal}%`;
        const sheets = parseInt(document.getElementById("v2SheetsInput")?.value || 1, 10);
        const totalP = blanksVal > 0 ? (blanksVal * sheets) : (v2BasePart.offtake * sheets);
        document.getElementById("v2OptPartsProduced").innerText = `${totalP} Nos`;
        v2LastOptimization = { yield_pct: yieldVal, total_parts_produced: totalP };
    }

    // 2. Show End Bits Generated Banner
    const endbitsBanner = document.getElementById("v2EndbitsBanner");
    const endbitsList = document.getElementById("v2EndbitsList");
    if (endbitsBanner && endbitsList) {
        const sheets = parseInt(document.getElementById("v2SheetsInput")?.value || 1, 10);
        const ebCode = `EB-${v2BasePart.grade}-${v2BasePart.thickness}-${remnantText !== 'None' ? remnantText : '600x1250'}`;
        const ebWeight = ((600 * 1250 * v2BasePart.thickness * 0.00000785) || 14.13).toFixed(2);

        endbitsList.innerHTML = `
            <div style="background: #faf5ff; border: 1.5px solid #d8b4fe; border-radius: 6px; padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; width: 100%;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <i class="fa-solid fa-scissors" style="color: #7e22ce; font-size: 1.2rem;"></i>
                    <div>
                        <strong style="color: #581c87; font-size: 0.9rem;">${ebCode}</strong>
                        <p style="margin: 2px 0 0 0; font-size: 0.76rem; color: #7e22ce;">
                            Generated ${sheets} pieces • Weight: ${ebWeight} kg/piece • Reusable Store Batch
                        </p>
                    </div>
                </div>
                <span class="badge" style="background: #16a34a; color: #fff; font-weight: 700; padding: 4px 8px; border-radius: 4px; font-size: 0.75rem;">
                    <i class="fa-solid fa-check"></i> Stock Traceable
                </span>
            </div>
        `;
        endbitsBanner.style.display = "block";

        if (v2LastOptimization) {
            v2LastOptimization.endbit_desc = ebCode;
            v2LastOptimization.total_endbit_weight = (ebWeight * sheets);
        }
    }

    alert(`✅ Visual 2D Layout & Optimization applied (${yieldVal}% Yield)! Endbits recorded.`);
}

// ============================================================================
// 5. SUBMIT MATERIAL ORDER
// ============================================================================
window.submitV2CreateMo = async function(e) {
    e.preventDefault();

    if (!v2BasePart) {
        alert("Please select the Base Part first.");
        return;
    }

    const rmSelect = document.getElementById('v2RmSelect');
    const rmCode = rmSelect ? rmSelect.value : '';
    if (!rmCode) {
        alert("Please select a Raw Material Sheet.");
        return;
    }

    const sheetsCount = parseFloat(document.getElementById('v2SheetsInput')?.value || 1);
    const remarks = document.getElementById('v2RemarksInput')?.value || '';

    const allParts = [v2BasePart, ...v2AdditionalParts.filter(p => p && p.part_no)];

    let partsProduced = [];
    let totalPartsQty = 0;
    let yieldPct = 85.0;
    let endbitDesc = '';
    let endbitWt = 0;

    if (v2LastOptimization) {
        yieldPct = v2LastOptimization.yield_pct;
        totalPartsQty = v2LastOptimization.total_parts_produced;
        endbitDesc = v2LastOptimization.endbit_desc || '';
        endbitWt = v2LastOptimization.total_endbit_weight || 0;
        partsProduced = allParts.map(p => ({
            part_no: p.part_no,
            qty: Math.max(1, p.offtake * sheetsCount)
        }));
    } else {
        partsProduced = allParts.map(p => ({
            part_no: p.part_no,
            qty: Math.max(1, p.offtake * sheetsCount)
        }));
        totalPartsQty = partsProduced.reduce((sum, p) => sum + p.qty, 0);
    }

    const payload = {
        rm_code: rmCode,
        no_of_rm_sheets: sheetsCount,
        parts_produced: partsProduced,
        parts_qty: totalPartsQty,
        endbits: endbitDesc,
        endbit_weight: endbitWt,
        yield_pct: yieldPct,
        remarks: remarks,
        workflow_path: "DIRECT_ERP"
    };

    const submitBtn = document.getElementById('v2BtnSubmitMo');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting MO...';
    }

    try {
        const res = await fetch('/api/v2/create-mo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await res.json();

        if (result.success) {
            alert(`🎉 Material Order ${result.mo_no} created successfully! Live RM stock updated.`);
            closeV2CreateMoModal();
            if (typeof loadOrdersTable === 'function') loadOrdersTable();
            else window.location.reload();
        } else {
            alert(`Failed to create MO: ${result.error || 'Unknown error'}`);
        }
    } catch (err) {
        console.error("Submission error:", err);
        alert(`Error: ${err.message}`);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit Material Order';
        }
    }
};
