// 2026-11-18 loadout renderings: first preset of exactly the compartments they were supplied for; earlier images stay.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { COMPARTMENTS } from '../../shared/apparatus.js';

describe('2026-11-18 loadout renderings', () => {
  test('are the first preset of exactly LS1, LS2, LS3, LS4, RS1, RS2 and RS4, and earlier images stay in the gallery', () => {
    const withLoadout = COMPARTMENTS.filter(c => c.images.some(i => i.src.includes('_loadout_2026-11-18')));
    expect(withLoadout.map(c => c.id)).toEqual(['LS1', 'LS2', 'LS3', 'LS4', 'RS1', 'RS2', 'RS4']);
    const file = id => ({ LS1: 'LS1_loadout_2026-11-18-v2.webp', LS2: 'LS2_loadout_2026-11-18-v4.webp', RS2: 'RS2_loadout_2026-11-18-v2.webp' }[id] ?? `${id}_loadout_2026-11-18.webp`); // LS1 (v2), LS2 (v4) and RS2 (v2) replaced by the owner
    for (const c of withLoadout) {
      expect(c.images[0]).toEqual({ src: `/images/${file(c.id)}`, title: 'Loadout Rendering (2026-11-18)' });
      expect(c.images.slice(1).some(i => i.src === `/images/${c.id}.webp`)).toBe(true);
    }
    const ls2 = COMPARTMENTS.find(c => c.id === 'LS2').images.map(i => i.src);
    expect(ls2).toContain('/images/LS2_rendering.webp');
    expect(ls2).not.toContain('/images/LS2_loadout_2026-11-18.webp'); // replaced, not offered twice
    for (const old of ['v2', 'v3']) expect(ls2).not.toContain(`/images/LS2_loadout_2026-11-18-${old}.webp`);
    expect(COMPARTMENTS.find(c => c.id === 'RS2').images.map(i => i.src)).not.toContain('/images/RS2_loadout_2026-11-18.webp');
    expect(COMPARTMENTS.find(c => c.id === 'LS1').images.map(i => i.src)).not.toContain('/images/LS1_loadout_2026-11-18.webp');
  });
  test('files exist and are WebP (the replaced LS1/LS2 files stay for open tabs)', () => {
    for (const f of ['LS1', 'LS2', 'LS3', 'LS4', 'RS1', 'RS2', 'RS4'].map(id => `${id}_loadout_2026-11-18.webp`).concat('LS1_loadout_2026-11-18-v2.webp', 'LS2_loadout_2026-11-18-v2.webp', 'LS2_loadout_2026-11-18-v3.webp', 'LS2_loadout_2026-11-18-v4.webp', 'RS2_loadout_2026-11-18-v2.webp')) {
      const buf = readFileSync(new URL(`../../public/images/${f}`, import.meta.url));
      expect(buf.subarray(0, 4).toString('latin1')).toBe('RIFF');
      expect(buf.subarray(8, 12).toString('latin1')).toBe('WEBP');
    }
  });
});
