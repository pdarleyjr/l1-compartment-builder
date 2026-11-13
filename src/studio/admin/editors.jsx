import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { COMPARTMENT_IDS, DEFAULT_ZONES, IMAGE_COMPLEXITIES, IMAGE_MODELS, IMAGE_QUALITIES, PRESETS } from '../../../shared/contracts.js';
import { zoneLabel } from '../layout/layoutModel.js';
import { OUTPUT_FORMATS, OVERRIDE_ORIENTATIONS, SPEC_TEXT_MAX } from './settingsModel.js';

const input = 'touch-target border border-slate-300 rounded px-2 text-sm bg-white w-full min-w-0';
const numVal = e => (e.target.value === '' ? null : Number(e.target.value));

function Select({ label, value, options, onChange }) {
  return (
    <label className="text-xs text-slate-600 flex flex-col min-w-0">{label}
      <select value={value ?? ''} onChange={e => onChange(e.target.value)} className={input}>{options.map(o => <option key={o} value={o}>{o}</option>)}</select>
    </label>
  );
}

/** Typed editor dispatcher. @param {{meta:object, value:any, onChange:(v:any)=>void, id:string}} props */
export function FieldEditor({ meta, value, onChange, id }) {
  switch (meta.type) {
    case 'boolean':
      return (
        <label className="touch-target inline-flex items-center gap-2 text-sm font-semibold text-slate-900">
          <input id={id} type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} className="w-5 h-5 accent-red-700" /> {value ? 'On' : 'Off'}
        </label>
      );
    case 'number':
      return <input id={id} type="number" inputMode="decimal" min={meta.min} max={meta.max} step={meta.step} value={value ?? ''} onChange={e => onChange(numVal(e))} className={`${input} max-w-[10rem]`} />;
    case 'text': return <input id={id} type="text" value={value ?? ''} maxLength={meta.maxLength} onChange={e => onChange(e.target.value)} className={input} />;
    case 'textarea':
      return (<div><textarea id={id} rows={6} value={value ?? ''} onChange={e => onChange(e.target.value)} className="w-full border border-slate-300 rounded p-2 text-sm" />
        <p className="text-xs text-slate-500">{(value ?? '').length}/{meta.maxLength}</p></div>);
    case 'emails': return <EmailsEditor value={value ?? []} onChange={onChange} id={id} />;
    case 'presets': return <PresetsEditor value={value} onChange={onChange} />;
    case 'pricing': return <PricingEditor value={value} onChange={onChange} />;
    case 'overrides': return <OverridesEditor value={value ?? {}} onChange={onChange} />;
    default: return null;
  }
}

function EmailsEditor({ value, onChange, id }) {
  const [draft, setDraft] = useState('');
  const add = () => { const v = draft.trim(); if (v) { onChange([...value, v]); setDraft(''); } };
  return (
    <div className="space-y-2">
      <ul className="space-y-1">{value.map((e, i) => (
        <li key={`${e}${i}`} className="flex items-center gap-2 text-sm"><span className="flex-1 min-w-0 truncate">{e}</span>
          <button type="button" aria-label={`Remove ${e}`} onClick={() => onChange(value.filter((_, j) => j !== i))} className="touch-target flex items-center justify-center text-red-700"><Trash2 size={16} /></button></li>))}
      </ul>
      <div className="flex gap-2"><input id={id} type="email" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} placeholder="name@example.com" className={input} />
        <button type="button" onClick={add} className="touch-target px-3 rounded bg-slate-800 text-white text-sm font-semibold flex items-center gap-1"><Plus size={14} /> Add</button></div>
    </div>
  );
}

function PresetsEditor({ value, onChange }) {
  const set = (p, patch) => onChange({ ...value, [p]: { ...value[p], ...patch } });
  return (
    <div className="space-y-3">{PRESETS.map(p => value?.[p] && (
      <fieldset key={p} className="border border-slate-300 rounded-lg p-2 grid gap-2 sm:grid-cols-2">
        <legend className="px-1 text-sm font-bold">{p}</legend>
        <Select label="Model" value={value[p].model} options={IMAGE_MODELS} onChange={v => set(p, { model: v })} />
        <Select label="Quality" value={value[p].quality} options={IMAGE_QUALITIES} onChange={v => set(p, { quality: v })} />
        <Select label="Complexity" value={value[p].complexity} options={IMAGE_COMPLEXITIES} onChange={v => set(p, { complexity: v })} />
        <Select label="Format" value={value[p].outputFormat} options={OUTPUT_FORMATS} onChange={v => set(p, { outputFormat: v })} />
        <label className="touch-target inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={!!value[p].confirm} onChange={e => set(p, { confirm: e.target.checked })} className="w-5 h-5 accent-red-700" /> Ask for cost confirmation</label>
      </fieldset>))}
    </div>
  );
}

