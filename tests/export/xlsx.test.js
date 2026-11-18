import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import writeXlsxFile from 'write-excel-file/node';
import readXlsxFile from 'read-excel-file/node';
import { buildSnapshot } from '../../src/lib/export/snapshot.js';
import { buildManifest } from '../../src/lib/export/manifest.js';
import { PROTECTED_TEXT, buildWorkbookSheets } from '../../src/lib/export/workbook.js';
import { A, B, FIXED, baseDoc, emptyAlloc, unzip } from './helpers.js';

async function render(docOver) {
  const snapshot = buildSnapshot({ doc: baseDoc(docOver), ...FIXED });
  const manifest = buildManifest(snapshot);
  const sheets = buildWorkbookSheets(snapshot, manifest);
  const file = join(mkdtempSync(join(tmpdir(), 'l1x-')), 'plan.xlsx');
  await writeXlsxFile(sheets).toFile(file);
  return { snapshot, manifest, sheets, file, read: async () => Object.fromEntries((await readXlsxFile(file)).map(s => [s.sheet, s.data])) };
}

describe('real xlsx output', () => {
  it('writes formula-like names, leading zeros and Unicode as strings, never as formulas', async () => {
    const odd = ['=SUM(A1)', '+1', '-2', '@x', '007', '"q" 🧯 é'];
    const allocations = emptyAlloc();
    odd.forEach((n, i) => { allocations.LS1[i] = n; });
    const { file, read } = await render({
      allocations, customTools: odd.map(name => ({ name, qty: 1, dimensions: '=1+1' })), notes: { LS1: { text: '=HYPERLINK("x")', updatedAt: 1 } },
      unverified: { '=SUM(A1)': '@reason' },
    });
    const zip = unzip(readFileSync(file));
    const sheetXml = Object.entries(zip).filter(([n]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).map(([, b]) => b.toString());
    expect(sheetXml).toHaveLength(8);
    for (const xml of sheetXml) expect(xml).not.toMatch(/<f[\s>/]/);
    const data = await read();
    const names = data['Compartment Inventory'].slice(1).filter(r => r[2] === 'LS1').map(r => r[4]);
    expect(names).toEqual(odd);
    expect(data['Compartment Inventory'][0][0]).toBe('Order');
    expect(data['Compartment Inventory'].slice(1).every(r => typeof r[4] === 'string')).toBe(true);
  });

  it('round-trips every manifest line into Compartment Inventory and the totals into Export Metadata', async () => {
    const allocations = emptyAlloc();
    allocations.LS1[0] = A; allocations.LS1[2] = A; allocations.RS3[0] = B; allocations.RR1[1] = B;
    const { manifest, read } = await render({
      allocations, bundles: { LS1: [{ id: 'b1', name: 'Kit', colorIdx: 0, slotIndices: [0, 2] }] },
      notes: { LS1: { text: 'A note', updatedAt: 1763478245000 } }, unverified: { [B]: 'check size' },
    });
    const data = await read();
    expect(Object.keys(data)).toEqual(['Compartment Inventory', 'Equipment Catalog', 'Compartment Summary', 'Bundles and Kits', 'Notes and Exceptions', 'Export Metadata', 'Compartments', 'Inventory Status']);
    const rows = data['Compartment Inventory'].slice(1);
    const lines = manifest.compartments.flatMap(c => c.items.map(l => ({ c, l })));
    expect(rows).toHaveLength(lines.length);
    for (const { c, l } of lines) {
      const row = rows.find(r => r[2] === c.id && r[5] === l.equipmentId);
      expect(row, l.lineKey).toBeTruthy();
      expect(row[6]).toBe(l.quantity);
      expect(row[7]).toBe(l.slots.map(s => s + 1).join(', '));
      expect(row[8] ?? '').toBe((l.bundles ?? []).map(b => `${b.name} (${b.slots.map(s => s + 1).join(', ')})`).join('; '));
    }
    const meta = Object.fromEntries(data['Export Metadata'].slice(1).map(r => [r[0], r[1]]));
    expect(meta['Total lines']).toBe(manifest.totals.lines);
    expect(meta['Total units']).toBe(manifest.totals.units);
    expect(meta['Needs verification']).toBe(2); // B sits in RS3 and RR1
    expect(meta['Snapshot SHA-256']).toBe(manifest.source.snapshotSha256);
    expect(meta['Planner revision']).toBe(13);
    expect(meta['Units by compartment: LS1']).toBe(2);
    const summary = data['Compartment Summary'].slice(1);
    expect(summary).toHaveLength(11);
    expect(summary.find(r => r[2] === 'RS3')[7]).toBe(PROTECTED_TEXT);
    expect(data['Bundles and Kits'].slice(1).map(r => [r[2], r[5]])).toEqual([['Kit', 1], ['Kit', 3]]);
    expect(data['Notes and Exceptions'].slice(1).some(r => r[0] === 'Compartment note' && r[3] === 'A note')).toBe(true);
  });
});
