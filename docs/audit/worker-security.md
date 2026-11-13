# Worker / API / security audit — l1-compartment-builder @ c9e0d0e

Audit part: worker-security. Audit-only: no existing file was modified. Deliverables are this report and
`worker/audit.test.js`. AUDIT.md was treated as a claim, not as proof.

Evidence labels: **SOURCE VERIFIED** (read in code at c9e0d0e), **TEST VERIFIED** (reproduced by
`worker/audit.test.js` against `worker/index.js` using fake KV/AI bindings; no network was used),
**INFERRED** (reasoned from platform behaviour or docs; not executed).

Reproduction command for everything: `npx vitest run worker/audit.test.js`
(`test.fails` = the test asserts the *correct* behaviour and is expected to fail today; when a fix lands vitest
reports "Expect test to fail" and the `.fails` marker must be removed, turning it into a permanent regression test).

## Limits of this audit

- Tests run in Node with fake bindings, not workerd/miniflare, so platform CPU/memory limits, real KV
  consistency and real request-size behaviour are modelled or inferred, not measured.
- The production Worker, l1.mbfdhub.com, Cloudflare and OpenAI were never contacted. Branch protection,
  Cloudflare dashboard settings (WAF rules, Access, KV plan, Worker plan) cannot be seen from the repo.
- `npm` 9.2 on this worker crashed (`Cannot read properties of null (reading 'edgesOut')`) when resolving a trial
  upgrade in a scratch directory, so upgrade targets below come from registry metadata (`npm view`) and the
  `npm audit` advisory ranges, **not from a resolved + re-audited tree**. Re-verify with `aiw_run` before merging.

Note: AUDIT.md claims "eliminated all reported npm audit findings"; that is no longer true at c9e0d0e (WS-17), and its
"sanitized server errors"/"hourly per-client limit" claims hold only in the narrow senses shown in WS-21 and WS-03.

## Command results (this run)

| Command | Result |
|---|---|
| `npm ci` | OK (reported the 16 vulnerabilities) |
| `npm run lint` | exit 0 |
| `npx vitest run` | exit 0 — 3 files, 58 passed + 25 expected-fail (83 tests) |
| `npm audit --audit-level=low` | **exit 1** — 16 vulnerabilities (9 moderate, 7 high); expected, detail in WS-17 |

## Summary table

| ID | Title | Severity | Evidence | Test |
|---|---|---|---|---|
| WS-01 | Authentication is spoofable Origin gating; forged-Origin PUT overwrites production state | High | TEST VERIFIED | fails |
| WS-02 | `GET /state` and `/images` are fully anonymous | Medium | TEST VERIFIED | fails |
| WS-03 | AI rate limit is a racy per-IP KV read-modify-write (parallel, eventual consistency, window boundary) | High | TEST VERIFIED | fails ×3 |
| WS-04 | No global/daily/monthly spend cap; per-IP limit is the only control | High | TEST VERIFIED | fails |
| WS-05 | Shared `unknown` IP bucket; station NAT shares one 5/h budget | Low | TEST VERIFIED | fails + doc |
| WS-06 | KV 1 write/sec/key limit and KV errors are unhandled (thrown, not JSON); counter burns on AI failure | Medium | TEST VERIFIED | fails ×2 + doc |
| WS-07 | Body size enforced only after the whole body is buffered when Content-Length is absent | Medium | TEST VERIFIED | fails (+2 non-repros) |
| WS-08 | 12 MB `PUT /images` parse + validate cost / memory multiplier | Low | TEST VERIFIED (Node) / INFERRED (workerd) | measurement |
| WS-09 | Generator schema accepts `{}`, any `compId`, client-authored spec/prompt text, and `null` → 500 | Medium | TEST VERIFIED | fails ×3 |
| WS-10 | Generator accepts no reference photos (confirmed; extras silently ignored) | Info | TEST VERIFIED | doc |
| WS-11 | Document validation gaps: unknown fields/compartments persisted, base64 not validated, dangling featured uid, wipe | Medium | TEST VERIFIED | fails ×5 |
| WS-12 | Any `*.l1-compartment-builder.pages.dev` preview (and localhost:4173) can mutate production KV | Medium | TEST VERIFIED | fails + non-repro |
| WS-13 | No 405/Allow, 404 not JSON, OPTIONS answered for any path, no preflight cache | Low | TEST VERIFIED | fails ×3 |
| WS-14 | Worker responses lack CSP / defence-in-depth headers | Low | TEST VERIFIED | fails |
| WS-15 | `camera=()` blocks getUserMedia; static header review (HSTS, connect-src) | Info | SOURCE VERIFIED + docs | guard |
| WS-16 | Unauthenticated 5 s polling of two KV reads per client → quota/availability exposure | Medium | INFERRED | — |
| WS-17 | `npm audit` fails (16 vulns); all dev/build-time, none in shipped runtime | Medium | SOURCE VERIFIED | — |
| WS-18 | `account_id` + KV namespace id committed; secret scan of full history clean | Low | SOURCE VERIFIED | — |
| WS-19 | `compatibility_date = 2024-01-01` is ~3 years stale | Low | SOURCE VERIFIED / INFERRED effect | — |
| WS-20 | CI: red audit gate, tag-pinned actions, no Worker deploy provenance, no branch-protection evidence | Medium | SOURCE VERIFIED | — |
| WS-21 | Error-message leakage on the AI path | Info (does not reproduce) | TEST VERIFIED | pass |
| WS-22 | No durable jobs, idempotency, retries, progress or resume for generation | Medium (High when paid API is exposed) | TEST VERIFIED + SOURCE | fails |
| WS-23 | Worker tests use an atomic, zero-latency fake KV; nothing runs under workerd | Low | SOURCE VERIFIED | — |

