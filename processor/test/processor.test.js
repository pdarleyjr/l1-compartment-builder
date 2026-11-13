/* global Buffer, clearTimeout, setTimeout -- Node 22 runtime globals (AIW processor runs on Node, not in the browser/Worker) */
import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createApiClient } from '../src/api-client.js';
import { createOpenAiAdapter } from '../src/openai-adapter.js';
import { createProcessor } from '../src/index.js';
import { createJobRunner } from '../src/job-runner.js';
import { loadConfig, ConfigError, summarize } from '../src/config.js';
import { planReferences } from '../src/reference-plan.js';
import { buildContactSheet, normalizeReference, buildDerivatives } from '../src/image-prep.js';
import { SECRETS, png, jpeg, listen, send, parseMultipart, mockWorker, captureLogger, claimFor, config } from './support/helpers.js';

const b64 = buf => buf.toString('base64');
const imageResponse = async (extra = {}) => ({ created: 1, size: '1024x768', output_format: 'png', data: [{ b64_json: b64(await png(1024, 768)), revised_prompt: 'rp' }],
  usage: { input_tokens: 100, output_tokens: 300, total_tokens: 400, input_tokens_details: { text_tokens: 40, image_tokens: 60 } }, ...extra });

/** Mock OpenAI. `handler(req,res,parts?)`; records requests. */
async function mockOpenAi(handler) {
  const reqs = [];
  const srv = await listen(async (req, res) => { reqs.push(req); await handler(req, res, reqs.length); });
  return { ...srv, reqs };
}
async function setup({ worker, openai, hbMs = 20, adapterOver }) {
  const w = await mockWorker(worker);
  const o = openai ? await mockOpenAi(openai) : null;
  const cap = captureLogger();
  const api = createApiClient(config(w.url), { retryBaseMs: 1, retries: 1 });
  const adapter = adapterOver || createOpenAiAdapter({ apiKey: SECRETS.openai, baseUrl: o ? `${o.url}/v1` : 'http://127.0.0.1:1/v1', timeoutMs: 5000 });
  const runner = createJobRunner({ api, adapter, node: 'test-node', logger: cap.logger, heartbeatMs: hbMs, secrets: Object.values(SECRETS) });
  return { w, o, cap, runner, close: async () => { await w.close(); await o?.close(); } };
}

test('config: refuses to start without required vars and never prints values', () => {
  assert.throws(() => loadConfig({ L1_API_BASE: 'http://evil.example', L1_ACCESS_CLIENT_SECRET: 'topsecretvalue' }), e => e instanceof ConfigError
    && /L1_ACCESS_CLIENT_ID is required/.test(e.message) && /L1_OPENAI_API_KEY is required/.test(e.message) && /https/.test(e.message) && !/topsecretvalue/.test(e.message));
  const c = loadConfig({ L1_API_BASE: 'https://x.example/', L1_ACCESS_CLIENT_ID: 'a', L1_ACCESS_CLIENT_SECRET: 'b', L1_OPENAI_API_KEY: 'sk-k' });
  assert.deepEqual(c.kinds, ['render', 'recognize', 'verify']);
  assert.equal(c.maxParallel, 1);
  assert.doesNotMatch(JSON.stringify(summarize(c)), /sk-k|"b"/);
  assert.equal(loadConfig({ L1_API_BASE: 'https://x.example', L1_ACCESS_CLIENT_ID: 'a', L1_ACCESS_CLIENT_SECRET: 'b', L1_DRY_RUN: '1' }).dryRun, true);
});

