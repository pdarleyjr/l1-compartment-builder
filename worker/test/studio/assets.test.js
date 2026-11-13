import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as assets from '../../src/assets.js';
import { ASSET_LIMITS } from '../../../shared/contracts.js';
import { EQ, NOW, admin, call, editor, jsonOf, makeEnv, service } from './helpers/harness.js';
import { heic, jpeg, png, sha256, webp } from './helpers/images.js';
import { resetIds } from './helpers/fakes.js';

vi.mock('../../../shared/ids.js', async () => (await import('./helpers/fakes.js')).idsFake);
vi.mock('../../../shared/planner.js', async () => (await import('./helpers/fakes.js')).plannerSharedFake);
vi.mock('../../../shared/validation.js', async () => (await import('./helpers/fakes.js')).validationFake);
vi.mock('../../src/settings.js', async () => (await import('./helpers/fakes.js')).settingsFake());
vi.mock('../../src/planner.js', async () => (await import('./helpers/fakes.js')).plannerModuleFake);

let t;
beforeEach(() => { resetIds(); t = makeEnv(); });

const orig = png(200, 100, 20);
const disp = webp(100, 50);
const thumb = webp(40, 20);

const createBody = (extra = {}) => ({ compartmentId: 'LS1', category: 'tool', title: 'Spanner', width: 200, height: 100, bytes: orig.length, sha256: sha256(orig), idempotencyKey: 'k1', ...extra });
const create = async (extra, actor = editor()) => jsonOf(await call(assets.createAsset, t.env, { method: 'POST', body: createBody(extra), actor }));
const put = (id, variant, bytes, o = {}) => call(assets.putVariant, t.env, { method: 'PUT', raw: bytes, headers: { 'Content-Type': 'image/png' }, params: { assetId: id, variant }, ...o });
const commit = (id, body = {}, o = {}) => call(assets.commitAsset, t.env, { method: 'POST', body, params: { assetId: id }, ...o });

async function uploadAll(id) {
  expect((await put(id, 'original', orig)).status).toBe(204);
  expect((await put(id, 'display', disp, { headers: { 'Content-Type': 'image/webp' } })).status).toBe(204);
  expect((await put(id, 'thumb', thumb, { headers: { 'Content-Type': 'image/webp' } })).status).toBe(204);
}

async function committed(links) {
  const { asset } = await create();
  await uploadAll(asset.id);
  const res = await commit(asset.id, links ? { links } : {});
  expect(res.status).toBe(200);
  return asset.id;
}

describe('createAsset', () => {
  it('creates a pending asset with upload URLs (201)', async () => {
    const res = await call(assets.createAsset, t.env, { method: 'POST', body: createBody() });
    expect(res.status).toBe(201);
    const body = await jsonOf(res);
    expect(body.asset).toMatchObject({ status: 'pending', category: 'tool', visibility: 'private', createdBy: 'ed@mbfd.test' });
    expect(body.upload.original).toBe(`/api/assets/${body.asset.id}/original`);
    expect(t.db.one('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?', 'asset.create').n).toBe(1);
  });

  it('is idempotent per (user, idempotencyKey) but not across users', async () => {
    const a = await create();
    const b = await create();
    expect(b.asset.id).toBe(a.asset.id);
    expect(t.db.one('SELECT COUNT(*) AS n FROM assets').n).toBe(1);
    const other = await create({}, editor('other@mbfd.test'));
    expect(other.asset.id).not.toBe(a.asset.id);
  });

  it('rejects reuse of a key for a different photo', async () => {
    await create();
    const res = await call(assets.createAsset, t.env, { method: 'POST', body: createBody({ sha256: sha256(thumb) }) });
    expect(res.status).toBe(409);
  });

  it('rejects server-only categories, unknown compartments and invalid bodies', async () => {
    for (const category of ['rendering', 'legacy_upload', 'nonsense']) {
      expect((await call(assets.createAsset, t.env, { method: 'POST', body: createBody({ category }) })).status).toBe(400);
    }
    expect((await call(assets.createAsset, t.env, { method: 'POST', body: createBody({ compartmentId: 'XX9' }) })).status).toBe(404);
    expect((await call(assets.createAsset, t.env, { method: 'POST', body: createBody({ sha256: 'zz' }) })).status).toBe(400);
    expect((await call(assets.createAsset, t.env, { method: 'POST', raw: 'not json' })).status).toBe(400);
  });

  it('allows the markup category and enforces the per-compartment cap', async () => {
    expect((await call(assets.createAsset, t.env, { method: 'POST', body: createBody({ category: 'markup', idempotencyKey: 'm' }) })).status).toBe(201);
    const ins = t.db.sqlite.prepare("INSERT INTO assets (id, compartment_id, category, provenance, status, created_at, updated_at) VALUES (?, 'LS1', 'tool', 'user_photo', 'committed', 1, 1)");
    for (let i = 0; i < ASSET_LIMITS.maxPerCompartment; i += 1) ins.run(`ast_fill${i}`);
    const res = await call(assets.createAsset, t.env, { method: 'POST', body: createBody({ idempotencyKey: 'over' }) });
    expect(res.status).toBe(409);
    expect((await jsonOf(res)).error.message).toMatch(/400 photos/);
  });
});

