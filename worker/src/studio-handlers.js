// Router entry point for the Studio modules: `studio.<module>.<handler>(ctx)` (see shared/contracts.js ROUTES).
import * as assets from './assets.js';
import * as gallery from './gallery.js';
import * as links from './links.js';
import * as mounts from './mounts.js';
import * as designs from './designs.js';
import * as jobs from './jobs.js';
import * as processor from './processor.js';
import * as spend from './spend.js';
import { gcPendingAssets, recoverExpiredLeases, sweepLedger } from './studio/recovery.js';

export { assets, gallery, links, mounts, designs, jobs, processor, spend };

/**
 * Cron housekeeping: expired leases, pending-asset GC, ledger reservations of finished jobs.
 * Each step is isolated so one failure cannot block the others.
 * @param {{DB:any, ASSETS:any}} env @param {number} now epoch ms
 */
export async function studioCron(env, now = Date.now()) {
  const report = { leases: null, gcAssets: 0, errors: [] };
  const steps = [
    ['leases', async () => { report.leases = await recoverExpiredLeases(env.DB, now); }],
    ['gcAssets', async () => { report.gcAssets = await gcPendingAssets(env.DB, env.ASSETS, now); }],
    ['ledger', async () => { await sweepLedger(env.DB, now); }],
  ];
  for (const [name, run] of steps) {
    try { await run(); } catch (err) { report.errors.push(`${name}: ${err?.message || err}`); }
  }
  return report;
}