test('render with references: multipart image[] parts, markup, upload variants, complete', async () => {
  const refA = await png(3000, 2000); const refB = await jpeg(100, 100); const mk = await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
  let parts;
  const s = await setup({
    worker: { assets: { a1: refA, a2: refB, m1: mk } },
    openai: async (req, res) => { parts = parseMultipart(req); send(res, 200, await imageResponse(), { 'x-request-id': 'req_abc' }); },
  });
  s.w.calls.length = 0;
  s.w.opts = null;
  const claim = claimFor(s.w.url, {}, [['a1', 'parent', 'Parent'], ['a2', 'tool', 'Halligan'], ['m1', 'markup', 'Markup']]);
  const h = s.runner.start(claim);
  assert.equal((await h.done).outcome, 'completed');
  assert.equal(s.o.reqs[0].url, '/v1/images/edits');
  assert.match(s.o.reqs[0].headers.authorization, /^Bearer sk-test/);
  const imgs = parts.filter(p => p.name === 'image[]');
  assert.equal(imgs.length, 2);
  const m0 = await sharp(imgs[0].data).metadata();
  assert.equal(Math.max(m0.width, m0.height), 2048); // long edge capped, parent first
  const mark = parts.find(p => p.name === 'markup');
  const mm = await sharp(mark.data).metadata();
  assert.deepEqual([mm.width, mm.height, mm.format], [m0.width, m0.height, 'png']);
  const fields = Object.fromEntries(parts.filter(p => !p.filename).map(p => [p.name, p.data.toString()]));
  assert.equal(fields.model, 'gpt-image-2.6-flare'); assert.equal(fields.size, '1024x768'); assert.equal(fields.quality, 'low'); assert.equal(fields.complexity, 'medium'); assert.equal(fields.output_format, 'png');
  // status order and output
  const statuses = s.w.calls.filter(c => c.json?.status).map(c => c.json.status);
  assert.ok(statuses.indexOf('generating') > statuses.indexOf('preparing') && statuses.indexOf('saving') > statuses.indexOf('generating'));
  assert.deepEqual(Object.keys(s.w.uploads).sort(), ['display', 'original', 'thumb']);
  assert.equal(s.w.uploads.display.type, 'image/webp');
  const dm = await sharp(s.w.uploads.display.data).metadata(); assert.ok(dm.width <= 1600 && dm.format === 'webp');
  const tm = await sharp(s.w.uploads.thumb.data).metadata(); assert.ok(tm.width <= 400);
  const done = s.w.find('complete').json;
  assert.deepEqual([done.node, done.actualCostUsd, done.providerRequestId, done.revisedPrompt, done.width, done.height], ['test-node', null, 'req_abc', 'rp', 1024, 768]);
  assert.equal(done.usage.output_tokens, 300);
  await s.close();
});

test('render without references uses generations (JSON)', async () => {
  let body;
  const s = await setup({ worker: {}, openai: async (req, res) => { body = JSON.parse(req.body.toString()); send(res, 200, await imageResponse()); } });
  const h = s.runner.start(claimFor(s.w.url));
  assert.equal((await h.done).outcome, 'completed');
  assert.equal(s.o.reqs[0].url, '/v1/images/generations');
  assert.equal(body.prompt, 'A tidy compartment'); assert.equal(body.model, 'gpt-image-2.6-flare'); assert.equal(body.output_format, 'png');
  await s.close();
});

test('recognize: structured output, candidate filtering, result posted', async () => {
  let reqBody;
  const s = await setup({
    worker: { assets: { subj: await png(200, 100) } },
    openai: (req, res) => {
      reqBody = JSON.parse(req.body.toString());
      const out = { objects: [{ label: 'axe', quantity: 2, region: { x: 0.1, y: 0.2, w: 2, h: 0.3 }, candidates: [{ equipmentId: 'eq_axe', confidence: 0.9 }, { equipmentId: 'eq_bogus', confidence: 0.8 }] }] };
      send(res, 200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(out) }] }], usage: { input_tokens: 10, output_tokens: 5 } }, { 'x-request-id': 'req_r' });
    },
  });
  const claim = claimFor(s.w.url, { job: { id: 'gj_rec', kind: 'recognize', model: 'gpt-5.4-mini' }, spec: { candidates: [{ equipmentId: 'eq_axe', name: 'Pick-head axe' }] } }, [['subj', 'subject', 'photo']]);
  assert.equal((await s.runner.start(claim).done).outcome, 'completed');
  assert.equal(s.o.reqs[0].url, '/v1/responses');
  assert.equal(reqBody.text.format.type, 'json_schema'); assert.equal(reqBody.text.format.strict, true);
  assert.match(reqBody.input[0].content[1].image_url, /^data:image\/jpeg;base64,/);
  const r = s.w.find('complete').json.result;
  assert.deepEqual(r.objects[0].candidates, [{ equipmentId: 'eq_axe', name: 'Pick-head axe', confidence: 0.9 }]);
  assert.equal(r.objects[0].region.w, 1); // clamped
  assert.equal(r.objects[0].quantity, 2);
  await s.close();
});

