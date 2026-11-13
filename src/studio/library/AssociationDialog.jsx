import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../../lib/api.js';
import { fetchSession } from '../../lib/session.js';
import { effectiveInventory } from '../../../shared/planner.js';
import { planAssociation, searchCandidates } from '../../../shared/associations.js';
import { Modal } from '../capture/Modal.jsx';
import { BTN_PRIMARY, BTN_SECONDARY, INPUT, ERROR_TEXT } from '../capture/styles.js';
import { attachRegions, newRegion, rowKey, summarizePlan, toApiLink } from './association-summary.js';
import { CandidateList } from './CandidateList.jsx';
import { NewToolForm } from './NewToolForm.jsx';
import { RegionEditor } from './RegionEditor.jsx';
import { SuggestionsPanel } from './SuggestionsPanel.jsx';

const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

/**
 * “Which tools are in this photo?” Nothing is saved until “Save links”.
 * @param {{compId:string, asset:object|null, plannerDoc:object|null, open:boolean, onClose:()=>void, onSaved:(asset:object)=>void,
 *   session?:{aiEnabled?:boolean}}} props `session` is optional; when omitted the session is fetched once to learn aiEnabled.
 */
export function AssociationDialog({ compId, asset, plannerDoc, open, onClose, onSaved, session }) {
  const [doc, setDoc] = useState(plannerDoc);
  const [query, setQuery] = useState('');
  const [multi, setMulti] = useState(asset?.category === 'tool_group');
  const [selected, setSelected] = useState(() => new Map());
  const [activeRegion, setActiveRegion] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [aiEnabled, setAiEnabled] = useState(!!session?.aiEnabled);

  useEffect(() => { setDoc(plannerDoc); }, [plannerDoc]);
  useEffect(() => { if (session) setAiEnabled(!!session.aiEnabled); else if (open) fetchSession().then(s => setAiEnabled(!!s.aiEnabled)); }, [session, open]);

  const names = useMemo(() => safe(() => effectiveInventory(doc), []), [doc]);
  const nameById = useMemo(() => new Map(names.filter(n => n.equipmentId).map(n => [n.equipmentId, n.name])), [names]);
  const keptLinks = useMemo(() => (asset?.links ?? []).filter(l => l.state !== 'suggested' && l.state !== 'rejected' && l.targetType !== 'equipment' && l.targetType !== 'assignment'), [asset]);

  // Reset when a different photo opens; prefill from its confirmed equipment links.
  useEffect(() => {
    if (!open || !asset) return;
    const next = new Map();
    for (const l of asset.links ?? []) {
      if (l.state === 'suggested' || l.state === 'rejected' || !l.equipmentId) continue;
      const k = l.equipmentId;
      const prev = next.get(k);
      next.set(k, { key: k, equipmentId: k, name: l.label ?? nameById.get(k) ?? k, quantity: (prev?.quantity ?? 0) + (l.quantity ?? 1), region: l.region ?? prev?.region ?? null });
    }
    setSelected(next); setMulti(asset.category === 'tool_group' || next.size > 1); setQuery(''); setError(''); setNotice(''); setActiveRegion(null); setSuggestions([]);
  }, [open, asset?.id]);

  const candidates = useMemo(() => safe(() => searchCandidates(doc, compId, query), { assigned: [], available: [], unavailable: [] }), [doc, compId, query]);
  const freeByName = useMemo(() => Object.fromEntries(names.map(n => [n.name, n])), [names]);

  const selections = useMemo(() => Array.from(selected.values()), [selected]);
  const plan = useMemo(() => {
    if (!selections.length) return null;
    try { return planAssociation(doc, compId, selections.map(s => ({ equipmentId: s.equipmentId, name: s.name, quantity: s.quantity, newTool: s.newTool })), {}); }
    catch (e) { return { links: [], plannerOps: [], errors: [{ index: 0, code: 'INVALID', message: e?.message || 'Could not plan these links.' }] }; }
  }, [doc, compId, selections]);
  const summary = useMemo(() => summarizePlan(plan, selections, freeByName), [plan, selections, freeByName]);

  const toggle = useCallback(row => {
    const key = rowKey(row);
    setSelected(prev => {
      const next = multi ? new Map(prev) : new Map();
      if (prev.has(key)) next.delete(key); else next.set(key, { key, equipmentId: row.equipmentId, name: row.name, quantity: 1, region: null });
      return next;
    });
  }, [multi]);
  const setQty = useCallback((key, quantity) => setSelected(prev => { const n = new Map(prev); n.set(key, { ...n.get(key), quantity }); return n; }), []);
  const setRegion = useCallback((key, region) => setSelected(prev => { const n = new Map(prev); n.set(key, { ...n.get(key), region }); return n; }), []);
  const addNew = useCallback(t => {
    const key = `new:${t.name}`;
    setSelected(prev => { const n = multi ? new Map(prev) : new Map(); n.set(key, { key, name: t.name, quantity: t.qty, newTool: t, region: null }); return n; });
  }, [multi]);
  const onConfirmSuggestion = useCallback(link => {
    if (!link.equipmentId) { setNotice(`“${link.label ?? 'Suggestion'}” confirmed. Pick the matching tool above to link it.`); return; }
    setMulti(true);
    setSelected(prev => { const n = new Map(prev); n.set(link.equipmentId, { key: link.equipmentId, equipmentId: link.equipmentId, name: link.label ?? nameById.get(link.equipmentId) ?? link.equipmentId, quantity: link.quantity ?? 1, region: link.region ?? null }); return n; });
  }, [nameById]);

  const refreshDoc = async () => {
    const res = await api('/public/planner');
    setDoc(res?.doc ? { ...res.doc, revision: res.revision ?? res.doc.revision } : res);
  };

  const save = async () => {
    if (!asset || !plan || !summary.canSave) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const links = [...attachRegions(plan.links, selections).map(toApiLink), ...keptLinks.map(toApiLink)];
      const res = await api(`/assets/${asset.id}/links`, { method: 'POST', json: { links, plannerOps: plan.plannerOps, baseRevision: doc?.revision } });
      onSaved(res?.asset ?? asset);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        try { await refreshDoc(); setNotice('Another device changed the inventory. The summary below is updated — review it and save again.'); }
        catch { setError('The inventory changed and could not be refreshed. Close this and try again.'); }
      } else setError(e?.message || 'Could not save the links.');
    } finally { setSaving(false); }
  };

  const regions = selections.filter(s => s.region).map(s => ({ key: s.key, label: s.name, rect: s.region, active: s.key === activeRegion }));
  const photo = asset?.variants?.display ?? asset?.variants?.thumb ?? null;
  const suggestionBoxes = suggestions.filter(s => s.region).map(s => ({ key: s.id, label: s.label ?? 'Suggestion', rect: s.region }));
  if (!asset) return null;

  return (
    <Modal open={open} onClose={onClose} title="Which tools are in this photo?" wide testId="association-dialog"
      footer={<>
        <button type="button" className={BTN_SECONDARY} onClick={onClose}>Not now</button>
        <button type="button" className={BTN_PRIMARY} data-testid="assoc-save" disabled={saving || !summary.canSave} onClick={save}>{saving ? 'Saving…' : 'Save links'}</button>
      </>}>
      <div className="flex flex-col gap-4">
        <RegionEditor src={photo} alt={asset.title || 'Photo being linked to tools'} regions={regions} suggestions={suggestionBoxes} onChange={setRegion} />
        <div role="group" aria-label="Photo contents" className="grid grid-cols-2 gap-2">
          {[[false, 'One tool'], [true, 'Multiple tools in this photo']].map(([v, label]) => (
            <button key={label} type="button" aria-pressed={multi === v} data-testid={v ? 'assoc-mode-multi' : 'assoc-mode-single'}
              onClick={() => { setMulti(v); if (!v) setSelected(prev => new Map(Array.from(prev).slice(0, 1))); }}
              className={`touch-target min-h-11 rounded border px-2 text-sm font-medium ${multi === v ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-700 border-slate-300'}`}>{label}</button>
          ))}
        </div>
        <label className="block"><span className="sr-only">Search tools</span>
          <input type="search" className={INPUT} placeholder="Search tools by name" value={query} onChange={e => setQuery(e.target.value)} data-testid="assoc-search" data-autofocus /></label>
        <CandidateList compId={compId} candidates={candidates} selected={selected} multi={multi} onToggle={toggle} onQty={setQty} />
        <NewToolForm existingNames={names.map(n => n.name)} onAdd={addNew} />

        {selections.length > 0 && (
          <section aria-label="Mark tools on the photo" className="flex flex-col gap-1">
            <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500">Where is each tool? (optional)</h4>
            {selections.map(s => (
              <div key={s.key} className="flex items-center gap-2 min-w-0">
                <span className="flex-1 min-w-0 text-sm text-slate-800 break-words">{s.name}</span>
                {s.region
                  ? <button type="button" className={BTN_SECONDARY} onClick={() => { setRegion(s.key, null); setActiveRegion(null); }} aria-label={`Remove box for ${s.name}`}>Remove box</button>
                  : <button type="button" className={BTN_SECONDARY} onClick={() => { setRegion(s.key, newRegion()); setActiveRegion(s.key); }} aria-label={`Mark ${s.name} on the photo`}>Mark on photo</button>}
              </div>
            ))}
          </section>
        )}

        {aiEnabled && <SuggestionsPanel compId={compId} assetId={asset.id} onSuggestions={setSuggestions} onConfirm={onConfirmSuggestion} />}

        <section aria-label="What will happen" aria-live="polite" className="rounded-lg border border-slate-300 bg-slate-50 p-3" data-testid="assoc-summary">
          <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">What will happen</h4>
          <ul className="flex flex-col gap-1 text-sm">
            {summary.lines.map((l, i) => <li key={i} className={l.tone === 'ok' ? 'text-green-800' : 'text-slate-800'}>{l.text}</li>)}
            {summary.errors.map((t, i) => <li key={`e${i}`} className={ERROR_TEXT} role="alert">{t}</li>)}
          </ul>
          <p className="text-xs text-slate-500 mt-2">Nothing is saved until you tap “Save links”.</p>
        </section>
        {notice && <p role="status" className="text-sm text-amber-800">{notice}</p>}
        {error && <p role="alert" className={ERROR_TEXT}>{error}</p>}
      </div>
    </Modal>
  );
}
