// Same-origin API client for /api (Worker). Used by App.jsx and the Studio. No secrets ever reach the browser.
// Signed-out detection: Cloudflare Access answers protected paths with a redirect to its login page; with
// redirect:'manual' that surfaces as an opaque redirect, which we report as AuthRequiredError like a 401.

export const API_BASE = '/api';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'INTERNAL';
    this.details = details;
  }
}

export class AuthRequiredError extends ApiError {
  constructor() {
    super(401, 'AUTH_REQUIRED', 'Sign in to make changes.');
    this.name = 'AuthRequiredError';
  }
}

export class NetworkError extends Error {
  constructor(cause) {
    super('You appear to be offline. Your work is kept on this device and will retry.');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/**
 * @param {string} path  path below /api, e.g. '/planner/ops'
 * @param {{method?:string, json?:unknown, body?:BodyInit, headers?:Record<string,string>, signal?:AbortSignal,
 *          idempotencyKey?:string, expect?:'json'|'response'}} [opts]
 */
export async function api(path, opts = {}) {
  const { method = 'GET', json, body, headers = {}, signal, idempotencyKey, expect = 'json' } = opts;
  const init = {
    method,
    headers: { Accept: 'application/json', ...headers },
    credentials: 'same-origin',
    redirect: 'manual',
    cache: 'no-store',
    signal,
  };
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body;
  }
  if (idempotencyKey) init.headers['Idempotency-Key'] = idempotencyKey;

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new NetworkError(err);
  }
  if (res.type === 'opaqueredirect' || res.status === 401) throw new AuthRequiredError();
  if (expect === 'response') {
    if (!res.ok && res.status !== 304) throw await toApiError(res);
    return res;
  }
  if (res.status === 204 || res.status === 304) return null;
  if (!res.ok) throw await toApiError(res);
  return res.json();
}

async function toApiError(res) {
  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON error body */ }
  const e = payload?.error ?? {};
  return new ApiError(res.status, e.code, e.message, e.details);
}

/** URL for the browser to sign in through Cloudflare Access and come back to the current page. */
export function signInUrl(returnPath = `${location.pathname}${location.search}${location.hash}`) {
  return `${API_BASE}/auth/login?return=${encodeURIComponent(returnPath)}`;
}

/** Random idempotency / client-op key (not a secret). */
export function newKey(prefix = 'k') {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}
