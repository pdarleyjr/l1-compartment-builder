// Pure helpers for the admin settings UI: metadata, validation mirroring the contract enums, diff, history (part B2).
import {
  COMPARTMENT_IDS, DEFAULT_ZONES, IMAGE_COMPLEXITIES, IMAGE_MODELS, IMAGE_QUALITIES, IMAGE_SIZE_RULES, PRESETS, SETTINGS_DEFAULTS,
} from '../../../shared/contracts.js';

export const OUTPUT_FORMATS = Object.freeze(['jpeg', 'png', 'webp']);
export const OVERRIDE_ORIENTATIONS = Object.freeze(['landscape', 'portrait', 'square']);
export const HOUSE_TEXT_MAX = 4000;
export const SPEC_TEXT_MAX = 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Settings keys grouped for the UI, with labels and input hints. */
export const SETTING_META = {
  'studio.enabled': { label: 'Studio enabled', group: 'General', type: 'boolean', help: 'Turn the whole AI Compartment Studio on or off.' },
  'ai.enabled': { label: 'AI generation enabled', group: 'General', type: 'boolean', help: 'Kill switch for all paid image generation.' },
  'access.admins': { label: 'Admins', group: 'General', type: 'emails', help: 'Email addresses that can open this panel.' },
  'budget.monthlyUsd': { label: 'Monthly budget (USD)', group: 'Spending', type: 'number', min: 0, max: 10000, step: 1 },
  'budget.dailyUsd': { label: 'Daily budget (USD)', group: 'Spending', type: 'number', min: 0, max: 10000, step: 1 },
  'budget.userDailyUsd': { label: 'Per-user daily budget (USD)', group: 'Spending', type: 'number', min: 0, max: 10000, step: 1 },
  'jobs.maxConcurrent': { label: 'Max jobs at once (everyone)', group: 'Spending', type: 'number', min: 1, max: 20, step: 1, integer: true },
  'jobs.userMaxConcurrent': { label: 'Max jobs at once (per person)', group: 'Spending', type: 'number', min: 1, max: 20, step: 1, integer: true },
  'presets': { label: 'Quality presets', group: 'Generation', type: 'presets', help: 'Which model and quality each preset uses.' },
  'pricing': { label: 'Price table (USD per 1M tokens)', group: 'Generation', type: 'pricing', help: 'Used only for cost estimates; actual cost comes from the provider usage.' },
  'references.maxPerRequest': { label: 'Max reference photos per request', group: 'Generation', type: 'number', min: 1, max: 16, step: 1, integer: true, help: 'Extra photos are combined into labelled contact sheets.' },
  'recognition.enabled': { label: 'Photo recognition enabled', group: 'Recognition & checks', type: 'boolean' },
  'recognition.model': { label: 'Recognition model', group: 'Recognition & checks', type: 'text', maxLength: 80 },
  'verification.enabled': { label: 'Automatic image check enabled', group: 'Recognition & checks', type: 'boolean' },
  'style.houseText': { label: 'House style text', group: 'Style & compartments', type: 'textarea', maxLength: HOUSE_TEXT_MAX, help: 'Inserted as plain data into every prompt.' },
  'compartments.overrides': { label: 'Per-compartment overrides', group: 'Style & compartments', type: 'overrides' },
};

/** @param {string} size 'WxH' @returns {string|null} error */
export function validateSize(size) {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(size ?? '');
  if (!m) return 'Size must look like 1536x1024.';
  const w = Number(m[1]), h = Number(m[2]), r = IMAGE_SIZE_RULES;
  if (w % r.multiple || h % r.multiple) return `Width and height must be multiples of ${r.multiple}.`;
  if (Math.max(w, h) > r.maxEdge) return `Longest edge must be ${r.maxEdge}px or less.`;
  if (w * h < r.minPixels || w * h > r.maxPixels) return `Total pixels must be between ${r.minPixels.toLocaleString()} and ${r.maxPixels.toLocaleString()}.`;
  if (w / h < r.minRatio || w / h > r.maxRatio) return 'Aspect ratio must be between 1:3 and 3:1.';
  return null;
}

const isNum = v => typeof v === 'number' && Number.isFinite(v);

