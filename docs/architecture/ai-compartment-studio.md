# AI Compartment Studio — architecture and contracts

Status: binding contract for the implementation agents (lead: Opus). Version 1, 2026-11-12.
Code-level contracts live in `shared/contracts.js` (constants, routes, error codes, typedefs) and
`worker/migrations/0001_studio.sql` (D1 schema). Audit inputs: `docs/audit/*.md`.

## 1. Goals and non-goals

Authorized MBFD editors photograph compartments, tools, tool groups and mounting hardware, link those photos to the
existing inventory without inflating counts, arrange equipment by zone, generate photorealistic renderings with OpenAI
`gpt-image-2.6-*` through a durable job processed on the AIW, iterate with natural-language and markup edits, keep an
immutable version history, and publish one approved image per compartment as its main image on every device.

Everything that works today keeps working: planner slots, inventory edits, bundles, bulk fill, presets, gallery,
featured images, Excel export, print, mobile navigation, branding. A failed Studio rollout must never break the planner
(feature flag `studio.enabled`, lazy-loaded Studio chunk, planner has no runtime dependency on Studio).

Not in scope: CAD, structural/fit certification (renderings are planning concepts, always labelled as such).

## 2. Topology

```
Browser (Pages, l1.mbfdhub.com)  ──same-origin──▶  Worker l1-state-sync  (route l1.mbfdhub.com/api/*)
   │  public reads: /api/public/*                    │  D1 l1-builder (metadata, planner doc, jobs, ledger, audit)
   │  editor calls: /api/*  (Cloudflare Access)      │  R2 l1-builder-assets (private: originals, derivatives, renders)
   │                                                 │  KV L1_STATE (legacy, read-only after migration, never deleted)
   ▼                                                 ▲
 Access app "L1 Compartment Builder"                 │ outbound HTTPS only (claim/heartbeat/assets/output/complete)
 (MBFD staff policy + service token)                 │
                                         AIW processor (systemd, aiw-k8 + aiw-7070, active-active via leases)
                                                     │
                                                     └──▶ OpenAI Images API / Responses API (key only on the AIW)
```

Staging mirrors production: Pages project `l1-compartment-builder-staging` on `l1-staging.mbfdhub.com`, Worker
`l1-state-sync-staging` (`wrangler --env staging`), D1 `l1-builder-staging`, R2 `l1-builder-assets-staging`.
The legacy `l1-state-sync.pdarleyjr.workers.dev` hostname keeps serving read-only legacy GETs for old open tabs and
answers legacy PUT/POST with `409 {code:"APP_UPDATED"}` (old tabs show their existing sync-failed state; reload fixes).

## 3. Identity and authorization

* Cloudflare Access (team `darl.cloudflareaccess.com`) application **"L1 Compartment Builder"** on `l1.mbfdhub.com/api`
  with the established MBFD policy (email domain `miamibeachfl.gov`, plus the owner) and a **Service Auth** policy for the
  service token `l1-image-processor`. A second Access application with decision **bypass** covers
  `l1.mbfdhub.com/api/public` (same pattern as existing MBFD bypass apps). Session 730h like the other MBFD apps.
* The Worker never trusts the edge alone: every `/api/*` (non-public) request must carry a valid Access JWT
  (`Cf-Access-Jwt-Assertion` header, falling back to the `CF_Authorization` cookie): RS256 against
  `${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs` (cached, key rotation aware), `iss` = team domain, `aud` contains
  `ACCESS_AUD`, `exp`/`nbf` checked. Missing/invalid → `401 AUTH_REQUIRED` (JSON).
* Actor model (`getActor`): `{kind:'user', email, roles}` | `{kind:'service', serviceId}` | `{kind:'anonymous'}`.
  Roles: `editor` = any valid user JWT; `admin` = email in setting `access.admins` (seeded with the owner).
  Service JWTs (`common_name` claim) may call only `/api/processor/*`; users may never call `/api/processor/*`.
