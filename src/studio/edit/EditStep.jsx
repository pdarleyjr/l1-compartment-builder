import { useEffect, useMemo, useRef, useState } from 'react';
import { ImageIcon, Wand2 } from 'lucide-react';
import { INSTRUCTIONS_MAX, PRESETS } from '../../../shared/contracts.js';
import { AssetLibrary } from '../capture/index.js';
import { attemptKey, clearAttemptKey, createJob, estimate } from '../../lib/jobs.js';
import { EstimateBadge, ProvenanceBadge } from '../common/badges.jsx';
import ConfirmDialog from '../common/ConfirmDialog.jsx';
import Dialog from '../common/Dialog.jsx';
import { estimateLabel, humanError } from '../common/format.js';
import { classifySubmitError, needsConfirm, PRESET_INFO } from '../generate/generateModel.js';
import JobStatus from '../generate/JobStatus.jsx';
import MarkupCanvas from './MarkupCanvas.jsx';
import { EXAMPLE_CHIPS } from './markupModel.js';
import { uploadMarkup } from './markupUpload.js';

/**
 * Step 6b: edit a chosen version with words and optional markup; creates an `edit` job whose parent is that version.
 * @param {{compId:string, session:object, plannerDoc:object, jobsState:{jobs:object[],active:object[],refresh:()=>void}, version:object|null, versionLabel:string, onOpenResult:(job:object)=>void, onPickVersion:()=>void}} props
 */
