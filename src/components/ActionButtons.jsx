import { Download, Printer } from 'lucide-react';

/**
 * Export Excel / Print PDF buttons shown in every panel header.
 * @param {{onExport:()=>void}} props
 */
export default function ActionButtons({ onExport }) {
  return (
    <div className="flex items-center gap-2 print:hidden shrink-0">
      <button onClick={onExport}
        data-touch-target="true" aria-label="Export Excel"
        className="touch-target flex items-center justify-center gap-1.5 bg-green-700 hover:bg-green-600 active:bg-green-800 text-white text-sm px-2.5 py-2 rounded transition-colors">
        <Download size={14} /> <span className="hidden sm:inline">Export Excel</span>
      </button>
      <button onClick={() => window.print()}
        data-touch-target="true" aria-label="Print PDF"
        className="touch-target flex items-center justify-center gap-1.5 bg-slate-800 hover:bg-slate-700 active:bg-slate-900 text-white text-sm px-2.5 py-2 rounded transition-colors">
        <Printer size={14} /> <span className="hidden sm:inline">Print PDF</span>
      </button>
    </div>
  );
}
