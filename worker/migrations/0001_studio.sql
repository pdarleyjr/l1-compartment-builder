-- AI Compartment Studio schema v1 (D1 / SQLite). Additive; legacy KV data is never deleted.
-- Conventions: ids are prefixed text (shared/contracts.js ID_PREFIX); *_at are epoch milliseconds (INTEGER);
-- JSON columns are TEXT validated in code; soft deletes via deleted_at; revisions are integers bumped by CAS.

CREATE TABLE IF NOT EXISTS planner_doc (
  id          TEXT PRIMARY KEY CHECK (id = 'main'),
  revision    INTEGER NOT NULL,
  doc         TEXT NOT NULL,              -- planner doc v2 JSON (docs/architecture §4)
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

CREATE TABLE IF NOT EXISTS planner_history (
  revision     INTEGER PRIMARY KEY,
  client_op_id TEXT,
  ops          TEXT NOT NULL,             -- JSON ops applied in this revision
  conflicts    TEXT,                      -- JSON conflicts reported
  actor        TEXT,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS planner_history_client_op ON planner_history(client_op_id) WHERE client_op_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS assets (
  id              TEXT PRIMARY KEY,
  compartment_id  TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN ('compartment','tool','tool_group','mount','arrangement','other','rendering','markup','legacy_upload')),
  provenance      TEXT NOT NULL CHECK (provenance IN ('user_photo','reference','ai_concept','approved_concept','as_built_photo','legacy_upload')),
  status          TEXT NOT NULL CHECK (status IN ('pending','committed','deleted')),
  visibility      TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public')),
  title           TEXT,
  notes           TEXT,
  width           INTEGER,
  height          INTEGER,
  bytes           INTEGER,
  sha256          TEXT,
  original_key    TEXT,
  original_type   TEXT,
  display_key     TEXT,
  thumb_key       TEXT,
  variants_ready  TEXT NOT NULL DEFAULT '[]', -- JSON array of uploaded variant names
  idempotency_key TEXT,
  legacy_uid      TEXT,
  created_by      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  committed_at    INTEGER,
  deleted_at      INTEGER,
  deleted_by      TEXT,
  revision        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS assets_compartment ON assets(compartment_id, status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS assets_legacy_uid ON assets(legacy_uid) WHERE legacy_uid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS assets_idempotency ON assets(created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS asset_links (
  id            TEXT PRIMARY KEY,
  asset_id      TEXT NOT NULL REFERENCES assets(id),
  target_type   TEXT NOT NULL CHECK (target_type IN ('equipment','assignment','mount','bundle')),
  target_id     TEXT NOT NULL,
  equipment_id  TEXT,                     -- denormalized for assignment/bundle links
  quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 500),
  region        TEXT,                     -- JSON {x,y,w,h} normalized 0..1, optional
  state         TEXT NOT NULL DEFAULT 'confirmed' CHECK (state IN ('suggested','confirmed','rejected')),
  label         TEXT,                     -- recognition label for suggestions
  confidence    REAL,
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS asset_links_asset ON asset_links(asset_id);
CREATE INDEX IF NOT EXISTS asset_links_target ON asset_links(target_type, target_id);
CREATE INDEX IF NOT EXISTS asset_links_equipment ON asset_links(equipment_id);

CREATE TABLE IF NOT EXISTS mounts (
  id              TEXT PRIMARY KEY,
  compartment_id  TEXT NOT NULL,
  name            TEXT,
  manufacturer    TEXT,
  model           TEXT,
  description     TEXT,
  dimensions      TEXT,
  orientation     TEXT CHECK (orientation IS NULL OR orientation IN ('vertical','horizontal','angled')),
  zone            TEXT,
  capacity        INTEGER,
  classification  TEXT NOT NULL DEFAULT 'mounting' CHECK (classification IN ('mounting','inventory','reference')),
  status          TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('existing','proposed','optional','awaiting_verification')),
  equipment_id    TEXT,                   -- set when classification = 'inventory'
  notes           TEXT,
  created_by      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  revision        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS mounts_compartment ON mounts(compartment_id, deleted_at);

CREATE TABLE IF NOT EXISTS mount_links (
  mount_id     TEXT NOT NULL REFERENCES mounts(id),
  target_type  TEXT NOT NULL CHECK (target_type IN ('equipment','assignment','asset')),
  target_id    TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (mount_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS designs (
  compartment_id  TEXT PRIMARY KEY,
  revision        INTEGER NOT NULL,
  layout          TEXT NOT NULL,          -- JSON {zones:[...], placements:[{targetType,targetId,zone,orientation,x?,y?,w?,h?,notes?}], notes?}
  updated_by      TEXT,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id                  TEXT PRIMARY KEY,
  compartment_id      TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('render','recognize','verify')),
  mode                TEXT CHECK (mode IS NULL OR mode IN ('plan','reference','edit')),
  preset              TEXT,
  model               TEXT NOT NULL,
  quality             TEXT,
  complexity          TEXT,
  size                TEXT,
  output_format       TEXT,
  idempotency_key     TEXT NOT NULL,
  requested_by        TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('queued','claimed','preparing','generating','saving','completed','failed','cancelled')),
  spec                TEXT NOT NULL,      -- immutable scene spec snapshot (l1.scene/1)
  spec_hash           TEXT NOT NULL,
  prompt              TEXT,               -- deterministic prompt text built from spec
  inventory_fingerprint TEXT,
  planner_revision    INTEGER,
  design_revision     INTEGER,
  parent_version_id   TEXT,
  subject_asset_id    TEXT,               -- recognize: the photo; edit: markup asset
  reference_asset_ids TEXT NOT NULL DEFAULT '[]',
  attempts            INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 2,
  lease_owner         TEXT,
  lease_expires_at    INTEGER,
  heartbeat_at        INTEGER,
  provider_called_at  INTEGER,            -- set when status becomes 'generating' (paid-call boundary)
  next_attempt_at     INTEGER,
  cancel_requested    INTEGER NOT NULL DEFAULT 0,
  error_code          TEXT,
  error_message       TEXT,
  result_version_id   TEXT,
  result              TEXT,               -- JSON for recognize/verify
  usage               TEXT,               -- JSON provider usage
  provider_request_id TEXT,
  estimated_cost_usd  REAL NOT NULL DEFAULT 0,
  actual_cost_usd     REAL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  completed_at        INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency ON generation_jobs(requested_by, idempotency_key);
CREATE INDEX IF NOT EXISTS jobs_queue ON generation_jobs(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS jobs_compartment ON generation_jobs(compartment_id, created_at);

CREATE TABLE IF NOT EXISTS image_versions (
  id                    TEXT PRIMARY KEY,
  compartment_id        TEXT NOT NULL,
  parent_version_id     TEXT,
  job_id                TEXT NOT NULL,
  asset_id              TEXT NOT NULL REFERENCES assets(id),
  spec                  TEXT NOT NULL,
  spec_hash             TEXT NOT NULL,
  prompt                TEXT,
  instructions          TEXT,
  model                 TEXT NOT NULL,
  settings              TEXT NOT NULL,     -- JSON {preset, quality, complexity, size, outputFormat}
  inventory_fingerprint TEXT NOT NULL,
  planner_revision      INTEGER,
  design_revision       INTEGER,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected','deleted')),
  verification          TEXT,
  usage                 TEXT,
  cost_usd              REAL,
  created_by            TEXT,
  created_at            INTEGER NOT NULL,
  approved_by           TEXT,
  approved_at           INTEGER,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS versions_compartment ON image_versions(compartment_id, created_at);
CREATE INDEX IF NOT EXISTS versions_parent ON image_versions(parent_version_id);

CREATE TABLE IF NOT EXISTS main_images (
  compartment_id        TEXT PRIMARY KEY,
  revision              INTEGER NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('preset','asset','version')),
  ref                   TEXT NOT NULL,     -- preset path | asset id | version id
  inventory_fingerprint TEXT,
  previous              TEXT,              -- JSON {kind, ref} for one-step recovery
  updated_by            TEXT,
  updated_at            INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS spend_ledger (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL,
  actor         TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('reserved','settled','released')),
  estimated_usd REAL NOT NULL,
  actual_usd    REAL,
  model         TEXT,
  usage         TEXT,
  day           TEXT NOT NULL,             -- YYYY-MM-DD (America/New_York)
  month         TEXT NOT NULL,             -- YYYY-MM   (America/New_York)
  created_at    INTEGER NOT NULL,
  settled_at    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS spend_job ON spend_ledger(job_id);
CREATE INDEX IF NOT EXISTS spend_day ON spend_ledger(day, state);
CREATE INDEX IF NOT EXISTS spend_month ON spend_ledger(month, state);
CREATE INDEX IF NOT EXISTS spend_actor_day ON spend_ledger(actor, day, state);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,               -- JSON
  revision    INTEGER NOT NULL,
  updated_by  TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings_history (
  key         TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  value       TEXT NOT NULL,
  updated_by  TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (key, revision)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           INTEGER NOT NULL,
  actor        TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  detail       TEXT                         -- JSON, redacted (no image bytes, no secrets, truncated free text)
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS audit_entity ON audit_log(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS migrations_meta (
  name        TEXT PRIMARY KEY,
  ran_at      INTEGER NOT NULL,
  report      TEXT NOT NULL
);
