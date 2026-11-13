import { Check, RotateCcw, X } from 'lucide-react';
import { describeItem, formatBytes, itemPercent } from './queue-status.js';
import { BTN_SECONDARY, CARD } from './styles.js';
import { useObjectUrl } from './useObjectUrl.js';

const TONE = { info: 'text-slate-600', ok: 'text-green-700', warn: 'text-amber-700', error: 'text-red-700' };

function Row({ item, onCancel, onRetry, onRemove, onLink }) {
  const thumb = useObjectUrl(item.thumbBlob);
  const { text, tone } = describeItem(item);
  const pct = itemPercent(item);
  const active = ['queued', 'creating', 'uploading', 'committing'].includes(item.state);
  return (
    <li className={`${CARD} p-2 flex items-center gap-3 min-w-0`} data-testid="upload-row" data-state={item.state}>
      <div className="w-14 h-14 shrink-0 rounded bg-slate-100 overflow-hidden flex items-center justify-center">
        {thumb ? <img src={thumb} alt="" className="w-full h-full object-cover" /> : item.state === 'done' ? <Check className="text-green-600" aria-hidden="true" /> : null}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-800 truncate">{item.label || 'Photo'} <span className="font-normal text-slate-500">· {formatBytes(item.bytes)}</span></p>
        <p className={`text-xs ${TONE[tone]}`}>{text}</p>
        {active && (
          <div role="progressbar" aria-label={`Upload progress for ${item.label || 'photo'}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="mt-1 h-1.5 rounded bg-slate-200 overflow-hidden">
            <div className="h-full bg-red-600 motion-safe:transition-[width]" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <div className="flex flex-col sm:flex-row gap-1 shrink-0">
        {item.state === 'done' && item.asset && onLink && <button type="button" className={BTN_SECONDARY} onClick={() => onLink(item)}>Link tools</button>}
        {item.state === 'failed' && item.retryable && <button type="button" className={BTN_SECONDARY} onClick={() => onRetry(item.id)}><RotateCcw size={14} aria-hidden="true" /> Retry</button>}
        {active && <button type="button" className={BTN_SECONDARY} onClick={() => onCancel(item.id)} aria-label={`Cancel upload of ${item.label || 'photo'}`}><X size={14} aria-hidden="true" /> Cancel</button>}
        {['failed', 'cancelled', 'done'].includes(item.state) && <button type="button" className={BTN_SECONDARY} onClick={() => onRemove(item.id)} aria-label={`Dismiss ${item.label || 'photo'}`}>Dismiss</button>}
      </div>
    </li>
  );
}

/** Upload progress with cancel/retry per photo. */
export function UploadProgressList({ items, ...actions }) {
  if (!items.length) return null;
  return <ul className="flex flex-col gap-2" aria-label="Upload progress">{items.map(i => <Row key={i.id} item={i} {...actions} />)}</ul>;
}
