// Workbook sheet specs for write-excel-file (browser and Node entries share them). Pure ESM, no DOM.
// Every text value is a String cell (never a formula); only real numbers are Number cells.
import { COMPARTMENTS, COMP_LABEL, DIMENSIONS, INVENTORY_BY_NAME, MASTER_INVENTORY, SLOTS_PER_COMPARTMENT } from '../../../shared/apparatus.js';

export const SHEET_NAMES = Object.freeze([
  'Compartment Inventory', 'Equipment Catalog', 'Compartment Summary', 'Bundles and Kits', 'Notes and Exceptions',
  'Export Metadata', 'Compartments', 'Inventory Status',
]);
export const PROTECTED_TEXT = 'Yes — unchanged by this export (read-only)';

const cell = (value, header) => ({
  value: typeof value === 'number' && Number.isFinite(value) ? value : String(value ?? ''),
  type: typeof value === 'number' && Number.isFinite(value) ? Number : String,
  fontWeight: header ? 'bold' : undefined,
});
const toSheet = rows => rows.map((row, i) => row.map(v => cell(v, i === 0)));
const sheet = (name, headers, rows, widths) => ({ sheet: name, data: toSheet([headers, ...rows]), stickyRowsCount: 1, columns: widths.map(width => ({ width })) });
const bundleText = l => (l.bundles ?? []).map(b => `${b.name} (${b.slots.map(s => s + 1).join(', ')})`).join('; ');
const yesNo = b => (b ? 'Yes' : 'No');
const verText = v => (v.status === 'needs_verification' ? 'Needs verification' : 'Verified');

/** Rows of the two legacy sheets, byte-for-byte the logic of the pre-manifest export. */
export function legacyRows(snapshot) {
  const { allocations, customQtys, customTools, customDimensions, removedItems } = snapshot.legacy;
  const compHeaders = ['Slot', ...COMPARTMENTS.map(c => c.label ?? c.id)];
  const maxSlots = Math.max(SLOTS_PER_COMPARTMENT, ...COMPARTMENTS.map(c => (allocations[c.id] ?? []).length));
  const compRows = [];
  for (let i = 0; i < maxSlots; i++) compRows.push([i + 1, ...COMPARTMENTS.map(c => (allocations[c.id] ?? [])[i] || '')]);

  const inventory = [...MASTER_INVENTORY.filter(i => !removedItems.includes(i.name)), ...customTools];
  const dims = { ...DIMENSIONS, ...customDimensions };
  customTools.forEach(t => { if (t.dimensions) dims[t.name] = t.dimensions; });
  const getQty = name => {
    if (customQtys[name] !== undefined) return customQtys[name];
    const ct = customTools.find(t => t.name === name);
    if (ct) return ct.qty;
    return INVENTORY_BY_NAME[name]?.qty ?? 0;
  };
  const stats = {};
  inventory.forEach(item => { stats[item.name] = { total: 0, byComp: {} }; });
  COMPARTMENTS.forEach(comp => {
    allocations[comp.id].forEach(slot => {
      if (slot && stats[slot]) {
        stats[slot].total += 1;
        stats[slot].byComp[comp.id] = (stats[slot].byComp[comp.id] ?? 0) + 1;
      }
    });
  });
  const invHeaders = ['Equipment Item', 'Total Qty', 'Placed', 'Remaining', 'Assigned To', 'Dimensions', 'Status'];
  const invRows = inventory.map(item => {
    const s = stats[item.name];
    const qty = getQty(item.name);
    const placed = s?.total ?? 0;
    const remaining = qty - placed;
    const assignedTo = Object.entries(s?.byComp ?? {})
      .map(([comp, cnt]) => cnt > 1 ? `${COMP_LABEL[comp] ?? comp} x${cnt}` : (COMP_LABEL[comp] ?? comp)).join(', ');
    const status = placed > qty ? 'Over' : remaining === 0 ? 'Complete' : placed > 0 ? 'Partial' : 'Pending';
    return [item.name, qty, placed, remaining, assignedTo || '', dims[item.name] || '', status];
  });
  return { compHeaders, compRows, invHeaders, invRows };
}

/**
 * @param {ReturnType<import('./snapshot.js').buildSnapshot>} snapshot
 * @param {ReturnType<import('./manifest.js').buildManifest>} manifest
 * @returns {object[]} write-excel-file sheet specs, in output order
 */
