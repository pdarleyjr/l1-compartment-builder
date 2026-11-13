// Magic-byte image sniffing and dimension parsing for JPEG / PNG / WebP (no dependencies).
// Declared MIME types and file extensions are never trusted; only the bytes decide.

/** @type {Record<string,string>} */
export const EXT_BY_TYPE = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' });
export const TYPE_BY_EXT = Object.freeze({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' });
export const KNOWN_EXTENSIONS = Object.freeze(Object.keys(TYPE_BY_EXT));

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const ascii = (b, i, n) => String.fromCharCode(...b.subarray(i, i + n));

function jpegDims(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i += 1; continue; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) { i += 2; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

function pngDims(b) {
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function webpDims(b) {
  if (b.length < 30) return null;
  const kind = ascii(b, 12, 4);
  if (kind === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (kind === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    return {
      width: 1 + (b[21] | ((b[22] & 0x3f) << 8)),
      height: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)),
    };
  }
  if (kind === 'VP8X') {
    return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  return null;
}

/**
 * Identify an image by its leading bytes and parse its pixel dimensions.
 * @param {Uint8Array} bytes
 * @returns {{type:'image/jpeg'|'image/png'|'image/webp', ext:'jpg'|'png'|'webp', width:number, height:number}|null}
 *   null for anything else (HEIC, GIF, SVG, HTML, truncated or corrupt headers).
 */
export function sniffImage(bytes) {
  if (!bytes || bytes.length < 12) return null;
  let type = null;
  let dims = null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    type = 'image/jpeg'; dims = jpegDims(bytes);
  } else if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    type = 'image/png'; dims = pngDims(bytes);
  } else if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    type = 'image/webp'; dims = webpDims(bytes);
  }
  if (!type || !dims || !(dims.width > 0) || !(dims.height > 0)) return null;
  return { type, ext: EXT_BY_TYPE[type], width: dims.width, height: dims.height };
}

/** Decode-bomb guard: a few header bytes can declare 65535x65535 pixels. Limits are per edge and in total pixels. */
export const PIXEL_LIMITS = Object.freeze({
  upload: Object.freeze({ maxEdge: 4096, maxPixels: 4096 * 4096 }),
  output: Object.freeze({ maxEdge: 8192, maxPixels: 36_000_000 }),
});

/** @param {{width:number,height:number}} dims @param {'upload'|'output'} [kind] @returns {boolean} true when within limits */
export function withinPixelLimits(dims, kind = 'upload') {
  const lim = PIXEL_LIMITS[kind];
  return dims.width <= lim.maxEdge && dims.height <= lim.maxEdge && dims.width * dims.height <= lim.maxPixels;
}

/** Content types the Worker will ever emit for stored image bytes. */
export const SERVABLE_TYPES = Object.freeze(new Set(Object.values(TYPE_BY_EXT)));
