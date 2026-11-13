// Strict allowlist validators. Each returns {ok:true, value} (normalized: strings trimmed, defaults applied) or
// {ok:false, error}. Unknown fields are rejected everywhere.
import {
  ASSET_LIMITS, COMPARTMENT_IDS, ID_PATTERN, IMAGE_COMPLEXITIES, IMAGE_MODELS, IMAGE_QUALITIES, INSTRUCTIONS_MAX, JOB_KINDS,
  LINK_STATES, LINK_TARGETS, MOUNT_CLASSIFICATIONS, MOUNT_STATUSES, ORIENTATIONS, PLANNER_LIMITS, PRESETS, RENDER_MODES,
  SETTINGS_DEFAULTS, USER_ASSET_CATEGORIES, isCompartmentId,
} from './contracts.js';
import { isValidImageSize, ORIENTATION_VALUES } from './apparatus-render.js';
import { validateOp } from './planner.js';

export const OUTPUT_FORMATS = Object.freeze(['jpeg', 'png', 'webp']);
const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const ZONE = /^[a-z][a-z0-9_]{0,39}$/;
const KEY = /^[A-Za-z0-9._:-]{8,100}$/;
const BUNDLE_ID = /^[0-9a-z_]{1,64}$/;

class Bad extends Error {}
const bad = msg => { throw new Bad(msg); };
const guard = fn => {
  try { return { ok: true, value: fn() }; } catch (e) { if (e instanceof Bad) return { ok: false, error: e.message }; throw e; }
};
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function object(v, name, allowed) {
  if (!isObj(v)) bad(`${name} must be an object`);
  for (const k of Object.keys(v)) if (!allowed.includes(k)) bad(`${name}: unknown field ${k.slice(0, 40)}`);
  return v;
}
function str(v, name, { max, min = 0, optional = false, nullable = false } = {}) {
  if (v === undefined && optional) return undefined;
  if (v === null && nullable) return null;
  if (typeof v !== 'string') bad(`${name} must be a string`);
  const t = v.trim();
  if (t.length < min) bad(`${name} must not be empty`);
  if (t.length > max) bad(`${name} must be at most ${max} characters`);
  return t;
}
function int(v, name, min, max, optional = false) {
  if (v === undefined && optional) return undefined;
  if (!Number.isInteger(v) || v < min || v > max) bad(`${name} must be an integer ${min}..${max}`);
  return v;
}
function numRange(v, name, min, max) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) bad(`${name} must be a number ${min}..${max}`);
  return v;
}
function oneOf(v, name, list, optional = false) {
  if (v === undefined && optional) return undefined;
  if (!list.includes(v)) bad(`${name} must be one of ${list.join(', ')}`);
  return v;
}
function id(v, name, optional = false) {
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'string' || !ID_PATTERN.test(v)) bad(`${name} is not a valid id`);
  return v;
}
function compId(v, name) {
  if (!isCompartmentId(v)) bad(`${name} is not a known compartment`);
  return v;
}
const drop = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

function region(v) {
  if (v === undefined || v === null) return null;
  object(v, 'region', ['x', 'y', 'w', 'h']);
  const { x, y, w, h } = v;
  for (const [k, n] of Object.entries({ x, y, w, h })) numRange(n, `region.${k}`, 0, 1);
  if (w <= 0 || h <= 0) bad('region must have positive size');
  if (x + w > 1 + 1e-9 || y + h > 1 + 1e-9) bad('region must stay within the image');
  return { x, y, w, h };
}

