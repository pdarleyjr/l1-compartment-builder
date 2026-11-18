import { describe, expect, it } from 'vitest';
import { COMPARTMENT_IDS } from '../../shared/contracts.js';
import { COMPARTMENTS, COMP_LABEL, SLOTS_PER_COMPARTMENT } from '../../shared/apparatus.js';
import { buildSnapshot } from '../../src/lib/export/snapshot.js';
import { buildManifest, verifyManifest } from '../../src/lib/export/manifest.js';
import { legacyRows, buildWorkbookSheets } from '../../src/lib/export/workbook.js';
import { manifestFilename, mergeViewWithDoc, workbookFilename } from '../../src/lib/export/files.js';
import { A, B, C, FIXED, baseDoc, emptyAlloc } from './helpers.js';

const make = (docOver, fixed = {}) => {
  const snapshot = buildSnapshot({ doc: baseDoc(docOver), ...FIXED, ...fixed });
  return { snapshot, manifest: buildManifest(snapshot) };
};
const comp = (m, id) => m.compartments.find(c => c.id === id);

describe('manifest structure', () => {
  it('has all 11 compartments in order, including empty ones with an exception', () => {
    const { manifest: m } = make({});
    expect(m.schema).toBe('l1.checklist-transfer/1');
    expect(m.compartments.map(c => c.id)).toEqual([...COMPARTMENT_IDS]);
    expect(m.compartments.map(c => c.order)).toEqual([...COMPARTMENT_IDS.keys()]);
    expect(m.compartments.every(c => c.items.length === 0)).toBe(true);
    expect(m.exceptions.filter(e => e.type === 'empty_compartment')).toHaveLength(11);
    expect(m.totals).toMatchObject({ compartments: 11, lines: 0, units: 0, unassignedCatalogItems: m.totals.catalogItems });
    expect(m.source).toMatchObject({ app: 'l1-compartment-builder', plannerRevision: 13, syncState: 'confirmed', pendingChanges: 0 });
    expect(m.apparatus).toEqual({ planId: 'l1-mid-mount', label: 'L1 Mid-Mount' });
    expect(verifyManifest(m)).toEqual({ ok: true, errors: [] });
  });

  it('groups repeated items per compartment; no compartment is protected; RS3 lines equal its slots', () => {
    const allocations = emptyAlloc();
    allocations.LS1[0] = A; allocations.LS1[3] = B; allocations.LS1[5] = A;
    allocations.RS3[0] = A; allocations.RS3[1] = B; allocations.RS3[2] = B;
    const { manifest: m } = make({
      allocations, assignmentIds: { LS1: ['as_1', '', 'x', 'as_4', '', 'as_6'] },
    });
    const ls1 = comp(m, 'LS1');
    expect(ls1.items.map(l => [l.name, l.quantity, l.slots])).toEqual([[A, 2, [0, 5]], [B, 1, [3]]]);
    expect(ls1.items[0].assignmentIds).toEqual(['as_1', 'as_6']);
    expect(ls1.items[0].lineKey).toBe(`LS1:${ls1.items[0].equipmentId}`);
    expect(ls1.side).toBe('Left');
    const rs3 = comp(m, 'RS3');
    expect(rs3.protected).toBe(false);
    expect(m.compartments.filter(c => c.protected)).toEqual([]);
    expect(rs3.items.map(l => [l.name, l.slots])).toEqual([[A, [0]], [B, [1, 2]]]);
    expect(rs3.items.reduce((n, l) => n + l.quantity, 0)).toBe(3);
    expect(m.totals.lines).toBe(4);
    expect(m.totals.units).toBe(6);
    expect(m.catalog.find(i => i.name === A).compartments).toEqual({ LS1: 2, RS3: 1 });
  });

  it('reports a bundle on each member line and null otherwise', () => {
    const allocations = emptyAlloc();
    allocations.LS2[0] = A; allocations.LS2[1] = B; allocations.LS2[2] = C;
    const { manifest: m } = make({ allocations, bundles: { LS2: [{ id: 'b_1', name: 'Kit', colorIdx: 0, slotIndices: [0, 1] }] } });
    expect(comp(m, 'LS2').items.map(l => l.bundle)).toEqual([{ id: 'b_1', name: 'Kit' }, { id: 'b_1', name: 'Kit' }, null]);
  });

  it('handles custom tools, removed items and over-allocation', () => {
    const allocations = emptyAlloc();
    allocations.LS1[0] = 'Custom Saw'; allocations.LS1[1] = 'Custom Saw';
    allocations.LS3[0] = B;
    allocations.LS4[0] = A; allocations.LS4[1] = A;
    const { manifest: m } = make({
      allocations, customTools: [{ name: 'Custom Saw', qty: 1, dimensions: '1 × 2' }], customQtys: { [A]: 1 }, removedItems: [B],
    });
    const saw = m.catalog.find(i => i.name === 'Custom Saw');
    expect(saw).toMatchObject({ custom: true, quantity: 1, assigned: 2, remaining: -1, dimensions: '1 × 2' });
    expect(m.catalog.some(i => i.name === B)).toBe(false);
    expect(comp(m, 'LS3').items[0].name).toBe(B); // tolerated
    const over = m.exceptions.filter(e => e.type === 'over_allocated');
    expect(over.map(e => e.equipmentId).sort()).toEqual([saw.equipmentId, m.catalog.find(i => i.name === A).equipmentId, comp(m, 'LS3').items[0].equipmentId].sort());
    expect(verifyManifest(m).ok).toBe(true);
  });

  it('turns unverified items into needs_verification lines and exceptions; notes appear or are null', () => {
    const allocations = emptyAlloc();
    allocations.LS1[0] = A; allocations.RS1[0] = B;
    const { manifest: m } = make({
      allocations, unverified: { [A]: 'size unknown', Unplaced: '' },
      notes: { LS1: { text: 'Door sticks', updatedAt: 1763478245000 } },
    });
    expect(comp(m, 'LS1').items[0].verification).toEqual({ status: 'needs_verification', reason: 'size unknown' });
    expect(comp(m, 'RS1').items[0].verification).toEqual({ status: 'verified', reason: '' });
    expect(m.exceptions.filter(e => e.type === 'needs_verification')).toHaveLength(1);
    expect(m.totals.needsVerification).toBe(1);
    expect(comp(m, 'LS1').note).toEqual({ text: 'Door sticks', updatedAt: 1763478245000 });
    expect(comp(m, 'LS2').note).toBeNull();
    expect(make({}).manifest.compartments.every(c => c.note === null)).toBe(true);
  });

  it('copes with a 500-slot compartment', () => {
    const allocations = emptyAlloc();
    allocations.LS1 = Array.from({ length: 500 }, (_, i) => (i % 2 ? A : B));
    const { manifest: m, snapshot } = make({ allocations });
    expect(comp(m, 'LS1').items.map(l => l.quantity)).toEqual([250, 250]);
    expect(m.totals.units).toBe(500);
    expect(snapshot.compartments[1].totalSlots).toBe(500);
    expect(verifyManifest(m).ok).toBe(true);
  });

  it('keeps Unicode, quotes and emoji names exactly', () => {
    const name = '  "Rescue" tool — Ünïcode 🧯 \'x\' ';
    const allocations = emptyAlloc();
    allocations.LS1[0] = name;
    const { manifest: m } = make({ allocations, customTools: [{ name, qty: 1 }] });
    expect(comp(m, 'LS1').items[0].name).toBe(name);
    expect(JSON.parse(JSON.stringify(m)).compartments[1].items[0].name).toBe(name);
  });
});

