import { useEffect, useRef } from 'react';
import { Download, X } from 'lucide-react';
import { downloadManifest } from './exportExcel.js';

const BTN = 'touch-target min-h-11 rounded px-4 py-2.5 text-sm font-medium text-left';
const FOCUSABLE = 'button:not([disabled])';

/** Accessible modal: role=dialog, focus trapped, Escape closes, focus restored on close. */
export function ChoiceDialog({ pending, revision, canSaved, onChoose, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector(FOCUSABLE)?.focus();
    return () => previous?.focus?.();
  }, []);
  const onKeyDown = e => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key !== 'Tab') return;
    const items = [...ref.current.querySelectorAll(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/60 p-4 print:hidden">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="export-choice-title" onKeyDown={onKeyDown}
        className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
        <h2 id="export-choice-title" className="text-base font-bold text-slate-900">Some changes are not saved to the team plan yet</h2>
        <div className="mt-4 flex flex-col gap-2">
          <button type="button" onClick={() => onChoose('local')} className={`${BTN} bg-green-700 text-white hover:bg-green-600`}>
            Export what you see (includes {pending} change{pending === 1 ? '' : 's'} not yet saved to the team plan)
          </button>
          <button type="button" disabled={!canSaved} onClick={() => onChoose('saved')} className={`${BTN} border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:opacity-50`}>
            Export the last saved team plan (revision {revision})
          </button>
          <button type="button" onClick={onClose} className={`${BTN} text-slate-700 hover:bg-slate-100`}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export function DonePanel({ result, error, onClose }) {
  if (error) {
    return (
      <div role="alert" className="fixed bottom-4 right-4 z-[70] max-w-sm rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 shadow-lg print:hidden">
        Export failed: {error}
        <button type="button" onClick={onClose} className="touch-target ml-2 min-h-11 underline">Dismiss</button>
      </div>
    );
  }
  const sha = result.manifest.source.snapshotSha256;
  return (
    <section role="region" aria-label="Export complete" data-testid="export-done"
      className="fixed bottom-4 right-4 z-[70] w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-lg print:hidden">
      <div className="flex items-start justify-between gap-2">
        <p role="status" className="font-medium text-slate-900">
          Workbook downloaded · snapshot <span data-testid="export-snapshot-hash" title={sha}>{sha.slice(0, 12)}</span>
        </p>
        <button type="button" aria-label="Close export panel" onClick={onClose} className="touch-target flex min-h-11 min-w-11 items-center justify-center rounded text-slate-600 hover:bg-slate-100">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <button type="button" onClick={() => downloadManifest(result)}
        className="touch-target mt-2 flex min-h-11 items-center gap-1.5 rounded bg-slate-800 px-3 py-2 text-sm text-white hover:bg-slate-700">
        <Download size={14} aria-hidden="true" /> Download checklist transfer file (JSON)
      </button>
    </section>
  );
}
