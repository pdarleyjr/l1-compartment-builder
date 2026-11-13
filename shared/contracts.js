// AI Compartment Studio — shared contract (v1). Imported by the React app, the Worker and the AIW processor.
// Binding for every implementation part; see docs/architecture/ai-compartment-studio.md. Plain ESM, no deps.

export const CONTRACT_VERSION = 1;

// ── Compartments ──────────────────────────────────────────────────────────────────────────────────────────────────
export const COMPARTMENT_IDS = Object.freeze([
  'CabRearZone', 'LS1', 'LS2', 'LS3', 'LS4', 'RS1', 'RS2', 'RS3', 'RS4', 'RS5', 'RR1',
]);
export const isCompartmentId = v => typeof v === 'string' && COMPARTMENT_IDS.includes(v);

// Default layout zones offered for every compartment (admins can override per compartment in settings).
export const DEFAULT_ZONES = Object.freeze([
  'upper_shelf', 'middle_shelf', 'lower_tray', 'pull_out_tray', 'left_wall', 'right_wall', 'rear_wall',
  'floor', 'door_area', 'other',
]);
export const ORIENTATIONS = Object.freeze(['vertical', 'horizontal', 'angled']);

// ── Ids (format: `${prefix}_${26 chars [0-9a-z]}`, time-sortable; see shared/ids.js) ────────────────────────────────
export const ID_PREFIX = Object.freeze({
  equipment: 'eq', assignment: 'as', asset: 'ast', link: 'al', mount: 'mt', job: 'gj', version: 'iv',
  ledger: 'sl', bundle: 'bd', clientOp: 'op',
});
export const ID_PATTERN = /^[a-z]{2,3}_[0-9a-z]{16,32}$/;

// ── Assets ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export const ASSET_CATEGORIES = Object.freeze([
  'compartment', // the actual compartment, empty or partially equipped
  'tool',        // one specific piece of equipment
  'tool_group',  // several pieces of equipment in one photo
  'mount',       // brackets, trays, hooks, holders, straps, fixtures
  'arrangement', // equipment already installed
  'other',       // manufacturer photo, catalog image, diagram, example
  'rendering',   // AI output (created by the server only)
  'markup',      // annotation layer for targeted edits (created by the edit UI)
  'legacy_upload', // migrated from the KV images document
]);
export const USER_ASSET_CATEGORIES = Object.freeze(['compartment', 'tool', 'tool_group', 'mount', 'arrangement', 'other']);
export const ASSET_PROVENANCE = Object.freeze(['user_photo', 'reference', 'ai_concept', 'approved_concept', 'as_built_photo', 'legacy_upload']);
export const ASSET_STATUS = Object.freeze(['pending', 'committed', 'deleted']);
export const ASSET_VARIANTS = Object.freeze(['original', 'display', 'thumb']);
export const ASSET_LIMITS = Object.freeze({
  originalMaxBytes: 25 * 1024 * 1024,
  displayMaxBytes: 4 * 1024 * 1024,
  thumbMaxBytes: 512 * 1024,
  originalMaxEdge: 4096,
  displayMaxEdge: 1600,
  thumbMaxEdge: 400,
  maxPerCompartment: 400,
  titleMax: 200,
  notesMax: 2000,
  pendingTtlMs: 24 * 60 * 60 * 1000,
});
// Accepted upload content (verified by magic bytes on the server, never by extension or declared MIME alone).
export const UPLOAD_MIME = Object.freeze({ original: ['image/jpeg', 'image/png', 'image/webp'], display: ['image/webp', 'image/jpeg'], thumb: ['image/webp', 'image/jpeg'] });

export const LINK_TARGETS = Object.freeze(['equipment', 'assignment', 'mount', 'bundle']);
export const LINK_STATES = Object.freeze(['suggested', 'confirmed', 'rejected']);

// ── Mounts ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export const MOUNT_CLASSIFICATIONS = Object.freeze(['mounting', 'inventory', 'reference']);
export const MOUNT_STATUSES = Object.freeze(['existing', 'proposed', 'optional', 'awaiting_verification']);