describe('determinism and verification', () => {
  it('same input gives the same hash regardless of key order; exportedAt is excluded', () => {
    const allocations = emptyAlloc();
    allocations.LS1[0] = A;
    const reordered = { bundles: {}, removedItems: [], customDimensions: {}, customTools: [], customQtys: {}, allocations: Object.fromEntries(Object.entries(allocations).reverse()) };
    const m1 = make({ allocations }).manifest;
    const m2 = buildManifest(buildSnapshot({ doc: reordered, ...FIXED, exportedAt: '2030-01-01T00:00:00.000Z' }));
    expect(m1.source.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m2.source.snapshotSha256).toBe(m1.source.snapshotSha256);
    expect(m2.source.exportedAt).not.toBe(m1.source.exportedAt);
    expect(make({ allocations }, { revision: 14 }).manifest.source.snapshotSha256).not.toBe(m1.source.snapshotSha256);
  });

  it('snapshot and manifest are deeply frozen', () => {
    const { snapshot, manifest } = make({});
    expect(Object.isFrozen(snapshot.compartments[0].slots)).toBe(true);
    expect(Object.isFrozen(manifest.compartments[0].items)).toBe(true);
  });

  it('verifyManifest catches tampering, wrong schema and bad structure', () => {
    const allocations = emptyAlloc();
    allocations.LS1[0] = A; allocations.LS1[1] = A;
    const m = JSON.parse(JSON.stringify(make({ allocations }).manifest));
    const tampered = structuredClone(m);
    tampered.compartments[1].items[0].quantity = 5;
    const r = verifyManifest(tampered);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/snapshotSha256/);
    expect(r.errors.join('\n')).toMatch(/slot count/);
    expect(verifyManifest({ ...m, schema: 'x/2' }).ok).toBe(false);
    const fewer = structuredClone(m); fewer.compartments.pop();
    expect(verifyManifest(fewer).ok).toBe(false);
    expect(verifyManifest(null).ok).toBe(false);
    expect(verifyManifest({ schema: m.schema }).ok).toBe(false);
    const totals = structuredClone(m); totals.totals.units = 99;
    expect(verifyManifest(totals).errors.join()).toMatch(/totals.units/);
    const cat = structuredClone(m); cat.catalog.find(i => i.name === A).assigned = 1;
    expect(verifyManifest(cat).errors.join()).toMatch(/assigned/);
  });
});

