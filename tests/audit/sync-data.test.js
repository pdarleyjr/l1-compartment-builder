// Audit reproduction tests (sync-data part) for worker/index.js at c9e0d0e.
// test.fails(...) = documented defect: the body asserts the CORRECT behaviour and is
// expected to fail today. When a fix lands the test starts passing and vitest reports it,
// at which point the `.fails` marker must be removed.
import { afterEach, describe, expect, test, vi } from 'vitest';
import worker from '../../worker/index.js';

const ORIGIN = 'http://127.0.0.1:4173';
const COMPS = ['CabRearZone', 'LS1', 'LS2', 'LS3', 'LS4', 'RS1', 'RS2', 'RS3', 'RS4', 'RS5', 'RR1'];

function makeEnv() {
  const store = new Map();
  const writes = [];
  return {
    store,
    writes,
    L1_STATE: {
      async get(key) { return store.has(key) ? store.get(key) : null; },
      async put(key, value) { writes.push({ key, bytes: Buffer.byteLength(value) }); store.set(key, value); },
    },
  };
}

const call = (env, method, path, body) => worker.fetch(new Request(`https://worker.test${path}`, {
  method,
  headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
}), env);

const emptyAllocations = () => Object.fromEntries(COMPS.map(c => [c, Array(15).fill('')]));
const stateDoc = (patch = {}) => ({ allocations: emptyAllocations(), customQtys: {}, customTools: [], bundles: {}, removedItems: [], customDimensions: {}, ...patch });
const b64 = bytes => 'A'.repeat(bytes);
const photo = (uid, chars = 1000) => ({ uid, title: `Photo ${uid}`, fileName: `${uid}.jpg`, dataUrl: `data:image/jpeg;base64,${b64(chars)}` });

afterEach(() => { vi.useRealTimers(); });

describe('state document: whole-document last-write-wins', () => {
  test.fails('SD-01 a stale full-document PUT must not silently erase another device\'s edit', async () => {
    const env = makeEnv();
    const base = stateDoc();
    await call(env, 'PUT', '/state', base);
    // Device A and B both loaded `base`. A edits LS1, B edits RS1, each PUTs its full copy.
    const a = stateDoc(); a.allocations.LS1[0] = 'Synthetic Tool A';
    const b = stateDoc(); b.allocations.RS1[0] = 'Synthetic Tool B';
    const ra = await call(env, 'PUT', '/state', a);
    const rb = await call(env, 'PUT', '/state', b);
    const saved = JSON.parse(env.store.get('allocations'));
    const mergedOrRejected = rb.status === 409 ||
      (saved.allocations.LS1[0] === 'Synthetic Tool A' && saved.allocations.RS1[0] === 'Synthetic Tool B');
    expect(ra.status).toBe(200);
    expect(mergedOrRejected).toBe(true); // observed: 200 and LS1[0] === '' (A's edit lost)
  });

  test('SD-01 (characterization) observed: second PUT wins and A\'s edit is gone', async () => {
    const env = makeEnv();
    const a = stateDoc(); a.allocations.LS1[0] = 'Synthetic Tool A';
    const b = stateDoc(); b.allocations.RS1[0] = 'Synthetic Tool B';
    await call(env, 'PUT', '/state', a);
    const rb = await call(env, 'PUT', '/state', b);
    const saved = JSON.parse(env.store.get('allocations'));
    expect(rb.status).toBe(200);
    expect(saved.allocations.LS1[0]).toBe('');
    expect(saved.allocations.RS1[0]).toBe('Synthetic Tool B');
  });

  test.fails('SD-14 two writes in the same millisecond receive distinct, increasing revisions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const env = makeEnv();
    const r1 = await (await call(env, 'PUT', '/state', stateDoc())).json();
    const r2 = await (await call(env, 'PUT', '/state', stateDoc())).json();
    // The client pulls only when remoteTs > lastPushTs, so equal timestamps hide the second write.
    expect(r2._serverTs).toBeGreaterThan(r1._serverTs);
  });

  test.fails('SD-11 a failing KV write returns a JSON 5xx instead of an unhandled exception', async () => {
    const env = makeEnv();
    env.L1_STATE.put = async () => { throw new Error('KV PUT failed with 429 Too Many Requests'); };
    let status = 'threw';
    try { status = (await call(env, 'PUT', '/state', stateDoc())).status; } catch { /* unhandled */ }
    expect([429, 503]).toContain(status); // observed: 'threw' (no try/catch around put at worker/index.js:~142)
  });

  test.fails('SD-15 unknown top-level fields are not persisted verbatim', async () => {
    const env = makeEnv();
    await call(env, 'PUT', '/state', { ...stateDoc(), junk: 'x'.repeat(200_000), _serverTs: 5 });
    const saved = JSON.parse(env.store.get('allocations'));
    expect(saved.junk).toBeUndefined(); // observed: 200 KB of arbitrary data stored
  });
});

