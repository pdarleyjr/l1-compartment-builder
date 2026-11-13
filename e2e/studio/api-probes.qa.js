// Adversarial API probes against the real Worker (editor identity, not admin). Each asserts the SAFE behaviour; a probe that finds a
// backend/shared bug is marked test.fail() and described in docs/qa/findings.md.
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { EDITOR_ACTOR } from '../helpers/real-backend/ports.mjs';
import { ensureVersion, versionsOf, mainOf, syntheticPhoto } from './lib.js';

const as = { headers: { 'X-Test-Actor': EDITOR_ACTOR } };
const json = (data, extra = {}) => ({ ...as, headers: { ...as.headers, ...extra }, data });

test.describe('editor-level probes', () => {
  test.beforeEach(({ browserName }, testInfo) => { test.skip(browserName !== "chromium" || testInfo.project.name !== "desktop", "API probes are viewport independent; run once"); });
  test('an editor cannot reach processor or admin routes', async ({ request }) => {
    expect((await request.post('/api/processor/claim', as)).status()).toBe(403);
    expect((await request.get('/api/admin/settings', as)).status()).toBe(403);
    expect((await request.post('/api/admin/migrate-legacy', as)).status()).toBe(403);
    expect((await request.put('/api/admin/settings/ai.enabled', json({ value: false, expectRevision: 1 }))).status()).toBe(403);
  });

  test('a version of one compartment cannot be published or edited from another', async ({ request }) => {
    await ensureVersion(request, 'LS2');
    const foreign = (await versionsOf(request, 'LS2'))[0];
    const mainBefore = await mainOf(request, 'LS1');
    const pub = await request.post('/api/compartments/LS1/main-image', json({ kind: 'version', ref: foreign.id, expectRevision: mainBefore?.revision ?? 0, acknowledgeStale: true }));
    expect(pub.status()).toBeGreaterThanOrEqual(400);
    expect(pub.status()).toBeLessThan(500);
    expect(await mainOf(request, 'LS1')).toEqual(mainBefore);
    const job = await request.post('/api/compartments/LS1/jobs', json({ kind: 'render', mode: 'edit', preset: 'preview', parentVersionId: foreign.id, instructions: 'x' }, { 'Idempotency-Key': `qa-foreign-${Date.now()}` }));
    expect(job.status()).toBeGreaterThanOrEqual(400);
    expect(job.status()).toBeLessThan(500);
  });

  test('a preset main image must be a known static path (no traversal, no external URL)', async ({ request }) => {
    for (const ref of ['/images/../../etc/passwd', 'https://evil.example/x.png', '//evil.example/x.png', '/api/assets/x/original']) {
      const r = await request.post('/api/compartments/RS1/main-image', json({ kind: 'preset', ref, expectRevision: 0 }));
      expect(r.status(), ref).toBeGreaterThanOrEqual(400);
      expect(r.status(), ref).toBeLessThan(500);
    }
  });

  test('uploads are verified by content, not by declared type', async ({ request }) => {
    const created = await request.post('/api/assets', json({ compartmentId: 'RS1', category: 'other', width: 10, height: 10, bytes: 20, sha256: 'a'.repeat(64), idempotencyKey: `qa-probe-${Date.now()}` }));
    expect(created.status()).toBe(201);
    const { asset } = await created.json();
    const text = await request.put(`/api/assets/${asset.id}/original`, { headers: { 'X-Test-Actor': EDITOR_ACTOR, 'Content-Type': 'image/jpeg' }, data: Buffer.from('<script>alert(1)</script>') });
    expect(text.status()).toBeGreaterThanOrEqual(400);
    expect(text.status()).toBeLessThan(500);
    const html = await request.put(`/api/assets/${asset.id}/original`, { headers: { 'X-Test-Actor': EDITOR_ACTOR, 'Content-Type': 'text/html' }, data: await syntheticPhoto() });
    expect(html.status()).toBe(415);
    await request.delete(`/api/assets/${asset.id}`, as);
  });

  test('job input limits: over-long instructions and unknown presets are refused', async ({ request }) => {
    const long = await request.post('/api/compartments/RS1/jobs', json({ kind: 'render', mode: 'plan', preset: 'preview', instructions: 'x'.repeat(2001) }, { 'Idempotency-Key': `qa-long-${Date.now()}` }));
    expect(long.status()).toBe(400);
    const preset = await request.post('/api/compartments/RS1/jobs', json({ kind: 'render', mode: 'plan', preset: 'gpt-image-2.6-sunburst' }, { 'Idempotency-Key': `qa-preset-${Date.now()}` }));
    expect(preset.status()).toBe(400);
    const missingKey = await request.post('/api/compartments/RS1/jobs', json({ kind: 'render', mode: 'plan', preset: 'preview' }));
    expect(missingKey.status()).toBe(400);
  });

  test('public asset URLs never serve private photos or the original', async ({ request }) => {
    const anon = { headers: { 'X-Test-Actor': '' } };
    const photo = await syntheticPhoto();
    const created = await request.post('/api/assets', json({ compartmentId: 'RS1', category: 'other', width: 800, height: 600, bytes: photo.length, sha256: createHash('sha256').update(photo).digest('hex'), idempotencyKey: `qa-private-${Date.now()}` }));
    expect(created.status()).toBe(201);
    const { asset } = await created.json();
    for (const v of ['original', 'display', 'thumb']) expect((await request.put(`/api/assets/${asset.id}/${v}`, { headers: { 'X-Test-Actor': EDITOR_ACTOR, 'Content-Type': 'image/jpeg' }, data: photo })).status()).toBe(204);
    expect((await request.post(`/api/assets/${asset.id}/commit`, json({}))).status()).toBe(200);
    for (const v of ['original', 'display', 'thumb']) expect((await request.get(`/api/public/assets/${asset.id}/${v}`, anon)).status(), `private ${v}`).toBeGreaterThanOrEqual(400);
    expect((await request.get(`/api/assets/${asset.id}/display`, anon)).status()).toBe(401);
    expect((await request.get(`/api/assets/${asset.id}/display`, as)).status()).toBe(200);
    await request.delete(`/api/assets/${asset.id}`, as);
  });
});
