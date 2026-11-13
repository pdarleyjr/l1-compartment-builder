/* global setTimeout, process, Buffer */
// Mock OpenAI for the QA stack (node:http only; never leaves 127.0.0.1).
//  - POST /v1/images/generations and /v1/images/edits -> a REAL, valid image (640x480, a different colour per call so
//    versions look different), in the output_format the request asked for (jpeg|png|webp), with documented usage:
//      usage = { total_tokens: 100, input_tokens: 50, output_tokens: 50, input_tokens_details: { text_tokens: 10, image_tokens: 40 } }
//    (snake_case, exactly the Images API shape; the Worker prices it with shared/cost.js actualCost).
//  - POST /v1/responses -> an empty recognition result (no suggestions).
//  - GET /health -> 200 (Playwright webServer readiness) ; GET /calls -> JSON log of requests (counts only, no bodies).
//  - Optional delay: write milliseconds to <CONTROL_DIR>/openai.delay so tests can watch "generating".
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CONTROL_DIR, MOCK_PORT, ROOT } from './ports.mjs';

const sharp = createRequire(path.join(ROOT, 'processor/package.json'))('sharp');
const COLORS = ['#b02a2a', '#2a6fb0', '#2ab06f', '#b0902a', '#7a2ab0', '#2ab0b0'];
const calls = [];
const USAGE = { total_tokens: 100, input_tokens: 50, output_tokens: 50, input_tokens_details: { text_tokens: 10, image_tokens: 40 } };

const delayMs = () => { try { return Number(fs.readFileSync(path.join(CONTROL_DIR, 'openai.delay'), 'utf8')) || 0; } catch { return 0; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function render(n, fmt) {
  const c = COLORS[n % COLORS.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="${c}"/><rect x="40" y="40" width="560" height="400" fill="none" stroke="#fff" stroke-width="6"/><rect x="80" y="300" width="200" height="90" fill="#fff" opacity=".7"/><circle cx="440" cy="200" r="70" fill="#fff" opacity=".6"/></svg>`;
  const img = sharp(Buffer.from(svg));
  return (fmt === 'png' ? img.png() : fmt === 'webp' ? img.webp() : img.jpeg()).toBuffer();
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    const send = (status, payload, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(payload)); };
    try {
      if (req.url === '/health') return send(200, { ok: true });
      if (req.url === '/calls') return send(200, { count: calls.length, calls });
      if (req.url.endsWith('/images/edits') || req.url.endsWith('/images/generations')) {
        const text = body.toString('latin1');
        const fmt = /output_format"?(?:\r\n\r\n|":\s*")(jpeg|png|webp)/.exec(text)?.[1] ?? 'jpeg';
        const size = /(?:size"?(?:\r\n\r\n|":\s*"))(\d+x\d+)/.exec(text)?.[1] ?? '640x480';
        calls.push({ path: req.url, fmt, size, bytes: body.length, at: Date.now() });
        const ms = delayMs(); if (ms) await sleep(ms);
        const png = await render(calls.length, fmt);
        return send(200, { created: 1_700_000_000, size: '640x480', output_format: fmt, quality: 'low', data: [{ b64_json: png.toString('base64') }], usage: USAGE }, { 'x-request-id': `req_mock_${calls.length}` });
      }
      if (req.url.endsWith('/responses')) {
        calls.push({ path: req.url, bytes: body.length, at: Date.now() });
        return send(200, { id: 'resp_mock', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ objects: [] }) }] }],
          usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 0 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1280 } });
      }
      return send(404, { error: { code: 'not_found', message: 'mock' } });
    } catch (e) { return send(500, { error: { code: 'mock_failed', message: String(e?.message) } }); }
  });
});
server.listen(MOCK_PORT, '127.0.0.1', () => process.stdout.write(`mock-openai ready on ${MOCK_PORT}\n`));
process.on('SIGTERM', () => { server.closeAllConnections?.(); server.close(() => process.exit(0)); });
process.on('SIGINT', () => { server.closeAllConnections?.(); server.close(() => process.exit(0)); });
