import { describe, expect, test } from 'vitest';
import { ASSET_LIMITS, COMPARTMENT_IDS, INSTRUCTIONS_MAX, SETTINGS_DEFAULTS, SETTINGS_KEYS } from '../../shared/contracts.js';
import {
  validateAssetCreate, validateAssetUpdate, validateDesign, validateJobRequest, validateLinks, validateMount, validateSettingValue,
} from '../../shared/validation.js';

const SHA = 'a'.repeat(64);
const ID = 'ast_0123456789abcdefghij012345';
const EQ = 'eq_0123456789abcdef';
const okVal = r => { expect(r.ok, JSON.stringify(r)).toBe(true); return r.value; };
const bad = (r, re) => { expect(r.ok).toBe(false); if (re) expect(r.error).toMatch(re); };

const asset = (o = {}) => ({ compartmentId: 'LS1', category: 'tool', width: 1000, height: 800, bytes: 2000, sha256: SHA, idempotencyKey: 'key-12345678', ...o });

describe('validateAssetCreate', () => {
  test('accepts a valid body and trims/normalizes', () => {
    const v = okVal(validateAssetCreate(asset({ title: '  Spanners  ', notes: ' n ', sha256: SHA.toUpperCase(), provenance: 'as_built_photo' })));
    expect(v).toMatchObject({ title: 'Spanners', notes: 'n', sha256: SHA, provenance: 'as_built_photo' });
    expect(okVal(validateAssetCreate(asset({ category: 'markup' }))).category).toBe('markup');
  });
  test.each([
    ['unknown field', { extra: 1 }, /unknown field extra/], ['rendering category', { category: 'rendering' }, /category/], ['legacy category', { category: 'legacy_upload' }, /category/],
    ['bad compartment', { compartmentId: 'XX' }, /compartment/], ['title too long', { title: 'x'.repeat(ASSET_LIMITS.titleMax + 1) }, /title/],
    ['notes too long', { notes: 'x'.repeat(ASSET_LIMITS.notesMax + 1) }, /notes/], ['width 0', { width: 0 }, /width/], ['width too big', { width: ASSET_LIMITS.originalMaxEdge + 1 }, /width/],
    ['height float', { height: 1.5 }, /height/], ['bytes too big', { bytes: ASSET_LIMITS.originalMaxBytes + 1 }, /bytes/], ['short sha', { sha256: 'abc' }, /sha256/],
    ['non-hex sha', { sha256: 'z'.repeat(64) }, /hex/], ['short key', { idempotencyKey: 'short' }, /idempotencyKey/], ['key chars', { idempotencyKey: 'bad key with spaces' }, /invalid characters/],
    ['bad provenance', { provenance: 'ai_concept' }, /provenance/], ['title not string', { title: 5 }, /title/],
  ])('rejects %s', (_n, patch, re) => bad(validateAssetCreate(asset(patch)), re));
  test('rejects non-objects and missing fields', () => {
    bad(validateAssetCreate(null), /object/);
    bad(validateAssetCreate([]), /object/);
    bad(validateAssetCreate({}), /must be a string/);
  });
});

describe('validateAssetUpdate', () => {
  test('accepts partial updates incl. null clearing', () => {
    expect(okVal(validateAssetUpdate({ title: ' New ' }))).toEqual({ title: 'New' });
    expect(okVal(validateAssetUpdate({ notes: null }))).toEqual({ notes: null });
    expect(okVal(validateAssetUpdate({ category: 'mount' }))).toEqual({ category: 'mount' });
  });
  test.each([[{}, /nothing/], [{ category: 'rendering' }, /category/], [{ visibility: 'public' }, /unknown field/], [{ title: 'x'.repeat(201) }, /title/]])('rejects %j', (b, re) => bad(validateAssetUpdate(b), re));
});

