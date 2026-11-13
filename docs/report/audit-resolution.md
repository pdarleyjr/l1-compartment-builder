# Audit resolution report: MBFD Ladder 1 Compartment Builder (AI Compartment Studio)

Date: 2026-11-13. Branch: `aiw/l1_compartment_builder-9-1113004107-02ad` (head `03abca8`). Baseline audited: `c9e0d0e` (pre-Studio production).
Scope: every finding in `docs/audit/worker-security.md` (WS), `docs/audit/sync-data.md` (SD), `docs/audit/frontend-mobile.md` (FM),
`docs/security/review-2026-11.md` (S) and `docs/qa/findings.md` (U, Q), re-checked against the current code.
The directive's "19.1 to 19.13" numbering does not appear in any audit document, so no mapping was made.

## How to read this report

Verification column tags:

- **[V]** automated test re-run in this job and passing (vitest or `node --test`; list at the end).
- **[E]** Playwright spec exists; its result is taken from `docs/qa/report.md` (117 + 45 passed, 0 failed). Playwright was **not** run in this job.
- **[C]** direct code read only (no dedicated regression test).
- **P-n** refers to the "Needs production verification" checklist (section 4).

Status values: **Fixed** (current code and a passing test), **Fixed by redesign** (the audited mechanism no longer exists; the
replacement and its test are named), **Mitigated / accepted** (risk remains, reason and owner given), **Not reproduced / info**,
**Open** (not fixed). Paths: `wt/` = `worker/test/`, `ws/` = `worker/src/`. "Owner" = the repository owner (lead) unless stated.

## 1. Summary

101 finding IDs: 23 WS, 18 SD, 36 FM (FM-01 to FM-35 plus FM-08b), 16 S, 3 U, 5 Q.

| Severity | Fixed | Fixed by redesign | Mitigated / accepted | Not reproduced / info | Open | Total |
|---|---|---|---|---|---|---|
| Critical | 0 | 1 | 0 | 0 | 0 | 1 |
| High | 6 | 8 | 0 | 0 | 0 | 14 |
| Medium | 28 | 9 | 1 | 0 | 1 | 39 |
| Low | 19 | 6 | 5 | 0 | 3 | 33 |
| Info | 3 | 0 | 0 | 11 | 0 | 14 |
| **Total** | 56 | 24 | 6 | 11 | 4 | 101 |


No Critical or High finding is open. All 15 Critical or High IDs (SD-01; WS-01, WS-03, WS-04; SD-02, SD-03, SD-05, SD-06; FM-11, FM-16,
FM-20, FM-24; S-01, S-02; U-02) are fixed or fixed by redesign, each with a passing test (section 3). The remaining open items are Medium or Low: the CI hardening part of WS-20, the optional processor service-id pin (S-12), the
missing edge rate-limit rule (S-16), the lint ignore for wrangler output (Q-02), and the anonymous read-only legacy `*.workers.dev`
endpoints (WS-02, accepted). The largest uncertainty is not a defect: several High fixes (Access JWT, atomic spend ledger, mobile
camera and Safari behaviour, client sync outbox) were proven against mocks, Node SQLite fakes and headless Chromium only, and the
production `ACCESS_AUD` is still a placeholder (section 2).

## 2. Open High/Critical items

**None of the audited findings is open at High or Critical severity.** Justification: each High/Critical ID below has current code and a
passing test (see the tables). Adversarial review, however, found the following conditions that can turn a "Fixed" High into a live
problem. They are not unfixed findings; they are unverified or unset deployment facts, listed here because they gate release.

1. **Release blocker: production `ACCESS_AUD` is the placeholder `SET_AT_DEPLOY`** (`worker/wrangler.toml`, top-level `[vars]`; staging has a real
   value). `ws/auth.js` fails closed on that value, so the production API would answer 401 to every non-public route, including the
   Studio and all planner edits, until the real Access application tag is set. This is safe (closed) but the app is not usable in production
   until it is set (P-1). The `workers_dev` legacy host does not need it.
2. **WS-01 / S-02 (High, Fixed) depend on real Access.** Tests mint JWTs with local RSA keys and a mocked JWKS endpoint. What is not verified:
   that the deployed Access application uses the same team domain and AUD, that the bypass application covers exactly `/api/public/*`, and
   that Access policies restrict `/api/processor/*` and `/api/admin/*` (P-1 to P-3). If the bypass application were broader than
   `/api/public`, the Worker would still refuse (it re-verifies every JWT), so the failure mode is availability, not exposure.
3. **WS-03 / WS-04 (High, Fixed by redesign) were proven on `node:sqlite`.** The cap is one `INSERT ... SELECT ... WHERE SUM(...) + est <= cap`
   statement (`ws/spend.js`), which is atomic per statement in D1, but concurrency was exercised only against a single-threaded SQLite
   fake and never under workerd/D1 (P-6). No real OpenAI call has ever been made, so actual cost versus estimate is untested (P-7).
   The provider-side hard monthly cap recommended in the audit (section (b) item 1) cannot be seen from the repo and must be confirmed.
4. **SD-06, SD-16, SD-18, FM-11, FM-20, FM-24 (High or Medium) client behaviour**: the offline outbox, status pill and pull/push race in
   `src/lib/planner-sync.js` have almost no unit tests (only `sanitizeView`, `describeConflict`, `pruneBundles` are unit-tested). Their
   proof is the Playwright specs `e2e/audit-sync.spec.js` and `e2e/audit-frontend.spec.js`, reported passing by QA and not re-run here (P-12, P-22).
5. **FM-01 / FM-02 HEIC**: `heic2any` needs `new Function`, which the production CSP blocks (correctly, per `docs/security/review-2026-11.md`). A real
   HEIC from a desktop Chromium therefore cannot be converted and shows the friendly refusal. iOS Safari decodes HEIC natively, so this
   is expected to matter little, but it has not been tried on a device (P-10).

