import { beforeEach, describe, expect, test } from 'vitest';
import { COMPARTMENT_IDS, NOTES_LOCKED_COMPARTMENTS, NOTE_LIMITS } from '../../shared/contracts.js';
import { applyOps, diffDocs, emptyDocV2, migrateV1toV2, normalizeDoc, projectV1, validateOp } from '../../shared/planner.js';
import { counterIds, FOG, JACK, THERMAL, v1Fixture } from './fixtures.js';

let doc;
let ctx;
beforeEach(async () => {
  ctx = { newId: counterIds(), now: 1000 };
  doc = (await migrateV1toV2(v1Fixture(), { newId: counterIds() })).doc;
});
const apply = (ops, d = doc) => applyOps(d, ops, ctx);
const note = (comp, text, expect = '') => ({ op: 'setNote', comp, text, expect });

describe('constants', () => {
  test('RS3 is locked; limits', () => {
    expect(NOTES_LOCKED_COMPARTMENTS).toEqual(['RS3']);
    expect(NOTE_LIMITS).toEqual({ textMax: 2000, reasonMax: 300 });
  });
});

describe('validateOp setNote / setUnverified', () => {
  test('accepts newline and tab, 2000 chars', () => {
    expect(validateOp(note('LS1', 'a\nb\tc'))).toEqual({ ok: true });
    expect(validateOp(note('LS1', 'x'.repeat(2000)))).toEqual({ ok: true });
  });
  test('rejects 2001 chars, control chars, non-strings, extra fields', () => {
    expect(validateOp(note('LS1', 'x'.repeat(2001))).ok).toBe(false);
    for (const c of ['\u0000', '\u0007', '\r', '\u001b', '\u007f']) expect(validateOp(note('LS1', `a${c}b`)).ok).toBe(false);
    expect(validateOp(note('LS1', 5)).ok).toBe(false);
    expect(validateOp({ ...note('LS1', 'a'), extra: 1 }).ok).toBe(false);
    expect(validateOp({ op: 'setNote', comp: 'LS1', text: 'a' }).ok).toBe(false);
  });
  test('setUnverified reason: null, string <= 300, else invalid', () => {
    expect(validateOp({ op: 'setUnverified', name: 'a', reason: null })).toEqual({ ok: true });
    expect(validateOp({ op: 'setUnverified', name: 'a', reason: '' })).toEqual({ ok: true });
    expect(validateOp({ op: 'setUnverified', name: 'a', reason: 'x'.repeat(301) }).ok).toBe(false);
    expect(validateOp({ op: 'setUnverified', name: 'a', reason: 'a\u0001' }).ok).toBe(false);
    expect(validateOp({ op: 'setUnverified', name: 'a', reason: 3 }).ok).toBe(false);
  });
});

describe('setNote', () => {
  test('create, update, delete', () => {
    let r = apply([note('LS1', 'first')]);
    expect(r.conflicts).toEqual([]);
    expect(r.doc.notes.LS1).toEqual({ text: 'first', updatedAt: 1000 });
    r = applyOps(r.doc, [note('LS1', 'second', 'first')], { ...ctx, now: 2000 });
    expect(r.doc.notes.LS1).toEqual({ text: 'second', updatedAt: 2000 });
    r = applyOps(r.doc, [note('LS1', '', 'second')], ctx);
    expect(r.doc.notes).toEqual({});
  });
  test('precondition conflict returns current text; matching target is an idempotent no-op', () => {
    const d = apply([note('LS1', 'theirs')]).doc;
    const r = apply([note('LS1', 'mine', '')], d);
    expect(r.conflicts).toEqual([{ index: 0, reason: 'PRECONDITION', current: 'theirs' }]);
    expect(r.doc.notes.LS1.text).toBe('theirs');
    const same = applyOps(d, [note('LS1', 'theirs', '')], { ...ctx, now: 9999 });
    expect(same.conflicts).toEqual([]);
    expect(same.applied).toEqual([0]);
    expect(same.doc.notes.LS1.updatedAt).toBe(1000);
  });
  test('RS3 is locked (INVALID), nothing written', () => {
    const r = apply([note('RS3', 'x')]);
    expect(r.conflicts).toEqual([{ index: 0, reason: 'INVALID', message: 'notes are locked for this compartment' }]);
    expect(r.doc.notes.RS3).toBeUndefined();
    expect(r.doc).toEqual(normalizeDoc(doc).doc);
  });
  test('unknown compartment → NOT_FOUND', () => {
    expect(apply([note('ZZ9', 'x')]).conflicts[0].reason).toBe('NOT_FOUND');
  });
  test('invalid text is reported INVALID by applyOps and not stored', () => {
    const r = apply([note('LS1', 'x'.repeat(2001)), note('LS1', 'a\u0000')]);
    expect(r.conflicts.map(c => c.reason)).toEqual(['INVALID', 'INVALID']);
    expect(r.doc.notes).toEqual({});
  });
  test('markup is stored as plain text', () => {
    const r = apply([note('LS2', '<script>alert(1)</script>')]);
    expect(r.doc.notes.LS2.text).toBe('<script>alert(1)</script>');
  });
});

