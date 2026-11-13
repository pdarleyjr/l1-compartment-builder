import { beforeEach, describe, expect, test } from 'vitest';
import { CONFLICT_REASONS, ID_PATTERN, PLANNER_LIMITS, PLANNER_OPS } from '../../shared/contracts.js';
import { equipmentIdForNameSync } from '../../shared/ids.js';
import { applyOps, assignedCounts, effectiveInventory, migrateV1toV2, projectV1, validateOp } from '../../shared/planner.js';
import { counterIds, CELLAR, FOG, GRIPHOIST, IRONS, JACK, THERMAL, VSTRUT, v1Fixture } from './fixtures.js';

let doc;
let ctx;
beforeEach(async () => {
  ctx = { newId: counterIds(), now: 1 };
  doc = (await migrateV1toV2(v1Fixture(), { newId: counterIds() })).doc;
});
const apply = (ops, d = doc) => applyOps(d, ops, ctx);
const setSlot = (comp, index, value, expect = '') => ({ op: 'setSlot', comp, index, value, expect });

describe('validateOp', () => {
  const good = [
    setSlot('LS1', 0, 'x'), { op: 'setSlotCount', comp: 'LS1', count: 20, expect: 15 }, { op: 'setCustomQty', name: 'a', qty: 3 },
    { op: 'setCustomQty', name: 'a', qty: null }, { op: 'upsertCustomTool', tool: { name: 'T', qty: 1, dimensions: '1 in', description: 'd', equipmentId: 'eq_aaaaaaaaaaaaaaaa' } },
    { op: 'removeCustomTool', name: 'T' }, { op: 'setDimension', name: 'a', value: '1 x 1' }, { op: 'setDimension', name: 'a', value: null },
    { op: 'setRemoved', name: 'a', removed: true },
    { op: 'upsertBundle', comp: 'LS1', bundle: { id: 'abc123', name: 'B', colorIdx: 0, slotIndices: [0] } },
    { op: 'deleteBundle', comp: 'LS1', id: 'abc123' }, { op: 'renameEquipment', from: 'a', to: 'b' },
    { type: 'setSlot', comp: 'LS1', index: 0, value: '', expect: 'x' },
  ];
  test.each(good.map(o => [o.op ?? o.type, o]))('accepts %s', (_n, op) => expect(validateOp(op)).toEqual({ ok: true }));
  test('every PLANNER_OPS name is covered by the good list', () => {
    expect(new Set(good.map(o => o.op ?? o.type))).toEqual(new Set(PLANNER_OPS));
  });
  const bad = [
    ['not an object', null], ['array', []], ['unknown op', { op: 'dropTable' }], ['missing field', { op: 'setSlot', comp: 'LS1', index: 0, value: '' }],
    ['extra field', { ...setSlot('LS1', 0, 'x'), evil: 1 }], ['negative index', setSlot('LS1', -1, 'x')],
    ['index beyond limit', setSlot('LS1', PLANNER_LIMITS.maxSlotsPerCompartment, 'x')], ['fractional index', setSlot('LS1', 1.5, 'x')],
    ['value too long', setSlot('LS1', 0, 'x'.repeat(301))], ['value not string', setSlot('LS1', 0, 5)],
    ['count 0', { op: 'setSlotCount', comp: 'LS1', count: 0, expect: 15 }], ['count too big', { op: 'setSlotCount', comp: 'LS1', count: 501, expect: 15 }],
    ['qty negative', { op: 'setCustomQty', name: 'a', qty: -1 }], ['qty huge', { op: 'setCustomQty', name: 'a', qty: 10001 }],
    ['name untrimmed', { op: 'removeCustomTool', name: ' a' }], ['name empty', { op: 'removeCustomTool', name: '' }],
    ['tool extra key', { op: 'upsertCustomTool', tool: { name: 'T', qty: 1, x: 1 } }], ['tool bad id', { op: 'upsertCustomTool', tool: { name: 'T', qty: 1, equipmentId: 'nope' } }],
    ['tool qty float', { op: 'upsertCustomTool', tool: { name: 'T', qty: 1.5 } }],
    ['dimension empty', { op: 'setDimension', name: 'a', value: '' }], ['removed not bool', { op: 'setRemoved', name: 'a', removed: 1 }],
    ['bundle bad id', { op: 'upsertBundle', comp: 'LS1', bundle: { id: 'A B', name: 'B', colorIdx: 0, slotIndices: [] } }],
    ['bundle bad slot', { op: 'upsertBundle', comp: 'LS1', bundle: { id: 'ab', name: 'B', colorIdx: 0, slotIndices: [-1] } }],
    ['bundle extra', { op: 'upsertBundle', comp: 'LS1', bundle: { id: 'ab', name: 'B', colorIdx: 0, slotIndices: [], z: 1 } }],
    ['deleteBundle bad id', { op: 'deleteBundle', comp: 'LS1', id: '' }],
  ];
  test.each(bad)('rejects %s', (_n, op) => {
    const r = validateOp(op);
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
  });
});

