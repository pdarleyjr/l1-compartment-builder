// Audit reproduction (sync-data part). Every request to the production Worker URL is intercepted
// and served by the REAL worker/index.js module backed by an in-memory KV that is shared between
// browser contexts (= two devices). Nothing reaches the network. test.fail() = documented defect;
// the body asserts the CORRECT behaviour.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import worker from '../worker/index.js';

const WORKER_URL = 'https://l1-state-sync.pdarleyjr.workers.dev';
const ORIGIN = 'http://127.0.0.1:4173';
const COMPS = ['CabRearZone', 'LS1', 'LS2', 'LS3', 'LS4', 'RS1', 'RS2', 'RS3', 'RS4', 'RS5', 'RR1'];
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const TINY_URL = `data:image/png;base64,${TINY_PNG}`;
const HOIST = '1 Ton Griphoist'; // standard inventory item, qty 1
const FOG = '1 1/2 Fog Nozzles'; // standard inventory item, qty 1

test.beforeEach(({ browserName: _b }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'multi-device scenarios run once, at desktop size');
});
test.describe.configure({ timeout: 60_000 });
// AUDIT_RAW=1 disables the expected-failure marker so the real assertion failures can be inspected.
const knownDefect = () => { if (!process.env.AUDIT_RAW) test.fail(); };