describe('putVariant', () => {
  it('stores each variant in R2 with content type and records variants_ready', async () => {
    const { asset } = await create();
    await uploadAll(asset.id);
    const keys = [...t.r2.store.keys()].sort();
    expect(keys).toEqual([`assets/LS1/${asset.id}/display.webp`, `assets/LS1/${asset.id}/original.png`, `assets/LS1/${asset.id}/thumb.webp`]);
    expect(t.r2.store.get(`assets/LS1/${asset.id}/original.png`).httpMetadata.contentType).toBe('image/png');
    const row = t.db.one('SELECT * FROM assets WHERE id = ?', asset.id);
    expect(JSON.parse(row.variants_ready).sort()).toEqual(['display', 'original', 'thumb']);
    expect(row).toMatchObject({ width: 200, height: 100, bytes: orig.length, original_type: 'image/png' });
  });

  it('rejects HEIC and non-image bytes with 415 even when the header claims image/jpeg', async () => {
    const { asset } = await create();
    expect((await put(asset.id, 'original', heic(), { headers: { 'Content-Type': 'image/jpeg' } })).status).toBe(415);
    expect((await put(asset.id, 'original', new TextEncoder().encode('<script>alert(1)</script>'), { headers: { 'Content-Type': 'image/jpeg' } })).status).toBe(415);
    expect((await put(asset.id, 'original', orig, { headers: { 'Content-Type': 'text/html' } })).status).toBe(415);
    expect(t.r2.store.size).toBe(0);
  });

  it('rejects PNG as a derivative, oversize uploads (413) and empty bodies', async () => {
    const { asset } = await create();
    expect((await put(asset.id, 'display', png(10, 10, 20))).status).toBe(415);
    const big = webp(10, 10, ASSET_LIMITS.thumbMaxBytes + 1);
    expect((await put(asset.id, 'thumb', big, { headers: { 'Content-Type': 'image/webp' } })).status).toBe(413);
    expect((await put(asset.id, 'thumb', new Uint8Array(0))).status).toBe(400);
  });

  it('rejects an original whose sha256 differs from the declared one', async () => {
    const { asset } = await create();
    const res = await put(asset.id, 'original', png(200, 100, 21));
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error.message).toMatch(/checksum/);
    expect(t.r2.store.size).toBe(0);
  });

  it('rejects unknown variants, unknown assets, other users and committed assets', async () => {
    const { asset } = await create();
    expect((await put(asset.id, 'huge', orig)).status).toBe(404);
    expect((await put('ast_missing', 'original', orig)).status).toBe(404);
    expect((await put(asset.id, 'original', orig, { actor: editor('intruder@mbfd.test') })).status).toBe(403);
    expect((await put(asset.id, 'original', orig, { actor: admin() })).status).toBe(204);
    await put(asset.id, 'display', disp, { headers: { 'Content-Type': 'image/webp' } });
    await put(asset.id, 'thumb', thumb, { headers: { 'Content-Type': 'image/webp' } });
    await commit(asset.id);
    expect((await put(asset.id, 'original', orig)).status).toBe(409);
  });

  it('replacing a variant with another format removes the old object', async () => {
    const { asset } = await create();
    await put(asset.id, 'display', webp(10, 10), { headers: { 'Content-Type': 'image/webp' } });
    await put(asset.id, 'display', jpeg(10, 10), { headers: { 'Content-Type': 'image/jpeg' } });
    expect([...t.r2.store.keys()]).toEqual([`assets/LS1/${asset.id}/display.jpg`]);
  });
});

