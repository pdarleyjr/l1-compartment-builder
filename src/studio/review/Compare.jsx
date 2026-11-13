import { useEffect, useState } from 'react';

function useWide() {
  const q = '(min-width: 768px)';
  const [wide, setWide] = useState(() => globalThis.matchMedia?.(q).matches ?? true);
  useEffect(() => {
    const m = globalThis.matchMedia?.(q); if (!m) return undefined;
    const on = () => setWide(m.matches); m.addEventListener('change', on); return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}

/** Compare two images: side by side on wide screens, swipe slider on phones.
 * @param {{options:{id:string,label:string,url:string}[], leftId:string, rightId:string, onLeft:(id:string)=>void, onRight:(id:string)=>void}} props */
export default function Compare({ options, leftId, rightId, onLeft, onRight }) {
  const wide = useWide();
  const [pos, setPos] = useState(50);
  const a = options.find(o => o.id === leftId) ?? options[0], b = options.find(o => o.id === rightId) ?? options[1] ?? options[0];
  const select = (value, onChange, label) => (
    <label className="text-xs text-slate-600 flex flex-col min-w-0">{label}
      <select value={value} onChange={e => onChange(e.target.value)} className="touch-target border border-slate-300 rounded px-1.5 text-sm text-slate-900 bg-white">
        {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </label>
  );
  return (
    <div className="space-y-2" data-testid="compare-view">
      <div className="grid grid-cols-2 gap-2">{select(a?.id, onLeft, 'Left')}{select(b?.id, onRight, 'Right')}</div>
      {wide ? (
        <div className="grid grid-cols-2 gap-2">
          {[a, b].map((o, i) => <figure key={i} className="min-w-0 bg-slate-900 rounded-lg"><img src={o?.url} alt={o?.label} className="w-full max-h-[60dvh] object-contain" /><figcaption className="text-xs text-white px-2 py-1">{o?.label}</figcaption></figure>)}
        </div>
      ) : (
        <div className="space-y-1">
          <div className="relative bg-slate-900 rounded-lg overflow-hidden">
            <img src={b?.url} alt={b?.label} className="w-full max-h-[55dvh] object-contain" />
            <img src={a?.url} alt={a?.label} className="absolute inset-0 w-full h-full object-contain" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} />
            <div className="absolute inset-y-0 w-0.5 bg-white pointer-events-none" style={{ left: `${pos}%` }} />
          </div>
          <input type="range" min="0" max="100" value={pos} onChange={e => setPos(Number(e.target.value))} aria-label="Slide to compare" className="w-full h-11" />
          <p className="text-xs text-slate-600 flex justify-between"><span>{a?.label}</span><span>{b?.label}</span></p>
        </div>
      )}
    </div>
  );
}
