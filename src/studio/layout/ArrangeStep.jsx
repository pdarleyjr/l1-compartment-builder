import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Save } from 'lucide-react';
import { api } from '../../lib/api.js';
import { ID_PATTERN, INSTRUCTIONS_MAX, ORIENTATIONS } from '../../../shared/contracts.js';
import { availableZones, diagramModel, itemsByZone, layoutDirty, layoutPayload, normalizeLayout, ORIENTATION_LABELS, placementOf, setPlacement, zoneLabel } from './layoutModel.js';
import { humanError } from '../common/format.js';

const designPath = compId => `/compartments/${encodeURIComponent(compId)}/design`;
const unwrap = res => ({ layout: normalizeLayout(res?.design?.layout), revision: Number(res?.design?.revision ?? 0) });

/**
 * Step 4: arrange tools and mounts by zone/orientation. Selects work by keyboard and touch; drag is a pointer convenience.
 * @param {{compId:string, tools:{kind:'tool',ref:string,name:string,qty:number}[], mounts:{id:string,name?:string,title?:string}[], geometry:object|null}} props
 */
export default function ArrangeStep({ compId, tools, mounts, geometry }) {
  const [layout, setLayout] = useState({ placements: [], notes: '' });
  const [saved, setSaved] = useState({ placements: [], notes: '' });
  const [revision, setRevision] = useState(0);
  const [phase, setPhase] = useState('loading'); // loading | idle | saving | failed
  const [message, setMessage] = useState('');
  const revRef = useRef(0); revRef.current = revision;
  const layoutRef = useRef(layout); layoutRef.current = layout;

  useEffect(() => {
    let alive = true; setPhase('loading');
    api(designPath(compId)).then(res => {
      if (!alive) return;
      const d = unwrap(res); setLayout(d.layout); setSaved(d.layout); setRevision(d.revision); setPhase('idle');
    }).catch(e => { if (!alive) return; setPhase(e?.status === 404 ? 'idle' : 'failed'); if (e?.status !== 404) setMessage(humanError(e)); });
    return () => { alive = false; };
  }, [compId]);

  const dirty = layoutDirty(layout, saved);
  const save = useCallback(async () => {
    const mine = layoutRef.current;
    setPhase('saving'); setMessage('');
    try {
      const res = await api(designPath(compId), { method: 'PUT', json: { layout: layoutPayload(mine), expectRevision: revRef.current } });
      const d = unwrap(res);
      setRevision(d.revision || revRef.current + 1); setSaved(mine); setPhase('idle');
    } catch (e) {
      if (e?.status === 409) {
        // Someone saved first: take the new revision, keep my edits on top of it, and ask for a re-save.
        try { const d = unwrap(await api(designPath(compId))); setRevision(d.revision); setSaved(d.layout); setPhase('idle'); setMessage('Someone else saved this layout first. Your changes are still here — press Save to apply them on top.'); return; } catch { /* fall through */ }
      }
      setPhase('failed'); setMessage(humanError(e));
    }
  }, [compId]);

  // Autosave shortly after the last change so Generate always sees the arrangement.
  useEffect(() => {
    if (!dirty || phase !== 'idle') return undefined;
    const h = setTimeout(save, 2500);
    return () => clearTimeout(h);
  }, [dirty, phase, layout, save]);

  const zones = availableZones(geometry, layout);
  const byZone = itemsByZone(layout, zones);
  const model = diagramModel(geometry, zones);
  // Only items the server can resolve (tools with an equipment id, saved mounts) can be placed.
  const items = [
    ...tools.filter(t => ID_PATTERN.test(t.ref)).map(t => ({ kind: 'tool', ref: t.ref, name: t.qty > 1 ? `${t.name} ×${t.qty}` : t.name, rawName: t.name })),
    ...mounts.map(m => ({ kind: 'mount', ref: m.id, name: m.name || 'Mount', rawName: m.name || 'Mount' })),
  ];
  const labelOf = new Map(items.map(it => [`${it.kind === 'mount' ? 'mount' : 'equipment'}:${it.ref}`, it.name]));
  const place = (item, patch) => setLayout(l => setPlacement(l, item, patch));
  const onDrop = (e, zone) => {
    e.preventDefault();
    try { const it = JSON.parse(e.dataTransfer.getData('application/x-l1-item')); place(it, { zone }); } catch { /* ignore foreign drops */ }
  };

  const indicator = phase === 'saving' ? <span className="flex items-center gap-1 text-slate-600"><Loader2 size={14} className="motion-safe:animate-spin" /> Saving…</span>
    : phase === 'failed' ? <span className="flex items-center gap-1 text-red-700"><AlertTriangle size={14} /> Save failed</span>
      : dirty ? <span className="text-amber-800">Unsaved changes</span>
        : <span className="flex items-center gap-1 text-green-800"><CheckCircle2 size={14} /> Saved</span>;

  return (
    <div className="p-3 sm:p-4 grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]" data-testid="arrange-step">
      <section aria-label="Compartment diagram" className="min-w-0">
        <svg viewBox={`0 0 ${model.vbW} ${model.vbH}`} role="img" aria-label={`Diagram of ${compId} with ${zones.length} zones`} className="w-full h-auto max-h-[60dvh] bg-slate-100 border-2 border-slate-700 rounded">
          {model.rects.map(r => (
            <g key={r.zone} onDragOver={e => e.preventDefault()} onDrop={e => onDrop(e, r.zone)}>
              <rect x={r.x} y={r.y} width={r.w} height={r.h} rx="4" className={byZone[r.zone].length ? 'fill-red-50 stroke-red-700' : 'fill-white stroke-slate-400'} strokeWidth="1.5" />
              <text x={r.x + 6} y={r.y + 14} fontSize="11" fontWeight="700" className="fill-slate-800">{zoneLabel(r.zone)}</text>
              {byZone[r.zone].slice(0, Math.max(1, Math.floor((r.h - 20) / 12))).map((p, i) => (
                <text key={p.targetType + p.targetId} x={r.x + 6} y={r.y + 28 + i * 12} fontSize="9" className="fill-slate-700">{((n) => (n.length > 26 ? `${n.slice(0, 25)}…` : n))(labelOf.get(`${p.targetType}:${p.targetId}`) ?? 'Item')}</text>
              ))}
            </g>
          ))}
        </svg>
        {!model.known && <p className="mt-1 text-xs text-slate-600">Dimensions unknown — the diagram is not to scale. An admin can add dimensions in Admin settings.</p>}
        {model.known && <p className="mt-1 text-xs text-slate-600">Drawn to scale from {geometry.dimensions.widthIn}″ W × {geometry.dimensions.heightIn}″ H.</p>}
      </section>

      <section aria-label="Placement" className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2 justify-between" aria-live="polite">
          <h3 className="font-bold text-slate-900">Where does each item go?</h3>
          <div className="flex items-center gap-2 text-xs font-semibold">
            {indicator}
            <button type="button" onClick={save} disabled={!dirty || phase === 'saving'} data-testid="arrange-save"
              className="touch-target px-3 rounded bg-red-700 text-white font-bold disabled:opacity-50 flex items-center gap-1"><Save size={14} /> Save</button>
          </div>
        </div>
        {message && <p role="alert" className="text-sm rounded border border-amber-300 bg-amber-50 text-amber-950 px-2 py-1.5">{message}</p>}
        {!items.length && <p className="text-sm text-slate-600">No tools are assigned to this compartment yet. Assign equipment in the planner first.</p>}
        <ul className="space-y-2">
          {items.map(it => {
            const p = placementOf(layout, it); const id = `${it.kind}-${it.ref}`;
            return (
              <li key={id} className="rounded-lg border border-slate-300 bg-white p-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_9rem] sm:items-center">
                <div draggable onDragStart={e => e.dataTransfer.setData('application/x-l1-item', JSON.stringify({ kind: it.kind, ref: it.ref, name: it.name }))}
                  className="min-w-0 text-sm font-semibold text-slate-900 break-words sm:cursor-grab">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500 mr-1">{it.kind}</span>{it.name}
                </div>
                <label className="text-xs text-slate-600 flex flex-col">Zone
                  <select value={p.zone ?? ''} onChange={e => place(it, { zone: e.target.value || null })} id={`zone-${id}`} disabled={phase === 'loading'} className="touch-target border border-slate-300 rounded px-1.5 text-sm text-slate-900 bg-white">
                    <option value="">Not placed</option>
                    {zones.map(z => <option key={z} value={z}>{zoneLabel(z)}</option>)}
                  </select>
                </label>
                <label className="text-xs text-slate-600 flex flex-col">Orientation
                  <select value={p.orientation ?? ''} disabled={phase === 'loading'} onChange={e => place(it, { orientation: e.target.value || null })} className="touch-target border border-slate-300 rounded px-1.5 text-sm text-slate-900 bg-white">
                    <option value="">Any</option>
                    {ORIENTATIONS.map(o => <option key={o} value={o}>{ORIENTATION_LABELS[o]}</option>)}
                  </select>
                </label>
              </li>
            );
          })}
        </ul>
        <label className="block text-sm font-semibold text-slate-800">Notes for the image
          <textarea value={layout.notes} disabled={phase === 'loading'} maxLength={INSTRUCTIONS_MAX} rows={3} onChange={e => setLayout(l => ({ ...l, notes: e.target.value }))}
            className="mt-1 w-full border border-slate-300 rounded p-2 text-sm font-normal" placeholder="e.g. Hose rolls stand upright against the rear wall." />
          <span className="text-xs font-normal text-slate-500">{layout.notes.length}/{INSTRUCTIONS_MAX}</span>
        </label>
      </section>
    </div>
  );
}
