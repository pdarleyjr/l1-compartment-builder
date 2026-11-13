// Test-only stand-in for shared/planner.js, used ONLY while that module is still the P0 interface stub
// (playwright.config.js detects the stub and enables the vite alias via L1_PLANNER_SHIM=1). Once part C lands the real
// module this file is never loaded. It implements just enough of the documented contract (planner doc v2, ops, diff)
// for the browser client (src/lib/planner-sync.js) and e2e/helpers/fake-api.js to behave like the real thing.
import { COMPARTMENTS, MASTER_INVENTORY, SLOTS_PER_COMPARTMENT } from '../../shared/apparatus.js';

const clone = v => JSON.parse(JSON.stringify(v));
const BASE_QTY = Object.fromEntries(MASTER_INVENTORY.map(i => [i.name, i.qty]));
const V1_KEYS = ['allocations', 'customQtys', 'customTools', 'bundles', 'removedItems', 'customDimensions'];

function eqId(name) {
  let h = 0x811c9dc5;
  for (const ch of name) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return `eq_${h.toString(16).padStart(8, '0')}${name.length.toString(16).padStart(8, '0')}`;
}
const randId = prefix => `${prefix}_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`.padEnd(20, '0');

/** @returns {object} empty v2 doc */
export function emptyDocV2() {
  const allocations = {}; const assignmentIds = {};
  for (const c of COMPARTMENTS) { allocations[c.id] = Array(SLOTS_PER_COMPARTMENT).fill(''); assignmentIds[c.id] = Array(SLOTS_PER_COMPARTMENT).fill(null); }
  const equipmentIds = Object.fromEntries(MASTER_INVENTORY.map(i => [i.name, eqId(i.name)]));
  return { schema: 2, allocations, customQtys: {}, customTools: [], customDimensions: {}, removedItems: [], bundles: {}, equipmentIds, assignmentIds };
}

/** v2 → v1 view. */
export function projectV1(doc) {
  const out = {};
  for (const k of V1_KEYS) out[k] = clone(doc?.[k] ?? (k === 'customTools' || k === 'removedItems' ? [] : {}));
  return out;
}

/** Per-compartment rows of occupied slots. */
export function compartmentAssignments(doc, compId) {
  const slots = doc.allocations?.[compId] ?? [];
  const bundles = doc.bundles?.[compId] ?? [];
  return slots.flatMap((name, slotIndex) => name ? [{
    slotIndex, name, equipmentId: doc.equipmentIds?.[name] ?? null,
    assignmentId: doc.assignmentIds?.[compId]?.[slotIndex] ?? null,
    bundleId: bundles.find(b => b.slotIndices.includes(slotIndex))?.id ?? null,
  }] : []);
}

const effQty = (doc, name) => {
  if (doc.customQtys?.[name] !== undefined) return doc.customQtys[name];
  if (BASE_QTY[name] !== undefined) return BASE_QTY[name];
  return (doc.customTools ?? []).find(t => t.name === name)?.qty ?? 0;
};
const placed = (doc, name) => Object.values(doc.allocations).reduce((a, s) => a + s.filter(v => v === name).length, 0);

function renameIn(doc, from, to) {
  for (const id of Object.keys(doc.allocations)) doc.allocations[id] = doc.allocations[id].map(s => (s === from ? to : s));
  const qty = effQty(doc, from);
  const dims = doc.customDimensions?.[from] ?? (doc.customTools ?? []).find(t => t.name === from)?.dimensions ?? '';
  delete doc.customQtys[from]; delete doc.customDimensions[from];
  doc.customQtys[to] = qty;
  if (dims) doc.customDimensions[to] = dims;
  const ct = doc.customTools.find(t => t.name === from);
  if (ct) { ct.name = to; ct.qty = qty; if (dims) ct.dimensions = dims; }
  else { if (!doc.removedItems.includes(from)) doc.removedItems.push(from); doc.customTools.push({ name: to, qty, dimensions: dims }); }
  if (doc.equipmentIds?.[from]) { doc.equipmentIds[to] = doc.equipmentIds[from]; delete doc.equipmentIds[from]; }
}