// ── Planner ops (see shared/planner.js) ─────────────────────────────────────────────────────────────────────────────
export const PLANNER_SCHEMA = 2;
export const PLANNER_OPS = Object.freeze([
  'setSlot', 'setSlotCount', 'setCustomQty', 'upsertCustomTool', 'removeCustomTool', 'setDimension', 'setRemoved',
  'upsertBundle', 'deleteBundle', 'renameEquipment',
]);
export const PLANNER_LIMITS = Object.freeze({ maxOpsPerRequest: 200, maxSlotsPerCompartment: 500 });
export const CONFLICT_REASONS = Object.freeze(['PRECONDITION', 'QUANTITY', 'NOT_FOUND', 'INVALID']);

// ── Generation ──────────────────────────────────────────────────────────────────────────────────────────────────────
export const JOB_KINDS = Object.freeze(['render', 'recognize', 'verify']);
export const RENDER_MODES = Object.freeze(['plan', 'reference', 'edit']);
export const JOB_STATES = Object.freeze(['queued', 'claimed', 'preparing', 'generating', 'saving', 'completed', 'failed', 'cancelled']);
export const ACTIVE_JOB_STATES = Object.freeze(['queued', 'claimed', 'preparing', 'generating', 'saving']);
export const TERMINAL_JOB_STATES = Object.freeze(['completed', 'failed', 'cancelled']);
export const PROCESSOR_REPORTABLE_STATES = Object.freeze(['preparing', 'generating', 'saving']);
export const JOB_TIMING = Object.freeze({ leaseMs: 120_000, heartbeatMs: 20_000, maxAttempts: 2, backoffBaseMs: 15_000, pollActiveMs: 3_000, pollIdleMs: 15_000 });
export const PRESETS = Object.freeze(['preview', 'high', 'max']);
export const IMAGE_MODELS = Object.freeze(['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst']);
export const IMAGE_QUALITIES = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const IMAGE_COMPLEXITIES = Object.freeze(['low', 'medium', 'high']);
export const IMAGE_SIZE_RULES = Object.freeze({ multiple: 16, minPixels: 655_360, maxPixels: 8_294_400, maxEdge: 3840, minRatio: 1 / 3, maxRatio: 3, defaultMaxEdge: 2560 });
export const VERSION_STATES = Object.freeze(['draft', 'approved', 'rejected', 'deleted']);
export const MAIN_IMAGE_KINDS = Object.freeze(['preset', 'asset', 'version']);
export const INSTRUCTIONS_MAX = 2000;
export const SCENE_SPEC_SCHEMA = 'l1.scene/1';

// ── Settings (keys, defaults, validation hints). Admin-editable through /api/admin/settings. ───────────────────────
export const SETTINGS_DEFAULTS = Object.freeze({
  'studio.enabled': true,
  'ai.enabled': false, // flipped on by an admin after the staging smoke test
  'access.admins': [], // seeded at migration with the owner
  'budget.monthlyUsd': 25,
  'budget.dailyUsd': 8,
  'budget.userDailyUsd': 5,
  'jobs.maxConcurrent': 2,
  'jobs.userMaxConcurrent': 1,
  'presets': {
    preview: { model: 'gpt-image-2.6-flare', quality: 'low', complexity: 'medium', outputFormat: 'jpeg', confirm: false },
    high: { model: 'gpt-image-2.6-sunburst', quality: 'high', complexity: 'high', outputFormat: 'jpeg', confirm: false },
    max: { model: 'gpt-image-2.6-sunburst', quality: 'max', complexity: 'high', outputFormat: 'png', confirm: true },
  },
  // USD per 1M tokens (verify against https://developers.openai.com/api/docs/pricing at release) plus per-call
  // output-token estimates by quality used for pre-generation guidance. Calibrated from actual usage after smoke tests.
  'pricing': {
    'gpt-image-2.6-flare': { textIn: 5, imageIn: 8, imageInCached: 2, imageOut: 30 },
    'gpt-image-2.6-sunburst': { textIn: 5, imageIn: 8, imageInCached: 2, imageOut: 30 },
    'gpt-5.4-mini': { textIn: 0.75, imageIn: 0.75, imageInCached: 0.075, textOut: 4.5 },
    estimatedOutputTokensPerMegapixel: { low: 300, medium: 1100, high: 4200, xhigh: 6500, max: 9000 },
    estimatedInputTokensPerReference: 1500,
  },
  'references.maxPerRequest': 10, // conservative until the processor verifies the model limit; overflow → contact sheets
  'recognition.enabled': true,
  'recognition.model': 'gpt-5.4-mini',
  'verification.enabled': false,
  'style.houseText': 'Professional photograph of a Pierce fire apparatus compartment: fire-engine red bodywork, door frame and roll-up door rails where present, realistic metal shelves, trays and brackets, accurate scale, natural lighting and shadows. Planning visualization — do not add equipment that is not listed.',
  'compartments.overrides': {}, // { [compId]: { orientation?, size?, zones?, dimensions?: {...}, specText? } }
});
export const SETTINGS_KEYS = Object.freeze(Object.keys(SETTINGS_DEFAULTS));