test('planReferences: overflow becomes contact sheets of ≤ 6 tiles; explicit sheet groups', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ id: i }));
  const plan = planReferences(items, 10);
  const direct = plan.filter(p => p.type === 'direct'); const sheets = plan.filter(p => p.type === 'sheet');
  assert.ok(plan.length <= 10);
  assert.ok(sheets.every(s => s.items.length <= 6));
  assert.equal(direct.length + sheets.reduce((n, s) => n + s.items.length, 0), 20);
  assert.deepEqual(direct.map(d => d.item.id), direct.map((_, i) => i)); // most important stay direct
  const grp = planReferences([{ id: 1 }, { id: 2, sheet: 'Tools' }, { id: 3, sheet: 'Tools' }], 16);
  assert.equal(grp.length, 2); assert.equal(grp[1].label, 'Tools');
  assert.equal(planReferences(items.slice(0, 3), 16).length, 3);
});

test('contact sheet: grid image built from labelled tiles; overflow job sends ≤ max images', async () => {
  const sheet = await buildContactSheet([{ bytes: await png(), label: 'A & B <x>' }, { bytes: await jpeg(), label: 'two' }]);
  const m = await sharp(sheet.bytes).metadata();
  assert.ok(m.width > 0 && m.format === 'jpeg');
  await assert.rejects(buildContactSheet(Array(7).fill({ bytes: await png(), label: 'x' })), RangeError);
  const assets = {}; const ids = [];
  for (let i = 0; i < 6; i++) { assets[`r${i}`] = await png(); ids.push([`r${i}`, 'tool', `Tool ${i}`]); }
  let parts;
  const s = await setup({ worker: { assets }, openai: async (req, res) => { parts = parseMultipart(req); send(res, 200, await imageResponse()); } });
  const claim = { ...claimFor(s.w.url, {}, ids), maxReferences: 3 };
  assert.equal((await s.runner.start(claim).done).outcome, 'completed');
  assert.ok(parts.filter(p => p.name === 'image[]').length <= 3);
  await s.close();
});

