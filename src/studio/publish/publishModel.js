// Pure decision logic for the Publish step (part B2).

/** @typedef {{kind:'stale'|'conflict'|'forbidden'|'other', message:string}} PublishOutcome */

/**
 * Decide what to show after a failed publish/restore call.
 * stale → offer Regenerate / Publish anyway / Cancel; conflict → reload the main image; others → show message.
 * @param {any} err @returns {PublishOutcome}
 */
export function classifyPublishError(err) {
  if (err?.code === 'STALE_SOURCE') return { kind: 'stale', message: 'Equipment assignments changed since this image was generated.' };
  if (err?.code === 'REVISION_CONFLICT' || (err?.status === 409 && err?.code === 'CONFLICT')) return { kind: 'conflict', message: 'The main image was changed by someone else. The latest one was loaded — please review and publish again.' };
  if (err?.code === 'FORBIDDEN') return { kind: 'forbidden', message: 'You do not have permission to publish.' };
  return { kind: 'other', message: err?.message || 'Publishing failed. Please try again.' };
}

/** Request body for POST main-image. @param {{id:string}} version @param {{revision?:number}|null} main @param {boolean} acknowledgeStale */
export function publishBody(version, main, acknowledgeStale = false) {
  const body = { kind: 'version', ref: version.id, expectRevision: main?.revision ?? 0 };
  if (acknowledgeStale) body.acknowledgeStale = true;
  return body;
}

/** One compartment's main image from GET /api/public/main-images ({mainImages:{[compId]:MainImage}}). @returns {object|null} */
export function extractMain(res, compId) {
  return res?.mainImages?.[compId] ?? null;
}

/** Can this version be published? Rejected/deleted cannot. */
export const canPublish = v => !!v && v.status !== 'rejected' && v.status !== 'deleted';
