/* global Buffer, process -- Node 22 runtime globals (AIW processor runs on Node, not in the browser/Worker) */
// Structured JSON logger with redaction. Never emits secrets, auth headers, long prompts or image data.

const SECRET_KEY_RE = /authorization|secret|api[-_]?key|token|password|cookie/i;
const LONG_TEXT_KEY_RE = /prompt/i;
const BASE64_RUN_RE = /[A-Za-z0-9+/_-]{120,}={0,2}/g;
const DATA_URL_RE = /data:[a-z/+.-]+;base64,[A-Za-z0-9+/=_-]*/gi;
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{8,}/g;

/**
 * Remove secrets and bulky data from a string.
 * @param {string} text
 * @param {string[]} [secrets] exact secret values to mask
 * @returns {string}
 */
export function sanitize(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  return out.replace(DATA_URL_RE, '[redacted-data-url]').replace(OPENAI_KEY_RE, '[redacted-key]').replace(BASE64_RUN_RE, '[redacted-base64]');
}

/**
 * Deep-redact a value for logging.
 * @param {unknown} value
 * @param {string[]} secrets
 * @param {string} [key]
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redact(value, secrets, key = '', depth = 0) {
  if (value == null) return value;
  if (SECRET_KEY_RE.test(key)) return '[redacted]';
  if (typeof value === 'string') {
    let s = sanitize(value, secrets);
    const max = LONG_TEXT_KEY_RE.test(key) ? 200 : 1000;
    if (s.length > max) s = `${s.slice(0, max)}…[truncated ${s.length - max}]`;
    return s;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `[binary ${value.length} bytes]`;
  if (typeof value !== 'object') return value;
  if (depth > 5) return '[depth]';
  if (value instanceof Error) return { name: value.name, message: sanitize(value.message, secrets), code: /** @type {any} */ (value).code };
  if (Array.isArray(value)) return value.slice(0, 50).map(v => redact(v, secrets, key, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = redact(v, secrets, k, depth + 1);
  return out;
}

/**
 * @param {{secrets?: string[], write?: (line: string) => void, base?: object, level?: string}} [opts]
 * @returns {{debug: Function, info: Function, warn: Function, error: Function, child: (extra: object) => any}}
 */
export function createLogger(opts = {}) {
  const secrets = (opts.secrets || []).filter(Boolean);
  const write = opts.write || (line => process.stdout.write(`${line}\n`));
  const base = opts.base || {};
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  const min = order[opts.level || 'info'] || 20;
  const emit = (level, msg, fields) => {
    if (order[level] < min) return;
    const rec = { ts: new Date().toISOString(), level, msg: sanitize(msg, secrets), ...redact({ ...base, ...(fields || {}) }, secrets) };
    write(JSON.stringify(rec));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: extra => createLogger({ ...opts, base: { ...base, ...extra } }),
  };
}