describe('setUnverified and its lifecycle', () => {
  test('set / clear / NOT_FOUND', () => {
    let r = apply([{ op: 'setUnverified', name: FOG, reason: 'size unknown' }]);
    expect(r.doc.unverified).toEqual({ [FOG]: 'size unknown' });
    r = apply([{ op: 'setUnverified', name: FOG, reason: '' }], r.doc);
    expect(r.doc.unverified).toEqual({ [FOG]: '' });
    r = apply([{ op: 'setUnverified', name: FOG, reason: null }], r.doc);
    expect(r.doc.unverified).toEqual({});
    expect(apply([{ op: 'setUnverified', name: 'No such item', reason: 'x' }]).conflicts[0].reason).toBe('NOT_FOUND');
    expect(apply([{ op: 'setUnverified', name: 'No such item', reason: null }]).conflicts).toEqual([]);
  });
  test('renameEquipment moves the entry', () => {
    const d = apply([{ op: 'setUnverified', name: FOG, reason: 'r' }]).doc;
    const r = apply([{ op: 'renameEquipment', from: FOG, to: 'Fog Nozzle 2' }], d);
    expect(r.conflicts).toEqual([]);
    expect(r.doc.unverified).toEqual({ 'Fog Nozzle 2': 'r' });
  });
  test('removeCustomTool and setRemoved(true) delete the entry', () => {
    let d = apply([{ op: 'setUnverified', name: THERMAL, reason: 'r' }, { op: 'setUnverified', name: JACK, reason: 'q' }]).doc;
    d = apply([{ op: 'removeCustomTool', name: THERMAL }], d).doc;
    expect(d.unverified).toEqual({ [JACK]: 'q' });
    d = apply([{ op: 'setRemoved', name: JACK, removed: true }], d).doc;
    expect(d.unverified).toEqual({});
  });
});

describe('normalizeDoc / emptyDocV2 / projectV1', () => {
  test('seeds both maps; emptyDocV2 includes them', () => {
    const { doc: d } = normalizeDoc({ ...emptyDocV2(), notes: undefined, unverified: undefined });
    expect(d.notes).toEqual({});
    expect(d.unverified).toEqual({});
    expect(emptyDocV2()).toMatchObject({ notes: {}, unverified: {} });
  });
  test('drops malformed / unknown notes but keeps valid ones', () => {
    const base = emptyDocV2();
    base.notes = { LS1: { text: 'ok', updatedAt: 5 }, ZZ: { text: 'x', updatedAt: 1 }, LS2: { text: '', updatedAt: 1 }, LS3: 'str', RS3: { text: 'bad' } };
    const { doc: d } = normalizeDoc(base);
    expect(Object.keys(d.notes)).toEqual(['LS1']);
  });
  test('projectV1 carries notes and unverified', () => {
    const d = apply([note('LS1', 'n'), { op: 'setUnverified', name: FOG, reason: 'r' }]).doc;
    const v = projectV1(d);
    expect(v.notes.LS1.text).toBe('n');
    expect(v.unverified[FOG]).toBe('r');
  });
});