describe('applyOps: purity and result shape', () => {
  test('never mutates inputs and returns new objects', () => {
    const before = structuredClone(doc);
    const ops = [setSlot('LS3', 0, GRIPHOIST)];
    const opsBefore = structuredClone(ops);
    const r = apply(ops);
    expect(doc).toEqual(before);
    expect(ops).toEqual(opsBefore);
    expect(r.doc).not.toBe(doc);
    expect(r.doc.allocations.LS3[0]).toBe(GRIPHOIST);
    expect(r).toMatchObject({ applied: [0], conflicts: [] });
  });
  test('non-array ops apply nothing', () => {
    expect(apply(undefined)).toMatchObject({ applied: [], conflicts: [] });
  });
  test('invalid ops are INVALID conflicts and do not stop the rest', () => {
    const r = apply([{ op: 'nope' }, setSlot('LS3', 0, GRIPHOIST)]);
    expect(r.applied).toEqual([1]);
    expect(r.conflicts).toEqual([{ index: 0, reason: 'INVALID', message: expect.any(String) }]);
  });
  test('every conflict reason is a contract reason', () => {
    const r = apply([setSlot('XX', 0, ''), setSlot('LS1', 99, ''), setSlot('LS1', 0, JACK, ''), setSlot('LS3', 0, 'Nope')]);
    for (const c of r.conflicts) expect(CONFLICT_REASONS).toContain(c.reason);
  });
});

describe('setSlot', () => {
  test('mints a new assignment id when an empty slot is filled and when the item changes; keeps it when unchanged', () => {
    const filled = apply([setSlot('LS3', 0, GRIPHOIST)]).doc;
    const id1 = filled.assignmentIds.LS3[0];
    expect(id1).toMatch(ID_PATTERN);
    const swapped = apply([setSlot('LS3', 0, JACK, GRIPHOIST)], filled).doc;
    expect(swapped.assignmentIds.LS3[0]).not.toBe(id1);
    expect(swapped.assignmentIds.LS3[0]).toMatch(ID_PATTERN);
    const same = apply([setSlot('LS3', 0, JACK, JACK)], swapped).doc;
    expect(same.assignmentIds.LS3[0]).toBe(swapped.assignmentIds.LS3[0]);
  });
  test('emptying clears the assignment id and prunes bundles (SD-08)', () => {
    const r = apply([setSlot('RS3', 0, '', VSTRUT)]);
    expect(r.doc.assignmentIds.RS3[0]).toBeNull();
    expect(r.doc.bundles.RS3[0].slotIndices).toEqual([1]);
    const r2 = apply([setSlot('RS3', 1, '', VSTRUT)], r.doc);
    expect(r2.doc.bundles.RS3.map(b => b.id)).toEqual(['m4n8y3b2']);
  });
  test('PRECONDITION when expect differs; reports the current value', () => {
    const r = apply([setSlot('LS1', 0, '', 'something else')]);
    expect(r.conflicts).toEqual([{ index: 0, reason: 'PRECONDITION', current: FOG }]);
    expect(r.doc.allocations.LS1[0]).toBe(FOG);
  });
  test('idempotent when the slot already equals the value (counted as applied)', () => {
    const r = apply([setSlot('LS1', 0, FOG, '')]);
    expect(r).toMatchObject({ applied: [0], conflicts: [] });
    const r2 = apply([setSlot('LS1', 0, FOG, FOG)]);
    expect(r2.applied).toEqual([0]);
  });
  test('NOT_FOUND for unknown compartment, out-of-range index, and unknown equipment', () => {
    const r = apply([setSlot('XX', 0, ''), setSlot('LS1', 15, ''), setSlot('LS3', 0, 'Not an item')]);
    expect(r.conflicts.map(c => c.reason)).toEqual(['NOT_FOUND', 'NOT_FOUND', 'NOT_FOUND']);
  });
  test('removed base items are not assignable', () => {
    expect(apply([setSlot('LS3', 0, CELLAR)]).conflicts[0].reason).toBe('NOT_FOUND');
  });
  test('QUANTITY: cannot exceed effective qty; the op is skipped', () => {
    const r = apply([setSlot('LS3', 0, VSTRUT)]); // 4 of 4 already placed in RS3
    expect(r.conflicts).toEqual([{ index: 0, reason: 'QUANTITY', current: { assigned: 4, qty: 4 } }]);
    expect(r.doc.allocations.LS3[0]).toBe('');
  });
  test('QUANTITY respects customQtys overrides and custom tool qty', () => {
    expect(apply([setSlot('LS3', 0, JACK)]).applied).toEqual([0]); // qty override 2, one placed
    expect(apply([setSlot('LS3', 0, THERMAL)]).conflicts[0].reason).toBe('QUANTITY'); // 2 of 2
  });
  test('moving an item between slots in one batch needs a clear first at capacity', () => {
    const swap = apply([setSlot('LS3', 0, VSTRUT)]);
    expect(swap.conflicts[0].reason).toBe('QUANTITY');
    const ordered = apply([setSlot('RS3', 3, '', VSTRUT), setSlot('LS3', 0, VSTRUT)]);
    expect(ordered.conflicts).toEqual([]);
  });
  test('registers an equipment id for newly used names', () => {
    const d = structuredClone(doc);
    delete d.equipmentIds[GRIPHOIST];
    const r = apply([setSlot('LS3', 0, GRIPHOIST)], d);
    expect(r.doc.equipmentIds[GRIPHOIST]).toBe(equipmentIdForNameSync(GRIPHOIST));
  });
});