Counts: **Critical 0 · High 3 · Medium 10 · Low 7 · Info 3** (23 findings; 25 expected-fail reproduction tests).

---

## WS-01 — Authentication is Origin gating only (High)

- Location: `worker/index.js:150-155` (check), `:176-195` (state PUT), `:211-229` (images PUT), `:233` (generate).
- Evidence: TEST VERIFIED.
- Logic: `origin = Origin ?? ''`. Rejected (403) if `origin` is non-empty and not allow-listed, **or** if the method is
  PUT/POST/PATCH/DELETE and the origin is not allow-listed. Per method with **no** Origin header:
  GET → 200 (anonymous), OPTIONS → 204, HEAD → 404 (no handler), PUT/POST/PATCH/DELETE → 403.
- Why High: Origin is only a browser-enforced header. `curl -X PUT -H 'Origin: https://l1.mbfdhub.com' …` is
  accepted and overwrites the one shared plan for every station and every operator. The repo is public, the Worker URL
  is hard-coded in `src/App.jsx:10`, and the schema is in `validateStatePayload`, so a valid body is trivial to craft.
  It also lets anyone trigger the AI path (cost). No per-user attribution exists, so a bad write cannot be traced.
- Reproduction: `WS-01 a non-browser PUT with a forged Origin header and no credential is rejected` — observed
  status 200 and KV written; test asserts 401/403. `WS-01 per-method behaviour with no Origin header` documents the
  matrix. `WS-01 browser cross-site mutation from a disallowed Origin IS blocked` **passes**: the Origin check does stop
  drive-by writes from other websites in a real browser. It is CSRF protection, not authentication.
- Root cause: identity is inferred from a client-asserted header.
- Correction (narrow): require a verified identity on every non-OPTIONS request (see section (a)); keep the Origin
  check as defence in depth; add the auth header to `Access-Control-Allow-Headers` if a header (not cookie) is used.
- Regression test to keep: the `WS-01` `.fails` test, un-failed, plus the cross-site 403 test.

## WS-02 — Anonymous reads of all state and images (Medium)

- Location: `worker/index.js:165-174`, `:200-209`. Evidence: TEST VERIFIED.
- Why Medium: apparatus layout, inventory and uploaded photos of MBFD equipment are readable by anyone with the URL,
  with or without an Origin header. Not personal data and not obviously sensitive, but it is an operational record of a
  fire apparatus, and AUDIT.md itself says confidentiality needs Access. Also feeds WS-16.
- Reproduction: `WS-02 GET /state without Origin or credential is rejected` and the `/images` twin — both observe 200.
- Root cause: GET is exempt from the mutation check and there is no auth. Correction: same identity requirement as
  WS-01, viewer role sufficient. Regression: the two tests above.

## WS-03 — AI rate limiter is bypassable (High)

- Location: `worker/index.js:255-259`. Evidence: TEST VERIFIED.
- Defect: `get` → compare → `put(used+1)` is not atomic, KV is eventually consistent (writes can take up to ~60 s to be
  seen in other locations) and the window is fixed per clock hour.
- Reproductions (all with the fake AI counting FLUX calls):
  - `WS-03 concurrent requests cannot exceed the hourly AI limit` — 20 parallel requests, 50 ms read latency:
    **20 FLUX calls** (limit 5). Note: with a fake KV whose reads observe writes made while the read is in flight, this
    does *not* reproduce — the first version of this test did not, which is why the fake snapshots the value at call
    time. Real KV reads have tens of ms of latency, so the race is realistic.
  - `…KV eventual consistency…` — 20 sequential requests with a 60 ms write-propagation delay: **20 calls**.
  - `…fixed window: no more than 5 generations in any rolling hour` — 5 requests at 59:59, 5 at 00:01: **10 calls in 2 s**.
- Root cause: KV is not a counter. Correction: move the counter to a Durable Object (single-threaded, strongly
  consistent) using a sliding window or token bucket; reserve before the model call (see (b)). Do **not** try to fix
  with KV tricks. Regression: the three `.fails` tests, un-failed.

## WS-04 — No global spend cap (High)

- Location: `worker/index.js:255-259` (only per-IP). Evidence: TEST VERIFIED.
- Why High: with a paid image API, cost = calls × price. Per-IP limits do not bound total spend: 60 addresses × 5 =
  300 FLUX calls in the test, IPv6 /64 rotation or a VPN pool scales this arbitrarily, and the endpoint is
  anonymous (WS-01). Today the bill is Workers AI usage; at the planned OpenAI move it is real money per call.
- Reproduction: `WS-04 there is a global daily budget independent of client IP` — 300 calls vs asserted budget 50
  (placeholder number). Correction: global daily and monthly counters in the same Durable Object plus a provider-side
  hard budget (section (b)). Regression: that test with the real configured budget.

## WS-05 — `unknown` bucket and shared station IPs (Low)

- Location: `worker/index.js:255`. Evidence: TEST VERIFIED.
- `CF-Connecting-IP` is always set by Cloudflare in production, so the `unknown` fallback is only reachable in tests /
  local dev, where every caller then shares one bucket (and a missing header is served rather than refused).
  Conversely, firefighters on one station/city NAT share a single 5/hour budget (`WS-05 all callers behind one NAT…`
  documents 5×200 then 429). Per-user limits (after WS-01 auth) fix both; until then fail closed on a missing header.