test('image-prep: orientation, size cap, derivatives', async () => {
  const big = await sharp({ create: { width: 4000, height: 1000, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  const n = await normalizeReference(big);
  assert.equal(n.width, 2048);
  const d = await buildDerivatives(await png(3000, 2000));
  assert.equal(d.original.mime, 'image/png'); assert.deepEqual([d.width, d.height], [3000, 2000]);
});

test('lease lost mid-job aborts before generating', async () => {
  const s = await setup({
    worker: { assets: { a: await png() }, onHeartbeat: (b, n) => (n >= 2 ? { status: 409, body: { error: { code: 'LEASE_LOST', message: 'gone' } } } : null) },
    openai: (req, res) => send(res, 200, {}),
  });
  const h = s.runner.start(claimFor(s.w.url, {}, [['a', 'tool', 'x']]));
  assert.equal((await h.done).outcome, 'lease_lost');
  assert.equal(s.o.reqs.length, 0);
  assert.ok(!s.w.calls.some(c => c.json?.status === 'generating'));
  assert.equal(s.w.find('fail'), undefined);
  await s.close();
});

test('cancel requested before generating: no provider call, fail CANCELLED', async () => {
  const s = await setup({ worker: { onHeartbeat: (b, n) => (n >= 2 ? { status: 200, body: { leaseExpiresAt: 1, cancelRequested: true } } : null) }, openai: (req, res) => send(res, 200, {}) });
  const h = s.runner.start(claimFor(s.w.url));
  assert.equal((await h.done).outcome, 'cancel');
  assert.equal(s.o.reqs.length, 0);
  assert.deepEqual(s.w.find('fail').json, { node: 'test-node', code: 'CANCELLED', message: 'Cancelled before generation started.', retryable: false, providerCalled: false });
  await s.close();
});

test('cancel after generating is ignored; job finishes', async () => {
  const s = await setup({
    worker: { onHeartbeat: b => (b.status === 'saving' || b.status === 'generating' ? { status: 200, body: { leaseExpiresAt: 1, cancelRequested: true } } : null) },
    openai: async (req, res) => send(res, 200, await imageResponse()),
  });
  assert.equal((await s.runner.start(claimFor(s.w.url)).done).outcome, 'completed');
  await s.close();
});

test('provider 429 → fail retryable; 5xx retryable; quota 429 terminal', async () => {
  for (const [status, err, expect] of [
    [429, { code: 'rate_limit_exceeded', message: 'slow down' }, { code: 'PROVIDER_RATE_LIMITED', retryable: true }],
    [503, { message: 'overloaded' }, { code: 'PROVIDER_UNAVAILABLE', retryable: true }],
    [429, { code: 'insufficient_quota', message: 'You exceeded your current quota' }, { code: 'PROVIDER_BILLING', retryable: false }],
    [400, { code: 'invalid_value', message: 'bad size' }, { code: 'PROVIDER_REJECTED', retryable: false }],
    [404, { code: 'model_not_found', message: 'no such model' }, { code: 'PROVIDER_MODEL_INVALID', retryable: false }],
  ]) {
    const s = await setup({ worker: {}, openai: (req, res) => send(res, status, { error: err }) });
    assert.equal((await s.runner.start(claimFor(s.w.url)).done).outcome, 'failed');
    assert.equal(s.o.reqs.length, 1, 'provider is never re-called by the processor');
    const f = s.w.find('fail').json;
    assert.equal(f.code, expect.code); assert.equal(f.retryable, expect.retryable); assert.equal(f.providerCalled, true);
    await s.close();
  }
});

test('moderation_blocked → terminal', async () => {
  const s = await setup({ worker: {}, openai: (req, res) => send(res, 400, { error: { type: 'image_generation_user_error', code: 'moderation_blocked', message: 'blocked' } }) });
  await s.runner.start(claimFor(s.w.url)).done;
  const f = s.w.find('fail').json;
  assert.deepEqual([f.code, f.retryable, f.providerCalled], ['MODERATION_BLOCKED', false, true]);
  await s.close();
});

test('network error before call → providerCalled false, retryable', async () => {
  const dead = await listen(() => {}); const deadUrl = dead.url; await dead.close(); // closed port → ECONNREFUSED
  const s = await setup({ worker: {}, adapterOver: createOpenAiAdapter({ apiKey: SECRETS.openai, baseUrl: `${deadUrl}/v1`, timeoutMs: 2000 }) });
  await s.runner.start(claimFor(s.w.url)).done;
  const f = s.w.find('fail').json;
  assert.deepEqual([f.code, f.retryable, f.providerCalled], ['PROVIDER_UNREACHABLE', true, false]);
  await s.close();
});

test('provider timeout after send → outcome unknown, not retryable', async () => {
  const s = await setup({ worker: {}, openai: () => { /* never answers */ }, adapterOver: null });
  const adapter = createOpenAiAdapter({ apiKey: SECRETS.openai, baseUrl: `${s.o.url}/v1`, timeoutMs: 100 });
  const r = createJobRunner({ api: createApiClient(config(s.w.url), { retryBaseMs: 1 }), adapter, node: 'n', logger: s.cap.logger, heartbeatMs: 1000 });
  await r.start(claimFor(s.w.url)).done;
  const f = s.w.find('fail').json;
  assert.deepEqual([f.code, f.retryable, f.providerCalled], ['PROVIDER_TIMEOUT', false, true]);
  await s.close();
});

test('SIGTERM before generating requeues (fail retryable, providerCalled false)', async () => {
  const s = await setup({ worker: { assets: { a: await png() } }, openai: (req, res) => send(res, 200, {}) });
  const slow = createApiClient(config(s.w.url), { retryBaseMs: 1 });
  const orig = slow.download;
  slow.download = async (...a) => { await new Promise(r => setTimeout(r, 150)); return orig(...a); };
  const runner = createJobRunner({ api: slow, adapter: createOpenAiAdapter({ apiKey: 'k', baseUrl: `${s.o.url}/v1` }), node: 'test-node', logger: s.cap.logger, heartbeatMs: 1000 });
  const h = runner.start(claimFor(s.w.url, {}, [['a', 'tool', 'x']]));
  await new Promise(r => setTimeout(r, 30));
  assert.equal(h.requestShutdown(), 'preparing');
  assert.equal((await h.done).outcome, 'shutdown');
  const f = s.w.find('fail').json;
  assert.deepEqual([f.code, f.retryable, f.providerCalled], ['PROCESSOR_SHUTDOWN', true, false]);
  assert.equal(s.o.reqs.length, 0);
  await s.close();
});

test('processor loop: claims, runs, graceful shutdown lets a generating job finish', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const w = await mockWorker({ claim: url => claimFor(url) });
  const o = await mockOpenAi(async (req, res) => { await gate; send(res, 200, await imageResponse()); });
  const cap = captureLogger();
  const cfg = { ...config(w.url), openaiBase: `${o.url}/v1` };
  const p = createProcessor(cfg, { logger: cap.logger, pollActiveMs: 20, pollIdleMs: 20, graceMs: 5000, apiOpts: { retryBaseMs: 1 } });
  const loop = p.loop();
  for (let i = 0; i < 100 && !o.reqs.length; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(o.reqs.length, 1);
  const sd = p.shutdown(); // job is in 'generating' → must finish, not requeue
  release();
  assert.equal(await sd, 'done');
  await loop;
  assert.ok(w.find('complete')); assert.equal(w.find('fail'), undefined);
  await w.close(); await o.close();
});

test('processor loop: SIGTERM requeue path via shutdown when job still preparing', async () => {
  const w = await mockWorker({ claim: url => claimFor(url, {}, [['slow', 'tool', 'x']]), assets: {} });
  // asset download answers slowly via a wrapped api
  const cap = captureLogger();
  const { createApiClient: mk } = await import('../src/api-client.js');
  const api = mk(config(w.url), { retryBaseMs: 1 });
  const dl = api.download; api.download = async (u, o) => { await new Promise((res, rej) => { const t = setTimeout(res, 2000); o.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }); }); return dl(u, o); };
  const p = createProcessor({ ...config(w.url) }, { logger: cap.logger, api, adapter: { generateImage: () => { throw new Error('must not be called'); } }, pollActiveMs: 20, pollIdleMs: 20 });
  const loop = p.loop();
  for (let i = 0; i < 100 && !p.running.size; i++) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(await p.shutdown(), 'done'); await loop;
  const f = w.find('fail').json;
  assert.deepEqual([f.code, f.retryable, f.providerCalled], ['PROCESSOR_SHUTDOWN', true, false]);
  await w.close();
});

test('api client: retries 5xx and network errors, never 4xx; refuses cross-origin downloads; download cap', async () => {
  let n = 0;
  const srv = await listen((req, res) => {
    n += 1;
    if (req.url.includes('five')) return n < 3 ? send(res, 502, {}) : send(res, 200, { ok: 1 });
    if (req.url.includes('four')) return send(res, 400, { error: { code: 'INVALID_REQUEST', message: 'nope' } });
    if (req.url.includes('big')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.alloc(5000)); }
    send(res, 200, {});
  });
  const api = createApiClient({ apiBase: srv.url, accessClientId: 'i', accessClientSecret: 's' }, { retryBaseMs: 1, maxDownloadBytes: 1000 });
  n = 0; assert.deepEqual(await api.heartbeat('five', 'n', 'preparing').catch(e => e), { ok: 1 }); assert.equal(n, 3);
  n = 0; await assert.rejects(api.fail('four', {}), e => e.code === 'INVALID_REQUEST'); assert.equal(n, 1);
  await assert.rejects(api.download('http://elsewhere.example/x'), e => e.code === 'BAD_URL');
  await assert.rejects(api.download('/big'), e => e.code === 'TOO_LARGE');
  await srv.close();
});

test('redaction: logs never contain key, client secret or base64 image data', async () => {
  const img = await png(300, 300);
  const s = await setup({
    worker: { assets: { a: img } },
    openai: (req, res) => send(res, 400, { error: { code: 'invalid_api_key', message: `Incorrect API key provided: ${SECRETS.openai}. data:image/png;base64,${b64(img)}` } }),
  });
  s.cap.logger.info('probe', { Authorization: `Bearer ${SECRETS.openai}`, note: `x ${SECRETS.client} y`, blob: b64(img), prompt: 'p'.repeat(500), bytes: img });
  await s.runner.start({ ...claimFor(s.w.url, { job: { prompt: 'q'.repeat(900) } }, [['a', 'tool', 'x']]) }).done;
  const all = s.cap.lines.join('\n') + s.w.find('fail').body.toString();
  for (const secret of Object.values(SECRETS)) assert.ok(!all.includes(secret), `leaked ${secret}`);
  assert.ok(!all.includes(b64(img).slice(0, 200)));
  assert.ok(!/q{201}/.test(all) && !/p{201}/.test(all));
  assert.ok(!s.w.find('fail').body.toString().includes('base64,'));
  await s.close();
});
