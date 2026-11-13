// Magic-byte image sniffing. Never trust the file extension or the declared MIME type.

/** @typedef {'jpeg'|'png'|'webp'|'heic'|'heif'|'gif'|'unknown'} ImageKind */

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);
const HEIF_BRANDS = new Set(['mif1', 'msf1', 'heif']);

const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to));

/**
 * Identify an image from its first bytes.
 * @param {Uint8Array|ArrayBuffer} input at least the first 16 bytes
 * @returns {ImageKind}
 */
export function sniffImage(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'gif';
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (HEIC_BRANDS.has(brand)) return 'heic';
    if (HEIF_BRANDS.has(brand)) return 'heif';
    // Some files list the real brand as a compatible brand after a generic major brand.
    for (let i = 16; i + 4 <= Math.min(b.length, 64); i += 4) {
      const c = ascii(b, i, i + 4);
      if (HEIC_BRANDS.has(c)) return 'heic';
      if (HEIF_BRANDS.has(c)) return 'heif';
    }
  }
  return 'unknown';
}

/** Read the first bytes of a Blob and sniff them. @param {Blob} blob @returns {Promise<ImageKind>} */
export async function sniffBlob(blob) {
  const head = await blob.slice(0, 64).arrayBuffer();
  return sniffImage(new Uint8Array(head));
}

/** @param {ImageKind} kind @returns {boolean} */
export const isHeifFamily = kind => kind === 'heic' || kind === 'heif';
