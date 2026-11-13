// Three-step asset upload for a markup PNG (same API as part B1's capture flow): create → PUT variants → commit.
import { API_BASE, api, newKey } from '../../lib/api.js';
import { ASSET_LIMITS } from '../../../shared/contracts.js';

/** @param {Blob} blob */
async function sha256Hex(blob) {
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
}
const toApiPath = url => (url.startsWith(API_BASE) ? url.slice(API_BASE.length) : url);

/** Largest PNG we may send for all three variants. */
export const MARKUP_MAX_BYTES = Math.min(ASSET_LIMITS.thumbMaxBytes, ASSET_LIMITS.displayMaxBytes, ASSET_LIMITS.originalMaxBytes);

/**
 * Upload a markup PNG as an asset (category 'markup'); original/display/thumb all use the same bytes.
 * @param {{compId:string, png:Blob, width:number, height:number, idempotencyKey?:string}} p @returns {Promise<string>} asset id
 */
export async function uploadMarkup({ compId, png, width, height, idempotencyKey = newKey('markup') }) {
  if (png.size > MARKUP_MAX_BYTES) throw new Error('The markup drawing is too large. Remove some freehand strokes and try again.');
  const created = await api('/assets', { method: 'POST', idempotencyKey, json: {
    compartmentId: compId, category: 'markup', title: 'Edit markup', width, height, bytes: png.size, sha256: await sha256Hex(png), idempotencyKey,
  } });
  const id = created?.asset?.id;
  if (!id) throw new Error('The server did not accept the markup upload.');
  for (const variant of ['original', 'display', 'thumb']) {
    const url = created.upload?.[variant] ?? `${API_BASE}/assets/${id}/${variant}`;
    await api(toApiPath(url), { method: 'PUT', body: png, headers: { 'Content-Type': 'image/png' }, expect: 'response' });
  }
  await api(`/assets/${encodeURIComponent(id)}/commit`, { method: 'POST', json: {} });
  return id;
}