export function buildWorkbookSheets(snapshot, manifest) {
  const sideOf = Object.fromEntries(snapshot.compartments.map(c => [c.id, c.side]));
  const snapComp = Object.fromEntries(snapshot.compartments.map(c => [c.id, c]));

  const invRows = [];
  for (const c of manifest.compartments) {
    for (const l of c.items) {
      invRows.push([
        c.order + 1, c.label, c.id, c.side, l.name, l.equipmentId, l.quantity, l.slots.map(s => s + 1).join(', '), bundleText(l),
        yesNo(l.custom), verText(l.verification), l.verification.reason, l.dimensions, l.description, c.note?.text ?? '',
      ]);
    }
  }
  const inventorySheet = sheet('Compartment Inventory',
    ['Order', 'Compartment', 'Compartment ID', 'Side', 'Equipment', 'Equipment ID', 'Qty', 'Slots', 'Bundle', 'Custom item', 'Verification', 'Verification reason', 'Dimensions', 'Description', 'Compartment note'],
    invRows, [7, 16, 15, 8, 44, 24, 6, 18, 22, 11, 20, 30, 24, 50, 50]);

  const catalogSheet = sheet('Equipment Catalog',
    ['Equipment', 'Equipment ID', 'Qty', 'Assigned', 'Remaining', 'Custom item', 'Verification', 'Verification reason', 'Compartments', 'Dimensions', 'Description'],
    manifest.catalog.map(i => [
      i.name, i.equipmentId, i.quantity, i.assigned, i.remaining, yesNo(i.custom), verText(i.verification), i.verification.reason,
      Object.entries(i.compartments).map(([id, n]) => `${COMP_LABEL[id] ?? id}${n > 1 ? ` x${n}` : ''}`).join(', '), i.dimensions, i.description,
    ]), [44, 24, 6, 9, 10, 11, 20, 30, 30, 24, 50]);

  const warnings = id => manifest.exceptions.filter(e => e.compartmentId === id).map(e => e.message).join(' | ');
  const summarySheet = sheet('Compartment Summary',
    ['Order', 'Compartment', 'Compartment ID', 'Side', 'Lines', 'Units', 'Slots used / total', 'Protected', 'Note', 'Spec', 'Warnings'],
    manifest.compartments.map(c => {
      const used = snapComp[c.id].slots.filter(Boolean).length;
      return [
        c.order + 1, c.label, c.id, sideOf[c.id], c.items.length, c.items.reduce((n, l) => n + l.quantity, 0), `${used} / ${snapComp[c.id].totalSlots}`,
        c.protected ? PROTECTED_TEXT : 'No', c.note?.text ?? '', c.spec, warnings(c.id),
      ];
    }), [7, 16, 15, 8, 7, 7, 17, 42, 50, 70, 60]);

  const bundleRows = [];
  for (const c of snapshot.compartments) {
    for (const b of c.bundles) {
      const members = b.slotIndices.filter(i => c.slots[i]);
      if (!members.length) bundleRows.push([c.order + 1, c.label, b.name, b.id, 0, '', '', '']);
      for (const i of members) bundleRows.push([c.order + 1, c.label, b.name, b.id, members.length, i + 1, c.slots[i], manifest.compartments[c.order].items.find(l => l.name === c.slots[i])?.equipmentId ?? '']);
    }
  }
  const bundleSheet = sheet('Bundles and Kits', ['Order', 'Compartment', 'Bundle', 'Bundle ID', 'Members', 'Slot', 'Equipment', 'Equipment ID'], bundleRows, [7, 16, 28, 30, 9, 6, 44, 24]);

  const noteRows = [];
  for (const c of manifest.compartments) if (c.note) noteRows.push(['Compartment note', c.label, '', c.note.text, c.note.updatedAt ? new Date(c.note.updatedAt).toISOString() : '']);
  for (const e of manifest.exceptions) {
    const eq = e.equipmentId ? (manifest.catalog.find(i => i.equipmentId === e.equipmentId)?.name ?? '') : '';
    noteRows.push([({ needs_verification: 'Needs verification', over_allocated: 'Over-allocated', empty_compartment: 'Empty compartment' })[e.type] ?? e.type,
      e.compartmentId ? (COMP_LABEL[e.compartmentId] ?? e.compartmentId) : '', eq, e.message, '']);
  }
  const notesSheet = sheet('Notes and Exceptions', ['Kind', 'Compartment', 'Equipment', 'Detail', 'Updated (UTC)'], noteRows, [20, 16, 40, 90, 26]);

  const s = manifest.source;
  const t = manifest.totals;
  const meta = [
    ['Schema', manifest.schema], ['Source app', s.app], ['Origin', s.origin], ['Build SHA', s.buildSha], ['Planner revision', s.plannerRevision],
    ['Sync state', s.syncState], ['Pending changes', s.pendingChanges], ['Exported at (UTC ISO)', s.exportedAt], ['Snapshot SHA-256', s.snapshotSha256],
    ['Counting rule', manifest.countingRule], ['Total compartments', t.compartments], ['Total lines', t.lines], ['Total units', t.units],
    ['Catalog items', t.catalogItems], ['Unassigned catalog items', t.unassignedCatalogItems], ['Needs verification', t.needsVerification],
    ...manifest.compartments.map(c => [`Units by compartment: ${c.id}`, c.items.reduce((n, l) => n + l.quantity, 0)]),
  ];
  const metaSheet = sheet('Export Metadata', ['Key', 'Value'], meta, [32, 70]);

  const lg = legacyRows(snapshot);
  return [
    inventorySheet, catalogSheet, summarySheet, bundleSheet, notesSheet, metaSheet,
    { data: toSheet([lg.compHeaders, ...lg.compRows]), sheet: 'Compartments', stickyRowsCount: 1 },
    { data: toSheet([lg.invHeaders, ...lg.invRows]), sheet: 'Inventory Status', stickyRowsCount: 1 },
  ];
}
