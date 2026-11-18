// Clearing a slot moves the items below it up (server-side removeSlot): the moved items keep their assignment ids and
// bundles follow their items; removing an inventory item packs every compartment it was in. In-memory fake API.
import { expect, test } from '@playwright/test';
import { FakeApi } from './helpers/fake-api.js';

const A = '6 lb Flathead Axe';
const B = 'Irons';
const C = '36 in Bolt Cutter';
const D = 'Hi-Lift Jack';
const pill = page => page.locator('[data-testid=sync-status]:visible').last();
const slot = (page, n) => page.getByRole('combobox', { name: `Equipment for slot ${n}`, exact: true });

function seeded() {
  const api = new FakeApi();
  const slots = Array(15).fill('');
  [A, B, C, D].forEach((n, i) => { slots[i] = n; });
  api.seed({ allocations: { ...api.doc.allocations, LS1: slots, RS1: [A, ...Array(14).fill('')] }, bundles: { LS1: [{ id: 'bndl0001', name: 'Low pair', colorIdx: 1, slotIndices: [2, 3] }] } });
  return api;
}

async function openDevice(browser, api) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await api.install(context);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByText('Loading L1 Compartment Builder')).toBeHidden();
  await expect(pill(page)).toHaveText(/Saved/);
  await page.getByRole('button', { name: /^LS1/ }).click();
  return { context, page };
}

test('clearing a middle slot moves the items below up, keeps their ids and bundles, on reload and on a second device', async ({ browser }) => {
  const api = seeded();
  const idsBefore = [...api.doc.assignmentIds.LS1];
  const { page, context } = await openDevice(browser, api);
  await expect(slot(page, 2)).toHaveText(B);

  await page.getByRole('button', { name: 'Clear slot 2', exact: true }).click();
  // Immediately, in the UI: C and D moved up, the last used slot is empty.
  await expect(slot(page, 2)).toHaveText(C);
  await expect(slot(page, 3)).toHaveText(D);
  await expect(slot(page, 4)).not.toHaveText(D);
  await expect(pill(page)).toHaveText(/Saved/);

  await expect.poll(() => api.doc.allocations.LS1.slice(0, 5)).toEqual([A, C, D, '', '']);
  expect(api.doc.allocations.LS1).toHaveLength(15);
  expect(api.doc.assignmentIds.LS1.slice(0, 3)).toEqual([idsBefore[0], idsBefore[2], idsBefore[3]]);
  expect(api.doc.assignmentIds.LS1[3]).toBeNull();
  expect(api.doc.bundles.LS1[0].slotIndices).toEqual([1, 2]);
  expect(api.opLog.flatMap(b => b.ops).some(o => o.op === 'removeSlot')).toBe(true);
  // The bundle below the cleared slot still shows its items.
  await expect(page.getByText('Low pair').first()).toBeVisible();

  await page.reload();
  await expect(page.getByText('Loading L1 Compartment Builder')).toBeHidden();
  await page.getByRole('button', { name: /^LS1/ }).click();
  await expect(slot(page, 2)).toHaveText(C);
  await expect(slot(page, 3)).toHaveText(D);

  const second = await openDevice(browser, api);
  await expect(slot(second.page, 1)).toHaveText(A);
  await expect(slot(second.page, 2)).toHaveText(C);
  await expect(slot(second.page, 3)).toHaveText(D);
  await second.context.close();
  await context.close();
});

test('removing an inventory item packs every compartment it was in', async ({ browser }) => {
  const api = seeded();
  const { page, context } = await openDevice(browser, api);
  await page.getByRole('button', { name: 'Inventory Status', exact: true }).click();
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: `Remove ${A}`, exact: true }).click();
  await expect.poll(() => api.doc.removedItems).toContain(A);
  expect(api.doc.allocations.LS1.slice(0, 4)).toEqual([B, C, D, '']);
  expect(api.doc.allocations.RS1.every(v => v === '')).toBe(true);
  expect(api.doc.bundles.LS1[0].slotIndices).toEqual([1, 2]);
  const ops = api.opLog.flatMap(b => b.ops);
  expect(ops.filter(o => o.op === 'setSlot')).toEqual([]);
  await context.close();
});
