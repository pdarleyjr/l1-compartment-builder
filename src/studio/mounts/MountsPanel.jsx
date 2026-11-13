import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { Modal } from '../capture/Modal.jsx';
import { BTN_DANGER, BTN_PRIMARY, BTN_SECONDARY, CARD, CHIP } from '../capture/styles.js';
import { MountForm } from './MountForm.jsx';
import { CLASSIFICATION_INFO, MOUNT_DISCLAIMER, STATUS_LABELS, emptyMount, formToPayload, mountToForm, validateMountForm } from './mount-constants.js';

const unwrap = r => r.mounts;

/**
 * Mounts for one compartment: list, create/edit (own sheet), delete with confirm.
 * @param {{compId:string, session:object, plannerDoc:object|null, plannerRevision?:number}} props
 */
export function MountsPanel({ compId, session, plannerDoc, plannerRevision }) {
  const [state, setState] = useState({ mounts: [], loading: true, error: '' });
  const [editing, setEditing] = useState(null); // {id|null, form}
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: '' }));
    try { setState({ mounts: unwrap(await api(`/compartments/${encodeURIComponent(compId)}/mounts`)), loading: false, error: '' }); }
    catch (e) { setState(s => ({ ...s, loading: false, error: e?.message || 'Could not load mounts.' })); }
  }, [compId]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (validateMountForm(editing.form)) return;
    setSaving(true); setFormError('');
    try {
      const body = formToPayload(editing.form);
      if (editing.id) await api(`/mounts/${editing.id}`, { method: 'PATCH', json: { ...body, expectRevision: editing.revision } });
      else await api(`/compartments/${encodeURIComponent(compId)}/mounts`, { method: 'POST', json: body });
      setEditing(null); await load();
    } catch (e) { setFormError(e?.message || 'Could not save the mount.'); } finally { setSaving(false); }
  };
  const remove = async () => {
    const m = deleting; setDeleting(null);
    try { await api(`/mounts/${m.id}`, { method: 'DELETE' }); await load(); }
    catch (e) { setState(s => ({ ...s, error: e?.message || 'Could not delete the mount.' })); }
  };

  const { mounts, loading, error } = state;
  return (
    <section className="flex flex-col gap-3 min-w-0" aria-label="Mounts" data-testid="mounts-panel">
      <p className="rounded border border-amber-300 bg-amber-50 text-amber-900 text-sm p-2" data-testid="mount-disclaimer">{MOUNT_DISCLAIMER}</p>
      <div><button type="button" className={BTN_PRIMARY} data-testid="mount-add" onClick={() => { setFormError(''); setEditing({ id: null, form: emptyMount() }); }}><Plus size={16} aria-hidden="true" /> Add mount</button></div>
      <div aria-live="polite">
        {loading && !mounts.length && <p className="text-sm text-slate-500" role="status">Loading mounts…</p>}
        {error && <div role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 flex flex-wrap gap-2 items-center"><span className="flex-1">{error}</span><button type="button" className={BTN_SECONDARY} onClick={load}>Try again</button></div>}
        {!loading && !error && !mounts.length && <p className="text-sm text-slate-600 rounded border border-dashed border-slate-300 p-4 text-center">No mounts yet. Add brackets, trays or holders so renderings can show them.</p>}
      </div>
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {mounts.map(m => (
          <li key={m.id} className={`${CARD} p-3 flex flex-col gap-2 min-w-0`} data-testid="mount-item">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-bold text-slate-800 break-words">{m.name || 'Untitled mount'}</h3>
                <p className="text-xs text-slate-500 break-words">{[m.manufacturer, m.model].filter(Boolean).join(' · ') || 'No manufacturer or model'}</p>
              </div>
              <button type="button" className={BTN_SECONDARY} onClick={() => { setFormError(''); setEditing({ id: m.id, revision: m.revision, form: mountToForm(m) }); }} aria-label={`Edit ${m.name || 'mount'}`}><Pencil size={14} aria-hidden="true" /></button>
              <button type="button" className={BTN_DANGER} onClick={() => setDeleting(m)} aria-label={`Delete ${m.name || 'mount'}`}><Trash2 size={14} aria-hidden="true" /></button>
            </div>
            <div className="flex flex-wrap gap-1">
              <span className={CHIP}>{CLASSIFICATION_INFO[m.classification]?.label ?? m.classification}</span>
              <span className={CHIP}>{STATUS_LABELS[m.status] ?? m.status}</span>
              {m.zone && <span className={CHIP}>{m.zone.replace(/_/g, ' ')}</span>}
              {m.capacity != null && <span className={CHIP}>holds {m.capacity}</span>}
              {(m.links ?? []).filter(l => l.targetType === 'equipment').length > 0 && <span className={CHIP}>{m.links.filter(l => l.targetType === 'equipment').length} tools</span>}
            </div>
          </li>
        ))}
      </ul>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Edit mount' : 'Add mount'} wide testId="mount-dialog">
        {editing && <MountForm compId={compId} session={session} plannerDoc={plannerDoc} plannerRevision={plannerRevision} form={editing.form} setForm={f => setEditing(e => ({ ...e, form: f }))}
          saving={saving} error={formError} onSave={save} onCancel={() => setEditing(null)} />}
      </Modal>
      <Modal open={!!deleting} onClose={() => setDeleting(null)} title="Delete mount?" testId="mount-delete-dialog"
        footer={<><button type="button" className={BTN_SECONDARY} onClick={() => setDeleting(null)} data-autofocus>Keep</button><button type="button" className={BTN_DANGER} data-testid="mount-delete-confirm" onClick={remove}>Delete</button></>}>
        <p className="text-sm text-slate-700">“{deleting?.name || 'This mount'}” will be removed from this compartment. Its photo stays in the library.</p>
      </Modal>
    </section>
  );
}
