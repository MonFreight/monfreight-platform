/**
 * Mon Freight Logistics Management System — Frontend
 * v2.0 — Professional freight forwarding SPA
 */

"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

let shipments = [...(window.SHIPMENTS || [])];

// Filter state from server (set by Jinja2 template)
const _filterStart = window.FILTER_START || "";
const _filterEnd   = window.FILTER_END   || "";

// ── Link-group colour assignment ──────────────────────────────────────────
// Maps link_group integer → CSS class name (lg1…lg8, cycling).
// Rebuilt each time renderTable runs so new groups get colours automatically.
const _LG_CLASSES = ["lg1","lg2","lg3","lg4","lg5","lg6","lg7","lg8"];
let _lgClassMap = {};   // link_group int → CSS class string

// Complete, page-independent map of every link group → its member boxes,
// loaded from /api/links. This lets the link indicator (icon + tooltip)
// stay consistent for ALL linked boxes even when group members fall on
// different pages or are hidden by the current filter.
let _lgFull = {};       // "link_group" → [{id, box_number, batch_date, receiver_name}]

async function loadLinkMap() {
  try {
    const res = await fetch("/api/links");
    if (res.ok) _lgFull = await res.json();
  } catch (_) { /* keep last good map on error */ }
  if (typeof renderTable === "function") renderTable();
}

// Return the full member list for a group (from the complete server map).
function _linkMembers(group) {
  return _lgFull[group] || _lgFull[String(group)] || [];
}

function _buildLgMap(rows) {
  // Colour each group deterministically from the union of all known groups
  // (server map + current page) sorted by id, so a given group always keeps
  // the same colour regardless of which page it appears on.
  const groups = new Set(Object.keys(_lgFull).map(Number).filter(g => !Number.isNaN(g)));
  rows.forEach(r => { if (r.link_group != null) groups.add(Number(r.link_group)); });
  const sorted = [...groups].sort((a, b) => a - b);
  _lgClassMap = {};
  sorted.forEach((g, i) => { _lgClassMap[g] = _LG_CLASSES[i % _LG_CLASSES.length]; });
}

// Default sort matches server-side: batch_date desc, box_number asc secondary.
// User can override by clicking column headers.
let sortKey = "batch_date";
let sortDir = "desc";

// Selections persist across page navigation (server-side pagination reloads
// the page) and the browser tab session via sessionStorage, so users can pick
// shipments from multiple pages without losing earlier selections.
const SELECTION_KEY = "mf_selected_ids";
function _loadSelection() {
  try {
    const raw = sessionStorage.getItem(SELECTION_KEY);
    if (!raw) return [];
    return JSON.parse(raw).map(Number).filter(Number.isFinite);
  } catch (_) { return []; }
}
function persistSelection() {
  try {
    sessionStorage.setItem(SELECTION_KEY, JSON.stringify(Array.from(selectedIds)));
  } catch (_) { /* ignore quota / privacy-mode errors */ }
}
const selectedIds = new Set(_loadSelection());

// ============================================================
// SECTION / PANEL NAVIGATION
// ============================================================

function switchPanel(name) {
  // Deactivate all panels
  $$(".panel").forEach(p => p.classList.remove("active"));
  $$(".topnav a").forEach(a => a.classList.remove("active"));

  const panel = $(`#panel-${name}`);
  if (panel) panel.classList.add("active");

  const link = $(`.topnav a[data-panel="${name}"]`);
  if (link) link.classList.add("active");

  // Lazy-load panel data
  if (name === "dashboard") loadDashboard();
  if (name === "customers") loadCustomers();
  if (name === "reports")   loadReports();
  if (name === "settings")  loadSettings();
  if (name === "activity")  loadActivityPanel();
  if (name === "sms")       loadSMSPanel();
  if (name === "prep" && typeof loadPrep === "function") loadPrep();

  // Sync the labels panel selection state
  if (name === "labels") syncLabelsPanel();

  sessionStorage.setItem("mf_panel", name);
}

// Wire up nav links
$$(".topnav a[data-panel]").forEach(a => {
  a.addEventListener("click", e => {
    e.preventDefault();
    switchPanel(a.dataset.panel);
  });
});

// Restore last panel on page load (default: dashboard)
const _savedPanel = sessionStorage.getItem("mf_panel") || "dashboard";
switchPanel(_savedPanel);

// Quick-action dashboard buttons
$("#importBtn2")?.addEventListener("click", () => {
  openImportModal();
});

// Dashboard refresh button
$("#dashRefreshBtn")?.addEventListener("click", loadDashboard);

// ============================================================
// FORMULA EVALUATOR (client-side preview)
// ============================================================

const FORMULA_RE = /^[\s\d.+\-*/()weightvaluvw]+$/i;

function evalFormula(s, weight = 0, value = 0) {
  if (s === null || s === undefined) return null;
  let str = String(s).trim();
  if (!str) return 0;
  if (str.startsWith("=")) str = str.slice(1);
  if (!isNaN(Number(str))) return Number(str);
  if (!FORMULA_RE.test(str)) throw new Error("Bad characters in formula");
  const expr = str
    .replace(/\bweight\b/g, `(${+weight || 0})`)
    .replace(/\bvalue\b/g, `(${+value || 0})`)
    .replace(/\bw\b/g, `(${+weight || 0})`)
    .replace(/\bv\b/g, `(${+value || 0})`);
  if (!/^[\d.+\-*/()\s]+$/.test(expr)) throw new Error("Unsafe expression");
  const v = Function(`"use strict"; return (${expr});`)(); // eslint-disable-line no-new-func
  if (!Number.isFinite(v)) throw new Error("Bad result");
  return v;
}

// ============================================================
// TOAST / CONFIRM
// ============================================================

function toast(msg, kind = "ok") {
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = String(msg);
  $("#toast").appendChild(t);
  const delay = kind === "err" ? 5500 : 2400;
  setTimeout(() => { t.style.opacity = 0; t.style.transition = "opacity .4s"; }, delay);
  setTimeout(() => t.remove(), delay + 500);
}

function formatServerError(err) {
  if (!err) return "Unknown error";
  if (typeof err === "string") return err;
  if (Array.isArray(err.detail)) {
    return err.detail.map(e => {
      const field = (e.loc || []).slice(1).join(".") || "(field)";
      return `${field}: ${e.msg}`;
    }).join(" · ");
  }
  if (err.detail) return String(err.detail);
  return JSON.stringify(err);
}

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

function customConfirm({ title = "Confirm", message = "Are you sure?",
                         okLabel = "Delete", okClass = "danger" } = {}) {
  return new Promise(resolve => {
    const m = $("#confirmModal");
    $("#confirmTitle").textContent = title;
    $("#confirmMessage").textContent = message;
    const ok = $("#confirmOk");
    ok.textContent = okLabel;
    ok.className = `btn ${okClass}`;
    m.classList.remove("hidden");
    function cleanup(v) {
      m.classList.add("hidden");
      ok.removeEventListener("click", onOk);
      $("#confirmCancel").removeEventListener("click", onCancel);
      resolve(v);
    }
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    ok.addEventListener("click", onOk);
    $("#confirmCancel").addEventListener("click", onCancel);
  });
}

// ============================================================
// PRINT / LABEL CHOOSER
// ============================================================

function printXlsxInBrowser(url) {
  const htmlUrl = url.replace(/(\?|$)/, ".html$1");
  const win = window.open(htmlUrl, "_blank");
  if (!win) toast("Browser blocked the print window — please allow pop-ups for this site.", "err");
}

function chooseLabelTemplate(scopeText = "this label") {
  return new Promise(resolve => {
    const m = $("#printChooserModal");
    if (!m) { resolve("html"); return; }
    $("#printChooserScope").textContent = scopeText;
    m.classList.remove("hidden");

    const buttons = $$(".chooser-btn", m);
    const close   = $("#printChooserClose");
    const cancel  = $("#printChooserCancel");

    function cleanup(choice) {
      m.classList.add("hidden");
      buttons.forEach(b => b.removeEventListener("click", onPick));
      close.removeEventListener("click", onCancel);
      cancel.removeEventListener("click", onCancel);
      m.removeEventListener("click", onBackdrop);
      resolve(choice);
    }
    const onPick = e => cleanup(e.currentTarget.dataset.choice);
    const onCancel = () => cleanup(null);
    const onBackdrop = e => { if (e.target === m) cleanup(null); };

    buttons.forEach(b => b.addEventListener("click", onPick));
    close.addEventListener("click", onCancel);
    cancel.addEventListener("click", onCancel);
    m.addEventListener("click", onBackdrop);
  });
}

// ============================================================
// FORMAT HELPERS
// ============================================================

const fmt0  = n => Number(n || 0).toLocaleString("en-AU", { maximumFractionDigits: 0 });
const fmt2  = n => Number(n || 0).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoney = n => "$" + fmt2(n);

// ============================================================
// STATS BAR
// ============================================================

function recomputeStats(rows) {
  const boxes  = rows.length;
  const weight = rows.reduce((a, r) => a + Number(r.weight || 0), 0);
  const value  = rows.reduce((a, r) => a + Number(r.declared_value || 0), 0);
  const total  = rows.reduce((a, r) => a + Number(r.total_aud || 0), 0);
  const paid   = rows.filter(r => r.paid).reduce((a, r) => a + Number(r.total_aud || 0), 0);
  $("#statBoxes").textContent  = fmt0(boxes);
  $("#statWeight").textContent = fmt2(weight);
  $("#statValue").textContent  = fmtMoney(value);
  $("#statPrice").textContent  = fmtMoney(total);
  $("#statPaid").textContent   = fmtMoney(paid);
  $("#statUnpaid").textContent = fmtMoney(total - paid);
  $("#rowCount").textContent   = `${boxes} shipment${boxes === 1 ? "" : "s"}`;
}

// ============================================================
// SORT
// ============================================================

function compare(a, b, key) {
  const av = a[key]; const bv = b[key];
  if (key === "paid") return (av === bv) ? 0 : (av ? 1 : -1);
  // Always use numeric comparison for box_number (prevents "10" sorting before "2")
  if (key === "box_number") return (Number(av) || 0) - (Number(bv) || 0);
  if (typeof av === "number" || typeof bv === "number")
    return (Number(av) || 0) - (Number(bv) || 0);
  return String(av || "").localeCompare(String(bv || ""));
}
function sortRows(rows) {
  return [...rows].sort((a, b) => {
    // Primary sort (user-selected key + direction)
    let r = compare(a, b, sortKey);
    if (sortDir === "desc") r = -r;
    if (r !== 0) return r;
    // Secondary: always box_number ascending (natural numeric order within batch)
    if (sortKey !== "box_number") {
      const boxCmp = (Number(a.box_number) || 0) - (Number(b.box_number) || 0);
      if (boxCmp !== 0) return boxCmp;
    }
    // Tertiary: batch_date descending (most recent batch first)
    if (sortKey !== "batch_date") {
      return -String(a.batch_date || "").localeCompare(String(b.batch_date || ""));
    }
    return 0;
  });
}
function updateSortIndicators() {
  $$("th.sortable").forEach(th => {
    th.classList.remove("asc", "desc");
    if (th.dataset.sort === sortKey) th.classList.add(sortDir);
  });
}

// ============================================================
// RENDER SHIPMENTS TABLE
// ============================================================

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
const escapeAttr = escapeHtml;

