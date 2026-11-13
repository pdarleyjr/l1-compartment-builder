import { useMemo } from 'react';
import { COMPARTMENTS, SLOTS_PER_COMPARTMENT } from '../../shared/apparatus.js';

export const BUNDLE_COLORS = [
  { bg: '#fef9c3', border: '#ca8a04', text: '#713f12' },
  { bg: '#dcfce7', border: '#16a34a', text: '#14532d' },
  { bg: '#dbeafe', border: '#2563eb', text: '#1e3a8a' },
  { bg: '#fce7f3', border: '#db2777', text: '#831843' },
  { bg: '#f3e8ff', border: '#9333ea', text: '#581c87' },
  { bg: '#ffedd5', border: '#ea580c', text: '#7c2d12' },
  { bg: '#cffafe', border: '#0891b2', text: '#164e63' },
  { bg: '#d1fae5', border: '#059669', text: '#064e3b' },
];

/** Lowest unused bundle colour index for a compartment. */
export function nextBundleColor(existing) {
  const used = existing.map(b => b.colorIdx ?? 0);
  for (let i = 0; i < BUNDLE_COLORS.length; i++) if (!used.includes(i)) return i;
  return existing.length % BUNDLE_COLORS.length;
}

function generateUid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

/** Drop bundle slots that are empty or out of range, and bundles left with no slots (SD-08). */
export function pruneBundles(allocations, bundles) {
  const out = {};
  for (const [comp, list] of Object.entries(bundles)) {
    const slots = allocations[comp] ?? [];
    const kept = list
      .map(b => ({ ...b, slotIndices: b.slotIndices.filter(i => !!slots[i]) }))
      .filter(b => b.slotIndices.length > 0);
    if (kept.length) out[comp] = kept;
  }
  return out;
}

const emptyAllocations = () => Object.fromEntries(COMPARTMENTS.map(c => [c.id, Array(SLOTS_PER_COMPARTMENT).fill('')]));

/**
 * Planner mutations. Every one is a functional update of the local view; planner-sync turns the difference into ops.
 * @param {{update:(fn:(v:object)=>object)=>void, hintRename:(from:string,to:string)=>void}} sync
 * @param {ReturnType<import('./usePlan.js').default>} plan
 */