// The installed @playwright/test wants a chromium revision that is not in this worker's cache. If the
// default executable is missing, fall back to whatever chromium_headless_shell revision is cached.
function cachedHeadlessShell() {
  const root = path.join(process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright'));
  try {
    for (const dir of fs.readdirSync(root).filter(d => d.startsWith('chromium_headless_shell-')).sort().reverse()) {
      const exe = path.join(root, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      if (fs.existsSync(exe)) return exe;
    }
  } catch { /* no cache */ }
  return undefined;
}
const defaultMissing = !fs.existsSync(path.join(os.homedir(), '.cache', 'ms-playwright', 'chromium_headless_shell-1217'));
if (defaultMissing && cachedHeadlessShell()) test.use({ launchOptions: { executablePath: cachedHeadlessShell() } });

function makeBackend() {
  const store = new Map();
  const be = {
    store,
    puts: [],
    failStatePut: false,
    imagesPutStatus: null,
    frozen: { A: false, B: false },
    snap: {},
    env: { L1_STATE: { async get(k) { return store.has(k) ? store.get(k) : null; }, async put(k, v) { store.set(k, v); } } },
    state: () => JSON.parse(store.get('allocations') ?? 'null'),
    images: () => JSON.parse(store.get('images') ?? 'null'),
    seedState(patch = {}) {
      const allocations = Object.fromEntries(COMPS.map(c => [c, Array(15).fill('')]));
      store.set('allocations', JSON.stringify({ allocations, customQtys: {}, customTools: [], bundles: {}, removedItems: [], customDimensions: {}, ...patch, _serverTs: 1 }));
    },
    seedImages(uploadedImages, featuredImages = {}) {
      store.set('images', JSON.stringify({ uploadedImages, featuredImages, _serverTs: 1 }));
    },
  };
  return be;
}

async function openDevice(browser, be, name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route(`${WORKER_URL}/**`, async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': ORIGIN } });
    if (req.method() === 'POST' && url.pathname === '/generate-image') {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': ORIGIN }, body: JSON.stringify({ dataUrl: TINY_URL }) });
    }
    if (req.method() === 'GET' && be.frozen[name]) {
      const body = be.snap[`${name}${url.pathname}`] ?? 'null';
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': ORIGIN }, body });
    }
    if (req.method() === 'PUT' && url.pathname === '/state' && be.failStatePut === name) return route.abort('internetdisconnected');
    if (req.method() === 'PUT' && url.pathname === '/images' && be.imagesPutStatus) {
      return route.fulfill({ status: be.imagesPutStatus, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': ORIGIN }, body: '{"error":"Payload too large"}' });
    }
    const res = await worker.fetch(new Request(req.url(), { method: req.method(), headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: req.postData() ?? undefined }), be.env);
    return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() });
  });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/`);
  await expect(page.getByText(/Synced with team|Offline/)).toBeVisible({ timeout: 10_000 });
  return { context, page };
}

const freeze = (be, name) => {
  be.snap[`${name}/state`] = be.store.get('allocations') ?? 'null';
  be.snap[`${name}/images`] = be.store.get('images') ?? 'null';
  be.frozen[name] = true;
};

async function assignSlot(page, comp, slot, item) {
  await page.getByRole('button', { name: new RegExp(`^${comp}`) }).click();
  await page.getByRole('combobox', { name: `Equipment for slot ${slot}`, exact: true }).click();
  await page.getByRole('searchbox', { name: /search equipment/i }).fill(item);
  await page.getByRole('option', { name: new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click();
}

const photo = (uid, title = uid) => ({ uid, title, fileName: `${uid}.png`, dataUrl: TINY_URL });
const localJson = (page, key) => page.evaluate(k => JSON.parse(localStorage.getItem(k) ?? 'null'), key);

test('SD-01 two devices editing different compartments do not lose either edit', async ({ browser }) => {
  knownDefect(); // observed: B's full-document PUT overwrites A's edit
  const be = makeBackend(); be.seedState();
  const a = await openDevice(browser, be, 'A');
  const b = await openDevice(browser, be, 'B');
  freeze(be, 'B'); // B has not polled yet (5 s poll window)
  await assignSlot(a.page, 'LS1', 1, HOIST);
  await expect.poll(() => be.state()?.allocations.LS1[0], { timeout: 5000 }).toBe(HOIST);
  await assignSlot(b.page, 'RS1', 1, FOG);
  await expect.poll(() => be.state()?.allocations.RS1[0], { timeout: 5000 }).toBe(FOG);
  const saved = be.state().allocations;
  expect([saved.LS1[0], saved.RS1[0]]).toEqual([HOIST, FOG]);
});

test('SD-09 (evidence) concurrent assignment of the last unit does not over-allocate, it loses one update', async ({ browser }) => {
  const be = makeBackend(); be.seedState();
  const a = await openDevice(browser, be, 'A');
  const b = await openDevice(browser, be, 'B');
  freeze(be, 'B');
  await assignSlot(a.page, 'LS1', 1, HOIST);
  await expect.poll(() => be.state()?.allocations.LS1[0]).toBe(HOIST);
  await assignSlot(b.page, 'RS1', 1, HOIST); // B still sees the unit as free
  await expect.poll(() => be.state()?.allocations.RS1[0]).toBe(HOIST);
  const placed = Object.values(be.state().allocations).flat().filter(s => s === HOIST).length;
  expect(placed).toBe(1); // qty 1: no over-allocation in KV, but only because A's placement was erased (SD-01)
  expect(be.state().allocations.LS1[0]).toBe('');
});

test('SD-02 a photo deleted on device A disappears from device B on its next pull', async ({ browser }) => {
  knownDefect(); // observed: additive merge never removes it
  const be = makeBackend(); be.seedState(); be.seedImages({ LS1: [photo('x-photo')] });
  const a = await openDevice(browser, be, 'A');
  const b = await openDevice(browser, be, 'B');
  await a.page.getByRole('button', { name: /^LS1/ }).click();
  await a.page.getByRole('button', { name: 'Show image 2 of 2' }).click();
  await a.page.getByRole('button', { name: 'Remove this image' }).click();
  await expect.poll(() => be.images()?.uploadedImages.LS1.length, { timeout: 5000 }).toBe(0);
  await b.page.waitForTimeout(7000); // > one 5 s poll
  const bLocal = await localJson(b.page, 'l1-compartment-builder-uploads');
  expect(bLocal.LS1 ?? []).toHaveLength(0);
});

test('SD-03 reloading a device that still holds a deleted photo does not resurrect it in KV', async ({ browser }) => {
  knownDefect(); // observed: B pushes its stale local copy back on load
  const be = makeBackend(); be.seedState(); be.seedImages({ LS1: [photo('x-photo')] });
  const a = await openDevice(browser, be, 'A');
  const b = await openDevice(browser, be, 'B');
  await a.page.getByRole('button', { name: /^LS1/ }).click();
  await a.page.getByRole('button', { name: 'Show image 2 of 2' }).click();
  await a.page.getByRole('button', { name: 'Remove this image' }).click();
  await expect.poll(() => be.images()?.uploadedImages.LS1.length, { timeout: 5000 }).toBe(0);
  await b.page.reload();
  await expect(b.page.getByText(/Synced with team|Offline/)).toBeVisible();
  await b.page.waitForTimeout(3000);
  expect(be.images().uploadedImages.LS1 ?? []).toHaveLength(0);
});

test('SD-04 a featured-image change on device A replaces the featured image on device B', async ({ browser }) => {
  knownDefect(); // observed: B keeps its local featured selection ("remote wins only if local has none")
  const be = makeBackend(); be.seedState();
  be.seedImages({}, { LS2: { kind: 'preset', src: '/images/LS2.webp' } });
  const a = await openDevice(browser, be, 'A');
  const b = await openDevice(browser, be, 'B');
  await a.page.getByRole('button', { name: /^LS2/ }).click();
  await a.page.getByRole('button', { name: 'Show image 2 of 2' }).click();
  await a.page.getByRole('button', { name: 'Set as featured image' }).click();
  await expect.poll(() => be.images()?.featuredImages.LS2?.src, { timeout: 5000 }).toBe('/images/LS2_rendering.webp');
  await b.page.waitForTimeout(7000);
  expect((await localJson(b.page, 'l1-compartment-builder-featured')).LS2.src).toBe('/images/LS2_rendering.webp');
});

test('SD-04 removing the featured image on device A clears it on device B', async ({ browser }) => {
  knownDefect(); // observed: B keeps showing the removed featured selection
  const be = makeBackend(); be.seedState();
  be.seedImages({}, { LS2: { kind: 'preset', src: '/images/LS2.webp' } });
  const a = await openDevice(browser, be, 'A');
  const b = await openDevice(browser, be, 'B');
  await a.page.getByRole('button', { name: /^LS2/ }).click();
  await a.page.getByRole('button', { name: 'Remove as featured image' }).click();
  await expect.poll(() => be.images()?.featuredImages.LS2, { timeout: 5000 }).toBeUndefined();
  await b.page.waitForTimeout(7000);
  expect((await localJson(b.page, 'l1-compartment-builder-featured')).LS2).toBeUndefined();
});

test('SD-06 an edit made while the state PUT fails is retried once connectivity returns', async ({ browser }) => {
  knownDefect(); // observed: nothing retries until another edit happens (or a pull overwrites it)
  const be = makeBackend(); be.seedState();
  const a = await openDevice(browser, be, 'A');
  be.failStatePut = 'A';
  await assignSlot(a.page, 'LS1', 1, HOIST);
  await a.page.waitForTimeout(1500);
  expect(be.state().allocations.LS1[0]).toBe('');
  be.failStatePut = false; // network back
  await expect.poll(() => be.state().allocations.LS1[0], { timeout: 12_000 }).toBe(HOIST);
});

test('SD-06b an offline edit survives a reload once the network is back', async ({ browser }) => {
  knownDefect(); // observed: initial pull replaces local state wholesale with the server copy
  const be = makeBackend(); be.seedState();
  const a = await openDevice(browser, be, 'A');
  be.failStatePut = 'A';
  await assignSlot(a.page, 'LS1', 1, HOIST);
  await a.page.waitForTimeout(1500);
  be.failStatePut = false;
  await a.page.reload();
  await expect(a.page.getByText(/Synced with team|Offline/)).toBeVisible();
  await a.page.getByRole('button', { name: /^LS1/ }).click();
  await expect(a.page.getByRole('combobox', { name: 'Equipment for slot 1', exact: true })).toHaveText(HOIST);
});

test('SD-16 a rejected image PUT keeps showing as a sync problem instead of reverting to "Synced"', async ({ browser }) => {
  knownDefect(); // observed: next successful GET poll resets the indicator to "Synced with team"
  const be = makeBackend(); be.seedState(); be.imagesPutStatus = 413;
  const a = await openDevice(browser, be, 'A');
  await a.page.waitForTimeout(7500);
  await expect(a.page.getByText(/Offline/)).toBeVisible();
});

test('SD-17 an AI-generated image records its source and the inventory it was generated from', async ({ browser }) => {
  knownDefect(); // observed: entry is only {dataUrl,title,fileName,uid}
  const be = makeBackend(); be.seedState();
  const a = await openDevice(browser, be, 'A');
  await assignSlot(a.page, 'LS1', 1, HOIST);
  await a.page.getByRole('button', { name: 'Generate AI Rendering', exact: true }).click();
  await expect.poll(() => be.images()?.uploadedImages?.LS1?.length, { timeout: 8000 }).toBe(1);
  const entry = be.images().uploadedImages.LS1[0];
  expect(entry.source ?? entry.generatedFrom ?? entry.inventorySnapshot).toBeTruthy();
});

test('SD-07 removing a standard item and re-adding the same name as custom keeps the new quantity', async ({ browser }) => {
  knownDefect(); // observed: getQty() prefers the built-in quantity
  const be = makeBackend(); be.seedState();
  const { page } = await openDevice(browser, be, 'A');
  await page.getByRole('button', { name: 'Inventory Status', exact: true }).click();
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: `Remove ${HOIST}`, exact: true }).click();
  await page.getByLabel('Custom tool name').fill(HOIST);
  await page.getByLabel('Custom tool quantity').fill('5');
  await page.getByRole('button', { name: 'Add Tool' }).click();
  const qtyCell = page.locator('tr', { hasText: HOIST }).locator('td').nth(1);
  await expect(qtyCell).toHaveText('5');
});

test('SD-07 renaming a standard item away and back, then removing it, really removes it', async ({ browser }) => {
  knownDefect(); // observed: the leftover custom copy keeps the row alive
  const be = makeBackend(); be.seedState();
  const { page } = await openDevice(browser, be, 'A');
  await page.getByRole('button', { name: 'Inventory Status', exact: true }).click();
  const rename = async (from, to) => {
    await page.getByRole('button', { name: `Edit ${from}`, exact: true }).click();
    await page.getByLabel(`Equipment name for ${from}`).fill(to);
    await page.getByRole('button', { name: `Save changes for ${from}`, exact: true }).click();
  };
  await rename(HOIST, 'Synthetic Hoist');
  await rename('Synthetic Hoist', HOIST);
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: `Remove ${HOIST}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `Remove ${HOIST}`, exact: true })).toHaveCount(0);
});

