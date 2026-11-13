// Decide which references go to the model directly and which are packed into labelled contact sheets.

/** Documented Images API edits limit for GPT image models (docs/ops/aiw-image-processor.md). */
export const MODEL_MAX_IMAGES = 16;
export const SHEET_MAX_TILES = 6;

/**
 * @template T
 * @param {(T & {sheet?:string|null})[]} items ordered by importance (parent/compartment first)
 * @param {number} max image slots available on the request (markup does not use one)
 * @returns {({type:'direct', item:T}|{type:'sheet', label:string, items:T[]})[]}
 */
export function planReferences(items, max = MODEL_MAX_IMAGES) {
  const direct = []; const groups = new Map();
  for (const it of items) {
    if (it.sheet) { if (!groups.has(it.sheet)) groups.set(it.sheet, []); groups.get(it.sheet).push(it); } else direct.push(it);
  }
  const chunk = (label, arr) => {
    const out = [];
    for (let i = 0; i < arr.length; i += SHEET_MAX_TILES) out.push({ type: 'sheet', label, items: arr.slice(i, i + SHEET_MAX_TILES) });
    return out.map((s, i, a) => (a.length > 1 ? { ...s, label: `${label} (${i + 1}/${a.length})` } : s));
  };
  const fixed = [...groups].flatMap(([label, arr]) => chunk(label, arr));
  let keep = direct.length;
  let overflow = [];
  while (keep + fixed.length + Math.ceil(overflow.length / SHEET_MAX_TILES) > max && keep > 0) {
    keep -= 1;
    overflow = direct.slice(keep);
  }
  const auto = chunk('More references', overflow);
  return [...direct.slice(0, keep).map(item => ({ type: 'direct', item })), ...fixed, ...auto];
}
