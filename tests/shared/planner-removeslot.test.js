import { beforeEach, describe, expect, test } from 'vitest';
import { applyOps, diffDocs, migrateV1toV2, projectV1, validateOp } from '../../shared/planner.js';
import { AXE, counterIds, CUTTER, IRONS, JACK, THERMAL, v1Fixture, VSTRUT, LDH } from './fixtures.js';

let base;
beforeEach(async () => { base = (await migrateV1toV2(v1Fixture(), { newId: counterIds() })).doc; });
const apply = (ops, d = base) => applyOps(d, ops, { newId: counterIds(), now: 1 });
const rm = (comp, index, expect) => ({ op: 'removeSlot', comp, index, expect });

describe('removeSlot', () => {
  test('shifts later items up, keeps their assignment ids, pads with empty, slot count unchanged', () => {
    const before = base.assignmentIds.RS3;
    const r = apply([rm('RS3', 1, VSTRUT)]);
    expect(r.conflicts).toEqual([]);
    expect(r.doc.allocations.RS3).toEqual([VSTRUT, VSTRUT, VSTRUT, LDH, LDH, '', '', '', '', '', '', '', '', '', '']);
    expect(r.doc.allocations.RS3).toHaveLength(15);
    expect(r.doc.assignmentIds.RS3.slice(0, 5)).toEqual([before[0], before[2], before[3], before[4], before[5]]);
    expect(r.doc.assignmentIds.RS3.slice(5)).toEqual(Array(10).fill(null));
  });

  test('remaps bundles: drops the removed index, decrements those below, deletes emptied bundles', () => {
    // RS3 bundles: [0,1] and [2,3]; removing slot 1 → first [0], second [1,2]
    let r = apply([rm('RS3', 1, VSTRUT)]);
    expect(r.doc.bundles.RS3.map(b => b.slotIndices)).toEqual([[0], [1, 2]]);
    // a bundle spanning the removed slot
    const spanning = apply([{ op: 'upsertBundle', comp: 'RS3', bundle: { id: 'span1', name: 'S', colorIdx: 3, slotIndices: [1, 2, 4] } }]).doc;
    r = apply([rm('RS3', 2, VSTRUT)], spanning);
    expect(r.doc.bundles.RS3.find(b => b.id === 'span1').slotIndices).toEqual([1, 3]);
    // single-slot bundle disappears when its slot is removed
    const single = apply([{ op: 'upsertBundle', comp: 'LS2', bundle: { id: 'one1', name: 'J', colorIdx: 0, slotIndices: [3] } }]).doc;
    expect(apply([rm('LS2', 3, JACK)], single).doc.bundles.LS2).toBeUndefined();
  });

  test('PRECONDITION on stale expect (current returned), NOT_FOUND for unknown comp / index, no change', () => {
    const r = apply([rm('RS3', 0, AXE), rm('NOPE', 0, AXE), rm('RS3', 15, VSTRUT), rm('LS3', 0, AXE)]);
    expect(r.applied).toEqual([]);
    expect(r.conflicts.map(c => c.reason)).toEqual(['PRECONDITION', 'NOT_FOUND', 'NOT_FOUND', 'PRECONDITION']);
    expect(r.conflicts[0].current).toBe(VSTRUT);
    expect(r.conflicts[3].current).toBe('');
    expect(r.doc).toEqual(apply([]).doc);
  });

  test('validateOp: expect must be a non-empty name', () => {
    expect(validateOp(rm('RS3', 0, ''))).toMatchObject({ ok: false });
    expect(validateOp(rm('RS3', -1, VSTRUT))).toMatchObject({ ok: false });
    expect(validateOp({ op: 'removeSlot', comp: 'RS3', index: 0 })).toMatchObject({ ok: false });
  });

  test('other compartments are untouched', () => {
    const r = apply([rm('RS3', 0, VSTRUT)]);
    for (const id of Object.keys(base.allocations)) {
      if (id === 'RS3') continue;
      expect(r.doc.allocations[id]).toEqual(base.allocations[id]);
      expect(r.doc.assignmentIds[id]).toEqual(base.assignmentIds[id]);
      expect(r.doc.bundles[id]).toEqual(base.bundles[id]);
    }
  });
});

