// Shared helpers for the Studio QA specs (real local stack, see playwright.studio.config.js).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expect } from '@playwright/test';
import { COMPARTMENTS } from '../../shared/apparatus.js';
import { COMPARTMENT_IDS } from '../../shared/contracts.js';
import { CONTROL_DIR, ROOT, WORKER_URL } from '../helpers/real-backend/ports.mjs';
import { toolNames } from '../helpers/real-backend/global-setup.mjs';

export { COMPARTMENT_IDS, toolNames, WORKER_URL };
export const SHOTS = path.join(ROOT, 'docs/qa/screenshots');
const sharp = createRequire(path.join(ROOT, 'processor/package.json'))('sharp');

// ── synthetic photos ───────────────────────────────────────────────────────────────────────────────────────────────
const PALETTE = ['#3b6ea8', '#a85a3b', '#4a8f5d', '#8a5aa8', '#a89a3b', '#3b9aa8'];
/** A recognisable synthetic picture (coloured blocks, no text) as JPEG or PNG. `seed` varies the colours. */
export async function syntheticPhoto({ seed = 0, kind = 'jpeg', width = 800, height = 600 } = {}) {
  const c = i => PALETTE[(seed + i) % PALETTE.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#d9dde3"/>`
    + `<rect x="30" y="30" width="${width - 60}" height="${height - 60}" fill="#f4f5f7" stroke="#555" stroke-width="8"/>`
    + `<rect x="80" y="90" width="220" height="${height - 200}" rx="12" fill="${c(0)}"/><rect x="340" y="90" width="150" height="${height - 200}" rx="12" fill="${c(1)}"/>`
    + `<circle cx="${width - 170}" cy="${height / 2}" r="90" fill="${c(2)}"/></svg>`;
  const img = sharp(Buffer.from(svg));
  return kind === 'png' ? img.png().toBuffer() : img.jpeg({ quality: 90 }).toBuffer();
}
export const photoFile = async (name, opts) => ({ name, mimeType: name.endsWith('.png') ? 'image/png' : 'image/jpeg', buffer: await syntheticPhoto({ kind: name.endsWith('.png') ? 'png' : 'jpeg', ...opts }) });
/** A ".heic" file that is not decodable here (random bytes): must take the friendly "could not be converted" path. */
export const heicFile = (name = 'IMG_0001.heic') => ({ name, mimeType: 'image/heic', buffer: Buffer.from('not-really-a-heic-photo-just-synthetic-bytes') });

// ── control switches shared with the processor / mock ─────────────────────────────────────────────────────────────
export const pauseProcessor = () => { fs.mkdirSync(CONTROL_DIR, { recursive: true }); fs.writeFileSync(path.join(CONTROL_DIR, 'processor.pause'), '1'); };
export const resumeProcessor = () => fs.rmSync(path.join(CONTROL_DIR, 'processor.pause'), { force: true });
export const setProviderDelay = ms => { fs.mkdirSync(CONTROL_DIR, { recursive: true }); if (ms) fs.writeFileSync(path.join(CONTROL_DIR, 'openai.delay'), String(ms)); else fs.rmSync(path.join(CONTROL_DIR, 'openai.delay'), { force: true }); };

// ── API (through the Vite proxy so the signed-in header of the project applies) ───────────────────────────────────
export async function getJson(request, p) {
  const r = await request.get(p);
  expect(r.ok(), `${p} -> ${r.status()}`).toBeTruthy();
  return r.json();
}
export const plannerOf = request => getJson(request, '/api/public/planner');
export const assetsOf = async (request, compId) => (await getJson(request, `/api/compartments/${compId}/assets`)).assets;
export const versionsOf = async (request, compId) => (await getJson(request, `/api/compartments/${compId}/versions`)).versions;
export const jobsOf = async (request, compId) => (await getJson(request, `/api/compartments/${compId}/jobs`)).jobs;
export const mainOf = async (request, compId) => (await getJson(request, '/api/public/main-images')).mainImages[compId] ?? null;
export const usedSlots = (doc, compId) => (doc.allocations[compId] ?? []).filter(Boolean);

/** Set an admin setting (needs the admin header of the project). Returns the previous value so callers can restore it. */
export async function setSetting(request, key, value) {
  const all = await getJson(request, '/api/admin/settings');
  const cur = all.settings[key];
  const r = await request.put(`/api/admin/settings/${encodeURIComponent(key)}`, { data: { value, expectRevision: cur.revision } });
  expect(r.ok(), `PUT ${key} -> ${r.status()} ${await r.text()}`).toBeTruthy();
  return cur.value;
}

// ── navigation ────────────────────────────────────────────────────────────────────────────────────────────────────
const labelOf = id => COMPARTMENTS.find(c => c.id === id)?.label ?? id;
export async function openApp(page) {
  await page.goto('/');
  await expect(page.getByText('Loading L1 Compartment Builder')).toBeHidden();
}
export async function openCompartment(page, id) {
  const burger = page.getByRole('button', { name: 'Open navigation menu' });
  if (await burger.isVisible()) await burger.click();
  await page.getByRole('button', { name: new RegExp(`^${labelOf(id)}(\\s+\\d+)?$`) }).click();
  await expect(page.getByRole('heading', { name: `Compartment ${labelOf(id)}` })).toBeVisible();
}
export const studioDialog = page => page.getByRole('dialog', { name: /AI Compartment Studio/ });
export async function openStudio(page, id, step) {
  await openCompartment(page, id);
  await page.getByRole('button', { name: 'AI Compartment Studio' }).click();
  await expect(studioDialog(page)).toBeVisible();
  if (step) await gotoStep(page, step);
}
export const STEP_LABEL = { photos: 'Photos', tools: 'Tools', mounts: 'Mounts', arrange: 'Arrange', generate: 'Generate', review: 'Review & Edit', publish: 'Publish' };
export async function gotoStep(page, step) {
  await page.getByTestId(`studio-step-${step}`).click();
  await expect(page.getByTestId(`studio-panel-${step}`)).toBeVisible();
}
export const closeStudio = page => page.getByRole('button', { name: 'Close Studio' }).click();

// ── capture ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** Pick a category, add the files through the real file input, return once every pending card is ready or failed. */
export async function addPending(page, category, files) {
  await page.getByTestId('capture-category').selectOption(category);
  await page.getByTestId('capture-input-files').setInputFiles(files);
  await expect(page.getByTestId('pending-photo').filter({ hasText: /Preparing/ })).toHaveCount(0, { timeout: 30_000 });
}
export async function uploadPending(page) {
  await page.getByTestId('capture-upload').click();
}
export const assocDialog = page => page.getByTestId('association-dialog');
/** Wait for the compartment's committed-asset count to reach n (server truth). */
export async function waitForAssets(request, compId, n) {
  await expect.poll(async () => (await assetsOf(request, compId)).filter(a => a.status === 'committed').length, { timeout: 30_000 }).toBeGreaterThanOrEqual(n);
}
export async function pickCandidate(dialog, name) {
  await dialog.getByTestId('assoc-search').fill(name);
  await dialog.getByTestId('assoc-row').filter({ hasText: name }).first().click();
}
export const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });

/** Put one compartment back to its seeded state (Alpha, Beta assigned; Gamma free; no mounts; empty design) so a flow can repeat on another project. */
export async function resetCompartment(request, id) {
  const names = toolNames(id);
  const planner = await plannerOf(request);
  const cur = planner.doc.allocations[id];
  const want = cur.map((v, i) => (i === 0 ? names.alpha : i === 1 ? names.beta : ''));
  const ops = want.flatMap((value, index) => (cur[index] === value ? [] : [{ op: 'setSlot', comp: id, index, value, expect: cur[index] }]));
  if (ops.length) {
    const r = await request.post('/api/planner/ops', { data: { baseRevision: planner.revision, clientOpId: `qa-reset-${id}-${Date.now()}`, ops } });
    expect(r.ok()).toBeTruthy();
    expect((await r.json()).conflicts).toEqual([]);
  }
  for (const m of (await getJson(request, `/api/compartments/${id}/mounts`)).mounts) expect((await request.delete(`/api/mounts/${m.id}`)).ok()).toBeTruthy();
  const { design } = await getJson(request, `/api/compartments/${id}/design`);
  if (design.layout.placements?.length || design.layout.notes) {
    expect((await request.put(`/api/compartments/${id}/design`, { data: { layout: { placements: [] }, expectRevision: design.revision } })).ok()).toBeTruthy();
  }
}

/** Make sure the compartment has at least one version (creates a plan-mode Fast Preview through the API and waits for the processor). */
export async function ensureVersion(request, id) {
  if ((await versionsOf(request, id)).length) return;
  const r = await request.post(`/api/compartments/${id}/jobs`, { headers: { 'Idempotency-Key': `qa-ensure-${id}-${Date.now()}` }, data: { kind: 'render', mode: 'plan', preset: 'preview' } });
  expect(r.status(), await r.text()).toBe(202);
  await expect.poll(async () => (await versionsOf(request, id)).length, { timeout: 60_000 }).toBeGreaterThan(0);
}
/** Press Tab until `locator` has focus (keyboard-only navigation). */
export async function tabTo(page, locator, max = 80) {
  for (let i = 0; i < max; i += 1) {
    if (await locator.evaluate(el => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Could not reach the element by keyboard');
}
export const STEP_IDS = ['photos', 'tools', 'mounts', 'arrange', 'generate', 'review', 'publish'];
