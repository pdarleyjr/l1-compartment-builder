import { useCallback, useEffect, useState } from 'react';
import { listVersions } from '../../lib/jobs.js';

/** Loads a compartment's versions; call refresh() after a job completes or a version changes. */
export function useVersions(compId) {
  const [state, setState] = useState({ versions: [], loaded: false, error: null });
  const refresh = useCallback(async () => {
    try { setState({ versions: await listVersions(compId), loaded: true, error: null }); } catch (error) { setState(s => ({ ...s, loaded: true, error })); }
  }, [compId]);
  useEffect(() => { setState({ versions: [], loaded: false, error: null }); refresh(); }, [refresh]);
  return { ...state, refresh };
}
