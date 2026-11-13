import { useMemo } from 'react';
import { COMPARTMENTS, DIMENSIONS, INVENTORY_BY_NAME, MASTER_INVENTORY } from '../../shared/apparatus.js';

/**
 * Derived planner values (effective inventory, quantities, placed stats) for a v1 planner view.
 * @param {{allocations:Record<string,string[]>, customQtys:Record<string,number>, customTools:{name:string,qty:number,dimensions?:string}[],
 *   removedItems:string[], customDimensions:Record<string,string>}} view
 */
export default function usePlan(view) {
  const { allocations, customQtys, customTools, removedItems, customDimensions } = view;

  const effectiveInventory = useMemo(() => [
    ...MASTER_INVENTORY.filter(i => !removedItems.includes(i.name)),
    ...customTools,
  ], [customTools, removedItems]);

  const effectiveDimensions = useMemo(() => {
    const dims = { ...DIMENSIONS, ...customDimensions };
    customTools.forEach(t => { if (t.dimensions) dims[t.name] = t.dimensions; });
    return dims;
  }, [customTools, customDimensions]);

  // Effective quantity: explicit override, then a custom tool of that name, then the standard inventory default.
  const getQty = name => {
    if (customQtys[name] !== undefined) return customQtys[name];
    const ct = customTools.find(t => t.name === name);
    if (ct) return ct.qty;
    return INVENTORY_BY_NAME[name]?.qty ?? 0;
  };

  const placedStats = useMemo(() => {
    const stats = {};
    effectiveInventory.forEach(item => { stats[item.name] = { total: 0, byComp: {} }; });
    COMPARTMENTS.forEach(comp => {
      allocations[comp.id].forEach(slot => {
        if (slot && stats[slot]) {
          stats[slot].total += 1;
          stats[slot].byComp[comp.id] = (stats[slot].byComp[comp.id] ?? 0) + 1;
        }
      });
    });
    return stats;
  }, [allocations, effectiveInventory]);

  const totalPlaced = useMemo(() => Object.values(placedStats).reduce((a, s) => a + s.total, 0), [placedStats]);
  const totalReq = useMemo(() => effectiveInventory.reduce((a, i) => a + getQty(i.name), 0), [customQtys, customTools, effectiveInventory]);

  const getOptions = currentValue => effectiveInventory.filter(item => {
    const placed = placedStats[item.name]?.total ?? 0;
    const qty = getQty(item.name);
    return qty > 0 && (placed < qty || item.name === currentValue);
  });

  const isCustom = name => customTools.some(t => t.name === name);
  return { effectiveInventory, effectiveDimensions, getQty, placedStats, totalPlaced, totalReq, getOptions, isCustom };
}
