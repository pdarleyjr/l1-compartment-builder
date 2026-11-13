import { beforeEach, describe, expect, test } from 'vitest';
import { applyOps, diffDocs, effectiveInventory, migrateV1toV2, projectV1, validateOp } from '../../shared/planner.js';
import { CELLAR, counterIds, FOG, GRIPHOIST, IRONS, JACK, THERMAL, VSTRUT, v1Fixture } from './fixtures.js';

let base; // v2
let v1;
beforeEach(async () => {
  v1 = v1Fixture();
  base = (await migrateV1toV2(v1, { newId: counterIds() })).doc;
});
const ctx = () => ({ newId: counterIds() });
/** Apply diff(base→next) to base and return the projection. */
function roundTrip(next, opts) {
  const ops = diffDocs(base, next, opts);
  for (const op of ops) expect(validateOp(op)).toEqual({ ok: true });
  const r = applyOps(base, ops, ctx());
  expect(r.conflicts).toEqual([]);
  return { ops, result: projectV1(r.doc) };
}
const edit = fn => { const n = structuredClone(v1); fn(n); return n; };

describe('diffDocs', () => {
  test('identical states → no ops (v1 views and v2 docs alike)', () => {
    expect(diffDocs(v1, v1)).toEqual([]);
    expect(diffDocs(base, base)).toEqual([]);
    expect(diffDocs(base, v1)).toEqual([]);
  });
  test('single slot assignment → exactly one setSlot with expect = base value', () => {
    const next = edit(n => { n.allocations.LS3[4] = GRIPHOIST; });
    expect(diffDocs(v1, next)).toEqual([{ op: 'setSlot', comp: 'LS3', index: 4, value: GRIPHOIST, expect: '' }]);
  });
  test('clear and replace', () => {
    const next = edit(n => { n.allocations.LS1[0] = ''; n.allocations.LS1[1] = GRIPHOIST; });
    expect(diffDocs(v1, next)).toEqual([
      { op: 'setSlot', comp: 'LS1', index: 0, value: '', expect: FOG },
      { op: 'setSlot', comp: 'LS1', index: 1, value: GRIPHOIST, expect: FOG },
    ]);
  });
  test('addRow / removeLastEmptyRow → setSlotCount', () => {
    const grown = edit(n => { n.allocations.LS1.push('', GRIPHOIST); });
    const ops = diffDocs(v1, grown);
    expect(ops[0]).toEqual({ op: 'setSlotCount', comp: 'LS1', count: 17, expect: 15 });
    expect(ops[1]).toEqual({ op: 'setSlot', comp: 'LS1', index: 16, value: GRIPHOIST, expect: '' });
    const shrunk = edit(n => { n.allocations.LS1.pop(); });
    expect(diffDocs(v1, shrunk)).toEqual([{ op: 'setSlotCount', comp: 'LS1', count: 14, expect: 15 }]);
  });
  test('quantity-safe ordering: a unit moves A→B at full capacity (clear before fill)', () => {
    const next = edit(n => { n.allocations.RS3[3] = ''; n.allocations.LS3[0] = VSTRUT; n.bundles.RS3[1].slotIndices = [2]; });
    const ops = diffDocs(v1, next);
    expect(ops.findIndex(o => o.comp === 'RS3')).toBeLessThan(ops.findIndex(o => o.comp === 'LS3'));
    expect(roundTrip(next).result).toEqual(next);
  });
  test('swap at full capacity is split into clear + fill so it still applies', () => {
    const next = edit(n => { n.allocations.RS3[0] = LDH_NAME; n.allocations.RS3[4] = VSTRUT; });
    const { result } = roundTrip(next);
    expect(result.allocations).toEqual(next.allocations);
  });
  test('custom quantity / dimension / removal / custom tool / bundle changes', () => {
    const next = edit(n => {
      n.customQtys[GRIPHOIST] = 3; delete n.customQtys[JACK];
      n.customDimensions[FOG] = '11 in'; delete n.customDimensions[IRONS];
      n.removedItems = [CELLAR, GATE];
      n.customTools = [{ name: THERMAL, qty: 3, dimensions: '7 in' }, { name: 'Pry Bar', qty: 2, dimensions: '' }];
      n.bundles.RS3 = [n.bundles.RS3[0], { id: 'new11111', name: 'New', colorIdx: 4, slotIndices: [4, 5] }];
      delete n.bundles.RR1;
    });
    const { ops, result } = roundTrip(next);
    const kinds = new Set(ops.map(o => o.op));
    expect(kinds).toEqual(new Set(['setCustomQty', 'setDimension', 'setRemoved', 'upsertCustomTool', 'upsertBundle', 'deleteBundle']));
    expect(result).toEqual(next);
  });
  test('removing a custom tool (with slots cleared by the app) and a base item round-trips', () => {
    const next = edit(n => {
      n.customTools = []; n.allocations.LS4[0] = ''; n.allocations.RS5[0] = '';
      n.removedItems = [CELLAR, JACK]; n.allocations.LS2[3] = ''; delete n.customQtys[JACK];
    });
    const { ops, result } = roundTrip(next);
    expect(ops.some(o => o.op === 'removeCustomTool')).toBe(true);
    expect(result).toEqual(next);
  });
  test('un-removing a base item', () => {
    const next = edit(n => { n.removedItems = []; });
    expect(diffDocs(v1, next)).toEqual([{ op: 'setRemoved', name: CELLAR, removed: false }]);
  });
  test('assigning a brand-new custom tool: upsert comes before the slot that uses it', () => {
    const next = edit(n => { n.customTools.push({ name: 'Pry Bar', qty: 1, dimensions: '' }); n.allocations.LS3[0] = 'Pry Bar'; });
    const ops = diffDocs(v1, next);
    expect(ops.map(o => o.op)).toEqual(['upsertCustomTool', 'setSlot']);
    expect(roundTrip(next).result).toEqual(next);
  });
  test('raising a quantity and using it in one change set round-trips', () => {
    const next = edit(n => { n.customQtys[GRIPHOIST] = 2; n.allocations.LS3[0] = GRIPHOIST; n.allocations.LS3[1] = GRIPHOIST; });
    expect(roundTrip(next).result).toEqual(next);
  });
  test('v2 next carrying a custom tool id passes it through', () => {
    const next = structuredClone(base);
    next.customTools.push({ name: 'Pry Bar', qty: 1, dimensions: '' });
    next.equipmentIds['Pry Bar'] = 'eq_1234567890abcdef';
    expect(diffDocs(base, next)[0].tool.equipmentId).toBe('eq_1234567890abcdef');
  });
  test('slot ops are minimal: a full-compartment fill emits one op per changed slot only', () => {
    const next = edit(n => { n.allocations.CabRearZone = Array(15).fill(GRIPHOIST).map((v, i) => (i === 0 ? v : '')); });
    expect(diffDocs(v1, next)).toHaveLength(1);
  });
});