describe('commitAsset', () => {
  it('refuses to commit while a variant is missing (pending is never linked)', async () => {
    const { asset } = await create();
    await put(asset.id, 'original', orig);
    const res = await commit(asset.id, { links: [{ targetType: 'equipment', targetId: EQ.spanner, quantity: 1 }] });
    expect(res.status).toBe(409);
    expect((await jsonOf(res)).error.details.missing).toEqual(['display', 'thumb']);
    expect(t.db.one('SELECT COUNT(*) AS n FROM asset_links').n).toBe(0);
    expect(t.db.one('SELECT status FROM assets WHERE id = ?', asset.id).status).toBe('pending');
  });

  it('commits with links in one batch and returns the asset with links', async () => {
    const { asset } = await create();
    await uploadAll(asset.id);
    const res = await commit(asset.id, { links: [
      { targetType: 'equipment', targetId: EQ.spanner, quantity: 2 },
      { targetType: 'assignment', targetId: 'as_ls1_axe', quantity: 1 },
      { targetType: 'bundle', targetId: 'bd_one' },
    ] });
    expect(res.status).toBe(200);
    const { asset: out } = await jsonOf(res);
    expect(out.status).toBe('committed');
    expect(out.links).toHaveLength(3);
    expect(out.links.find(l => l.targetType === 'assignment')).toMatchObject({ equipmentId: EQ.axe, state: 'confirmed' });
    expect(out.variants.thumb).toBe(`/api/assets/${asset.id}/thumb`);
  });

  it('rejects invalid link targets atomically (nothing committed)', async () => {
    const { asset } = await create();
    await uploadAll(asset.id);
    const bad = [
      [{ targetType: 'equipment', targetId: 'eq_unknown' }],
      [{ targetType: 'assignment', targetId: 'as_ls2_axe' }],                 // other compartment
      [{ targetType: 'equipment', targetId: EQ.spanner, quantity: 3 }],        // only 2 assigned
      [{ targetType: 'equipment', targetId: EQ.hose, quantity: 1 }],           // not assigned here
      [{ targetType: 'mount', targetId: 'mt_nope' }],
      [{ targetType: 'bundle', targetId: 'bd_missing' }],
      [{ targetType: 'equipment', targetId: EQ.axe }, { targetType: 'equipment', targetId: EQ.axe }],
      [{ targetType: 'equipment', targetId: EQ.axe, region: { x: 2, y: 0, w: 1, h: 1 } }],
    ];
    for (const links of bad) {
      expect((await commit(asset.id, { links })).status).toBe(400);
    }
    expect(t.db.one('SELECT status FROM assets WHERE id = ?', asset.id).status).toBe('pending');
    expect(t.db.one('SELECT COUNT(*) AS n FROM asset_links').n).toBe(0);
  });

  it('applies planner ops and links together; quantity may use freshly assigned slots', async () => {
    const { asset } = await create();
    await uploadAll(asset.id);
    const res = await commit(asset.id, {
      plannerOps: [{ type: 'setSlot', comp: 'LS1', index: 3, value: 'Hose', expect: '' }],
      links: [{ targetType: 'equipment', targetId: EQ.hose, quantity: 1 }],
    });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).plannerRevision).toBe(2);
    expect(JSON.parse(t.db.one("SELECT doc FROM planner_doc WHERE id = 'main'").doc).allocations.LS1[3]).toBe('Hose');
  });

  it('a planner conflict returns 409 CONFLICT and commits nothing', async () => {
    const { asset } = await create();
    await uploadAll(asset.id);
    const res = await commit(asset.id, {
      plannerOps: [{ type: 'setSlot', comp: 'LS1', index: 0, value: 'Hose', expect: '' }],
      links: [{ targetType: 'equipment', targetId: EQ.spanner, quantity: 1 }],
    });
    expect(res.status).toBe(409);
    const body = await jsonOf(res);
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.details.conflicts[0]).toMatchObject({ index: 0, reason: 'PRECONDITION', current: 'Spanner' });
    expect(t.db.one('SELECT status FROM assets WHERE id = ?', asset.id).status).toBe('pending');
    expect(t.db.one('SELECT COUNT(*) AS n FROM asset_links').n).toBe(0);
    expect(t.db.one("SELECT revision FROM planner_doc WHERE id = 'main'").revision).toBe(1);
  });

  it('rolls back everything when a statement in the batch fails', async () => {
    const { asset } = await create();
    await uploadAll(asset.id);
    t.db.sqlite.exec('CREATE TRIGGER boom BEFORE INSERT ON asset_links BEGIN SELECT RAISE(ABORT, \'boom\'); END');
    await expect(commit(asset.id, { links: [{ targetType: 'equipment', targetId: EQ.axe }] })).rejects.toThrow(/boom/);
    expect(t.db.one('SELECT status FROM assets WHERE id = ?', asset.id).status).toBe('pending');
  });

  it('is idempotent for committed assets and restricted to the uploader or an admin', async () => {
    const id = await committed();
    expect((await commit(id)).status).toBe(200);
    const { asset } = await create({ idempotencyKey: 'k2' });
    expect((await commit(asset.id, {}, { actor: editor('intruder@mbfd.test') })).status).toBe(403);
    expect((await commit('ast_missing')).status).toBe(404);
  });
});

