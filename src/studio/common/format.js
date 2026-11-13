// Pure formatting / error-message helpers shared by the Studio steps (part B2).

/** "$0.12" style amount. @param {number|null|undefined} n */
export function formatUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;
}

/** "about $0.xx (estimate)" @param {number|null|undefined} n */
export const estimateLabel = n => `about ${formatUsd(n)} (estimate)`;

/** Short date/time for lists. @param {number|string|null} ts */
export function formatWhen(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Human message for an API/network error, with friendly text for the well-known Studio codes. @param {any} err */
export function humanError(err) {
  const code = err?.code;
  switch (code) {
    case 'BUDGET_EXCEEDED': return 'The AI spending limit has been reached for now. Ask an admin to raise it or try again later.';
    case 'CONCURRENCY_LIMIT': return 'Too many images are being generated right now. Wait for one to finish, then try again.';
    case 'AI_DISABLED': return 'AI image generation is turned off. An admin can turn it on in Studio settings.';
    case 'STUDIO_DISABLED': return 'The AI Compartment Studio is turned off.';
    case 'RATE_LIMITED': return 'Too many requests. Please wait a moment and try again.';
    case 'FORBIDDEN': return 'You do not have permission to do that.';
    case 'AUTH_REQUIRED': return 'Sign in to continue.';
    case 'REVISION_CONFLICT': return 'Someone else changed this. The latest version was loaded — please review and try again.';
    default: return err?.message || 'Something went wrong. Please try again.';
  }
}

/** @param {any} err @returns {boolean} true for the server's "estimate must be confirmed" 409 (CONFLICT, details.requiresConfirm) */
export function isConfirmEstimate(err) {
  return err?.status === 409 && err?.code === 'CONFLICT' && err?.details?.requiresConfirm === true;
}

/** Download-free label for a version's cost. @param {{actualCostUsd?:number|null, estimatedCostUsd?:number|null}|null} job */
export function costLabel(job) {
  if (!job) return '';
  if (typeof job.actualCostUsd === 'number') return `${formatUsd(job.actualCostUsd)} (actual)`;
  if (typeof job.estimatedCostUsd === 'number') return `${formatUsd(job.estimatedCostUsd)} (estimate)`;
  return '';
}
