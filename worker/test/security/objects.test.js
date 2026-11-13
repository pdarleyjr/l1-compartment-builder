// Security review 2026-11 — object access and media handling: IDOR, private-vs-public, R2 keys, content sniffing / stored XSS,
// serving headers, size and pixel caps, and the legacy workers.dev host.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN, createStack, device, JPEG, migrateUntilDone, ORIGIN, one, sha256, uploadPhoto, v1Fixture, WEBP } from '../../../tests/integration/harness.js';

const EDITOR_A = 'user:alice@example.com';
const EDITOR_B = 'user:bob@example.com';
let stack; let alice; let bob; let admin; let anon; let baseline;
/** R2 keys written since the test started (the legacy migration seeds a few). */
const stored = () => [...stack.env.ASSETS.store.keys()].filter(k => !baseline.has(k));
beforeEach(async () => {
  stack = createStack({ kv: { allocations: v1Fixture() } }); // no legacy images: R2 and galleries start empty
  alice = device(stack, EDITOR_A); bob = device(stack, EDITOR_B); admin = device(stack, ADMIN); anon = device(stack, null);
  await migrateUntilDone(admin);
  baseline = new Set(stack.env.ASSETS.store.keys());
});

const ascii = (u8, at, text) => { for (let i = 0; i < text.length; i++) u8[at + i] = text.charCodeAt(i); };
const pngBomb = (w, h) => { const b = new Uint8Array(48); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); ascii(b, 12, 'IHDR'); new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h); return b; };
const jpegBomb = (w, h) => { const b = new Uint8Array(32); b.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3], 0); return b; };
const webpBomb = (w, h) => { const b = new Uint8Array(40); ascii(b, 0, 'RIFF'); ascii(b, 8, 'WEBP'); ascii(b, 12, 'VP8X'); b[24] = (w - 1) & 255; b[25] = ((w - 1) >> 8) & 255; b[26] = (w - 1) >> 16; b[27] = (h - 1) & 255; b[28] = ((h - 1) >> 8) & 255; b[29] = (h - 1) >> 16; return b; };
const enc = text => new TextEncoder().encode(text);

async function pendingAsset(dev, bytes, { compartmentId = 'LS1', category = 'tool' } = {}) {
  const r = await dev.post('/api/assets', { compartmentId, category, width: 1, height: 1, bytes: bytes.length, sha256: sha256(bytes), idempotencyKey: `k-${Math.random().toString(36).slice(2)}-xx` });
  expect(r.status).toBe(201);
  return r.body;
}

