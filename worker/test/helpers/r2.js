// R2 + KV fakes (in-memory).
const toBytes = async value => {
  if (value == null) return new Uint8Array(0);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(await new Response(value).arrayBuffer());
};

export function createR2() {
  const store = new Map();
  const view = (key, o) => ({
    key, size: o.bytes.length, etag: o.etag, uploaded: o.uploaded, httpMetadata: o.httpMetadata ?? {}, customMetadata: o.customMetadata ?? {},
  });
  return {
    store,
    async put(key, value, opts = {}) {
      const bytes = await toBytes(value);
      const o = { bytes, httpMetadata: opts.httpMetadata, customMetadata: opts.customMetadata, uploaded: new Date(), etag: `etag-${store.size}-${bytes.length}` };
      store.set(key, o);
      return view(key, o);
    },
    async head(key) { const o = store.get(key); return o ? view(key, o) : null; },
    async get(key) {
      const o = store.get(key);
      if (!o) return null;
      return {
        ...view(key, o),
        body: new Response(o.bytes).body,
        arrayBuffer: async () => o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.length),
        text: async () => new TextDecoder().decode(o.bytes),
      };
    },
    async delete(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k); },
    async list({ prefix = '', limit = 1000 } = {}) {
      const objects = [...store.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, limit).map(([k, o]) => view(k, o));
      return { objects, truncated: false, delimitedPrefixes: [] };
    },
  };
}

export function createKv(seed = {}) {
  const values = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  const writes = [];
  return {
    values, writes,
    async get(key, opts) {
      const type = typeof opts === 'string' ? opts : opts?.type ?? 'text';
      const v = values.get(key) ?? null;
      return v !== null && type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { writes.push(key); values.set(key, value); },
    async delete(key) { writes.push(key); values.delete(key); },
    async list() { return { keys: [...values.keys()].map(name => ({ name })), list_complete: true }; },
  };
}