describe('validation gaps (state)', () => {
  test('SD-09 (characterization) Worker accepts allocations exceeding customQtys (quantity enforcement is client-only)', async () => {
    const env = makeEnv();
    const doc = stateDoc({ customQtys: { 'Synthetic Tool A': 1 } });
    doc.allocations.LS1[0] = doc.allocations.LS2[0] = doc.allocations.RS1[0] = 'Synthetic Tool A';
    expect((await call(env, 'PUT', '/state', doc)).status).toBe(200);
  });

  test.fails('SD-13 a bundle that references an empty or out-of-range slot is rejected', async () => {
    const env = makeEnv();
    const doc = stateDoc({ bundles: { LS1: [{ id: 'b1', name: 'Kit', colorIdx: 0, slotIndices: [0, 1, 40] }] } });
    doc.allocations.LS1[0] = 'Synthetic Tool A'; // slot 1 empty, slot 40 does not exist (15 slots)
    expect((await call(env, 'PUT', '/state', doc)).status).toBe(400);
  });

  test('SD-12 (characterization) 501 rows or a 301-char name make the whole state PUT fail (client enforces neither)', async () => {
    const env = makeEnv();
    const tall = stateDoc(); tall.allocations.LS1 = Array(501).fill('');
    expect((await call(env, 'PUT', '/state', tall)).status).toBe(400);
    const longName = stateDoc(); longName.customTools = [{ name: 'N'.repeat(301), qty: 1 }];
    expect((await call(env, 'PUT', '/state', longName)).status).toBe(400);
  });
});

describe('images document', () => {
  const imageDoc = (uploadedImages, featuredImages = {}) => ({ uploadedImages, featuredImages });

  test.fails('SD-10 duplicate image uid inside one compartment is rejected', async () => {
    const env = makeEnv();
    const res = await call(env, 'PUT', '/images', imageDoc({ LS1: [photo('dup'), photo('dup')] }));
    expect(res.status).toBe(400);
  });

  test.fails('SD-10 a featured upload that points at a non-existent uid is rejected', async () => {
    const env = makeEnv();
    const res = await call(env, 'PUT', '/images', imageDoc({ LS1: [photo('x1')] }, { LS1: { kind: 'uploaded', uid: 'gone' } }));
    expect(res.status).toBe(400);
  });

  test('SD-12 (characterization) a 301-char fileName/title rejects the entire images document', async () => {
    const env = makeEnv();
    const bad = { ...photo('x1'), fileName: 'f'.repeat(301) };
    expect((await call(env, 'PUT', '/images', imageDoc({ LS1: [photo('x0'), bad] }))).status).toBe(400);
  });

  test('SD-05 (measurement) one new photo makes the client resend the entire document', async () => {
    const env = makeEnv();
    // Production-shaped: 11 compartments, ~2.9 MB of base64 total.
    const uploaded = Object.fromEntries(COMPS.map(c => [c, [photo(`${c}-1`, 130_000), photo(`${c}-2`, 130_000)]]));
    const before = JSON.stringify(imageDoc(uploaded));
    expect((await call(env, 'PUT', '/images', before)).status).toBe(200);
    uploaded.LS1.push(photo('LS1-new', 300_000));
    const after = JSON.stringify(imageDoc(uploaded));
    await call(env, 'PUT', '/images', after);
    const delta = 300_000;
    const bytesOnWire = Buffer.byteLength(after);
    console.log(`SD-05 doc before=${Buffer.byteLength(before)} B, new photo=${delta} B, bytes PUT for that one photo=${bytesOnWire} B (${(bytesOnWire / delta).toFixed(1)}x)`);
    expect(bytesOnWire / delta).toBeGreaterThan(8);
    expect(env.writes.filter(w => w.key === 'images')).toHaveLength(2); // one full KV value rewrite per change
  });

  test('SD-05 (limits) Worker caps the document at 12 MB (below the 25 MiB KV value limit) but above the ~5M-char browser localStorage quota', async () => {
    const env = makeEnv();
    const make = n => JSON.stringify(imageDoc({ LS1: Array.from({ length: n }, (_, i) => photo(`p${i}`, 1_000_000)) }));
    const ok = make(11); // ~11.0 MB
    expect(ok.length).toBeGreaterThan(5_000_000); // cannot be mirrored into localStorage (see e2e SD-05)
    expect((await call(env, 'PUT', '/images', ok)).status).toBe(200);
    expect((await call(env, 'PUT', '/images', make(13))).status).toBe(413);
  });
});
