// Generation jobs, versions and estimate client for the AI Compartment Studio (part B2).
// Pure helpers (poller, status text, idempotency keys, job memory) are exported separately so they can be tested in node.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, newKey } from './api.js';
import { ACTIVE_JOB_STATES } from '../../shared/contracts.js';

/** @typedef {import('../../shared/contracts.js')} Contract */

const enc = encodeURIComponent;

// ── API calls ────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Create a generation job. The idempotency key is persisted per attempt (see {@link attemptKey}) so a double tap or a
 * retry after a lost response never creates a second paid job.
 * @param {string} compId @param {object} body @param {string} [idempotencyKey]
 * @returns {Promise<{job:object, estimate:{usd:number, basis?:string}}>}
 */
export async function createJob(compId, body, idempotencyKey = attemptKey(compId, body)) {
  const res = await api(`/compartments/${enc(compId)}/jobs`, { method: 'POST', json: body, idempotencyKey });
  if (res?.job?.id) { rememberJob(compId, res.job.id); clearAttemptKey(compId, body); }
  return res;
}
/** @param {string} jobId @param {AbortSignal} [signal] @returns {Promise<object>} the job */
export async function getJob(jobId, signal) {
  return (await api(`/jobs/${enc(jobId)}`, { signal })).job;
}
/** @param {string} compId @param {AbortSignal} [signal] @returns {Promise<object[]>} */
export async function listJobs(compId, signal) {
  return (await api(`/compartments/${enc(compId)}/jobs`, { signal })).jobs;
}
/** @param {string} jobId @returns {Promise<object>} */
export async function cancelJob(jobId) {
  return (await api(`/jobs/${enc(jobId)}/cancel`, { method: 'POST', json: {} })).job;
}
/** Explicit retry; reserves budget again, so it gets its own idempotency key. @param {string} jobId */
export async function retryJob(jobId) {
  return api(`/jobs/${enc(jobId)}/retry`, { method: 'POST', json: {}, idempotencyKey: newKey('retry') });
}
/**
 * Cost estimate for a render request (POST estimate → {estimate:{usd, basis}, requiresConfirm}).
 * @returns {Promise<{usd:number, basis:string, requiresConfirm:boolean}>}
 */
export async function estimate(compId, body, signal) {
  const res = await api(`/compartments/${enc(compId)}/estimate`, { method: 'POST', json: body, signal });
  return { ...res.estimate, requiresConfirm: res.requiresConfirm === true };
}
/** @param {string} compId @returns {Promise<object[]>} ImageVersion[] */
export async function listVersions(compId, signal) {
  return (await api(`/compartments/${enc(compId)}/versions`, { signal })).versions;
}
/** Reject / soft-delete a draft. @param {string} versionId @param {{status:'rejected'|'deleted'}} patch */
export async function updateVersion(versionId, patch) {
  return (await api(`/versions/${enc(versionId)}`, { method: 'PATCH', json: patch })).version;
}

// ── Status text ──────────────────────────────────────────────────────────────────────────────────────────────────────
const STATUS_TEXT = {
  queued: 'Waiting for the image worker…',
  claimed: 'Waiting for the image worker…',
  preparing: 'Preparing photos…',
  generating: 'Generating image (can take up to 2 minutes)…',
  saving: 'Saving…',
  completed: 'Done — your draft image is ready.',
  failed: 'Generation failed.',
  cancelled: 'Cancelled.',
};
/** Human status line for a job. Terminal errors use the server message. @param {{status:string, errorMessage?:string|null}|null} job */
export function jobStatusText(job) {
  if (!job) return '';
  if (job.status === 'failed') return job.errorMessage ? `Generation failed: ${job.errorMessage}` : STATUS_TEXT.failed;
  return STATUS_TEXT[job.status] ?? 'Working…';
}
/** @param {{status:string}|null} job */
export const isActiveJob = job => !!job && ACTIVE_JOB_STATES.includes(job.status);

// ── Idempotency keys (one per distinct attempt, survives reloads) ─────────────────────────────────────────────────────
const store = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const stableStringify = v => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const keyFor = (compId, body) => `l1.studio.attempt.${compId}.${stableStringify(body)}`;
/** Same request body → same key until it succeeds or is cleared; a changed body gets a fresh key. */
export function attemptKey(compId, body) {
  const s = store(); const k = keyFor(compId, body);
  let v = null; try { v = s?.getItem(k); } catch { /* storage unavailable */ }
  if (!v) { v = newKey('gen'); try { s?.setItem(k, v); } catch { /* keep in-memory key only */ } }
  return v;
}
/** Forget the attempt key (after the job was created or the user changed their mind). */
export function clearAttemptKey(compId, body) { try { store()?.removeItem(keyFor(compId, body)); } catch { /* ignore */ } }

