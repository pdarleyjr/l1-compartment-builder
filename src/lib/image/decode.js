// Decode a user-selected file into something drawable. HEIC/HEIF is converted lazily (heic2any) only when the browser
// cannot decode it. Failures are typed with friendly messages; a file that cannot be decoded is never stored raw (FM-01).
import { isHeifFamily, sniffBlob } from './sniff.js';

export class ImageDecodeError extends Error {
  /** @param {'unsupported'|'heic'|'corrupt'|'too_large'|'empty'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'ImageDecodeError';
    this.code = code;
  }
}

export const HEIC_MESSAGE = 'This HEIC photo could not be converted on this device. Choose "Most Compatible" in the camera settings, or share it as JPEG.';
const MAX_SOURCE_BYTES = 80 * 1024 * 1024;

/** @param {Blob} blob @returns {Promise<{bitmap:ImageBitmap|HTMLImageElement, width:number, height:number, close:()=>void}>} */
async function tryDecode(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
    } catch { /* fall through to <img> */ }
  }
  if (typeof Image === 'undefined') throw new Error('no decoder');
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    // <img> honours EXIF orientation by default (image-orientation: from-image), so natural size is already upright.
    return { bitmap: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
  } finally {
    // The decoded image keeps its pixels after the URL is revoked.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Decode a file/blob. Orientation is applied. HEIC/HEIF is converted to JPEG only if the browser cannot decode it.
 * @param {Blob} file
 * @returns {Promise<{bitmap:ImageBitmap|HTMLImageElement, width:number, height:number, close:()=>void, converted:boolean}>}
 */
export async function decodeImage(file) {
  if (!file || file.size === 0) throw new ImageDecodeError('empty', 'That file is empty.');
  if (file.size > MAX_SOURCE_BYTES) throw new ImageDecodeError('too_large', 'That photo is too large (over 80 MB). Choose a smaller one.');
  const kind = await sniffBlob(file);
  if (kind === 'unknown') {
    const name = /** @type {File} */ (file).name ?? '';
    if (/\.(heic|heif)$/i.test(name)) throw new ImageDecodeError('heic', HEIC_MESSAGE);
    throw new ImageDecodeError('unsupported', 'That file is not a supported photo. Use JPEG, PNG, WebP, GIF or HEIC.');
  }
  try {
    const d = await tryDecode(file);
    if (d.width > 0 && d.height > 0) return { ...d, converted: false };
  } catch { /* try HEIC conversion below */ }

  if (isHeifFamily(kind)) {
    let jpeg;
    try {
      const { default: heic2any } = await import('heic2any');
      const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
      jpeg = Array.isArray(out) ? out[0] : out;
    } catch {
      throw new ImageDecodeError('heic', HEIC_MESSAGE);
    }
    try {
      const d = await tryDecode(jpeg);
      return { ...d, converted: true };
    } catch {
      throw new ImageDecodeError('heic', HEIC_MESSAGE);
    }
  }
  throw new ImageDecodeError('corrupt', 'That photo could not be read. It may be damaged — try taking it again.');
}
