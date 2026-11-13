// Scheduled housekeeping (every 5 minutes). Each step is independent; failures are logged, never thrown.
import { logEvent } from './http.js';
import { studioCron } from './studio-handlers.js';

const KEEP_PLANNER_HISTORY = 2000;
const AUDIT_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

/** @returns {Promise<{plannerHistoryDeleted:number, auditDeleted:number}>} */
export async function runCron(env, now = Date.now()) {
  const summary = { plannerHistoryDeleted: 0, auditDeleted: 0 };
  try {
    const r = await env.DB.prepare(
      'DELETE FROM planner_history WHERE revision <= (SELECT MAX(revision) FROM planner_history) - ?').bind(KEEP_PLANNER_HISTORY).run();
    summary.plannerHistoryDeleted = r?.meta?.changes ?? 0;
  } catch (err) { logEvent('error', 'cron.planner_history', { message: String(err?.message ?? err).slice(0, 200) }); }
  try {
    const r = await env.DB.prepare('DELETE FROM audit_log WHERE at < ?').bind(now - AUDIT_RETENTION_MS).run();
    summary.auditDeleted = r?.meta?.changes ?? 0;
  } catch (err) { logEvent('error', 'cron.audit', { message: String(err?.message ?? err).slice(0, 200) }); }
  try {
    await studioCron(env, now);
  } catch (err) { logEvent('error', 'cron.studio', { message: String(err?.message ?? err).slice(0, 200) }); }
  return summary;
}

/** Entry used by worker/index.js `scheduled`. */
export const scheduled = (event, env, ctx) => ctx.waitUntil(runCron(env, Date.now()));
