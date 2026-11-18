import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyManifest } from '../../src/lib/export/manifest.js';
import { A, baseDoc, emptyAlloc } from './helpers.js';

describe('scripts/export-manifest.mjs', () => {
  it('writes the manifest and workbook from a planner.json and the manifest verifies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'l1s-'));
    const allocations = emptyAlloc();
    allocations.LS1[0] = A;
    const input = join(dir, 'planner.json');
    writeFileSync(input, JSON.stringify({ doc: baseDoc({ allocations }), revision: 7 }));
    const out = join(dir, 'out');
    execFileSync(process.execPath, ['scripts/export-manifest.mjs', input, out, '--build-sha', 'abc'], { stdio: 'pipe' });
    const files = readdirSync(out);
    expect(files.some(f => f.endsWith('.json'))).toBe(true);
    expect(files.some(f => f.endsWith('.xlsx'))).toBe(true);
    const m = JSON.parse(readFileSync(join(out, files.find(f => f.endsWith('.json'))), 'utf8'));
    expect(verifyManifest(m)).toEqual({ ok: true, errors: [] });
    expect(m.totals.units).toBe(1);
  });
});
