import { useRef } from 'react';
import { RectBox } from '../capture/RectBox.jsx';

/**
 * Photo with optional region boxes. Boxes are always editable with touch, mouse (drag handles) and keyboard (arrows).
 * @param {{src:string|null, alt:string, regions:{key:string, label:string, rect:object, active:boolean}[], onChange:(key:string, rect:object)=>void,
 *   suggestions?:{key:string, label:string, rect:object}[]}} props
 */
export function RegionEditor({ src, alt, regions, onChange, suggestions = [] }) {
  const box = useRef(null);
  if (!src) return <div className="h-40 rounded bg-slate-100 flex items-center justify-center text-sm text-slate-500">Photo unavailable</div>;
  return (
    <div className="mx-auto w-fit max-w-full bg-slate-100 rounded overflow-hidden select-none" style={{ lineHeight: 0 }}>
      <div ref={box} className="relative inline-block max-w-full">
        <img src={src} alt={alt} draggable={false} className="block max-w-full max-h-[40vh] w-auto h-auto" />
        {suggestions.filter(s => s.rect).map(s => (
          <span key={s.key} aria-hidden="true" className="absolute border-2 border-dashed border-amber-400 pointer-events-none" style={{ left: `${s.rect.x * 100}%`, top: `${s.rect.y * 100}%`, width: `${s.rect.w * 100}%`, height: `${s.rect.h * 100}%` }}>
            <span className="absolute -top-5 left-0 bg-amber-400 text-slate-900 text-[11px] px-1 rounded" style={{ lineHeight: 1.3 }}>{s.label}</span>
          </span>
        ))}
        {regions.map(r => <RectBox key={r.key} rect={r.rect} label={`Region for ${r.label}`} caption={r.label} tone={r.active ? 'red' : 'amber'} containerRef={box} onChange={rect => onChange(r.key, rect)} />)}
      </div>
    </div>
  );
}
