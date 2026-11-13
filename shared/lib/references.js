// Reference-image selection: priority order, contact-sheet overflow. Used by shared/scene-spec.js.

const SHEET_SIZE = 6;
const PINNED_ROLES = new Set(['compartment', 'parent', 'markup']);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Order spec.references by priority: compartment photo → parent version → markup → one photo per equipment
 * (photos covering the most equipment first) → mounts → arrangement/other → extra photos of already-covered tools.
 * @param {{role:string, assetId:string, label:string, equipmentIds:string[]}[]} references
 */
export function prioritizeReferences(references) {
  const byRole = role => references.filter(r => r.role === role);
  const tools = byRole('tool').sort((a, b) => b.equipmentIds.length - a.equipmentIds.length || cmp(a.label, b.label) || cmp(a.assetId, b.assetId));
  const covered = new Set();
  const primary = [];
  const extra = [];
  for (const ref of tools) {
    if (ref.equipmentIds.some(id => !covered.has(id))) { primary.push(ref); ref.equipmentIds.forEach(id => covered.add(id)); }
    else extra.push(ref);
  }
  return [...byRole('compartment'), ...byRole('parent'), ...byRole('markup'), ...primary, ...byRole('mount'),
    ...byRole('arrangement'), ...byRole('other'), ...extra];
}

/**
 * Split the prioritized references into direct images and labelled contact sheets (≤ 6 items each). A contact sheet
 * counts as one reference image toward `maxPerRequest`. Compartment/parent/markup stay direct whenever possible.
 * @param {object[]} references @param {number} maxPerRequest
 * @returns {{direct:object[], contactSheets:{label:string, items:{assetId:string,label:string}[]}[], onlyInSheets:string[], dropped:object[]}}
 */
export function splitReferences(references, maxPerRequest) {
  const ordered = prioritizeReferences(references);
  const max = Math.max(0, Math.floor(Number(maxPerRequest) || 0));
  const n = ordered.length;
  let d = n; // everything direct when it fits
  if (n > max) {
    let fit = 0; // largest direct count that still lets every reference fit via sheets
    for (let k = max; k >= 0; k--) {
      if (k + Math.ceil((n - k) / SHEET_SIZE) <= max) { fit = k; break; }
    }
    // compartment/parent/markup stay direct even when that means dropping the lowest-priority overflow
    d = Math.max(fit, Math.min(ordered.filter(r => PINNED_ROLES.has(r.role)).length, max - 1));
    d = Math.max(0, d);
  }
  const rest = ordered.slice(d);
  const sheetCount = Math.min(max - d, Math.ceil(rest.length / SHEET_SIZE));
  const inSheets = rest.slice(0, sheetCount * SHEET_SIZE);
  const dropped = rest.slice(sheetCount * SHEET_SIZE);
  const direct = ordered.slice(0, d);
  const contactSheets = [];
  for (let i = 0; i < inSheets.length; i += SHEET_SIZE) {
    contactSheets.push({
      label: `Contact sheet ${contactSheets.length + 1} of ${sheetCount}`,
      items: inSheets.slice(i, i + SHEET_SIZE).map(r => ({ assetId: r.assetId, label: r.label })),
    });
  }
  const directEquipment = new Set(direct.flatMap(r => r.equipmentIds));
  const onlyInSheets = [...new Set(inSheets.flatMap(r => r.equipmentIds))].filter(id => !directEquipment.has(id)).sort();
  return {
    direct: direct.map(r => ({ assetId: r.assetId, role: r.role, label: r.label })),
    contactSheets,
    onlyInSheets,
    dropped: dropped.map(r => ({ assetId: r.assetId, role: r.role, label: r.label })),
  };
}
