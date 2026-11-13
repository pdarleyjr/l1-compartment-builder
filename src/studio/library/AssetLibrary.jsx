import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Check, ImageOff } from 'lucide-react';
import { CATEGORY_LABELS, PROVENANCE_LABELS } from '../capture/categories.js';
import { BTN_SECONDARY, BTN_PRIMARY, CARD, CHIP } from '../capture/styles.js';
import { AssetDetail } from './AssetDetail.jsx';
import { AssociationDialog } from './AssociationDialog.jsx';
import { pendingDeleteIds, scheduleDelete, subscribeDeletes, undoDelete, UNDO_MS } from './deferred-delete.js';
import { useAssets } from './useAssets.js';

const TABS = [['all', 'All'], ['compartment', 'Compartment'], ['tool', 'Tools'], ['tool_group', 'Groups'], ['mount', 'Mounts'], ['arrangement', 'Installed'], ['other', 'Reference'], ['rendering', 'AI']];

function Tile({ asset, selectable, selected, onOpen, onSelect }) {
  const links = (asset.links ?? []).filter(l => l.state === 'confirmed');
  const title = asset.title || CATEGORY_LABELS[asset.category] || 'Photo';
  const alt = `${title}${links.length ? `, linked to ${links.map(l => l.label || 'a tool').join(', ')}` : ''}`;
  return (
    <li className={`${CARD} overflow-hidden min-w-0 ${selected ? 'ring-2 ring-red-500' : ''}`} data-testid="asset-tile">
      <button type="button" onClick={() => (selectable ? onSelect(asset) : onOpen(asset))} aria-pressed={selectable ? selected : undefined}
        className="block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500">
        <div className="relative aspect-[4/3] bg-slate-100 flex items-center justify-center">
          {asset.variants?.thumb ? <img src={asset.variants.thumb} alt={alt} loading="lazy" decoding="async" className="w-full h-full object-cover" /> : <ImageOff className="text-slate-400" aria-hidden="true" />}
          <span className="absolute left-1 top-1 rounded bg-slate-900/80 text-white text-[10px] px-1.5 py-0.5">{PROVENANCE_LABELS[asset.provenance] ?? asset.provenance}</span>
          {selectable && <span className={`absolute right-1 top-1 w-6 h-6 rounded-full border-2 flex items-center justify-center ${selected ? 'bg-red-600 border-red-600 text-white' : 'bg-white/90 border-slate-400'}`} aria-hidden="true">{selected && <Check size={14} />}</span>}
        </div>
        <div className="p-2">
          <p className="text-sm font-medium text-slate-800 truncate">{title}</p>
          <p className="text-xs text-slate-500">{CATEGORY_LABELS[asset.category]}</p>
        </div>
      </button>
      {links.length > 0 && <ul className="px-2 pb-2 flex flex-wrap gap-1" aria-label="Linked tools">{links.slice(0, 3).map(l => <li key={l.id} className={CHIP}><span className="truncate">{l.label || 'Tool'}</span></li>)}{links.length > 3 && <li className={CHIP}>+{links.length - 3}</li>}</ul>}
      {!selectable && (asset.category === 'tool' || asset.category === 'tool_group') && links.length === 0 && (
        <p className="px-2 pb-2 text-xs text-amber-700">Not linked to a tool yet</p>
      )}
    </li>
  );
}

/**
 * Photo library for one compartment: category filter, thumbnail grid, detail sheet, link editor, delete with 10 s undo.
 * @param {{compId:string, session?:object, plannerDoc:object|null, plannerRevision?:number, onSelect?:(asset:object)=>void, selectable?:boolean, filterCategory?:string}} props
 */
