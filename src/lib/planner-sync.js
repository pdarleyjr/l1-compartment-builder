// Revisioned planner sync (docs/architecture/ai-compartment-studio.md §4). The server owns the planner document;
// the browser keeps the last server document as its base, turns every local change into ops (diffDocs), queues them
// durably in localStorage and POSTs them with retry/backoff. Pulls never clobber unsent local edits.
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { api, newKey, ApiError, AuthRequiredError, NetworkError } from './api.js';
import { applyOps, diffDocs, projectV1 } from '../../shared/planner.js';
import { COMPARTMENTS, COMP_LABEL, CONSOLIDATION_RENAMES, SLOTS_PER_COMPARTMENT, V3_RENAMES } from '../../shared/apparatus.js';

/** localStorage key of the offline copy: {v, doc, revision, migrated, queue}. Replaces the old v4 mirror. */
export const CACHE_KEY = 'l1-planner-sync-v5';
const LEGACY_KEYS = { state: 'l1-compartment-builder-v4', removed: 'l1-compartment-builder-removed', cdims: 'l1-compartment-builder-cdims' };
const PULL_MS = 5000;
const FLUSH_MS = 300;
const MAX_OPS_PER_ENTRY = 150;
/** HTTP statuses that mean "this batch itself is invalid" (retrying cannot help): it is dropped with a notice. */
const REJECTED = new Set([400, 413, 415, 422]);

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v : '');

/** Empty v1 view (every compartment seeded with empty slots). */
export function emptyView() {
  const allocations = {};
  COMPARTMENTS.forEach(c => { allocations[c.id] = Array(SLOTS_PER_COMPARTMENT).fill(''); });
  return { allocations, customQtys: {}, customTools: [], bundles: {}, removedItems: [], customDimensions: {} };
}

/**
 * Coerce an untrusted v1 view (server document, cached copy, legacy mirror) into the exact shapes the UI renders,
 * so a malformed shared document can never blank the app (FM-20). Old item names are mapped through the rename tables.
 * @param {any} raw
 */
export function sanitizeView(raw) {
  const out = emptyView();
  if (!isObj(raw)) return out;
  if (isObj(raw.allocations)) {
    for (const c of COMPARTMENTS) {
      const slots = raw.allocations[c.id];
      if (!Array.isArray(slots)) continue;
      out.allocations[c.id] = slots.map(v => {
        const s = str(v);
        const renamed = V3_RENAMES[s] ?? s;
        return CONSOLIDATION_RENAMES[renamed] ?? renamed;
      });
    }
  }
  if (isObj(raw.customQtys)) for (const [k, v] of Object.entries(raw.customQtys)) if (Number.isFinite(v)) out.customQtys[k] = v;
  if (Array.isArray(raw.customTools)) {
    out.customTools = raw.customTools.filter(t => isObj(t) && str(t.name)).map(t => ({
      name: t.name, qty: Number.isFinite(t.qty) ? t.qty : 1, dimensions: str(t.dimensions),
    }));
  }
  if (isObj(raw.customDimensions)) for (const [k, v] of Object.entries(raw.customDimensions)) if (typeof v === 'string') out.customDimensions[k] = v;
  if (Array.isArray(raw.removedItems)) out.removedItems = [...new Set(raw.removedItems.filter(v => typeof v === 'string'))];
  if (isObj(raw.bundles)) {
    for (const [comp, list] of Object.entries(raw.bundles)) {
      if (!Array.isArray(list)) continue;
      out.bundles[comp] = list.filter(b => isObj(b) && Array.isArray(b.slotIndices)).map(b => ({
        id: str(b.id) || `b_${Math.random().toString(36).slice(2, 9)}`, name: str(b.name) || 'Bundle',
        colorIdx: Number.isInteger(b.colorIdx) ? b.colorIdx : 0,
        slotIndices: b.slotIndices.filter(i => Number.isInteger(i) && i >= 0),
      }));
    }
  }
  return out;
}