function renderTable() {
  const tbody = $("#shipTable tbody");
  tbody.innerHTML = "";
  const rows = sortRows(shipments);
  if (rows.length === 0) $("#emptyMsg").classList.remove("hidden");
  else                   $("#emptyMsg").classList.add("hidden");

  // Build link_group → related box numbers map for tooltips.
  // Prefer the complete server-side map so the tooltip lists EVERY box in the
  // group (even ones on other pages); fall back to current-page rows.
  _buildLgMap(rows);
  const _lgBoxLabels = {};  // link_group → ["BOX 1", "BOX 2", …]
  for (const [g, members] of Object.entries(_lgFull)) {
    _lgBoxLabels[g] = members.map(m => `BOX ${m.box_number}`);
  }
  for (const r of rows) {
    if (r.link_group == null) continue;
    if (!_lgBoxLabels[r.link_group]) _lgBoxLabels[r.link_group] = [];
    if (!_lgBoxLabels[r.link_group].includes(`BOX ${r.box_number}`)) {
      _lgBoxLabels[r.link_group].push(`BOX ${r.box_number}`);
    }
  }

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.dataset.id = r.id;
    if (r.paid) tr.classList.add("paid");
    if (selectedIds.has(r.id)) tr.classList.add("selected");
    // Apply link-group colour class
    if (r.link_group != null && _lgClassMap[r.link_group]) {
      tr.classList.add(_lgClassMap[r.link_group]);
    }

    // Build link badge for the Box column
    let linkBadge = "";
    if (r.link_group != null) {
      const cls = _lgClassMap[r.link_group] || "";
      // Tooltip shows the OTHER boxes in the group, not the current one
      const others = (_lgBoxLabels[r.link_group] || []).filter(label => label !== `BOX ${r.box_number}`).join(", ");
      const tipText = others ? `Linked with: ${others} (click to highlight)` : "Linked box";
      linkBadge = `<span class="link-badge" data-link-group="${r.link_group}" role="button" tabindex="0" style="background:var(--${cls});color:var(--${cls}b);border:1px solid var(--${cls}b)" title="${escapeAttr(tipText)}" aria-label="${escapeAttr(tipText)}"></span>`;
    }

    tr.innerHTML = `
      <td class="cb-col"><input type="checkbox" class="row-cb" ${selectedIds.has(r.id) ? "checked" : ""}></td>
      <td><span class="ed" data-field="batch_date" data-type="date">${r.batch_date}</span></td>
      <td>BOX ${r.box_number}${linkBadge}</td>
      <td class="mf-num">${r.mf_number}</td>
      <td><strong>${escapeHtml(r.sender_name)}</strong>
          <div class="muted small">${escapeHtml(r.sender_phone || "")}</div></td>
      <td><strong>${escapeHtml(r.receiver_name)}</strong>
          <div class="muted small">${escapeHtml(r.receiver_city || "")}${r.receiver_city && r.receiver_phone ? " · " : ""}${escapeHtml(r.receiver_phone || "")}</div></td>
      <td>${escapeHtml(r.description || "")}</td>
      <td class="num">${fmt2(r.declared_value)}</td>
      <td class="num"><span class="ed" data-field="weight" data-type="number">${fmt2(r.weight)}</span></td>
      <td class="num">
        <span class="ed" data-field="price" data-type="formula">${fmt2(r.price_aud)}</span>
        ${r.price_formula ? `<span class="formula" title="${escapeAttr(r.price_formula)}">${escapeHtml(r.price_formula)}</span>` : ""}
      </td>
      <td class="num"><span class="ed" data-field="extra">${fmt2(r.extra_charges)}</span></td>
      <td class="num"><strong>${fmt2(r.total_aud)}</strong></td>
      <td><span class="paid-pill ${r.paid ? "yes" : "no"}" data-field="paid">${r.paid ? "✓ Paid" : "Unpaid"}</span></td>
      <td class="rowbtns">
        <button class="btn small" data-act="print" title="Print / view label">🖨</button>
        <a class="btn small" href="/shipments/${r.id}/label.xlsx" title="Download label as Excel">📥</a>
        <button class="btn small" data-act="edit" title="Edit shipment">✏</button>
        <button class="btn small danger" data-act="delete" title="Delete shipment">✕</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
  // Summary bar:
  //  • When a Batch Date / date range / search filter is active, always show
  //    the COMPLETE totals for that batch (all pages) via loadBatchStats().
  //    This must run on every render — including the 15s background poll — so
  //    the full batch summary never reverts to a current-page-only summary.
  //  • With no filter active, fall back to the current-page summary.
  if (window.FILTER_START || window.FILTER_END || window.SEARCH_Q) {
    loadBatchStats();
  } else {
    recomputeStats(rows);
  }
  updateSortIndicators();
  updateSelectionUI();
}

// ============================================================
// SELECTION & BULK ACTIONS
// ============================================================

function updateSelectionUI() {
  persistSelection();
  const n = selectedIds.size;

  // Shipments panel buttons
  ["printSelectedBtn","deleteSelectedBtn","excelSelectedBtn"].forEach(id => {
    const b = $(`#${id}`);
    if (!b) return;
    b.disabled = n === 0;
    const label = id === "printSelectedBtn" ? "Print Selected" :
                  id === "excelSelectedBtn" ? "Excel Selected" : "Delete Selected";
    b.textContent = `${label} (${n})`;
  });


  // Labels panel buttons
  const lpsb = $("#labelPrintSelectedBtn");
  const lesb = $("#labelExcelSelectedBtn");
  if (lpsb) lpsb.disabled = n === 0;
  if (lesb) lesb.disabled = n === 0;

  const selInfo = $("#labelSelectionInfo");
  if (selInfo) {
    selInfo.textContent = n === 0
      ? "No shipments selected. Go to the Shipments tab to select some."
      : `${n} shipment${n === 1 ? "" : "s"} selected.`;
    selInfo.className = n > 0 ? "small" : "muted small";
  }

  const sa = $("#selectAll");
  if (!sa) return;
  const visibleCbs = $$(".row-cb", $("#shipTable tbody"));
  const visibleIds = visibleCbs.map(cb => +cb.closest("tr").dataset.id);
  const allSel  = visibleCbs.length > 0 && visibleIds.every(i => selectedIds.has(i));
  const someSel = visibleIds.some(i => selectedIds.has(i));
  sa.checked = allSel;
  sa.indeterminate = !allSel && someSel;
  updateSelectionTotals();
}

function updateSelectionTotals() {
  const bar = $("#selectionBar");
  if (!bar) return;
  const n = selectedIds.size;
  if (n === 0) { bar.classList.add("hidden"); return; }
  const sel = shipments.filter(r => selectedIds.has(r.id));
  const weight  = sel.reduce((a, r) => a + Number(r.weight   || 0), 0);
  const freight = sel.reduce((a, r) => a + Number(r.total_aud || 0), 0);
  const paid    = sel.filter(r => r.paid).reduce((a, r) => a + Number(r.total_aud || 0), 0);
  bar.classList.remove("hidden");
  bar.innerHTML =
    `<strong>${n} row${n === 1 ? "" : "s"} selected</strong>` +
    ` &nbsp;·&nbsp; Weight: <strong>${fmt2(weight)} kg</strong>` +
    ` &nbsp;·&nbsp; Freight: <strong>${fmtMoney(freight)}</strong>` +
    ` &nbsp;·&nbsp; Paid: <strong>${fmtMoney(paid)}</strong>` +
    ` &nbsp;·&nbsp; Outstanding: <strong>${fmtMoney(freight - paid)}</strong>` +
    ` <button class="btn ghost small" style="margin-left:auto" onclick="selectedIds.clear();renderTable();">✕ Clear</button>`;
}

function syncLabelsPanel() { updateSelectionUI(); }

document.addEventListener("change", e => {
  if (e.target.matches(".row-cb")) {
    const tr = e.target.closest("tr");
    const id = +tr.dataset.id;
    if (e.target.checked) selectedIds.add(id);
    else selectedIds.delete(id);
    tr.classList.toggle("selected", e.target.checked);
    updateSelectionUI();
  } else if (e.target.id === "selectAll") {
    const cbs = $$(".row-cb", $("#shipTable tbody"));
    cbs.forEach(cb => {
      const id = +cb.closest("tr").dataset.id;
      cb.checked = e.target.checked;
      cb.closest("tr").classList.toggle("selected", e.target.checked);
      if (e.target.checked) selectedIds.add(id);
      else selectedIds.delete(id);
    });
    updateSelectionUI();
  }
});

// Print selected (from shipments panel)
$("#printSelectedBtn")?.addEventListener("click", async () => {
  if (selectedIds.size === 0) return;
  const orderedIds = sortRows(shipments.filter(r => selectedIds.has(r.id))).map(r => r.id);
  const n = orderedIds.length;
  const choice = await chooseLabelTemplate(`${n} selected label${n === 1 ? "" : "s"}`);
  if (!choice) return;
  if (choice === "html") window.open(`/labels/by-ids?ids=${orderedIds.join(",")}`, "_blank");
  else printXlsxInBrowser(`/labels/by-ids.xlsx?ids=${orderedIds.join(",")}`);
});

// Excel selected (from shipments panel)
$("#excelSelectedBtn")?.addEventListener("click", () => {
  if (selectedIds.size === 0) return;
  const orderedIds = sortRows(shipments.filter(r => selectedIds.has(r.id))).map(r => r.id);
  window.location = `/labels/by-ids.xlsx?ids=${orderedIds.join(",")}`;
});

// Delete selected (from shipments panel)
$("#deleteSelectedBtn")?.addEventListener("click", async () => {
  if (selectedIds.size === 0) return;
  const ids = Array.from(selectedIds);
  const ok = await customConfirm({
    title: "Delete Selected Shipments",
    message: `Permanently delete ${ids.length} selected shipment${ids.length === 1 ? "" : "s"}? This cannot be undone.`,
    okLabel: "Delete Selected",
  });
  if (!ok) return;
  const res = await fetch("/api/shipments/bulk-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) {
    const err = await safeJson(res);
    toast("Delete failed — " + formatServerError(err), "err");
    return;
  }
  shipments = shipments.filter(r => !selectedIds.has(r.id));
  selectedIds.clear();
  renderTable();
  toast("Selected shipments deleted.");
});

// ── Edit modal: linked boxes section ─────────────────────────────────────
let _editingShipId = null;

function _applyLinkLocally(ids, newGroup) {
  // ids: selected ids, newGroup: returned link_group from server
  // Also update any pre-existing group members that got merged
  const mergedGroups = new Set(
    ids.map(id => shipments.find(r => r.id === id)?.link_group).filter(g => g != null)
  );
  shipments.forEach(r => {
    if (ids.includes(r.id) || mergedGroups.has(r.link_group)) r.link_group = newGroup;
  });
  loadLinkMap();   // refresh the complete link map so indicators stay accurate
}

function _applyUnlinkLocally(ids) {
  const affectedGroups = new Set(
    ids.map(id => shipments.find(r => r.id === id)?.link_group).filter(g => g != null)
  );
  shipments.forEach(r => {
    if (ids.includes(r.id)) { r.link_group = null; return; }
    if (affectedGroups.has(r.link_group)) {
      const mates = shipments.filter(x => x.link_group === r.link_group && !ids.includes(x.id));
      if (mates.length === 1) r.link_group = null;
    }
  });
  loadLinkMap();   // refresh the complete link map so indicators stay accurate
}

async function renderEditLinkSection() {
  const chipsDiv = $("#editLinkedChips");
  const select   = $("#editLinkSelect");
  if (!chipsDiv || !select) return;

  const ship = shipments.find(r => r.id === _editingShipId);
  if (!ship) return;

  _buildLgMap(shipments);  // ensure colour map is current

  // ── chips: current linked boxes ───────────────────────────────────────
  chipsDiv.innerHTML = "";
  // Fetch all boxes for this batch date so chips and dropdown are complete
  let batchBoxes = [];
  try {
    const res = await fetch(`/api/shipments?start=${ship.batch_date}&end=${ship.batch_date}`);
    if (res.ok) batchBoxes = await res.json();
  } catch { batchBoxes = shipments.filter(r => r.batch_date === ship.batch_date); }

  // Merge API data into local shipments for link_group accuracy
  batchBoxes.forEach(remote => {
    const local = shipments.find(r => r.id === remote.id);
    if (local) Object.assign(local, remote);
  });
  _buildLgMap(shipments);

  const linked = ship.link_group != null
    ? batchBoxes.filter(r => r.link_group === ship.link_group && r.id !== ship.id)
    : [];

  if (linked.length === 0) {
    chipsDiv.innerHTML = '<span class="muted small" style="line-height:26px;">No linked boxes yet.</span>';
  } else {
    const cls = _lgClassMap[ship.link_group] || "lg1";
    linked
      .sort((a, b) => a.box_number - b.box_number)
      .forEach(r => {
        const chip = document.createElement("span");
        chip.className = "link-chip";
        chip.style.cssText = `background:var(--${cls});color:var(--${cls}b);border-color:var(--${cls}b)`;
        chip.innerHTML = `🔗 BOX ${r.box_number} · ${r.receiver_name || ""}` +
          `<button class="link-chip-remove" type="button" data-remove-id="${r.id}" title="Remove this link">×</button>`;
        chipsDiv.appendChild(chip);
      });
  }

  // ── dropdown: same-batch boxes not already linked ─────────────────────
  const linkedIds = ship.link_group != null
    ? new Set(batchBoxes.filter(r => r.link_group === ship.link_group).map(r => r.id))
    : new Set([ship.id]);

  select.innerHTML = '<option value="">— select a box to link with —</option>';
  batchBoxes
    .filter(r => !linkedIds.has(r.id))
    .sort((a, b) => a.box_number - b.box_number)
    .forEach(r => {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = `BOX ${r.box_number}  ·  ${r.receiver_name || "—"}`;
      select.appendChild(opt);
    });
}

// Chip remove clicks (delegated)
document.addEventListener("click", async e => {
  const btn = e.target.closest(".link-chip-remove");
  if (!btn) return;
  const removeId = +btn.dataset.removeId;
  const res = await fetch("/api/shipments/unlink", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [removeId] }),
  });
  if (!res.ok) { toast("Unlink failed.", "err"); return; }
  _applyUnlinkLocally([removeId]);
  renderEditLinkSection();
  renderTable();
});

