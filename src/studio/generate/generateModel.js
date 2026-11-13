// Pure helpers for the Generate step (part B2).
import { INSTRUCTIONS_MAX, PRESETS, SETTINGS_DEFAULTS } from '../../../shared/contracts.js';
import { humanError, isConfirmEstimate, formatUsd } from '../common/format.js';

export const PRESET_INFO = {
  preview: { label: 'Fast Preview', blurb: 'Quick, low-cost draft to check the arrangement.' },
  high: { label: 'High Quality', blurb: 'Detailed image for review and sharing.' },
  max: { label: 'Maximum Detail', blurb: 'Highest fidelity. Slowest and most expensive.' },
};

/** reference when any tool/compartment photo exists, otherwise plan. @param {{category:string,status?:string}[]} assets */
export function pickMode(assets) {
  const has = (assets ?? []).some(a => a.status !== 'deleted' && ['tool', 'tool_group', 'compartment', 'mount', 'arrangement'].includes(a.category));
  return has ? 'reference' : 'plan';
}

/** Body for estimate / jobs (no confirm field). @returns {object} */
export function renderBody({ mode, preset, instructions }) {
  const body = { kind: 'render', mode, preset };
  const text = (instructions ?? '').trim().slice(0, INSTRUCTIONS_MAX);
  if (text) body.instructions = text;
  return body;
}

/** Does this preset need an explicit cost confirmation? The server flag on the estimate wins; until it arrives `max` defaults to yes. */
export function needsConfirm(preset, est) {
  if (typeof est?.requiresConfirm === 'boolean') return est.requiresConfirm;
  return !!SETTINGS_DEFAULTS.presets[preset]?.confirm;
}

/**
 * What will be rendered, plus warnings.
 * @param {{tools:{name:string,qty:number,ref:string}[], counts:Record<string,number>, assets:{category:string,status?:string}[], mounts:object[], geometry:object|null}} d
 */
export function buildSummary({ tools, counts, assets, mounts, geometry }) {
  const live = (assets ?? []).filter(a => a.status !== 'deleted');
  const withoutPhotos = tools.filter(t => !counts[t.ref]);
  const refPhotos = live.filter(a => ['tool', 'tool_group', 'compartment', 'mount', 'arrangement'].includes(a.category)).length;
  const max = SETTINGS_DEFAULTS['references.maxPerRequest'];
  const warnings = [];
  if (withoutPhotos.length) warnings.push(`${withoutPhotos.length} tool${withoutPhotos.length === 1 ? '' : 's'} without photos will be drawn from the name only.`);
  const d = geometry?.dimensions;
  if (!(d?.widthIn > 0 && d?.heightIn > 0)) warnings.push('Compartment dimensions are uncertain, so proportions may be approximate.');
  if (refPhotos > max) warnings.push(`${refPhotos} reference photos exceed ${max}; extras are combined into labelled contact sheets.`);
  return {
    toolCount: tools.reduce((n, t) => n + t.qty, 0), toolKinds: tools.length, withoutPhotos, refPhotos,
    mountCount: (mounts ?? []).length, warnings,
  };
}

/** Map a failed create-job call to UI state. @param {any} err @returns {{kind:'confirm'|'error'|'budget'|'busy'|'disabled', message:string, estimateUsd?:number}} */
export function classifySubmitError(err) {
  if (isConfirmEstimate(err)) {
    const usd = Number(err?.details?.estimate?.usd);
    return { kind: 'confirm', message: 'This preset needs your OK on the cost first.', estimateUsd: Number.isFinite(usd) ? usd : undefined };
  }
  const kind = { BUDGET_EXCEEDED: 'budget', CONCURRENCY_LIMIT: 'busy', AI_DISABLED: 'disabled' }[err?.code] ?? 'error';
  return { kind, message: humanError(err) };
}

/**
 * GET /api/usage → {today, month, user: {spent, reserved, cap}, jobs, recent} as labelled meters (spent + reserved vs cap).
 * @returns {{label:string, used:number, limit:number|null, pct:number|null}[]}
 */
export function usageMeters(u) {
  if (!u || typeof u !== 'object') return [];
  return [['This month', u.month], ['Today', u.today], ['You today', u.user]].filter(([, m]) => m && typeof m.spent === 'number').map(([label, m]) => {
    const used = m.spent + (m.reserved ?? 0);
    const limit = typeof m.cap === 'number' ? m.cap : null;
    return { label, used, limit, pct: limit ? Math.min(100, Math.round((used / limit) * 100)) : null };
  });
}

/** @param {{used:number, limit:number|null}} m */
export const meterText = m => `${formatUsd(m.used)}${m.limit != null ? ` of ${formatUsd(m.limit)}` : ''}`;

export { PRESETS };
