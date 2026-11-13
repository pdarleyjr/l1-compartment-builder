// Versioned scene spec (schema 'l1.scene/1') + deterministic prompt (architecture §8).
import { COMPARTMENT_IDS, INSTRUCTIONS_MAX, SCENE_SPEC_SCHEMA, SETTINGS_DEFAULTS } from './contracts.js';
import { VISUAL_DESCRIPTIONS } from './apparatus.js';
import { compartmentGeometry, renderSizeFor } from './apparatus-render.js';
import { inventoryFingerprint } from './fingerprint.js';
import { sha256Hex } from './ids.js';
import { canonicalJson } from './lib/canonical.js';
import { dimsOf } from './lib/doc.js';
import { buildPrompt } from './lib/prompt.js';
import { splitReferences } from './lib/references.js';
import { compartmentAssignments } from './planner.js';

export { buildPrompt };

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const usable = (asset, compId) => asset && (asset.status === undefined || asset.status === 'committed') && !asset.deletedAt
  && (asset.compartmentId === undefined || asset.compartmentId === compId);

function placementsOf(design) {
  const layout = design?.layout ?? design ?? {};
  return Array.isArray(layout.placements) ? layout.placements : [];
}

/**
 * Build the scene spec for one compartment. Equipment comes strictly from the authoritative planner doc; only
 * `confirmed` links to committed assets of this compartment contribute photos (suggested/rejected are ignored).
 * Photos: plan → compartment photo only; edit → compartment + parent version + markup; reference → everything.
 * @param {{compId:string, doc:object, design?:object, assets?:object[], links?:object[], mounts?:object[], settings?:object,
 *   mode?:'plan'|'reference'|'edit', preset?:string, instructions?:string, parentVersion?:{id:string, assetId:string}|null,
 *   markupAsset?:{id:string}|null, plannerRevision?:number}} input
 * @returns {Promise<object>} spec {schema, compartment, equipment, mounts, references, render, inventoryFingerprint, plannerRevision, designRevision}
 */