/** POST /api/assets body. */
export function validateAssetCreate(body) {
  return guard(() => {
    const b = object(body, 'body', ['compartmentId', 'category', 'title', 'notes', 'width', 'height', 'bytes', 'sha256', 'idempotencyKey', 'provenance']);
    const sha256 = str(b.sha256, 'sha256', { max: 64, min: 64 }).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) bad('sha256 must be 64 hex characters');
    return drop({
      compartmentId: compId(b.compartmentId, 'compartmentId'),
      category: oneOf(b.category, 'category', [...USER_ASSET_CATEGORIES, 'markup']),
      title: str(b.title, 'title', { max: ASSET_LIMITS.titleMax, optional: true }),
      notes: str(b.notes, 'notes', { max: ASSET_LIMITS.notesMax, optional: true }),
      width: int(b.width, 'width', 1, ASSET_LIMITS.originalMaxEdge),
      height: int(b.height, 'height', 1, ASSET_LIMITS.originalMaxEdge),
      bytes: int(b.bytes, 'bytes', 1, ASSET_LIMITS.originalMaxBytes),
      sha256,
      idempotencyKey: (() => { const k = str(b.idempotencyKey, 'idempotencyKey', { max: 100, min: 8 }); if (!KEY.test(k)) bad('idempotencyKey has invalid characters'); return k; })(),
      provenance: oneOf(b.provenance, 'provenance', ['user_photo', 'reference', 'as_built_photo'], true),
    });
  });
}

/** PATCH /api/assets/:id body: at least one of title, notes, category, plus expectRevision (read by the handler). */
export function validateAssetUpdate(body) {
  return guard(() => {
    const b = object(body, 'body', ['title', 'notes', 'category', 'expectRevision']);
    int(b.expectRevision, 'expectRevision', 0, Number.MAX_SAFE_INTEGER, true);
    const out = drop({
      title: str(b.title, 'title', { max: ASSET_LIMITS.titleMax, optional: true, nullable: true }),
      notes: str(b.notes, 'notes', { max: ASSET_LIMITS.notesMax, optional: true, nullable: true }),
      category: oneOf(b.category, 'category', USER_ASSET_CATEGORIES, true),
    });
    if (!Object.keys(out).length) bad('nothing to update');
    return out;
  });
}

function link(l, i) {
  const n = `links[${i}]`;
  const x = object(l, n, ['targetType', 'targetId', 'equipmentId', 'quantity', 'region', 'state', 'label', 'assignSlots']);
  const targetType = oneOf(x.targetType, `${n}.targetType`, LINK_TARGETS);
  if (typeof x.targetId !== 'string' || !(targetType === 'bundle' ? BUNDLE_ID : ID_PATTERN).test(x.targetId)) bad(`${n}.targetId is invalid`);
  if (x.assignSlots !== undefined && (!Array.isArray(x.assignSlots) || x.assignSlots.length > 500)) bad(`${n}.assignSlots must be an array`);
  return drop({
    targetType, targetId: x.targetId,
    equipmentId: x.equipmentId === null ? null : id(x.equipmentId, `${n}.equipmentId`, true),
    quantity: int(x.quantity ?? 1, `${n}.quantity`, 1, 500),
    region: region(x.region),
    state: oneOf(x.state ?? 'confirmed', `${n}.state`, LINK_STATES),
    label: str(x.label, `${n}.label`, { max: 200, optional: true }),
    assignSlots: x.assignSlots?.map((s, k) => int(s, `${n}.assignSlots[${k}]`, 0, PLANNER_LIMITS.maxSlotsPerCompartment - 1)),
  });
}

/** Asset commit / putLinks body: {links?, plannerOps?, baseRevision?}. */
export function validateLinks(body) {
  return guard(() => {
    const b = object(body, 'body', ['links', 'plannerOps', 'baseRevision']);
    const links = b.links ?? [];
    if (!Array.isArray(links) || links.length > 200) bad('links must be an array of at most 200');
    const ops = b.plannerOps ?? [];
    if (!Array.isArray(ops) || ops.length > PLANNER_LIMITS.maxOpsPerRequest) bad(`plannerOps must be an array of at most ${PLANNER_LIMITS.maxOpsPerRequest}`);
    ops.forEach((op, i) => { const r = validateOp(op); if (!r.ok) bad(`plannerOps[${i}]: ${r.error}`); });
    return drop({ links: links.map(link), plannerOps: ops, baseRevision: int(b.baseRevision, 'baseRevision', 0, Number.MAX_SAFE_INTEGER, true) });
  });
}

