import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import worker from '../../../worker/index.js';
import { ADMIN, EDITOR, imagesFixture, makeEnv, ORIGIN, request, TINY_JPEG_B64, v1Fixture } from '../helpers/index.js';

vi.mock('../../../shared/planner.js', async () => (await import('../helpers/fake-shared.js')).fakePlanner());
vi.mock('../../../shared/ids.js', async () => (await import('../helpers/fake-shared.js')).fakeIds());
vi.mock('../../../shared/validation.js', async () => (await import('../helpers/fake-shared.js')).fakeValidation());
vi.mock('../../src/studio-handlers.js', () => ({ assets: {}, gallery: {}, links: {}, mounts: {}, designs: {}, jobs: {}, spend: {}, processor: {}, studioCron: async () => {} }));

const migrate = async env => (await worker.fetch(request('POST', '/api/admin/migrate-legacy', { actor: ADMIN, origin: ORIGIN }), env)).json();
const seeded = () => makeEnv({ kv: { allocations: v1Fixture(), images: imagesFixture() } });
const count = async (env, sql) => (await env.DB.prepare(sql).first()).n;

describe('POST /api/admin/migrate-legacy', () => {
  it('is admin-only', async () => {
    const env = seeded();
    expect((await worker.fetch(request('POST', '/api/admin/migrate-legacy', { actor: EDITOR, origin: ORIGIN }), env)).status).toBe(403);
    expect((await worker.fetch(request('POST', '/api/admin/migrate-legacy', { origin: ORIGIN }), env)).status).toBe(401);
  });

  it('round-trips a synthetic v1 KV document and images with matching counts', async () => {
    const env = seeded();
    const out = await migrate(env);
    expect(out.done).toBe(true);
    const { before, after } = out.report;
    expect(before).toEqual({ compartments: 11, occupiedSlots: 4, equipment: 2, bundles: 1, uploadedImages: 3, featured: 3 });
    expect(after).toEqual({ ...before, featured: 2 }); // LS3 preset path does not exist -> skipped
    expect(out.report.skipped).toEqual([{ compId: 'LS3', reason: 'featured image not resolvable' }]);

    const doc = JSON.parse((await env.DB.prepare("SELECT doc FROM planner_doc WHERE id='main'").first()).doc);
    expect(doc.schema).toBe(2);
    expect(doc.allocations.LS1.slice(0, 2)).toEqual(['1 Ton Griphoist', 'Custom Wrench']);
    expect(doc.bundles.LS1[0].slotIndices).toEqual([0, 1]);
    expect(doc._serverTs).toBeUndefined();

    const assets = (await env.DB.prepare('SELECT * FROM assets ORDER BY legacy_uid').all()).results;
    expect(assets.map(a => [a.legacy_uid, a.compartment_id, a.title, a.category, a.provenance, a.visibility, a.status]))
      .toEqual([
        ['u-1', 'LS1', 'Front', 'legacy_upload', 'legacy_upload', 'public', 'committed'],
        ['u-2', 'LS1', 'Side', 'legacy_upload', 'legacy_upload', 'public', 'committed'],
        ['u-3', 'RS2', 'Right', 'legacy_upload', 'legacy_upload', 'public', 'committed'],
      ]);
    const [a1, a2] = assets;
    expect(a1.original_key).toBe(a1.display_key);
    expect(a1.original_key).toBe(a1.thumb_key);
    expect(a1.original_key).toMatch(new RegExp(`^assets/LS1/${a1.id}/original\\.jpg$`));
    expect(a2.original_key).toMatch(/original\.png$/);
    const obj = await env.ASSETS.get(a1.original_key);
    expect(obj.httpMetadata.contentType).toBe('image/jpeg');
    expect(Buffer.from(await obj.arrayBuffer()).toString('base64')).toBe(TINY_JPEG_B64);
    expect(a1.bytes).toBe(Buffer.from(TINY_JPEG_B64, 'base64').length);

    const mains = (await env.DB.prepare('SELECT compartment_id, kind, ref FROM main_images ORDER BY compartment_id').all()).results;
    expect(mains).toEqual([
      { compartment_id: 'LS1', kind: 'asset', ref: a2.id },
      { compartment_id: 'LS2', kind: 'preset', ref: '/images/LS2_rendering.webp' },
    ]);
    const admins = await env.DB.prepare("SELECT value, revision FROM settings WHERE key='access.admins'").first();
    expect(admins).toEqual({ value: '["owner@example.com"]', revision: 1 });
    expect(await count(env, "SELECT COUNT(*) n FROM settings_history WHERE key='access.admins'")).toBe(1);
    expect(env.L1_STATE.writes).toEqual([]); // KV is never written
    expect(env.L1_STATE.values.size).toBe(2);
  });

  it('backs up both KV documents to R2 once per content hash', async () => {
    const env = seeded();
    await migrate(env);
    const keys = () => [...env.ASSETS.store.keys()].filter(k => k.startsWith('backups/kv/'));
    expect(keys()).toHaveLength(2);
    expect(keys().some(k => k.endsWith('/allocations.json'))).toBe(true);
    expect(keys().some(k => k.endsWith('/images.json'))).toBe(true);
  });

  it('is idempotent: a second run changes nothing and reports the same counts', async () => {
    const env = seeded();
    const first = await migrate(env);
    const snapshot = async () => JSON.stringify([
      (await env.DB.prepare('SELECT id, legacy_uid FROM assets ORDER BY id').all()).results,
      (await env.DB.prepare('SELECT * FROM main_images ORDER BY compartment_id').all()).results,
      (await env.DB.prepare('SELECT * FROM planner_doc').all()).results,
      [...env.ASSETS.store.keys()].sort(),
    ]);
    const before = await snapshot();
    const second = await migrate(env);
    expect(await snapshot()).toBe(before);
    expect(second.report.before).toEqual(first.report.before);
    expect(second.report.after).toEqual(first.report.after);
    expect(second.report.backups.map(b => b.status)).toEqual(['exists', 'exists']);
  });

  it('does not overwrite a planner doc that already moved past revision 1', async () => {
    const env = seeded();
    await migrate(env);
    await env.DB.prepare("UPDATE planner_doc SET revision = 7 WHERE id='main'").run();
    await migrate(env);
    expect((await env.DB.prepare("SELECT revision FROM planner_doc").first()).revision).toBe(7);
  });

  it('is resumable: large image sets are imported in chunks (done:false, next)', async () => {
    const uploaded = { LS1: Array.from({ length: 14 }, (_, i) => ({ uid: `bulk-${i}`, title: `P${i}`, dataUrl: `data:image/jpeg;base64,${TINY_JPEG_B64}` })) };
    const env = makeEnv({ kv: { allocations: v1Fixture(), images: { uploadedImages: uploaded, featuredImages: {} } } });
    const r1 = await migrate(env);
    expect(r1).toMatchObject({ done: false, next: 8, processed: 6 });
    expect(await count(env, 'SELECT COUNT(*) n FROM assets')).toBe(6);
    const r2 = await migrate(env);
    expect(r2).toMatchObject({ done: false, next: 2 });
    const r3 = await migrate(env);
    expect(r3.done).toBe(true);
    expect(r3.report.after.uploadedImages).toBe(14);
    expect(await count(env, 'SELECT COUNT(*) n FROM assets')).toBe(14);
  });

  it('skips images whose bytes are not a real image (magic bytes) and unknown compartments', async () => {
    const bad = `data:image/png;base64,${btoa('this is not a png at all, just text')}`;
    const env = makeEnv({ kv: { allocations: v1Fixture(), images: { uploadedImages: { LS1: [{ uid: 'bad', dataUrl: bad }], NOPE: [{ uid: 'x', dataUrl: `data:image/jpeg;base64,${TINY_JPEG_B64}` }] }, featuredImages: {} } } });
    const out = await migrate(env);
    expect(out.done).toBe(true);
    expect(out.report.skipped.map(s => s.uid).sort()).toEqual(['bad', 'x']);
    expect(await count(env, 'SELECT COUNT(*) n FROM assets')).toBe(0);
    expect([...env.ASSETS.store.keys()].filter(k => k.startsWith('assets/'))).toEqual([]);
  });

  it('works with empty KV (fresh install) and does not reseed admins that already exist', async () => {
    const env = makeEnv();
    await env.DB.prepare("INSERT INTO settings (key, value, revision, updated_at) VALUES ('access.admins', '[\"x@y.z\"]', 3, 0)").run();
    const out = await migrate(env);
    expect(out.done).toBe(true);
    expect(out.report.before).toMatchObject({ compartments: 0, occupiedSlots: 0 });
    expect((await env.DB.prepare("SELECT revision FROM settings WHERE key='access.admins'").first()).revision).toBe(3);
    expect(await count(env, "SELECT COUNT(*) n FROM planner_doc")).toBe(1);
  });

  it('GET /api/admin/migration-report returns the stored report', async () => {
    const env = seeded();
    const none = await (await worker.fetch(request('GET', '/api/admin/migration-report', { actor: ADMIN }), env)).json();
    expect(none).toMatchObject({ migrated: false, report: null });
    await migrate(env);
    const got = await (await worker.fetch(request('GET', '/api/admin/migration-report', { actor: ADMIN }), env)).json();
    expect(got.migrated).toBe(true);
    expect(got.report.after.uploadedImages).toBe(3);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='migration.legacy'").first()).n).toBe(1);
  });
});