* Test/dev: `AUTH_MODE=test` (vitest, local e2e only) honors header `X-Test-Actor: user:<email>[,admin]` or
  `service:<id>`. Production and staging configs set `AUTH_MODE=access`; any other value fails closed.
* Browser: `GET /api/session` → `{email, roles, studioEnabled}`; fetches use `redirect:'manual'`; an opaque redirect or
  401 means signed out → "Sign in to edit" → `location.assign('/api/auth/login?return=<path>')` (Access login, then the
  Worker 302s back to a same-origin path only). Anonymous visitors keep read-only access to the planner, gallery and
  published images exactly as today; every mutation and every Studio view requires sign-in.

## 4. Data model (D1) — see `worker/migrations/0001_studio.sql`

**Planner document (revisioned, op-based).** The legacy planner state stays one small JSON document (≈3 KB) because
App.jsx and the Excel export are built around it, but it moves to D1 table `planner_doc` with an integer `revision`
and is changed only through **ops with preconditions**, never whole-document overwrites (fixes SD-01/06/18, WS-01).
Doc v2 is a strict superset of v1:

```
{ schema: 2,
  allocations: {compId: string[]},           // unchanged v1 slot arrays (names; '' = empty); slots never shift
  customQtys, customTools, customDimensions, removedItems,   // unchanged v1 fields
  bundles: {compId: [{id, name, colorIdx, slotIndices}]},    // unchanged v1 shape
  equipmentIds: {name: 'eq_…'},              // stable equipment identity registry (base + custom items)
  assignmentIds: {compId: (string|null)[]},  // 'as_…' per occupied slot, parallel to allocations
}
```

* Base-inventory equipment ids are deterministic: `eq_` + first 16 hex of sha256(canonical original name), so every
  client and the server agree before any write. Custom tools get random ids when created.
* An assignment id is minted when a slot changes from empty or from a different item to an item, and dropped when the
  slot is cleared. Rename (`renameEquipment`) keeps the equipment id and every assignment id.
* Ops (`shared/contracts.js PLANNER_OPS`): `setSlot{comp,index,value,expect}`, `setSlotCount{comp,count,expect}`,
  `setCustomQty{name,qty|null}`, `upsertCustomTool{tool}`, `removeCustomTool{name}`, `setDimension{name,value|null}`,
  `setRemoved{name,removed}`, `upsertBundle{comp,bundle}`, `deleteBundle{comp,id}`, `renameEquipment{from,to}`.
* Server apply (`shared/planner.js applyOps`): per-op precondition (`expect` must equal current value, or the op is
  already satisfied → no-op); quantity invariant (assigned count ≤ effective qty) → conflict `QUANTITY`; bundle
  integrity (indices pointing at empty/out-of-range slots are pruned, empty bundles deleted) → fixes SD-08/13.
  Non-conflicting ops apply; conflicts are returned. CAS write `UPDATE … WHERE revision = ?` retried server-side ≤3×.
  `clientOpId` dedupes retries (stored in `planner_history`).
* Client sync (`src/lib/planner-sync.js`): keeps the last server doc as base; each local change is diffed
  (`shared/planner.js diffDocs(base, next)` → ops), queued durably in localStorage, POSTed with retry/backoff; pulls use
  `GET /api/public/planner?since=<rev>` (304 when unchanged) every 5 s while visible; conflicts are shown as a
  dismissible notice ("Another device changed LS2 slot 4 — kept their change").

**Studio entities** (all ids `prefix_` + 26-char time-sortable random, `shared/ids.js`):
`assets` (category, provenance, R2 keys for original/display/thumb, status pending→committed→deleted, visibility),
`asset_links` (one asset → many equipment/assignment/mount/bundle targets, quantity, optional normalized region,
state suggested|confirmed|rejected), `mounts` + `mount_links` (one-to-many both ways; classification
mounting|inventory|reference; status existing|proposed|optional|awaiting_verification), `designs` (per-compartment
layout: zones and placements, revisioned), `generation_jobs`, `image_versions` (immutable; parent chain = branches),
`main_images` (server-authoritative main image per compartment, revisioned, keeps previous for one-tap recovery),
`spend_ledger`, `settings` + `settings_history`, `audit_log`, `planner_doc` + `planner_history`.

