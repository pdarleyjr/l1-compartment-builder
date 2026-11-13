import { describe, expect, it } from 'vitest';
import { describeConflict, emptyView, sanitizeView } from '../../src/lib/planner-sync.js';
import { buildCarouselItems } from '../../src/components/carouselItems.js';
import { pruneBundles } from '../../src/components/usePlanActions.js';

describe('sanitizeView (FM-20)', () => {
  it('coerces malformed shared documents into renderable shapes', () => {
    const v = sanitizeView({ allocations: { LS1: ['1 Ton Griphoist', 5, null] }, customTools: {}, bundles: { LS1: [{ id: 'x', slotIndices: 5 }, { id: 'y', slotIndices: [0, -1, 'a'] }] }, removedItems: 'no', customQtys: { a: 'x', b: 2 } });
    expect(v.allocations.LS1.slice(0, 3)).toEqual(['1 Ton Griphoist', '', '']);
    expect(v.customTools).toEqual([]);
    expect(v.removedItems).toEqual([]);
    expect(v.customQtys).toEqual({ b: 2 });
    expect(v.bundles.LS1).toHaveLength(1);
    expect(v.bundles.LS1[0].slotIndices).toEqual([0]);
  });
  it('returns an empty view for non-objects and seeds every compartment', () => {
    expect(sanitizeView(null)).toEqual(emptyView());
    expect(Object.keys(sanitizeView('x').allocations)).toHaveLength(11);
  });
});

describe('describeConflict', () => {
  it('names the compartment and slot and what was kept', () => {
    const msg = describeConflict({ op: 'setSlot', comp: 'LS2', index: 3, value: 'A', expect: '' }, { index: 0, reason: 'PRECONDITION', current: 'B' });
    expect(msg).toContain('LS2 slot 4');
    expect(msg).toContain('kept their change');
  });
  it('explains quantity conflicts', () => {
    expect(describeConflict({ op: 'setSlot', comp: 'RS1', index: 0, value: 'Hoist' }, { index: 0, reason: 'QUANTITY' })).toContain('Not enough units');
  });
});

describe('buildCarouselItems', () => {
  const presets = [{ src: '/images/LS2.webp', title: 'Compartment Photo' }, { src: '/images/LS2_rendering.webp', title: 'Rendering with Tools' }];
  it('puts the server main image first, then presets, then other items (no duplicates)', () => {
    const items = [{ key: 'a', id: 'ast_1', kind: 'asset', url: '/api/public/assets/ast_1/display', title: 'Approved', provenance: 'approved_concept', deletable: true }, { key: 'b', id: 'ast_2', kind: 'asset', url: '/u2', title: 'Other', provenance: 'user_photo', deletable: true }];
    const main = { kind: 'asset', ref: 'ast_1', url: '/api/public/assets/ast_1/display', provenance: 'approved_concept', stale: true };
    const list = buildCarouselItems({ main, presets, items });
    expect(list.map(i => i.title)).toEqual(['Approved', 'Compartment Photo', 'Rendering with Tools', 'Other']);
    expect(list[0]).toMatchObject({ isMain: true, stale: true });
  });
  it('a preset chosen as main is shown once, first', () => {
    const list = buildCarouselItems({ main: { kind: 'preset', ref: '/images/LS2_rendering.webp', url: '/images/LS2_rendering.webp', provenance: 'user_photo', stale: false }, presets, items: [] });
    expect(list.map(i => i.title)).toEqual(['Rendering with Tools', 'Compartment Photo']);
  });
  it('without a main image the order is unchanged', () => {
    expect(buildCarouselItems({ main: null, presets, items: [] }).map(i => i.src)).toEqual(presets.map(p => p.src));
  });
});

describe('pruneBundles (SD-08)', () => {
  it('drops empty slots and empty bundles', () => {
    const out = pruneBundles({ LS1: ['A', '', 'C'] }, { LS1: [{ id: '1', slotIndices: [0, 1] }, { id: '2', slotIndices: [1] }], RS1: [{ id: '3', slotIndices: [0] }] });
    expect(out).toEqual({ LS1: [{ id: '1', slotIndices: [0] }] });
  });
});
