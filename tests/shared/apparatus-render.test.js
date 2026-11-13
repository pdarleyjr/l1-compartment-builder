import { describe, expect, test } from 'vitest';
import { COMPARTMENT_IDS, DEFAULT_ZONES, IMAGE_SIZE_RULES } from '../../shared/contracts.js';
import { COMPARTMENT_SPECS } from '../../shared/apparatus.js';
import {
  compartmentGeometry, isValidImageSize, MANUAL_DIMENSIONS, parseImageSize, parseSpecDimensions, renderSizeFor, sizeForAspect,
} from '../../shared/apparatus-render.js';

const R = IMAGE_SIZE_RULES;
function expectValid(size, maxEdge = R.defaultMaxEdge) {
  const p = parseImageSize(size);
  expect(p.ok, `${size}: ${p.error}`).toBe(true);
  expect(p.width % 16).toBe(0);
  expect(p.height % 16).toBe(0);
  const ratio = p.width / p.height;
  expect(ratio).toBeLessThanOrEqual(3);
  expect(ratio).toBeGreaterThanOrEqual(1 / 3);
  expect(p.width * p.height).toBeGreaterThanOrEqual(R.minPixels);
  expect(p.width * p.height).toBeLessThanOrEqual(R.maxPixels);
  expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(Math.max(maxEdge, 0) || R.maxEdge);
}

describe('parseSpecDimensions', () => {
  test.each([
    ['LS1', { widthIn: 17.75, heightIn: 38, depthIn: 27, doorWidthIn: 15, doorHeightIn: 38 }],
    ['LS2', { heightIn: 44 }],
    ['LS3', { widthIn: 80, heightIn: 16.375, depthIn: 27 }],
    ['LS4', { heightIn: 20, doorWidthIn: 26.5, doorHeightIn: 22 }],
    ['RS3', {}],
    ['RS4', { widthIn: 25, heightIn: 20, depthIn: 26.75 }],
    ['RS5', { widthIn: 17, heightIn: 29.5, depthIn: 9, doorWidthIn: 15.5, doorHeightIn: 29.5 }],
    ['RR1', {}], ['CabRearZone', {}],
  ])('%s', (id, want) => expect(parseSpecDimensions(COMPARTMENT_SPECS[id])).toEqual(want));
  test('fractions: mixed numbers', () => {
    expect(parseSpecDimensions('Overall: 10 1/2" W × 3 3/4" H.')).toEqual({ widthIn: 10.5, heightIn: 3.75 });
  });
  test('regex values agree with the hand table wherever both exist', () => {
    for (const id of COMPARTMENT_IDS) {
      for (const [k, v] of Object.entries(parseSpecDimensions(COMPARTMENT_SPECS[id]))) expect(MANUAL_DIMENSIONS[id][k]).toBe(v);
    }
  });
});