describe('setSlotCount', () => {
  test('grows with empty slots and null ids; idempotent re-apply', () => {
    const op = { op: 'setSlotCount', comp: 'LS1', count: 18, expect: 15 };
    const r = apply([op]);
    expect(r.doc.allocations.LS1).toHaveLength(18);
    expect(r.doc.assignmentIds.LS1.slice(15)).toEqual([null, null, null]);
    expect(apply([op], r.doc)).toMatchObject({ applied: [0], conflicts: [] });
  });
  test('shrinks only empty tail slots', () => {
    const grown = apply([{ op: 'setSlotCount', comp: 'LS1', count: 17, expect: 15 }]).doc;
    expect(apply([{ op: 'setSlotCount', comp: 'LS1', count: 15, expect: 17 }], grown).doc.allocations.LS1).toHaveLength(15);
    const r = apply([{ op: 'setSlotCount', comp: 'LS1', count: 1, expect: 15 }]);
    expect(r.conflicts[0]).toMatchObject({ reason: 'PRECONDITION', current: 15 });
  });
  test('PRECONDITION on stale expect; NOT_FOUND on unknown compartment', () => {
    expect(apply([{ op: 'setSlotCount', comp: 'LS1', count: 20, expect: 10 }]).conflicts[0]).toMatchObject({ reason: 'PRECONDITION', current: 15 });
    expect(apply([{ op: 'setSlotCount', comp: 'XX', count: 20, expect: 10 }]).conflicts[0].reason).toBe('NOT_FOUND');
  });
});

