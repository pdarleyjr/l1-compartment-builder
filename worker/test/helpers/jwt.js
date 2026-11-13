// Real RS256 Access JWTs + a JWKS fetch mock.
import { vi } from 'vitest';

export const TEAM = 'https://team.example.cloudflareaccess.com';
export const AUD = 'aud-tag-123';
const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = obj => b64u(new TextEncoder().encode(JSON.stringify(obj)));

/** @returns {Promise<{kid:string, privateKey:CryptoKey, jwk:object}>} */
export async function makeKeyPair(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { kid, privateKey: pair.privateKey, jwk };
}

/** Mint a JWT. `claims` override defaults; `header` overrides {alg:'RS256', kid}. */
export async function signJwt(key, claims = {}, { header = {}, now = Date.now(), unsigned = false } = {}) {
  const s = Math.floor(now / 1000);
  const h = { alg: 'RS256', typ: 'JWT', kid: key.kid, ...header };
  const p = { iss: TEAM, aud: [AUD], iat: s, exp: s + 3600, ...claims };
  const input = `${enc(h)}.${enc(p)}`;
  if (unsigned) return `${input}.`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64u(sig)}`;
}

/** Stub global fetch to serve the JWKS for TEAM. `current.keys` can be swapped to simulate rotation. */
export function mockJwks(initialKeys) {
  const state = { keys: initialKeys, calls: 0, fail: false };
  const fn = vi.fn(async url => {
    if (String(url) !== `${TEAM}/cdn-cgi/access/certs`) throw new Error(`unexpected fetch ${url}`);
    state.calls++;
    if (state.fail) return new Response('nope', { status: 500 });
    return new Response(JSON.stringify({ keys: state.keys.map(k => k.jwk) }), { headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return state;
}
