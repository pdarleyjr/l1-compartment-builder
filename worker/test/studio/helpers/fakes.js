// Faithful small fakes for the shared/*.js and E1 (settings/planner) modules, which are stubs in this worktree.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { SETTINGS_DEFAULTS } from '../../../../shared/contracts.js';

let counter = 0;
export const resetIds = () => { counter = 0; };
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

export const idsFake = {
  newId(prefix) {
    counter += 1;
    let n = counter; let s = '';
    while (s.length < 8) { s = B36[n % 36] + s; n = Math.floor(n / 36); }
    return `${prefix}_${'0'.repeat(18)}${s}`;
  },
  async sha256Hex(input) { return createHash('sha256').update(typeof input === 'string' ? input : Buffer.from(input)).digest('hex'); },
  async equipmentIdForName(name) { return `eq_${createHash('sha256').update(name).digest('hex').slice(0, 16)}`; },
};

export const plannerSharedFake = {
  compartmentAssignments(doc, compId) {
    const rows = [];
    (doc.allocations?.[compId] || []).forEach((name, slotIndex) => {
      if (!name) return;
      rows.push({ slotIndex, name, equipmentId: doc.equipmentIds?.[name] ?? null, assignmentId: doc.assignmentIds?.[compId]?.[slotIndex] ?? null, bundleId: null });
    });
    return rows;
  },
};

export const fingerprintFake = {
  async inventoryFingerprint(doc, compId) {
    const counts = {};
    for (const r of plannerSharedFake.compartmentAssignments(doc, compId)) counts[r.equipmentId] = (counts[r.equipmentId] || 0) + 1;
    return createHash('sha256').update(JSON.stringify(Object.entries(counts).sort())).digest('hex').slice(0, 16);
  },
};

export const apparatusRenderFake = {
  compartmentGeometry: (compId, overrides = {}) => ({ id: compId, zones: overrides.zones || ['upper_shelf', 'floor'], aspect: 1.5 }),
  renderSizeFor: () => '1536x1024',
};

export const costFake = {
  estimateCost({ model, quality, referenceCount }) {
    const base = { low: 0.05, medium: 0.1, high: 0.4, xhigh: 0.7, max: 1.2 }[quality] ?? 0.1;
    return { usd: Math.round((base + referenceCount * 0.01) * 100) / 100, basis: `${model}/${quality}` };
  },
  actualCost: usage => ((usage.inputTokens || 0) * 8 + (usage.outputTokens || 0) * 30) / 1e6,
};

export const sceneSpecFake = {
  async buildSceneSpec(input) {
    const refs = (input.assets || []).map(a => ({ assetId: a.id, role: a.category, label: a.title || a.category }));
    if (input.parentVersion) refs.unshift({ assetId: input.parentVersion.assetId, role: 'parent', label: 'Parent' });
    if (input.markupAsset) refs.push({ assetId: input.markupAsset.id, role: 'markup', label: 'Markup' });
    return {
      schema: 'l1.scene/1', compartment: { id: input.compId }, mode: input.mode, equipment: [], mounts: input.mounts.map(m => m.id), references: refs,
      render: { preset: input.preset, instructions: input.instructions },
      inventoryFingerprint: await fingerprintFake.inventoryFingerprint(input.doc, input.compId), plannerRevision: input.doc.__rev ?? 1, designRevision: input.design.revision,
    };
  },
  buildPrompt: spec => `PROMPT for ${spec.compartment.id} (${spec.mode}) ${spec.render.instructions ?? ''}`,
  selectReferences: (spec, max) => ({ direct: spec.references.slice(0, max), contactSheets: spec.references.length > max ? [{ label: 'Sheet 1', items: spec.references.slice(max).map(r => ({ assetId: r.assetId, label: r.label })) }] : [] }),
  async specHash(spec) { return createHash('sha256').update(JSON.stringify(spec)).digest('hex'); },
};

const ok = value => ({ ok: true, value });
const bad = error => ({ ok: false, error });
const str = (v, max) => v === undefined || v === null || (typeof v === 'string' && v.length <= max);

