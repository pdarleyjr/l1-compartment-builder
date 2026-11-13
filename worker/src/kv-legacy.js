// Read-only access to the legacy KV documents. KV is never written after the Studio cutover (docs §12).

/** @param {{L1_STATE?: {get: Function}}} env @param {string} key @returns {Promise<string|null>} raw stored text */
export async function readKvText(env, key) {
  if (!env.L1_STATE) return null;
  const value = await env.L1_STATE.get(key, { type: 'text' });
  return typeof value === 'string' ? value : null;
}

/** @returns {Promise<{text:string, value:any}|null>} parsed legacy document, or null when absent/unparseable */
export async function readKvJson(env, key) {
  const text = await readKvText(env, key);
  if (text == null) return null;
  try {
    const value = JSON.parse(text);
    return value === null ? null : { text, value };
  } catch {
    return null;
  }
}
