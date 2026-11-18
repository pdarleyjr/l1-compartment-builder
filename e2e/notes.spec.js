// Compartment notes + "Needs verification" (docs/architecture/notes-verification-transfer.md). Served by the in-memory
// FakeApi (real op engine); two browser contexts = two devices.
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { FakeApi } from './helpers/fake-api.js';

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
const goTo = (page, comp) => page.getByRole('button', { name: new RegExp(`^${comp}`) }).click();
const status = page => page.getByTestId('note-status');
const field = (page, comp = 'LS1') => page.getByRole('textbox', { name: `Notes for ${comp}` });

async function saveNote(page, text, comp = 'LS1') {
  const add = page.getByRole('button', { name: /^(Add note|Edit notes)/ });
  await add.click();
  await field(page, comp).fill(text);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
}

test('add, edit, save and reload persists; a second device sees it', async ({ browser }) => {
  const api = new FakeApi();
  const a = await openDevice(browser, api);
  await goTo(a.page, 'LS1');
  await expect(a.page.getByRole('heading', { name: 'Notes' })).toBeVisible();
  await saveNote(a.page, 'Strap on the left\nCheck latch');
  await expect(a.page.getByTestId('note-text')).toHaveText('Strap on the left\nCheck latch');
  await expect(status(a.page)).toHaveText(/^Saved to the team plan · /);
  expect(api.doc.notes.LS1.text).toBe('Strap on the left\nCheck latch');

  await a.page.reload();
  await expect(pill(a.page)).toHaveText(/Saved/);
  await goTo(a.page, 'LS1');
  await expect(a.page.getByTestId('note-text')).toHaveText('Strap on the left\nCheck latch');

  await a.page.getByRole('button', { name: /^Edit notes/ }).click();
  await expect(a.page.getByText('0 / 2000')).toHaveCount(0);
  await expect(a.page.getByText(/\d+ \/ 2000/)).toBeVisible();
  await expect(a.page.getByText('Placement, access or handling details. Not a substitute for equipment lines.')).toBeVisible();
  await field(a.page).fill('Edited note');
  await a.page.keyboard.press('Control+Enter');
  await expect(a.page.getByTestId('note-text')).toHaveText('Edited note');
  await expect.poll(() => api.doc.notes.LS1?.text).toBe('Edited note');

  const b = await openDevice(browser, api);
  await goTo(b.page, 'LS1');
  await expect(b.page.getByTestId('note-text')).toHaveText('Edited note');
});

test('Escape cancels an edit and a mid-edit draft survives a reload', async ({ browser }) => {
  const api = new FakeApi();
  const a = await openDevice(browser, api);
  await goTo(a.page, 'LS2');
  await a.page.getByRole('button', { name: /^Add note/ }).click();
  await field(a.page, 'LS2').fill('draft text');
  await a.page.reload();
  await expect(pill(a.page)).toHaveText(/Saved/);
  await goTo(a.page, 'LS2');
  await expect(field(a.page, 'LS2')).toHaveValue('draft text');
  await a.page.keyboard.press('Escape');
  await expect(field(a.page, 'LS2')).toHaveCount(0);
  await expect(a.page.getByRole('button', { name: /^Add note/ })).toBeVisible();
  expect(api.doc.notes.LS2).toBeUndefined();
  await a.page.reload();
  await goTo(a.page, 'LS2');
  await expect(field(a.page, 'LS2')).toHaveCount(0);
});

test('signed-out user reads the note but cannot edit', async ({ browser }) => {
  const api = new FakeApi();
  api.applyDirect([{ op: 'setNote', comp: 'LS1', text: 'Read me', expect: '' }]);
  const a = await openDevice(browser, api, { signedIn: false });
  await goTo(a.page, 'LS1');
  await expect(a.page.getByTestId('note-text')).toHaveText('Read me');
  await expect(a.page.getByRole('button', { name: /^(Edit notes|Add note)/ })).toHaveCount(0);
  await goTo(a.page, 'LS2');
  await expect(a.page.getByRole('heading', { name: 'Notes' })).toHaveCount(0);
});

test('offline save shows "not synced yet", then "Saved to the team plan" after reconnect', async ({ browser }) => {
  const api = new FakeApi();
  const a = await openDevice(browser, api);
  await goTo(a.page, 'LS3');
  await a.context.setOffline(true);
  await saveNote(a.page, 'Offline note', 'LS3');
  await expect(status(a.page)).toHaveText('Saved on this device — not synced yet');
  expect(api.doc.notes.LS3).toBeUndefined();
  await a.context.setOffline(false);
  await expect(status(a.page)).toHaveText(/^Saved to the team plan · /, { timeout: 30_000 });
  expect(api.doc.notes.LS3.text).toBe('Offline note');
});