/** Validate one setting value. @param {string} key @param {any} value @returns {string[]} human error messages (empty = valid) */
export function validateSetting(key, value) {
  const meta = SETTING_META[key]; const errs = [];
  if (!meta) return [`Unknown setting ${key}.`];
  switch (meta.type) {
    case 'boolean': if (typeof value !== 'boolean') errs.push('Must be on or off.'); break;
    case 'number':
      if (!isNum(value)) errs.push('Enter a number.');
      else {
        if (value < meta.min || value > meta.max) errs.push(`Must be between ${meta.min} and ${meta.max}.`);
        if (meta.integer && !Number.isInteger(value)) errs.push('Must be a whole number.');
      } break;
    case 'text': if (typeof value !== 'string' || !value.trim()) errs.push('Required.'); else if (value.length > meta.maxLength) errs.push(`At most ${meta.maxLength} characters.`); else if (!/^[A-Za-z0-9._:/-]+$/.test(value)) errs.push('Use letters, digits and . _ : / - only.'); break;
    case 'textarea': if (typeof value !== 'string') errs.push('Must be text.'); else if (value.length > meta.maxLength) errs.push(`At most ${meta.maxLength} characters.`); break;
    case 'emails':
      if (!Array.isArray(value)) errs.push('Must be a list.');
      else { value.filter(e => !EMAIL.test(e)).forEach(e => errs.push(`"${e}" is not a valid email address.`)); if (new Set(value.map(e => e.toLowerCase())).size !== value.length) errs.push('Duplicate email addresses.'); if (!value.length) errs.push('Keep at least one admin.'); }
      break;
    case 'presets':
      if (!value || typeof value !== 'object') { errs.push('Missing presets.'); break; }
      for (const p of PRESETS) {
        const v = value[p];
        if (!v) { errs.push(`Preset "${p}" is missing.`); continue; }
        if (!IMAGE_MODELS.includes(v.model)) errs.push(`${p}: model must be one of ${IMAGE_MODELS.join(', ')}.`);
        if (!IMAGE_QUALITIES.includes(v.quality)) errs.push(`${p}: quality must be one of ${IMAGE_QUALITIES.join(', ')}.`);
        if (!IMAGE_COMPLEXITIES.includes(v.complexity)) errs.push(`${p}: complexity must be one of ${IMAGE_COMPLEXITIES.join(', ')}.`);
        if (!OUTPUT_FORMATS.includes(v.outputFormat)) errs.push(`${p}: format must be one of ${OUTPUT_FORMATS.join(', ')}.`);
        if (typeof v.confirm !== 'boolean') errs.push(`${p}: confirm must be on or off.`);
      } break;
    case 'pricing':
      if (!value || typeof value !== 'object') { errs.push('Missing price table.'); break; }
      for (const [k, v] of Object.entries(value)) {
        if (isNum(v)) { if (v < 0 || v > 1_000_000) errs.push(`${k}: out of range.`); continue; }
        if (!v || typeof v !== 'object') { errs.push(`${k}: invalid.`); continue; }
        for (const [f, n] of Object.entries(v)) if (!isNum(n) || n < 0 || n > 1_000_000) errs.push(`${k}.${f}: enter a number between 0 and 1,000,000.`);
      }
      for (const q of IMAGE_QUALITIES) if (!isNum(value.estimatedOutputTokensPerMegapixel?.[q])) errs.push(`Output tokens per megapixel needs a value for "${q}".`);
      break;
    case 'overrides':
      if (!value || typeof value !== 'object' || Array.isArray(value)) { errs.push('Must be an object.'); break; }
      for (const [id, o] of Object.entries(value)) {
        if (!COMPARTMENT_IDS.includes(id)) { errs.push(`${id}: unknown compartment.`); continue; }
        if (o.orientation != null && !OVERRIDE_ORIENTATIONS.includes(o.orientation)) errs.push(`${id}: orientation must be ${OVERRIDE_ORIENTATIONS.join(', ')}.`);
        if (o.size != null && o.size !== '') { const e = validateSize(o.size); if (e) errs.push(`${id}: ${e}`); }
        if (o.zones != null && (!Array.isArray(o.zones) || o.zones.some(z => !DEFAULT_ZONES.includes(z)))) errs.push(`${id}: zones must come from the list.`);
        for (const [f, n] of Object.entries(o.dimensions ?? {})) if (n != null && (!isNum(n) || n <= 0 || n > 600)) errs.push(`${id}: ${f} must be between 0 and 600 inches.`);
        if (o.specText != null && (typeof o.specText !== 'string' || o.specText.length > SPEC_TEXT_MAX)) errs.push(`${id}: spec text at most ${SPEC_TEXT_MAX} characters.`);
      } break;
    default: break;
  }
  return errs;
}

/** Remove empty override fields so saved JSON stays small. @param {Record<string,object>} overrides */
export function cleanOverrides(overrides) {
  const out = {};
  for (const [id, o] of Object.entries(overrides ?? {})) {
    const c = {};
    if (o.orientation) c.orientation = o.orientation;
    if (o.size) c.size = o.size;
    if (Array.isArray(o.zones) && o.zones.length) c.zones = o.zones;
    const dims = Object.fromEntries(Object.entries(o.dimensions ?? {}).filter(([, n]) => isNum(n)));
    if (Object.keys(dims).length) c.dimensions = dims;
    if (o.specText?.trim()) c.specText = o.specText;
    if (Object.keys(c).length) out[id] = c;
  }
  return out;
}

/** Flat diff of two JSON values. @returns {{path:string, from:any, to:any}[]} */
export function diffValues(from, to, path = '') {
  const same = JSON.stringify(from) === JSON.stringify(to);
  if (same) return [];
  const obj = v => v && typeof v === 'object' && !Array.isArray(v);
  if (obj(from) && obj(to)) {
    return [...new Set([...Object.keys(from), ...Object.keys(to)])].flatMap(k => diffValues(from[k], to[k], path ? `${path}.${k}` : k));
  }
  return [{ path: path || '(value)', from, to }];
}

/** GET /admin/settings → {settings:{[key]:{value, revision, default}}}. Returns {key:{value, revision}} (defaults fill gaps). */
export function normalizeSettings(res) {
  const raw = res?.settings ?? {};
  const out = {};
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    const e = raw[key];
    out[key] = e ? { value: e.value, revision: Number(e.revision ?? 0) } : { value: SETTINGS_DEFAULTS[key], revision: 0 };
  }
  return out;
}

/** @param {{history:{revision:number, value:any, updatedBy?:string, updatedAt?:number}[]}} res GET .../history response @returns {object[]} newest first */
export function normalizeHistory(res) {
  return [...(res?.history ?? [])].sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0));
}

/** Short display of a JSON value for diffs. */
export function showValue(v) {
  if (v === undefined) return '(none)';
  const s = typeof v === 'string' ? `"${v}"` : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}
