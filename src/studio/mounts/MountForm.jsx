import { useMemo, useState } from 'react';
import { Camera } from 'lucide-react';
import { DEFAULT_ZONES, ORIENTATIONS } from '../../../shared/contracts.js';
import { effectiveInventory, compartmentAssignments } from '../../../shared/planner.js';
import { CapturePanel } from '../capture/CapturePanel.jsx';
import { BTN_PRIMARY, BTN_SECONDARY, ERROR_TEXT, INPUT, LABEL } from '../capture/styles.js';
import { useAssets } from '../library/useAssets.js';
import { CLASSIFICATION_INFO, MOUNT_CLASSIFICATIONS, MOUNT_STATUSES, ORIENTATION_LABELS, STATUS_LABELS, validateMountForm } from './mount-constants.js';

const safe = (fn, fb) => { try { return fn(); } catch { return fb; } };
const zoneLabel = z => z.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

function ToolPicker({ rows, value, onChange }) {
  const [q, setQ] = useState('');
  const shown = rows.filter(r => r.name.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = id => onChange(value.includes(id) ? value.filter(v => v !== id) : [...value, id]);
  return (
    <fieldset className="min-w-0">
      <legend className={LABEL}>Tools carried by this mount</legend>
      <input type="search" className={`${INPUT} mb-2`} placeholder="Search tools" aria-label="Search tools" value={q} onChange={e => setQ(e.target.value)} />
      <ul className="max-h-48 overflow-y-auto border border-slate-200 rounded divide-y divide-slate-100">
        {shown.map(r => (
          <li key={r.equipmentId}><label className="touch-target min-h-11 flex items-center gap-2 px-2 cursor-pointer">
            <input type="checkbox" className="w-5 h-5 accent-red-600" checked={value.includes(r.equipmentId)} onChange={() => toggle(r.equipmentId)} />
            <span className="text-sm text-slate-800 break-words min-w-0">{r.name}</span>{r.here && <span className="ml-auto text-[11px] text-slate-500 shrink-0">in this compartment</span>}
          </label></li>
        ))}
        {!shown.length && <li className="p-3 text-sm text-slate-500">No matching tools.</li>}
      </ul>
      <p className="text-xs text-slate-500 mt-1">{value.length} selected</p>
    </fieldset>
  );
}

/**
 * Create/edit form for a mount.
 * @param {{compId:string, session:object, plannerDoc:object|null, form:object, setForm:(f:object)=>void, saving:boolean, error:string,
 *   onSave:()=>void, onCancel:()=>void}} props
 */
export function MountForm({ compId, session, plannerDoc, plannerRevision, form, setForm, saving, error, onSave, onCancel }) {
  const [capture, setCapture] = useState(false);
  const [pick, setPick] = useState(false);
  const { assets } = useAssets(compId);
  const rows = useMemo(() => {
    const here = new Set(safe(() => compartmentAssignments(plannerDoc, compId), []).map(r => r.equipmentId));
    const all = safe(() => effectiveInventory(plannerDoc), []).filter(r => r.equipmentId).map(r => ({ equipmentId: r.equipmentId, name: r.name, here: here.has(r.equipmentId) }));
    return all.sort((a, b) => Number(b.here) - Number(a.here) || a.name.localeCompare(b.name));
  }, [plannerDoc, compId]);
  const set = k => e => setForm({ ...form, [k]: e.target.value });
  const photo = assets.find(a => a.id === form.assetId);
  const problem = validateMountForm(form);
  const zones = form.zone && !DEFAULT_ZONES.includes(form.zone) ? [form.zone, ...DEFAULT_ZONES] : DEFAULT_ZONES;

  return (
    <form className="flex flex-col gap-3 min-w-0" onSubmit={e => { e.preventDefault(); onSave(); }} data-testid="mount-form">
      <label><span className={LABEL}>Name *</span><input className={INPUT} value={form.name} onChange={set('name')} data-testid="mount-name" required /></label>
      <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-3">
        <label><span className={LABEL}>Manufacturer</span><input className={INPUT} value={form.manufacturer} onChange={set('manufacturer')} /></label>
        <label><span className={LABEL}>Model</span><input className={INPUT} value={form.model} onChange={set('model')} /></label>
      </div>
      <label><span className={LABEL}>Description</span><textarea className={INPUT} rows={2} value={form.description} onChange={set('description')} /></label>
      <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-3">
        <label><span className={LABEL}>Dimensions</span><input className={INPUT} value={form.dimensions} placeholder="e.g. 12 × 4 × 6 in" onChange={set('dimensions')} /></label>
        <label><span className={LABEL}>Capacity (tools held)</span><input className={INPUT} type="number" min="0" inputMode="numeric" value={form.capacity} onChange={set('capacity')} /></label>
        <label><span className={LABEL}>Orientation</span>
          <select className={INPUT} value={form.orientation} onChange={set('orientation')}><option value="">Not set</option>{ORIENTATIONS.map(o => <option key={o} value={o}>{ORIENTATION_LABELS[o]}</option>)}</select></label>
        <label><span className={LABEL}>Zone</span>
          <select className={INPUT} value={form.zone} onChange={set('zone')}><option value="">Not set</option>{zones.map(z => <option key={z} value={z}>{zoneLabel(z)}</option>)}</select></label>
      </div>
      <fieldset>
        <legend className={LABEL}>Classification</legend>
        <div className="flex flex-col gap-1">
          {MOUNT_CLASSIFICATIONS.map(c => (
            <label key={c} className="touch-target min-h-11 flex items-start gap-2 rounded border border-slate-200 p-2 cursor-pointer has-[:checked]:border-red-500 has-[:checked]:bg-red-50">
              <input type="radio" name="mount-classification" className="mt-1 w-4 h-4 accent-red-600" checked={form.classification === c} onChange={() => setForm({ ...form, classification: c })} />
              <span><span className="block text-sm font-medium text-slate-800">{CLASSIFICATION_INFO[c].label}</span><span className="block text-xs text-slate-500">{CLASSIFICATION_INFO[c].help}</span></span>
            </label>
          ))}
        </div>
      </fieldset>
      {form.classification === 'inventory' && (
        <label><span className={LABEL}>Inventory item *</span>
          <select className={INPUT} value={form.equipmentId} onChange={set('equipmentId')} data-testid="mount-equipment" required>
            <option value="">Choose the inventory item…</option>{rows.map(r => <option key={r.equipmentId} value={r.equipmentId}>{r.name}</option>)}</select></label>
      )}
      <label><span className={LABEL}>Status</span>
        <select className={INPUT} value={form.status} onChange={set('status')}>{MOUNT_STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}</select></label>

      <section aria-label="Mount photo" className="flex flex-col gap-2">
        <span className={LABEL}>Photo</span>
        {photo?.variants?.thumb && <img src={photo.variants.thumb} alt={photo.title || 'Mount photo'} className="w-24 h-24 object-cover rounded border border-slate-200" />}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BTN_SECONDARY} onClick={() => setPick(p => !p)} aria-expanded={pick}>Choose from library</button>
          <button type="button" className={BTN_SECONDARY} onClick={() => setCapture(c => !c)} aria-expanded={capture}><Camera size={16} aria-hidden="true" /> Take or upload photo</button>
          {form.assetId && <button type="button" className={BTN_SECONDARY} onClick={() => setForm({ ...form, assetId: null })}>Remove photo</button>}
        </div>
        {pick && (
          <ul className="grid grid-cols-3 min-[480px]:grid-cols-4 gap-2" aria-label="Library photos">
            {assets.filter(a => ['mount', 'other', 'arrangement', 'compartment'].includes(a.category)).map(a => (
              <li key={a.id}><button type="button" aria-pressed={form.assetId === a.id} onClick={() => { setForm({ ...form, assetId: a.id }); setPick(false); }}
                className={`w-full aspect-square rounded overflow-hidden border-2 ${form.assetId === a.id ? 'border-red-600' : 'border-slate-200'}`}>
                {a.variants?.thumb && <img src={a.variants.thumb} alt={a.title || a.category} loading="lazy" className="w-full h-full object-cover" />}</button></li>
            ))}
          </ul>
        )}
        {capture && <CapturePanel compId={compId} session={session} plannerDoc={plannerDoc} plannerRevision={plannerRevision} defaultCategory="mount"
          onAssetsCommitted={list => { if (list[0]) { setForm({ ...form, assetId: list[0].id }); setCapture(false); } }} />}
      </section>

      <ToolPicker rows={rows} value={form.equipmentIds} onChange={ids => setForm({ ...form, equipmentIds: ids })} />
      {(error || problem) && <p role="alert" className={ERROR_TEXT}>{error || problem}</p>}
      <div className="flex gap-2 justify-end">
        <button type="button" className={BTN_SECONDARY} onClick={onCancel}>Cancel</button>
        <button type="submit" className={BTN_PRIMARY} data-testid="mount-save" disabled={saving || !!problem}>{saving ? 'Saving…' : 'Save mount'}</button>
      </div>
    </form>
  );
}
