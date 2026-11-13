import { Check, Minus, Plus } from 'lucide-react';
import { BTN_ICON } from '../capture/styles.js';
import { maxQuantity, rowKey } from './association-summary.js';

function Stepper({ name, value, max, onChange }) {
  return (
    <div className="flex items-center" role="group" aria-label={`Quantity of ${name}`}>
      <button type="button" className={BTN_ICON} onClick={() => onChange(value - 1)} disabled={value <= 1} aria-label={`Decrease quantity of ${name}`}><Minus size={16} aria-hidden="true" /></button>
      <span className="min-w-8 text-center text-sm font-semibold tabular-nums" aria-live="polite">{value}</span>
      <button type="button" className={BTN_ICON} onClick={() => onChange(value + 1)} disabled={value >= max} aria-label={`Increase quantity of ${name}`}><Plus size={16} aria-hidden="true" /></button>
    </div>
  );
}

function Row({ row, group, selected, multi, onToggle, onQty }) {
  const key = rowKey(row);
  const sel = selected.get(key);
  const disabled = group === 'unavailable';
  const detail = group === 'assigned' ? `${row.assignmentIds?.length ?? row.assignedHere ?? 1} assigned here${row.free ? ` · ${row.free} more available` : ''}`
    : group === 'available' ? `${row.free} available` : 'No free units — all assigned elsewhere';
  return (
    <li className={`flex items-center gap-2 rounded border px-2 ${sel ? 'border-red-500 bg-red-50' : 'border-slate-200 bg-white'} ${disabled ? 'opacity-60' : ''}`}>
      <button type="button" disabled={disabled} onClick={() => onToggle(row)} aria-pressed={!!sel}
        className="touch-target min-h-11 flex-1 min-w-0 flex items-center gap-2 text-left py-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 rounded" data-testid="assoc-row">
        <span className={`w-5 h-5 shrink-0 rounded ${multi ? '' : 'rounded-full'} border flex items-center justify-center ${sel ? 'bg-red-600 border-red-600 text-white' : 'border-slate-400'}`} aria-hidden="true">{sel && <Check size={12} />}</span>
        <span className="min-w-0"><span className="block text-sm font-medium text-slate-800 break-words">{row.name}</span><span className="block text-xs text-slate-500">{detail}</span></span>
      </button>
      {sel && multi && <Stepper name={row.name} value={sel.quantity} max={maxQuantity(row)} onChange={q => onQty(key, Math.min(maxQuantity(row), Math.max(1, q)))} />}
    </li>
  );
}

/** Candidate rows grouped “Already in <comp>”, “Available in inventory”, “Not available (assigned elsewhere)”. */
export function CandidateList({ compId, candidates, selected, multi, onToggle, onQty }) {
  const groups = [['assigned', `Already in ${compId}`], ['available', 'Available in inventory'], ['unavailable', 'Not available (assigned elsewhere)']];
  const any = groups.some(([g]) => candidates?.[g]?.length);
  if (!any) return <p className="text-sm text-slate-500" role="status">No matching tools. Try a different word, or add a new tool below.</p>;
  return (
    <div className="flex flex-col gap-3">
      {groups.map(([g, title]) => (candidates?.[g]?.length ? (
        <section key={g} aria-label={title}>
          <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">{title}</h4>
          <ul className="flex flex-col gap-1">{candidates[g].map(r => <Row key={rowKey(r)} row={r} group={g} selected={selected} multi={multi} onToggle={onToggle} onQty={onQty} />)}</ul>
        </section>
      ) : null))}
    </div>
  );
}
