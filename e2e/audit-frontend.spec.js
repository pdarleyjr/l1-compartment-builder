/**
 * Frontend / mobile regression tests (docs/audit/frontend-mobile.md, FM-nn).
 *
 *  - Every FM test asserts the CORRECT behaviour against the current app; the former expected-failure (test.fail)
 *    reproductions of fixed defects are now ordinary regression tests.
 *  - Tests for the removed browser-side photo pipeline and AI panel (FM-01…09, 11, 15…18, 33) are retired with a
 *    one-line note: capture/upload now live in the Studio (e2e/studio/**) and photos/renderings on the server.
 *  - Every /api request is served by e2e/helpers/fake-api.js; all images are synthetic.
 */
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeApi } from './helpers/fake-api.js';

async function boot(page, { api = new FakeApi(), signedIn = true } = {}) {
  const device = await api.install(page, { signedIn });
  await page.goto('/');
  await expect(page.getByText('Loading L1 Compartment Builder')).toBeHidden();
  return { api, device };
}

async function nav(page, isMobile, name) {
  if (isMobile) await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await page.getByRole('button', typeof name === 'string' ? { name, exact: true } : { name }).click();
}

// ─── Retired: browser-side upload pipeline, AI panel, localStorage photos ─────────────────────────────────────────
// FM-01/02 (undecodable/HEIC), FM-03 (full resolution), FM-04 (alpha), FM-05/06 (EXIF), FM-07/08 (multi-select, capture),
// FM-09/09b (validation announcements), FM-33 (localStorage quota): replaced by the Studio capture pipeline (src/studio/capture,
// src/lib/image, e2e/studio/**); the planner no longer decodes, stores or uploads photos.
// FM-11 (deleted photo resurrected): replaced by "SD-02/03" in e2e/audit-sync.spec.js (server tombstones).
// FM-15/16/16b/17/18 (generating overlay, draft state, failure message, cancel): the old AI panel is gone; the Studio owns
// generation with durable jobs, draft/approved versions and cancel (e2e/studio/**).

