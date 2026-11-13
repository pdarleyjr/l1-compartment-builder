import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api, newKey } from '../../lib/api.js';
import { BTN_SECONDARY } from '../capture/styles.js';
import { unwrapAssets } from './useAssets.js';

const POLL_MS = 3000;
const POLL_MAX = 60;

/**
 * “Suggest tools (AI)”: starts a recognize job, polls it, and lists suggested links as UNCONFIRMED chips. Each must be
 * confirmed (PATCH state confirmed) or dismissed (state rejected). Nothing is ever committed automatically.
 * @param {{compId:string, assetId:string, onSuggestions:(links:object[])=>void, onConfirm:(link:object)=>void}} props
 */
export function SuggestionsPanel({ compId, assetId, onSuggestions, onConfirm }) {
  const [status, setStatus] = useState('idle'); // idle | running | done | error
  const [message, setMessage] = useState('');
  const [links, setLinks] = useState([]);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const push = useCallback(next => { setLinks(next); onSuggestions(next); }, [onSuggestions]);

  const loadSuggested = useCallback(async () => {
    const list = unwrapAssets(await api(`/compartments/${encodeURIComponent(compId)}/assets`));
    const asset = list.find(a => a.id === assetId);
    push((asset?.links ?? []).filter(l => l.state === 'suggested'));
  }, [compId, assetId, push]);

  const start = async () => {
    setStatus('running'); setMessage('Looking at the photo…');
    try {
      const res = await api(`/compartments/${encodeURIComponent(compId)}/jobs`, { method: 'POST', json: { kind: 'recognize', assetId }, idempotencyKey: newKey('recognize') });
      let job = res.job ?? res;
      for (let i = 0; i < POLL_MAX && alive.current && !['completed', 'failed', 'cancelled'].includes(job.status); i += 1) {
        await new Promise(r => setTimeout(r, POLL_MS));
        const next = await api(`/jobs/${job.id}`);
        job = next.job ?? next;
      }
      if (!alive.current) return;
      if (job.status === 'failed' || job.status === 'cancelled') { setStatus('error'); setMessage(job.errorMessage || 'The suggestion request did not finish. You can still pick tools by hand.'); return; }
      if (job.status !== 'completed') { setStatus('error'); setMessage('That is taking longer than expected. You can still pick tools by hand.'); return; }
      await loadSuggested();
      setStatus('done'); setMessage('');
    } catch (e) {
      if (alive.current) { setStatus('error'); setMessage(e?.message || 'Suggestions are not available right now.'); }
    }
  };

  const decide = async (link, state) => {
    try {
      await api(`/links/${link.id}`, { method: 'PATCH', json: { state } });
      push(links.filter(l => l.id !== link.id));
      if (state === 'confirmed') onConfirm(link);
    } catch (e) { setMessage(e?.message || 'Could not update that suggestion.'); }
  };

  return (
    <section className="rounded-lg border border-amber-300 bg-amber-50 p-3 flex flex-col gap-2" aria-label="AI suggestions">
      <button type="button" className={`${BTN_SECONDARY} self-start`} onClick={start} disabled={status === 'running'} data-testid="assoc-suggest">
        <Sparkles size={16} aria-hidden="true" /> {status === 'running' ? 'Suggesting…' : 'Suggest tools (AI)'}
      </button>
      <p className="text-xs text-slate-600">AI only suggests. Nothing is linked until you confirm each tool.</p>
      <div aria-live="polite" className="text-sm text-slate-700">{message}</div>
      {status === 'done' && !links.length && <p className="text-sm text-slate-600">No suggestions to review.</p>}
      <ul className="flex flex-col gap-2">
        {links.map(l => (
          <li key={l.id} className="flex flex-wrap items-center gap-2 bg-white border border-dashed border-amber-400 rounded p-2" data-testid="assoc-suggestion">
            <span className="text-sm font-medium text-slate-800 flex-1 min-w-0 break-words">{l.label || l.targetId} <span className="text-xs font-normal text-amber-700">· unconfirmed</span></span>
            <button type="button" className={BTN_SECONDARY} onClick={() => decide(l, 'confirmed')} aria-label={`Confirm ${l.label || 'suggestion'}`}>Confirm</button>
            <button type="button" className={BTN_SECONDARY} onClick={() => decide(l, 'rejected')} aria-label={`Dismiss ${l.label || 'suggestion'}`}>Dismiss</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
