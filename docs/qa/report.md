# QA report — AI Compartment Studio (Ladder 1), independent adversarial pass

Author: Claude Sonnet 5.5 (part F, retry). Date: 2026-11-13. Branch `aiw/l1_compartment_builder-9-1112232618-518c`.
Synthetic data only; nothing contacted production, Cloudflare or OpenAI. Findings detail: `findings.md`; skips: `skips.md`;
screenshots (deviceScaleFactor 2): `screenshots/`.

## What was run

A **real local stack**, started and stopped only by Playwright `webServer` (no process was ever killed by name):

| Piece | How |
|---|---|
| Worker + D1 + R2 + KV | `wrangler dev --local` (`e2e/helpers/real-backend/start-worker.sh`: fresh `.wrangler/e2e`, `d1 migrations apply`, then dev with `ENVIRONMENT=development`, `AUTH_MODE=test`, `PUBLIC_ORIGIN` = the Vite origin) — port 8791 (8787 is the AIW status page on aiw-k8) |
| Browser app | Vite with a proxy to the Worker (`vite.studio.config.mjs` = app config + `changeOrigin:true`, finding Q-01) — port 5183 |
| OpenAI | `mock-openai.mjs` (node:http): valid 640×480 image in the requested format, usage `{input_tokens:50, output_tokens:50, input_tokens_details:{text_tokens:10,image_tokens:40}}` |
| Processor | the REAL `processor/src` (`createProcessor`, api-client, job-runner, openai-adapter, sharp) via `run-processor.mjs`: fetch wrapper adds `X-Test-Actor: service:qa-processor`, `L1_OPENAI_BASE` → mock, 1 s polling, a pause file to keep a job `queued` |
| Seed (`global-setup.mjs`) | synthetic v1 planner (every compartment: two assigned tools Alpha/Beta + one free tool Gamma) and a tiny images doc put into local KV with `wrangler kv key put --local`, `POST /api/admin/migrate-legacy` as admin until done, `ai.enabled=true` |
| Identities | signed-in projects send `X-Test-Actor: user:qa.admin@miamibeachfl.gov,admin` via `extraHTTPHeaders`; signed-out projects send none |

Projects (`playwright.studio.config.js`, `workers: 1`): `desktop` 1440×900, `phone` Pixel 5, `desktop-signed-out`, `phone-signed-out`.

## Test matrix and results

| Command | Result |
|---|---|
| `npm run lint` | clean |
| `npx vitest run` | 44 files, **925 passed**, 2 expected-fail (pre-existing `fails` markers), 0 failed |
| `npx playwright test --trace off` | **117 passed, 36 skipped, 0 failed** (every skip explained in `skips.md`; one flake noted there) |
| `npx playwright test -c playwright.studio.config.js --trace off` | **45 passed, 15 skipped, 0 failed** (60 test instances; skips = 9 phone core flows outside LS2/RS5 by design + 6 API probes on the phone project, which run once on desktop) |
| `test.fail()` backend findings | none needed (no backend/shared/security defect found) |

| Scenario (spec) | desktop | phone (Pixel 5) | signed-out (desktop + phone) |
|---|---|---|---|
| Core flow, all 11 ids (`core-flow.qa.js`) | CabRearZone, LS1–LS4, RS1–RS5, RR1: pass | LS2, RS5: pass (others skipped by design) | – |
| Upload compartment photo + tool photo (`setInputFiles`), `.heic` file shows "could not be converted" | pass | pass | – |
| Tool photo → already-assigned tool, planner allocations unchanged | pass | pass | – |
| Group photo → 2 assigned + 1 unassigned tool, exactly one new assignment, Alpha/Beta slots untouched | pass | pass | – |
| Mount linked to 2 tools; arrange zones (design saved, placements incl. the mount) | pass | pass | – |
| Fast Preview: job progress → version (draft, no parent) | pass | pass | – |
| Edit with instruction + markup → child version with `parentVersionId` = first; job parent matches | pass | pass | – |
| Compare two versions | pass | pass (slider) | – |
| Approve + set main; reload; second (anonymous) context shows it first, "Approved concept" | pass | pass | – |
| Inventory change → stale badge (`stale:true`, banner) | pass | pass | – |
| Publish anyway (409 `STALE_SOURCE` → acknowledgement), restore previous | pass | pass | – |
| Signed-out is read-only (no Studio/edit controls, 401 on 10 routes, public reads work) (`signed-out.qa.js`) | – | – | pass / pass |
| Daily budget 0 → budget message, no job created | pass | pass | – |
| AI disabled → message, generation refused | pass | pass | – |
| Cancel a queued job | pass | pass | – |
| Double-click Generate → exactly one job | pass | pass | – |
| Upload aborted mid-PUT → nothing committed/linked, retry → one asset, no links | pass | pass | – |
| Offline → online resumes the upload queue | pass | pass | – |
| Keyboard-only pass through all 7 steps; Escape closes, focus returns | pass | pass | – |
| 360 px: no horizontal overflow, targets ≥ 44 px, all steps + edit mode | pass | pass | – |
| axe: no serious/critical on all 7 steps + edit mode | pass | pass (after U-03 fix) | – |
| Regressions U-01, U-02 | pass | pass | – |
| Adversarial API probes (editor, `api-probes.qa.js`) | 6 pass | skipped (viewport independent) | – |