describe('IDOR: acting on another editor\'s records', () => {
  it('only the uploader (or an admin) may upload to / commit a pending asset', async () => {
    const { asset, upload } = await pendingAsset(alice, JPEG);
    expect((await bob.putBytes(upload.original, JPEG)).status).toBe(403);
    expect((await bob.post(`/api/assets/${asset.id}/commit`, {})).status).toBe(403);
    expect((await alice.putBytes(upload.original, JPEG)).status).toBe(204);
    expect((await admin.putBytes(upload.display, WEBP, 'image/webp')).status).toBe(204);
    expect(one(stack, 'SELECT COUNT(*) n FROM audit_log WHERE actor = ?', 'bob@example.com').n).toBe(0);
  });

  it('idempotency keys are per user: a key used by Alice cannot read or replay for Bob', async () => {
    const first = await alice.post('/api/assets', { compartmentId: 'LS1', category: 'tool', width: 1, height: 1, bytes: JPEG.length, sha256: sha256(JPEG), idempotencyKey: 'shared-key-0001' });
    const second = await bob.post('/api/assets', { compartmentId: 'LS1', category: 'tool', width: 1, height: 1, bytes: JPEG.length, sha256: sha256(JPEG), idempotencyKey: 'shared-key-0001' });
    expect(second.status).toBe(201);
    expect(second.body.asset.id).not.toBe(first.body.asset.id);
    expect(second.body.replayed).toBeUndefined();
  });

  it('cancel and retry of a generation job are restricted to its requester (or an admin)', async () => {
    const aliceJob = 'gj_00000000000000000000aaaaaa';
    stack.sql.prepare(
      `INSERT INTO generation_jobs (id, compartment_id, kind, mode, preset, model, quality, size, idempotency_key, requested_by, status, spec, spec_hash, prompt, attempts, max_attempts, estimated_cost_usd, created_at, updated_at)
       VALUES (?, 'LS1', 'render', 'plan', 'preview', 'gpt-image-1', 'low', '1024x1024', 'idem-key-1', 'alice@example.com', 'queued', '{}', 'h', 'p', 0, 3, 0.1, 1, 1)`,
    ).run(aliceJob);
    expect((await bob.post(`/api/jobs/${aliceJob}/cancel`)).status).toBe(403);
    expect((await bob.post(`/api/jobs/${aliceJob}/retry`)).status).toBe(403);
    expect(one(stack, 'SELECT status FROM generation_jobs WHERE id = ?', aliceJob).status).toBe('queued');
    expect((await alice.post(`/api/jobs/${aliceJob}/cancel`)).status).toBe(200);
  });

  it('records cannot be tied across compartments: mount links, asset links and job references', async () => {
    const { assetId: ls2Photo } = await uploadPhoto(alice, { compartmentId: 'LS2' });
    const mount = await alice.post('/api/compartments/LS1/mounts', { name: 'Bracket', classification: 'mounting', links: [{ targetType: 'asset', targetId: ls2Photo }] });
    expect(mount.status).toBe(400);
    const own = await alice.post('/api/compartments/LS1/mounts', { name: 'Bracket', classification: 'mounting' });
    expect(own.status).toBe(201);
    expect((await alice.patch(`/api/mounts/${own.body.mount.id}`, { expectRevision: own.body.mount.revision, links: [{ targetType: 'asset', targetId: ls2Photo }] })).status).toBe(400);
    // main image of LS1 cannot point at an LS2 photo
    expect((await alice.post('/api/compartments/LS1/main-image', { kind: 'asset', ref: ls2Photo })).status).toBe(400);
  });
});

describe('public asset endpoint exposes only public + committed display/thumb', () => {
  it('private, pending and deleted assets are 404 and indistinguishable from unknown ids', async () => {
    const { assetId } = await uploadPhoto(alice, {});
    const { asset } = await pendingAsset(alice, JPEG);
    const unknown = await anon.get('/api/public/assets/ast_0000000000000000000000zzzz/display');
    for (const id of [assetId, asset.id]) {
      const r = await anon.get(`/api/public/assets/${id}/display`);
      expect(r.status).toBe(404);
      expect(r.text).toBe(unknown.text);
    }
    // editor route requires auth
    expect((await anon.get(`/api/assets/${assetId}/display`)).status).toBe(401);
    expect((await alice.get(`/api/assets/${assetId}/display`)).status).toBe(200);
  });

  it('a public asset serves display/thumb but never the full-size original (EXIF/GPS, 25 MB)', async () => {
    const { assetId } = await uploadPhoto(alice, {});
    expect((await alice.post('/api/compartments/LS1/main-image', { kind: 'asset', ref: assetId })).status).toBe(200);
    expect((await anon.get(`/api/public/assets/${assetId}/display`)).status).toBe(200);
    expect((await anon.get(`/api/public/assets/${assetId}/thumb`)).status).toBe(200);
    expect((await anon.get(`/api/public/assets/${assetId}/original`)).status).toBe(404);
    expect((await anon.get(`/api/public/assets/${assetId}/other`)).status).toBe(404);
  });

  it('public gallery and main-image payloads do not expose author e-mails or private assets', async () => {
    const { assetId } = await uploadPhoto(alice, {});
    await alice.post('/api/compartments/LS1/main-image', { kind: 'asset', ref: assetId });
    await uploadPhoto(alice, { title: 'private one' });
    const g = await anon.get('/api/public/compartments/LS1/gallery');
    expect(g.text).not.toMatch(/alice@example\.com/);
    expect(g.body.items.filter(i => i.kind === 'asset')).toHaveLength(1);
    expect((await anon.get('/api/public/main-images')).text).not.toMatch(/alice@example\.com/);
  });
});

