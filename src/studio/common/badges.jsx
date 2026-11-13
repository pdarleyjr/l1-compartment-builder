import { Info, Loader2, CheckCircle2, XCircle, Ban, FileClock, Star } from 'lucide-react';
import { estimateLabel } from './format.js';

const PILLS = {
  draft: ['Draft', 'bg-amber-100 text-amber-900 border-amber-300', FileClock],
  approved: ['Approved', 'bg-green-100 text-green-900 border-green-300', Star],
  rejected: ['Rejected', 'bg-slate-200 text-slate-700 border-slate-300', XCircle],
  deleted: ['Deleted', 'bg-slate-200 text-slate-700 border-slate-300', Ban],
  completed: ['Done', 'bg-green-100 text-green-900 border-green-300', CheckCircle2],
  failed: ['Failed', 'bg-red-100 text-red-900 border-red-300', XCircle],
  cancelled: ['Cancelled', 'bg-slate-200 text-slate-700 border-slate-300', Ban],
};
/** Status chip for versions and jobs. @param {{status:string}} props */
export function StatusPill({ status }) {
  const [label, cls, Icon] = PILLS[status] ?? [status === 'queued' ? 'Queued' : 'Working', 'bg-blue-100 text-blue-900 border-blue-300', Loader2];
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-bold ${cls}`}><Icon size={11} className={Icon === Loader2 ? 'motion-safe:animate-spin' : ''} aria-hidden="true" />{label}</span>;
}

/** "about $0.xx (estimate)" @param {{usd:number|null|undefined, className?:string}} props */
export function EstimateBadge({ usd, className = '' }) {
  return <span className={`inline-flex items-center rounded bg-slate-100 border border-slate-300 px-1.5 py-0.5 text-xs font-semibold text-slate-800 ${className}`}>{estimateLabel(usd)}</span>;
}

/** Non-negotiable label for AI output. */
export function ProvenanceBadge({ compact = false }) {
  return (
    <p role="note" className="flex items-start gap-1.5 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-950">
      <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>{compact ? 'AI concept — planning visualization' : 'AI concept — planning visualization, not a photo of the installed compartment'}</span>
    </p>
  );
}
