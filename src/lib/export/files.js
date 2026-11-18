// File names and the shared planner-input merge for the export. Pure ESM.
export const APP_TITLE = 'L1 Mid-Mount';

/** @param {Date} d local calendar date as YYYY-MM-DD */
export function dateStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export const workbookFilename = (revision, date = dateStamp()) => `${APP_TITLE} - Compartment Plan - ${date} - rev${revision}.xlsx`;
export const manifestFilename = (revision, date = dateStamp()) => `${APP_TITLE} - Checklist Transfer - ${date} - rev${revision}.json`;

/**
 * Combine the local view (what the user sees) with the last server doc: the view lacks equipment/assignment ids, so those
 * come from the server doc; an assignment id is kept only where the slot still holds the same item.
 */
export function mergeViewWithDoc(view, doc) {
  const out = { ...view, equipmentIds: { ...(doc?.equipmentIds ?? {}) }, notes: view.notes ?? doc?.notes ?? {}, unverified: view.unverified ?? doc?.unverified ?? {} };
  const assignmentIds = {};
  for (const [comp, slots] of Object.entries(view.allocations ?? {})) {
    const base = doc?.allocations?.[comp] ?? [];
    assignmentIds[comp] = slots.map((name, i) => (name && base[i] === name ? (doc?.assignmentIds?.[comp]?.[i] ?? null) : null));
  }
  out.assignmentIds = assignmentIds;
  return out;
}