describe('name removal packs slots', () => {
  test('removeCustomTool packs, keeping other slots\' ids', () => {
    // LS4[0] and RS5[0] hold THERMAL; put another item below in LS4
    const d = apply([{ op: 'setSlot', comp: 'LS4', index: 1, value: AXE, expect: '' }]).doc;
    const axeId = d.assignmentIds.LS4[1];
    const r = apply([{ op: 'removeCustomTool', name: THERMAL }], d);
    expect(r.doc.allocations.LS4.slice(0, 2)).toEqual([AXE, '']);
    expect(r.doc.assignmentIds.LS4[0]).toBe(axeId);
    expect(r.doc.allocations.RS5.every(v => v === '')).toBe(true);
  });

  test('setRemoved packs several slots of one name and remaps bundles', () => {
    const r = apply([{ op: 'setRemoved', name: CUTTER, removed: true }]);
    expect(r.doc.allocations.RR1.slice(0, 3)).toEqual([AXE, IRONS, '']);
    expect(r.doc.allocations.RR1).toHaveLength(15);
    expect(r.doc.assignmentIds.RR1[0]).toBe(base.assignmentIds.RR1[2]);
    expect(r.doc.assignmentIds.RR1[1]).toBe(base.assignmentIds.RR1[3]);
    expect(r.doc.bundles.RR1.map(b => [b.id, b.slotIndices])).toEqual([['r6s6a5d4', [0, 1]]]);
  });
});

describe('diffDocs with slotRemovals / packed removals', () => {
  const viewPacked = (comp, index) => {
    const v = projectV1(base);
    const slots = v.allocations[comp];
    v.allocations[comp] = [...slots.slice(0, index), ...slots.slice(index + 1), ''];
    v.bundles[comp] = (v.bundles[comp] ?? []).map(b => ({ ...b, slotIndices: b.slotIndices.filter(i => i !== index).map(i => (i > index ? i - 1 : i)) })).filter(b => b.slotIndices.length);
    return v;
  };

  test('slotRemovals → exactly one removeSlot op; applyOps reproduces next with ids kept', () => {
    const next = viewPacked('RS3', 1);
    const ops = diffDocs(base, next, { slotRemovals: [{ comp: 'RS3', index: 1, expect: VSTRUT }] });
    expect(ops).toEqual([rm('RS3', 1, VSTRUT)]);
    const r = apply(ops);
    expect(r.conflicts).toEqual([]);
    expect(projectV1(r.doc)).toEqual(projectV1(apply([]).doc) && { ...next, notes: {}, unverified: {} });
    expect(r.doc.assignmentIds.RS3[1]).toBe(base.assignmentIds.RS3[2]);
  });

  test('a removal hint that does not apply is skipped', () => {
    const ops = diffDocs(base, base, { slotRemovals: [{ comp: 'RS3', index: 1, expect: AXE }] });
    expect(ops).toEqual([]);
  });

  test('several removals (highest index first) in one diff', () => {
    const v = projectV1(base);
    v.allocations.RR1 = [AXE, IRONS, ...Array(13).fill('')];
    v.bundles.RR1 = [{ id: 'r6s6a5d4', name: 'Hand tools', colorIdx: 2, slotIndices: [0, 1] }];
    const ops = diffDocs(base, v, { slotRemovals: [rm('RR1', 1, CUTTER), rm('RR1', 0, CUTTER)].map(({ comp, index, expect: e }) => ({ comp, index, expect: e })) });
    expect(ops.map(o => o.op)).toEqual(['removeSlot', 'removeSlot']);
    expect(projectV1(apply(ops).doc).allocations.RR1).toEqual(v.allocations.RR1);
    expect(apply(ops).doc.bundles.RR1.map(b => b.slotIndices)).toEqual([[0, 1]]);
  });

  test('packed removeItem views yield only the removal op (setRemoved / removeCustomTool)', () => {
    for (const [name, op] of [[CUTTER, { op: 'setRemoved', name: CUTTER, removed: true }], [THERMAL, { op: 'removeCustomTool', name: THERMAL }]]) {
      const expected = apply([op]).doc;
      const next = projectV1(expected);
      const ops = diffDocs(base, next);
      expect(ops).toEqual([op]);
      const r = apply(ops);
      expect(r.conflicts).toEqual([]);
      expect(projectV1(r.doc)).toEqual(projectV1(expected));
      expect(name).toBeTruthy();
    }
  });

  test('an old-style blanked view still round-trips', () => {
    const v = projectV1(base);
    v.allocations.RS3[1] = '';
    v.bundles.RS3 = [v.bundles.RS3[0], v.bundles.RS3[1]].map((b, i) => (i === 0 ? { ...b, slotIndices: [0] } : b));
    const ops = diffDocs(base, v);
    expect(projectV1(apply(ops).doc).allocations.RS3).toEqual(v.allocations.RS3);
  });
});