Screenshots (synthetic data, DSF 2, desktop + phone, `docs/qa/screenshots/{desktop,phone}-NN-*.png`): 01 compartment page, 02 capture review,
03 group-photo linking, 04 mount editor, 05 arrange, 06 generate, 07 job progress, 08 edit with markup, 09 review/compare, 10 published main
image, 11 stale badge (taken from the LS2 flow).

## Defects (details and repro in `findings.md`)

| Id | Severity | Summary | Status |
|---|---|---|---|
| U-01 | Medium | New mounts/link edits not visible in Arrange/Generate until the Studio was reopened | **Fixed** (`StudioShell.jsx`), regression test |
| U-02 | High (layout feature) | Arrange discarded zone picks made while the saved layout was loading | **Fixed** (`ArrangeStep.jsx`), regression test |
| U-03 | Medium | Admin button had no accessible name on phones (axe `button-name`, critical) | **Fixed** (`StudioShell.jsx`), axe regression on phone |
| Q-01 | Low | `vite.config.js` proxy `changeOrigin:false` → every browser mutation 403 against `wrangler dev` | Reported, owner A (QA uses its own Vite config) |
| Q-02 | Low | `eslint .` lints wrangler's generated `worker/.wrangler/tmp` | Reported, lead (teardown removes it) |
| Q-03 | Low | Port 8787 busy on aiw-k8 | Worked around (configurable ports) |
| Q-04 | Low | Default `playwright test` would pick up Studio specs | Fixed (`*.qa.js`) |
| Q-05 | Low | Flaky touch-target test sampled during the drawer transition | Reported, owner A |
| – | – | Backend / shared / security | none found; 6 adversarial probes pass |

Both UI fixes were verified by reverting `src/**`: the regression tests then fail (U-01 `a mount added…`, U-02 `Arrange keeps an early zone choice…`,
U-03 phone axe), and pass again with the fixes.

## Residual risks — read these

* **Real iOS Safari and real Android camera behaviour were NOT tested.** Everything ran in headless Chromium (desktop and Pixel 5
  emulation). `capture="environment"`, camera permission prompts, real HEIC/HEIF conversion (heic2any), EXIF orientation of real phone
  photos, WebKit touch/scroll/viewport quirks and the live-camera viewfinder are unverified. The `.heic` path was tested only with an
  undecodable file (the friendly failure), not with a real HEIC photo. The production CSP (`public/_headers`) is not applied by Vite, so
  CSP effects (e.g. `heic2any`) were not exercised.
* **Auth is `AUTH_MODE=test`**: Cloudflare Access JWT verification, the login redirect and `redirect:'manual'` signed-out detection with a real
  Access redirect were not exercised end to end (the signed-out project simply sends no identity).
* **The image model is a mock.** Real `gpt-image-2.6-*` output, moderation errors, provider 429/5xx retries, real token cost vs the
  estimate, contact-sheet building with many references and `OUTCOME_UNKNOWN` handling were not exercised here (covered only by the
  existing integration/unit suites).
* Single browser engine, a single local D1; no concurrency stress or multi-user soak. Timing-based assertions use generous timeouts
  (15–90 s) and the processor polls at 1 s instead of 3–15 s.
* The R2/D1/KV are Miniflare local emulations; production-only behaviour (cron housekeeping, Worker limits, Pages headers, caching) is untested.
* Visual quality (layout polish, colour) was only spot-checked from screenshots; axe covers automatable accessibility rules only, not a
  screen-reader session.