// Add link from edit modal
$("#editLinkAddBtn")?.addEventListener("click", async () => {
  const sel = $("#editLinkSelect");
  const targetId = +sel.value;
  if (!targetId) { toast("Please select a box to link with.", "err"); return; }
  const targetLabel = sel.options[sel.selectedIndex]?.text || `ID ${targetId}`;
  const res = await fetch("/api/shipments/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [_editingShipId, targetId] }),
  });
  if (!res.ok) { toast("Link failed.", "err"); return; }
  const data = await res.json();
  _applyLinkLocally([_editingShipId, targetId], data.link_group);
  renderEditLinkSection();
  renderTable();
  toast(`Linked with ${targetLabel}.`);
});

// ── Post-create link modal ────────────────────────────────────────────────
let _justCreatedId = null;

async function _populateLinkAfterCreate(createdShip) {
  _justCreatedId = createdShip.id;
  const msg    = $("#linkAfterCreateMsg");
  const select = $("#linkAfterCreateSelect");
  if (!msg || !select) return;
  msg.textContent = `BOX ${createdShip.box_number} saved. Would you like to link it with another box from the same batch (${createdShip.batch_date})?`;

  // Fetch all boxes for this batch date
  let batchBoxes = [];
  try {
    const res = await fetch(`/api/shipments?start=${createdShip.batch_date}&end=${createdShip.batch_date}`);
    if (res.ok) batchBoxes = await res.json();
  } catch { batchBoxes = shipments.filter(r => r.batch_date === createdShip.batch_date); }

  select.innerHTML = '<option value="">— select a box —</option>';
  batchBoxes
    .filter(r => r.id !== createdShip.id)
    .sort((a, b) => a.box_number - b.box_number)
    .forEach(r => {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = `BOX ${r.box_number}  ·  ${r.receiver_name || "—"}`;
      select.appendChild(opt);
    });

  if (batchBoxes.filter(r => r.id !== createdShip.id).length === 0) {
    // No other boxes in this batch — skip the modal
    return;
  }
  $("#linkAfterCreateModal").classList.remove("hidden");
}

function _closeLinkAfterCreate() {
  $("#linkAfterCreateModal")?.classList.add("hidden");
  _justCreatedId = null;
}

["#linkAfterCreateClose", "#linkAfterCreateSkip"].forEach(sel =>
  document.querySelector(sel)?.addEventListener("click", _closeLinkAfterCreate)
);

$("#linkAfterCreateConfirm")?.addEventListener("click", async () => {
  const sel = $("#linkAfterCreateSelect");
  const targetId = +sel.value;
  if (!targetId) { toast("Please select a box to link with.", "err"); return; }
  const targetLabel = sel.options[sel.selectedIndex]?.text || `ID ${targetId}`;
  const res = await fetch("/api/shipments/link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [_justCreatedId, targetId] }),
  });
  if (!res.ok) { toast("Link failed.", "err"); return; }
  const data = await res.json();
  _applyLinkLocally([_justCreatedId, targetId], data.link_group);
  renderTable();
  const src = shipments.find(r => r.id === _justCreatedId);
  toast(`BOX ${src?.box_number} linked with ${targetLabel}.`);
  _closeLinkAfterCreate();
});

// Labels panel buttons (mirror to shipments-panel actions)
$("#labelPrintSelectedBtn")?.addEventListener("click", async () => {
  if (selectedIds.size === 0) { toast("No shipments selected — go to Shipments and select some first.", "err"); return; }
  const orderedIds = sortRows(shipments.filter(r => selectedIds.has(r.id))).map(r => r.id);
  const n = orderedIds.length;
  const choice = await chooseLabelTemplate(`${n} selected label${n === 1 ? "" : "s"}`);
  if (!choice) return;
  if (choice === "html") window.open(`/labels/by-ids?ids=${orderedIds.join(",")}`, "_blank");
  else printXlsxInBrowser(`/labels/by-ids.xlsx?ids=${orderedIds.join(",")}`);
});

$("#labelExcelSelectedBtn")?.addEventListener("click", () => {
  if (selectedIds.size === 0) { toast("No shipments selected.", "err"); return; }
  const orderedIds = sortRows(shipments.filter(r => selectedIds.has(r.id))).map(r => r.id);
  window.location = `/labels/by-ids.xlsx?ids=${orderedIds.join(",")}`;
});

// ============================================================
// ENTRY-ROW TOTAL AUTO-COMPUTE
// ============================================================

function entryComputeTotal() {
  const f = $("#newForm");
  const w   = +f.elements["weight"].value || 0;
  const ext = +f.elements["extra_charges"].value || 0;
  const priceStr = (f.elements["price_input"].value || "").trim();
  let price = 0;
  if (priceStr) {
    if (priceStr.startsWith("=")) {
      try { price = evalFormula(priceStr, w, +f.elements["declared_value"].value || 0); }
      catch (_) { price = 0; }
    } else { price = +priceStr || 0; }
  }
  const total = w * price + ext;
  f.elements["total_display"].value = total ? total.toFixed(2) : "";
}

$("#newForm").addEventListener("input", e => {
  if (["weight","price_input","declared_value","extra_charges"].includes(e.target.name))
    entryComputeTotal();
});

// ============================================================
// NEW SHIPMENT — SUBMIT
// ============================================================

$("#newForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const fd  = new FormData(e.target);
    const obj = Object.fromEntries(fd.entries());
    const priceInput = (obj.price_input || "").trim();
    let price = 0, formula = "";
    if (priceInput.startsWith("=")) {
      formula = priceInput;
      try { price = evalFormula(priceInput, +obj.weight || 0, +obj.declared_value || 0); }
      catch (err) { toast("Bad formula: " + err.message, "err"); return; }
    } else { price = parseFloat(priceInput) || 0; }

    const bd = (obj.batch_date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bd)) {
      toast(`Batch date is invalid: "${bd}". Please re-pick from the calendar.`, "err");
      return;
    }

    let boxNumber = null;
    const boxRaw = (obj.box_number || "").trim();
    if (boxRaw !== "") {
      const n = parseInt(boxRaw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        toast(`Box number must be a positive whole number, got "${boxRaw}".`, "err");
        return;
      }
      boxNumber = n;
    }

    const payload = {
      ...obj,
      box_number:     boxNumber,
      declared_value: parseFloat(obj.declared_value) || 0,
      weight:         parseFloat(obj.weight) || 0,
      price_formula:  formula,
      price_aud:      price,
      extra_charges:  parseFloat(obj.extra_charges) || 0,
      paid:           !!obj.paid,
    };
    delete payload.price_input;
    delete payload.total_display;

    const res = await fetch("/api/shipments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await safeJson(res);
      toast("Add failed — " + formatServerError(err), "err");
      return;
    }
    const created = await res.json();
    shipments.push(created);
    renderTable();
    const keepDate = obj.batch_date;
    e.target.reset();
    e.target.batch_date.value = keepDate;
    e.target.sender_country.value  = "Австрали";
    e.target.receiver_country.value = "Монгол";
    entryComputeTotal();
    e.target.sender_name.focus();
    toast(`BOX ${created.box_number} (${created.mf_number}) added.`);
    // Prompt user to link this new box with another
    _populateLinkAfterCreate(created);
  } catch (err) {
    toast("Submit failed: " + err.message, "err");
  }
});

// ============================================================
// TABLE INTERACTIONS
// ============================================================

const tableBody = $("#shipTable tbody");

// Highlight every box that shares a link group, list them, and flag any that
// live on other pages. Driven by the complete /api/links map so it works for
// all linked boxes throughout the system, not just the current page.
function highlightLinkGroup(group) {
  if (group == null || group === "") return;
  const members = _linkMembers(group);
  const memberIds = new Set(members.map(m => m.id));
  const trs = $$("#shipTable tbody tr");
  trs.forEach(tr => tr.classList.remove("link-flash"));
  let onPage = 0, firstEl = null;
  trs.forEach(tr => {
    if (memberIds.has(+tr.dataset.id)) {
      tr.classList.add("link-flash");
      onPage++;
      if (!firstEl) firstEl = tr;
    }
  });
  if (firstEl) firstEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  const labels = members.map(m => `BOX ${m.box_number}`).join(", ");
  const msg = labels ? `Linked boxes: ${labels}` : "This box is linked.";
  const offPage = members.length - onPage;
  toast(offPage > 0 ? `${msg} · ${offPage} on other page${offPage === 1 ? "" : "s"}` : msg, "ok");
  setTimeout(() => $$("#shipTable tbody tr").forEach(tr => tr.classList.remove("link-flash")), 3000);
}

// Keyboard activation for the focusable link badge (Enter / Space)
tableBody.addEventListener("keydown", e => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const badge = e.target.closest?.(".link-badge");
  if (!badge) return;
  e.preventDefault();
  highlightLinkGroup(badge.dataset.linkGroup);
});

tableBody.addEventListener("click", async e => {
  const tr = e.target.closest("tr"); if (!tr) return;
  const id = +tr.dataset.id;

  // Link badge → show & highlight all boxes linked together in this group
  const badge = e.target.closest(".link-badge");
  if (badge) { highlightLinkGroup(badge.dataset.linkGroup); return; }

  // Paid pill toggle
  const pill = e.target.closest(".paid-pill");
  if (pill) {
    const ship = shipments.find(s => s.id === id);
    const newVal = !ship.paid;
    const r = await patchShipment(id, { paid: newVal });
    if (r) { Object.assign(ship, r); renderTable(); toast(newVal ? "Marked as Paid" : "Marked as Unpaid"); }
    return;
  }

  // Action buttons
  const btn = e.target.closest("button[data-act]");
  if (btn) {
    const ship = shipments.find(s => s.id === id);
    if (!ship) return;
    if (btn.dataset.act === "print") {
      const scope = `BOX ${ship.box_number} (${ship.mf_number})`;
      const choice = await chooseLabelTemplate(scope);
      if (!choice) return;
      if (choice === "html") window.open(`/shipments/${ship.id}/label`, "_blank");
      else printXlsxInBrowser(`/shipments/${ship.id}/label.xlsx`);
      return;
    }
    if (btn.dataset.act === "edit") { openEdit(ship); return; }
    if (btn.dataset.act === "delete") {
      const ok = await customConfirm({
        title: "Delete Shipment",
        message: `Permanently delete BOX ${ship.box_number} (${ship.mf_number}) from ${ship.batch_date}? This cannot be undone.`,
        okLabel: "Delete",
      });
      if (!ok) return;
      const res = await fetch(`/api/shipments/${id}`, { method: "DELETE" });
      if (res.ok) { shipments = shipments.filter(s => s.id !== id); renderTable(); toast("Shipment deleted."); }
      else toast("Delete failed.", "err");
    }
    return;
  }

  // Checkbox itself — handled by the change event; skip here
  if (e.target.matches("input.row-cb")) return;

  // Download link — let browser handle
  if (e.target.closest("a")) return;

  // Single click anywhere else on the row → toggle selection
  const cb = tr.querySelector(".row-cb");
  if (!cb) return;
  cb.checked = !cb.checked;
  if (cb.checked) selectedIds.add(id);
  else            selectedIds.delete(id);
  tr.classList.toggle("selected", cb.checked);
  updateSelectionUI();
});

tableBody.addEventListener("dblclick", e => {
  const tr = e.target.closest("tr"); if (!tr) return;
  const id = +tr.dataset.id;
  const ship = shipments.find(s => s.id === id); if (!ship) return;

  // On editable cell → inline edit (existing behaviour)
  const ed = e.target.closest(".ed");
  if (ed && !ed.classList.contains("editing")) { startInlineEdit(ed); return; }

  // On button / link / pill / checkbox → ignore
  if (e.target.closest("button, a, input, .paid-pill, .link-badge")) return;

  // Double-click anywhere else on row → open full edit modal
  openEdit(ship);
});

function startInlineEdit(ed) {
  const tr  = ed.closest("tr");
  const id  = +tr.dataset.id;
  const ship = shipments.find(s => s.id === id);
  const field = ed.dataset.field;
  const type  = ed.dataset.type;
  const old   = ed.textContent;
  ed.classList.add("editing");
  let val = "";
  if (field === "price")      val = ship.price_formula || ship.price_aud;
  else if (field === "batch_date") val = ship.batch_date;
  else if (field === "extra") val = ship.extra_charges;
  else if (field === "weight") val = ship.weight;
  ed.innerHTML = `<input ${type === "date" ? 'type="text"' : ""} value="${escapeAttr(val)}">`;
  const inp = ed.querySelector("input");
  if (field === "batch_date" && window.flatpickr) {
    flatpickr(inp, {
      dateFormat: "Y-m-d", defaultDate: val, locale: { firstDayOfWeek: 1 },
      onClose: () => finish(true),
    });
  }
  inp.focus(); inp.select();

  const finish = async (commit) => {
    if (!commit) { ed.textContent = old; ed.classList.remove("editing"); return; }
    const newVal = inp.value;
    let body = {};
    if (field === "batch_date") body.batch_date = newVal;
    else if (field === "price") body.price_formula = String(newVal);
    else if (field === "extra") body.extra_charges = parseFloat(newVal) || 0;
    else if (field === "weight") body.weight = parseFloat(newVal) || 0;
    const r = await patchShipment(id, body);
    if (r) { Object.assign(ship, r); renderTable(); toast("Saved."); }
    else   { ed.textContent = old; ed.classList.remove("editing"); }
  };
  inp.addEventListener("keydown", ke => {
    if (ke.key === "Enter")  { ke.preventDefault(); finish(true); }
    if (ke.key === "Escape") finish(false);
  });
  inp.addEventListener("blur", () => { if (field !== "batch_date") finish(true); });
}