// ── Remembered job ids per compartment ───────────────────────────────────────────────────────────────────────────────
const jobsKey = compId => `l1.studio.jobs.${compId}`;
/** @returns {string[]} newest first */
export function recallJobs(compId) {
  try { const v = JSON.parse(store()?.getItem(jobsKey(compId)) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; }
}
/** Remember a job id so a phone that locked or left the page finds it again. */
export function rememberJob(compId, jobId) {
  const next = [jobId, ...recallJobs(compId).filter(x => x !== jobId)].slice(0, 10);
  try { store()?.setItem(jobsKey(compId), JSON.stringify(next)); } catch { /* ignore */ }
}
/** @param {string} compId @param {string} jobId */
export function forgetJob(compId, jobId) {
  try { store()?.setItem(jobsKey(compId), JSON.stringify(recallJobs(compId).filter(x => x !== jobId))); } catch { /* ignore */ }
}

// ── Poller ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Polling loop with backoff (minMs → maxMs while nothing changes), paused while the tab is hidden and resumed on
 * visibility/online. Never overlaps requests. `poke()` polls immediately.
 * @param {{fetchOnce:(signal:AbortSignal)=>Promise<any>, onResult:(v:any)=>void, onError?:(e:any)=>void,
 *   shouldStop?:(v:any)=>boolean, minMs?:number, maxMs?:number, factor?:number}} cfg
 */
export function createPoller({ fetchOnce, onResult, onError, shouldStop, minMs = 2000, maxMs = 10000, factor = 1.5 }) {
  let timer = null, running = false, inflight = false, delay = minMs, last, ctrl = null, stopped = true;
  const hidden = () => globalThis.document?.visibilityState === 'hidden';
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const schedule = () => { clear(); if (!running || hidden()) return; timer = setTimeout(tick, delay); };
  async function tick() {
    timer = null;
    if (!running || inflight || hidden()) return;
    inflight = true; ctrl = new AbortController();
    try {
      const v = await fetchOnce(ctrl.signal);
      if (!running) return;
      const sig = stableStringify(v);
      delay = sig === last ? Math.min(maxMs, Math.round(delay * factor)) : minMs;
      last = sig;
      onResult(v);
      if (shouldStop?.(v)) { running = false; return; }
    } catch (e) {
      if (!running || e?.name === 'AbortError') return;
      delay = Math.min(maxMs, Math.round(delay * factor));
      onError?.(e);
    } finally { inflight = false; }
    schedule();
  }
  const wake = () => { if (running && !hidden() && !inflight) { delay = minMs; clear(); tick(); } };
  const onVisibility = () => { if (hidden()) clear(); else wake(); };
  return {
    start() {
      if (running) return;
      running = true; stopped = false; delay = minMs; last = undefined;
      globalThis.document?.addEventListener?.('visibilitychange', onVisibility);
      globalThis.addEventListener?.('online', wake);
      if (!hidden()) tick();
    },
    stop() {
      if (stopped) return;
      running = false; stopped = true; clear(); ctrl?.abort();
      globalThis.document?.removeEventListener?.('visibilitychange', onVisibility);
      globalThis.removeEventListener?.('online', wake);
    },
    poke: wake,
    /** @returns {number} current delay in ms (for tests) */
    get delay() { return delay; },
  };
}

/** Generic polling hook: returns {data, error, refresh}. */
function usePolling(fetchOnce, deps, shouldStop) {
  const [state, setState] = useState({ data: null, error: null, loaded: false });
  const pollerRef = useRef(null);
  const fetchRef = useRef(fetchOnce); fetchRef.current = fetchOnce;
  const stopRef = useRef(shouldStop); stopRef.current = shouldStop;
  useEffect(() => {
    setState({ data: null, error: null, loaded: false });
    const p = createPoller({
      fetchOnce: s => fetchRef.current(s),
      onResult: data => setState({ data, error: null, loaded: true }),
      onError: error => setState(s => ({ ...s, error, loaded: true })),
      shouldStop: v => !!stopRef.current?.(v),
    });
    pollerRef.current = p; p.start();
    return () => p.stop();
  }, deps);
  const refresh = useCallback(() => pollerRef.current?.poke(), []);
  return { ...state, refresh };
}

/** Poll one job until it reaches a terminal state. @param {string|null} jobId @returns {{job:object|null, error:any, refresh:()=>void}} */
export function useJob(jobId) {
  const r = usePolling(jobId ? s => getJob(jobId, s) : async () => null, [jobId], j => !!j && !isActiveJob(j));
  return { job: r.data, error: r.error, refresh: r.refresh };
}

/** Poll a compartment's jobs (re-discovers jobs started earlier / on another device). */
export function useActiveJobs(compId) {
  const r = usePolling(s => listJobs(compId, s), [compId]);
  const jobs = r.data ?? [];
  return { jobs, active: jobs.filter(isActiveJob), loaded: r.loaded, error: r.error, refresh: r.refresh };
}
