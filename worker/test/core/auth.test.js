import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../../worker/index.js';
import { resetAuthCache } from '../../src/auth.js';
import { clearSettingsCache } from '../../src/settings.js';
import { makeEnv, request } from '../helpers/index.js';
import { AUD, makeKeyPair, mockJwks, signJwt, TEAM } from '../helpers/jwt.js';

vi.mock('../../../shared/planner.js', async () => (await import('../helpers/fake-shared.js')).fakePlanner());
vi.mock('../../../shared/ids.js', async () => (await import('../helpers/fake-shared.js')).fakeIds());
vi.mock('../../../shared/validation.js', async () => (await import('../helpers/fake-shared.js')).fakeValidation());
vi.mock('../../src/studio-handlers.js', async () => {
  const { json } = await import('../../src/http.js');
  return {
    assets: {}, gallery: {}, links: {}, mounts: {}, designs: {}, jobs: {}, spend: {},
    processor: { claim: async ctx => json({ service: ctx.actor.serviceId }) },
    studioCron: async () => {},
  };
});

const accessEnv = (o = {}) => makeEnv({ AUTH_MODE: 'access', ENVIRONMENT: 'production', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...o });
const session = async (env, headers) => (await worker.fetch(request('GET', '/api/session', { headers }), env)).json();
let key;

beforeEach(async () => { resetAuthCache(); key = await makeKeyPair('kid-1'); mockJwks([key]); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Access JWT verification', () => {
  it('accepts a valid user JWT from the header and from the CF_Authorization cookie', async () => {
    const env = accessEnv();
    const token = await signJwt(key, { email: 'Fire.Fighter@MiamiBeachFL.gov' });
    expect(await session(env, { 'Cf-Access-Jwt-Assertion': token })).toMatchObject({ email: 'fire.fighter@miamibeachfl.gov', roles: ['editor'] });
    expect(await session(env, { Cookie: `x=1; CF_Authorization=${token}` })).toMatchObject({ email: 'fire.fighter@miamibeachfl.gov' });
  });

  it('grants admin to the owner (OWNER_EMAILS) and to settings access.admins', async () => {
    const env = accessEnv();
    const owner = await signJwt(key, { email: 'owner@example.com' });
    expect((await session(env, { 'Cf-Access-Jwt-Assertion': owner })).roles).toEqual(['editor', 'admin']);
    await env.DB.prepare("INSERT INTO settings (key, value, revision, updated_at) VALUES ('access.admins', ?, 1, 0)").bind('["boss@example.com"]').run();
    clearSettingsCache(env.DB); // settings reads are cached for 5 s per isolate
    const boss = await signJwt(key, { email: 'Boss@Example.com' });
    expect((await session(env, { 'Cf-Access-Jwt-Assertion': boss })).roles).toEqual(['editor', 'admin']);
  });

  it.each([
    ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ['wrong aud', { aud: ['other'] }],
    ['wrong iss', { iss: 'https://evil.cloudflareaccess.com' }],
    ['not yet valid', { nbf: Math.floor(Date.now() / 1000) + 3600 }],
  ])('rejects a %s token', async (_name, claims) => {
    const token = await signJwt(key, { email: 'a@b.co', ...claims });
    expect((await session(accessEnv(), { 'Cf-Access-Jwt-Assertion': token })).email).toBeNull();
  });

  it('tolerates 60 s clock skew on exp', async () => {
    const token = await signJwt(key, { email: 'a@b.co', exp: Math.floor(Date.now() / 1000) - 30 });
    expect((await session(accessEnv(), { 'Cf-Access-Jwt-Assertion': token })).email).toBe('a@b.co');
  });

  it('rejects alg none, HS256, tampered payloads and foreign signatures', async () => {
    const env = accessEnv();
    const none = await signJwt(key, { email: 'a@b.co' }, { header: { alg: 'none' }, unsigned: true });
    const hs = await signJwt(key, { email: 'a@b.co' }, { header: { alg: 'HS256' } });
    const good = await signJwt(key, { email: 'a@b.co' });
    const [h, , s] = good.split('.');
    const forged = `${h}.${btoa(JSON.stringify({ iss: TEAM, aud: [AUD], exp: 9999999999, email: 'admin@b.co' })).replace(/=+$/, '')}.${s}`;
    const other = await makeKeyPair('kid-1');
    const foreign = await signJwt(other, { email: 'a@b.co' });
    for (const t of [none, hs, forged, foreign, 'garbage', '']) {
      expect((await session(env, { 'Cf-Access-Jwt-Assertion': t })).email, t.slice(0, 20)).toBeNull();
    }
  });

  it('refetches the JWKS for an unknown kid (rotation) but at most once a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
    const env = accessEnv();
    const jwks = mockJwks([key]);
    expect((await session(env, { 'Cf-Access-Jwt-Assertion': await signJwt(key, { email: 'a@b.co' }) })).email).toBe('a@b.co');
    expect(jwks.calls).toBe(1);
    const rotated = await makeKeyPair('kid-2');
    jwks.keys = [rotated];
    const t2 = await signJwt(rotated, { email: 'new@b.co' });
    vi.setSystemTime(new Date('2026-11-12T12:00:10Z')); // only 10 s after the last fetch
    expect((await session(env, { 'Cf-Access-Jwt-Assertion': t2 })).email).toBeNull();
    expect(jwks.calls).toBe(1);
    vi.setSystemTime(new Date('2026-11-12T12:01:10Z'));
    expect((await session(env, { 'Cf-Access-Jwt-Assertion': t2 })).email).toBe('new@b.co');
    expect(jwks.calls).toBe(2);
    await session(env, { 'Cf-Access-Jwt-Assertion': t2 });
    expect(jwks.calls).toBe(2); // cached
  });

  it('survives a JWKS outage (anonymous, no crash)', async () => {
    const jwks = mockJwks([key]);
    jwks.fail = true;
    expect((await session(accessEnv(), { 'Cf-Access-Jwt-Assertion': await signJwt(key, { email: 'a@b.co' }) })).email).toBeNull();
  });
});