Deletes are soft (`deleted_at`) → tombstones; nothing is resurrected by a stale client (fixes SD-02/03, FM-11).

## 5. Object storage (R2, private)

Keys (never derived from user input except validated ids): `assets/{compId}/{assetId}/original.{ext}`,
`…/display.webp` (≤1600 px long edge), `…/thumb.webp` (≤400 px); renders are assets too (category `rendering`);
`backups/kv/{iso}/{key}.json`. Uploads are streamed through the Worker with magic-byte checks (JPEG/PNG/WebP for
every variant; HEIC is converted in the browser before upload), size caps (original ≤ 25 MB, display ≤ 4 MB,
thumb ≤ 512 KB) and sha256 verification of the original. Served by the Worker: public assets (published main images,
legacy gallery uploads) at `/api/public/assets/{id}/{variant}` with `Cache-Control: public, max-age=31536000,
immutable`; everything else at `/api/assets/{id}/{variant}` for editors with `private, no-store`. Buckets stay private;
no public bucket domain, no listing.

## 6. Upload lifecycle (client)

Capture (`<input type=file accept="image/*" capture="environment">` and a multi-select picker on phones,
getUserMedia viewfinder where permitted, desktop picker/drag) → decode (HEIC/HEIF via lazy `heic2any` when the browser
cannot decode) → EXIF orientation applied, metadata stripped (canvas re-encode) → review screen (rotate, crop, retake,
remove, category) → `original` = highest-quality re-encode (JPEG q0.92, ≤ 4096 px long edge, orientation applied,
metadata stripped; the sole copy is never downscaled further) plus display/thumb WebP derivatives → persisted in an
IndexedDB queue → `POST /api/assets` (pending) → `PUT` each variant (progress, cancel, retry) →
`POST /api/assets/{id}/commit` with links (and optional explicit planner ops) applied **in one D1 transaction**. An
interrupted upload leaves only a pending asset (no links), garbage-collected after 24 h by the cron. A captured photo is
never lost because generation fails.

## 7. Photo ↔ inventory association rules (`shared/associations.js`)

* A photo is evidence, never inventory. Links are created only on explicit confirmation.
* Matching order: (1) items already assigned in this compartment, (2) inventory items with free quantity,
  (3) "new tool" via the existing custom-tool workflow (name, qty, dimensions, description).
* Linking an already-assigned item creates an `assignment` link (no planner op). Assigning an unassigned item emits
  explicit `setSlot` ops into empty slots (validated against free quantity) in the same commit.
* Group photo: one asset, many links, per-link quantity, optional region; quantity on a link never exceeds what is
  assigned/being assigned in that compartment. Photo groups are not bundles; a link may target a bundle for context.
* AI recognition (`kind:'recognize'` job, vision model from settings) returns candidate regions/names/matches stored as
  `suggested` links; nothing changes until the user confirms each one.

## 8. Generation pipeline

`POST /api/compartments/{id}/jobs` (editor) with `Idempotency-Key`: the **server** builds the scene spec from the
authoritative planner doc, design, confirmed links, mounts, compartment spec and settings (`shared/scene-spec.js`,
schema `l1.scene/1`, deterministic prompt text, `inventoryFingerprint`), selects references (compartment photo →
parent version → markup → tools by importance → mounts; overflow beyond the model limit goes into labelled contact
sheets built by the processor; every required tool is named in the prompt even if its photo is in a sheet), estimates
cost (`shared/cost.js`, admin-editable price table), reserves budget atomically, inserts the job (`queued`) and returns
`202 {job}`. Modes: `plan` (no tool photos), `reference` (photos), `edit` (parent version + instructions + optional
markup). Presets map to model/quality/complexity/size from settings: `preview` → `gpt-image-2.6-flare`/`low`,
`high` → `gpt-image-2.6-sunburst`/`high`, `max` → `gpt-image-2.6-sunburst`/`max` (admin-editable, `max` needs a
confirm showing the estimate). Output size per compartment from its proportions (`shared/apparatus-render.js`),
multiples of 16, ratio clamped to 1:3–3:1, 655,360–8,294,400 px; default ≤ 2560 px long edge.