/**
 * Mount create (name required) or partial update body (+ expectRevision, read by the handler). Canonical payload:
 * {name, manufacturer?, model?, description?, dimensions?, orientation?, zone?, capacity?, classification, status, equipmentId?, notes?,
 * links:[{targetType:'equipment'|'assignment'|'asset', targetId}]}.
 */
export function validateMount(body, { partial = false } = {}) {
  return guard(() => {
    const b = object(body, 'body', ['name', 'manufacturer', 'model', 'description', 'dimensions', 'orientation', 'zone', 'capacity',
      'classification', 'status', 'equipmentId', 'notes', 'links', 'expectRevision']);
    int(b.expectRevision, 'expectRevision', 0, Number.MAX_SAFE_INTEGER, true);
    if (!partial && b.name === undefined) bad('name is required');
    const text = (k, max) => str(b[k], k, { max, optional: true, nullable: true });
    if (b.links !== undefined && (!Array.isArray(b.links) || b.links.length > 100)) bad('links must be an array of at most 100');
    const out = drop({
      name: partial ? text('name', ASSET_LIMITS.titleMax) : str(b.name, 'name', { max: ASSET_LIMITS.titleMax, min: 1 }),
      manufacturer: text('manufacturer', ASSET_LIMITS.titleMax), model: text('model', ASSET_LIMITS.titleMax),
      description: text('description', ASSET_LIMITS.notesMax), dimensions: text('dimensions', ASSET_LIMITS.titleMax),
      orientation: b.orientation === null ? null : oneOf(b.orientation, 'orientation', ORIENTATIONS, true),
      zone: (() => { const z = text('zone', 40); if (z && !ZONE.test(z)) bad('zone has invalid characters'); return z; })(),
      capacity: b.capacity === null ? null : int(b.capacity, 'capacity', 0, 500, true),
      classification: oneOf(b.classification, 'classification', MOUNT_CLASSIFICATIONS, true),
      status: oneOf(b.status, 'status', MOUNT_STATUSES, true),
      equipmentId: b.equipmentId === null ? null : id(b.equipmentId, 'equipmentId', true),
      notes: text('notes', ASSET_LIMITS.notesMax),
      links: b.links?.map((l, i) => {
        const x = object(l, `links[${i}]`, ['targetType', 'targetId']);
        const targetType = oneOf(x.targetType, `links[${i}].targetType`, ['equipment', 'assignment', 'asset']);
        return { targetType, targetId: id(x.targetId, `links[${i}].targetId`) };
      }),
    });
    if (partial && !Object.keys(out).length) bad('nothing to update');
    return out;
  });
}

/**
 * PUT design body: {layout:{placements:[{targetType:'assignment'|'equipment'|'mount', targetId, zone, orientation?, notes?}], notes?},
 * expectRevision}. Normalized to the same shape.
 */
export const PLACEMENT_TARGETS = Object.freeze(['assignment', 'equipment', 'mount']);
export function validateDesign(body) {
  return guard(() => {
    const { expectRevision, layout: layoutIn } = object(body, 'body', ['layout', 'expectRevision']);
    const l = object(layoutIn, 'layout', ['placements', 'notes']);
    const placements = l.placements ?? [];
    if (!Array.isArray(placements) || placements.length > 300) bad('placements must be an array of at most 300');
    return {
      expectRevision: int(expectRevision, 'expectRevision', 0, Number.MAX_SAFE_INTEGER),
      layout: drop({
        placements: placements.map((p, i) => {
          const n = `placements[${i}]`;
          const x = object(p, n, ['targetType', 'targetId', 'zone', 'orientation', 'notes']);
          const targetType = oneOf(x.targetType, `${n}.targetType`, PLACEMENT_TARGETS);
          if (typeof x.targetId !== 'string' || !ID_PATTERN.test(x.targetId)) bad(`${n}.targetId is invalid`);
          const zone = str(x.zone, `${n}.zone`, { max: 40, min: 1 });
          if (!ZONE.test(zone)) bad(`${n}.zone has invalid characters`);
          return drop({ targetType, targetId: x.targetId, zone, orientation: oneOf(x.orientation, `${n}.orientation`, ORIENTATIONS, true), notes: str(x.notes, `${n}.notes`, { max: 500, optional: true }) });
        }),
        notes: str(l.notes, 'notes', { max: ASSET_LIMITS.notesMax, optional: true }),
      }),
    };
  });
}

