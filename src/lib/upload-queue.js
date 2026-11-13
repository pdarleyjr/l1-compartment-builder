// Durable photo upload queue (IndexedDB via idb-keyval). Captured photos survive reload, tab kill and offline.
// States: queued → creating → uploading(variant, progress) → committing → done | failed(retryable) | cancelled.
// POST /api/assets → PUT original/display/thumb (XHR, progress) → POST /api/assets/:id/commit. An item never commits
// unless all three variants uploaded. See docs/architecture/ai-compartment-studio.md §6.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createStore, del, get, keys as idbKeys, set } from 'idb-keyval';
import { ASSET_VARIANTS } from '../../shared/contracts.js';
import { ApiError, AuthRequiredError, NetworkError, api, newKey } from './api.js';

/** @typedef {'queued'|'creating'|'uploading'|'committing'|'done'|'failed'|'cancelled'} QueueState */
/** @typedef {{blob:Blob,width:number,height:number,bytes:number,sha256:string}} StoredVariant */
/** @typedef {{compId:string, category:string, title?:string, notes?:string, variants:{original:StoredVariant,display:StoredVariant,thumb:StoredVariant},
 *   links?:object[], plannerOps?:object[], baseRevision?:number, label?:string}} EnqueueSpec */

export const QUEUE_DEFAULTS = Object.freeze({ maxAttempts: 6, baseDelayMs: 1000, maxDelayMs: 60_000 });
const KEY_PREFIX = 'l1q:';
const IN_FLIGHT = new Set(['creating', 'uploading', 'committing']);

/** Exponential backoff with jitter (50–100 % of the capped exponential delay). */
export function backoffDelay(attempt, random = Math.random, o = QUEUE_DEFAULTS) {
  const cap = Math.min(o.maxDelayMs, o.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(cap * (0.5 + random() * 0.5));
}

/** Throws unless every variant has been uploaded (an item must never commit links with a missing variant). */
export function assertAllUploaded(item) {
  const missing = ASSET_VARIANTS.filter(v => !item.uploaded?.[v]);
  if (missing.length) throw new Error(`Cannot commit: not uploaded yet (${missing.join(', ')}).`);
}

/** @returns {Promise<{status:number, url?:string}>} PUT bytes with progress (same-origin, credentials). Rejects NetworkError/AbortError. */
export function xhrPut(url, blob, { onProgress, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded, e.total); };
    xhr.onload = () => resolve({ status: xhr.status, url: xhr.responseURL });
    xhr.onerror = () => reject(new NetworkError());
    xhr.ontimeout = () => reject(new NetworkError());
    xhr.onabort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal) {
      if (signal.aborted) { xhr.abort(); return; }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(blob);
  });
}

const idbStore = () => createStore('l1-studio-uploads', 'queue');

/** Durable queue. Dependencies are injectable for tests. */
export class UploadQueue {
  /** @param {{store?:{get:Function,set:Function,del:Function,keys:Function}, api?:Function, put?:Function, probeAuth?:()=>Promise<boolean>,
   *   isOnline?:()=>boolean, now?:()=>number, random?:()=>number, setTimer?:Function, clearTimer?:Function, options?:object, newId?:()=>string}} [deps] */
  constructor(deps = {}) {
    this.deps = deps;
    this.api = deps.api ?? api;
    this.put = deps.put ?? xhrPut;
    this.isOnline = deps.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? (t => clearTimeout(t));
    this.newId = deps.newId ?? (() => newKey('up'));
    this.opts = { ...QUEUE_DEFAULTS, ...(deps.options ?? {}) };
    this.probeAuth = deps.probeAuth ?? (async () => {
      try { await this.api('/session'); return false; } catch (e) { return e?.name === 'AuthRequiredError'; }
    });
    const s = deps.store;
    if (s) this.store = s;
    else { const st = idbStore(); this.store = { get: k => get(k, st), set: (k, v) => set(k, v, st), del: k => del(k, st), keys: () => idbKeys(st) }; }
    /** @type {Map<string, any>} */ this.items = new Map();
    /** @type {Map<string, AbortController>} */ this.controllers = new Map();
    this.listeners = new Set();
    this.committedListeners = new Set();
    this.pausedReason = null; // null | 'offline' | 'signed_out'
    this.running = false;
    this.timer = null;
    this.snapshot = [];
    this.started = null;
  }