describe('updateAsset / deleteAsset', () => {
  it('updates title, notes and category with a revision check', async () => {
    const id = await committed();
    const patch = (body, actor) => call(assets.updateAsset, t.env, { method: 'PATCH', body, params: { assetId: id }, actor });
    const ok = await patch({ title: 'New', category: 'mount', expectRevision: 2 });
    expect(ok.status).toBe(200);
    expect((await jsonOf(ok)).asset).toMatchObject({ title: 'New', category: 'mount', revision: 3 });
    expect((await patch({ title: 'Stale', expectRevision: 2 })).status).toBe(409);
    expect((await patch({ category: 'rendering', expectRevision: 3 })).status).toBe(400);
    expect((await patch({ title: 'x' })).status).toBe(400);
  });

  it('refuses to edit studio-managed categories', async () => {
    t.db.sqlite.prepare("INSERT INTO assets (id, compartment_id, category, provenance, status, created_at, updated_at) VALUES ('ast_r', 'LS1', 'rendering', 'ai_concept', 'committed', 1, 1)").run();
    const res = await call(assets.updateAsset, t.env, { method: 'PATCH', body: { title: 'x', expectRevision: 1 }, params: { assetId: 'ast_r' } });
    expect(res.status).toBe(403);
    expect((await call(assets.deleteAsset, t.env, { method: 'DELETE', params: { assetId: 'ast_r' } })).status).toBe(409);
  });

  it('soft-deletes, hides from list, and refuses when it is the current main image', async () => {
    const id = await committed();
    t.db.sqlite.prepare("INSERT INTO main_images (compartment_id, revision, kind, ref, updated_at) VALUES ('LS1', 1, 'asset', ?, 1)").run(id);
    const blocked = await call(assets.deleteAsset, t.env, { method: 'DELETE', params: { assetId: id } });
    expect(blocked.status).toBe(409);
    expect((await jsonOf(blocked)).error.message).toMatch(/main image/);
    t.db.sqlite.exec('DELETE FROM main_images');
    expect((await call(assets.deleteAsset, t.env, { method: 'DELETE', params: { assetId: id } })).status).toBe(200);
    const row = t.db.one('SELECT status, deleted_at, deleted_by FROM assets WHERE id = ?', id);
    expect(row).toMatchObject({ status: 'deleted', deleted_at: NOW, deleted_by: 'ed@mbfd.test' });
    const list = await jsonOf(await call(assets.listAssets, t.env, { params: { compId: 'LS1' } }));
    expect(list.assets).toHaveLength(0);
    expect((await call(assets.getVariant, t.env, { params: { assetId: id, variant: 'thumb' } })).status).toBe(404);
  });

  it('refuses to delete an asset backing the current main version', async () => {
    t.db.sqlite.prepare("INSERT INTO assets (id, compartment_id, category, provenance, status, created_at, updated_at) VALUES ('ast_v', 'LS1', 'tool', 'user_photo', 'committed', 1, 1)").run();
    t.db.sqlite.prepare("INSERT INTO image_versions (id, compartment_id, job_id, asset_id, spec, spec_hash, model, settings, inventory_fingerprint, created_at, updated_at) VALUES ('iv_1', 'LS1', 'gj_1', 'ast_v', '{}', 'h', 'm', '{}', 'f', 1, 1)").run();
    t.db.sqlite.prepare("INSERT INTO main_images (compartment_id, revision, kind, ref, updated_at) VALUES ('LS1', 1, 'version', 'iv_1', 1)").run();
    expect((await call(assets.deleteAsset, t.env, { method: 'DELETE', params: { assetId: 'ast_v' } })).status).toBe(409);
  });
});

