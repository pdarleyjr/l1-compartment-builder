import { useMemo, useState } from 'react';
import { AlertCircle, HelpCircle } from 'lucide-react';
import { buildProgress } from '../lib/progress.js';

function VerifyBadge({ reason }) {
  return (
    <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-900 text-xs font-bold px-2 py-0.5 rounded-full">
      <HelpCircle size={11} aria-hidden="true" /> Needs verification{reason ? <span className="font-normal">: {reason}</span> : null}
    </span>
  );
}

/**
 * Read-only placement progress: what is placed in each compartment and what is still to place.
 * @param {{view:object, plan:ReturnType<import('./usePlan.js').default>, onNav:(tab:string)=>void}} props
 */
export default function ProgressPanel({ view, plan, onNav }) {
  const [filter, setFilter] = useState('');
  const progress = useMemo(() => buildProgress(view, plan), [view, plan]);
  const { totals } = progress;
  const q = filter.trim().toLowerCase();
  const match = name => !q || name.toLowerCase().includes(q);
  const pct = Math.min(100, Math.round((totals.unitsPlaced / Math.max(1, totals.unitsRequired)) * 100));
  const pending = progress.pending.filter(p => match(p.name));
  const compartments = progress.compartments.map(c => ({ ...c, lines: c.lines.filter(l => match(l.name)) }));
  const stillCount = progress.pending.length;

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-white overflow-y-auto">
      <div className="px-4 py-3 sm:p-5 border-b border-slate-200 bg-slate-50 sticky top-0 z-10 print:static print:border-0">
        <h2 className="text-lg sm:text-xl font-bold text-slate-800">Placement Progress</h2>
        <p className="text-xs sm:text-sm text-slate-600" data-testid="progress-summary">
          {totals.unitsPlaced} of {totals.unitsRequired} units placed · {stillCount} {stillCount === 1 ? 'item' : 'items'} still to place · {totals.needsVerification} need verification
        </p>
      </div>

      <div className="p-4 sm:p-6 space-y-6 min-w-0">
        <div>
          <div role="progressbar" aria-label="Units placed" aria-valuemin={0} aria-valuemax={Math.max(1, totals.unitsRequired)}
            aria-valuenow={Math.min(totals.unitsPlaced, Math.max(1, totals.unitsRequired))}
            aria-valuetext={`${totals.unitsPlaced} of ${totals.unitsRequired} units placed`}
            className="w-full bg-slate-200 rounded-full h-2 mb-1">
            <div className="bg-red-500 h-2 rounded-full transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-slate-600 text-right">{pct}% placed</p>
        </div>

        <div className="print:hidden">
          <label htmlFor="progress-filter" className="block text-sm font-semibold text-slate-700 mb-1">Filter equipment</label>
          <input id="progress-filter" type="search" value={filter} onChange={e => setFilter(e.target.value)}
            className="min-h-11 w-full sm:max-w-md border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-800 focus:ring-2 focus:ring-red-400 outline-none bg-white" />
        </div>

        {progress.over.length > 0 && (
          <section aria-labelledby="progress-over" className="rounded-lg border border-red-200 bg-red-50 p-4">
            <h3 id="progress-over" className="flex items-center gap-2 text-base font-bold text-red-800">
              <AlertCircle size={16} aria-hidden="true" /> Over-allocated
            </h3>
            <ul className="mt-2 space-y-1 text-sm text-red-900">
              {progress.over.filter(o => match(o.name)).map(o => (
                <li key={o.name} className="break-words">{o.name}: {o.placed} placed, only {o.required} required ({o.excess} too many)</li>
              ))}
            </ul>
          </section>
        )}

        <section aria-labelledby="progress-placed">
          <h3 id="progress-placed" className="text-base font-bold text-slate-800 mb-3 border-b pb-2">Placed so far</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4">
            {compartments.filter(c => !q || c.lines.length > 0).map(c => (
              <div key={c.id} data-testid={`progress-comp-${c.id}`} className="bg-slate-50 rounded-lg border border-slate-200 overflow-hidden min-w-0 print:break-inside-avoid">
                <div className="bg-slate-200 px-4 py-1 font-bold text-slate-700 flex justify-between items-center gap-2 text-sm">
                  <button type="button" onClick={() => onNav(c.id)} data-touch-target="true"
                    className="touch-target text-left underline decoration-slate-400 hover:text-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-600 min-w-0 break-words print:no-underline">
                    {c.label}<span className="sr-only"> compartment page</span>
                  </button>
                  <span className="text-xs bg-white px-2 py-0.5 rounded-full text-slate-700 shrink-0">{c.units} {c.units === 1 ? 'unit' : 'units'}</span>
                </div>
                <div className="p-3">
                  {c.lines.length === 0 ? (
                    <p className="text-sm text-slate-600">{c.units === 0 ? 'Nothing placed yet' : 'No matching equipment'}</p>
                  ) : (
                    <ul className="space-y-2">
                      {c.lines.map(l => (
                        <li key={l.name} className="text-sm text-slate-800 break-words">
                          <span className="font-medium">{l.name} × {l.qty}</span>
                          {(l.bundles.length > 0 || l.needsVerification) && (
                            <span className="mt-1 flex flex-wrap gap-1.5">
                              {l.bundles.map(b => (
                                <span key={b} className="inline-block bg-blue-100 text-blue-800 text-xs font-semibold px-2 py-0.5 rounded-full">Bundle: {b}</span>
                              ))}
                              {l.needsVerification && <VerifyBadge reason={l.reason} />}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="progress-pending">
          <h3 id="progress-pending" className="text-base font-bold text-slate-800 mb-3 border-b pb-2">Still to place</h3>
          {pending.length === 0 ? (
            <p className="text-sm text-slate-600">{q ? 'No matching equipment still to place.' : 'Everything has been placed.'}</p>
          ) : (
            <ul className="grid grid-cols-1 lg:grid-cols-2 gap-2">
              {pending.map(p => (
                <li key={p.name} className="rounded-lg border border-slate-200 bg-white p-3 text-sm min-w-0 print:break-inside-avoid">
                  <p className="font-medium text-slate-800 break-words">{p.name}</p>
                  <p className="text-slate-700">{p.placed} of {p.required} placed — {p.remaining} to place</p>
                  {p.placedIn.length > 0 && (
                    <p className="text-xs text-slate-600">Already in: {p.placedIn.map(x => (x.count > 1 ? `${x.label} ×${x.count}` : x.label)).join(', ')}</p>
                  )}
                  {p.needsVerification && <p className="mt-1"><VerifyBadge reason={p.reason} /></p>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
