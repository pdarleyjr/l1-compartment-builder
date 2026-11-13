# Frontend / mobile audit — MBFD Ladder 1 Compartment Builder

- Baseline audited: `c9e0d0e` (= live production). Audit only: no source, config, worker or existing test was modified.
- Auditor model: Claude Sonnet 5.5 (`claude-sonnet-5-5`), unattended, on aiw-7070.
- Reproductions: `e2e/audit-frontend.spec.js` (32 tests × 3 Chromium projects = 96 runs; 4 skipped by design: drawer-only tests on the desktop project and FM-34 on touch projects).
- Evidence labels: **SOURCE VERIFIED** (read in code at `c9e0d0e`), **TEST VERIFIED** (reproduced by a Playwright test against the dev build with an in-memory fake Worker), **INFERRED** (reasoned from platform behaviour, not executable here).
- Nothing in this audit touched the production Worker, `l1.mbfdhub.com`, OpenAI or Cloudflare. Every Worker URL is intercepted with `page.route` (see `installFakeWorker`). All images are generated in the test.
- `AUDIT.md` was read but not trusted; every claim below is independently verified.

## How to read the tests

Every `FM-nn` test asserts the **correct** behaviour. A test annotated `test.fail()` is a CONFIRMED defect: it passes the suite today and will flip to "unexpected pass" the moment the defect is fixed, at which point the annotation is removed and the test stays as the regression guard. Tests whose title says *(not a defect)* or *(documents behaviour)* pass normally.

```
npx playwright test e2e/audit-frontend.spec.js --trace off --reporter=line
npx playwright test e2e/audit-frontend.spec.js -g "FM-11"      # one finding
```

Environment note (not a product issue): on this worker `@playwright/test` 1.59.1 wants Chromium build 1217 but the cache holds 1248, so the **existing** `e2e/l1.spec.js` also fails to launch here without help. I ran everything with `PLAYWRIGHT_BROWSERS_PATH=/tmp/pwb` (symlinks named `…-1217` → the cached `…-1248`). The spec also honours `L1_CHROMIUM_PATH` as an `executablePath` override. Parallel audit jobs on the same worker all start Vite on port 4173 (`reuseExistingServer:false`), so concurrent runs collide; I used a throw-away config in `/tmp` on another port while iterating and ran the standard command for the final result.

## Results of the required commands

| Command | Result |
|---|---|
| `npm ci` | OK (npm reports audit advisories; not in scope) |
| `npm run lint` | pass, no output |
| `npx vitest run` | 2 files, 45/45 passed |
| `npx playwright test --trace off --reporter=line` | **128 passed, 4 skipped, 0 failed** (36 baseline `l1.spec.js` + 92 audit; expected-fail tests count as passing) |
| `npx vite build --outDir /tmp/l1dist` | OK; see FM-28 |

## Summary table

| ID | Title | Severity | Evidence | Test (expected-fail unless noted) |
|---|---|---|---|---|
| FM-01 | Undecodable "image" (e.g. HEIC on Chromium) is stored raw and synced | Medium | TEST VERIFIED | FM-01 |
| FM-02 | `.heic` with empty MIME gets generic message that never mentions HEIC | Low | TEST VERIFIED | FM-02 |
| FM-03 | Every upload is downscaled to ≤1400 px JPEG q0.82; the original is discarded | Medium (High once photos become model references) | TEST VERIFIED | FM-03 |
| FM-04 | Transparent PNG flattened onto black | Low | TEST VERIFIED | FM-04 |
| FM-05 | GPS/EXIF metadata survival | Info — **not reproduced** (stripped) | TEST VERIFIED | FM-05 (passes) |
| FM-06 | EXIF orientation | Info — **not reproduced** (applied) | TEST VERIFIED | FM-06 (passes) |
| FM-07 | No multi-file selection | Medium | TEST VERIFIED | FM-07 |
| FM-08 | No "take photo" (capture) control | Medium | TEST VERIFIED | FM-08 |
| FM-08b | `Permissions-Policy camera=()` blocks `getUserMedia` (not `capture`) | Info | TEST VERIFIED / INFERRED | FM-08b (passes) |
| FM-09 | Upload validation errors not announced and displayed in the AI panel | Low | TEST VERIFIED | FM-09 (+ FM-09b passes) |
| FM-10 | Photo delete: no confirmation, no undo, syncs to the whole team | Medium | TEST VERIFIED | FM-10 |
| FM-11 | Deleted photos are resurrected by the add-only image merge | **High** | TEST VERIFIED | FM-11 |
| FM-12 | Carousel ignores arrow keys (and has no swipe) | Medium | TEST VERIFIED / SOURCE VERIFIED (swipe) | FM-12 |
| FM-13 | Active carousel dot has no accessible state | Low | TEST VERIFIED | FM-13 |
| FM-14 | Carousel footer clips Remove/Star with many photos | Medium | TEST VERIFIED | FM-14 |
| FM-15 | "Generating…" overlay and disabled button leak onto other compartments | Medium | TEST VERIFIED | FM-15 |
| FM-16 | AI result is an ordinary, instantly shared photo — no draft/approved state | **High** (blocks the roadmap) | TEST VERIFIED | FM-16 (+ FM-16b passes) |
| FM-17 | AI failure handling | Info — works (message shown, text kept) | TEST VERIFIED | FM-17 (passes) |
| FM-18 | AI generation has no cancel and no client timeout | Medium | TEST VERIFIED / SOURCE VERIFIED | FM-18 |
| FM-19 | "Device storage is full" appears only in the off-canvas drawer on phones | Medium | TEST VERIFIED | FM-19 (fails only on touch projects) |
| FM-20 | No error boundary: a malformed shared document blanks the app on every device | **High** | TEST VERIFIED | FM-20 |
| FM-21 | Closed mobile drawer is still keyboard/AT-focusable | Medium | TEST VERIFIED | FM-21 |
| FM-22 | Open drawer: no focus move, no Escape, no trap, no `aria-modal` | Medium | TEST VERIFIED | FM-22 |
| FM-23 | Contrast: star 1.48:1, remove 2.56:1, "Powered by" text 2.67:1 | Low | TEST VERIFIED | FM-23 |
| FM-24 | Full `/images` document re-downloaded every 5 s by every open device | **High** (for a photo-heavy product) | TEST VERIFIED | FM-24 |
| FM-25 | Low-end phone timing (4× CPU throttle) | Info | TEST VERIFIED | FM-25 (passes, records timings) |
| FM-26 | Print prints only the current slide, hides upload/AI controls | Info | TEST VERIFIED | FM-26 (passes) |
| FM-27 | Excel export has two sheets; no bundles, photos or renderings | Info | TEST VERIFIED | FM-27 (passes) |
| FM-28 | Bundle size | Info | TEST VERIFIED (build) | — |
| FM-29 | Stale AI panel copy ("Cloudflare Workers AI · Llama + Flux") | Low | SOURCE VERIFIED | — |
| FM-30 | `FileReader` has no `onerror`; `pendingNav` can get stuck | Low | SOURCE VERIFIED | — |
| FM-31 | No upload progress/cancel; resize runs on the main thread | Low | SOURCE VERIFIED + FM-25 timing | FM-25 |
| FM-32 | `App.jsx` is a 2363-line module; extraction plan below | Info | SOURCE VERIFIED | — |
| FM-33 | Photos live as base64 in `localStorage` (~5 MB): 5 detailed photos fill it | Medium | TEST VERIFIED | FM-33 |
| FM-34 | `Sidebar` is defined inside `App`: full remount (focus/scroll loss) on every re-render | Medium | TEST VERIFIED | FM-34 |
| FM-35 | iOS Safari coverage and risks | Info | INFERRED | — |

