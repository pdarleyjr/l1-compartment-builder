import { useState } from 'react';
import { Loader2, LogIn } from 'lucide-react';
import { api } from '../lib/api.js';

const BTN = 'touch-target inline-flex items-center gap-1.5 bg-red-600 hover:bg-red-700 active:bg-red-800 disabled:opacity-60 text-white text-sm font-bold px-4 py-2 rounded-lg touch-manipulation';
const MAX_ROUNDS = 200; // each round imports a few photos; the Worker answers done:true when finished

/**
 * Action shown in the "being moved to the new service" banner. Without it nobody could sign in or finish the move:
 * the banner hid the sign-in button, and the move needs a signed-in admin.
 * - signed out: Sign in (MBFD Access)
 * - admin: "Move the plan now" repeats POST /api/admin/migrate-legacy until done, then shows the before/after counts
 * - other editors: says an admin must finish it
 * @param {{session:{status:string, isAdmin?:boolean}, signIn:()=>void}} props
 */
export default function MigrationAction({ session, signIn }) {
  const [state, setState] = useState({ phase: 'idle', left: null, report: null, error: '' });

  if (session.status !== 'signed_in') {
    return <button type="button" onClick={signIn} data-touch-target="true" className={BTN}><LogIn size={14} aria-hidden="true" /> Sign in</button>;
  }
  if (!session.isAdmin) return <span className="text-sm font-semibold">An admin needs to finish this.</span>;

  const run = async () => {
    setState({ phase: 'running', left: null, report: null, error: '' });
    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const res = await api('/admin/migrate-legacy', { method: 'POST', json: {} });
        if (res?.done) { setState({ phase: 'done', left: 0, report: res.report ?? null, error: '' }); return; }
        setState(s => ({ ...s, left: res?.remaining ?? null }));
      }
      setState(s => ({ ...s, phase: 'idle', error: 'The move is taking longer than expected. Tap again to continue.' }));
    } catch (e) {
      setState(s => ({ ...s, phase: 'idle', error: e?.message || 'The move failed. Nothing was lost; tap again to retry.' }));
    }
  };

  if (state.phase === 'done') {
    const a = state.report?.after ?? {};
    const b = state.report?.before ?? {};
    const same = ['compartments', 'occupiedSlots', 'equipment', 'bundles', 'uploadedImages'].every(k => a[k] === b[k]);
    return (
      <span className="flex flex-wrap items-center gap-3 text-sm">
        <span data-testid="migration-result">
          Done: {a.compartments ?? '?'} compartments, {a.occupiedSlots ?? '?'} tools placed, {a.uploadedImages ?? '?'} photos, {a.featured ?? '?'} main images.
          {same ? ' Counts match the old plan.' : ' Some counts differ from the old plan; tell your administrator.'}
        </span>
        <button type="button" onClick={() => window.location.reload()} className={BTN}>Continue</button>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-3 text-sm">
      {state.error && <span role="alert" className="text-red-800">{state.error}</span>}
      <button type="button" onClick={run} disabled={state.phase === 'running'} data-touch-target="true" data-testid="migration-run" className={BTN}>
        {state.phase === 'running'
          ? <><Loader2 size={14} className="animate-spin" aria-hidden="true" /> Moving{state.left != null ? ` (${state.left} photos left)` : '…'}</>
          : 'Move the plan now'}
      </button>
    </span>
  );
}
