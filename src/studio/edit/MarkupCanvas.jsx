import { forwardRef, useEffect, useImperativeHandle, useReducer, useRef, useState } from 'react';
import { ArrowUpRight, Circle, Eraser, Pencil, Redo2, Square, Undo2 } from 'lucide-react';
import { clearAll, commit, defaultShape, drawShapes, emptyHistory, exportMarkupPng, nudgeShape, redo, scaleShape, shapeFromDrag, toNormalized, undo } from './markupModel.js';

const TOOLS = [['arrow', 'Arrow', ArrowUpRight], ['circle', 'Circle', Circle], ['rect', 'Rectangle', Square], ['free', 'Freehand', Pencil]];
const reducer = (h, a) => (a.t === 'commit' ? commit(h, a.v) : a.t === 'undo' ? undo(h) : a.t === 'redo' ? redo(h) : a.t === 'clear' ? clearAll(h) : h);

/**
 * Image with a markup layer. Touch + mouse drawing; keyboard users add a shape, then move (arrows) and resize ([ ]) it.
 * Ref API: `export()` → Promise<{png:Blob,width:number,height:number}|null>, `hasMarkup()`.
 */
const MarkupCanvas = forwardRef(function MarkupCanvas({ src, alt }, ref) {
  const [h, dispatch] = useReducer(reducer, undefined, emptyHistory);
  const [tool, setTool] = useState('arrow');
  const [draft, setDraft] = useState(null);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const canvas = useRef(null);
  const drawing = useRef([]);
  const shapes = draft ? [...h.present, draft] : h.present;

  useImperativeHandle(ref, () => ({
    hasMarkup: () => h.present.length > 0,
    export: async () => (h.present.length && natural.w ? { png: await exportMarkupPng(h.present, natural.w, natural.h), width: natural.w, height: natural.h } : null),
  }), [h.present, natural]);

  useEffect(() => {
    const c = canvas.current; if (!c || !natural.w) return;
    c.width = natural.w; c.height = natural.h;
    const ctx = c.getContext('2d'); ctx.clearRect(0, 0, c.width, c.height); drawShapes(ctx, shapes, c.width, c.height);
  });

  const pt = e => toNormalized(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
  const down = e => { e.currentTarget.setPointerCapture?.(e.pointerId); drawing.current = [pt(e)]; setDraft(shapeFromDrag(tool, [...drawing.current, pt(e)])); };
  const move = e => { if (!drawing.current.length) return; drawing.current.push(pt(e)); setDraft(shapeFromDrag(tool, drawing.current)); };
  const up = () => {
    if (!drawing.current.length) return;
    const s = shapeFromDrag(tool, drawing.current); drawing.current = []; setDraft(null);
    if (s) dispatch({ t: 'commit', v: [...h.present, s] });
  };
  const last = h.present[h.present.length - 1];
  const replaceLast = s => dispatch({ t: 'commit', v: [...h.present.slice(0, -1), s] });
  const onKey = e => {
    if (!last) return;
    const d = 0.02; const moves = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] };
    if (moves[e.key]) { e.preventDefault(); replaceLast(nudgeShape(last, ...moves[e.key])); }
    else if (e.key === ']') { e.preventDefault(); replaceLast(scaleShape(last, 1.1)); }
    else if (e.key === '[') { e.preventDefault(); replaceLast(scaleShape(last, 0.9)); }
  };
  const btn = 'touch-target px-2.5 rounded border text-sm font-semibold flex items-center gap-1.5 disabled:opacity-40';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="toolbar" aria-label="Markup tools">
        {TOOLS.map(([id, label, Icon]) => (
          <button key={id} type="button" aria-pressed={tool === id} onClick={() => setTool(id)} className={`${btn} ${tool === id ? 'bg-slate-800 text-white border-slate-800' : 'border-slate-300 hover:bg-slate-100'}`}><Icon size={15} /> {label}</button>
        ))}
        <button type="button" onClick={() => dispatch({ t: 'commit', v: [...h.present, defaultShape(tool)] })} className={`${btn} border-slate-300 hover:bg-slate-100`} data-testid="markup-add">Add {tool} (keyboard)</button>
        <button type="button" onClick={() => dispatch({ t: 'undo' })} disabled={!h.past.length} className={`${btn} border-slate-300`} aria-label="Undo"><Undo2 size={15} /></button>
        <button type="button" onClick={() => dispatch({ t: 'redo' })} disabled={!h.future.length} className={`${btn} border-slate-300`} aria-label="Redo"><Redo2 size={15} /></button>
        <button type="button" onClick={() => dispatch({ t: 'clear' })} disabled={!h.present.length} className={`${btn} border-slate-300`}><Eraser size={15} /> Clear</button>
      </div>
      <div className="relative inline-block max-w-full bg-slate-900 rounded-lg overflow-hidden leading-none">
        <img src={src} alt={alt} onLoad={e => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} className="block max-w-full max-h-[60dvh] select-none" draggable={false} />
        <canvas ref={canvas} tabIndex={0} aria-label="Markup layer. Draw with a finger or mouse; or add a shape with the button, then use arrow keys to move it and the bracket keys to resize."
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={onKey}
          className="absolute inset-0 w-full h-full touch-none cursor-crosshair focus-visible:outline-offset-[-3px]" />
      </div>
    </div>
  );
});
export default MarkupCanvas;
