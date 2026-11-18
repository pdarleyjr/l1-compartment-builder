#!/usr/bin/env node
// Dependency audit gate: `npm audit` at level low, minus the temporary, expiring, dev-only exceptions listed in
// audit-exceptions.json. Fails on any other advisory, when an excepted advisory reaches a production dependency,
// when a fixed version is published, or after the exception's expiry date. Usage: npm run audit
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { evaluateAudit } from './audit-policy.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function run(args) {
  try {
    return execFileSync(npm, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    if (e.stdout) return e.stdout; // npm audit exits non-zero when it finds anything; the JSON is still on stdout
    throw e;
  }
}
const audit = extra => JSON.parse(run(['audit', '--json', '--audit-level=low', ...extra]) || '{}');

const { exceptions } = JSON.parse(readFileSync(new URL('../../audit-exceptions.json', import.meta.url), 'utf8'));
const latest = {};
for (const pkg of new Set(exceptions.map(e => e.package).filter(Boolean))) {
  try { latest[pkg] = run(['view', pkg, 'version']).trim() || null; } catch { latest[pkg] = null; }
}
const result = evaluateAudit({
  all: audit([]), production: audit(['--omit=dev']), exceptions, today: new Date().toISOString().slice(0, 10), latest,
});
for (const line of result.excepted) console.log(`excepted: ${line}`);
for (const line of result.warnings) console.log(`warning: ${line}`);
if (!result.ok) {
  for (const line of result.failures) console.error(`FAIL: ${line}`);
  process.exit(1);
}
console.log('npm audit: no advisories outside the temporary exceptions');
