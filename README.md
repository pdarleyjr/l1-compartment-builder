# L1 Compartment Builder

Production planning application for the MBFD Ladder 1 mid-mount apparatus. The
application is deployed at `https://l1.mbfdhub.com/`. Everything the browser
needs is same-origin under `/api` (Cloudflare Worker `l1-state-sync`, route
`l1.mbfdhub.com/api/*`); see `docs/architecture/ai-compartment-studio.md`.

## Capabilities

- Eleven editable apparatus compartments and four apparatus overview screens
- Searchable equipment assignment with inventory quantity enforcement
- Clearing a slot moves the items below it up; moved items keep their identity
- Bulk assignment, row expansion, equipment bundles, and full inventory CRUD
- Placement Progress page: placed equipment by compartment and what is still to place
- Revisioned, op-based planner sync (`src/lib/planner-sync.js`): edits are queued
  durably on the device, sent with retry/backoff, and merged by the server, so two
  people editing different compartments never overwrite each other. A status pill
  reports Saved · Saving… · Offline — changes queued · Sign in to save · Sync problem.
- Anonymous visitors can read everything; editing needs sign-in (Cloudflare Access).
- Server-backed gallery and one approved main image per compartment, shown first on
  every device (`src/lib/gallery.js`); photos and AI renderings are created in the
  lazily loaded **AI Compartment Studio** (`src/studio/`)
- Per-compartment notes (plain text, up to 2,000 characters) and a "Needs verification" flag with a
  reason on any inventory item, both saved through the same op-based planner sync
  (`docs/architecture/notes-verification-transfer.md`)
- Excel export of the whole plan (Compartment Inventory, Equipment Catalog, Compartment Summary, Bundles and Kits,
  Notes and Exceptions, Export Metadata, plus the legacy Compartments and Inventory Status sheets) and, from the same
  snapshot, the `l1.checklist-transfer/1` JSON file that MBFD Hub imports into a checklist draft
  (`scripts/export-manifest.mjs` builds both offline from a saved `GET /api/public/planner` response)
- Print/PDF layouts
- Responsive navigation and touch-first controls for phones, tablets, and
  desktop browsers

## Local development

Requirements: Node.js 22 or newer.

```powershell
npm ci
npm run dev
```

The browser talks to `/api` on its own origin. To develop against a local Worker
(for example `wrangler dev`), set `L1_API_PROXY=http://127.0.0.1:8787` before
`npm run dev`; Vite then proxies `/api` to it. Without it the planner loads
read-only from whatever `/api` answers (tests use an in-memory fake instead).

API shapes the UI relies on (beyond `shared/contracts.js`): `GET /api/public/planner`
→ `{revision, doc, migrated}` (`?since=<rev>` → 304 when unchanged; `migrated:false`
makes the planner read-only with a notice); `GET /api/public/main-images` →
`{mainImages: {compId: MainImage}}`; gallery endpoints → `{main, items:[{id, kind,
url, thumbUrl, title, provenance}]}`.

## Verification

```powershell
npm run audit
npm run lint
npm run test:coverage
npm run build
npm run test:e2e
```

`npm run audit` is `npm audit` at level low minus the temporary, dev-only exceptions in `audit-exceptions.json`
(none at the moment; the picomatch GHSA-fc5q-39xc-vjpf exception was removed on 2026-11-18 once npm audit stopped
reporting it). It fails on any other advisory, when an excepted
advisory reaches a production dependency, when a fixed version is published, or after the exception expires.

CI runs on GitHub-hosted `ubuntu-latest` (Ubuntu 26.04) with `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64`, because
Playwright 1.59 does not list Ubuntu 26.04 yet; set the same variable when installing browsers on a 26.04 machine.

The end-to-end suite serves every `/api` request from an in-memory implementation
of the API contract (`e2e/helpers/fake-api.js`: session with a signed-in/out switch,
revisioned planner ops, galleries, main images, asset variants), so it cannot alter
any real data. It covers Chromium at desktop, iPad-sized, and phone-sized viewports,
including keyboard and touch dropdown flows, read-only mode, two-device concurrent
edits, offline queue persistence, rename consistency, carousel main image and stale
badge, Studio lazy loading and the error boundary, route and image health,
inventory mutations, Excel export, 44-pixel interactive targets, horizontal
overflow, and automated WCAG checks. The fake API in `e2e/helpers/fake-api.js` runs the
real `shared/planner.js`. On workers where the default Chromium cannot start, the config falls
back to the cached `chromium_headless_shell` (or set `L1_CHROMIUM_PATH`); run with
`npx playwright test --trace off`.

## Manual Cloudflare release

Set `CLOUDFLARE_API_TOKEN` in the current process without committing it, then:

```powershell
$env:VITE_BUILD_SHA = git rev-parse HEAD
npm run build
npm run deploy:worker
npm run deploy:pages
```

Deploy the Worker before Pages whenever the planner op list changes, so the new client never sends an op the
running Worker does not know (old clients keep working against the new Worker).
The deployed commit is available in the UI sidebar and at `/version.json`.
Cloudflare Pages retains prior deployments for rollback. Never place API tokens
or credentials in this repository.