describe('validateLinks', () => {
  const op = { op: 'setSlot', comp: 'LS1', index: 0, value: 'x', expect: '' };
  test('accepts links of every target type with defaults', () => {
    const v = okVal(validateLinks({ links: [
      { targetType: 'equipment', targetId: EQ }, { targetType: 'assignment', targetId: 'as_0123456789abcdefghij012345', quantity: 3, equipmentId: EQ },
      { targetType: 'mount', targetId: 'mt_0123456789abcdefghij012345', region: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, state: 'suggested', label: ' Spanner ' },
      { targetType: 'bundle', targetId: 'k3j9x2a1' }, { targetType: 'equipment', targetId: EQ, quantity: 2, assignSlots: [0, 1], equipmentId: null },
    ], plannerOps: [op], baseRevision: 4 }));
    expect(v.links[0]).toEqual({ targetType: 'equipment', targetId: EQ, quantity: 1, region: null, state: 'confirmed' });
    expect(v.links[2]).toMatchObject({ label: 'Spanner', state: 'suggested', region: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } });
    expect(v.links[4]).toMatchObject({ assignSlots: [0, 1], equipmentId: null });
    expect(v.plannerOps).toEqual([op]);
    expect(v.baseRevision).toBe(4);
  });
  test('empty body is an empty set', () => {
    expect(okVal(validateLinks({}))).toEqual({ links: [], plannerOps: [] });
  });
  test.each([
    ['not an array', { links: 'x' }, /links/], ['too many', { links: Array(201).fill({ targetType: 'equipment', targetId: EQ }) }, /at most 200/],
    ['unknown target type', { links: [{ targetType: 'photo', targetId: EQ }] }, /targetType/], ['bad id', { links: [{ targetType: 'equipment', targetId: 'nope' }] }, /targetId/],
    ['bundle id with caps', { links: [{ targetType: 'bundle', targetId: 'BAD ID' }] }, /targetId/], ['quantity 0', { links: [{ targetType: 'equipment', targetId: EQ, quantity: 0 }] }, /quantity/],
    ['quantity 501', { links: [{ targetType: 'equipment', targetId: EQ, quantity: 501 }] }, /quantity/], ['unknown field', { links: [{ targetType: 'equipment', targetId: EQ, foo: 1 }] }, /unknown field foo/],
    ['bad state', { links: [{ targetType: 'equipment', targetId: EQ, state: 'maybe' }] }, /state/], ['bad eq id', { links: [{ targetType: 'equipment', targetId: EQ, equipmentId: 'x' }] }, /equipmentId/],
    ['region > 1', { links: [{ targetType: 'equipment', targetId: EQ, region: { x: 0, y: 0, w: 1.2, h: 1 } }] }, /region\.w/], ['region negative', { links: [{ targetType: 'equipment', targetId: EQ, region: { x: -0.1, y: 0, w: 0.5, h: 0.5 } }] }, /region\.x/],
    ['region overflow', { links: [{ targetType: 'equipment', targetId: EQ, region: { x: 0.6, y: 0, w: 0.6, h: 0.5 } }] }, /within the image/], ['region zero size', { links: [{ targetType: 'equipment', targetId: EQ, region: { x: 0, y: 0, w: 0, h: 0.5 } }] }, /positive/],
    ['region NaN', { links: [{ targetType: 'equipment', targetId: EQ, region: { x: NaN, y: 0, w: 0.5, h: 0.5 } }] }, /region\.x/], ['region extra', { links: [{ targetType: 'equipment', targetId: EQ, region: { x: 0, y: 0, w: 0.5, h: 0.5, z: 1 } }] }, /unknown field/],
    ['assignSlots not array', { links: [{ targetType: 'equipment', targetId: EQ, assignSlots: 'x' }] }, /assignSlots/], ['assignSlots out of range', { links: [{ targetType: 'equipment', targetId: EQ, assignSlots: [-1] }] }, /assignSlots/],
    ['ops not array', { plannerOps: {} }, /plannerOps/], ['too many ops', { plannerOps: Array(201).fill(op) }, /at most 200/], ['bad op', { plannerOps: [{ op: 'nope' }] }, /plannerOps\[0\]/],
    ['bad revision', { baseRevision: -1 }, /baseRevision/], ['unknown top field', { foo: 1 }, /unknown field foo/], ['label too long', { links: [{ targetType: 'equipment', targetId: EQ, label: 'x'.repeat(201) }] }, /label/],
  ])('rejects %s', (_n, body, re) => bad(validateLinks(body), re));
});

