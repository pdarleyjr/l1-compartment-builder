/**
 * Build the carousel list: server main image first, then the static presets, then the remaining gallery items.
 * @param {{main:object|null, presets:{src:string,title:string}[], items:object[]}} input
 */
export function buildCarouselItems({ main, presets, items }) {
  const list = [];
  const samePreset = p => main && main.kind === 'preset' && (main.ref === p.src || main.url === p.src);
  const matches = it => main && (main.url === it.url || (it.id && main.ref === it.id));
  if (main) {
    const hit = presets.find(samePreset) ?? items.find(matches);
    list.push({
      key: 'main', src: main.url, title: hit?.title ?? 'Main image', provenance: main.provenance, isMain: true,
      stale: main.stale, deletable: false, kind: main.kind, ref: main.ref,
    });
  }
  for (const p of presets) {
    if (samePreset(p)) continue;
    list.push({ key: `preset:${p.src}`, src: p.src, title: p.title, provenance: 'preset', isMain: false, deletable: false, kind: 'preset', ref: p.src });
  }
  for (const it of items) {
    if (matches(it)) continue;
    list.push({ key: `asset:${it.key}`, src: it.url, title: it.title, provenance: it.provenance, isMain: false, deletable: it.deletable, kind: it.kind, ref: it.id, id: it.id });
  }
  return list;
}
