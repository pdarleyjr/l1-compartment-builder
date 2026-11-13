// Client for the Worker's /api/processor/* endpoints (Cloudflare Access service token auth).
import { Readable } from 'node:stream';

export class ApiError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {{apiBase:string, accessClientId:string, accessClientSecret:string, node?:string}} cfg
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, uploadTimeoutMs?: number, retries?: number, retryBaseMs?: number,
 *   maxDownloadBytes?: number, sleepImpl?: (ms:number)=>Promise<void>}} [opts]
 */
export function createApiClient(cfg, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const uploadTimeoutMs = opts.uploadTimeoutMs ?? 120_000;
  const retries = opts.retries ?? 3;
  const retryBaseMs = opts.retryBaseMs ?? 500;
  const maxDownloadBytes = opts.maxDownloadBytes ?? 40 * 1024 * 1024;
  const wait = opts.sleepImpl || sleep;
  const origin = new URL(cfg.apiBase).origin;

  const authHeaders = () => ({ 'CF-Access-Client-Id': cfg.accessClientId, 'CF-Access-Client-Secret': cfg.accessClientSecret });

  /** Only same-origin URLs are ever fetched, so Access credentials cannot leak elsewhere. */
  const resolveUrl = pathOrUrl => {
    const u = new URL(pathOrUrl, `${cfg.apiBase}/`);
    if (u.origin !== origin) throw new ApiError(0, 'BAD_URL', 'Refusing to call a URL outside the API origin');
    return u.toString();
  };
  const apiUrl = path => resolveUrl(`${cfg.apiBase}/api${path}`);

  /** Run fn with retries on network errors and 5xx (never on 4xx). */
  async function withRetry(fn, signal) {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        const retryable = err instanceof ApiError ? err.status >= 500 : !(signal?.aborted) && err?.code !== 'BAD_URL';
        if (!retryable || attempt >= retries || signal?.aborted) throw err;
        const delay = retryBaseMs * 2 ** attempt * (0.5 + Math.random());
        attempt += 1;
        await wait(delay);
      }
    }
  }

  async function toError(res) {
    let code = `HTTP_${res.status}`;
    let message = `Worker returned HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error?.code) code = String(j.error.code);
      if (j?.error?.message) message = String(j.error.message).slice(0, 300);
    } catch { /* non-JSON body */ }
    return new ApiError(res.status, code, message);
  }

  /**
   * JSON request. Resolves with parsed body, or null for 204.
   * @param {string} method @param {string} path e.g. /processor/claim @param {object} [body]
   * @param {{signal?: AbortSignal}} [o]
   */
  async function json(method, path, body, o = {}) {
    return withRetry(async () => {
      const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      const res = await fetchImpl(apiUrl(path), {
        method, signal,
        headers: { ...authHeaders(), accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 204) return null;
      if (!res.ok) throw await toError(res);
      return res.json();
    }, o.signal);
  }

  return {
    /** @returns {Promise<{job:object, spec:object, references:object[], leaseExpiresAt:number}|null>} */
    claim: (node, kinds, o) => json('POST', '/processor/claim', { node, kinds }, o),
    /** Heartbeat doubles as status report. @returns {Promise<{leaseExpiresAt:number, cancelRequested:boolean}>} */
    heartbeat: (jobId, node, status, o) => json('POST', `/processor/jobs/${encodeURIComponent(jobId)}/heartbeat`, { node, status }, o),
    complete: (jobId, body, o) => json('POST', `/processor/jobs/${encodeURIComponent(jobId)}/complete`, body, o),
    fail: (jobId, body, o) => json('POST', `/processor/jobs/${encodeURIComponent(jobId)}/fail`, body, o),
    /** Reachability probe for --health (GET on a POST-only route → 405 means reachable and authorised). */
    async ping() {
      const res = await fetchImpl(apiUrl('/processor/claim'), { method: 'GET', redirect: 'manual', headers: authHeaders(), signal: AbortSignal.timeout(timeoutMs) });
      await res.arrayBuffer();
      return { status: res.status };
    },

    /**
     * Stream a binary output variant to the Worker (PUT). `bytes` is re-streamed on each retry.
     * @param {string} jobId @param {'original'|'display'|'thumb'} variant @param {Buffer} bytes @param {string} mime
     */
    async putOutput(jobId, variant, bytes, mime, o = {}) {
      return withRetry(async () => {
        const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(uploadTimeoutMs)]) : AbortSignal.timeout(uploadTimeoutMs);
        const chunks = [];
        for (let i = 0; i < bytes.length; i += 64 * 1024) chunks.push(bytes.subarray(i, i + 64 * 1024));
        const res = await fetchImpl(apiUrl(`/processor/jobs/${encodeURIComponent(jobId)}/output/${variant}`), {
          method: 'PUT', signal, duplex: 'half',
          headers: { ...authHeaders(), 'content-type': mime, 'content-length': String(bytes.length) },
          body: Readable.toWeb(Readable.from(chunks)),
        });
        if (!res.ok) throw await toError(res);
        await res.arrayBuffer();
      }, o.signal);
    },

    /**
     * Download a reference variant (same-origin only) with a hard size cap.
     * @param {string} url absolute or API-relative @returns {Promise<{bytes:Buffer, mime:string}>}
     */
    async download(url, o = {}) {
      return withRetry(async () => {
        const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(uploadTimeoutMs)]) : AbortSignal.timeout(uploadTimeoutMs);
        const res = await fetchImpl(resolveUrl(url), { method: 'GET', headers: authHeaders(), signal });
        if (!res.ok) throw await toError(res);
        const declared = Number(res.headers.get('content-length') || 0);
        if (declared > maxDownloadBytes) throw new ApiError(413, 'TOO_LARGE', 'Reference exceeds the download size cap');
        const parts = [];
        let total = 0;
        for await (const chunk of res.body) {
          total += chunk.length;
          if (total > maxDownloadBytes) throw new ApiError(413, 'TOO_LARGE', 'Reference exceeds the download size cap');
          parts.push(chunk);
        }
        return { bytes: Buffer.concat(parts), mime: (res.headers.get('content-type') || 'application/octet-stream').split(';')[0] };
      }, o.signal);
    },
  };
}