Residual non-High items that remain open or accepted (for completeness): WS-02 (Medium, accepted), WS-20 (Medium, open), WS-23 (Low,
accepted), S-12, S-16, Q-02 (Low, open), S-13 to S-15 (Low, accepted), `[ai]` binding in `wrangler.toml` is now unused (no `env.AI` reference in `worker/src`).

## 3. Findings by source

### 3.1 Worker security (WS-01 to WS-23)

| ID | Severity | Component | Evidence | Root cause | Fix | Verification | Status |
|---|---|---|---|---|---|---|---|
| WS-01 | High | Worker auth | worker-security WS-01 | Identity inferred from client-set `Origin` | Access JWT verified on every non-public `/api` route (RS256/JWKS, iss, aud, exp/nbf), same-origin check; legacy PUT/POST answer 409 and never write (`ws/auth.js` `getActor`, `ws/router.js`, `ws/legacy.js`) | [V] `worker/audit.test.js` "WS-01 a non-browser PUT with a forged Origin ... can no longer overwrite state", "WS-01 Studio mutations require a verified identity"; `wt/security/auth.test.js` (51); P-1 | Fixed |
| WS-02 | Medium | Legacy `*.workers.dev` GET | WS-02 | GET exempt from auth | `/api/public/*` is public by design (public committed display/thumb only). Legacy `GET /state` and `/images` stay anonymous read-only for old tabs (`ws/legacy.js` `readState`, `readImages`) | [V] the two `test.fails` in `worker/audit.test.js` still document it. Before `migrate-legacy` completes, legacy `GET /images` serves the raw KV photo document; afterwards only public asset URLs (P-8) | Mitigated / accepted (owner: lead; disable `workers_dev` once old tabs are gone) |
| WS-03 | High | AI rate limit | WS-03 | Racy per-IP KV read-modify-write | No KV counter; atomic D1 spend ledger with per-user concurrency and per-user/day/month caps (`ws/spend.js` `reserve`) | [V] `wt/security/spend-and-prompt.test.js` "parallel requests with distinct keys never exceed the per-user concurrency or the reservation caps", "retry makes ONE new reservation"; P-6 | Fixed by redesign |
| WS-04 | High | Global spend cap | WS-04 | Only a per-IP limit | Global day and month caps and per-user day cap in the same ledger; admin kill switch `ai.enabled` | [V] `spend-and-prompt.test.js` "a retry cannot bypass a spent daily budget" and ledger bound tests; `tests/integration/budget-caps.test.js` (5); P-6, P-7 | Fixed by redesign |
| WS-05 | Low | IP buckets | WS-05 | Shared `unknown` IP bucket, NAT sharing | Limits are per authenticated user, no IP buckets | [V] `worker/audit.test.js` "WS-03/04/05/09 POST /generate-image never calls the model" | Fixed by redesign |
| WS-06 | Medium | KV write limit, unhandled errors | WS-06 | Bare KV puts, no try/catch | No KV writes on any path; D1 writes retried on CAS miss; unhandled errors become JSON 500 (`worker/index.js` catch) | [V] `worker/audit.test.js` "WS-06 a KV read failure on GET /state returns a JSON 5xx", "WS-06 there is no KV write left to fail"; `wt/core/planner.test.js` "gives up with REVISION_CONFLICT after repeated CAS misses" | Fixed by redesign |
| WS-07 | Medium | Body size | WS-07 | Body buffered before size check | `readJson`/`readBytes` stop reading at the limit (`ws/http.js`) | [V] `worker/audit.test.js` "WS-07 an over-limit chunked body ... is abandoned after the limit", "falsified small Content-Length"; `wt/security/objects.test.js` "a body without Content-Length is cut off", "a lying Content-Length" | Fixed |
| WS-08 | Low | 12 MB image PUT | WS-08 | Whole base64 document parsed per PUT | Endpoint removed; photos are R2 objects streamed with per-variant caps (original 25 MB, display 4 MB, thumb 512 KB) | [V] `worker/audit.test.js` "WS-07 legacy writes are answered without reading the body"; `objects.test.js` limit tests; P-20 | Fixed by redesign |
| WS-09 | Medium | Generator schema | WS-09 | Client-authored spec and prompt | Server builds the scene spec and prompt from stored data; unknown fields and presets rejected; text flattened/quoted (`ws/studio/job-spec.js`) | [V] `spend-and-prompt.test.js` "prompt injection stays quoted data" (6) and tamper tests | Fixed by redesign |
| WS-10 | Info | Reference photos | WS-10 | Generator accepted none | Reference photos supported via validated uploads (magic bytes, pixel and size limits). The server does not re-encode, so EXIF removal relies on the browser canvas re-encode | [V] `objects.test.js` type, bomb and limit tests; [C] `ws/assets.js`, `src/lib/image/encode.js` | Not reproduced / info (see residual under FM-05) |
| WS-11 | Medium | Document validation | WS-11 | Whole document stored with loose checks | No whole-document writes; planner ops validated one by one, state rebuilt by `applyOps` (`shared/planner.js`) | [V] `worker/audit.test.js` "WS-11 unknown ops and malformed bodies are rejected"; `tests/shared/planner-ops.test.js` (73); `tests/shared/validation.test.js` (143) | Fixed by redesign |
| WS-12 | Medium | Preview origins write prod | WS-12 | Preview origins trusted for writes | Legacy host has no write path; `/api` needs verified identity and `PUBLIC_ORIGIN` | [V] `worker/audit.test.js` "WS-12 a Pages preview deployment origin cannot mutate production state", "look-alike origins are rejected" | Fixed |
| WS-13 | Low | Routing | WS-13 | No 405, non-JSON 404 | 405 + `Allow`, JSON 404, preflight only for real legacy paths with `Max-Age`; no CORS on `/api` | [V] `worker/audit.test.js` WS-13 x4; `wt/security/auth.test.js` "unknown routes and wrong methods" | Fixed |
| WS-14 | Low | Response headers | WS-14 | No CSP | CSP `default-src 'none'; frame-ancestors 'none'`, nosniff, no-referrer, HSTS on all Worker responses (`ws/http.js` `SECURITY_HEADERS`) | [V] `worker/audit.test.js` "WS-14 API and legacy responses carry a restrictive Content-Security-Policy"; `objects.test.js` "every kind of API response carries" | Fixed |
| WS-15 | Info | `camera=()` | WS-15 | Header blocked `getUserMedia` | `public/_headers` now `camera=(self)`; CSP unchanged (no unsafe-eval) | [V] `worker/audit.test.js` WS-15 x2; `wt/security/headers-config.test.js` (10); real iOS/Android: P-10 | Fixed |
| WS-16 | Medium | Polling load | WS-16 | Two full KV reads per tab every 5 s | `GET /api/public/planner?since=<rev>` returns 304; polling only while visible (`src/lib/planner-sync.js`); photos are cacheable URLs | [V] `tests/integration/migration-planner.test.js` "serves 304 with an ETag when `since` matches"; [E] `e2e/audit-sync.spec.js` "pulls use ?since= ..."; quota headroom: P-20 | Fixed by redesign |
| WS-17 | Medium | `npm audit` | WS-17 | Vulnerable dev/build packages | `vite ^8.3.8`, `vitest`/coverage `^4.1.12`, `wrangler ^4.161.0`, `overrides.minimatch ^11.0.8` (`package.json`) | [V] `npx npm@11.6.2 audit --audit-level=low` run here: "found 0 vulnerabilities"; `npm ci` and `npm run build` succeed; advisory data changes over time: P-14 | Fixed |
| WS-18 | Low | Committed identifiers | WS-18 | Account and namespace ids in `wrangler.toml` | Identifiers only (accepted); `.gitignore` now covers `.dev.vars`, `.env*`, `processor/deploy/*.env`; no secret scanner added | [V] `headers-config.test.js` "contains no secrets" and working-tree secret test; a `git grep` for key shapes over the tree found only the audit text and a synthetic test fixture | Fixed (identifiers accepted; secret scanner not added) |
| WS-19 | Low | `compatibility_date` | WS-19 | Date 2024-01-01 | Now `2026-11-01`; observability enabled | [C] `worker/wrangler.toml`; dry-run deploy not executed: P-19 | Fixed |
| WS-20 | Medium | CI provenance | WS-20 | Tag-pinned actions, no deploy provenance | Only the audit gate effect is gone (audit now clean). `.github/workflows/ci.yml` is unchanged: actions pinned by tag, no `concurrency`, no Dependabot, no Worker version endpoint; branch protection not visible | [C] `ci.yml`, no `/version` route in `ws/router.js`; P-15, P-16 | Open (Medium; owner: lead) |
| WS-21 | Info | Error leakage | WS-21 | Did not reproduce | 500 bodies generic; processor and provider text never reach users (S-07) | [V] `objects.test.js` "error bodies never echo stack traces, SQL or internals"; `worker/audit.test.js` "WS-21/22 the response is a constant APP_UPDATED body" | Not reproduced / info (hardened) |
| WS-22 | Medium | Durable jobs | WS-22 | Synchronous, non-idempotent generation | `POST /api/compartments/:id/jobs` with `Idempotency-Key`, leases, one ledger row per job, OUTCOME_UNKNOWN never requeued (`ws/jobs.js`, `ws/studio/recovery.js`) | [V] `wt/studio/jobs.test.js` (26), `spend-and-prompt.test.js`, `tests/integration/jobs-processor.test.js` (11); real provider: P-7 | Fixed by redesign |
| WS-23 | Low | Test infrastructure | WS-23 | Atomic fake KV, no workerd | Tests now use `node:sqlite` D1 and in-memory R2 fakes; still no workerd or latency/consistency simulation | [C] `wt/helpers/d1.js`; mitigated by staging checks P-6, P-18 | Mitigated / accepted (owner: lead) |

