import { COMPARTMENTS, COMP_LABEL } from '../../shared/apparatus.js';

/**
 * Read-only placement progress derived from a planner view and its derived plan values.
 * @param {{allocations:Record<string,string[]>, bundles?:Record<string,{id?:string,name?:string,slotIndices:number[]}[]>,
 *   unverified?:Record<string,string>}} view
 * @param {{effectiveInventory:{name:string}[], getQty:(name:string)=>number, unverified?:Record<string,string>}} plan
 */
export function buildProgress(view, plan) {
  const unverified = plan.unverified ?? view.unverified ?? {};
  const inventory = plan.effectiveInventory ?? [];
  const known = new Set(inventory.map(i => i.name));
  const flagged = name => Object.prototype.hasOwnProperty.call(unverified, name);
  const reasonOf = name => (flagged(name) ? String(unverified[name] ?? '') : '');

  const placedBy = {}; // name -> { total, byComp: {compId: n} }
  const compartments = COMPARTMENTS.map(comp => {
    const slots = view.allocations?.[comp.id] ?? [];
    const bundles = view.bundles?.[comp.id] ?? [];
    const byName = new Map();
    slots.forEach((name, idx) => {
      if (!name || !known.has(name)) return;
      let line = byName.get(name);
      if (!line) {
        line = { name, qty: 0, slots: [], bundles: [], needsVerification: flagged(name), reason: reasonOf(name) };
        byName.set(name, line);
      }
      line.qty += 1;
      line.slots.push(idx + 1);
      bundles.forEach(b => {
        const label = b.name || 'Bundle';
        if (Array.isArray(b.slotIndices) && b.slotIndices.includes(idx) && !line.bundles.includes(label)) line.bundles.push(label);
      });
      const s = (placedBy[name] ??= { total: 0, byComp: {} });
      s.total += 1;
      s.byComp[comp.id] = (s.byComp[comp.id] ?? 0) + 1;
    });
    const lines = [...byName.values()];
    return { id: comp.id, label: COMP_LABEL[comp.id] ?? comp.id, side: comp.side, lines, units: lines.reduce((a, l) => a + l.qty, 0) };
  });

  const totals = { unitsPlaced: 0, unitsRequired: 0, itemsComplete: 0, itemsPartial: 0, itemsPending: 0, itemsOver: 0, needsVerification: 0 };
  const pending = [];
  const over = [];
  for (const item of inventory) {
    const required = plan.getQty(item.name);
    const placed = placedBy[item.name]?.total ?? 0;
    const remaining = required - placed;
    totals.unitsPlaced += placed;
    totals.unitsRequired += required;
    if (flagged(item.name)) totals.needsVerification += 1;
    if (placed > required) { totals.itemsOver += 1; over.push({ name: item.name, required, placed, excess: placed - required }); }
    else if (required > 0 && placed === required) totals.itemsComplete += 1;
    else if (placed > 0) totals.itemsPartial += 1;
    else if (required > 0) totals.itemsPending += 1;
    if (remaining > 0) {
      const placedIn = Object.entries(placedBy[item.name]?.byComp ?? {})
        .map(([compId, count]) => ({ compId, label: COMP_LABEL[compId] ?? compId, count }))
        .sort((a, b) => COMPARTMENTS.findIndex(c => c.id === a.compId) - COMPARTMENTS.findIndex(c => c.id === b.compId));
      pending.push({ name: item.name, required, placed, remaining, placedIn, needsVerification: flagged(item.name), reason: reasonOf(item.name) });
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  pending.sort(byName);
  over.sort(byName);
  return { totals, compartments, pending, over };
}
