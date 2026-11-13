// v1 ↔ v2 conversion. migrateV1toV2 mirrors App.jsx migrateAllocations (renames + compartment seeding) and adds ids.
import { COMPARTMENT_IDS, PLANNER_SCHEMA } from '../contracts.js';
import { CONSOLIDATION_RENAMES, SLOTS_PER_COMPARTMENT, V3_RENAMES } from '../apparatus.js';
import { newId as defaultNewId } from '../ids.js';
import { baseEquipmentIds, clone, inventoryNames, isBaseName, normalizeDoc } from './doc.js';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const renameSlot = v => {
  const renamed = V3_RENAMES[v] ?? v;
  return CONSOLIDATION_RENAMES[renamed] ?? renamed;
};

const cleanTool = t => {
  const out = { ...t };
  delete out.description;
  delete out.equipmentId;
  return out;
};

/**
 * v2 → v1 view: exactly what App.jsx state and the legacy GET /state use (no v2-only fields).
 * @param {object} doc @returns {{allocations:object, customQtys:object, customTools:object[], bundles:object, removedItems:string[], customDimensions:object}}
 */
export function projectV1(doc) {
  return clone({
    allocations: doc.allocations ?? {},
    customQtys: doc.customQtys ?? {},
    customTools: (doc.customTools ?? []).map(cleanTool),
    bundles: doc.bundles ?? {},
    removedItems: doc.removedItems ?? [],
    customDimensions: doc.customDimensions ?? {},
  });
}

/**
 * v1 (legacy KV document) → v2. Applies the same V3/consolidation renames and compartment seeding as App.jsx
 * migrateAllocations; never drops equipment names. Base names get deterministic ids, custom/unknown names random ones,
 * every occupied slot gets an assignment id. Stale bundle indices are pruned (reported as warnings).
 * @param {object} v1 @param {{newId?:(prefix:string)=>string}} [ctx]
 * @returns {Promise<{doc:object, report:{compartments:Record<string,{slots:number,occupied:number}>, equipment:number, customTools:number, bundles:number, removedItems:number, warnings:string[]}}>}
 */
export async function migrateV1toV2(v1, ctx = {}) {
  const mint = ctx.newId ?? defaultNewId;
  const src = isObj(v1) ? v1 : {};
  const warnings = [];
  const isV2 = src.schema === PLANNER_SCHEMA; // re-migrating a v2 doc keeps its ids
  if (!isObj(v1)) warnings.push('input was not an object; started from an empty document');
  const allocations = {};
  for (const id of COMPARTMENT_IDS) allocations[id] = Array(SLOTS_PER_COMPARTMENT).fill('');
  for (const [compId, slots] of Object.entries(isObj(src.allocations) ? src.allocations : {})) {
    if (!(compId in allocations)) { warnings.push(`ignored unknown compartment ${compId}`); continue; }
    if (!Array.isArray(slots)) { warnings.push(`${compId}: allocations not an array; kept empty`); continue; }
    allocations[compId] = slots.map((v, i) => {
      if (typeof v !== 'string') { warnings.push(`${compId}[${i}]: non-string slot treated as empty`); return ''; }
      return renameSlot(v);
    });
  }
  const doc = {
    schema: PLANNER_SCHEMA,
    allocations,
    customQtys: isObj(src.customQtys) ? clone(src.customQtys) : {},
    customTools: Array.isArray(src.customTools) ? src.customTools.map(t => clone(isV2 ? t : cleanTool(t))) : [],
    customDimensions: isObj(src.customDimensions) ? clone(src.customDimensions) : {},
    removedItems: Array.isArray(src.removedItems) ? [...src.removedItems] : [],
    bundles: isObj(src.bundles) ? clone(src.bundles) : {},
    equipmentIds: { ...baseEquipmentIds(), ...(isV2 && isObj(src.equipmentIds) ? src.equipmentIds : {}) },
    assignmentIds: isV2 && isObj(src.assignmentIds) ? clone(src.assignmentIds) : {},
  };
  // Custom/unknown names: random ids (base names already hold their deterministic ids).
  const known = new Set(inventoryNames(doc));
  for (const slots of Object.values(allocations)) {
    for (const name of slots) {
      if (name && !known.has(name) && !isBaseName(name)) warnings.push(`name not in inventory: ${name}`);
    }
  }
  const { doc: normalized, repairs } = normalizeDoc(doc, { newId: mint });
  for (const r of repairs) if (r.startsWith('pruned') || r.startsWith('deleted')) warnings.push(r);
  const report = {
    compartments: Object.fromEntries(Object.entries(normalized.allocations).map(([id, s]) => [id, { slots: s.length, occupied: s.filter(Boolean).length }])),
    equipment: Object.keys(normalized.equipmentIds).length,
    customTools: normalized.customTools.length,
    bundles: Object.values(normalized.bundles).reduce((n, l) => n + l.length, 0),
    removedItems: normalized.removedItems.length,
    warnings,
  };
  return { doc: normalized, report };
}
