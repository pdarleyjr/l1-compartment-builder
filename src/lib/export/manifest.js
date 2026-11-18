// Manifest `l1.checklist-transfer/1` (docs/architecture/notes-verification-transfer.md §3). Pure ESM.
import { canonicalJson } from '../../../shared/lib/canonical.js';
import { sha256StringSync } from '../../../shared/lib/sha256.js';
import { COMPARTMENT_IDS } from '../../../shared/contracts.js';

export const MANIFEST_SCHEMA = 'l1.checklist-transfer/1';
export const COUNTING_RULE = 'One unit per occupied planner slot. Mounting hardware and kit contents are not counted.';
const verifiedFlag = { status: 'verified', reason: '' };

/** sha256 hex of the manifest without source.exportedAt and source.snapshotSha256. */
export function hashManifest(manifest) {
  const { exportedAt: _e, snapshotSha256: _s, ...source } = manifest.source ?? {};
  return sha256StringSync(canonicalJson({ ...manifest, source }));
}

/** @param {ReturnType<import('./snapshot.js').buildSnapshot>} snapshot */
export function buildManifest(snapshot) {
  const info = new Map([...snapshot.inventory, ...snapshot.strays].map(i => [i.name, i]));
  const exceptions = [];
  const perItem = new Map(); // equipmentId -> {compId: count}
  let lines = 0;
  let units = 0;
  let needsVerification = 0;

  const compartments = snapshot.compartments.map(c => {
    const groups = new Map(); // name -> {slots, assignmentIds}
    c.slots.forEach((name, i) => {
      if (!name) return;
      const g = groups.get(name) ?? { slots: [], assignmentIds: [] };
      g.slots.push(i);
      if (c.assignmentIds[i]) g.assignmentIds.push(c.assignmentIds[i]);
      groups.set(name, g);
    });
    const bundleOf = slot => {
      let found = null; // the last bundle listing a slot wins (same rule as the app)
      for (const b of c.bundles) if (b.slotIndices.includes(slot)) found = b;
      return found ? { id: found.id, name: found.name } : null;
    };
    const bundlesOf = slots => {
      const by = new Map(); // bundle id -> {id, name, slots}, in first-slot order
      for (const slot of slots) {
        const b = bundleOf(slot);
        if (!b) continue;
        const key = `${b.id}\u0000${b.name}`;
        const e = by.get(key) ?? { id: b.id, name: b.name, slots: [] };
        e.slots.push(slot);
        by.set(key, e);
      }
      return [...by.values()];
    };
    const items = [...groups].map(([name, g]) => {
      const it = info.get(name);
      const verification = it?.verification ?? verifiedFlag;
      const line = {
        lineKey: `${c.id}:${it.equipmentId}`, equipmentId: it.equipmentId, name, quantity: g.slots.length, slots: g.slots,
        assignmentIds: g.assignmentIds, bundle: bundleOf(g.slots[0]), bundles: bundlesOf(g.slots), custom: it.custom, description: it.description,
        dimensions: it.dimensions, verification: { ...verification },
      };
      const per = perItem.get(it.equipmentId) ?? {};
      per[c.id] = (per[c.id] ?? 0) + line.quantity;
      perItem.set(it.equipmentId, per);
      lines += 1;
      units += line.quantity;
      return line;
    });
    if (!items.length) exceptions.push({ type: 'empty_compartment', compartmentId: c.id, message: `${c.label} has no equipment assigned.` });
    for (const line of items) {
      if (line.verification.status !== 'needs_verification') continue;
      needsVerification += 1;
      exceptions.push({
        type: 'needs_verification', compartmentId: c.id, equipmentId: line.equipmentId,
        message: `${line.name} in ${c.label} needs verification${line.verification.reason ? `: ${line.verification.reason}` : '.'}`,
      });
    }
    return {
      id: c.id, label: c.label, side: c.side, order: c.order, protected: c.protected, spec: c.spec, note: c.note ? { ...c.note } : null, items,
    };
  });

  const catalog = snapshot.inventory.map(i => {
    const compCounts = perItem.get(i.equipmentId) ?? {};
    return {
      equipmentId: i.equipmentId, name: i.name, quantity: i.qty, assigned: i.assigned, remaining: i.qty - i.assigned, custom: i.custom,
      dimensions: i.dimensions, description: i.description, verification: { ...i.verification }, compartments: { ...compCounts },
    };
  });
  for (const i of catalog) {
    if (i.assigned > i.quantity) {
      exceptions.push({ type: 'over_allocated', equipmentId: i.equipmentId, message: `${i.name} is assigned ${i.assigned} time(s) but the catalog quantity is ${i.quantity}.` });
    }
  }
  for (const s of snapshot.strays) {
    exceptions.push({
      type: 'over_allocated', equipmentId: s.equipmentId,
      message: `${s.name} is assigned ${perItemTotal(perItem.get(s.equipmentId))} time(s) but is not in the equipment catalog (removed).`,
    });
  }

  const manifest = {
    schema: MANIFEST_SCHEMA,
    source: { app: 'l1-compartment-builder', ...snapshot.source, snapshotSha256: '' },
    apparatus: { planId: 'l1-mid-mount', label: 'L1 Mid-Mount' },
    countingRule: COUNTING_RULE,
    compartments, catalog,
    totals: {
      compartments: compartments.length, lines, units, catalogItems: catalog.length,
      unassignedCatalogItems: catalog.filter(i => i.assigned === 0).length, needsVerification,
    },
    exceptions,
  };
  manifest.source.snapshotSha256 = hashManifest(manifest);
  return deepFreezeLite(manifest);
}

