// Frozen export snapshot: everything the workbook and the checklist-transfer manifest need, captured once.
// Pure ESM (no DOM) so the browser, the Vitest suite and scripts/export-manifest.mjs share it.
import { COMPARTMENTS, COMPARTMENT_SPECS, COMP_LABEL, DIMENSIONS, INVENTORY_BY_NAME, MASTER_INVENTORY, SLOTS_PER_COMPARTMENT, VISUAL_DESCRIPTIONS } from '../../../shared/apparatus.js';
import { COMPARTMENT_IDS } from '../../../shared/contracts.js';
import * as contracts from '../../../shared/contracts.js';
import { equipmentIdForNameSync } from '../../../shared/ids.js';
import { baseEquipmentIds } from '../../../shared/lib/doc.js';

// Frozen compartments (owner directive, see docs/architecture/notes-verification-transfer.md §1). The shared contract
// owns the list; until it exports NOTES_LOCKED_COMPARTMENTS the contract value ['RS3'] is used.
export const LOCKED_COMPARTMENTS = Object.freeze([...(contracts['NOTES_LOCKED_COMPARTMENTS'] ?? ['RS3'])]);

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v : '');

/** Recursively freeze plain data. @template T @param {T} value @returns {T} */
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * @param {{doc:object, revision?:number, pending?:number, syncState?:'confirmed'|'local_changes', buildSha?:string,
 *   origin?:string, exportedAt?:string}} input doc = planner view/doc (equipmentIds/assignmentIds/notes/unverified optional)
 * @returns {Readonly<object>} deeply frozen snapshot
 */
export function buildSnapshot({ doc, revision = 0, pending = 0, syncState = 'confirmed', buildSha = 'local', origin = '', exportedAt = new Date().toISOString() }) {
  const d = isObj(doc) ? doc : {};
  const allocations = {};
  const assignmentIds = {};
  for (const id of COMPARTMENT_IDS) {
    const slots = Array.isArray(d.allocations?.[id]) ? d.allocations[id].map(str) : [];
    allocations[id] = slots;
    const ids = Array.isArray(d.assignmentIds?.[id]) ? d.assignmentIds[id] : [];
    assignmentIds[id] = slots.map((_, i) => (typeof ids[i] === 'string' && ids[i] ? ids[i] : null));
  }
  const customQtys = isObj(d.customQtys) ? { ...d.customQtys } : {};
  const customTools = (Array.isArray(d.customTools) ? d.customTools : []).filter(t => isObj(t) && str(t.name))
    .map(t => ({ name: t.name, qty: Number.isFinite(t.qty) ? t.qty : 1, dimensions: str(t.dimensions), description: str(t.description) }));
  const customDimensions = isObj(d.customDimensions) ? { ...d.customDimensions } : {};
  const removed = new Set((Array.isArray(d.removedItems) ? d.removedItems : []).filter(v => typeof v === 'string'));
  const unverified = isObj(d.unverified) ? Object.fromEntries(Object.entries(d.unverified).map(([k, v]) => [k, str(v)])) : {};
  const notes = isObj(d.notes) ? d.notes : {};
  const baseIds = baseEquipmentIds();
  const idOf = name => (isObj(d.equipmentIds) && d.equipmentIds[name]) || baseIds[name] || equipmentIdForNameSync(name);
  const toolByName = Object.fromEntries(customTools.map(t => [t.name, t]));
  const qtyOf = name => customQtys[name] ?? toolByName[name]?.qty ?? INVENTORY_BY_NAME[name]?.qty ?? 0;
  const dimsOf = name => toolByName[name]?.dimensions || customDimensions[name] || DIMENSIONS[name] || '';

  // Effective inventory in App order: standard items minus removed, then custom tools.
  const names = [...MASTER_INVENTORY.filter(i => !removed.has(i.name)).map(i => i.name), ...customTools.map(t => t.name)];
  const assignedTotal = {};
  for (const slots of Object.values(allocations)) for (const n of slots) if (n) assignedTotal[n] = (assignedTotal[n] ?? 0) + 1;
  const describe = name => ({
    name, equipmentId: idOf(name), qty: qtyOf(name), dimensions: dimsOf(name), description: toolByName[name] ? toolByName[name].description : (VISUAL_DESCRIPTIONS[name] ?? ''),
    custom: name in toolByName,
    verification: name in unverified ? { status: 'needs_verification', reason: unverified[name] } : { status: 'verified', reason: '' },
  });
  const inventory = names.map(name => ({ ...describe(name), assigned: assignedTotal[name] ?? 0 }));
  const inCatalog = new Set(names);
  // Names that sit in a slot but are not in the effective inventory (removed items): still described, flagged later.
  const strays = [...new Set(Object.values(allocations).flat().filter(n => n && !inCatalog.has(n)))].map(describe);

  const compartments = COMPARTMENT_IDS.map((id, order) => {
    const meta = COMPARTMENTS.find(c => c.id === id);
    const n = notes[id];
    const slots = allocations[id];
    return {
      id, order, label: COMP_LABEL[id] ?? id, side: meta?.side ?? '', protected: LOCKED_COMPARTMENTS.includes(id),
      spec: COMPARTMENT_SPECS[id] ?? '',
      note: isObj(n) && str(n.text) ? { text: n.text, updatedAt: Number.isFinite(n.updatedAt) ? n.updatedAt : 0 } : null,
      slots, assignmentIds: assignmentIds[id], totalSlots: Math.max(SLOTS_PER_COMPARTMENT, slots.length),
      bundles: (Array.isArray(d.bundles?.[id]) ? d.bundles[id] : []).filter(b => isObj(b) && Array.isArray(b.slotIndices))
        .map(b => ({ id: str(b.id), name: str(b.name), slotIndices: b.slotIndices.filter(Number.isInteger) })),
    };
  });

  return deepFreeze({
    source: {
      origin: str(origin), buildSha: str(buildSha) || 'local', plannerRevision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
      syncState: syncState === 'local_changes' ? 'local_changes' : 'confirmed',
      pendingChanges: Number.isInteger(pending) && pending > 0 ? pending : 0, exportedAt,
    },
    compartments, inventory, strays,
    // Raw planner data the legacy sheets are derived from (identical logic to the pre-manifest export).
    legacy: { allocations, customQtys, customTools, customDimensions, removedItems: [...removed] },
  });
}
