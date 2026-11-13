import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { api } from '../../lib/api.js';
import { INSTRUCTIONS_MAX, PRESETS } from '../../../shared/contracts.js';
import { attemptKey, clearAttemptKey, createJob, estimate } from '../../lib/jobs.js';
import { EstimateBadge } from '../common/badges.jsx';
import ConfirmDialog from '../common/ConfirmDialog.jsx';
import { estimateLabel } from '../common/format.js';
import JobStatus from './JobStatus.jsx';
import { buildSummary, classifySubmitError, meterText, needsConfirm, PRESET_INFO, pickMode, renderBody, usageMeters } from './generateModel.js';

function UsageMeter() {
  const [meters, setMeters] = useState([]);
  useEffect(() => { let a = true; api('/usage').then(u => { if (a) setMeters(usageMeters(u)); }).catch(() => {}); return () => { a = false; }; }, []);
  if (!meters.length) return null;
  return (
    <div className="rounded-lg border border-slate-300 bg-white p-3 space-y-1.5" aria-label="AI spending">
      <h4 className="text-xs font-bold uppercase tracking-wide text-slate-600">AI spending</h4>
      {meters.map(m => (
        <div key={m.label}>
          <div className="flex justify-between text-xs text-slate-700"><span>{m.label}</span><span>{meterText(m)}</span></div>
          {m.pct != null && <div className="h-1.5 rounded bg-slate-200" role="progressbar" aria-valuenow={m.pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${m.label} budget used`}><div className={`h-1.5 rounded ${m.pct >= 90 ? 'bg-red-600' : 'bg-green-600'}`} style={{ width: `${m.pct}%` }} /></div>}
        </div>
      ))}
    </div>
  );
}

/**
 * Step 5: choose a preset, see the estimate and what will be rendered, then generate.
 * @param {{compId:string, session:object, data:object, jobsState:{jobs:object[],active:object[],refresh:()=>void}, onOpenResult:(job:object)=>void, onGotoStep:(id:string)=>void}} props
 */
export default function GenerateStep({ compId, session, data, jobsState, onOpenResult, onGotoStep }) {
  const { assets, tools, counts, mounts, geometry } = data;
  const mode = pickMode(assets);
  const [preset, setPreset] = useState('preview');
  const [instructions, setInstructions] = useState('');
  const [estimates, setEstimates] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState(null);
  const [confirm, setConfirm] = useState(null); // {usd}
  const guard = useRef(false);
  const { jobs, active, refresh } = jobsState;
  const summary = useMemo(() => buildSummary({ tools, counts, assets, mounts, geometry }), [tools, counts, assets, mounts, geometry]);
  const aiOff = session && session.aiEnabled === false;

  useEffect(() => {
    let alive = true; const ctrl = new AbortController(); setEstimates({});
    PRESETS.forEach(p => estimate(compId, renderBody({ mode, preset: p }), ctrl.signal)
      .then(r => { if (alive) setEstimates(e => ({ ...e, [p]: r })); }).catch(() => {}));
    return () => { alive = false; ctrl.abort(); };
  }, [compId, mode]);

  const submit = async (confirmUsd) => {
    if (guard.current) return; // double-tap safe: one in-flight submit, and the key is persisted per attempt
    guard.current = true; setSubmitting(true); setProblem(null);
    const base = renderBody({ mode, preset, instructions });
    const key = attemptKey(compId, base);
    try {
      const body = confirmUsd != null ? { ...base, confirmEstimateUsd: confirmUsd } : base;
      await createJob(compId, body, key);
      clearAttemptKey(compId, base); setConfirm(null); refresh();
    } catch (e) {
      const c = classifySubmitError(e);
      if (c.kind === 'confirm') setConfirm({ usd: c.estimateUsd ?? estimates[preset]?.usd });
      else setProblem(c);
    } finally { guard.current = false; setSubmitting(false); }
  };
  const onGenerate = () => {
    const est = estimates[preset];
    if (needsConfirm(preset, est) && est?.usd != null) setConfirm({ usd: est.usd }); else submit();
  };

  const recent = jobs.filter(j => j.kind === 'render' || !j.kind).slice(0, 3);
  return (
    <div className="p-3 sm:p-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]" data-testid="generate-step">
      <div className="space-y-4 min-w-0">
        <fieldset>
          <legend className="font-bold text-slate-900 mb-1.5">Quality</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {PRESETS.map(p => (
              <label key={p} data-testid={`gen-preset-${p}`} className={`cursor-pointer rounded-lg border-2 p-3 min-h-[44px] ${preset === p ? 'border-red-700 bg-red-50' : 'border-slate-300 bg-white hover:border-slate-500'}`}>
                <input type="radio" name="preset" value={p} checked={preset === p} onChange={() => setPreset(p)} className="sr-only" />
                <span className="block font-bold text-slate-900">{PRESET_INFO[p].label}</span>
                <span className="block text-xs text-slate-600">{PRESET_INFO[p].blurb}</span>
                <span className="block mt-1.5 text-xs font-semibold text-slate-800">{estimates[p] ? estimateLabel(estimates[p].usd) : 'Estimating…'}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <section className="rounded-lg border border-slate-300 bg-white p-3 space-y-1.5 text-sm" aria-label="What will be rendered">
          <h3 className="font-bold text-slate-900">What will be rendered</h3>
          <p className="text-slate-700">Mode: <b>{mode === 'reference' ? 'Using your photos as references' : 'Plan-only (no tool photos yet)'}</b></p>
          <p className="text-slate-700">{summary.toolCount} item{summary.toolCount === 1 ? '' : 's'} ({summary.toolKinds} kind{summary.toolKinds === 1 ? '' : 's'}), {summary.refPhotos} photo{summary.refPhotos === 1 ? '' : 's'}, {summary.mountCount} mount{summary.mountCount === 1 ? '' : 's'}</p>
          {tools.length > 0 && <ul className="text-xs text-slate-700 columns-1 sm:columns-2 gap-4">{tools.map(t => <li key={t.ref} className="break-words">{t.qty}× {t.name}{!counts[t.ref] && <span className="text-amber-800"> (no photo)</span>}</li>)}</ul>}
          {summary.warnings.map(w => <p key={w} className="flex items-start gap-1.5 text-xs text-amber-950 bg-amber-50 border border-amber-300 rounded px-2 py-1"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{w}</p>)}
          {summary.withoutPhotos.length > 0 && <button type="button" onClick={() => onGotoStep('tools')} className="touch-target text-xs font-semibold text-red-700 underline">Add photos for these tools</button>}
        </section>

        <label className="block text-sm font-semibold text-slate-800">Instructions (optional)
          <textarea value={instructions} maxLength={INSTRUCTIONS_MAX} rows={3} onChange={e => setInstructions(e.target.value)} data-testid="gen-instructions"
            className="mt-1 w-full border border-slate-300 rounded p-2 text-sm font-normal" placeholder="e.g. Show the door open, shelves slightly pulled out." />
          <span className="text-xs font-normal text-slate-500">{instructions.length}/{INSTRUCTIONS_MAX}</span>
        </label>

        {aiOff && <p role="status" className="text-sm rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-amber-950">AI image generation is currently turned off. You can keep preparing; an admin can turn it on.</p>}
        {problem && <p role="alert" data-testid="gen-error" className="text-sm rounded border border-red-300 bg-red-50 px-2 py-1.5 text-red-900">{problem.message}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={onGenerate} disabled={submitting || !tools.length} data-testid="gen-submit"
            className="touch-target px-5 rounded-lg bg-red-700 hover:bg-red-800 disabled:opacity-50 text-white font-bold flex items-center gap-2"><Sparkles size={16} /> {submitting ? 'Starting…' : 'Generate image'}</button>
          {estimates[preset] && <EstimateBadge usd={estimates[preset].usd} />}
        </div>
      </div>

      <aside className="space-y-3 min-w-0">
        {active.length > 0 && <h3 className="font-bold text-slate-900 text-sm">In progress</h3>}
        {(active.length ? active : recent).map(j => <JobStatus key={j.id} job={j} onChanged={refresh} onOpenResult={onOpenResult} />)}
        <UsageMeter />
      </aside>

      <ConfirmDialog open={!!confirm} title="Confirm cost" confirmLabel="Generate" testId="gen-confirm"
        message={<p>This will cost {confirm?.usd != null ? <b>{estimateLabel(confirm.usd)}</b> : 'more than a normal preview'}. The final cost is shown on the image once it is done.</p>}
        onConfirm={() => submit(confirm?.usd ?? estimates[preset]?.usd)} onCancel={() => setConfirm(null)} />
    </div>
  );
}