### 3.2 Sync / data (SD-01 to SD-18)

| ID | Severity | Component | Evidence | Root cause | Fix | Verification | Status |
|---|---|---|---|---|---|---|---|
| SD-01 | Critical | Planner sync | sync-data SD-01 | Whole-document last-write-wins | Op-based planner with integer revision and CAS (`ws/planner.js`, `shared/planner.js` `applyOps`, `diffDocs`) | [V] `tests/audit/sync-data.test.js` "SD-01 ... neither edit is lost", "SD-01 a stale edit of the SAME slot is reported as a conflict"; `tests/shared/planner-ops.test.js` "SD-01: two devices editing different compartments both survive"; `tests/integration/migration-planner.test.js` "(b) ops from two devices ..."; [E] SD-01; P-12 | Fixed by redesign |
| SD-02 | High | Photo deletion | SD-02 | Additive merge, no tombstones | Photos are server assets with soft delete (`deleted_at`); no client merge (`ws/assets.js`) | [V] `wt/studio/assets.test.js` "soft-deletes, hides from list ..."; `tests/studio-b1/ui-logic.test.js` "sends DELETE only after the undo window"; [E] SD-02/03 | Fixed by redesign |
| SD-03 | High | Reload resurrects photo | SD-03 | SD-02 plus push on load | The client never pushes a photo set; deletion is server state | [V] as SD-02; [E] SD-02/03 | Fixed by redesign |
| SD-04 | Medium | Featured image | SD-04 | "Local wins" merge | Server-authoritative `main_images` row with revision CAS, previous kept for recovery | [V] `wt/studio/gallery.test.js` "uses CAS on main_images.revision", "swaps current and previous"; [E] SD-04 | Fixed by redesign |
| SD-05 | High | Whole base64 document | SD-05 | Images inline in one KV value | R2 objects, `/api/public/assets/:id/display`; legacy `/images` is a URL projection | [V] `tests/audit/sync-data.test.js` "SD-05 one new photo no longer re-sends the whole document"; [E] SD-05 (replaced) no photo keys in localStorage | Fixed by redesign |
| SD-06 | High | Failed PUT not retried | SD-06 | No outbox | Durable op queue in localStorage with backoff and rebase (`src/lib/planner-sync.js` `queue`, `kick`, `rebase`); photos in an IndexedDB queue (`src/lib/upload-queue.js`) | [V] `tests/studio-b1/upload-queue.test.js` "resumes after a reload from the durable store", "pauses while offline and resumes"; planner outbox: [E] SD-06, SD-06b only; P-12, P-13 | Fixed (planner outbox lacks vitest coverage) |
| SD-07 | Medium | Identity by name | SD-07 | Mutable name is the key | Stable equipment ids (`eq_` + hash) and assignment ids; `renameEquipment` keeps ids | [V] `planner-ops.test.js` "rename back and forth keeps the same identity", "removed base items are not assignable"; [E] SD-07 x2 | Fixed |
| SD-08 | Medium | Stale bundles | SD-08 | Reset and remove did not prune | Bundle integrity enforced in `applyOps`; `pruneBundles` client side | [V] `planner-ops.test.js` "SD-08: Reset-all style clears leave no stale bundles", "emptying clears the assignment id and prunes bundles"; `tests/app/app-units.test.js` pruneBundles; [E] SD-08 x2 | Fixed |
| SD-09 | Info | Concurrent last unit | SD-09 | Did not over-allocate (only by losing an update) | Quantity invariant enforced server side; loser gets `QUANTITY` conflict and a notice | [V] `planner-ops.test.js` "SD-09: both devices take the last unit"; `migration-planner.test.js` "the last unit ... QUANTITY conflict"; [E] SD-09 | Not reproduced / info (invariant now enforced) |
| SD-10 | Low | Duplicate uids | SD-10 | Loose images validator | Legacy images document is no longer written; ids are server generated; migration skips unresolvable featured entries and reports them | [V] `tests/audit/sync-data.test.js` "SD-10 a featured upload that points at a non-existent uid is skipped"; `wt/core/migrate.test.js` (9) | Fixed by redesign |
| SD-11 | Low | KV write failure | SD-11 | Bare `put` | No KV write remains | [V] `tests/audit/sync-data.test.js` "SD-11 no KV write exists to fail" | Fixed by redesign |
| SD-12 | Medium | Client/Worker limits mismatch | SD-12 | Limits only on the Worker | Shared constants in `shared/contracts.js` (`ASSET_LIMITS`, `PLANNER_LIMITS`) used by client and Worker; errors surfaced as sync problems | [V] `tests/shared/validation.test.js` (143), `tests/shared/ids.test.js` | Fixed |
| SD-13 | Low | Bundle integrity | SD-13 | No referential checks | `applyOps` prunes empty/out-of-range indices and deletes empty bundles | [V] `planner-ops.test.js` "upsert replaces by id ... prunes empty/out-of-range slots, deletes empty bundles" | Fixed |
| SD-14 | Low | `_serverTs` not a revision | SD-14 | `Date.now()` | Integer revision incremented under CAS | [V] `tests/audit/sync-data.test.js` "SD-14 writes in the same millisecond receive distinct, increasing revisions" | Fixed |
| SD-15 | Low | Unknown fields persisted | SD-15 | Whole body stored | State derived only from validated ops | [V] `worker/audit.test.js` "WS-11 unknown ops and malformed bodies are rejected" | Fixed by redesign |
| SD-16 | Medium | Failed save masked | SD-16 | Status derived from GET success | Status derived from queue and `problem` flag (`planner-sync.js` `status`) | [E] SD-16; [C] `planner-sync.js:134-141`; no vitest | Fixed (e2e only) |
| SD-17 | Medium | Images unbound to inventory | SD-17 | No link to plan state | `inventoryFingerprint` on versions, `stale` flag, "Image may be outdated" notice (`ImageCarousel.jsx`) | [V] `tests/shared/fingerprint.test.js` (5), `wt/studio/gallery.test.js` "main image becomes stale when assignments change after approval"; [E] stale badge flow | Fixed |
| SD-18 | Medium | Pull overwrites pending edit | SD-18 | Pull cancelled debounce timer | `flushLocal()` queues local edits before the base moves (`planner-sync.js:307`) | [E] SD-18; [C] code; not reproduced deterministically in the original audit; no vitest | Fixed (e2e only) |