- Reproduction: `WS-05 a request with no CF-Connecting-IP is not served from a shared "unknown" bucket` (fails: 200).

## WS-06 — KV write limit and storage errors unhandled (Medium)

- Location: `worker/index.js:191`, `:225` (puts with no try/catch), `:166`, `:201` (gets), `:259`. Evidence: TEST VERIFIED.
- KV allows ~1 write/second per key. Every client debounces `PUT /state` by 300 ms (`src/App.jsx:487-499`) to the same
  key `allocations`; two operators editing within a second will hit KV 429. The state/images handlers have no
  try/catch, so the exception escapes `fetch()` (platform error 1101, non-JSON, no CORS headers → the browser reports an
  opaque network error rather than a status). The AI route's `put` is inside its try/catch (generic 500).
- Reproductions: `WS-06 two PUT /state within one second degrade to a controlled JSON error…` (fetch rejects with the KV
  error) and `WS-06 a KV read failure on GET /state returns a JSON 5xx` (rejects). Doc test
  `WS-06 a failed AI call still consumes quota` shows the counter is written before the model runs, so upstream
  failures burn the user's quota (Info-level side issue).
- Correction: wrap storage calls, return JSON 503/429 with `Retry-After` and CORS headers; the client should retry with
  backoff. Longer term the single-document last-write-wins design (acknowledged in AUDIT.md) belongs in a Durable Object
  or D1 with a revision check. Regression: the two `.fails` tests.

## WS-07 — Body-size enforcement (Medium)

- Location: `worker/index.js:131-141`. Evidence: TEST VERIFIED.
- `Content-Length` is only a hint (`Number(header || 0)`); the real check runs after `await request.text()` has
  buffered everything, then `TextEncoder().encode(text)` makes a second copy. Without Content-Length (chunked), a body
  of any size up to the platform request limit is fully read into memory before the 413.
- Reproduction: `WS-07 an over-limit chunked body (no Content-Length) is abandoned after the limit` — 1 MB limit, a
  20 MB stream: **all 20 MB pulled** before 413 (test requires ≤ 4 MB).
- Does **not** reproduce: a falsified small Content-Length (`WS-07 a falsified small Content-Length…`) still yields 413;
  multi-byte payloads are measured in bytes (`…measured in bytes, not characters`).
- Correction: read the stream with a reader and abort/cancel once `maxBytes` is exceeded; reject non-JSON
  Content-Type. Regression: the `.fails` test and the two non-repro tests.

## WS-08 — CPU/memory for 12 MB image bodies (Low)

- Location: `worker/index.js:8`, `:131-141`, `:96-129`. Evidence: TEST VERIFIED in Node, INFERRED for workerd.
- Measurement (`WS-08 …CPU measurement`): a ~11.8 MB `PUT /images` (2×4.9 MB + 2 MB data URLs) took **111 ms wall in
  Node** end to end (parse + regex + stringify + fake put). The regex `^data:image/...;base64,[a-z0-9+/=]+$` is linear
  and was not a ReDoS. Memory: body string (~12 MB, UTF-16 ≈ up to 24 MB) + encoded copy (12 MB) + parsed object +
  re-stringified copy ≈ 4–6× the payload, comfortably inside 128 MB but not free; concurrent large PUTs share one isolate.
  Workers CPU limits depend on plan (INFERRED: 10 ms free tier is exceeded by this request; paid default is far higher).
  Plan unknown from the repo.
- Correction: depends on WS-01 (authenticated writers only) and WS-07 (streamed limit); move images out of one 12 MB KV
  JSON document into R2 objects with per-image size caps (also fixes the 5 s full-document polling, WS-16).

## WS-09 — AI request schema too permissive (Medium)

