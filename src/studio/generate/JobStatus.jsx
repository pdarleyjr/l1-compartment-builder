import { useEffect, useRef, useState } from 'react';
import { Loader2, RotateCw, XCircle } from 'lucide-react';
import { cancelJob, isActiveJob, jobStatusText, retryJob } from '../../lib/jobs.js';
import { StatusPill } from '../common/badges.jsx';
import { humanError, costLabel } from '../common/format.js';

/** Live status of one job with cancel/retry. @param {{job:object, onChanged?:()=>void, onOpenResult?:(job:object)=>void}} props */
export default function JobStatus({ job, onChanged, onOpenResult }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const active = isActiveJob(job);
  const [elapsed, setElapsed] = useState(0);
  const start = useRef(job.createdAt ?? Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const h = setInterval(() => setElapsed(Math.max(0, Math.round((Date.now() - start.current) / 1000))), 1000);
    return () => clearInterval(h);
  }, [active]);
  const run = async fn => { setBusy(true); setErr(''); try { await fn(); onChanged?.(); } catch (e) { setErr(humanError(e)); } finally { setBusy(false); } };
  return (
    <div data-testid="job-status" data-status={job.status} className="rounded-lg border border-slate-300 bg-white p-3 space-y-2" role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        {active && <Loader2 size={16} className="motion-safe:animate-spin text-red-700" aria-hidden="true" />}
        <p className="text-sm font-semibold text-slate-900 flex-1 min-w-0 break-words">{jobStatusText(job)}</p>
        <StatusPill status={job.status} />
      </div>
      <p className="text-xs text-slate-600">
        {job.preset ?? ''}{job.mode ? ` · ${job.mode}` : ''} {costLabel(job) ? `· ${costLabel(job)}` : ''}{active ? ` · ${elapsed}s` : ''}
      </p>
      {err && <p role="alert" className="text-sm text-red-700">{err}</p>}
      <div className="flex flex-wrap gap-2">
        {active && <button type="button" disabled={busy} onClick={() => run(() => cancelJob(job.id))} className="touch-target px-3 rounded border border-slate-300 text-sm font-semibold flex items-center gap-1 hover:bg-slate-100"><XCircle size={14} /> Cancel</button>}
        {job.status === 'failed' && <button type="button" disabled={busy} onClick={() => run(() => retryJob(job.id))} className="touch-target px-3 rounded bg-slate-800 text-white text-sm font-semibold flex items-center gap-1"><RotateCw size={14} /> Try again</button>}
        {job.status === 'completed' && job.resultVersionId && onOpenResult && <button type="button" onClick={() => onOpenResult(job)} className="touch-target px-3 rounded bg-red-700 text-white text-sm font-bold">Review result</button>}
      </div>
    </div>
  );
}
