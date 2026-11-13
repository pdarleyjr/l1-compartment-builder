// Pure layout model helpers for the Arrange step (part B2). No React, no I/O.
import { DEFAULT_ZONES, ORIENTATIONS } from '../../../shared/contracts.js';

/** @typedef {{kind:'tool'|'mount', ref:string, name:string, zone:string|null, orientation:string|null}} Placement */
/** @typedef {{placements:Placement[], notes:string}} Layout */

export const ZONE_LABELS = {
  upper_shelf: 'Upper shelf', middle_shelf: 'Middle shelf', lower_tray: 'Lower tray', pull_out_tray: 'Pull-out tray',
  left_wall: 'Left wall', right_wall: 'Right wall', rear_wall: 'Rear wall', floor: 'Floor', door_area: 'Door area', other: 'Other',
};
/** @param {string} z */
export const zoneLabel = z => ZONE_LABELS[z] ?? z.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
export const ORIENTATION_LABELS = { vertical: 'Vertical', horizontal: 'Horizontal', angled: 'Angled' };

/** Group compartment assignment rows into tool items with quantities. @param {{name:string, equipmentId?:string}[]} rows */
export function toolItems(rows) {
  const map = new Map();
  for (const r of rows ?? []) {
    const ref = r.equipmentId || r.name;
    const cur = map.get(ref) ?? { kind: 'tool', ref, name: r.name, qty: 0 };
    cur.qty += 1; map.set(ref, cur);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Normalise whatever the server returned into a Layout. @param {any} raw @returns {Layout} */
export function normalizeLayout(raw) {
  const placements = Array.isArray(raw?.placements) ? raw.placements.filter(p => p && typeof p.ref === 'string').map(p => ({
    kind: p.kind === 'mount' ? 'mount' : 'tool', ref: p.ref, name: String(p.name ?? p.ref),
    zone: typeof p.zone === 'string' ? p.zone : null,
    orientation: ORIENTATIONS.includes(p.orientation) ? p.orientation : null,
  })) : [];
  return { placements, notes: typeof raw?.notes === 'string' ? raw.notes : '' };
}

/** Return a layout with one item's zone/orientation changed (immutable). @param {Layout} layout @param {{kind:string, ref:string, name:string}} item @param {{zone?:string|null, orientation?:string|null}} patch */
export function setPlacement(layout, item, patch) {
  const rest = layout.placements.filter(p => !(p.kind === item.kind && p.ref === item.ref));
  const cur = layout.placements.find(p => p.kind === item.kind && p.ref === item.ref) ?? { kind: item.kind, ref: item.ref, name: item.name, zone: null, orientation: null };
  const next = { ...cur, name: item.name, ...patch };
  const keep = next.zone || next.orientation;
  return { ...layout, placements: keep ? [...rest, next] : rest };
}

/** @param {Layout} layout @param {{kind:string, ref:string}} item */
export const placementOf = (layout, item) => layout.placements.find(p => p.kind === item.kind && p.ref === item.ref) ?? { zone: null, orientation: null };

/** Items per zone for the diagram. @returns {Record<string, Placement[]>} */
export function itemsByZone(layout, zones) {
  const out = Object.fromEntries(zones.map(z => [z, []]));
  for (const p of layout.placements) if (p.zone && out[p.zone]) out[p.zone].push(p);
  return out;
}

/** Zones to offer: geometry zones, else defaults. Always includes zones already used by the layout. */
export function availableZones(geometry, layout) {
  const base = Array.isArray(geometry?.zones) && geometry.zones.length ? geometry.zones : [...DEFAULT_ZONES];
  const extra = layout.placements.map(p => p.zone).filter(z => z && !base.includes(z));
  return [...base, ...new Set(extra)];
}

/**
 * Proportional diagram: outer box scaled from known width/height (inches) into a viewBox, zones tiled inside.
 * Unknown dimensions → a 4:3 box and `known:false` so the UI can say so.
 * @returns {{vbW:number, vbH:number, known:boolean, rects:{zone:string,x:number,y:number,w:number,h:number}[]}}
 */
export function diagramModel(geometry, zones, maxEdge = 360) {
  const w = Number(geometry?.dimensions?.widthIn), h = Number(geometry?.dimensions?.heightIn);
  const known = w > 0 && h > 0;
  const ratio = known ? w / h : 4 / 3;
  const clamped = Math.min(4, Math.max(0.25, ratio));
  const vbW = clamped >= 1 ? maxEdge : Math.round(maxEdge * clamped);
  const vbH = clamped >= 1 ? Math.round(maxEdge / clamped) : maxEdge;
  const n = Math.max(1, zones.length);
  // Tall boxes stack zones vertically, wide boxes tile left→right, then wrap.
  const cols = clamped < 0.8 ? 1 : Math.min(n, Math.ceil(Math.sqrt(n * clamped)));
  const rows = Math.ceil(n / cols);
  const pad = 4, cw = (vbW - pad * 2) / cols, rh = (vbH - pad * 2) / rows;
  const rects = zones.map((zone, i) => ({ zone, x: pad + (i % cols) * cw, y: pad + Math.floor(i / cols) * rh, w: cw - pad, h: rh - pad }));
  return { vbW, vbH, known, rects };
}

/** True when two layouts differ (ignores placement order). */
export function layoutDirty(a, b) {
  const key = l => JSON.stringify({ n: l.notes, p: [...l.placements].sort((x, y) => (x.kind + x.ref).localeCompare(y.kind + y.ref)) });
  return key(a) !== key(b);
}