describe('validateMount', () => {
  const mount = (o = {}) => ({ name: 'Strut bracket', ...o });
  test('create requires a name; accepts all optional fields; trims', () => {
    const v = okVal(validateMount(mount({ name: '  Strut bracket ', manufacturer: 'Pac', model: 'K-1', description: 'd', dimensions: '12 in', orientation: 'vertical', zone: 'left_wall',
      capacity: 2, classification: 'inventory', status: 'existing', equipmentId: EQ, notes: 'n', links: [{ targetType: 'asset', targetId: ID }, { targetType: 'equipment', targetId: EQ }] })));
    expect(v.name).toBe('Strut bracket');
    expect(v).toMatchObject({ capacity: 2, classification: 'inventory', status: 'existing', orientation: 'vertical', zone: 'left_wall' });
    expect(v.links).toHaveLength(2);
    bad(validateMount({}), /name is required/);
    bad(validateMount({ name: '   ' }), /name must not be empty/);
  });
  test('partial updates: only provided fields, nulls clear, empty rejected', () => {
    expect(okVal(validateMount({ status: 'optional' }, { partial: true }))).toEqual({ status: 'optional' });
    expect(okVal(validateMount({ orientation: null, capacity: null, equipmentId: null, zone: null, name: 'x' }, { partial: true }))).toEqual({ orientation: null, capacity: null, equipmentId: null, zone: null, name: 'x' });
    bad(validateMount({}, { partial: true }), /nothing/);
  });
  test.each([
    ['unknown field', { color: 'red' }, /unknown field/], ['orientation', { orientation: 'diagonal' }, /orientation/], ['classification', { classification: 'x' }, /classification/], ['status', { status: 'x' }, /status/],
    ['capacity', { capacity: 501 }, /capacity/], ['equipment id', { equipmentId: 'bad' }, /equipmentId/], ['zone chars', { zone: 'Left Wall' }, /zone/], ['links not array', { links: 'x' }, /links/],
    ['link type', { links: [{ targetType: 'mount', targetId: ID }] }, /targetType/], ['link id', { links: [{ targetType: 'asset', targetId: 'bad' }] }, /targetId/], ['link extra', { links: [{ targetType: 'asset', targetId: ID, x: 1 }] }, /unknown field/],
    ['too many links', { links: Array(101).fill({ targetType: 'asset', targetId: ID }) }, /at most 100/], ['description long', { description: 'x'.repeat(2001) }, /description/],
  ])('rejects %s', (_n, patch, re) => bad(validateMount(mount(patch)), re));
});

