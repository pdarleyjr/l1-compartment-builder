/* global process, Response, Headers */
// Runs the REAL AIW processor (processor/src: config, api-client, job-runner, openai-adapter, sharp) against the local Worker
// and the mock OpenAI. Differences from production, all through configuration:
//  - global fetch is wrapped to add `X-Test-Actor: service:qa-processor` to Worker calls (AUTH_MODE=test has no Access JWT),
//  - L1_OPENAI_BASE points at the mock, the key is a synthetic string,
//  - faster polling (1 s) so tests do not wait on the 3-15 s production cadence,
//  - pause switch: while <CONTROL_DIR>/processor.pause exists, claim answers 204 (lets a test keep a job `queued`).
import fs from 'node:fs';
import path from 'node:path';
import { CONTROL_DIR, MOCK_URL, WORKER_URL } from './ports.mjs';

const realFetch = globalThis.fetch;
const paused = () => fs.existsSync(path.join(CONTROL_DIR, 'processor.pause'));
globalThis.fetch = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith(WORKER_URL)) return realFetch(input, init);
  if (url.includes('/api/processor/claim') && paused()) return Promise.resolve(new Response(null, { status: 204 }));
  const headers = new Headers(init.headers ?? (typeof input === 'object' ? input.headers : undefined));
  headers.set('X-Test-Actor', 'service:qa-processor');
  return realFetch(input, { ...init, headers });
};

Object.assign(process.env, {
  L1_API_BASE: WORKER_URL,
  L1_ACCESS_CLIENT_ID: 'qa-synthetic-id',
  L1_ACCESS_CLIENT_SECRET: 'qa-synthetic-secret',
  L1_OPENAI_API_KEY: 'sk-qa-synthetic-not-a-key',
  L1_OPENAI_BASE: `${MOCK_URL}/v1`,
  L1_NODE_NAME: 'qa-node',
});

const { loadConfig } = await import('../../../processor/src/config.js');
const { createProcessor } = await import('../../../processor/src/index.js');
const processor = createProcessor(loadConfig(process.env), { pollActiveMs: 1000, pollIdleMs: 1000, graceMs: 5000 });
const stop = async () => { await processor.shutdown(); process.exit(0); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
process.stdout.write('qa-processor started\n');
await processor.loop();
