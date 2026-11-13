// Full-stack harness: the REAL Worker (worker/index.js) on the node:sqlite D1 fake + in-memory R2/KV fakes, driven through
// worker.fetch like a browser ("device") or like the AIW processor (service actor). Nothing in shared/** or worker/src/** is
// mocked. The only fakes are infrastructure (D1/R2/KV) and the OpenAI HTTP server (node:http).
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
import worker from '../../worker/index.js';
import { imagesFixture, makeEnv, ORIGIN, TINY_JPEG_B64, v1Fixture } from '../../worker/test/helpers/index.js';
import { createProcessor } from '../../processor/src/index.js';
import { createLogger } from '../../processor/src/logger.js';

export { ORIGIN, TINY_JPEG_B64, imagesFixture, v1Fixture, worker };

export const EDITOR = 'user:editor@example.com';
export const EDITOR_B = 'user:second@example.com';
export const ADMIN = 'user:owner@example.com,admin';
export const SERVICE = 'service:l1-image-processor';

// Real (tiny) image bytes. JPEG original + lossy 1x1 WebP derivatives (display/thumb accept WebP or JPEG).
export const JPEG = new Uint8Array(Buffer.from(TINY_JPEG_B64, 'base64'));
export const WEBP = new Uint8Array(Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** A fresh Worker environment (AUTH_MODE=test, ENVIRONMENT=development) with the legacy KV documents seeded. */
export function createStack({ kv = { allocations: v1Fixture(), images: imagesFixture() }, env: extra = {} } = {}) {
  const env = makeEnv({ kv, ENVIRONMENT: 'development', AUTH_MODE: 'test', ...extra });
  return { env, worker, sql: env.DB.raw };
}

/** @typedef {{status:number, body:any, text:string, headers:Headers, res:Response}} Reply */

/** A browser-like client acting as `actor` (X-Test-Actor header value). */
export function device(stack, actor = EDITOR, { host = 'l1.test' } = {}) {
  /** @returns {Promise<Reply>} */
  async function call(method, path, { json, body, headers = {}, actor: as = actor, noOrigin = false } = {}) {
    const h = { ...headers };
    if (as) h['X-Test-Actor'] = as;
    if (!noOrigin && method !== 'GET' && !h.Origin) h.Origin = ORIGIN;
    let payload = body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
    const res = await stack.worker.fetch(new Request(`https://${host}${path}`, { method, headers: h, body: payload }), stack.env);
    const buf = res.status === 204 || res.status === 304 ? '' : await res.clone().text();
    let parsed = null;
    try { parsed = buf ? JSON.parse(buf) : null; } catch { /* binary or empty */ }
    return { status: res.status, body: parsed, text: buf, headers: res.headers, res };
  }
  return {
    call,
    get: (path, o) => call('GET', path, o),
    post: (path, json, o) => call('POST', path, { json, ...o }),
    put: (path, json, o) => call('PUT', path, { json, ...o }),
    patch: (path, json, o) => call('PATCH', path, { json, ...o }),
    del: (path, o) => call('DELETE', path, o),
    putBytes: (path, bytes, type = 'image/jpeg', o) => call('PUT', path, { body: bytes, headers: { 'Content-Type': type }, ...o }),
  };
}

/** Run /api/admin/migrate-legacy until it reports done (it works in chunks). @returns {Promise<{runs:number, last:any}>} */
export async function migrateUntilDone(admin) {
  let runs = 0; let last;
  do {
    const r = await admin.post('/api/admin/migrate-legacy');
    if (r.status !== 200) throw new Error(`migrate failed ${r.status} ${r.text}`);
    last = r.body; runs += 1;
  } while (!last.done && runs < 50);
  return { runs, last };
}

/** Current planner document as a browser sees it: {revision, migrated, doc}. */
export async function plannerOf(dev) {
  const r = await dev.get('/api/public/planner');
  if (r.status !== 200) throw new Error(`planner ${r.status}`);
  return r.body;
}

/** Create → PUT original/display/thumb → commit. Returns the commit reply and the asset id. */
export async function uploadPhoto(dev, { compartmentId = 'LS1', category = 'tool', title, key, commit = {} } = {}) {
  const idempotencyKey = key ?? `up-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const created = await dev.post('/api/assets', { compartmentId, category, ...(title ? { title } : {}), width: 1, height: 1, bytes: JPEG.length, sha256: sha256(JPEG), idempotencyKey });
  if (created.status !== 201) throw new Error(`create asset ${created.status} ${created.text}`);
  const { asset, upload } = created.body;
  for (const [variant, bytes, type] of [['original', JPEG, 'image/jpeg'], ['display', WEBP, 'image/webp'], ['thumb', WEBP, 'image/webp']]) {
    const put = await dev.putBytes(upload[variant], bytes, type);
    if (put.status !== 204) throw new Error(`put ${variant} ${put.status} ${put.text}`);
  }
  const committed = await dev.post(`/api/assets/${asset.id}/commit`, commit);
  return { assetId: asset.id, committed, created };
}

// ── OpenAI stand-in (node:http) ──────────────────────────────────────────────────────────────────────────────────────
/**
 * @param {{png?:Buffer, usage?:object, recognition?:(catalogue:{equipmentId:string,name:string}[])=>object, onImage?:()=>void}} [o]
 * @returns {Promise<{baseUrl:string, calls:{path:string, contentType:string, body:Buffer}[], close:()=>Promise<void>}>}
 */
export async function startMockOpenAI(o = {}) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      calls.push({ path: req.url, contentType: req.headers['content-type'] || '', auth: req.headers.authorization, body });
      const send = (status, payload) => { res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': `req_mock_${calls.length}` }); res.end(JSON.stringify(payload)); };
      if (req.url.endsWith('/images/edits') || req.url.endsWith('/images/generations')) {
        o.onImage?.();
        return send(200, {
          created: 1_700_000_000, size: '1536x1024', output_format: 'jpeg', quality: 'low',
          data: [{ b64_json: o.png.toString('base64') }],
          usage: o.usage ?? { total_tokens: 100, input_tokens: 50, output_tokens: 50, input_tokens_details: { text_tokens: 10, image_tokens: 40 } },
        });
      }
      if (req.url.endsWith('/responses')) {
        const text = JSON.parse(body.toString('utf8')).input[0].content[0].text;
        const catalogue = [...text.matchAll(/^(eq_[0-9a-z]+): (.+)$/gm)].map(m => ({ equipmentId: m[1], name: m[2] }));
        const parsed = o.recognition?.(catalogue) ?? { objects: [] };
        return send(200, {
          id: 'resp_mock', status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(parsed) }] }],
          usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 0 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1280 },
        });
      }
      return send(404, { error: { code: 'not_found', message: 'mock' } });
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}/v1`, calls, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}

/** A real 640x480 JPEG, standing in for the model's output. */
export async function makeOutputImage() {
  const sharp = createRequire(new URL('../../processor/package.json', import.meta.url))('sharp');
  return sharp({ create: { width: 640, height: 480, channels: 3, background: '#b02a2a' } }).jpeg().toBuffer();
}

// ── Processor (the real job-runner, in-process) ──────────────────────────────────────────────────────────────────────
/**
 * Run the real processor (processor/src) once against the Worker through a fetch shim that authenticates as the service
 * actor. `onRequest(url, init)` may act between processor calls (e.g. a user cancelling) before the request is forwarded.
 * @returns {Promise<{requests:{method:string, path:string, headers:object}[], logs:string[], claims:object[]}>} claims = every 200 claim body
 */
export async function runProcessorOnce(stack, { openaiBase, kinds = ['render', 'recognize'], node = 'k8-test', onRequest } = {}) {
  const requests = []; const logs = []; const claims = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    requests.push({ method: init.method ?? 'GET', path: u.pathname + u.search, headers: { ...init.headers } });
    await onRequest?.(u, init);
    const headers = { ...init.headers, 'X-Test-Actor': SERVICE };
    const res = await stack.worker.fetch(new Request(url, { ...init, headers }), stack.env);
    if (u.pathname === '/api/processor/claim' && res.status === 200) claims.push(await res.clone().json());
    return res;
  };
  const config = {
    apiBase: 'http://worker.test', accessClientId: 'id.access', accessClientSecret: 'synthetic-secret', openaiKey: 'sk-synthetic-test-key',
    nodeName: node, kinds, maxParallel: 1, openaiBase, dryRun: false,
  };
  const p = createProcessor(config, {
    logger: createLogger({ write: line => logs.push(line) }), apiOpts: { fetchImpl, retries: 0 }, heartbeatMs: 3_600_000,
  });
  await p.loop({ once: true });
  await p.shutdown();
  return { requests, logs, claims };
}

/** Raw single-row helpers for assertions. */
export const one = (stack, sql, ...args) => stack.sql.prepare(sql).get(...args) ?? null;
export const all = (stack, sql, ...args) => stack.sql.prepare(sql).all(...args);

/** A real PNG (transparent markup layer stand-in). */
export async function makePng(width = 8, height = 6) {
  const sharp = createRequire(new URL('../../processor/package.json', import.meta.url))('sharp');
  return sharp({ create: { width, height, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.4 } } }).png().toBuffer();
}

/**
 * Route the browser's relative `fetch('/api/...')` (src/lib/api.js) to the real Worker as `actor`, so the actual UI client
 * modules (api.js, jobs.js, gallery.js, session.js, markupUpload.js …) can be exercised against the real handlers.
 * @returns {() => void} restore function
 */
export function installBrowserFetch(stack, actor = EDITOR) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const headers = { ...(init.headers || {}), ...(actor ? { 'X-Test-Actor': actor } : {}) };
    if (init.method && init.method !== 'GET') headers.Origin = ORIGIN;
    return stack.worker.fetch(new Request(new URL(url, ORIGIN), { ...init, headers }), stack.env);
  };
  return () => { globalThis.fetch = original; };
}