/** Diff two v1 views / v2 docs into ops; opts.renames = [{from,to}]. */
export function diffDocs(base, next, opts = {}) {
  const ops = []; const b = projectV1(base); const n = projectV1(next);
  for (const { from, to } of opts.renames ?? []) { ops.push({ op: 'renameEquipment', from, to }); renameIn(b, from, to); }
  for (const comp of new Set([...Object.keys(b.allocations), ...Object.keys(n.allocations)])) {
    const bs = b.allocations[comp] ?? []; const ns = n.allocations[comp] ?? [];
    if (ns.length > bs.length) ops.push({ op: 'setSlotCount', comp, count: ns.length, expect: bs.length });
    for (let i = 0; i < Math.max(bs.length, ns.length); i++) {
      const was = bs[i] ?? ''; const now = ns[i] ?? '';
      if (was !== now && (i < ns.length || was !== '')) ops.push({ op: 'setSlot', comp, index: i, value: now, expect: was });
    }
    if (ns.length < bs.length) ops.push({ op: 'setSlotCount', comp, count: ns.length, expect: bs.length });
  }
  for (const k of new Set([...Object.keys(b.customQtys), ...Object.keys(n.customQtys)])) {
    if (b.customQtys[k] !== n.customQtys[k]) ops.push({ op: 'setCustomQty', name: k, qty: n.customQtys[k] ?? null });
  }
  const bt = new Map(b.customTools.map(t => [t.name, t])); const nt = new Map(n.customTools.map(t => [t.name, t]));
  for (const [k, t] of nt) if (JSON.stringify(bt.get(k)) !== JSON.stringify(t)) ops.push({ op: 'upsertCustomTool', tool: t });
  for (const k of bt.keys()) if (!nt.has(k)) ops.push({ op: 'removeCustomTool', name: k });
  for (const k of new Set([...Object.keys(b.customDimensions), ...Object.keys(n.customDimensions)])) {
    if (b.customDimensions[k] !== n.customDimensions[k]) ops.push({ op: 'setDimension', name: k, value: n.customDimensions[k] ?? null });
  }
  for (const k of n.removedItems) if (!b.removedItems.includes(k)) ops.push({ op: 'setRemoved', name: k, removed: true });
  for (const k of b.removedItems) if (!n.removedItems.includes(k)) ops.push({ op: 'setRemoved', name: k, removed: false });
  for (const comp of new Set([...Object.keys(b.bundles), ...Object.keys(n.bundles)])) {
    const bb = new Map((b.bundles[comp] ?? []).map(x => [x.id, x])); const nb = new Map((n.bundles[comp] ?? []).map(x => [x.id, x]));
    for (const [id, x] of nb) if (JSON.stringify(bb.get(id)) !== JSON.stringify(x)) ops.push({ op: 'upsertBundle', comp, bundle: x });
    for (const id of bb.keys()) if (!nb.has(id)) ops.push({ op: 'deleteBundle', comp, id });
  }
  return ops;
}

/** Validate one op shape. */
export function validateOp(op) {
  return op && typeof op.op === 'string' ? { ok: true } : { ok: false, error: 'op missing' };
}

/** Repair invariants (bundle pruning, assignment id parity). */
export function normalizeDoc(doc, ctx = {}) {
  const repairs = []; const newId = ctx.newId ?? randId;
  for (const comp of Object.keys(doc.allocations)) {
    const slots = doc.allocations[comp];
    const ids = (doc.assignmentIds[comp] ??= []);
    while (ids.length < slots.length) ids.push(null);
    ids.length = slots.length;
    slots.forEach((v, i) => { if (v && !ids[i]) ids[i] = newId('as'); if (!v) ids[i] = null; });
    const kept = [];
    for (const bd of doc.bundles[comp] ?? []) {
      const idx = bd.slotIndices.filter(i => i < slots.length && slots[i]);
      if (idx.length !== bd.slotIndices.length) repairs.push(`bundle ${bd.id} pruned`);
      if (idx.length) kept.push({ ...bd, slotIndices: idx });
    }
    if (kept.length || doc.bundles[comp]) doc.bundles[comp] = kept;
  }
  return { doc, repairs };
}