async function patchShipment(id, body) {
  const res = await fetch(`/api/shipments/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await safeJson(res);
    toast("Update failed — " + formatServerError(err), "err");
    return null;
  }
  return res.json();
}

// ============================================================
// SORT HEADERS
// ============================================================

$$(".dataTable th.sortable").forEach(th => {
  th.addEventListener("click", () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir = sortDir === "asc" ? "desc" : "asc";
    else { sortKey = k; sortDir = k === "batch_date" ? "desc" : "asc"; }
    renderTable();
  });
});

// ============================================================
// FILTER / SEARCH
// ============================================================

$("#filterApply").addEventListener("click", () => {
  const start = $("#filterStart").value || $("#exportDate").value;
  const end   = $("#filterEnd").value   || $("#exportDate").value;
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end)   params.set("end",   end);
  window.location = "/?" + params;
});
$("#filterClear").addEventListener("click", () => { window.location = "/"; });

// ============================================================
// EXPORT BUTTONS (Shipments panel)
// ============================================================

function rebuildExportLinks(d) {
  d = d || $("#exportDate")?.value;
  const buttons = [
    ["#aircargoBtn",   "/batches/__D__/aircargo.xlsx"],
    ["#labelsXlsxBtn", "/batches/__D__/labels.xlsx"],
    ["#labelsAllBtn",  "/batches/__D__/labels.html"],
  ];
  buttons.forEach(([sel, tmpl]) => {
    const el = $(sel);
    if (!el) return;
    if (!d) { el.removeAttribute("href"); el.classList.add("disabled"); }
    else    { el.href = tmpl.replace("__D__", d); el.classList.remove("disabled"); }
  });
}

$("#exportDate")?.addEventListener("change", () => rebuildExportLinks());

["#aircargoBtn","#labelsXlsxBtn"].forEach(sel => {
  const el = $(sel);
  if (!el) return;
  el.addEventListener("click", e => {
    if (!el.getAttribute("href")) { e.preventDefault(); toast("Please pick an export batch date first.", "err"); }
  });
});

$("#labelsAllBtn")?.addEventListener("click", async e => {
  const d = $("#exportDate")?.value;
  if (!d) return;
  e.preventDefault();
  const choice = await chooseLabelTemplate(`all labels for ${d}`);
  if (!choice) return;
  if (choice === "html") window.open(`/batches/${d}/labels.html`, "_blank");
  else printXlsxInBrowser(`/batches/${d}/labels.xlsx`);
});

// ============================================================
// LABELS PANEL — BATCH EXPORT BUTTONS
// ============================================================

function rebuildLabelPanelLinks(d) {
  d = d || $("#labelBatchDate")?.value;
  const defs = [
    ["#labelAircargoBtn",   "/batches/__D__/aircargo.xlsx"],
    ["#labelLabelsXlsxBtn", "/batches/__D__/labels.xlsx"],
    ["#labelPrintAllBtn",   "/batches/__D__/labels.html"],
  ];
  defs.forEach(([sel, tmpl]) => {
    const el = $(sel);
    if (!el) return;
    if (!d) { el.removeAttribute("href"); el.classList.add("disabled"); }
    else    { el.href = tmpl.replace("__D__", d); el.classList.remove("disabled"); }
  });
}

$("#labelBatchDate") && flatpickr && (() => {
  // Init after flatpickr loads
  window.addEventListener("load", () => {
    if (!window.flatpickr) return;
    flatpickr($("#labelBatchDate"), {
      dateFormat: "Y-m-d",
      altInput: true,
      altFormat: "D, j M Y",
      locale: { firstDayOfWeek: 1 },
      allowInput: true,
      onChange: (_, dateStr) => rebuildLabelPanelLinks(dateStr),
    });
    rebuildLabelPanelLinks();
  });
})();

$("#labelPrintAllBtn")?.addEventListener("click", async e => {
  const d = $("#labelBatchDate")?.value;
  if (!d) { e.preventDefault(); toast("Please pick a batch date first.", "err"); return; }
  e.preventDefault();
  const choice = await chooseLabelTemplate(`all labels for ${d}`);
  if (!choice) return;
  if (choice === "html") window.open(`/batches/${d}/labels.html`, "_blank");
  else printXlsxInBrowser(`/batches/${d}/labels.xlsx`);
});

// ============================================================
// EDIT MODAL
// ============================================================

const editModal = $("#editModal");
const editForm  = $("#editForm");

function openEdit(ship) {
  _editingShipId = ship.id;
  editForm.id.value = ship.id;
  $("#editTitle").textContent = `BOX ${ship.box_number} · ${ship.mf_number}`;
  for (const [k, v] of Object.entries(ship)) {
    const f = editForm.elements[k];
    if (!f) continue;
    if (f.type === "checkbox") f.checked = !!v;
    else f.value = v ?? "";
  }
  // Batch Date is a flatpickr picker with a separate visible (alt) input, so
  // setting .value directly above does NOT update what the user sees or the
  // picker's selected day. Push the shipment's existing batch date through
  // flatpickr's API so the assigned date loads, displays, and stays selected
  // unless the user intentionally picks a different one.
  const bdInput = editForm.elements["batch_date"];
  if (bdInput) {
    if (bdInput._flatpickr) bdInput._flatpickr.setDate(ship.batch_date || null, false);
    else bdInput.value = ship.batch_date || "";
  }
  editForm.elements["price_input"].value  = ship.price_formula || ship.price_aud || "";
  editForm.elements["extra_charges"].value = ship.extra_charges || 0;
  editForm.elements["total_display"].value = (ship.total_aud || 0).toFixed(2);
  updateEditPricePreview();
  renderEditLinkSection();
  editModal.classList.remove("hidden");
}

function closeEdit() { editModal.classList.add("hidden"); }
$("#editClose").addEventListener("click", closeEdit);
$("#editCancel").addEventListener("click", closeEdit);
// NOTE: Edit window intentionally does NOT close on outside (backdrop) click.
// It only closes via Save Changes, Cancel, or the Close (X) button so that
// unsaved changes can't be lost by an accidental click outside the popup.

function getEditPrice() {
  const v = editForm.elements["price_input"].value.trim();
  const w = +editForm.elements["weight"].value || 0;
  const dv = +editForm.elements["declared_value"].value || 0;
  if (!v) return 0;
  if (!v.startsWith("=") && !isNaN(+v)) return +v;
  try { return evalFormula(v, w, dv); } catch { return null; }
}

function updateEditPricePreview() {
  const tip = $("#editPricePreview");
  const v = editForm.elements["price_input"].value.trim();
  const r = getEditPrice();
  if (!v)       { tip.textContent = ""; tip.className = "hint"; }
  else if (r === null) { tip.textContent = "Bad formula"; tip.className = "hint error"; }
  else          { tip.textContent = `= ${fmtMoney(r)}`; tip.className = "hint ok"; }
  const w   = +editForm.elements["weight"].value || 0;
  const ext = +editForm.elements["extra_charges"].value || 0;
  const total = (w * (r || 0)) + ext;
  editForm.elements["total_display"].value = total.toFixed(2);
}

["price_input","weight","declared_value","extra_charges"].forEach(n => {
  editForm.elements[n]?.addEventListener("input", updateEditPricePreview);
});

editForm.addEventListener("submit", async e => {
  e.preventDefault();
  const fd  = new FormData(editForm);
  const obj = Object.fromEntries(fd.entries());
  const id  = +obj.id;
  const priceInput = (obj.price_input || "").trim();
  let price = 0, formula = "";
  if (priceInput.startsWith("=")) {
    formula = priceInput;
    try { price = evalFormula(priceInput, +obj.weight || 0, +obj.declared_value || 0); }
    catch (err) { toast("Bad formula: " + err.message, "err"); return; }
  } else { price = parseFloat(priceInput) || 0; }

  let boxNumber = null;
  const boxRaw = (obj.box_number || "").trim();
  if (boxRaw !== "") {
    const n = parseInt(boxRaw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      toast(`Box number must be a positive whole number, got "${boxRaw}".`, "err");
      return;
    }
    boxNumber = n;
  }

  const payload = {
    ...obj,
    box_number:     boxNumber,
    declared_value: parseFloat(obj.declared_value) || 0,
    weight:         parseFloat(obj.weight) || 0,
    price_formula:  formula,
    price_aud:      price,
    extra_charges:  parseFloat(obj.extra_charges) || 0,
    paid:           editForm.elements["paid"].checked,
  };
  delete payload.id; delete payload.price_input; delete payload.total_display;

  const res = await fetch(`/api/shipments/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await safeJson(res);
    toast("Save failed — " + formatServerError(err), "err");
    return;
  }
  const updated = await res.json();
  const i = shipments.findIndex(s => s.id === id);
  if (i >= 0) shipments[i] = updated;
  closeEdit();
  renderTable();
  toast("Shipment updated successfully.");
});

// ============================================================
// CUSTOMER AUTOCOMPLETE
// ============================================================

let acTimeout = null;
let acActiveInput = null;
let acIdx = -1;
const acCache = new Map();
const AC_CACHE_MAX = 60;

function closeAutocomplete() {
  $$(".autocomplete-list").forEach(l => l.remove());
  acActiveInput = null;
  acIdx = -1;
}

document.addEventListener("click", e => {
  if (e.target.closest(".autocomplete-cell") || e.target.closest(".autocomplete-list")) return;
  closeAutocomplete();
});

function _repositionAutocomplete() {
  const list = document.querySelector(".autocomplete-list");
  if (!list || !list._anchorInput) return;
  const r = list._anchorInput.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight) { closeAutocomplete(); return; }
  list.style.top      = (r.bottom + 2) + "px";
  list.style.left     = r.left + "px";
  list.style.minWidth = Math.max(r.width, 280) + "px";
}
window.addEventListener("scroll", _repositionAutocomplete, true);
window.addEventListener("resize", _repositionAutocomplete);

function highlightMatch(text, q) {
  if (!text) return "";
  if (!q)    return escapeHtml(text);
  const safe  = escapeHtml(text);
  const safeQ = escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return safe.replace(new RegExp(safeQ, "gi"), m => `<mark>${m}</mark>`);
}

$$('input[data-lookup]').forEach(inp => {
  inp.addEventListener("input", () => {
    clearTimeout(acTimeout);
    const q = inp.value.trim();
    if (q.length < 3) { closeAutocomplete(); return; }
    const side = inp.dataset.lookup;
    acTimeout = setTimeout(async () => {
      const cacheKey = `${side}:${q.toLowerCase()}`;
      let items;
      if (acCache.has(cacheKey)) {
        items = acCache.get(cacheKey);
      } else {
        try {
          const res = await fetch(`/api/customers/search?q=${encodeURIComponent(q)}&side=${side}`);
          if (!res.ok) { showAutocomplete(inp, [], side, q, "Search failed"); return; }
          items = await res.json();
        } catch {
          showAutocomplete(inp, [], side, q, "Network error"); return;
        }
        if (acCache.size >= AC_CACHE_MAX) acCache.delete(acCache.keys().next().value);
        acCache.set(cacheKey, items);
      }
      showAutocomplete(inp, items, side, q);
    }, 180);
  });

  inp.addEventListener("keydown", e => {
    const list = $$(".autocomplete-list").find(l => l._anchorInput === inp);
    if (!list) return;
    const items = $$(".autocomplete-item", list);
    if (!items.length) { if (e.key === "Escape") closeAutocomplete(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      acIdx = Math.min(acIdx + 1, items.length - 1);
      items.forEach((it, i) => it.classList.toggle("active", i === acIdx));
      items[acIdx]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      acIdx = Math.max(acIdx - 1, 0);
      items.forEach((it, i) => it.classList.toggle("active", i === acIdx));
      items[acIdx]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && acIdx >= 0) {
      e.preventDefault(); items[acIdx].click();
    } else if (e.key === "Escape") {
      closeAutocomplete();
    }
  });
});

function showAutocomplete(inp, items, side, q = "", emptyMsg = null) {
  closeAutocomplete();
  const list = document.createElement("div");
  list.className = "autocomplete-list";
  list._anchorInput = inp;

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "autocomplete-empty";
    empty.textContent = emptyMsg || `No saved customers match "${q}"`;
    list.appendChild(empty);
    document.body.appendChild(list);
    _repositionAutocomplete();
    acActiveInput = inp; acIdx = -1;
    return;
  }

  const header = document.createElement("div");
  header.className = "autocomplete-header";
  const plural = items.length === 1 ? "" : "es";
  header.innerHTML = `<span>${items.length} match${plural}</span><span class="small">↑↓ to navigate · Enter to select</span>`;
  list.appendChild(header);

  for (const it of items) {
    const name    = it[`${side}_name`]    || "(no name)";
    const phone   = it[`${side}_phone`]   || "—";
    const city    = it[`${side}_city`]    || "";
    const addr    = it[`${side}_address`] || "";
    const country = it[`${side}_country`] || "";
    const row = document.createElement("div");
    row.className = "autocomplete-item";
    const locParts = [city, country].filter(Boolean).join(", ");
    row.innerHTML = `
      <div class="ai-name">${highlightMatch(name, q)}</div>
      <div class="ai-meta">
        <span class="ai-phone">${highlightMatch(phone, q)}</span>
        ${locParts ? `<span class="ai-loc">· ${highlightMatch(locParts, q)}</span>` : ""}
      </div>
      ${addr ? `<div class="ai-addr">${highlightMatch(addr, q)}</div>` : ""}
    `;
    row.addEventListener("click", () => { closeAutocomplete(); askAutofillConfirmation(inp, it, side); });
    row.addEventListener("mouseenter", () => {
      $$(".autocomplete-item", list).forEach((el, i) => {
        el.classList.toggle("active", el === row);
        if (el === row) acIdx = i;
      });
    });
    list.appendChild(row);
  }
  document.body.appendChild(list);
  _repositionAutocomplete();
  acActiveInput = inp; acIdx = -1;
}

