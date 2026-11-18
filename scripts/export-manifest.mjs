#!/usr/bin/env node
// Offline snapshot: node scripts/export-manifest.mjs <planner.json> <out-dir> --build-sha <sha> [--origin https://l1.mbfdhub.com]
// <planner.json> is the body of GET /api/public/planner ({doc, revision}) or a bare planner doc. Reuses src/lib/export.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import writeXlsxFile from 'write-excel-file/node';
import { buildSnapshot } from '../src/lib/export/snapshot.js';
import { buildManifest, verifyManifest } from '../src/lib/export/manifest.js';
import { buildWorkbookSheets } from '../src/lib/export/workbook.js';
import { manifestFilename, workbookFilename } from '../src/lib/export/files.js';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); if (i < 0) return undefined; const [, v] = args.splice(i, 2); return v; };
const buildSha = flag('--build-sha');
const origin = flag('--origin') ?? 'https://l1.mbfdhub.com';
const [input, outDir] = args;
if (!input || !outDir || !buildSha) {
  console.error('usage: node scripts/export-manifest.mjs <planner.json> <out-dir> --build-sha <sha> [--origin <url>]');
  process.exit(2);
}

const body = JSON.parse(readFileSync(input, 'utf8'));
const doc = body.doc ?? body;
const snapshot = buildSnapshot({
  doc, revision: Number.isInteger(body.revision) ? body.revision : 0, pending: 0, syncState: 'confirmed', buildSha, origin,
  exportedAt: new Date().toISOString(),
});
const manifest = buildManifest(snapshot);
const check = verifyManifest(manifest);
if (!check.ok) { console.error(`manifest failed verification:\n${check.errors.join('\n')}`); process.exit(1); }

mkdirSync(outDir, { recursive: true });
const rev = snapshot.source.plannerRevision;
const date = snapshot.source.exportedAt.slice(0, 10);
const manifestPath = join(outDir, manifestFilename(rev, date));
const workbookPath = join(outDir, workbookFilename(rev, date));
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await writeXlsxFile(buildWorkbookSheets(snapshot, manifest)).toFile(workbookPath);

console.log(`snapshotSha256 ${manifest.source.snapshotSha256}`);
console.log(`totals ${JSON.stringify(manifest.totals)}`);
console.log(`wrote ${manifestPath}\nwrote ${workbookPath}`);
