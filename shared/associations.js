// Owner: part C. Interface stub (P0). Photo ↔ inventory association rules (architecture §7).
/** Search candidates for linking: {assigned:[...], available:[...], unavailable:[...]} each row {name, equipmentId, assignedHere, free, assignmentIds}. */
export function searchCandidates(doc, compId, query) { throw new Error('NOT_IMPLEMENTED: interface stub, owner replaces it'); }
/** selections: [{equipmentId?|name, quantity, newTool?:{name, qty, dimensions?, description?}}] →
 * {links:[{targetType, targetId, equipmentId, quantity}], plannerOps:object[], errors:[{index, code, message}]} — links existing assignments first,
 * emits setSlot ops into empty slots (expect '') only for quantity not already assigned here, never exceeds free inventory. */
export function planAssociation(doc, compId, selections, ctx) { throw new Error('NOT_IMPLEMENTED: interface stub, owner replaces it'); }