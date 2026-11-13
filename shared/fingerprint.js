// Staleness fingerprint of what is assigned in one compartment.
import { sha256Hex } from './ids.js';
import { canonicalJson } from './lib/canonical.js';
import { equipmentIdOf } from './lib/doc.js';

/**
 * Stable hash of what is assigned in one compartment: sha256 of canonical JSON of sorted [equipmentId, count] pairs.
 * Renames keep equipment ids and therefore do not change it; adding, removing or swapping items does.
 * @param {object} doc planner doc (v2; v1 views fall back to deterministic/name keys)
 * @param {string} compId
 * @returns {Promise<string>}
 */
export async function inventoryFingerprint(doc, compId) {
  const counts = new Map();
  for (const name of doc.allocations?.[compId] ?? []) {
    if (!name) continue;
    const key = equipmentIdOf(doc, name) ?? `name:${name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const pairs = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256Hex(canonicalJson(pairs));
}