export const validationFake = {
  validateAssetCreate(b) {
    if (!b || typeof b.compartmentId !== 'string' || typeof b.category !== 'string') return bad('compartmentId and category are required');
    if (![b.width, b.height, b.bytes].every(n => Number.isInteger(n) && n > 0)) return bad('width, height and bytes must be positive integers');
    if (!/^[0-9a-f]{64}$/.test(b.sha256 || '')) return bad('sha256 must be 64 hex characters');
    if (!str(b.title, 200) || !str(b.notes, 2000)) return bad('title/notes too long');
    return ok({ compartmentId: b.compartmentId, category: b.category, title: b.title ?? null, notes: b.notes ?? null, width: b.width, height: b.height, bytes: b.bytes, sha256: b.sha256, idempotencyKey: b.idempotencyKey ?? null });
  },
  validateAssetUpdate(b) {
    const v = {};
    for (const k of ['title', 'notes', 'category']) if (b[k] !== undefined) v[k] = b[k];
    return ok(v);
  },
  // Mirrors shared/validation.js: the argument is the whole body {links?, plannerOps?, baseRevision?}.
  validateLinks(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body must be an object');
    const links = body.links ?? [];
    if (!Array.isArray(links)) return bad('links must be a list');
    return ok({ links: links.map(l => ({ targetType: l.targetType, targetId: l.targetId, quantity: l.quantity ?? 1, region: l.region ?? null })), plannerOps: body.plannerOps ?? [], baseRevision: body.baseRevision });
  },
  validateMount(b, { partial = false } = {}) {
    if (!partial && !b.name) return bad('name is required');
    const v = {};
    for (const k of ['name', 'manufacturer', 'model', 'description', 'dimensions', 'orientation', 'zone', 'capacity', 'classification', 'status', 'equipmentId', 'notes']) if (b[k] !== undefined) v[k] = b[k];
    return ok(v);
  },
  // Mirrors the canonical contract: {layout:{placements:[{targetType, targetId, zone, orientation?, notes?}], notes?}, expectRevision}.
  validateDesign(b) {
    const l = b?.layout;
    if (!l || typeof l !== 'object' || Array.isArray(l) || Object.keys(l).some(k => !['placements', 'notes'].includes(k))) return bad('layout must be {placements, notes?}');
    const placements = l.placements ?? [];
    if (!Array.isArray(placements)) return bad('layout.placements must be a list');
    for (const p of placements) {
      if (!['assignment', 'equipment', 'mount'].includes(p?.targetType) || typeof p.targetId !== 'string' || typeof p.zone !== 'string') return bad('invalid placement');
    }
    return ok({ expectRevision: b.expectRevision, layout: { ...l, placements } });
  },
  validateJobRequest(b) {
    if (!['render', 'recognize'].includes(b?.kind)) return bad('kind must be render or recognize');
    return ok({ ...b });
  },
};

/** getSettings/getSetting backed by the settings table, falling back to SETTINGS_DEFAULTS. */
export function settingsFake() {
  async function getSettings(db, keys) {
    const out = {};
    for (const k of keys) {
      const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(k).first();
      out[k] = row ? JSON.parse(row.value) : SETTINGS_DEFAULTS[k];
    }
    return out;
  }
  return { getSettings, getSetting: async (db, k) => (await getSettings(db, [k]))[k] };
}

/** loadPlannerDoc/applyPlannerOpsInBatch backed by planner_doc. Supports setSlot ops with `expect` preconditions. */
export const plannerModuleFake = {
  async loadPlannerDoc(db) {
    const row = await db.prepare("SELECT revision, doc FROM planner_doc WHERE id = 'main'").first();
    if (!row) return null;
    const doc = JSON.parse(row.doc);
    doc.__rev = row.revision;
    return { revision: row.revision, doc };
  },
  async applyPlannerOpsInBatch(db, { ops, actor, now }) {
    const row = await db.prepare("SELECT revision, doc FROM planner_doc WHERE id = 'main'").first();
    const doc = JSON.parse(row.doc);
    const applied = []; const conflicts = [];
    ops.forEach((op, index) => {
      if (op.type !== 'setSlot') { conflicts.push({ index, reason: 'INVALID' }); return; }
      const list = (doc.allocations[op.comp] ||= []);
      const cur = list[op.index] || '';
      if (cur !== (op.expect ?? '')) { conflicts.push({ index, reason: 'PRECONDITION', current: cur }); return; }
      list[op.index] = op.value;
      (doc.assignmentIds[op.comp] ||= [])[op.index] = op.value ? `as_${op.comp}_${op.index}_${row.revision + 1}` : null;
      applied.push(index);
    });
    const revision = applied.length ? row.revision + 1 : row.revision;
    const statements = applied.length
      ? [db.prepare("UPDATE planner_doc SET revision = ?, doc = ?, updated_at = ?, updated_by = ? WHERE id = 'main' AND revision = ?").bind(revision, JSON.stringify(doc), now, actor?.email ?? actor?.serviceId ?? actor, row.revision)]
      : [];
    doc.__rev = revision;
    return { statements, result: { revision, doc, applied, conflicts } };
  },
};
