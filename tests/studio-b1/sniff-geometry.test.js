import { describe, expect, it } from 'vitest';
import { sniffImage } from '../../src/lib/image/sniff.js';
import {
  FULL_CROP, IOS_CANVAS_MAX_PIXELS, areaScale, clampCrop, fitWithin, normalizeRotation, outputSize, planTransform, rotateRect,
  rotatedSize, stepwiseSizes,
} from '../../src/lib/image/geometry.js';

const bytes = (...a) => new Uint8Array(a);
const ascii = s => Array.from(s, c => c.charCodeAt(0));
const ftyp = brand => bytes(0, 0, 0, 24, ...ascii('ftyp'), ...ascii(brand), 0, 0, 0, 0, ...ascii('mif1'), ...ascii(brand));

describe('sniffImage', () => {
  it('detects JPEG, PNG, WebP, GIF', () => {
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10))).toBe('jpeg');
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('png');
    expect(sniffImage(bytes(...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBP')))).toBe('webp');
    expect(sniffImage(bytes(...ascii('GIF89a'), 0))).toBe('gif');
  });
  it('detects HEIC and HEIF brands', () => {
    expect(sniffImage(ftyp('heic'))).toBe('heic');
    expect(sniffImage(ftyp('heix'))).toBe('heic');
    expect(sniffImage(ftyp('mif1'))).toBe('heif');
  });
  it('finds a HEIC compatible brand behind a generic major brand', () => {
    expect(sniffImage(bytes(0, 0, 0, 24, ...ascii('ftyp'), ...ascii('isom'), 0, 0, 0, 0, ...ascii('heic')))).toBe('heic');
  });
  it('never trusts text posing as an image', () => {
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('unknown');
    expect(sniffImage(bytes())).toBe('unknown');
    expect(sniffImage(bytes(0xff, 0xd8))).toBe('unknown');
    expect(sniffImage(bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')))).toBe('unknown');
  });
});

describe('resize math', () => {
  it('caps the long edge and never upscales', () => {
    expect(fitWithin(8000, 6000, 4096)).toMatchObject({ width: 4096, height: 3072 });
    expect(fitWithin(6000, 8000, 1600)).toMatchObject({ width: 1200, height: 1600 });
    expect(fitWithin(300, 200, 400)).toMatchObject({ width: 300, height: 200, scale: 1 });
    expect(fitWithin(1, 4000, 400).width).toBe(1);
  });
  it('guards the iOS canvas area', () => {
    expect(areaScale(4000, 4000)).toBe(1);
    const s = areaScale(10000, 10000);
    expect(s).toBeLessThan(1);
    const o = outputSize(10000, 10000, 20000);
    expect(o.width * o.height).toBeLessThanOrEqual(IOS_CANVAS_MAX_PIXELS);
  });
  it('plans stepwise halvings that end exactly at the target', () => {
    const steps = stepwiseSizes(8000, 6000, 1600, 1200);
    expect(steps.at(-1)).toEqual({ width: 1600, height: 1200 });
    let pw = 8000;
    for (const s of steps) { expect(pw / s.width).toBeLessThanOrEqual(2.0001); pw = s.width; }
    expect(stepwiseSizes(100, 100, 100, 100)).toEqual([]);
  });
});

describe('crop / rotate math', () => {
  it('normalizes rotations', () => {
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(rotatedSize(400, 300, 90)).toEqual({ width: 300, height: 400 });
    expect(rotatedSize(400, 300, 180)).toEqual({ width: 400, height: 300 });
  });
  it('clamps crop rects into the unit square', () => {
    expect(clampCrop({ x: -0.2, y: 0.9, w: 2, h: 0.5 })).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
    expect(clampCrop({ x: 0.5, y: 0.5, w: 0, h: 0 }).w).toBeGreaterThan(0);
  });
  it('plans rotate then crop in the rotated frame', () => {
    const p = planTransform(400, 200, { rotate: 90, crop: { x: 0, y: 0, w: 1, h: 0.5 } });
    expect(p).toMatchObject({ rotate: 90, rotatedWidth: 200, rotatedHeight: 400, sx: 0, sy: 0, sw: 200, sh: 200 });
    expect(planTransform(400, 200)).toMatchObject({ sw: 400, sh: 200 });
  });
  it('rotating a rect four times is the identity; once moves a top-left box to top-right', () => {
    const r = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
    const r4 = rotateRect(r, 360);
    expect(r4).toEqual(r);
    const tl = rotateRect({ x: 0, y: 0, w: 0.25, h: 0.5 }, 90);
    expect(tl.x).toBeCloseTo(0.5); expect(tl.y).toBeCloseTo(0); expect(tl.w).toBeCloseTo(0.5); expect(tl.h).toBeCloseTo(0.25);
    expect(rotateRect(FULL_CROP, 90)).toEqual(FULL_CROP);
  });
});

import { moveRect, nudgeRect, resizeRect } from '../../src/lib/image/geometry.js';
describe('rect editing math', () => {
  it('keeps a moved rect inside the image', () => {
    expect(moveRect({ x: 0.5, y: 0.5, w: 0.4, h: 0.4 }, 0.5, -1)).toEqual({ x: 0.6, y: 0, w: 0.4, h: 0.4 });
  });
  it('resizes from a handle keeping the opposite edge and the minimum size', () => {
    const r = resizeRect({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, 'nw', 0.1, 0.1);
    expect(r.x).toBeCloseTo(0.3); expect(r.w).toBeCloseTo(0.3); expect(r.x + r.w).toBeCloseTo(0.6);
    const tiny = resizeRect({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, 'se', -0.9, -0.9, 0.1);
    expect(tiny.w).toBeCloseTo(0.1); expect(tiny.x).toBeCloseTo(0.2);
    expect(resizeRect({ x: 0.2, y: 0.2, w: 0.7, h: 0.7 }, 'se', 0.5, 0.5).w).toBeCloseTo(0.8);
  });
  it('nudges with arrows and resizes with shift', () => {
    expect(nudgeRect({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, 'ArrowRight', false).x).toBeCloseTo(0.11);
    expect(nudgeRect({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, 'ArrowDown', true).h).toBeCloseTo(0.21);
    const r = { x: 0, y: 0, w: 0.5, h: 0.5 };
    expect(nudgeRect(r, 'a', false)).toBe(r);
  });
});
