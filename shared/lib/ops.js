// Planner op engine: validateOp + applyOps (pure; preconditions, quantity invariant, bundle integrity).
import { CONFLICT_REASONS, ID_PATTERN, ID_PREFIX, PLANNER_LIMITS, PLANNER_OPS } from '../contracts.js';
import { newId as defaultNewId } from '../ids.js';
import { assignedCounts, baseEquipmentIds, clone, dimsOf, inventoryNames, isBaseName, normalizeDoc, qtyOf } from './doc.js';

const NAME_MAX = 300;
const DIMS_MAX = 500;
const QTY_MAX = 10_000;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isName = v => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= NAME_MAX;
const opName = op => op?.op ?? op?.type;

const SHAPES = {
  setSlot: { comp: 'comp', index: 'index', value: 'slotValue', expect: 'slotValue' },
  setSlotCount: { comp: 'comp', count: 'count', expect: 'count' },
  setCustomQty: { name: 'name', qty: 'qtyOrNull' },
  upsertCustomTool: { tool: 'tool' },
  removeCustomTool: { name: 'name' },
  setDimension: { name: 'name', value: 'dimOrNull' },
  setRemoved: { name: 'name', removed: 'bool' },
  upsertBundle: { comp: 'comp', bundle: 'bundle' },
  deleteBundle: { comp: 'comp', id: 'bundleId' },
  renameEquipment: { from: 'name', to: 'name' },
};
const checks = {
  comp: v => typeof v === 'string' && v.length > 0 && v.length <= 50,
  index: v => isInt(v, 0, PLANNER_LIMITS.maxSlotsPerCompartment - 1),
  slotValue: v => typeof v === 'string' && v.length <= NAME_MAX,
  count: v => isInt(v, 1, PLANNER_LIMITS.maxSlotsPerCompartment),
  name: isName,
  qtyOrNull: v => v === null || isInt(v, 0, QTY_MAX),
  dimOrNull: v => v === null || (typeof v === 'string' && v.length > 0 && v.length <= DIMS_MAX),
  bool: v => typeof v === 'boolean',
  bundleId: v => typeof v === 'string' && /^[0-9a-z_]{1,64}$/.test(v),
  tool: t => isObj(t) && isName(t.name) && isInt(t.qty, 0, QTY_MAX)
    && (t.dimensions === undefined || t.dimensions === null || (typeof t.dimensions === 'string' && t.dimensions.length <= DIMS_MAX))
    && (t.description === undefined || (typeof t.description === 'string' && t.description.length <= 2000))
    && (t.equipmentId === undefined || (typeof t.equipmentId === 'string' && ID_PATTERN.test(t.equipmentId)))
    && Object.keys(t).every(k => ['name', 'qty', 'dimensions', 'description', 'equipmentId'].includes(k)),
  bundle: b => isObj(b) && checks.bundleId(b.id) && typeof b.name === 'string' && b.name.length > 0 && b.name.length <= NAME_MAX
    && isInt(b.colorIdx, 0, 1000) && Array.isArray(b.slotIndices) && b.slotIndices.length <= PLANNER_LIMITS.maxSlotsPerCompartment
    && b.slotIndices.every(checks.index) && Object.keys(b).every(k => ['id', 'name', 'colorIdx', 'slotIndices'].includes(k)),
};

/**
 * Validate one op's shape and limits (no document access). Ops are `{op:<PLANNER_OPS name>, ...fields}`.
 * @param {unknown} op @returns {{ok:boolean, error?:string}}
 */
export function validateOp(op) {
  if (!isObj(op)) return { ok: false, error: 'op must be an object' };
  const name = opName(op);
  if (!PLANNER_OPS.includes(name)) return { ok: false, error: `unknown op ${String(name).slice(0, 40)}` };
  const shape = SHAPES[name];
  for (const key of Object.keys(op)) {
    if (key !== 'op' && key !== 'type' && !(key in shape)) return { ok: false, error: `${name}: unexpected field ${key.slice(0, 40)}` };
  }
  for (const [field, kind] of Object.entries(shape)) {
    if (!(field in op)) return { ok: false, error: `${name}: missing ${field}` };
    if (!checks[kind](op[field])) return { ok: false, error: `${name}: invalid ${field}` };
  }
  return { ok: true };
}

/** Context helpers shared by op handlers. */
function makeCtx(ctx = {}) {
  return { newId: ctx.newId ?? defaultNewId, now: ctx.now ?? Date.now() };
}

