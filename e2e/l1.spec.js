import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function isolateSharedState(page) {
  const empty = {};
  for (const id of ['CabRearZone', 'LS1', 'LS2', 'LS3', 'LS4', 'RS1', 'RS2', 'RS3', 'RS4', 'RS5', 'RR1']) {
    empty[id] = Array(15).fill('');
  }

  await page.route('https://l1-state-sync.pdarleyjr.workers.dev/**', async route => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && url.pathname === '/state') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ allocations: empty, _serverTs: 1 }),
      });
    }
    if (route.request().method() === 'GET' && url.pathname === '/images') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    }
    if (route.request().method() === 'POST' && url.pathname === '/generate-image') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ dataUrl: `data:image/png;base64,${TINY_PNG}` }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, _serverTs: Date.now() }),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await isolateSharedState(page);
  await page.goto('/');
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

test('image upload and AI rendering flows add carousel images', async ({ page, isMobile }) => {
  await navigateTo(page, isMobile, /^LS1/);
  await page.locator('input[type="file"]').setInputFiles({
    name: 'upload-test.png',
    mimeType: 'image/png',
    buffer: Buffer.from(TINY_PNG, 'base64'),
  });
  await expect(page.getByRole('img', { name: 'upload-test' })).toBeVisible();

  await page.getByLabel('Additional AI rendering instructions').fill('Mount tools low and centered.');
  await page.getByRole('button', { name: 'Generate AI Rendering', exact: true }).click();
  await expect(page.getByRole('img', { name: 'AI Rendering' })).toBeVisible();
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
