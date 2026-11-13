// Cross-cutting Studio behaviour on the real stack: budget / AI switches, queued-job cancel, double-click, aborted upload, offline queue,
// keyboard-only, 360 px layout, axe. State is shared, so every test restores what it changes.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import {
  STEP_IDS, addPending, assetsOf, closeStudio, ensureVersion, gotoStep, jobsOf, openApp, openCompartment, openStudio, pauseProcessor, photoFile, plannerOf,
  resetCompartment, resumeProcessor, setProviderDelay, setSetting, studioDialog, tabTo, uploadPending,
} from './lib.js';

const ID = 'RR1';
test.describe.configure({ mode: 'serial' });
test.beforeEach(() => { resumeProcessor(); setProviderDelay(0); });
test.afterEach(() => { resumeProcessor(); setProviderDelay(0); });

async function cancelActiveJobs(request, id) {
  for (const j of await jobsOf(request, id)) if (['queued', 'claimed', 'preparing', 'generating', 'saving'].includes(j.status)) await request.post(`/api/jobs/${j.id}/cancel`);
}
test.afterEach(async ({ request }) => { await cancelActiveJobs(request, ID); });

test('a daily budget of 0 shows the budget message and creates no job', async ({ page, request }) => {
  const before = (await jobsOf(request, ID)).length;
  const old = await setSetting(request, 'budget.dailyUsd', 0);
  try {
    await openApp(page);
    await openStudio(page, ID, 'generate');
    await page.getByTestId('gen-submit').click();
    await expect(page.getByTestId('gen-error')).toContainText(/budget|limit|spend|cap/i);
    expect((await jobsOf(request, ID)).length).toBe(before);
  } finally { await setSetting(request, 'budget.dailyUsd', old); }
});

test('AI disabled shows its message and generation is refused', async ({ page, request }) => {
  const before = (await jobsOf(request, ID)).length;
  const old = await setSetting(request, 'ai.enabled', false);
  try {
    await openApp(page);
    await openStudio(page, ID, 'generate');
    await expect(page.getByText(/AI image generation is currently turned off/)).toBeVisible();
    await page.getByTestId('gen-submit').click();
    await expect(page.getByTestId('gen-error')).toContainText(/turned off|disabled|not available|switched off/i);
    expect((await jobsOf(request, ID)).length).toBe(before);
  } finally { await setSetting(request, 'ai.enabled', old); }
});

test('cancelling a queued job works', async ({ page, request }) => {
  pauseProcessor();
  await openApp(page);
  await openStudio(page, ID, 'generate');
  await page.getByTestId('gen-submit').click();
  const status = page.getByTestId('job-status').first();
  await expect(status).toHaveAttribute('data-status', 'queued');
  await status.getByRole('button', { name: /Cancel/ }).click();
  await expect(status).toHaveAttribute('data-status', 'cancelled');
  expect((await jobsOf(request, ID))[0].status).toBe('cancelled');
});

test('a double-click on Generate creates exactly one job', async ({ page, request }) => {
  pauseProcessor();
  const before = (await jobsOf(request, ID)).length;
  await openApp(page);
  await openStudio(page, ID, 'generate');
  await page.getByTestId('gen-submit').dblclick();
  await expect(page.getByTestId('job-status').first()).toHaveAttribute('data-status', 'queued');
  await page.waitForTimeout(1500);
  expect((await jobsOf(request, ID)).length).toBe(before + 1);
});

test('an upload aborted mid-PUT can be retried with no partial links or duplicate assets', async ({ page, request }) => {
  const committed = async () => (await assetsOf(request, ID)).filter(a => a.status === 'committed');
  const base = await committed();
  const planner = (await plannerOf(request)).doc.allocations[ID];
  let block = true; let aborted = 0;
  await page.route('**/api/assets/*/original', route => {
    if (block && route.request().method() === 'PUT') { aborted += 1; return route.abort('failed'); }
    return route.continue();
  });
  await openApp(page);
  await openStudio(page, ID, 'photos');
  await addPending(page, 'compartment', [await photoFile('aborted.jpg', { seed: 4 })]);
  await uploadPending(page);
  const row = page.getByTestId('upload-row').first();
  await expect(row).toContainText(/Retry|Retrying|failed|interrupted|connection/i, { timeout: 30_000 });
  expect(aborted).toBeGreaterThan(0);
  expect((await committed()).length).toBe(base.length); // nothing committed, nothing linked
  expect((await plannerOf(request)).doc.allocations[ID]).toEqual(planner);
  block = false;
  const retry = row.getByRole('button', { name: 'Retry' });
  if (await retry.isVisible()) await retry.click();
  await expect(row).toHaveAttribute('data-state', 'done', { timeout: 45_000 });
  const after = await committed();
  expect(after.length).toBe(base.length + 1);
  expect(after.find(a => !base.some(b => b.id === a.id)).links ?? []).toEqual([]);
});

test('going offline then online resumes the upload queue', async ({ page, request, context }) => {
  const committed = async () => (await assetsOf(request, ID)).filter(a => a.status === 'committed').length;
  const base = await committed();
  await openApp(page);
  await openStudio(page, ID, 'photos');
  await addPending(page, 'compartment', [await photoFile('offline.png', { seed: 5 })]);
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await uploadPending(page);
  await expect(page.getByText(/You are offline|Waiting for a connection/).first()).toBeVisible({ timeout: 20_000 });
  await context.setOffline(false);
  await expect(page.getByTestId('upload-row').first()).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  expect(await committed()).toBe(base + 1);
});

