// Sync / data regression tests (docs/audit/sync-data.md, SD-01 … SD-18) against the same-origin API contract.
// Every request to /api is served by e2e/helpers/fake-api.js (in-memory planner document with revisions, galleries,
// main images); nothing reaches the network. Two browser contexts = two devices sharing one FakeApi.
// The old expected-failure reproductions of the KV/PUT design are now passing regression tests (or retired with a
// one-line note naming their replacement).
import { expect, test } from '@playwright/test';
import { FakeApi } from './helpers/fake-api.js';

const HOIST = '1 Ton Griphoist'; // standard inventory item, qty 1
const FOG = '1 1/2 Fog Nozzles'; // standard inventory item, qty 1

test.beforeEach(({ browserName: _b }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'multi-device scenarios run once, at desktop size');
});
test.describe.configure({ timeout: 60_000 });

const pill = page => page.locator('[data-testid=sync-status]:visible').last();

async function openDevice(browser, api, opts) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const device = await api.install(context, opts);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByText('Loading L1 Compartment Builder')).toBeHidden();
  await expect(pill(page)).toHaveText(/Saved|Sign in to save/);
  return { context, page, device };
}

async function assignSlot(page, comp, slot, item) {
  await page.getByRole('button', { name: new RegExp(`^${comp}`) }).click();
  await page.getByRole('combobox', { name: `Equipment for slot ${slot}`, exact: true }).click();
  await page.getByRole('searchbox', { name: /search equipment/i }).fill(item);
  await page.getByRole('option', { name: new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click();
}
const slotBox = (page, n) => page.getByRole('combobox', { name: `Equipment for slot ${n}`, exact: true });

test('SD-01 two devices editing different compartments do not lose either edit', async ({ browser }) => {
  const api = new FakeApi();
  const a = await openDevice(browser, api);
  const b = await openDevice(browser, api);
  b.device.freezeReads(); // B has not polled yet (5 s poll window)
  await assignSlot(a.page, 'LS1', 1, HOIST);
  await expect.poll(() => api.view().allocations.LS1[0], { timeout: 5000 }).toBe(HOIST);
  await assignSlot(b.page, 'RS1', 1, FOG);
  await expect.poll(() => api.view().allocations.RS1[0], { timeout: 5000 }).toBe(FOG);
  const saved = api.view().allocations;
  expect([saved.LS1[0], saved.RS1[0]]).toEqual([HOIST, FOG]);
  // B's screen also shows A's edit once its save round-trips (its base moved to the server document)
  await b.page.getByRole('button', { name: /^LS1/ }).click();
  await expect(slotBox(b.page, 1)).toHaveText(HOIST);
});

test('SD-01b a change to the same slot from a stale device is rejected with a notice naming slot and what was kept', async ({ browser }) => {
  const api = new FakeApi();
  const a = await openDevice(browser, api);
  const b = await openDevice(browser, api);
  b.device.freezeReads();
  await assignSlot(a.page, 'LS1', 1, HOIST);
  await expect.poll(() => api.view().allocations.LS1[0]).toBe(HOIST);
  await assignSlot(b.page, 'LS1', 1, FOG);
  const notice = b.page.getByRole('status').filter({ hasText: /LS1 slot 1/ });
  await expect(notice).toContainText('kept their change');
  await expect(slotBox(b.page, 1)).toHaveText(HOIST);
  expect(api.view().allocations.LS1[0]).toBe(HOIST);
  await notice.getByRole('button', { name: 'Dismiss notice' }).click();
  await expect(notice).toHaveCount(0);
});

test('SD-09 concurrent assignment of the last unit never over-allocates; the loser is told', async ({ browser }) => {
  const api = new FakeApi();
  const a = await openDevice(browser, api);
  const b = await openDevice(browser, api);
  b.device.freezeReads();
  await assignSlot(a.page, 'LS1', 1, HOIST);
  await expect.poll(() => api.view().allocations.LS1[0]).toBe(HOIST);
  await assignSlot(b.page, 'RS1', 1, HOIST); // B still sees the unit as free
  await expect(b.page.getByRole('status').filter({ hasText: /RS1 slot 1/ })).toBeVisible();
  const placed = Object.values(api.view().allocations).flat().filter(s => s === HOIST).length;
  expect(placed).toBe(1);
  expect(api.view().allocations.LS1[0]).toBe(HOIST); // A's placement is kept
  await expect(slotBox(b.page, 1)).toHaveText('— Empty Slot —');
});

test('SD-02/03 a photo deleted on device A is gone on device B and is never resurrected by a reload', async ({ browser }) => {
  const api = new FakeApi();
  api.addAsset('LS1', { title: 'x-photo' });
  const a = await openDevice(browser, api);
  const b = await openDevice(browser, api);
  await a.page.getByRole('button', { name: /^LS1/ }).click();
  await b.page.getByRole('button', { name: /^LS1/ }).click();
  await expect(b.page.getByRole('button', { name: 'Show image 2 of 2' })).toBeVisible();
  await a.page.getByRole('button', { name: 'Show image 2 of 2' }).click();
  a.page.once('dialog', d => d.accept());
  await a.page.getByRole('button', { name: 'Remove this image' }).click();
  await expect(a.page.getByRole('img', { name: 'x-photo' })).toHaveCount(0);
  await b.page.reload();
  await b.page.getByRole('button', { name: /^LS1/ }).click();
  await expect(b.page.getByRole('img', { name: 'Compartment Photo' })).toBeVisible();
  await expect(b.page.getByRole('button', { name: /Show image 2/ })).toHaveCount(0);
  await a.page.reload();
  await a.page.getByRole('button', { name: /^LS1/ }).click();
  await expect(a.page.getByRole('button', { name: /Show image 2/ })).toHaveCount(0);
});

test('SD-04 a main-image change on device A replaces the first image on device B', async ({ browser }) => {
  const api = new FakeApi();
  const a = await openDevice(browser, api);
  const b = await openDevice(browser, api);
  await a.page.getByRole('button', { name: /^LS2/ }).click();
  await a.page.getByRole('button', { name: 'Show image 2 of 2' }).click();
  await a.page.getByRole('button', { name: 'Set as main image' }).click();
  await expect.poll(() => api.mains.LS2?.ref).toBe('/images/LS2_rendering.webp');
  await b.page.reload();
  await b.page.getByRole('button', { name: /^LS2/ }).click();
  await expect(b.page.getByRole('img', { name: 'Rendering with Tools' })).toBeVisible();
  await expect(b.page.getByRole('button', { name: 'Show image 1 of 2' })).toHaveAttribute('aria-current', 'true');
  await expect(b.page.getByText('main image', { exact: true })).toBeVisible();
});

// SD-04b (clearing a featured image) is retired: the action no longer exists; replaced by SD-04 above (main images are replaced or restored in the Studio).

test('SD-06 an edit made while the ops POST fails is retried once connectivity returns', async ({ browser }) => {
  const api = new FakeApi();
  const a = await openDevice(browser, api);
  a.device.failOps = 'network';
  await assignSlot(a.page, 'LS1', 1, HOIST);
  await expect(pill(a.page)).toHaveText('Offline — changes queued');
  expect(api.view().allocations.LS1[0]).toBe('');
  a.device.failOps = null; // network back
  await expect.poll(() => api.view().allocations.LS1[0], { timeout: 15_000 }).toBe(HOIST);
  await expect(pill(a.page)).toHaveText('Saved');
});

test('SD-06b an offline edit survives a reload (and a second reload) and is delivered when the network is back', async ({ browser }) => {
  const api = new FakeApi();
  const a = await openDevice(browser, api);
  a.device.failOps = 'network';
  await assignSlot(a.page, 'LS1', 1, HOIST);
  await expect(pill(a.page)).toHaveText('Offline — changes queued');
  await a.page.reload();
  await expect(a.page.getByText('Loading L1 Compartment Builder')).toBeHidden();
  await a.page.getByRole('button', { name: /^LS1/ }).click();
  await expect(slotBox(a.page, 1)).toHaveText(HOIST);
  await a.page.reload();
  await a.page.getByRole('button', { name: /^LS1/ }).click();
  await expect(slotBox(a.page, 1)).toHaveText(HOIST);
  expect(api.view().allocations.LS1[0]).toBe('');
  a.device.failOps = null;
  await expect.poll(() => api.view().allocations.LS1[0], { timeout: 15_000 }).toBe(HOIST);
});

test('SD-16 a failing save keeps showing a sync problem instead of reverting to "Saved"', async ({ browser }) => {
  const api = new FakeApi();
  const a = await openDevice(browser, api);
  a.device.failOps = 500;
  await assignSlot(a.page, 'LS1', 1, HOIST);
  await expect(pill(a.page)).toHaveText('Sync problem (retrying)');
  await a.page.waitForTimeout(6500); // longer than one 5 s poll, which succeeds
  await expect(pill(a.page)).toHaveText('Sync problem (retrying)');
  await expect(slotBox(a.page, 1)).toHaveText(HOIST); // the local edit is still shown and still queued
});

// SD-17 (no binding between images and inventory) is retired: replaced by the server-side inventory fingerprint + stale badge, covered by the carousel test in e2e/l1.spec.js.

test('SD-18 a pull never overwrites an edit that is still being sent', async ({ browser }) => {
  const api = new FakeApi();
  const a = await openDevice(browser, api);
  a.device.failOps = 'network'; // A's edit stays unsent
  await assignSlot(a.page, 'LS1', 1, HOIST);
  api.applyDirect([{ op: 'setSlot', comp: 'RS1', index: 0, value: FOG, expect: '' }]); // a teammate edits elsewhere
  await a.page.waitForTimeout(6500); // A pulls the teammate's revision
  await a.page.getByRole('button', { name: /^RS1/ }).click();
  await expect(slotBox(a.page, 1)).toHaveText(FOG);
  await a.page.getByRole('button', { name: /^LS1/ }).click();
  await expect(slotBox(a.page, 1)).toHaveText(HOIST);
  a.device.failOps = null;
  await expect.poll(() => api.view().allocations.LS1[0], { timeout: 15_000 }).toBe(HOIST);
  expect(api.view().allocations.RS1[0]).toBe(FOG);
});

test('SD-07 removing a standard item and re-adding the same name as custom keeps the new quantity', async ({ browser }) => {
  const { page } = await openDevice(browser, new FakeApi());
  await page.getByRole('button', { name: 'Inventory Status', exact: true }).click();
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: `Remove ${HOIST}`, exact: true }).click();
  await page.getByLabel('Custom tool name').fill(HOIST);
  await page.getByLabel('Custom tool quantity').fill('5');
  await page.getByRole('button', { name: 'Add Tool' }).click();
  await expect(page.locator('tr', { hasText: HOIST }).locator('td').nth(1)).toHaveText('5');
});