describe('validateDesign', () => {
  const placement = { targetType: 'equipment', targetId: EQ, zone: 'upper_shelf', orientation: 'vertical', x: 0.1, y: 0.2, w: 0.3, h: 0.4, notes: ' n ' };
  test('nested and flat forms normalize identically', () => {
    const layout = { zones: ['upper_shelf', 'floor'], placements: [placement], notes: ' hi ' };
    const nested = okVal(validateDesign({ expectRevision: 2, layout }));
    const flat = okVal(validateDesign({ expectRevision: 2, ...layout }));
    expect(flat).toEqual(nested);
    expect(nested.layout.placements[0].notes).toBe('n');
    expect(nested.layout.notes).toBe('hi');
    expect(okVal(validateDesign({ expectRevision: 0 }))).toEqual({ expectRevision: 0, layout: { zones: [], placements: [] } });
    expect(okVal(validateDesign({ expectRevision: 1, placements: [{ targetType: 'bundle', targetId: 'k3j9x2a1', zone: 'floor' }] })).layout.placements[0].targetType).toBe('bundle');
  });
  test.each([
    ['missing revision', {}, /expectRevision/], ['negative revision', { expectRevision: -1 }, /expectRevision/], ['mixed forms', { expectRevision: 1, layout: {}, zones: [] }, /either nested or flat/],
    ['unknown layout field', { expectRevision: 1, layout: { foo: 1 } }, /unknown field/], ['zones not array', { expectRevision: 1, zones: 'x' }, /zones/], ['bad zone', { expectRevision: 1, zones: ['Upper Shelf'] }, /zones\[0\]/],
    ['too many zones', { expectRevision: 1, zones: Array(31).fill('a') }, /at most 30/], ['too many placements', { expectRevision: 1, placements: Array(301).fill(placement) }, /at most 300/],
    ['bad target type', { expectRevision: 1, placements: [{ ...placement, targetType: 'asset' }] }, /targetType/], ['bad target id', { expectRevision: 1, placements: [{ ...placement, targetId: 'x' }] }, /targetId/],
    ['bad bundle id', { expectRevision: 1, placements: [{ ...placement, targetType: 'bundle', targetId: 'A B' }] }, /targetId/], ['bad zone in placement', { expectRevision: 1, placements: [{ ...placement, zone: 'A B' }] }, /zone/],
    ['bad orientation', { expectRevision: 1, placements: [{ ...placement, orientation: 'tilted' }] }, /orientation/], ['geometry > 1', { expectRevision: 1, placements: [{ ...placement, x: 2 }] }, /x/],
    ['not object', 'x', /object/],
  ])('rejects %s', (_n, body, re) => bad(validateDesign(body), re));
});

describe('validateJobRequest', () => {
  test('render and recognize', () => {
    expect(okVal(validateJobRequest({ kind: 'render', mode: 'reference', preset: 'high', instructions: '  brighter ', confirmEstimateUsd: 1.5 }))).toEqual({ kind: 'render', mode: 'reference', preset: 'high', instructions: 'brighter', confirmEstimateUsd: 1.5 });
    expect(okVal(validateJobRequest({ kind: 'render', mode: 'edit', parentVersionId: 'iv_0123456789abcdefghij012345', markupAssetId: ID })).parentVersionId).toBe('iv_0123456789abcdefghij012345');
    expect(okVal(validateJobRequest({ kind: 'recognize', assetId: ID }))).toEqual({ kind: 'recognize', assetId: ID });
  });
  test.each([
    ['missing kind', {}, /kind/], ['verify not user-requestable', { kind: 'verify' }, /kind/], ['bad mode', { kind: 'render', mode: 'x' }, /mode/], ['bad preset', { kind: 'render', preset: 'ultra' }, /preset/],
    ['instructions long', { kind: 'render', instructions: 'x'.repeat(INSTRUCTIONS_MAX + 1) }, /instructions/], ['bad id', { kind: 'render', parentVersionId: 'x' }, /parentVersionId/],
    ['recognize needs asset', { kind: 'recognize' }, /assetId is required/], ['edit needs parent', { kind: 'render', mode: 'edit' }, /parentVersionId is required/],
    ['estimate negative', { kind: 'render', confirmEstimateUsd: -1 }, /confirmEstimateUsd/], ['estimate NaN', { kind: 'render', confirmEstimateUsd: NaN }, /confirmEstimateUsd/], ['unknown field', { kind: 'render', model: 'x' }, /unknown field model/],
  ])('rejects %s', (_n, body, re) => bad(validateJobRequest(body), re));
  test('instructions exactly at the cap are accepted', () => {
    expect(okVal(validateJobRequest({ kind: 'render', instructions: 'x'.repeat(INSTRUCTIONS_MAX) })).instructions).toHaveLength(INSTRUCTIONS_MAX);
  });
});