describe('custom tools, quantities, dimensions, removal', () => {
  test('upsertCustomTool creates (with preferred id), updates, keeps description, and rejects duplicate names', () => {
    const id = 'eq_aaaaaaaaaaaaaaaaaaaa';
    let r = apply([{ op: 'upsertCustomTool', tool: { name: 'Pry Bar', qty: 3, dimensions: '30 in', description: 'steel bar', equipmentId: id } }]);
    expect(r.doc.customTools.at(-1)).toEqual({ name: 'Pry Bar', qty: 3, dimensions: '30 in', description: 'steel bar' });
    expect(r.doc.equipmentIds['Pry Bar']).toBe(id);
    r = apply([{ op: 'upsertCustomTool', tool: { name: 'Pry Bar', qty: 4 } }], r.doc);
    expect(r.doc.customTools.at(-1)).toEqual({ name: 'Pry Bar', qty: 4, dimensions: '', description: 'steel bar' });
    expect(r.doc.equipmentIds['Pry Bar']).toBe(id);
    expect(apply([{ op: 'upsertCustomTool', tool: { name: 'pry bar', qty: 1 } }], r.doc).conflicts[0].reason).toBe('INVALID');
    expect(apply([{ op: 'upsertCustomTool', tool: { name: JACK, qty: 1 } }]).conflicts[0].reason).toBe('INVALID');
    expect(apply([{ op: 'upsertCustomTool', tool: { name: 'New One', qty: 1 } }]).doc.equipmentIds['New One']).toMatch(ID_PATTERN);
  });
  test('removeCustomTool clears its slots like App.jsx, drops qty override, id, and prunes bundles; absent = no-op', () => {
    const withBundle = apply([{ op: 'upsertBundle', comp: 'LS4', bundle: { id: 'zz9', name: 'T', colorIdx: 0, slotIndices: [0] } }]).doc;
    const r = apply([{ op: 'removeCustomTool', name: THERMAL }], withBundle);
    expect(r.doc.customTools).toEqual([]);
    expect(r.doc.allocations.LS4[0]).toBe('');
    expect(r.doc.allocations.RS5[0]).toBe('');
    expect(r.doc.assignmentIds.RS5[0]).toBeNull();
    expect(r.doc.bundles.LS4).toBeUndefined();
    expect(r.doc.equipmentIds[THERMAL]).toBeUndefined();
    expect(apply([{ op: 'removeCustomTool', name: THERMAL }], r.doc)).toMatchObject({ applied: [0], conflicts: [] });
  });
  test('setCustomQty sets/clears; lowering below assigned is allowed (UI "Over" badge); unknown name NOT_FOUND', () => {
    let r = apply([{ op: 'setCustomQty', name: VSTRUT, qty: 1 }]);
    expect(effectiveInventory(r.doc).find(x => x.name === VSTRUT)).toMatchObject({ qty: 1, assigned: 4, free: 0 });
    r = apply([{ op: 'setCustomQty', name: VSTRUT, qty: null }], r.doc);
    expect(r.doc.customQtys[VSTRUT]).toBeUndefined();
    expect(apply([{ op: 'setCustomQty', name: 'Ghost', qty: 1 }]).conflicts[0].reason).toBe('NOT_FOUND');
  });
  test('setDimension sets and clears', () => {
    let r = apply([{ op: 'setDimension', name: FOG, value: '12 in' }]);
    expect(effectiveInventory(r.doc).find(x => x.name === FOG).dims).toBe('12 in');
    r = apply([{ op: 'setDimension', name: FOG, value: null }], r.doc);
    expect(r.doc.customDimensions[FOG]).toBeUndefined();
  });
  test('setRemoved clears slots + qty override (App.jsx handleRemoveItem) and is reversible; non-base NOT_FOUND', () => {
    let r = apply([{ op: 'setRemoved', name: JACK, removed: true }]);
    expect(r.doc.removedItems).toEqual([CELLAR, JACK]);
    expect(r.doc.allocations.LS2[3]).toBe('');
    expect(r.doc.customQtys[JACK]).toBeUndefined();
    expect(effectiveInventory(r.doc).some(x => x.name === JACK)).toBe(false);
    expect(apply([{ op: 'setRemoved', name: JACK, removed: true }], r.doc).doc.removedItems).toEqual([CELLAR, JACK]);
    r = apply([{ op: 'setRemoved', name: JACK, removed: false }], r.doc);
    expect(r.doc.removedItems).toEqual([CELLAR]);
    expect(apply([{ op: 'setRemoved', name: THERMAL, removed: true }]).conflicts[0].reason).toBe('NOT_FOUND');
  });
});

