// The real browser-side client modules (src/lib/*, src/studio/**) talking to the real Worker: every response shape the UI
// reads is the canonical one. (No `api()` mocks: global fetch is routed to worker.fetch.)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compartmentAssignments } from '../../shared/planner.js';
import { api } from '../../src/lib/api.js';
import { deleteAsset, loadGallery, loadMainImages, setMainImage } from '../../src/lib/gallery.js';
import { cancelJob, createJob, estimate, getJob, listJobs, listVersions, retryJob } from '../../src/lib/jobs.js';
import { fetchSession } from '../../src/lib/session.js';
import { normalizeHistory, normalizeSettings } from '../../src/studio/admin/settingsModel.js';
import { photoCounts } from '../../src/studio/common/data.js';
import { isConfirmEstimate } from '../../src/studio/common/format.js';
import { uploadMarkup } from '../../src/studio/edit/markupUpload.js';
import { classifySubmitError, usageMeters } from '../../src/studio/generate/generateModel.js';
import { extractMain } from '../../src/studio/publish/publishModel.js';
import { ADMIN, EDITOR, createStack, device, installBrowserFetch, makePng, migrateUntilDone, plannerOf, uploadPhoto } from './harness.js';

describe('UI client modules against the real Worker', () => {
  let stack; let admin; let restore;
  const as = actor => { restore?.(); restore = installBrowserFetch(stack, actor); };
  beforeAll(async () => {
    stack = createStack();
    admin = device(stack, ADMIN);
    await migrateUntilDone(admin);
    expect((await admin.put('/api/admin/settings/ai.enabled', { value: true, expectRevision: 0 })).status).toBe(200);
  });
  afterAll(() => restore?.());

  it('session: editor, admin and signed-out', async () => {
    as(EDITOR);
    expect(await fetchSession()).toMatchObject({ status: 'signed_in', email: 'editor@example.com', canEdit: true, isAdmin: false, studioEnabled: true, aiEnabled: true });
    as(ADMIN);
    expect(await fetchSession()).toMatchObject({ isAdmin: true });
    as(null);
    expect(await fetchSession()).toMatchObject({ status: 'signed_out', canEdit: false });
  });

  it('gallery.js: main images map, public and editor galleries, set main, delete', async () => {
    as(null);
    const mains = await loadMainImages({ force: true });
    expect(Object.keys(mains).sort()).toEqual(['LS1', 'LS2']);
    expect(mains.LS1).toMatchObject({ compartmentId: 'LS1', kind: 'asset', revision: 1, stale: false });
    expect(extractMain(await api('/public/main-images'), 'LS2')).toMatchObject({ kind: 'preset' });
    const pub = await loadGallery('LS1', { editor: false, force: true });
    expect(pub.main).toMatchObject({ kind: 'asset', url: expect.stringMatching(/^\/api\/public\/assets\//) });
    const uploaded = pub.items.filter(i => i.kind === 'asset');
    expect(uploaded.map(i => i.title).sort()).toEqual(['Front', 'Side']);
    expect(uploaded.every(i => i.deletable && i.id === i.key.slice('asset:'.length))).toBe(true);
    expect(pub.items.some(i => i.kind === 'preset' && !i.deletable)).toBe(true);

    as(EDITOR);
    const front = uploaded.find(i => i.title === 'Front');
    const set = await setMainImage('LS1', { kind: 'asset', ref: front.id, expectRevision: 1 });
    expect(set).toMatchObject({ kind: 'asset', ref: front.id, revision: 2 });
    await expect(setMainImage('LS1', { kind: 'asset', ref: front.id, expectRevision: 1 })).rejects.toMatchObject({ status: 409, code: 'REVISION_CONFLICT' });
    const ed = await loadGallery('LS1', { editor: true, force: true });
    expect(ed.main.ref).toBe(front.id);
    const side = ed.items.find(i => i.title === 'Side');
    await deleteAsset('LS1', side.id);
    expect((await loadGallery('LS1', { editor: true, force: true })).items.some(i => i.id === side.id)).toBe(false);
    await expect(deleteAsset('LS1', front.id)).rejects.toMatchObject({ status: 409 }); // current main image
  });

  it('jobs.js: estimate, create (idempotent), get, list, cancel, retry, versions', async () => {
    as(EDITOR);
    const body = { kind: 'render', mode: 'plan', preset: 'preview' };
    const est = await estimate('LS3', body);
    expect(est).toEqual({ usd: expect.any(Number), basis: expect.any(String), requiresConfirm: false });
    expect((await estimate('LS3', { ...body, preset: 'max' })).requiresConfirm).toBe(true);
    const created = await createJob('LS3', body, 'ui-key-0000001');
    expect(created.job).toMatchObject({ status: 'queued', compartmentId: 'LS3' });
    expect(created.estimate.usd).toBe(est.usd);
    expect((await createJob('LS3', body, 'ui-key-0000001')).job.id).toBe(created.job.id);
    expect(await getJob(created.job.id)).toMatchObject({ id: created.job.id, status: 'queued' });
    expect((await listJobs('LS3')).map(j => j.id)).toEqual([created.job.id]);
    expect(await listVersions('LS3')).toEqual([]);
    expect(await cancelJob(created.job.id)).toMatchObject({ status: 'cancelled' });
    const retried = await retryJob(created.job.id);
    expect(retried.job).toMatchObject({ status: 'queued' });
    expect(retried.job.id).not.toBe(created.job.id);
    await cancelJob(retried.job.id);

    // the confirm-estimate 409 is read the canonical way by the Generate step's error classifier
    let err;
    try { await createJob('LS3', { ...body, preset: 'max' }, 'ui-key-0000002'); } catch (e) { err = e; }
    expect(err).toMatchObject({ status: 409, code: 'CONFLICT', details: { requiresConfirm: true } });
    expect(classifySubmitError(err)).toMatchObject({ kind: 'confirm', estimateUsd: expect.any(Number) });
    // retrying a Maximum Detail job needs the same confirmation (JobStatus "Try again" → "Confirm cost")
    const maxJob = await createJob('LS3', { ...body, preset: 'max', confirmEstimateUsd: err.details.estimate.usd }, 'ui-key-0000004');
    await cancelJob(maxJob.job.id);
    let retryErr;
    try { await retryJob(maxJob.job.id); } catch (e) { retryErr = e; }
    expect(isConfirmEstimate(retryErr)).toBe(true);
    const confirmedRetry = await retryJob(maxJob.job.id, retryErr.details.estimate.usd);
    expect(confirmedRetry.job).toMatchObject({ status: 'queued', preset: 'max' });
    expect(confirmedRetry.job.id).not.toBe(maxJob.job.id);
    await cancelJob(confirmedRetry.job.id);
    // referenceAssetIds from the edit step are accepted
    const { assetId } = await uploadPhoto(device(stack, EDITOR), { compartmentId: 'LS3', category: 'other', title: 'Reference' });
    const withRef = await createJob('LS3', { ...body, referenceAssetIds: [assetId] }, 'ui-key-0000003');
    expect(withRef.job.status).toBe('queued');
    await cancelJob(withRef.job.id);
  });

  it('markupUpload: a transparent PNG is accepted as original, display and thumb (category markup) and stays out of the library', async () => {
    as(EDITOR);
    const png = new Blob([await makePng()], { type: 'image/png' });
    const id = await uploadMarkup({ compId: 'LS4', png, width: 8, height: 6 });
    expect(id).toMatch(/^ast_/);
    const e = device(stack, EDITOR);
    expect((await e.get('/api/compartments/LS4/assets')).body.assets.map(a => a.id)).not.toContain(id);
    expect((await e.get('/api/compartments/LS4/assets?category=markup')).body.assets.map(a => a.id)).toContain(id);
    // a user photo may not use PNG derivatives
    const created = await e.post('/api/assets', { compartmentId: 'LS4', category: 'tool', width: 8, height: 6, bytes: png.size, sha256: 'a'.repeat(64), idempotencyKey: 'png-derivative-1' });
    expect((await e.putBytes(created.body.upload.display, new Uint8Array(await png.arrayBuffer()), 'image/png')).status).toBe(415);
  });

  it('admin: settings / history / usage / audit shapes feed normalizeSettings, normalizeHistory and usageMeters', async () => {
    as(ADMIN);
    const settings = normalizeSettings(await api('/admin/settings'));
    expect(settings['ai.enabled']).toEqual({ value: true, revision: 1 });
    expect(settings['budget.dailyUsd']).toEqual({ value: 8, revision: 0 });
    const saved = await api('/admin/settings/budget.dailyUsd', { method: 'PUT', json: { value: 9, expectRevision: 0 } });
    expect(saved).toEqual({ key: 'budget.dailyUsd', value: 9, revision: 1 });
    expect(normalizeHistory(await api('/admin/settings/budget.dailyUsd/history'))).toEqual([expect.objectContaining({ revision: 1, value: 9, updatedBy: 'owner@example.com' })]);
    expect(usageMeters(await api('/usage')).map(m => m.label)).toEqual(['This month', 'Today', 'You today']);
    const audit = await api('/admin/audit');
    expect(audit.entries.length).toBeGreaterThan(0);
    expect(audit.entries[0]).toEqual(expect.objectContaining({ id: expect.any(Number), at: expect.any(Number), actor: expect.any(String), action: expect.any(String), entityType: expect.anything() }));
  });

  it('data.js: photo counts per tool come from the real library list (links with state)', async () => {
    as(EDITOR);
    const dev = device(stack, EDITOR);
    const planner = await plannerOf(dev);
    const eq = planner.doc.equipmentIds['1 Ton Griphoist'];
    await uploadPhoto(dev, { compartmentId: 'LS1', category: 'tool', commit: { links: [{ targetType: 'equipment', targetId: eq, quantity: 1 }] } });
    const { assets } = await api('/compartments/LS1/assets');
    expect(photoCounts(assets, compartmentAssignments(planner.doc, 'LS1'))).toEqual({ [eq]: 1 });
  });
});
