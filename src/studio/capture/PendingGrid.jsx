import { useRef } from 'react';
import { Camera, Crop, RotateCw, Trash2 } from 'lucide-react';
import { CATEGORY_HINTS, CATEGORY_OPTIONS } from './categories.js';
import { BTN_ICON, CARD, INPUT } from './styles.js';
import { useObjectUrl } from './useObjectUrl.js';

function PendingCard({ item, index, onCategory, onRotate, onCrop, onRetake, onRemove }) {
  const url = useObjectUrl(item.preview);
  const retake = useRef(null);
  const busy = item.status === 'decoding';
  return (
    <li className={`${CARD} p-2 flex flex-col gap-2 min-w-0`} data-testid="pending-photo">
      <div className="relative bg-slate-100 rounded aspect-[4/3] flex items-center justify-center overflow-hidden">
        {url && !busy ? <img src={url} alt={`Photo ${index + 1}: ${item.name}`} className="max-h-full max-w-full object-contain" /> : null}
        {busy && <span className="text-xs text-slate-500" role="status">Preparing…</span>}
        {item.status === 'error' && <p role="alert" className="text-xs text-red-700 p-2 text-center">{item.error}</p>}
      </div>
      <p className="text-xs text-slate-600 truncate" title={item.name}>{item.name}</p>
      <label className="block">
        <span className="sr-only">Category for {item.name}</span>
        <select value={item.category} onChange={e => onCategory(item.id, e.target.value)} className={INPUT} aria-describedby={`hint-${item.id}`}>
          {CATEGORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      <p id={`hint-${item.id}`} className="text-[11px] text-slate-500 leading-snug">{CATEGORY_HINTS[item.category]}</p>
      <div className="flex flex-wrap items-center justify-between gap-1">
        <button type="button" className={BTN_ICON} onClick={() => onRotate(item)} disabled={item.status !== 'ready'} aria-label={`Rotate ${item.name} 90 degrees`}><RotateCw size={18} aria-hidden="true" /></button>
        <button type="button" className={BTN_ICON} onClick={() => onCrop(item)} disabled={item.status !== 'ready'} aria-label={`Crop ${item.name}`}><Crop size={18} aria-hidden="true" /></button>
        <button type="button" className={BTN_ICON} onClick={() => retake.current?.click()} aria-label={`Retake or replace ${item.name}`}><Camera size={18} aria-hidden="true" /></button>
        <input ref={retake} type="file" accept="image/*,.heic,.heif" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true"
          onChange={e => { const f = e.target.files?.[0]; if (f) onRetake(item.id, f); e.target.value = ''; }} />
        <button type="button" className={`${BTN_ICON} text-red-700`} onClick={() => onRemove(item.id)} aria-label={`Remove ${item.name}`}><Trash2 size={18} aria-hidden="true" /></button>
      </div>
    </li>
  );
}

/** Review grid for pending photos: rotate, crop, retake/replace, remove, per-photo category. */
export function PendingGrid({ items, ...handlers }) {
  return (
    <ul className="grid grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-3 gap-3" aria-label="Photos ready to upload">
      {items.map((item, i) => <PendingCard key={item.id} item={item} index={i} {...handlers} />)}
    </ul>
  );
}