/** First-paint only: the pre-API localStorage mirror. Never written again. */
function readLegacyView() {
  try {
    const raw = localStorage.getItem(LEGACY_KEYS.state);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!isObj(saved?.allocations)) return null;
    const parse = (k, fb) => { try { return JSON.parse(localStorage.getItem(k) ?? 'null') ?? fb; } catch { return fb; } };
    return sanitizeView({ ...saved, removedItems: parse(LEGACY_KEYS.removed, []), customDimensions: parse(LEGACY_KEYS.cdims, {}) });
  } catch { return null; }
}

function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    if (c?.v === 1 && isObj(c.doc) && Number.isInteger(c.revision)) return c;
  } catch { /* corrupt cache: ignore */ }
  return null;
}

const queueOps = queue => queue.flatMap(e => e.ops);
const readDoc = doc => sanitizeView(projectV1(doc));

/** Human sentence for a conflict returned by POST /planner/ops (names the compartment/slot and what was kept). */
export function describeConflict(op, conflict) {
  const kind = op?.op ?? op?.type;
  const where = op?.comp ? `${COMP_LABEL[op.comp] ?? op.comp}${Number.isInteger(op.index) ? ` slot ${op.index + 1}` : ''}` : (op?.name ?? op?.tool?.name ?? op?.to ?? 'the plan');
  if (conflict.reason === 'QUANTITY') return `Not enough units left for ${where}${op?.value ? ` (${op.value})` : ''} — your placement was not kept.`;
  if (conflict.reason === 'NOT_FOUND') return `${where} no longer exists — your change was not kept.`;
  if (conflict.reason === 'INVALID') return `Your change to ${where} was not valid — it was not kept.`;
  const cur = typeof conflict.current === 'string' ? ` (now “${conflict.current || 'empty'}”)` : '';
  return kind === 'setSlot' || kind === 'setSlotCount'
    ? `Another device changed ${where}${cur} — kept their change.`
    : `Another device changed ${where} — kept their change.`;
}

/** @typedef {'loading'|'saved'|'saving'|'offline'|'signin'|'problem'} SyncStatus */

class PlannerEngine {
  constructor() {
    this.listeners = new Set();
    this.canEdit = false;
    this.signedOut = false;
    const cache = readCache();
    this.doc = cache?.doc ?? null;
    this.revision = cache?.revision ?? 0;
    this.migrated = cache ? cache.migrated !== false : null;
    this.queue = cache?.queue ?? [];
    this.ready = !!cache;
    this.pendingRenames = [];
    this.notices = [];
    this.flags = { offline: typeof navigator !== 'undefined' && navigator.onLine === false, authLost: false, problem: '', sending: false, loadFailed: false, storageError: false };
    this.retry = 0;
    this.timers = { flush: null, retry: null, pull: null };
    this.pulling = false;
    this.started = false;
    let view;
    if (this.doc) { try { view = readDoc(applyOps(this.doc, queueOps(this.queue), {}).doc); } catch { view = readDoc(this.doc); } }
    this.view = view ?? readLegacyView() ?? emptyView();
    this.snapshot = null;
    this.emit();
  }

  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  getSnapshot = () => this.snapshot;

  get status() {
    const f = this.flags;
    if (!this.ready) return 'loading';
    const pending = this.queue.length > 0;
    if (f.authLost || this.signedOut) return 'signin';
    if (f.offline) return 'offline';
    if (f.problem) return 'problem';
    if (f.sending || pending || this.timers.flush) return 'saving';
    return 'saved';
  }

  emit() {
    this.snapshot = {
      view: this.view, doc: this.doc, revision: this.revision, migrated: this.migrated, ready: this.ready,
      status: this.status, pending: this.queue.length, notices: this.notices, authLost: this.flags.authLost,
      problem: this.flags.problem, storageError: this.flags.storageError, offline: this.flags.offline,
    };
    this.listeners.forEach(l => l());
  }

