/* global Buffer -- Node 22 runtime globals (AIW processor runs on Node, not in the browser/Worker) */
// sharp-based image preparation: reference normalisation, contact sheets, output derivatives.
import sharp from 'sharp';
import { ASSET_LIMITS } from '../../shared/contracts.js';

const LONG_EDGE = 2048;
const open = bytes => sharp(bytes, { failOn: 'none', limitInputPixels: 120_000_000 });
const esc = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

/**
 * Auto-orient, strip metadata, cap the long edge at 2048 px. PNG when the image has transparency, else JPEG q90
 * (both accepted by the Images API edits endpoint and the Responses vision input).
 * @param {Buffer} bytes
 * @returns {Promise<{bytes:Buffer, mime:string, width:number, height:number}>}
 */
export async function normalizeReference(bytes) {
  const meta = await open(bytes).metadata();
  const pipeline = open(bytes).rotate().resize({ width: LONG_EDGE, height: LONG_EDGE, fit: 'inside', withoutEnlargement: true });
  const { data, info } = meta.hasAlpha
    ? await pipeline.png().toBuffer({ resolveWithObject: true })
    : await pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 90, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return { bytes: data, mime: meta.hasAlpha ? 'image/png' : 'image/jpeg', width: info.width, height: info.height };
}

/**
 * Markup layer: transparent PNG with exactly the base image's dimensions (API requirement).
 * @param {Buffer} bytes @param {{width:number, height:number}} base
 */
export async function normalizeMarkup(bytes, base) {
  const { data } = await open(bytes).rotate().ensureAlpha()
    .resize({ width: base.width, height: base.height, fit: 'fill' }).png().toBuffer({ resolveWithObject: true });
  return { bytes: data, mime: 'image/png', width: base.width, height: base.height };
}

/**
 * Labelled grid (≤ 6 tiles, 3 columns) so several reference photos consume one image slot.
 * Labels are SVG text; install a system font (fonts-dejavu-core) on the host.
 * @param {{bytes:Buffer, label:string}[]} tiles @param {{title?:string}} [opts]
 */
export async function buildContactSheet(tiles, opts = {}) {
  if (!tiles.length || tiles.length > 6) throw new RangeError('contact sheet needs 1-6 tiles');
  const cols = Math.min(3, tiles.length);
  const rows = Math.ceil(tiles.length / cols);
  const cell = 640; const bar = 56; const gap = 8;
  const W = cols * cell + (cols + 1) * gap; const H = rows * (cell + bar) + (rows + 1) * gap;
  const layers = [];
  for (let i = 0; i < tiles.length; i++) {
    const x = gap + (i % cols) * (cell + gap); const y = gap + Math.floor(i / cols) * (cell + bar + gap);
    const img = await open(tiles[i].bytes).rotate().resize({ width: cell, height: cell, fit: 'contain', background: '#f3f3f3' }).png().toBuffer();
    const label = esc(`${i + 1}. ${tiles[i].label}`.slice(0, 60));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${bar}"><rect width="100%" height="100%" fill="#111"/>`
      + `<text x="12" y="${bar / 2 + 9}" font-family="DejaVu Sans, Arial, sans-serif" font-size="26" fill="#fff">${label}</text></svg>`;
    layers.push({ input: img, left: x, top: y }, { input: Buffer.from(svg), left: x, top: y + cell });
  }
  const sheet = sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } }).composite(layers)
    .resize({ width: LONG_EDGE, height: LONG_EDGE, fit: 'inside', withoutEnlargement: true });
  const { data, info } = await sheet.jpeg({ quality: 88 }).toBuffer({ resolveWithObject: true });
  return { bytes: data, mime: 'image/jpeg', width: info.width, height: info.height, title: opts.title || null };
}

/**
 * Output derivatives: original as returned (PNG/JPEG/WebP; anything else becomes PNG), display WebP ≤ 1600 px q82,
 * thumb WebP ≤ 400 px q80. Sizes are checked against the Worker's upload caps.
 * @param {Buffer} bytes
 */
export async function buildDerivatives(bytes) {
  const meta = await open(bytes).metadata();
  const oriented = open(bytes).rotate();
  let original = { bytes, mime: `image/${meta.format === 'jpg' ? 'jpeg' : meta.format}` };
  if (!['png', 'jpeg', 'webp'].includes(meta.format)) original = { bytes: await oriented.clone().png().toBuffer(), mime: 'image/png' };
  const display = await oriented.clone().resize({ width: ASSET_LIMITS.displayMaxEdge, height: ASSET_LIMITS.displayMaxEdge, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  const thumb = await oriented.clone().resize({ width: ASSET_LIMITS.thumbMaxEdge, height: ASSET_LIMITS.thumbMaxEdge, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
  if (original.bytes.length > ASSET_LIMITS.originalMaxBytes) throw new RangeError('output original exceeds the upload cap');
  const swap = (meta.orientation || 1) >= 5;
  return {
    original, display: { bytes: display, mime: 'image/webp' }, thumb: { bytes: thumb, mime: 'image/webp' },
    width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height,
  };
}
