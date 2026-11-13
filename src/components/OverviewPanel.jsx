import { CheckCircle } from 'lucide-react';
import { COMPARTMENTS } from '../../shared/apparatus.js';
import ActionButtons from './ActionButtons.jsx';
import CompartmentImage from './CompartmentImage.jsx';

/**
 * Overview of one side of the apparatus: the apparatus photo plus a summary card per compartment (with its approved
 * main image thumbnail when one exists).
 * @param {{ov:{id:string,label:string,side:string,image:string}, allocations:Record<string,string[]>,
 *   mainImages:Record<string,{url:string,thumbUrl:string|null}>, onExport:()=>void}} props
 */
export default function OverviewPanel({ ov, allocations, mainImages, onExport }) {
  const sideComps = COMPARTMENTS.filter(c => c.side === ov.side);
  return (
      <div className="flex-1 min-h-0 flex flex-col bg-white overflow-y-auto">
        <div className="px-4 py-3 sm:p-5 border-b border-slate-200 bg-slate-50 sticky top-0 z-10 flex justify-between items-center gap-2 print:static print:border-0">
          <h2 className="text-lg sm:text-xl font-bold text-slate-800">{ov.label}</h2>
          <ActionButtons onExport={onExport} />
        </div>
        <div className="p-4 sm:p-6 space-y-5">
          <CompartmentImage src={ov.image} alt={ov.label} />
          <div>
            <h3 className="text-base font-bold text-slate-800 mb-3 border-b pb-2">Compartment Summary</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4">
              {sideComps.map(comp => {
                const tools = allocations[comp.id].filter(Boolean);
                return (
                  <div key={comp.id} className="bg-slate-50 rounded-lg border border-slate-200 overflow-hidden">
                    <div className="bg-slate-200 px-4 py-2 font-bold text-slate-700 flex justify-between items-center text-sm">
                      <span className="flex items-center gap-2 min-w-0">
                        {mainImages[comp.id] && (
                          <img src={mainImages[comp.id].thumbUrl ?? mainImages[comp.id].url} alt={`${comp.label ?? comp.id} main image`}
                            loading="lazy" decoding="async" width="40" height="40"
                            className="w-10 h-10 rounded object-cover border border-slate-300 bg-white shrink-0" />
                        )}
                        <span className="truncate">{comp.label ?? comp.id}</span>
                      </span>
                      <span className="text-xs bg-white px-2 py-0.5 rounded-full text-slate-600">{tools.length} items</span>
                    </div>
                    <div className="p-3">
                      {tools.length === 0
                        ? <p className="text-xs text-slate-600 italic">No tools assigned.</p>
                        : (
                          <ul className="space-y-1.5">
                            {tools.map((t, i) => (
                              <li key={i} className="text-xs flex items-start gap-1.5 text-slate-700">
                                <CheckCircle size={12} className="text-green-500 mt-0.5 shrink-0" />{t}
                              </li>
                            ))}
                          </ul>
                        )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    );
}