export const MAX_REFERENCE_ASSETS = 4;
function referenceIds(v) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > MAX_REFERENCE_ASSETS) bad(`referenceAssetIds must be an array of at most ${MAX_REFERENCE_ASSETS} ids`);
  const ids = v.map((x, i) => id(x, `referenceAssetIds[${i}]`));
  if (new Set(ids).size !== ids.length) bad('referenceAssetIds must not repeat an id');
  return ids;
}

/** POST /api/compartments/:id/jobs body. */
export function validateJobRequest(body) {
  return guard(() => {
    const b = object(body, 'body', ['kind', 'mode', 'preset', 'instructions', 'parentVersionId', 'markupAssetId', 'assetId', 'referenceAssetIds', 'confirmEstimateUsd']);
    const kind = oneOf(b.kind, 'kind', JOB_KINDS.filter(k => k !== 'verify'));
    const out = drop({
      kind,
      mode: oneOf(b.mode, 'mode', RENDER_MODES, true),
      preset: oneOf(b.preset, 'preset', PRESETS, true),
      instructions: str(b.instructions, 'instructions', { max: INSTRUCTIONS_MAX, optional: true }),
      parentVersionId: id(b.parentVersionId, 'parentVersionId', true),
      markupAssetId: id(b.markupAssetId, 'markupAssetId', true),
      assetId: id(b.assetId, 'assetId', true),
      referenceAssetIds: referenceIds(b.referenceAssetIds),
      confirmEstimateUsd: b.confirmEstimateUsd === undefined ? undefined : numRange(b.confirmEstimateUsd, 'confirmEstimateUsd', 0, 10_000),
    });
    if (kind === 'recognize' && !out.assetId) bad('assetId is required for recognize');
    if (kind === 'render' && out.mode === 'edit' && !out.parentVersionId) bad('parentVersionId is required for edit mode');
    return out;
  });
}

const PRICING_FIELDS = ['textIn', 'imageIn', 'imageInCached', 'imageOut', 'textOut'];
const RECOGNITION_MODELS = Object.keys(SETTINGS_DEFAULTS.pricing).filter(k => !IMAGE_MODELS.includes(k) && !k.startsWith('estimated'));

function pricing(v) {
  const defaults = SETTINGS_DEFAULTS.pricing;
  const p = object(v, 'pricing', Object.keys(defaults));
  const out = {};
  for (const key of Object.keys(defaults)) {
    if (!(key in p)) bad(`pricing.${key} is required`);
    if (key === 'estimatedInputTokensPerReference') out[key] = numRange(p[key], `pricing.${key}`, 0, 1_000_000);
    else if (key === 'estimatedOutputTokensPerMegapixel') {
      const t = object(p[key], `pricing.${key}`, IMAGE_QUALITIES);
      out[key] = Object.fromEntries(IMAGE_QUALITIES.map(q => [q, numRange(t[q], `pricing.${key}.${q}`, 0, 1_000_000)]));
    } else {
      const rates = object(p[key], `pricing.${key}`, PRICING_FIELDS);
      out[key] = Object.fromEntries(Object.keys(defaults[key]).map(f => [f, numRange(rates[f], `pricing.${key}.${f}`, 0, 10_000)]));
    }
  }
  return out;
}

