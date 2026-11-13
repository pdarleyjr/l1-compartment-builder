import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, AuthRequiredError, NetworkError } from '../../src/lib/api.js';
import { UploadQueue, assertAllUploaded, backoffDelay } from '../../src/lib/upload-queue.js';

function memStore(map = new Map()) {
  return { map, get: async k => map.get(k), set: async (k, v) => { map.set(k, v); }, del: async k => { map.delete(k); }, keys: async () => [...map.keys()] };
}
const variant = n => ({ blob: new Blob([new Uint8Array(n)], { type: 'image/jpeg' }), width: 100, height: 50, bytes: n, sha256: 'ab'.repeat(32) });
const spec = (extra = {}) => ({ compId: 'LS1', category: 'tool', variants: { original: variant(30), display: variant(20), thumb: variant(10) }, ...extra });

function setup({ apiImpl, putImpl, online = true, store = memStore(), random = () => 0.5 } = {}) {
  const calls = [];
  let isOnline = online;
  const api = vi.fn(async (path, opts = {}) => {
    calls.push([opts.method ?? 'GET', path, opts.json]);
    if (apiImpl) { const r = await apiImpl(path, opts, calls); if (r !== undefined) return r; }
    if (path === '/assets') return { asset: { id: 'ast_1' }, upload: { original: '/o', display: '/d', thumb: '/t' } };
    if (path.endsWith('/commit')) return { asset: { id: 'ast_1', status: 'committed' } };
    return null;
  });
  const put = vi.fn(putImpl ?? (async (url, blob, o) => { o.onProgress?.(blob.size, blob.size); return { status: 204 }; }));
  let t = 1000;
  const timers = [];
  const q = new UploadQueue({
    store, api, put, isOnline: () => isOnline, now: () => t, random,
    setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; }, clearTimer: () => {},
    probeAuth: async () => false,
  });
  return { q, api, put, calls, store, timers, setOnline: v => { isOnline = v; }, advance: ms => { t += ms; } };
}
const state = q => q.getSnapshot()[0];

