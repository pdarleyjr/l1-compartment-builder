import { useCallback, useRef, useState } from 'react';
import exportPlan from './exportExcel.js';
import { ChoiceDialog, DonePanel } from './ExportDialogs.jsx';

/**
 * Export flow state. `start()` runs the export (asking first when unsynced edits exist); render `ui` once in the app.
 * @param {object} sync planner sync state (view, doc, revision, pending)
 */
export default function useExportFlow(sync) {
  const [stage, setStage] = useState(null); // {kind:'choose'} | {kind:'done', result} | {kind:'error', error}
  const syncRef = useRef(sync);
  syncRef.current = sync;

  const run = useCallback(async choice => {
    setStage(null);
    try {
      setStage({ kind: 'done', result: await exportPlan({ sync: syncRef.current, choice }) });
    } catch (err) {
      setStage({ kind: 'error', error: err?.message ?? String(err) });
    }
  }, []);
  const start = useCallback(() => {
    if (syncRef.current.pending > 0) setStage({ kind: 'choose' });
    else run('local');
  }, [run]);
  const close = useCallback(() => setStage(null), []);

  const ui = stage?.kind === 'choose'
    ? <ChoiceDialog pending={sync.pending} revision={sync.revision} canSaved={!!sync.doc} onChoose={run} onClose={close} />
    : stage ? <DonePanel result={stage.result} error={stage.error} onClose={close} /> : null;
  return { start, ui };
}
