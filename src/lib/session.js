// Session state for the browser: who is signed in (Cloudflare Access identity via the Worker) and what they may do.
// Anonymous visitors keep read-only access; editing and the Studio require sign-in.
import { useCallback, useEffect, useState } from 'react';
import { api, signInUrl } from './api.js';

/** @typedef {{status:'loading'|'signed_in'|'signed_out'|'unavailable', email:string|null, roles:string[],
 *   studioEnabled:boolean, aiEnabled:boolean, canEdit:boolean, isAdmin:boolean}} Session */

const SIGNED_OUT = { status: 'signed_out', email: null, roles: [], studioEnabled: false, aiEnabled: false, canEdit: false, isAdmin: false };

export async function fetchSession() {
  try {
    const s = await api('/session');
    const roles = Array.isArray(s?.roles) ? s.roles : [];
    if (!s?.email) return { ...SIGNED_OUT, studioEnabled: !!s?.studioEnabled };
    return {
      status: 'signed_in',
      email: s.email,
      roles,
      studioEnabled: !!s.studioEnabled,
      aiEnabled: !!s.aiEnabled,
      canEdit: roles.includes('editor'),
      isAdmin: roles.includes('admin'),
    };
  } catch (err) {
    if (err?.name === 'AuthRequiredError') return SIGNED_OUT;
    return { ...SIGNED_OUT, status: 'unavailable' };
  }
}

/** React hook: current session plus actions. */
export function useSession() {
  const [session, setSession] = useState({ ...SIGNED_OUT, status: 'loading' });
  const refresh = useCallback(async () => setSession(await fetchSession()), []);
  useEffect(() => {
    let alive = true;
    fetchSession().then(s => { if (alive) setSession(s); });
    return () => { alive = false; };
  }, []);
  const signIn = useCallback(() => { window.location.assign(signInUrl()); }, []);
  return { session, refresh, signIn };
}
