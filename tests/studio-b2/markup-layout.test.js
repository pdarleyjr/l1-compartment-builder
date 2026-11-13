import { describe, expect, it } from 'vitest';
import {
  arrowHead, clearAll, commit, defaultShape, drawShapes, emptyHistory, nudgeShape, redo, scaleShape, shapeFromDrag, toNormalized, undo,
} from '../../src/studio/edit/markupModel.js';
import { clampPan, clampScale, versionLabels, branchText, verificationHints, zoomAt, visibleVersions } from '../../src/studio/review/reviewModel.js';
import { availableZones, diagramModel, itemsByZone, layoutDirty, normalizeLayout, placementOf, setPlacement, toolItems } from '../../src/studio/layout/layoutModel.js';
import { photoCounts } from '../../src/studio/common/data.js';

describe('markup geometry', () => {
  it('normalizes pointer positions and clamps', () => {
    const rect = { left: 10, top: 20, width: 200, height: 100 };
    expect(toNormalized(110, 70, rect)).toEqual({ x: 0.5, y: 0.5 });
    expect(toNormalized(-50, 500, rect)).toEqual({ x: 0, y: 1 });
  });
  it('ignores taps but keeps real drags', () => {
    expect(shapeFromDrag('arrow', [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.505 }])).toBeNull();
    expect(shapeFromDrag('rect', [{ x: 0.1, y: 0.1 }, { x: 0.4, y: 0.5 }])).toMatchObject({ type: 'rect' });
    expect(shapeFromDrag('free', [{ x: 0.1, y: 0.1 }])).toBeNull();
    expect(shapeFromDrag('free', [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }]).pts).toHaveLength(2);
  });
  it('nudges within bounds and scales around the centre', () => {
    const s = defaultShape('rect');
    const moved = nudgeShape(s, 5, 0);
    expect(moved.b.x).toBe(1);
    expect(moved.b.x - moved.a.x).toBeCloseTo(0.2);
    const bigger = scaleShape(s, 2);
    expect(bigger.b.x - bigger.a.x).toBeCloseTo(0.4);
  });
  it('arrow head has two wings behind the tip', () => {
    const [l, r] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 10);
    expect(l.x).toBeLessThan(100); expect(r.x).toBeLessThan(100);
    expect(l.y).toBeCloseTo(-r.y);
  });
  it('undo/redo/clear history', () => {
    let h = emptyHistory();
    h = commit(h, [defaultShape('arrow')]);
    h = commit(h, [defaultShape('arrow'), defaultShape('circle')]);
    expect(h.present).toHaveLength(2);
    h = undo(h); expect(h.present).toHaveLength(1);
    h = redo(h); expect(h.present).toHaveLength(2);
    h = clearAll(h); expect(h.present).toHaveLength(0);
    h = undo(h); expect(h.present).toHaveLength(2);
    expect(undo(emptyHistory())).toEqual(emptyHistory());
  });
  it('draws every shape type to a context at pixel size', () => {
    const calls = [];
    const ctx = new Proxy({}, { get: (_t, k) => (k in ctx2 ? ctx2[k] : (...a) => calls.push([k, ...a])), set: (_t, k, v) => { ctx2[k] = v; return true; } });
    const ctx2 = {};
    drawShapes(ctx, ['arrow', 'circle', 'rect', 'free'].map(defaultShape), 1000, 500);
    const names = new Set(calls.map(c => c[0]));
    for (const n of ['ellipse', 'rect', 'lineTo', 'stroke']) expect(names.has(n)).toBe(true);
    const rectCall = calls.find(c => c[0] === 'rect');
    expect(rectCall[3]).toBeCloseTo(200); // 0.2 × 1000 px wide
  });
});

