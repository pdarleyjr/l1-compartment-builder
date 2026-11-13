import { COMPARTMENTS, COMP_LABEL, SLOTS_PER_COMPARTMENT } from '../../shared/apparatus.js';

/**
 * Download L1_Compartment_Plan.xlsx (sheets "Compartments" and "Inventory Status").
 * @param {Record<string,string[]>} allocations
 * @param {ReturnType<import('./usePlan.js').default>} plan
 */
export default async function exportExcel(allocations, plan) {
  const { effectiveInventory, effectiveDimensions, getQty, placedStats } = plan;
  const { default: writeXlsxFile } = await import('write-excel-file/browser');

  // Sheet 1: Compartment Assignments
  const compHeaders = ['Slot', ...COMPARTMENTS.map(c => c.label ?? c.id)];
  const compRows = [];
  const maxSlots = Math.max(SLOTS_PER_COMPARTMENT, ...COMPARTMENTS.map(c => (allocations[c.id] ?? []).length));
  for (let i = 0; i < maxSlots; i++) {
    compRows.push([i + 1, ...COMPARTMENTS.map(c => (allocations[c.id] ?? [])[i] || '')]);
  }

  // Sheet 2: Inventory Status
  const invHeaders = ['Equipment Item', 'Total Qty', 'Placed', 'Remaining', 'Assigned To', 'Dimensions', 'Status'];
  const invRows = effectiveInventory.map(item => {
    const stats = placedStats[item.name];
    const qty = getQty(item.name);
    const placed = stats?.total ?? 0;
    const remaining = qty - placed;
    const assignedTo = Object.entries(stats?.byComp ?? {})
      .map(([comp, cnt]) => cnt > 1 ? `${COMP_LABEL[comp] ?? comp} x${cnt}` : (COMP_LABEL[comp] ?? comp))
      .join(', ');
    const status = placed > qty ? 'Over' : remaining === 0 ? 'Complete' : placed > 0 ? 'Partial' : 'Pending';
    return [item.name, qty, placed, remaining, assignedTo || '', effectiveDimensions[item.name] || '', status];
  });
  const toSheet = rows => rows.map((row, rowIndex) => row.map(value => ({
    value,
    type: typeof value === 'number' ? Number : String,
    fontWeight: rowIndex === 0 ? 'bold' : undefined,
  })));
  await writeXlsxFile([
    {
      data: toSheet([compHeaders, ...compRows]),
      sheet: 'Compartments',
      stickyRowsCount: 1,
    },
    {
      data: toSheet([invHeaders, ...invRows]),
      sheet: 'Inventory Status',
      stickyRowsCount: 1,
    },
    ]).toFile('L1_Compartment_Plan.xlsx');
}