Job states: `queued → claimed → preparing → generating → saving → completed | failed | cancelled`.
Processor: `POST /api/processor/claim` (atomic `UPDATE … RETURNING`, lease 120 s), heartbeat every 20 s
(`/heartbeat` returns `cancelRequested`), status `generating` is recorded **before** the paid call
(`provider_called_at`). Lease expiry before `generating` → requeue (≤ `max_attempts`, backoff with jitter); expiry after
`generating` → `failed: OUTCOME_UNKNOWN` (never auto-resubmitted; user may retry explicitly, which reserves again).
Provider 429/5xx before any image is returned → bounded retry with backoff (counts as an attempt; 400/moderation/billing
errors are terminal with a human message). Output: processor uploads original + display + thumb, then `complete` with
usage → server creates the `rendering` asset (provenance `ai_concept`), an immutable `image_versions` row (`draft`),
settles the ledger with actual cost. Optional `verify` job compares output vs spec and stores a non-authoritative report.

Spend controls (settings, admin-editable, enforced server-side in the reservation statement): `ai.enabled` kill switch,
monthly / daily / per-user-daily USD caps, max concurrent jobs global / per user, per-request preset allowlist.
Reservation = conditional `INSERT … SELECT … WHERE` sums+estimate ≤ caps (atomic in D1). Settlement replaces the
estimate with actual (or keeps the estimate when the outcome is unknown). The OpenAI project should also carry a hard
provider-side budget (owner action, documented).

## 9. Review, edit, publish

Versions are immutable; edits create children (`parent_version_id`), so any older version can be branched again.
Compare view (side-by-side / slider), zoom, reject, soft-delete drafts. **Approve & Set as Main Image**
(`POST /api/compartments/{id}/main-image {kind:'version', ref, expectRevision, acknowledgeStale}`): editor; checks the
version exists and belongs to the compartment; if the current inventory fingerprint differs from the version's, the
server returns `409 STALE_SOURCE` unless `acknowledgeStale`; writes `main_images` with CAS on revision, stores the
previous main for recovery, marks the version `approved`, flips the rendering asset to `public`, audit-logs.
Every device's carousel shows the server main image first; presets/uploads stay in the gallery. If assignments later
change, the gallery shows "Image may be outdated — equipment assignments changed" (fingerprint mismatch) and offers to
regenerate; the approved image stays until another is approved. Provenance badges: Photo · AI concept ·
Approved concept · As-built photo.

## 10. AIW processor (`processor/`)