test.describe('photos and carousel', () => {
  test('FM-08b Permissions-Policy allows the camera for this origin only; other features stay disabled', async () => {
    const headers = readFileSync(join(process.cwd(), 'public/_headers'), 'utf8');
    const policy = headers.match(/Permissions-Policy: (.*)/)[1];
    expect(policy).toContain('camera=(self)');
    for (const feature of ['microphone', 'geolocation', 'payment', 'usb']) expect(policy).toContain(`${feature}=()`);
    const csp = headers.match(/Content-Security-Policy: (.*)/)[1];
    expect(csp).toContain("connect-src 'self' https://cloudflareinsights.com;");
    expect(csp).not.toContain('workers.dev');
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("worker-src 'self' blob:");
  });

  test('FM-10 removing an uploaded photo asks for confirmation', async ({ page, isMobile }) => {
    const api = new FakeApi();
    api.addAsset('LS1', { title: 'mount-photo' });
    await boot(page, { api });
    await nav(page, isMobile, /^LS1/);
    await page.getByRole('button', { name: 'Show image 2 of 2' }).click();
    await expect(page.getByRole('img', { name: 'mount-photo' })).toBeVisible();
    let message = '';
    page.once('dialog', d => { message = d.message(); d.dismiss(); });
    await page.getByRole('button', { name: 'Remove this image' }).click();
    await page.waitForTimeout(300);
    expect(message).toMatch(/Remove .mount-photo./);
    await expect(page.getByRole('img', { name: 'mount-photo' })).toBeVisible();
    page.once('dialog', d => d.accept());
    await page.getByRole('button', { name: 'Remove this image' }).click();
    await expect(page.getByRole('img', { name: 'mount-photo' })).toHaveCount(0);
  });

  test('FM-12 carousel responds to the ArrowRight key and to a horizontal swipe', async ({ page, isMobile }) => {
    await boot(page);
    await nav(page, isMobile, /^LS2/);
    await expect(page.getByRole('img', { name: 'Compartment Photo' })).toBeVisible();
    await page.getByRole('button', { name: 'Show image 1 of 2' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('img', { name: 'Rendering with Tools' })).toBeVisible({ timeout: 1000 });
    // swipe left on the image area (pointer events, as a touch drag produces) moves to the next image, i.e. wraps to the first
    await page.getByRole('img', { name: 'Rendering with Tools' }).evaluate(img => {
      const fire = (type, x) => img.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', clientX: x, clientY: 100 }));
      fire('pointerdown', 300); fire('pointerup', 120);
    });
    await expect(page.getByRole('img', { name: 'Compartment Photo' })).toBeVisible({ timeout: 1000 });
  });

  test('FM-13 the active carousel dot is exposed to assistive technology', async ({ page, isMobile }) => {
    await boot(page);
    await nav(page, isMobile, /^LS2/);
    await expect(page.getByRole('button', { name: 'Show image 1 of 2' })).toHaveAttribute('aria-current', 'true');
    await expect(page.getByRole('button', { name: 'Show image 2 of 2' })).not.toHaveAttribute('aria-current', /.+/);
    await expect(page.getByRole('region', { name: /Images for LS2/ })).toHaveAttribute('aria-roledescription', 'carousel');
  });

  test('FM-14 carousel controls remain reachable when a compartment has 20 photos', async ({ page, isMobile }) => {
    const api = new FakeApi();
    for (let i = 0; i < 20; i++) api.addAsset('LS1', { title: `p${i}` });
    await boot(page, { api });
    await nav(page, isMobile, /^LS1/);
    await expect(page.getByRole('button', { name: /Show image 21 of 21/ })).toBeVisible();
    await page.getByRole('button', { name: 'Show image 21 of 21' }).click();
    const box = await page.locator('.print-image-container').first().boundingBox();
    for (const name of ['Remove this image', 'Set as main image']) {
      const b = await page.getByRole('button', { name }).boundingBox();
      expect(b.x).toBeGreaterThanOrEqual(box.x - 1);
      expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 1);
    }
  });

  test('FM-23 carousel icon buttons meet WCAG contrast', async ({ page, isMobile }) => {
    const api = new FakeApi();
    api.addAsset('LS1', { title: 'contrast' });
    await boot(page, { api });
    await nav(page, isMobile, /^LS1/);
    await page.getByRole('button', { name: 'Show image 2 of 2' }).click();
    await expect(page.getByRole('img', { name: 'contrast' })).toBeVisible();
    const measured = await page.evaluate(() => {
      const fgOf = el => getComputedStyle(el).color;
      const bgOf = el => { for (let n = el; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (!/rgba?\(0, 0, 0, 0\)/.test(c)) return c; } return 'rgb(255,255,255)'; };
      const star = document.querySelector('button[aria-label="Set as main image"]');
      const del = document.querySelector('button[aria-label="Remove this image"]');
      return { star: [fgOf(star), bgOf(star)], del: [fgOf(del), bgOf(del)] };
    });
    const lum = c => { const [r, g, b] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = ([f, b]) => { const [a, z] = [lum(f), lum(b)].sort((x, y) => y - x); return (a + 0.05) / (z + 0.05); };
    expect(ratio(measured.star)).toBeGreaterThanOrEqual(3);
    expect(ratio(measured.del)).toBeGreaterThanOrEqual(3);
  });
});

test.describe('shared-state robustness', () => {
  test('FM-24 an unchanged plan and gallery are not re-downloaded every 5 s', async ({ page }) => {
    const { api } = await boot(page);
    const before = { full: api.counts.plannerFull, mains: api.counts.mainImageGets };
    await page.waitForTimeout(11_500);
    expect(api.counts.plannerFull - before.full).toBe(0);
    expect(api.counts.plannerNotModified).toBeGreaterThanOrEqual(1);
    expect(api.counts.mainImageGets - before.mains).toBe(0);
  });

  test('FM-19 a "device storage is full" warning is visible on phones without opening the menu', async ({ page, isMobile }) => {
    await page.addInitScript(() => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (window.__quotaFull && k.includes('planner-sync')) throw new DOMException('quota', 'QuotaExceededError');
        return orig.call(this, k, v);
      };
    });
    await boot(page);
    await nav(page, isMobile, /^LS1/);
    await page.evaluate(() => { window.__quotaFull = true; });
    await page.getByRole('combobox', { name: 'Equipment for slot 1', exact: true }).click();
    await page.getByRole('option', { name: /1 Ton Griphoist/ }).click();
    const alert = page.getByRole('alert').filter({ hasText: /storage is full/i });
    await expect(alert).toHaveCount(1, { timeout: 3000 });
    await page.waitForTimeout(600); // let the 300 ms drawer close transition finish
    const bb = await alert.boundingBox();
    expect(bb.x + bb.width).toBeGreaterThan(1);
    expect(bb.x).toBeGreaterThanOrEqual(0);
  });

  test('FM-20 a malformed shared document does not blank the whole app', async ({ page }) => {
    const api = new FakeApi();
    api.seed({ customTools: {}, bundles: 5, customDimensions: [], removedItems: { a: 1 } }, { raw: true });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await boot(page, { api });
    await page.waitForTimeout(1000);
    expect((await page.locator('#root').innerText()).trim().length).toBeGreaterThan(0);
    await expect(page.getByRole('heading', { name: 'Left Side Overview' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('FM-34 keyboard focus in the sidebar survives a remote update', async ({ page, isMobile }) => {
    test.skip(isMobile, 'drawer is closed on small viewports; checked on desktop where the sidebar is persistent');
    const { api } = await boot(page);
    const btn = page.getByRole('button', { name: 'Inventory Status', exact: true });
    await btn.focus();
    await expect(btn).toBeFocused();
    api.applyDirect([{ op: 'setSlot', comp: 'LS1', index: 0, value: '1 Ton Griphoist', expect: '' }]); // a teammate changes the plan
    await page.waitForTimeout(6500); // the 5 s poll applies it and App re-renders
    await expect(page.getByRole('button', { name: /^LS1/ })).toContainText('1'); // update arrived
    await expect(btn).toBeFocused();
  });
});

test.describe('navigation accessibility', () => {
  test('FM-21 the closed mobile navigation drawer is not keyboard-focusable', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'drawer only exists below the lg breakpoint');
    await boot(page);
    const focused = await page.evaluate(() => {
      const b = document.querySelector('#sidebar button');
      b.focus();
      return document.activeElement === b;
    });
    expect(focused).toBe(false);
    await expect(page.locator('#sidebar').locator('..')).toHaveAttribute('aria-hidden', 'true');
  });

  test('FM-22 the open mobile drawer takes focus, traps Tab and closes on Escape', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'drawer only exists below the lg breakpoint');
    await boot(page);
    const opener = page.getByRole('button', { name: 'Open navigation menu' });
    await opener.click();
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => !!document.activeElement?.closest('#sidebar'))).toBe(true);
    await expect(page.getByRole('dialog', { name: 'Navigation menu' })).toHaveAttribute('aria-modal', 'true');
    for (let i = 0; i < 40; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('#sidebar'))).toBe(true); // focus never leaves
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    expect((await page.locator('#sidebar').boundingBox()).x).toBeLessThan(0);
    await expect(opener).toBeFocused();
  });
});