describe('diffDocs', () => {
  test('round trip reproduces notes and unverified; ops come before bundle ops', () => {
    const next = projectV1(doc);
    next.notes = { LS1: { text: 'hello', updatedAt: 5 } };
    next.unverified = { [FOG]: 'why' };
    next.bundles = { ...next.bundles, LS1: [{ id: 'b1', name: 'B', colorIdx: 0, slotIndices: [0] }] };
    const ops = diffDocs(doc, next);
    for (const op of ops) expect(validateOp(op)).toEqual({ ok: true });
    const kinds = ops.map(o => o.op);
    expect(kinds.indexOf('setNote')).toBeLessThan(kinds.indexOf('upsertBundle'));
    expect(kinds.indexOf('setUnverified')).toBeLessThan(kinds.indexOf('upsertBundle'));
    const r = apply(ops);
    expect(r.conflicts).toEqual([]);
    expect(r.doc.notes.LS1.text).toBe('hello');
    expect(r.doc.unverified).toEqual({ [FOG]: 'why' });
    const back = diffDocs(r.doc, projectV1(doc));
    const r2 = apply(back, r.doc);
    expect(r2.doc.notes).toEqual({});
    expect(r2.doc.unverified).toEqual({});
  });
  test('text-only comparison: same text with different updatedAt emits nothing', () => {
    const a = apply([note('LS1', 'same')]).doc;
    const b = structuredClone(a); b.notes.LS1.updatedAt = 77;
    expect(diffDocs(a, b)).toEqual([]);
  });
  test('changing a note carries expect = base text', () => {
    const a = apply([note('LS1', 'one')]).doc;
    const b = structuredClone(a); b.notes.LS1.text = 'two';
    expect(diffDocs(a, b)).toEqual([note('LS1', 'two', 'one')]);
    const c = structuredClone(a); delete c.notes.LS1;
    expect(diffDocs(a, c)).toEqual([note('LS1', '', 'one')]);
  });
});

describe('RS3 invariant', () => {
  test('ops targeting other compartments never touch RS3 data or create notes.RS3', () => {
    const before = structuredClone(normalizeDoc(doc).doc);
    const others = COMPARTMENT_IDS.filter(c => c !== 'RS3');
    const ops = [];
    for (const c of others) {
      ops.push(note(c, `note ${c}`), { op: 'setSlotCount', comp: c, count: 16, expect: 15 },
        { op: 'upsertBundle', comp: c, bundle: { id: `bb${c.toLowerCase()}`, name: 'B', colorIdx: 0, slotIndices: [] } },
        { op: 'deleteBundle', comp: c, id: 'nonexistent' });
    }
    ops.push({ op: 'setSlot', comp: 'LS3', index: 0, value: FOG, expect: '' },
      { op: 'setCustomQty', name: JACK, qty: 4 }, { op: 'setDimension', name: JACK, value: '1 x 1' },
      { op: 'upsertCustomTool', tool: { name: 'Extra', qty: 1 } }, { op: 'setUnverified', name: 'Extra', reason: 'r' },
      { op: 'renameEquipment', from: 'Extra', to: 'Extra2' }, { op: 'removeCustomTool', name: 'Extra2' },
      { op: 'setRemoved', name: JACK, removed: true }, note('RS3', 'sneaky'));
    const r = apply(ops);
    expect(r.doc.allocations.RS3).toEqual(before.allocations.RS3);
    expect(r.doc.assignmentIds.RS3).toEqual(before.assignmentIds.RS3);
    expect(r.doc.bundles.RS3).toEqual(before.bundles.RS3);
    expect(r.doc.notes.RS3).toBeUndefined();
    expect(r.conflicts.filter(c => c.reason === 'INVALID').length).toBeGreaterThan(0);
  });
});

describe('plain text well-formedness', () => {
  test('rejects lone surrogates, accepts paired ones', () => {
    expect(validateOp(note('LS1', 'a\uD800b')).ok).toBe(false);
    expect(validateOp(note('LS1', 'a\uDC00')).ok).toBe(false);
    expect(validateOp({ op: 'setUnverified', name: 'a', reason: 'x\uD83D' }).ok).toBe(false);
    expect(validateOp(note('LS1', 'ok 🧯'))).toEqual({ ok: true });
  });
});