function presets(v) {
  const p = object(v, 'presets', PRESETS);
  return Object.fromEntries(PRESETS.map(name => {
    if (!(name in p)) bad(`presets.${name} is required`);
    const x = object(p[name], `presets.${name}`, ['model', 'quality', 'complexity', 'outputFormat', 'confirm']);
    if (typeof x.confirm !== 'boolean') bad(`presets.${name}.confirm must be a boolean`);
    return [name, {
      model: oneOf(x.model, `presets.${name}.model`, IMAGE_MODELS), quality: oneOf(x.quality, `presets.${name}.quality`, IMAGE_QUALITIES),
      complexity: oneOf(x.complexity, `presets.${name}.complexity`, IMAGE_COMPLEXITIES),
      outputFormat: oneOf(x.outputFormat, `presets.${name}.outputFormat`, OUTPUT_FORMATS), confirm: x.confirm,
    }];
  }));
}

function overrides(v) {
  const o = object(v, 'overrides', COMPARTMENT_IDS);
  const out = {};
  for (const [cid, raw] of Object.entries(o)) {
    const x = object(raw, `overrides.${cid}`, ['orientation', 'size', 'zones', 'dimensions', 'specText']);
    const dims = x.dimensions === undefined ? undefined : (() => {
      const d = object(x.dimensions, `overrides.${cid}.dimensions`, ['widthIn', 'heightIn', 'depthIn', 'doorWidthIn', 'doorHeightIn']);
      return Object.fromEntries(Object.entries(d).map(([k, n]) => [k, numRange(n, `overrides.${cid}.dimensions.${k}`, 0.5, 400)]));
    })();
    if (x.size !== undefined && !isValidImageSize(x.size)) bad(`overrides.${cid}.size is not a valid image size`);
    if (x.zones !== undefined && (!Array.isArray(x.zones) || x.zones.length > 30)) bad(`overrides.${cid}.zones must be an array of at most 30`);
    out[cid] = drop({
      orientation: oneOf(x.orientation, `overrides.${cid}.orientation`, ORIENTATION_VALUES, true),
      size: x.size,
      zones: x.zones?.map((z, i) => { const s = str(z, `overrides.${cid}.zones[${i}]`, { max: 40, min: 1 }); if (!ZONE.test(s)) bad(`overrides.${cid}.zones[${i}] has invalid characters`); return s; }),
      dimensions: dims,
      specText: str(x.specText, `overrides.${cid}.specText`, { max: 2000, optional: true }),
    });
  }
  return out;
}

const bool = (v, key) => { if (typeof v !== 'boolean') bad(`${key} must be a boolean`); return v; };
const usd = (v, key) => numRange(v, key, 0, 10_000);

const SETTING_VALIDATORS = {
  'studio.enabled': bool,
  'ai.enabled': bool,
  'recognition.enabled': bool,
  'verification.enabled': bool,
  'access.admins': (v, key) => {
    if (!Array.isArray(v) || v.length > 50) bad(`${key} must be an array of at most 50 emails`);
    const list = v.map((e, i) => { const s = str(e, `${key}[${i}]`, { max: 254, min: 3 }).toLowerCase(); if (!EMAIL.test(s)) bad(`${key}[${i}] is not a valid email`); return s; });
    return [...new Set(list)];
  },
  'budget.monthlyUsd': usd,
  'budget.dailyUsd': usd,
  'budget.userDailyUsd': usd,
  'jobs.maxConcurrent': (v, key) => int(v, key, 1, 10),
  'jobs.userMaxConcurrent': (v, key) => int(v, key, 1, 10),
  'references.maxPerRequest': (v, key) => int(v, key, 1, 16),
  'recognition.model': (v, key) => oneOf(v, key, RECOGNITION_MODELS),
  'style.houseText': (v, key) => str(v, key, { max: 2000 }),
  presets: v => presets(v),
  pricing: v => pricing(v),
  'compartments.overrides': v => overrides(v),
};

/**
 * Validate one admin setting. @param {string} key one of SETTINGS_KEYS @param {unknown} value
 * @returns {{ok:true, value:unknown}|{ok:false, error:string}}
 */
export function validateSettingValue(key, value) {
  if (!Object.prototype.hasOwnProperty.call(SETTING_VALIDATORS, key)) return { ok: false, error: 'unknown setting' };
  return guard(() => SETTING_VALIDATORS[key](value, key));
}
