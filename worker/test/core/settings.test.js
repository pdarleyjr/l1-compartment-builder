import { describe, expect, it, vi } from 'vitest';
import worker from '../../../worker/index.js';
import { SETTINGS_DEFAULTS, SETTINGS_KEYS } from '../../../shared/contracts.js';
import { clearSettingsCache, getSetting, getSettings } from '../../src/settings.js';
import { ADMIN, EDITOR, makeEnv, ORIGIN, request } from '../helpers/index.js';

vi.mock('../../../shared/planner.js', async () => (await import('../helpers/fake-shared.js')).fakePlanner());
vi.mock('../../../shared/ids.js', async () => (await import('../helpers/fake-shared.js')).fakeIds());
vi.mock('../../../shared/validation.js', async () => (await import('../helpers/fake-shared.js')).fakeValidation());
vi.mock('../../src/studio-handlers.js', () => ({ assets: {}, gallery: {}, links: {}, mounts: {}, designs: {}, jobs: {}, spend: {}, processor: {}, studioCron: async () => {} }));

const put = (env, key, json, actor = ADMIN) => worker.fetch(request('PUT', `/api/admin/settings/${encodeURIComponent(key)}`, { actor, json, origin: ORIGIN }), env);

describe('admin settings', () => {
  it('lists every key merged with defaults and per-key revision', async () => {
    const env = makeEnv();
    const { settings } = await (await worker.fetch(request('GET', '/api/admin/settings', { actor: ADMIN }), env)).json();
    expect(Object.keys(settings).sort()).toEqual([...SETTINGS_KEYS].sort());
    expect(settings['budget.monthlyUsd']).toEqual(expect.objectContaining({ value: 25, revision: 0, default: 25 }));
    expect((await worker.fetch(request('GET', '/api/admin/settings', { actor: EDITOR }), env)).status).toBe(403);
  });

  it('writes with CAS, bumps the revision, records history and audit', async () => {
    const env = makeEnv();
    const r1 = await put(env, 'budget.monthlyUsd', { value: 40, expectRevision: 0 });
    expect(await r1.json()).toEqual({ key: 'budget.monthlyUsd', value: 40, revision: 1 });
    const r2 = await put(env, 'budget.monthlyUsd', { value: 50, expectRevision: 1 });
    expect((await r2.json()).revision).toBe(2);
    const stale = await put(env, 'budget.monthlyUsd', { value: 60, expectRevision: 1 });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toMatchObject({ code: 'REVISION_CONFLICT', details: { currentRevision: 2 } });
    const dup = await put(env, 'budget.monthlyUsd', { value: 60, expectRevision: 0 });
    expect(dup.status).toBe(409);
    const hist = await (await worker.fetch(request('GET', '/api/admin/settings/budget.monthlyUsd/history', { actor: ADMIN }), env)).json();
    expect(hist.history.map(h => [h.revision, h.value, h.updatedBy])).toEqual([[2, 50, 'owner@example.com'], [1, 40, 'owner@example.com']]);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='settings.update'").first()).n).toBe(2);
    const listed = await (await worker.fetch(request('GET', '/api/admin/settings', { actor: ADMIN }), env)).json();
    expect(listed.settings['budget.monthlyUsd']).toEqual(expect.objectContaining({ value: 50, revision: 2, default: 25 }));
  });

  it('a lost CAS race inside the batch rolls everything back', async () => {
    const env = makeEnv();
    const realBatch = env.DB.batch.bind(env.DB);
    env.DB.batch = async s => {
      await env.DB.prepare("INSERT INTO settings (key, value, revision, updated_at) VALUES ('budget.dailyUsd', '9', 1, 0)").run();
      await env.DB.prepare("INSERT INTO settings_history (key, revision, value, updated_at) VALUES ('budget.dailyUsd', 1, '9', 0)").run();
      return realBatch(s);
    };
    const res = await put(env, 'budget.dailyUsd', { value: 3, expectRevision: 0 });
    expect(res.status).toBe(409);
    expect((await env.DB.prepare("SELECT value FROM settings WHERE key='budget.dailyUsd'").first()).value).toBe('9');
  });

  it('validates keys, bodies and values', async () => {
    const env = makeEnv();
    expect((await put(env, 'not.a.setting', { value: 1, expectRevision: 0 })).status).toBe(404);
    expect((await put(env, 'budget.monthlyUsd', { value: -5, expectRevision: 0 })).status).toBe(400);
    expect((await put(env, 'budget.monthlyUsd', { value: 5 })).status).toBe(400);
    expect((await put(env, 'studio.enabled', { value: 'yes', expectRevision: 0 })).status).toBe(400);
    expect((await put(env, 'budget.monthlyUsd', { value: 5, expectRevision: 0 }, EDITOR)).status).toBe(403);
    expect((await worker.fetch(request('GET', '/api/admin/settings/nope/history', { actor: ADMIN }), env)).status).toBe(404);
  });

  it('getSetting/getSettings helpers apply defaults, cache for 5 s and are bypassed after writes', async () => {
    const env = makeEnv();
    expect(await getSetting(env.DB, 'budget.dailyUsd')).toBe(SETTINGS_DEFAULTS['budget.dailyUsd']);
    expect(await getSettings(env.DB, ['budget.dailyUsd', 'ai.enabled'])).toEqual({ 'budget.dailyUsd': 8, 'ai.enabled': false });
    await env.DB.prepare("INSERT INTO settings (key, value, revision, updated_at) VALUES ('budget.dailyUsd', '11', 1, 0)").run();
    expect(await getSetting(env.DB, 'budget.dailyUsd')).toBe(8); // cached
    await put(env, 'budget.monthlyUsd', { value: 1, expectRevision: 0 });
    expect(await getSetting(env.DB, 'budget.dailyUsd')).toBe(11); // write cleared the cache
    clearSettingsCache(env.DB);
    const all = await getSettings(env.DB);
    expect(Object.keys(all)).toHaveLength(SETTINGS_KEYS.length);
  });
});
