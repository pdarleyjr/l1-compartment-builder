// Builds the immutable job plan (scene spec, prompt, size, estimate) from authoritative server state.
import { RENDER_MODES } from '../../../shared/contracts.js';
import { compartmentGeometry, renderSizeFor } from '../../../shared/apparatus-render.js';
import { estimateCost } from '../../../shared/cost.js';
import { inventoryFingerprint } from '../../../shared/fingerprint.js';
import { buildPrompt, buildSceneSpec, selectReferences, specHash } from '../../../shared/scene-spec.js';
import { compartmentAssignments } from '../../../shared/planner.js';
import { SCENE_SPEC_SCHEMA } from '../../../shared/contracts.js';
import { HttpError } from '../http.js';
import { getSettings } from '../settings.js';
import { loadPlannerDoc } from '../planner.js';
import { linksFor, parseJson, assetDto } from './common.js';

export const PLAN_SETTING_KEYS = [
  'studio.enabled', 'ai.enabled', 'presets', 'pricing', 'style.houseText', 'compartments.overrides', 'references.maxPerRequest',
  'recognition.enabled', 'recognition.model', 'budget.monthlyUsd', 'budget.dailyUsd', 'budget.userDailyUsd',
  'jobs.maxConcurrent', 'jobs.userMaxConcurrent',
];
const USER_PHOTO_CATEGORIES = "'compartment','tool','tool_group','mount','arrangement','other'";

/** Gate on the Studio/AI switches. `needAi=false` is used by estimates. */
export function assertEnabled(settings, needAi) {
  if (settings['studio.enabled'] === false) throw new HttpError('STUDIO_DISABLED', 'The Studio is turned off right now.');
  if (needAi && settings['ai.enabled'] !== true) throw new HttpError('AI_DISABLED', 'AI image generation is turned off. An administrator can turn it on in Studio settings.');
}

async function loadAssetFor(db, id, compId, label, categories) {
  const row = await db.prepare("SELECT * FROM assets WHERE id = ? AND status = 'committed'").bind(id).first();
  if (!row || row.compartment_id !== compId || (categories && !categories.includes(row.category))) {
    throw new HttpError('INVALID_REQUEST', `${label} does not belong to this compartment.`);
  }
  return row;
}

async function loadMounts(db, compId) {
  const { results } = await db.prepare('SELECT * FROM mounts WHERE compartment_id = ? AND deleted_at IS NULL ORDER BY created_at, id').bind(compId).all();
  const rows = results || [];
  const links = new Map(rows.map(r => [r.id, []]));
  if (rows.length) {
    const { results: ml } = await db.prepare(`SELECT * FROM mount_links WHERE mount_id IN (${rows.map(() => '?').join(',')})`).bind(...rows.map(r => r.id)).all();
    for (const l of ml || []) links.get(l.mount_id)?.push({ targetType: l.target_type, targetId: l.target_id });
  }
  return rows.map(r => ({
    id: r.id, name: r.name, manufacturer: r.manufacturer, model: r.model, description: r.description, dimensions: parseJson(r.dimensions, null),
    orientation: r.orientation, zone: r.zone, capacity: r.capacity, classification: r.classification, status: r.status,
    equipmentId: r.equipment_id, notes: r.notes, links: links.get(r.id),
  }));
}

/**
 * Validate a job request against the compartment and build everything createJob/estimate/retry need.
 * @param {*} db
 * @param {string} compId
 * @param {object} req normalized request ({kind, mode, preset, instructions, parentVersionId, markupAssetId, assetId, referenceAssetIds?})
 * @param {object} settings values for PLAN_SETTING_KEYS
 */
