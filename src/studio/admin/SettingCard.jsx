import { useEffect, useMemo, useState } from 'react';
import { History } from 'lucide-react';
import { api } from '../../lib/api.js';
import { humanError, formatWhen } from '../common/format.js';
import { useToast } from '../common/toastContext.js';
import { FieldEditor } from './editors.jsx';
import { cleanOverrides, diffValues, normalizeHistory, SETTING_META, showValue, validateSetting } from './settingsModel.js';

const enc = encodeURIComponent;

/**
 * One setting: typed editor, inline validation, diff preview, revisioned save and history restore.
 * @param {{settingKey:string, entry:{value:any,revision:number}, onSaved:(key:string, entry:{value:any,revision:number})=>void, onReload:()=>void}} props
 */
export default function SettingCard({ settingKey, entry, onSaved, onReload }) {
  const meta = SETTING_META[settingKey]; const toast = useToast();
  const [draft, setDraft] = useState(entry.value);
  const [serverErrors, setServerErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState(null);
  useEffect(() => { setDraft(entry.value); setServerErrors([]); }, [entry]);

  const value = meta.type === 'overrides' ? cleanOverrides(draft) : draft;
  const errors = useMemo(() => validateSetting(settingKey, value), [settingKey, value]);
  const diff = useMemo(() => diffValues(entry.value, value), [entry.value, value]);
  const dirty = diff.length > 0;
  const id = `setting-${settingKey}`;

  const put = async (next) => {
    setSaving(true); setServerErrors([]);
    try {
      const res = await api(`/admin/settings/${enc(settingKey)}`, { method: 'PUT', json: { value: next, expectRevision: entry.revision } });
      onSaved(settingKey, { value: res.value, revision: res.revision }); toast(`${meta.label} saved.`, 'success');
    } catch (e) {
      if (e?.code === 'REVISION_CONFLICT' || e?.status === 409) { toast('Someone else changed this setting. The latest value was loaded.', 'error'); onReload(); }
      else setServerErrors([...(Array.isArray(e?.details?.errors) ? e.details.errors.map(String) : []), humanError(e)].slice(0, 6));
    } finally { setSaving(false); }
  };
  const loadHistory = async () => {
    try { setHistory(normalizeHistory(await api(`/admin/settings/${enc(settingKey)}/history`))); } catch (e) { setHistory([]); toast(humanError(e), 'error'); }
  };

  return (
    <section className="rounded-lg border border-slate-300 bg-white p-3 space-y-2 min-w-0" aria-labelledby={`${id}-h`}>
      <h4 id={`${id}-h`} className="font-bold text-slate-900 text-sm">{meta.label}</h4>
      {meta.help && <p className="text-xs text-slate-600">{meta.help}</p>}
      <FieldEditor meta={meta} id={id} value={draft} onChange={setDraft} />
      {dirty && errors.map(e => <p key={e} role="alert" className="text-xs text-red-700">{e}</p>)}
      {serverErrors.map(e => <p key={e} role="alert" className="text-xs text-red-700">{e}</p>)}
      {dirty && (
        <div className="rounded bg-slate-50 border border-slate-200 p-2 text-xs space-y-0.5" aria-label="Changes to save" data-testid={`admin-diff-${settingKey}`}>
          <p className="font-bold">Changes</p>
          {diff.slice(0, 12).map(d => <p key={d.path} className="break-all"><code>{d.path}</code>: {showValue(d.from)} → <b>{showValue(d.to)}</b></p>)}
          {diff.length > 12 && <p>…and {diff.length - 12} more</p>}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid={`admin-save-${settingKey}`} disabled={!dirty || errors.length > 0 || saving} onClick={() => put(value)}
          className="touch-target px-4 rounded bg-red-700 text-white text-sm font-bold disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
        {dirty && <button type="button" onClick={() => setDraft(entry.value)} className="touch-target px-3 rounded border border-slate-300 text-sm font-semibold">Discard</button>}
        <button type="button" onClick={loadHistory} className="touch-target px-3 rounded border border-slate-300 text-sm font-semibold flex items-center gap-1.5"><History size={14} /> History</button>
      </div>
      {history && (
        <ul className="divide-y divide-slate-200 border border-slate-200 rounded text-xs" aria-label="History">
          {history.length === 0 && <li className="p-2 text-slate-600">No earlier versions.</li>}
          {history.slice(0, 10).map(h => (
            <li key={h.revision} className="p-2 flex flex-wrap items-center gap-2">
              <span className="font-bold">r{h.revision}</span><span className="text-slate-600">{h.updatedBy ?? ''} {formatWhen(h.updatedAt)}</span>
              <span className="flex-1 min-w-0 break-all text-slate-800">{showValue(h.value)}</span>
              <button type="button" disabled={saving || JSON.stringify(h.value) === JSON.stringify(entry.value) || validateSetting(settingKey, h.value).length > 0} onClick={() => put(h.value)}
                className="touch-target px-2 rounded border border-slate-300 font-semibold disabled:opacity-40">Restore this version</button>
            </li>))}
        </ul>
      )}
    </section>
  );
}
