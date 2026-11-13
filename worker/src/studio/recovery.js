// Lease recovery, pending-asset GC and ledger sweeping (used by the processor claim path and the cron).
import { ASSET_LIMITS, JOB_TIMING } from '../../../shared/contracts.js';
import { releaseStatement, settleStatement } from '../spend.js';
import { auditIfExists } from './common.js';

/** Backoff for the next attempt: base·2^attempts plus up to one base of jitter. */
export function backoffMs(attempts, random = Math.random) {
  return JOB_TIMING.backoffBaseMs * 2 ** attempts + Math.floor(random() * JOB_TIMING.backoffBaseMs);
}

const SERVICE = 'system:lease-recovery';

/**
 * Re-queue or fail jobs whose lease expired. Before the paid call (provider_called_at null): requeue while attempts remain,
 * else fail with the reservation released. After it: OUTCOME_UNKNOWN, ledger settled at the estimate; never auto-resubmitted.
 * @returns {Promise<{requeued:number, failed:number, unknown:number, cancelled:number}>}
 */
export async function recoverExpiredLeases(db, now, kinds = null) {
  const kindSql = kinds?.length ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : '';
  const { results } = await db.prepare(
    `SELECT * FROM generation_jobs WHERE status IN ('claimed','preparing','generating','saving') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?${kindSql} LIMIT 50`,
  ).bind(now, ...(kinds || [])).all();
  const out = { requeued: 0, failed: 0, unknown: 0, cancelled: 0 };
  for (const job of results || []) {
    const guard = 'WHERE id = ? AND status = ? AND lease_expires_at < ?';
    const gargs = [job.id, job.status, now];
    const afterCall = !!job.provider_called_at || ['generating', 'saving'].includes(job.status);
    let stmts;
    if (afterCall) {
      stmts = [
        db.prepare(`UPDATE generation_jobs SET status = 'failed', error_code = 'OUTCOME_UNKNOWN', error_message = ?, lease_owner = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ? ${guard}`)
          .bind('The image service stopped responding after the request was sent, so the result is unknown and you may have been charged. Retry if you still need it.', now, now, ...gargs),
        settleStatement(db, job.id, job.estimated_cost_usd, null, now, 'failed'),
      ];
      out.unknown += 1;
    } else if (job.cancel_requested) {
      stmts = [
        db.prepare(`UPDATE generation_jobs SET status = 'cancelled', error_code = 'CANCELLED', error_message = 'Cancelled by the requester.', lease_owner = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ? ${guard}`)
          .bind(now, now, ...gargs),
        releaseStatement(db, job.id, now, 'cancelled'),
      ];
      out.cancelled += 1;
    } else if (job.attempts < job.max_attempts) {
      stmts = [
        db.prepare(`UPDATE generation_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = ?, error_code = 'LEASE_EXPIRED', error_message = 'The worker stopped responding; retrying.', updated_at = ? ${guard}`)
          .bind(now + backoffMs(job.attempts), now, ...gargs),
      ];
      out.requeued += 1;
    } else {
      stmts = [
        db.prepare(`UPDATE generation_jobs SET status = 'failed', error_code = 'LEASE_EXPIRED', error_message = 'The image service did not finish this request after several tries. Nothing was charged.', lease_owner = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ? ${guard}`)
          .bind(now, now, ...gargs),
        releaseStatement(db, job.id, now, 'failed'),
      ];
      out.failed += 1;
    }
    stmts.push(auditIfExists(db, { actor: SERVICE, action: 'job.lease_expired', entityType: 'job', entityId: job.id, detail: { was: job.status, afterCall } }, now,
      'SELECT 1 FROM generation_jobs WHERE id = ? AND updated_at = ? AND error_code IN (\'LEASE_EXPIRED\', \'OUTCOME_UNKNOWN\', \'CANCELLED\')', [job.id, now]));
    await db.batch(stmts);
  }
  return out;
}

/** Settle/release ledger reservations of jobs that already reached a terminal state. */
export async function sweepLedger(db, now) {
  await db.batch([
    db.prepare(
      `UPDATE spend_ledger SET state = 'released', settled_at = ? WHERE state = 'reserved' AND job_id IN
       (SELECT id FROM generation_jobs WHERE status IN ('failed','cancelled') AND provider_called_at IS NULL)`,
    ).bind(now),
    db.prepare(
      `UPDATE spend_ledger SET state = 'settled', actual_usd = estimated_usd, settled_at = ? WHERE state = 'reserved' AND job_id IN
       (SELECT id FROM generation_jobs WHERE status IN ('failed','cancelled','completed') AND provider_called_at IS NOT NULL)`,
    ).bind(now),
  ]);
}

/** Delete pending assets (and their R2 objects) older than the pending TTL. @returns {Promise<number>} rows removed */
export async function gcPendingAssets(db, bucket, now) {
  const { results } = await db.prepare("SELECT id, compartment_id FROM assets WHERE status = 'pending' AND created_at < ? LIMIT 100")
    .bind(now - ASSET_LIMITS.pendingTtlMs).all();
  let removed = 0;
  for (const a of results || []) {
    const prefix = `assets/${a.compartment_id}/${a.id}/`;
    const listed = await bucket.list({ prefix });
    const keys = (listed.objects || []).map(o => o.key);
    if (keys.length) await bucket.delete(keys);
    await db.batch([
      db.prepare("DELETE FROM asset_links WHERE asset_id = ?").bind(a.id),
      db.prepare("DELETE FROM assets WHERE id = ? AND status = 'pending'").bind(a.id),
    ]);
    removed += 1;
  }
  return removed;
}