// ── Errors (HTTP status + machine code; message is human-readable and safe to show) ────────────────────────────────
export const ERROR_CODES = Object.freeze({
  AUTH_REQUIRED: 401, FORBIDDEN: 403, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405, CONFLICT: 409, STALE_SOURCE: 409,
  REVISION_CONFLICT: 409, APP_UPDATED: 409, PAYLOAD_TOO_LARGE: 413, UNSUPPORTED_MEDIA: 415, INVALID_REQUEST: 400,
  BUDGET_EXCEEDED: 402, CONCURRENCY_LIMIT: 429, RATE_LIMITED: 429, AI_DISABLED: 503, STUDIO_DISABLED: 503,
  LEASE_LOST: 409, OUTCOME_UNKNOWN: 409, INTERNAL: 500,
});
// Every error body: { error: { code, message, details? } }

// ── Routes. Handler = '<module>.<export>' under worker/src/. Auth: public | editor | admin | service. ───────────────
// E1 implements the router and the core modules; E2 implements the studio modules. Paths are relative to /api.
export const ROUTES = Object.freeze([
  // session / auth (E1)
  { method: 'GET', path: '/session', auth: 'public', handler: 'session.getSession' },
  { method: 'GET', path: '/auth/login', auth: 'editor', handler: 'session.login' }, // 302 to same-origin ?return
  // planner (E1)
  { method: 'GET', path: '/public/planner', auth: 'public', handler: 'planner.getPlanner' }, // ?since=rev → 304
  { method: 'POST', path: '/planner/ops', auth: 'editor', handler: 'planner.postOps' },
  // gallery / main image (E2)
  { method: 'GET', path: '/public/compartments/:compId/gallery', auth: 'public', handler: 'gallery.getPublicGallery' },
  { method: 'GET', path: '/public/main-images', auth: 'public', handler: 'gallery.getMainImages' },
  { method: 'GET', path: '/public/assets/:assetId/:variant', auth: 'public', handler: 'assets.getPublicVariant' },
  { method: 'GET', path: '/compartments/:compId/gallery', auth: 'editor', handler: 'gallery.getEditorGallery' },
  { method: 'POST', path: '/compartments/:compId/main-image', auth: 'editor', handler: 'gallery.setMainImage' },
  { method: 'POST', path: '/compartments/:compId/main-image/restore', auth: 'editor', handler: 'gallery.restorePreviousMainImage' },
  // assets (E2)
  { method: 'POST', path: '/assets', auth: 'editor', handler: 'assets.createAsset' },
  { method: 'PUT', path: '/assets/:assetId/:variant', auth: 'editor', handler: 'assets.putVariant' },
  { method: 'POST', path: '/assets/:assetId/commit', auth: 'editor', handler: 'assets.commitAsset' },
  { method: 'PATCH', path: '/assets/:assetId', auth: 'editor', handler: 'assets.updateAsset' },
  { method: 'DELETE', path: '/assets/:assetId', auth: 'editor', handler: 'assets.deleteAsset' },
  { method: 'GET', path: '/assets/:assetId/:variant', auth: 'editor', handler: 'assets.getVariant' },
  { method: 'GET', path: '/compartments/:compId/assets', auth: 'editor', handler: 'assets.listAssets' },
  // links (E2)
  { method: 'POST', path: '/assets/:assetId/links', auth: 'editor', handler: 'links.putLinks' }, // replace set atomically, may include planner ops
  { method: 'PATCH', path: '/links/:linkId', auth: 'editor', handler: 'links.updateLink' },        // confirm/reject suggestion
  // mounts & designs (E2)
  { method: 'GET', path: '/compartments/:compId/mounts', auth: 'editor', handler: 'mounts.listMounts' },
  { method: 'POST', path: '/compartments/:compId/mounts', auth: 'editor', handler: 'mounts.createMount' },
  { method: 'PATCH', path: '/mounts/:mountId', auth: 'editor', handler: 'mounts.updateMount' },
  { method: 'DELETE', path: '/mounts/:mountId', auth: 'editor', handler: 'mounts.deleteMount' },
  { method: 'GET', path: '/compartments/:compId/design', auth: 'editor', handler: 'designs.getDesign' },
  { method: 'PUT', path: '/compartments/:compId/design', auth: 'editor', handler: 'designs.putDesign' }, // expectRevision
  // jobs & versions (E2)
  { method: 'POST', path: '/compartments/:compId/jobs', auth: 'editor', handler: 'jobs.createJob' },
  { method: 'GET', path: '/compartments/:compId/jobs', auth: 'editor', handler: 'jobs.listJobs' },
  { method: 'GET', path: '/jobs/:jobId', auth: 'editor', handler: 'jobs.getJob' },
  { method: 'POST', path: '/jobs/:jobId/cancel', auth: 'editor', handler: 'jobs.cancelJob' },
  { method: 'POST', path: '/jobs/:jobId/retry', auth: 'editor', handler: 'jobs.retryJob' },
  { method: 'POST', path: '/compartments/:compId/estimate', auth: 'editor', handler: 'jobs.estimate' },
  { method: 'GET', path: '/compartments/:compId/versions', auth: 'editor', handler: 'jobs.listVersions' },
  { method: 'PATCH', path: '/versions/:versionId', auth: 'editor', handler: 'jobs.updateVersion' }, // reject / delete draft
  { method: 'GET', path: '/usage', auth: 'editor', handler: 'spend.getUsage' },
  // processor (E2) — service identity only
  { method: 'POST', path: '/processor/claim', auth: 'service', handler: 'processor.claim' },
  { method: 'POST', path: '/processor/jobs/:jobId/heartbeat', auth: 'service', handler: 'processor.heartbeat' },
  { method: 'GET', path: '/processor/assets/:assetId/:variant', auth: 'service', handler: 'processor.getAsset' },
  { method: 'PUT', path: '/processor/jobs/:jobId/output/:variant', auth: 'service', handler: 'processor.putOutput' },
  { method: 'POST', path: '/processor/jobs/:jobId/complete', auth: 'service', handler: 'processor.complete' },
  { method: 'POST', path: '/processor/jobs/:jobId/fail', auth: 'service', handler: 'processor.fail' },
  // admin (E1)
  { method: 'GET', path: '/admin/settings', auth: 'admin', handler: 'settings.getSettings' },
  { method: 'PUT', path: '/admin/settings/:key', auth: 'admin', handler: 'settings.putSetting' }, // expectRevision
  { method: 'GET', path: '/admin/settings/:key/history', auth: 'admin', handler: 'settings.getHistory' },
  { method: 'GET', path: '/admin/audit', auth: 'admin', handler: 'audit.listAudit' },
  { method: 'POST', path: '/admin/migrate-legacy', auth: 'admin', handler: 'migrate.migrateLegacy' },
  { method: 'GET', path: '/admin/migration-report', auth: 'admin', handler: 'migrate.report' },
]);
// Legacy hostname (l1-state-sync.pdarleyjr.workers.dev), handled by legacy.js (E1): GET /state, GET /images →
// read-only v1 projections from D1 (KV before migration); PUT /state, PUT /images, POST /generate-image →
// 409 { error: { code: 'APP_UPDATED' } } with the existing CORS policy.

