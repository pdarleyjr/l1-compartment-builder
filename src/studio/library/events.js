// Tiny pub/sub so the capture panel can tell the library (and any other Studio view) that assets changed.
const listeners = new Set();

/** @param {(compId:string)=>void} fn @returns {()=>void} unsubscribe */
export function onAssetsChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** @param {string} compId */
export function notifyAssetsChanged(compId) { for (const l of listeners) l(compId); }
