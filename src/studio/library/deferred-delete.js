// Client-side undo for deleting a photo: the DELETE request is delayed 10 s and cancelled by Undo (there is no restore
// endpoint). Module-level so a pending delete still fires if the library unmounts.
import { api } from '../../lib/api.js';

export const UNDO_MS = 10_000;
const pending = new Map();
const listeners = new Set();
let snapshot = new Set();
const emit = () => { snapshot = new Set(pending.keys()); for (const l of listeners) l(); };

/** @param {()=>void} fn @returns {()=>void} */
export function subscribeDeletes(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** ids currently waiting for their DELETE */
export function pendingDeleteIds() { return snapshot; }

/**
 * Schedule DELETE /assets/:id after UNDO_MS.
 * @param {object} asset @param {{onDone?:(asset:object)=>void, onError?:(asset:object, err:Error)=>void, delayMs?:number, request?:Function}} [o]
 */
export function scheduleDelete(asset, { onDone, onError, delayMs = UNDO_MS, request = api } = {}) {
  if (pending.has(asset.id)) return;
  const timer = setTimeout(async () => {
    try {
      await request(`/assets/${asset.id}`, { method: 'DELETE' });
      pending.delete(asset.id); emit(); onDone?.(asset);
    } catch (e) { pending.delete(asset.id); emit(); onError?.(asset, e); }
  }, delayMs);
  pending.set(asset.id, { asset, timer });
  emit();
}

/** Cancel a scheduled delete. @returns {boolean} true when it was still pending */
export function undoDelete(id) {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer); pending.delete(id); emit();
  return true;
}