describe('R2 keys come from server-held ids only', () => {
  it('path-traversal style ids and variants never reach R2 and yield 404', async () => {
    const get = vi.spyOn(stack.env.ASSETS, 'get');
    for (const id of ['..%2F..%2Fsecret', '%2e%2e%2fsecret', 'ast_x%2F..%2F..%2Fetc', '..', '%00', 'assets%2FLS1%2Fast_x%2Foriginal.jpg']) {
      for (const base of ['/api/public/assets', '/api/assets']) {
        const r = await alice.get(`${base}/${id}/display`);
        expect([404, 400], `${base}/${id}`).toContain(r.status);
      }
    }
    for (const variant of ['..%2Foriginal', 'original.jpg', 'ORIGINAL', 'display%00']) expect((await alice.get(`/api/assets/ast_0000000000000000000000aaaa/${variant}`)).status).toBe(404);
    expect(get).not.toHaveBeenCalled();
  });

  it('stored keys are assets/<compartment>/<asset id>/<variant>.<ext> built from the sniffed type, never from client names', async () => {
    const { asset, upload } = await pendingAsset(alice, JPEG);
    await alice.call('PUT', upload.original, { body: JPEG, headers: { 'Content-Type': 'image/jpeg', 'Content-Disposition': 'attachment; filename="../../evil.html"', 'X-File-Name': '../../evil.html' } });
    expect(stored()).toEqual([`assets/LS1/${asset.id}/original.jpg`]);
    expect((await alice.post('/api/assets', { compartmentId: '../LS1', category: 'tool', width: 1, height: 1, bytes: 1, sha256: sha256(JPEG), idempotencyKey: 'trav-key-0001' })).status).toBe(400);
  });
});