export default function usePlanActions({ update, hintRename }, plan) {
  const { getQty, placedStats, effectiveInventory, isCustom } = plan;
  return useMemo(() => {
    const withAllocations = (v, allocations) => ({ ...v, allocations, bundles: pruneBundles(allocations, v.bundles) });
    return {
      assign: (compId, idx, val) => update(v => {
        const allocations = { ...v.allocations, [compId]: [...v.allocations[compId]] };
        allocations[compId][idx] = val;
        return val === '' ? withAllocations(v, allocations) : { ...v, allocations };
      }),
      clearSlot: (compId, idx) => update(v => {
        const allocations = { ...v.allocations, [compId]: [...v.allocations[compId]] };
        allocations[compId][idx] = '';
        return withAllocations(v, allocations);
      }),
      /** @returns {{filled:number, message:string}} message is non-empty when nothing (or fewer than asked) was filled */
      bulkFill: (compId, item, qty, currentAllocations) => {
        const available = getQty(item) - (placedStats[item]?.total ?? 0);
        const emptySlots = (currentAllocations[compId] ?? []).filter(s => !s).length;
        const canFill = Math.min(available, emptySlots);
        const toFill = Math.min(qty, canFill);
        if (toFill <= 0) {
          return { filled: 0, message: available <= 0
            ? `No remaining capacity for "${item}" — all ${getQty(item)} units are already placed.`
            : `No empty slots available in compartment ${compId}.` };
        }
        update(v => {
          const slots = [...v.allocations[compId]];
          let filled = 0;
          for (let i = 0; i < slots.length && filled < toFill; i++) if (!slots[i]) { slots[i] = item; filled++; }
          return { ...v, allocations: { ...v.allocations, [compId]: slots } };
        });
        return { filled: toFill, message: toFill < qty ? `Filled ${toFill} slot${toFill !== 1 ? 's' : ''} (only ${canFill} slot${canFill !== 1 ? 's' : ''} available for "${item}").` : '' };
      },
      createBundle: (compId, name, slotIndices) => update(v => {
        const valid = slotIndices.filter(i => !!(v.allocations[compId] ?? [])[i]);
        if (!valid.length) return v;
        const existing = v.bundles[compId] ?? [];
        return { ...v, bundles: { ...v.bundles, [compId]: [...existing, { id: generateUid(), name, colorIdx: nextBundleColor(existing), slotIndices: valid }] } };
      }),
      deleteBundle: (compId, bundleId) => update(v => ({ ...v, bundles: { ...v.bundles, [compId]: (v.bundles[compId] ?? []).filter(b => b.id !== bundleId) } })),
      addRow: compId => update(v => ({ ...v, allocations: { ...v.allocations, [compId]: [...v.allocations[compId], ''] } })),
      removeLastEmptyRow: compId => update(v => {
        const slots = v.allocations[compId];
        if (slots.length <= SLOTS_PER_COMPARTMENT || slots[slots.length - 1] !== '') return v;
        return withAllocations(v, { ...v.allocations, [compId]: slots.slice(0, -1) });
      }),
      reset: () => update(v => withAllocations(v, emptyAllocations())),
      addTool: ({ name, qty, dimensions }) => update(v => ({ ...v, customTools: [...v.customTools, { name, qty, dimensions }] })),
      removeItem: name => {
        if (!window.confirm(`Remove "${name}" from inventory? It will be cleared from all compartments.`)) return;
        update(v => {
          const allocations = {};
          for (const [compId, slots] of Object.entries(v.allocations)) allocations[compId] = slots.map(s => (s === name ? '' : s));
          const customQtys = { ...v.customQtys }; delete customQtys[name];
          const custom = isCustom(name);
          return withAllocations({
            ...v, customQtys,
            customTools: custom ? v.customTools.filter(t => t.name !== name) : v.customTools,
            removedItems: custom || v.removedItems.includes(name) ? v.removedItems : [...v.removedItems, name],
          }, allocations);
        });
      },
      /** @returns {boolean} true when saved (false = validation failed and the form should stay open) */
      saveEdit: (item, values) => {
        const custom = isCustom(item.name);
        const newQty = Math.max(0, parseInt(values.qty, 10) || 0);
        const newDims = (values.dims ?? '').trim();
        const newName = ((values.name ?? '').trim() || item.name);
        const nameChanged = newName !== item.name;
        if (nameChanged && effectiveInventory.some(i => i.name.toLowerCase() === newName.toLowerCase() && i.name !== item.name)) {
          alert(`"${newName}" already exists in the inventory.`);
          return false;
        }
        if (nameChanged) hintRename(item.name, newName);
        update(v => {
          if (nameChanged) {
            const allocations = {};
            for (const [compId, slots] of Object.entries(v.allocations)) allocations[compId] = slots.map(s => (s === item.name ? newName : s));
            const customQtys = { ...v.customQtys }; delete customQtys[item.name]; customQtys[newName] = newQty;
            const customDimensions = { ...v.customDimensions }; delete customDimensions[item.name];
            if (newDims) customDimensions[newName] = newDims;
            return {
              ...v, allocations, customQtys, customDimensions,
              customTools: custom
                ? v.customTools.map(t => (t.name === item.name ? { ...t, name: newName, qty: newQty, dimensions: newDims } : t))
                : [...v.customTools, { name: newName, qty: newQty, dimensions: newDims }],
              removedItems: custom ? v.removedItems : [...v.removedItems, item.name],
            };
          }
          const customDimensions = { ...v.customDimensions };
          if (newDims) customDimensions[item.name] = newDims; else delete customDimensions[item.name];
          return {
            ...v, customDimensions, customQtys: { ...v.customQtys, [item.name]: newQty },
            customTools: custom ? v.customTools.map(t => (t.name === item.name ? { ...t, qty: newQty, dimensions: newDims } : t)) : v.customTools,
          };
        });
        return true;
      },
    };
  }, [update, hintRename, getQty, placedStats, effectiveInventory, isCustom]);
}