### 3.3 Frontend / mobile (FM-01 to FM-35, FM-08b)

`src/App.jsx` shrank from 2363 to 182 lines; the components named below replaced the inline code.

| ID | Severity | Component | Evidence | Root cause | Fix | Verification | Status |
|---|---|---|---|---|---|---|---|
| FM-01 | Medium | Upload decode | frontend-mobile FM-01 | Decode failure stored raw file | `decode.js` throws `ImageDecodeError`; nothing stored; server sniffs magic bytes | [V] `tests/studio-b1/sniff-geometry.test.js` "never trusts text posing as an image"; [E] QA ".heic file shows could not be converted"; P-10 | Fixed |
| FM-02 | Low | HEIC message | FM-02 | MIME empty, generic text | Extension check and explicit HEIC message (`decode.js`) | [V] sniff-geometry "detects HEIC and HEIF brands"; [E] as FM-01 | Fixed |
| FM-03 | Medium | Only a downscaled copy | FM-03 | 1400 px JPEG kept | Original JPEG q0.92 up to 4096 px plus 1600 px display and 400 px thumb (`src/lib/image/encode.js`) | [V] sniff-geometry "caps the long edge and never upscales"; [C] encode.js | Fixed (still a re-encode, byte-identical original is not kept: accepted, strips metadata) |
| FM-04 | Low | Transparent PNG black | FM-04 | JPEG re-encode | White flatten (`encode.js:58`); markup layers keep PNG | [V] `tests/integration/ui-clients.test.js` "markupUpload: a transparent PNG is accepted"; flatten is [C] only | Fixed |
| FM-05 | Info | EXIF/GPS | FM-05 | Not reproduced | Canvas re-encode strips metadata. The Worker does not re-encode: a custom client could upload EXIF in `display` | [C] `encode.js`, `ws/assets.js`; public serves display/thumb only; owner: lead (optional server strip) | Not reproduced / info |
| FM-06 | Info | EXIF orientation | FM-06 | Not reproduced | `createImageBitmap(..., {imageOrientation:'from-image'})` (`decode.js:21`) | [C]; real phone photos: P-10 | Not reproduced / info |
| FM-07 | Medium | Multi-select | FM-07 | No `multiple` | `multiple` picker (`CapturePanel.jsx:99`) | [E] QA core-flow upload specs | Fixed |
| FM-08 | Medium | Take photo | FM-08 | No capture input | Camera input with `capture="environment"` plus live viewfinder (`CapturePanel.jsx:97`, `LiveCamera.jsx`) | [E] QA capture specs; real devices not tested: P-10 | Fixed |
| FM-08b | Info | Permissions-Policy | FM-08b | `camera=()` | `camera=(self)` only | [V] `headers-config.test.js`; [E] FM-08b | Fixed |
| FM-09 | Low | Upload errors | FM-09 | Shared `aiError`, no `role` | Per-item `role="alert"` and `aria-live` (`PendingGrid.jsx`, `CapturePanel.jsx`) | [C]; [E] QA ".heic ... shows message" | Fixed |
| FM-10 | Medium | Delete confirm | FM-10 | No confirm, no undo | Confirm in the carousel; library delete has a 10 s undo (`deferred-delete.js`) | [V] `ui-logic.test.js` "sends DELETE only after the undo window"; [E] FM-10 | Fixed |
| FM-11 | High | Deleted photo resurrected | FM-11 | Add-only merge | Same as SD-02 (soft delete, server authoritative) | [V] `assets.test.js` soft delete; [E] SD-02/03 | Fixed by redesign |
| FM-12 | Medium | Carousel keys/swipe | FM-12 | No handlers | Arrow keys and pointer swipe (`ImageCarousel.jsx:47-52`) | [E] FM-12 | Fixed |
| FM-13 | Low | Active dot state | FM-13 | No state | `aria-current` on active dot | [E] FM-13; [C] `ImageCarousel.jsx:122` | Fixed |
| FM-14 | Medium | Footer clipped | FM-14 | `shrink-0` dots in overflow | Footer wraps (`flex-wrap`) | [E] FM-14 (20 photos) | Fixed |
| FM-15 | Medium | Generating state leaks | FM-15 | Unkeyed carousel, local state | `key={comp.id}` (`CompartmentMedia.jsx:24`); generation state lives in per-compartment server jobs | [C]; [E] QA job progress flows; no dedicated test | Fixed by redesign |
| FM-16 | High | AI output = shared photo | FM-16 | No draft state | Versions are private drafts; only an approved version is published as main image; provenance badge; stale gate | [V] `wt/studio/gallery.test.js` "approving a fresh version publishes it ...", "editor gallery adds private photos and draft/rejected versions", "public gallery: preset images + public committed assets only" | Fixed by redesign |
| FM-17 | Info | Failure handling | FM-17 | Worked | Fixed texts from `humanFailure(code)` | [V] `spend-and-prompt.test.js` "failure message ... never echoed" | Not reproduced / info |
| FM-18 | Medium | No cancel/timeout | FM-18 | Plain `fetch` | Cancel button per job (`JobStatus.jsx:43`), server leases and timeouts | [V] `objects.test.js` "cancel and retry ... restricted to its requester"; [E] QA "Cancel a queued job" | Fixed by redesign |
| FM-19 | Medium | Storage warning hidden | FM-19 | Only in drawer | Banner in main column (`App.jsx:141`); photos no longer in localStorage | [E] FM-19; [C] | Fixed |
| FM-20 | High | No error boundary | FM-20 | Unvalidated server fields | `ErrorBoundary` in `main.jsx`; `sanitizeView` coerces every field | [V] `tests/app/app-units.test.js` "coerces malformed shared documents into renderable shapes"; [E] FM-20 | Fixed |
| FM-21 | Medium | Closed drawer focusable | FM-21 | No `inert` | `inert` + `aria-hidden` (`Sidebar.jsx:44`) | [E] FM-21 (touch projects) | Fixed |
| FM-22 | Medium | Drawer focus/Escape | FM-22 | No trap | Focus move, Tab trap, Escape, `aria-modal`, focus return (`Sidebar.jsx:24-47`) | [E] FM-22 | Fixed |
| FM-23 | Low | Contrast | FM-23 | Light grays | Star, remove and badge colors darkened; "Powered by" text removed. Prev/Next still `bg-black/30` over photos (not measured) | [E] FM-23 | Fixed |
| FM-24 | High | Full document every 5 s | FM-24 | No conditional fetch | `?since=` 304 and R2 URLs (see WS-16) | [V] `migration-planner.test.js` 304 test; [E] FM-24 | Fixed by redesign |
| FM-25 | Info | Low-end timing | FM-25 | Measurement | Pipeline changed (`createImageBitmap`, display/thumb); not re-measured here | [E] FM-25 documents timings only | Not reproduced / info |
| FM-26 | Info | Print | FM-26 | Documents behaviour | Unchanged (current image only, controls hidden) | [E] FM-26 | Not reproduced / info |
| FM-27 | Info | Excel export | FM-27 | Documents behaviour | Unchanged: two sheets, no bundles, photos or renderings (`exportExcel.js`). Enhancement, not a defect | [C]; [E] FM-27 | Not reproduced / info |
| FM-28 | Info | Bundle size | FM-28 | Measurement | `npm run build` here: main `index` 264.64 kB (81.42 kB gzip), lazy `StudioShell` 191.82 kB, lazy `write-excel-file` 70.71 kB, lazy `heic2any` 1352 kB (344.72 kB gzip, only on HEIC) | [V] build succeeded (baseline was 230.5 kB) | Not reproduced / info |
| FM-29 | Low | Stale AI copy | FM-29 | Old text | No "Workers AI" or "Llama" string remains in `src` | [C] grep | Fixed |
| FM-30 | Low | FileReader/`pendingNav` | FM-30 | No `onerror` | `FileReader` removed; promise pipeline with typed errors | [C] grep, `decode.js` | Fixed by redesign |
| FM-31 | Low | Upload progress | FM-31 | No progress | Progress list, per-photo status, cancel and retry (`UploadProgressList.jsx`, `upload-queue.js`) | [V] `upload-queue.test.js` "cancel aborts ...", "fails as retryable after max attempts"; `ui-logic.test.js` "computes percent and summaries" | Fixed |
| FM-32 | Info | `App.jsx` size | FM-32 | 2363 lines | 182 lines; `src/components/*` | [C] `wc -l` | Fixed (refactor done) |
| FM-33 | Medium | localStorage quota | FM-33 | Base64 photos in localStorage | Photos on the server; pending photos in IndexedDB | [E] SD-05 (replaced) | Fixed by redesign |
| FM-34 | Medium | Inner `Sidebar` | FM-34 | Component defined in `App` | Top-level component (`Sidebar.jsx`) | [E] FM-34 | Fixed |
| FM-35 | Info | iOS Safari | FM-35 | Not covered | Still uncovered: no WebKit run, no device. `h-[100dvh] min-h-screen` unchanged (`App.jsx:81`) | Not testable here; P-10 | Not reproduced / info (needs P-10) |

