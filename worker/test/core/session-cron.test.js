import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../../worker/index.js';
import { safeReturnPath } from '../../src/session.js';
import { runCron } from '../../src/cron.js';
import { ADMIN, EDITOR, makeEnv, request } from '../helpers/index.js';

vi.mock('../../../shared/planner.js', async () => (await import('../helpers/fake-shared.js')).fakePlanner());
vi.mock('../../../shared/ids.js', async () => (await import('../helpers/fake-shared.js')).fakeIds());
vi.mock('../../../shared/validation.js', async () => (await import('../helpers/fake-shared.js')).fakeValidation());
const studioCron = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../src/studio-handlers.js', () => ({ assets: {}, gallery: {}, links: {}, mounts: {}, designs: {}, jobs: {}, spend: {}, processor: {}, studioCron }));

beforeEach(() => studioCron.mockClear());

describe('session', () => {
  it('reports anonymous, editor and admin with feature flags', async () => {
    const env = makeEnv();
    expect(await (await worker.fetch(request('GET', '/api/session'), env)).json()).toEqual({ email: null, roles: [], studioEnabled: true, aiEnabled: false });
    expect(await (await worker.fetch(request('GET', '/api/session', { actor: EDITOR }), env)).json()).toMatchObject({ email: 'editor@example.com', roles: ['editor'] });
    expect((await (await worker.fetch(request('GET', '/api/session', { actor: ADMIN }), env)).json()).roles).toEqual(['editor', 'admin']);
  });

  it('login 302s to same-origin paths only', async () => {
    const env = makeEnv();
    const go = async ret => worker.fetch(request('GET', `/api/auth/login${ret === undefined ? '' : `?return=${encodeURIComponent(ret)}`}`, { actor: EDITOR }), env);
    expect((await go('/studio/LS1')).headers.get('Location')).toBe('/studio/LS1');
    expect((await go()).headers.get('Location')).toBe('/');
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '/ok\r\nSet-Cookie: x=1', '/a\\b', '']) {
      expect((await go(bad)).headers.get('Location'), bad).toBe('/');
    }
    expect((await go('/x')).status).toBe(302);
    expect((await worker.fetch(request('GET', '/api/auth/login?return=/x'), env)).status).toBe(401);
    expect(safeReturnPath('/a?b=c#d')).toBe('/a?b=c#d');
  });
});

describe('cron', () => {
  it('keeps the newest 2000 planner_history rows and prunes audit_log older than 400 days', async () => {
    const env = makeEnv();
    const now = Date.UTC(2026, 10, 12);
    const day = 86_400_000;
    await env.DB.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 2300)
      INSERT INTO planner_history (revision, ops, created_at) SELECT i, '[]', 0 FROM n`);
    for (const [age, action] of [[399, 'keep'], [401, 'drop'], [1, 'keep']]) {
      await env.DB.prepare('INSERT INTO audit_log (at, action) VALUES (?, ?)').bind(now - age * day, action).run();
    }
    const out = await runCron(env, now);
    expect(out).toEqual({ plannerHistoryDeleted: 300, auditDeleted: 1 });
    expect((await env.DB.prepare('SELECT MIN(revision) m, COUNT(*) n FROM planner_history').first())).toEqual({ m: 301, n: 2000 });
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='drop'").first()).n).toBe(0);
    expect(studioCron).toHaveBeenCalledWith(env, now);
  });

  it('a failing step never blocks the others', async () => {
    const env = makeEnv();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    studioCron.mockRejectedValueOnce(new Error('boom'));
    await expect(runCron(env, Date.now())).resolves.toBeTruthy();
    err.mockRestore();
  });

  it('scheduled() hands the work to waitUntil', async () => {
    const env = makeEnv();
    const waits = [];
    await worker.scheduled({}, env, { waitUntil: p => waits.push(p) });
    await Promise.all(waits);
    expect(waits).toHaveLength(1);
    expect(studioCron).toHaveBeenCalledTimes(1);
  });
});