describe('bundles', () => {
  test('upsert replaces by id, appends otherwise, prunes empty/out-of-range slots, deletes empty bundles', () => {
    let r = apply([{ op: 'upsertBundle', comp: 'LS1', bundle: { id: 'nb1', name: 'Nozzles', colorIdx: 3, slotIndices: [0, 1, 7, 99] } }]);
    expect(r.doc.bundles.LS1).toEqual([{ id: 'nb1', name: 'Nozzles', colorIdx: 3, slotIndices: [0, 1] }]);
    r = apply([{ op: 'upsertBundle', comp: 'LS1', bundle: { id: 'nb1', name: 'Renamed', colorIdx: 3, slotIndices: [1] } }], r.doc);
    expect(r.doc.bundles.LS1).toEqual([{ id: 'nb1', name: 'Renamed', colorIdx: 3, slotIndices: [1] }]);
    r = apply([{ op: 'upsertBundle', comp: 'LS1', bundle: { id: 'nb2', name: 'Empty', colorIdx: 0, slotIndices: [9] } }], r.doc);
    expect(r.doc.bundles.LS1.map(b => b.id)).toEqual(['nb1']);
  });
  test('deleteBundle removes by id, missing id is a no-op, unknown comp NOT_FOUND', () => {
    const r = apply([{ op: 'deleteBundle', comp: 'RS3', id: 'k3j9x2a1' }, { op: 'deleteBundle', comp: 'RS3', id: 'missing' }, { op: 'deleteBundle', comp: 'XX', id: 'a' }]);
    expect(r.doc.bundles.RS3.map(b => b.id)).toEqual(['m4n8y3b2']);
    expect(r.applied).toEqual([0, 1]);
    expect(r.conflicts[0].reason).toBe('NOT_FOUND');
    expect(apply([{ op: 'upsertBundle', comp: 'XX', bundle: { id: 'a', name: 'a', colorIdx: 0, slotIndices: [] } }]).conflicts[0].reason).toBe('NOT_FOUND');
  });
  test('SD-08: Reset-all style clears leave no stale bundles', () => {
    const clears = [];
    doc.allocations.RS3.forEach((v, i) => { if (v) clears.push(setSlot('RS3', i, '', v)); });
    const r = apply(clears);
    expect(r.doc.bundles.RS3).toBeUndefined();
    expect(r.doc.bundles.RR1).toBeDefined();
  });
});

describe('renameEquipment (SD-07)', () => {
  test('custom tool: slots, qty override, dimension override follow; equipment and assignment ids kept', () => {
    const d = apply([{ op: 'setCustomQty', name: THERMAL, qty: 5 }, { op: 'setDimension', name: THERMAL, value: '7 in' }]).doc;
    const ids = structuredClone(d.assignmentIds);
    const eq = d.equipmentIds[THERMAL];
    const r = apply([{ op: 'renameEquipment', from: THERMAL, to: 'Thermal Imager' }], d);
    expect(r.conflicts).toEqual([]);
    expect(r.doc.allocations.LS4[0]).toBe('Thermal Imager');
    expect(r.doc.allocations.RS5[0]).toBe('Thermal Imager');
    expect(r.doc.customTools[0].name).toBe('Thermal Imager');
    expect(r.doc.customQtys['Thermal Imager']).toBe(5);
    expect(r.doc.customDimensions['Thermal Imager']).toBe('7 in');
    expect(r.doc.customQtys[THERMAL]).toBeUndefined();
    expect(r.doc.equipmentIds['Thermal Imager']).toBe(eq);
    expect(r.doc.equipmentIds[THERMAL]).toBeUndefined();
    expect(r.doc.assignmentIds).toEqual(ids);
  });
  test('base item: promoted to a custom tool, old name removed, id and assignments kept (App.jsx saveEdit)', () => {
    const eq = doc.equipmentIds[JACK];
    const as = doc.assignmentIds.LS2[3];
    const r = apply([{ op: 'renameEquipment', from: JACK, to: 'Hi-Lift Jack 48 in' }]);
    expect(r.doc.removedItems).toContain(JACK);
    expect(r.doc.customTools.at(-1)).toMatchObject({ name: 'Hi-Lift Jack 48 in', qty: 2 });
    expect(r.doc.allocations.LS2[3]).toBe('Hi-Lift Jack 48 in');
    expect(r.doc.equipmentIds['Hi-Lift Jack 48 in']).toBe(eq);
    expect(r.doc.assignmentIds.LS2[3]).toBe(as);
    const inv = effectiveInventory(r.doc).find(x => x.name === 'Hi-Lift Jack 48 in');
    expect(inv).toMatchObject({ assigned: 1, custom: true, equipmentId: eq });
    expect(inv.dims).toContain('38');
  });
  test('rename back and forth keeps the same identity', () => {
    const eq = doc.equipmentIds[THERMAL];
    const a = apply([{ op: 'renameEquipment', from: THERMAL, to: 'X1' }]).doc;
    const b = apply([{ op: 'renameEquipment', from: 'X1', to: THERMAL }], a).doc;
    expect(b.equipmentIds[THERMAL]).toBe(eq);
    expect(b.allocations.LS4[0]).toBe(THERMAL);
  });
  test('rejects duplicates (case-insensitive), unknown source; is idempotent', () => {
    expect(apply([{ op: 'renameEquipment', from: THERMAL, to: JACK.toUpperCase() }]).conflicts[0].reason).toBe('INVALID');
    expect(apply([{ op: 'renameEquipment', from: 'Ghost', to: 'Other' }]).conflicts[0].reason).toBe('NOT_FOUND');
    const once = apply([{ op: 'renameEquipment', from: THERMAL, to: 'X1' }]).doc;
    expect(apply([{ op: 'renameEquipment', from: THERMAL, to: 'X1' }], once)).toMatchObject({ applied: [0], conflicts: [] });
    expect(apply([{ op: 'renameEquipment', from: THERMAL, to: THERMAL }])).toMatchObject({ applied: [0], conflicts: [] });
  });
});