/** Apply ops with preconditions and quantity invariant. Pure. */
export function applyOps(docIn, ops, ctx = {}) {
  const doc = clone(docIn); const newId = ctx.newId ?? randId;
  const applied = []; const conflicts = [];
  ops.forEach((o, index) => {
    const fail = (reason, current) => conflicts.push({ index, reason, current });
    switch (o.op) {
      case 'setSlot': {
        const slots = doc.allocations[o.comp];
        if (!slots) return fail('NOT_FOUND');
        const cur = slots[o.index] ?? '';
        if (cur === o.value) return applied.push(index);
        if (o.expect !== undefined && cur !== o.expect) return fail('PRECONDITION', cur);
        if (o.value && placed(doc, o.value) >= effQty(doc, o.value)) return fail('QUANTITY', placed(doc, o.value));
        while (slots.length <= o.index) slots.push('');
        slots[o.index] = o.value;
        (doc.assignmentIds[o.comp] ??= [])[o.index] = o.value ? newId('as') : null;
        return applied.push(index);
      }
      case 'setSlotCount': {
        const slots = doc.allocations[o.comp];
        if (!slots) return fail('NOT_FOUND');
        if (slots.length === o.count) return applied.push(index);
        if (o.expect !== undefined && slots.length !== o.expect) return fail('PRECONDITION', slots.length);
        if (o.count < slots.length && slots.slice(o.count).some(Boolean)) return fail('PRECONDITION', slots.length);
        if (o.count > slots.length) while (slots.length < o.count) slots.push(''); else slots.length = o.count;
        return applied.push(index);
      }
      case 'setCustomQty':
        if (o.qty === null) delete doc.customQtys[o.name]; else doc.customQtys[o.name] = o.qty;
        return applied.push(index);
      case 'upsertCustomTool': {
        const i = doc.customTools.findIndex(t => t.name === o.tool.name);
        if (i >= 0) doc.customTools[i] = o.tool; else doc.customTools.push(o.tool);
        doc.equipmentIds[o.tool.name] ??= newId('eq');
        return applied.push(index);
      }
      case 'removeCustomTool':
        doc.customTools = doc.customTools.filter(t => t.name !== o.name);
        return applied.push(index);
      case 'setDimension':
        if (o.value === null) delete doc.customDimensions[o.name]; else doc.customDimensions[o.name] = o.value;
        return applied.push(index);
      case 'setRemoved':
        doc.removedItems = doc.removedItems.filter(n => n !== o.name);
        if (o.removed) doc.removedItems.push(o.name);
        return applied.push(index);
      case 'upsertBundle': {
        const list = (doc.bundles[o.comp] ??= []);
        const i = list.findIndex(x => x.id === o.bundle.id);
        if (i >= 0) list[i] = o.bundle; else list.push(o.bundle);
        return applied.push(index);
      }
      case 'deleteBundle':
        doc.bundles[o.comp] = (doc.bundles[o.comp] ?? []).filter(x => x.id !== o.id);
        return applied.push(index);
      case 'renameEquipment':
        if (doc.customTools.some(t => t.name === o.to) || (BASE_QTY[o.to] !== undefined && !doc.removedItems.includes(o.to))) return fail('INVALID');
        renameIn(doc, o.from, o.to);
        return applied.push(index);
      default:
        return fail('INVALID');
    }
  });
  normalizeDoc(doc, { newId });
  return { doc, applied, conflicts };
}

/** Not needed by the browser; present so the module exposes the full interface. */
export async function migrateV1toV2(v1) { return { doc: { ...emptyDocV2(), ...clone(v1) }, report: {} }; }
export function effectiveInventory(doc) {
  return [...MASTER_INVENTORY.filter(i => !doc.removedItems.includes(i.name)), ...doc.customTools].map(i => ({
    name: i.name, qty: effQty(doc, i.name), dims: doc.customDimensions[i.name] ?? '', custom: !(i.name in BASE_QTY),
    equipmentId: doc.equipmentIds[i.name] ?? null, assigned: placed(doc, i.name), free: effQty(doc, i.name) - placed(doc, i.name),
  }));
}
export function assignedCounts(doc) {
  const out = {}; for (const s of Object.values(doc.allocations).flat()) if (s) out[s] = (out[s] ?? 0) + 1; return out;
}
