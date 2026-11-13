import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { onAssetsChanged } from './events.js';

/** Normalize list responses ({assets:[…]} or a bare array). */
export const unwrapAssets = r => r.assets;

/**
 * Assets of one compartment (editor list, newest first as returned). Reloads when the capture panel commits.
 * @param {string} compId
 */
export function useAssets(compId) {
  const [state, setState] = useState({ assets: [], loading: true, error: '' });
  const load = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: '' }));
    try {
      const assets = unwrapAssets(await api(`/compartments/${encodeURIComponent(compId)}/assets`));
      setState({ assets: assets.filter(a => a.status !== 'deleted'), loading: false, error: '' });
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: e?.message || 'Could not load photos.' }));
    }
  }, [compId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onAssetsChanged(id => { if (id === compId) load(); }), [compId, load]);
  const replace = useCallback(asset => setState(s => ({ ...s, assets: s.assets.map(a => (a.id === asset.id ? { ...a, ...asset } : a)) })), []);
  const drop = useCallback(id => setState(s => ({ ...s, assets: s.assets.filter(a => a.id !== id) })), []);
  return { ...state, reload: load, replace, drop };
}