test('conflict keeps the local text and offers Use my version / Keep theirs', async ({ browser }) => {
  const api = new FakeApi();
  const a = await openDevice(browser, api);
  await goTo(a.page, 'LS1');
  await a.context.setOffline(true);
  await saveNote(a.page, 'My version');
  await expect(status(a.page)).toHaveText('Saved on this device — not synced yet');
  api.applyDirect([{ op: 'setNote', comp: 'LS1', text: 'Their version', expect: '' }]);
  await a.context.setOffline(false);
  const conflict = a.page.getByRole('group', { name: 'Note conflict' });
  await expect(conflict).toContainText('Another device changed this note. Your version is kept below.', { timeout: 30_000 });
  await expect(a.page.getByTestId('note-server-text')).toHaveText('Their version');
  await expect(a.page.getByTestId('note-mine-text')).toHaveText('My version');

  await a.page.getByRole('button', { name: 'Use my version' }).click();
  await expect.poll(() => api.doc.notes.LS1?.text).toBe('My version');
  await expect(conflict).toHaveCount(0);
  await expect(status(a.page)).toHaveText(/^Saved to the team plan · /);

  // Keep theirs path
  api.applyDirect([{ op: 'setNote', comp: 'LS1', text: 'Third', expect: 'My version' }]);
  await a.context.setOffline(true);
  await a.page.getByRole('button', { name: /^Edit notes/ }).click();
  await field(a.page).fill('Local again');
  await a.page.getByRole('button', { name: 'Save', exact: true }).click();
  api.applyDirect([{ op: 'setNote', comp: 'LS1', text: 'Fourth', expect: 'Third' }]);
  await a.context.setOffline(false);
  await expect(conflict).toBeVisible({ timeout: 30_000 });
  await a.page.getByRole('button', { name: 'Keep theirs' }).click();
  await expect(conflict).toHaveCount(0);
  await expect(a.page.getByTestId('note-text')).toHaveText('Fourth');
  expect(api.doc.notes.LS1.text).toBe('Fourth');
});

test('markup in a note renders literally', async ({ browser }) => {
  const api = new FakeApi();
  const a = await openDevice(browser, api);
  const dialogs = [];
  a.page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
  await goTo(a.page, 'LS1');
  const xss = '<img src=x onerror=alert(1)>';
  await saveNote(a.page, xss);
  await expect(a.page.getByTestId('note-text')).toHaveText(xss);
  await expect(a.page.locator('[data-testid=note-text] img')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test('RS3 has a Notes section like every other compartment', async ({ browser }) => {
  const api = new FakeApi();
  const a = await openDevice(browser, api);
  await goTo(a.page, 'RS3');
  await expect(a.page.getByRole('heading', { name: 'Compartment RS3', exact: true })).toBeVisible();
  const before = structuredClone(api.doc.allocations.RS3);
  await a.page.getByRole('button', { name: /^Add note/ }).click();
  await a.page.getByRole('textbox', { name: /Notes for RS3/ }).fill('RS3 hose packs stay bundled');
  await a.page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => api.doc.notes?.RS3?.text).toBe('RS3 hose packs stay bundled');
  expect(api.doc.allocations.RS3).toEqual(before);
});

test('notes controls are at least 44px and pass axe', async ({ browser }) => {
  const api = new FakeApi();
  const a = await openDevice(browser, api);
  await goTo(a.page, 'LS1');
  await a.page.getByRole('button', { name: /^Add note/ }).click();
  const small = await a.page.locator('section:has(h3:text-is("Notes")) button:visible, section:has(h3:text-is("Notes")) textarea:visible').evaluateAll(els =>
    els.flatMap(el => { const r = el.getBoundingClientRect(); return r.width < 44 || r.height < 44 ? [el.textContent.trim()] : []; }));
  expect(small).toEqual([]);
  await a.page.mouse.move(0, 0);
  const results = await new AxeBuilder({ page: a.page }).include('section[aria-labelledby]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => [v.id, v.nodes.map(n => n.target.join(' '))])).toEqual([]);
});

test('Needs verification: editor marks an item, badge + reason show, others and signed-out see it', async ({ browser }) => {
  const api = new FakeApi();
  const a = await openDevice(browser, api);
  await a.page.getByRole('button', { name: 'Inventory Status', exact: true }).click();
  await a.page.getByRole('button', { name: /^Mark .* as needs verification$/ }).first().click();
  await a.page.getByRole('textbox', { name: /^Verification reason for/ }).fill('Model number not confirmed');
  await a.page.getByRole('button', { name: 'Mark needs verification' }).click();
  await expect(a.page.getByText('Needs verification', { exact: true }).first()).toBeVisible();
  await expect(a.page.getByText('Reason: Model number not confirmed')).toBeVisible();
  await expect.poll(() => Object.values(api.doc.unverified)).toEqual(['Model number not confirmed']);

  const b = await openDevice(browser, api, { signedIn: false });
  await b.page.getByRole('button', { name: 'Inventory Status', exact: true }).click();
  await expect(b.page.getByText('Reason: Model number not confirmed')).toBeVisible();

  await a.page.getByRole('button', { name: /^Edit verification for/ }).click();
  await a.page.getByRole('button', { name: 'Mark verified' }).click();
  await expect.poll(() => api.doc.unverified).toEqual({});
  await expect(a.page.getByText('Reason: Model number not confirmed')).toHaveCount(0);
});
