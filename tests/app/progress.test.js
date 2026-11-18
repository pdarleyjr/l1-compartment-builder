import { describe, expect, it } from 'vitest';
import { buildProgress } from '../../src/lib/progress.js';
import { COMPARTMENTS } from '../../shared/apparatus.js';

function make({ alloc = {}, qtys = {}, items = [], bundles = {}, unverified = {} } = {}) {
  const allocations = Object.fromEntries(COMPARTMENTS.map(c => [c.id, Array(4).fill('')]));
  for (const [id, slots] of Object.entries(alloc)) slots.forEach((s, i) => { allocations[id][i] = s; });
  const effectiveInventory = items.map(name => ({ name }));
  const getQty = n => qtys[n] ?? 0;
  return buildProgress({ allocations, bundles }, { effectiveInventory, getQty, unverified });
}

describe('buildProgress', () => {
  it('lists every compartment in order, empty ones with no lines', () => {
    const p = make({ items: ['Axe'], qtys: { Axe: 1 } });
    expect(p.compartments.map(c => c.id)).toEqual(COMPARTMENTS.map(c => c.id));
    expect(p.compartments.every(c => c.lines.length === 0 && c.units === 0)).toBe(true);
  });

  it('groups repeated items per compartment with 1-based slots', () => {
    const p = make({ alloc: { LS1: ['Axe', 'Saw', 'Axe'], LS2: ['Axe'] }, items: ['Axe', 'Saw'], qtys: { Axe: 4, Saw: 1 } });
    const ls1 = p.compartments.find(c => c.id === 'LS1');
    expect(ls1.units).toBe(3);
    expect(ls1.lines).toHaveLength(2);
    expect(ls1.lines[0]).toMatchObject({ name: 'Axe', qty: 2, slots: [1, 3] });
    expect(p.totals).toMatchObject({ unitsPlaced: 4, unitsRequired: 5, itemsComplete: 1, itemsPartial: 1, itemsPending: 0 });
  });

  it('reports pending and partial items sorted by name with where they are placed', () => {
    const p = make({ alloc: { RS1: ['Axe'], LS1: ['Axe'] }, items: ['Zed', 'Axe', 'Bar'], qtys: { Zed: 1, Axe: 4, Bar: 2 } });
    expect(p.pending.map(x => x.name)).toEqual(['Axe', 'Bar', 'Zed']);
    expect(p.pending[0]).toMatchObject({ required: 4, placed: 2, remaining: 2 });
    expect(p.pending[0].placedIn.map(x => x.compId)).toEqual(['LS1', 'RS1']);
    expect(p.totals).toMatchObject({ itemsPartial: 1, itemsPending: 2, itemsComplete: 0 });
  });

  it('records bundle names on lines', () => {
    const p = make({ alloc: { LS1: ['Axe', 'Saw'] }, items: ['Axe', 'Saw'], qtys: { Axe: 1, Saw: 1 }, bundles: { LS1: [{ id: 'b', name: 'Pack', slotIndices: [0] }] } });
    const l = p.compartments.find(c => c.id === 'LS1').lines;
    expect(l[0].bundles).toEqual(['Pack']);
    expect(l[1].bundles).toEqual([]);
  });

  it('detects over-allocation', () => {
    const p = make({ alloc: { LS1: ['Axe', 'Axe', 'Axe'] }, items: ['Axe'], qtys: { Axe: 2 } });
    expect(p.over).toEqual([{ name: 'Axe', required: 2, placed: 3, excess: 1 }]);
    expect(p.totals.itemsOver).toBe(1);
    expect(p.pending).toEqual([]);
  });

  it('ignores removed items still sitting in slots and includes custom items', () => {
    const p = make({ alloc: { LS1: ['Gone', 'Custom Thing'] }, items: ['Custom Thing'], qtys: { 'Custom Thing': 2 } });
    const l = p.compartments.find(c => c.id === 'LS1');
    expect(l.lines.map(x => x.name)).toEqual(['Custom Thing']);
    expect(p.totals.unitsPlaced).toBe(1);
    expect(p.pending[0]).toMatchObject({ name: 'Custom Thing', remaining: 1 });
  });

  it('flags unverified items with reasons, allowing empty reasons', () => {
    const p = make({ alloc: { LS1: ['Axe'] }, items: ['Axe', 'Saw'], qtys: { Axe: 1, Saw: 1 }, unverified: { Axe: 'check model', Saw: '' } });
    expect(p.compartments.find(c => c.id === 'LS1').lines[0]).toMatchObject({ needsVerification: true, reason: 'check model' });
    expect(p.pending[0]).toMatchObject({ name: 'Saw', needsVerification: true, reason: '' });
    expect(p.totals.needsVerification).toBe(2);
  });
});
