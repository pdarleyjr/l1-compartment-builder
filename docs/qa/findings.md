# QA findings — AI Compartment Studio (Ladder 1), real local stack

Severity: **High** = data loss / wrong result for users, **Medium** = a feature unusable or inaccessible in a common situation,
**Low** = developer/test-tooling or cosmetic. Status: *Fixed* (code in this change set + a regression test that fails without the fix,
verified by reverting `src/**`) or *Reported* (owner named, not changed here).

## Backend / shared / security (owner: lead)

**None found.** Besides the full flow against the real Worker, D1, R2 and processor, the adversarial probes in
`e2e/studio/api-probes.qa.js` all passed (so no `test.fail()` was needed): editor cannot reach processor/admin routes (403); a
version of compartment A cannot be published or edited-from in compartment B; preset main-image refs reject traversal, external
URLs and `/api/…` paths; uploads are validated by content (text bytes declared `image/jpeg` refused, `text/html` → 415);
over-long instructions / unknown presets / missing `Idempotency-Key` → 400; private photos are never served by
`/api/public/assets/*` (any variant) and need sign-in on `/api/assets/*`. Signed-out requests get 401 on every mutating and editor-only
route, including `/api/processor/claim`.

## UI defects found and fixed

### U-01 (Medium, Fixed) New mounts and edited links did not reach Arrange / Generate until the Studio was reopened
Repro: Studio → Mounts → Add mount "Rail Bracket" → Save → Arrange. The mount is missing from the item list (and Generate's "mounts: 0"
summary is wrong) because `StudioShell` loads compartment data once; only the capture panel refreshed it.
Fix: `src/studio/StudioShell.jsx` `go()` reloads the shared data on every step change.
Regression: `cross-cutting.qa.js` "a mount added in the Mounts step is offered in Arrange immediately" (fails without the fix, 16 s timeout),
and the Arrange step of every `core-flow` test.

### U-02 (High for the layout feature, Fixed) Arrange: zone choices made while the saved layout was loading were silently discarded
Repro: open Arrange on a slow connection, pick zones at once; when `GET …/design` resolves it replaces the local layout, so the picks vanish
(and the next Save writes the empty/old layout). Found because the first core-flow run saved only the last placement.
Fix: `src/studio/layout/ArrangeStep.jsx` disables zone, orientation and notes until the layout has loaded.
Regression: `cross-cutting.qa.js` "Arrange keeps an early zone choice when the saved layout loads slowly" (fails without the fix).

### U-03 (Medium, Fixed) Admin button had no accessible name on phones
Repro: signed in as admin, width < 640 px: the Studio header button shows only an icon (`<span class="hidden sm:inline">`), axe `button-name`
(critical) on every step. Fix: `aria-label` ("Admin settings" / "Back to the Studio steps") in `StudioShell.jsx`.
Regression: `cross-cutting.qa.js` axe test on the `phone` project (fails without the fix).

## Tooling / environment issues (Reported)

### Q-01 (Low, Reported — owner A, `vite.config.js`) `L1_API_PROXY` with `changeOrigin:false` makes every browser mutation fail against `wrangler dev`
With the documented local setup (`L1_API_PROXY=http://127.0.0.1:8787`) the browser's `Host` (the Vite port) reaches `wrangler dev`, which then
sends the Worker an `Origin` that fails the CSRF check (`403 Cross-origin requests are not allowed.`), whatever `PUBLIC_ORIGIN` is set to
(verified with `curl -H 'Host: 127.0.0.1:5183'`: always 403; with the real Host: passes). Reads work, every POST/PUT/PATCH/DELETE fails, so local
development of the Studio against a local Worker is impossible as documented. Production is unaffected (no proxy). The QA stack uses
`e2e/helpers/real-backend/vite.studio.config.mjs` (root config + `changeOrigin:true`); the same one-word change in `vite.config.js` fixes
local development. The local Worker also needs `--var PUBLIC_ORIGIN:<vite origin>` (done in `start-worker.sh`).

### Q-02 (Low, Reported — lead) `eslint .` lints wrangler's generated bundle
`wrangler dev` writes `worker/.wrangler/tmp/**` (gitignored, but not in `eslint.config.js` `ignores`): 265 spurious lint errors after any local
Worker run. The studio config deletes it in `globalTeardown`; suggest adding `**/.wrangler/**` to `eslint.config.js` ignores.

### Q-03 (Low, Reported — lead) Port 8787 is taken on aiw-k8 (AIW status page)
The brief asked for port 8787; on aiw-k8 the AIW status page listens there (`python3`), so the stack defaults to Worker 8791, Vite 5183, mock
OpenAI 8792, overridable with `L1_E2E_WORKER_PORT`, `L1_E2E_VITE_PORT`, `L1_E2E_MOCK_PORT`. Nothing was killed to free the port.

### Q-04 (Low, Fixed in this change set) Default `playwright test` would pick up the Studio specs
`playwright.config.js` has `testDir: ./e2e`; spec files under `e2e/studio` would run without the real stack and fail. They are named
`*.qa.js` and only `playwright.studio.config.js` matches them.

### Q-05 (Low, Reported — part A) Flaky touch-target test, see `docs/qa/skips.md` ("One flaky test observed").

## Not defects, but worth knowing
* Zones offered in Arrange depend on the compartment geometry (e.g. Rear Zone has no "upper shelf"); the specs read the real options.
* The Fast Preview estimate in this stack is about $0.12 and the mock's documented usage settles at about $0.004 per image.
