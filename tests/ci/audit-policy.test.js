import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { advisoriesOf, evaluateAudit, newerThan } from '../../scripts/ci/audit-policy.mjs';

const PICO = 'GHSA-fc5q-39xc-vjpf';
const advisory = (name, id, severity = 'high') => ({ source: 1, name, title: 'ReDoS', url: `https://github.com/advisories/${id}`, severity, range: '<=4.0.7' });
const report = (entries) => ({ auditReportVersion: 2, vulnerabilities: entries, metadata: { vulnerabilities: { total: Object.keys(entries).length } } });
const picoReport = (fixAvailable = { name: 'vitest', version: '3.1.4', isSemVerMajor: true }) => report({
  picomatch: { name: 'picomatch', severity: 'high', via: [advisory('picomatch', PICO)], fixAvailable },
  anymatch: { name: 'anymatch', severity: 'high', via: ['picomatch'], fixAvailable: true },
});
const clean = report({});
const exception = { id: PICO, package: 'picomatch', reason: 'dev only', lastVulnerableVersion: '4.0.7', expires: '2027-02-28' };
const base = { all: picoReport(), production: clean, exceptions: [exception], today: '2026-11-18', latest: { picomatch: '4.0.7' } };

describe('audit policy', () => {
  test('the repository exception file is valid (the picomatch exception was retired once npm audit stopped reporting it)', () => {
    const file = JSON.parse(readFileSync(new URL('../../audit-exceptions.json', import.meta.url), 'utf8'));
    expect(Array.isArray(file.exceptions)).toBe(true);
    expect(file.exceptions.map(e => e.id)).not.toContain(PICO);
    for (const e of file.exceptions) expect(e.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  test('the excepted dev-only advisory passes while no fix exists', () => {
    const r = evaluateAudit(base);
    expect(r.ok).toBe(true);
    expect(r.excepted).toHaveLength(1);
    expect(r.excepted[0]).toContain('excepted until 2027-02-28');
  });
  test('a transitive entry with a fix flag does not count as a fix for the leaf advisory', () => {
    expect(advisoriesOf(picoReport()).get(PICO.toUpperCase()).fixAvailable).toBe(false);
  });
  test('fails on any other advisory, at any severity', () => {
    const all = report({ ...picoReport().vulnerabilities, lodash: { name: 'lodash', via: [advisory('lodash', 'GHSA-aaaa-bbbb-cccc', 'low')] } });
    const r = evaluateAudit({ ...base, all });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain('GHSA-AAAA-BBBB-CCCC lodash (low)');
  });
  test('fails after the expiry date', () => {
    expect(evaluateAudit({ ...base, today: '2027-03-01' }).failures[0]).toContain('expired on 2027-02-28');
  });
  test('fails when the advisory reaches a production dependency', () => {
    expect(evaluateAudit({ ...base, production: picoReport() }).failures[0]).toContain('production dependency');
  });
  test('fails when npm offers a non-breaking fix', () => {
    expect(evaluateAudit({ ...base, all: picoReport(true) }).failures[0]).toContain('non-breaking fix');
  });
  test('fails when a fixed version is published', () => {
    expect(evaluateAudit({ ...base, latest: { picomatch: '4.0.8' } }).failures[0]).toContain('4.0.8 is published');
    expect(newerThan('4.0.10', '4.0.7')).toBe(true);
    expect(newerThan('4.0.7', '4.0.7')).toBe(false);
  });
  test('fails closed when npm audit itself fails or returns something that is not a complete report', () => {
    const bad = [
      null, [], { error: { code: 'ENOTFOUND', summary: 'request to registry failed' } }, { auditReportVersion: 1, vulnerabilities: {} },
      { auditReportVersion: 2 }, { auditReportVersion: 2, vulnerabilities: {} },
      { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 3 } } },
    ];
    for (const r of bad) {
      expect(evaluateAudit({ ...base, all: r }).ok, JSON.stringify(r)).toBe(false);
      expect(evaluateAudit({ ...base, production: r }).ok, JSON.stringify(r)).toBe(false);
    }
    expect(evaluateAudit({ ...base, all: { error: { code: 'ENOTFOUND' } } }).failures[0]).toContain('npm audit failed (ENOTFOUND)');
  });
  test('warns (does not fail) when the registry cannot be asked, and when an exception is no longer needed', () => {
    const offline = evaluateAudit({ ...base, latest: { picomatch: null } });
    expect(offline.ok).toBe(true);
    expect(offline.warnings[0]).toContain('could not check the registry');
    const gone = evaluateAudit({ ...base, all: clean });
    expect(gone.ok).toBe(true);
    expect(gone.warnings[0]).toContain('no longer reported');
  });
});
