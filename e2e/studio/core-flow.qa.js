// Core Studio flow against the REAL Worker/D1/R2 + real processor (mock OpenAI), one test per compartment on desktop, LS2 + RS5 on phone.
import { expect, test } from '@playwright/test';
import {
  COMPARTMENT_IDS, addPending, assetsOf, assocDialog, closeStudio, gotoStep, jobsOf, mainOf, openApp, openCompartment, openStudio, photoFile, pickCandidate,
  plannerOf, resetCompartment, setProviderDelay, shot, toolNames, uploadPending, usedSlots, versionsOf, waitForAssets, heicFile,
} from './lib.js';

const PHONE_IDS = ['LS2', 'RS5'];

for (const id of COMPARTMENT_IDS) {
  test(`core flow ${id}`, async ({ page, request, browser, baseURL }, testInfo) => {
    const phone = testInfo.project.name === 'phone';
    test.skip(phone && !PHONE_IDS.includes(id), 'Pixel 5 runs the same flow for LS2 and RS5 only (task scope)');
    const shotName = n => (id === 'LS2' ? `${phone ? 'phone' : 'desktop'}-${n}` : null);
    const snap = async n => { const s = shotName(n); if (s) await shot(page, s); };
    const names = toolNames(id);
    await resetCompartment(request, id);
    const baseAssets = new Set((await assetsOf(request, id)).map(a => a.id));
    const baseCommitted = (await assetsOf(request, id)).filter(a => a.status === 'committed').length;
    const baseV = (await versionsOf(request, id)).length;
    const newAsset = async category => (await assetsOf(request, id)).find(a => a.category === category && !baseAssets.has(a.id));
    const allocBefore = (await plannerOf(request)).doc.allocations[id];
    expect(allocBefore.slice(0, 2)).toEqual([names.alpha, names.beta]);
    setProviderDelay(2500);
    page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 400 && r.status() !== 404) console.log('API', r.status(), r.request().method(), r.url(), r.request().headers().origin); });
    test.setTimeout(240_000);

    await test.step('open the Studio', async () => {
      await openApp(page);
      await openCompartment(page, id);
      await snap('01-compartment-page');
      await openStudio(page, id);
      await expect(page.getByTestId('studio-panel-photos')).toBeVisible();
    });

    await test.step('upload a compartment photo; a .heic file takes the friendly failure path', async () => {
      await addPending(page, 'compartment', [await photoFile('compartment.jpg', { seed: 1 })]);
      await addPending(page, 'tool', [heicFile()]);
      const bad = page.getByTestId('pending-photo').filter({ hasText: 'IMG_0001.heic' });
      await expect(bad.getByRole('alert')).toContainText(/could not be converted/i);
      await expect(page.getByTestId('capture-upload')).toContainText('Upload 1 photo');
      await snap('02-capture-review');
      await uploadPending(page);
      await waitForAssets(request, id, baseCommitted + 1);
      await bad.getByRole('button', { name: /^Remove IMG_0001\.heic/ }).click();
      await expect(page.getByTestId('pending-photo')).toHaveCount(0);
    });

    await test.step('a tool photo linked to an already-assigned tool leaves the planner counts unchanged', async () => {
      await addPending(page, 'tool', [await photoFile('tool.png', { seed: 2 })]);
      await uploadPending(page);
      const dlg = assocDialog(page);
      await expect(dlg).toBeVisible({ timeout: 30_000 });
      await pickCandidate(dlg, names.alpha);
      await expect(dlg.getByTestId('assoc-summary')).toContainText(/no inventory change/i);
      await dlg.getByTestId('assoc-save').click();
      await expect(dlg).toBeHidden();
      const planner = await plannerOf(request);
      expect(planner.doc.allocations[id]).toEqual(allocBefore);
      const tool = await newAsset('tool');
      expect(tool.links.filter(l => l.state === 'confirmed')).toHaveLength(1);
    });

    await test.step('a group photo: 2 assigned tools + 1 unassigned tool -> exactly one new assignment', async () => {
      await addPending(page, 'tool_group', [await photoFile('group.jpg', { seed: 3 })]);
      await uploadPending(page);
      const dlg = assocDialog(page);
      await expect(dlg).toBeVisible({ timeout: 30_000 });
      for (const n of [names.alpha, names.beta, names.gamma]) await pickCandidate(dlg, n);
      await dlg.getByTestId('assoc-search').fill('');
      await expect(dlg.getByTestId('assoc-summary')).toContainText(names.gamma);
      await snap('03-group-photo-linking');
      await dlg.getByTestId('assoc-save').click();
      await expect(dlg).toBeHidden();
      const after = (await plannerOf(request)).doc;
      expect(usedSlots(after, id)).toHaveLength(allocBefore.filter(Boolean).length + 1);
      expect(usedSlots(after, id).filter(n => n === names.gamma)).toHaveLength(1);
      expect(after.allocations[id].slice(0, 2)).toEqual([names.alpha, names.beta]);
      const group = await newAsset('tool_group');
      expect(group.links.filter(l => l.state === 'confirmed').length).toBeGreaterThanOrEqual(3);
    });

    await test.step('Tools step reflects photo counts', async () => {
      await gotoStep(page, 'tools');
      for (const n of [names.alpha, names.beta, names.gamma]) await expect(page.getByTestId('tools-step').getByRole('listitem').filter({ hasText: n })).toContainText(/\d photo/);
    });

    let mountId;
    await test.step('add a mount linked to two tools', async () => {
      await gotoStep(page, 'mounts');
      await page.getByTestId('mount-add').click();
      await page.getByTestId('mount-name').fill('QA Rail Bracket');
      const form = page.getByTestId('mount-form');
      for (const n of [names.alpha, names.beta]) await form.getByRole('checkbox').and(form.locator('label', { hasText: n }).getByRole('checkbox')).first().check();
      await expect(form.getByText('2 selected')).toBeVisible();
      await snap('04-mount-editor');
      await page.getByTestId('mount-save').click();
      await expect(page.getByTestId('mount-item')).toContainText('QA Rail Bracket');
      const mounts = (await (await request.get(`/api/compartments/${id}/mounts`)).json()).mounts;
      expect(mounts).toHaveLength(1);
      expect(mounts[0].links.filter(l => l.targetType === 'equipment')).toHaveLength(2);
      mountId = mounts[0].id;
    });

    await test.step('arrange zones', async () => {
      await gotoStep(page, 'arrange');
      const row = text => page.getByTestId('arrange-step').getByRole('listitem').filter({ hasText: text });
      await expect(row(names.alpha).getByLabel('Zone')).toBeEnabled();
      // zones differ per compartment (geometry), so use the first three real options offered
      const zones = (await row(names.alpha).getByLabel('Zone').locator('option').evaluateAll(o => o.map(x => x.value))).filter(Boolean);
      expect(zones.length).toBeGreaterThanOrEqual(3);
      const [zA, zB, zM] = zones;
      for (const [text, zone] of [[names.alpha, zA], [names.beta, zB], ['QA Rail Bracket', zM]]) await row(text).getByLabel('Zone').selectOption(zone);
      await snap('05-arrange');
      await page.getByTestId('arrange-save').click();
      await expect(page.getByTestId('arrange-step').getByText('Saved', { exact: true })).toBeVisible();
      const design = (await (await request.get(`/api/compartments/${id}/design`)).json()).design;
      expect(design.layout.placements.map(p => p.zone).sort()).toEqual([zA, zB, zM].sort());
      expect(design.layout.placements.some(p => p.targetType === 'mount' && p.targetId === mountId)).toBe(true);
    });

    const baseIds = new Set((await versionsOf(request, id)).map(v => v.id));
    let first;
    await test.step('generate a Fast Preview and watch the job', async () => {
      await gotoStep(page, 'generate');
      await expect(page.getByTestId('gen-preset-preview')).toContainText(/\$/);
      await snap('06-generate');
      await page.getByTestId('gen-submit').click();
      const status = page.getByTestId('job-status').first();
      await expect(status).toBeVisible();
      await expect(status).toHaveAttribute('data-status', /queued|claimed|preparing|generating|saving/);
      await expect(status).toHaveAttribute('data-status', /claimed|preparing|generating|saving/, { timeout: 30_000 });
      await snap('07-job-progress');
      await expect(status).toHaveAttribute('data-status', 'completed', { timeout: 90_000 });
      await expect.poll(async () => (await versionsOf(request, id)).length, { timeout: 30_000 }).toBe(baseV + 1);
      first = (await versionsOf(request, id)).find(v => !baseIds.has(v.id));
      expect(first.status).toBe('draft');
      expect(first.parentVersionId).toBeNull();
    });

    let child;
    await test.step('edit with an instruction plus markup -> child version with the right parent', async () => {
      await page.getByRole('button', { name: 'Review result' }).first().click();
      await expect(page.getByTestId('review-step')).toBeVisible();
      await page.getByRole('button', { name: /Edit this version/ }).click();
      await expect(page.getByTestId('edit-step')).toBeVisible();
      await page.getByTestId('edit-instructions').fill('Move the hose rolls to the lower shelf.');
      await page.getByTestId('markup-add').click();
      await snap('08-edit-with-markup');
      await page.getByTestId('edit-submit').click();
      const status = page.getByTestId('job-status').first();
      await expect(status).toHaveAttribute('data-status', 'completed', { timeout: 90_000 });
      await expect.poll(async () => (await versionsOf(request, id)).length, { timeout: 30_000 }).toBe(baseV + 2);
      child = (await versionsOf(request, id)).find(v => !baseIds.has(v.id) && v.id !== first.id);
      expect(child.parentVersionId).toBe(first.id);
      expect(child.instructions).toContain('hose rolls');
      const editJob = (await jobsOf(request, id)).find(j => j.mode === 'edit' && j.parentVersionId === first.id);
      expect(editJob.parentVersionId).toBe(first.id);
    });

    await test.step('compare the two versions', async () => {
      await page.getByRole('button', { name: 'Review result' }).first().click();
      await expect(page.getByTestId('review-step')).toBeVisible();
      await expect(page.getByTestId('version-item')).toHaveCount(baseV + 2);
      await expect(page.getByText(`branch of v${baseV + 1}`).first()).toBeVisible();
      await page.getByTestId('compare-toggle').click();
      await expect(page.getByTestId('compare-view')).toBeVisible();
      await expect(page.getByTestId('compare-view').locator('img')).toHaveCount(2);
      await snap('09-review-compare');
    });

    await test.step('approve and set as main image; reload; a second context shows it first', async () => {
      await page.getByTestId('compare-toggle').click();
      await page.getByTestId('version-item').filter({ hasText: new RegExp(`^v${baseV + 2}(?!\\d)`) }).click();
      await page.getByRole('button', { name: /Publish…/ }).click();
      await expect(page.getByTestId('publish-step')).toBeVisible();
      await page.getByTestId('publish-approve').click();
      await expect(page.getByText('Main image updated for everyone.')).toBeVisible();
      const main = await mainOf(request, id);
      expect(main).toMatchObject({ kind: 'version', ref: child.id, provenance: 'approved_concept', stale: false });
      await closeStudio(page);
      await page.reload();
      await openCompartment(page, id);
      const carousel = page.getByRole('region', { name: `Images for ${id}` });
      await expect(carousel.getByRole('img').first()).toHaveAttribute('src', main.url);
      await expect(carousel).toContainText('main image');
      await snap('10-published-main-image');
      // second device: a brand-new anonymous context
      const ctx = await browser.newContext({ ...testInfo.project.use, extraHTTPHeaders: {}, baseURL });
      try {
        const p2 = await ctx.newPage();
        await openApp(p2);
        await openCompartment(p2, id);
        const c2 = p2.getByRole('region', { name: `Images for ${id}` });
        await expect(c2.getByRole('img').first()).toHaveAttribute('src', main.url);
        await expect(c2).toContainText('Approved concept');
      } finally { await ctx.close(); }
    });

    await test.step('change inventory -> stale badge', async () => {
      const planner = await plannerOf(request);
      const r = await request.post('/api/planner/ops', { data: { baseRevision: planner.revision, clientOpId: `qa-stale-${id}-${Date.now()}`, ops: [{ op: 'setSlot', comp: id, index: 1, value: '', expect: names.beta }] } });
      expect(r.ok()).toBeTruthy();
      expect((await r.json()).conflicts).toEqual([]);
      await expect.poll(async () => (await mainOf(request, id)).stale).toBe(true);
      await page.reload();
      await openCompartment(page, id);
      await expect(page.getByText('Image may be outdated — equipment assignments changed')).toBeVisible();
      await snap('11-stale-badge');
    });

    await test.step('publish anyway with the acknowledgement, then restore the previous image', async () => {
      await openStudio(page, id, 'review');
      await page.getByTestId('version-item').filter({ hasText: new RegExp(`^v${baseV + 1}(?!\\d)`) }).click();
      await page.getByRole('button', { name: /Publish…/ }).click();
      await page.getByTestId('publish-approve').click();
      await expect(page.getByRole('dialog', { name: 'Image may be outdated' })).toBeVisible();
      expect((await mainOf(request, id)).ref).toBe(child.id); // refused until acknowledged
      await page.getByTestId('publish-anyway').click();
      await expect(page.getByText('Main image updated for everyone.')).toBeVisible();
      expect(await mainOf(request, id)).toMatchObject({ kind: 'version', ref: first.id });
      await page.getByRole('button', { name: /Restore previous main image/ }).click();
      await expect(page.getByText('Previous main image restored.')).toBeVisible();
      expect((await mainOf(request, id)).ref).toBe(child.id);
    });
    setProviderDelay(0);
  });
}
