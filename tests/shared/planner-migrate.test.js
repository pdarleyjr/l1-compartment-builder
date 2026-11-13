import { describe, expect, test } from 'vitest';
import { COMPARTMENT_IDS, ID_PATTERN } from '../../shared/contracts.js';
import { CONSOLIDATION_RENAMES, INVENTORY_BY_NAME, MASTER_INVENTORY, SLOTS_PER_COMPARTMENT, V3_RENAMES } from '../../shared/apparatus.js';
import { equipmentIdForNameSync } from '../../shared/ids.js';
import { assignedCounts, compartmentAssignments, effectiveInventory, emptyDocV2, migrateV1toV2, normalizeDoc, projectV1 } from '../../shared/planner.js';
import { counterIds, FOG, IRONS, JACK, THERMAL, VSTRUT, v1Fixture, CELLAR, GRIPHOIST } from './fixtures.js';

const V1_KEYS = ['allocations', 'bundles', 'customDimensions', 'customQtys', 'customTools', 'removedItems'];

describe('emptyDocV2', () => {
  test('all compartments × 15 empty slots, base ids, parity', () => {
    const doc = emptyDocV2();
    expect(doc.schema).toBe(2);
    expect(Object.keys(doc.allocations)).toEqual([...COMPARTMENT_IDS]);
    for (const id of COMPARTMENT_IDS) {
      expect(doc.allocations[id]).toEqual(Array(SLOTS_PER_COMPARTMENT).fill(''));
      expect(doc.assignmentIds[id]).toEqual(Array(SLOTS_PER_COMPARTMENT).fill(null));
    }
    expect(Object.keys(doc.equipmentIds)).toHaveLength(MASTER_INVENTORY.length);
    expect(doc.equipmentIds[JACK]).toBe(equipmentIdForNameSync(JACK));
  });
  test('returns independent objects', () => {
    const a = emptyDocV2();
    a.allocations.LS1[0] = 'x';
    a.equipmentIds.zzz = 'eq_1';
    expect(emptyDocV2().allocations.LS1[0]).toBe('');
    expect(emptyDocV2().equipmentIds.zzz).toBeUndefined();
  });
});