test.describe('print, export and performance', () => {
  test('FM-26 print media prints only the current carousel image and hides the photo/Studio controls', async ({ page, isMobile }) => {
    const api = new FakeApi();
    api.addAsset('LS2', { title: 'extra' });
    await boot(page, { api });
    await nav(page, isMobile, /^LS2/);
    await expect(page.getByRole('button', { name: 'Show image 3 of 3' })).toBeVisible();
    await page.emulateMedia({ media: 'print' });
    expect(await page.locator('main img:visible').count()).toBe(1);
    expect(await page.getByRole('button', { name: 'Add photos' }).isVisible()).toBe(false);
    expect(await page.getByRole('button', { name: 'AI Compartment Studio' }).isVisible()).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test('FM-27 Excel export contains only the allocations and inventory sheets (same columns as before)', async ({ page }) => {
    await boot(page);
    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export Excel' }).click();
    const download = await dl;
    const dir = mkdtempSync(join(tmpdir(), 'l1xlsx-'));
    const file = join(dir, 'plan.xlsx');
    await download.saveAs(file);
    const wb = execFileSync('unzip', ['-p', file, 'xl/workbook.xml']).toString();
    expect([...wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map(m => m[1])).toEqual(['Compartments', 'Inventory Status']);
    const shared = execFileSync('unzip', ['-p', file, 'xl/sharedStrings.xml']).toString();
    for (const h of ['Equipment Item', 'Total Qty', 'Placed', 'Remaining', 'Assigned To', 'Dimensions', 'Status']) expect(shared).toContain(h);
  });

  test('FM-25 low-end phone timings with 4x CPU throttle (documents behaviour)', async ({ page, browserName }, testInfo) => {
    test.skip(browserName !== 'chromium');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const api = new FakeApi();
    await api.install(page);
    const t0 = Date.now();
    await page.goto('/');
    await expect(page.getByText('Loading L1 Compartment Builder')).toBeHidden();
    const tLoaded = Date.now() - t0;
    const nav0 = Date.now();
    if (testInfo.project.use.isMobile) await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await page.getByRole('button', { name: /^LS1/ }).click();
    await expect(page.getByRole('combobox', { name: 'Equipment for slot 1', exact: true })).toBeVisible();
    const tNav = Date.now() - nav0;
    testInfo.annotations.push({ type: 'observed', description: `4x throttle: app ready ${tLoaded} ms, open LS1 ${tNav} ms; planner GETs ${api.counts.plannerGets}` });
    expect(tLoaded).toBeLessThan(30000);
  });
});
