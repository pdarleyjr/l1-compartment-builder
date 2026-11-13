// Small faithful fakes of the part-C shared modules (planner/ids/validation) for hermetic Worker tests.
// Use with: vi.mock('<path>/shared/planner.js', async () => (await import('<helpers>/fake-shared.js')).fakePlanner())
import { COMPARTMENT_IDS } from '../../../shared/contracts.js';
import { INVENTORY_BY_NAME } from '../../../shared/apparatus.js';

const V1_KEYS = ['allocations', 'customQtys', 'customTools', 'bundles', 'removedItems', 'customDimensions'];

export function fakePlanner() {
  const emptyDocV2 = () => ({
    schema: 2,
    allocations: Object.fromEntries(COMPARTMENT_IDS.map(c => [c, Array(15).fill('')])),
    customQtys: {}, customTools: [], bundles: {}, removedItems: [], customDimensions: {}, equipmentIds: {}, assignmentIds: {},
  });
  const qtyOf = (doc, name) => doc.customQtys?.[name] ?? INVENTORY_BY_NAME[name]?.qty ?? doc.customTools?.find(t => t.name === name)?.qty ?? Infinity;
  const countOf = (doc, name) => Object.values(doc.allocations).reduce((n, slots) => n + slots.filter(s => s === name).length, 0);
  return {
    emptyDocV2,
    migrateV1toV2: async v1 => {
      const doc = { ...emptyDocV2(), ...structuredClone(v1), schema: 2 };
      doc.equipmentIds = {};
      doc.assignmentIds = Object.fromEntries(Object.entries(doc.allocations).map(([c, slots]) => [c, slots.map((s, i) => (s ? `as_${c}_${i}` : null))]));
      return { doc, report: {} };
    },
    projectV1: doc => Object.fromEntries(V1_KEYS.filter(k => k in doc).map(k => [k, doc[k]])),
    validateOp: op => (op && ['setSlot', 'setCustomQty'].includes(op.op) ? { ok: true } : { ok: false, error: 'unknown op' }),
    applyOps: (doc, ops, ctx) => {
      const applied = []; const conflicts = [];
      ops.forEach((op, index) => {
        if (op.op === 'setCustomQty') { doc.customQtys[op.name] = op.qty; applied.push(index); return; }
        const cur = doc.allocations[op.comp]?.[op.index];
        if (cur === undefined) { conflicts.push({ index, reason: 'NOT_FOUND' }); return; }
        if (cur === op.value) { applied.push(index); return; }
        if ('expect' in op && cur !== op.expect) { conflicts.push({ index, reason: 'PRECONDITION', current: cur }); return; }
        if (op.value && countOf(doc, op.value) + 1 > qtyOf(doc, op.value)) { conflicts.push({ index, reason: 'QUANTITY', current: countOf(doc, op.value) }); return; }
        doc.allocations[op.comp][op.index] = op.value;
        doc.assignmentIds[op.comp] ??= [];
        doc.assignmentIds[op.comp][op.index] = op.value ? ctx.newId('as') : null;
        applied.push(index);
      });
      return { doc, applied, conflicts };
    },
  };
}

export function fakeIds() {
  let n = 0;
  return {
    newId: prefix => `${prefix}_${String(++n).padStart(26, '0')}`,
    sha256Hex: async () => '0'.repeat(64),
    equipmentIdForName: async name => `eq_${name.length}`,
  };
}

export function fakeValidation() {
  const validateSettingValue = (key, value) => {
    const bad = error => ({ ok: false, error });
    if (key.startsWith('budget.')) return typeof value === 'number' && value >= 0 ? { ok: true, value } : bad('must be a non-negative number');
    if (key.endsWith('.enabled')) return typeof value === 'boolean' ? { ok: true, value } : bad('must be a boolean');
    if (key === 'access.admins') return Array.isArray(value) && value.every(v => typeof v === 'string') ? { ok: true, value } : bad('must be a list of emails');
    return { ok: true, value };
  };
  return { validateSettingValue };
}