  persist() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ v: 1, doc: this.doc, revision: this.revision, migrated: this.migrated !== false, queue: this.queue }));
      this.flags.storageError = false;
    } catch { this.flags.storageError = true; }
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.fetchRemote();
    this.timers.pull = setInterval(() => { if (document.visibilityState === 'visible') this.fetchRemote(); }, PULL_MS);
    this.onVisible = () => { if (document.visibilityState === 'visible') this.fetchRemote(); else this.flushLocal(); };
    this.onOnline = () => { this.flags.offline = false; this.retry = 0; this.emit(); this.fetchRemote(); this.kick(); };
    this.onOffline = () => { this.flags.offline = true; this.emit(); };
    this.onHide = () => this.flushLocal();
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    window.addEventListener('pagehide', this.onHide);
    this.kick();
  }

  stop() {
    this.started = false;
    clearInterval(this.timers.pull); clearTimeout(this.timers.flush); clearTimeout(this.timers.retry);
    this.timers = { flush: null, retry: null, pull: null };
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    window.removeEventListener('pagehide', this.onHide);
    this.flushLocal();
  }

  setAccess(canEdit, signedOut) {
    const was = this.canEdit;
    const v = canEdit;
    this.canEdit = v;
    this.signedOut = signedOut;
    if (v && !was) { this.flags.authLost = false; this.retry = 0; this.kick(); }
    this.emit();
  }

  /** Apply a functional update to the local view (the UI's optimistic state) and schedule op generation. */
  update(fn) {
    if (!this.canEdit || this.migrated === false) return;
    const next = fn(this.view);
    if (next === this.view) return;
    this.view = next;
    clearTimeout(this.timers.flush);
    this.timers.flush = setTimeout(() => this.flushLocal(), FLUSH_MS);
    this.emit();
  }

  /** Record that `from` was renamed to `to`, so the next diff emits renameEquipment (keeps equipment/assignment ids). */
  hintRename(from, to) {
    this.pendingRenames = [...this.pendingRenames.filter(r => r.to !== from), { from, to }];
  }

  /** Turn the unsent difference between the base (+queue) and the local view into a queue entry. */
  flushLocal() {
    clearTimeout(this.timers.flush);
    this.timers.flush = null;
    if (!this.doc) { this.pendingRenames = []; return; }
    let ops = [];
    try {
      const effective = applyOps(this.doc, queueOps(this.queue), {}).doc;
      ops = diffDocs(readDoc(effective), this.view, { renames: this.pendingRenames });
    } catch (err) {
      this.flags.problem = `Could not prepare your change (${err?.message ?? 'unknown error'}).`;
    }
    this.pendingRenames = [];
    if (ops.length) {
      const last = this.queue[this.queue.length - 1];
      if (last && !last.sent && last.ops.length + ops.length <= MAX_OPS_PER_ENTRY) last.ops = [...last.ops, ...ops];
      else this.queue.push({ clientOpId: newKey('op'), ops, sent: false });
      this.persist();
    }
    this.emit();
    if (ops.length) this.kick();
  }

  kick(fromRetry = false) {
    if (this.flags.sending || !this.queue.length || !this.canEdit || this.flags.authLost || !this.started) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (this.timers.retry && !fromRetry) return;
    this.send();
  }

  async send() {
    const entry = this.queue[0];
    entry.sent = true;
    this.flags.sending = true;
    this.emit();
    try {
      const res = await api('/planner/ops', { method: 'POST', json: { baseRevision: this.revision, clientOpId: entry.clientOpId, ops: entry.ops } });
      this.flags.sending = false; this.flags.problem = ''; this.flags.offline = false; this.retry = 0;
      this.queue = this.queue.filter(e => e !== entry);
      for (const c of res?.conflicts ?? []) {
        this.notices = [...this.notices, { id: newKey('n'), message: describeConflict(entry.ops[c.index], c) }];
      }
      if (res?.doc && Number.isInteger(res.revision) && res.revision >= this.revision) { this.doc = res.doc; this.revision = res.revision; this.migrated = true; }
      this.rebase();
    } catch (err) {
      this.flags.sending = false;
      this.handleSendError(err, entry);
    }
    this.kick();
  }

  handleSendError(err, entry) {
    if (err instanceof AuthRequiredError) { this.flags.authLost = true; this.flags.problem = ''; }
    else if (err instanceof NetworkError) { this.flags.offline = true; this.scheduleRetry(); }
    else if (err instanceof ApiError && REJECTED.has(err.status)) {
      this.queue = this.queue.filter(e => e !== entry);
      this.notices = [...this.notices, { id: newKey('n'), message: `A change could not be saved and was reverted: ${err.message}` }];
      this.flags.problem = '';
      this.rebase();
    } else if (err instanceof ApiError && err.code === 'APP_UPDATED') {
      this.flags.problem = 'A newer version of the app is available — reload to keep saving.';
    } else {
      this.flags.problem = err?.message || 'Sync problem';
      this.scheduleRetry();
      if (err instanceof ApiError) this.fetchRemote();
    }
    this.emit();
  }

  scheduleRetry() {
    this.retry += 1;
    const base = Math.min(30000, 1000 * 2 ** Math.min(this.retry, 5));
    const wait = base * (0.5 + Math.random() * 0.5);
    clearTimeout(this.timers.retry);
    this.timers.retry = setTimeout(() => { this.timers.retry = null; this.kick(true); }, wait);
  }

  /** Recompute the view as server base + every still-unsent local op (nothing local is ever overwritten). */
  rebase() {
    if (!this.doc) return;
    try { this.view = readDoc(applyOps(this.doc, queueOps(this.queue), {}).doc); } catch { this.view = readDoc(this.doc); }
    this.persist();
    this.emit();
  }

  async fetchRemote() {
    if (this.pulling) return;
    this.pulling = true;
    try {
      const res = await api(`/public/planner${this.doc && this.revision ? `?since=${this.revision}` : ''}`, { expect: 'response' });
      if (!this.queue.length) this.flags.offline = false;
      this.flags.loadFailed = false;
      if (res.status !== 304) {
        const body = await res.json();
        this.flushLocal(); // make every local edit a queued op before the base moves (SD-18)
        const doc = body?.doc;
        if (isObj(doc) && Number.isInteger(body.revision) && (!this.doc || body.revision >= this.revision)) {
          this.doc = doc; this.revision = body.revision;
        }
        this.migrated = body?.migrated !== false;
        this.rebase();
      }
      if (this.flags.problem && !this.queue.length) this.flags.problem = '';
    } catch (err) {
      this.flags.loadFailed = true;
      if (err instanceof NetworkError) this.flags.offline = true;
      else if (!(err instanceof AuthRequiredError)) this.flags.problem = this.queue.length ? this.flags.problem : '';
    } finally {
      this.pulling = false;
      this.ready = true;
      this.emit();
      this.kick();
    }
  }

  dismissNotice(id) { this.notices = this.notices.filter(n => n.id !== id); this.emit(); }
  retryNow() { clearTimeout(this.timers.retry); this.timers.retry = null; this.flags.offline = false; this.flags.problem = ''; this.retry = 0; this.emit(); this.fetchRemote(); this.kick(); }
}