export function AssetLibrary({ compId, session, plannerDoc, plannerRevision, onSelect, selectable = false, filterCategory }) {
  const { assets, loading, error, reload, replace, drop } = useAssets(compId);
  const [tab, setTab] = useState(filterCategory ?? 'all');
  const [detail, setDetail] = useState(null);
  const [linking, setLinking] = useState(null);
  const [picked, setPicked] = useState(() => new Set());
  const [toast, setToast] = useState(null);
  const hidden = useSyncExternalStore(subscribeDeletes, () => pendingDeleteIds(), () => new Set());
  useEffect(() => { if (filterCategory) setTab(filterCategory); }, [filterCategory]);
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), UNDO_MS + 500); return () => clearTimeout(t); }, [toast]);

  const visible = useMemo(() => assets.filter(a => a.status !== 'deleted' && !hidden.has(a.id) && (tab === 'all' || a.category === tab)), [assets, hidden, tab]);
  const counts = useMemo(() => { const c = { all: 0 }; for (const a of assets) if (!hidden.has(a.id)) { c.all += 1; c[a.category] = (c[a.category] ?? 0) + 1; } return c; }, [assets, hidden]);

  const remove = asset => {
    setDetail(null);
    scheduleDelete(asset, { onDone: a => drop(a.id), onError: (a, e) => { setToast({ text: `Could not delete “${a.title || 'photo'}”: ${e?.message || 'try again'}.` }); reload(); } });
    setToast({ text: `Deleted “${asset.title || CATEGORY_LABELS[asset.category] || 'photo'}”.`, undoId: asset.id });
  };
  const choose = asset => {
    setPicked(prev => { const n = new Set(prev); if (n.has(asset.id)) n.delete(asset.id); else n.add(asset.id); return n; });
    onSelect?.(asset);
  };

  return (
    <section className="flex flex-col gap-3 min-w-0" aria-label="Photo library" data-testid="asset-library">
      <div role="tablist" aria-label="Photo categories" className="flex gap-1 overflow-x-auto pb-1 -mx-1 px-1">
        {TABS.filter(([v]) => v === 'all' || counts[v] || v === tab).map(([v, label]) => (
          <button key={v} type="button" role="tab" aria-selected={tab === v} onClick={() => setTab(v)}
            className={`touch-target min-h-11 shrink-0 rounded-full px-3 text-sm font-medium border ${tab === v ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-700 border-slate-300'}`}>
            {label}{counts[v] ? ` (${counts[v]})` : ''}
          </button>
        ))}
      </div>
      <div aria-live="polite" className="min-h-0">
        {loading && !assets.length && <p className="text-sm text-slate-500" role="status">Loading photos…</p>}
        {error && (
          <div role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 flex flex-wrap items-center gap-2">
            <span className="flex-1">{error}</span><button type="button" className={BTN_SECONDARY} onClick={reload}>Try again</button>
          </div>
        )}
        {!loading && !error && !visible.length && <p className="text-sm text-slate-600 rounded border border-dashed border-slate-300 p-4 text-center">{tab === 'all' ? 'No photos yet. Use Take Photo or Choose Photos to add some.' : 'No photos in this category yet.'}</p>}
      </div>
      <ul className="grid grid-cols-2 min-[520px]:grid-cols-3 lg:grid-cols-4 gap-3">
        {visible.map(a => <Tile key={a.id} asset={a} selectable={selectable} selected={picked.has(a.id)} onOpen={setDetail} onSelect={choose} />)}
      </ul>
      {selectable && picked.size > 0 && <p className="text-sm text-slate-600">{picked.size} selected</p>}
      {toast && (
        <div role="status" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 max-w-[92vw] flex items-center gap-3 rounded-lg bg-slate-900 text-white text-sm px-4 py-2 shadow-lg" data-testid="library-toast">
          <span className="min-w-0 break-words">{toast.text}</span>
          {toast.undoId && <button type="button" className={`${BTN_PRIMARY} !min-h-11`} data-testid="library-undo" onClick={() => { undoDelete(toast.undoId); setToast(null); }}>Undo</button>}
        </div>
      )}
      <AssetDetail asset={detail} open={!!detail} onClose={() => setDetail(null)} onSaved={a => { replace(a); setDetail(null); }} onDelete={remove}
        onEditLinks={a => { setDetail(null); setLinking(a); }} />
      <AssociationDialog compId={compId} session={session} asset={linking} plannerDoc={plannerDoc} plannerRevision={plannerRevision} open={!!linking} onClose={() => setLinking(null)}
        onSaved={() => { setLinking(null); reload(); }} />
    </section>
  );
}