describe('content sniffing and stored XSS', () => {
  const html = enc('<!doctype html><html><body><script>fetch("/api/admin/settings")</script></body></html>');
  const svg = enc('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
  const gif = enc('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;;;;;;;;;;;;');
  const cases = [['HTML as image/jpeg', html, 'image/jpeg'], ['HTML as image/png', html, 'image/png'], ['SVG as image/svg+xml', svg, 'image/svg+xml'],
    ['SVG as image/png', svg, 'image/png'], ['SVG with no content type', svg, null], ['GIF', gif, 'image/gif'], ['text/html content type with JPEG bytes', JPEG, 'text/html']];
  for (const [label, bytes, type] of cases) {
    it(`rejects ${label} with 415 and stores nothing`, async () => {
      const { upload } = await pendingAsset(alice, bytes);
      const r = await alice.call('PUT', upload.original, { body: bytes, headers: type ? { 'Content-Type': type } : {} });
      expect(r.status).toBe(415);
      expect(stored()).toEqual([]);
    });
  }

  it('markup layers may be PNG; display/thumb must be WebP or JPEG; an HTML-in-WebP-wrapper is refused', async () => {
    const polyglotHtml = enc('RIFF....WEBP<script>alert(1)</script>');
    const { upload } = await pendingAsset(alice, JPEG);
    expect((await alice.putBytes(upload.display, polyglotHtml, 'image/webp')).status).toBe(415);
  });

  it('a JPEG with trailing script is served as inert image/jpeg: nosniff, sandboxing CSP, no-store (editor) / immutable (public)', async () => {
    const poly = new Uint8Array([...JPEG, ...enc('<script>alert(1)</script>')]);
    const { asset, upload } = await pendingAsset(alice, poly);
    expect((await alice.putBytes(upload.original, poly)).status).toBe(204);
    await alice.putBytes(upload.display, WEBP, 'image/webp'); await alice.putBytes(upload.thumb, WEBP, 'image/webp');
    expect((await alice.post(`/api/assets/${asset.id}/commit`, {})).status).toBe(200);
    const priv = await alice.get(`/api/assets/${asset.id}/original`);
    expect(priv.headers.get('Content-Type')).toBe('image/jpeg');
    expect(priv.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(priv.headers.get('Content-Security-Policy')).toMatch(/default-src 'none'.*sandbox/);
    expect(priv.headers.get('Content-Disposition')).toMatch(/^inline/);
    expect(priv.headers.get('Cache-Control')).toBe('private, no-store');
    await alice.post('/api/compartments/LS1/main-image', { kind: 'asset', ref: asset.id });
    const pub = await anon.get(`/api/public/assets/${asset.id}/display`);
    expect(pub.status).toBe(200);
    expect(pub.headers.get('Content-Type')).toBe('image/webp');
    expect(pub.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(pub.headers.get('Content-Security-Policy')).toMatch(/sandbox/);
    expect(pub.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('the served Content-Type comes from the verified bytes, never from the declared one, and never from tampered metadata', async () => {
    const png = pngBomb(10, 10); // header-only PNG, tiny dimensions
    const { asset, upload } = await pendingAsset(alice, png);
    expect((await alice.putBytes(upload.original, png, 'image/jpeg')).status).toBe(204); // declared jpeg, really png
    expect(stored()).toEqual([`assets/LS1/${asset.id}/original.png`]);
    expect(stack.env.ASSETS.store.get(`assets/LS1/${asset.id}/original.png`).httpMetadata.contentType).toBe('image/png');
    // even if object metadata were ever tampered with, an active type is downgraded to an opaque download
    stack.env.ASSETS.store.get(`assets/LS1/${asset.id}/original.png`).httpMetadata.contentType = 'text/html';
    const r = await alice.get(`/api/assets/${asset.id}/original`);
    expect(r.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});

describe('size and pixel caps', () => {
  it('a body without Content-Length is cut off at the per-variant byte limit (thumb 512 KB) and nothing is stored', async () => {
    const { upload } = await pendingAsset(alice, JPEG);
    const chunk = new Uint8Array(64 * 1024).fill(0xff); chunk.set([0xff, 0xd8, 0xff, 0xe0]);
    let sent = 0;
    const body = new ReadableStream({ pull(c) { if (sent++ < 40) c.enqueue(chunk); else c.close(); } }); // 2.5 MB, unannounced
    const res = await stack.worker.fetch(new Request(`https://l1.test${upload.thumb}`, {
      method: 'PUT', body, duplex: 'half', headers: { 'X-Test-Actor': EDITOR_A, Origin: ORIGIN, 'Content-Type': 'image/jpeg' },
    }), stack.env);
    expect(res.status).toBe(413);
    expect(stored()).toEqual([]);
    expect(sent).toBeLessThan(20); // aborted early, not buffered to the end
  });

  it('a lying Content-Length (small) cannot smuggle a large body either', async () => {
    const { upload } = await pendingAsset(alice, JPEG);
    const big = new Uint8Array(700 * 1024).fill(1); big.set([0xff, 0xd8, 0xff, 0xe0]);
    const res = await stack.worker.fetch(new Request(`https://l1.test${upload.thumb}`, {
      method: 'PUT', body: big, headers: { 'X-Test-Actor': EDITOR_A, Origin: ORIGIN, 'Content-Type': 'image/jpeg', 'Content-Length': '10' },
    }), stack.env);
    expect([413, 400, 415]).toContain(res.status);
    expect(stored()).toEqual([]);
  });

  for (const [label, make] of [['PNG', pngBomb], ['JPEG', jpegBomb], ['WebP (VP8X)', webpBomb]]) {
    it(`${label} headers declaring 30000 x 30000 pixels (a decode bomb in a few bytes) are refused with 413`, async () => {
      const bomb = make(30000, 30000);
      const { upload } = await pendingAsset(alice, bomb);
      for (const variant of ['original', 'display', 'thumb']) {
        const r = await alice.putBytes(upload[variant], bomb, label.startsWith('WebP') ? 'image/webp' : label === 'PNG' ? 'image/png' : 'image/jpeg');
        expect([413, 415], variant).toContain(r.status); // display/thumb reject PNG by type, the rest by pixels
      }
      expect(stored()).toEqual([]);
    });
  }

  it('edges over 4096 are refused even when the pixel total is small, and a 4096 x 4096 original is accepted', async () => {
    const long = pngBomb(20000, 1);
    const a = await pendingAsset(alice, long);
    expect((await alice.putBytes(a.upload.original, long, 'image/png')).status).toBe(413);
    const ok = pngBomb(4096, 4096);
    const b = await pendingAsset(alice, ok);
    expect((await alice.putBytes(b.upload.original, ok, 'image/png')).status).toBe(204);
  });
});

describe('the legacy *.workers.dev host cannot write anything', () => {
  const legacy = () => device(stack, ADMIN, { host: 'l1-state-sync.example.workers.dev' });
  it('API routes do not exist there (even with a test actor header) and legacy writes answer 409 APP_UPDATED', async () => {
    const before = one(stack, 'SELECT COUNT(*) n FROM planner_history').n;
    const l = legacy();
    for (const [m, p] of [['POST', '/api/planner/ops'], ['POST', '/api/assets'], ['POST', '/api/admin/migrate-legacy'], ['PUT', '/api/admin/settings/ai.enabled'], ['POST', '/api/compartments/LS1/jobs']]) {
      const r = await l.call(m, p, { json: {}, headers: { Origin: 'https://l1.mbfdhub.com' } });
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    for (const p of ['/state', '/images', '/generate-image']) {
      const r = await l.call('PUT', p, { json: { allocations: {} }, headers: { Origin: 'https://l1.mbfdhub.com' } });
      expect([409, 405]).toContain(r.status);
    }
    expect((await l.call('POST', '/generate-image', { json: {}, headers: { Origin: 'https://l1.mbfdhub.com' } })).body.error.code).toBe('APP_UPDATED');
    expect((await l.call('PUT', '/state', { json: {}, headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect(one(stack, 'SELECT COUNT(*) n FROM planner_history').n).toBe(before);
    expect(one(stack, 'SELECT COUNT(*) n FROM assets').n).toBe(0);
  });
});

describe('API response headers', () => {
  it('every kind of API response carries nosniff, no-referrer, X-Frame-Options, HSTS and a locked-down CSP; JSON/errors are no-store', async () => {
    const replies = [
      await anon.get('/api/session'), await anon.get('/api/usage'), await alice.get('/api/nope'), await alice.call('DELETE', '/api/usage'),
      await alice.post('/api/assets', { nonsense: true }), await anon.get('/api/public/planner'), await alice.get('/api/auth/login'),
      await alice.get('/api/assets/ast_0000000000000000000000aaaa/original'), await alice.call('POST', '/api/planner/ops', { body: '{not json', headers: { 'Content-Type': 'application/json' } }),
    ];
    for (const r of replies) {
      expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(r.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(r.headers.get('X-Frame-Options')).toBe('DENY');
      expect(r.headers.get('Strict-Transport-Security')).toMatch(/max-age=\d{7,}/);
      expect(r.headers.get('Content-Security-Policy')).toMatch(/default-src 'none'/);
      expect(r.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('error bodies never echo stack traces, SQL or internals', async () => {
    stack.env.DB.prepare = () => { throw new Error('SQLITE_ERROR: no such table secret_table at /srv/worker/src/x.js:12'); };
    const r = await alice.get('/api/compartments/LS1/assets');
    expect(r.status).toBe(500);
    expect(r.text).not.toMatch(/SQLITE|secret_table|\/srv\/|\.js:/);
  });
});