### 3.4 Security review 2026-11 (S-01 to S-16)

| ID | Severity | Component | Evidence | Root cause | Fix | Verification | Status |
|---|---|---|---|---|---|---|---|
| S-01 | High | Processor lease | review S-01 | Node optional on raw endpoints | Node hint mandatory (`ws/processor.js` `nodeHint`). Residual: node names are self-asserted under one shared token; gives no extra privilege | [V] `wt/security/processor-api.test.js` "raw endpoints refuse requests that name no node at all" (10 tests) | Fixed (residual accepted) |
| S-02 | High | `AUTH_MODE=test` | S-02 | Honored unless env was `production`/`staging` | Allow-list `test`/`development`/`local` (`ws/auth.js:13`); `wrangler.toml` pins `access` | [V] `wt/security/auth.test.js` "AUTH_MODE=test can never be honored outside test/development/local" | Fixed |
| S-03 | Medium | Public original | S-03 | Original served publicly | Public variants display/thumb only (`assets.getPublicVariant`) | [V] `objects.test.js` "a public asset serves display/thumb but never the full-size original" | Fixed |
| S-04 | Medium | Pixel limits | S-04 | No dimension cap | `withinPixelLimits` (upload 4096 px, 16.7 MP; output 8192, 36 MP) | [V] `objects.test.js` "headers declaring 30000 x 30000 pixels ... refused with 413", "edges over 4096"; P-7 | Fixed |
| S-05 | Medium | Prompt injection | S-05 | Names interpolated raw | `neutralizeSpecText`/`flatText`; instructions quoted. Residual: a hostile name can still lie on its own line; human review of drafts remains | [V] `spend-and-prompt.test.js` "prompt injection stays quoted data" | Fixed (residual accepted) |
| S-06 | Medium | Cost bound | S-06 | Unbounded reported cost | Cap `max(5 x reservation, $0.25)`; usage size limits (`ws/processor.js:168`) | [V] `spend-and-prompt.test.js` "reported cost stays within [0, 5x reservation]" | Fixed (under-reporting accepted) |
| S-07 | Medium | Provider text | S-07 | Provider message relayed | Fixed messages both in processor and `humanFailure` | [V] `spend-and-prompt.test.js` "a failure message ... never echoed to users"; `processor/test/security.test.js` | Fixed |
| S-08 | Medium | Processor redirects/SSRF | S-08 | Redirects followed with secret headers | `redirect:'error'`; downloads limited to `/api/processor/assets/` (`processor/src/api-client.js`) | [V] `processor/test/security.test.js` "a redirect from the Worker origin is never followed", "download only fetches processor asset endpoints" | Fixed |
| S-09 | Low | CSRF | S-09 | Origin only | Fetch Metadata check in `ws/router.js:85` | [V] `auth.test.js` "a mutation flagged cross-site / same-site by Fetch Metadata is refused"; cookie SameSite: P-4 | Fixed |
| S-10 | Low | Retry key | S-10 | Key not validated | Shared `idempotencyKey()` (`ws/jobs.js:81`) | [V] `wt/studio/jobs.test.js` | Fixed |
| S-11 | Low | Response hardening | S-11 | Missing HSTS, image CSP | HSTS, image CSP + `sandbox`, servable-type allow-list | [V] `objects.test.js` "a JPEG with trailing script is served as inert image/jpeg" | Fixed |
| S-12 | Low | Service-token pinning | S-12 | Any app token is a processor | Optional `PROCESSOR_SERVICE_IDS` implemented (`ws/auth.js:148`) but not set in `wrangler.toml` | [V] `auth.test.js` "PROCESSOR_SERVICE_IDS pins which service tokens count"; P-3 | Open (config; owner: lead) |
| S-13 | Low | JWKS stale keys | S-13 | Cached key on outage | Unchanged, by design (availability) | Review text only | Mitigated / accepted |
| S-14 | Low | R2 overwrite race | S-14 | R2 put before D1 update | Unchanged; actor may already delete that asset | Review text only | Mitigated / accepted |
| S-15 | Low | `style-src 'unsafe-inline'` | S-15 | React inline styles | Unchanged | [C] `public/_headers` | Mitigated / accepted |
| S-16 | Low | Rate limiting | S-16 | None on editor routes | Spend ledger and size caps only; edge rule not in repo | P-5 | Open (Cloudflare rule; owner: lead) |