// ============================================================
// IMPORT .XLSX MODAL
// ============================================================

const importModal = $("#importModal");
let importPickedFile = null;
let importDatePickerInited = false;

function openImportModal() {
  importPickedFile = null;
  $("#importFilename").textContent = "No file selected";
  $("#importFile").value = "";
  $("#importDate").value = "";
  importModal.classList.remove("hidden");
  if (!importDatePickerInited && window.flatpickr) {
    flatpickr($("#importDate"), {
      dateFormat: "Y-m-d",
      altInput: true,
      altFormat: "D, j M Y",
      locale: { firstDayOfWeek: 1 },
      allowInput: true,
      onChange: () => _refreshImportSummary(),
      onClose:  () => _refreshImportSummary(),
    });
    importDatePickerInited = true;
  }
  _refreshImportSummary();
  setTimeout(() => $("#importDate").focus(), 60);
}

function _refreshImportSummary() {
  const date   = $("#importDate")?.value || "";
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const fileName = importPickedFile?.name || "";
  $("#importPickFileBtn").disabled = !dateOk;
  const sum = $("#importSummary");
  if (dateOk && fileName) {
    sum.classList.remove("hidden");
    $("#importSummaryDate").textContent = date;
    $("#importSummaryFile").textContent = fileName;
    $("#importMfPreview").textContent   = date.slice(2).replace(/-/g, "");
  } else {
    sum.classList.add("hidden");
  }
  $("#importGo").disabled = !(dateOk && fileName);
}

$("#importBtn").addEventListener("click", openImportModal);
$("#importPickFileBtn")?.addEventListener("click", () => $("#importFile").click());

$("#importFile").addEventListener("change", e => {
  const f = e.target.files[0];
  if (!f) return;
  importPickedFile = f;
  $("#importFilename").textContent = `Selected: ${f.name}`;
  if (!$("#importDate").value) {
    const inferred = inferDateFromName(f.name) || "";
    if (inferred) $("#importDate").value = inferred;
  }
  _refreshImportSummary();
});
$("#importDate")?.addEventListener("input", _refreshImportSummary);
$("#importDate")?.addEventListener("change", _refreshImportSummary);