describe('helpers', () => {
  it('names files with date and revision', () => {
    expect(workbookFilename(7, '2026-11-18')).toBe('L1 Mid-Mount - Compartment Plan - 2026-11-18 - rev7.xlsx');
    expect(manifestFilename(7, '2026-11-18')).toBe('L1 Mid-Mount - Checklist Transfer - 2026-11-18 - rev7.json');
    expect(workbookFilename(1)).toMatch(/ - \d{4}-\d{2}-\d{2} - rev1\.xlsx$/);
  });

  it('mergeViewWithDoc keeps assignment ids only where the slot is unchanged', () => {
    const doc = { equipmentIds: { [A]: 'eq_a' }, allocations: { LS1: [A, B] }, assignmentIds: { LS1: ['as_1', 'as_2'] }, notes: { LS1: { text: 'n', updatedAt: 1 } }, unverified: { [A]: '' } };
    const view = { allocations: { LS1: [A, C, A] } };
    const merged = mergeViewWithDoc(view, doc);
    expect(merged.assignmentIds.LS1).toEqual(['as_1', null, null]);
    expect(merged.equipmentIds[A]).toBe('eq_a');
    expect(merged.notes.LS1.text).toBe('n');
    expect(mergeViewWithDoc(view, null).notes).toEqual({});
  });
});

