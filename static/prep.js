/**
 * Mon Freight — Shipment Preparation panel
 * Packages · parcel assignment · packing list / invoice · documents.
 * Relies on globals from app.js: $, $$, toast, escapeHtml, CURRENT_USER, flatpickr.
 */
"use strict";

(function () {
  const q  = (s, r = document) => r.querySelector(s);
  const qa = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => (window.escapeHtml ? window.escapeHtml(s) :
    String(s ?? "").replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
  const notify = (m, k) => (window.toast ? window.toast(m, k) : console.log(m));
  const money = (n) => "$" + (Number(n) || 0).toLocaleString(undefined,
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const state = {
    date: null, isAdmin: false,
    packages: [], parcels: [], items: [],
    editingPkgId: null, plSaved: false, plMeta: {},
  };
  let _inited = false;

  async function ensureRole() {
    if (window.CURRENT_USER) { state.isAdmin = window.CURRENT_USER.role === "admin"; return; }
    try {
      const r = await fetch("/auth/me");
      if (r.ok) { const u = await r.json(); window.CURRENT_USER = u; state.isAdmin = u.role === "admin"; }
    } catch (_) {}
  }

  function applyRole() {
    const panel = q("#panel-prep");
    if (panel) panel.classList.toggle("prep-staff", !state.isAdmin);
    const note = q("#prepRoleNote");
    if (note) note.textContent = state.isAdmin
      ? "Admin — full edit access"
      : "View only — editing is restricted to administrators";
  }

  // ---- init (called by switchPanel each time the panel opens) ----
  window.loadPrep = async function loadPrep() {
    await ensureRole();
    applyRole();
    if (!_inited) {
      _inited = true;
      initDatePicker();
      wireButtons();
    }
    if (state.date) refreshAll();
  };

  function initDatePicker() {
    const el = q("#prepBatchDate");
    if (!el) return;
    const dates = (window.ALL_DATES && window.ALL_DATES.length) ? window.ALL_DATES : undefined;
    if (window.flatpickr) {
      flatpickr(el, {
        dateFormat: "Y-m-d", altInput: true, altFormat: "D, j M Y",
        locale: { firstDayOfWeek: 1 }, allowInput: true, enable: dates,
        onChange: (_, ds) => { if (ds) selectBatch(ds); },
      });
    } else {
      el.addEventListener("change", () => { if (el.value) selectBatch(el.value); });
    }
    // Preselect current single-batch filter if present
    const pre = window.FILTER_START && window.FILTER_START === window.FILTER_END
      ? window.FILTER_START : (dates ? dates[0] : null);
    if (pre) {
      if (el._flatpickr) el._flatpickr.setDate(pre, true);
      else { el.value = pre; selectBatch(pre); }
    }
  }

  function selectBatch(ds) {
    state.date = ds;
    q("#prepEmpty")?.classList.add("hidden");
    q("#prepContent")?.classList.remove("hidden");
    refreshDocLinks();
    refreshAll();
  }

  function refreshDocLinks() {
    const d = state.date;
    const set = (id, href) => { const a = q(id); if (a) a.href = href; };
    set("#prepDocLabels", `/prep/${d}/labels.html`);
    set("#prepDocPacking", `/prep/${d}/packing-list.html`);
    set("#prepDocInvoice", `/prep/${d}/invoice.html`);
    set("#prepDocSummary", `/prep/${d}/summary.html`);
  }

  async function refreshAll() {
    await Promise.all([loadDashboard(), loadPackages(), loadParcels()]);
    await loadPackingList();
  }

  // ---- dashboard ----
  async function loadDashboard() {
    try {
      const r = await fetch(`/api/prep/dashboard?date=${state.date}`);
      if (!r.ok) return;
      const d = await r.json();
      const kpi = (val, lbl, cls = "") =>
        `<div class="prep-kpi ${cls}"><div class="pk-val">${val}</div><div class="pk-lbl">${lbl}</div></div>`;
      q("#prepKpis").innerHTML =
        kpi(d.total_packages, "Packages") +
        kpi(d.total_parcels, "Parcels") +
        kpi(d.assigned_parcels, "Assigned") +
        kpi(d.unassigned_parcels, "Unassigned", d.unassigned_parcels ? "warn" : "") +
        kpi((d.total_weight).toLocaleString() + " kg", "Total weight") +
        kpi(money(d.total_declared_value), "Declared value") +
        kpi(d.battery_items, "Battery parcels", d.battery_items ? "warn" : "") +
        kpi(d.packing_list_generated ? "✓" : "—", "Packing list");
      const rd = q("#prepReadiness");
      rd.textContent = d.readiness;
      rd.className = "prep-readiness " + (d.ready ? "ready" : "pending");
      q("#prepWarnings").innerHTML = (d.warnings || []).map(w =>
        `<div class="prep-warn lvl-${w.level}">${esc(w.text)}</div>`).join("");
    } catch (e) { console.warn(e); }
  }

  // ---- packages ----
  async function loadPackages() {
    try {
      const r = await fetch(`/api/prep/packages?date=${state.date}`);
      if (!r.ok) return;
      state.packages = await r.json();
      renderPackages();
      renderAssignTarget();
    } catch (e) { console.warn(e); }
  }

  function renderPackages() {
    const total = state.packages.length;
    q("#prepPkgCount").textContent = total ? `(${total})` : "";
    const rows = state.packages.map(p => {
      const dims = `${p.length_cm || 0}×${p.width_cm || 0}×${p.height_cm || 0}`;
      const bat = (p.battery && p.battery.present)
        ? `<span class="prep-bat-badge">⚠ ${p.battery.un_numbers && p.battery.un_numbers.length ? p.battery.un_numbers.join(",") : "Battery"}</span>` : "—";
      const pcount = p.parcel_count_manual != null ? p.parcel_count_manual : p.parcel_count;
      return `<tr>
        <td><strong>${p.package_number} / ${total}</strong></td>
        <td>${esc(p.package_type)}</td>
        <td class="small">${esc(p.reference_number)}</td>
        <td>${pcount}</td>
        <td class="num">${(p.gross_weight || 0).toLocaleString()}</td>
        <td class="small">${dims}</td>
        <td class="num">${(p.total_declared_value || 0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
        <td>${bat}</td>
        <td><span class="prep-status s-${(p.status||'').replace(/\s+/g,'-').toLowerCase()}">${esc(p.status)}</span></td>
        <td class="admin-only prep-pkg-actions">
          <button class="btn small" data-edit="${p.id}">Edit</button>
          <a class="btn small ghost" href="/prep/package/${p.id}/label.html" target="_blank">Label</a>
          <button class="btn small danger" data-del="${p.id}">✕</button>
        </td>
      </tr>`;
    }).join("");
    q("#prepPkgRows").innerHTML = rows ||
      `<tr><td colspan="10" class="muted" style="text-align:center;padding:12px;">No packages yet. ${state.isAdmin ? "Click “New Package”." : ""}</td></tr>`;
    qa("#prepPkgRows [data-edit]").forEach(b => b.onclick = () => openPkgModal(Number(b.dataset.edit)));
    qa("#prepPkgRows [data-del]").forEach(b => b.onclick = () => deletePkg(Number(b.dataset.del)));
  }

  function renderAssignTarget() {
    const sel = q("#prepAssignTarget");
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = state.packages.map(p =>
      `<option value="${p.id}">#${p.package_number} · ${esc(p.package_type)} · ${esc(p.reference_number)}</option>`).join("")
      || `<option value="">(no packages — create one first)</option>`;
    // Keep the previously selected carton active instead of jumping back to the first.
    if (prev && state.packages.some(p => String(p.id) === prev)) sel.value = prev;
  }

  // ---- parcels + assignment ----
  async function loadParcels() {
    try {
      const r = await fetch(`/api/prep/parcels?date=${state.date}`);
      if (!r.ok) return;
      state.parcels = await r.json();
      renderParcels();
    } catch (e) { console.warn(e); }
  }

  function pkgNumFor(id) {
    const p = state.packages.find(x => x.id === id);
    return p ? `#${p.package_number}` : "—";
  }

  // Outer package number + type, e.g. "#3 Carton" — used in the Assign
  // Parcels list, shown immediately after each box's weight.
  function pkgLabelFor(id) {
    const p = state.packages.find(x => x.id === id);
    if (!p) return "—";
    return p.package_type ? `#${p.package_number} ${p.package_type}` : `#${p.package_number}`;
  }

  function renderParcels() {
    const unassigned = state.parcels.filter(p => !p.package_id).length;
    q("#prepUnassignedNote").textContent = unassigned
      ? `${unassigned} unassigned` : "All parcels assigned ✓";
    q("#prepUnassignedNote").className = "muted small" + (unassigned ? " prep-warn-text" : "");
    q("#prepParcelList").innerHTML = state.parcels.map(p => {
      const assigned = p.package_id ? `<span class="prep-asgn">${pkgLabelFor(p.package_id)}</span>` : `<span class="prep-unasgn">unassigned</span>`;
      const bat = p.has_battery ? `<span class="prep-bat-dot" title="Battery info detected">🔋</span>` : "";
      return `<label class="prep-parcel ${p.package_id ? "" : "is-unassigned"}">
        <input type="checkbox" class="prep-pcheck" value="${p.id}">
        <span class="pp-box">BOX ${p.box_number}</span>
        <span class="pp-mf">${esc(p.mf_number)}</span>
        <span class="pp-desc">${esc((p.description||"").slice(0,60))}</span>
        <span class="pp-wt">${(p.weight||0)}kg</span>
        ${assigned}${bat}
      </label>`;
    }).join("") || `<p class="muted small">No parcels recorded for this batch date.</p>`;
  }

  function selectedParcelIds() {
    return qa(".prep-pcheck:checked").map(c => Number(c.value));
  }

  async function assignSelected(packageId) {
    let ids = selectedParcelIds();
    if (!ids.length) { notify("Tick at least one parcel first", "err"); return; }
    if (packageId !== null && !state.packages.length) { notify("Create a package first", "err"); return; }
    // Prevent duplicate assignments: a parcel already in another carton must be
    // unassigned first before it can move to a different carton.
    if (packageId !== null) {
      const blocked = ids.filter(id => {
        const p = state.parcels.find(x => x.id === id);
        return p && p.package_id && p.package_id !== packageId;
      });
      if (blocked.length) {
        ids = ids.filter(id => !blocked.includes(id));
        const names = blocked.map(id => {
          const p = state.parcels.find(x => x.id === id);
          return p ? `BOX ${p.box_number} (${pkgNumFor(p.package_id)})` : id;
        }).join(", ");
        if (!ids.length) {
          notify(`Already assigned — unassign first: ${names}`, "err");
          return;
        }
        notify(`Skipped already-assigned parcel(s): ${names}. Unassign them first.`, "err");
      }
    }
    const r = await fetch("/api/prep/assign", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parcel_ids: ids, package_id: packageId }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { notify(d.detail || "Assignment failed", "err"); return; }
    notify(packageId === null ? "Parcels unassigned" : `Assigned ${d.moved} parcel(s)`);
    await Promise.all([loadParcels(), loadPackages(), loadDashboard()]);
  }

  // ---- package modal ----
  function openPkgModal(id) {
    state.editingPkgId = id || null;
    const p = id ? state.packages.find(x => x.id === id) : null;
    q("#prepPkgModalTitle").textContent = p ? `Edit Package #${p.package_number}` : "New Package";
    q("#pkgType").value = p ? p.package_type : "Carton";
    q("#pkgStatus").value = p ? p.status : "Open";
    q("#pkgWeight").value = p ? (p.gross_weight || "") : "";
    q("#pkgRef").value = p ? p.reference_number : "";
    q("#pkgL").value = p ? (p.length_cm || "") : "";
    q("#pkgW").value = p ? (p.width_cm || "") : "";
    q("#pkgH").value = p ? (p.height_cm || "") : "";
    q("#pkgManual").value = p && p.parcel_count_manual != null ? p.parcel_count_manual : "";
    q("#pkgNotes").value = p ? p.notes : "";
    q("#pkgDropoff").value = p && p.dropoff_reference ? p.dropoff_reference : "";
    const marks = (p && p.handling_marks) ? p.handling_marks : [];
    qa(".pkgHandling").forEach(cb => { cb.checked = marks.includes(cb.value); });
    q("#prepPkgModal").classList.remove("hidden");
  }
  function closePkgModal() { q("#prepPkgModal").classList.add("hidden"); }

  async function savePkg() {
    const body = {
      batch_date: state.date,
      package_type: q("#pkgType").value,
      status: q("#pkgStatus").value,
      gross_weight: parseFloat(q("#pkgWeight").value) || 0,
      reference_number: q("#pkgRef").value.trim(),
      length_cm: parseFloat(q("#pkgL").value) || 0,
      width_cm: parseFloat(q("#pkgW").value) || 0,
      height_cm: parseFloat(q("#pkgH").value) || 0,
      notes: q("#pkgNotes").value.trim(),
      dropoff_reference: q("#pkgDropoff").value.trim(),
      handling_marks: qa(".pkgHandling").filter(cb => cb.checked).map(cb => cb.value),
    };
    const man = q("#pkgManual").value.trim();
    body.parcel_count_manual = man === "" ? null : parseInt(man, 10);
    const id = state.editingPkgId;
    const url = id ? `/api/prep/packages/${id}` : "/api/prep/packages";
    const method = id ? "PUT" : "POST";
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { notify(d.detail || "Could not save package", "err"); return; }
    notify(id ? "Package updated" : `Package #${d.package_number} created`);
    closePkgModal();
    await Promise.all([loadPackages(), loadParcels(), loadDashboard()]);
  }

  async function deletePkg(id) {
    const p = state.packages.find(x => x.id === id);
    if (!confirm(`Delete package #${p ? p.package_number : id}? Parcels inside will be unassigned.`)) return;
    const r = await fetch(`/api/prep/packages/${id}`, { method: "DELETE" });
    if (!r.ok) { const d = await r.json().catch(() => ({})); notify(d.detail || "Delete failed", "err"); return; }
    notify("Package deleted");
    await Promise.all([loadPackages(), loadParcels(), loadDashboard()]);
  }

  // ---- packing list / invoice ----
  async function loadPackingList() {
    try {
      const r = await fetch(`/api/prep/packing-list?date=${state.date}`);
      if (!r.ok) return;
      const d = await r.json();
      state.items = (d.items || []).map(i => ({ ...i }));
      state.plSaved = !!d.saved;
      state.plMeta = d;
      q("#prepSignerName").value = d.signer_name || "";
      q("#prepDocDate").value = d.doc_date || "";
      q("#prepPLStatus").textContent = d.generated_at
        ? `Last generated ${d.generated_at.slice(0, 16).replace("T", " ")}`
        : "Not generated yet";
      renderItems();
    } catch (e) { console.warn(e); }
  }

  function renderItems() {
    const tbody = q("#prepItemRows");
    tbody.innerHTML = state.items.map((it, i) => `
      <tr data-i="${i}">
        <td><input class="pl-in pl-desc" value="${esc(it.description)}"></td>
        <td class="num"><input class="pl-in pl-qty num" type="number" step="1" value="${it.qty}"></td>
        <td class="num"><input class="pl-in pl-unit num" type="number" step="0.01" value="${it.unit_price}"></td>
        <td class="num"><input class="pl-in pl-amt num" type="number" step="0.01" value="${it.amount}"></td>
        <td class="admin-only"><button class="btn small danger pl-del">✕</button></td>
      </tr>`).join("") ||
      `<tr><td colspan="5" class="muted" style="text-align:center;padding:10px;">No items — assign parcels then auto-summarise.</td></tr>`;
    wireItemInputs();
    recalcItems();
  }

  function wireItemInputs() {
    qa("#prepItemRows tr[data-i]").forEach(tr => {
      const i = Number(tr.dataset.i);
      const desc = q(".pl-desc", tr), qty = q(".pl-qty", tr),
            unit = q(".pl-unit", tr), amt = q(".pl-amt", tr);
      desc.oninput = () => state.items[i].description = desc.value;
      const sync = (autoAmt) => {
        state.items[i].qty = parseFloat(qty.value) || 0;
        state.items[i].unit_price = parseFloat(unit.value) || 0;
        if (autoAmt) {
          state.items[i].amount = +(state.items[i].qty * state.items[i].unit_price).toFixed(2);
          amt.value = state.items[i].amount;
        } else {
          state.items[i].amount = parseFloat(amt.value) || 0;
        }
        recalcItems();
      };
      qty.oninput = () => sync(true);
      unit.oninput = () => sync(true);
      amt.oninput = () => sync(false);
      q(".pl-del", tr).onclick = () => { state.items.splice(i, 1); renderItems(); };
    });
  }

  function recalcItems() {
    const tot = state.items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
    const qty = state.items.reduce((s, it) => s + (Number(it.qty) || 0), 0);
    q("#prepItemsTotal").textContent = money(tot);
    q("#prepItemsQty").textContent = qty;
  }

  async function reSummarise() {
    // Force a fresh auto-summary by reading the (unsaved) computed summary.
    // We bypass any saved record by recomputing client-side from parcels list.
    try {
      const r = await fetch(`/api/prep/packing-list?date=${state.date}&_fresh=1`);
      const d = await r.json();
      // If a saved record exists the server returns it; for a true re-summary
      // we re-derive from parcels via the packages' item summaries.
      const map = new Map();
      state.packages.forEach(p => (p.item_summary || []).forEach(it => {
        const k = it.description.toLowerCase();
        const cur = map.get(k) || { description: it.description, qty: 0, unit_price: 0, amount: 0 };
        cur.qty += it.qty; cur.amount += it.amount; map.set(k, cur);
      }));
      let items = [...map.values()];
      if (!items.length) items = (d.items || []).map(i => ({ ...i }));
      items.forEach(it => { it.unit_price = it.qty ? +(it.amount / it.qty).toFixed(2) : 0; });
      state.items = items;
      renderItems();
      notify("Items re-summarised from current packages");
    } catch (e) { notify("Could not re-summarise", "err"); }
  }

  function mergeDuplicateItems() {
    const map = new Map();
    const order = [];
    state.items.forEach(it => {
      const key = (it.description || "").trim().toLowerCase();
      if (!key) return;
      if (!map.has(key)) {
        map.set(key, { description: (it.description || "").trim(), qty: 0, unit_price: 0, amount: 0 });
        order.push(key);
      }
      const cur = map.get(key);
      cur.qty += Number(it.qty) || 0;
      cur.amount += Number(it.amount) || 0;
    });
    const before = state.items.length;
    state.items = order.map(k => {
      const row = map.get(k);
      row.qty = +row.qty.toFixed(2);
      row.amount = +row.amount.toFixed(2);
      row.unit_price = row.qty ? +(row.amount / row.qty).toFixed(2) : 0;
      return row;
    });
    renderItems();
    const removed = before - state.items.length;
    notify(removed > 0 ? `Merged ${removed} duplicate line(s)` : "No duplicate descriptions to merge");
  }

  async function savePackingList() {
    const body = {
      batch_date: state.date,
      items: state.items,
      signer_name: q("#prepSignerName").value.trim(),
      doc_date: q("#prepDocDate").value.trim(),
    };
    const r = await fetch("/api/prep/packing-list", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { notify(d.detail || "Save failed", "err"); return; }
    notify("Packing list saved & generated");
    await loadPackingList();
    loadDashboard();
  }

  // ---- buttons ----
  function wireButtons() {
    q("#prepAddPkgBtn")?.addEventListener("click", () => openPkgModal(null));
    q("#prepPkgSave")?.addEventListener("click", savePkg);
    q("#prepPkgCancel")?.addEventListener("click", closePkgModal);
    q("#prepPkgModalClose")?.addEventListener("click", closePkgModal);
    q("#prepAssignBtn")?.addEventListener("click", () => {
      const id = q("#prepAssignTarget").value;
      assignSelected(id ? Number(id) : null);
    });
    q("#prepUnassignBtn")?.addEventListener("click", () => assignSelected(null));
    q("#prepReSummariseBtn")?.addEventListener("click", reSummarise);
    q("#prepMergeItemsBtn")?.addEventListener("click", mergeDuplicateItems);
    q("#prepAddItemBtn")?.addEventListener("click", () => {
      state.items.push({ description: "", qty: 1, unit_price: 0, amount: 0 });
      renderItems();
    });
    q("#prepSavePLBtn")?.addEventListener("click", savePackingList);
  }

  // If the page restored directly onto the Prep panel, app.js called
  // switchPanel("prep") before this script defined loadPrep — bootstrap now.
  if (document.querySelector("#panel-prep.active")) window.loadPrep();
})();
