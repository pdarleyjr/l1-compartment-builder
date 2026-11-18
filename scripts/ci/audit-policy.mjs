// Pure decision logic for scripts/ci/audit.mjs (unit-tested in tests/ci/audit-policy.test.js).

const GHSA = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i;

/** Every advisory object in an `npm audit --json` (v2) report, keyed by GHSA id (or source number). */
export function advisoriesOf(report) {
  const out = new Map();
  for (const entry of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of entry.via ?? []) {
      if (!via || typeof via !== 'object') continue;
      const id = (String(via.url ?? '').match(GHSA)?.[0] ?? `npm-${via.source}`).toUpperCase();
      const prev = out.get(id);
      out.set(id, {
        id, package: via.name ?? entry.name, severity: via.severity, title: via.title ?? '', url: via.url ?? '',
        fixAvailable: prev?.fixAvailable === true || entry.fixAvailable === true,
      });
    }
  }
  return out;
}

/**
 * Fail closed: anything that is not a complete `npm audit --json` v2 report (network failure, registry error,
 * truncated output) is an error, never "no advisories". @returns {string|null} error message or null when valid
 */
export function reportError(report, label) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return `${label}: npm audit did not return a JSON object`;
  if (report.error) return `${label}: npm audit failed (${String(report.error.code ?? report.error.summary ?? 'error').slice(0, 120)})`;
  if (report.auditReportVersion !== 2) return `${label}: unexpected npm audit report version ${String(report.auditReportVersion)}`;
  if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)) {
    return `${label}: npm audit report has no vulnerabilities map`;
  }
  const total = report.metadata?.vulnerabilities?.total;
  if (!Number.isInteger(total)) return `${label}: npm audit report has no vulnerability totals`;
  if (total > 0 && Object.keys(report.vulnerabilities).length === 0) return `${label}: npm audit reported ${total} findings without details`;
  return null;
}

const parts = v => String(v).split(/[.+-]/).slice(0, 3).map(n => Number.parseInt(n, 10) || 0);
/** a > b for plain x.y.z versions. */
export function newerThan(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/**
 * @param {{all:object, production:object, exceptions:object[], today:string, latest:Record<string,string|null>}} input
 *   all = `npm audit --json`, production = `npm audit --omit=dev --json`, today = YYYY-MM-DD,
 *   latest = latest published version per excepted package (null when the registry could not be asked).
 * @returns {{ok:boolean, failures:string[], excepted:string[], warnings:string[]}}
 */
export function evaluateAudit({ all, production, exceptions, today, latest }) {
  const failures = [];
  const excepted = [];
  const warnings = [];
  const invalid = [reportError(all, 'full audit'), reportError(production, 'production audit')].filter(Boolean);
  if (invalid.length) return { ok: false, failures: invalid, excepted, warnings };
  const byId = new Map(exceptions.map(e => [String(e.id).toUpperCase(), e]));
  const prod = advisoriesOf(production);
  for (const [id, adv] of advisoriesOf(all)) {
    const ex = byId.get(id);
    const label = `${id} ${adv.package} (${adv.severity}) ${adv.title}`.trim();
    if (!ex) { failures.push(`${label}: not excepted`); continue; }
    if (ex.package && ex.package !== adv.package) { failures.push(`${label}: exception is for ${ex.package}`); continue; }
    if (!(today <= ex.expires)) { failures.push(`${label}: exception expired on ${ex.expires}`); continue; }
    if (prod.has(id)) { failures.push(`${label}: now reaches a production dependency, so the dev-only exception no longer applies`); continue; }
    if (adv.fixAvailable) { failures.push(`${label}: npm reports a non-breaking fix; run npm audit fix and remove the exception`); continue; }
    const published = latest?.[adv.package];
    if (published && ex.lastVulnerableVersion && newerThan(published, ex.lastVulnerableVersion)) {
      failures.push(`${label}: ${adv.package} ${published} is published (last vulnerable ${ex.lastVulnerableVersion}); update it and remove the exception`);
      continue;
    }
    if (published === null) warnings.push(`${id}: could not check the registry for a fixed ${adv.package}; relying on the expiry date ${ex.expires}`);
    excepted.push(`${label} — excepted until ${ex.expires} (${ex.reason})`);
  }
  for (const id of byId.keys()) {
    if (!advisoriesOf(all).has(id)) warnings.push(`${id}: no longer reported by npm audit; remove it from audit-exceptions.json`);
  }
  return { ok: failures.length === 0, failures, excepted, warnings };
}
