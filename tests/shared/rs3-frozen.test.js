// RS3 is frozen by owner directive (2026-11-18). These literals are the definitions that were live before the loadout
// update; any change to RS3's presets, spec, dimensions, image file or notes lock must be a deliberate, reviewed edit.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { COMPARTMENTS, COMPARTMENT_SPECS } from '../../shared/apparatus.js';
import { MANUAL_DIMENSIONS } from '../../shared/apparatus-render.js';
import { NOTES_LOCKED_COMPARTMENTS } from '../../shared/contracts.js';

describe('RS3 is unchanged', () => {
  test('preset images', () => {
    expect(COMPARTMENTS.find(c => c.id === 'RS3')).toEqual({
      id: 'RS3', side: 'Right', images: [{ src: '/images/RS3.webp', title: 'Compartment Photo' }],
    });
  });
  test('spec text and dimensions', () => {
    expect(COMPARTMENT_SPECS.RS3).toBe('Right Side 3 (RS3): Wide horizontal compartment, right side. Fixed tray: 15" D × 56" W × 16" H total interior height. Very wide and shallow. Note: tires located directly below this compartment.');
    expect(MANUAL_DIMENSIONS.RS3).toEqual({ widthIn: 56, heightIn: 16, depthIn: 15 });
  });
  test('image file bytes', () => {
    const sha = createHash('sha256').update(readFileSync(new URL('../../public/images/RS3.webp', import.meta.url))).digest('hex');
    expect(sha).toBe('0a94d90e7aea2f67b00d9fc3221080531579acb8867969efc785ea179ca757b1');
  });
  test('notes stay locked', () => {
    expect(NOTES_LOCKED_COMPARTMENTS).toContain('RS3');
  });
});

describe('2026-11-18 loadout renderings', () => {
  test('are the first preset of exactly LS1, LS2, LS3, LS4, RS2 and RS4, and earlier images stay in the gallery', () => {
    const withLoadout = COMPARTMENTS.filter(c => c.images.some(i => i.src.includes('_loadout_2026-11-18')));
    expect(withLoadout.map(c => c.id)).toEqual(['LS1', 'LS2', 'LS3', 'LS4', 'RS2', 'RS4']);
    for (const c of withLoadout) {
      expect(c.images[0]).toEqual({ src: `/images/${c.id}_loadout_2026-11-18.webp`, title: 'Loadout Rendering (2026-11-18)' });
      expect(c.images.slice(1).some(i => i.src === `/images/${c.id}.webp`)).toBe(true);
    }
    expect(COMPARTMENTS.find(c => c.id === 'LS2').images.map(i => i.src)).toContain('/images/LS2_rendering.webp');
  });
  test('files exist and are WebP', () => {
    for (const id of ['LS1', 'LS2', 'LS3', 'LS4', 'RS2', 'RS4']) {
      const buf = readFileSync(new URL(`../../public/images/${id}_loadout_2026-11-18.webp`, import.meta.url));
      expect(buf.subarray(0, 4).toString('latin1')).toBe('RIFF');
      expect(buf.subarray(8, 12).toString('latin1')).toBe('WEBP');
    }
  });
});
