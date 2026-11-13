import { useMemo, useState } from 'react';
import { Columns2, GitBranch, Pencil, Trash2, Upload, XCircle } from 'lucide-react';
import { updateVersion } from '../../lib/jobs.js';
import { ProvenanceBadge, StatusPill } from '../common/badges.jsx';
import ConfirmDialog from '../common/ConfirmDialog.jsx';
import { costLabel, formatWhen, humanError } from '../common/format.js';
import { useToast } from '../common/toastContext.js';
import Compare from './Compare.jsx';
import Viewer from './Viewer.jsx';
import { branchText, canRejectOrDelete, verificationHints, versionLabels, visibleVersions } from './reviewModel.js';

/**
 * Step 6: view, compare and manage versions.
 * @param {{versions:object[], jobs:object[], assets:object[], selectedId:string|null, baseId:string|null, onSelect:(id:string)=>void,
 *   onEdit:(v:object)=>void, onUseAsBase:(v:object)=>void, onPublish:(v:object)=>void, onRefresh:()=>void}} props
 */
export default function ReviewStep({ versions, jobs, assets, selectedId, baseId, onSelect, onEdit, onUseAsBase, onPublish, onRefresh }) {
  const toast = useToast();
  const [compare, setCompare] = useState(false);
  const [leftId, setLeftId] = useState(null);
  const [rightId, setRightId] = useState(null);
  const [pending, setPending] = useState(null); // {version, status}
  const labels = useMemo(() => versionLabels(versions), [versions]);
  const list = useMemo(() => visibleVersions(versions), [versions]);
  const jobById = useMemo(() => new Map(jobs.map(j => [j.id, j])), [jobs]);
  const selected = list.find(v => v.id === selectedId) ?? list[0] ?? null;
  const photo = assets.find(a => a.category === 'compartment' && a.status !== 'deleted' && a.variants?.display);
  const options = [
    ...list.map(v => ({ id: v.id, label: `${labels.get(v.id)} (${v.status})`, url: v.variants?.display })),
    ...(photo ? [{ id: 'photo', label: 'Compartment photo', url: photo.variants.display }] : []),
  ];

  const confirmAction = async () => {
    const { version, status } = pending; setPending(null);
    try { await updateVersion(version.id, { status }); toast(status === 'deleted' ? 'Draft deleted.' : 'Version rejected.', 'success'); onRefresh(); }
    catch (e) { toast(humanError(e), 'error'); }
  };

  if (!list.length) return <div className="p-6 text-center text-slate-700" data-testid="review-empty"><p className="font-semibold">No images yet.</p><p className="text-sm">Generate one in the previous step and it will appear here as a draft.</p></div>;

  return (
    <div className="p-3 sm:p-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]" data-testid="review-step">
      <section className="min-w-0 space-y-3">
        {compare && options.length > 1
          ? <Compare options={options} leftId={leftId ?? list[0]?.id} rightId={rightId ?? list[1]?.id ?? 'photo'} onLeft={setLeftId} onRight={setRightId} />
          : selected && <Viewer src={selected.variants?.display} alt={`Version ${labels.get(selected.id)}`} className="h-[55dvh] lg:h-[65dvh]" />}
        <ProvenanceBadge />
        {selected && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => onEdit(selected)} className="touch-target px-3 rounded bg-slate-800 text-white text-sm font-semibold flex items-center gap-1.5"><Pencil size={14} /> Edit this version</button>
              <button type="button" onClick={() => onUseAsBase(selected)} className="touch-target px-3 rounded border border-slate-300 text-sm font-semibold flex items-center gap-1.5 hover:bg-slate-100" aria-pressed={baseId === selected.id}><GitBranch size={14} /> {baseId === selected.id ? 'Base for next edit' : 'Use as base'}</button>
              {selected.status !== 'rejected' && <button type="button" onClick={() => onPublish(selected)} className="touch-target px-3 rounded bg-red-700 text-white text-sm font-bold flex items-center gap-1.5"><Upload size={14} /> Publish…</button>}
              {canRejectOrDelete(selected) && <>
                <button type="button" onClick={() => setPending({ version: selected, status: 'rejected' })} className="touch-target px-3 rounded border border-slate-300 text-sm font-semibold flex items-center gap-1.5 hover:bg-slate-100"><XCircle size={14} /> Reject</button>
                <button type="button" onClick={() => setPending({ version: selected, status: 'deleted' })} className="touch-target px-3 rounded border border-red-300 text-red-800 text-sm font-semibold flex items-center gap-1.5 hover:bg-red-50"><Trash2 size={14} /> Delete draft</button>
              </>}
            </div>
            {verificationHints(selected.verification).length > 0 && (
              <div className="rounded border border-slate-300 bg-slate-50 p-2 text-xs text-slate-800" data-testid="verification-hints">
                <p className="font-bold">Automatic check (hints only — not authoritative)</p>
                <ul className="list-disc pl-4 mt-1 space-y-0.5">{verificationHints(selected.verification).map((h, i) => <li key={i} className="break-words">{h}</li>)}</ul>
              </div>
            )}
          </div>
        )}
      </section>

      <aside className="min-w-0 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-slate-900">Versions ({list.length})</h3>
          <button type="button" data-testid="compare-toggle" aria-pressed={compare} onClick={() => setCompare(c => !c)} disabled={options.length < 2}
            className={`touch-target px-3 rounded border text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50 ${compare ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-300 hover:bg-slate-100'}`}><Columns2 size={14} /> Compare</button>
        </div>
        <ul className="space-y-2">
          {list.map(v => {
            const job = jobById.get(v.jobId); const active = selected?.id === v.id;
            return (
              <li key={v.id}>
                <button type="button" data-testid="version-item" aria-current={active} onClick={() => onSelect(v.id)}
                  className={`w-full text-left flex gap-2 rounded-lg border-2 p-2 min-h-[44px] ${active ? 'border-red-700 bg-red-50' : 'border-slate-300 bg-white hover:border-slate-500'}`}>
                  <img src={v.variants?.thumb} alt="" loading="lazy" className="w-16 h-16 object-cover rounded bg-slate-200 shrink-0" />
                  <span className="min-w-0 text-xs text-slate-700 space-y-0.5">
                    <span className="flex flex-wrap items-center gap-1.5"><b className="text-sm text-slate-900">{labels.get(v.id)}</b><StatusPill status={v.status} />{baseId === v.id && <span className="text-[11px] font-bold text-blue-800">base</span>}</span>
                    <span className="block truncate">{v.model}{v.settings?.preset ? ` · ${v.settings.preset}` : ''}</span>
                    <span className="block truncate">{v.createdBy} · {formatWhen(v.createdAt)}</span>
                    {costLabel(job) && <span className="block">{costLabel(job)}</span>}
                    {branchText(v, labels) && <span className="block text-slate-600">{branchText(v, labels)}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <ConfirmDialog open={!!pending} danger title={pending?.status === 'deleted' ? 'Delete this draft?' : 'Reject this version?'}
        confirmLabel={pending?.status === 'deleted' ? 'Delete draft' : 'Reject'}
        message={<p>{pending?.status === 'deleted' ? 'The draft will be removed from the list.' : 'It stays in history but cannot be published.'} Other versions are not affected.</p>}
        onConfirm={confirmAction} onCancel={() => setPending(null)} />
    </div>
  );
}