class Conflict {
  constructor(reason, current, message) {
    if (!CONFLICT_REASONS.includes(reason)) throw new Error(`bad reason ${reason}`);
    Object.assign(this, { reason, current, message });
  }
}

function clearName(doc, name) {
  for (const [compId, slots] of Object.entries(doc.allocations)) {
    slots.forEach((v, i) => { if (v === name) { slots[i] = ''; doc.assignmentIds[compId][i] = null; } });
  }
}

function ensureEquipmentId(doc, name, ctx, preferred) {
  if (doc.equipmentIds[name]) return;
  const det = isBaseName(name) ? baseEquipmentIds()[name] : null;
  doc.equipmentIds[name] = preferred ?? (det && !Object.values(doc.equipmentIds).includes(det) ? det : ctx.newId(ID_PREFIX.equipment));
}

const handlers = {
  setSlot(doc, op, ctx) {
    const slots = doc.allocations[op.comp];
    if (!slots) throw new Conflict('NOT_FOUND', undefined, `unknown compartment ${op.comp}`);
    if (op.index >= slots.length) throw new Conflict('NOT_FOUND', slots.length, 'slot index out of range');
    const current = slots[op.index];
    if (current !== op.expect) {
      if (current === op.value) return; // already satisfied
      throw new Conflict('PRECONDITION', current);
    }
    if (current === op.value) return;
    if (op.value) {
      if (!inventoryNames(doc).includes(op.value)) throw new Conflict('NOT_FOUND', undefined, `unknown equipment ${op.value}`);
      const assigned = assignedCounts(doc)[op.value] ?? 0;
      const qty = qtyOf(doc, op.value);
      if (assigned + 1 > qty) throw new Conflict('QUANTITY', { assigned, qty });
      ensureEquipmentId(doc, op.value, ctx);
      doc.assignmentIds[op.comp][op.index] = ctx.newId(ID_PREFIX.assignment);
    } else {
      doc.assignmentIds[op.comp][op.index] = null;
    }
    slots[op.index] = op.value;
  },
  setSlotCount(doc, op) {
    const slots = doc.allocations[op.comp];
    if (!slots) throw new Conflict('NOT_FOUND', undefined, `unknown compartment ${op.comp}`);
    if (slots.length !== op.expect) {
      if (slots.length === op.count) return;
      throw new Conflict('PRECONDITION', slots.length);
    }
    if (op.count < slots.length && slots.slice(op.count).some(Boolean)) throw new Conflict('PRECONDITION', slots.length, 'slots to remove are not empty');
    const ids = doc.assignmentIds[op.comp];
    if (op.count < slots.length) { slots.length = op.count; ids.length = op.count; }
    while (slots.length < op.count) { slots.push(''); ids.push(null); }
  },
  setCustomQty(doc, op) {
    if (op.qty === null) delete doc.customQtys[op.name];
    else {
      if (!inventoryNames(doc).includes(op.name)) throw new Conflict('NOT_FOUND', undefined, `unknown equipment ${op.name}`);
      doc.customQtys[op.name] = op.qty;
    }
  },
  upsertCustomTool(doc, op, ctx) {
    const { name, qty, dimensions, description, equipmentId } = op.tool;
    const idx = doc.customTools.findIndex(t => t.name === name);
    const lower = name.toLowerCase();
    if (inventoryNames(doc).some(n => n !== name && n.toLowerCase() === lower)) throw new Conflict('INVALID', undefined, 'an item with this name already exists');
    if (idx < 0 && inventoryNames(doc).includes(name)) throw new Conflict('INVALID', undefined, 'an item with this name already exists');
    const tool = { name, qty, dimensions: dimensions ?? '' };
    const kept = description ?? (idx >= 0 ? doc.customTools[idx].description : undefined);
    if (kept) tool.description = kept;
    if (idx >= 0) doc.customTools[idx] = tool;
    else doc.customTools.push(tool);
    ensureEquipmentId(doc, name, ctx, equipmentId);
  },
  removeCustomTool(doc, op) {
    const idx = doc.customTools.findIndex(t => t.name === op.name);
    if (idx < 0) return;
    doc.customTools.splice(idx, 1);
    delete doc.customQtys[op.name];
    clearName(doc, op.name);
    if (!isBaseName(op.name)) delete doc.equipmentIds[op.name];
  },
  setDimension(doc, op) {
    if (op.value === null) delete doc.customDimensions[op.name];
    else doc.customDimensions[op.name] = op.value;
  },
  setRemoved(doc, op) {
    if (!isBaseName(op.name)) throw new Conflict('NOT_FOUND', undefined, 'only base inventory items can be removed this way');
    const has = doc.removedItems.includes(op.name);
    if (op.removed && !has) {
      doc.removedItems.push(op.name);
      delete doc.customQtys[op.name];
      clearName(doc, op.name);
    } else if (!op.removed && has) {
      doc.removedItems = doc.removedItems.filter(n => n !== op.name);
    }
  },
  upsertBundle(doc, op) {
    if (!doc.allocations[op.comp]) throw new Conflict('NOT_FOUND', undefined, `unknown compartment ${op.comp}`);
    const list = doc.bundles[op.comp] ?? (doc.bundles[op.comp] = []);
    const bundle = { id: op.bundle.id, name: op.bundle.name, colorIdx: op.bundle.colorIdx, slotIndices: [...op.bundle.slotIndices] };
    const idx = list.findIndex(b => b.id === bundle.id);
    if (idx >= 0) list[idx] = bundle; else list.push(bundle);
  },
  deleteBundle(doc, op) {
    if (!doc.allocations[op.comp]) throw new Conflict('NOT_FOUND', undefined, `unknown compartment ${op.comp}`);
    if (doc.bundles[op.comp]) doc.bundles[op.comp] = doc.bundles[op.comp].filter(b => b.id !== op.id);
  },
  renameEquipment(doc, op) {
    const { from, to } = op;
    if (from === to) return;
    const names = inventoryNames(doc);
    const present = names.includes(from);
    if (!present) {
      if (names.includes(to)) return; // already renamed
      throw new Conflict('NOT_FOUND', undefined, `unknown equipment ${from}`);
    }
    const lower = to.toLowerCase();
    if (names.some(n => n !== from && n.toLowerCase() === lower)) throw new Conflict('INVALID', undefined, 'an item with this name already exists');
    const customIdx = doc.customTools.findIndex(t => t.name === from);
    const qty = qtyOf(doc, from);
    const dims = dimsOf(doc, from);
    if (customIdx >= 0) doc.customTools[customIdx] = { ...doc.customTools[customIdx], name: to };
    else {
      doc.removedItems.push(from);
      doc.customTools.push({ name: to, qty, dimensions: dims });
    }
    if (doc.customQtys[from] !== undefined) { doc.customQtys[to] = doc.customQtys[from]; delete doc.customQtys[from]; }
    if (doc.customDimensions[from] !== undefined) { doc.customDimensions[to] = doc.customDimensions[from]; delete doc.customDimensions[from]; }
    if (doc.equipmentIds[from]) { doc.equipmentIds[to] = doc.equipmentIds[from]; delete doc.equipmentIds[from]; }
    else if (isBaseName(from)) doc.equipmentIds[to] = baseEquipmentIds()[from];
    for (const slots of Object.values(doc.allocations)) slots.forEach((v, i) => { if (v === from) slots[i] = to; });
    if (customIdx >= 0) doc.removedItems = doc.removedItems.map(n => (n === from ? to : n));
  },
};

