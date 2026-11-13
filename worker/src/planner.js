/* eslint-disable no-unused-vars -- E2 placeholder so studio modules resolve; part E1 owns this file, keep E1's version on merge */
// Placeholder (part E2). Real implementation: part E1 (planner doc persistence + op application).
/** @returns {Promise<{statements:any[], result:{revision:number, doc:object, applied:number[], conflicts:object[]}}>} */
export async function applyPlannerOpsInBatch(db, { ops, actor, clientOpId, now }) { throw new Error('NOT_IMPLEMENTED: provided by part E1'); }
/** @returns {Promise<{revision:number, doc:object}|null>} */
export async function loadPlannerDoc(db) { throw new Error('NOT_IMPLEMENTED: provided by part E1'); }