describe('compartmentGeometry', () => {
  test('all 11 compartments produce a geometry; all but CabRearZone/RR1 have W and H', () => {
    for (const id of COMPARTMENT_IDS) {
      const g = compartmentGeometry(id);
      expect(g.id).toBe(id);
      expect(g.specText).toBe(COMPARTMENT_SPECS[id]);
      expect(g.zones.every(z => DEFAULT_ZONES.includes(z))).toBe(true);
      expect(g.aspect).toBeGreaterThan(0);
      if (id === 'CabRearZone' || id === 'RR1') expect(g.dimensionsKnown).toBe(false);
      else expect(g).toMatchObject({ dimensionsKnown: true, dimensions: { widthIn: expect.any(Number), heightIn: expect.any(Number) } });
    }
  });
  test('documented fallbacks: CabRearZone square, RR1 landscape', () => {
    expect(compartmentGeometry('CabRearZone')).toMatchObject({ orientation: 'square', aspect: 1 });
    expect(compartmentGeometry('RR1')).toMatchObject({ orientation: 'landscape' });
    expect(compartmentGeometry('RR1').dimensions).toEqual({});
  });
  test('orientation from W/H', () => {
    expect(compartmentGeometry('LS1').orientation).toBe('portrait');
    expect(compartmentGeometry('LS3').orientation).toBe('landscape');
    expect(compartmentGeometry('LS2').orientation).toBe('square');
    expect(compartmentGeometry('RS5').orientation).toBe('portrait');
  });
  test('features and zones: LS2/RS2 include upper/middle/lower', () => {
    for (const id of ['LS2', 'RS2']) {
      const g = compartmentGeometry(id);
      expect(g.zones).toEqual(expect.arrayContaining(['upper_shelf', 'middle_shelf', 'lower_tray', 'pull_out_tray']));
      expect(g.features).toEqual(expect.arrayContaining(['Pull-Out Tilt Shelf', 'Pull-Out Tray', 'Fixed Shelf']));
    }
    expect(compartmentGeometry('LS4').features).toContain('Inverter (upper-left corner)');
    expect(compartmentGeometry('RS4').features).toContain('Exhaust below compartment');
    expect(compartmentGeometry('RS3').features).toContain('Tires below compartment');
    expect(compartmentGeometry('LS1').zones).toEqual(expect.arrayContaining(['upper_shelf', 'lower_tray']));
    expect(compartmentGeometry('LS1').zones).not.toContain('pull_out_tray');
    expect(compartmentGeometry('LS3').features.filter(f => /Pull-Out/.test(f))).toEqual(['Tilt / Pull-Out Tray']);
  });
  test('zones keep DEFAULT_ZONES order', () => {
    const g = compartmentGeometry('LS2');
    expect(g.zones).toEqual(DEFAULT_ZONES.filter(z => g.zones.includes(z)));
  });
  test('unknown compartment throws', () => {
    expect(() => compartmentGeometry('XX')).toThrow(RangeError);
  });
  describe('overrides win', () => {
    test('whole settings map or single override object', () => {
      for (const ov of [{ LS1: { orientation: 'landscape' } }, { orientation: 'landscape' }]) {
        const g = compartmentGeometry('LS1', ov);
        expect(g.orientation).toBe('landscape');
        expect(g.aspect).toBeGreaterThan(1);
      }
      expect(compartmentGeometry('LS1', { RS1: { orientation: 'landscape' } }).orientation).toBe('portrait');
    });
    test('square / same-orientation / dimensions / zones / specText', () => {
      expect(compartmentGeometry('LS3', { LS3: { orientation: 'square' } })).toMatchObject({ orientation: 'square', aspect: 1 });
      expect(compartmentGeometry('LS3', { LS3: { orientation: 'landscape' } }).aspect).toBeCloseTo(80 / 16.375);
      expect(compartmentGeometry('LS3', { LS3: { orientation: 'portrait' } }).aspect).toBeCloseTo(16.375 / 80);
      expect(compartmentGeometry('RR1', { RR1: { dimensions: { widthIn: 30, heightIn: 60 } } })).toMatchObject({ dimensionsKnown: true, orientation: 'portrait' });
      expect(compartmentGeometry('LS1', { LS1: { zones: ['a_zone', 'b_zone'] } }).zones).toEqual(['a_zone', 'b_zone']);
      const g = compartmentGeometry('RR1', { RR1: { specText: 'Overall: 20" W × 10" H × 5" D. Pull-Out Tray.' } });
      expect(g).toMatchObject({ specText: 'Overall: 20" W × 10" H × 5" D. Pull-Out Tray.', dimensionsKnown: true, orientation: 'landscape' });
      expect(g.features).toContain('Pull-Out Tray');
    });
    test('invalid override values are ignored; non-object overrides ignored', () => {
      expect(compartmentGeometry('LS1', { LS1: { orientation: 'diagonal', dimensions: { widthIn: -5, heightIn: 'x' }, zones: [] } }).dimensions.widthIn).toBe(17.75);
      expect(compartmentGeometry('LS1', null).orientation).toBe('portrait');
      expect(compartmentGeometry('LS1', { LS1: { specText: '   ' } }).specText).toBe(COMPARTMENT_SPECS.LS1);
    });
  });
});

describe('render sizes', () => {
  test.each(COMPARTMENT_IDS)('%s obeys IMAGE_SIZE_RULES', id => {
    const size = renderSizeFor(id);
    expectValid(size);
    expect(isValidImageSize(size)).toBe(true);
  });
  test.each(COMPARTMENT_IDS)('%s with maxEdge 1024 / 3840 and orientation overrides stays valid', id => {
    expectValid(renderSizeFor(id, {}, { maxEdge: 1024 }), 3840);
    expectValid(renderSizeFor(id, {}, { maxEdge: 3840 }), 3840);
    for (const orientation of ['landscape', 'portrait', 'square']) expectValid(renderSizeFor(id, { [id]: { orientation } }));
  });
  test('expected shapes: wide LS3 clamps to 3:1; tall LS1 portrait; default long edge ≤ 2560', () => {
    expect(renderSizeFor('LS3')).toBe('2560x864');
    const ls1 = parseImageSize(renderSizeFor('LS1'));
    expect(ls1.height).toBeGreaterThan(ls1.width);
    for (const id of COMPARTMENT_IDS) {
      const p = parseImageSize(renderSizeFor(id));
      expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(2560);
    }
  });
  test('valid size override wins; invalid is ignored', () => {
    expect(renderSizeFor('LS1', { LS1: { size: '1024x1024' } })).toBe('1024x1024');
    expect(renderSizeFor('LS1', { LS1: { size: '1000x1000' } })).toBe(renderSizeFor('LS1'));
  });
  test.each([0.001, 0.2, 1 / 3, 0.5, 1, 1.7, 3, 5, 100, 1e9])('sizeForAspect(%s) is valid at several maxEdges', aspect => {
    for (const edge of [16, 256, 1024, 2560, 3840, 99999]) expectValid(sizeForAspect(aspect, edge), 3840);
  });
  test('square at max edge is reduced to fit the pixel ceiling', () => {
    const p = parseImageSize(sizeForAspect(1, 3840));
    expect(p.width * p.height).toBeLessThanOrEqual(R.maxPixels);
    expect(p.width).toBe(p.height);
  });
  test('parseImageSize rejects bad strings', () => {
    for (const s of ['', 'abc', '1000x1000', '1024x', '16x16', '4000x1024', '4096x1024', '3840x3840', '3840x1024', 5, null]) expect(isValidImageSize(s)).toBe(false);
    expect(parseImageSize('1024x1024')).toEqual({ ok: true, width: 1024, height: 1024 });
  });
});