export async function planJob(db, compId, req, settings) {
  const loaded = await loadPlannerDoc(db);
  if (!loaded) throw new HttpError('INTERNAL', 'The planner document is not initialised.');
  const { doc } = loaded;
  const overrides = settings['compartments.overrides'] || {};
  const fingerprint = await inventoryFingerprint(doc, compId);
  const request = {
    kind: req.kind, mode: req.mode ?? null, preset: req.preset ?? null, instructions: req.instructions ?? null,
    parentVersionId: req.parentVersionId ?? null, markupAssetId: req.markupAssetId ?? null, assetId: req.assetId ?? null,
    referenceAssetIds: req.referenceAssetIds ?? [],
  };
  if (req.kind === 'recognize') return planRecognize(db, compId, request, settings, doc, loaded.revision, fingerprint);
  if (req.kind !== 'render') throw new HttpError('INVALID_REQUEST', 'Unsupported job kind.');

  const presetName = req.preset ?? 'preview';
  const presetCfg = (settings.presets || {})[presetName];
  if (!presetCfg) throw new HttpError('INVALID_REQUEST', `Preset "${presetName}" is not available.`);
  request.preset = presetName;
  const mode = req.mode ?? 'plan';
  if (!RENDER_MODES.includes(mode)) throw new HttpError('INVALID_REQUEST', 'Unknown render mode.');
  request.mode = mode;
  let parentVersion = null;
  let markupAsset = null;
  if (mode === 'edit') {
    if (!req.parentVersionId) throw new HttpError('INVALID_REQUEST', 'Edit mode needs the version to edit.');
    const v = await db.prepare("SELECT * FROM image_versions WHERE id = ? AND status IN ('draft','approved')").bind(req.parentVersionId).first();
    if (!v || v.compartment_id !== compId) throw new HttpError('INVALID_REQUEST', 'That version does not belong to this compartment.');
    parentVersion = { id: v.id, assetId: v.asset_id, instructions: v.instructions, inventoryFingerprint: v.inventory_fingerprint };
    if (req.markupAssetId) markupAsset = await loadAssetFor(db, req.markupAssetId, compId, 'The markup layer', ['markup']);
  } else if (req.parentVersionId || req.markupAssetId) {
    throw new HttpError('INVALID_REQUEST', 'A parent version or markup layer is only allowed in edit mode.');
  }

  for (const refId of request.referenceAssetIds) {
    await loadAssetFor(db, refId, compId, 'A reference photo', USER_PHOTO_CATEGORIES.split(',').map(c => c.replace(/'/g, '')));
  }
  const { results } = await db.prepare(
    `SELECT * FROM assets WHERE compartment_id = ? AND status = 'committed' AND category IN (${USER_PHOTO_CATEGORIES}) ORDER BY created_at, id`,
  ).bind(compId).all();
  const assetRows = results || [];
  const linkMap = await linksFor(db, assetRows.map(r => r.id), ['confirmed']);
  const assets = assetRows.map(r => assetDto(r, { links: linkMap.get(r.id) }));
  const mounts = await loadMounts(db, compId);
  const design = await db.prepare('SELECT * FROM designs WHERE compartment_id = ?').bind(compId).first();
  const designObj = design ? { revision: design.revision, layout: parseJson(design.layout, {}) } : { revision: 0, layout: { zones: compartmentGeometry(compId, overrides[compId] || {}).zones, placements: [] } };

  const spec = await buildSceneSpec({
    compId, doc, design: designObj, assets, links: assets.flatMap(a => a.links || []), mounts, settings,
    mode, preset: presetName, instructions: req.instructions ?? null, parentVersion, referenceAssetIds: request.referenceAssetIds,
    markupAsset: markupAsset ? { id: markupAsset.id } : null,
  });
  const prompt = buildPrompt(spec);
  const size = renderSizeFor(compId, overrides[compId] || {});
  const maxRefs = settings['references.maxPerRequest'] ?? 10;
  const selection = selectReferences(spec, maxRefs);
  const sheetIds = (selection.contactSheets || []).flatMap(s => (s.items || []).map(i => i.assetId));
  const referenceAssetIds = [...new Set([
    ...(spec.references || []).map(r => r.assetId), ...selection.direct.map(r => r.assetId), ...sheetIds,
    ...(parentVersion ? [parentVersion.assetId] : []), ...(markupAsset ? [markupAsset.id] : []),
  ].filter(Boolean))];
  const estimate = estimateCost({
    model: presetCfg.model, quality: presetCfg.quality, size, referenceCount: selection.direct.length, promptChars: prompt.length,
  }, settings.pricing);
  return {
    kind: 'render', mode, preset: presetName, presetCfg, model: presetCfg.model, quality: presetCfg.quality, complexity: presetCfg.complexity,
    outputFormat: presetCfg.outputFormat, size, spec: { ...spec, request }, specHash: await specHash(spec), prompt, estimate,
    fingerprint: spec.inventoryFingerprint ?? fingerprint, plannerRevision: spec.plannerRevision ?? loaded.revision,
    designRevision: spec.designRevision ?? designObj.revision, parentVersionId: parentVersion?.id ?? null,
    subjectAssetId: markupAsset?.id ?? null, referenceAssetIds, request,
  };
}

async function planRecognize(db, compId, request, settings, doc, plannerRevision, fingerprint) {
  if (settings['recognition.enabled'] === false) throw new HttpError('AI_DISABLED', 'Photo recognition is turned off.');
  if (!request.assetId) throw new HttpError('INVALID_REQUEST', 'Choose the photo to recognize.');
  const asset = await loadAssetFor(db, request.assetId, compId, 'That photo', ['compartment', 'tool', 'tool_group', 'mount', 'arrangement', 'other']);
  const model = settings['recognition.model'];
  const registry = Object.entries(doc.equipmentIds || {}).map(([name, equipmentId]) => ({ equipmentId, name }));
  const here = compartmentAssignments(doc, compId).map(a => ({ equipmentId: a.equipmentId, name: a.name }));
  const spec = {
    schema: SCENE_SPEC_SCHEMA, kind: 'recognize', compartmentId: compId, subjectAssetId: asset.id, assignedHere: here, candidates: registry,
    references: [{ assetId: asset.id, role: 'subject', label: asset.title || asset.category }], inventoryFingerprint: fingerprint, plannerRevision, request,
  };
  const prompt = [
    'Identify the pieces of fire-service equipment visible in this photo of an apparatus compartment.',
    'Return JSON {"objects":[{"label","quantity","region":{"x","y","w","h"} normalized 0..1,"candidates":[{"equipmentId","name","confidence"}]}]}.',
    'Choose candidates only from the provided inventory; prefer items assigned in this compartment. Do not invent equipment.',
  ].join('\n');
  const estimate = estimateCost({ model, quality: 'low', size: '1024x1024', referenceCount: 1, promptChars: prompt.length + JSON.stringify(registry).length }, settings.pricing);
  return {
    kind: 'recognize', mode: null, preset: null, presetCfg: null, model, quality: 'low', complexity: null, outputFormat: null, size: null,
    spec, specHash: await specHash(spec), prompt, estimate, fingerprint, plannerRevision, designRevision: null, parentVersionId: null,
    subjectAssetId: asset.id, referenceAssetIds: [asset.id], request,
  };
}

export async function loadPlanSettings(db) {
  return getSettings(db, PLAN_SETTING_KEYS);
}