describe('concurrency scenarios (SD-01, SD-09)', () => {
  test('SD-01: two devices editing different compartments both survive, in either order', () => {
    const a = [setSlot('LS3', 0, GRIPHOIST)];
    const b = [setSlot('LS1', 5, FOG)];
    const ab = apply(b, apply(a).doc);
    const ba = apply(a, apply(b).doc);
    for (const r of [ab, ba]) {
      expect(r.conflicts).toEqual([]);
      expect(r.doc.allocations.LS3[0]).toBe(GRIPHOIST);
      expect(r.doc.allocations.LS1[5]).toBe(FOG);
    }
    expect(projectV1(ab.doc)).toEqual(projectV1(ba.doc));
  });
  test('SD-01: same slot, different values → second writer gets PRECONDITION and the first value survives', () => {
    const first = apply([setSlot('LS3', 0, GRIPHOIST)]);
    const second = apply([setSlot('LS3', 0, JACK)], first.doc);
    expect(second.conflicts).toEqual([{ index: 0, reason: 'PRECONDITION', current: GRIPHOIST }]);
    expect(second.doc.allocations.LS3[0]).toBe(GRIPHOIST);
  });
  test('SD-09: both devices take the last unit → exactly one wins, the other gets QUANTITY (no over-allocation)', () => {
    const a = [setSlot('LS3', 0, GRIPHOIST)];
    const b = [setSlot('RS2', 4, GRIPHOIST)];
    const r1 = apply(a);
    const r2 = apply(b, r1.doc);
    expect(r1.conflicts).toEqual([]);
    expect(r2.conflicts).toEqual([{ index: 0, reason: 'QUANTITY', current: { assigned: 1, qty: 1 } }]);
    expect(assignedCounts(r2.doc)[GRIPHOIST]).toBe(1);
    const flipped = apply(a, apply(b).doc);
    expect(flipped.conflicts[0].reason).toBe('QUANTITY');
    expect(assignedCounts(flipped.doc)[GRIPHOIST]).toBe(1);
  });
  test('SD-08 across devices: one device assigns into a bundle slot another just cleared → bundle pruned', () => {
    const cleared = apply([setSlot('RR1', 0, '', 'x')]); // stale expect → conflict, bundle untouched
    expect(cleared.doc.bundles.RR1).toHaveLength(2);
    const r = apply([{ op: 'upsertBundle', comp: 'RR1', bundle: { id: 'late', name: 'Late', colorIdx: 0, slotIndices: [10] } }]);
    expect(r.doc.bundles.RR1.map(b => b.id)).not.toContain('late');
  });
  test('IRONS dimension override survives unrelated ops', () => {
    expect(effectiveInventory(apply([setSlot('LS3', 0, GRIPHOIST)]).doc).find(x => x.name === IRONS).dims).toBe('40 × 9 × 3 in');
  });
});