### 3.5 QA findings (U-01 to U-03, Q-01 to Q-05)

| ID | Severity | Component | Evidence | Root cause | Fix | Verification | Status |
|---|---|---|---|---|---|---|---|
| U-01 | Medium | Studio shell | qa/findings U-01 | Data loaded once | `go()` reloads shared data (`StudioShell.jsx:86`) | [E] `cross-cutting.qa.js` "a mount added in the Mounts step is offered in Arrange immediately" | Fixed |
| U-02 | High (layout feature) | Arrange step | U-02 | Zone picks overwritten by late load | Controls disabled while loading (`ArrangeStep.jsx:116,122`) | [E] `cross-cutting.qa.js` "Arrange keeps an early zone choice ..." | Fixed |
| U-03 | Medium | Admin button | U-03 | No accessible name | `aria-label` (`StudioShell.jsx:121`) | [E] axe test on phone project | Fixed |
| Q-01 | Low | Vite proxy | Q-01 | `changeOrigin:false` | `changeOrigin: true` (`vite.config.js:25`) | [C] | Fixed |
| Q-02 | Low | ESLint | Q-01..05 doc | Wrangler tmp not ignored | `eslint.config.js` ignores unchanged (no `.wrangler`); QA teardown deletes the folder | [V] `npx eslint .` clean here because no `worker/.wrangler` exists | Open (owner: lead) |
| Q-03 | Low | Port 8787 | Q-03 | AIW status page uses it | Ports configurable (`e2e/helpers/real-backend/ports.mjs`) | [C] | Mitigated / accepted |
| Q-04 | Low | Playwright testDir | Q-04 | Studio specs in default run | Specs named `*.qa.js`, matched only by `playwright.studio.config.js` | [C] config read | Fixed |
| Q-05 | Low | Flaky touch-target test | Q-05 | Sampled mid-transition | `e2e/l1.spec.js` waits for animations to finish | [C] `e2e/l1.spec.js:28-29` | Fixed |

