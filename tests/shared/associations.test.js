import { beforeEach, describe, expect, test } from 'vitest';
import { planAssociation, searchCandidates } from '../../shared/associations.js';
import { ID_PATTERN } from '../../shared/contracts.js';
import { newId } from '../../shared/ids.js';
import { applyOps, assignedCounts, migrateV1toV2, projectV1 } from '../../shared/planner.js';
import { counterIds, FOG, GRIPHOIST, JACK, THERMAL, VSTRUT, v1Fixture } from './fixtures.js';

let doc;
let ctx;
beforeEach(async () => {
  doc = (await migrateV1toV2(v1Fixture())).doc;
  ctx = { newId: counterIds() };
});
const names = rows => rows.map(r => r.name);

describe('searchCandidates', () => {
  test('case-insensitive token match; groups assigned / available / unavailable', () => {
    const g = searchCandidates(doc, 'LS1', 'FOG nozzle');
    expect(names(g.assigned)).toEqual([FOG]);
    expect(g.assigned[0]).toMatchObject({ assignedHere: 2, free: 2, qty: 5, assignmentIds: [doc.assignmentIds.LS1[0], doc.assignmentIds.LS1[1]] });
    expect(g.available.map(r => r.name)).toContain(FOG); // free 2 > 0
    expect(g.available.every(r => r.free > 0)).toBe(true);
  });
  test('unavailable = fully assigned elsewhere, with where', () => {
    const g = searchCandidates(doc, 'LS1', 'v-strut');
    expect(g.assigned).toEqual([]);
    expect(g.available).toEqual([]);
    expect(g.unavailable).toHaveLength(1);
    expect(g.unavailable[0]).toMatchObject({ name: VSTRUT, free: 0, assignedHere: 0, assignedElsewhere: [{ compId: 'RS3', count: 4 }] });
  });
  test('custom tools are searchable and listed as assigned in their compartment', () => {
    const g = searchCandidates(doc, 'LS4', 'thermal');
    expect(g.assigned[0]).toMatchObject({ name: THERMAL, assignedHere: 1, free: 0, assignedElsewhere: [{ compId: 'RS5', count: 1 }] });
    expect(g.unavailable).toEqual([]);
  });
  test('empty query lists everything; no match lists nothing; results sorted by name', () => {
    const all = searchCandidates(doc, 'LS3', '');
    expect(all.available.length).toBeGreaterThan(50);
    expect(names(all.available)).toEqual([...names(all.available)].sort((a, b) => a.localeCompare(b)));
    expect(searchCandidates(doc, 'LS3', 'zzzz')).toEqual({ assigned: [], available: [], unavailable: [] });
    expect(searchCandidates(doc, 'LS3', undefined).available.length).toBe(all.available.length);
  });
  test('removed items are not candidates', () => {
    expect(searchCandidates(doc, 'LS3', 'cellar').available).toEqual([]);
  });
});

