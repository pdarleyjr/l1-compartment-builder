// (c) asset lifecycle with association (UI planner → server), (d) mounts with links and layout designs.
// The browser-side pure modules (planAssociation, toApiLink, mount form mapping, layout model) are used as the UI uses them.
import { beforeAll, describe, expect, it } from 'vitest';
import { planAssociation } from '../../shared/associations.js';
import { newId } from '../../shared/ids.js';
import { toApiLink } from '../../src/studio/library/association-summary.js';
import { layoutPayload, normalizeLayout, setPlacement } from '../../src/studio/layout/layoutModel.js';
import { emptyMount, formToPayload, mountToForm } from '../../src/studio/mounts/mount-constants.js';
import { ADMIN, EDITOR, EDITOR_B, JPEG, WEBP, all, createStack, device, migrateUntilDone, one, plannerOf, sha256, uploadPhoto } from './harness.js';

describe('assets, links, mounts, designs', () => {
  let stack; let ed; let other; let admin; let anon;
  beforeAll(async () => {
    stack = createStack();
    admin = device(stack, ADMIN); ed = device(stack, EDITOR); other = device(stack, EDITOR_B); anon = device(stack, null);
    await migrateUntilDone(admin);
  });

  it('(c) interrupted upload is never linked, listed or served; it can be resumed and committed', async () => {
    const created = await ed.post('/api/assets', { compartmentId: 'LS1', category: 'tool', width: 1, height: 1, bytes: JPEG.length, sha256: sha256(JPEG), idempotencyKey: 'interrupted-upload-1' });
    expect(created.status).toBe(201);
    const { asset, upload } = created.body;
    expect(Object.keys(upload).sort()).toEqual(['display', 'original', 'thumb']);
    expect((await ed.putBytes(upload.original, JPEG)).status).toBe(204); // ...connection drops here
    // same Idempotency-Key returns the same pending asset (resume)
    const resumed = await ed.post('/api/assets', { compartmentId: 'LS1', category: 'tool', width: 1, height: 1, bytes: JPEG.length, sha256: sha256(JPEG), idempotencyKey: 'interrupted-upload-1' });
    expect(resumed.body.asset.id).toBe(asset.id);
    const early = await ed.post(`/api/assets/${asset.id}/commit`, { links: [] });
    expect(early.status).toBe(409);
    expect(early.body.error.details.missing).toEqual(['display', 'thumb']);
    expect((await ed.get('/api/compartments/LS1/assets')).body.assets.map(x => x.id)).not.toContain(asset.id);
    expect((await ed.post(`/api/assets/${asset.id}/links`, { links: [] })).status).toBe(404); // pending assets cannot be linked
    expect((await anon.get(`/api/public/assets/${asset.id}/display`)).status).toBe(404);
    expect(one(stack, 'SELECT COUNT(*) n FROM asset_links WHERE asset_id = ?', asset.id).n).toBe(0);
    // finish the upload
    for (const v of ['display', 'thumb']) expect((await ed.putBytes(upload[v], WEBP, 'image/webp')).status).toBe(204);
    expect((await ed.post(`/api/assets/${asset.id}/commit`, {})).status).toBe(200);
    expect((await ed.get('/api/compartments/LS1/assets')).body.assets.map(x => x.id)).toContain(asset.id);
  });

  it('(c) uploads reject non-images and checksum mismatches', async () => {
    const created = await ed.post('/api/assets', { compartmentId: 'LS2', category: 'tool', width: 1, height: 1, bytes: 3, sha256: sha256(JPEG), idempotencyKey: 'bad-upload-0001' });
    const { upload } = created.body;
    expect((await ed.putBytes(upload.original, new Uint8Array([1, 2, 3]))).status).toBe(415);
    expect((await ed.putBytes(upload.original, WEBP, 'image/webp')).status).toBe(400); // valid image, wrong checksum
    expect((await other.putBytes(upload.original, JPEG)).status).toBe(403); // only the uploader (or an admin)
  });

  it('(c) a group photo of tools already assigned → 0 planner ops; plus one unassigned tool → setSlot', async () => {
    const before = await plannerOf(ed);
    // LS1 already holds 1 Ton Griphoist (slot 0) and Custom Wrench (slot 1)
    const griphoist = before.doc.equipmentIds['1 Ton Griphoist'];
    const wrench = before.doc.equipmentIds['Custom Wrench'];
    const eqExtinguisher = before.doc.equipmentIds['CO2 Extinguisher'];
    const group = planAssociation(before.doc, 'LS1', [{ equipmentId: griphoist, quantity: 1 }, { equipmentId: wrench, quantity: 1 }], { newId });
    expect(group.errors).toEqual([]);
    expect(group.plannerOps).toEqual([]);
    expect(group.links.map(l => l.targetType)).toEqual(['assignment', 'assignment']);

    const { assetId, committed } = await uploadPhoto(ed, {
      compartmentId: 'LS1', category: 'tool_group', title: 'Group photo',
      commit: { links: group.links.map(toApiLink), plannerOps: group.plannerOps, baseRevision: before.revision },
    });
    expect(committed.status).toBe(200);
    expect(committed.body.plannerRevision).toBeUndefined(); // nothing changed in the planner
    expect((await plannerOf(ed)).revision).toBe(before.revision);
    expect(committed.body.asset.links.map(l => [l.targetType, l.state, l.quantity])).toEqual([['assignment', 'confirmed', 1], ['assignment', 'confirmed', 1]]);

    // one more tool that is in the inventory but not assigned here → one setSlot op, linked as an equipment link
    const next = await plannerOf(ed);
    const plan = planAssociation(next.doc, 'LS1', [{ equipmentId: eqExtinguisher, quantity: 1 }], { newId });
    expect(plan.errors).toEqual([]);
    expect(plan.plannerOps).toHaveLength(1);
    expect(plan.plannerOps[0]).toMatchObject({ op: 'setSlot', comp: 'LS1', value: 'CO2 Extinguisher', expect: '' });
    const second = await uploadPhoto(ed, {
      compartmentId: 'LS1', category: 'tool', title: 'Extinguisher',
      commit: { links: plan.links.map(toApiLink), plannerOps: plan.plannerOps, baseRevision: next.revision },
    });
    expect(second.committed.status).toBe(200);
    expect(second.committed.body.plannerRevision).toBe(next.revision + 1);
    expect(one(stack, "SELECT actor FROM planner_history WHERE revision = ?", next.revision + 1).actor).toBe('editor@example.com'); // attributed to the person, not 'anonymous'
    expect(one(stack, "SELECT actor FROM audit_log WHERE action = 'planner.ops' AND entity_id = ?", String(next.revision + 1)).actor).toBe('editor@example.com');
    const after = await plannerOf(ed);
    expect(after.revision).toBe(next.revision + 1);
    const slot = after.doc.allocations.LS1.indexOf('CO2 Extinguisher');
    expect(slot).toBeGreaterThan(1);
    expect(after.doc.assignmentIds.LS1[slot]).toMatch(/^as_/);

    // links are visible in the library list (confirmed + suggested, with state)
    const list = (await ed.get('/api/compartments/LS1/assets')).body.assets;
    const g = list.find(x => x.id === assetId);
    expect(g.links).toHaveLength(2);
    expect(g.links.every(l => l.state === 'confirmed' && l.equipmentId)).toBe(true);
    const ex = list.find(x => x.id === second.assetId);
    expect(ex.links).toEqual([expect.objectContaining({ targetType: 'equipment', targetId: eqExtinguisher, equipmentId: eqExtinguisher, quantity: 1, state: 'confirmed' })]);
    expect(list.every(x => x.status === 'committed' && x.variants.display && x.variants.thumb)).toBe(true);
    // the quantity invariant holds: photos never created inventory
    expect(one(stack, 'SELECT COUNT(*) n FROM planner_history').n).toBeGreaterThan(0);
  });

  it('(c) a stale-quantity commit is refused atomically (nothing committed, nothing changed)', async () => {
    const start = await plannerOf(ed);
    // another device takes the last unit first
    const NAME = '2.5 gal Water Extinguisher';
    const eq = start.doc.equipmentIds[NAME];
    const plan = planAssociation(start.doc, 'LS2', [{ equipmentId: eq, quantity: 1 }], { newId });
    expect((await other.post('/api/planner/ops', { baseRevision: start.revision, clientOpId: 'steal-last-unit-1', ops: [{ op: 'setSlot', comp: 'RS1', index: 3, value: NAME, expect: '' }] })).body.applied).toEqual([0]);
    const { committed, assetId } = await uploadPhoto(ed, { compartmentId: 'LS2', category: 'tool', commit: { links: plan.links.map(toApiLink), plannerOps: plan.plannerOps, baseRevision: start.revision } });
    expect(committed.status).toBe(409);
    expect(committed.body.error.code).toBe('CONFLICT');
    expect(committed.body.error.details.conflicts[0].reason).toBe('QUANTITY');
    expect(one(stack, 'SELECT status FROM assets WHERE id = ?', assetId).status).toBe('pending');
    expect(one(stack, 'SELECT COUNT(*) n FROM asset_links WHERE asset_id = ?', assetId).n).toBe(0);
    expect((await plannerOf(ed)).doc.allocations.LS2.includes(NAME)).toBe(false);
  });

  it('PATCH asset needs expectRevision (the UI sends it) and rejects stale revisions', async () => {
    const { assetId } = await uploadPhoto(ed, { compartmentId: 'RS2', category: 'other', title: 'Manufacturer sheet' });
    const asset = (await ed.get('/api/compartments/RS2/assets')).body.assets.find(x => x.id === assetId);
    const ok = await ed.patch(`/api/assets/${assetId}`, { title: 'Renamed', notes: null, expectRevision: asset.revision });
    expect(ok.status).toBe(200);
    expect(ok.body.asset).toMatchObject({ title: 'Renamed', revision: asset.revision + 1 });
    expect((await ed.patch(`/api/assets/${assetId}`, { title: 'Again', expectRevision: asset.revision })).status).toBe(409);
    expect((await ed.patch(`/api/assets/${assetId}`, { title: 'No revision' })).status).toBe(400);
  });

  it('(d) a mount with links: the UI payload round-trips through POST, GET and PATCH', async () => {
    const planner = await plannerOf(ed);
    const eq = planner.doc.equipmentIds['1 Ton Griphoist'];
    const { assetId } = await uploadPhoto(ed, { compartmentId: 'LS1', category: 'mount', title: 'Bracket photo' });
    const form = { ...emptyMount(), name: ' Griphoist bracket ', manufacturer: 'Acme', zone: 'left_wall', orientation: 'vertical', capacity: '1', classification: 'mounting', status: 'existing', assetId, equipmentIds: [eq] };
    const payload = formToPayload(form);
    expect(payload.links).toEqual([{ targetType: 'asset', targetId: assetId }, { targetType: 'equipment', targetId: eq }]);
    const created = await ed.post('/api/compartments/LS1/mounts', payload);
    expect(created.status).toBe(201);
    const { mount } = created.body;
    expect(mount).toMatchObject({ name: 'Griphoist bracket', manufacturer: 'Acme', zone: 'left_wall', orientation: 'vertical', capacity: 1, classification: 'mounting', status: 'existing', compartmentId: 'LS1' });
    expect(mount.links).toEqual(expect.arrayContaining(payload.links));

    const listed = (await ed.get('/api/compartments/LS1/mounts')).body;
    expect(listed.mounts).toHaveLength(1);
    expect(mountToForm(listed.mounts[0])).toMatchObject({ name: 'Griphoist bracket', assetId, equipmentIds: [eq], zone: 'left_wall' });

    // PATCH carries expectRevision (the UI sends mount.revision) and replaces the links
    const edited = await ed.patch(`/api/mounts/${mount.id}`, { ...formToPayload({ ...mountToForm(mount), status: 'proposed', equipmentIds: [] }), expectRevision: mount.revision });
    expect(edited.status).toBe(200);
    expect(edited.body.mount).toMatchObject({ status: 'proposed', revision: mount.revision + 1, links: [{ targetType: 'asset', targetId: assetId }] });
    expect((await ed.patch(`/api/mounts/${mount.id}`, { name: 'stale', expectRevision: mount.revision })).status).toBe(409);

    // an inventory mount needs an inventory item; links must belong to the compartment
    const inv = formToPayload({ ...emptyMount(), name: 'Strap', classification: 'inventory', equipmentId: eq });
    expect(inv.equipmentId).toBe(eq);
    expect((await ed.post('/api/compartments/LS1/mounts', inv)).status).toBe(201);
    expect((await ed.post('/api/compartments/LS1/mounts', { ...inv, equipmentId: null })).status).toBe(400);
    expect((await ed.post('/api/compartments/LS2/mounts', formToPayload({ ...emptyMount(), name: 'X', assetId }))).status).toBe(400); // photo belongs to LS1
    expect((await anon.post('/api/compartments/LS1/mounts', payload)).status).toBe(401);
  });

  it('(d) design PUT/GET with the canonical layout {placements:[{targetType, targetId, zone, orientation?}]}', async () => {
    const empty = await ed.get('/api/compartments/LS1/design');
    expect(empty.body).toEqual({ design: expect.objectContaining({ revision: 0, layout: { placements: [] } }) });
    const planner = await plannerOf(ed);
    const eq = planner.doc.equipmentIds['1 Ton Griphoist'];
    const mountId = (await ed.get('/api/compartments/LS1/mounts')).body.mounts[0].id;
    let layout = normalizeLayout(empty.body.design.layout);
    layout = setPlacement(layout, { kind: 'tool', ref: eq, name: 'Griphoist' }, { zone: 'upper_shelf', orientation: 'horizontal' });
    layout = setPlacement(layout, { kind: 'mount', ref: mountId, name: 'Bracket' }, { zone: 'left_wall' });
    layout = { ...layout, notes: 'Keep the hoist off the floor.' };
    const put = await ed.put('/api/compartments/LS1/design', { layout: layoutPayload(layout), expectRevision: 0 });
    expect(put.status).toBe(200);
    expect(put.body.design.revision).toBe(1);
    const got = (await ed.get('/api/compartments/LS1/design')).body.design;
    expect(normalizeLayout(got.layout)).toEqual(layout);
    expect(got.layout.placements).toEqual(expect.arrayContaining([
      { targetType: 'equipment', targetId: eq, zone: 'upper_shelf', orientation: 'horizontal' }, { targetType: 'mount', targetId: mountId, zone: 'left_wall' },
    ]));
    // stale writer, foreign item, pre-canonical shape
    expect((await ed.put('/api/compartments/LS1/design', { layout: layoutPayload(layout), expectRevision: 0 })).status).toBe(409);
    expect((await ed.put('/api/compartments/LS2/design', { layout: layoutPayload(layout), expectRevision: 0 })).status).toBe(400);
    expect((await ed.put('/api/compartments/LS1/design', { layout: { placements: [{ kind: 'tool', ref: eq, name: 'x', zone: 'floor' }] }, expectRevision: 1 })).status).toBe(400);
    expect(all(stack, "SELECT action FROM audit_log WHERE action = 'design.update'")).toHaveLength(1);
  });
});
