// Spend ledger: atomic reservation SQL, settlement/release statements and usage reporting.
// All amounts are USD floats; day/month buckets are America/New_York calendar dates.
import { ACTIVE_JOB_STATES } from '../../shared/contracts.js';
import { getSettings } from './settings.js';
import { json } from './http.js';

export const ACTIVE_SQL = ACTIVE_JOB_STATES.map(s => `'${s}'`).join(',');
const COUNTED = "CASE WHEN state='settled' THEN COALESCE(actual_usd, estimated_usd) WHEN state='reserved' THEN estimated_usd ELSE 0 END";

/** @param {number} now epoch ms @returns {{day:string, month:string}} */
export function ledgerBuckets(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now));
  const get = t => parts.find(p => p.type === t).value;
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  return { day, month: day.slice(0, 7) };
}

/**
 * Conditional reservation INSERT ... SELECT ... WHERE. Inserts nothing when any cap would be exceeded.
 * @param {*} db
 * @param {{ledgerId:string, jobId:string, actor:string, estimateUsd:number, model:string, now:number,
 *   caps:{monthly:number, daily:number, user:number, maxConcurrent:number, userMaxConcurrent:number}}} p
 */
export function reservationStatement(db, p) {
  const { day, month } = ledgerBuckets(p.now);
  const est = p.estimateUsd;
  return db.prepare(
    `INSERT INTO spend_ledger (id, job_id, actor, state, estimated_usd, model, day, month, created_at)
     SELECT ?, ?, ?, 'reserved', ?, ?, ?, ?, ?
     WHERE (SELECT COALESCE(SUM(${COUNTED}), 0) FROM spend_ledger WHERE month = ?) + ? <= ?
       AND (SELECT COALESCE(SUM(${COUNTED}), 0) FROM spend_ledger WHERE day = ?) + ? <= ?
       AND (SELECT COALESCE(SUM(${COUNTED}), 0) FROM spend_ledger WHERE day = ? AND actor = ?) + ? <= ?
       AND (SELECT COUNT(*) FROM generation_jobs WHERE status IN (${ACTIVE_SQL})) < ?
       AND (SELECT COUNT(*) FROM generation_jobs WHERE requested_by = ? AND status IN (${ACTIVE_SQL})) < ?`,
  ).bind(
    p.ledgerId, p.jobId, p.actor, est, p.model, day, month, p.now,
    month, est, p.caps.monthly, day, est, p.caps.daily, day, p.actor, est, p.caps.user,
    p.caps.maxConcurrent, p.actor, p.caps.userMaxConcurrent,
  );
}

/** Settle the reservation of a job with the actual cost; only when the job is in `requiredStatus`. */
export function settleStatement(db, jobId, actualUsd, usage, now, requiredStatus) {
  return db.prepare(
    `UPDATE spend_ledger SET state = 'settled', actual_usd = ?, usage = ?, settled_at = ?
     WHERE job_id = ? AND state = 'reserved' AND EXISTS (SELECT 1 FROM generation_jobs WHERE id = ? AND status = ?)`,
  ).bind(actualUsd, usage == null ? null : JSON.stringify(usage), now, jobId, jobId, requiredStatus);
}

/** Release the reservation of a job (no money spent); only when the job is in `requiredStatus`. */
export function releaseStatement(db, jobId, now, requiredStatus) {
  return db.prepare(
    `UPDATE spend_ledger SET state = 'released', settled_at = ?
     WHERE job_id = ? AND state = 'reserved' AND EXISTS (SELECT 1 FROM generation_jobs WHERE id = ? AND status = ?)`,
  ).bind(now, jobId, jobId, requiredStatus);
}

async function sums(db, where, ...args) {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN state='settled' THEN COALESCE(actual_usd, estimated_usd) ELSE 0 END), 0) AS spent,
            COALESCE(SUM(CASE WHEN state='reserved' THEN estimated_usd ELSE 0 END), 0) AS reserved
     FROM spend_ledger WHERE ${where}`,
  ).bind(...args).first();
  return { spent: row?.spent ?? 0, reserved: row?.reserved ?? 0 };
}

/** Current spend figures versus caps for one actor. */
export async function usageFor(db, actor, now) {
  const s = await getSettings(db, ['budget.monthlyUsd', 'budget.dailyUsd', 'budget.userDailyUsd', 'jobs.maxConcurrent', 'jobs.userMaxConcurrent']);
  const { day, month } = ledgerBuckets(now);
  const [today, mon, user] = await Promise.all([
    sums(db, 'day = ?', day), sums(db, 'month = ?', month), sums(db, 'day = ? AND actor = ?', day, actor),
  ]);
  const active = await db.prepare(`SELECT COUNT(*) AS n FROM generation_jobs WHERE status IN (${ACTIVE_SQL})`).first();
  const userActive = await db.prepare(`SELECT COUNT(*) AS n FROM generation_jobs WHERE requested_by = ? AND status IN (${ACTIVE_SQL})`).bind(actor).first();
  return {
    today: { ...today, cap: s['budget.dailyUsd'] },
    month: { ...mon, cap: s['budget.monthlyUsd'] },
    user: { ...user, cap: s['budget.userDailyUsd'] },
    jobs: { active: active?.n ?? 0, max: s['jobs.maxConcurrent'], userActive: userActive?.n ?? 0, userMax: s['jobs.userMaxConcurrent'] },
  };
}

/** GET /api/usage */
export async function getUsage({ db, actor, now }) {
  const label = actor?.kind === 'user' ? actor.email : 'anonymous';
  const usage = await usageFor(db, label, now);
  const { results } = await db.prepare(
    'SELECT id, job_id, actor, state, estimated_usd, actual_usd, model, day, created_at, settled_at FROM spend_ledger ORDER BY created_at DESC, rowid DESC LIMIT 20',
  ).all();
  const recent = (results || []).map(r => ({
    id: r.id, jobId: r.job_id, actor: r.actor, state: r.state, estimatedUsd: r.estimated_usd, actualUsd: r.actual_usd,
    model: r.model, day: r.day, createdAt: r.created_at, settledAt: r.settled_at,
  }));
  return json({ ...usage, recent });
}