describe('legacy sheets golden', () => {
  // The pre-manifest export logic (src/components/exportExcel.js before this change), with usePlan inlined.
  async function oldRows(allocations, plan) {
    const { effectiveInventory, effectiveDimensions, getQty, placedStats } = plan;
    const compHeaders = ['Slot', ...COMPARTMENTS.map(c => c.label ?? c.id)];
    const compRows = [];
    const maxSlots = Math.max(SLOTS_PER_COMPARTMENT, ...COMPARTMENTS.map(c => (allocations[c.id] ?? []).length));
    for (let i = 0; i < maxSlots; i++) compRows.push([i + 1, ...COMPARTMENTS.map(c => (allocations[c.id] ?? [])[i] || '')]);
    const invHeaders = ['Equipment Item', 'Total Qty', 'Placed', 'Remaining', 'Assigned To', 'Dimensions', 'Status'];
    const invRows = effectiveInventory.map(item => {
      const stats = placedStats[item.name];
      const qty = getQty(item.name);
      const placed = stats?.total ?? 0;
      const remaining = qty - placed;
      const assignedTo = Object.entries(stats?.byComp ?? {}).map(([c, cnt]) => cnt > 1 ? `${COMP_LABEL[c] ?? c} x${cnt}` : (COMP_LABEL[c] ?? c)).join(', ');
      const status = placed > qty ? 'Over' : remaining === 0 ? 'Complete' : placed > 0 ? 'Partial' : 'Pending';
      return [item.name, qty, placed, remaining, assignedTo || '', effectiveDimensions[item.name] || '', status];
    });
    return { compHeaders, compRows, invHeaders, invRows };
  }
  // usePlan's derivations without React.
  async function planOf(view) {
    const { DIMENSIONS, INVENTORY_BY_NAME, MASTER_INVENTORY } = await import('../../shared/apparatus.js');
    const { allocations, customQtys, customTools, removedItems, customDimensions } = view;
    const effectiveInventory = [...MASTER_INVENTORY.filter(i => !removedItems.includes(i.name)), ...customTools];
    const effectiveDimensions = { ...DIMENSIONS, ...customDimensions };
    customTools.forEach(t => { if (t.dimensions) effectiveDimensions[t.name] = t.dimensions; });
    const getQty = name => customQtys[name] !== undefined ? customQtys[name] : (customTools.find(t => t.name === name)?.qty ?? INVENTORY_BY_NAME[name]?.qty ?? 0);
    const placedStats = {};
    effectiveInventory.forEach(i => { placedStats[i.name] = { total: 0, byComp: {} }; });
    COMPARTMENTS.forEach(c => allocations[c.id].forEach(s => {
      if (s && placedStats[s]) { placedStats[s].total += 1; placedStats[s].byComp[c.id] = (placedStats[s].byComp[c.id] ?? 0) + 1; }
    }));
    return { effectiveInventory, effectiveDimensions, getQty, placedStats };
  }

  it('matches the old rows for a mixed plan', async () => {
    const allocations = emptyAlloc();
    allocations.LS1[0] = A; allocations.LS1[1] = A; allocations.RS2[4] = B; allocations.RR1[0] = 'Custom Saw'; allocations.LS3[2] = C;
    allocations.CabRearZone = Array(20).fill('').map((_, i) => (i === 19 ? A : ''));
    const view = baseDoc({
      allocations, customQtys: { [A]: 1 }, customTools: [{ name: 'Custom Saw', qty: 2, dimensions: '3 × 3' }],
      removedItems: [C], customDimensions: { [B]: 'tiny' },
    });
    const old = await oldRows(view.allocations, await planOf(view));
    const rows = legacyRows(buildSnapshot({ doc: view, ...FIXED }));
    expect(rows).toEqual(old);
    const sheets = buildWorkbookSheets(buildSnapshot({ doc: view, ...FIXED }), buildManifest(buildSnapshot({ doc: view, ...FIXED })));
    const values = name => sheets.find(s => s.sheet === name).data.map(r => r.map(c => c.value));
    expect(values('Compartments')).toEqual([old.compHeaders, ...old.compRows]);
    expect(values('Inventory Status')).toEqual([old.invHeaders, ...old.invRows]);
    expect(sheets.map(s => s.sheet)).toEqual(['Compartment Inventory', 'Equipment Catalog', 'Compartment Summary', 'Bundles and Kits', 'Notes and Exceptions', 'Export Metadata', 'Compartments', 'Inventory Status']);
  });
});