/**
 * React binding for the planner sync engine.
 * @param {{canEdit:boolean, signedOut?:boolean}} opts canEdit = signed in as an editor (pauses sending and blocks local
 *   edits otherwise); signedOut = the session is known to be anonymous (status pill reads "Sign in to save")
 * @returns {{view:object, doc:object|null, revision:number, migrated:boolean|null, ready:boolean, status:SyncStatus,
 *   pending:number, notices:{id:string,message:string}[], authLost:boolean, problem:string, storageError:boolean,
 *   readOnly:boolean, update:(fn:(v:object)=>object)=>void, hintRename:(from:string,to:string)=>void,
 *   dismissNotice:(id:string)=>void, retryNow:()=>void}}
 */
export function usePlannerSync({ canEdit, signedOut = false }) {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = new PlannerEngine();
  const engine = engineRef.current;
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  useEffect(() => { engine.start(); return () => engine.stop(); }, [engine]);
  useEffect(() => { engine.setAccess(!!canEdit, !!signedOut); }, [engine, canEdit, signedOut]);
  const update = useCallback(fn => engine.update(fn), [engine]);
  const hintRename = useCallback((a, b) => engine.hintRename(a, b), [engine]);
  const dismissNotice = useCallback(id => engine.dismissNotice(id), [engine]);
  const retryNow = useCallback(() => engine.retryNow(), [engine]);
  return useMemo(() => ({
    ...snap, readOnly: !canEdit || snap.migrated === false, update, hintRename, dismissNotice, retryNow,
  }), [snap, canEdit, update, hintRename, dismissNotice, retryNow]);
}
