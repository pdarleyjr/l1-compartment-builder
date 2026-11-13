// Canonical JSON: object keys sorted, undefined dropped, so equal data hashes equally everywhere.

/** @param {unknown} value @returns {string} */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(v => (v === undefined ? null : sortKeys(v)));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
}
