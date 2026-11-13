// Owner: part C. Interface stub (P0). Planner doc v2 + op engine (docs/architecture/ai-compartment-studio.md §4).
// v1 view = {allocations, customQtys, customTools, bundles, removedItems, customDimensions}; v2 = v1 + {schema:2, equipmentIds, assignmentIds}.
/** @returns {object} empty v2 doc with all COMPARTMENT_IDS × SLOTS_PER_COMPARTMENT empty slots */ export function emptyDocV2() { throw new Error('NOT_IMPLEMENTED: interface stub, owner replaces it'); }
/** v1 (legacy KV document) → v2; never renames or drops data. @returns {Promise<{doc:object, report:object}>} */ export async function migrateV1toV2(v1) { throw new Error('NOT_IMPLEMENTED: interface stub, owner replaces it'); }
/** v2 → v1 view (what App.jsx state and the legacy GET /state use). */ export function projectV1(doc) { throw new Error('NOT_IMPLEMENTED: interface stub, owner replaces it'); }
/** Effective inventory rows: [{name, qty, dims, custom, equipmentId, assigned, free}] */ export function effectiveInventory(doc) { throw new Error('NOT_IMPLEMENTED: interface stub, owner replaces it'); }
/** Per-name assigned counts across all compartments. @returns {Record<string,number>} */ export function assignedCounts(doc) { throw new Error('NOT_IMPLEMENTED: interface stub, owner replaces it'); }
/** Rows for one compartment: [{slotIndex, name, equipmentId, assignmentId, bundleId}] (occupied slots only). */ export function compartmentAssignments(doc, compId) { throw new Error('NOT_IMPLEMENTED: interface stub, owner replaces it'); }
/** Diff two v1 views (or v2 docs) into ops; opts.renames = [{from,to}] emits renameEquipment instead of remove+add. @returns {object[]} */ export function diffDocs(base, next, opts = {}) { throw new Error('NOT_IMPLEMENTED: interface stub, owner replaces it'); }
/** Validate one op shape. @returns {{ok:boolean, error?:string}} */ export function validateOp(op) { throw new Error('NOT_IMPLEMENTED: interface stub, owner replaces it'); }
/** Apply ops with preconditions + invariants. ctx = {newId, now}. Pure (no I/O).
 * @returns {{doc:object, applied:number[], conflicts:{index:number, reason:'PRECONDITION'|'QUANTITY'|'NOT_FOUND'|'INVALID', current?:unknown}[]}} */
export function applyOps(doc, ops, ctx) { throw new Error('NOT_IMPLEMENTED: interface stub, owner replaces it'); }
/** Repair invariants (slot/assignmentIds parity, bundle pruning). @returns {{doc:object, repairs:string[]}} */ export function normalizeDoc(doc, ctx) { throw new Error('NOT_IMPLEMENTED: interface stub, owner replaces it'); }