// Environment configuration. Values are never printed; only variable names appear in errors.
import os from 'node:os';
import { JOB_KINDS } from '../../shared/contracts.js';

export class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`Invalid configuration: ${problems.join('; ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const isLocalHost = h => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';

/**
 * @typedef {{apiBase:string, accessClientId:string, accessClientSecret:string, openaiKey:string, nodeName:string,
 *   kinds:string[], maxParallel:number, openaiBase:string, dryRun:boolean}} Config
 */

/**
 * Parse and validate the environment.
 * @param {Record<string,string|undefined>} env
 * @returns {Config}
 */
export function loadConfig(env = process.env) {
  const problems = [];
  const dryRun = /^(1|true|yes)$/i.test(env.L1_DRY_RUN || '');
  const need = name => {
    const v = (env[name] || '').trim();
    if (!v) problems.push(`${name} is required`);
    return v;
  };
  let apiBase = need('L1_API_BASE');
  if (apiBase) {
    try {
      const u = new URL(apiBase);
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalHost(u.hostname))) problems.push('L1_API_BASE must be an https URL');
      apiBase = u.origin + u.pathname.replace(/\/+$/, '');
    } catch { problems.push('L1_API_BASE is not a valid URL'); }
  }
  const accessClientId = need('L1_ACCESS_CLIENT_ID');
  const accessClientSecret = need('L1_ACCESS_CLIENT_SECRET');
  const openaiKey = dryRun ? (env.L1_OPENAI_API_KEY || '').trim() : need('L1_OPENAI_API_KEY');
  const kinds = (env.L1_KINDS || 'render,recognize,verify').split(',').map(s => s.trim()).filter(Boolean);
  if (!kinds.length || kinds.some(k => !JOB_KINDS.includes(k))) problems.push(`L1_KINDS must be a comma list of ${JOB_KINDS.join(',')}`);
  const maxParallel = Number(env.L1_MAX_PARALLEL || 1);
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) problems.push('L1_MAX_PARALLEL must be an integer 1-8');
  if (problems.length) throw new ConfigError(problems);
  return {
    apiBase, accessClientId, accessClientSecret, openaiKey,
    nodeName: (env.L1_NODE_NAME || '').trim() || os.hostname(),
    kinds, maxParallel,
    openaiBase: (env.L1_OPENAI_BASE || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    dryRun,
  };
}

/**
 * Secret values that must be masked in logs.
 * @param {Config} c
 * @returns {string[]}
 */
export const secretsOf = c => [c.accessClientSecret, c.accessClientId, c.openaiKey].filter(Boolean);

/**
 * Redacted configuration summary safe for logs.
 * @param {Config} c
 */
export function summarize(c) {
  return {
    apiBase: c.apiBase, node: c.nodeName, kinds: c.kinds, maxParallel: c.maxParallel, openaiBase: c.openaiBase, dryRun: c.dryRun,
    accessClientId: c.accessClientId ? 'set' : 'missing', accessClientSecret: c.accessClientSecret ? 'set' : 'missing',
    openaiKey: c.openaiKey ? 'set' : 'missing',
  };
}
