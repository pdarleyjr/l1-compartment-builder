import { buildSnapshot } from '../lib/export/snapshot.js';
import { buildManifest } from '../lib/export/manifest.js';
import { buildWorkbookSheets } from '../lib/export/workbook.js';
import { dateStamp, manifestFilename, mergeViewWithDoc, workbookFilename } from '../lib/export/files.js';

/**
 * Build ONE frozen snapshot + manifest from the planner sync state and download the workbook.
 * @param {{sync:{view:object, doc:object|null, revision:number, pending:number}, choice?:'local'|'saved'}} args
 *   choice 'saved' exports the last server doc (syncState 'confirmed'); 'local' (default) exports the local view.
 * @returns {Promise<{snapshot:object, manifest:object, date:string, workbookName:string}>}
 */
export default async function exportPlan({ sync, choice = 'local' }) {
  const saved = choice === 'saved' && sync.doc;
  const dirty = !saved && sync.pending > 0;
  const snapshot = buildSnapshot({
    doc: saved ? sync.doc : mergeViewWithDoc(sync.view, sync.doc),
    revision: sync.revision, pending: dirty ? sync.pending : 0, syncState: dirty ? 'local_changes' : 'confirmed',
    buildSha: import.meta.env?.VITE_BUILD_SHA || 'local', origin: globalThis.location?.origin ?? '', exportedAt: new Date().toISOString(),
  });
  const manifest = buildManifest(snapshot);
  const date = dateStamp();
  const workbookName = workbookFilename(snapshot.source.plannerRevision, date);
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  await writeXlsxFile(buildWorkbookSheets(snapshot, manifest)).toFile(workbookName);
  return { snapshot, manifest, date, workbookName };
}

/** Download the manifest of an export result as JSON (no state is read again). */
export function downloadManifest({ manifest, date }) {
  const blob = new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = manifestFilename(manifest.source.plannerRevision, date);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