test('SD-08 Reset All does not leave bundles pointing at emptied slots', async ({ browser }) => {
  knownDefect(); // observed: bundles are untouched by handleReset()
  const be = makeBackend();
  const allocations = Object.fromEntries(COMPS.map(c => [c, Array(15).fill('')]));
  allocations.LS1[0] = HOIST; allocations.LS1[1] = FOG;
  be.seedState({ allocations, bundles: { LS1: [{ id: 'b1', name: 'Synthetic Kit', colorIdx: 0, slotIndices: [0, 1] }] } });
  const { page } = await openDevice(browser, be, 'A');
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Reset All' }).click();
  await expect.poll(() => be.state().allocations.LS1[0], { timeout: 5000 }).toBe('');
  const remaining = (be.state().bundles.LS1 ?? []).flatMap(b => b.slotIndices);
  expect(remaining).toEqual([]);
});

test('SD-08 removing an inventory item prunes it from bundles', async ({ browser }) => {
  knownDefect(); // observed: allocations are blanked but bundle slotIndices stay
  const be = makeBackend();
  const allocations = Object.fromEntries(COMPS.map(c => [c, Array(15).fill('')]));
  allocations.LS1[0] = HOIST; allocations.LS1[1] = FOG;
  be.seedState({ allocations, bundles: { LS1: [{ id: 'b1', name: 'Synthetic Kit', colorIdx: 0, slotIndices: [0, 1] }] } });
  const { page } = await openDevice(browser, be, 'A');
  await page.getByRole('button', { name: 'Inventory Status', exact: true }).click();
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: `Remove ${HOIST}`, exact: true }).click();
  await expect.poll(() => be.state().allocations.LS1[0], { timeout: 5000 }).toBe('');
  expect((be.state().bundles.LS1 ?? []).flatMap(b => b.slotIndices)).toEqual([1]);
});

test('SD-05 (evidence) localStorage cannot hold an images document the Worker accepts (>~5M chars)', async ({ browser }) => {
  const be = makeBackend(); be.seedState();
  const { page } = await openDevice(browser, be, 'A'); // routed: never touches the real Worker
  const result = await page.evaluate(() => {
    const k = 'audit-quota-probe';
    let stored = 0;
    try { for (let n = 1_000_000; n <= 12_000_000; n += 1_000_000) { localStorage.setItem(k, 'A'.repeat(n)); stored = n; } }
    catch { /* quota */ }
    localStorage.removeItem(k);
    return stored;
  });
  console.log(`SD-05 largest single localStorage value accepted: ${result} chars (Worker accepts up to 12,000,000 B)`);
  expect(result).toBeLessThan(12_000_000);
});
