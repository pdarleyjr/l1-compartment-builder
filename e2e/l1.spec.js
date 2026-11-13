import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { FakeApi } from './helpers/fake-api.js';

test.beforeEach(async ({ page }) => {
  await new FakeApi().install(page);
  await page.goto('/');
  await expect(page.getByText('Loading L1 Compartment Builder')).toBeHidden();
});

async function navigateTo(page, isMobile, name) {
  if (isMobile) await page.getByRole('button', { name: 'Open navigation menu' }).click();
  const options = typeof name === 'string' ? { name, exact: true } : { name };
  await page.getByRole('button', options).click();
}

test('primary layout has no horizontal document overflow', async ({ page }) => {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
});

test('visible controls meet touch target sizing', async ({ page, isMobile }) => {
  if (isMobile) await page.getByRole('button', { name: 'Open navigation menu' }).click();

  const findUndersized = () => page.locator(
    'button:visible, input:visible:not([type="file"]), select:visible, textarea:visible, label:has(input[type="file"]):visible',
  ).evaluateAll(controls =>
    controls.flatMap(control => {
      const rect = control.getBoundingClientRect();
      return rect.width < 44 || rect.height < 44
        ? [{
            name: control.getAttribute('aria-label') || control.getAttribute('placeholder') || control.textContent.trim(),
            width: rect.width,
            height: rect.height,
          }]
        : [];
    }),
  );

  expect(await findUndersized()).toEqual([]);

  await page.getByRole('button', { name: /^LS1/ }).click();
  expect(await findUndersized()).toEqual([]);

  await page.getByRole('button', { name: 'Bulk Add to Compartment' }).click();
  expect(await findUndersized()).toEqual([]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.getByRole('combobox', { name: 'Equipment for slot 1', exact: true }).click();
  expect(await findUndersized()).toEqual([]);
  await page.getByRole('searchbox', { name: /search equipment/i }).press('Escape');

  await navigateTo(page, isMobile, 'Inventory Status');
  expect(await findUndersized()).toEqual([]);
});

test('search Enter selects the first matching equipment item', async ({ page, isMobile }) => {
  if (isMobile) await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: /^LS1/ }).click();

  const trigger = page.getByRole('combobox', { name: 'Equipment for slot 1', exact: true });
  await trigger.click();
  const search = page.getByRole('searchbox', { name: /search equipment/i });
  await search.fill('Griphoist');
  await search.press('Enter');

  await expect(trigger).toHaveText('1 Ton Griphoist');
});

test('dropdown remains inside the visual viewport at the last slot', async ({ page, isMobile }) => {
  if (isMobile) await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', { name: /^LS1/ }).click();

  const trigger = page.getByRole('combobox', { name: /equipment for slot 15/i });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();

  const dropdown = page.getByRole('listbox', { name: /equipment choices/i });
  const box = await dropdown.boundingBox();
  const viewport = page.viewportSize();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
});

test('touch selection and clear slot work without pointer-only handlers', async ({ page, isMobile }) => {
  await navigateTo(page, isMobile, /^LS1/);
  const trigger = page.getByRole('combobox', { name: 'Equipment for slot 1', exact: true });
  await trigger.click();
  await page.getByRole('option', { name: /1 Ton Griphoist/ }).click();
  await expect(trigger).toHaveText('1 Ton Griphoist');

  await page.getByRole('button', { name: 'Clear slot 1', exact: true }).click();
  await expect(trigger).toHaveText('— Empty Slot —');
});

test('bulk add and bundle creation complete as a touch workflow', async ({ page, isMobile }) => {
  await navigateTo(page, isMobile, /^LS1/);
  await page.getByRole('button', { name: 'Bulk Add to Compartment' }).click();
  await page.getByLabel('Bulk add equipment').selectOption('1.5 in Smooth Bore Tip');
  await page.getByLabel('Bulk add quantity').fill('2');
  await page.getByRole('button', { name: 'Add 2 Slots' }).click();

  await expect(page.getByRole('combobox', { name: 'Equipment for slot 1', exact: true })).toHaveText('1.5 in Smooth Bore Tip');
  await expect(page.getByRole('combobox', { name: 'Equipment for slot 2', exact: true })).toHaveText('1.5 in Smooth Bore Tip');

  await page.getByRole('button', { name: 'Create Bundle' }).click();
  await page.getByRole('button', { name: /Add slot 1 to bundle/ }).click();
  await page.getByRole('button', { name: /Add slot 2 to bundle/ }).click();
  await page.getByRole('button', { name: 'Bundle 2 Selected Slots' }).click();
  await page.getByPlaceholder(/Bundle name/).fill('Highrise Pack');
  await page.getByRole('button', { name: 'Save Bundle' }).click();
  await expect(page.getByText('Bundles (1)')).toBeVisible();
});