describe('RS3-like double bundles', () => {
  const rs3Doc = () => {
    const allocations = emptyAlloc();
    [A, B, C, A, B, C].forEach((n, i) => { allocations.RS3[i] = n; });
    // two bundles holding the same item types; slot 5 is listed by both (last wins for the single-bundle `bundle`)
    return {
      allocations,
      bundles: { RS3: [
        { id: 'b_one', name: 'Highrise Pack', colorIdx: 0, slotIndices: [0, 1, 2] },
        { id: 'b_two', name: 'Highrise Pack 2', colorIdx: 1, slotIndices: [3, 4, 5] },
      ] },
    };
  };

  it('lists every bundle of a line in `bundles`, keeps `bundle` = first slot, totals unchanged', () => {
    const { manifest: m } = make(rs3Doc());
    const rs3 = comp(m, 'RS3');
    expect(rs3.items).toHaveLength(3);
    expect(new Set(rs3.items.map(l => l.lineKey)).size).toBe(3);
    const a = rs3.items.find(l => l.name === A);
    expect(a.quantity).toBe(2);
    expect(a.bundle).toEqual({ id: 'b_one', name: 'Highrise Pack' });
    expect(a.bundles).toEqual([{ id: 'b_one', name: 'Highrise Pack', slots: [0] }, { id: 'b_two', name: 'Highrise Pack 2', slots: [3] }]);
    expect(m.totals).toMatchObject({ lines: 3, units: 6 });
    expect(m.catalog.find(i => i.name === A).compartments).toEqual({ RS3: 2 });
    expect(verifyManifest(m)).toEqual({ ok: true, errors: [] });
  });

  it('uses [] when a line has no bundle', () => {
    const allocations = emptyAlloc();
    allocations.LS1[0] = A;
    const { manifest: m } = make({ allocations });
    expect(comp(m, 'LS1').items[0].bundles).toEqual([]);
  });

  it('verifyManifest sums quantities per compartment', () => {
    const { manifest: m } = make(rs3Doc());
    const copy = structuredClone(m);
    copy.source.snapshotSha256 = '';
    const line = copy.compartments.find(c => c.id === 'RS3').items[0];
    expect(line.quantity).toBe(2);
    expect(verifyManifest(m).ok).toBe(true);
  });

  it('workbook shows both bundles in the inventory and one Bundles row per member slot', () => {
    const { snapshot, manifest } = make(rs3Doc());
    const sheets = buildWorkbookSheets(snapshot, manifest);
    const rows = name => sheets.find(s => s.sheet === name).data.map(r => r.map(c => c.value));
    const inv = rows('Compartment Inventory');
    const aRow = inv.find(r => r[2] === 'RS3' && r[4] === A);
    expect(aRow[8]).toBe('Highrise Pack (1); Highrise Pack 2 (4)');
    const bundleRows = rows('Bundles and Kits').slice(1).filter(r => r[1] === COMP_LABEL.RS3);
    expect(bundleRows.filter(r => r[2] === 'Highrise Pack')).toHaveLength(3);
    expect(bundleRows.filter(r => r[2] === 'Highrise Pack 2')).toHaveLength(3);
  });
});

describe('custom tool descriptions', () => {
  it('flow into the manifest line and catalog', () => {
    const allocations = emptyAlloc();
    allocations.LS1[0] = 'Zed Tool';
    const { manifest: m } = make({ allocations, customTools: [{ name: 'Zed Tool', qty: 1, dimensions: '1 in', description: 'A zed tool' }] });
    expect(comp(m, 'LS1').items[0]).toMatchObject({ custom: true, description: 'A zed tool' });
    expect(m.catalog.find(i => i.name === 'Zed Tool').description).toBe('A zed tool');
  });
});
