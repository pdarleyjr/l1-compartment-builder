import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as gallery from '../../src/gallery.js';
import { COMPARTMENTS } from '../../../shared/apparatus.js';
import { EQ, NOW, call, insertAsset, insertVersion, jsonOf, makeEnv, editor } from './helpers/harness.js';
import { resetIds } from './helpers/fakes.js';

vi.mock('../../../shared/ids.js', async () => (await import('./helpers/fakes.js')).idsFake);
vi.mock('../../../shared/planner.js', async () => (await import('./helpers/fakes.js')).plannerSharedFake);
vi.mock('../../../shared/fingerprint.js', async () => (await import('./helpers/fakes.js')).fingerprintFake);
vi.mock('../../../shared/apparatus-render.js', async () => (await import('./helpers/fakes.js')).apparatusRenderFake);
vi.mock('../../../shared/cost.js', async () => (await import('./helpers/fakes.js')).costFake);
vi.mock('../../../shared/scene-spec.js', async () => (await import('./helpers/fakes.js')).sceneSpecFake);
vi.mock('../../../shared/validation.js', async () => (await import('./helpers/fakes.js')).validationFake);
vi.mock('../../src/settings.js', async () => (await import('./helpers/fakes.js')).settingsFake());
vi.mock('../../src/planner.js', async () => (await import('./helpers/fakes.js')).plannerModuleFake);

let t;
beforeEach(() => { resetIds(); t = makeEnv(); });

const anon = { kind: 'anonymous' };
const pubGallery = (comp = 'LS2') => call(gallery.getPublicGallery, t.env, { params: { compId: comp }, actor: anon });
const edGallery = (comp = 'LS1') => call(gallery.getEditorGallery, t.env, { params: { compId: comp } });
const setMain = (comp, body, o) => call(gallery.setMainImage, t.env, { method: 'POST', body, params: { compId: comp }, ...o });
const restore = (comp, body, o) => call(gallery.restorePreviousMainImage, t.env, { method: 'POST', body, params: { compId: comp }, ...o });
const mainRow = comp => t.db.one('SELECT * FROM main_images WHERE compartment_id = ?', comp);
const fpOf = async comp => (await import('./helpers/fakes.js')).fingerprintFake.inventoryFingerprint(JSON.parse(t.db.one("SELECT doc FROM planner_doc").doc), comp);

describe('galleries', () => {
  it('public gallery: preset images + public committed assets only, no main by default', async () => {
    insertAsset(t, 'ast_pub', 'LS2', { visibility: 'public', provenance: 'legacy_upload', category: 'legacy_upload' });
    insertAsset(t, 'ast_priv', 'LS2');
    insertAsset(t, 'ast_other', 'LS1', { visibility: 'public' });
    insertAsset(t, 'ast_pend', 'LS2', { visibility: 'public', status: 'pending' });
    const body = await jsonOf(await pubGallery());
    expect(body.main).toBeNull();
    const presets = COMPARTMENTS.find(c => c.id === 'LS2').images;
    expect(body.items.filter(i => i.kind === 'preset').map(i => i.url)).toEqual(presets.map(i => i.src));
    expect(body.items.find(i => i.url?.includes('LS2_rendering'))).toMatchObject({ provenance: 'ai_concept' });
    const assets = body.items.filter(i => i.kind === 'asset');
    expect(assets.map(i => i.assetId)).toEqual(['ast_pub']);
    expect(assets[0]).toMatchObject({ url: '/api/public/assets/ast_pub/display', thumbUrl: '/api/public/assets/ast_pub/thumb', provenance: 'legacy_upload' });
    expect((await pubGallery('NOPE')).status).toBe(404);
  });

  it('editor gallery adds private photos and draft/rejected versions (flagging stale ones), never markup', async () => {
    insertAsset(t, 'ast_priv', 'LS1');
    insertAsset(t, 'ast_markup', 'LS1', { category: 'markup' });
    insertAsset(t, 'ast_r1', 'LS1', { category: 'rendering', provenance: 'ai_concept' });
    insertAsset(t, 'ast_r2', 'LS1', { category: 'rendering', provenance: 'ai_concept' });
    insertAsset(t, 'ast_r3', 'LS1', { category: 'rendering', provenance: 'ai_concept' });
    insertVersion(t, 'iv_draft', 'LS1', 'ast_r1', { fingerprint: await fpOf('LS1') });
    insertVersion(t, 'iv_rej', 'LS1', 'ast_r2', { status: 'rejected' });
    insertVersion(t, 'iv_del', 'LS1', 'ast_r3', { status: 'deleted' });
    const { items } = await jsonOf(await edGallery());
    expect(items.filter(i => i.kind === 'asset').map(i => i.assetId)).toEqual(['ast_priv']);
    const versions = items.filter(i => i.kind === 'version');
    expect(versions.map(v => [v.versionId, v.status, v.stale])).toEqual([['iv_draft', 'draft', false], ['iv_rej', 'rejected', true]]);
    const pub = await jsonOf(await pubGallery('LS1'));
    expect(pub.items.some(i => i.kind === 'version' || i.assetId === 'ast_priv')).toBe(false);
  });
});

