// Synthetic v1 planner state shaped like production: 11 compartments × 15 slots, base-inventory names, bundles in RS3
// and RR1, a custom tool, a removed item, a customQty and a customDimension. No real data.
import { COMPARTMENT_IDS } from '../../shared/contracts.js';

export const FOG = '1 3/4 in Fog Nozzle (Elkhart Chief XD 175 GPM @ 75psi)';
export const VSTRUT = 'Holmatro V-Strut';
export const LDH = '5 in LDH Hose 100 ft Sections (PF-50Y-100)';
export const CUTTER = '36 in Bolt Cutter';
export const AXE = '6 lb Flathead Axe';
export const JACK = 'Hi-Lift Jack';
export const GRIPHOIST = '1 Ton Griphoist';
export const IRONS = 'Irons';
export const CELLAR = 'Cellar Nozzle';
export const THERMAL = 'Thermal Camera';

export function v1Fixture() {
  const allocations = Object.fromEntries(COMPARTMENT_IDS.map(id => [id, Array(15).fill('')]));
  allocations.LS1[0] = FOG; allocations.LS1[1] = FOG; allocations.RS1[0] = FOG;
  allocations.LS2[3] = JACK;
  allocations.LS4[0] = THERMAL; allocations.RS5[0] = THERMAL;
  [VSTRUT, VSTRUT, VSTRUT, VSTRUT, LDH, LDH].forEach((n, i) => { allocations.RS3[i] = n; });
  [CUTTER, CUTTER, AXE, IRONS].forEach((n, i) => { allocations.RR1[i] = n; });
  return {
    allocations,
    customQtys: { [JACK]: 2 },
    customTools: [{ name: THERMAL, qty: 2, dimensions: '6 × 4 × 3 in' }],
    bundles: {
      RS3: [{ id: 'k3j9x2a1', name: 'V-Struts', colorIdx: 0, slotIndices: [0, 1] }, { id: 'm4n8y3b2', name: 'Rear pair', colorIdx: 1, slotIndices: [2, 3] }],
      RR1: [{ id: 'p5q7z4c3', name: 'Cutters', colorIdx: 0, slotIndices: [0, 1] }, { id: 'r6s6a5d4', name: 'Hand tools', colorIdx: 2, slotIndices: [2, 3] }],
    },
    removedItems: [CELLAR],
    customDimensions: { [IRONS]: '40 × 9 × 3 in' },
  };
}

/** Deterministic id factory for tests. */
export function counterIds() {
  let n = 0;
  return prefix => `${prefix}_${String(++n).padStart(20, '0')}`;
}