test('a keyboard-only pass reaches every Studio step', async ({ page, request }) => {
  await ensureVersion(request, ID);
  await openApp(page);
  await openCompartment(page, ID);
  const opener = page.getByRole('button', { name: 'AI Compartment Studio' });
  await tabTo(page, opener);
  await page.keyboard.press('Enter');
  await expect(studioDialog(page)).toBeVisible();
  for (const step of STEP_IDS) {
    await tabTo(page, page.getByTestId(`studio-step-${step}`));
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(`studio-panel-${step}`)).toBeVisible();
    await expect(page.getByTestId(`studio-step-${step}`)).toHaveAttribute('aria-current', 'step');
  }
  await page.keyboard.press('Escape');
  await expect(studioDialog(page)).toBeHidden();
  await expect(opener).toBeFocused();
});

async function layoutProblems(page) {
  return page.evaluate(() => {
    const out = [];
    const dlg = document.querySelector('[role="dialog"][aria-label^="AI Compartment Studio"]');
    const scroller = dlg.querySelector('.overflow-y-auto');
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth) out.push(`document overflows: ${document.documentElement.scrollWidth} > ${document.documentElement.clientWidth}`);
    if (scroller.scrollWidth > scroller.clientWidth) out.push(`studio overflows: ${scroller.scrollWidth} > ${scroller.clientWidth}`);
    const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; };
    for (const el of dlg.querySelectorAll('button, select, textarea, a[href], input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden])')) {
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 43.5 || r.height < 43.5) out.push(`target ${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || el.placeholder || '').trim().slice(0, 40)}" is ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
}

test('at 360 px there is no horizontal overflow and targets are at least 44 px, on every step', async ({ page, request }) => {
  await ensureVersion(request, ID);
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp(page);
  await openStudio(page, ID);
  const problems = {};
  for (const step of STEP_IDS) {
    await gotoStep(page, step);
    await page.waitForTimeout(400);
    const p = await layoutProblems(page);
    if (p.length) problems[step] = p;
  }
  await gotoStep(page, 'review');
  await page.getByRole('button', { name: /Edit this version/ }).click();
  await expect(page.getByTestId('edit-step')).toBeVisible();
  const edit = await layoutProblems(page);
  if (edit.length) problems['review/edit'] = edit;
  await closeStudio(page);
  expect(problems).toEqual({});
});

test('axe reports no serious or critical violations on any Studio step', async ({ page, request }) => {
  await ensureVersion(request, ID);
  await openApp(page);
  await openStudio(page, ID);
  const found = {};
  const scan = async name => {
    const r = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    const bad = r.violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map(n => n.target.join(' ') + ' ' + (n.any[0]?.message ?? '')).join(' | ')}`);
    if (bad.length) found[name] = bad;
  };
  for (const step of STEP_IDS) { await gotoStep(page, step); await page.waitForTimeout(400); await scan(step); }
  await gotoStep(page, 'review');
  await page.getByRole('button', { name: /Edit this version/ }).click();
  await expect(page.getByTestId('edit-step')).toBeVisible();
  await page.waitForTimeout(400); // let the step button's colour transition finish (axe would sample mid-fade)
  await scan('review/edit');
  expect(found).toEqual({});
});

// Regression (QA finding U-02): Arrange let users pick a zone while the saved layout was still loading; the late response overwrote the pick.
test('Arrange keeps an early zone choice when the saved layout loads slowly', async ({ page, request }) => {
  await resetCompartment(request, ID); // empty saved design, so choosing a zone is a real change
  await page.route('**/api/compartments/*/design', async route => { if (route.request().method() === 'GET') await new Promise(r => setTimeout(r, 1500)); await route.continue(); });
  await openApp(page);
  const layoutLoaded = page.waitForResponse(r => /\/design$/.test(r.url()) && r.request().method() === 'GET');
  await openStudio(page, ID, 'arrange');
  const zone = page.getByTestId('arrange-step').getByRole('listitem').first().getByLabel('Zone');
  await zone.selectOption({ index: 1 }); // auto-waits until the control is enabled, i.e. after the layout has loaded
  const chosen = await zone.inputValue();
  expect(chosen).not.toBe('');
  await layoutLoaded;
  await page.waitForTimeout(500);
  await expect(zone).toHaveValue(chosen);
  await page.getByTestId('arrange-save').click();
  await expect(page.getByTestId('arrange-step').getByText('Saved', { exact: true })).toBeVisible();
});

// Regression (QA finding U-01): a mount added in step 3 must appear in Arrange without reopening the Studio.
test('a mount added in the Mounts step is offered in Arrange immediately', async ({ page, request }) => {
  const name = `QA Hook ${Date.now()}`;
  await openApp(page);
  await openStudio(page, ID, 'mounts');
  await page.getByTestId('mount-add').click();
  await page.getByTestId('mount-name').fill(name);
  await page.getByTestId('mount-save').click();
  await expect(page.getByTestId('mount-item').filter({ hasText: name })).toBeVisible();
  await gotoStep(page, 'arrange');
  await expect(page.getByTestId('arrange-step').getByRole('listitem').filter({ hasText: name })).toBeVisible();
  for (const m of (await (await request.get(`/api/compartments/${ID}/mounts`)).json()).mounts) await request.delete(`/api/mounts/${m.id}`);
});
