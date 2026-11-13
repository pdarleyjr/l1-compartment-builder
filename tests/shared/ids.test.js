import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { ID_PATTERN, ID_PREFIX } from '../../shared/contracts.js';
import { equipmentIdForName, equipmentIdForNameSync, newId, sha256Hex } from '../../shared/ids.js';
import { sha256HexSync, sha256StringSync } from '../../shared/lib/sha256.js';
import { canonicalJson } from '../../shared/lib/canonical.js';

const ref = s => createHash('sha256').update(s).digest('hex');

describe('newId', () => {
  test.each(Object.values(ID_PREFIX))('prefix %s: 26 chars [0-9a-z] and ID_PATTERN', prefix => {
    const id = newId(prefix);
    expect(id).toMatch(new RegExp(`^${prefix}_[0-9a-z]{26}$`));
    expect(id).toMatch(ID_PATTERN);
  });
  test('unique across many calls', () => {
    expect(new Set(Array.from({ length: 5000 }, () => newId('as'))).size).toBe(5000);
  });
  test('time-sortable: earlier timestamps sort first', () => {
    const a = newId('gj', 1_000_000_000_000);
    const b = newId('gj', 1_000_000_000_001);
    const c = newId('gj', 1_900_000_000_000);
    expect([c, b, a].sort()).toEqual([a, b, c]);
    expect(a.slice(3, 13)).toBe((1_000_000_000_000).toString(36).padStart(10, '0'));
  });
  test('timestamp 0 and negative are zero-padded', () => {
    expect(newId('as', 0).slice(3, 13)).toBe('0000000000');
    expect(newId('as', -5).slice(3, 13)).toBe('0000000000');
  });
});

describe('sha256', () => {
  test.each(['', 'abc', 'Holmatro V-Strut', 'é—日本語', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(1000)])('string %#', async s => {
    expect(await sha256Hex(s)).toBe(ref(s));
    expect(sha256StringSync(s)).toBe(ref(s));
  });
  test('bytes, views and ArrayBuffer', async () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const want = createHash('sha256').update(bytes).digest('hex');
    expect(await sha256Hex(bytes)).toBe(want);
    expect(await sha256Hex(bytes.buffer)).toBe(want);
    expect(await sha256Hex(new Uint8Array([9, 1, 2, 3, 250]).subarray(1))).toBe(want);
    expect(sha256HexSync(bytes)).toBe(want);
  });
  test('rejects other input types', async () => {
    await expect(sha256Hex(42)).rejects.toThrow(TypeError);
  });
});

describe('equipmentIdForName', () => {
  test('deterministic eq_ + first 16 hex of sha256', async () => {
    const id = await equipmentIdForName('Hi-Lift Jack');
    expect(id).toBe(`eq_${ref('Hi-Lift Jack').slice(0, 16)}`);
    expect(id).toMatch(ID_PATTERN);
    expect(equipmentIdForNameSync('Hi-Lift Jack')).toBe(id);
    expect(await equipmentIdForName('hi-lift jack')).not.toBe(id);
  });
});

describe('canonicalJson', () => {
  test('sorts keys, drops undefined, keeps arrays ordered', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [3, undefined, { z: 1, y: 2 }] }, u: undefined })).toBe('{"a":{"c":[3,null,{"y":2,"z":1}],"d":1},"b":1}');
    expect(canonicalJson(null)).toBe('null');
  });
});