export default function EditStep({ compId, session, plannerDoc, jobsState, version, versionLabel, onOpenResult, onPickVersion }) {
  const [text, setText] = useState('');
  const [preset, setPreset] = useState('preview');
  const [est, setEst] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [pickRef, setPickRef] = useState(false);
  const [refAsset, setRefAsset] = useState(null);
  const canvas = useRef(null);
  const guard = useRef(false);
  const { jobs, active, refresh } = jobsState;
  const parentId = version?.id ?? null;

  useEffect(() => {
    if (!parentId) return undefined;
    let alive = true; setEst(null);
    estimate(compId, { kind: 'render', mode: 'edit', preset, parentVersionId: parentId }).then(r => { if (alive) setEst(r); }).catch(() => {});
    return () => { alive = false; };
  }, [compId, preset, parentId]);

  const base = useMemo(() => ({ kind: 'render', mode: 'edit', preset, parentVersionId: parentId, instructions: text.trim() || undefined, referenceAssetId: refAsset?.id }), [preset, parentId, text, refAsset]);

  const submit = async confirmUsd => {
    if (guard.current || !parentId) return;
    guard.current = true; setBusy(true); setProblem('');
    const key = attemptKey(compId, base);
    try {
      const mk = await canvas.current?.export();
      if (!text.trim() && !mk && !refAsset) { setProblem('Describe the change, draw on the image, or pick a replacement photo first.'); return; }
      const markupAssetId = mk ? await uploadMarkup({ compId, png: mk.png, width: mk.width, height: mk.height, idempotencyKey: `${key}_mk` }) : undefined;
      const body = { ...base, ...(markupAssetId ? { markupAssetId } : {}), ...(confirmUsd != null ? { confirmEstimateUsd: confirmUsd } : {}) };
      await createJob(compId, body, key);
      clearAttemptKey(compId, base); setConfirm(null); setText(''); refresh();
    } catch (e) {
      const c = classifySubmitError(e);
      if (c.kind === 'confirm') setConfirm({ usd: c.estimateUsd ?? est?.usd }); else setProblem(c.kind === 'error' && !e.status ? humanError(e) : c.message);
    } finally { guard.current = false; setBusy(false); }
  };
  const onSubmit = () => (needsConfirm(preset, est) && est?.usd != null ? setConfirm({ usd: est.usd }) : submit());

  if (!version) return (
    <div className="p-6 text-center space-y-3" data-testid="edit-empty"><p className="font-semibold text-slate-800">Pick a version to edit first.</p>
      <button type="button" onClick={onPickVersion} className="touch-target px-4 rounded bg-red-700 text-white font-bold">Go to Review</button></div>
  );
  return (
    <div className="p-3 sm:p-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]" data-testid="edit-step">
      <section className="min-w-0 space-y-2">
        <h3 className="font-bold text-slate-900">Editing {versionLabel}</h3>
        <MarkupCanvas ref={canvas} src={version.variants?.display} alt={`Version ${versionLabel} to edit`} />
        <p className="text-xs text-slate-600">Region edits are best-effort: the markup guides the change but the result may differ slightly. Check the new draft carefully.</p>
        <ProvenanceBadge compact />
      </section>
      <section className="min-w-0 space-y-3">
        <label className="block text-sm font-semibold text-slate-800">What should change?
          <textarea value={text} maxLength={INSTRUCTIONS_MAX} rows={4} onChange={e => setText(e.target.value)} data-testid="edit-instructions"
            className="mt-1 w-full border border-slate-300 rounded p-2 text-sm font-normal" placeholder="Describe the change in plain words." />
          <span className="text-xs font-normal text-slate-500">{text.length}/{INSTRUCTIONS_MAX}</span>
        </label>
        <div className="flex flex-wrap gap-1.5" aria-label="Examples">
          {EXAMPLE_CHIPS.map(c => <button key={c} type="button" onClick={() => setText(t => (t ? `${t.trimEnd()} ${c}` : c))} className="touch-target px-2.5 rounded-full border border-slate-300 text-xs text-slate-800 hover:bg-slate-100 text-left">{c}</button>)}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button type="button" onClick={() => setPickRef(true)} className="touch-target px-3 rounded border border-slate-300 font-semibold flex items-center gap-1.5 hover:bg-slate-100"><ImageIcon size={14} /> {refAsset ? 'Change reference photo' : 'Replace reference photo'}</button>
          {refAsset && <><span className="text-xs text-slate-700 truncate max-w-[10rem]">{refAsset.title || refAsset.id}</span><button type="button" onClick={() => setRefAsset(null)} className="touch-target text-xs underline">Remove</button></>}
        </div>
        <fieldset><legend className="text-sm font-semibold text-slate-800 mb-1">Quality</legend>
          <div className="flex flex-wrap gap-1.5">{PRESETS.map(p => <label key={p} data-testid={`gen-preset-${p}`} className={`touch-target px-3 rounded border-2 text-sm font-semibold flex items-center cursor-pointer ${preset === p ? 'border-red-700 bg-red-50' : 'border-slate-300'}`}><input type="radio" name="edit-preset" className="sr-only" checked={preset === p} onChange={() => setPreset(p)} />{PRESET_INFO[p].label}</label>)}</div>
        </fieldset>
        {problem && <p role="alert" className="text-sm rounded border border-red-300 bg-red-50 px-2 py-1.5 text-red-900">{problem}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={onSubmit} disabled={busy} data-testid="edit-submit" className="touch-target px-5 rounded-lg bg-red-700 hover:bg-red-800 disabled:opacity-50 text-white font-bold flex items-center gap-2"><Wand2 size={16} /> {busy ? 'Starting…' : 'Create edited version'}</button>
          {est && <EstimateBadge usd={est.usd} />}
        </div>
        {(active.length ? active : jobs.filter(j => j.mode === 'edit').slice(0, 1)).map(j => <JobStatus key={j.id} job={j} onChanged={refresh} onOpenResult={onOpenResult} />)}
      </section>
      <Dialog open={pickRef} title="Choose a reference photo" variant="sheet" onClose={() => setPickRef(false)}>
        <AssetLibrary compId={compId} session={session} plannerDoc={plannerDoc} selectable onSelect={a => { setRefAsset(a); setPickRef(false); }} />
      </Dialog>
      <ConfirmDialog open={!!confirm} title="Confirm cost" confirmLabel="Create version" message={<p>This will cost {confirm?.usd != null ? <b>{estimateLabel(confirm.usd)}</b> : 'more than a normal preview'}.</p>}
        onConfirm={() => submit(confirm?.usd ?? est?.usd)} onCancel={() => setConfirm(null)} />
    </div>
  );
}