describe('planAssociation', () => {
  test('group photo: 4 tools already assigned here → zero planner ops, links to the existing assignments', () => {
    const sel = [{ name: VSTRUT, quantity: 4 }];
    const r = planAssociation(doc, 'RS3', sel, ctx);
    expect(r.plannerOps).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.links).toHaveLength(4);
    expect(r.links.every(l => l.targetType === 'assignment' && l.quantity === 1)).toBe(true);
    expect(r.links.map(l => l.targetId)).toEqual(doc.assignmentIds.RS3.slice(0, 4));
  });
  test('"4 of 10": a photo of 4 already-assigned tools among a 10-tool inventory emits no ops', () => {
    const sel = [{ name: FOG, quantity: 2 }, { name: 'Holmatro V-Strut', quantity: 1 }, { name: THERMAL, quantity: 1 }];
    // FOG is assigned in LS1 (2), V-Strut in RS3, Thermal in LS4 → select them in the right compartments
    expect(planAssociation(doc, 'LS1', [sel[0]], ctx).plannerOps).toEqual([]);
    expect(planAssociation(doc, 'RS3', [sel[1]], ctx).plannerOps).toEqual([]);
    expect(planAssociation(doc, 'LS4', [sel[2]], ctx).plannerOps).toEqual([]);
  });
  test('assigns the remainder into the lowest empty slots with expect "" and links by equipment', () => {
    const r = planAssociation(doc, 'LS1', [{ name: FOG, quantity: 4 }], ctx);
    expect(r.links.filter(l => l.targetType === 'assignment')).toHaveLength(2);
    expect(r.plannerOps).toEqual([
      { op: 'setSlot', comp: 'LS1', index: 2, value: FOG, expect: '' },
      { op: 'setSlot', comp: 'LS1', index: 3, value: FOG, expect: '' },
    ]);
    const eqLink = r.links.find(l => l.targetType === 'equipment');
    expect(eqLink).toMatchObject({ targetId: doc.equipmentIds[FOG], equipmentId: doc.equipmentIds[FOG], quantity: 2, assignSlots: [2, 3] });
    const applied = applyOps(doc, r.plannerOps, ctx);
    expect(applied.conflicts).toEqual([]);
    expect(applied.doc.allocations.LS1.slice(0, 4)).toEqual([FOG, FOG, FOG, FOG]);
  });
  test('selection by equipmentId; unassigned item goes to empty slots', () => {
    const r = planAssociation(doc, 'LS3', [{ equipmentId: doc.equipmentIds[GRIPHOIST], quantity: 1 }], ctx);
    expect(r.plannerOps).toEqual([{ op: 'setSlot', comp: 'LS3', index: 0, value: GRIPHOIST, expect: '' }]);
    expect(r.links).toEqual([{ targetType: 'equipment', targetId: doc.equipmentIds[GRIPHOIST], equipmentId: doc.equipmentIds[GRIPHOIST], quantity: 1, assignSlots: [0] }]);
  });
  test('quantity overflow → QUANTITY error, nothing emitted for that selection', () => {
    const r = planAssociation(doc, 'LS3', [{ name: GRIPHOIST, quantity: 2 }, { name: JACK, quantity: 1 }], ctx);
    expect(r.errors).toEqual([{ index: 0, code: 'QUANTITY', message: expect.stringContaining('only 1') }]);
    expect(r.plannerOps).toEqual([{ op: 'setSlot', comp: 'LS3', index: 0, value: JACK, expect: '' }]);
    expect(r.links).toHaveLength(1);
  });
  test('item fully assigned elsewhere cannot be linked here (QUANTITY)', () => {
    const r = planAssociation(doc, 'LS3', [{ name: VSTRUT, quantity: 1 }], ctx);
    expect(r.errors[0].code).toBe('QUANTITY');
    expect(r.plannerOps).toEqual([]);
  });
  test('multiple selections share slots without collisions and track free inventory across selections', () => {
    const r = planAssociation(doc, 'LS3', [{ name: FOG, quantity: 2 }, { name: FOG, quantity: 2 }, { name: FOG, quantity: 1 }], ctx);
    // FOG: 5 qty, 3 already assigned elsewhere/here → 2 free in total
    expect(r.plannerOps.map(o => o.index)).toEqual([0, 1]);
    expect(r.errors.map(e => e.index)).toEqual([1, 2]);
    expect(assignedCounts(applyOps(doc, r.plannerOps, ctx).doc)[FOG]).toBe(5);
  });
  test('identical names: a second selection never re-links an assignment the first already linked', () => {
    const r = planAssociation(doc, 'LS1', [{ name: FOG, quantity: 1 }, { name: FOG, quantity: 1 }, { name: FOG, quantity: 1 }], ctx);
    const targets = r.links.filter(l => l.targetType === 'assignment').map(l => l.targetId);
    expect(new Set(targets).size).toBe(2);
    expect(r.plannerOps).toHaveLength(1);
    expect(r.links.find(l => l.targetType === 'equipment').assignSlots).toEqual([2]);
  });
  test('new tool: upsertCustomTool then setSlots; ids line up so links resolve after apply', () => {
    const r = planAssociation(doc, 'LS3', [{ quantity: 2, newTool: { name: ' Pry Bar ', qty: 3, dimensions: '30 in', description: 'steel bar' } }], ctx);
    expect(r.errors).toEqual([]);
    expect(r.plannerOps[0]).toMatchObject({ op: 'upsertCustomTool', tool: { name: 'Pry Bar', qty: 3, dimensions: '30 in', description: 'steel bar' } });
    expect(r.plannerOps.slice(1)).toEqual([
      { op: 'setSlot', comp: 'LS3', index: 0, value: 'Pry Bar', expect: '' },
      { op: 'setSlot', comp: 'LS3', index: 1, value: 'Pry Bar', expect: '' },
    ]);
    const eq = r.plannerOps[0].tool.equipmentId;
    expect(eq).toMatch(ID_PATTERN);
    expect(r.links).toEqual([{ targetType: 'equipment', targetId: eq, equipmentId: eq, quantity: 2, assignSlots: [0, 1] }]);
    const applied = applyOps(doc, r.plannerOps, ctx);
    expect(applied.conflicts).toEqual([]);
    expect(applied.doc.equipmentIds['Pry Bar']).toBe(eq);
    expect(projectV1(applied.doc).customTools.at(-1)).toEqual({ name: 'Pry Bar', qty: 3, dimensions: '30 in' });
  });
  test('new tool defaults qty to the selected quantity; duplicate names and bad input are errors', () => {
    expect(planAssociation(doc, 'LS3', [{ quantity: 2, newTool: { name: 'Gizmo' } }], ctx).plannerOps[0].tool.qty).toBe(2);
    const dup = planAssociation(doc, 'LS3', [{ quantity: 1, newTool: { name: JACK.toLowerCase() } }, { quantity: 1, newTool: { name: '  ' } },
      { quantity: 3, newTool: { name: 'Gizmo', qty: 1 } }], ctx);
    expect(dup.errors.map(e => e.code)).toEqual(['INVALID', 'INVALID', 'QUANTITY']);
    expect(dup.plannerOps).toEqual([]);
  });
  test('invalid quantity / unknown equipment / unknown compartment / not enough empty slots', () => {
    const r = planAssociation(doc, 'LS3', [{ name: JACK, quantity: 0 }, { name: JACK, quantity: 1.5 }, { name: 'Ghost', quantity: 1 }, { equipmentId: 'eq_nope', quantity: 1 }], ctx);
    expect(r.errors.map(e => e.code)).toEqual(['INVALID', 'INVALID', 'NOT_FOUND', 'NOT_FOUND']);
    expect(planAssociation(doc, 'NOPE', [{ name: JACK, quantity: 1 }], ctx).errors[0].code).toBe('NOT_FOUND');
    const full = structuredClone(doc);
    full.allocations.LS3 = Array(15).fill(THERMAL).map((_, i) => (i < 14 ? 'x' : ''));
    const noSlots = planAssociation(full, 'LS3', [{ name: FOG, quantity: 2 }], ctx);
    expect(noSlots.errors).toEqual([{ index: 0, code: 'NO_SLOTS', message: expect.any(String) }]);
  });
  test('non-array selections work without ctx; new tools need ctx.newId', () => {
    expect(planAssociation(doc, 'LS3', undefined)).toEqual({ links: [], plannerOps: [], errors: [] });
    expect(() => planAssociation(doc, 'LS3', [{ quantity: 1, newTool: { name: 'Thing' } }])).toThrow(/ctx\.newId .* is required/);
    const r = planAssociation(doc, 'LS3', [{ quantity: 1, newTool: { name: 'Thing' } }], { newId });
    expect(r.plannerOps[0].tool.equipmentId).toMatch(ID_PATTERN);
  });
});
