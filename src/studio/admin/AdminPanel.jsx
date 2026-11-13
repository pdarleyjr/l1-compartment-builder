import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { api } from '../../lib/api.js';
import { formatWhen, humanError } from '../common/format.js';
import { meterText, usageMeters } from '../generate/generateModel.js';
import SettingCard from './SettingCard.jsx';
import { normalizeSettings, SETTING_META } from './settingsModel.js';

const TABS = [['settings', 'Settings'], ['usage', 'Usage'], ['audit', 'Audit log']];
const GROUPS = [...new Set(Object.values(SETTING_META).map(m => m.group))];

function UsageTab() {
  const [state, setState] = useState({ loading: true, usage: null, error: null });
  useEffect(() => { api('/usage').then(usage => setState({ loading: false, usage, error: null })).catch(error => setState({ loading: false, usage: null, error })); }, []);
  if (state.loading) return <p className="p-4 text-sm text-slate-600">Loading…</p>;
  if (state.error) return <p role="alert" className="p-4 text-sm text-red-700">{humanError(state.error)}</p>;
  const meters = usageMeters(state.usage);
  const byUser = Object.values((state.usage?.recent ?? []).reduce((m, r) => { const e = m[r.actor] ?? (m[r.actor] = { actor: r.actor, usd: 0 }); e.usd += r.actualUsd ?? r.estimatedUsd ?? 0; return m; }, {}));
  return (
    <div className="p-3 sm:p-4 space-y-3" data-testid="admin-usage">
      {!meters.length && <p className="text-sm text-slate-600">No usage recorded yet.</p>}
      {meters.map(m => <div key={m.label} className="rounded-lg border border-slate-300 bg-white p-3"><div className="flex justify-between text-sm"><b>{m.label}</b><span>{meterText(m)}</span></div>
        {m.pct != null && <div className="mt-1 h-2 rounded bg-slate-200"><div className={`h-2 rounded ${m.pct >= 90 ? 'bg-red-600' : 'bg-green-600'}`} style={{ width: `${m.pct}%` }} /></div>}</div>)}
      {byUser.length > 0 && <table className="w-full text-sm"><thead><tr className="text-left text-xs text-slate-600"><th className="py-1">Person</th><th>Spent</th></tr></thead>
        <tbody>{byUser.map(u => <tr key={u.actor} className="border-t border-slate-200"><td className="py-1 break-all">{u.actor}</td><td>{meterText({ used: u.usd, limit: null })}</td></tr>)}</tbody></table>}
    </div>
  );
}

function AuditTab() {
  const [state, setState] = useState({ loading: true, rows: [], error: null });
  useEffect(() => { api('/admin/audit').then(r => setState({ loading: false, rows: r.entries, error: null })).catch(error => setState({ loading: false, rows: [], error })); }, []);
  if (state.loading) return <p className="p-4 text-sm text-slate-600">Loading…</p>;
  if (state.error) return <p role="alert" className="p-4 text-sm text-red-700">{humanError(state.error)}</p>;
  return (
    <ul className="p-3 sm:p-4 divide-y divide-slate-200 text-sm" data-testid="admin-audit">
      {!state.rows.length && <li className="text-slate-600">Nothing recorded yet.</li>}
      {state.rows.slice(0, 100).map((r, i) => (
        <li key={r.id ?? i} className="py-2 min-w-0"><span className="font-semibold">{r.action}</span> <span className="text-slate-600">{[r.entityType, r.entityId].filter(Boolean).join(' ')}</span>
          <span className="block text-xs text-slate-600 break-all">{r.actor} · {formatWhen(r.at)}</span></li>))}
    </ul>
  );
}

/** Admin settings, usage and audit. Only rendered for admins; never shows or accepts secrets. @param {{session:{isAdmin:boolean}}} props */
export default function AdminPanel({ session }) {
  const [tab, setTab] = useState('settings');
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    try { setSettings(normalizeSettings(await api('/admin/settings'))); setError(null); } catch (e) { setError(e); }
  }, []);
  useEffect(() => { if (session?.isAdmin) load(); }, [session?.isAdmin, load]);
  if (!session?.isAdmin) return <p className="p-6 text-sm text-slate-700 flex items-center gap-2"><ShieldAlert size={16} /> Admin access is required.</p>;
  const onSaved = (key, entry) => setSettings(s => ({ ...s, [key]: entry }));
  return (
    <div data-testid="admin-panel">
      <div role="tablist" aria-label="Admin sections" className="flex gap-1 p-2 border-b border-slate-200 bg-slate-50 overflow-x-auto">
        {TABS.map(([id, label]) => <button key={id} role="tab" type="button" aria-selected={tab === id} onClick={() => setTab(id)} className={`touch-target px-3 rounded text-sm font-semibold ${tab === id ? 'bg-red-700 text-white' : 'bg-white border border-slate-300'}`}>{label}</button>)}
      </div>
      {tab === 'usage' && <UsageTab />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'settings' && (
        <div className="p-3 sm:p-4 space-y-5">
          <p className="text-xs text-slate-600">Changes apply to everyone as soon as they are saved. API keys and other secrets are never shown or edited here.</p>
          {error && <p role="alert" className="text-sm text-red-700">{humanError(error)} <button type="button" onClick={load} className="underline">Retry</button></p>}
          {!settings && !error && <p className="text-sm text-slate-600">Loading settings…</p>}
          {settings && GROUPS.map(g => (
            <div key={g} className="space-y-2"><h3 className="font-bold text-slate-900">{g}</h3>
              <div className="grid gap-3 lg:grid-cols-2">{Object.entries(SETTING_META).filter(([, m]) => m.group === g).map(([key]) => <SettingCard key={key} settingKey={key} entry={settings[key]} onSaved={onSaved} onReload={load} />)}</div></div>))}
        </div>
      )}
    </div>
  );
}
