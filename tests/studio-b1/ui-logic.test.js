import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachRegions, maxQuantity, rowKey, summarizePlan, toApiLink } from '../../src/studio/library/association-summary.js';
import { describeItem, formatBytes, itemPercent, summarizeQueue } from '../../src/studio/capture/queue-status.js';
import { emptyMount, formToPayload, mountToForm, validateMountForm } from '../../src/studio/mounts/mount-constants.js';
import { UNDO_MS, pendingDeleteIds, scheduleDelete, undoDelete } from '../../src/studio/library/deferred-delete.js';
import { needsAssociation } from '../../src/studio/capture/categories.js';

describe('association summary', () => {
  it('describes linking existing assignments without an inventory change', () => {
    const plan = { links: [1, 2, 3, 4].map(i => ({ targetType: 'assignment', targetId: `as_${i}`, equipmentId: 'eq_a', quantity: 1 })), plannerOps: [], errors: [] };
    const s = summarizePlan(plan, [{ name: 'Axe' }]);
    expect(s.lines[0].text).toBe('Link to 4 existing assignments — no inventory change');
    expect(s.canSave).toBe(true);
  });
  it('describes assigning into empty slots with availability (1-based slot numbers)', () => {
    const plan = { links: [{ targetType: 'assignment', targetId: 'as_new' }], plannerOps: [{ op: 'setSlot', comp: 'LS1', index: 6, value: 'Spreader', expect: '' }], errors: [] };
    const s = summarizePlan(plan, [{ name: 'Spreader' }], { Spreader: { free: 2 } });
    expect(s.lines.map(l => l.text)).toContain('Assign 1 × Spreader to empty slot 7 (2 available)');
    expect(s.lines[0].text).toBe('Link to 1 existing assignment — no inventory change');
  });
  it('reports multiple slots, new tools and blocks saving on errors', () => {
    const plan = { links: [], plannerOps: [{ op: 'setSlot', index: 0, value: 'Hose' }, { op: 'setSlot', index: 3, value: 'Hose' }, { op: 'upsertCustomTool', tool: { name: 'Wedge', qty: 2 } }], errors: [{ index: 1, code: 'QUANTITY', message: 'Only 0 available.' }] };
    const s = summarizePlan(plan, [{ name: 'Hose' }, { name: 'Pike pole' }]);
    expect(s.lines.map(l => l.text)).toEqual(['Assign 2 × Hose to empty slots 1, 4', 'Add new tool “Wedge” to inventory (quantity 2)']);
    expect(s.errors).toEqual(['Pike pole: Only 0 available.']);
    expect(s.canSave).toBe(false);
  });
  it('handles empty/no plan', () => {
    expect(summarizePlan(null).canSave).toBe(false);
    expect(summarizePlan({ links: [], plannerOps: [], errors: [] }).lines[0].text).toBe('Nothing selected yet.');
  });
  it('keys rows, bounds quantity, attaches regions and strips UI fields', () => {
    expect(rowKey({ equipmentId: 'eq_1', name: 'x' })).toBe('eq_1');
    expect(rowKey({ name: 'x' })).toBe('name:x');
    expect(maxQuantity({ assignmentIds: ['a', 'b'], free: 1 })).toBe(3);
    expect(maxQuantity({ free: 0 })).toBe(1);
    const region = { x: 0, y: 0, w: 0.5, h: 0.5 };
    const links = attachRegions([{ targetType: 'assignment', targetId: 'as_1', equipmentId: 'eq_1', label: 'Axe' }, { targetType: 'assignment', targetId: 'as_2', equipmentId: 'eq_1' }], [{ equipmentId: 'eq_1', name: 'Axe', region }]);
    expect(links[0].region).toEqual(region);
    expect(links[1].region).toBeUndefined();
    expect(toApiLink({ targetType: 'assignment', targetId: 'as_1', equipmentId: 'eq_1', label: 'Axe', quantity: 2, region })).toEqual({ targetType: 'assignment', targetId: 'as_1', quantity: 2, region });
  });
  it('only tool and group photos open the dialog', () => {
    expect(needsAssociation('tool')).toBe(true);
    expect(needsAssociation('tool_group')).toBe(true);
    expect(needsAssociation('mount')).toBe(false);
  });
});

describe('queue status text', () => {
  it('describes each state', () => {
    expect(describeItem({ state: 'queued', waiting: 'offline' }).tone).toBe('warn');
    expect(describeItem({ state: 'uploading', progress: { variant: 'thumb' } }).text).toBe('Uploading thumbnail…');
    expect(describeItem({ state: 'failed', error: 'Too big', retryable: true }).text).toContain('Retry');
    expect(describeItem({ state: 'failed', error: 'Too big', retryable: false }).text).toBe('Too big');
    expect(describeItem({ state: 'done' }).tone).toBe('ok');
  });
  it('computes percent and summaries', () => {
    expect(itemPercent({ state: 'uploading', uploaded: { original: true }, progress: { loaded: 50, total: 100 } })).toBe(50);
    expect(itemPercent({ state: 'done' })).toBe(100);
    expect(summarizeQueue([{ state: 'done' }, { state: 'failed' }, { state: 'uploading' }])).toBe('1 uploading, 1 uploaded, 1 failed');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(formatBytes(100)).toBe('1 KB');
  });
});

describe('mount form mapping', () => {
  it('round-trips a mount and validates', () => {
    const f = { ...emptyMount(), name: ' Hose tray ', capacity: '4', zone: 'lower_tray', assetId: 'ast_1', equipmentIds: ['eq_1'] };
    const p = formToPayload(f);
    expect(p).toMatchObject({ name: 'Hose tray', capacity: 4, manufacturer: null, zone: 'lower_tray', classification: 'mounting', status: 'proposed' });
    expect(p.links).toEqual([{ targetType: 'asset', targetId: 'ast_1' }, { targetType: 'equipment', targetId: 'eq_1' }]);
    expect(mountToForm({ ...p, links: p.links })).toMatchObject({ name: 'Hose tray', capacity: '4', assetId: 'ast_1', equipmentIds: ['eq_1'] });
    expect(validateMountForm(emptyMount())).toMatch(/name/);
    expect(validateMountForm({ ...f, capacity: '-1' })).toMatch(/Capacity/);
    expect(validateMountForm(f)).toBe('');
  });
});

describe('deferred delete with undo', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('sends DELETE only after the undo window, and not after Undo', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue(null);
    const done = vi.fn();
    scheduleDelete({ id: 'ast_a' }, { request, onDone: done });
    scheduleDelete({ id: 'ast_b' }, { request });
    expect(pendingDeleteIds().has('ast_a')).toBe(true);
    expect(undoDelete('ast_b')).toBe(true);
    await vi.advanceTimersByTimeAsync(UNDO_MS - 1);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/assets/ast_a', { method: 'DELETE' });
    expect(done).toHaveBeenCalled();
    expect(pendingDeleteIds().size).toBe(0);
    expect(undoDelete('ast_a')).toBe(false);
  });
  it('reports a failed delete', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    scheduleDelete({ id: 'ast_c' }, { request: vi.fn().mockRejectedValue(new Error('x')), onError, delayMs: 10 });
    await vi.advanceTimersByTimeAsync(20);
    expect(onError).toHaveBeenCalled();
  });
});
