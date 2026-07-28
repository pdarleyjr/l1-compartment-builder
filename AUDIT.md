# L1 production audit

Audit date: 2026-07-28

Scope: React client, responsive UI, all navigation and planning workflows,
Cloudflare Worker/KV/AI integration, asset delivery, export/print behavior,
accessibility, dependency health, testing, source control, and release
provenance.

## Architecture and feature inventory

- Vite/React single-page client hosted by Cloudflare Pages
- Eleven compartment plans: cab rear zone, LS1-LS4, RS1-RS5, and rear
- Four visual overviews plus inventory status
- Cloudflare Worker endpoints: `GET/PUT /state`, `GET/PUT /images`, and
  `POST /generate-image`
- KV-backed allocation, inventory customization, bundles, uploaded images, and
  featured-image state
- Cloudflare Workers AI using Llama prompt construction and Flux image output
- Browser-local fallback persistence, Excel workbook generation, and print/PDF

## Remediated findings

### Interaction and responsive behavior

- Fixed Enter in a filtered equipment dropdown clearing the slot instead of
  choosing the first match.
- Replaced pointer-down-only option selection with click/tap behavior and
  restored focus to the originating control.
- Added visual-viewport-aware dropdown placement, including above/below
  flipping, horizontal clamping, safe maximum height, and live repositioning
  during mobile keyboard, resize, and scroll changes.
- Replaced fixed-screen-height behavior with dynamic viewport units.
- Added a shared-state hydration boundary so a fast initial edit cannot be
  overwritten by the first Worker pull.
- Fixed an impure bulk-fill state updater that failed under React Strict Mode.
- Stacked compact toolbars and bulk controls at narrow widths and exposed
  dimensions editing/display on phones and tablets.
- Raised visible buttons, inputs, selects, upload controls, and searchable
  dropdown controls to at least 44 by 44 CSS pixels.

### Accessibility and UX

- Added combobox/listbox/option semantics, expanded state, control
  relationships, slot-specific names, search labels, and keyboard operation.
- Added accessible names to icon-only edit, remove, save, cancel, clear,
  carousel, featured-image, and navigation controls.
- Added live sync status and storage-failure alerts.
- Added strong focus-visible treatment and reduced-motion behavior.
- Corrected serious automated color-contrast findings across navigation,
  empty slots, inventory state, and overview cards.
- Added useful file type/size errors and local-storage quota feedback.

### Reliability, security, and integration

- State and image sync now treats non-success HTTP responses as failures instead
  of falsely reporting a successful sync.
- Activated the previously unreachable AI generation UI callback.
- Added image type and 12 MB limits plus proportional client-side resizing.
- Restricted Worker CORS to production, Pages previews, and explicit local
  origins; mutations now require an allowed browser origin.
- Added request body limits, JSON error handling, structured state/image
  validation, AI input validation, sanitized server errors, and an hourly
  per-client AI request limit.
- Added browser and Worker security headers, strict content policy, frame
  blocking, and immutable hashed asset caching.
- Added a programmatic release identity at `/version.json`.

### Performance and maintainability

- Converted sixteen apparatus PNG assets from roughly 30 MB total to roughly
  2.1 MB of WebP assets.
- Replaced the vulnerable/heavy `xlsx` dependency with a dynamically imported
  workbook writer, reducing the export chunk from roughly 429 KB to roughly
  71 KB before compression.
- Updated the build toolchain and eliminated all reported npm audit findings.
- Added linting, unit/integration coverage, multi-viewport Playwright tests, and
  GitHub Actions CI.

## Verification contract

Automated verification covers code paths and Chromium browser emulation. It
does not represent physical acceptance on every personally owned phone/tablet,
native iOS Safari, printer hardware, or a long-duration multi-operator editing
session. Production deployment and live read-only browser verification are
separate release gates from the local test suite.

The current synchronization design uses Cloudflare KV and last-write-wins
documents. Validation and timestamp handling reduce failures, but KV is not a
transactional multi-user database. If simultaneous editing becomes common, a
future migration to a Durable Object or transactional database should provide
authoritative revision/conflict handling.

Allowed-origin enforcement and CORS reduce unintended browser access, but they
are not user authentication: non-browser clients can forge an Origin header.
If the apparatus plan requires confidentiality or per-user authorization,
protect both the Pages site and API with Cloudflare Access and validate Access
identity at the API boundary.

## Final local quality evidence

- Lighthouse mobile: Performance 90, Accessibility 100, Best Practices 100,
  SEO 100; LCP 2.1 s and CLS 0.061.
- Lighthouse desktop: Performance 100, Accessibility 100, Best Practices 100,
  SEO 100; LCP 0.5 s and CLS 0.048.
- Production bundle: approximately 230.5 KB main JavaScript (69.9 KB gzip),
  70.8 KB lazy Excel chunk (19.7 KB gzip), and 29.1 KB CSS (6.0 KB gzip).
- Static apparatus images: 16 WebP files totaling approximately 2.1 MB.