- Location: `worker/index.js:236-253`. Evidence: TEST VERIFIED.
- `compId = ''` / `compartmentSpec = ''` defaults mean **`{}` passes validation and runs both models**; any `compId` string
  is accepted; the compartment description (≤2000 chars) and `userText` (≤1000 chars, labelled "high priority — follow
  exactly") are client-authored free text interpolated into the Llama prompt, so the endpoint is a general
  text-to-image proxy with MBFD framing, and prompt injection of the prompt engineer is possible (output is only an
  image, but content is uncontrolled and is later stored into shared KV by the client). A literal JSON `null` body
  destructures to a TypeError → 500 instead of 400.
- Reproductions (all `.fails`): empty object → 200 with 2 model calls; unknown `compId` + arbitrary spec → 200; `null`
  → 500. Also the response returns the engineered `prompt` to the client (minor).
- Correction: require `compId` from the 11 known ids, build the spec server-side, cap `userText` and strip/escape it,
  ignore client `compartmentSpec`, reject unknown fields, return 400 for non-objects. Regression: the three tests.

## WS-10 — Generator accepts no reference photos (Info)

- Evidence: TEST VERIFIED (`WS-10 the generator accepts no reference photos…`).
- Request schema is `{compId, compartmentSpec, tools[{name,qty,dims,visual}], userText}`. Extra fields
  (`referenceImages`, `images`) are **silently ignored** (HTTP 200); the FLUX multipart form carries only
  `prompt/width/height/steps`. When reference photos are added, unknown-field rejection (WS-09/11) and image validation
  (type by magic bytes, size/count, re-encode, EXIF/GPS strip, dimension cap) must come with them, and the 200 KB
  `MAX_AI_BYTES` (`:9`) must change to a streamed multipart limit.

## WS-11 — Persisted-document validation gaps (Medium)

- Location: `worker/index.js:27-94`, `:96-129`, `:189-191`, `:223-225`. Evidence: TEST VERIFIED.
- `parsed` is stored whole after validation, so **any unknown field survives**: 500 KB `junk` is stored and served to
  every client (`…unknown top-level fields are not persisted…`). Compartment ids are arbitrary strings (unknown id
  accepted); data URLs are matched by regex only — `data:image/png;base64,A` (invalid base64, not an image) is accepted;
  `featuredImages.uid` may reference a non-existent upload; an `allocations: {}` PUT replaces a populated plan
  (client always sends all 11 ids). Counts of keys in `allocations`, `customQtys`, `customDimensions` are unbounded
  except by body size. Compared with what the client sends (`src/App.jsx:489`, `:650`) the schema is *looser* than needed
  rather than too strict, so tightening is safe for the current client.
- Correction: build a new object from whitelisted fields; allow-list compartment ids; validate base64 length/charset
  (and PNG/JPEG/WebP magic bytes); cross-check featured uids; reject an `allocations` missing known ids or a payload that
  drops ≥N% content without an explicit flag; add a base revision (`If-Match`) so stale clients cannot clobber.
  Regression: the five `.fails` tests.

## WS-12 — Preview/localhost origins may write production KV (Medium)

- Location: `worker/index.js:1-6`, `:14-16`. Evidence: TEST VERIFIED.
- The regex `^https://[a-z0-9-]+\.l1-compartment-builder\.pages\.dev$` is correctly anchored (look-alikes, nested
  subdomains, `http://`, `null` all rejected — `WS-12 look-alike origins are rejected` passes). The issue is policy: every
  preview/branch deployment of the Pages project is a trusted origin with write access to the **single production
  namespace** `L1_STATE`. Anyone who can push a branch/preview (or an unreviewed PR preview, if git integration builds
  forks) can mutate production data and spend AI budget. `http://127.0.0.1:4173`/`localhost:4173` are also trusted in
  production, which any local process on a user's machine can use from a browser tab.
- Correction: previews and local dev use a separate Worker/KV (`wrangler.toml` `[env.preview]`), production allows only
  `https://l1.mbfdhub.com`; with Access (section (a)) origin becomes secondary. Regression: `WS-12 a Pages preview
  deployment origin cannot mutate production KV` (`.fails`) and the look-alike test.

## WS-13 — Routing, methods, preflight (Low)

- Location: `worker/index.js:157-159`, `:362`. Evidence: TEST VERIFIED.
- `POST /state` → 404 (should be 405 + `Allow`); 404 body is JSON but sent without `Content-Type` (served as
  `text/plain`); `OPTIONS` is answered 204 for **any** path and without validating the requested method/headers; no
  `Access-Control-Max-Age` so every PUT pays an extra preflight; `Allow-Headers: Content-Type` must be extended for any
  auth header. No leakage found otherwise.
- Reproductions: three `.fails` tests. Correction: small router table with per-route method sets.

## WS-14 — Worker response headers (Low)

- Location: `worker/index.js:14-25`. Evidence: TEST VERIFIED.
- Present: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`. Missing:
  `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Cross-Origin-Resource-Policy`, and
  `Vary: Origin` on non-allowed responses (harmless because of `no-store`). Success responses that bypass `jsonResponse`
  (`:167`, `:192`, `:349`) are fine. Strict-Transport-Security on the Worker is a Cloudflare-zone setting (INFERRED:
  workers.dev is HTTPS-only). Low impact since responses are JSON; cheap hardening.

## WS-15 — `public/_headers`: Permissions-Policy, CSP, HSTS (Info)

- Location: `public/_headers:2-7`. Evidence: SOURCE VERIFIED + MDN.
- **camera=()**: MDN (Permissions-Policy `camera`): "controls whether the current document is allowed to use video
  input devices"; where blocked, `MediaDevices.getUserMedia()` rejects with `NotAllowedError`. MDN says nothing about
  `<input type="file" accept="image/*" capture>`. **INFERRED (not tested in a browser):** that input hands the request to
  the browser/OS file or camera picker, which is not a Permissions-Policy-gated powerful feature, so the existing
  `<input type="file" accept="image/*">` (`src/App.jsx:2013`, no `capture` attribute) is unaffected today and adding
  `capture` would also work. Verify on a real iOS Safari and Android Chrome device.
- **What must change for in-app camera capture** (`getUserMedia`): `Permissions-Policy: camera=(self), microphone=(),…`
  (never `*`); HTTPS is already satisfied; use `<video playsinline muted autoplay>` (iOS Safari); draw frames to a canvas and
  `toBlob`. A `MediaStream` assigned to `srcObject` needs no CSP change; `img-src … blob:` already allows previews. Only if
  the code ever uses `<video src="blob:…">` add `media-src 'self' blob:` (it falls back to `default-src 'self'`, which blocks
  blob:). Because `frame-ancestors 'none'`, no iframe delegation is needed.
- CSP review: no `unsafe-eval`, no wildcards, `script-src 'self' https://static.cloudflareinsights.com`,
  `connect-src 'self' <workers.dev Worker> https://cloudflareinsights.com` is exactly what the client and RUM beacon use
  (guard test `WS-15 CSP has no unsafe-eval…`). `style-src 'unsafe-inline'` is the one weakness (React inline styles;
  Low). Missing but optional: `worker-src 'none'`, `manifest-src`, `upgrade-insecure-requests`, COOP. When the API moves
  same-origin (section (a)) drop the workers.dev entry from connect-src. The browser must **never** be given an OpenAI
  origin in `connect-src` — generation stays server-side. Preview deployments inherit the same `_headers`.
- HSTS `max-age=31536000; includeSubDomains` (no `preload`) is correct for the host; `includeSubDomains` covers only
  subdomains of `l1.mbfdhub.com`. Fine.

## WS-16 — Anonymous polling and quota exposure (Medium, INFERRED)

- Location: `src/App.jsx:506-509`, `:586`; `worker/index.js:166`, `:201`. Evidence: INFERRED (plan/limits unknown).
- Each open client polls **both** `/state` and `/images` every 5 s: 2 × 17 280 = **~34 560 KV reads/day per open tab**,
  and `/images` can be 12 MB each time, uncached (`no-store`, no ETag). Cloudflare's free-tier daily KV-read and
  Worker-request limits are of the order of 100 000 (verify the current figures/plan); a handful of tabs, or one loop
  against the anonymous endpoints (WS-02), can exhaust them and take the app down for everyone, or run up usage on a paid plan.
- Correction: ETag/`If-None-Match` on `_serverTs` returning 304, separate lightweight "version" endpoint, longer/visibility-
  aware polling, edge Cache API, a Cloudflare WAF rate-limiting rule on the Worker route, auth (WS-01/02).

## WS-17 — Dependencies: `npm audit` fails (Medium; no runtime exposure)

- Evidence: SOURCE VERIFIED (`npm audit` output; versions from lockfile). Exit code 1: 16 vulnerabilities (9 moderate, 7 high).
- **Exposure classification.** Shipped to users: `react`, `react-dom`, `lucide-react`, `write-excel-file` — none are flagged. The
  Worker runs on Cloudflare's runtime, not on these packages. Every flagged package is build/test/deploy tooling. They
  matter for (1) CI, which runs them over PR code and **fails today at the audit step**, (2) developer machines/the
  workers running `npm ci`, `vite dev`, `wrangler deploy`.

| Package (installed → flagged range) | Severity | Pulled in by | Exposure |
|---|---|---|---|
| vite 8.1.5 (8.0.0–8.1.5) | high | direct devDep | dev server/`vite preview` advisories (cross-origin script execution via custom middleware, `server.fs.allow` bypass, launch-editor on Windows). Not in production output; relevant when running `npm run dev` on a shared network |
| undici 7.28.0 / 7.29.0 (7.0.0–7.30.0, ~25 advisories) | high | wrangler → miniflare; jsdom via vitest | dev-only: wrangler CLI/miniflare HTTP client, vitest jsdom (unused, env is `node`) |
| sharp 0.35.2 (≤0.35.5-rc.1) | high | miniflare | dev-only local images simulation |
| miniflare 4.20260722.0, wrangler 4.114.0 | high / moderate | direct (wrangler) | deploy/dev tooling only |
| nanoid 3.3.16 (<3.3.18), source-map-js 1.2.1 (≤1.2.1) | high | postcss (build), css-tree/magicast | build-time only; nanoid issue needs a custom `size:0` generator, source-map-js needs hostile source maps |
| brace-expansion 5.0.8 (4.0.0–5.0.11), minimatch 10.2.6 (≤11.0.0) | high / moderate | eslint | lint-time glob DoS; patterns come from repo config, not attackers |
| postcss-selector-parser 6.1.2 (≤6.1.4) | moderate | tailwindcss | build-time CSS parsing DoS on repo CSS |
| @vitest/mocker, vitest, @vitest/coverage-v8 4.1.10 (≤4.1.11) | moderate | direct | test-time: mock-redirect file read / code injection needs untrusted test code or vitest UI/server exposure |
| eslint 10.8.0, @eslint/js, @eslint/config-array | moderate | direct | only via minimatch |

- **Minimal safe upgrade plan** (do not apply here; targets are from registry metadata, see limits above):
  1. `vite` → `^8.3.8` (fixed since 8.1.6; 8.1.7 is the smallest in the 8.1 line; engines `^20.19.0 || >=22.12.0`, satisfied by Node 22).
  2. `vitest` and `@vitest/coverage-v8` → `^4.1.12` (in range; bumps `@vitest/mocker` to 4.1.12). Keep v4; v5.1.0 exists but is a major.
  3. `wrangler` → `^4.161.0` (current `latest`). Its `miniflare` is `5.20261110.2-beta` with `undici 7.30.1` and `sharp 0.35.5`, which
     clear the undici/sharp/miniflare advisories. Note it is a **pre-release transitive dependency**; wrangler 4.120–4.160 still
     pull miniflare 5 alphas with `undici 7.29.0`/`sharp 0.35.2` (checked 5.20260908.0-alpha), i.e. still vulnerable, and
     miniflare's stable `latest` (4.20260730.0) still pins `undici 7.28.0`. Alternative if the beta is unacceptable:
     keep the current wrangler and add `overrides` `{"undici":"^7.30.2","sharp":"^0.35.5"}` after a smoke deploy dry-run
     (`wrangler deploy --dry-run`). Run the dry run on a worker.
  4. Lockfile-only refreshes inside existing ranges (`npm update nanoid source-map-js postcss postcss-selector-parser brace-expansion`):
     nanoid ≥3.3.20, source-map-js 1.2.2, postcss-selector-parser 6.1.6, brace-expansion 5.0.13, postcss latest.
  5. `minimatch`: `npm audit fix --force` proposes **downgrading eslint to 9.39.5** (major, breaking) — reject it. eslint 10.14.0's
     `minimatch ^10.2.6` cannot reach the fixed 11.x line. Options: (a) `overrides: {"minimatch": "^11.0.8"}` (Node `20 || >=22`
     OK; must be validated with `npm run lint`) or (b) accept as dev-only and allow-list the advisory with a dated expiry. Also optionally eslint → `^10.14.0`.
  6. After each step: `npm ci && npm audit --audit-level=low && npm run lint && npx vitest run && npm run build` via `aiw_run`.
  7. Add Dependabot/Renovate (none exists: `.github` contains only `workflows/ci.yml`) and split CI so `npm audit --omit=dev
     --audit-level=high` gates merges while full `npm audit` is reported (currently one dev-only advisory can block unrelated work).

## WS-18 — Committed identifiers and secret scan (Low)

- Location: `worker/wrangler.toml:4` (`account_id`), `:8` (KV namespace `id`). Evidence: SOURCE VERIFIED.
- Full-history scan: `git log --all` has 3 commits (c9e0d0e, ff0154e, beb5e34). Patterns searched across every commit's tree:
  `sk-`, `sk-proj-`, `cfut_`, `github_pat_`, `ghp_`/`gho_`, `AKIA…`, `-----BEGIN … PRIVATE`, `Bearer <20+ chars>`, `xox[bp]-`,
  Google `AIza…`, `CLOUDFLARE_API_TOKEN=<value>`. **Result: no matches.** (Keyword hits for "token" are `max_tokens` in
  `worker/index.js` at all three commits and the README note "Set `CLOUDFLARE_API_TOKEN` … without committing it" at c9e0d0e
  and ff0154e.) No `.env`, `.dev.vars`, `.wrangler/` state, key or credential file was ever committed (`.gitignore` excludes
  `.wrangler/` but not `.env`/`.dev.vars` — add both). Only commit SHA + path + type would have been reported; none exist.
  Caveat: the scan covers reachable refs/objects in this clone; it cannot see GitHub-side deleted PRs/forks.
- Realistic risk: a Cloudflare account id and KV namespace id are identifiers, not credentials. They do not grant access
  without an API token or the Worker binding, but they aid targeting (account enumeration, a hint for token scoping). With
  anonymous endpoints (WS-01/02) the identifiers are not the weak point. Prefer an environment variable/`CLOUDFLARE_ACCOUNT_ID`
  in CI and keep the namespace id only if needed; do not rotate unless a token is suspected. The workers.dev subdomain is
  also public in `src/App.jsx:10`.
- Add `.env*`, `.dev.vars*` to `.gitignore` and a secret scanner (gitleaks/GitHub push protection) before OpenAI keys
  exist. The OpenAI key must only ever be a Worker secret (`wrangler secret put`), never in `[vars]`.

## WS-19 — `compatibility_date = "2024-01-01"` (Low)

- Location: `worker/wrangler.toml:3`. Evidence: SOURCE VERIFIED; effect INFERRED.
- The date pins the runtime's behaviour to its state on 2024-01-01; every later default-on compatibility flag
  (Fetch/streams/Request-Response semantics, security and spec-conformance changes) is not applied until the date is bumped.
  The Worker uses `Request`, `FormData`, `Response.body`, `btoa`, `TextEncoder`, `crypto` only, so breakage risk is low, but a
  new-API dependency (WebSocket/DO, `nodejs_compat`, JWT verification with `crypto.subtle` + JWKS fetch, R2) should be built
  and tested against the date the repo is deployed with. Recommendation: bump to a recent date in the same PR that adds the DO,
  test under miniflare/workerd (WS-23), enable `[observability]`, and set `workers_dev`/routes explicitly.

## WS-20 — CI and release provenance (Medium)

- Location: `.github/workflows/ci.yml:16,18,33` (actions by tag), `:25` (audit step), `:8-9` (permissions), `package.json`
  (`deploy:worker`, `deploy:pages`). Evidence: SOURCE VERIFIED.
- Good: `permissions: contents: read`; `timeout-minutes`; no secrets; `pull_request` (not `pull_request_target`).
- Gaps: (1) `actions/checkout@v4`, `setup-node@v4`, `upload-artifact@v4` pinned to mutable tags, not commit SHAs; (2) the audit
  step runs `npm audit --audit-level=low` on the **full** tree and currently exits 1, so CI is red at c9e0d0e on the step
  before lint/tests (everything after it never runs in that job); (3) no `concurrency` group; (4) no Worker deploy workflow:
  deploys are manual from a developer machine with `CLOUDFLARE_API_TOKEN` (README) and deploy the *working tree*, so the
  running Worker has no commit provenance (the SPA exposes `/version.json`; the Worker has no equivalent). Add a
  `GET /version` returning `VITE_BUILD_SHA`-style var injected by `wrangler deploy --var`, or deploy from CI on tag/main with
  an environment requiring approval; (5) nothing in the repo shows branch protection, required checks or CODEOWNERS (cannot be
  verified from files — check GitHub settings: require PR + the `verify` check, no force-push, and a protected `production`
  environment for deploys); (6) no Dependabot, no secret scanning config, no SBOM/provenance attestation; (7) the repo is
  public: fork PRs run this workflow with read-only token — acceptable — but keep it that way (never add secrets to this job).

## WS-21 — Error leakage (Info, does not reproduce)

- Evidence: TEST VERIFIED (`WS-21 upstream error text is not leaked…`). With the AI binding throwing a message containing
  an "account" string, the client receives only `{"error":"AI generation failed"}`; 400/413 bodies are fixed strings;
  validation errors reveal only the schema field category. The only leakage path is the *unhandled* KV exception on
  state/images routes (WS-06), which is a platform error page, not repo data. Keep this test when adding the OpenAI path
  (never echo provider errors, request ids with keys, or the engineered prompt).

## WS-22 — No durable generation jobs (Medium now; High once a paid API is exposed)

- Location: `worker/index.js:233-359`. Evidence: SOURCE VERIFIED + TEST VERIFIED.
- Generation is one synchronous request that runs a Llama call then a FLUX call and returns a base64 PNG in the response.
  Consequences: a client disconnect/timeout still spends but loses the result; the client's natural retry spends again
  (`WS-22 a retried request with the same Idempotency-Key does not spend twice`: 2 FLUX calls, expected 1); no job id,
  progress, resume, cancel, or cost record; no `waitUntil`/Queue; result is delivered into the client's local state and later
  PUT to KV as a 5 MB data URL (WS-08). An image-edit call with reference photos is slower and costlier, so the failure
  modes get worse. Correction: see section (b). Regression: that test.

## WS-23 — Test infrastructure is not production-like (Low)

- Evidence: SOURCE VERIFIED. `worker/index.test.js` uses an atomic, zero-latency Map KV and a perfect AI stub
  (`makeEnv`, lines 9-26). It therefore cannot detect WS-03/06/07; even this audit's first fake (delay *before* the read)
  failed to reproduce WS-03 until reads were made to snapshot at call time. Nothing runs under workerd
  (`@cloudflare/vitest-pool-workers` or miniflare). Add: a latency/consistency-simulating KV fake (as in
  `audit.test.js`), a Durable-Object-backed integration test under workerd, provider contract tests with recorded OpenAI
  responses, and a CI check that fails when an expected-fail audit test starts passing without being un-failed.

---

## (a) Recommended auth model for operators

**Recommendation: Cloudflare Access in front of the whole app, with the Worker validating the Access JWT itself.**

- Serve the Worker same-origin: route `l1.mbfdhub.com/api/*` to the Worker (Pages stays on the same hostname), disable the
  public workers.dev URL. One Access application on `l1.mbfdhub.com` then protects both the SPA and the API, the
  `CF_Authorization` cookie is first-party (no cross-site cookie/CORS-credential problems), and CORS can be dropped.
- Identity: Access policies against the department's IdP (Microsoft 365/Google; one-time-PIN as fallback) with MFA.
- **Validate at the Worker, do not trust the edge alone.** On every request verify `Cf-Access-Jwt-Assertion`: RS256 signature
  against the team JWKS (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, cached with key rotation), `iss` =
  team domain, `aud` = this application's AUD tag, `exp/nbf`. Without this, anything reaching the Worker by another route
  (workers.dev, a mis-scoped Access policy, a preview URL) is unauthenticated again — exactly today's situation.
- **Viewers vs editors:** two Access groups/policies. Both can `GET`. Mutations (`PUT /state`, `PUT /images`, `POST /generate`)
  require the `email`/group claim to be in an editors list (Access group via IdP groups, or a Worker secret/KV allow-list
  keyed on the JWT email). Generation additionally needs an editor and is budgeted per user. Store `updatedBy` and `updatedAt`
  on every write and in the cost ledger (attribution that does not exist today).
- Local development: a documented `wrangler dev` variable that injects a fixed fake identity, enabled only in the dev
  environment; production config must fail closed with no such switch. E2E tests use an Access service token or the same dev stub.
- **Alternatives considered:** (1) Shared passcode/PIN in the SPA — trivially leaked, no attribution, no revocation: rejected.
  (2) Per-operator bearer tokens/API keys issued by the Worker — workable but means building issuance, rotation, revocation and
  a login UI; keep only as Access service tokens for automation. (3) Self-hosted login (Auth0/Clerk/custom sessions) — more code
  and a second identity store; reasonable only if operators lack any IdP. (4) Access at the edge **without** JWT validation —
  cheaper but leaves the workers.dev bypass; rejected. (5) mTLS/client certs — poor fit for phones and shared station tablets.
  Cloudflare Access on the free plan is sufficient for small teams (verify current user limits).

## (b) Recommended paid-generation guardrails (before any OpenAI call is reachable)

Hard prerequisites (block release if absent): authenticated identity (WS-01) and an editor-only role.

1. **Provider-side hard cap**: dedicated OpenAI project with a hard monthly spend limit and alert thresholds (50/80/100 %), key stored
   only as a Worker secret, separate keys for production vs preview; spend caps stay in force even if the Worker is compromised.
2. **Server-side budget ledger in a Durable Object** (atomic): per-user hourly, global daily and global monthly caps in dollars (not
   just call counts); `reserve(estimated_max_cost)` before calling, `settle(actual)` after; kill switch (`AI_ENABLED`) and an automatic
   trip when the monthly cap reaches e.g. 80 %. Fail closed if the ledger is unreachable.
3. **Pin everything cost-relevant server-side**: model id, size, quality, `n=1`, max input images, max prompt length, timeout with
   `AbortController`; the client may choose only `compId`, tools and bounded text. Estimated per-call price lives in config and is
   re-checked against OpenAI's pricing page at release.
4. **Request schema**: known `compId`, server-built prompt/spec (WS-09), unknown fields rejected; reference photos: ≤ N files, ≤ M MB
   each, magic-byte verified JPEG/PNG/WebP, dimensions capped, re-encoded to strip EXIF/GPS, no filename/path passthrough; input photos
   and outputs stored in R2 with short retention, referenced by id (not base64 in KV).
5. **Durable jobs** (WS-22): `POST /api/generations` returns `202 {jobId}` immediately; a DO/Queue runs the provider call; states
   `queued → running → succeeded | failed | cancelled`; `GET /api/generations/{id}` for progress/result; `Idempotency-Key` required so retries
   return the existing job; at most one automatic retry, only for 5xx/timeouts, never for content-policy refusals, and a retried call
   never reserves budget twice; results survive client disconnects and device switches.
6. **Approval policy**: standard-quality renders for editors within budget; high-quality/multi-image requests or any request that would push
   the day past a threshold require a second approver (admin) or an explicit confirm step showing the estimated cost.
7. **Cost and audit logging**: one ledger row per attempt (job id, user, compId, model, size/quality, input count, estimated/actual cost, latency,
   outcome, provider request id) — never image bytes, prompts containing user free text beyond a hash/truncation, or the key. Daily digest to the
   admin; alert on anomalies (spikes, repeated failures, one user over 3× median).
8. **Edge protections**: WAF rate-limit rule on `/api/generations`, per-user concurrency of 1–2 running jobs, reject if a job for the same
   `(user, compId, input hash)` ran in the last minute unless forced.
9. **Safety**: constrain `userText` length, treat it as data (delimit, do not obey tool-like instructions), run provider moderation on the
   request, return generic errors (WS-21), keep browser `connect-src` limited to the app origin.
10. **Tests before launch**: provider contract tests with recorded responses, DO-concurrency tests under workerd proving the cap holds at
    N parallel requests, replay/idempotency tests, a kill-switch test, and un-failing WS-01/03/04/09/22.

## (c) Dependency upgrade plan

See WS-17 for the table and the numbered steps. Order: (1) vite ^8.3.8, vitest + coverage ^4.1.12, lockfile refresh of
nanoid/source-map-js/postcss/postcss-selector-parser/brace-expansion → verify `npm audit` leaves only wrangler chain and minimatch;
(2) wrangler ^4.161.0 (or overrides fallback) with `wrangler deploy --dry-run`; (3) decide minimatch override vs documented acceptance;
(4) split the CI audit gate (`--omit=dev --audit-level=high` blocking, full audit reported) and add Dependabot. Expected result: runtime
dependency surface unchanged (none flagged), full audit clean or with one documented dev-only exception. All verification must run on a
worker via `aiw_run` (the trial upgrade here could not be resolved with npm 9.2).

## Resolution (AI Compartment Studio, part E1)

The pre-Studio Worker (whole-document KV `PUT /state`, `PUT /images`, unauthenticated `POST /generate-image`) was replaced.
`worker/audit.test.js` and `tests/audit/sync-data.test.js` now assert the new contract; the `fails` markers for fixed
findings were removed.

| Finding | Status | How |
|---|---|---|
| WS-01 forged-Origin mutation | Fixed | every `/api` mutation needs a verified Cloudflare Access JWT (RS256/JWKS, `iss`, `aud`, `exp`/`nbf`) and a same-origin `Origin`; legacy `PUT`/`POST` answer `409 APP_UPDATED` and never write KV |
| WS-02 anonymous reads | Accepted by design | planner, gallery and published images stay publicly readable (docs §3); the two reproduction tests keep `test.fails` |
| WS-03/04/05/06 AI rate limit, spend cap, KV write limits | Superseded | `/generate-image` no longer calls any model or KV; spend is enforced server-side by the job ledger (part E2). Regression tests assert no AI call and no KV write |
| WS-07 body bounds | Fixed | `readJson`/`readBytes` abort at the limit; legacy writes do not read the body |
| WS-08 12 MB images PUT cost | Obsolete | the endpoint no longer parses bodies; legacy images migrate to R2 in bounded chunks (`/api/admin/migrate-legacy`) |
| WS-09/10/21/22 generator schema, references, leakage, idempotency | Superseded | constant `409` legacy answer; server-built scene specs and `Idempotency-Key` jobs live in the Studio job API (part E2) |
| WS-11 document validation | Superseded | no whole-document writes; planner ops are validated per op and applied with preconditions (`shared/planner.js`) |
| WS-12 Pages preview origins | Fixed | previews can read the 409 explanation but cannot write anything |
| WS-13 routing | Fixed | 405 + `Allow`, JSON 404, preflight only for real legacy paths with `Max-Age`; no CORS on `/api` |
| WS-14 CSP | Fixed | `default-src 'none'; frame-ancestors 'none'` on every Worker response |
| SD-01/14 lost updates, equal revisions | Fixed | `POST /api/planner/ops` with CAS on an integer revision (history primary key aborts a lost race) |
| SD-09/13 quantity and bundle integrity | Moved | enforced by the op engine (`shared/planner.js`), tested in `tests/shared` (part C) |
| SD-10/11/12/15 images/state validation | Superseded | legacy write API closed; migration skips unresolvable featured entries and reports them |
| SD-05 whole base64 document per change | Fixed | images are R2 objects served by URL (`/api/public/assets/:id/display`) |

Implementation decision: `OWNER_EMAILS` are implicit admins (otherwise nobody could run the first
`/api/admin/migrate-legacy`, which is what seeds `access.admins`).
