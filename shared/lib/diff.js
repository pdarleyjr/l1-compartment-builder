// diffDocs: minimal op list turning one planner state (v1 view or v2 doc) into another.
import { PLANNER_SCHEMA } from '../contracts.js';
import { canonicalJson } from './canonical.js';
import { clone, effectiveInventory, normalizeDoc } from './doc.js';
import { applyOps } from './ops.js';

const same = (a, b) => canonicalJson(a) === canonicalJson(b);

/** v1 view or v2 doc → full v2 doc with fresh placeholder ids (ids never leak into diff output). */
function toDoc(view) {
  let n = 0;
  const fake = prefix => `${prefix}_${String(++n).padStart(16, '0')}`;
  return normalizeDoc({ schema: PLANNER_SCHEMA, ...clone(view) }, { newId: fake }).doc;
}

function slotOps(base, next, qtyOf) {
  const ops = { grow: [], shrink: [], clears: [], sets: [] };
  for (const compId of Object.keys(next.allocations)) {
    const b = base.allocations[compId] ?? [];
    const n = next.allocations[compId];
    if (n.length > b.length) ops.grow.push({ op: 'setSlotCount', comp: compId, count: n.length, expect: b.length });
    for (let i = 0; i < Math.max(b.length, n.length); i++) {
      const from = b[i] ?? '';
      const to = n[i] ?? '';
      if (from === to) continue;
      if (to === '') ops.clears.push({ op: 'setSlot', comp: compId, index: i, value: '', expect: from });
      else ops.sets.push({ op: 'setSlot', comp: compId, index: i, value: to, expect: from });
    }
    if (n.length < b.length) ops.shrink.push({ op: 'setSlotCount', comp: compId, count: n.length, expect: b.length });
  }
  return { ...ops, sets: orderSets(base, ops.sets, ops.clears, qtyOf) };
}

/**
 * Order slot changes so each op respects the quantity invariant when applied sequentially: pure clears are emitted
 * first; a replacement that would temporarily exceed an item's quantity is deferred until a unit frees up, and a true
 * cycle (swap at full capacity) is split into clear + fill.
 */
function orderSets(base, sets, clears, qtyOf) {
  const counts = {};
  for (const slots of Object.values(base.allocations)) for (const v of slots) if (v) counts[v] = (counts[v] ?? 0) + 1;
  for (const c of clears) counts[c.expect] -= 1;
  const out = [];
  let pending = [...sets];
  const free = op => (counts[op.value] ?? 0) + 1 <= qtyOf(op.value);
  const run = op => {
    if (op.expect) counts[op.expect] -= 1;
    counts[op.value] = (counts[op.value] ?? 0) + 1;
    out.push(op);
  };
  while (pending.length) {
    const idx = pending.findIndex(free);
    if (idx >= 0) { run(pending[idx]); pending = pending.filter((_, i) => i !== idx); continue; }
    const stuck = pending.find(op => op.expect);
    if (!stuck) { run(pending.shift()); continue; } // over quantity by intent; the server will decide
    out.push({ op: 'setSlot', comp: stuck.comp, index: stuck.index, value: '', expect: stuck.expect });
    counts[stuck.expect] -= 1;
    pending = pending.map(op => (op === stuck ? { ...op, expect: '' } : op));
  }
  return [...clears, ...out];
}

const keyedDiff = (baseMap, nextMap, make) => {
  const ops = [];
  for (const key of new Set([...Object.keys(baseMap), ...Object.keys(nextMap)])) {
    if (!same(baseMap[key], nextMap[key])) ops.push(make(key, nextMap[key] === undefined ? null : nextMap[key]));
  }
  return ops;
};

/**
 * Diff two planner states into ops. `base`/`next` may be v1 views or v2 docs. `opts.renames = [{from,to}]` emits
 * renameEquipment (applied to a copy of base first) so the rename shows up as one op, not remove + add.
 * Op order keeps sequential application valid: renames → custom tools/qty up → slot growth → slot changes →
 * slot shrink → removals → dimensions → bundles.
 * @param {object} base @param {object} next @param {{renames?:{from:string,to:string}[]}} [opts]
 * @returns {object[]}
 */
export function diffDocs(base, next, opts = {}) {
  let from = toDoc(base);
  const to = toDoc(next);
  const ops = [];
  for (const r of opts.renames ?? []) {
    const op = { op: 'renameEquipment', from: r.from, to: r.to };
    const res = applyOps(from, [op], { newId: p => `${p}_${'0'.repeat(16)}` });
    if (res.applied.length) { from = res.doc; ops.push(op); }
  }
  const qtyOf = name => effectiveInventory(to).find(r => r.name === name)?.qty ?? 0;

  const toolOps = [];
  const baseTools = Object.fromEntries(from.customTools.map(t => [t.name, t]));
  const nextTools = Object.fromEntries(to.customTools.map(t => [t.name, t]));
  for (const t of to.customTools) {
    const prev = baseTools[t.name];
    if (!prev || prev.qty !== t.qty || (prev.dimensions ?? '') !== (t.dimensions ?? '') || (t.description ?? '') !== (prev.description ?? '')) {
      const tool = { name: t.name, qty: t.qty };
      if (t.dimensions) tool.dimensions = t.dimensions;
      if (t.description) tool.description = t.description;
      if (!prev && next.equipmentIds?.[t.name]) tool.equipmentId = next.equipmentIds[t.name];
      toolOps.push({ op: 'upsertCustomTool', tool });
    }
  }
  const removedNow = new Set(to.removedItems);
  const removedBefore = new Set(from.removedItems);
  const unremove = [...removedBefore].filter(n => !removedNow.has(n)).map(name => ({ op: 'setRemoved', name, removed: false }));
  const remove = [...removedNow].filter(n => !removedBefore.has(n)).map(name => ({ op: 'setRemoved', name, removed: true }));
  const delTools = Object.keys(baseTools).filter(n => !nextTools[n]).map(name => ({ op: 'removeCustomTool', name }));
  const qtyOps = keyedDiff(from.customQtys, to.customQtys, (name, qty) => ({ op: 'setCustomQty', name, qty }));
  const slots = slotOps(from, to, qtyOf);

  const bundleOps = [];
  for (const compId of new Set([...Object.keys(from.bundles), ...Object.keys(to.bundles)])) {
    const b = Object.fromEntries((from.bundles[compId] ?? []).map(x => [x.id, x]));
    const n = Object.fromEntries((to.bundles[compId] ?? []).map(x => [x.id, x]));
    for (const id of Object.keys(b)) if (!n[id]) bundleOps.push({ op: 'deleteBundle', comp: compId, id });
    for (const x of to.bundles[compId] ?? []) {
      if (!same(b[x.id], x)) bundleOps.push({ op: 'upsertBundle', comp: compId, bundle: { id: x.id, name: x.name, colorIdx: x.colorIdx, slotIndices: [...x.slotIndices] } });
    }
  }
  const dimOps = keyedDiff(from.customDimensions, to.customDimensions, (name, value) => ({ op: 'setDimension', name, value }));

  return [...ops, ...unremove, ...toolOps, ...qtyOps, ...slots.grow, ...slots.sets, ...slots.shrink, ...remove, ...delTools, ...dimOps, ...bundleOps];
}