/**
 * Apply ops with preconditions + invariants. Pure: the input doc is never mutated.
 * - setSlot/setSlotCount: `expect` must equal the current value, unless the target value is already in place
 *   (idempotent no-op, counted as applied) → otherwise conflict PRECONDITION.
 * - an op that would raise a name's assigned count above its effective quantity → conflict QUANTITY (op skipped).
 * - unknown compartment / equipment / slot → NOT_FOUND; malformed op or duplicate name → INVALID.
 * Afterwards {@link normalizeDoc} repairs assignment-id parity and bundle integrity.
 * @param {object} doc v2 planner doc
 * @param {object[]} ops
 * @param {{newId?:(prefix:string)=>string, now?:number}} [ctx]
 * @returns {{doc:object, applied:number[], conflicts:{index:number, reason:string, current?:unknown, message?:string}[]}}
 */
export function applyOps(doc, ops, ctx) {
  const c = makeCtx(ctx);
  let work = clone(doc);
  work = normalizeDoc(work, c).doc;
  const applied = [];
  const conflicts = [];
  (Array.isArray(ops) ? ops : []).forEach((op, index) => {
    const valid = validateOp(op);
    if (!valid.ok) { conflicts.push({ index, reason: 'INVALID', message: valid.error }); return; }
    const attempt = clone(work);
    try {
      handlers[opName(op)](attempt, op, c);
      work = attempt;
      applied.push(index);
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
      const entry = { index, reason: e.reason };
      if (e.current !== undefined) entry.current = e.current;
      if (e.message) entry.message = e.message;
      conflicts.push(entry);
    }
  });
  return { doc: normalizeDoc(work, c).doc, applied, conflicts };
}
