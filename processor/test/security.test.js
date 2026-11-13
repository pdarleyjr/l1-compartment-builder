/* global Buffer, Response, clearInterval, setInterval -- Node 22 runtime globals (AIW processor runs on Node, not in the browser/Worker) */
// Security review 2026-11 — processor: no credential leaks (redirects, foreign URLs), no echo of provider error bodies,
// log redaction, timeouts. Real api-client / adapter / job-runner against node:http mocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../src/api-client.js';
import { createOpenAiAdapter, mapHttpError } from '../src/openai-adapter.js';
import { createJobRunner } from '../src/job-runner.js';
import { createLogger, redact, sanitize } from '../src/logger.js';
import { SECRETS, png, listen, send, mockWorker, captureLogger, claimFor, config } from './support/helpers.js';

const cfgFor = url => config(url);

test('a redirect from the Worker origin is never followed (Access secret headers must not travel to another host)', async () => {
  const evil = await listen((req, res) => { res.statusCode = 200; res.end('{}'); });
  let evilHits = 0;
  const evilCounting = await listen((req, res) => { evilHits += 1; res.statusCode = 200; res.end('{}'); });
  const worker = await listen((req, res) => { res.writeHead(302, { location: `${evilCounting.url}/steal` }); res.end(); });
  const api = createApiClient(cfgFor(worker.url), { retries: 0 });
  await assert.rejects(api.claim('n', ['render']));
  await assert.rejects(api.heartbeat('gj_1', 'n', 'preparing'));
  await assert.rejects(api.putOutput('gj_1', 'original', Buffer.from('x'), 'image/png'));
  await assert.rejects(api.download('/api/processor/assets/ast_1/original?job=gj_1'));
  assert.equal(evilHits, 0, 'the redirect target received no request, hence no CF-Access-Client-Secret');
  await Promise.all([evil.close(), evilCounting.close(), worker.close()]);
});

test('download only fetches processor asset endpoints on the Worker origin (SSRF via a claimed reference url)', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('x'); };
  const api = createApiClient(cfgFor('https://worker.example'), { fetchImpl, retries: 0 });
  const bad = [
    'https://evil.example/api/processor/assets/ast_1/original', '//evil.example/api/processor/assets/ast_1/original',
    'http://worker.example/api/processor/assets/ast_1/original', 'https://worker.example.evil.example/api/processor/assets/ast_1/original',
    'https://worker.example@evil.example/api/processor/assets/ast_1/original', 'https://evil.example\\@worker.example/api/processor/assets/a',
    'https://worker.example:8443/api/processor/assets/ast_1/original', 'file:///etc/passwd', 'data:text/plain,hi', 'javascript:alert(1)',
    'https://worker.example/api/admin/settings', '/api/admin/settings', '/api/processor/claim', '/api/processor/assets/../../admin/settings',
    '/api/processor/assets/%2e%2e/%2e%2e/admin/settings', 'https://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:8787/api/processor/assets/a/b',
  ];
  for (const url of bad) await assert.rejects(api.download(url), e => e.code === 'BAD_URL', url);
  assert.equal(calls, 0, 'no request was made for any of them');
  await api.download('/api/processor/assets/ast_1/original?job=gj_1');
  await api.download('https://worker.example/api/processor/assets/ast_1/display?job=gj_1');
  assert.equal(calls, 2);
});

test('a claim whose reference URL points at a foreign host fails the job without contacting that host', async () => {
  let evilHits = 0;
  const evil = await listen((req, res) => { evilHits += 1; res.end(); });
  const w = await mockWorker({});
  const cap = captureLogger();
  const api = createApiClient(config(w.url), { retryBaseMs: 1, retries: 0 });
  const adapter = { generateImage: async () => { throw new Error('provider must not be called'); } };
  const runner = createJobRunner({ api, adapter, node: 'test-node', logger: cap.logger, heartbeatMs: 1000, secrets: Object.values(SECRETS) });
  const claim = claimFor(w.url, {}, [['ast_1', 'tool', 'x', { url: `${evil.url}/api/processor/assets/ast_1/original` }]]);
  const out = await runner.start(claim).done;
  assert.equal(out.outcome, 'failed');
  assert.equal(evilHits, 0);
  const f = w.find('fail').json;
  assert.deepEqual([f.code, f.providerCalled], ['PREP_FAILED', false]);
  await Promise.all([evil.close(), w.close()]);
});

test('provider error bodies (key fragments, org ids, prompt text) never reach the Worker report or the log lines in raw form', async () => {
  const leak = `Incorrect API key provided: ${SECRETS.openai}. org-SECRETORG123 asked: "A tidy compartment" data:image/png;base64,AAAA${'B'.repeat(200)}`;
  const o = await listen((req, res) => send(res, 401, { error: { code: 'invalid_api_key', message: leak } }));
  const w = await mockWorker({});
  const cap = captureLogger();
  const api = createApiClient(config(w.url), { retryBaseMs: 1, retries: 0 });
  const adapter = createOpenAiAdapter({ apiKey: SECRETS.openai, baseUrl: `${o.url}/v1`, timeoutMs: 5000 });
  const runner = createJobRunner({ api, adapter, node: 'test-node', logger: cap.logger, heartbeatMs: 1000, secrets: Object.values(SECRETS) });
  await runner.start(claimFor(w.url)).done;
  const f = w.find('fail').json;
  assert.equal(f.code, 'PROVIDER_AUTH');
  const reported = JSON.stringify(f);
  for (const needle of ['Incorrect API key', 'org-SECRETORG123', 'A tidy compartment', SECRETS.openai, 'base64']) assert.ok(!reported.includes(needle), `report leaked ${needle}`);
  const logs = cap.lines.join('\n');
  for (const secret of Object.values(SECRETS)) assert.ok(!logs.includes(secret), 'secret in logs');
  assert.ok(!/B{50}/.test(logs), 'image data in logs');
  await Promise.all([o.close(), w.close()]);
});