describe('migrateV1toV2', () => {
  test('round trip: projectV1(migrate(v1)) deep-equals the (renamed) v1 and has exactly the v1 keys', async () => {
    const v1 = v1Fixture();
    const { doc, report } = await migrateV1toV2(v1, { newId: counterIds() });
    const proj = projectV1(doc);
    expect(Object.keys(proj).sort()).toEqual(V1_KEYS);
    expect(proj).toEqual(v1);
    expect(report.warnings).toEqual([]);
  });
  test('does not mutate the input', async () => {
    const v1 = v1Fixture();
    const copy = structuredClone(v1);
    await migrateV1toV2(v1);
    expect(v1).toEqual(copy);
  });
  test('ids: deterministic for base names, random for custom tools; one assignment id per occupied slot', async () => {
    const { doc } = await migrateV1toV2(v1Fixture());
    expect(doc.equipmentIds[FOG]).toBe(equipmentIdForNameSync(FOG));
    expect(doc.equipmentIds[THERMAL]).toMatch(ID_PATTERN);
    expect(doc.equipmentIds[THERMAL]).not.toBe(equipmentIdForNameSync(THERMAL));
    let occupied = 0;
    for (const id of COMPARTMENT_IDS) {
      doc.allocations[id].forEach((v, i) => {
        if (v) { occupied++; expect(doc.assignmentIds[id][i]).toMatch(ID_PATTERN); } else expect(doc.assignmentIds[id][i]).toBeNull();
      });
    }
    expect(occupied).toBe(3 + 1 + 2 + 6 + 4);
    const all = Object.values(doc.assignmentIds).flat().filter(Boolean);
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(Object.values(doc.equipmentIds)).size).toBe(Object.keys(doc.equipmentIds).length);
  });
  test('report counts', async () => {
    const { report } = await migrateV1toV2(v1Fixture());
    expect(report.compartments.RS3).toEqual({ slots: 15, occupied: 6 });
    expect(report.compartments.CabRearZone).toEqual({ slots: 15, occupied: 0 });
    expect(Object.keys(report.compartments)).toHaveLength(11);
    expect(report).toMatchObject({ customTools: 1, bundles: 4, removedItems: 1 });
    expect(report.equipment).toBe(MASTER_INVENTORY.length + 1);
  });
  test.each([...Object.entries(V3_RENAMES), ...Object.entries(CONSOLIDATION_RENAMES)])('renames %s', async (oldName, newName) => {
    const v1 = v1Fixture();
    v1.allocations.LS3[2] = oldName;
    const { doc } = await migrateV1toV2(v1);
    expect(doc.allocations.LS3[2]).toBe(newName);
    expect(doc.equipmentIds[newName]).toBe(equipmentIdForNameSync(newName));
  });
  test('seeds missing compartments, ignores obsolete ones, keeps other slot counts', async () => {
    const { doc, report } = await migrateV1toV2({ allocations: { LS1: [FOG, '', ''], OLD: ['x'], RS1: 'oops' } });
    expect(doc.allocations.LS1).toEqual([FOG, '', '']);
    expect(doc.allocations.RR1).toHaveLength(15);
    expect(doc.allocations.OLD).toBeUndefined();
    expect(doc.allocations.RS1).toHaveLength(15);
    expect(report.warnings).toEqual(expect.arrayContaining(['ignored unknown compartment OLD', 'RS1: allocations not an array; kept empty']));
  });
  test('unknown names are kept, get a random id and a warning', async () => {
    const { doc, report } = await migrateV1toV2({ allocations: { LS1: ['Mystery Widget', ''] } });
    expect(doc.allocations.LS1[0]).toBe('Mystery Widget');
    expect(doc.equipmentIds['Mystery Widget']).toMatch(ID_PATTERN);
    expect(report.warnings).toContain('name not in inventory: Mystery Widget');
  });
  test('non-string slots become empty with a warning; non-object input yields an empty doc', async () => {
    const r = await migrateV1toV2({ allocations: { LS1: [5, null, FOG] } });
    expect(r.doc.allocations.LS1).toEqual(['', '', FOG]);
    expect(r.report.warnings).toHaveLength(2);
    const e = await migrateV1toV2(null);
    expect(e.doc.allocations.LS1).toHaveLength(15);
    expect(e.report.warnings[0]).toMatch(/not an object/);
  });
  test('stale bundles (SD-08/13) are pruned with warnings, never silently', async () => {
    const v1 = v1Fixture();
    v1.bundles.LS1 = [{ id: 'aaaa1111', name: 'Stale', colorIdx: 0, slotIndices: [0, 5, 99] }, { id: 'bbbb2222', name: 'Dead', colorIdx: 1, slotIndices: [7] }];
    const { doc, report } = await migrateV1toV2(v1);
    expect(doc.bundles.LS1).toEqual([{ id: 'aaaa1111', name: 'Stale', colorIdx: 0, slotIndices: [0] }]);
    expect(report.warnings).toEqual(expect.arrayContaining(['pruned bundle LS1/aaaa1111', 'deleted empty bundle LS1/bbbb2222']));
  });
  test('migrating a v2 doc again keeps ids (idempotent)', async () => {
    const first = (await migrateV1toV2(v1Fixture())).doc;
    const second = (await migrateV1toV2(first)).doc;
    expect(second.assignmentIds).toEqual(first.assignmentIds);
    expect(second.equipmentIds).toEqual(first.equipmentIds);
  });
});

describe('projectV1', () => {
  test('strips v2-only fields and tool extras, returns copies', async () => {
    const { doc } = await migrateV1toV2(v1Fixture());
    doc.customTools[0].description = 'thermal imager';
    doc.customTools[0].equipmentId = 'eq_0000000000000000';
    const proj = projectV1(doc);
    expect(proj.customTools[0]).toEqual({ name: THERMAL, qty: 2, dimensions: '6 × 4 × 3 in' });
    proj.allocations.LS1[0] = 'changed';
    expect(doc.allocations.LS1[0]).toBe(FOG);
  });
  test('tolerates sparse docs', () => {
    expect(projectV1({})).toEqual({ allocations: {}, customQtys: {}, customTools: [], bundles: {}, removedItems: [], customDimensions: {} });
  });
});