Node 22 service (no framework), deps: `sharp`. Runs as systemd unit `l1-image-processor.service` on aiw-k8 and
aiw-7070 under a dedicated system user, hardened (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`,
`PrivateTmp`, `MemoryMax=1G`, `CPUQuota=200%`), config in `/etc/l1-image-processor/env` (root:l1img 0640) holding
`L1_API_BASE`, `L1_ACCESS_CLIENT_ID`, `L1_ACCESS_CLIENT_SECRET`, `L1_OPENAI_API_KEY`, `L1_NODE_NAME`. The key is
scoped to this unit only (never `/etc/environment`, never AIW agent jobs; Codex/Claude keep subscription billing).
Outbound only; no listening port. Adaptive polling 3 s (recent work) → 15 s (idle). Graceful SIGTERM (finish or
release lease before `generating`). Installed/updated by `processor/deploy/install.sh` over SSH; documented in
`docs/ops/aiw-image-processor.md`. Systemd (not Docker) matches the existing AIW service pattern (aiw-recover,
mbfd-ci-pool) and avoids a container runtime dependency for one small process.

## 11. Admin self-service (no-code)

Admin panel inside Studio (revisioned settings writes + history + restore): AI on/off, Studio on/off, budgets and
concurrency, preset → model/quality/complexity mapping (allowlisted values only), price table for estimates,
recognition model + on/off, verification on/off, house style text (bounded, inserted as data), per-compartment render
overrides (orientation/size, zones list, structured dimensions, spec text), admins list. Not editable: auth policy
enforcement, secrets, schema, executable prompts. No-code outcome: **BUILT**.

## 12. Migration (additive, reversible)

1. Backup: export KV `allocations` and `images` to R2 `backups/kv/{iso}/` and to the owner's local backup folder.
2. `POST /api/admin/migrate-legacy` (admin, idempotent): KV `allocations` v1 → `planner_doc` v2 (ids added, nothing
   renamed or dropped; record counts per compartment); KV `images` → R2 assets (`legacy_upload`, public, `legacy_uid`
   preserved) and `featuredImages` → `main_images` (preset paths validated). Report: counts before/after.
3. KV keys are never deleted; the legacy GET projection is served from D1 after cutover.
Rollback: redeploy the previous Pages deployment + Worker version; KV still holds the pre-migration documents.

## 13. Resource ledger (expected)

D1: < 10 MB/yr (rows: assets/links/versions in the low thousands). R2: ~2–6 MB per photo set incl. derivatives,
renders 1–4 MB; < 5 GB/yr (well inside included storage). Worker requests: processor polling ≤ 2×5,760/day idle +
app traffic, well inside Workers Paid. Browser: Studio is a lazy chunk (target < 120 KB gz excluding `heic2any`, which
loads only for HEIC). AIW: one Node process per node, ≤ 1 GB RAM cap, idle CPU ~0. OpenAI: bounded by the caps above.
New infra: 2 D1 databases, 2 R2 buckets, 2 Access apps, 1 Pages staging project, 1 staging Worker, 2 systemd units;
no new vendors or subscriptions.

## 14. Ownership map for parallel work

| Part | Owns (exclusive) |
|---|---|
| P0 lead | `docs/architecture/**`, `shared/contracts.js`, `shared/apparatus.js`, `worker/migrations/0001_studio.sql`, `worker/wrangler.toml`, `src/lib/api.js`, `src/lib/session.js`, root `package.json`/lock |
| C data | `shared/ids.js`, `shared/planner.js`, `shared/associations.js`, `shared/scene-spec.js`, `shared/apparatus-render.js`, `shared/cost.js`, `shared/fingerprint.js`, `shared/validation.js`, `tests/shared/**`, `tests/audit/**` |
| E1 backend core | `worker/index.js`, `worker/src/{router,http,auth,planner,legacy,settings,audit,migrate,cron,session}.js`, `worker/test/core/**`, `worker/index.test.js`, `worker/audit.test.js` |
| E2 backend studio | `worker/src/{assets,gallery,mounts,designs,links,jobs,processor,spend}.js`, `worker/test/studio/**` |
| D processor | `processor/**`, `docs/ops/aiw-image-processor.md` |
| B1 capture | `src/studio/capture/**`, `src/studio/library/**`, `src/studio/mounts/**`, `src/lib/image/**`, `src/lib/upload-queue.js` |
| B2 studio | `src/studio/StudioShell.jsx`, `src/studio/{layout,generate,review,edit,admin}/**`, `src/lib/jobs.js` |
| A app | `src/App.jsx`, `src/main.jsx`, `src/components/**`, `src/lib/planner-sync.js`, `src/lib/gallery.js`, `public/_headers`, `index.html`, `vite.config.js`, `e2e/l1.spec.js`, `e2e/audit-*.spec.js` |
| F QA | `e2e/studio/**`, `e2e/helpers/**`, `docs/qa/**` |

Audit reproduction tests belong to the part that fixes the finding; when a fix lands, remove the `fails` marker in the
same change.
