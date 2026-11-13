import { Check } from 'lucide-react';

/** @param {{steps:{id:string,label:string,badge?:string|number|null}[], current:string, onSelect:(id:string)=>void, hint?:string}} props */
export default function StepBar({ steps, current, onSelect, hint }) {
  return (
    <div className="shrink-0 border-b border-slate-200 bg-slate-50">
      <nav aria-label="Studio steps" className="flex gap-1 overflow-x-auto px-2 py-1.5">
        {steps.map((s, i) => {
          const active = s.id === current;
          return (
            <button key={s.id} type="button" data-testid={`studio-step-${s.id}`} aria-current={active ? 'step' : undefined}
              onClick={() => onSelect(s.id)}
              className={`touch-target shrink-0 flex items-center gap-1.5 px-2.5 rounded-md text-xs sm:text-sm font-semibold whitespace-nowrap transition-colors ${active ? 'bg-red-700 text-white' : 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-100'}`}>
              <span className={`flex items-center justify-center w-5 h-5 rounded-full text-[11px] ${active ? 'bg-white text-red-700' : 'bg-slate-200 text-slate-700'}`}>{i + 1}</span>
              {s.label}
              {s.badge ? <span className="ml-0.5 min-w-[18px] px-1 rounded-full bg-amber-500 text-slate-900 text-[11px] text-center">{s.badge}</span> : null}
            </button>
          );
        })}
      </nav>
      {hint && <p className="px-3 pb-1.5 text-xs text-slate-600 flex items-start gap-1" aria-live="polite"><Check size={12} className="mt-0.5 shrink-0 text-green-700" />{hint}</p>}
    </div>
  );
}
