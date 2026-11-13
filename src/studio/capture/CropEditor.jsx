import { useEffect, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { FULL_CROP, clampCrop, isFullCrop, normalizeRotation, rotateRect } from '../../lib/image/geometry.js';
import { Modal } from './Modal.jsx';
import { RectBox } from './RectBox.jsx';
import { BTN_PRIMARY, BTN_SECONDARY } from './styles.js';
import { useObjectUrl } from './useObjectUrl.js';

/**
 * Crop + rotate editor for one pending photo. `loadPreview(rotate)` returns an uncropped, rotated preview Blob.
 * @param {{open:boolean, name:string, rotate:number, crop:object|null, loadPreview:(rotate:number)=>Promise<Blob>,
 *   onApply:(t:{rotate:number, crop:object|null})=>void, onClose:()=>void}} props
 */
export function CropEditor({ open, name, rotate: initialRotate, crop: initialCrop, loadPreview, onApply, onClose }) {
  const [rotate, setRotate] = useState(initialRotate);
  const [crop, setCrop] = useState(initialCrop ?? FULL_CROP);
  const [blob, setBlob] = useState(null);
  const [error, setError] = useState('');
  const url = useObjectUrl(blob);
  const box = useRef(null);
  const loadRef = useRef(loadPreview);
  loadRef.current = loadPreview;

  useEffect(() => { if (open) { setRotate(initialRotate); setCrop(initialCrop ?? FULL_CROP); } }, [open, initialRotate, initialCrop]);
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    setError('');
    loadRef.current(rotate).then(b => { if (alive) setBlob(b); }).catch(() => { if (alive) setError('Could not load a preview of this photo.'); });
    return () => { alive = false; };
  }, [open, rotate]);

  const spin = () => {
    setCrop(c => rotateRect(c, 90));
    setRotate(r => normalizeRotation(r + 90));
  };

  return (
    <Modal open={open} onClose={onClose} title={`Crop and rotate — ${name}`} testId="crop-editor"
      footer={<>
        <button type="button" className={BTN_SECONDARY} onClick={() => setCrop(FULL_CROP)} disabled={isFullCrop(crop)}>Reset crop</button>
        <button type="button" className={BTN_SECONDARY} onClick={onClose}>Cancel</button>
        <button type="button" className={BTN_PRIMARY} data-testid="crop-apply" onClick={() => onApply({ rotate, crop: isFullCrop(crop) ? null : clampCrop(crop) })}>Apply</button>
      </>}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <button type="button" className={BTN_SECONDARY} onClick={spin}><RotateCw size={16} aria-hidden="true" /> Rotate 90°</button>
          <p className="text-xs text-slate-500">Drag the box or its corners. With a keyboard: arrows move, Shift + arrows resize.</p>
        </div>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="relative mx-auto max-w-full select-none bg-slate-100 rounded overflow-hidden" style={{ lineHeight: 0 }}>
          {url ? (
            <div ref={box} className="relative inline-block max-w-full">
              <img src={url} alt={`Preview of ${name}`} draggable={false} className="block max-w-full max-h-[55vh] w-auto h-auto" />
              <RectBox rect={crop} onChange={setCrop} label="Crop area" containerRef={box} tone="navy" dim />
            </div>
          ) : <div className="h-48 flex items-center justify-center text-sm text-slate-500" style={{ lineHeight: 1.5 }}>Loading preview…</div>}
        </div>
      </div>
    </Modal>
  );
}
