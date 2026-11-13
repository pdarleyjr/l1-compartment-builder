// Pure markup helpers for the Edit step: normalized shapes, undo/redo history, canvas drawing and PNG export (part B2).
// Shapes use coordinates normalized to 0..1 so the same markup renders at any display size.

/** @typedef {{x:number,y:number}} Pt */
/** @typedef {{type:'arrow'|'circle'|'rect', a:Pt, b:Pt}|{type:'free', pts:Pt[]}} Shape */

export const MARKUP_COLOR = '#ff1744';
export const MARKUP_HALO = '#ffffff';
export const SHAPE_TYPES = ['arrow', 'circle', 'rect', 'free'];

const clamp01 = n => Math.min(1, Math.max(0, n));
/** @param {Pt} p @returns {Pt} */
export const clampPt = p => ({ x: clamp01(p.x), y: clamp01(p.y) });

/** Pointer position → normalized point within a client rect. @param {{left:number,top:number,width:number,height:number}} rect */
export function toNormalized(clientX, clientY, rect) {
  if (!rect.width || !rect.height) return { x: 0, y: 0 };
  return clampPt({ x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height });
}

/** Build a shape from a drag. Returns null for accidental taps. @param {string} type @param {Pt[]} pts */
export function shapeFromDrag(type, pts) {
  if (!pts.length) return null;
  if (type === 'free') return pts.length < 2 ? null : { type, pts: pts.map(clampPt) };
  const a = clampPt(pts[0]), b = clampPt(pts[pts.length - 1]);
  return Math.hypot(a.x - b.x, a.y - b.y) < 0.01 ? null : { type, a, b };
}

/** Default shape for keyboard users, centred. @param {string} type @returns {Shape} */
export function defaultShape(type) {
  if (type === 'arrow') return { type, a: { x: 0.35, y: 0.5 }, b: { x: 0.65, y: 0.5 } };
  if (type === 'free') return { type, pts: [{ x: 0.4, y: 0.4 }, { x: 0.5, y: 0.45 }, { x: 0.6, y: 0.4 }] };
  return { type, a: { x: 0.4, y: 0.4 }, b: { x: 0.6, y: 0.6 } };
}

const mapPts = (s, f) => (s.type === 'free' ? { ...s, pts: s.pts.map(f) } : { ...s, a: f(s.a), b: f(s.b) });
const pointsOf = s => (s.type === 'free' ? s.pts : [s.a, s.b]);

/** Move a shape by (dx, dy), keeping it inside the image. @param {Shape} s */
export function nudgeShape(s, dx, dy) {
  const pts = pointsOf(s);
  const minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x));
  const minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y));
  const ddx = Math.min(1 - maxX, Math.max(-minX, dx)), ddy = Math.min(1 - maxY, Math.max(-minY, dy));
  return mapPts(s, p => ({ x: p.x + ddx, y: p.y + ddy }));
}

/** Scale about the centroid. @param {Shape} s @param {number} factor */
export function scaleShape(s, factor) {
  const pts = pointsOf(s);
  const cx = pts.reduce((n, p) => n + p.x, 0) / pts.length, cy = pts.reduce((n, p) => n + p.y, 0) / pts.length;
  return mapPts(s, p => clampPt({ x: cx + (p.x - cx) * factor, y: cy + (p.y - cy) * factor }));
}

/** Arrow head triangle points in pixel space. @returns {[Pt,Pt]} the two wing points */
export function arrowHead(from, to, size) {
  const ang = Math.atan2(to.y - from.y, to.x - from.x), spread = Math.PI / 7;
  return [
    { x: to.x - size * Math.cos(ang - spread), y: to.y - size * Math.sin(ang - spread) },
    { x: to.x - size * Math.cos(ang + spread), y: to.y - size * Math.sin(ang + spread) },
  ];
}

// ── history ──
/** @returns {{past:Shape[][], present:Shape[], future:Shape[][]}} */
export const emptyHistory = () => ({ past: [], present: [], future: [] });
/** @param {ReturnType<typeof emptyHistory>} h @param {Shape[]} next */
export const commit = (h, next) => ({ past: [...h.past, h.present].slice(-50), present: next, future: [] });
export const undo = h => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h);
export const redo = h => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h);
export const clearAll = h => (h.present.length ? commit(h, []) : h);

// ── drawing ──
/**
 * Draw shapes on a 2D context sized w×h pixels (a white halo under a high-contrast stroke).
 * @param {CanvasRenderingContext2D} ctx @param {Shape[]} shapes @param {number} w @param {number} h
 */
export function drawShapes(ctx, shapes, w, h) {
  const base = Math.max(4, Math.round(Math.max(w, h) / 220));
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const px = p => ({ x: p.x * w, y: p.y * h });
  for (const [color, width] of [[MARKUP_HALO, base + 4], [MARKUP_COLOR, base]]) {
    ctx.strokeStyle = color; ctx.lineWidth = width;
    for (const s of shapes) {
      ctx.beginPath();
      if (s.type === 'free') { s.pts.forEach((p, i) => { const q = px(p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }); }
      else {
        const a = px(s.a), b = px(s.b);
        if (s.type === 'rect') ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
        else if (s.type === 'circle') ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.max(1, Math.abs(a.x - b.x) / 2), Math.max(1, Math.abs(a.y - b.y) / 2), 0, 0, Math.PI * 2);
        else { const [l, r] = arrowHead(a, b, base * 5); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.moveTo(l.x, l.y); ctx.lineTo(b.x, b.y); ctx.lineTo(r.x, r.y); }
      }
      ctx.stroke();
    }
  }
}

/**
 * Export markup as a transparent PNG blob with the same pixel size as the version display image.
 * @param {Shape[]} shapes @param {number} w @param {number} h @returns {Promise<Blob>}
 */
export function exportMarkupPng(shapes, w, h) {
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  drawShapes(canvas.getContext('2d'), shapes, w, h);
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not export the markup image.'))), 'image/png'));
}

export const EXAMPLE_CHIPS = [
  'Move the hydraulic cutter to the left wall',
  'Keep everything the same except the upper shelf',
  'Make the hose rolls stand upright',
  'Remove the item I circled',
];
