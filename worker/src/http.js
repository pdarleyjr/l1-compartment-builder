// Shared HTTP helpers for every Worker module (owner after P0: part E1; signatures are a contract for E2).
import { ERROR_CODES } from '../../shared/contracts.js';

export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
});

/** Error carrying a contract error code (shared/contracts.js ERROR_CODES); the router turns it into a JSON response. */
export class HttpError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'HttpError';
    this.code = code in ERROR_CODES ? code : 'INTERNAL';
    this.status = ERROR_CODES[this.code];
    this.details = details;
  }
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export function errorResponse(code, message, details, headers = {}) {
  const status = ERROR_CODES[code] ?? 500;
  const body = { error: { code: code in ERROR_CODES ? code : 'INTERNAL', message: message || code } };
  if (details !== undefined) body.error.details = details;
  return json(body, status, headers);
}

/** Read a JSON body with a hard byte limit (does not trust Content-Length). */
export async function readJson(request, maxBytes = 1_000_000) {
  const bytes = await readBytes(request, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError('INVALID_REQUEST', 'Request body must be valid JSON.');
  }
}

/** Read a raw body as Uint8Array, aborting once maxBytes is exceeded. */
export async function readBytes(request, maxBytes) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > maxBytes) throw new HttpError('PAYLOAD_TOO_LARGE', 'Upload is too large.');
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new HttpError('PAYLOAD_TOO_LARGE', 'Upload is too large.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

/** @param {import('../../shared/contracts.js').Actor} actor */
export function requireEditor(actor) {
  if (actor?.kind !== 'user') throw new HttpError('AUTH_REQUIRED', 'Sign in to make changes.');
  if (!actor.roles.includes('editor')) throw new HttpError('FORBIDDEN', 'You do not have permission to edit.');
  return actor;
}
export function requireAdmin(actor) {
  requireEditor(actor);
  if (!actor.roles.includes('admin')) throw new HttpError('FORBIDDEN', 'Administrator access is required.');
  return actor;
}
export function requireService(actor) {
  if (actor?.kind !== 'service') throw new HttpError('FORBIDDEN', 'Service identity required.');
  return actor;
}
/** Human-readable actor label for audit/ledger rows. */
export function actorLabel(actor) {
  if (actor?.kind === 'user') return actor.email;
  if (actor?.kind === 'service') return `service:${actor.serviceId}`;
  return 'anonymous';
}

/** Response with no body (204/304/302...) carrying the standard security headers. */
export function empty(status = 204, headers = {}) {
  return new Response(null, { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

/** Structured, secret-free log line (never pass request bodies, tokens or image bytes). */
export function logEvent(level, event, fields = {}) {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
