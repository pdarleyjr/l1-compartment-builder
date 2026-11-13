import { describe, expect, it } from 'vitest';
import { sniffImage } from '../../src/media.js';
import { heic, jpeg, png, webp } from './helpers/images.js';

describe('media.sniffImage', () => {
  it('identifies JPEG, PNG and WebP with dimensions', () => {
    expect(sniffImage(jpeg(640, 480))).toMatchObject({ type: 'image/jpeg', ext: 'jpg', width: 640, height: 480 });
    expect(sniffImage(png(100, 50))).toMatchObject({ type: 'image/png', ext: 'png', width: 100, height: 50 });
    expect(sniffImage(webp(320, 200))).toMatchObject({ type: 'image/webp', ext: 'webp', width: 320, height: 200 });
  });

  it('parses lossy and lossless WebP headers', () => {
    const lossy = new Uint8Array(40);
    lossy.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00]);
    expect(sniffImage(lossy)).toMatchObject({ width: 320, height: 240 });
    const lossless = new Uint8Array(40);
    lossless.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 0, 0, 0, 0, 0x2f, 99, 0, 0, 0]);
    expect(sniffImage(lossless)).toMatchObject({ width: 100, height: 1 });
  });

  it('rejects HEIC, text, GIF, truncated and empty input', () => {
    expect(sniffImage(heic())).toBeNull();
    expect(sniffImage(new TextEncoder().encode('<html>not an image at all</html>'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode('GIF89a......................'))).toBeNull();
    expect(sniffImage(jpeg().subarray(0, 8))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
    expect(sniffImage(null)).toBeNull();
  });

  it('skips JPEG segments before the frame header and rejects headers without one', () => {
    const b = new Uint8Array(40);
    b.set([0xff, 0xd8, 0xff, 0xe1, 0, 6, 1, 2, 3, 4, 0xff, 0xc2, 0, 11, 8, 0, 20, 0, 30, 1, 1, 0x11, 0]);
    expect(sniffImage(b)).toMatchObject({ width: 30, height: 20 });
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
});
