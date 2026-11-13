// Structured geometry derived from shared/apparatus.js COMPARTMENT_SPECS + admin overrides, and valid render sizes.
import { COMPARTMENT_IDS, DEFAULT_ZONES, IMAGE_SIZE_RULES } from './contracts.js';
import { COMP_LABEL, COMPARTMENT_SPECS } from './apparatus.js';

export const ORIENTATION_VALUES = Object.freeze(['landscape', 'portrait', 'square']);
const SQUARE_BAND = [0.9, 1.1]; // aspect (W/H) inside this band counts as square

/**
 * Hand-maintained dimensions (inches) for every value the spec-text regex cannot parse reliably (the regex only
 * reads labelled `NN" H × NN" W × NN" D` runs after "Overall"/"Door opening"). Regex values win where present.
 * RR1 and CabRearZone have no published dimensions → absent here, flagged `dimensionsKnown:false`.
 */
export const MANUAL_DIMENSIONS = Object.freeze({
  LS1: { widthIn: 17.75, heightIn: 38, depthIn: 27, doorWidthIn: 15, doorHeightIn: 38 },
  LS2: { widthIn: 40, heightIn: 44, depthIn: 26 }, // width = widest shelf (fixed shelf 40"), depth = pull-out tray 26"
  LS3: { widthIn: 80, heightIn: 16.375, depthIn: 27 },
  LS4: { widthIn: 26.5, heightIn: 20, depthIn: 26, doorWidthIn: 26.5, doorHeightIn: 22 }, // width = door opening
  RS1: { widthIn: 17.75, heightIn: 38, depthIn: 27, doorWidthIn: 15, doorHeightIn: 38 },
  RS2: { widthIn: 40, heightIn: 44, depthIn: 26 },
  RS3: { widthIn: 56, heightIn: 16, depthIn: 15 },
  RS4: { widthIn: 25, heightIn: 20, depthIn: 26.75 },
  RS5: { widthIn: 17, heightIn: 29.5, depthIn: 9, doorWidthIn: 15.5, doorHeightIn: 29.5 },
});

/** Aspect (W/H) used when no dimensions are known. */
export const DEFAULT_ASPECT = Object.freeze({ CabRearZone: 1, RR1: 4 / 3 });

const FEATURE_RULES = [
  { re: /Pull-Out Tilt Shelf/i, label: 'Pull-Out Tilt Shelf', zones: ['upper_shelf'] },
  { re: /Tilt\/pull-out tray/i, label: 'Tilt / Pull-Out Tray', zones: ['pull_out_tray', 'lower_tray'] },
  { re: /(?<!Tilt\/)Pull-Out Tray/i, label: 'Pull-Out Tray', zones: ['pull_out_tray', 'lower_tray'] },
  { re: /Top shelf/i, label: 'Top Shelf', zones: ['upper_shelf'] },
  { re: /Fixed Shelf/i, label: 'Fixed Shelf', zones: ['middle_shelf'] },
  { re: /Fixed tray/i, label: 'Fixed Tray', zones: ['middle_shelf'] },
  { re: /Lower open bay/i, label: 'Lower Open Bay', zones: ['lower_tray'] },
  { re: /three-tier/i, label: 'Three-Tier Layout', zones: ['upper_shelf', 'middle_shelf', 'lower_tray'] },
  { re: /Inverter/i, label: 'Inverter (upper-left corner)', zones: [] },
  { re: /exhaust located below/i, label: 'Exhaust below compartment', zones: [] },
  { re: /tires located directly below/i, label: 'Tires below compartment', zones: [] },
  { re: /Very shallow|shallow/i, label: 'Shallow', zones: [] },
];
const BASE_ZONES = ['left_wall', 'right_wall', 'rear_wall', 'floor', 'door_area', 'other'];

const num = s => {
  const m = /^(\d+)(?:\s+(\d+)\/(\d+))?$/.exec(s.trim());
  if (!m) return undefined;
  return Number(m[1]) + (m[2] ? Number(m[2]) / Number(m[3]) : 0);
};

