import { beforeEach, describe, expect, test } from 'vitest';
import { inventoryFingerprint } from '../../shared/fingerprint.js';
import { applyOps, migrateV1toV2 } from '../../shared/planner.js';
import { counterIds, FOG, GRIPHOIST, JACK, THERMAL, v1Fixture } from './fixtures.js';

let doc;
beforeEach(async () => { doc = (await migrateV1toV2(v1Fixture())).doc; });
const apply = (ops, d = doc) => applyOps(d, ops, { newId: counterIds() }).doc;
const fp = (d, c = 'LS1') => inventoryFingerprint(d, c);

describe('inventoryFingerprint', () => {
  test('64 hex chars, stable, independent of assignment ids and slot order', async () => {
    const a = await fp(doc);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const other = (await migrateV1toV2(v1Fixture())).doc; // different random assignment ids
    expect(await fp(other)).toBe(a);
    const reordered = structuredClone(doc);
    [reordered.allocations.LS1[0], reordered.allocations.LS1[7]] = ['', FOG];
    expect(await fp(reordered)).toBe(a);
  });
  test('rename keeps it (equipment ids are stable)', async () => {
    const before = await fp(doc, 'LS4');
    const renamed = apply([{ op: 'renameEquipment', from: THERMAL, to: 'Imager' }]);
    expect(await fp(renamed, 'LS4')).toBe(before);
  });
  test('adding, removing, reassigning and changing counts change it', async () => {
    const before = await fp(doc);
    const added = apply([{ op: 'setSlot', comp: 'LS1', index: 2, value: GRIPHOIST, expect: '' }]);
    const removed = apply([{ op: 'setSlot', comp: 'LS1', index: 1, value: '', expect: FOG }]);
    const swapped = apply([{ op: 'setSlot', comp: 'LS1', index: 1, value: JACK, expect: FOG }]);
    const prints = await Promise.all([before, fp(added), fp(removed), fp(swapped)].map(x => x));
    expect(new Set(prints).size).toBe(4);
  });
  test('changes in other compartments do not affect it', async () => {
    const before = await fp(doc);
    const other = apply([{ op: 'setSlot', comp: 'LS3', index: 0, value: GRIPHOIST, expect: '' }]);
    expect(await fp(other)).toBe(before);
  });
  test('empty and unknown compartments agree; works on v1 views and unknown names', async () => {
    expect(await fp(doc, 'CabRearZone')).toBe(await fp(doc, 'NOPE'));
    const v1ish = { allocations: { LS1: [FOG, 'Mystery', 'Mystery'] } };
    const a = await fp(v1ish);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await fp({ allocations: { LS1: ['Mystery', FOG, 'Mystery'] } })).toBe(a);
  });
});
