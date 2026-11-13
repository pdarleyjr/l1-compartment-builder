/* global AbortSignal, Blob, Buffer, FormData, fetch -- Node 22 runtime globals (AIW processor runs on Node, not in the browser/Worker) */
// Provider-neutral image adapter. The runner only depends on generateImage / recognize / verify, so models or
// providers can change without touching job-runner.js. Never log the key, auth headers, prompts > 200 chars or bytes.
import { sanitize } from './logger.js';

export class ProviderError extends Error {
  /** @param {{code:string, message:string, retryable:boolean, providerCalled:boolean, status?:number, requestId?:string|null}} f */
  constructor(f) {
    super(f.message);
    this.name = 'ProviderError';
    this.code = f.code;
    this.retryable = f.retryable;
    this.providerCalled = f.providerCalled;
    this.status = f.status ?? 0;
    this.requestId = f.requestId ?? null;
    this.detail = f.detail ?? null; // sanitized provider text for the local log only; never sent to the Worker
  }
}

/** Node/undici connection errors that happen before any request byte can have reached the provider. */
const PRE_SEND_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);

/**
 * Map a failed HTTP response to a ProviderError.
 *  - 429 rate limit: retryable; providerCalled true but no image produced, so it is not charged (insufficient_quota is a
 *    429 too but is terminal).
 *  - 5xx: retryable. 400 / moderation_blocked / insufficient_quota / billing / invalid model / auth: terminal.
 * @param {number} status @param {any} body parsed JSON error body (may be null) @param {string|null} requestId
 */
export function mapHttpError(status, body, requestId = null) {
  const e = body?.error || {};
  const pcode = String(e.code || e.type || '');
  // The provider's error text is never forwarded (it can carry key fragments, org ids or prompt excerpts): the message is a
  // fixed string built from the status only, and the Worker maps the code to user-facing text. Details stay in the
  // sanitized processor log through the thrown error's `detail`.
  const message = `Provider returned HTTP ${status}`;
  const base = { providerCalled: true, status, requestId, message, detail: sanitize(typeof e.message === 'string' ? e.message : '').slice(0, 300) };
  if (pcode === 'moderation_blocked') return new ProviderError({ ...base, code: 'MODERATION_BLOCKED', retryable: false,
    message: 'The image provider declined this request (safety moderation). Change the instructions or photos and try again.' });
  if (pcode === 'insufficient_quota' || pcode === 'billing_hard_limit_reached' || /billing|quota/i.test(pcode)) return new ProviderError({ ...base, code: 'PROVIDER_BILLING', retryable: false });
  if (status === 429) return new ProviderError({ ...base, code: 'PROVIDER_RATE_LIMITED', retryable: true });
  if (status >= 500) return new ProviderError({ ...base, code: 'PROVIDER_UNAVAILABLE', retryable: true });
  if (status === 401 || status === 403) return new ProviderError({ ...base, code: 'PROVIDER_AUTH', retryable: false });
  if (status === 404 || pcode === 'model_not_found') return new ProviderError({ ...base, code: 'PROVIDER_MODEL_INVALID', retryable: false });
  return new ProviderError({ ...base, code: 'PROVIDER_REJECTED', retryable: false });
}

/** Map a thrown fetch error (no HTTP response). */
export function mapNetworkError(err, timedOut, aborted) {
  if (aborted) return new ProviderError({ code: 'ABORTED', message: 'Provider call aborted', retryable: false, providerCalled: true });
  if (timedOut) return new ProviderError({ code: 'PROVIDER_TIMEOUT', message: 'The image provider did not answer within 300 s; the outcome is unknown.', retryable: false, providerCalled: true });
  const c = err?.cause?.code || err?.code;
  if (PRE_SEND_CODES.has(c)) return new ProviderError({ code: 'PROVIDER_UNREACHABLE', message: 'Could not reach the image provider (network).', retryable: true, providerCalled: false });
  return new ProviderError({ code: 'PROVIDER_CONNECTION_LOST', message: 'Connection to the image provider was lost after sending; the outcome is unknown.', retryable: false, providerCalled: true });
}

