// Security review 2026-11 — static hosting headers vs what the app actually loads, deploy config, and secrets in the tree.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = rel => readFileSync(join(ROOT, rel), 'utf8');

/** Parse public/_headers into {pattern: {Header: value}}. */
function parseHeaders(text) {
  const out = {}; let cur = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) { cur = line.trim(); out[cur] = {}; continue; }
    const i = line.indexOf(':');
    out[cur][line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
const headers = parseHeaders(read('public/_headers'));
const all = headers['/*'];
const csp = Object.fromEntries(all['Content-Security-Policy'].split(';').map(d => d.trim()).filter(Boolean).map(d => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));

describe('public/_headers (served by Pages for the SPA)', () => {
  it('CSP: self-only with the Cloudflare Insights beacon, blob:/data: images and no eval or wildcard anywhere', () => {
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['script-src']).toEqual(["'self'", 'https://static.cloudflareinsights.com']);
    expect(csp['connect-src']).toEqual(["'self'", 'https://cloudflareinsights.com']);
    expect(csp['img-src']).toEqual(["'self'", 'data:', 'blob:']);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'self'"]);
    expect(csp['form-action']).toEqual(["'self'"]);
    expect(all['Content-Security-Policy']).not.toMatch(/unsafe-eval|wasm-unsafe-eval|\*|http:/);
    expect(csp['script-src']).not.toContain("'unsafe-inline'"); // inline styles are tolerated (React style attributes); inline scripts are not
  });

  it('everything the app loads is covered: one module script, no inline script, no eval, no third-party origins', () => {
    const html = read('index.html');
    expect([...html.matchAll(/<script\b[^>]*>/g)].map(m => m[0])).toEqual(['<script type="module" src="/src/main.jsx">']);
    expect(html).not.toMatch(/<script[^>]*>[^<]+<\/script>/); // no inline script bodies
    expect(html).not.toMatch(/\son\w+\s*=/i);
    const hosts = new Set();
    const walk = dir => { for (const f of readdirSync(join(ROOT, dir))) {
      const rel = `${dir}/${f}`; const st = statSync(join(ROOT, rel));
      if (st.isDirectory()) walk(rel);
      else if (/\.(jsx?|css|html)$/.test(f)) {
        const text = readFileSync(join(ROOT, rel), 'utf8');
        for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1]);
        expect(text, rel).not.toMatch(/\beval\(|new Function\(|document\.write\(/);
      } } };
    walk('src');
    for (const h of hosts) expect(['l1.mbfdhub.com', 'www.w3.org', 'github.com', 'static.cloudflareinsights.com', 'cloudflareinsights.com'], `unexpected origin ${h}`).toContain(h);
    expect(html.match(/https?:\/\/[a-z0-9.-]+/gi) ?? []).toEqual(['https://l1.mbfdhub.com']); // canonical link only
  });

  it('Permissions-Policy grants the camera to this origin only and nothing else', () => {
    const pp = all['Permissions-Policy'];
    expect(pp).toMatch(/(^|,\s*)camera=\(self\)/);
    for (const feature of pp.split(',').map(s => s.trim())) {
      if (feature.startsWith('camera=')) continue;
      expect(feature, feature).toMatch(/^[a-z-]+=\(\)$/);
    }
    expect(pp).not.toMatch(/=\*|=\(\*\)/);
  });

  it('HSTS (>= 1 year, subdomains), nosniff, frame denial, strict referrer policy', () => {
    expect(all['Strict-Transport-Security']).toMatch(/max-age=(3[1-9]\d{6}|[4-9]\d{7}|\d{9,})/);
    expect(all['Strict-Transport-Security']).toContain('includeSubDomains');
    expect(all['X-Content-Type-Options']).toBe('nosniff');
    expect(all['X-Frame-Options']).toBe('DENY');
    expect(all['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });

  it('only static assets are cached immutably', () => {
    expect(Object.keys(headers).sort()).toEqual(['/*', '/assets/*', '/images/*']);
    expect(headers['/assets/*']['Cache-Control']).toMatch(/immutable/);
    expect(all['Cache-Control']).toBeUndefined();
  });
});

describe('worker/wrangler.toml', () => {
  const toml = read('worker/wrangler.toml');
  it('production and staging both pin Access auth, a real PUBLIC_ORIGIN and a non-placeholder staging AUD', () => {
    expect(toml).toMatch(/\[vars\][\s\S]*?ENVIRONMENT = "production"[\s\S]*?AUTH_MODE = "access"/);
    expect(toml).toMatch(/\[env\.staging\.vars\][\s\S]*?ENVIRONMENT = "staging"[\s\S]*?AUTH_MODE = "access"/);
    expect(toml).toMatch(/PUBLIC_ORIGIN = "https:\/\/l1\.mbfdhub\.com"/);
    expect(toml).toMatch(/PUBLIC_ORIGIN = "https:\/\/l1-staging\.mbfdhub\.com"/);
    expect(toml).toMatch(/\[env\.staging\.vars\][\s\S]*?ACCESS_AUD = "[0-9a-f]{64}"/);
  });
  it('routes are exactly the /api/* patterns on the two hostnames and the staging env has workers.dev disabled', () => {
    expect([...toml.matchAll(/pattern = "([^"]+)"/g)].map(m => m[1])).toEqual(['l1.mbfdhub.com/api/*', 'l1-staging.mbfdhub.com/api/*']);
    expect(toml).toMatch(/\[env\.staging\][\s\S]*?workers_dev = false/);
  });
  it('contains no secrets (only ids and public configuration)', () => {
    expect(toml).not.toMatch(/sk-[A-Za-z0-9]{10,}|secret\s*=|password|private key|token\s*=/i);
  });
});

describe('secrets in the working tree', () => {
  const PATTERNS = [/sk-(proj-)?[A-Za-z0-9_-]{24,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /gh[pousr]_[A-Za-z0-9]{30,}/, /xox[bpa]-[A-Za-z0-9-]{20,}/,
    /[0-9a-f]{32}\.access\b/, /CF-Access-Client-Secret:\s*[A-Za-z0-9]{20,}/i, /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/];
  const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', '.wrangler', 'test-results', 'playwright-report']);
  it('no key, token, private key or service-token pattern appears in tracked source, docs or deploy files', () => {
    const hits = [];
    const walk = dir => { for (const f of readdirSync(join(ROOT, dir))) {
      if (SKIP.has(f)) continue;
      const rel = dir ? `${dir}/${f}` : f; const st = statSync(join(ROOT, rel));
      if (st.isDirectory()) { walk(rel); continue; }
      if (st.size > 2_000_000 || /\.(webp|png|jpe?g|ico|lock|json)$/.test(f) && !/wrangler|env/.test(f)) continue;
      if (rel.startsWith('worker/test/security/') || rel.startsWith('processor/test/')) continue; // deliberately synthetic fixtures
      const text = readFileSync(join(ROOT, rel), 'utf8');
      for (const re of PATTERNS) if (re.test(text)) hits.push(`${rel}: ${re}`);
    } };
    walk('');
    expect(hits).toEqual([]);
  });
  it('processor/deploy/env.example holds no values', () => {
    const lines = read('processor/deploy/env.example').split('\n').filter(l => /^[A-Z0-9_]+=/.test(l));
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) {
      const [k, v] = l.split('=');
      if (/SECRET|KEY|TOKEN|ID$/.test(k)) expect(v.trim(), k).toBe('');
    }
  });
});