describe('setMainImage', () => {
  it('sets a preset as main (insert path) and keeps no previous', async () => {
    const res = await setMain('LS2', { kind: 'preset', ref: '/images/LS2_rendering.webp' });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).main).toMatchObject({ kind: 'preset', revision: 1, url: '/images/LS2_rendering.webp', stale: false, previous: null });
    expect(mainRow('LS2').updated_by).toBe('ed@mbfd.test');
    expect(t.db.one("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'main_image.set'").n).toBe(1);
  });

  it('rejects refs from other compartments or unknown kinds/ids', async () => {
    insertAsset(t, 'ast_ls2', 'LS2');
    insertAsset(t, 'ast_mk', 'LS1', { category: 'markup' });
    insertAsset(t, 'ast_pend', 'LS1', { status: 'pending' });
    insertAsset(t, 'ast_r', 'LS2', { category: 'rendering' });
    insertVersion(t, 'iv_ls2', 'LS2', 'ast_r');
    insertVersion(t, 'iv_del', 'LS1', 'ast_r', { status: 'deleted' });
    for (const body of [
      { kind: 'preset', ref: '/images/LS2.webp' }, { kind: 'preset', ref: '/images/nope.webp' }, { kind: 'asset', ref: 'ast_ls2' },
      { kind: 'asset', ref: 'ast_mk' }, { kind: 'asset', ref: 'ast_pend' }, { kind: 'version', ref: 'iv_ls2' }, { kind: 'version', ref: 'iv_del' },
      { kind: 'version', ref: 'iv_nope' }, { kind: 'bogus', ref: 'x' }, { kind: 'asset' },
    ]) {
      expect((await setMain('LS1', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(t.db.one('SELECT COUNT(*) AS n FROM main_images').n).toBe(0);
  });

  it('approving a fresh version publishes it: version approved, asset public + approved_concept, main set, one audit row', async () => {
    insertAsset(t, 'ast_r', 'LS1', { category: 'rendering', provenance: 'ai_concept' });
    insertVersion(t, 'iv_1', 'LS1', 'ast_r', { fingerprint: await fpOf('LS1') });
    const res = await setMain('LS1', { kind: 'version', ref: 'iv_1' }, { actor: editor('boss@mbfd.test') });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).main).toMatchObject({ kind: 'version', provenance: 'approved_concept', url: '/api/public/assets/ast_r/display', stale: false });
    expect(t.db.one("SELECT status, approved_by, approved_at FROM image_versions WHERE id = 'iv_1'")).toEqual({ status: 'approved', approved_by: 'boss@mbfd.test', approved_at: NOW });
    expect(t.db.one("SELECT visibility, provenance FROM assets WHERE id = 'ast_r'")).toEqual({ visibility: 'public', provenance: 'approved_concept' });
    const pub = await jsonOf(await pubGallery('LS1'));
    expect(pub.main.ref).toBe('iv_1');
    expect(pub.items.some(i => i.assetId === 'ast_r')).toBe(true);
    expect((await jsonOf(await call(gallery.getMainImages, t.env, { actor: anon }))).mainImages.LS1.kind).toBe('version');
  });

  it('a stale version needs acknowledgeStale: 409 STALE_SOURCE with both fingerprints, then publishes when acknowledged', async () => {
    insertAsset(t, 'ast_r', 'LS1', { category: 'rendering', provenance: 'ai_concept' });
    insertVersion(t, 'iv_1', 'LS1', 'ast_r', { fingerprint: 'outdated' });
    const res = await setMain('LS1', { kind: 'version', ref: 'iv_1' });
    expect(res.status).toBe(409);
    const err = (await jsonOf(res)).error;
    expect(err.code).toBe('STALE_SOURCE');
    expect(err.details).toEqual({ current: await fpOf('LS1'), version: 'outdated' });
    expect(t.db.one('SELECT COUNT(*) AS n FROM main_images').n).toBe(0);
    expect(t.db.one("SELECT status FROM image_versions WHERE id = 'iv_1'").status).toBe('draft');
    expect(t.db.one("SELECT visibility FROM assets WHERE id = 'ast_r'").visibility).toBe('private');
    expect((await setMain('LS1', { kind: 'version', ref: 'iv_1', acknowledgeStale: true })).status).toBe(200);
    const main = (await jsonOf(await pubGallery('LS1'))).main;
    expect(main.stale).toBe(true);
  });

  it('main image becomes stale when assignments change after approval', async () => {
    insertAsset(t, 'ast_r', 'LS1', { category: 'rendering', provenance: 'ai_concept' });
    insertVersion(t, 'iv_1', 'LS1', 'ast_r', { fingerprint: await fpOf('LS1') });
    await setMain('LS1', { kind: 'version', ref: 'iv_1' });
    const all = async () => (await jsonOf(await call(gallery.getMainImages, t.env, { actor: anon }))).mainImages.LS1.stale;
    expect(await all()).toBe(false);
    const doc = JSON.parse(t.db.one('SELECT doc FROM planner_doc').doc);
    doc.allocations.LS1[7] = 'Hose'; doc.assignmentIds.LS1[7] = 'as_new';
    t.db.sqlite.prepare("UPDATE planner_doc SET doc = ?, revision = 2").run(JSON.stringify(doc));
    expect(await all()).toBe(true);
  });

  it('uses CAS on main_images.revision', async () => {
    await setMain('LS2', { kind: 'preset', ref: '/images/LS2.webp' });
    const stale = await setMain('LS2', { kind: 'preset', ref: '/images/LS2_rendering.webp', expectRevision: 0 });
    expect(stale.status).toBe(409);
    expect((await jsonOf(stale)).error.code).toBe('REVISION_CONFLICT');
    expect((await setMain('LS2', { kind: 'preset', ref: '/images/LS2_rendering.webp' })).status).toBe(400); // expectRevision required once a row exists
    const ok = await setMain('LS2', { kind: 'preset', ref: '/images/LS2_rendering.webp', expectRevision: 1 });
    expect(ok.status).toBe(200);
    expect((await jsonOf(ok)).main).toMatchObject({ revision: 2, previous: { kind: 'preset', ref: '/images/LS2.webp' } });
    expect((await setMain('LS2', { kind: 'preset', ref: '/images/LS2.webp', expectRevision: 0 })).status).toBe(409);
  });

  it('first write for a compartment with no main row refuses a non-zero expectRevision', async () => {
    expect((await setMain('LS2', { kind: 'preset', ref: '/images/LS2.webp', expectRevision: 4 })).status).toBe(409);
    expect(t.db.one('SELECT COUNT(*) AS n FROM main_images').n).toBe(0);
  });

  it('a concurrent insert race leaves exactly one winner and no half-applied follow-ups', async () => {
    insertAsset(t, 'ast_r', 'LS1', { category: 'rendering', provenance: 'ai_concept' });
    insertVersion(t, 'iv_1', 'LS1', 'ast_r', { fingerprint: await fpOf('LS1') });
    // someone else inserts between our read and our batch
    const realPrepare = t.db.prepare;
    let injected = false;
    t.db.prepare = sql => {
      if (!injected && sql.startsWith('INSERT INTO main_images')) {
        injected = true;
        t.db.sqlite.prepare("INSERT INTO main_images (compartment_id, revision, kind, ref, updated_at) VALUES ('LS1', 1, 'preset', '/images/LS1.webp', 5)").run();
      }
      return realPrepare(sql);
    };
    const res = await setMain('LS1', { kind: 'version', ref: 'iv_1' });
    t.db.prepare = realPrepare;
    expect(res.status).toBe(409);
    expect(mainRow('LS1').ref).toBe('/images/LS1.webp');
    expect(t.db.one("SELECT status FROM image_versions WHERE id = 'iv_1'").status).toBe('draft');
    expect(t.db.one("SELECT visibility FROM assets WHERE id = 'ast_r'").visibility).toBe('private');
    expect(t.db.one("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'main_image.set'").n).toBe(0);
  });

  it('sets a committed asset as main and makes it public', async () => {
    insertAsset(t, 'ast_p', 'LS1');
    const res = await setMain('LS1', { kind: 'asset', ref: 'ast_p' });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).main).toMatchObject({ kind: 'asset', url: '/api/public/assets/ast_p/display' });
    expect(t.db.one("SELECT visibility FROM assets WHERE id = 'ast_p'").visibility).toBe('public');
  });
});

