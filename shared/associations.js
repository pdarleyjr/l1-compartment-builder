// Photo ↔ inventory association rules (architecture §7). A photo is evidence, never inventory.
import { ID_PREFIX } from './contracts.js';
import { newId as defaultNewId } from './ids.js';
import { assignedCounts, effectiveInventory } from './lib/doc.js';

const norm = s => String(s ?? '').toLowerCase();

function whereElse(doc, compId, name) {
  const out = [];
  for (const [id, slots] of Object.entries(doc.allocations ?? {})) {
    if (id === compId) continue;
    const count = slots.filter(v => v === name).length;
    if (count) out.push({ compId: id, count });
  }
  return out;
}

function assignmentsHere(doc, compId, name) {
  const ids = [];
  (doc.allocations?.[compId] ?? []).forEach((v, i) => { if (v === name && doc.assignmentIds?.[compId]?.[i]) ids.push({ id: doc.assignmentIds[compId][i], index: i }); });
  return ids;
}

/**
 * Search candidates for linking. Case-insensitive; every whitespace-separated token must occur in the name.
 * `assigned` = assigned in this compartment; `available` = free quantity > 0 (may overlap with `assigned`, see
 * `assignedHere`); `unavailable` = no free quantity and not assigned here — `assignedElsewhere` says where.
 * @returns {{assigned:object[], available:object[], unavailable:object[]}} rows {name, equipmentId, qty, assignedHere, free, assignmentIds, assignedElsewhere}
 */
export function searchCandidates(doc, compId, query) {
  const tokens = norm(query).split(/\s+/).filter(Boolean);
  const out = { assigned: [], available: [], unavailable: [] };
  const rows = effectiveInventory(doc).filter(r => tokens.every(t => norm(r.name).includes(t))).sort((a, b) => a.name.localeCompare(b.name));
  for (const r of rows) {
    const here = assignmentsHere(doc, compId, r.name);
    const row = {
      name: r.name, equipmentId: r.equipmentId, qty: r.qty, assignedHere: here.length, free: r.free,
      assignmentIds: here.map(h => h.id), assignedElsewhere: whereElse(doc, compId, r.name),
    };
    if (here.length) out.assigned.push(row);
    if (r.free > 0) out.available.push(row);
    else if (!here.length) out.unavailable.push(row);
  }
  return out;
}

/**
 * Plan photo links for a set of selections. For each selection quantity q: first link up to q existing assignments of
 * that equipment in this compartment (targetType 'assignment', quantity 1 each, no planner op); the remainder becomes
 * setSlot ops into the lowest empty slots (expect '') when free inventory allows, linked as ONE 'equipment' link with
 * quantity and `assignSlots`. newTool selections emit upsertCustomTool first. A selection that cannot be satisfied
 * emits nothing and reports an error {index, code:'QUANTITY'|'NO_SLOTS'|'NOT_FOUND'|'INVALID', message}.
 * @param {object} doc @param {string} compId
 * @param {{equipmentId?:string, name?:string, quantity:number, newTool?:{name:string, qty?:number, dimensions?:string, description?:string}}[]} selections
 * @param {{newId?:(prefix:string)=>string}} [ctx]
 * @returns {{links:object[], plannerOps:object[], errors:{index:number, code:string, message:string}[]}}
 */
export function planAssociation(doc, compId, selections, ctx = {}) {
  const mint = ctx.newId ?? defaultNewId;
  const links = [];
  const plannerOps = [];
  const errors = [];
  const slots = doc.allocations?.[compId];
  if (!slots) return { links, plannerOps, errors: [{ index: 0, code: 'NOT_FOUND', message: `unknown compartment ${compId}` }] };
  const taken = new Set(); // slot indices already used by this plan
  const linked = new Set(); // assignment ids already linked by this plan
  const counts = assignedCounts(doc);
  const rows = new Map(effectiveInventory(doc).map(r => [r.name, r]));
  const byId = new Map(effectiveInventory(doc).filter(r => r.equipmentId).map(r => [r.equipmentId, r]));

  (Array.isArray(selections) ? selections : []).forEach((sel, index) => {
    const fail = (code, message) => errors.push({ index, code, message });
    const q = sel?.quantity;
    if (!Number.isInteger(q) || q < 1 || q > 500) return fail('INVALID', 'quantity must be an integer 1..500');
    const tool = sel.newTool;
    const emptySlots = () => slots.map((v, i) => i).filter(i => !slots[i] && !taken.has(i));
    let name;
    let equipmentId;
    const pre = [];
    if (tool) {
      name = String(tool.name ?? '').trim();
      const qty = tool.qty ?? q;
      if (!name || name.length > 300) return fail('INVALID', 'new tool needs a name (max 300 characters)');
      if ([...rows.keys()].some(n => n.toLowerCase() === name.toLowerCase())) return fail('INVALID', `"${name}" already exists in the inventory`);
      if (!Number.isInteger(qty) || qty < q || qty > 10_000) return fail('QUANTITY', 'new tool quantity must cover the selected quantity');
      equipmentId = mint(ID_PREFIX.equipment);
      const spec = { name, qty, equipmentId };
      if (tool.dimensions) spec.dimensions = String(tool.dimensions);
      if (tool.description) spec.description = String(tool.description);
      pre.push({ op: 'upsertCustomTool', tool: spec });
    } else {
      const row = sel.equipmentId ? byId.get(sel.equipmentId) : rows.get(sel.name);
      if (!row) return fail('NOT_FOUND', 'equipment is not in the inventory');
      name = row.name;
      equipmentId = row.equipmentId;
    }
    const existing = tool ? [] : assignmentsHere(doc, compId, name).filter(a => !linked.has(a.id));
    const reuse = existing.slice(0, q);
    const remainder = q - reuse.length;
    const free = tool ? (tool.qty ?? q) : (rows.get(name).qty - (counts[name] ?? 0));
    if (remainder > Math.max(0, free)) return fail('QUANTITY', `only ${Math.max(0, free)} of "${name}" still available, ${remainder} needed`);
    const targets = emptySlots().slice(0, remainder);
    if (targets.length < remainder) return fail('NO_SLOTS', `compartment ${compId} has only ${targets.length} empty slots, ${remainder} needed`);

    plannerOps.push(...pre);
    for (const a of reuse) {
      linked.add(a.id);
      links.push({ targetType: 'assignment', targetId: a.id, equipmentId, quantity: 1 });
    }
    if (remainder) {
      for (const i of targets) {
        taken.add(i);
        plannerOps.push({ op: 'setSlot', comp: compId, index: i, value: name, expect: '' });
      }
      links.push({ targetType: 'equipment', targetId: equipmentId, equipmentId, quantity: remainder, assignSlots: targets });
      counts[name] = (counts[name] ?? 0) + remainder;
    }
    if (tool) rows.set(name, { name, qty: tool.qty ?? q, equipmentId });
  });
  return { links, plannerOps, errors };
}
