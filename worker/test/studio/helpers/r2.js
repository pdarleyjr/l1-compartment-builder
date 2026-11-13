// Map-backed R2 bucket fake (get/put/head/delete/list).
async function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return new TextEncoder().encode(value);
  return new Uint8Array(await new Response(value).arrayBuffer());
}

export function createR2() {
  const store = new Map();
  return {
    store,
    async put(key, value, opts = {}) { store.set(key, { bytes: await toBytes(value), httpMetadata: opts.httpMetadata || {} }); },
    async get(key) {
      const o = store.get(key);
      return o ? { body: o.bytes, httpMetadata: o.httpMetadata, size: o.bytes.length } : null;
    },
    async head(key) {
      const o = store.get(key);
      return o ? { httpMetadata: o.httpMetadata, size: o.bytes.length, key } : null;
    },
    async delete(keys) { for (const k of [].concat(keys)) store.delete(k); },
    async list({ prefix = '' } = {}) {
      return { objects: [...store.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) };
    },
  };
}