const RECOGNITION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['objects'],
  properties: { objects: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['label', 'quantity', 'region', 'candidates'],
    properties: {
      label: { type: 'string' },
      quantity: { type: 'integer' },
      region: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['x', 'y', 'w', 'h'],
        properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } }] },
      candidates: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['equipmentId', 'confidence'],
        properties: { equipmentId: { type: 'string' }, confidence: { type: 'number' } } } },
    } } } },
};
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['missing', 'extra', 'notes', 'confidence'],
  properties: { missing: { type: 'array', items: { type: 'string' } }, extra: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' }, confidence: { type: 'number' } },
};

const clamp01 = n => Math.min(1, Math.max(0, Number(n) || 0));

/**
 * @param {{apiKey:string, baseUrl?:string, fetchImpl?: typeof fetch, timeoutMs?:number}} cfg
 */
export function createOpenAiAdapter(cfg) {
  const baseUrl = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const fetchImpl = cfg.fetchImpl || fetch;
  const timeoutMs = cfg.timeoutMs ?? 300_000;

  /** One provider request. Never retried here: a paid call is never resubmitted by the processor itself. */
  async function call(path, init, signal) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, { ...init, signal: sig, headers: { authorization: `Bearer ${cfg.apiKey}`, ...init.headers } });
    } catch (err) {
      throw mapNetworkError(err, timeout.aborted, !!signal?.aborted);
    }
    const requestId = res.headers.get('x-request-id');
    let text;
    try { text = await res.text(); } catch (err) { throw mapNetworkError(err, timeout.aborted, !!signal?.aborted); }
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-JSON */ }
    if (!res.ok) throw mapHttpError(res.status, body, requestId);
    if (!body) throw new ProviderError({ code: 'PROVIDER_BAD_RESPONSE', message: 'Provider returned a non-JSON response', retryable: false, providerCalled: true, requestId });
    return { body, requestId };
  }

  return {
    name: 'openai',
    /**
     * Render an image. Uses Images API edits (multipart `image[]`, optional `markup`) when references/markup exist,
     * otherwise generations (JSON).
     * @param {{model:string, prompt:string, size?:string, quality?:string, complexity?:string, outputFormat?:string,
     *   moderation?:string, references?:{bytes:Buffer, mime:string, filename:string, label?:string}[],
     *   markup?:{bytes:Buffer, mime:string, filename:string}, signal?:AbortSignal}} a
     * @returns {Promise<{bytes:Buffer, mime:string, width:number|null, height:number|null, usage:object|null, requestId:string|null, revisedPrompt:string|null}>}
     */
    async generateImage(a) {
      const refs = a.references || [];
      const fmt = a.outputFormat || 'png';
      const common = { model: a.model, prompt: a.prompt, size: a.size, quality: a.quality, complexity: a.complexity, output_format: fmt, moderation: a.moderation };
      let init; let path;
      if (refs.length || a.markup) {
        path = '/images/edits';
        const form = new FormData();
        for (const [k, v] of Object.entries(common)) if (v != null) form.append(k, String(v));
        for (const r of refs) form.append('image[]', new Blob([r.bytes], { type: r.mime }), r.filename);
        if (a.markup) form.append('markup', new Blob([a.markup.bytes], { type: a.markup.mime }), a.markup.filename);
        init = { method: 'POST', body: form };
      } else {
        path = '/images/generations';
        const o = {};
        for (const [k, v] of Object.entries(common)) if (v != null) o[k] = v;
        init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) };
      }
      const { body, requestId } = await call(path, init, a.signal);
      const item = body.data?.[0];
      if (!item?.b64_json) throw new ProviderError({ code: 'PROVIDER_BAD_RESPONSE', message: 'Provider returned no image', retryable: false, providerCalled: true, requestId });
      const m = /^(\d+)x(\d+)$/.exec(body.size || '');
      const outFmt = body.output_format || fmt;
      return {
        bytes: Buffer.from(item.b64_json, 'base64'),
        mime: outFmt === 'jpeg' || outFmt === 'jpg' ? 'image/jpeg' : `image/${outFmt}`,
        width: m ? Number(m[1]) : null, height: m ? Number(m[2]) : null,
        usage: body.usage || null, requestId, revisedPrompt: item.revised_prompt || null,
      };
    },

    /**
     * Identify equipment in a photo via the Responses API with strict JSON-schema output.
     * @param {{model:string, imageBytes:Buffer, mime:string, candidates:{equipmentId:string, name:string}[], signal?:AbortSignal}} a
     */
    async recognize(a) {
      const list = a.candidates.map(c => `${c.equipmentId}: ${c.name}`).join('\n');
      const text = 'List every distinct piece of fire-apparatus equipment visible in the photo. region is a bounding box as '
        + 'fractions 0-1 of the image (x, y = top-left, w, h = size) or null if unsure. quantity = how many of that item are visible. '
        + 'For each object give up to 3 candidates chosen ONLY from the catalogue below (equipmentId exactly as written) with confidence 0-1; '
        + `use an empty candidates list when nothing matches.\nCatalogue:\n${list}`;
      const { parsed, usage, requestId } = await structured(a, text, 'equipment_recognition', RECOGNITION_SCHEMA);
      const known = new Map(a.candidates.map(c => [c.equipmentId, c.name]));
      const objects = (parsed.objects || []).slice(0, 100).map(o => ({
        label: String(o.label || '').slice(0, 200),
        quantity: Math.max(1, Math.min(999, Math.trunc(Number(o.quantity)) || 1)),
        region: o.region ? { x: clamp01(o.region.x), y: clamp01(o.region.y), w: clamp01(o.region.w), h: clamp01(o.region.h) } : null,
        candidates: (o.candidates || []).filter(c => known.has(c.equipmentId)).slice(0, 3)
          .map(c => ({ equipmentId: c.equipmentId, name: known.get(c.equipmentId), confidence: clamp01(c.confidence) })),
      }));
      return { objects, usage, requestId };
    },

    /**
     * Compare a render against its scene spec (non-authoritative).
     * @param {{model:string, imageBytes:Buffer, mime:string, spec:object, signal?:AbortSignal}} a
     */
    async verify(a) {
      const items = [...(a.spec?.equipment || []), ...(a.spec?.mounts || [])].map(e => `- ${e.name || e.label || e.id}${e.quantity ? ` x${e.quantity}` : ''}`).join('\n').slice(0, 6000);
      const text = `Check this planning image against the required item list. missing = required items not visible; extra = visible equipment not in the list; confidence 0-1.\nRequired:\n${items}`;
      const { parsed, usage, requestId } = await structured(a, text, 'render_verification', VERIFY_SCHEMA);
      return { missing: (parsed.missing || []).map(String).slice(0, 100), extra: (parsed.extra || []).map(String).slice(0, 100),
        notes: String(parsed.notes || '').slice(0, 1000), confidence: clamp01(parsed.confidence), usage, requestId };
    },
  };

  async function structured(a, text, name, schema) {
    const dataUrl = `data:${a.mime};base64,${a.imageBytes.toString('base64')}`;
    const req = {
      model: a.model, store: false, max_output_tokens: 4000,
      input: [{ role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: dataUrl, detail: 'high' }] }],
      text: { format: { type: 'json_schema', name, schema, strict: true } },
    };
    const { body, requestId } = await call('/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) }, a.signal);
    if (body.status === 'incomplete') throw new ProviderError({ code: 'PROVIDER_INCOMPLETE', message: `Provider output was cut off (${body.incomplete_details?.reason || 'unknown'})`, retryable: false, providerCalled: true, requestId });
    const parts = (body.output || []).filter(o => o.type === 'message').flatMap(o => o.content || []);
    if (parts.some(p => p.type === 'refusal')) throw new ProviderError({ code: 'MODERATION_BLOCKED', message: 'The model declined to analyse this image.', retryable: false, providerCalled: true, requestId });
    const out = parts.find(p => p.type === 'output_text');
    let parsed;
    try { parsed = JSON.parse(out?.text ?? ''); } catch { parsed = null; }
    if (!parsed || typeof parsed !== 'object') throw new ProviderError({ code: 'PROVIDER_BAD_RESPONSE', message: 'Provider returned unparseable structured output', retryable: false, providerCalled: true, requestId });
    return { parsed, usage: body.usage || null, requestId };
  }
}
