// Workbook + checklist-transfer export (docs/architecture/notes-verification-transfer.md §3–4). Served by the fake API.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { FakeApi } from './helpers/fake-api.js';

const HOIST = '1 Ton Griphoist';
const exportButton = page => page.getByRole('button', { name: 'Export Excel' }).first();

async function boot(page, api = new FakeApi()) {
  const device = await api.install(page);
  await page.goto('/');
  await expect(page.getByText('Loading L1 Compartment Builder')).toBeHidden();
  return { api, device };
}

test('Export Excel downloads the workbook, then the matching checklist transfer JSON', async ({ page }) => {
  await boot(page);
  const wb = page.waitForEvent('download');
  await exportButton(page).click();
  const workbook = await wb;
  expect(workbook.suggestedFilename()).toMatch(/^L1 Mid-Mount - Compartment Plan - \d{4}-\d{2}-\d{2} - rev1\.xlsx$/);

  const panel = page.getByRole('region', { name: 'Export complete' });
  await expect(panel).toContainText('Workbook downloaded · snapshot');
  const shown = (await page.getByTestId('export-snapshot-hash').textContent()).trim();
  expect(shown).toMatch(/^[0-9a-f]{12}$/);

  const js = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download checklist transfer file (JSON)' }).click();
  const json = await js;
  expect(json.suggestedFilename()).toMatch(/^L1 Mid-Mount - Checklist Transfer - \d{4}-\d{2}-\d{2} - rev1\.json$/);
  const manifest = JSON.parse(readFileSync(await json.path(), 'utf8'));
  expect(manifest.schema).toBe('l1.checklist-transfer/1');
  expect(manifest.compartments).toHaveLength(11);
  expect(manifest.source).toMatchObject({ plannerRevision: 1, syncState: 'confirmed', pendingChanges: 0 });
  expect(manifest.source.snapshotSha256.startsWith(shown)).toBe(true);
  expect(manifest.source.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
});

test('with unsynced edits the export asks which version to export', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'offline edit scenario runs once, at desktop size');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const { device } = await boot(page);
  device.failOps = 'network';
  await page.getByRole('button', { name: /^LS1/ }).click();
  await page.getByRole('combobox', { name: 'Equipment for slot 1', exact: true }).click();
  await page.getByRole('searchbox', { name: /search equipment/i }).fill(HOIST);
  await page.getByRole('option', { name: new RegExp(HOIST) }).first().click();
  await expect(page.locator('[data-testid=sync-status]:visible').last()).toHaveText('Offline — changes queued');

  await exportButton(page).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Export what you see \(includes 1 change not yet saved to the team plan\)/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Export the last saved team plan \(revision 1\)/ })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await exportButton(page).click();
  const wb = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: /Export what you see/ }).click();
  await wb;
  const js = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download checklist transfer file (JSON)' }).click();
  const manifest = JSON.parse(readFileSync(await (await js).path(), 'utf8'));
  expect(manifest.source).toMatchObject({ syncState: 'local_changes', pendingChanges: 1 });
  expect(manifest.compartments.find(c => c.id === 'LS1').items[0].name).toBe(HOIST);

  await page.getByRole('button', { name: 'Close export panel' }).click();
  await exportButton(page).click();
  const saved = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: /Export the last saved team plan/ }).click();
  await saved;
  const js2 = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download checklist transfer file (JSON)' }).click();
  const confirmed = JSON.parse(readFileSync(await (await js2).path(), 'utf8'));
  expect(confirmed.source).toMatchObject({ syncState: 'confirmed', pendingChanges: 0 });
  expect(confirmed.compartments.find(c => c.id === 'LS1').items).toEqual([]);
  await context.close();
});