function inferDateFromName(name) {
  let m = name.match(/(\d{2})[_\-](\d{2})[_\-](\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = name.match(/(\d{4})[_\-](\d{2})[_\-](\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

$("#importClose").addEventListener("click", () => importModal.classList.add("hidden"));
$("#importCancel").addEventListener("click", () => importModal.classList.add("hidden"));

$("#importGo").addEventListener("click", async () => {
  if (!importPickedFile) { toast("Please pick an .xlsx file first.", "err"); return; }
  const fname = importPickedFile.name || "";
  if (!/\.(xlsx|xlsm)$/i.test(fname)) {
    toast(`"${fname}" is not a .xlsx file. Please pick an Excel workbook.`, "err"); return;
  }
  const date = $("#importDate").value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
    toast("Please pick a valid batch date (YYYY-MM-DD).", "err"); return;
  }
  const goBtn = $("#importGo");
  goBtn.disabled = true; goBtn.textContent = "Importing…";
  try {
    const buf = await importPickedFile.arrayBuffer();
    const res = await fetch(`/api/batches/${date}/import-aircargo`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buf,
    });
    if (!res.ok) {
      const err = await safeJson(res);
      toast("Import failed — " + formatServerError(err || { detail: res.statusText }), "err");
      return;
    }
    const r = await res.json();
    let msg = `Imported ${r.added} shipment${r.added === 1 ? "" : "s"}`;
    if (r.skipped) msg += ` (${r.skipped} non-BOX rows skipped)`;
    if (r.errors && r.errors.length) msg += ` · ${r.errors.length} row warning(s)`;
    toast(msg);
    importModal.classList.add("hidden");
    // Redirect to the imported batch date so BOX 1 appears first on page 1
    setTimeout(() => {
      window.location = `/?start=${date}&end=${date}`;
    }, 900);
  } catch (err) {
    toast("Import failed: " + err.message, "err");
  } finally {
    goBtn.disabled = false; goBtn.textContent = "Import Shipments";
  }
});

// ============================================================
// BULK CREATE — multiple blank shipments
// ============================================================

const bulkCreateModal = $("#bulkCreateModal");
let bulkDatePickerInited = false;

function _bulkCreateRefreshHint() {
  const n = parseInt($("#bulkCreateCount")?.value, 10);
  const hint = $("#bulkCreateHint");
  if (!hint) return;
  if (Number.isFinite(n) && n >= 1 && n <= 50) {
    hint.textContent = `${n} blank box record${n === 1 ? "" : "s"} will be created with auto box & MF numbers.`;
  } else {
    hint.textContent = "Enter a number between 1 and 50.";
  }
}

function openBulkCreateModal() {
  if (!bulkCreateModal) return;
  // Default the batch date to whatever the New Shipment form is using.
  const newFormDate = $("#newForm")?.elements["batch_date"]?.value || "";
  const dateInp = $("#bulkCreateDate");
  if (dateInp) {
    if (dateInp._flatpickr) dateInp._flatpickr.setDate(newFormDate || null, false);
    else dateInp.value = newFormDate;
  }
  $("#bulkCreateCount").value = "5";
  _bulkCreateRefreshHint();
  bulkCreateModal.classList.remove("hidden");
  if (!bulkDatePickerInited && window.flatpickr && dateInp) {
    flatpickr(dateInp, {
      dateFormat: "Y-m-d",
      altInput: true,
      altFormat: "D, j M Y",
      locale: { firstDayOfWeek: 1 },
      allowInput: true,
    });
    if (newFormDate) dateInp._flatpickr.setDate(newFormDate, false);
    bulkDatePickerInited = true;
  }
  setTimeout(() => $("#bulkCreateCount")?.focus(), 60);
}

function closeBulkCreateModal() { bulkCreateModal?.classList.add("hidden"); }

$("#bulkCreateBtn")?.addEventListener("click", openBulkCreateModal);
$("#bulkCreateClose")?.addEventListener("click", closeBulkCreateModal);
$("#bulkCreateCancel")?.addEventListener("click", closeBulkCreateModal);
$("#bulkCreateCount")?.addEventListener("input", _bulkCreateRefreshHint);

$("#bulkCreateConfirm")?.addEventListener("click", async () => {
  const date = ($("#bulkCreateDate")?.value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    toast("Please pick a valid batch date (YYYY-MM-DD).", "err");
    return;
  }
  const count = parseInt($("#bulkCreateCount")?.value, 10);
  if (!Number.isFinite(count) || count < 1) {
    toast("Please enter how many blank shipments to create (1 or more).", "err");
    return;
  }
  if (count > 50) {
    toast("You can create at most 50 blank shipments at once.", "err");
    return;
  }
  const btn = $("#bulkCreateConfirm");
  btn.disabled = true; btn.textContent = "Creating…";
  try {
    const res = await fetch("/api/shipments/bulk-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batch_date: date, count }),
    });
    if (!res.ok) {
      const err = await safeJson(res);
      toast("Create failed — " + formatServerError(err), "err");
      return;
    }
    const created = await res.json();
    closeBulkCreateModal();
    toast(`Created ${created.length} blank shipment${created.length === 1 ? "" : "s"} — redirecting to that batch…`);
    // Redirect to the batch date so the new blank rows appear, ready to edit.
    setTimeout(() => {
      window.location = `/?start=${date}&end=${date}`;
    }, 700);
  } catch (err) {
    toast("Create failed: " + err.message, "err");
  } finally {
    btn.disabled = false; btn.textContent = "Create Blank Shipments";
  }
});

// ============================================================
// DASHBOARD
// ============================================================

async function loadDashboard() {
  try {
    const res = await fetch("/api/dashboard");
    if (!res.ok) return;
    const d = await res.json();
    const m = d.this_month;
    const a = d.all_time;

    // KPI cards
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set("#kpiShipments",  fmt0(m.shipments));
    set("#kpiMonthLabel", d.this_month_label || "This Month");
    set("#kpiWeight",     fmt2(m.weight) + " kg");
    set("#kpiRevenue",    fmtMoney(m.revenue));
    set("#kpiPaid",       fmtMoney(m.paid));
    set("#kpiPaidCount",  `${m.paid_count || 0} shipment${(m.paid_count || 0) === 1 ? "" : "s"}`);
    set("#kpiUnpaid",     fmtMoney(m.unpaid));
    set("#kpiUnpaidCount",`${m.unpaid_count || 0} shipment${(m.unpaid_count || 0) === 1 ? "" : "s"}`);
    set("#kpiAllTime",    fmt0(a.shipments));
    set("#kpiAllTimeRev", fmtMoney(a.revenue) + " total revenue");

    // System status badge
    const hs = $("#healthStatus");
    if (hs) { hs.textContent = "● System Online"; hs.style.color = "var(--success)"; }

    // Batch table
    const tbody = $("#dashBatchRows");
    if (tbody) {
      if (!d.latest_batches || !d.latest_batches.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="muted" style="padding:14px;text-align:center;">No batch records yet.</td></tr>`;
      } else {
        tbody.innerHTML = d.latest_batches.map(b => `
          <tr>
            <td>
              <a href="#" class="muted-link" onclick="event.preventDefault();$('#exportDate').value='${b.date}';rebuildExportLinks();switchPanel('shipments');" title="View batch ${b.date}">
                <strong style="font-family:monospace;font-size:12px;">${b.date}</strong>
              </a>
            </td>
            <td class="num">${fmt0(b.shipments)}</td>
            <td class="num">${fmt2(b.weight)}</td>
            <td class="num">${fmtMoney(b.revenue)}</td>
            <td class="num" style="color:var(--success);font-weight:600;">${fmtMoney(b.paid)}</td>
            <td class="num" style="color:${b.unpaid > 0 ? "var(--danger)" : "var(--muted)"};">${fmtMoney(b.unpaid)}</td>
          </tr>`).join("");
      }
    }
  } catch (e) {
    console.warn("[Mon Freight] Dashboard load failed:", e);
  }
}

// ============================================================
// CUSTOMERS PANEL
// ============================================================

async function loadCustomers() {
  const q = $("#customerSearch")?.value || "";
  const tbody = $("#customerTable tbody");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="6" class="muted small" style="padding:16px;text-align:center;">Loading…</td></tr>`;
  try {
    const res = await fetch(`/api/customers?q=${encodeURIComponent(q)}&limit=200`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="6" class="muted" style="padding:16px;text-align:center;">Failed to load customers.</td></tr>`; return; }
    const rows = await res.json();
    const count = $("#customerCount");
    if (count) count.textContent = `${rows.length} customer record${rows.length === 1 ? "" : "s"}`;
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="muted" style="padding:16px;text-align:center;">No customers found${q ? ` matching "${q}"` : ""}.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(c => `
      <tr>
        <td><span class="side-badge ${c.side}">${c.side === "sender" ? "Sender" : "Receiver"}</span></td>
        <td><strong>${escapeHtml(c.name)}</strong></td>
        <td>${escapeHtml(c.phone)}</td>
        <td>${escapeHtml(c.city || "—")}</td>
        <td class="muted">${escapeHtml(c.address || "—")}</td>
        <td class="muted small">${escapeHtml(c.last_batch || "")}</td>
      </tr>`).join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted" style="padding:16px;text-align:center;">Error loading customers.</td></tr>`;
    console.warn("[Mon Freight] Customer load failed:", e);
  }
}

let custTimer = null;
$("#customerSearch")?.addEventListener("input", () => {
  clearTimeout(custTimer);
  custTimer = setTimeout(loadCustomers, 300);
});
$("#customerRefresh")?.addEventListener("click", loadCustomers);

// ============================================================
// REPORTS PANEL
// ============================================================

async function loadReports(start, end) {
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end)   params.set("end",   end);
  const tbody = $("#reportTableBody");
  const footer = $("#reportFooter");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="9" class="muted" style="padding:16px;text-align:center;">Loading…</td></tr>`;

  try {
    const res = await fetch(`/api/reports?${params}`);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="9" class="muted" style="padding:16px;text-align:center;">Failed to load reports.</td></tr>`; return; }
    const data = await res.json();
    const s = data.summary;

    // Summary KPIs
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set("#rptBatches",   fmt0(s.batches));
    set("#rptShipments", fmt0(s.shipments));
    set("#rptWeight",    fmt2(s.weight) + " kg");
    set("#rptRevenue",   fmtMoney(s.revenue));

    // Batch table
    if (!data.batches.length) {
      tbody.innerHTML = `<tr><td colspan="9" class="muted" style="padding:16px;text-align:center;">No batches found for the selected period.</td></tr>`;
      if (footer) footer.textContent = "";
      return;
    }

    tbody.innerHTML = data.batches.map(b => {
      const pctPaid = b.revenue > 0 ? Math.round((b.paid / b.revenue) * 100) : 0;
      const pillColor = pctPaid === 100 ? "var(--success)" : pctPaid > 0 ? "var(--warn)" : "var(--muted)";
      return `
        <tr>
          <td>
            <a href="/batches/${b.date}/aircargo.xlsx" class="date-link" title="Download Air Cargo manifest">${b.date}</a>
          </td>
          <td class="num">${fmt0(b.shipments)}</td>
          <td class="num">${fmt2(b.weight)}</td>
          <td class="num">${fmtMoney(b.declared_value)}</td>
          <td class="num"><strong>${fmtMoney(b.revenue)}</strong></td>
          <td class="num" style="color:var(--success);">${fmtMoney(b.paid)}</td>
          <td class="num" style="color:${b.unpaid > 0 ? "var(--danger)" : "var(--muted)"};">${fmtMoney(b.unpaid)}</td>
          <td class="num"><span style="color:${pillColor};font-weight:700;">${pctPaid}%</span></td>
          <td>
            <a class="btn small" href="/batches/${b.date}/aircargo.xlsx" title="Air Cargo .xlsx">📄</a>
            <a class="btn small" href="/batches/${b.date}/labels.xlsx"   title="Labels .xlsx">🏷</a>
          </td>
        </tr>`;
    }).join("");

    if (footer) {
      const range = (start && end) ? `${start} to ${end}` : start ? `from ${start}` : end ? `to ${end}` : "All time";
      footer.textContent = `${data.batches.length} batch${data.batches.length === 1 ? "" : "es"} · ${fmt0(s.shipments)} shipments · ${fmtMoney(s.revenue)} revenue · ${range}`;
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="9" class="muted" style="padding:16px;text-align:center;">Error loading report data.</td></tr>`;
    console.warn("[Mon Freight] Report load failed:", e);
  }
}

$("#reportApply")?.addEventListener("click", () => {
  const s = $("#reportStart")?.value;
  const e = $("#reportEnd")?.value;
  loadReports(s || undefined, e || undefined);
});
$("#reportClear")?.addEventListener("click", () => {
  if ($("#reportStart")) $("#reportStart").value = "";
  if ($("#reportEnd"))   $("#reportEnd").value   = "";
  loadReports();
});

// ============================================================
// SETTINGS PANEL — HEALTH CHECK
// ============================================================

async function loadSettings() {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) return;
    const d = await res.json();
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set("#settingsDbKind",    d.ok ? (d.db_url_kind === "sqlite" ? "SQLite (local)" : "PostgreSQL") : "Error");
    set("#settingsShipCount", d.ok ? `${fmt0(d.shipment_count)} records` : "—");
    set("#settingsHealth",    d.ok ? "Connected ✓" : "Error — " + (d.error || "unknown"));
    if (d.ok) {
      const el = $("#settingsHealth");
      if (el) { el.style.background = "var(--paid-bg)"; el.style.color = "var(--paid-fg)"; }
    }
  } catch (e) {
    console.warn("[Mon Freight] Settings health check failed:", e);
  }
  loadAdminSections();
}

// ============================================================
// AUTH — current user, logout
// ============================================================

let CURRENT_USER = null;

async function authFetch(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) { window.location.href = "/login"; throw new Error("Signed out"); }
  return res;
}

async function initAuth() {
  try {
    const res = await fetch("/auth/me");
    if (res.status === 401) { window.location.href = "/login"; return; }
    CURRENT_USER = await res.json();
    const chip = $("#userChip");
    if (chip) chip.textContent =
      `${CURRENT_USER.username}${CURRENT_USER.role === "admin" ? " (admin)" : ""}`;
  } catch (e) { console.warn("auth check failed", e); }
}
initAuth();

$("#logoutBtn")?.addEventListener("click", async () => {
  try {
    const res = await fetch("/auth/logout", { method: "POST" });
    const d = await res.json();
    window.location.href = d.redirect || "/login";
  } catch { window.location.href = "/login"; }
});

// ============================================================
// SETTINGS — USER MANAGEMENT (admin)
// ============================================================

async function loadAdminSections() {
  if (!CURRENT_USER) await initAuth();
  const isAdmin = CURRENT_USER && CURRENT_USER.role === "admin";
  $("#usersCard")?.classList.toggle("hidden", !isAdmin);
  $("#backupCard")?.classList.toggle("hidden", !isAdmin);
  if (!isAdmin) return;
  const badge = $("#smsModeBadge");
  if (badge) badge.innerHTML = CURRENT_USER.sms_configured
    ? `<span style="color:var(--success);font-weight:600;">SMS delivery: Twilio ✓</span>`
    : `<span style="color:var(--danger);font-weight:600;">SMS not configured —
       codes are shown on the login page (DEV MODE). Set the Twilio
       environment variables before go-live.</span>`;
  loadUsers();
  loadBackups();
}

async function loadUsers() {
  const tbody = $("#usersTable tbody");
  if (!tbody) return;
  try {
    const res = await authFetch("/api/users");
    const users = await res.json();
    tbody.innerHTML = users.map(u => `
      <tr>
        <td><strong>${escapeHtml(u.username)}</strong></td>
        <td>${escapeHtml(u.phone || "—")}</td>
        <td>${u.role}</td>
        <td>${u.active ? "active" : `<span style="color:var(--danger);">disabled</span>`}</td>
        <td class="small">${u.last_login ? u.last_login.slice(0, 16).replace("T", " ") + " UTC" : "never"}</td>
        <td>
          <button class="btn small" onclick="resetUserPassword(${u.id}, '${escapeHtml(u.username)}')">Password</button>
          <button class="btn small" onclick="editUserPhone(${u.id}, '${escapeHtml(u.phone || "")}')">Mobile</button>
          <button class="btn small" onclick="toggleUserActive(${u.id}, ${u.active})">${u.active ? "Disable" : "Enable"}</button>
          <button class="btn small danger" onclick="deleteUser(${u.id}, '${escapeHtml(u.username)}')">✕</button>
        </td>
      </tr>`).join("") || `<tr><td colspan="6" class="muted">No users.</td></tr>`;
  } catch (e) { console.warn(e); }
}

async function userPatch(id, body) {
  const res = await authFetch(`/api/users/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { toast(formatServerError(d), "err"); return false; }
  return true;
}

window.resetUserPassword = async (id, name) => {
  const p = prompt(`New password for "${name}" (min 8 characters):`);
  if (!p) return;
  if (await userPatch(id, { password: p })) { toast("Password updated"); loadUsers(); }
};
window.editUserPhone = async (id, current) => {
  const p = prompt("Mobile number(s), E.164 format, comma-separated for several (e.g. +61400123456,+97699112233):", current);
  if (p === null) return;
  if (await userPatch(id, { phone: p.trim() })) { toast("Mobile updated"); loadUsers(); }
};
window.toggleUserActive = async (id, active) => {
  if (await userPatch(id, { active: !active })) { toast(active ? "User disabled" : "User enabled"); loadUsers(); }
};
window.deleteUser = async (id, name) => {
  if (!confirm(`Delete user "${name}" permanently?`)) return;
  const res = await authFetch(`/api/users/${id}`, { method: "DELETE" });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { toast(formatServerError(d), "err"); return; }
  toast("User deleted");
  loadUsers();
};

$("#addUserBtn")?.addEventListener("click", async () => {
  const body = {
    username: $("#nuUsername").value.trim(),
    password: $("#nuPassword").value,
    phone: $("#nuPhone").value.trim(),
    role: $("#nuRole").value,
  };
  if (!body.username || !body.password) { toast("Username and password required", "err"); return; }
  const res = await authFetch("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { toast(formatServerError(d), "err"); return; }
  toast(`User "${d.username}" created`);
  $("#nuUsername").value = $("#nuPassword").value = $("#nuPhone").value = "";
  loadUsers();
});

// ============================================================
// SETTINGS — BACKUP & RESTORE (admin)
// ============================================================

function fmtBytes(n) {
  if (!n) return "—";
  if (n > 1048576) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1024).toFixed(0) + " KB";
}

async function loadBackups() {
  const tbody = $("#backupsTable tbody");
  if (!tbody) return;
  try {
    const res = await authFetch("/api/backups");
    const d = await res.json();
    $("#backupSchedule").textContent =
      `Daily at ${d.schedule_utc} UTC · keep ${d.retention_days} days`;
    const drv = $("#backupDrive");
    drv.textContent = d.drive_configured ? "OneDrive ✓" : "Local disk only — OneDrive not configured";
    drv.classList.toggle("warn", !d.drive_configured);
    const real = d.backups.filter(b => !b.pre_restore);
    $("#backupLast").textContent = real.length
      ? `${(real[0].created_at || "").slice(0, 16).replace("T", " ")} UTC`
      : "No backups yet";
    tbody.innerHTML = d.backups.map(b => `
      <tr>
        <td class="small">${escapeHtml(b.name)}${b.pre_restore ? ' <span class="muted">(safety snapshot)</span>' : ""}</td>
        <td class="small">${(b.created_at || "").slice(0, 16).replace("T", " ")}</td>
        <td>${fmtBytes(b.size)}</td>
        <td class="small">${[b.local ? "Server" : "", b.drive ? "Drive" : ""].filter(Boolean).join(" + ") || "—"}</td>
        <td>
          <a class="btn small" href="/api/backups/download/${encodeURIComponent(b.name)}">⬇ Download</a>
          <button class="btn small danger" onclick="askRestore('${escapeHtml(b.name)}')">Restore</button>
        </td>
      </tr>`).join("") || `<tr><td colspan="5" class="muted">No backups yet.</td></tr>`;
  } catch (e) { console.warn(e); }
}

$("#runBackupBtn")?.addEventListener("click", async () => {
  const btn = $("#runBackupBtn");
  btn.disabled = true; btn.textContent = "Backing up…";
  try {
    const res = await authFetch("/api/backups/run", { method: "POST" });
    const d = await res.json();
    if (!res.ok) { toast(formatServerError(d), "err"); }
    else toast(`Backup created: ${d.name}` +
               (d.uploaded_to_drive ? " (uploaded to Drive)" : ""));
    loadBackups();
  } catch (e) { toast(String(e), "err"); }
  btn.disabled = false; btn.textContent = "Run Backup Now";
});

let _restoreTarget = null;
window.askRestore = (name) => {
  _restoreTarget = name;
  $("#restoreModalName").textContent = name;
  $("#restoreModal").style.display = "flex";
};
$("#restoreCancelBtn")?.addEventListener("click", () => {
  $("#restoreModal").style.display = "none";
  _restoreTarget = null;
});
$("#restoreConfirmBtn")?.addEventListener("click", async () => {
  if (!_restoreTarget) return;
  const btn = $("#restoreConfirmBtn");
  btn.disabled = true; btn.textContent = "Restoring…";
  try {
    const res = await authFetch("/api/backups/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: _restoreTarget, confirm: true }),
    });
    const d = await res.json();
    if (!res.ok) toast(formatServerError(d), "err");
    else {
      toast(`Restore complete — safety snapshot: ${d.safety_snapshot}`);
      setTimeout(() => window.location.reload(), 1800);
    }
  } catch (e) { toast(String(e), "err"); }
  btn.disabled = false; btn.textContent = "Yes, Restore Now";
  $("#restoreModal").style.display = "none";
  _restoreTarget = null;
});

// ============================================================
// AUTOFILL CONFIRMATION
// ============================================================

function askAutofillConfirmation(inp, item, side) {
  const modal = $("#autofillModal");
  if (!modal) { applyAutofill(inp, item, side); return; }
  const fields = [
    [`${side}_name`,    "Name"],
    [`${side}_phone`,   "Phone"],
    [`${side}_address`, "Address"],
    [`${side}_city`,    "City"],
    [`${side}_country`, "Country"],
  ];
  if (side === "sender") fields.push(["sender_postal", "Postcode"]);
  $("#autofillPreview").innerHTML = `
    <p class="muted small" style="margin-top:0;">
      Apply these <strong>${side}</strong> details to this shipment?
    </p>
    <table class="autofill-table">
      ${fields.map(([k, label]) => `<tr><th>${label}</th><td>${escapeHtml(item[k] || "—")}</td></tr>`).join("")}
    </table>
  `;
  modal.classList.remove("hidden");
  const ok    = $("#autofillOk");
  const cancel = $("#autofillCancel");
  const close  = $("#autofillClose");
  function cleanup() {
    modal.classList.add("hidden");
    ok.removeEventListener("click", onOk);
    cancel.removeEventListener("click", onCancel);
    close.removeEventListener("click", onCancel);
  }
  const onOk     = () => { cleanup(); applyAutofill(inp, item, side); };
  const onCancel = () => { cleanup(); inp.focus(); };
  ok.addEventListener("click", onOk);
  cancel.addEventListener("click", onCancel);
  close.addEventListener("click", onCancel);
}

function applyAutofill(inp, item, side) {
  const form = inp.closest("form");
  Object.entries(item).forEach(([k, v]) => {
    const target = form.elements[k];
    if (target && v) target.value = v;
  });
  const nextField = side === "sender" ? "receiver_name" : "description";
  form.elements[nextField]?.focus();
  toast(`Autofilled from ${item[`${side}_name`] || "saved customer"}.`);
}

// ============================================================
// FLATPICKR INIT
// ============================================================

function initFlatpickr() {
  if (!window.flatpickr) { console.warn("[Mon Freight] Flatpickr not loaded — date inputs will be plain text."); return; }
  const base = {
    dateFormat: "Y-m-d",
    altInput:   true,
    altFormat:  "D, j M Y",
    locale:     { firstDayOfWeek: 1 },
    allowInput: true,
  };
  flatpickr($("#newForm").elements["batch_date"],  base);
  flatpickr(editForm.elements["batch_date"],        base);
  flatpickr($("#filterStart"), base);
  flatpickr($("#filterEnd"),   base);
  flatpickr($("#exportDate"),  {
    ...base,
    onChange: (_, dateStr) => {
      rebuildExportLinks(dateStr);
      // Selecting a batch date filters the Shipment Records table to that batch.
      // Clearing the date (dateStr === "") returns to the unfiltered view.
      if (dateStr) {
        const url = new URL(window.location.href);
        url.searchParams.set("start", dateStr);
        url.searchParams.set("end",   dateStr);
        // Preserve any existing search query
        if (window.SEARCH_Q) url.searchParams.set("q", window.SEARCH_Q);
        else url.searchParams.delete("q");
        window.location = url.toString();
      }
    },
    onReady: (_, dateStr, fp) => {
      // If the page already has an active single-batch filter, show a hint
      if (_filterStart && _filterStart === _filterEnd) {
        const el = fp.input.closest("label");
        if (el) el.title = `Filtered to batch ${_filterStart}`;
      }
    },
  });
  // Batch Date quick-filter (above Shipments Records table)
  const bfd = $("#batchFilterDate");
  if (bfd) {
    flatpickr(bfd, {
      ...base,
      // Restrict to dates that actually have batches (if ALL_DATES is populated)
      enable: window.ALL_DATES && window.ALL_DATES.length ? window.ALL_DATES : undefined,
      onChange: (_, dateStr) => {
        if (dateStr) {
          const url = new URL(window.location.href);
          url.searchParams.set("start", dateStr);
          url.searchParams.set("end",   dateStr);
          if (window.SEARCH_Q) url.searchParams.set("q", window.SEARCH_Q);
          else url.searchParams.delete("q");
          url.searchParams.delete("page");
          window.location = url.toString();
        }
      },
    });
  }

  // Reports date pickers
  const rStart = $("#reportStart");
  const rEnd   = $("#reportEnd");
  if (rStart) flatpickr(rStart, base);
  if (rEnd)   flatpickr(rEnd,   base);
  // Labels panel batch date
  const lbd = $("#labelBatchDate");
  if (lbd) flatpickr(lbd, {
    ...base,
    onChange: (_, dateStr) => rebuildLabelPanelLinks(dateStr),
  });
}

// ============================================================
// ACTIVITY LOGS PANEL (admin only)
// ============================================================

const _ACT_PAGE_SIZE = 100;
let _actOffset = 0;
let _actTotal  = 0;

// Pretty-print action names for display
const _ACTION_LABELS = {
  login:                    "Login",
  logout:                   "Logout",
  shipment_created:         "Shipment Created",
  shipment_updated:         "Shipment Updated",
  shipment_patched:         "Shipment Edited (inline)",
  shipment_deleted:         "Shipment Deleted",
  shipments_bulk_deleted:   "Bulk Delete",
  excel_import:             "Excel Import",
  excel_export_aircargo:    "Export — Air Cargo",
  excel_export_labels:      "Export — Labels",
  user_created:             "User Created",
  user_updated:             "User Updated",
  user_deleted:             "User Deleted",
  backup_created:           "Backup Created",
  backup_restored:          "Backup Restored",
};

function _actionLabel(action) {
  return _ACTION_LABELS[action] || action.replace(/_/g, " ");
}

function _actionClass(action) {
  if (action === "login")  return "color:var(--success);font-weight:600;";
  if (action === "logout") return "color:var(--muted);";
  if (action.includes("delete")) return "color:var(--danger);font-weight:600;";
  if (action.includes("restore")) return "color:var(--danger);";
  if (action.includes("import") || action.includes("export")) return "color:var(--brand);";
  if (action.includes("backup")) return "color:#7c6f00;";
  if (action.includes("user")) return "color:#5a2d82;";
  return "";
}

async function loadActivityLogs(offset = 0) {
  const tbody = $("#activityTableBody");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="5" class="muted small" style="padding:16px;text-align:center;">Loading…</td></tr>`;

  const userF   = ($("#activityUserFilter")?.value   || "").trim();
  const actionF = ($("#activityActionFilter")?.value || "").trim();
  let url = `/api/activity-logs?limit=${_ACT_PAGE_SIZE}&offset=${offset}`;
  if (userF)   url += `&user=${encodeURIComponent(userF)}`;
  if (actionF) url += `&action=${encodeURIComponent(actionF)}`;

  try {
    const res = await authFetch(url);
    if (!res.ok) { tbody.innerHTML = `<tr><td colspan="5" class="muted">Failed to load logs.</td></tr>`; return; }
    const d = await res.json();
    _actTotal  = d.total || 0;
    _actOffset = offset;

    if (!d.logs || d.logs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="muted small" style="padding:16px;text-align:center;">No activity logs found.</td></tr>`;
    } else {
      tbody.innerHTML = d.logs.map(r => `
        <tr>
          <td class="small" style="white-space:nowrap;">${(r.timestamp || "").slice(0, 16).replace("T", " ")}</td>
          <td><strong>${escapeHtml(r.username)}</strong></td>
          <td class="small" style="${_actionClass(r.action)}">${escapeHtml(_actionLabel(r.action))}</td>
          <td class="small" style="color:var(--ink-soft);">${escapeHtml(r.details || "")}</td>
          <td class="small muted">${escapeHtml(r.ip || "")}</td>
        </tr>`).join("");
    }

    const shown = Math.min(offset + _ACT_PAGE_SIZE, _actTotal);
    const foot = $("#activityFooter");
    if (foot) foot.textContent = `Showing ${offset + 1}–${shown} of ${_actTotal} log entries`;

    const prevBtn = $("#activityPrevBtn");
    const nextBtn = $("#activityNextBtn");
    if (prevBtn) prevBtn.disabled = offset === 0;
    if (nextBtn) nextBtn.disabled = offset + _ACT_PAGE_SIZE >= _actTotal;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Error loading logs.</td></tr>`;
    console.warn("[Mon Freight] Activity log load failed:", e);
  }
}

async function loadActivityPanel() {
  if (!CURRENT_USER) await initAuth();
  const isAdmin = CURRENT_USER && CURRENT_USER.role === "admin";
  $("#activityCard")?.classList.toggle("hidden", !isAdmin);
  $("#activityNoAccess")?.classList.toggle("hidden", isAdmin);
  if (isAdmin) loadActivityLogs(0);
}

$("#activityFilterBtn")?.addEventListener("click", () => loadActivityLogs(0));
$("#activityClearBtn")?.addEventListener("click", () => {
  if ($("#activityUserFilter"))   $("#activityUserFilter").value   = "";
  if ($("#activityActionFilter")) $("#activityActionFilter").value = "";
  loadActivityLogs(0);
});
$("#activityRefreshBtn")?.addEventListener("click", () => loadActivityLogs(_actOffset));
$("#activityPrevBtn")?.addEventListener("click", () => {
  if (_actOffset > 0) loadActivityLogs(Math.max(0, _actOffset - _ACT_PAGE_SIZE));
});
$("#activityNextBtn")?.addEventListener("click", () => {
  if (_actOffset + _ACT_PAGE_SIZE < _actTotal) loadActivityLogs(_actOffset + _ACT_PAGE_SIZE);
});

// Show the "Activity Logs" nav link for admins after auth check
(async () => {
  if (!CURRENT_USER) await initAuth();
  if (CURRENT_USER && CURRENT_USER.role === "admin") {
    const navLink = $("#navActivity");
    if (navLink) navLink.style.display = "";
  }
})();

initFlatpickr();
rebuildExportLinks();
rebuildLabelPanelLinks?.();

// ============================================================
// INITIAL RENDER
// ============================================================

renderTable();
loadLinkMap();   // load the complete link-group map, then re-render with full indicators
// Dashboard loaded by switchPanel on init

// ============================================================
// BATCH STATS — fetch totals for ALL records matching the
// current filter (all pages) and populate the stats bar.
// ============================================================
async function loadBatchStats() {
  const params = new URLSearchParams();
  if (window.FILTER_START) params.set("start", window.FILTER_START);
  if (window.FILTER_END)   params.set("end",   window.FILTER_END);
  if (window.SEARCH_Q)     params.set("q",     window.SEARCH_Q);
  try {
    const res = await fetch("/api/stats" + (params.toString() ? "?" + params : ""));
    if (!res.ok) return;
    const d = await res.json();
    $("#statBoxes").textContent  = fmt0(d.total);
    $("#statWeight").textContent = fmt2(d.weight);
    $("#statValue").textContent  = fmtMoney(d.declared_value);
    $("#statPrice").textContent  = fmtMoney(d.freight);
    $("#statPaid").textContent   = fmtMoney(d.paid);
    $("#statUnpaid").textContent = fmtMoney(d.outstanding);
    $("#rowCount").textContent   = `${d.total} shipment${d.total === 1 ? "" : "s"}`;
  } catch (_) {}
}
loadBatchStats();

// ============================================================
// BACKGROUND POLL — refresh shipments every 15 seconds so
// changes made by other users appear without a manual reload.
// Always mirrors the exact page / filter / search the user
// is on so the view is never reset to page 1.
// ============================================================
(function startPolling() {
  const POLL_MS = 15_000;

  async function _pollShipments() {
    // Only poll on the Shipments panel
    const activePanel = sessionStorage.getItem("mf_panel") || "dashboard";
    if (activePanel !== "shipments") return;

    // Skip if any modal/dialog is currently visible
    const modalOpen = $$(".modal, .dialog, [role='dialog']")
      .some(el => !el.classList.contains("hidden") &&
                  el.offsetParent !== null);
    if (modalOpen) return;

    try {
      // Always pass page so page 1 also gets only its 15 rows (not all records)
      const params = new URLSearchParams();
      if (window.FILTER_START) params.set("start", window.FILTER_START);
      if (window.FILTER_END)   params.set("end",   window.FILTER_END);
      if (window.SEARCH_Q)     params.set("q",     window.SEARCH_Q);
      params.set("page", window.PAGE || 1);
      const res = await fetch("/api/shipments?" + params);
      if (!res.ok) return;
      const fresh = await res.json();
      // Only re-render if data actually changed
      if (JSON.stringify(fresh) !== JSON.stringify(shipments)) {
        shipments = fresh;
        loadLinkMap();   // refresh complete link map (also re-renders the table)
      }
    } catch (_) {
      // Silently ignore network errors during polling
    }
  }

  setInterval(_pollShipments, POLL_MS);
})();

// ============================================================
// SEND SMS PANEL (admin only)
// ============================================================
let _smsRecipients = [];          // [{name, raw, phone, valid, reason, box, included}]
let _smsDevMode    = true;
let _smsHistOffset = 0;
let _smsHistTotal  = 0;
const _SMS_HIST_PAGE = 100;
const _SMS_SEG_LIMIT = 70;        // Unicode (UCS-2) single-segment limit

function _smsHasUnicode(s) {
  // Any code point above basic GSM range → message is sent as UCS-2.
  return /[^\x00-\x7F]/.test(s || "");
}

function _smsSegments(s) {
  const len = (s || "").length;
  if (len === 0) return 0;
  if (_smsHasUnicode(s)) {
    return len <= 70 ? 1 : Math.ceil(len / 67);   // UCS-2 segmentation
  }
  return len <= 160 ? 1 : Math.ceil(len / 153);   // GSM-7 segmentation
}

async function loadSMSPanel() {
  if (!CURRENT_USER) await initAuth();
  const isAdmin = CURRENT_USER && CURRENT_USER.role === "admin";
  $("#smsCard")?.classList.toggle("hidden", !isAdmin);
  $("#smsNoAccess")?.classList.toggle("hidden", isAdmin);
  if (!isAdmin) return;

  // Config status badge
  try {
    const res = await authFetch("/api/sms/status");
    if (res.ok) {
      const d = await res.json();
      _smsDevMode = !!d.dev_mode;
      const badge = $("#smsConfigBadge");
      if (badge) {
        if (d.configured) {
          badge.textContent = `Twilio ready · sending from ${d.from}`;
          badge.style.cssText = "font-size:11px;background:#e6ffed;color:#137333;padding:3px 8px;border-radius:10px;";
        } else {
          badge.textContent = "DEV MODE — Twilio not configured (dry run)";
          badge.style.cssText = "font-size:11px;background:#fff7e6;color:#a6730b;padding:3px 8px;border-radius:10px;";
        }
      }
    }
  } catch (_) {}

  // Load batch list
  try {
    const res = await authFetch("/api/sms/batches");
    const sel = $("#smsBatchSelect");
    if (res.ok && sel) {
      const d = await res.json();
      if (!d.batches || d.batches.length === 0) {
        sel.innerHTML = `<option value="">No batches found</option>`;
        $("#smsLoadBtn").disabled = true;
      } else {
        sel.innerHTML = `<option value="">Select a batch date…</option>` +
          d.batches.map(b =>
            `<option value="${b.date}">${b.date} — ${b.shipments} shipment${b.shipments === 1 ? "" : "s"}</option>`
          ).join("");
      }
    }
  } catch (_) {}

  loadSMSHistory(0);
}

$("#smsBatchSelect")?.addEventListener("change", e => {
  $("#smsLoadBtn").disabled = !e.target.value;
});

$("#smsLoadBtn")?.addEventListener("click", async () => {
  const date = $("#smsBatchSelect").value;
  if (!date) return;
  $("#smsRecipSummary").textContent = "Loading senders…";
  try {
    const res = await authFetch(`/api/sms/recipients?date=${encodeURIComponent(date)}`);
    if (!res.ok) { $("#smsRecipSummary").textContent = "Failed to load."; return; }
    const d = await res.json();
    _smsRecipients = (d.recipients || []).map(r => ({ ...r, included: r.valid }));
    $("#smsRecipSummary").textContent =
      `${d.total} sender${d.total === 1 ? "" : "s"} found — ${d.valid} valid AU mobile${d.valid === 1 ? "" : "s"}` +
      (d.invalid ? `, ${d.invalid} flagged` : "");
    $("#smsRecipientsCard").classList.remove("hidden");
    $("#smsMessageCard").classList.remove("hidden");
    $("#smsResultCard").classList.add("hidden");
    renderSMSRecipients();
    updateSMSPreview();
  } catch (_) {
    $("#smsRecipSummary").textContent = "Error loading senders.";
  }
});

function _smsStatusPill(r) {
  if (r.valid) return `<span style="color:#137333;font-weight:600;">✓ AU mobile</span>`;
  return `<span style="color:#b91c1c;" title="${escapeAttr(r.reason || "")}">⚠ ${escapeHtml(r.reason || "invalid")}</span>`;
}

function renderSMSRecipients() {
  const body = $("#smsRecipBody");
  if (!body) return;
  if (_smsRecipients.length === 0) {
    body.innerHTML = `<tr><td colspan="5" class="muted small" style="padding:14px;text-align:center;">No senders in this batch.</td></tr>`;
  } else {
    body.innerHTML = _smsRecipients.map((r, i) => `
      <tr style="${r.included ? "" : "opacity:.45;"}">
        <td style="text-align:center;">
          <input type="checkbox" data-sms-idx="${i}" ${r.included ? "checked" : ""}
                 ${r.valid ? "" : "disabled"} title="${r.valid ? "Include / remove" : "Cannot send to an invalid number"}">
        </td>
        <td>${escapeHtml(r.name || "—")}</td>
        <td style="font-family:monospace;">${escapeHtml(r.phone || "—")}</td>
        <td class="muted small" style="font-family:monospace;">${escapeHtml(r.raw || "")}</td>
        <td class="small">${_smsStatusPill(r)}</td>
      </tr>`).join("");
  }
  body.querySelectorAll("input[data-sms-idx]").forEach(cb => {
    cb.addEventListener("change", e => {
      const idx = +e.target.dataset.smsIdx;
      _smsRecipients[idx].included = e.target.checked;
      renderSMSRecipients();
      updateSMSPreview();
    });
  });
  const included = _smsRecipients.filter(r => r.included && r.valid).length;
  $("#smsRecipCount").textContent = `${included} selected to send`;
  updateSMSPreview();
}

// Add a number manually
$("#smsAddBtn")?.addEventListener("click", async () => {
  const input = $("#smsAddPhone");
  const raw = (input.value || "").trim();
  const msg = $("#smsAddMsg");
  if (!raw) return;
  try {
    const res = await authFetch("/api/sms/validate-number", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: raw }),
    });
    const d = await res.json();
    if (!d.valid) {
      msg.textContent = `⚠ ${d.reason || "Not a valid AU mobile"}`;
      msg.style.color = "#b91c1c";
      return;
    }
    if (_smsRecipients.some(r => r.phone === d.phone)) {
      msg.textContent = "Already in the list.";
      msg.style.color = "#a6730b";
      return;
    }
    _smsRecipients.push({ name: "(added manually)", raw, phone: d.phone,
                          valid: true, reason: "ok", box: null, included: true });
    input.value = "";
    msg.textContent = `Added ${d.phone}`;
    msg.style.color = "#137333";
    renderSMSRecipients();
  } catch (_) {
    msg.textContent = "Error validating number.";
    msg.style.color = "#b91c1c";
  }
});
$("#smsAddPhone")?.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); $("#smsAddBtn").click(); }
});

// Message editor → live preview
$("#smsMessage")?.addEventListener("input", updateSMSPreview);

function updateSMSPreview() {
  const text = $("#smsMessage")?.value || "";
  const preview = $("#smsPreview");
  if (preview) preview.textContent = text || "(your message preview appears here)";
  const included = _smsRecipients.filter(r => r.included && r.valid).length;
  const segs = _smsSegments(text);
  const enc = _smsHasUnicode(text) ? "Unicode (Mongolian/Cyrillic OK)" : "GSM-7";
  const meta = $("#smsMeta");
  if (meta) {
    meta.textContent = text
      ? `${text.length} characters · ${segs} SMS segment${segs === 1 ? "" : "s"} · ${enc}`
      : "";
  }
  const summary = $("#smsSendSummary");
  if (summary) summary.textContent = `${included} recipient${included === 1 ? "" : "s"} selected`;
  const btn = $("#smsSendBtn");
  if (btn) btn.disabled = !(text.trim() && included > 0);
}

// Send → confirmation modal
$("#smsSendBtn")?.addEventListener("click", () => {
  const included = _smsRecipients.filter(r => r.included && r.valid);
  if (included.length === 0 || !($("#smsMessage").value || "").trim()) return;
  $("#smsConfirmText").innerHTML =
    `You are about to send this SMS to <strong>${included.length}</strong> ` +
    `sender${included.length === 1 ? "" : "s"}. Are you sure?`;
  $("#smsConfirmDevNote").classList.toggle("hidden", !_smsDevMode);
  $("#smsConfirmModal").classList.remove("hidden");
});

function _closeSMSConfirm() { $("#smsConfirmModal")?.classList.add("hidden"); }
$("#smsConfirmClose")?.addEventListener("click", _closeSMSConfirm);
$("#smsConfirmCancel")?.addEventListener("click", _closeSMSConfirm);

$("#smsConfirmSend")?.addEventListener("click", async () => {
  const included = _smsRecipients.filter(r => r.included && r.valid);
  const message = ($("#smsMessage").value || "").trim();
  const date = $("#smsBatchSelect").value || null;
  if (included.length === 0 || !message) { _closeSMSConfirm(); return; }

  const sendBtn = $("#smsConfirmSend");
  sendBtn.disabled = true;
  sendBtn.textContent = "Sending…";
  try {
    const res = await authFetch("/api/sms/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batch_date: date, message,
                             recipients: included.map(r => r.phone) }),
    });
    const d = await res.json();
    _closeSMSConfirm();
    renderSMSResults(d);
    loadSMSHistory(0);
  } catch (_) {
    _closeSMSConfirm();
    alert("Failed to send SMS. Please try again.");
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = "Yes, send";
  }
});

function renderSMSResults(d) {
  const card = $("#smsResultCard");
  const body = $("#smsResultBody");
  if (!card || !body) return;
  card.classList.remove("hidden");
  const tag = d.dev_mode ? ` <span style="color:#a6730b;">(dry run — Twilio not configured)</span>` : "";
  const rows = (d.results || []).map(r => {
    let color = "#137333", label = r.status;
    if (r.status === "failed" || r.status === "rejected") { color = "#b91c1c"; }
    if (r.status === "dev") { color = "#a6730b"; label = "dry run"; }
    return `<tr>
      <td style="font-family:monospace;">${escapeHtml(r.phone)}</td>
      <td style="color:${color};font-weight:600;">${escapeHtml(label)}</td>
      <td class="muted small">${escapeHtml(r.error || "")}</td>
    </tr>`;
  }).join("");
  body.innerHTML = `
    <p style="font-size:15px;margin:0 0 10px;">
      <strong style="color:#137333;">${d.sent}</strong> sent ·
      <strong style="color:#b91c1c;">${d.failed}</strong> failed ·
      <strong>${d.rejected}</strong> rejected${tag}
    </p>
    <div class="rowscroll" style="max-height:260px;">
      <table class="dataTable" style="table-layout:auto;">
        <thead><tr><th>Number</th><th style="width:110px;">Result</th><th>Detail</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// History
async function loadSMSHistory(offset = 0) {
  const body = $("#smsHistoryBody");
  if (!body) return;
  try {
    const res = await authFetch(`/api/sms/history?limit=${_SMS_HIST_PAGE}&offset=${offset}`);
    if (!res.ok) { body.innerHTML = `<tr><td colspan="6" class="muted">Failed to load.</td></tr>`; return; }
    const d = await res.json();
    _smsHistTotal = d.total || 0;
    _smsHistOffset = offset;
    if (!d.history || d.history.length === 0) {
      body.innerHTML = `<tr><td colspan="6" class="muted small" style="padding:16px;text-align:center;">No SMS history yet.</td></tr>`;
    } else {
      body.innerHTML = d.history.map(r => {
        let color = "#137333";
        if (r.status === "failed" || r.status === "rejected") color = "#b91c1c";
        if (r.status === "dev") color = "#a6730b";
        const st = r.status === "dev" ? "dry run" : r.status;
        return `<tr>
          <td class="small" style="white-space:nowrap;">${escapeHtml(r.sent_at)}</td>
          <td class="small">${escapeHtml(r.batch_date || "—")}</td>
          <td class="small" style="font-family:monospace;">${escapeHtml(r.phone)}</td>
          <td class="small" style="color:var(--ink-soft);">${escapeHtml(r.message || "")}${r.error ? `<br><span style="color:#b91c1c;">${escapeHtml(r.error)}</span>` : ""}</td>
          <td class="small" style="color:${color};font-weight:600;">${escapeHtml(st)}</td>
          <td class="small">${escapeHtml(r.admin_user || "")}</td>
        </tr>`;
      }).join("");
    }
    const shown = Math.min(offset + _SMS_HIST_PAGE, _smsHistTotal);
    $("#smsHistoryFooter").textContent =
      _smsHistTotal ? `Showing ${offset + 1}–${shown} of ${_smsHistTotal}` : "";
    $("#smsHistoryPrev").disabled = offset === 0;
    $("#smsHistoryNext").disabled = offset + _SMS_HIST_PAGE >= _smsHistTotal;
  } catch (_) {
    body.innerHTML = `<tr><td colspan="6" class="muted">Error loading history.</td></tr>`;
  }
}
$("#smsHistoryRefresh")?.addEventListener("click", () => loadSMSHistory(_smsHistOffset));
$("#smsHistoryPrev")?.addEventListener("click", () => {
  if (_smsHistOffset > 0) loadSMSHistory(Math.max(0, _smsHistOffset - _SMS_HIST_PAGE));
});
$("#smsHistoryNext")?.addEventListener("click", () => {
  if (_smsHistOffset + _SMS_HIST_PAGE < _smsHistTotal) loadSMSHistory(_smsHistOffset + _SMS_HIST_PAGE);
});

// Show the "Send SMS" nav link for admins after auth check
(async () => {
  if (!CURRENT_USER) await initAuth();
  if (CURRENT_USER && CURRENT_USER.role === "admin") {
    const navLink = $("#navSMS");
    if (navLink) navLink.style.display = "";
  }
})();
