import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/api.js', () => ({
  api: vi.fn(),
  newKey: (p = 'k') => `${p}_${Math.random().toString(16).slice(2, 14)}`,
}));
const { api } = await import('../../src/lib/api.js');
const jobs = await import('../../src/lib/jobs.js');

function memStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
}
function fakeDocument() {
  const listeners = {};
  return {
    visibilityState: 'visible',
    addEventListener: (t, f) => { (listeners[t] ??= new Set()).add(f); },
    removeEventListener: (t, f) => listeners[t]?.delete(f),
    emit(t) { listeners[t]?.forEach(f => f()); },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  globalThis.localStorage = memStorage();
  globalThis.document = fakeDocument();
  api.mockReset();
});
afterEach(() => { vi.useRealTimers(); delete globalThis.document; delete globalThis.localStorage; });

describe('status text', () => {
  it('maps every job state', () => {
    expect(jobs.jobStatusText({ status: 'queued' })).toBe('Waiting for the image worker…');
    expect(jobs.jobStatusText({ status: 'claimed' })).toBe('Waiting for the image worker…');
    expect(jobs.jobStatusText({ status: 'preparing' })).toBe('Preparing photos…');
    expect(jobs.jobStatusText({ status: 'generating' })).toBe('Generating image (can take up to 2 minutes)…');
    expect(jobs.jobStatusText({ status: 'saving' })).toBe('Saving…');
    expect(jobs.jobStatusText({ status: 'completed' })).toMatch(/ready/);
    expect(jobs.jobStatusText({ status: 'cancelled' })).toBe('Cancelled.');
  });
  it('shows the server error message for failures', () => {
    expect(jobs.jobStatusText({ status: 'failed', errorMessage: 'Moderation blocked it' })).toContain('Moderation blocked it');
    expect(jobs.jobStatusText({ status: 'failed' })).toBe('Generation failed.');
  });
  it('knows active vs terminal', () => {
    expect(jobs.isActiveJob({ status: 'generating' })).toBe(true);
    expect(jobs.isActiveJob({ status: 'completed' })).toBe(false);
    expect(jobs.isActiveJob(null)).toBe(false);
  });
});

describe('poller', () => {
  it('backs off 2s → 10s while unchanged and resets on change', async () => {
    let n = 0; const results = [];
    const p = jobs.createPoller({ fetchOnce: async () => ({ status: n++ < 4 ? 'queued' : 'generating' }), onResult: v => results.push(v.status) });
    p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(results.length).toBe(1);
    expect(p.delay).toBe(2000);
    await vi.advanceTimersByTimeAsync(2000); // same → delay grows
    expect(p.delay).toBe(3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(p.delay).toBe(4500);
    await vi.advanceTimersByTimeAsync(4500);
    await vi.advanceTimersByTimeAsync(6750);
    expect(results.at(-1)).toBe('generating'); // changed → reset
    expect(p.delay).toBe(2000);
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(10000);
    expect(p.delay).toBe(10000);
    p.stop();
  });

  it('stops when shouldStop says so', async () => {
    const fetchOnce = vi.fn(async () => ({ status: 'completed' }));
    const p = jobs.createPoller({ fetchOnce, onResult: () => {}, shouldStop: v => v.status === 'completed' });
    p.start(); await vi.advanceTimersByTimeAsync(60000);
    expect(fetchOnce).toHaveBeenCalledTimes(1);
  });

  it('pauses while hidden and resumes immediately on visibility', async () => {
    const fetchOnce = vi.fn(async () => ({ s: 1 }));
    const p = jobs.createPoller({ fetchOnce, onResult: () => {} });
    p.start(); await vi.advanceTimersByTimeAsync(0);
    expect(fetchOnce).toHaveBeenCalledTimes(1);
    document.visibilityState = 'hidden'; document.emit('visibilitychange');
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchOnce).toHaveBeenCalledTimes(1);
    document.visibilityState = 'visible'; document.emit('visibilitychange');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchOnce).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it('backs off on errors and reports them', async () => {
    const onError = vi.fn();
    const p = jobs.createPoller({ fetchOnce: async () => { throw new Error('offline'); }, onResult: () => {}, onError });
    p.start(); await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(p.delay).toBe(3000);
    p.stop();
  });
});

describe('persistence', () => {
  it('remembers recent job ids per compartment, newest first, capped', () => {
    for (let i = 0; i < 12; i++) jobs.rememberJob('LS1', `gj_${i}`);
    jobs.rememberJob('LS1', 'gj_5');
    const ids = jobs.recallJobs('LS1');
    expect(ids[0]).toBe('gj_5');
    expect(ids).toHaveLength(10);
    expect(jobs.recallJobs('LS2')).toEqual([]);
    jobs.forgetJob('LS1', 'gj_5');
    expect(jobs.recallJobs('LS1')).not.toContain('gj_5');
  });
  it('createJob stores the returned job id', async () => {
    api.mockResolvedValue({ job: { id: 'gj_a' }, estimate: { usd: 0.1 } });
    await jobs.createJob('RS2', { kind: 'render', preset: 'preview' }, 'key1');
    expect(jobs.recallJobs('RS2')).toEqual(['gj_a']);
  });
});

describe('idempotency keys', () => {
  it('reuses the key for the same request (double submit) and changes it for a different one', () => {
    const body = { kind: 'render', mode: 'plan', preset: 'high' };
    const k1 = jobs.attemptKey('LS1', body);
    expect(jobs.attemptKey('LS1', { preset: 'high', mode: 'plan', kind: 'render' })).toBe(k1);
    expect(jobs.attemptKey('LS1', { ...body, preset: 'max' })).not.toBe(k1);
    expect(jobs.attemptKey('LS2', body)).not.toBe(k1);
  });
  it('double submit sends the same Idempotency-Key; success clears it', async () => {
    api.mockResolvedValue({ job: { id: 'gj_x' } });
    const body = { kind: 'render', mode: 'plan', preset: 'preview' };
    await Promise.all([jobs.createJob('LS1', body), jobs.createJob('LS1', body)]);
    const keys = api.mock.calls.map(c => c[1].idempotencyKey);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
    expect(jobs.attemptKey('LS1', body)).not.toBe(keys[0]); // cleared after success → next attempt is new
  });
});
