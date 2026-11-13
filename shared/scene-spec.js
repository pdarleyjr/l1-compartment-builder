/* eslint-disable no-unused-vars -- P0 interface stub; remove when implemented */
// Owner: part C. Interface stub (P0). Versioned scene spec (schema 'l1.scene/1') + deterministic prompt.
/** input = {compId, doc, design, assets, links, mounts, settings, mode, preset, instructions, parentVersion, markupAsset}
 * → spec {schema, compartment, equipment:[...], mounts:[...], references:[...], render:{...}, inventoryFingerprint, plannerRevision, designRevision} */
export async function buildSceneSpec(input) { throw new Error('NOT_IMPLEMENTED: interface stub, owner replaces it'); }
/** Deterministic prompt text from a spec (treats operator text as quoted data). @returns {string} */ export function buildPrompt(spec) { throw new Error('NOT_IMPLEMENTED: interface stub, owner replaces it'); }
/** @returns {{direct:{assetId, role, label}[], contactSheets:{label, items:{assetId, label}[]}[]}} */ export function selectReferences(spec, maxPerRequest) { throw new Error('NOT_IMPLEMENTED: interface stub, owner replaces it'); }
/** @returns {Promise<string>} */ export async function specHash(spec) { throw new Error('NOT_IMPLEMENTED: interface stub, owner replaces it'); }