## 4. Needs production verification

Cannot be checked from the repository. Perform on staging first, then production.

- [ ] **P-1** Set the real production `ACCESS_AUD` (currently the placeholder); confirm team domain; unauthenticated call to a non-public `/api` route gives 401 and a signed-in call succeeds.
- [ ] **P-2** Confirm the Access bypass application covers exactly `/api/public/*` and nothing else.
- [ ] **P-3** Confirm Access policies: `/api/processor/*` only for the service token, `/api/admin/*` only for the owner group; set `PROCESSOR_SERVICE_IDS` (S-12).
- [ ] **P-4** Confirm the `CF_Authorization` cookie is `SameSite` and a cross-site mutation with the cookie is refused.
- [ ] **P-5** Add and test a Cloudflare rate-limiting rule on `/api/*` and on job creation (S-16).
- [ ] **P-6** On staging (workerd + real D1) fire about 20 parallel job creations at a small daily cap; reserved spend must never exceed the cap.
- [ ] **P-7** With the real OpenAI key on the processor node: one job per preset; compare real cost to the estimate; check output size against the 8192 px cap; trigger a provider error and a timeout (OUTCOME_UNKNOWN) and confirm no requeue and a generic user message; confirm the provider-side monthly hard cap exists.
- [ ] **P-8** Legacy host: confirm `GET /images` returns only public asset URLs after migration; before migration it exposes raw KV photos; decide when to set `workers_dev = false`.
- [ ] **P-9** Run `/api/admin/migrate-legacy` on staging against the KV copy; compare counts, review skipped items, confirm idempotent re-run.
- [ ] **P-10** Real iOS Safari and Android Chrome: `capture="environment"`, live viewfinder under `camera=(self)`, real HEIC and 12 to 48 MP photos, EXIF orientation, `100dvh` with toolbar and keyboard, private-browsing storage.
- [ ] **P-11** Open the planner and Studio on staging with the Pages `_headers` applied; confirm no CSP violations in the console.
- [ ] **P-12** Two real devices on staging: concurrent edits to different and same slots, offline edit then reload then reconnect, photo delete propagation.
- [ ] **P-13** Let an Access session expire during editing; confirm the sign-in prompt appears and queued edits are delivered after login.
- [ ] **P-14** Re-run the full-tree `npm audit` in CI on the merge commit (advisory data changes daily).
- [ ] **P-15** GitHub settings: required PR and `verify` check, no force-push, protected production environment; then pin actions by SHA, add a `concurrency` group and Dependabot (WS-20).
- [ ] **P-16** Add a deploy provenance marker (version endpoint or deploy from CI) and confirm the deployed Worker matches the reviewed commit.
- [ ] **P-17** Optional: migration adding `CHECK (estimated_usd >= 0)` and `CHECK (actual_usd IS NULL OR actual_usd >= 0)` on `spend_ledger` (review lead item 4).
- [ ] **P-18** Confirm the `*/5` cron runs in production (expired leases, pending-asset GC, stale reservations); unit tests cover logic only.
- [ ] **P-19** `wrangler deploy --dry-run` on a worker with `compatibility_date = 2026-11-01`; remove the unused `[ai]` binding if confirmed unneeded.
- [ ] **P-20** Check Cloudflare plan limits (Workers requests, D1 reads, R2 operations) against expected polling and 25 MB streamed uploads.
- [ ] **P-21** Desktop Chromium: choose a real `.heic` file and confirm the friendly refusal; confirm iOS library picks arrive as JPEG.
- [ ] **P-22** Re-run Playwright on a worker (`npx playwright test` and `-c playwright.studio.config.js`; WebKit in the official Docker image) after the final merge.

