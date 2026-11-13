import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as links from '../../src/links.js';
import * as mounts from '../../src/mounts.js';
import * as designs from '../../src/designs.js';
import { EQ, call, insertAsset, jsonOf, makeEnv, setSetting, editor } from './helpers/harness.js';
import { resetIds } from './helpers/fakes.js';

vi.mock('../../../shared/ids.js', async () => (await import('./helpers/fakes.js')).idsFake);
vi.mock('../../../shared/planner.js', async () => (await import('./helpers/fakes.js')).plannerSharedFake);
vi.mock('../../../shared/apparatus-render.js', async () => (await import('./helpers/fakes.js')).apparatusRenderFake);
vi.mock('../../../shared/validation.js', async () => (await import('./helpers/fakes.js')).validationFake);
vi.mock('../../src/settings.js', async () => (await import('./helpers/fakes.js')).settingsFake());
vi.mock('../../src/planner.js', async () => (await import('./helpers/fakes.js')).plannerModuleFake);

let t;
beforeEach(() => { resetIds(); t = makeEnv(); insertAsset(t, 'ast_a', 'LS1'); insertAsset(t, 'ast_b', 'LS2'); });

const put = (assetId, body, o) => call(links.putLinks, t.env, { method: 'POST', body, params: { assetId }, ...o });
const patchLink = (linkId, body, o) => call(links.updateLink, t.env, { method: 'PATCH', body, params: { linkId }, ...o });

describe('putLinks', () => {
  it('replaces the confirmed link set atomically and keeps suggestions', async () => {
    await put('ast_a', { links: [{ targetType: 'equipment', targetId: EQ.spanner, quantity: 2 }] });
    t.db.sqlite.prepare("INSERT INTO asset_links (id, asset_id, target_type, target_id, equipment_id, state, created_at, updated_at) VALUES ('al_s', 'ast_a', 'equipment', ?, ?, 'suggested', 1, 1)").run(EQ.hose, EQ.hose);
    const res = await put('ast_a', { links: [{ targetType: 'assignment', targetId: 'as_ls1_axe' }] });
    expect(res.status).toBe(200);
    const rows = t.db.query('SELECT target_type, state FROM asset_links WHERE asset_id = ? ORDER BY target_type', 'ast_a');
    expect(rows).toEqual([{ target_type: 'assignment', state: 'confirmed' }, { target_type: 'equipment', state: 'suggested' }]);
  });

  it('an empty set clears confirmed links', async () => {
    await put('ast_a', { links: [{ targetType: 'equipment', targetId: EQ.axe }] });
    expect((await put('ast_a', { links: [] })).status).toBe(200);
    expect(t.db.one('SELECT COUNT(*) AS n FROM asset_links').n).toBe(0);
  });

  it('validates against the asset\'s own compartment (cross-compartment ids rejected, set unchanged)', async () => {
    await put('ast_a', { links: [{ targetType: 'equipment', targetId: EQ.axe }] });
    const res = await put('ast_a', { links: [{ targetType: 'assignment', targetId: 'as_ls2_axe' }] });
    expect(res.status).toBe(400);
    expect(t.db.one("SELECT COUNT(*) AS n FROM asset_links WHERE state = 'confirmed'").n).toBe(1);
  });

  it('applies planner ops in the same batch and aborts on conflict', async () => {
    const ok = await put('ast_a', {
      plannerOps: [{ type: 'setSlot', comp: 'LS1', index: 5, value: 'Hose', expect: '' }],
      links: [{ targetType: 'equipment', targetId: EQ.hose }],
    });
    expect(ok.status).toBe(200);
    expect((await jsonOf(ok)).plannerRevision).toBe(2);
    const conflict = await put('ast_a', {
      plannerOps: [{ type: 'setSlot', comp: 'LS1', index: 5, value: 'Axe', expect: '' }],
      links: [],
    });
    expect(conflict.status).toBe(409);
    expect(t.db.one("SELECT COUNT(*) AS n FROM asset_links WHERE state = 'confirmed'").n).toBe(1);
  });

  it('404s for pending, deleted or missing assets', async () => {
    t.db.sqlite.prepare("UPDATE assets SET status = 'pending' WHERE id = 'ast_a'").run();
    expect((await put('ast_a', { links: [] })).status).toBe(404);
    expect((await put('ast_nope', { links: [] })).status).toBe(404);
  });
});