describe('validateSettingValue', () => {
  test('every default value is valid for its own key (and round-trips)', () => {
    for (const key of SETTINGS_KEYS) {
      const v = SETTINGS_DEFAULTS[key];
      const r = validateSettingValue(key, v);
      expect(r.ok, `${key}: ${r.error}`).toBe(true);
      expect(r.value).toEqual(v);
    }
  });
  test('unknown keys, including prototype names, are rejected', () => {
    for (const k of ['nope', 'toString', '__proto__', 'constructor']) bad(validateSettingValue(k, 1), /unknown setting/);
  });
  test.each([['studio.enabled'], ['ai.enabled'], ['recognition.enabled'], ['verification.enabled']])('%s must be boolean', key => {
    expect(validateSettingValue(key, true).ok).toBe(true);
    for (const v of [1, 'true', null, undefined]) bad(validateSettingValue(key, v), /boolean/);
  });
  test.each([['budget.monthlyUsd'], ['budget.dailyUsd'], ['budget.userDailyUsd']])('%s: 0..10000 USD', key => {
    for (const v of [0, 0.5, 10_000]) expect(validateSettingValue(key, v).ok).toBe(true);
    for (const v of [-0.01, 10_000.01, NaN, Infinity, '5', null]) bad(validateSettingValue(key, v), /number/);
  });
  test.each([['jobs.maxConcurrent'], ['jobs.userMaxConcurrent']])('%s: integer 1..10', key => {
    for (const v of [1, 10]) expect(validateSettingValue(key, v).ok).toBe(true);
    for (const v of [0, 11, 1.5, '2']) bad(validateSettingValue(key, v), /integer/);
  });
  test('references.maxPerRequest 1..16', () => {
    expect(validateSettingValue('references.maxPerRequest', 16).ok).toBe(true);
    bad(validateSettingValue('references.maxPerRequest', 17), /integer/);
    bad(validateSettingValue('references.maxPerRequest', 0), /integer/);
  });
  test('access.admins: lowercase, trimmed, de-duplicated emails', () => {
    expect(okVal(validateSettingValue('access.admins', [' Owner@Example.com ', 'owner@example.com', 'b@miamibeachfl.gov']))).toEqual(['owner@example.com', 'b@miamibeachfl.gov']);
    expect(okVal(validateSettingValue('access.admins', []))).toEqual([]);
    for (const v of ['x', [5], ['not-an-email'], ['a@b'], Array(51).fill('a@b.co'), ['']]) bad(validateSettingValue('access.admins', v));
  });
  test('recognition.model only allowlisted', () => {
    expect(validateSettingValue('recognition.model', 'gpt-5.4-mini').ok).toBe(true);
    bad(validateSettingValue('recognition.model', 'gpt-image-2.6-flare'), /one of/);
    bad(validateSettingValue('recognition.model', 'evil-model'), /one of/);
  });
  test('style.houseText ≤ 2000 chars, trimmed', () => {
    expect(okVal(validateSettingValue('style.houseText', '  text  '))).toBe('text');
    expect(validateSettingValue('style.houseText', 'x'.repeat(2000)).ok).toBe(true);
    bad(validateSettingValue('style.houseText', 'x'.repeat(2001)), /at most 2000/);
    bad(validateSettingValue('style.houseText', 5), /string/);
  });
  describe('presets', () => {
    const presets = () => structuredClone(SETTINGS_DEFAULTS.presets);
    test('valid edits accepted', () => {
      const p = presets();
      p.preview = { model: 'gpt-image-2.6-sunburst', quality: 'medium', complexity: 'low', outputFormat: 'webp', confirm: true };
      expect(okVal(validateSettingValue('presets', p)).preview.outputFormat).toBe('webp');
    });
    test.each([
      ['unknown model', p => { p.high.model = 'gpt-5'; }, /model/], ['unknown quality', p => { p.high.quality = 'ultra'; }, /quality/], ['unknown complexity', p => { p.high.complexity = 'x'; }, /complexity/],
      ['unknown format', p => { p.high.outputFormat = 'gif'; }, /outputFormat/], ['confirm not bool', p => { p.max.confirm = 'yes'; }, /confirm/], ['extra preset', p => { p.turbo = p.high; }, /unknown field turbo/],
      ['missing preset', p => { delete p.max; }, /required/], ['extra field', p => { p.high.temperature = 1; }, /unknown field/],
    ])('rejects %s', (_n, mutate, re) => { const p = presets(); mutate(p); bad(validateSettingValue('presets', p), re); });
    test('non-object rejected', () => bad(validateSettingValue('presets', []), /object/));
  });
  describe('pricing', () => {
    const pricing = () => structuredClone(SETTINGS_DEFAULTS.pricing);
    test('valid edits accepted', () => {
      const p = pricing();
      p['gpt-image-2.6-flare'].imageOut = 12.5;
      p.estimatedOutputTokensPerMegapixel.low = 100;
      p.estimatedInputTokensPerReference = 2000;
      expect(okVal(validateSettingValue('pricing', p))['gpt-image-2.6-flare'].imageOut).toBe(12.5);
    });
    test.each([
      ['negative rate', p => { p['gpt-image-2.6-flare'].textIn = -1; }, /textIn/], ['huge rate', p => { p['gpt-image-2.6-flare'].imageOut = 10_001; }, /imageOut/], ['string rate', p => { p['gpt-5.4-mini'].textOut = '4'; }, /textOut/],
      ['unknown model', p => { p['gpt-9'] = p['gpt-5.4-mini']; }, /unknown field/], ['missing model', p => { delete p['gpt-5.4-mini']; }, /required/],
      ['unknown rate field', p => { p['gpt-5.4-mini'].bonus = 1; }, /unknown field/], ['missing rate field', p => { delete p['gpt-5.4-mini'].textOut; }, /textOut/],
      ['unknown quality', p => { p.estimatedOutputTokensPerMegapixel.ultra = 1; }, /unknown field/], ['negative tokens', p => { p.estimatedOutputTokensPerMegapixel.low = -1; }, /low/],
      ['bad per-reference', p => { p.estimatedInputTokensPerReference = -5; }, /PerReference/],
    ])('rejects %s', (_n, mutate, re) => { const p = pricing(); mutate(p); bad(validateSettingValue('pricing', p), re); });
  });
  describe('compartments.overrides', () => {
    test('accepts known compartments and fields', () => {
      const v = okVal(validateSettingValue('compartments.overrides', { LS1: { orientation: 'landscape', size: '1536x1024', zones: ['upper_shelf', 'top_rack'], dimensions: { widthIn: 20.5, heightIn: 30 }, specText: ' Custom text ' }, RR1: {} }));
      expect(v.LS1).toMatchObject({ orientation: 'landscape', size: '1536x1024', zones: ['upper_shelf', 'top_rack'], specText: 'Custom text' });
      expect(v.RR1).toEqual({});
      for (const id of COMPARTMENT_IDS) expect(validateSettingValue('compartments.overrides', { [id]: {} }).ok).toBe(true);
    });
    test.each([
      ['unknown compartment', { ZZ: {} }, /unknown field ZZ/], ['unknown field', { LS1: { color: 'red' } }, /unknown field color/], ['bad orientation', { LS1: { orientation: 'vertical' } }, /orientation/],
      ['bad size', { LS1: { size: '1000x1000' } }, /valid image size/], ['bad zone', { LS1: { zones: ['Bad Zone'] } }, /zones\[0\]/], ['zones not array', { LS1: { zones: 'x' } }, /zones/],
      ['too many zones', { LS1: { zones: Array(31).fill('a') } }, /at most 30/], ['negative dimension', { LS1: { dimensions: { widthIn: -1 } } }, /widthIn/], ['huge dimension', { LS1: { dimensions: { widthIn: 401 } } }, /widthIn/],
      ['unknown dimension', { LS1: { dimensions: { weight: 5 } } }, /unknown field weight/], ['specText long', { LS1: { specText: 'x'.repeat(2001) } }, /specText/], ['override not object', { LS1: 'x' }, /object/], ['array', [], /object/],
    ])('rejects %s', (_n, v, re) => bad(validateSettingValue('compartments.overrides', v), re));
  });
});