## 5. Verified defects versus theoretical risks

**Verified defects (reproduced by a test at the audited baseline, now fixed and covered).** WS-01, WS-03, WS-04, WS-05, WS-06, WS-07,
WS-09, WS-11, WS-12, WS-13, WS-14, WS-22, SD-01 to SD-08, SD-10 to SD-17, FM-01 to FM-04, FM-07 to FM-16, FM-18 to FM-24, FM-33, FM-34
(the audit documents label these TEST VERIFIED), and from the security review S-01 to S-11 (each fixed with a test that fails when the fix is reverted, per the review).
Their current status relies on the tests named in the tables.

**Theoretical or inferred at audit time (not reproduced, or reproducible only in production).** WS-08 (workerd cost), WS-15 camera behaviour
on devices, WS-16 quota exhaustion, SD-18 (timing race), FM-06, FM-25, FM-35 and the iOS risks, S-13, S-14, S-16, and the residuals
under S-01 and S-05. Cloudflare Access edge behaviour, WAF and rate limits, D1 under real concurrency, real OpenAI behaviour and cost, real
HEIC and mobile camera behaviour, cron execution and plan quotas are inaccessible from this repository; section 4 lists the exact checks.

**Not defects.** WS-10, WS-21, SD-09, FM-05, FM-06, FM-17, FM-26 to FM-28 were informational or did not reproduce.

**What this job did and did not do.** It re-ran the unit and integration suites, `node --test` for the processor, lint, `npm audit` and a
production build. It did not run Playwright, start servers, or contact Cloudflare, GitHub or OpenAI. Findings backed only by [E] rest on the
QA report.

## 6. Test runs (this job, branch head `03abca8`, `npx npm@11.6.2 ci` first)

| Command | Result |
|---|---|
| `npx vitest run` (44 files) | 927 passed, 0 failed (includes the 2 intentional `test.fails` WS-02 reproductions) |
| `cd processor && node --test` | 29 passed, 0 failed |
| `npx eslint .` | no output (clean) |
| `npx npm@11.6.2 audit --audit-level=low` | found 0 vulnerabilities |
| `npm run build` | succeeded |

Per-file vitest pass counts (all files passed):

`worker/audit.test.js` 30; `worker/index.test.js` 8; `tests/audit/sync-data.test.js` 11; `tests/app/app-units.test.js` 8;
`tests/dropdown-position.test.js` 3; `tests/integration/assets-mounts-designs.test.js` 7; `tests/integration/budget-caps.test.js` 5;
`tests/integration/jobs-processor.test.js` 11; `tests/integration/migration-planner.test.js` 7; `tests/integration/ui-clients.test.js` 6;
`tests/shared/apparatus-render.test.js` 56; `tests/shared/associations.test.js` 17; `tests/shared/cost.test.js` 19;
`tests/shared/fingerprint.test.js` 5; `tests/shared/ids.test.js` 25; `tests/shared/planner-diff.test.js` 19;
`tests/shared/planner-migrate.test.js` 35; `tests/shared/planner-ops.test.js` 73; `tests/shared/scene-spec.test.js` 28;
`tests/shared/validation.test.js` 143; `tests/studio-b1/sniff-geometry.test.js` 14; `tests/studio-b1/ui-logic.test.js` 11;
`tests/studio-b1/upload-queue.test.js` 15; `tests/studio-b2/jobs.test.js` 11; `tests/studio-b2/markup-layout.test.js` 15;
`tests/studio-b2/publish-admin.test.js` 21; `worker/test/core/auth.test.js` 16; `worker/test/core/legacy.test.js` 5;
`worker/test/core/migrate.test.js` 9; `worker/test/core/planner.test.js` 16; `worker/test/core/router.test.js` 8;
`worker/test/core/session-cron.test.js` 5; `worker/test/core/settings.test.js` 5; `worker/test/security/auth.test.js` 51;
`worker/test/security/headers-config.test.js` 10; `worker/test/security/objects.test.js` 28;
`worker/test/security/processor-api.test.js` 10; `worker/test/security/spend-and-prompt.test.js` 45;
`worker/test/studio/assets.test.js` 27; `worker/test/studio/gallery.test.js` 14; `worker/test/studio/jobs.test.js` 26;
`worker/test/studio/links-mounts-designs.test.js` 14; `worker/test/studio/media.test.js` 4; `worker/test/studio/processor.test.js` 31.

`node --test` files: `processor/test/processor.test.js` and `processor/test/security.test.js` (29 passed together).
