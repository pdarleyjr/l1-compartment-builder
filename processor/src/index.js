/* global AbortController, clearTimeout, process, setTimeout -- Node 22 runtime globals (AIW processor runs on Node, not in the browser/Worker) */
// Main loop: claim → run → repeat. Outbound only; no listening port.
import { pathToFileURL } from 'node:url';
import { JOB_TIMING } from '../../shared/contracts.js';
import { loadConfig, ConfigError, secretsOf, summarize } from './config.js';
import { createLogger } from './logger.js';
import { createApiClient } from './api-client.js';
import { createOpenAiAdapter } from './openai-adapter.js';
import { createDryRunAdapter } from './dry-run-adapter.js';
import { createJobRunner } from './job-runner.js';

const SHUTDOWN_GRACE_MS = 120_000;
const sleep = (ms, signal) => new Promise(r => { const t = setTimeout(r, ms); signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); });

/**
 * Build the service. Exposed for tests.
 * @param {import('./config.js').Config} config
 * @param {{logger?:any, adapter?:any, api?:any, pollActiveMs?:number, pollIdleMs?:number, heartbeatMs?:number, graceMs?:number, apiOpts?:object}} [over]
 */
export function createProcessor(config, over = {}) {
  const logger = over.logger || createLogger({ secrets: secretsOf(config) });
  const api = over.api || createApiClient(config, over.apiOpts);
  const adapter = over.adapter || (config.dryRun ? createDryRunAdapter() : createOpenAiAdapter({ apiKey: config.openaiKey, baseUrl: config.openaiBase }));
  const runner = createJobRunner({ api, adapter, node: config.nodeName, logger, heartbeatMs: over.heartbeatMs, secrets: secretsOf(config) });
  const pollActiveMs = over.pollActiveMs ?? JOB_TIMING.pollActiveMs;
  const pollIdleMs = over.pollIdleMs ?? JOB_TIMING.pollIdleMs;
  const graceMs = over.graceMs ?? SHUTDOWN_GRACE_MS;
  const running = new Set();
  const stop = new AbortController();
  let stopping = false;

  /** Try to claim one job. @returns {Promise<boolean>} true when a job was started */
  async function claimOne() {
    const claim = await api.claim(config.nodeName, config.kinds, { signal: stop.signal });
    if (!claim?.job) return false;
    logger.info('claimed job', { jobId: claim.job.id, kind: claim.job.kind });
    const h = runner.start(claim);
    running.add(h);
    h.done.finally(() => running.delete(h));
    return true;
  }

  /** @param {{once?:boolean}} [o] */
  async function loop(o = {}) {
    let idleStreak = 0;
    let lastWork = 0;
    while (!stopping) {
      let claimed = false;
      try {
        if (running.size < config.maxParallel) claimed = await claimOne();
      } catch (err) {
        if (stopping) break;
        logger.warn('claim failed', { err });
        idleStreak += 1;
      }
      if (claimed) lastWork = Date.now();
      if (o.once) { if (!claimed) break; await Promise.allSettled([...running].map(h => h.done)); break; }
      const full = running.size >= config.maxParallel;
      const delay = claimed && !full ? 0 : (Date.now() - lastWork < 60_000 || full) ? pollActiveMs : Math.min(pollIdleMs, pollActiveMs * 2 ** Math.min(idleStreak, 3));
      if (!claimed) idleStreak += 1; else idleStreak = 0;
      if (delay) await sleep(delay, stop.signal);
    }
  }

  /** Graceful stop: no more claims; pre-generating jobs are requeued, others get graceMs to finish. */
  function shutdown() {
    shutdownPromise ||= doShutdown();
    return shutdownPromise;
  }
  let shutdownPromise = null;
  async function doShutdown() {
    stopping = true;
    stop.abort();
    logger.info('shutting down', { activeJobs: running.size });
    const handles = [...running];
    for (const h of handles) h.requestShutdown();
    const all = Promise.allSettled(handles.map(h => h.done)).then(() => 'done');
    let timer;
    const timeout = new Promise(r => { timer = setTimeout(() => r('timeout'), graceMs); });
    const r = await Promise.race([all, timeout]);
    clearTimeout(timer);
    if (r === 'timeout') logger.error('grace period exceeded; exiting with jobs in flight', { activeJobs: running.size });
    return r;
  }

  /** Config valid (already true if we got here) + Worker reachable. */
  async function health() {
    const r = await api.ping();
    const ok = r.status < 500 && ![301, 302, 303, 307, 308, 401, 403].includes(r.status); // redirect/401/403 = Access rejected the token
    return { ok, status: r.status };
  }
  return { loop, shutdown, health, running, logger };
}

/** CLI entry. @param {string[]} argv */
export async function main(argv, env = process.env) {
  let config;
  try { config = loadConfig(env); } catch (err) {
    if (err instanceof ConfigError) { process.stderr.write(`${err.message}\n`); return 78; }
    throw err;
  }
  const p = createProcessor(config);
  if (argv.includes('--health')) {
    try {
      const h = await p.health();
      if (!h.ok) { p.logger.error('health failed: Worker rejected the request', { workerStatus: h.status }); return 1; }
      p.logger.info('health ok', { workerStatus: h.status, config: summarize(config) }); return 0;
    } catch (err) {
      p.logger.error('health failed: Worker unreachable', { err }); return 1;
    }
  }
  p.logger.info('starting', { config: summarize(config), once: argv.includes('--once') });
  let code = 0;
  const onSignal = sig => { p.logger.info('signal received', { sig }); p.shutdown(); };
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));
  await p.loop({ once: argv.includes('--once') });
  if (await p.shutdown() === 'timeout') code = 1;
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(c => process.exit(c), err => { process.stderr.write(`fatal: ${err?.message}\n`); process.exit(1); });
}
