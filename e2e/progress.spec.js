// Read-only Placement Progress page. Runs against the in-memory fake API (no real data).
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { FakeApi } from './helpers/fake-api.js';

test.describe.configure({ timeout: 60_000 });

const PLACED = 'Hi-Lift Jack';
const PENDING = '1 Ton Griphoist';
const pill = page => page.locator('[data-testid=sync-status]:visible').last();

async function open(browser, api, { width = 1440, height = 900, signedIn = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  await api.install(context, { signedIn });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByText('Loading L1 Compartment Builder')).toBeHidden();
  return { context, page };
}

function seeded() {
  const api = new FakeApi();
  const ls1 = [...api.doc.allocations.LS1]; ls1[0] = PLACED;
  api.seed({ allocations: { ...api.doc.allocations, LS1: ls1 } });
  return api;
}

test('reachable from the desktop sidebar; shows placed and pending items; filter works', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'desktop scenario runs once');
  const { page, context } = await open(browser, seeded());
  await page.getByRole('button', { name: 'Placement Progress', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Placement Progress', exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', /^[1-9]/);
  await expect(page.getByTestId('progress-comp-LS1')).toContainText(`${PLACED} × 1`);
  await expect(page.getByTestId('progress-comp-LS2')).toContainText('Nothing placed yet');
  const pending = page.locator('section[aria-labelledby=progress-pending]');
  await expect(pending).toContainText(PENDING);
  await expect(pending).toContainText(/0 of \d+ placed — \d+ to place/);

  await page.getByLabel('Filter equipment').fill('griphoist');
  await expect(pending).toContainText(PENDING);
  await expect(pending).not.toContainText('Hi-Lift');
  await expect(page.getByTestId('progress-comp-LS1')).toHaveCount(0);
  await page.getByLabel('Filter equipment').fill('hi-lift');
  await expect(page.getByTestId('progress-comp-LS1')).toContainText(PLACED);
  await expect(pending).not.toContainText(PENDING);

  await page.getByLabel('Filter equipment').fill('');
  await page.getByTestId('progress-comp-LS1').getByRole('button').click();
  await expect(page.getByRole('heading', { name: 'Compartment LS1', exact: true })).toBeVisible();
  await context.close();
});

test('reachable from the mobile drawer, no horizontal overflow at 320px, and passes axe', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'uses its own 320px viewport');
  const { page, context } = await open(browser, seeded(), { width: 320, height: 700, signedIn: false });
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: 'Placement Progress', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Placement Progress', exact: true })).toBeVisible();
  await expect(page.getByTestId('progress-comp-LS1')).toContainText(PLACED);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const inner = await page.evaluate(() => [...document.querySelectorAll('main *')].filter(el => el.getBoundingClientRect().right > window.innerWidth + 1).length);
  expect(inner).toBe(0);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map(v => [v.id, v.nodes.map(n => n.target.join(' '))])).toEqual([]);
  await context.close();
});

test('assigning an item in a compartment moves it from pending to placed', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'desktop scenario runs once');
  const api = seeded();
  const { page, context } = await open(browser, api);
  await expect(pill(page)).toHaveText(/Saved/);
  await page.getByRole('button', { name: 'Placement Progress', exact: true }).click();
  const pending = page.locator('section[aria-labelledby=progress-pending]');
  await expect(pending).toContainText(PENDING);
  await expect(page.getByTestId('progress-comp-LS2')).toContainText('Nothing placed yet');

  await page.getByRole('button', { name: /^LS2/, exact: false }).first().click();
  const slot = page.getByRole('combobox', { name: 'Equipment for slot 1', exact: true });
  await slot.click();
  await page.getByRole('searchbox', { name: /search equipment/i }).fill('Griphoist');
  await page.getByRole('option', { name: /1 Ton Griphoist/ }).first().click();
  await expect.poll(() => api.doc.allocations.LS2[0]).toBe(PENDING);

  await page.getByRole('button', { name: 'Placement Progress', exact: true }).click();
  await expect(page.getByTestId('progress-comp-LS2')).toContainText(`${PENDING} × 1`);
  await page.getByLabel('Filter equipment').fill('griphoist');
  // Still pending only if more than one unit is required; otherwise it has left the list.
  const remaining = await pending.getByText(/\d+ of \d+ placed — \d+ to place/).count();
  if (remaining) await expect(pending).toContainText('Already in: LS2');
  else await expect(pending).not.toContainText(PENDING);
  await context.close();
});