export async function buildSceneSpec(input) {
  const { compId, doc } = input;
  if (!COMPARTMENT_IDS.includes(compId)) throw new RangeError(`unknown compartment ${compId}`);
  const settings = { ...SETTINGS_DEFAULTS, ...(input.settings ?? {}) };
  const mode = input.mode ?? 'reference';
  const presetName = input.preset ?? 'preview';
  const preset = settings.presets?.[presetName] ?? SETTINGS_DEFAULTS.presets[presetName] ?? SETTINGS_DEFAULTS.presets.preview;
  const overrides = settings['compartments.overrides'];
  const geometry = compartmentGeometry(compId, overrides);
  const size = renderSizeFor(compId, overrides);
  const assets = new Map((input.assets ?? []).filter(a => usable(a, compId)).map(a => [a.id, a]));
  const confirmed = (input.links ?? []).filter(l => l.state === 'confirmed' && assets.has(l.assetId));
  const placements = placementsOf(input.design);

  // Equipment: group the compartment's occupied slots by equipment id.
  const groups = new Map();
  for (const row of compartmentAssignments(doc, compId)) {
    const key = row.equipmentId ?? `name:${row.name}`;
    if (!groups.has(key)) groups.set(key, { equipmentId: key, name: row.name, count: 0, assignmentIds: [], bundleIds: [] });
    const g = groups.get(key);
    g.count += 1;
    if (row.assignmentId) g.assignmentIds.push(row.assignmentId);
    if (row.bundleId && !g.bundleIds.includes(row.bundleId)) g.bundleIds.push(row.bundleId);
  }
  const bundleName = id => (doc.bundles?.[compId] ?? []).find(b => b.id === id)?.name ?? null;
  const tools = (doc.customTools ?? []);
  const photosFor = g => {
    const ids = new Set();
    for (const l of confirmed) {
      if (l.targetType === 'mount' || (l.targetType === 'bundle' && !l.equipmentId)) continue;
      const hit = (l.targetType === 'equipment' && l.targetId === g.equipmentId)
        || (l.targetType === 'assignment' && g.assignmentIds.includes(l.targetId))
        || (l.targetType === 'bundle' && l.equipmentId === g.equipmentId);
      if (hit) ids.add(l.assetId);
    }
    return [...ids].sort(cmp);
  };
  const place = (g, type) => placements.find(p => (p.targetType === type) && (type === 'equipment' ? p.targetId === g.equipmentId
    : type === 'assignment' ? g.assignmentIds.includes(p.targetId) : g.bundleIds.includes(p.targetId)));
  const equipment = [...groups.values()].sort((a, b) => cmp(a.name, b.name) || cmp(a.equipmentId, b.equipmentId)).map(g => {
    const p = place(g, 'equipment') ?? place(g, 'assignment') ?? place(g, 'bundle');
    return {
      equipmentId: g.equipmentId, name: g.name, quantity: g.count, assignmentIds: g.assignmentIds,
      dims: dimsOf(doc, g.name) || null,
      visual: VISUAL_DESCRIPTIONS[g.name] ?? tools.find(t => t.name === g.name)?.description ?? null,
      referenceAssetIds: mode === 'reference' ? photosFor(g) : [],
      zone: p?.zone ?? null, orientation: p?.orientation ?? null, bundle: g.bundleIds.length ? bundleName(g.bundleIds[0]) : null,
    };
  });

  // Mounts.
  const mountPhotos = id => (mode === 'reference'
    ? [...new Set(confirmed.filter(l => l.targetType === 'mount' && l.targetId === id).map(l => l.assetId))].sort(cmp) : []);
  const mounts = (input.mounts ?? []).filter(m => !m.deletedAt && (m.compartmentId === undefined || m.compartmentId === compId))
    .sort((a, b) => cmp(a.id, b.id)).map(m => {
      const mp = placements.find(p => p.targetType === 'mount' && p.targetId === m.id);
      return {
        id: m.id, name: m.name ?? null, description: m.description ?? null, dimensions: m.dimensions ?? null, status: m.status ?? 'proposed',
        zone: m.zone ?? mp?.zone ?? null, orientation: m.orientation ?? mp?.orientation ?? null,
        equipmentIds: [...new Set([...(m.equipmentIds ?? []), ...(m.equipmentId ? [m.equipmentId] : [])])].sort(cmp), referenceAssetIds: mountPhotos(m.id),
      };
    });

  // References.
  const references = [];
  const add = (assetId, role, label, equipmentIds = []) => {
    if (assetId && !references.some(r => r.assetId === assetId)) references.push({ assetId, role, label, equipmentIds });
  };
  const compPhotos = [...assets.values()].filter(a => a.category === 'compartment').sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || cmp(a.id, b.id));
  if (compPhotos[0]) add(compPhotos[0].id, 'compartment', 'Compartment photo');
  if (input.parentVersion?.assetId) add(input.parentVersion.assetId, 'parent', 'Previous version');
  if (input.markupAsset?.id) add(input.markupAsset.id, 'markup', 'Markup (areas to change)');
  if (mode === 'reference') {
    const byAsset = new Map();
    for (const e of equipment) for (const id of e.referenceAssetIds) {
      if (!byAsset.has(id)) byAsset.set(id, []);
      byAsset.get(id).push(e);
    }
    for (const [assetId, list] of [...byAsset.entries()].sort((a, b) => cmp(a[0], b[0]))) {
      add(assetId, 'tool', list.map(e => e.name).join(' + '), list.map(e => e.equipmentId).sort(cmp));
    }
    for (const m of mounts) for (const id of m.referenceAssetIds) add(id, 'mount', m.name ?? 'Mount');
    for (const a of [...assets.values()].sort((x, y) => cmp(x.id, y.id))) {
      if (a.category === 'arrangement') add(a.id, 'arrangement', a.title || 'Existing arrangement');
      else if (a.category === 'other') add(a.id, 'other', a.title || 'Reference');
    }
  }

  const instructions = String(input.instructions ?? '').trim().slice(0, INSTRUCTIONS_MAX);
  return {
    schema: SCENE_SPEC_SCHEMA,
    compartment: {
      id: compId, label: geometry.label, specText: geometry.specText, dimensions: geometry.dimensions,
      dimensionsKnown: geometry.dimensionsKnown, features: geometry.features, zones: geometry.zones,
      orientation: geometry.orientation, aspect: Math.round(geometry.aspect * 1000) / 1000, size,
    },
    equipment, mounts, references,
    render: {
      mode, preset: presetName, model: preset.model, quality: preset.quality, complexity: preset.complexity, size,
      outputFormat: preset.outputFormat, instructions, styleText: settings['style.houseText'] ?? '',
      parentVersionId: input.parentVersion?.id ?? null,
    },
    inventoryFingerprint: await inventoryFingerprint(doc, compId),
    plannerRevision: input.plannerRevision ?? doc.revision ?? null,
    designRevision: input.design?.revision ?? null,
  };
}

/**
 * Choose which references go to the model. Order: compartment photo → parent version → markup → one photo per
 * equipment (photos covering the most equipment first) → mounts → arrangement/other. Overflow beyond `maxPerRequest`
 * goes into labelled contact sheets of ≤ 6 items (a sheet counts as one image); `onlyInSheets` lists equipment ids whose
 * only photos are in sheets (the prompt names every tool regardless); `dropped` lists what could not fit at all.
 * @param {object} spec @param {number} maxPerRequest
 * @returns {{direct:{assetId:string, role:string, label:string}[], contactSheets:{label:string, items:{assetId:string, label:string}[]}[], onlyInSheets:string[], dropped:object[]}}
 */
export function selectReferences(spec, maxPerRequest) {
  return splitReferences(spec.references, maxPerRequest);
}

/** sha256 of the canonical JSON of the spec. @param {object} spec @returns {Promise<string>} */
export async function specHash(spec) {
  return sha256Hex(canonicalJson(spec));
}