describe('upload queue', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('runs create → 3 uploads → commit and reports done', async () => {
    const { q, calls, put } = setup();
    const committed = vi.fn();
    q.onCommitted(committed);
    await q.enqueue(spec());
    await q.kick();
    expect(state(q).state).toBe('done');
    expect(put.mock.calls.map(c => c[0])).toEqual(['/o', '/d', '/t']);
    expect(calls.map(c => c[1])).toEqual(['/assets', '/assets/ast_1/commit']);
    expect(committed).toHaveBeenCalledOnce();
  });

  it('sends links and planner ops only in the commit, after all variants', async () => {
    const order = [];
    const { q, calls } = setup({ putImpl: async () => { order.push('put'); return { status: 204 }; } });
    await q.enqueue(spec({ links: [{ targetType: 'equipment', targetId: 'eq_1' }], plannerOps: [{ op: 'setSlot' }], baseRevision: 7 }));
    await q.kick();
    expect(order).toEqual(['put', 'put', 'put']);
    expect(calls.at(-1)[2]).toEqual({ links: [{ targetType: 'equipment', targetId: 'eq_1' }], plannerOps: [{ op: 'setSlot' }], baseRevision: 7 });
    expect(calls[0][2]).not.toHaveProperty('links');
  });

  it('never commits when a variant upload fails', async () => {
    let n = 0;
    const { q, calls } = setup({ putImpl: async () => (++n === 2 ? { status: 400 } : { status: 204 }) });
    await q.enqueue(spec({ links: [{ targetType: 'equipment', targetId: 'eq_1' }] }));
    await q.kick();
    expect(state(q).state).toBe('failed');
    expect(calls.some(c => c[1].endsWith('/commit'))).toBe(false);
  });

  it('assertAllUploaded rejects a missing variant', () => {
    expect(() => assertAllUploaded({ uploaded: { original: true, display: true } })).toThrow(/thumb/);
    expect(() => assertAllUploaded({ uploaded: { original: true, display: true, thumb: true } })).not.toThrow();
  });

  it('retries transient failures with backoff and only re-sends missing variants', async () => {
    let fail = true;
    const { q, put, timers, advance } = setup({
      putImpl: async url => { if (url === '/d' && fail) { fail = false; throw new NetworkError(); } return { status: 204 }; },
    });
    await q.enqueue(spec());
    await q.kick();
    expect(state(q)).toMatchObject({ state: 'queued', waiting: 'backoff', attempts: 1 });
    expect(timers.at(-1).ms).toBeGreaterThan(0);
    advance(120_000);
    await q.kick();
    expect(state(q).state).toBe('done');
    expect(put.mock.calls.filter(c => c[0] === '/o')).toHaveLength(1); // original not re-uploaded
  });

  it('fails as retryable after max attempts, and manual retry restarts', async () => {
    const { q, advance, api } = setup({ apiImpl: async path => { if (path === '/assets') throw new ApiError(503, 'INTERNAL', 'down'); } });
    await q.enqueue(spec());
    for (let i = 0; i < 10 && state(q).state !== 'failed'; i += 1) { advance(120_000); await q.kick(); }
    expect(state(q)).toMatchObject({ state: 'failed', retryable: true });
    api.mockImplementation(async path => (path === '/assets' ? { asset: { id: 'ast_2' }, upload: { original: '/o', display: '/d', thumb: '/t' } } : { asset: { id: 'ast_2' } }));
    await q.retry(state(q).id);
    await q.kick();
    expect(state(q).state).toBe('done');
  });

  it('treats 4xx as non-retryable', async () => {
    const { q } = setup({ apiImpl: async path => { if (path === '/assets') throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Too big'); } });
    await q.enqueue(spec());
    await q.kick();
    expect(state(q)).toMatchObject({ state: 'failed', retryable: false, error: 'Too big' });
  });

  it('pauses while offline and resumes on resume()', async () => {
    const { q, api, setOnline } = setup({ online: false });
    await q.enqueue(spec());
    await q.kick();
    expect(q.pausedReason).toBe('offline');
    expect(api).not.toHaveBeenCalled();
    expect(state(q).state).toBe('queued');
    setOnline(true);
    q.resume();
    await q.kick();
    expect(state(q).state).toBe('done');
  });

  it('pauses on a network error when the browser reports offline', async () => {
    let online = true;
    const { q, setOnline } = setup({ apiImpl: async () => { setOnline(false); online = false; throw new NetworkError(); } });
    await q.enqueue(spec());
    await q.kick();
    expect(online).toBe(false);
    expect(state(q)).toMatchObject({ state: 'queued', waiting: 'offline' });
  });

  it('pauses signed-out on 401 and keeps the photo', async () => {
    const { q, store } = setup({ apiImpl: async path => { if (path === '/assets') throw new AuthRequiredError(); } });
    await q.enqueue(spec());
    await q.kick();
    expect(q.pausedReason).toBe('signed_out');
    expect(state(q)).toMatchObject({ state: 'queued', waiting: 'signed_out' });
    expect(store.map.size).toBe(1);
  });

  it('treats an access-login redirect on PUT as signed out', async () => {
    const { q } = setup({ putImpl: async () => ({ status: 200, url: 'https://darl.cloudflareaccess.com/login' }) });
    await q.enqueue(spec());
    await q.kick();
    expect(q.pausedReason).toBe('signed_out');
  });

  it('cancel aborts, removes persisted blobs and best-effort deletes the pending asset', async () => {
    let release;
    const { q, store, api } = setup({
      putImpl: (url, blob, { signal }) => new Promise((_, rej) => { release = () => rej(Object.assign(new Error('a'), { name: 'AbortError' })); signal.addEventListener('abort', release); }),
    });
    await q.enqueue(spec());
    const run = q.kick();
    await vi.waitFor(() => expect(state(q).state).toBe('uploading'));
    await q.cancel(state(q).id);
    await run;
    expect(state(q).state).toBe('cancelled');
    expect(store.map.size).toBe(0);
    expect(api).toHaveBeenCalledWith('/assets/ast_1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('resumes after a reload from the durable store', async () => {
    const store = memStore();
    const first = setup({ store, online: false });
    await first.q.enqueue(spec());
    // Simulate a crash mid-upload: persisted state says uploading with the original already sent.
    const key = [...store.map.keys()][0];
    store.map.set(key, { ...store.map.get(key), state: 'uploading', assetId: 'ast_1', upload: { original: '/o', display: '/d', thumb: '/t' }, uploaded: { original: true } });
    const second = setup({ store });
    await second.q.start();
    expect(second.q.getSnapshot()).toHaveLength(1);
    expect(state(second.q).state).toBe('done');
    expect(second.put.mock.calls.map(c => c[0])).toEqual(['/d', '/t']);
    expect(second.calls.some(c => c[1] === '/assets')).toBe(false);
    expect(store.map.size).toBe(0);
  });

  it('recreates the asset once when the pending asset is gone (404)', async () => {
    let first = true;
    const { q } = setup({ apiImpl: async path => { if (path.endsWith('/commit') && first) { first = false; throw new ApiError(404, 'NOT_FOUND', 'gone'); } } });
    await q.enqueue(spec());
    await q.kick();
    expect(state(q).state).toBe('done');
  });

  it('backoff delay grows, is capped and jittered', () => {
    expect(backoffDelay(1, () => 1)).toBe(1000);
    expect(backoffDelay(1, () => 0)).toBe(500);
    expect(backoffDelay(3, () => 1)).toBe(4000);
    expect(backoffDelay(20, () => 1)).toBe(60_000);
  });
});