describe('updateLink', () => {
  const suggest = (id = 'al_s', target = EQ.axe, qty = 1) => t.db.sqlite.prepare(
    "INSERT INTO asset_links (id, asset_id, target_type, target_id, equipment_id, quantity, state, label, confidence, created_at, updated_at) VALUES (?, 'ast_a', 'equipment', ?, ?, ?, 'suggested', 'axe?', 0.8, 1, 1)",
  ).run(id, target, target, qty);

  it('confirms a suggestion (validated) and rejects one', async () => {
    suggest(); suggest('al_t', EQ.spanner, 2);
    const ok = await patchLink('al_s', { state: 'confirmed' });
    expect(ok.status).toBe(200);
    expect((await jsonOf(ok)).link).toMatchObject({ state: 'confirmed', equipmentId: EQ.axe });
    expect((await jsonOf(await patchLink('al_t', { state: 'rejected' }))).link.state).toBe('rejected');
    expect(t.db.one("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('link.confirmed','link.rejected')").n).toBe(2);
  });

  it('refuses to confirm a suggestion whose quantity exceeds what is assigned here, or whose item is not assigned', async () => {
    suggest('al_q', EQ.axe, 1);
    expect((await patchLink('al_q', { state: 'confirmed', quantity: 5 })).status).toBe(400);
    suggest('al_h', EQ.hose, 1);
    expect((await patchLink('al_h', { state: 'confirmed' })).status).toBe(400);
    expect(t.db.one("SELECT COUNT(*) AS n FROM asset_links WHERE state = 'confirmed'").n).toBe(0);
  });

  it('rejects bad states and unknown links', async () => {
    suggest();
    expect((await patchLink('al_s', { state: 'suggested' })).status).toBe(400);
    expect((await patchLink('al_s', { state: 'weird' })).status).toBe(400);
    expect((await patchLink('al_zzz', { state: 'confirmed' })).status).toBe(404);
  });
});

describe('mounts', () => {
  const create = (body, o) => call(mounts.createMount, t.env, { method: 'POST', body, params: { compId: 'LS1' }, ...o });
  const patch = (id, body, o) => call(mounts.updateMount, t.env, { method: 'PATCH', body, params: { mountId: id }, ...o });

  it('creates, lists, updates (CAS) and soft-deletes a mount with links', async () => {
    const res = await create({ name: 'Bracket', dimensions: { widthIn: 4 }, links: [{ targetType: 'equipment', targetId: EQ.axe }, { targetType: 'assignment', targetId: 'as_ls1_s0' }, { targetType: 'asset', targetId: 'ast_a' }] });
    expect(res.status).toBe(201);
    const { mount } = await jsonOf(res);
    expect(mount).toMatchObject({ classification: 'mounting', status: 'proposed', revision: 1, dimensions: { widthIn: 4 } });
    expect(mount.links).toHaveLength(3);

    const list = await jsonOf(await call(mounts.listMounts, t.env, { params: { compId: 'LS1' } }));
    expect(list.mounts).toHaveLength(1);
    expect((await jsonOf(await call(mounts.listMounts, t.env, { params: { compId: 'LS2' } }))).mounts).toHaveLength(0);

    const upd = await patch(mount.id, { name: 'Bracket 2', status: 'existing', expectRevision: 1, links: [{ targetType: 'equipment', targetId: EQ.spanner }] });
    expect(upd.status).toBe(200);
    const updated = (await jsonOf(upd)).mount;
    expect(updated).toMatchObject({ name: 'Bracket 2', status: 'existing', revision: 2 });
    expect(updated.links).toEqual([{ targetType: 'equipment', targetId: EQ.spanner }]);
    expect((await patch(mount.id, { name: 'stale', expectRevision: 1 })).status).toBe(409);
    expect(t.db.one('SELECT COUNT(*) AS n FROM mount_links').n).toBe(1);

    expect((await call(mounts.deleteMount, t.env, { method: 'DELETE', params: { mountId: mount.id } })).status).toBe(200);
    expect((await jsonOf(await call(mounts.listMounts, t.env, { params: { compId: 'LS1' } }))).mounts).toHaveLength(0);
    expect((await patch(mount.id, { name: 'x', expectRevision: 3 })).status).toBe(404);
    expect(t.db.one('SELECT deleted_at FROM mounts WHERE id = ?', mount.id).deleted_at).not.toBeNull();
  });

  it('a failed revision check does not touch the link set', async () => {
    const { mount } = await jsonOf(await create({ name: 'M', links: [{ targetType: 'equipment', targetId: EQ.axe }] }));
    expect((await patch(mount.id, { name: 'n', expectRevision: 9, links: [] })).status).toBe(409);
    expect(t.db.one('SELECT COUNT(*) AS n FROM mount_links').n).toBe(1);
  });

  it('validates enums, links and the inventory classification', async () => {
    expect((await create({ name: 'M', classification: 'bogus' })).status).toBe(400);
    expect((await create({ name: 'M', status: 'bogus' })).status).toBe(400);
    expect((await create({})).status).toBe(400);
    expect((await create({ name: 'M', links: [{ targetType: 'asset', targetId: 'ast_b' }] })).status).toBe(400);      // other compartment
    expect((await create({ name: 'M', links: [{ targetType: 'assignment', targetId: 'as_ls2_axe' }] })).status).toBe(400);
    expect((await create({ name: 'M', links: [{ targetType: 'equipment', targetId: 'eq_nope' }] })).status).toBe(400);
    expect((await create({ name: 'M', links: [{ targetType: 'mount', targetId: 'x' }] })).status).toBe(400);
    expect((await create({ name: 'M', classification: 'inventory' })).status).toBe(400);
    expect((await create({ name: 'M', classification: 'inventory', equipmentId: 'eq_nope' })).status).toBe(400);
    const ok = await create({ name: 'M', classification: 'inventory', equipmentId: EQ.hose });
    expect(ok.status).toBe(201);
    const { mount } = await jsonOf(ok);
    expect(mount.equipmentId).toBe(EQ.hose);
    expect((await patch(mount.id, { classification: 'reference', expectRevision: 1 })).status).toBe(200);
    expect(t.db.one('SELECT equipment_id FROM mounts WHERE id = ?', mount.id).equipment_id).toBeNull();
    expect((await patch(mount.id, { classification: 'inventory', expectRevision: 2 })).status).toBe(400);
    expect((await patch(mount.id, { name: 'x' })).status).toBe(400);
  });
});

