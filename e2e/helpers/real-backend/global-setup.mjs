/* global process, fetch */
// Seeds the real local stack: synthetic v1 planner + tiny images doc into local KV, migrate-legacy (as admin) until done,
// then ai.enabled=true. Synthetic data only.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMPARTMENT_IDS } from '../../../shared/contracts.js';
import { ADMIN_ACTOR, CONTROL_DIR, PERSIST, ROOT, WORKER_URL } from './ports.mjs';
import { TINY_JPEG_B64, TINY_PNG_B64 } from './tiny-images.mjs';

/** Per compartment: two assigned tools (Alpha, Beta, qty 1 each) and one unassigned tool (Gamma, qty 1). */
export const toolNames = id => ({ alpha: `QA Alpha ${id}`, beta: `QA Beta ${id}`, gamma: `QA Gamma ${id}` });

export function v1Doc() {
  const allocations = Object.fromEntries(COMPARTMENT_IDS.map(c => [c, Array(15).fill('')]));
  const customTools = [];
  for (const id of COMPARTMENT_IDS) {
    const n = toolNames(id);
    allocations[id][0] = n.alpha;
    allocations[id][1] = n.beta;
    customTools.push({ name: n.alpha, qty: 1, dimensions: '10 in' }, { name: n.beta, qty: 1, dimensions: '12 in' }, { name: n.gamma, qty: 1, dimensions: '8 in' });
  }
  return { allocations, customQtys: {}, customTools, bundles: {}, removedItems: [], customDimensions: {}, _serverTs: 1700000000000 };
}
export const imagesDoc = () => ({
  uploadedImages: { LS1: [{ uid: 'u-1', title: 'Legacy front', fileName: 'front.jpg', dataUrl: `data:image/jpeg;base64,${TINY_JPEG_B64}` }, { uid: 'u-2', title: 'Legacy side', dataUrl: `data:image/png;base64,${TINY_PNG_B64}` }] },
  featuredImages: {},
});

const call = (method, p, actor, json) => fetch(`${WORKER_URL}${p}`, { method, headers: { 'X-Test-Actor': actor, ...(json === undefined ? {} : { 'content-type': 'application/json' }) }, body: json === undefined ? undefined : JSON.stringify(json) });

export default async function globalSetup() {
  fs.mkdirSync(CONTROL_DIR, { recursive: true });
  for (const f of ['processor.pause', 'openai.delay']) fs.rmSync(path.join(CONTROL_DIR, f), { force: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'l1-qa-seed-'));
  const env = { ...process.env, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || '/tmp/wcfg', WRANGLER_SEND_METRICS: 'false', CI: '1' };
  for (const [key, doc] of [['allocations', v1Doc()], ['images', imagesDoc()]]) {
    const file = path.join(tmp, `${key}.json`);
    fs.writeFileSync(file, JSON.stringify(doc));
    execFileSync('npx', ['wrangler', 'kv', 'key', 'put', key, '--path', file, '--local', '--binding', 'L1_STATE', '--config', 'worker/wrangler.toml', '--persist-to', PERSIST], { cwd: ROOT, env, stdio: 'pipe' });
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  let done = false;
  for (let i = 0; i < 30 && !done; i += 1) {
    const r = await call('POST', '/api/admin/migrate-legacy', ADMIN_ACTOR);
    if (!r.ok) throw new Error(`migrate-legacy failed: ${r.status} ${await r.text()}`);
    done = (await r.json()).done === true;
  }
  if (!done) throw new Error('migrate-legacy did not report done');

  const settings = await (await call('GET', '/api/admin/settings', ADMIN_ACTOR)).json();
  const put = await call('PUT', '/api/admin/settings/ai.enabled', ADMIN_ACTOR, { value: true, expectRevision: settings.settings['ai.enabled'].revision });
  if (!put.ok) throw new Error(`enabling ai failed: ${put.status} ${await put.text()}`);
}