describe('effectiveInventory / counts / assignments', () => {
  test('mirrors App.jsx: base minus removed plus custom, qty overrides, dims over catalog', async () => {
    const { doc } = await migrateV1toV2(v1Fixture());
    const rows = effectiveInventory(doc);
    expect(rows).toHaveLength(MASTER_INVENTORY.length - 1 + 1);
    expect(rows.find(r => r.name === CELLAR)).toBeUndefined();
    const jack = rows.find(r => r.name === JACK);
    expect(jack).toMatchObject({ qty: 2, assigned: 1, free: 1, custom: false, equipmentId: equipmentIdForNameSync(JACK) });
    expect(jack.dims).toBe('10 × 5 × 38 in (W × D × H)');
    expect(rows.find(r => r.name === IRONS).dims).toBe('40 × 9 × 3 in');
    expect(rows.find(r => r.name === THERMAL)).toMatchObject({ qty: 2, assigned: 2, free: 0, custom: true, dims: '6 × 4 × 3 in' });
    expect(rows.find(r => r.name === GRIPHOIST)).toMatchObject({ assigned: 0, free: 1 });
    expect(rows.find(r => r.name === VSTRUT)).toMatchObject({ assigned: 4, free: 0 });
  });
  test('over-assigned items show free 0 (never negative)', () => {
    const doc = normalizeDoc({ ...emptyDocV2(), customQtys: { [JACK]: 0 }, allocations: { ...emptyDocV2().allocations, LS1: [JACK, ...Array(14).fill('')] } }).doc;
    expect(effectiveInventory(doc).find(r => r.name === JACK)).toMatchObject({ qty: 0, assigned: 1, free: 0 });
  });
  test('custom tool dims default to empty; unknown custom equipmentId is null without registry', () => {
    const doc = { allocations: {}, customTools: [{ name: 'Zed', qty: 1 }], customQtys: {}, customDimensions: {}, removedItems: [] };
    expect(effectiveInventory(doc).find(r => r.name === 'Zed')).toMatchObject({ dims: '', equipmentId: null });
  });
  test('assignedCounts counts every compartment', async () => {
    const { doc } = await migrateV1toV2(v1Fixture());
    expect(assignedCounts(doc)).toMatchObject({ [FOG]: 3, [THERMAL]: 2, [VSTRUT]: 4 });
  });
  test('compartmentAssignments lists occupied slots with ids and bundle', async () => {
    const { doc } = await migrateV1toV2(v1Fixture());
    const rows = compartmentAssignments(doc, 'RS3');
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ slotIndex: 0, name: VSTRUT, equipmentId: equipmentIdForNameSync(VSTRUT), assignmentId: doc.assignmentIds.RS3[0], bundleId: 'k3j9x2a1' });
    expect(rows[5].bundleId).toBeNull();
    expect(compartmentAssignments(doc, 'NOPE')).toEqual([]);
  });
  test('compartmentAssignments works on v1-like docs without ids', () => {
    const rows = compartmentAssignments({ allocations: { LS1: ['Hi-Lift Jack', ''] } }, 'LS1');
    expect(rows).toEqual([{ slotIndex: 0, name: JACK, equipmentId: equipmentIdForNameSync(JACK), assignmentId: null, bundleId: null }]);
  });
});

describe('normalizeDoc', () => {
  test('repairs parity, registry and bundles; reports repairs; pure', () => {
    const base = emptyDocV2();
    const broken = {
      ...base, allocations: { ...base.allocations, LS1: [FOG, '', JACK] }, assignmentIds: { LS1: ['as_keepkeepkeepkeepkeep', 'as_zzzzzzzzzzzzzzzzzzzz'] },
      bundles: { LS1: [{ id: 'bb', name: 'b', colorIdx: 0, slotIndices: [0, 1, 0, 50] }], GONE: [{ id: 'g', name: 'g', colorIdx: 0, slotIndices: [0] }] },
    };
    const copy = structuredClone(broken);
    const { doc, repairs } = normalizeDoc(broken, { newId: counterIds() });
    expect(broken).toEqual(copy);
    expect(doc.assignmentIds.LS1).toEqual(['as_keepkeepkeepkeepkeep', null, 'as_00000000000000000001']);
    expect(doc.bundles).toEqual({ LS1: [{ id: 'bb', name: 'b', colorIdx: 0, slotIndices: [0] }] });
    expect(repairs.length).toBeGreaterThan(0);
    expect(normalizeDoc(doc).repairs).toEqual([]);
  });
  test('reserves a fresh id when the deterministic id is already used by another name', () => {
    const doc = { ...emptyDocV2(), equipmentIds: { [THERMAL]: equipmentIdForNameSync(JACK) }, customTools: [{ name: THERMAL, qty: 1, dimensions: '' }] };
    delete doc.equipmentIds[JACK];
    const { doc: n } = normalizeDoc(doc, { newId: counterIds() });
    expect(n.equipmentIds[JACK]).toBe('eq_00000000000000000001');
  });
  test('fills in missing top-level fields of a v1-ish object', () => {
    const { doc } = normalizeDoc({ allocations: { LS1: [JACK] } });
    expect(doc.schema).toBe(2);
    expect(Object.keys(doc.allocations)).toHaveLength(11);
    expect(doc.customTools).toEqual([]);
    expect(doc.assignmentIds.LS1[0]).toMatch(ID_PATTERN);
  });
});

test('quantities in the production-shaped fixture are valid', () => {
  const counts = assignedCounts(v1Fixture());
  for (const [name, n] of Object.entries(counts)) {
    const qty = name === JACK ? 2 : name === THERMAL ? 2 : INVENTORY_BY_NAME[name].qty;
    expect(n).toBeLessThanOrEqual(qty);
  }
});
