import { useRef } from 'react';
import { moveRect, nudgeRect, resizeRect } from '../../lib/image/geometry.js';

const HANDLES = [['nw', 'left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize'], ['ne', 'right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize'],
  ['sw', 'left-0 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize'], ['se', 'right-0 bottom-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize']];

/**
 * Draggable/resizable normalized rectangle over a positioned container (touch, mouse and keyboard).
 * Arrow keys move by 1 %; Shift+Arrow resizes. Handles have 44 px hit areas.
 * @param {{rect:{x:number,y:number,w:number,h:number}, onChange:(r:object)=>void, label:string, containerRef:{current:HTMLElement|null},
 *   tone?:'red'|'navy'|'amber', min?:number, caption?:string, dim?:boolean}} props
 */
export function RectBox({ rect, onChange, label, containerRef, tone = 'red', min = 0.05, caption, dim = false }) {
  const drag = useRef(null);
  const color = { red: 'border-red-500', navy: 'border-slate-800', amber: 'border-amber-400' }[tone];

  const start = (e, mode) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, rect };
  };
  const move = e => {
    const d = drag.current; const box = containerRef.current?.getBoundingClientRect();
    if (!d || !box) return;
    const dx = (e.clientX - d.x) / box.width; const dy = (e.clientY - d.y) / box.height;
    onChange(d.mode === 'move' ? moveRect(d.rect, dx, dy) : resizeRect(d.rect, d.mode, dx, dy, min));
  };
  const end = () => { drag.current = null; };
  const onKey = e => {
    if (!e.key.startsWith('Arrow')) return;
    e.preventDefault();
    onChange(nudgeRect(rect, e.key, e.shiftKey, 0.01, min));
  };

  return (
    <div role="group" tabIndex={0} aria-label={`${label}. Arrow keys move the box, Shift plus arrows resize it.`} onKeyDown={onKey}
      onPointerDown={e => start(e, 'move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
      style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%`, touchAction: 'none' }}
      className={`absolute border-2 ${color} bg-white/10 cursor-move focus:outline-none focus-visible:ring-2 focus-visible:ring-white ${dim ? 'shadow-[0_0_0_9999px_rgba(15,23,42,0.45)]' : ''}`}>
      {caption && <span className="absolute -top-6 left-0 max-w-full truncate bg-slate-900/80 text-white text-[11px] px-1.5 py-0.5 rounded">{caption}</span>}
      {HANDLES.map(([h, pos]) => (
        <span key={h} role="presentation" onPointerDown={e => start(e, h)} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
          style={{ touchAction: 'none' }} className={`absolute ${pos} w-11 h-11 flex items-center justify-center`}>
          <span className="block w-4 h-4 rounded-full bg-white border-2 border-red-600" />
        </span>
      ))}
    </div>
  );
}
