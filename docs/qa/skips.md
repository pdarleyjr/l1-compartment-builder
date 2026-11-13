# Skipped tests in the existing Playwright suite (`npx playwright test --trace off`)

Result of the last run: **117 passed, 36 skipped, 0 failed**. Every skip is a deliberate, project-conditional `test.skip(...)`
inside the spec (none is `test.skip()` without a condition, `fixme` or a commented-out test). None hides a regression, because the
skipped combination is covered by another project that runs the same assertion in the environment where it is meaningful.

| Count | Where | Projects skipped | Why it is skipped | Where the same behaviour is still covered |
|---|---|---|---|---|
| 32 | `e2e/audit-sync.spec.js` (16 tests × 2) — `test.skip(testInfo.project.name !== 'desktop-chromium', 'multi-device scenarios run once, at desktop size')` | `tablet-chromium`, `phone-chromium` | These scenarios open two or more browser contexts ("devices") against `FakeApi` and test the sync protocol (ops, revisions, 304, offline retry, tombstones). They do not depend on viewport size, so running them three times only triples the time. | `desktop-chromium` runs all 16 (SD-01 … SD-18, rename, reset, `?since=`). Layout/touch behaviour of the same screens is covered by `l1.spec.js` and `audit-frontend.spec.js`, which run on all three projects. |
| 2 | `e2e/audit-frontend.spec.js` FM-34 "keyboard focus in the sidebar survives a remote update" — `test.skip(isMobile, …)` | `tablet-chromium`, `phone-chromium` | The persistent sidebar only exists at the `lg` breakpoint (desktop). Below it the sidebar is a closed, inert drawer, so there is nothing to focus. | `desktop-chromium` (runs it). The drawer variant is covered by FM-21/FM-22 below. |
| 2 | `e2e/audit-frontend.spec.js` FM-21 (closed drawer is not focusable) and FM-22 (open drawer traps Tab, Escape closes) — `test.skip(!isMobile, …)` | `desktop-chromium` | The off-canvas drawer only exists below `lg`; on desktop the sidebar is static and never a dialog. | `tablet-chromium` and `phone-chromium` (both run). |

Total: 32 + 2 + 2 = 36, matching the runner's count. The count is stable because it is a function of the project matrix (3 projects)
and the 4 conditional skips above; it changes only if a project or a conditional skip is added.

Checked for hidden regressions: the 16 sync scenarios were confirmed to *run and pass* on `desktop-chromium` in the final run
(`audit-sync.spec.js:37 … :271`), FM-34 passes on desktop, FM-21/FM-22 pass on tablet and phone.

## One flaky test observed (not a skip)

`l1.spec.js` "visible controls meet touch target sizing" failed once on `phone-chromium` with `Close menu` measured at
43.99999237 × 44 px (it passed on 6 consecutive repeats and in every other run). The test samples the drawer's controls right after
opening it while the 300 ms `transition-transform` is still running, and the float rounding of a transformed rectangle goes
0.000008 px under the 44 px threshold. Product behaviour is fine (the button is 44 px). Owner: part A (`e2e/l1.spec.js`; wait for the drawer
transition, or compare with a 0.5 px tolerance as the Studio specs do). Not changed here (outside this part's ownership).