describe('diffDocs with renames (SD-07)', () => {
  test('custom tool rename: one renameEquipment, no remove+add; result equals app state', () => {
    const next = edit(n => {
      n.customTools = [{ name: 'Thermal Imager', qty: 2, dimensions: '6 × 4 × 3 in' }];
      n.allocations.LS4[0] = 'Thermal Imager'; n.allocations.RS5[0] = 'Thermal Imager';
      n.customQtys['Thermal Imager'] = 2;
    });
    const { ops, result } = roundTrip(next, { renames: [{ from: THERMAL, to: 'Thermal Imager' }] });
    expect(ops[0]).toEqual({ op: 'renameEquipment', from: THERMAL, to: 'Thermal Imager' });
    expect(ops.some(o => o.op === 'removeCustomTool' || (o.op === 'setSlot' && o.value === ''))).toBe(false);
    expect(result).toEqual(next);
  });
  test('base item rename as App.jsx saveEdit does it (promote to custom, remove old name)', () => {
    const NEW = 'Hi-Lift Jack 48 in';
    const next = edit(n => {
      n.allocations.LS2[3] = NEW; n.removedItems = [CELLAR, JACK];
      n.customTools.push({ name: NEW, qty: 2, dimensions: '10 × 5 × 38 in' });
      delete n.customQtys[JACK]; n.customQtys[NEW] = 2;
    });
    const { ops, result } = roundTrip(next, { renames: [{ from: JACK, to: NEW }] });
    expect(ops.filter(o => o.op === 'renameEquipment')).toHaveLength(1);
    expect(ops.some(o => o.op === 'setSlot')).toBe(false);
    expect(result.allocations).toEqual(next.allocations);
    expect(effectiveInventory(applyOps(base, ops, ctx()).doc).find(r => r.name === NEW).equipmentId).toBe(base.equipmentIds[JACK]);
  });
  test('rename + qty edit in one change', () => {
    const next = edit(n => {
      n.customTools = [{ name: 'Imager', qty: 4, dimensions: '6 × 4 × 3 in' }];
      n.allocations.LS4[0] = 'Imager'; n.allocations.RS5[0] = 'Imager'; n.customQtys.Imager = 4;
    });
    const { result } = roundTrip(next, { renames: [{ from: THERMAL, to: 'Imager' }] });
    expect(result).toEqual(next);
  });
  test('an impossible rename hint is dropped (falls back to plain diff)', () => {
    const next = edit(n => { n.allocations.LS3[0] = GRIPHOIST; });
    expect(diffDocs(v1, next, { renames: [{ from: 'Ghost', to: 'Other' }] })).toHaveLength(1);
  });
});

