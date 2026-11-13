// Identity: Cloudflare Access JWT verification (RS256 via the team JWKS) and the test-only header mode.
// getActor never throws and never leaks why a token was rejected; the router turns `anonymous` into 401 on protected
// routes. Misconfiguration (missing/placeholder ACCESS_AUD, unknown AUTH_MODE) fails closed: everyone is anonymous.
import { logEvent } from './http.js';
import { getSetting } from './settings.js';

const JWKS_TTL_MS = 10 * 60_000;
const JWKS_MIN_REFETCH_MS = 60_000;
const SKEW_S = 60;
const ANON = Object.freeze({ kind: 'anonymous' });
// AUTH_MODE=test is an explicit allow-list: only these ENVIRONMENT values may ever honor X-Test-Actor. Anything else
// (production, staging, unset, 'Production', ' staging', a typo) is refused, so a mis-set variable cannot open the API.
const TEST_MODE_ENVIRONMENTS = new Set(['test', 'development', 'local']);

const jwks = { url: '', keys: new Map(), fetchedAt: 0, attemptedAt: 0 };
const warned = new Set();

/** Reset module caches (tests). */
export function resetAuthCache() {
  jwks.url = ''; jwks.keys = new Map(); jwks.fetchedAt = 0; jwks.attemptedAt = 0; warned.clear();
}

function warnOnce(id, message) {
  if (warned.has(id)) return;
  warned.add(id);
  logEvent('error', 'auth.config', { message });
}

function b64urlBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
const trimSlash = s => String(s ?? '').replace(/\/+$/, '');

async function refreshKeys(url, now) {
  jwks.attemptedAt = now;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`jwks ${res.status}`);
    const body = await res.json();
    const keys = new Map();
    for (const jwk of body?.keys ?? []) {
      if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
      keys.set(jwk.kid, await crypto.subtle.importKey(
        'jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    }
    if (keys.size) { jwks.keys = keys; jwks.fetchedAt = now; }
  } catch (err) {
    logEvent('warn', 'auth.jwks_fetch_failed', { error: String(err?.message ?? err).slice(0, 120) });
  }
}

async function getVerifyKey(kid, certsUrl, now) {
  if (jwks.url !== certsUrl) { jwks.url = certsUrl; jwks.keys = new Map(); jwks.fetchedAt = 0; jwks.attemptedAt = 0; }
  const fresh = now - jwks.fetchedAt < JWKS_TTL_MS && now >= jwks.fetchedAt;
  if (fresh && jwks.keys.has(kid)) return jwks.keys.get(kid);
  const mayRefetch = jwks.attemptedAt === 0 || now - jwks.attemptedAt >= JWKS_MIN_REFETCH_MS || now < jwks.attemptedAt;
  if (mayRefetch) await refreshKeys(certsUrl, now);
  return jwks.keys.get(kid) ?? null;
}

/** Verify an Access JWT. @returns {Promise<object|null>} claims or null */
export async function verifyAccessJwt(token, env, now = Date.now()) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return null;
  let header; let claims; let sig;
  try {
    header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); sig = b64urlBytes(parts[2]);
  } catch { return null; }
  if (header?.alg !== 'RS256' || typeof header.kid !== 'string' || !claims || typeof claims !== 'object') return null;
  const team = trimSlash(env.ACCESS_TEAM_DOMAIN);
  const key = await getVerifyKey(header.kid, `${team}/cdn-cgi/access/certs`, now);
  if (!key) return null;
  try {
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!ok) return null;
  } catch { return null; }
  const nowS = Math.floor(now / 1000);
  if (trimSlash(claims.iss) !== team) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_S < nowS) return null;
  if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - SKEW_S > nowS)) return null;
  return claims;
}

function cookieValue(request, name) {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

async function adminEmails(env) {
  const list = new Set(String(env.OWNER_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  try {
    const stored = env.DB ? await getSetting(env.DB, 'access.admins') : [];
    for (const e of Array.isArray(stored) ? stored : []) if (typeof e === 'string') list.add(e.trim().toLowerCase());
  } catch { /* settings unavailable: owners only */ }
  return list;
}

async function userActor(email, env, wantAdmin) {
  const lower = email.trim().toLowerCase();
  const isAdmin = wantAdmin ?? (await adminEmails(env)).has(lower);
  return { kind: 'user', email: lower, roles: isAdmin ? ['editor', 'admin'] : ['editor'] };
}

/**
 * Resolve the caller. AUTH_MODE 'access' verifies the Cloudflare Access JWT; 'test' (vitest/local e2e only) honors
 * `X-Test-Actor: user:<email>[,admin] | service:<id>` and refuses in production/staging. Anything else fails closed.
 * @returns {Promise<import('../../shared/contracts.js').Actor>}
 */
export async function getActor(request, env) {
  try {
    if (env.AUTH_MODE === 'test') {
      if (!TEST_MODE_ENVIRONMENTS.has(env.ENVIRONMENT)) {
        warnOnce('test-in-prod', 'AUTH_MODE=test is only honored when ENVIRONMENT is test/development/local');
        return ANON;
      }
      const raw = request.headers.get('X-Test-Actor') ?? '';
      let m = /^user:([^,\s]+@[^,\s]+)(,admin)?$/.exec(raw);
      if (m) return await userActor(m[1], env, Boolean(m[2]));
      m = /^service:([\w.-]+)$/.exec(raw);
      if (m) return { kind: 'service', serviceId: m[1] };
      return ANON;
    }
    if (env.AUTH_MODE !== 'access') {
      warnOnce('bad-mode', 'AUTH_MODE is not "access": all protected routes fail closed');
      return ANON;
    }
    if (!env.ACCESS_AUD || env.ACCESS_AUD === 'SET_AT_DEPLOY' || !env.ACCESS_TEAM_DOMAIN) {
      warnOnce('no-aud', 'ACCESS_AUD/ACCESS_TEAM_DOMAIN not configured: all protected routes fail closed');
      return ANON;
    }
    const token = request.headers.get('Cf-Access-Jwt-Assertion') || cookieValue(request, 'CF_Authorization');
    if (!token) return ANON;
    const claims = await verifyAccessJwt(token, env);
    if (!claims) return ANON;
    if (typeof claims.email === 'string' && claims.email.includes('@')) return await userActor(claims.email, env);
    if (typeof claims.common_name === 'string' && claims.common_name) {
      // Optional pin: PROCESSOR_SERVICE_IDS="<service token client id>[,<id>]" restricts which Access service tokens count as
      // the processor (defence in depth on top of the Access policy). Unset = any service token of this Access app.
      const pinned = String(env.PROCESSOR_SERVICE_IDS ?? '').split(',').map(x => x.trim()).filter(Boolean);
      if (pinned.length && !pinned.includes(claims.common_name)) return ANON;
      return { kind: 'service', serviceId: claims.common_name };
    }
    return ANON;
  } catch {
    return ANON;
  }
}
