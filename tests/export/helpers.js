import { inflateRawSync } from 'node:zlib';
import { MASTER_INVENTORY } from '../../shared/apparatus.js';
import { COMPARTMENT_IDS } from '../../shared/contracts.js';

export const [A, B, C, D] = MASTER_INVENTORY.map(i => i.name);
export const emptyAlloc = (n = 15) => Object.fromEntries(COMPARTMENT_IDS.map(id => [id, Array(n).fill('')]));
export const baseDoc = (over = {}) => ({
  allocations: emptyAlloc(), customQtys: {}, customTools: [], customDimensions: {}, removedItems: [], bundles: {}, ...over,
});
export const FIXED = { revision: 13, pending: 0, syncState: 'confirmed', buildSha: 'abc1234', origin: 'https://l1.example', exportedAt: '2026-11-18T15:04:05.000Z' };

/** Minimal zip reader (central directory + raw inflate): {name: Buffer}. */
export function unzip(buf) {
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const data = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(data, data + csize);
    out[name] = method === 0 ? raw : inflateRawSync(raw);
    p += 46 + nlen + elen + clen;
  }
  return out;
}