test('a custom inventory item can be added', async ({ page, isMobile }) => {
  await navigateTo(page, isMobile, 'Inventory Status');
  await page.getByLabel('Custom tool name').fill('Regression Test Tool');
  await page.getByLabel('Custom tool quantity').fill('2');
  await page.getByLabel('Custom tool dimensions').fill('12 × 4 × 3 in');
  await page.getByRole('button', { name: 'Add Tool' }).click();

  await expect(page.getByText('Regression Test Tool', { exact: true })).toBeVisible();
});

test('inventory items can be edited and removed', async ({ page, isMobile }) => {
  await navigateTo(page, isMobile, 'Inventory Status');
  await page.getByRole('button', { name: 'Edit 1 Ton Griphoist' }).click();
  await page.getByLabel('Required quantity for 1 Ton Griphoist').fill('2');
  await page.locator('input[aria-label="Dimensions for 1 Ton Griphoist"]:visible').fill('25 × 10 × 8 in');
  await page.getByRole('button', { name: 'Save changes for 1 Ton Griphoist' }).click();
  await expect(
    page.locator('span:visible').filter({ hasText: '25 × 10 × 8 in' }).first(),
  ).toHaveText('25 × 10 × 8 in');

  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Remove 1 Ton Griphoist' }).click();
  await expect(page.getByText('1 Ton Griphoist', { exact: true })).toHaveCount(0);
});

test('Studio entry points replace the old upload and AI controls', async ({ page, isMobile }) => {
  await navigateTo(page, isMobile, /^LS1/);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'AI Compartment Studio' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add photos' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate rendering' })).toBeVisible();
});

test('all primary routes render images without browser or network errors', async ({ page, isMobile }) => {
  const pageErrors = [];
  const consoleErrors = [];
  const failedResponses = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', response => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  });

  await page.reload();
  const routes = [
    ['Cab Overview', 'Cab Overview'],
    ['Left Side Overview', 'Left Side Overview'],
    ['Right Side Overview', 'Right Side Overview'],
    ['Rear Overview', 'Rear Overview'],
    ['Rear Zone', 'Compartment Rear Zone'],
    ['LS1', 'Compartment LS1'],
    ['LS2', 'Compartment LS2'],
    ['LS3', 'Compartment LS3'],
    ['LS4', 'Compartment LS4'],
    ['RS1', 'Compartment RS1'],
    ['RS2', 'Compartment RS2'],
    ['RS3', 'Compartment RS3'],
    ['RS4', 'Compartment RS4'],
    ['RS5', 'Compartment RS5'],
    ['Rear', 'Compartment Rear'],
    ['Inventory Status', 'Inventory Status'],
  ];

  for (const [buttonName, headingName] of routes) {
    await navigateTo(page, isMobile, buttonName);
    await expect(page.getByRole('heading', { name: headingName, exact: true })).toBeVisible();
  }

  const brokenImages = await page.locator('img:visible').evaluateAll(images =>
    images.filter(image => !image.complete || image.naturalWidth === 0).map(image => image.getAttribute('src')),
  );
  expect(brokenImages).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(failedResponses).toEqual([]);
});

test('primary screens have no serious automated accessibility violations', async ({ page, isMobile }) => {
  const analyze = async () => {
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    return result.violations
      .filter(violation => violation.impact === 'critical' || violation.impact === 'serious')
      .map(violation => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.map(node => node.target),
      }));
  };

  expect(await analyze()).toEqual([]);
  await navigateTo(page, isMobile, /^LS1/);
  expect(await analyze()).toEqual([]);
  await navigateTo(page, isMobile, 'Inventory Status');
  expect(await analyze()).toEqual([]);
});

test('Excel export downloads a workbook', async ({ page }) => {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Excel' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('L1_Compartment_Plan.xlsx');
});

