// An editor adds a new inventory item, finds it in a compartment's equipment dropdown, assigns it, and later removes it
// from the inventory (which clears the slot). Runs against the in-memory fake API (no real data).
import { expect, test } from '@playwright/test';
import { FakeApi } from './helpers/fake-api.js';

const NEW_ITEM = 'Honda EU2000i Whisper Generator';
const pill = page => page.locator('[data-testid=sync-status]:visible').last();

async function openDevice(browser, api) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await api.install(context);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByText('Loading L1 Compartment Builder')).toBeHidden();
  await expect(pill(page)).toHaveText(/Saved/);
  return { context, page };
}

test('a new item can be added, assigned from the dropdown, and removed again', async ({ browser }) => {
  const api = new FakeApi();
  const { page, context } = await openDevice(browser, api);

  // Add it to the inventory.
  await page.getByRole('button', { name: 'Inventory Status', exact: true }).click();
  await page.getByLabel('Custom tool name').fill(NEW_ITEM);
  await page.getByLabel('Custom tool quantity').fill('1');
  await page.getByRole('button', { name: 'Add Tool' }).click();
  await expect(page.getByText(NEW_ITEM, { exact: true })).toBeVisible();
  await expect.poll(() => api.doc.customTools.map(t => t.name)).toContain(NEW_ITEM);

  // It is offered in LS1's searchable equipment dropdown and can be assigned.
  await page.getByRole('button', { name: /^LS1/ }).click();
  const slot = page.getByRole('combobox', { name: 'Equipment for slot 2', exact: true });
  await slot.click();
  await page.getByRole('searchbox', { name: /search equipment/i }).fill('Whisper');
  await page.getByRole('option', { name: /Honda EU2000i Whisper Generator/ }).first().click();
  await expect(slot).toHaveText(NEW_ITEM);
  await expect.poll(() => api.doc.allocations.LS1[1]).toBe(NEW_ITEM);
  await expect(pill(page)).toHaveText(/Saved/);

  // Quantity 1 is now used up: the dropdown of another slot no longer offers it as available.
  await page.getByRole('combobox', { name: 'Equipment for slot 3', exact: true }).click();
  await page.getByRole('searchbox', { name: /search equipment/i }).fill('Whisper');
  await expect(page.getByRole('option', { name: /Honda EU2000i Whisper Generator/ })).toHaveCount(0);
  await page.getByRole('searchbox', { name: /search equipment/i }).press('Escape');

  // Remove it from the inventory: it disappears and its slot is cleared, on this device and on the server.
  await page.getByRole('button', { name: 'Inventory Status', exact: true }).click();
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: `Remove ${NEW_ITEM}`, exact: true }).click();
  await expect(page.getByText(NEW_ITEM, { exact: true })).toHaveCount(0);
  await expect.poll(() => api.doc.customTools.map(t => t.name)).not.toContain(NEW_ITEM);
  await expect.poll(() => api.doc.allocations.LS1[1]).toBe('');
  await context.close();
});

test('a standard catalog item can be removed from the inventory and stays removed after reload', async ({ browser }) => {
  const api = new FakeApi();
  const { page, context } = await openDevice(browser, api);
  await page.getByRole('button', { name: 'Inventory Status', exact: true }).click();
  page.once('dialog', d => d.accept());
  await page.getByRole('button', { name: 'Remove Hi-Lift Jack', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove Hi-Lift Jack', exact: true })).toHaveCount(0);
  await expect.poll(() => api.doc.removedItems).toContain('Hi-Lift Jack');
  await page.reload();
  await expect(page.getByText('Loading L1 Compartment Builder')).toBeHidden();
  await page.getByRole('button', { name: 'Inventory Status', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove Hi-Lift Jack', exact: true })).toHaveCount(0);
  await context.close();
});
