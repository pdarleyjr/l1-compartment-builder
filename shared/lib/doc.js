// Planner doc v2 basics: empty doc, effective inventory, counts, invariants repair. See shared/planner.js.
import { COMPARTMENT_IDS, ID_PREFIX, PLANNER_SCHEMA } from '../contracts.js';
import { DIMENSIONS, INVENTORY_BY_NAME, MASTER_INVENTORY, SLOTS_PER_COMPARTMENT } from '../apparatus.js';
import { equipmentIdForNameSync, newId as defaultNewId } from '../ids.js';

export const clone = value => globalThis.structuredClone(value);
export const isBaseName = name => Object.prototype.hasOwnProperty.call(INVENTORY_BY_NAME, name);

/** Deterministic ids of every base-inventory name (computed once). */
let baseIdCache = null;
export function baseEquipmentIds() {
  if (!baseIdCache) baseIdCache = Object.fromEntries(MASTER_INVENTORY.map(i => [i.name, equipmentIdForNameSync(i.name)]));
  return baseIdCache;
}

/** @returns {object} empty v2 doc with all COMPARTMENT_IDS × SLOTS_PER_COMPARTMENT empty slots */
export function emptyDocV2() {
  const allocations = {};
  const assignmentIds = {};
  for (const id of COMPARTMENT_IDS) {
    allocations[id] = Array(SLOTS_PER_COMPARTMENT).fill('');
    assignmentIds[id] = Array(SLOTS_PER_COMPARTMENT).fill(null);
  }
  return {
    schema: PLANNER_SCHEMA, allocations, customQtys: {}, customTools: [], customDimensions: {}, removedItems: [],
    bundles: {}, equipmentIds: { ...baseEquipmentIds() }, assignmentIds,
  };
}

/** Effective quantity of a name per App.jsx getQty (custom override, then tool/base default). */
export function qtyOf(doc, name) {
  const qtys = doc.customQtys ?? {};
  if (qtys[name] !== undefined) return qtys[name];
  const tool = (doc.customTools ?? []).find(t => t.name === name);
  if (tool) return tool.qty;
  return isBaseName(name) ? INVENTORY_BY_NAME[name].qty : 0;
}

/** Effective dimensions text per App.jsx effectiveDimensions (tool dims, then override, then catalog). */
export function dimsOf(doc, name) {
  const tool = (doc.customTools ?? []).find(t => t.name === name);
  if (tool?.dimensions) return tool.dimensions;
  return (doc.customDimensions ?? {})[name] ?? DIMENSIONS[name] ?? '';
}

/** Names present in the effective inventory (base minus removed, plus custom tools). */
export function inventoryNames(doc) {
  const removed = new Set(doc.removedItems ?? []);
  return [...MASTER_INVENTORY.filter(i => !removed.has(i.name)).map(i => i.name), ...(doc.customTools ?? []).map(t => t.name)];
}

/** Per-name assigned counts across all compartments. @returns {Record<string,number>} */
export function assignedCounts(doc) {
  const counts = {};
  for (const slots of Object.values(doc.allocations ?? {})) {
    for (const name of slots) if (name) counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

/** Equipment id for a name: registry first, then the deterministic base id, else null. */
export function equipmentIdOf(doc, name) {
  return doc.equipmentIds?.[name] ?? (isBaseName(name) ? baseEquipmentIds()[name] : null);
}

/** Effective inventory rows: [{name, qty, dims, custom, equipmentId, assigned, free}] (App.jsx semantics). */
export function effectiveInventory(doc) {
  const counts = assignedCounts(doc);
  const rows = [];
  const removed = new Set(doc.removedItems ?? []);
  const add = (name, custom) => {
    const qty = qtyOf(doc, name);
    const assigned = counts[name] ?? 0;
    rows.push({ name, qty, dims: dimsOf(doc, name), custom, equipmentId: equipmentIdOf(doc, name), assigned, free: Math.max(0, qty - assigned) });
  };
  for (const item of MASTER_INVENTORY) if (!removed.has(item.name)) add(item.name, false);
  for (const tool of doc.customTools ?? []) add(tool.name, true);
  return rows;
}

/**
 * Repair invariants: all compartments present, assignmentIds parity with allocations, every present name has an
 * equipment id, bundles only point at occupied in-range slots (empty bundles deleted). Pure.
 * @param {object} doc @param {{newId?:(prefix:string)=>string}} [ctx]
 * @returns {{doc:object, repairs:string[]}}
 */
export function normalizeDoc(doc, ctx = {}) {
  const mint = ctx.newId ?? defaultNewId;
  const out = clone(doc);
  const repairs = [];
  out.schema = PLANNER_SCHEMA;
  out.allocations ??= {};
  out.customQtys ??= {};
  out.customTools ??= [];
  out.customDimensions ??= {};
  out.removedItems ??= [];
  out.bundles ??= {};
  out.equipmentIds ??= {};
  out.assignmentIds ??= {};
  for (const id of COMPARTMENT_IDS) {
    if (!Array.isArray(out.allocations[id])) {
      out.allocations[id] = Array(SLOTS_PER_COMPARTMENT).fill('');
      repairs.push(`seeded ${id}`);
    }
  }
  for (const [compId, slots] of Object.entries(out.allocations)) {
    const ids = Array.isArray(out.assignmentIds[compId]) ? out.assignmentIds[compId] : [];
    const fixed = slots.map((name, i) => {
      if (!name) return null;
      return ids[i] || (repairs.push(`assignment id ${compId}[${i}]`), mint(ID_PREFIX.assignment));
    });
    if (ids.length && (ids.length !== fixed.length || ids.some((v, i) => (v ?? null) !== fixed[i]))) repairs.push(`assignmentIds parity ${compId}`);
    out.assignmentIds[compId] = fixed;
  }
  for (const compId of Object.keys(out.assignmentIds)) if (!out.allocations[compId]) delete out.assignmentIds[compId];

  // Equipment ids for every name that is in the inventory or in a slot; never reuse an id for two names.
  const names = new Set([...inventoryNames(out), ...Object.values(out.allocations).flat().filter(Boolean)]);
  for (const name of names) {
    if (out.equipmentIds[name]) continue;
    const det = isBaseName(name) ? baseEquipmentIds()[name] : null;
    const id = det && !Object.values(out.equipmentIds).includes(det) ? det : mint(ID_PREFIX.equipment);
    out.equipmentIds[name] = id;
    repairs.push(`equipment id ${name}`);
  }

  for (const [compId, list] of Object.entries(out.bundles)) {
    const slots = out.allocations[compId];
    const kept = [];
    for (const bundle of Array.isArray(list) ? list : []) {
      const seen = new Set();
      const slotIndices = (bundle.slotIndices ?? []).filter(i => {
        const ok = slots && Number.isInteger(i) && i >= 0 && i < slots.length && slots[i] && !seen.has(i);
        if (ok) seen.add(i);
        return ok;
      });
      if (slotIndices.length !== (bundle.slotIndices ?? []).length) repairs.push(`pruned bundle ${compId}/${bundle.id}`);
      if (slotIndices.length) kept.push({ ...bundle, slotIndices });
      else repairs.push(`deleted empty bundle ${compId}/${bundle.id}`);
    }
    if (kept.length) out.bundles[compId] = kept;
    else delete out.bundles[compId];
  }
  return { doc: out, repairs };
}