describe('concurrent clients through diff → apply (SD-01 / SD-09)', () => {
  test('two devices diff from the same base; applying both in either order keeps both edits', () => {
    const opsA = diffDocs(base, edit(n => { n.allocations.LS3[0] = GRIPHOIST; }));
    const opsB = diffDocs(base, edit(n => { n.allocations.LS1[5] = CO2; n.bundles.LS1 = [{ id: 'xb1', name: 'X', colorIdx: 0, slotIndices: [0, 5] }]; }));
    const ab = applyOps(applyOps(base, opsA, ctx()).doc, opsB, ctx());
    const ba = applyOps(applyOps(base, opsB, ctx()).doc, opsA, ctx());
    expect(ab.conflicts).toEqual([]);
    expect(ba.conflicts).toEqual([]);
    expect(projectV1(ab.doc)).toEqual(projectV1(ba.doc));
    expect(ab.doc.allocations.LS3[0]).toBe(GRIPHOIST);
    expect(ab.doc.allocations.LS1[5]).toBe(CO2);
  });
  test('last-unit race: loser gets QUANTITY and the bundle that referenced its slot is pruned', () => {
    const opsA = diffDocs(base, edit(n => { n.allocations.LS3[0] = GRIPHOIST; }));
    const opsB = diffDocs(base, edit(n => {
      n.allocations.RS2[0] = GRIPHOIST;
      n.bundles.RS2 = [{ id: 'lost111', name: 'Lost', colorIdx: 0, slotIndices: [0] }];
    }));
    const r = applyOps(applyOps(base, opsA, ctx()).doc, opsB, ctx());
    expect(r.conflicts).toEqual([{ index: 0, reason: 'QUANTITY', current: { assigned: 1, qty: 1 } }]);
    expect(r.doc.allocations.RS2[0]).toBe('');
    expect(r.doc.bundles.RS2).toBeUndefined();
  });
});

const GATE = '2.5 in Gate Valve';
const CO2 = 'CO2 Extinguisher';
const LDH_NAME = '5 in LDH Hose 100 ft Sections (PF-50Y-100)';