  /** Load persisted items (resume after reload) and start processing. Safe to call repeatedly. */
  start() {
    if (!this.started) {
      this.started = (async () => {
        const all = await this.store.keys();
        for (const k of all) {
          if (typeof k !== 'string' || !k.startsWith(KEY_PREFIX)) continue;
          const item = await this.store.get(k);
          if (!item || item.state === 'cancelled' || item.state === 'done') { await this.store.del(k); continue; }
          if (IN_FLIGHT.has(item.state)) item.state = 'queued';
          this.items.set(item.id, item);
        }
        this.emit();
      })();
    }
    return this.started.then(() => this.kick());
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  /** @param {(item:object)=>void} fn called once per item that committed during this session */
  onCommitted(fn) { this.committedListeners.add(fn); return () => this.committedListeners.delete(fn); }
  getSnapshot() { return this.snapshot; }

  emit() {
    this.snapshot = Array.from(this.items.values()).sort((a, b) => a.createdAt - b.createdAt).map(publicView);
    for (const l of this.listeners) l();
  }

  async persist(item) {
    if (item.state === 'done' || item.state === 'cancelled') await this.store.del(KEY_PREFIX + item.id);
    else await this.store.set(KEY_PREFIX + item.id, item);
  }

  async update(item, patch, { persist = true } = {}) {
    if (item.cancelRequested && patch.state && patch.state !== 'cancelled') return; // a late step must not revive a cancelled item
    Object.assign(item, patch);
    if (persist) await this.persist(item);
    this.emit();
  }

  /** @param {EnqueueSpec} spec @returns {Promise<string>} queue item id */
  async enqueue(spec) {
    const { original, display, thumb } = spec.variants;
    const item = {
      id: this.newId(), compId: spec.compId, category: spec.category, title: spec.title ?? null, notes: spec.notes ?? null,
      label: spec.label ?? null, createdAt: this.now(), state: 'queued', waiting: null, attempts: 0, nextAttemptAt: 0,
      error: null, retryable: false, assetId: null, upload: null, uploaded: {}, progress: null, recreated: 0,
      idempotencyKey: newKey('asset'), width: original.width, height: original.height, bytes: original.bytes, sha256: original.sha256,
      links: spec.links ?? [], plannerOps: spec.plannerOps ?? [], baseRevision: spec.baseRevision,
      variants: { original, display, thumb }, asset: null,
    };
    this.items.set(item.id, item);
    await this.persist(item);
    this.emit();
    this.kick();
    return item.id;
  }

  /** Manual retry of a failed item (also clears a stale backoff). */
  async retry(id) {
    const item = this.items.get(id);
    if (!item || (item.state !== 'failed' && item.state !== 'queued')) return;
    await this.update(item, { state: 'queued', waiting: null, error: null, attempts: 0, nextAttemptAt: 0, retryable: false });
    this.kick();
  }

  /** Cancel an item; aborts an in-flight request, drops stored blobs, best-effort deletes a pending server asset. */
  async cancel(id) {
    const item = this.items.get(id);
    if (!item || item.state === 'done' || item.state === 'cancelled') return;
    item.cancelRequested = true;
    this.controllers.get(id)?.abort();
    const assetId = item.assetId;
    await this.update(item, { state: 'cancelled', waiting: null, progress: null, variants: null });
    if (assetId) this.api(`/assets/${assetId}`, { method: 'DELETE' }).catch(() => {});
  }

  /** Remove a finished/failed/cancelled item from the list (and storage). */
  async remove(id) {
    const item = this.items.get(id);
    if (!item) return;
    if (!['done', 'failed', 'cancelled'].includes(item.state)) await this.cancel(id);
    this.items.delete(id);
    await this.store.del(KEY_PREFIX + id);
    this.emit();
  }

  /** Resume after offline / signed-out pause (called on 'online', after sign-in, and by the UI). */
  resume() {
    this.pausedReason = null;
    for (const it of this.items.values()) if (it.state === 'queued' && it.waiting !== 'backoff') it.waiting = null;
    this.emit();
    this.kick();
  }

  /** Browser wiring: resume on 'online', pause on 'offline'. @returns {()=>void} detach */
  attach(win = window) {
    const on = () => this.resume();
    const off = () => { this.pausedReason = 'offline'; this.emit(); };
    win.addEventListener('online', on);
    win.addEventListener('offline', off);
    return () => { win.removeEventListener('online', on); win.removeEventListener('offline', off); };
  }

  kick() {
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    if (this.running) return this.runPromise;
    this.running = true;
    this.runPromise = this.loop().finally(() => { this.running = false; });
    return this.runPromise;
  }

  async loop() {
    for (;;) {
      if (this.pausedReason === 'signed_out') return;
      if (!this.isOnline()) {
        this.pausedReason = 'offline';
        this.emit();
        return;
      }
      if (this.pausedReason === 'offline') { this.pausedReason = null; this.emit(); }
      const queued = Array.from(this.items.values()).filter(i => i.state === 'queued').sort((a, b) => a.createdAt - b.createdAt);
      if (!queued.length) return;
      const ready = queued.find(i => i.nextAttemptAt <= this.now());
      if (!ready) {
        const next = Math.min(...queued.map(i => i.nextAttemptAt));
        this.timer = this.setTimer(() => { this.timer = null; this.kick(); }, Math.max(0, next - this.now()));
        return;
      }
      await this.process(ready);
    }
  }

  async process(item) {
    const ctrl = new AbortController();
    this.controllers.set(item.id, ctrl);
    try {
      await this.run(item, ctrl.signal);
    } catch (err) {
      await this.handleError(item, err);
    } finally {
      this.controllers.delete(item.id);
    }
  }

  async run(item, signal) {
    if (!item.assetId) {
      await this.update(item, { state: 'creating', waiting: null, error: null });
      const res = await this.api('/assets', {
        method: 'POST', signal, idempotencyKey: item.idempotencyKey,
        json: { compartmentId: item.compId, category: item.category, title: item.title ?? undefined, notes: item.notes ?? undefined,
          width: item.width, height: item.height, bytes: item.bytes, sha256: item.sha256, idempotencyKey: item.idempotencyKey },
      });
      await this.update(item, { assetId: res.asset.id, upload: res.upload, uploaded: {} });
    }
    for (const variant of ASSET_VARIANTS) {
      if (item.uploaded[variant]) continue;
      if (item.cancelRequested) return;
      const blob = item.variants[variant].blob;
      await this.update(item, { state: 'uploading', progress: { variant, loaded: 0, total: blob.size } }, { persist: false });
      const r = await this.put(item.upload[variant], blob, {
        signal,
        onProgress: (loaded, total) => { item.progress = { variant, loaded, total }; this.emit(); },
      });
      if (/cloudflareaccess\.com|\/auth\/login/.test(r.url ?? '')) throw new AuthRequiredError();
      if (r.status === 401) throw new AuthRequiredError();
      if (r.status < 200 || r.status >= 300) throw new ApiError(r.status, null, `Upload failed (${r.status}).`);
      await this.update(item, { uploaded: { ...item.uploaded, [variant]: true }, progress: null });
    }
    assertAllUploaded(item);
    await this.update(item, { state: 'committing', progress: null });
    const body = {};
    if (item.links.length) body.links = item.links;
    if (item.plannerOps.length) { body.plannerOps = item.plannerOps; body.baseRevision = item.baseRevision; }
    const res = await this.api(`/assets/${item.assetId}/commit`, { method: 'POST', json: body, signal });
    await this.update(item, { state: 'done', asset: res.asset, plannerRevision: res.plannerRevision ?? null, conflicts: res.conflicts ?? null, variants: null, waiting: null, error: null });
    for (const l of this.committedListeners) l(publicView(item));
  }

  async handleError(item, err) {
    if (item.cancelRequested || item.state === 'cancelled') return;
    if (err?.name === 'AbortError') { await this.update(item, { state: 'queued' }); return; }
    if (err?.name === 'AuthRequiredError') return this.pauseSignedOut(item);
    if (err?.name === 'NetworkError') {
      if (!this.isOnline()) return this.pauseOffline(item);
      if (await this.probeAuth()) return this.pauseSignedOut(item);
      return this.backoff(item, err.message);
    }
    if (err instanceof ApiError) {
      if (err.status === 404 && item.assetId && item.recreated < 1) {
        // The pending asset expired or was garbage-collected: start over once with a fresh idempotency key.
        await this.update(item, { assetId: null, upload: null, uploaded: {}, recreated: item.recreated + 1, state: 'queued', idempotencyKey: newKey('asset') });
        return;
      }
      if (err.status === 408 || err.status === 429 || err.status >= 500) return this.backoff(item, err.message);
      const message = err.status === 409 && item.state === 'committing'
        ? 'The planner changed while uploading, so the links were not saved. Open the photo and link tools again.'
        : err.message;
      await this.update(item, { state: 'failed', retryable: false, error: message, waiting: null, progress: null });
      return;
    }
    await this.update(item, { state: 'failed', retryable: true, error: err?.message || 'Upload failed.', waiting: null, progress: null });
  }

  async pauseSignedOut(item) {
    this.pausedReason = 'signed_out';
    await this.update(item, { state: 'queued', waiting: 'signed_out', progress: null, error: 'Signed out — sign in to continue. Your photos are kept on this device.' });
  }

  async pauseOffline(item) {
    this.pausedReason = 'offline';
    await this.update(item, { state: 'queued', waiting: 'offline', progress: null, error: null });
  }

  async backoff(item, message) {
    const attempts = item.attempts + 1;
    if (attempts >= this.opts.maxAttempts) {
      await this.update(item, { state: 'failed', retryable: true, attempts, error: message || 'Upload failed.', waiting: null, progress: null });
      return;
    }
    const delay = backoffDelay(attempts, this.random, this.opts);
    await this.update(item, { state: 'queued', attempts, waiting: 'backoff', nextAttemptAt: this.now() + delay, error: message, progress: null });
  }
}

/** Strip blobs/internal fields for subscribers; keeps the thumb blob reference for previews. */
function publicView(i) {
  return {
    id: i.id, compId: i.compId, category: i.category, title: i.title, label: i.label, state: i.state, waiting: i.waiting,
    attempts: i.attempts, error: i.error, retryable: i.retryable, progress: i.progress, assetId: i.assetId, asset: i.asset,
    uploaded: { ...i.uploaded }, thumbBlob: i.variants?.thumb?.blob ?? null, plannerRevision: i.plannerRevision ?? null,
    conflicts: i.conflicts ?? null, createdAt: i.createdAt, links: i.links, bytes: i.bytes,
  };
}

let shared = null;
/** Process-wide queue (IndexedDB-backed, started and wired to online/offline events on first use). */
export function getUploadQueue() {
  if (!shared) {
    shared = new UploadQueue();
    if (typeof window !== 'undefined') shared.attach(window);
    shared.start();
  }
  return shared;
}

/**
 * React hook over the shared queue, filtered to one compartment.
 * @param {string} compId
 * @param {{onCommitted?:(item:object)=>void}} [opts]
 */
export function useUploadQueue(compId, opts = {}) {
  const q = getUploadQueue();
  const all = useSyncExternalStore(fn => q.subscribe(fn), () => q.getSnapshot(), () => []);
  const { onCommitted } = opts;
  useEffect(() => (onCommitted ? q.onCommitted(it => { if (it.compId === compId) onCommitted(it); }) : undefined), [q, compId, onCommitted]);
  const items = useMemo(() => all.filter(i => i.compId === compId), [all, compId]);
  return useMemo(() => ({
    items,
    paused: q.pausedReason,
    enqueue: spec => q.enqueue({ ...spec, compId }),
    cancel: id => q.cancel(id),
    retry: id => q.retry(id),
    remove: id => q.remove(id),
    resume: () => q.resume(),
    clearFinished: () => Promise.all(items.filter(i => ['done', 'cancelled'].includes(i.state)).map(i => q.remove(i.id))),
  }), [q, compId, items, all]);
}
