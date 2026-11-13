// Re-encode a decoded image into the three upload variants. Re-encoding through a canvas strips all metadata (EXIF/GPS).
import { ASSET_LIMITS } from '../../../shared/contracts.js';
import { IOS_CANVAS_MAX_PIXELS, outputSize, planTransform, stepwiseSizes } from './geometry.js';

/** @typedef {{rotate?:number, crop?:{x:number,y:number,w:number,h:number}|null}} Transform */
/** @typedef {{blob:Blob, width:number, height:number, bytes:number, sha256:string, type:string}} EncodedVariant */

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

async function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

/** @param {Blob} blob @returns {Promise<string>} hex sha256 */
export async function sha256OfBlob(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Draw the transformed source into a canvas of the requested size. Very large sources are downscaled stepwise.
 * Transparent areas are flattened on WHITE (FM-04).
 */
function render(source, plan, dst, flatten) {
  // Stage 1: rotate+crop into a canvas, already reduced by at most 2× (keeps peak memory low for 48 MP sources).
  const pre = Math.min(1, Math.max(dst.width / plan.sw, dst.height / plan.sh, 0.5));
  const bw = Math.max(1, Math.round(plan.sw * pre));
  const bh = Math.max(1, Math.round(plan.sh * pre));
  const base = makeCanvas(bw, bh);
  const ctx = base.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.scale(bw / plan.sw, bh / plan.sh);
  switch (plan.rotate) {
    case 90: ctx.translate(plan.sw, 0); ctx.rotate(Math.PI / 2); break;
    case 180: ctx.translate(plan.sw, plan.sh); ctx.rotate(Math.PI); break;
    case 270: ctx.translate(0, plan.sh); ctx.rotate(-Math.PI / 2); break;
    default: break;
  }
  // Source rect in unrotated source coordinates for a crop made in the rotated frame.
  const rw = plan.rotatedWidth;
  const rh = plan.rotatedHeight;
  let ux = plan.sx; let uy = plan.sy; let uw = plan.sw; let uh = plan.sh;
  if (plan.rotate === 90) { ux = plan.sy; uy = rw - plan.sx - plan.sw; uw = plan.sh; uh = plan.sw; }
  else if (plan.rotate === 180) { ux = rw - plan.sx - plan.sw; uy = rh - plan.sy - plan.sh; }
  else if (plan.rotate === 270) { ux = rh - plan.sy - plan.sh; uy = plan.sx; uw = plan.sh; uh = plan.sw; }
  ctx.drawImage(source, ux, uy, uw, uh, 0, 0, uw, uh);
  if (flatten) {
    // Flatten transparency onto white by painting underneath the drawn pixels (FM-04).
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, bw, bh);
    ctx.globalCompositeOperation = 'source-over';
  }
  // Stage 2: stepwise downscale to the destination size.
  let cur = base;
  let cw = bw;
  let ch = bh;
  for (const step of stepwiseSizes(cw, ch, dst.width, dst.height)) {
    const next = makeCanvas(step.width, step.height);
    const nctx = next.getContext('2d');
    nctx.imageSmoothingQuality = 'high';
    nctx.drawImage(cur, 0, 0, cw, ch, 0, 0, step.width, step.height);
    cur = next; cw = step.width; ch = step.height;
  }
  return cur;
}

/**
 * Encode one variant.
 * @param {ImageBitmap|HTMLImageElement} source
 * @param {{width:number,height:number}} src natural (oriented) source size
 * @param {Transform} transform
 * @param {{maxEdge:number, types:string[], quality:number, flatten:boolean}} spec first supported type wins
 * @returns {Promise<EncodedVariant>}
 */
async function encodeVariant(source, src, transform, spec) {
  const plan = planTransform(src.width, src.height, transform);
  const dst = outputSize(plan.sw, plan.sh, spec.maxEdge, IOS_CANVAS_MAX_PIXELS);
  const canvas = render(source, plan, dst, spec.flatten);
  const out = canvas;
  for (const type of spec.types) {
    const blob = await canvasToBlob(out, type, spec.quality);
    // Browsers silently fall back to PNG when a type is unsupported (old Safari for WebP) — detect and try the next.
    if (blob && blob.type === type && blob.size > 0) {
      return { blob, width: dst.width, height: dst.height, bytes: blob.size, sha256: await sha256OfBlob(blob), type };
    }
  }
  throw new Error('This browser could not encode the photo. Try a different browser.');
}

/**
 * Produce original (JPEG q0.92 ≤4096 px, white-flattened), display (WebP q0.82 ≤1600, JPEG fallback) and thumb
 * (WebP q0.8 ≤400, JPEG fallback). Metadata is stripped by re-encoding.
 * @param {ImageBitmap|HTMLImageElement} source
 * @param {{width:number,height:number}} size
 * @param {Transform} [transform]
 * @returns {Promise<{original:EncodedVariant, display:EncodedVariant, thumb:EncodedVariant}>}
 */
export async function encodeVariants(source, size, transform = {}) {
  const original = await encodeVariant(source, size, transform, { maxEdge: ASSET_LIMITS.originalMaxEdge, types: ['image/jpeg'], quality: 0.92, flatten: true });
  const display = await encodeVariant(source, size, transform, { maxEdge: ASSET_LIMITS.displayMaxEdge, types: ['image/webp', 'image/jpeg'], quality: 0.82, flatten: true });
  const thumb = await encodeVariant(source, size, transform, { maxEdge: ASSET_LIMITS.thumbMaxEdge, types: ['image/webp', 'image/jpeg'], quality: 0.8, flatten: true });
  return { original, display, thumb };
}

/**
 * Small JPEG preview for review screens (not uploaded).
 * @param {ImageBitmap|HTMLImageElement} source @param {{width:number,height:number}} size @param {Transform} [transform] @param {number} [maxEdge]
 * @returns {Promise<Blob>}
 */
export async function encodePreview(source, size, transform = {}, maxEdge = 720) {
  const v = await encodeVariant(source, size, transform, { maxEdge, types: ['image/jpeg'], quality: 0.7, flatten: true });
  return v.blob;
}
