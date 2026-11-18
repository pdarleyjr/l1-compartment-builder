// An edit made while an earlier save is still in flight must survive that save's response. Before the fix, send()
// rebased the view onto the server's answer without first queuing edits whose 300 ms flush timer had not fired yet,
// so a quick second edit (a second slot, a rename back, a removal) was silently dropped. The engine runs here with a
// fake clock and a fake API, so the in-flight window is reproduced exactly instead of by chance.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../src/lib/api.js';
import { PlannerEngine } from '../../src/lib/planner-sync.js';
import { applyOps, emptyDocV2 } from '../../shared/planner.js';

vi.mock('../../src/lib/api.js', async importOriginal => ({ ...(await importOriginal()), api: vi.fn() }));

const HOIST = '1 Ton Griphoist';
const FOG = '1 1/2 Fog Nozzles';
const setSlot = (v, comp, i, val) => ({ ...v, allocations: { ...v.allocations, [comp]: v.allocations[comp].map((s, j) => (j === i ? val : s)) } });

/** An engine that already holds `doc` at revision 1 and may edit (no pulls are started). */
function engineWith(doc) {
  const e = new PlannerEngine();
  Object.assign(e, { doc: structuredClone(doc), revision: 1, migrated: true, ready: true, started: true });
  e.rebase();
  e.setAccess(true, false);
  return e;
}

/** POSTs wait until the test answers them; anything else is unexpected. */
function holdPosts() {
  const answers = [];
  api.mockImplementation((path, opts) => (opts?.method === 'POST'
    ? new Promise((resolve, reject) => { answers.push({ resolve, reject }); })
    : Promise.reject(new Error(`unexpected request ${path}`))));
  return answers;
}
const sentOps = n => api.mock.calls.filter(c => c[1]?.method === 'POST')[n][1].json.ops;

beforeEach(() => { vi.useFakeTimers(); api.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('planner sync: edits made while a save is in flight', () => {
  it('keeps an edit made before the earlier save returns, and sends it next', async () => {
    const base = emptyDocV2();
    const answers = holdPosts();
    const e = engineWith(base);
    e.update(v => setSlot(v, 'LS1', 0, HOIST));
    await vi.advanceTimersByTimeAsync(300); // flushed and sent; the POST is in flight
    expect(answers).toHaveLength(1);

    e.update(v => setSlot(v, 'LS1', 1, FOG)); // only in the view: its own flush timer has not fired
    const server = applyOps(base, sentOps(0), {});
    answers[0].resolve({ revision: 2, doc: server.doc, applied: server.applied, conflicts: [] });
    await vi.advanceTimersByTimeAsync(0);

    expect(e.view.allocations.LS1.slice(0, 2)).toEqual([HOIST, FOG]); // was [HOIST, ''] before the fix
    expect(e.revision).toBe(2);
    expect(answers).toHaveLength(2); // the kept edit went out right after the first answer
    expect(sentOps(1)).toEqual([expect.objectContaining({ op: 'setSlot', comp: 'LS1', index: 1, value: FOG })]);
  });

  it('keeps a rename back made while the first rename is in flight', async () => {
    const base = emptyDocV2();
    const answers = holdPosts();
    const e = engineWith(base);
    const rename = (from, to) => {
      e.hintRename(from, to);
      e.update(v => ({ ...v, customTools: [...v.customTools.filter(t => t.name !== from), { name: to, qty: 1, dimensions: '' }], removedItems: v.removedItems.includes(HOIST) ? v.removedItems : [...v.removedItems, HOIST] }));
    };
    rename(HOIST, 'Synthetic Hoist');
    await vi.advanceTimersByTimeAsync(300);
    rename('Synthetic Hoist', HOIST);
    const server = applyOps(base, sentOps(0), {});
    answers[0].resolve({ revision: 2, doc: server.doc, applied: server.applied, conflicts: [] });
    await vi.advanceTimersByTimeAsync(0);

    const names = e.view.customTools.map(t => t.name);
    expect(names).toContain(HOIST);
    expect(names).not.toContain('Synthetic Hoist');
    expect(sentOps(1)).toEqual(expect.arrayContaining([expect.objectContaining({ op: 'renameEquipment', from: 'Synthetic Hoist', to: HOIST })]));
  });

  it('keeps a newer edit when the in-flight entry is rejected and reverted', async () => {
    const base = emptyDocV2();
    const answers = holdPosts();
    const e = engineWith(base);
    e.update(v => setSlot(v, 'LS1', 0, HOIST));
    await vi.advanceTimersByTimeAsync(300);
    e.update(v => setSlot(v, 'LS1', 1, FOG));
    answers[0].reject(new ApiError(422, 'INVALID', 'Synthetic rejection'));
    await vi.advanceTimersByTimeAsync(0);

    expect(e.view.allocations.LS1.slice(0, 2)).toEqual(['', FOG]); // the rejected edit is reverted, the newer one kept
    expect(e.notices.at(-1).message).toContain('could not be saved');
    expect(sentOps(1)).toEqual([expect.objectContaining({ op: 'setSlot', comp: 'LS1', index: 1, value: FOG })]);
  });
});