test('mapHttpError: every status produces a fixed, provider-text-free message', () => {
  for (const [status, body] of [[400, { error: { code: 'moderation_blocked', message: 'secret prompt words' } }], [401, { error: { message: 'sk-live-abc' } }], [403, null], [404, { error: { code: 'model_not_found', message: 'org-123' } }], [429, { error: { message: 'x' } }],
    [429, { error: { code: 'insufficient_quota', message: 'acct 42' } }], [500, { error: { message: 'trace /srv/x' } }], [418, { error: { message: 'teapot sk-1234567890abcdef' } }]]) {
    const e = mapHttpError(status, body, 'req_1');
    assert.ok(!/secret prompt|sk-|org-|acct|\/srv|teapot/.test(e.message), `${status}: ${e.message}`);
    assert.ok(e.message.length < 200);
    assert.equal(e.providerCalled, true);
  }
});

test('timeouts: a hanging provider yields PROVIDER_TIMEOUT (outcome unknown, not retryable); a hanging Worker rejects within the timeout', async () => {
  const hang = await listen(() => {}); // never answers
  const adapter = createOpenAiAdapter({ apiKey: SECRETS.openai, baseUrl: `${hang.url}/v1`, timeoutMs: 150 });
  const t0 = Date.now();
  await assert.rejects(adapter.generateImage({ model: 'm', prompt: 'p' }), e => e.code === 'PROVIDER_TIMEOUT' && e.retryable === false && e.providerCalled === true);
  assert.ok(Date.now() - t0 < 3000);
  const api = createApiClient(cfgFor(hang.url), { timeoutMs: 150, retries: 0 });
  const t1 = Date.now();
  await assert.rejects(api.claim('n', ['render']));
  assert.ok(Date.now() - t1 < 3000);
  await hang.close();
});

test('download streams are capped even when Content-Length lies or is absent', async () => {
  const srv = await listen((req, res) => { res.writeHead(200, { 'content-type': 'image/png', 'transfer-encoding': 'chunked' }); const big = Buffer.alloc(64 * 1024, 1); let i = 0; const t = setInterval(() => { res.write(big); if (++i > 200) { clearInterval(t); res.end(); } }, 1); });
  const api = createApiClient(cfgFor(srv.url), { maxDownloadBytes: 256 * 1024, retries: 0 });
  await assert.rejects(api.download('/api/processor/assets/ast_1/original?job=gj_1'), e => e.code === 'TOO_LARGE');
  await srv.close();
});

test('logger: secrets, auth headers, key patterns, data URLs and bytes are removed everywhere, including nested errors and URL-ish text', () => {
  const lines = [];
  const logger = createLogger({ secrets: Object.values(SECRETS), write: l => lines.push(l) });
  const img = Buffer.alloc(500, 7);
  logger.error(`failed with ${SECRETS.client} and ${SECRETS.openai}`, {
    headers: { 'CF-Access-Client-Secret': SECRETS.client, authorization: `Bearer ${SECRETS.openai}`, Cookie: 'CF_Authorization=abc' },
    err: Object.assign(new Error(`boom ${SECRETS.clientId} ${SECRETS.openai}`), { code: 'X' }), nested: { deep: { token: 'zzz', text: `see sk-abcdefghij1234567890 and data:image/png;base64,${'A'.repeat(300)}` } },
    bytes: img, big: 'Q'.repeat(400), prompt: 'p'.repeat(1000),
  });
  const all = lines.join('\n');
  for (const s of [...Object.values(SECRETS), 'CF_Authorization=abc', 'zzz', 'sk-abcdefghij', 'A'.repeat(100), 'Q'.repeat(150)]) assert.ok(!all.includes(s), `leaked ${s.slice(0, 20)}`);
  assert.ok(!/p{201}/.test(all));
  assert.equal(sanitize('x sk-ABCDEFGHIJKLMNOP y'), 'x [redacted-key] y');
  assert.deepEqual(redact({ apiKey: 'k', Password: 'p', ok: 1 }, []), { apiKey: '[redacted]', Password: '[redacted]', ok: 1 });
});

test('output reaches the Worker only as bytes for the job id the Worker itself assigned (no path built from provider data)', async () => {
  const w = await mockWorker({});
  const api = createApiClient(config(w.url), { retries: 0 });
  await api.putOutput('gj_job1', 'original', await png(8, 8), 'image/png');
  await api.putOutput('gj_a/../../x?y#z', 'thumb', await png(8, 8), 'image/png');
  const paths = w.calls.map(c => c.path);
  assert.deepEqual(paths, ['/api/processor/jobs/gj_job1/output/original', '/api/processor/jobs/gj_a%2F..%2F..%2Fx%3Fy%23z/output/thumb']);
  assert.ok(w.calls.every(c => c.headers['x-l1-node'] === 'test-node'), 'every raw request names the node (lease check)');
  await w.close();
});