function PricingEditor({ value, onChange }) {
  const setNum = (path, n) => {
    const [a, b] = path; const next = { ...value };
    if (b === undefined) next[a] = n; else next[a] = { ...value[a], [b]: n };
    onChange(next);
  };
  const groups = Object.entries(value ?? {}).filter(([, v]) => v && typeof v === 'object');
  const scalars = Object.entries(value ?? {}).filter(([, v]) => !(v && typeof v === 'object'));
  return (
    <div className="space-y-3">
      {groups.map(([k, v]) => (
        <fieldset key={k} className="border border-slate-300 rounded-lg p-2">
          <legend className="px-1 text-sm font-bold break-all">{k === 'estimatedOutputTokensPerMegapixel' ? 'Estimated output tokens per megapixel' : k}</legend>
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-3">
            {Object.entries(v).map(([f, n]) => (
              <label key={f} className="text-xs text-slate-600 flex flex-col min-w-0">{f}
                <input type="number" min="0" step="any" inputMode="decimal" value={n ?? ''} onChange={e => setNum([k, f], numVal(e))} className={input} /></label>))}
          </div>
        </fieldset>))}
      {scalars.map(([k, n]) => (
        <label key={k} className="text-xs text-slate-600 flex flex-col max-w-xs">{k === 'estimatedInputTokensPerReference' ? 'Estimated input tokens per reference photo' : k}
          <input type="number" min="0" step="any" value={n ?? ''} onChange={e => setNum([k], numVal(e))} className={input} /></label>))}
    </div>
  );
}

function OverridesEditor({ value, onChange }) {
  const [id, setId] = useState(COMPARTMENT_IDS[0]);
  const cur = value[id] ?? {};
  const set = patch => onChange({ ...value, [id]: { ...cur, ...patch } });
  const dim = (f, label) => (
    <label key={f} className="text-xs text-slate-600 flex flex-col">{label} (in)
      <input type="number" min="0" step="any" value={cur.dimensions?.[f] ?? ''} onChange={e => set({ dimensions: { ...cur.dimensions, [f]: numVal(e) } })} className={input} /></label>
  );
  const zones = cur.zones ?? [];
  return (
    <div className="space-y-3">
      <Select label="Compartment" value={id} options={COMPARTMENT_IDS} onChange={setId} />
      <p className="text-xs text-slate-600">{value[id] ? 'This compartment has overrides.' : 'No overrides yet — fields left blank use the built-in values.'}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-slate-600 flex flex-col">Orientation
          <select value={cur.orientation ?? ''} onChange={e => set({ orientation: e.target.value || undefined })} className={input}><option value="">Built-in</option>{OVERRIDE_ORIENTATIONS.map(o => <option key={o}>{o}</option>)}</select></label>
        <label className="text-xs text-slate-600 flex flex-col">Image size (WxH)
          <input type="text" value={cur.size ?? ''} placeholder="e.g. 1536x1024" onChange={e => set({ size: e.target.value || undefined })} className={input} /></label>
      </div>
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-3">{[['widthIn', 'Width'], ['heightIn', 'Height'], ['depthIn', 'Depth'], ['doorWidthIn', 'Door width'], ['doorHeightIn', 'Door height']].map(([f, l]) => dim(f, l))}</div>
      <fieldset><legend className="text-xs text-slate-600">Zones offered in Arrange</legend>
        <div className="flex flex-wrap gap-1.5 mt-1">{DEFAULT_ZONES.map(z => (
          <label key={z} className={`touch-target px-2.5 rounded border text-xs font-semibold flex items-center gap-1.5 cursor-pointer ${zones.includes(z) ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-300'}`}>
            <input type="checkbox" className="sr-only" checked={zones.includes(z)} onChange={e => set({ zones: e.target.checked ? [...zones, z] : zones.filter(x => x !== z) })} />{zoneLabel(z)}</label>))}</div></fieldset>
      <label className="text-xs text-slate-600 block">Spec text
        <textarea rows={3} value={cur.specText ?? ''} onChange={e => set({ specText: e.target.value || undefined })} className="w-full border border-slate-300 rounded p-2 text-sm" />
        <span>{(cur.specText ?? '').length}/{SPEC_TEXT_MAX}</span></label>
      {value[id] && <button type="button" onClick={() => { const n = { ...value }; delete n[id]; onChange(n); }} className="touch-target px-3 rounded border border-red-300 text-red-800 text-sm font-semibold">Remove overrides for {id}</button>}
    </div>
  );
}
