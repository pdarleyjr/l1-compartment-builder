// Pure geometry for resize / crop / rotate. No DOM access so it can be unit tested in Node.

/** Longest side of the largest decoded canvas older iOS Safari allows (about 16.7 megapixels). */
export const IOS_CANVAS_MAX_PIXELS = 16_777_216;
/** Sources above this are downscaled stepwise to keep peak memory low. */
export const STEPWISE_THRESHOLD_PIXELS = 12_000_000;

/**
 * Scale (w,h) so the long edge is at most maxEdge. Never upscales. Result is integer ≥ 1.
 * @param {number} w @param {number} h @param {number} maxEdge
 * @returns {{width:number, height:number, scale:number}}
 */
export function fitWithin(w, h, maxEdge) {
  const long = Math.max(w, h);
  const scale = long > maxEdge ? maxEdge / long : 1;
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale };
}

/** Largest scale ≤ 1 that keeps width×height within maxPixels (canvas area guard). */
export function areaScale(w, h, maxPixels = IOS_CANVAS_MAX_PIXELS) {
  const area = w * h;
  return area <= maxPixels ? 1 : Math.sqrt(maxPixels / area);
}

/**
 * Sequence of intermediate sizes for a stepwise downscale (each step ≤ 2× reduction → better quality, less memory).
 * @returns {{width:number,height:number}[]} ends at the target size (empty when no resize is needed)
 */
export function stepwiseSizes(srcW, srcH, dstW, dstH) {
  const steps = [];
  let w = srcW;
  let h = srcH;
  while (w / 2 > dstW && h / 2 > dstH) {
    w = Math.round(w / 2);
    h = Math.round(h / 2);
    steps.push({ width: w, height: h });
  }
  if (w !== dstW || h !== dstH) steps.push({ width: dstW, height: dstH });
  return steps;
}

/** @param {number} deg @returns {0|90|180|270} */
export function normalizeRotation(deg) {
  return /** @type {0|90|180|270} */ ((((Math.round(deg / 90) * 90) % 360) + 360) % 360);
}

/** Size after rotating a w×h image by rot degrees. */
export function rotatedSize(w, h, rot) {
  return normalizeRotation(rot) % 180 === 0 ? { width: w, height: h } : { width: h, height: w };
}

/** Clamp a normalized crop rect to the unit square with a minimum size. @returns {{x:number,y:number,w:number,h:number}} */
export function clampCrop(c, min = 0.05) {
  const w = Math.min(1, Math.max(min, c.w));
  const h = Math.min(1, Math.max(min, c.h));
  const x = Math.min(1 - w, Math.max(0, c.x));
  const y = Math.min(1 - h, Math.max(0, c.y));
  return { x, y, w, h };
}

/** Full-image crop. */
export const FULL_CROP = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

/** @param {{x:number,y:number,w:number,h:number}|null|undefined} c */
export const isFullCrop = c => !c || (c.x <= 0 && c.y <= 0 && c.w >= 1 && c.h >= 1);

/**
 * Rotate a normalized rect (in the ORIGINAL image's frame) by 90° steps clockwise, returning the rect in the rotated frame.
 * Used to keep an existing crop box in place when the user rotates.
 */
export function rotateRect(r, rot) {
  let { x, y, w, h } = r;
  for (let i = 0; i < normalizeRotation(rot) / 90; i += 1) {
    [x, y, w, h] = [1 - y - h, x, h, w];
  }
  return { x, y, w, h };
}

/**
 * Plan the output of rotating then cropping: the crop rect is expressed in the ROTATED frame.
 * @param {number} srcW @param {number} srcH @param {{rotate?:number, crop?:{x:number,y:number,w:number,h:number}|null}} t
 * @returns {{rotate:0|90|180|270, rotatedWidth:number, rotatedHeight:number, sx:number, sy:number, sw:number, sh:number}}
 */
export function planTransform(srcW, srcH, t = {}) {
  const rotate = normalizeRotation(t.rotate ?? 0);
  const rs = rotatedSize(srcW, srcH, rotate);
  const c = clampCrop(isFullCrop(t.crop) ? FULL_CROP : t.crop);
  const sx = Math.round(c.x * rs.width);
  const sy = Math.round(c.y * rs.height);
  const sw = Math.max(1, Math.min(rs.width - sx, Math.round(c.w * rs.width)));
  const sh = Math.max(1, Math.min(rs.height - sy, Math.round(c.h * rs.height)));
  return { rotate, rotatedWidth: rs.width, rotatedHeight: rs.height, sx, sy, sw, sh };
}

/**
 * Final output size for a variant: crop size capped by the long edge and the canvas area guard.
 * @returns {{width:number,height:number}}
 */
export function outputSize(sw, sh, maxEdge, maxPixels = IOS_CANVAS_MAX_PIXELS) {
  const a = fitWithin(sw, sh, maxEdge);
  const s = areaScale(a.width, a.height, maxPixels);
  return s < 1 ? { width: Math.max(1, Math.floor(a.width * s)), height: Math.max(1, Math.floor(a.height * s)) } : { width: a.width, height: a.height };
}

/** Move a normalized rect by (dx,dy) (also normalized), keeping it inside the unit square. */
export function moveRect(r, dx, dy) {
  return clampCrop({ ...r, x: r.x + dx, y: r.y + dy }, 0);
}

/**
 * Drag one handle ('nw'|'ne'|'sw'|'se'|'n'|'s'|'e'|'w') by (dx,dy). The opposite edge stays fixed; the box never flips
 * and never drops below `min`.
 */
export function resizeRect(r, handle, dx, dy, min = 0.05) {
  let l = r.x; let t = r.y; let rt = r.x + r.w; let b = r.y + r.h;
  if (handle.includes('w')) l = Math.min(Math.max(0, l + dx), rt - min);
  if (handle.includes('e')) rt = Math.max(Math.min(1, rt + dx), l + min);
  if (handle.includes('n')) t = Math.min(Math.max(0, t + dy), b - min);
  if (handle.includes('s')) b = Math.max(Math.min(1, b + dy), t + min);
  return { x: l, y: t, w: rt - l, h: b - t };
}

/** Keyboard nudge: arrows move, Shift+arrows resize the bottom-right corner. */
export function nudgeRect(r, key, shift, step = 0.01, min = 0.05) {
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[key];
  if (!d) return r;
  return shift ? resizeRect(r, 'se', d[0], d[1], min) : moveRect(r, d[0], d[1]);
}