test('SD-07 renaming a standard item away and back, then removing it, really removes it', async ({ browser }) => {
  const { page } = await openDevice(browser, new FakeApi());
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

test('rename in Inventory Status keeps the equipment id, assignment ids and bundles consistent', async ({ browser }) => {
  const api = new FakeApi();
  const a = await openDevice(browser, api);
  await assignSlot(a.page, 'LS1', 1, HOIST);
  await a.page.getByRole('combobox', { name: 'Equipment for slot 2', exact: true }).click();
  await a.page.getByRole('searchbox', { name: /search equipment/i }).fill('Fog');
  await a.page.getByRole('option', { name: /1 1\/2 Fog Nozzles/ }).first().click();
  await a.page.getByRole('button', { name: 'Create Bundle' }).click();
  await a.page.getByRole('button', { name: /Add slot 1 to bundle/ }).click();
  await a.page.getByRole('button', { name: /Add slot 2 to bundle/ }).click();
  await a.page.getByRole('button', { name: 'Bundle 2 Selected Slots' }).click();
  await a.page.getByPlaceholder(/Bundle name/).fill('Kit');
  await a.page.getByRole('button', { name: 'Save Bundle' }).click();
  await expect.poll(() => api.view().bundles.LS1?.length).toBe(1);
  const before = { eq: api.doc.equipmentIds[HOIST], as: api.doc.assignmentIds.LS1[0] };
  expect(before.eq).toBeTruthy();

  await a.page.getByRole('button', { name: 'Inventory Status', exact: true }).click();
  await a.page.getByRole('button', { name: `Edit ${HOIST}`, exact: true }).click();
  await a.page.getByLabel(`Equipment name for ${HOIST}`).fill('Synthetic Hoist');
  await a.page.getByRole('button', { name: `Save changes for ${HOIST}`, exact: true }).click();
  await expect.poll(() => api.view().allocations.LS1[0]).toBe('Synthetic Hoist');
  expect(JSON.stringify(api.opLog.at(-1).ops)).toContain('renameEquipment'); // the rename hint reached the server
  expect(api.doc.equipmentIds['Synthetic Hoist']).toBe(before.eq);
  expect(api.doc.assignmentIds.LS1[0]).toBe(before.as);
  expect(api.view().bundles.LS1[0].slotIndices).toEqual([0, 1]);
  await a.page.getByRole('button', { name: /^LS1/ }).click();
  await expect(slotBox(a.page, 1)).toHaveText('Synthetic Hoist');
});

test('SD-08 Reset All does not leave bundles pointing at emptied slots', async ({ browser }) => {
  const base = new FakeApi().view();
  const api = new FakeApi({ patch: { allocations: { ...base.allocations, LS1: [HOIST, FOG, ...Array(13).fill('')] }, bundles: { LS1: [{ id: 'b1', name: 'Synthetic Kit', colorIdx: 0, slotIndices: [0, 1] }] } } });
  const { page } = await openDevice(browser, api);
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Reset All' }).click();
  await expect.poll(() => api.view().allocations.LS1[0], { timeout: 5000 }).toBe('');
  expect((api.view().bundles.LS1 ?? []).flatMap(b => b.slotIndices)).toEqual([]);
});

test('SD-08 removing an inventory item prunes it from bundles', async ({ browser }) => {
  const base = new FakeApi().view();
  const api = new FakeApi({ patch: { allocations: { ...base.allocations, LS1: [HOIST, FOG, ...Array(13).fill('')] }, bundles: { LS1: [{ id: 'b1', name: 'Synthetic Kit', colorIdx: 0, slotIndices: [0, 1] }] } } });
  const { page } = await openDevice(browser, api);
  await page.getByRole('button', { name: 'Inventory Status', exact: true }).click();
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: `Remove ${HOIST}`, exact: true }).click();
  await expect.poll(() => api.view().allocations.LS1[0], { timeout: 5000 }).toBe('');
  expect((api.view().bundles.LS1 ?? []).flatMap(b => b.slotIndices)).toEqual([1]);
});

test('SD-05 (replaced) photos are never stored in localStorage; only the planner cache and queue are', async ({ browser }) => {
  const api = new FakeApi();
  api.addAsset('LS1', { title: 'big-photo' });
  const { page } = await openDevice(browser, api);
  await page.getByRole('button', { name: /^LS1/ }).click();
  await expect(page.getByRole('img', { name: 'big-photo' }).or(page.getByRole('button', { name: 'Show image 2 of 2' }))).toBeVisible();
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.filter(k => /upload|featured|image/i.test(k))).toEqual([]);
  expect(keys).toContain('l1-planner-sync-v5');
  const sizes = await page.evaluate(() => Object.values(localStorage).reduce((n, v) => n + v.length, 0));
  expect(sizes).toBeLessThan(200_000);
});

test('pulls use ?since= and an unchanged document answers 304 (no full re-download every 5 s)', async ({ browser }) => {
  const api = new FakeApi();
  await openDevice(browser, api);
  const before = api.counts.plannerFull;
  await new Promise(r => setTimeout(r, 11_500));
  expect(api.counts.plannerFull).toBe(before);
  expect(api.counts.plannerNotModified).toBeGreaterThanOrEqual(1);
});