// ─── API integration (sign-in, read-only, server gallery, Studio, error boundary) ─────────────────────────────────
const HOIST = '1 Ton Griphoist';
const pill = page => page.locator('[data-testid=sync-status]:visible').last();

// A stand-in Studio chunk: plain element objects, so it needs no imports. It echoes the props contract.
const FAKE_STUDIO = `
const el = (type, props, ...children) => ({ $$typeof: Symbol.for('react.element'), type, key: props?.key ?? null, ref: null,
  props: { ...props, children: children.length === 1 ? children[0] : children }, _owner: null });
export default function StudioShell(p) {
  return el('div', { 'data-testid': 'studio-fake', role: 'dialog', 'aria-label': 'Studio' },
    el('p', { key: 'a' }, 'Studio for ' + p.compId + ' step ' + (p.initialStep ?? 'none') + ' rev ' + p.plannerRevision + ' as ' + p.session.email + ' doc ' + (p.plannerDoc?.schema ?? 'none')),
    el('button', { key: 'b', onClick: () => p.onMainImageChanged({}) }, 'Notify main image changed'),
    el('button', { key: 'c', onClick: p.onClose }, 'Close studio'));
}`;

test.describe('API integration', () => {
  test('signed out: the plan is readable but every editing control is gone, with one Sign in to edit action', async ({ browser }) => {
    const api = new FakeApi({ patch: { allocations: { ...new FakeApi().view().allocations, LS1: [HOIST, ...Array(14).fill('')] } } });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const device = await api.install(context, { signedIn: false });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByText('Loading L1 Compartment Builder')).toBeHidden();
    await page.getByRole('button', { name: /^LS1/ }).click();
    await expect(page.getByRole('combobox', { name: 'Equipment for slot 1', exact: true })).toHaveText(HOIST);
    await expect(page.getByRole('combobox', { name: 'Equipment for slot 1', exact: true })).toBeDisabled();
    for (const name of ['Bulk Add to Compartment', 'Create Bundle', 'Add Row', 'Clear slot 1', 'Reset All', 'AI Compartment Studio', 'Add photos']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'Inventory Status', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit 1 Ton Griphoist' })).toHaveCount(0);
    await expect(page.getByLabel('Custom tool name')).toHaveCount(0);
    await expect(pill(page)).toHaveText('Sign in to save');
    await expect(page.getByRole('link', { name: /sign out/i })).toHaveCount(0);
    // reading still works: export is available
    await expect(page.getByRole('button', { name: 'Export Excel' })).toBeVisible();

    const signInButtons = page.getByRole('button', { name: 'Sign in to edit' });
    await expect(signInButtons).toHaveCount(1);
    const login = page.waitForRequest(r => /\/api\/auth\/login\?return=/.test(r.url()));
    await signInButtons.click();
    await login;
    await expect(page.getByText('Loading L1 Compartment Builder')).toBeHidden();
    await page.getByRole('button', { name: 'Inventory Status', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit 1 Ton Griphoist' })).toBeVisible();
    expect(device.requests.filter(r => r.startsWith('POST /planner/ops'))).toEqual([]);
    await context.close();
  });

  test('signed in: email and sign-out link are shown; an unmigrated planner is read-only with a notice', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await new FakeApi({ migrated: false }).install(context);
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByText('Loading L1 Compartment Builder')).toBeHidden();
    await expect(page.getByText('firefighter@example.test')).toBeVisible();
    await expect(page.getByRole('link', { name: /sign out/i })).toHaveAttribute('href', '/cdn-cgi/access/logout');
    await expect(page.getByText(/being moved to the new service/)).toBeVisible();
    await page.getByRole('button', { name: /^LS1/ }).click();
    await expect(page.getByRole('combobox', { name: 'Equipment for slot 1', exact: true })).toBeDisabled();
    await context.close();
  });

  test('carousel shows the server main image first with a provenance badge and the stale warning', async ({ page, isMobile }) => {
    const api = new FakeApi();
    const id = api.addAsset('LS2', { title: 'Approved layout', provenance: 'approved_concept' });
    api.addAsset('LS2', { title: 'Tool group photo' });
    api.setMain('LS2', { kind: 'asset', ref: id, provenance: 'approved_concept', stale: true });
    await api.install(page);
    await page.goto('/');
    await navigateTo(page, isMobile, /^LS2/);
    await expect(page.getByRole('img', { name: 'Approved layout' })).toBeVisible();
    await expect(page.getByText('Approved concept', { exact: true })).toBeVisible();
    await expect(page.getByText('main image', { exact: true })).toBeVisible();
    await expect(page.getByText('Image may be outdated — equipment assignments changed')).toBeVisible();
    // main + 2 presets + 1 other photo
    const dots = page.getByRole('button', { name: /^Show image \d+ of 4$/ });
    await expect(dots).toHaveCount(4);
    await expect(dots.first()).toHaveAttribute('aria-current', 'true');
    // keyboard
    await dots.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('img', { name: 'Compartment Photo' })).toBeVisible();
    await expect(dots.nth(1)).toHaveAttribute('aria-current', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('img', { name: 'Approved layout' })).toBeVisible();
  });

  test('Studio chunk loads lazily with the props contract, notifies, and closes', async ({ page, isMobile }) => {
    const api = new FakeApi();
    await api.install(page);
    let chunkRequests = 0;
    await page.route('**/src/studio/StudioShell.jsx*', route => {
      chunkRequests += 1;
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_STUDIO });
    });
    await page.goto('/');
    await navigateTo(page, isMobile, /^LS1/);
    expect(chunkRequests).toBe(0);
    await page.getByRole('button', { name: 'AI Compartment Studio' }).click();
    await expect(page.getByTestId('studio-fake')).toContainText('Studio for LS1 step none rev 1 as firefighter@example.test doc 2');
    expect(chunkRequests).toBe(1);
    const before = api.counts.mainImageGets;
    await page.getByRole('button', { name: 'Notify main image changed' }).click();
    await expect.poll(() => api.counts.mainImageGets).toBeGreaterThan(before);
    await page.getByRole('button', { name: 'Close studio' }).click();
    await expect(page.getByTestId('studio-fake')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Compartment LS1', exact: true })).toBeVisible();
    // the carousel buttons open the Studio at the relevant step
    await page.getByRole('button', { name: 'Generate rendering' }).click();
    await expect(page.getByTestId('studio-fake')).toContainText('step generate');
  });

  test('a Studio chunk that fails to load shows a recovery panel and never blanks the planner', async ({ page, isMobile }) => {
    await new FakeApi().install(page);
    await page.route('**/src/studio/StudioShell.jsx*', route => route.abort('failed'));
    await page.goto('/');
    await navigateTo(page, isMobile, /^LS1/);
    await page.getByRole('button', { name: 'AI Compartment Studio' }).click();
    const panel = page.getByRole('alert').filter({ hasText: 'The Studio could not be loaded' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Reload' })).toBeVisible();
    await panel.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('heading', { name: 'Compartment LS1', exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Equipment for slot 1', exact: true })).toBeEnabled();
  });

  test('a malformed shared document is sanitized instead of blanking the app (error boundary stays as backstop)', async ({ page }) => {
    const api = new FakeApi();
    api.seed({ customTools: {}, bundles: { LS1: [{ id: 'x', slotIndices: 5 }] }, removedItems: 'nope' }, { raw: true });
    await api.install(page);
    await page.goto('/');
    await expect(page.getByText('Loading L1 Compartment Builder')).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Left Side Overview' })).toBeVisible();
  });

  test('overview cards show the approved main image thumbnail', async ({ page, isMobile }) => {
    const api = new FakeApi();
    api.setMain('LS1', { kind: 'asset', ref: api.addAsset('LS1', { title: 'Approved' }) });
    await api.install(page);
    await page.goto('/');
    await navigateTo(page, isMobile, 'Left Side Overview');
    await expect(page.getByRole('img', { name: 'LS1 main image' })).toBeVisible();
    await expect(page.getByRole('img', { name: 'Left Side Overview' })).toBeVisible();
  });

  test('editing saves through the revisioned ops API and the status pill tells the truth', async ({ page, isMobile }) => {
    const api = new FakeApi();
    await api.install(page);
    await page.goto('/');
    await expect(pill(page)).toHaveText('Saved');
    await navigateTo(page, isMobile, /^LS1/);
    await page.getByRole('combobox', { name: 'Equipment for slot 1', exact: true }).click();
    await page.getByRole('option', { name: /1 Ton Griphoist/ }).click();
    await expect.poll(() => api.view().allocations.LS1[0]).toBe(HOIST);
    await expect(pill(page)).toHaveText('Saved');
    expect(api.opLog).toHaveLength(1);
  });
});