describe('designs', () => {
  const putD = (body, comp = 'LS1', o) => call(designs.putDesign, t.env, { method: 'PUT', body, params: { compId: comp }, ...o });
  const getD = (comp = 'LS1') => call(designs.getDesign, t.env, { params: { compId: comp } });

  it('returns a default layout from the geometry zones (with admin overrides) when none is stored', async () => {
    expect((await jsonOf(await getD())).design).toMatchObject({ revision: 0, layout: { zones: ['upper_shelf', 'floor'], placements: [] } });
    setSetting(t.db, 'compartments.overrides', { LS1: { zones: ['custom'] } });
    expect((await jsonOf(await getD())).design.layout.zones).toEqual(['custom']);
    expect((await getD('NOPE')).status).toBe(404);
  });

  it('saves with expectRevision CAS and rejects stale writers', async () => {
    const mountRes = await call(mounts.createMount, t.env, { method: 'POST', body: { name: 'Tray' }, params: { compId: 'LS1' } });
    const mountId = (await jsonOf(mountRes)).mount.id;
    const layout = { zones: ['floor'], placements: [{ targetType: 'assignment', targetId: 'as_ls1_s0', zone: 'floor' }, { targetType: 'mount', targetId: mountId, zone: 'floor' }, { targetType: 'equipment', targetId: EQ.axe, zone: 'floor' }] };
    const first = await putD({ layout, expectRevision: 0 });
    expect(first.status).toBe(200);
    expect((await jsonOf(first)).design.revision).toBe(1);
    expect((await putD({ layout, expectRevision: 0 })).status).toBe(409);
    expect((await jsonOf(await putD({ layout: { zones: [], placements: [] }, expectRevision: 1 }, 'LS1', { actor: editor('b@x') }))).design.revision).toBe(2);
    expect((await putD({ layout, expectRevision: 1 })).status).toBe(409);
    expect((await jsonOf(await getD())).design).toMatchObject({ revision: 2, updatedBy: 'b@x' });
    expect(t.db.one("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'design.update'").n).toBe(2);
  });

  it('rejects placements referencing other compartments or unknown ids, and missing expectRevision', async () => {
    const bad = [
      { targetType: 'assignment', targetId: 'as_ls2_axe' },
      { targetType: 'equipment', targetId: EQ.hose },
      { targetType: 'mount', targetId: 'mt_nope' },
      { targetType: 'asset', targetId: 'ast_a' },
    ];
    for (const p of bad) expect((await putD({ layout: { zones: [], placements: [p] }, expectRevision: 0 })).status).toBe(400);
    expect((await putD({ layout: { zones: [], placements: [] } })).status).toBe(400);
    expect((await putD({ layout: 'nope', expectRevision: 0 })).status).toBe(400);
    expect(t.db.one('SELECT COUNT(*) AS n FROM designs').n).toBe(0);
  });
});
