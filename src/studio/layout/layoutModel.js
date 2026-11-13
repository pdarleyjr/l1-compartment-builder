// Pure layout model helpers for the Arrange step (part B2). No React, no I/O.
import { DEFAULT_ZONES, ORIENTATIONS } from '../../../shared/contracts.js';

/**
 * Canonical layout (docs/architecture "API payloads"): placements address planner/mount entities by id.
 * @typedef {{targetType:'assignment'|'equipment'|'mount', targetId:string, zone:string, orientation?:string, notes?:string}} Placement
 * @typedef {{placements:Placement[], notes:string}} Layout
 * @typedef {{kind:'tool'|'mount', ref:string, name:string}} Item  UI item: a tool (ref = equipmentId) or a mount (ref = mount id)
 */
const PLACEABLE = ['assignment', 'equipment', 'mount'];

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

/** Placement target of a UI item. @param {{kind:string, ref:string}} item @returns {{targetType:'equipment'|'mount', targetId:string}} */
export const targetOf = item => ({ targetType: item.kind === 'mount' ? 'mount' : 'equipment', targetId: item.ref });
const sameTarget = (p, item) => { const t = targetOf(item); return p.targetType === t.targetType && p.targetId === t.targetId; };

/** Normalise whatever the server returned into a Layout (canonical placements only). @param {any} raw @returns {Layout} */
export function normalizeLayout(raw) {
  const placements = Array.isArray(raw?.placements)
    ? raw.placements.filter(p => p && PLACEABLE.includes(p.targetType) && typeof p.targetId === 'string' && typeof p.zone === 'string' && p.zone)
      .map(p => ({
        targetType: p.targetType, targetId: p.targetId, zone: p.zone,
        ...(ORIENTATIONS.includes(p.orientation) ? { orientation: p.orientation } : {}),
        ...(typeof p.notes === 'string' && p.notes ? { notes: p.notes } : {}),
      }))
    : [];
  return { placements, notes: typeof raw?.notes === 'string' ? raw.notes : '' };
}

/** Body for PUT design: {layout}. Empty notes are omitted. @param {Layout} layout */
export const layoutPayload = layout => ({ placements: layout.placements, ...(layout.notes ? { notes: layout.notes } : {}) });

/**
 * Return a layout with one item's zone/orientation changed (immutable). A placement needs a zone; clearing the zone
 * removes it (orientation alone is not stored).
 * @param {Layout} layout @param {Item} item @param {{zone?:string|null, orientation?:string|null}} patch
 */
export function setPlacement(layout, item, patch) {
  const rest = layout.placements.filter(p => !sameTarget(p, item));
  const cur = layout.placements.find(p => sameTarget(p, item));
  const zone = 'zone' in patch ? patch.zone : cur?.zone;
  const orientation = 'orientation' in patch ? patch.orientation : cur?.orientation;
  if (!zone) return { ...layout, placements: rest };
  const next = { ...(cur ?? {}), ...targetOf(item), zone };
  if (orientation) next.orientation = orientation; else delete next.orientation;
  return { ...layout, placements: [...rest, next] };
}

/** @param {Layout} layout @param {Item} item */
export const placementOf = (layout, item) => layout.placements.find(p => sameTarget(p, item)) ?? { zone: null, orientation: null };

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
  const key = l => JSON.stringify({ n: l.notes, p: [...l.placements].sort((x, y) => (x.targetType + x.targetId).localeCompare(y.targetType + y.targetId)) });
  return key(a) !== key(b);
}
