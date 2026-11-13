// Ids: `${prefix}_` + 26 chars [0-9a-z] — 10 chars base36 millisecond timestamp (zero padded, so ids sort by time)
// + 16 random chars. Works unchanged in Workers, browsers and Node 22 (Web Crypto only).
import { sha256StringSync } from './lib/sha256.js';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomChars(n) {
  let out = '';
  while (out.length < n) {
    const bytes = new Uint8Array(n * 2);
    globalThis.crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < 252 && out.length < n) out += ALPHABET[b % 36]; // 252 = 36*7: rejection sampling, no modulo bias
    }
  }
  return out;
}

/**
 * New time-sortable id.
 * @param {string} prefix e.g. ID_PREFIX.asset ('ast')
 * @param {number} [now] timestamp override (tests)
 * @returns {string}
 */
export function newId(prefix, now = Date.now()) {
  return `${prefix}_${Math.max(0, Math.floor(now)).toString(36).padStart(10, '0').slice(-10)}${randomChars(16)}`;
}

/**
 * SHA-256 hex of a string (UTF-8) or bytes (Web Crypto; works in Worker, browser, Node 22).
 * @param {string|Uint8Array|ArrayBuffer} input
 * @returns {Promise<string>}
 */
export async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? new globalThis.TextEncoder().encode(input)
    : input instanceof ArrayBuffer ? new Uint8Array(input)
      : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : null;
  if (!bytes) throw new TypeError('sha256Hex: expected string, Uint8Array or ArrayBuffer');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/** Synchronous variant of {@link equipmentIdForName} (same value). @param {string} name @returns {string} */
export function equipmentIdForNameSync(name) {
  return `eq_${sha256StringSync(name).slice(0, 16)}`;
}

/** Deterministic equipment id for a base-inventory name: 'eq_' + first 16 hex of sha256(name). @param {string} name @returns {Promise<string>} */
export async function equipmentIdForName(name) {
  return `eq_${(await sha256Hex(name)).slice(0, 16)}`;
}