const perItemTotal = per => Object.values(per ?? {}).reduce((a, b) => a + b, 0);
function deepFreezeLite(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.values(v).forEach(deepFreezeLite); Object.freeze(v); }
  return v;
}

/** Re-check a manifest (hash, schema, structure, totals, line/catalog consistency). @returns {{ok:boolean, errors:string[]}} */
export function verifyManifest(manifest) {
  const errors = [];
  const m = manifest;
  if (!m || typeof m !== 'object') return { ok: false, errors: ['manifest is not an object'] };
  if (m.schema !== MANIFEST_SCHEMA) errors.push(`unknown schema ${String(m.schema)}`);
  if (!m.source || typeof m.source !== 'object') errors.push('missing source');
  else if (m.source.snapshotSha256 !== hashManifest(m)) errors.push('snapshotSha256 does not match the content');
  const comps = Array.isArray(m.compartments) ? m.compartments : [];
  if (comps.length !== COMPARTMENT_IDS.length || comps.some((c, i) => c?.id !== COMPARTMENT_IDS[i] || c.order !== i)) {
    errors.push(`compartments must be the ${COMPARTMENT_IDS.length} compartments in order`);
  }
  let lines = 0;
  let units = 0;
  const byItem = {};
  for (const c of comps) {
    for (const l of c?.items ?? []) {
      lines += 1;
      units += l.quantity;
      if (!Array.isArray(l.slots) || l.quantity !== l.slots.length) errors.push(`${l.lineKey}: quantity ${l.quantity} does not equal its slot count`);
      if (l.lineKey !== `${c.id}:${l.equipmentId}`) errors.push(`${l.lineKey}: lineKey does not match ${c.id}:${l.equipmentId}`);
      const per = (byItem[l.equipmentId] ??= {});
      per[c.id] = (per[c.id] ?? 0) + l.quantity;
    }
  }
  const t = m.totals ?? {};
  const catalog = Array.isArray(m.catalog) ? m.catalog : [];
  const expected = {
    compartments: comps.length, lines, units, catalogItems: catalog.length,
    unassignedCatalogItems: catalog.filter(i => i.assigned === 0).length,
    needsVerification: comps.reduce((n, c) => n + (c?.items ?? []).filter(l => l.verification?.status === 'needs_verification').length, 0),
  };
  for (const [k, v] of Object.entries(expected)) if (t[k] !== v) errors.push(`totals.${k} is ${t[k]} but the content gives ${v}`);
  for (const i of catalog) {
    if (canonicalJson(i.compartments ?? {}) !== canonicalJson(byItem[i.equipmentId] ?? {})) errors.push(`catalog ${i.equipmentId}: compartment counts differ from the lines`);
    const assigned = Object.values(byItem[i.equipmentId] ?? {}).reduce((a, b) => a + b, 0);
    if (i.assigned !== assigned) errors.push(`catalog ${i.equipmentId}: assigned ${i.assigned} but lines give ${assigned}`);
  }
  return { ok: errors.length === 0, errors };
}