function parseRun(run) {
  const out = {};
  for (const m of run.matchAll(/(\d+(?:\s+\d+\/\d+)?)"\s*([HWD])\b/g)) out[m[2]] = num(m[1]);
  return out;
}

/**
 * Parse the dimension runs of a spec text. Only the "Overall…:" run and the "Door opening:" run are read, so
 * sub-component sizes (shelves, trays, sections) never overwrite the compartment's own size.
 * @param {string} text
 * @returns {{widthIn?:number, heightIn?:number, depthIn?:number, doorWidthIn?:number, doorHeightIn?:number}}
 */
export function parseSpecDimensions(text) {
  const out = {};
  const overall = /Overall[^:.]*:\s*([^.]*?)\.(?=\s|$)/.exec(text);
  if (overall) {
    const r = parseRun(overall[1]);
    if (r.W) out.widthIn = r.W;
    if (r.H) out.heightIn = r.H;
    if (r.D) out.depthIn = r.D;
  }
  const door = /Door opening:\s*([^.]*?)\.(?=\s|$)/.exec(text);
  if (door) {
    const r = parseRun(door[1]);
    if (r.W) out.doorWidthIn = r.W;
    if (r.H) out.doorHeightIn = r.H;
  }
  return out;
}

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const orientationOf = aspect => (aspect < SQUARE_BAND[0] ? 'portrait' : aspect > SQUARE_BAND[1] ? 'landscape' : 'square');

/** Per-compartment override object from either the whole settings map or a single override. */
function pickOverride(compId, overrides) {
  if (!isObj(overrides)) return {};
  if (isObj(overrides[compId])) return overrides[compId];
  if (COMPARTMENT_IDS.some(id => id in overrides)) return {};
  return overrides;
}

/**
 * Structured geometry for one compartment. `overrides` is the settings value 'compartments.overrides'
 * ({[compId]:{orientation?, size?, zones?, dimensions?, specText?}}) or a single compartment's override object.
 * @param {string} compId @param {object} [overrides]
 * @returns {{id:string, label:string, specText:string, dimensions:object, dimensionsKnown:boolean, features:string[], zones:string[],
 *   orientation:'landscape'|'portrait'|'square', aspect:number, sizeOverride?:string}}
 */
export function compartmentGeometry(compId, overrides = {}) {
  if (!COMPARTMENT_IDS.includes(compId)) throw new RangeError(`unknown compartment ${compId}`);
  const o = pickOverride(compId, overrides);
  const baseText = COMPARTMENT_SPECS[compId] ?? '';
  const specText = typeof o.specText === 'string' && o.specText.trim() ? o.specText.trim() : baseText;
  const parsed = parseSpecDimensions(specText);
  const dimensions = { ...(specText === baseText ? MANUAL_DIMENSIONS[compId] : {}), ...parsed };
  if (specText === baseText) Object.assign(dimensions, parsed); // regex wins over the table where it parsed
  for (const [k, v] of Object.entries(isObj(o.dimensions) ? o.dimensions : {})) if (typeof v === 'number' && v > 0) dimensions[k] = v;
  const features = FEATURE_RULES.filter(f => f.re.test(specText)).map(f => f.label);
  const zoneSet = new Set(BASE_ZONES);
  for (const f of FEATURE_RULES) if (f.re.test(specText)) f.zones.forEach(z => zoneSet.add(z));
  const zones = Array.isArray(o.zones) && o.zones.length ? [...o.zones] : DEFAULT_ZONES.filter(z => zoneSet.has(z));
  const dimensionsKnown = Boolean(dimensions.widthIn && dimensions.heightIn);
  let aspect = dimensionsKnown ? dimensions.widthIn / dimensions.heightIn : (DEFAULT_ASPECT[compId] ?? 1);
  let orientation = orientationOf(aspect);
  if (ORIENTATION_VALUES.includes(o.orientation) && o.orientation !== orientation) {
    orientation = o.orientation;
    aspect = orientation === 'square' ? 1 : (orientation === 'landscape') === (aspect > 1) ? aspect : 1 / aspect;
  }
  const geometry = {
    id: compId, label: COMP_LABEL[compId] ?? compId, specText, dimensions, dimensionsKnown, features, zones, orientation, aspect,
  };
  if (typeof o.size === 'string') geometry.sizeOverride = o.size;
  return geometry;
}

const floor16 = n => Math.floor(n / IMAGE_SIZE_RULES.multiple) * IMAGE_SIZE_RULES.multiple;
const ceil16 = n => Math.ceil(n / IMAGE_SIZE_RULES.multiple) * IMAGE_SIZE_RULES.multiple;
const round16 = n => Math.round(n / IMAGE_SIZE_RULES.multiple) * IMAGE_SIZE_RULES.multiple;

/** Validate 'WxH' against IMAGE_SIZE_RULES. @param {unknown} size @returns {{ok:boolean, width?:number, height?:number, error?:string}} */
export function parseImageSize(size) {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(typeof size === 'string' ? size : '');
  if (!m) return { ok: false, error: 'size must look like 1536x1024' };
  const width = Number(m[1]);
  const height = Number(m[2]);
  const r = IMAGE_SIZE_RULES;
  if (width % r.multiple || height % r.multiple) return { ok: false, error: `edges must be multiples of ${r.multiple}` };
  if (Math.max(width, height) > r.maxEdge) return { ok: false, error: `longest edge must be ≤ ${r.maxEdge}` };
  const ratio = width / height;
  if (ratio > r.maxRatio || ratio < r.minRatio) return { ok: false, error: 'aspect ratio must be between 1:3 and 3:1' };
  const px = width * height;
  if (px < r.minPixels || px > r.maxPixels) return { ok: false, error: `pixel count must be within ${r.minPixels}..${r.maxPixels}` };
  return { ok: true, width, height };
}

/** @param {unknown} size @returns {boolean} */
export const isValidImageSize = size => parseImageSize(size).ok;

/**
 * Compute a valid 'WxH' for an aspect ratio (W/H): multiples of 16, ratio clamped to 1:3..3:1, pixel bounds, long edge
 * ≤ maxEdge (default 2560, never above the API limit; raised only if needed to reach the minimum pixel count).
 * @param {number} aspect @param {number} [maxEdge] @returns {string}
 */
export function sizeForAspect(aspect, maxEdge = IMAGE_SIZE_RULES.defaultMaxEdge) {
  const r = IMAGE_SIZE_RULES;
  const wide = aspect >= 1;
  const ratio = Math.min(r.maxRatio, Math.max(1, wide ? aspect : 1 / aspect));
  const fit = long => {
    let short = round16(long / ratio);
    if (long / short > r.maxRatio) short = ceil16(long / r.maxRatio);
    return Math.max(short, r.multiple);
  };
  let long = Math.max(r.multiple, floor16(Math.min(maxEdge, r.maxEdge)));
  while (long * fit(long) > r.maxPixels && long > r.multiple) long -= r.multiple;
  while (long * fit(long) < r.minPixels && long < floor16(r.maxEdge)) long += r.multiple;
  const short = fit(long);
  return wide ? `${long}x${short}` : `${short}x${long}`;
}

/**
 * Output size 'WxH' valid for gpt-image-2.6 (contracts IMAGE_SIZE_RULES), from the compartment's proportions.
 * A valid `size` override wins. @param {string} compId @param {object} [overrides] @param {{maxEdge?:number}} [opts]
 */
export function renderSizeFor(compId, overrides = {}, opts = {}) {
  const g = compartmentGeometry(compId, overrides);
  if (g.sizeOverride && isValidImageSize(g.sizeOverride)) return g.sizeOverride;
  return sizeForAspect(g.aspect, opts.maxEdge ?? IMAGE_SIZE_RULES.defaultMaxEdge);
}