**Counts by severity** (36 IDs = FM-01…FM-35 plus FM-08b; FM-05, FM-06 and FM-17 are verified non-defects, listed as Info): **Critical 0 · High 4** (FM-11, 16, 20, 24) **· Medium 14** (FM-01, 03, 07, 08, 10, 12, 14, 15, 18, 19, 21, 22, 33, 34) **· Low 8** (FM-02, 04, 09, 13, 23, 29, 30, 31) **· Info 10** (FM-05, 06, 08b, 17, 25, 26, 27, 28, 32, 35). FM-16b is an evidence test attached to FM-16, not a separate finding.

---

## Findings

### FM-01 — Undecodable "image" is stored raw and synced (Medium)
- **Where:** `src/App.jsx:2084` (`img.onerror = () => resolve(dataUrl)`), consumed at `:1892-1894`.
- **Evidence:** TEST VERIFIED.
- **Repro:** `FM-01 an undecodable file claiming image/* is rejected, not stored raw` — upload `IMG_0001.HEIC` with `type: image/heic` (an ISO-BMFF `ftypheic` header + junk). Observed: stored `data:image/heic;base64,AAAAGGZ…` in `l1-compartment-builder-uploads` (no error shown, no alert). On a device whose browser cannot decode HEIC (Chromium on Linux/Windows/Android, most desktops) the carousel shows "Image not available" and the unusable blob is pushed to the shared `/images` document for the whole team.
- **Root cause:** the decode-failure fallback returns the **original, un-resized, un-validated** data URL. The 12 MB cap is on the file, so up to ~16 MB of base64 can reach `localStorage` and `/images`.
- **Correction (narrow):** make `compressImage` reject on `onerror`/`decode()` failure; `handleFile` catches it and shows "This photo can't be read on this device — export it as JPEG" (also fixes the quota risk of raw 12 MB blobs). Do not store anything.
- **Regression test to keep:** FM-01 as written (remove `test.fail`).

### FM-02 — `.heic` with empty MIME gets a generic message (Low)
- **Where:** `src/App.jsx:1879-1882`. **Evidence:** TEST VERIFIED (`FM-02`).
- **Repro/observation:** Chromium on Windows/Linux/Android reports `File.type === ''` for `.heic`; `file.type.startsWith('image/')` fails and the user sees "Choose a PNG, JPEG, or WebP image." (it does at least mention JPEG). HEIC is never named, so a firefighter does not learn that their iPhone "High Efficiency" photo is the cause.
- **Correction:** detect `.heic/.heif` by extension and say so; combine with FM-01 wording.
- **Test to keep:** FM-02.

### FM-03 — Resized copy is the only copy; fine detail is lost (Medium → High for reference photos)
- **Where:** `src/App.jsx:2070-2088` (`compressImage(dataUrl, maxDimension = 1400, quality = 0.82)`; `canvas.toDataURL('image/jpeg', quality)`), call site `:1887-1894`; original never kept; no `File`/`Blob` retained; nothing uploaded at full size.
- **Evidence:** TEST VERIFIED.
- **Quantification (FM-03):** a 3000×2000 PNG (122 KB) → **1400×933 `image/jpeg`**, 11.4 K chars; a 1-px alternating line pattern (worst case for downscale, stand-in for diamond-plate texture, small labels, hose/strap detail) drops to contrast std **0.0 vs 127.5** in the source, i.e. completely averaged away. Output is always JPEG regardless of input format; scale is `min(1, 1400/longEdge)` so small images are re-encoded (generation loss) but not resized. For a 12 MP phone photo (4000×3000) that is **~10.7× fewer pixels**; a 3 mm bolt head at arm's length is ~2–3 px.
- **Why it matters for the roadmap:** the planned "reference photos → gpt-image" flow and "mount photo" association depend on detail (tool outlines, bracket geometry). Detail that was thrown away at upload can never be recovered.
- **Correction:** keep two derivatives per photo, both generated client-side: a ≤2560 px JPEG q0.9 "reference" (≈0.5–1 MB) uploaded to object storage (R2) and a ~800 px thumbnail used in the carousel; stop storing either as base64 in `localStorage`/KV (see FM-24, FM-33). Preserve PNG for images with alpha (FM-04).
- **Test to keep:** FM-03 (assert long edge ≥ 2400 for a 3000 px source).

### FM-04 — Transparent PNG flattened onto black (Low)
- **Where:** `src/App.jsx:2082` (JPEG re-encode). **Evidence:** TEST VERIFIED (`FM-04`): the corner pixel of a fully transparent PNG becomes `rgba(0,0,0,255)`.
- **Impact:** annotated diagrams / exported renderings with transparent backgrounds become black blocks. Low today (users mostly upload photos), but the roadmap includes mounting reference drawings.
- **Correction:** fill the canvas white before `drawImage`, or keep PNG when the source has alpha.
- **Test to keep:** FM-04.