describe('serving and listing', () => {
  it('serves private variants to editors with private no-store', async () => {
    const id = await committed();
    const res = await call(assets.getVariant, t.env, { params: { assetId: id, variant: 'display' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Content-Type')).toBe('image/webp');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(disp);
    expect((await call(assets.getVariant, t.env, { params: { assetId: id, variant: 'bogus' } })).status).toBe(404);
  });

  it('public variants only for public + committed assets, immutable cache, ETag 304', async () => {
    const id = await committed();
    const pub = o => call(assets.getPublicVariant, t.env, { params: { assetId: id, variant: 'thumb' }, actor: { kind: 'anonymous' }, ...o });
    expect((await pub()).status).toBe(404);
    t.db.sqlite.prepare("UPDATE assets SET visibility = 'public' WHERE id = ?").run(id);
    const res = await pub();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    const etag = res.headers.get('ETag');
    expect(etag).toBeTruthy();
    const again = await pub({ headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);
    t.db.sqlite.prepare("UPDATE assets SET status = 'deleted' WHERE id = ?").run(id);
    expect((await pub()).status).toBe(404);
  });

  it('a pending public asset is never served; a missing R2 object is a 404', async () => {
    const { asset } = await create();
    t.db.sqlite.prepare("UPDATE assets SET visibility = 'public' WHERE id = ?").run(asset.id);
    expect((await call(assets.getPublicVariant, t.env, { params: { assetId: asset.id, variant: 'original' }, actor: { kind: 'anonymous' } })).status).toBe(404);
    const id = await committed();
    t.r2.store.clear();
    expect((await call(assets.getVariant, t.env, { params: { assetId: id, variant: 'original' } })).status).toBe(404);
  });

  it('lists committed assets with links, filtered by category, excluding other compartments and pending', async () => {
    const a = await committed([{ targetType: 'equipment', targetId: EQ.axe }]);
    const { asset: pending } = await create({ idempotencyKey: 'p', category: 'mount' });
    const res = await jsonOf(await call(assets.listAssets, t.env, { params: { compId: 'LS1' } }));
    expect(res.assets.map(x => x.id)).toEqual([a]);
    expect(res.assets[0].links[0]).toMatchObject({ equipmentId: EQ.axe });
    expect(res.assets[0].variants.thumb).toBe(`/api/assets/${a}/thumb`);
    const byCat = await jsonOf(await call(assets.listAssets, t.env, { params: { compId: 'LS1' }, query: '?category=mount' }));
    expect(byCat.assets).toHaveLength(0);
    expect(pending.status).toBe('pending');
    const other = await jsonOf(await call(assets.listAssets, t.env, { params: { compId: 'LS2' } }));
    expect(other.assets).toHaveLength(0);
    expect((await call(assets.listAssets, t.env, { params: { compId: 'ZZ' } })).status).toBe(404);
  });

  it('service identities cannot be mistaken for owners (record-level check)', async () => {
    const { asset } = await create();
    expect((await put(asset.id, 'original', orig, { actor: service() })).status).toBe(403);
  });
});
