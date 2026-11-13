/* global Buffer, URL -- Node 22 runtime globals (AIW processor runs on Node, not in the browser/Worker) */
// Mock Worker + OpenAI servers (node:http) and a tiny multipart parser.
import http from 'node:http';
import sharp from 'sharp';
import { createLogger } from '../../src/logger.js';

export const SECRETS = { client: 'client-secret-ZZZ-9f8e7d6c', clientId: 'client-id-abc123.access', openai: 'sk-test-SECRETKEY1234567890' };

export const png = (w = 64, h = 48, color = '#336699') => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
export const jpeg = (w = 64, h = 48) => sharp({ create: { width: w, height: h, channels: 3, background: '#aa3333' } }).jpeg().toBuffer();

export function listen(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    req.body = Buffer.concat(chunks);
    try { await handler(req, res); } catch (e) { res.statusCode = 500; res.end(String(e)); }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }),
  })));
}

export const send = (res, status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };

/** Parse multipart/form-data into [{name, filename, type, data}]. */
export function parseMultipart(req) {
  const m = /boundary=(.+)$/.exec(req.headers['content-type'] || '');
  const boundary = Buffer.from(`--${m[1]}`);
  const parts = []; let pos = req.body.indexOf(boundary);
  while (pos !== -1) {
    const next = req.body.indexOf(boundary, pos + boundary.length);
    if (next === -1) break;
    const seg = req.body.subarray(pos + boundary.length + 2, next - 2);
    const sep = seg.indexOf('\r\n\r\n');
    const head = seg.subarray(0, sep).toString();
    parts.push({ name: /name="([^"]*)"/.exec(head)?.[1], filename: /filename="([^"]*)"/.exec(head)?.[1], type: /Content-Type: (.+)/i.exec(head)?.[1], data: seg.subarray(sep + 4) });
    pos = next;
  }
  return parts;
}

/**
 * Programmable Worker mock. opts.claim = claim payload (or null); opts.onHeartbeat(body, n) → {status, body}.
 * Records every request in `calls`.
 */
export async function mockWorker(opts = {}) {
  const calls = []; const uploads = {}; let hb = 0;
  const refs = opts.assets || {};
  const srv = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const rec = { method: req.method, path: url.pathname, headers: req.headers, body: req.body };
    calls.push(rec);
    if (!req.headers['cf-access-client-id'] || !req.headers['cf-access-client-secret']) return send(res, 403, { error: { code: 'FORBIDDEN', message: 'no token' } });
    if (url.pathname === '/api/processor/claim') {
      if (req.method !== 'POST') return send(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'x' } });
      if (!opts.claim) { res.writeHead(204); return res.end(); }
      const c = opts.claim; opts.claim = null; return send(res, 200, typeof c === 'function' ? c(srv.url) : c);
    }
    let m = /^\/api\/processor\/jobs\/([^/]+)\/heartbeat$/.exec(url.pathname);
    if (m) {
      const body = JSON.parse(req.body.toString()); rec.json = body; hb += 1;
      const r = opts.onHeartbeat ? opts.onHeartbeat(body, hb) : null;
      if (r) return send(res, r.status, r.body);
      return send(res, 200, { leaseExpiresAt: Date.now() + 120000, cancelRequested: false });
    }
    m = /^\/api\/processor\/assets\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (m) { const a = refs[m[1]]; if (!a) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'nf' } }); res.writeHead(200, { 'content-type': 'image/png' }); return res.end(a); }
    m = /^\/api\/processor\/jobs\/([^/]+)\/output\/([^/]+)$/.exec(url.pathname);
    if (m) { uploads[m[2]] = { data: req.body, type: req.headers['content-type'] }; res.writeHead(204); return res.end(); }
    m = /^\/api\/processor\/jobs\/([^/]+)\/(complete|fail)$/.exec(url.pathname);
    if (m) { rec.json = JSON.parse(req.body.toString()); rec.kind = m[2]; return send(res, 200, { ok: true }); }
    return send(res, 404, { error: { code: 'NOT_FOUND', message: 'nf' } });
  });
  return { ...srv, calls, uploads, find: kind => calls.find(c => c.kind === kind) };
}

/** Logger that captures lines. */
export function captureLogger() {
  const lines = [];
  const logger = createLogger({ secrets: Object.values(SECRETS), write: l => lines.push(l) });
  return { logger, lines };
}

export const claimFor = (url, over = {}, refIds = []) => ({
  job: { id: 'gj_job1', kind: 'render', model: 'gpt-image-2.6-flare', quality: 'low', complexity: 'medium', size: '1024x768', outputFormat: 'png', prompt: 'A tidy compartment', ...over.job },
  spec: over.spec || { schema: 'l1.scene/1' },
  references: refIds.map(([assetId, role, label, extra]) => ({ assetId, variant: 'display', role, label, url: `/api/processor/assets/${assetId}/display`, ...extra })),
  leaseExpiresAt: Date.now() + 120000,
});

export const config = url => ({
  apiBase: url, accessClientId: SECRETS.clientId, accessClientSecret: SECRETS.client, openaiKey: SECRETS.openai,
  nodeName: 'test-node', kinds: ['render', 'recognize', 'verify'], maxParallel: 1, openaiBase: '', dryRun: false,
});
