// Planner doc v2 + op engine (docs/architecture/ai-compartment-studio.md §4). Pure ESM, no I/O.
// v1 view = {allocations, customQtys, customTools, bundles, removedItems, customDimensions};
// v2 = v1 + {schema:2, equipmentIds:{name→'eq_…'}, assignmentIds:{compId→('as_…'|null)[]}}.
// Ops are plain objects discriminated by `op` (one of contracts PLANNER_OPS), e.g.
//   {op:'setSlot', comp, index, value, expect}, {op:'setSlotCount', comp, count, expect}, {op:'setCustomQty', name, qty|null},
//   {op:'upsertCustomTool', tool:{name, qty, dimensions?, description?, equipmentId?}}, {op:'removeCustomTool', name},
//   {op:'setDimension', name, value|null}, {op:'setRemoved', name, removed}, {op:'upsertBundle', comp, bundle},
//   {op:'deleteBundle', comp, id}, {op:'renameEquipment', from, to}.
import { assignedCounts, effectiveInventory, emptyDocV2, equipmentIdOf, normalizeDoc } from './lib/doc.js';
import { diffDocs } from './lib/diff.js';
import { migrateV1toV2, projectV1 } from './lib/migrate.js';
import { applyOps, validateOp } from './lib/ops.js';

export { applyOps, assignedCounts, diffDocs, effectiveInventory, emptyDocV2, migrateV1toV2, normalizeDoc, projectV1, validateOp };

/**
 * Rows for one compartment: [{slotIndex, name, equipmentId, assignmentId, bundleId}] (occupied slots only).
 * bundleId follows App.jsx slotBundleMap (the last bundle listing a slot wins); null when unbundled.
 * @param {object} doc @param {string} compId
 */
export function compartmentAssignments(doc, compId) {
  const slots = doc.allocations?.[compId] ?? [];
  const bundleOf = {};
  for (const b of doc.bundles?.[compId] ?? []) for (const i of b.slotIndices) bundleOf[i] = b.id;
  const rows = [];
  slots.forEach((name, slotIndex) => {
    if (!name) return;
    rows.push({
      slotIndex, name, equipmentId: equipmentIdOf(doc, name),
      assignmentId: doc.assignmentIds?.[compId]?.[slotIndex] ?? null, bundleId: bundleOf[slotIndex] ?? null,
    });
  });
  return rows;
}
