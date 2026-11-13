// Server-backed compartment images: the authoritative main image per compartment (GET /api/public/main-images) and the
// per-compartment gallery (public variant, or the editor variant when signed in). Responses are cached in memory;
// photos themselves are served by the Worker (/api/public/assets/:id/:variant) and cached by the browser.
import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

/** Badge text per provenance (shared/contracts.js ASSET_PROVENANCE). */
export const PROVENANCE_LABEL = Object.freeze({
  user_photo: 'Photo', reference: 'Photo', legacy_upload: 'Photo', ai_concept: 'AI concept',
  approved_concept: 'Approved concept', as_built_photo: 'As-built',
});

/**
 * @typedef {{compartmentId:string, revision:number, kind:string, ref:string, url:string, thumbUrl:string|null,
 *   provenance:string, stale:boolean}} MainImage
 * @typedef {{key:string, id:string|null, kind:string, url:string, thumbUrl:string|null, title:string,
 *   provenance:string, deletable:boolean}} GalleryItem
 */

const isObj = v => v !== null && typeof v === 'object';

function toMain(m, compId) {
  if (!isObj(m) || typeof m.url !== 'string') return null;
  return {
    compartmentId: m.compartmentId ?? compId, revision: Number.isInteger(m.revision) ? m.revision : 0,
    kind: m.kind ?? 'asset', ref: String(m.ref ?? ''), url: m.url, thumbUrl: m.thumbUrl ?? null,
    provenance: m.provenance ?? 'user_photo', stale: m.stale === true,
  };
}

function toItem(it, i) {
  const url = it?.url ?? it?.variants?.display ?? it?.variants?.original;
  if (typeof url !== 'string') return null;
  const id = typeof it.id === 'string' ? it.id : null;
  return {
    key: id ?? `item-${i}`, id, kind: it.kind ?? 'asset', url, thumbUrl: it.thumbUrl ?? it.variants?.thumb ?? null,
    title: String(it.title ?? it.fileName ?? 'Photo'), provenance: it.provenance ?? 'user_photo',
    deletable: it.deletable !== false && !!id && (it.kind ?? 'asset') === 'asset',
  };
}

let mainPromise = null;
let mainCache = {};
const listeners = new Set();
const galleryCache = new Map(); // `${editor?'e':'p'}:${compId}` -> {main, items}
const epochListeners = new Set();

function publish(next) { mainCache = next; listeners.forEach(l => l(mainCache)); }

/** Load GET /api/public/main-images once (pass force to reload). @returns {Promise<Record<string, MainImage>>} */
export function loadMainImages({ force = false } = {}) {
  if (!mainPromise || force) {
    mainPromise = api('/public/main-images').then(body => {
      const raw = body?.mainImages ?? body?.images ?? body ?? {};
      const entries = Array.isArray(raw) ? raw.map(m => [m?.compartmentId, m]) : Object.entries(raw);
      const next = {};
      for (const [cid, m] of entries) { const main = toMain(m, cid); if (main && cid) next[cid] = main; }
      publish(next);
      return next;
    }).catch(() => { mainPromise = null; return mainCache; });
  }
  return mainPromise;
}

/** Load a compartment gallery (cached; force bypasses the cache). @returns {Promise<{main:MainImage|null, items:GalleryItem[]}>} */
export async function loadGallery(compId, { editor = false, force = false } = {}) {
  const key = `${editor ? 'e' : 'p'}:${compId}`;
  if (!force && galleryCache.has(key)) return galleryCache.get(key);
  const body = await api(editor ? `/compartments/${compId}/gallery` : `/public/compartments/${compId}/gallery`);
  const raw = body?.items ?? body?.assets ?? [];
  const value = { main: toMain(body?.main, compId), items: (Array.isArray(raw) ? raw : []).map(toItem).filter(Boolean) };
  galleryCache.set(key, value);
  return value;
}

/** Drop cached galleries (all, or one compartment) and optionally the main-image list. */
export function invalidateGallery(compId) {
  for (const k of [...galleryCache.keys()]) if (!compId || k.endsWith(`:${compId}`)) galleryCache.delete(k);
}

/** Reload the main-image list and every mounted gallery (after the Studio changed a main image, an upload, …). */
export function refreshGalleries() {
  invalidateGallery();
  epochListeners.forEach(fn => fn());
  return loadMainImages({ force: true });
}

/** Make a preset or an existing asset the compartment's main image (POST /api/compartments/:id/main-image). */
export async function setMainImage(compId, { kind, ref, expectRevision = 0 }) {
  const body = await api(`/compartments/${compId}/main-image`, { method: 'POST', json: { kind, ref, expectRevision } });
  invalidateGallery(compId);
  await loadMainImages({ force: true });
  return toMain(body?.main ?? body, compId);
}

/** Delete an uploaded photo (soft delete on the server). */
export async function deleteAsset(compId, assetId) {
  await api(`/assets/${assetId}`, { method: 'DELETE' });
  invalidateGallery(compId);
}

/** React hook: the main image of every compartment (loaded once, refreshed on tab focus and via refresh()). */
export function useMainImages() {
  const [mains, setMains] = useState(mainCache);
  useEffect(() => {
    listeners.add(setMains);
    loadMainImages().then(setMains);
    const onVisible = () => { if (document.visibilityState === 'visible') loadMainImages({ force: true }); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { listeners.delete(setMains); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  return { mainImages: mains, refreshMainImages: refreshGalleries };
}

/**
 * React hook: gallery of one compartment. Reloads when `version` changes (planner revision → stale badge) and on refresh().
 * @param {string} compId @param {{editor:boolean, version?:number}} opts
 */
export function useGallery(compId, { editor, version = 0 }) {
  const [state, setState] = useState({ main: null, items: [], loading: true, error: '', compId });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick(t => t + 1);
    epochListeners.add(bump);
    return () => epochListeners.delete(bump);
  }, []);
  useEffect(() => {
    let alive = true;
    const first = tick === 0 && version === 0;
    loadGallery(compId, { editor, force: !first || tick > 0 }).then(
      g => { if (alive) setState({ ...g, loading: false, error: '', compId }); },
      err => { if (alive) setState(s => ({ ...s, loading: false, error: err?.message || 'Could not load photos.', compId })); },
    );
    return () => { alive = false; };
  }, [compId, editor, version, tick]);
  const refresh = useCallback(() => { invalidateGallery(compId); setTick(t => t + 1); }, [compId]);
  const current = state.compId === compId ? state : { main: null, items: [], loading: true, error: '', compId };
  return { ...current, refresh };
}