describe('restorePreviousMainImage', () => {
  it('swaps current and previous with CAS (and swaps back)', async () => {
    insertAsset(t, 'ast_r', 'LS1', { category: 'rendering', provenance: 'ai_concept' });
    insertVersion(t, 'iv_1', 'LS1', 'ast_r', { fingerprint: await fpOf('LS1') });
    await setMain('LS1', { kind: 'preset', ref: '/images/LS1.webp' });
    await setMain('LS1', { kind: 'version', ref: 'iv_1', expectRevision: 1 });
    const res = await restore('LS1', { expectRevision: 2 });
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).main).toMatchObject({ kind: 'preset', ref: '/images/LS1.webp', revision: 3, previous: { kind: 'version', ref: 'iv_1' } });
    expect((await restore('LS1', { expectRevision: 2 })).status).toBe(409);
    const back = await restore('LS1', { expectRevision: 3 });
    expect((await jsonOf(back)).main).toMatchObject({ kind: 'version', ref: 'iv_1', revision: 4 });
    expect(t.db.one("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'main_image.restore'").n).toBe(2);
  });

  it('refuses without a previous image or when it was deleted meanwhile', async () => {
    expect((await restore('LS1', {})).status).toBe(409);
    await setMain('LS1', { kind: 'preset', ref: '/images/LS1.webp' });
    expect((await restore('LS1', { expectRevision: 1 })).status).toBe(409);
    insertAsset(t, 'ast_p', 'LS1');
    await setMain('LS1', { kind: 'asset', ref: 'ast_p', expectRevision: 1 });
    await setMain('LS1', { kind: 'preset', ref: '/images/LS1.webp', expectRevision: 2 });
    t.db.sqlite.prepare("UPDATE assets SET status = 'deleted' WHERE id = 'ast_p'").run();
    const res = await restore('LS1', { expectRevision: 3 });
    expect(res.status).toBe(409);
    expect((await jsonOf(res)).error.message).toMatch(/no longer available/);
  });

  it('getMainImages skips main rows whose target vanished', async () => {
    insertAsset(t, 'ast_p', 'LS1');
    await setMain('LS1', { kind: 'asset', ref: 'ast_p' });
    t.db.sqlite.prepare("UPDATE assets SET status = 'deleted' WHERE id = 'ast_p'").run();
    expect(await jsonOf(await call(gallery.getMainImages, t.env, { actor: anon }))).toEqual({ mainImages: {} });
    expect(EQ.axe).toBeTruthy();
  });
});
