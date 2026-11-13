import { useState } from 'react';
import { Plus } from 'lucide-react';
import { BTN_SECONDARY, INPUT, LABEL } from '../capture/styles.js';

/**
 * “New tool not in inventory” — same fields as the planner's custom-tool form (name, quantity, dimensions) plus description.
 * @param {{existingNames:string[], onAdd:(t:{name:string, qty:number, dimensions:string, description:string})=>void}} props
 */
export function NewToolForm({ existingNames, onAdd }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [qty, setQty] = useState(1);
  const [dimensions, setDimensions] = useState('');
  const [description, setDescription] = useState('');
  const trimmed = name.trim();
  const duplicate = existingNames.some(n => n.toLowerCase() === trimmed.toLowerCase());

  const add = () => {
    if (!trimmed || duplicate) return;
    onAdd({ name: trimmed, qty: Math.max(1, qty), dimensions: dimensions.trim(), description: description.trim() });
    setName(''); setQty(1); setDimensions(''); setDescription(''); setOpen(false);
  };

  if (!open) return <button type="button" className={BTN_SECONDARY} onClick={() => setOpen(true)} data-testid="assoc-new-tool"><Plus size={16} aria-hidden="true" /> New tool not in inventory</button>;
  return (
    <fieldset className="bg-slate-50 border border-dashed border-slate-300 rounded-lg p-3 flex flex-col gap-3 min-w-0">
      <legend className="text-sm font-bold text-slate-700 px-1">New tool not in inventory</legend>
      <label><span className={LABEL}>Tool name *</span>
        <input className={INPUT} value={name} onChange={e => setName(e.target.value)} aria-invalid={duplicate} data-testid="assoc-new-name" data-autofocus /></label>
      {duplicate && <p role="alert" className="text-sm text-red-700">“{trimmed}” already exists in the inventory — pick it from the list instead.</p>}
      <div className="grid grid-cols-1 min-[420px]:grid-cols-[6rem_1fr] gap-3">
        <label><span className={LABEL}>Quantity</span>
          <input className={`${INPUT} text-center`} type="number" min="1" inputMode="numeric" value={qty} onChange={e => setQty(Math.max(1, parseInt(e.target.value, 10) || 1))} /></label>
        <label><span className={LABEL}>Dimensions (optional)</span>
          <input className={INPUT} value={dimensions} placeholder="e.g. 42.5 × 5.9 × 8.3 in" onChange={e => setDimensions(e.target.value)} /></label>
      </div>
      <label><span className={LABEL}>Description (optional)</span>
        <textarea className={INPUT} rows={2} value={description} onChange={e => setDescription(e.target.value)} /></label>
      <div className="flex gap-2 justify-end">
        <button type="button" className={BTN_SECONDARY} onClick={() => setOpen(false)}>Cancel</button>
        <button type="button" className="touch-target min-h-11 rounded px-4 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:bg-slate-300" disabled={!trimmed || duplicate} onClick={add} data-testid="assoc-new-add">Add tool</button>
      </div>
    </fieldset>
  );
}
