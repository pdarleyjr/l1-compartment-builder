// 2026-11-18 loadout renderings: first preset of exactly the compartments they were supplied for; earlier images stay.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { COMPARTMENTS } from '../../shared/apparatus.js';

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
