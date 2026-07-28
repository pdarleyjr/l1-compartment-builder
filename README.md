# L1 Compartment Builder

Production planning application for the MBFD Ladder 1 mid-mount apparatus. The
application is deployed at `https://l1.mbfdhub.com/`; shared state, uploaded
images, and AI rendering requests are handled by the `l1-state-sync`
Cloudflare Worker.

## Capabilities

- Eleven editable apparatus compartments and four apparatus overview screens
- Searchable equipment assignment with inventory quantity enforcement
- Bulk assignment, row expansion, equipment bundles, and full inventory CRUD
- Shared state synchronization through Cloudflare KV
- Uploaded/featured compartment images and Cloudflare Workers AI renderings
- Two-sheet Excel export and print/PDF layouts
- Responsive navigation and touch-first controls for phones, tablets, and
  desktop browsers

## Local development

Requirements: Node.js 22 or newer.

```powershell
npm ci
npm run dev
```

The application accepts local Worker CORS requests from
`http://127.0.0.1:4173` and `http://localhost:4173`.

## Verification

```powershell
npm audit --audit-level=low
npm run lint
npm run test:coverage
npm run build
npm run test:e2e
```

The end-to-end suite uses isolated, intercepted Worker state so it cannot alter
the production apparatus plan. It covers Chromium at desktop, iPad-sized, and
phone-sized viewports, including keyboard and touch dropdown flows, route and
image health, inventory mutations, upload/AI carousel flows, Excel export,
44-pixel interactive targets, horizontal overflow, and automated WCAG checks.

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