### FM-05 — GPS/EXIF metadata survives? **Not reproduced** (Info)
- **Evidence:** TEST VERIFIED (`FM-05`, passes, kept as a guard). A JPEG built in the test with an APP1 `Exif` segment carrying Orientation + GPS IFD (25°46′30″N 80°7′15″W) was uploaded; the stored JPEG contains neither `Exif\0\0` nor `II*\0`. Canvas re-encoding strips it.
- **Caveat that makes FM-01 relevant:** the *fallback* path of FM-01 stores the original bytes untouched, so EXIF/GPS **would** survive there (e.g. a corrupt-but-EXIF-bearing JPEG, or an HEIC from a device that decodes it but then fails the canvas path). Fixing FM-01 closes this. Also: if FM-03's fix keeps a "reference" derivative made by canvas, metadata stays stripped; if it ever uploads the original file, strip EXIF/GPS server-side or client-side first (site photos of a fire apparatus bay shouldn't carry station coordinates).

### FM-06 — EXIF orientation: **Not reproduced** (Info)
- **Evidence:** TEST VERIFIED (`FM-06`, passes). A 200×100 JPEG tagged Orientation=6 is stored as **100×200** with the yellow top-left marker moved to the top-right, i.e. pixels are rotated (Chromium's `image-orientation: from-image` default is honoured by `drawImage`). The orientation tag itself is gone after re-encode, which is correct. Safari ≥13.4 behaves the same (INFERRED). Keep as guard before changing the pipeline (e.g. `createImageBitmap` ignores orientation unless `imageOrientation: 'from-image'` is passed).

### FM-07 — No multi-file selection (Medium)
- **Where:** `src/App.jsx:2013` (`<input type="file" accept="image/*">`, no `multiple`), `:1877` (`e.target.files[0]`). **Evidence:** TEST VERIFIED (`FM-07`: attribute missing).
- **Impact:** a firefighter photographing a compartment from 6 angles must open the picker 6 times; the planned "Add Tool Photos" is inherently multi-photo.
- **Correction:** add `multiple`, iterate files sequentially with per-file result (see FM-09/FM-31 for progress and partial failure).
- **Test to keep:** FM-07.

### FM-08 — No "take photo" control; `Permissions-Policy` impact (Medium; FM-08b Info)
- **Where:** `src/App.jsx:2013`; `public/_headers:5` (`Permissions-Policy: camera=(), microphone=(), …`). **Evidence:** TEST VERIFIED / INFERRED.
- **What the UI offers on a phone today:** a single "Upload rendering or photo" label. With `accept="image/*"` Android Chrome and iOS Safari present a chooser that includes "Take photo/Camera" (INFERRED — platform UI), but the app cannot steer users to the camera, cannot ask for the rear camera, and the label says "rendering or photo".
- **`camera=()` effect:** it disables `getUserMedia` / `getDisplayMedia` camera access for the page and every frame. **TEST VERIFIED (`FM-08b`)**: with that header, `document.permissionsPolicy.allowsFeature('camera')` is false and in-page capture is `NotAllowedError`. It does **not** govern `<input type="file" capture>` / `accept="image/*"`: those hand off to the OS camera app/picker (INFERRED — cannot be exercised in headless Chromium). So a native-camera button via `capture="environment"` is safe under the current header; a live-preview in-app camera (WebRTC `getUserMedia`, useful for guided "mount photo" framing) would require changing the header to `camera=(self)`. Make that decision explicitly in the roadmap; do not loosen it by default.
- **Correction:** add a second input `<input type="file" accept="image/*" capture="environment">` labelled "Take photo" beside the existing "Choose photo(s)" input; keep both ≥44 px.
- **Test to keep:** FM-08 (expects one `input[capture]`), FM-08b as header documentation.

### FM-09 — Validation errors are not announced and live in a distant panel (Low)
- **Where:** `src/App.jsx:2048-2053` (the shared `aiError` div, no `role`/`aria-live`), upload validation `:1877-1890`. **Evidence:** TEST VERIFIED (`FM-09`; `FM-09b` shows the messages themselves are right for >12 MB and non-image files and nothing is stored).
- **Impact:** screen-reader users get no feedback; the same state string (`aiError`) is shared by upload errors and AI errors, so an upload error can be cleared or overwritten by an AI action, and is rendered under the AI textarea rather than next to the upload button.
- **Correction:** separate `uploadError` from `aiError`, render each next to its control with `role="alert"`.
- **Test to keep:** FM-09 + FM-09b.

### FM-10 — Delete: no confirmation, no undo (Medium)
- **Where:** `src/App.jsx:1999-2003` → `handleDeleteUploadedImage` `:697-713`. **Evidence:** TEST VERIFIED (`FM-10`: no dialog, no Undo, image gone immediately). The inventory remove already uses `window.confirm` (`:769`), so this is inconsistent with the app's own pattern.
- **Impact:** a stray tap on the 44 px X (adjacent to the 44 px star on a phone) deletes a shared photo for every device, with no recovery (and see FM-11 for the sync consequences).
- **Correction:** an "Undo" toast for ~8 s (soft-delete with a tombstone, which FM-11 needs anyway) is better for gloved hands than a modal; at minimum `window.confirm`. Move Remove away from Star.
- **Test to keep:** FM-10.

### FM-11 — Deleted photos are resurrected by the add-only merge (**High**)
- **Where:** `src/App.jsx:548-556` (pull merge: keeps every local image, appends every remote image whose `uid` is missing locally) and `:703-712`; push of the full set at `:629-650`. **Evidence:** TEST VERIFIED (`FM-11`).
- **Repro (single page, fake Worker):** server doc holds photo `devB-1`; page loads it; user presses Remove; the app PUTs the doc without it; the fake then serves a newer doc that still contains `devB-1` (what a second device that has not yet deleted it would push); within one 5 s poll the photo is back. Expected: it stays deleted.
- **Root cause:** there are no tombstones; "absent" is indistinguishable from "not yet seen". Any device that still holds the photo and pushes anything (every image PUT sends the whole document) re-adds it everywhere. It also means a delete only "sticks" if every other device deletes it too.
- **Correction:** add `deleted: {uid: ts}` (or an `isDeleted`/`deletedAt` field on the item) to the image document; merge by uid with last-writer-wins on `updatedAt`; prune tombstones after N days. This is a data-model change shared with the worker audit part — flag to that author. Needed anyway for draft→approved status (FM-16).
- **Test to keep:** FM-11.

### FM-12 — Carousel is not keyboard- or swipe-operable (Medium)
- **Where:** `src/App.jsx:1930-1945` (only Prev/Next/dot buttons; no `onKeyDown`, no pointer/touch handlers on the image region). **Evidence:** TEST VERIFIED for keys (`FM-12`: focus a dot, press ArrowRight, slide does not change); swipe SOURCE VERIFIED (no `touch*`/`pointer*` handlers anywhere in the carousel).
- **Impact:** touch-first product with no swipe; keyboard users must Tab through up to N 44 px dot buttons (N grows with the photo features). Prev/Next buttons are `bg-black/30` (low contrast over bright photos).
- **Correction:** `role="group" aria-roledescription="carousel"` on the wrapper, ArrowLeft/Right on the wrapper, CSS `scroll-snap` strip or simple pointer-delta swipe; collapse dots into "3 / 9" text + prev/next once N > 6 (also fixes FM-14).
- **Test to keep:** FM-12.

### FM-13 — Active dot has no accessible state (Low)
- **Where:** `src/App.jsx:1965-1978`; also `group-hover:bg-slate-400` on `:1975` is dead (no `group` ancestor). **Evidence:** TEST VERIFIED (`FM-13`). Fix: `aria-current="true"` on the active dot (or `aria-pressed`), plus a live "Image 2 of 5" text. **Test to keep:** FM-13.

### FM-14 — Footer controls are clipped when a compartment has many photos (Medium)
- **Where:** `src/App.jsx:1959-2004` — one `w-11 h-11` dot button per image inside a `shrink-0` flex group inside `overflow-hidden`. **Evidence:** TEST VERIFIED (`FM-14`, 20 photos).
- **Observed:** container right edge vs Remove-button right edge: desktop 832 vs **1329** px, tablet 786 vs **1073**, Pixel 5 377 vs **1065**. The Star and Remove buttons are pushed outside the clipped container: the user cannot feature or delete a photo once a compartment has roughly 6 or more photos on a phone (the exact threshold depends on title length; the same happens at roughly 12-15 on a tablet or desktop split view). Reaching 6 is routine under the "tool photos + mount photo + renderings" roadmap.
- **Correction:** see FM-12 (counter instead of dots; or wrap/scroll thumbnails in a separate strip) and place Star/Remove in their own row.
- **Test to keep:** FM-14.

### FM-15 — "Generating…" state leaks onto other compartments (Medium)
- **Where:** `<ImageCarousel>` at `src/App.jsx:1500` has no `key`; `aiLoading`/`aiError`/`aiText` are its component state (`:1824-1826`) and only some are reset in the `[compId]` effect (`:1836`, which does **not** reset `aiLoading`). The render is a plain function call (`renderCompartment`), so React reuses the same instance across LS1→LS2. **Evidence:** TEST VERIFIED (`FM-15`).
- **Repro:** start a generation on LS1 (fake Worker delayed 5 s), navigate to LS2: the black "Generating AI rendering…" overlay and disabled Generate button appear over **LS2's** photo, though the request belongs to LS1. When it finishes the image lands in LS1 (the closure captured `comp.id`) while the user, on LS2, sees the overlay vanish with nothing happening; `pendingNav` was reset by the effect so the carousel does not navigate.
- **Impact:** confusing; blocks generating a second compartment; with a 30–60 s gpt-image call and per-compartment jobs this becomes a daily annoyance.
- **Correction:** `key={comp.id}` on `<ImageCarousel>` (one-line) **plus** move generation jobs into app-level state keyed by compartment (`{[compId]: {status, error, startedAt}}`) so each compartment page reflects its own job and results are not lost on navigation.
- **Test to keep:** FM-15.

### FM-16 — No draft vs approved: AI output is an ordinary shared photo (**High**)
- **Where:** `src/App.jsx:742-743` (`handleUploadImage(compId, { dataUrl, title: 'AI Rendering', fileName: 'ai-rendering.png' })`), carousel auto-navigates to it (`:1858-1865`), image push `:629-650`. **Evidence:** TEST VERIFIED (`FM-16`, `FM-16b`).
- **Observed (FM-16b):** within ~1 s of the response the unlabeled "AI Rendering" is PUT to the shared `/images` document; the stored item has only `{uid,dataUrl,title,fileName}` — no `status`, `prompt`, `sourceImages`, `model`, `createdBy`, `createdAt`. So every generation immediately appears on every teammate's screen, indistinguishable from a real photograph (title "AI Rendering" is the only hint and is repeated for every run), cannot be marked as not-approved, cannot be regenerated/edited from its inputs (nothing is recorded), can be set as "featured", and is carried into the print view (FM-26) if it is the current slide.
- **Why High:** for a fire-service plan, a plausible but wrong generated image presented as the compartment layout is a safety/credibility risk; the roadmap's draft→approved workflow cannot be bolted on without a data-model change.
- **Correction:** extend the image record: `{uid, kind:'photo'|'tool-photo'|'mount-photo'|'rendering', status:'draft'|'approved', parentUids[], prompt, model, createdAt}`; show a persistent red "DRAFT — not approved" ribbon (and exclude drafts from featured/print/export) until someone taps "Approve"; keep drafts in a "Drafts" strip, not the main carousel.
- **Test to keep:** FM-16 (expects a visible "Draft" label) and FM-16b updated to assert drafts are not auto-pushed to the shared featured set.

### FM-17 — AI failure handling works (Info, not a defect)
- **Evidence:** TEST VERIFIED (`FM-17`, passes). With the fake returning 502 `{error}`: the server message is shown, the typed instructions are preserved, the Generate button is re-enabled. Retry is "click again". Keep as a guard when the job model changes.

### FM-18 — No cancel, no client-side timeout (Medium)
- **Where:** `handleGenerateAIImage` `src/App.jsx:731-760` (plain `fetch`, no `AbortController`), overlay `:1938-1946` says "This may take up to 60 seconds" but offers no Cancel. **Evidence:** TEST VERIFIED (`FM-18`: no Cancel button during generation) + SOURCE VERIFIED (no abort/timeout).
- **Impact:** a stalled mobile connection leaves the spinner forever; the only recovery is reloading, which loses the typed instructions.
- **Correction:** `AbortController` + 90 s timeout + Cancel button; show elapsed time.
- **Test to keep:** FM-18.

### FM-19 — "Device storage is full" is hidden on phones (Medium)
- **Where:** `src/App.jsx:1111-1116` (only inside `Sidebar`). **Evidence:** TEST VERIFIED (`FM-19`, fails as expected on tablet and phone projects only): with `localStorage.setItem` throwing `QuotaExceededError`, the alert exists but its box is at x = **−244 px** (off-canvas); on desktop it is at x = 12.
- **Also:** the copy says "Export a backup and remove uploaded images" but **Export Excel contains no images** (FM-27), so there is no backup path for photos.
- **Correction:** render the storage/sync warnings in a persistent banner in the main column (top bar) with `role="alert"`; fix the text; see FM-33 for the real fix (stop storing photos in `localStorage`).
- **Test to keep:** FM-19.

### FM-20 — No error boundary; one bad shared document blanks every device (**High**)
- **Where:** `src/main.jsx` (bare `<App/>`), `src/App.jsx:~440-458,~516-521` (server payload fields set into state without validation). **Evidence:** TEST VERIFIED (`FM-20`).
- **Repro:** fake `/state` returns `customTools: {}`. The pull applies it (`setCustomTools`), `[...customTools]` throws "customTools is not iterable" during render, React unmounts the tree: `#root` text length **0** (white screen). Because the bad value is re-pulled on every load, reloading does not recover and **every device** is bricked until the server doc is fixed. The same applies to `bundles`, `customDimensions`, `removedItems`, and `allocations` slot values.
- **Impact:** also makes the planned new fields (photo records, rendering status) risky: any schema skew between an old cached bundle and a new Worker document can blank the app in the field.
- **Correction:** (1) a top-level `ErrorBoundary` with "Something went wrong — Reload / Use local copy / Copy diagnostics"; (2) a pure `sanitizeRemoteState(payload)` that type-checks each field before `setState` (unit-testable in vitest); (3) keep the last known-good local state.
- **Test to keep:** FM-20.

### FM-21 / FM-22 — Mobile drawer accessibility (Medium)
- **Where:** `src/App.jsx:~1778-1791` (wrapper only uses `-translate-x-full pointer-events-none` when closed), `:~1769-1776` (backdrop is `aria-hidden` div with only `onClick`). **Evidence:** TEST VERIFIED (`FM-21`, `FM-22` on tablet/phone).
- **FM-21:** the closed drawer's 20+ buttons are still focusable (`document.activeElement === button` after `focus()`); keyboard/switch/AT users on a tablet with a keyboard Tab into invisible controls and may navigate away without seeing it.
- **FM-22:** opening the drawer does not move focus into it (`focus inside drawer: false`), Escape does not close it (drawer x stays 0 after Escape), there is no focus trap, no `role="dialog"`/`aria-modal`, and focus is not returned to the menu button on close.
- **Correction:** closed: `inert` + `aria-hidden` (or `visibility:hidden` after the transition); open: focus the Close button, trap Tab, Escape closes, return focus to "Open navigation menu".
- **Tests to keep:** FM-21, FM-22.

### FM-23 — Contrast of new-ish controls (Low)
- **Where:** star `text-slate-300` on white (`:1992`), Remove X `text-slate-400` (`:2000`), "Powered by…" `text-[10px] text-indigo-400` on indigo-50 (`:2025`). **Evidence:** TEST VERIFIED (`FM-23`): star **1.48:1**, remove **2.56:1** (need 3:1, WCAG 1.4.11), helper text **2.67:1** (need 4.5:1, 1.4.3). The existing axe test (`l1.spec.js`) does not flag them because axe cannot evaluate the gradient background and treats icon-only buttons as non-text.
- **Related:** 9 px/10 px text (`text-[9px]` ×7, `text-[10px]` ×20, `text-[11px]` ×1) used for badges, helper text and sync status. On a phone outdoors this is below a comfortable reading size; the "locked"/"featured" badges are 9 px.
- **Correction:** star/remove `text-slate-600` (contrast 7.6:1); helper text ≥12 px and ≥ indigo-700; `bg-white/90` backing on the Prev/Next buttons.
- **Test to keep:** FM-23.

### FM-24 — Whole image document re-downloaded every 5 s (**High** for the roadmap)
- **Where:** `src/App.jsx:481-494,626` — the pull loop calls `fetchJson('images')` unconditionally every 5 s on every open tab; the document contains every photo as a base64 data URL; the push (`:629-650`) PUTs the same whole document. **Evidence:** TEST VERIFIED (`FM-24`).
- **Measured (fake server, 5 photos × 300 KB = 1.5 MB, **never changing**):** 4 full downloads in 11.5 s = **6.0 MB**, i.e. ≈ **520 kB/s per open device, continuously**. On a cellular connection with 3 firefighters + a dashboard open that is ~1.5 MB/s of pure waste plus 4× JSON parse of ~1.5 MB on the phone's main thread every 5 s (see FM-25). Every upload re-PUTs all images (1 s debounce).
- **Correction (minimum):** ask for a version first (`GET /images?since=<serverTs>` → 304/204) or a tiny `GET /images/meta`; **real fix:** photos as individual objects in R2, with only metadata (uid, kind, status, thumbnail URL, ts) in the shared doc; clients fetch image bytes lazily by URL (HTTP-cacheable, `loading="lazy"`). The Worker-side change belongs to the backend audit part; the frontend test asserts ≤1 full download in 11.5 s.
- **Test to keep:** FM-24.

### FM-25 — Low-end phone timing (Info)
- **Method:** Chromium CDP `Emulation.setCPUThrottlingRate=4`, fake Worker, three device profiles (see test output). Image generated before throttling.
- **Results (4× throttle, aiw-7070 under load from parallel jobs, so treat as indicative):**

| Profile | App ready (overlay gone) | Open LS1 (combobox visible) | Upload 4000×3000 JPEG (2.4 MB) → visible |
|---|---|---|---|
| Desktop Chrome 1440×900 | 1148 ms | 400 ms | 2843 ms |
| iPad gen 7 (Chromium) | 849 ms | 838 ms | 3125 ms |
| Pixel 5 (Chromium) | 813 ms | 746 ms | 3183 ms |

  The first paint is acceptable; **upload is the long pole** — ~3 s of mostly main-thread work for one 12 MP photo at 4× (FileReader → data URL → `Image` decode → canvas → `toDataURL`), during which the UI does not show progress (FM-31). Multiplied by multi-select (FM-07) this will block interaction for tens of seconds. Prefer `createImageBitmap(file, {resizeWidth})` / `OffscreenCanvas` in a worker and process files sequentially with a progress indicator.
- Real-device INFERRED notes: a 48 MP iPhone photo (up to the 12 MB cap) decodes to ~190 MB RGBA; older iOS Safari limits canvas area (≈16.7 MP) and can silently yield a blank canvas → another reason for FM-01's "never store on failure".

### FM-26 — Print (Info, documents behaviour)
- **Evidence:** TEST VERIFIED (`FM-26`, `page.emulateMedia({media:'print'})` on LS2 with 3 images). Only the **current** carousel image prints (1 of 3), the Upload and AI panels are hidden (`print:hidden`, and `button {display:none}` in `src/index.css`), no horizontal overflow. `@page` is letter landscape, 0.5 in margins. There is no print path for additional photos, mounting photos or an approved rendering; with the roadmap, print should render the **approved** rendering (or featured) + a thumbnail grid of mount photos, and drafts must never print.
- **Risk:** `.min-h-[260px]{min-height:0}` and `.overflow-hidden{overflow:visible}` rules key on Tailwind class names, so any new photo UI must reuse `print-image-container`/`print:hidden` or it will print unexpectedly.

### FM-27 — Excel export (Info, documents behaviour)
- **Evidence:** TEST VERIFIED (`FM-27`, unzip of the downloaded workbook). Sheets: `Compartments` (slots × compartments) and `Inventory Status`. Contains no bundles, no photo counts, no rendering status, no mounting notes (`src/App.jsx:948-1006`). `handleExportExcel` has no try/catch (a failed dynamic import is an unhandled rejection with no UI message). The export is therefore **not** a backup of photos (contradicts the FM-19 message).
- **Roadmap:** add a `Photos & Renderings` sheet (compartment, kind, status, title, created, approved by) and a `Bundles` sheet; keep images out of the workbook (or link to approved thumbnails).

### FM-28 — Bundle size (Info)
`npx vite build --outDir /tmp/l1dist`: `index.js` **230.5 kB (69.9 kB gzip)**, `index.css` 29.1 kB (6.0 kB gzip), lazy `write-excel-file/browser` chunk 70.8 kB (19.7 kB gzip) loaded only on export (good). Images in `public/images`: 2.1 MB of WebP, `Cache-Control: immutable` (`public/_headers`). The 230 kB main chunk is acceptable; the cost of the photo features will be in runtime memory/network (FM-24, FM-33), not JS. `loading="lazy"` on the carousel image plus `key={cur.src}` remounts the `<img>` on each slide change (a visible flash with large data URLs, since each slide decodes a 100–900 KB data URL synchronously); `CompartmentImage` uses `loading="eager" fetchpriority="high"` appropriately for the LCP overview.

### FM-29 — Stale AI copy (Low)
`src/App.jsx:2025` "Powered by Cloudflare Workers AI · Llama + Flux" and `:2031` "photorealistic rendering of this exact compartment" will be false once gpt-image is used and over-promise accuracy (see FM-16). Replace with neutral copy ("Draft concept image — verify against the real compartment").

### FM-30 — `FileReader` error path and `pendingNav` race (Low)
`src/App.jsx:1891-1896`: `reader.onerror` is not set (a read failure — e.g. a file revoked by the OS picker — is silent), and `pendingNav.current = true` is set inside `onload`, but **reset by the `[compId]` effect** if the user navigates meanwhile. `compressImage` has no timeout. INFERRED/SOURCE VERIFIED; fix together with FM-01/FM-31 (promise-based pipeline with typed errors).

### FM-31 — No upload progress, cancel or partial-failure state (Low)
Upload shows no spinner/progress (nothing between choosing the file and the thumbnail appearing; ~3 s at 4× throttle per 12 MP photo, FM-25), no cancel, and with multi-select (FM-07) there is no per-file result list ("3 added, 1 failed: IMG_4.HEIC"). SOURCE VERIFIED. Implement as a small `useUploadQueue` (see extraction plan) that exposes `{items:[{name,status,error}]}`.

### FM-33 — Photos in `localStorage` hit the quota after ~5 detailed photos (Medium)
- **Where:** `src/App.jsx:389-402,624-632` — `uploadedImages` (all base64) is `JSON.stringify`-ed into one key on every change; `QuotaExceededError` is caught and only sets `storageError` (FM-19).
- **Evidence:** TEST VERIFIED (`FM-33`): 12 uploads of an 887 KB, 1400×1050 high-entropy JPEG (diamond-plate/gravel-like) → only **5 of 12** stored, **4.89 M chars** of the ~5 M localStorage budget; photos 6–12 exist in React state and are pushed to the Worker but are not persisted locally, so an offline reload loses them. With smoother photos (ordinary scenes compress to 100–300 KB at 1400 px) the ceiling is ~10–25 photos for the whole app (all compartments, all devices that haven't synced yet). Whole-map re-serialisation also grows O(total) per change.
- **Correction:** move photos out of `localStorage` into IndexedDB (blobs) or the Cache API, keep only metadata in `localStorage`; see FM-24 for the server side. Interim: surface the failure per photo ("not saved on this device").
- **Test to keep:** FM-33.

### FM-34 — `Sidebar` is an inner component: remount on every render (Medium)
- **Where:** `src/App.jsx:1010` (`const Sidebar = () => (…)` declared inside `App`) used as `<Sidebar />` at `:1790`. A new function identity per render means React unmounts and remounts the entire sidebar subtree whenever `App` re-renders (every remote pull that changes state, every slot edit).
- **Evidence:** TEST VERIFIED (`FM-34`, desktop): focus a sidebar button, let a teammate's change arrive through the 5 s poll → `document.activeElement` becomes `<body>`; keyboard users lose their place, scroll position of the sidebar resets, and on phones with the drawer open the list jumps.
- **Correction:** call it as a function (`{renderSidebar()}`) or hoist to a top-level component with props (`activeTab`, `onNav`, `counts`, `syncStatus`, …) — pure move, no behaviour change (see extraction plan step 3).
- **Test to keep:** FM-34.

### FM-35 — iOS Safari: coverage and risks (Info)
**Not covered by any test here.** Playwright WebKit needs the Ubuntu 24.04 libraries on this 26.04 worker, so it must run in `mcr.microsoft.com/playwright:v1.59.1-noble` (Docker), which agent jobs cannot run; the cache contains `webkit-2370` but it is not usable here. Coverage status: Chromium emulation of iPad/Pixel profiles only (`l1.spec.js` + this spec); **no WebKit, no real iOS device**. Recommended follow-up for the coordinator: run `docker run --rm --ipc=host -v "$PWD":/src -w /src mcr.microsoft.com/playwright:v1.59.1-noble npx playwright test -c <config with webkit project>`; this spec is browser-neutral except FM-25 (CDP throttling, Chromium only) and `test.use` launch options.

iOS-specific risks (INFERRED from platform behaviour/source):
1. **HEIC:** with `accept="image/*"` iOS usually transcodes library picks to JPEG, and Safari decodes HEIC natively, so the FM-01 path rarely triggers on iPhones; the danger is a HEIC stored by an iPhone user and shown to a Chromium/Android teammate (FM-01 syncs it to everyone).
2. **`capture`:** `capture="environment"` is supported on iOS Safari; without it (FM-08) iOS shows the picker sheet with Photo Library/Take Photo/Choose File.
3. **Viewport units:** `h-[100dvh] min-h-screen overflow-hidden` (`src/App.jsx:1755`): `min-h-screen` (=100vh) is **taller than the visible area** while Safari's toolbar is expanded; combined with `overflow-hidden` on the root and `overscroll-behavior: none`, the bottom of long pages/drawers (Reset All at the end of the sidebar) can be cut off behind the toolbar. No `visualViewport` handling; the on-screen keyboard overlays inputs inside `overflow-hidden` containers (the search box of `ComboSlot` is positioned by `dropdown-position.js` using `innerHeight`).
4. **localStorage in Private Browsing:** modern Safari allows storage but with a small quota and clearing on tab close; failure is the same path as FM-19/FM-33, and the warning is hidden on phones.
5. **Canvas memory limits:** large photos (12–48 MP) hit canvas area/memory limits; `onerror`→raw fallback (FM-01) then stores the original. Also `toDataURL` of 4000×3000 in older Safari can return `data:,`.
6. **Back-forward cache / background tabs:** iOS suspends timers, so the 5 s poll and the 300 ms/1 s debounced pushes stop in background; an edit made just before locking the phone may not be pushed (existing sync design, relevant to photos because the image push is a 1 s debounce).

---

## Additional checks (no defect found)

- **Touch targets:** the carousel Prev/Next, dots (44 px), Star, Remove, upload label (`min-h-11`) all satisfy 44 px (`.touch-target`). The existing test only checks controls present on the first screens; the 20-photo state in FM-14 is the first state where they stop being reachable, not undersized.
- **Axe (WCAG 2 A/AA):** existing test passes critical/serious; the gaps above (gradients, icon contrast) are outside axe's reach.
- **Dropdown/Combobox focus:** existing behaviour is fine (Escape, ArrowDown/Up, Enter).
- **Dialogs:** the app uses only `window.confirm` and inline panels; there is no modal component. The new photo/rendering flows (approve/regenerate/delete/permissions) need one accessible dialog primitive (focus trap, Escape, return focus), which also fixes FM-22.
- **Bundle names / bundle prompt**: inline, `onKeyDown` Enter; fine.

## App.jsx map and low-risk extraction plan

`src/App.jsx` is 2363 lines, one default export `App` (384-1819, ~1435 lines: 29 `useState`, 6 `useRef`, 3 `useMemo`, 8 `useEffect`) plus 5 local components.

| Lines | Content | Pure? |
|---|---|---|
| 1-14 | imports, `WORKER_URL`, `BUILD_VERSION` | — |
| 15-83 | `MASTER_INVENTORY`, `INVENTORY_BY_NAME` | data |
| 86-222 | `DIMENSIONS`, `VISUAL_DESCRIPTIONS` | data |
| 223-306 | `SLOTS_PER_COMPARTMENT`, `STORAGE_KEY`, `V3_RENAMES`, `CONSOLIDATION_RENAMES`, `COMPARTMENTS` (246), `OVERVIEWS`, `COMP_LABEL`, `BUNDLE_COLORS`/`nextBundleColor`, `COMPARTMENT_SPECS` | data/pure |
| 307-362 | `generateUid`, `buildEmpty`, `migrateAllocations`, `loadSaved` (localStorage v2/v3/v4 migration) | pure(ish) |
| 364-382 | `CompartmentImage` | component |
| 384-1819 | `App` |
| 385-433 | state: tab, allocations, customQtys, customTools, **uploadedImages** (389), **featuredImages** (403), sync/storage flags, removedItems, customDimensions, editing, bundles, bulk-fill |
| 440-458 | `effectiveInventory`, `effectiveDimensions`; 459 `getQty` |
| 461-475 | effect: autosave state → `localStorage` |
| 477-502 | effect: debounced **state push** (PUT /state) |
| 504-589 | effect: **5 s pull** of /state and /images, merge (images merge 548-575) |
| 591-622 | `placedStats`, `totalPlaced`, `totalReq`, `getOptions` |
| 624-660 | effects: persist uploads/featured; **debounced image push** (629-650); persist removed/cdims |
| 662-675 | effect: reset transient UI on tab change |
| 690-760 | image handlers: upload, delete, set-featured, **AI generate** (731) |
| 762-850 | inventory handlers (add/remove/edit) |
| 851-946 | slot/bundle/bulk handlers, reset |
| 948-1006 | `handleExportExcel` |
| 1008-1126 | `nav`, **`Sidebar`** (1010, inner component, FM-34) |
| 1128-1350 | `renderInventory` |
| 1351-1395 | `renderOverview` |
| 1396-1747 | `renderCompartment` (carousel mount 1500; slots, bundles, bulk-add) |
| 1749-1818 | `return` (loading overlay, drawer, main) |
| 1821-2068 | `ImageCarousel` (state 1822-1828, effects 1836/1858, `handleFile` 1876, `handleGenerateAI` 1900, UI) |
| 2070-2088 | `compressImage` |
| 2090-2266 | `ComboSlot` | 
| 2268-2335 | `AddToolForm`; 2337 `SideBtn`; 2348 `CompBtn` |

**Extraction plan (each step is a pure move or a thin wrapper, can ship alone, and keeps `l1.spec.js` green):**

1. **Data modules (zero logic change):** `src/data/inventory.js` (MASTER_INVENTORY, DIMENSIONS, VISUAL_DESCRIPTIONS, COMPARTMENT_SPECS), `src/data/compartments.js` (COMPARTMENTS, OVERVIEWS, COMP_LABEL, SLOTS_PER_COMPARTMENT). Cuts ~330 lines; new features read compartment metadata from here.
2. **`src/lib/storage.js`** (STORAGE_KEY, `loadSaved`, `migrateAllocations`, `buildEmpty`, `generateUid`) + unit tests in vitest (the repo already has vitest).
3. **Fix FM-34 as a move:** `src/components/Sidebar.jsx` top-level with props; `SideBtn`/`CompBtn` go with it.
4. **`src/lib/images.js` — the new photo foundation:** `readImageFile(file) → {blob, width, height}` (typed errors, no raw fallback — FM-01), `makeDerivatives(blob) → {reference, thumb}` (FM-03/04), EXIF-stripping guard (FM-05/06 become unit/e2e regressions). Pure + testable; replaces `compressImage` behind the same call.
5. **`src/lib/imageStore.js`:** model `{uid, kind, status, parentUids, title, createdAt, deletedAt}` + `mergeImages(local, remote)` with tombstones (FM-11) — a pure reducer, unit-tested in vitest; replaces the add-only merge block (lines 548-575) without UI change.
6. **`src/components/ImageCarousel.jsx`** (+ `useUploadQueue`, `useGenerationJobs`): move the component as-is, add `key={compId}` (FM-15), then iterate on a11y (FM-12/13/14/23) inside the file. Generation job state is lifted to App-level (`Map<compId, job>`).
7. **`src/lib/sync.js` / `useSharedState`**: wrap the three effects (state push 477, pull 504, image push 629) into one hook with `sanitizeRemoteState` (FM-20) and a version-aware image pull (FM-24). Highest risk — do last, behind the existing e2e + the FM tests.
8. **`src/components/ErrorBoundary.jsx`** + wrapper in `main.jsx` (FM-20) can go first; it is independent and 25 lines.
9. New feature UI (Add Tool Photos / Add Mount Photo / Generate / Edit Rendering / approve) lives in `src/components/compartment/*` and consumes steps 4-6; `renderCompartment` just mounts `<CompartmentMedia compId>`.

Suggested order: 8 → 3 → 1 → 2 → 5 → 4 → 6 → 7.

## Design language inventory (so new UI matches)

- **Typography:** system stack (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, …`, `src/index.css`); no web fonts. Sizes: Tailwind `text-xs/sm/lg`, plus arbitrary `text-[9px]` ×7, `[10px]` ×20, `[11px]` ×1 (used for badges/helpers; FM-23 recommends ≥12 px for new UI). Weights: `font-bold` headings/CTAs, `font-semibold` labels, `font-medium` secondary.
- **Brand colours (Tailwind palette, no custom theme — `tailwind.config.js` `extend:{}`):** navy/near-black chrome `slate-900/950` (sidebar, mobile top bar), MBFD red `red-600` accents (logo tile, active nav, primary actions) with `red-500` focus/active dots and `red-50/700` hover; neutral surfaces `slate-50/100/200` with `slate-300` borders; body text `slate-600/700/800`; status: green (`green-50/600`, synced/complete), amber (`amber-50/200/600`, featured/warnings), `red-50/700` errors, blue (`blue-50/100/300/700/800`, bundle/info panels), **indigo** (`indigo-50…900`, AI panel only) and **purple** (`purple-300/600`, bundle mode). `BUNDLE_COLORS` supplies per-bundle accent colours (`src/App.jsx:273`).
- **Radii:** `rounded-lg` (25×) cards/inputs/buttons; `rounded-full` (18×) dots/progress/pills; `rounded-md` (4×) icon tiles; `rounded-xl` (3×) the three promo/panel blocks (AI, bundle, bulk). **Shadows:** `shadow-sm` on panels, `shadow-md` mobile bar.
- **Buttons:** primary `bg-red-600 hover:bg-red-700 active:bg-red-800 text-white font-bold rounded-lg px-4 py-3`; secondary `bg-slate-50 border border-slate-200 hover:bg-red-50 hover:border-red-300 text-slate-600 rounded-lg` (the upload label is the model); destructive-on-hover icon buttons `text-slate-400 hover:text-red-500`; AI uses `bg-indigo-600`. All carry `touch-manipulation`; interactive controls use `.touch-target` (`min-width/height:44px`) or `min-h-11`.
- **Focus:** global `:focus-visible { outline: 3px solid #ef4444; outline-offset: 2px }`.
- **Motion:** `transition-colors`, drawer `transition-transform duration-300`, `animate-spin`/`animate-pulse` for loaders; `prefers-reduced-motion` honoured globally.
- **Layout:** `flex h-[100dvh]`, 256 px (`w-64`) sidebar fixed overlay below `lg`, sticky page headers (`sticky top-0 z-10`), content grid `grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8`, `xl:grid-cols-3` card grids; z-layers: drawer 50, backdrop 40, loading overlay 10000.
- **Icons:** `lucide-react` 0.400 (sizes 11–48, e.g. `Upload`, `Sparkles`, `Star`, `Lock`, `X`, `Loader2`).
- **Print:** letter landscape, hide interactive controls with `print:hidden`, images `max-height:3.5in` via `.print-image-container`.
- **Guidance for new components:** use the secondary-button pattern for "Add Tool Photos / Add Mount Photo", red-600 primary for "Approve rendering", indigo only for AI-generated content, an amber `DRAFT` ribbon for unapproved renderings, ≥44 px targets, ≥12 px text, `role="alert"` messages beside the control.

## Regression tests to keep (summary)

All `FM-*` tests in `e2e/audit-frontend.spec.js`; when a defect is fixed, delete its `test.fail(...)` line (Playwright will report "expected to fail but passed" until you do). The "(not a defect)" tests FM-05, FM-06, FM-09b, FM-17 and the "(documents behaviour)" tests FM-08b, FM-16b, FM-25, FM-26, FM-27 should be updated, not removed, when the corresponding feature changes.
