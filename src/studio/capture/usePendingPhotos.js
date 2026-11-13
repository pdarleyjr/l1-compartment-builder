import { useCallback, useEffect, useRef, useState } from 'react';
import { ImageDecodeError, decodeImage } from '../../lib/image/decode.js';
import { encodePreview, encodeVariants } from '../../lib/image/encode.js';

/** @typedef {{id:string, file:File, name:string, category:string, rotate:number, crop:object|null, size:{width:number,height:number}|null,
 *   preview:Blob|null, status:'decoding'|'ready'|'error', error:string}} PendingPhoto */

let counter = 0;
const nextId = () => `p${Date.now().toString(36)}${(counter += 1)}`;

/** Run `fn` with a decoded source and always release it. */
async function withSource(file, fn) {
  const d = await decodeImage(file);
  try { return await fn(d); } finally { d.close(); }
}

/**
 * State for photos picked/captured but not yet uploaded (review screen). Files are decoded one at a time so many large
 * photos never sit decoded in memory together.
 * @param {string} defaultCategory
 */
export function usePendingPhotos(defaultCategory) {
  const [items, setItems] = useState(/** @type {PendingPhoto[]} */ ([]));
  const chain = useRef(Promise.resolve());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const patch = useCallback((id, p) => { if (alive.current) setItems(list => list.map(i => (i.id === id ? { ...i, ...p } : i))); }, []);

  const analyse = useCallback((id, file, transform = {}) => {
    chain.current = chain.current.then(async () => {
      try {
        const { size, preview } = await withSource(file, async d => ({ size: { width: d.width, height: d.height }, preview: await encodePreview(d.bitmap, d, transform) }));
        patch(id, { size, preview, status: 'ready', error: '' });
      } catch (e) {
        patch(id, { status: 'error', error: e instanceof ImageDecodeError ? e.message : 'That photo could not be read.', preview: null });
      }
    });
  }, [patch]);

  const addFiles = useCallback((files, category) => {
    const added = Array.from(files).map(file => ({ id: nextId(), file, name: file.name || 'Photo', category: category ?? defaultCategory, rotate: 0, crop: null, size: null, preview: null, status: 'decoding', error: '' }));
    if (!added.length) return;
    setItems(list => [...list, ...added]);
    for (const a of added) analyse(a.id, a.file);
  }, [analyse, defaultCategory]);

  const remove = useCallback(id => setItems(list => list.filter(i => i.id !== id)), []);
  const clear = useCallback(() => setItems([]), []);
  const setCategory = useCallback((id, category) => patch(id, { category }), [patch]);
  const setAllCategories = useCallback(category => setItems(list => list.map(i => ({ ...i, category }))), []);

  const replace = useCallback((id, file) => {
    patch(id, { file, name: file.name || 'Photo', rotate: 0, crop: null, size: null, preview: null, status: 'decoding', error: '' });
    analyse(id, file);
  }, [analyse, patch]);

  const applyTransform = useCallback((id, file, t) => {
    patch(id, { rotate: t.rotate, crop: t.crop, status: 'decoding' });
    analyse(id, file, t);
  }, [analyse, patch]);

  /** Rotate 90° clockwise right from the card. */
  const rotate90 = useCallback(item => {
    const rotate = (item.rotate + 90) % 360;
    // A crop box does not survive a rotation unchanged; reset it rather than guess.
    applyTransform(item.id, item.file, { rotate, crop: null });
  }, [applyTransform]);

  /** Uncropped, rotated preview used by the crop editor. */
  const loadEditorPreview = useCallback((file, rotate) => withSource(file, d => encodePreview(d.bitmap, d, { rotate }, 1100)), []);

  /** Final three variants for one photo (decoded again from the original file). */
  const encodeForUpload = useCallback(item => withSource(item.file, async d => ({
    variants: await encodeVariants(d.bitmap, d, { rotate: item.rotate, crop: item.crop }), width: d.width, height: d.height,
  })), []);

  return { items, addFiles, remove, clear, setCategory, setAllCategories, replace, applyTransform, rotate90, loadEditorPreview, encodeForUpload };
}
