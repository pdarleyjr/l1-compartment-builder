import { useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { clampPan, clampScale, pinchDistance, zoomAt } from './reviewModel.js';

/** Image viewer with wheel/pinch zoom, drag pan and keyboard (+ − 0 arrows). @param {{src:string, alt:string, className?:string}} props */
export default function Viewer({ src, alt, className = '' }) {
  const box = useRef(null);
  const pointers = useRef(new Map());
  const pinch = useRef(null);
  const [t, setT] = useState({ scale: 1, x: 0, y: 0 });
  const size = () => { const r = box.current?.getBoundingClientRect(); return { w: r?.width ?? 1, h: r?.height ?? 1, r }; };
  const zoomBy = (factor, focus = { cx: 0, cy: 0 }) => setT(cur => zoomAt(cur, cur.scale * factor, focus, size()));
  const reset = () => setT({ scale: 1, x: 0, y: 0 });
  const rel = (clientX, clientY) => { const { r } = size(); return { cx: clientX - (r?.left ?? 0) - (r?.width ?? 0) / 2, cy: clientY - (r?.top ?? 0) - (r?.height ?? 0) / 2 }; };

  const onWheel = e => { e.preventDefault?.(); zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, rel(e.clientX, e.clientY)); };
  const onDown = e => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) { const [a, b] = [...pointers.current.values()]; pinch.current = { d: pinchDistance(a, b), scale: t.scale }; }
  };
  const onMove = e => {
    const prev = pointers.current.get(e.pointerId); if (!prev) return;
    const next = { x: e.clientX, y: e.clientY }; pointers.current.set(e.pointerId, next);
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const d = pinchDistance(a, b), mid = rel((a.x + b.x) / 2, (a.y + b.y) / 2);
      setT(cur => zoomAt(cur, clampScale(pinch.current.scale * (d / pinch.current.d)), mid, size()));
    } else if (pointers.current.size === 1) {
      setT(cur => ({ ...cur, ...clampPan({ x: cur.x + next.x - prev.x, y: cur.y + next.y - prev.y }, cur.scale, size()) }));
    }
  };
  const onUp = e => { pointers.current.delete(e.pointerId); if (pointers.current.size < 2) pinch.current = null; };
  const onKey = e => {
    const step = 40; const map = { '+': () => zoomBy(1.25), '=': () => zoomBy(1.25), '-': () => zoomBy(0.8), '0': reset,
      ArrowLeft: () => setT(c => ({ ...c, ...clampPan({ x: c.x + step, y: c.y }, c.scale, size()) })),
      ArrowRight: () => setT(c => ({ ...c, ...clampPan({ x: c.x - step, y: c.y }, c.scale, size()) })),
      ArrowUp: () => setT(c => ({ ...c, ...clampPan({ x: c.x, y: c.y + step }, c.scale, size()) })),
      ArrowDown: () => setT(c => ({ ...c, ...clampPan({ x: c.x, y: c.y - step }, c.scale, size()) })) };
    if (map[e.key]) { e.preventDefault(); map[e.key](); }
  };
  const btn = 'touch-target flex items-center justify-center rounded bg-slate-900/80 text-white hover:bg-slate-900';
  return (
    <div className={`relative bg-slate-900 rounded-lg overflow-hidden ${className}`}>
      <div ref={box} tabIndex={0} role="group" aria-label={`${alt}. Use plus and minus to zoom, arrow keys to pan, 0 to reset.`}
        onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey}
        className="w-full h-full min-h-[240px] flex items-center justify-center touch-none select-none cursor-grab focus-visible:outline-offset-[-3px]">
        <img src={src} alt={alt} draggable={false} className="max-w-full max-h-full object-contain"
          style={{ transform: `translate(${t.x}px, ${t.y}px) scale(${t.scale})`, transition: 'none' }} />
      </div>
      <div className="absolute bottom-2 right-2 flex gap-1.5">
        <button type="button" className={btn} onClick={() => zoomBy(0.8)} aria-label="Zoom out"><Minus size={18} /></button>
        <button type="button" className={btn} onClick={reset} aria-label="Reset zoom"><RotateCcw size={16} /></button>
        <button type="button" className={btn} onClick={() => zoomBy(1.25)} aria-label="Zoom in"><Plus size={18} /></button>
      </div>
    </div>
  );
}
