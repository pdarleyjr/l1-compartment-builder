# L1 Compartment Builder

Production planning application for the MBFD Ladder 1 mid-mount apparatus. The
application is deployed at `https://l1.mbfdhub.com/`. Everything the browser
needs is same-origin under `/api` (Cloudflare Worker `l1-state-sync`, route
`l1.mbfdhub.com/api/*`); see `docs/architecture/ai-compartment-studio.md`.

## Capabilities

- Eleven editable apparatus compartments and four apparatus overview screens
- Searchable equipment assignment with inventory quantity enforcement
- Bulk assignment, row expansion, equipment bundles, and full inventory CRUD
- Revisioned, op-based planner sync (`src/lib/planner-sync.js`): edits are queued
  durably on the device, sent with retry/backoff, and merged by the server, so two
  people editing different compartments never overwrite each other. A status pill
  reports Saved · Saving… · Offline — changes queued · Sign in to save · Sync problem.
- Anonymous visitors can read everything; editing needs sign-in (Cloudflare Access).
- Server-backed gallery and one approved main image per compartment, shown first on
  every device (`src/lib/gallery.js`); photos and AI renderings are created in the
  lazily loaded **AI Compartment Studio** (`src/studio/`)
- Two-sheet Excel export and print/PDF layouts
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
npm audit --audit-level=low
npm run lint
npm run test:coverage
npm run build
npm run test:e2e
```

The end-to-end suite serves every `/api` request from an in-memory implementation
of the API contract (`e2e/helpers/fake-api.js`: session with a signed-in/out switch,
revisioned planner ops, galleries, main images, asset variants), so it cannot alter
any real data. It covers Chromium at desktop, iPad-sized, and phone-sized viewports,
including keyboard and touch dropdown flows, read-only mode, two-device concurrent
edits, offline queue persistence, rename consistency, carousel main image and stale
badge, Studio lazy loading and the error boundary, route and image health,
inventory mutations, Excel export, 44-pixel interactive targets, horizontal
overflow, and automated WCAG checks. While `shared/planner.js` is still the
interface stub, `playwright.config.js` aliases it to `e2e/helpers/planner-shim.js`
automatically. On workers where the default Chromium cannot start, the config falls
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

The deployed commit is available in the UI sidebar and at `/version.json`.
Cloudflare Pages retains prior deployments for rollback. Never place API tokens
or credentials in this repository.
