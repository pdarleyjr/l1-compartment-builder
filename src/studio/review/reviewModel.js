// Pure helpers for the Review step: version labels/tree order and viewer zoom/pan math (part B2).

/** Number versions oldest→newest as v1, v2… @param {{id:string, createdAt:number}[]} versions @returns {Map<string,string>} */
export function versionLabels(versions) {
  const sorted = [...versions].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  return new Map(sorted.map((v, i) => [v.id, `v${i + 1}`]));
}

/** Newest first, hiding deleted. */
export const visibleVersions = versions => versions.filter(v => v.status !== 'deleted').sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

/** "branch of v3" or '' */
export function branchText(version, labels) {
  return version.parentVersionId && labels.get(version.parentVersionId) ? `branch of ${labels.get(version.parentVersionId)}` : '';
}

/** @param {{status:string}} v  Only drafts may be rejected/deleted. */
export const canRejectOrDelete = v => v.status === 'draft';

/** Verification report → plain hint lines (non-authoritative). @param {any} report @returns {string[]} */
export function verificationHints(report) {
  if (!report || typeof report !== 'object') return [];
  const out = [];
  if (typeof report.summary === 'string') out.push(report.summary);
  for (const key of ['issues', 'findings', 'missing', 'notes']) {
    const list = Array.isArray(report[key]) ? report[key] : [];
    for (const it of list) out.push(typeof it === 'string' ? it : it?.message || it?.description || JSON.stringify(it));
  }
  return out.slice(0, 20);
}

export const MIN_SCALE = 1, MAX_SCALE = 6;
/** @param {number} s */
export const clampScale = s => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** Keep the scaled content covering the viewport. @param {{x:number,y:number}} p @param {number} scale @param {{w:number,h:number}} box */
export function clampPan(p, scale, box) {
  const maxX = (box.w * (scale - 1)) / 2, maxY = (box.h * (scale - 1)) / 2;
  return { x: Math.min(maxX, Math.max(-maxX, p.x)), y: Math.min(maxY, Math.max(-maxY, p.y)) };
}

/**
 * Zoom keeping the point under the cursor (cx, cy, relative to viewport centre) fixed.
 * @param {{scale:number,x:number,y:number}} t @param {number} nextScale @param {{cx:number,cy:number}} focus @param {{w:number,h:number}} box
 */
export function zoomAt(t, nextScale, focus, box) {
  const scale = clampScale(nextScale);
  const k = scale / t.scale;
  const pan = clampPan({ x: focus.cx - (focus.cx - t.x) * k, y: focus.cy - (focus.cy - t.y) * k }, scale, box);
  return { scale, ...pan };
}

/** Distance between two pointer points. */
export const pinchDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
