// Pure helpers for the association dialog: what exactly will happen when the user saves.
// Inputs come from shared/associations.js (searchCandidates / planAssociation).

/** Stable key for a candidate row or selection. */
export const rowKey = row => row.equipmentId ?? `name:${row.name}`;

const plural = (n, one, many = `${one}s`) => (n === 1 ? one : many);
const slotList = idx => idx.map(i => i + 1).join(', ');

/** Maximum quantity a user may pick for a candidate (assigned here + free units). */
export function maxQuantity(row) {
  return Math.max(1, (row.assignmentIds?.length ?? (row.assignedHere || 0)) + (row.free || 0));
}

/**
 * @param {{links?:object[], plannerOps?:object[], errors?:{index:number, code?:string, message:string}[]}|null} plan
 * @param {{name:string}[]} selections the selections that were passed to planAssociation (for error labels)
 * @param {Record<string, {free?:number}>} [freeByName] free inventory units per item name (for "(2 available)")
 * @returns {{lines:{tone:'ok'|'info', text:string}[], errors:string[], canSave:boolean}}
 */
export function summarizePlan(plan, selections = [], freeByName = {}) {
  if (!plan) return { lines: [], errors: [], canSave: false };
  const lines = [];
  const links = plan.links ?? [];
  const ops = plan.plannerOps ?? [];
  const existing = links.filter(l => l.targetType === 'assignment').length;
  if (existing) lines.push({ tone: 'ok', text: `Link to ${existing} existing ${plural(existing, 'assignment')} — no inventory change` });

  const bySlot = new Map();
  for (const op of ops.filter(o => o.op === 'setSlot' && o.value)) {
    if (!bySlot.has(op.value)) bySlot.set(op.value, []);
    bySlot.get(op.value).push(op.index);
  }
  for (const [name, idx] of bySlot) {
    const free = freeByName[name]?.free;
    lines.push({ tone: 'info', text: `Assign ${idx.length} × ${name} to empty ${plural(idx.length, 'slot')} ${slotList(idx)}${Number.isFinite(free) ? ` (${free} available)` : ''}` });
  }
  for (const op of ops.filter(o => o.op === 'upsertCustomTool')) {
    const t = op.tool ?? {};
    lines.push({ tone: 'info', text: `Add new tool “${t.name}” to inventory${t.qty ? ` (quantity ${t.qty})` : ''}` });
  }
  const other = links.filter(l => l.targetType !== 'assignment').length;
  if (other) lines.push({ tone: 'ok', text: `Link to ${other} other ${plural(other, 'item')}` });

  const errors = (plan.errors ?? []).map(e => `${selections[e.index]?.name ? `${selections[e.index].name}: ` : ''}${e.message}`);
  if (!lines.length && !errors.length) lines.push({ tone: 'info', text: 'Nothing selected yet.' });
  return { lines, errors, canSave: errors.length === 0 && (links.length > 0 || ops.length > 0) };
}

/**
 * Attach regions (drawn on the photo) to the planned links. A region goes on the first link of its selection.
 * @param {object[]} links from planAssociation
 * @param {{equipmentId?:string, name:string, region?:object|null}[]} selections
 */
export function attachRegions(links, selections) {
  const used = new Set();
  return links.map(l => {
    const sel = selections.find((s, i) => !used.has(i) && s.region && ((s.equipmentId && s.equipmentId === l.equipmentId) || (!s.equipmentId && (l.label === s.name || l.equipmentId == null))));
    if (!sel) return l;
    used.add(selections.indexOf(sel));
    return { ...l, region: sel.region };
  });
}

/** Strip UI-only fields from a link before sending it to the API. */
export function toApiLink(l) {
  const out = { targetType: l.targetType, targetId: l.targetId };
  if (l.quantity != null) out.quantity = l.quantity;
  if (l.region) out.region = l.region;
  return out;
}

/** Default box for “Mark on photo” (centered, 40 % of the photo). */
export const newRegion = () => ({ x: 0.3, y: 0.3, w: 0.4, h: 0.4 });