/**
 * @typedef {{kind:'user', email:string, roles:string[]}|{kind:'service', serviceId:string}|{kind:'anonymous'}} Actor
 * @typedef {{ id:string, compartmentId:string, category:string, provenance:string, status:string, visibility:'private'|'public',
 *   title:string|null, notes:string|null, width:number|null, height:number|null, bytes:number|null, createdBy:string|null,
 *   createdAt:number, variants:{original?:string, display?:string, thumb?:string}, links?:Link[] }} Asset  // variants = URLs
 * @typedef {{ id:string, assetId:string, targetType:'equipment'|'assignment'|'mount'|'bundle', targetId:string,
 *   equipmentId:string|null, quantity:number, region:{x:number,y:number,w:number,h:number}|null,
 *   state:'suggested'|'confirmed'|'rejected', label?:string }} Link
 * @typedef {{ id:string, compartmentId:string, kind:string, mode:string|null, preset:string|null, model:string,
 *   status:string, attempts:number, errorCode:string|null, errorMessage:string|null, estimatedCostUsd:number,
 *   actualCostUsd:number|null, resultVersionId:string|null, result:object|null, createdAt:number, updatedAt:number,
 *   completedAt:number|null, requestedBy:string, parentVersionId:string|null }} Job
 * @typedef {{ id:string, compartmentId:string, parentVersionId:string|null, jobId:string, assetId:string,
 *   status:'draft'|'approved'|'rejected'|'deleted', model:string, settings:object, instructions:string|null,
 *   inventoryFingerprint:string, createdAt:number, createdBy:string, approvedAt:number|null,
 *   variants:{display:string, thumb:string, original:string}, verification:object|null }} ImageVersion
 * @typedef {{ compartmentId:string, revision:number, kind:'preset'|'asset'|'version', ref:string, url:string,
 *   thumbUrl:string|null, provenance:string, stale:boolean, previous:{kind:string, ref:string}|null }} MainImage
 *
 * POST /api/assets           body {compartmentId, category, title?, notes?, width, height, bytes, sha256, idempotencyKey}
 *                            → 201 {asset, upload:{original:url, display:url, thumb:url}}
 * PUT  /api/assets/:id/:v    raw bytes, Content-Type image/* → 204
 * POST /api/assets/:id/commit body {links?:[{targetType,targetId,quantity?,region?}], plannerOps?:Op[], baseRevision?}
 *                            → 200 {asset, plannerRevision?, conflicts?}   (all-or-nothing in one D1 batch)
 * POST /api/planner/ops      body {baseRevision, clientOpId, ops:Op[]} → 200 {revision, doc, applied:number[], conflicts:[{index, reason, current}]}
 * POST /api/compartments/:id/jobs  header Idempotency-Key; body {kind:'render'|'recognize', mode?, preset?, instructions?,
 *                            parentVersionId?, markupAssetId?, assetId? (recognize), confirmEstimateUsd?}
 *                            → 202 {job, estimate:{usd, basis}}  | 402 BUDGET_EXCEEDED | 429 CONCURRENCY_LIMIT | 503 AI_DISABLED
 * POST /api/processor/claim  body {node, kinds} → 200 {job, spec, references:[{assetId, variant, role, label, url}], leaseExpiresAt} | 204
 * POST /api/processor/jobs/:id/heartbeat body {node, status} → 200 {leaseExpiresAt, cancelRequested} | 409 LEASE_LOST
 * PUT  /api/processor/jobs/:id/output/:variant raw bytes → 204
 * POST /api/processor/jobs/:id/complete body {node, usage, actualCostUsd, providerRequestId?, revisedPrompt?, result?, width?, height?}
 * POST /api/processor/jobs/:id/fail body {node, code, message, retryable:boolean, providerCalled:boolean}
 */
