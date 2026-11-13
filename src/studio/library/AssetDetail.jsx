import { useEffect, useState } from 'react';
import { Link2, Trash2 } from 'lucide-react';
import { ApiError, api } from '../../lib/api.js';
import { ASSET_LIMITS } from '../../../shared/contracts.js';
import { Modal } from '../capture/Modal.jsx';
import { CATEGORY_OPTIONS, CATEGORY_LABELS, PROVENANCE_LABELS } from '../capture/categories.js';
import { BTN_DANGER, BTN_PRIMARY, BTN_SECONDARY, ERROR_TEXT, INPUT, LABEL } from '../capture/styles.js';

/**
 * Detail sheet: edit title / notes / category, see links, open the link editor, delete (confirm → 10 s undo handled by the parent).
 * @param {{asset:object|null, open:boolean, onClose:()=>void, onSaved:(a:object)=>void, onEditLinks:(a:object)=>void, onDelete:(a:object)=>void}} props
 */
export function AssetDetail({ asset, open, onClose, onSaved, onEditLinks, onDelete }) {
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [category, setCategory] = useState('other');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (asset) { setTitle(asset.title ?? ''); setNotes(asset.notes ?? ''); setCategory(asset.category); setError(''); setConfirming(false); }
  }, [asset?.id, open]);

  if (!asset) return null;
  const editable = !['rendering', 'markup', 'legacy_upload'].includes(asset.category);
  const dirty = title !== (asset.title ?? '') || notes !== (asset.notes ?? '') || category !== asset.category;
  const confirmed = (asset.links ?? []).filter(l => l.state === 'confirmed');

  const save = async () => {
    setSaving(true); setError('');
    try {
      const res = await api(`/assets/${asset.id}`, { method: 'PATCH', json: { title: title.trim() || null, notes: notes.trim() || null, ...(editable ? { category } : {}), expectRevision: asset.revision } });
      onSaved(res.asset);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not save changes.'); } finally { setSaving(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={asset.title || CATEGORY_LABELS[asset.category] || 'Photo'} testId="asset-detail"
      footer={confirming ? (
        <>
          <p className="mr-auto self-center text-sm text-slate-700" role="alert">Delete this photo? You can undo for 10 seconds.</p>
          <button type="button" className={BTN_SECONDARY} onClick={() => setConfirming(false)}>Keep</button>
          <button type="button" className={BTN_DANGER} data-testid="asset-delete-confirm" onClick={() => onDelete(asset)}><Trash2 size={16} aria-hidden="true" /> Delete</button>
        </>
      ) : (
        <>
          <button type="button" className={`${BTN_DANGER} mr-auto`} data-testid="asset-delete" onClick={() => setConfirming(true)}><Trash2 size={16} aria-hidden="true" /> Delete</button>
          <button type="button" className={BTN_SECONDARY} onClick={onClose}>Close</button>
          <button type="button" className={BTN_PRIMARY} onClick={save} disabled={!dirty || saving} data-testid="asset-save">{saving ? 'Saving…' : 'Save changes'}</button>
        </>
      )}>
      <div className="flex flex-col gap-3">
        {asset.variants?.display && <img src={asset.variants.display} alt={asset.title || 'Photo'} className="max-h-[40vh] max-w-full w-auto mx-auto rounded bg-slate-100 object-contain" />}
        <p className="text-xs text-slate-500">{PROVENANCE_LABELS[asset.provenance] ?? asset.provenance}{asset.width ? ` · ${asset.width}×${asset.height}` : ''}</p>
        <label><span className={LABEL}>Title</span>
          <input className={INPUT} value={title} maxLength={ASSET_LIMITS.titleMax} onChange={e => setTitle(e.target.value)} /></label>
        <label><span className={LABEL}>Notes</span>
          <textarea className={INPUT} rows={3} value={notes} maxLength={ASSET_LIMITS.notesMax} onChange={e => setNotes(e.target.value)} /></label>
        {editable && (
          <label><span className={LABEL}>Category</span>
            <select className={INPUT} value={category} onChange={e => setCategory(e.target.value)}>{CATEGORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
        )}
        <section aria-label="Linked tools">
          <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-1">Linked tools</h3>
          {confirmed.length ? <ul className="flex flex-wrap gap-1">{confirmed.map(l => <li key={l.id} className="inline-flex items-center rounded-full bg-slate-100 text-slate-700 text-xs px-2 py-1">{l.label || l.targetId}{l.quantity > 1 ? ` × ${l.quantity}` : ''}</li>)}</ul>
            : <p className="text-sm text-slate-500">Not linked to any tool yet.</p>}
          {editable && <button type="button" className={`${BTN_SECONDARY} mt-2`} onClick={() => onEditLinks(asset)} data-testid="asset-edit-links"><Link2 size={16} aria-hidden="true" /> Edit links</button>}
        </section>
        {error && <p role="alert" className={ERROR_TEXT}>{error}</p>}
      </div>
    </Modal>
  );
}