describe('service tokens and route isolation', () => {
  it('service JWT (common_name) may call /api/processor/* only; users may not', async () => {
    const env = accessEnv();
    const svc = await signJwt(key, { common_name: 'abc.access', sub: '' });
    const user = await signJwt(key, { email: 'owner@example.com' });
    const ok = await worker.fetch(request('POST', '/api/processor/claim', { headers: { 'Cf-Access-Jwt-Assertion': svc }, json: {} }), env);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ service: 'abc.access' });
    const asUser = await worker.fetch(request('POST', '/api/processor/claim', { headers: { 'Cf-Access-Jwt-Assertion': user }, json: {} }), env);
    expect(asUser.status).toBe(403);
    const svcOnEditor = await worker.fetch(request('POST', '/api/planner/ops', { headers: { 'Cf-Access-Jwt-Assertion': svc }, json: {} }), env);
    expect(svcOnEditor.status).toBe(403);
    const anon = await worker.fetch(request('POST', '/api/processor/claim', { json: {} }), env);
    expect(anon.status).toBe(401);
    const svcAdmin = await worker.fetch(request('GET', '/api/admin/settings', { headers: { 'Cf-Access-Jwt-Assertion': svc } }), env);
    expect(svcAdmin.status).toBe(403);
  });
});

describe('fail closed', () => {
  it.each([
    ['ACCESS_AUD missing', { ACCESS_AUD: undefined }],
    ['ACCESS_AUD placeholder', { ACCESS_AUD: 'SET_AT_DEPLOY' }],
    ['unknown AUTH_MODE', { AUTH_MODE: 'open' }],
  ])('%s => protected routes 401 even with a valid token', async (_n, over) => {
    const env = accessEnv(over);
    const token = await signJwt(key, { email: 'owner@example.com' });
    const res = await worker.fetch(request('GET', '/api/auth/login', { headers: { 'Cf-Access-Jwt-Assertion': token } }), env);
    expect(res.status).toBe(401);
    expect((await session(env, { 'Cf-Access-Jwt-Assertion': token })).email).toBeNull(); // public route still works
  });

  it('AUTH_MODE=test refuses to run in production and staging', async () => {
    for (const ENVIRONMENT of ['production', 'staging']) {
      const res = await worker.fetch(request('GET', '/api/auth/login', { actor: 'user:owner@example.com,admin' }), makeEnv({ ENVIRONMENT }));
      expect(res.status, ENVIRONMENT).toBe(401);
    }
    const ok = await worker.fetch(request('GET', '/api/auth/login', { actor: 'user:owner@example.com' }), makeEnv());
    expect(ok.status).toBe(302);
  });

  it('test mode ignores malformed X-Test-Actor values', async () => {
    for (const actor of ['admin', 'user:', 'user:nope', 'service:']) {
      const res = await worker.fetch(request('GET', '/api/auth/login', { actor }), makeEnv());
      expect(res.status, actor).toBe(401);
    }
  });
});