describe('review helpers', () => {
  const vs = [{ id: 'b', createdAt: 2, parentVersionId: 'a', status: 'draft' }, { id: 'a', createdAt: 1, status: 'approved' }, { id: 'c', createdAt: 3, status: 'deleted' }];
  it('labels oldest→newest and describes branches', () => {
    const l = versionLabels(vs);
    expect([l.get('a'), l.get('b'), l.get('c')]).toEqual(['v1', 'v2', 'v3']);
    expect(branchText(vs[0], l)).toBe('branch of v1');
    expect(branchText(vs[1], l)).toBe('');
    expect(visibleVersions(vs).map(v => v.id)).toEqual(['b', 'a']);
  });
  it('zoom and pan stay in bounds', () => {
    expect(clampScale(0.2)).toBe(1); expect(clampScale(99)).toBe(6);
    expect(clampPan({ x: 999, y: -999 }, 2, { w: 200, h: 100 })).toEqual({ x: 100, y: -50 });
    const t = zoomAt({ scale: 1, x: 0, y: 0 }, 2, { cx: 50, cy: 0 }, { w: 200, h: 100 });
    expect(t.scale).toBe(2); expect(t.x).toBe(-50);
    expect(zoomAt({ scale: 1, x: 0, y: 0 }, 0.5, { cx: 0, cy: 0 }, { w: 200, h: 100 }).scale).toBe(1);
  });
  it('extracts verification hints', () => {
    expect(verificationHints(null)).toEqual([]);
    expect(verificationHints({ summary: 's', issues: ['a', { message: 'b' }] })).toEqual(['s', 'a', 'b']);
  });
});

describe('layout model', () => {
  it('groups tools by equipment and counts quantity', () => {
    expect(toolItems([{ name: 'Axe', equipmentId: 'eq_1' }, { name: 'Axe', equipmentId: 'eq_1' }, { name: 'Pike' }])).toEqual([
      { kind: 'tool', ref: 'eq_1', name: 'Axe', qty: 2 }, { kind: 'tool', ref: 'Pike', name: 'Pike', qty: 1 }]);
  });
  it('sets and clears placements immutably', () => {
    const item = { kind: 'tool', ref: 'eq_1', name: 'Axe' };
    const l0 = normalizeLayout(null);
    const l1 = setPlacement(l0, item, { zone: 'left_wall' });
    expect(placementOf(l1, item).zone).toBe('left_wall');
    expect(l0.placements).toHaveLength(0);
    const l2 = setPlacement(l1, item, { orientation: 'vertical' });
    expect(l2.placements).toHaveLength(1);
    expect(setPlacement(setPlacement(l2, item, { zone: null }), item, { orientation: null }).placements).toHaveLength(0);
    expect(layoutDirty(l0, l1)).toBe(true);
    expect(layoutDirty(l1, { ...l1, placements: [...l1.placements] })).toBe(false);
  });
  it('rejects bad orientations from the server', () => {
    expect(normalizeLayout({ placements: [{ ref: 'x', zone: 'floor', orientation: 'upside-down' }] }).placements[0].orientation).toBeNull();
  });
  it('builds a proportional diagram and flags unknown dimensions', () => {
    const wide = diagramModel({ dimensions: { widthIn: 80, heightIn: 16 } }, ['a', 'b']);
    expect(wide.known).toBe(true); expect(wide.vbW).toBeGreaterThan(wide.vbH);
    const tall = diagramModel({ dimensions: { widthIn: 17, heightIn: 38 } }, ['a', 'b']);
    expect(tall.vbH).toBeGreaterThan(tall.vbW);
    expect(diagramModel(null, ['a']).known).toBe(false);
    expect(diagramModel(null, ['a', 'b', 'c']).rects).toHaveLength(3);
  });
  it('offers geometry zones plus any already used', () => {
    const l = { placements: [{ kind: 'tool', ref: 'x', name: 'x', zone: 'legacy', orientation: null }], notes: '' };
    expect(availableZones({ zones: ['floor'] }, l)).toEqual(['floor', 'legacy']);
    expect(availableZones(null, normalizeLayout(null))).toContain('upper_shelf');
    expect(itemsByZone(l, ['legacy']).legacy).toHaveLength(1);
  });
  it('counts linked photos per tool, ignoring rejected links and deleted assets', () => {
    const rows = [{ name: 'Axe', equipmentId: 'eq_1', assignmentId: 'as_1' }, { name: 'Pike', equipmentId: 'eq_2', assignmentId: 'as_2' }];
    const assets = [
      { id: 'p1', links: [{ targetType: 'assignment', targetId: 'as_1', state: 'confirmed' }, { targetType: 'equipment', targetId: 'eq_1' }] },
      { id: 'p2', links: [{ targetType: 'equipment', targetId: 'eq_1', state: 'confirmed' }, { targetType: 'equipment', targetId: 'eq_2', state: 'rejected' }] },
      { id: 'p3', status: 'deleted', links: [{ targetType: 'equipment', targetId: 'eq_2' }] },
    ];
    expect(photoCounts(assets, rows)).toEqual({ eq_1: 2 });
  });
});
