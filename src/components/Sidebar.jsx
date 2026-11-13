import { useEffect, useRef } from 'react';
import { ChevronRight, LayoutGrid, LogOut, Package, RotateCcw, Settings, X } from 'lucide-react';
import { COMPARTMENTS, OVERVIEWS } from '../../shared/apparatus.js';
import SyncStatusPill from './SyncStatusPill.jsx';
import { useIsDesktop } from './useIsDesktop.js';

const BUILD_VERSION = import.meta.env.VITE_BUILD_SHA || 'local';
const GROUPS = [['Cab', 'Cab'], ['Left', 'Left Side'], ['Right', 'Right Side'], ['Rear', 'Rear']];

/**
 * Off-canvas drawer below `lg`, static sidebar above. Closed drawer is inert + aria-hidden (FM-21); open drawer is a
 * modal dialog that takes focus, traps Tab, closes on Escape and returns focus to the opener (FM-22).
 * @param {{open:boolean, onClose:()=>void, children:any}} props
 */
export function NavDrawer({ open, onClose, children }) {
  const isDesktop = useIsDesktop();
  const ref = useRef(null);
  const modal = open && !isDesktop;
  const hidden = !open && !isDesktop;

  useEffect(() => {
    if (!modal) return undefined;
    const opener = document.activeElement;
    const focusables = () => [...ref.current.querySelectorAll('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled);
    const raf = requestAnimationFrame(() => ref.current?.querySelector('[aria-label="Close menu"]')?.focus());
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { cancelAnimationFrame(raf); document.removeEventListener('keydown', onKey); opener?.focus?.(); };
  }, [modal, onClose]);

  return (
    <>
      {open && <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={onClose} aria-hidden="true" />}
      <div
        ref={ref}
        inert={hidden ? '' : undefined}
        aria-hidden={hidden ? 'true' : undefined}
        role={modal ? 'dialog' : undefined}
        aria-modal={modal ? 'true' : undefined}
        aria-label={modal ? 'Navigation menu' : undefined}
        className={`
          fixed lg:static inset-y-0 left-0 z-50 flex-shrink-0
          transition-transform duration-300 ease-in-out
          lg:transform-none lg:translate-x-0 lg:pointer-events-auto
          ${open ? 'translate-x-0 pointer-events-auto' : '-translate-x-full pointer-events-none'}
        `}>
        {children}
      </div>
    </>
  );
}

function SideBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} data-touch-target="true"
      className={`touch-target w-full text-left px-3 py-1.5 rounded flex items-center gap-2 text-xs transition-colors ${
        active ? 'bg-red-600 text-white font-medium' : 'hover:bg-slate-800 text-slate-300'
      }`}>
      {children}
    </button>
  );
}

function CompBtn({ comp, active, count, onClick }) {
  return (
    <button onClick={onClick} data-touch-target="true"
      className={`touch-target w-full text-left px-3 py-1.5 rounded flex items-center justify-between text-xs transition-colors ${
        active ? 'bg-slate-700 text-white font-medium' : 'hover:bg-slate-800 text-slate-300'
      }`}>
      <div className="flex items-center gap-1.5">
        <ChevronRight size={12} className={active ? 'text-red-400' : 'text-slate-500'} />
        {comp.label ?? comp.id}
      </div>
      {count > 0 && (
        <span className="bg-slate-600 text-white text-[9px] px-1.5 py-0.5 rounded-full">{count}</span>
      )}
    </button>
  );
}

/**
 * Navigation sidebar (a top-level component so keyboard focus and scroll survive App re-renders, FM-34).
 * @param {{activeTab:string, onNav:(tab:string)=>void, onClose:()=>void, counts:Record<string,number>,
 *   totalPlaced:number, totalReq:number, sync:{status:string, pending:number}, session:{status:string, email:string|null},
 *   canEdit:boolean, onReset:()=>void}} props
 */
export default function Sidebar({ activeTab, onNav, onClose, counts, totalPlaced, totalReq, sync, session, canEdit, onReset, onSignIn }) {
  return (
    <div id="sidebar" className="w-64 bg-slate-900 text-slate-300 flex flex-col h-full overflow-y-auto shrink-0 print:hidden">
      <div className="p-4 bg-slate-950 flex items-center gap-3 shrink-0">
        <div className="bg-red-600 p-2 rounded-md text-white shrink-0"><Settings size={20} /></div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-white text-sm leading-tight">L1 Mid-Mount</p>
          <p className="text-[11px] text-slate-400">Compartment Builder</p>
        </div>
        <button onClick={onClose} data-touch-target="true"
          className="touch-target lg:hidden text-slate-400 hover:text-white p-1.5 rounded transition-colors touch-manipulation"
          aria-label="Close menu">
          <X size={18} />
        </button>
      </div>

      <div className="p-3 flex-1 space-y-4 overflow-y-auto">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Overviews</p>
          <div className="space-y-0.5">
            {OVERVIEWS.map(ov => (
              <SideBtn key={ov.id} active={activeTab === ov.id} onClick={() => onNav(ov.id)}>
                <LayoutGrid size={13} />{ov.label}
              </SideBtn>
            ))}
            <SideBtn active={activeTab === 'inventory'} onClick={() => onNav('inventory')}>
              <Package size={13} />Inventory Status
            </SideBtn>
          </div>
        </div>
        {GROUPS.map(([side, heading]) => (
          <div key={side}>
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">{heading}</p>
            <div className="space-y-0.5">
              {COMPARTMENTS.filter(c => c.side === side).map(comp => (
                <CompBtn key={comp.id} comp={comp} active={activeTab === comp.id} count={counts[comp.id] ?? 0}
                  onClick={() => onNav(comp.id)} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="p-3 bg-slate-950 border-t border-slate-800 space-y-2">
        <div className="flex justify-between text-xs text-slate-400">
          <span>Total Placed:</span>
          <span className="font-bold text-white bg-slate-800 px-2 py-0.5 rounded">{totalPlaced} / {totalReq}</span>
        </div>
        <div className="w-full bg-slate-800 rounded-full h-1.5">
          <div className="bg-red-500 h-1.5 rounded-full transition-all"
            style={{ width: `${Math.min(100, (totalPlaced / Math.max(1, totalReq)) * 100)}%` }} />
        </div>

        <SyncStatusPill status={sync.status} pending={sync.pending} onSignIn={onSignIn} />
        {session.status === 'signed_in' && (
          <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
            <span className="truncate" title={session.email}>{session.email}</span>
            <a href="/cdn-cgi/access/logout"
              className="shrink-0 inline-flex items-center gap-1 min-h-11 px-1 text-slate-300 hover:text-white underline">
              <LogOut size={11} aria-hidden="true" /> Sign out
            </a>
          </div>
        )}
        <p className="text-[9px] text-slate-400">Build {BUILD_VERSION.slice(0, 12)}</p>

        {canEdit && (
          <button onClick={onReset} data-touch-target="true"
            className="touch-target w-full flex items-center justify-center gap-1.5 bg-slate-700 hover:bg-red-700 text-white text-xs py-1.5 rounded transition-colors">
            <RotateCcw size={12} /> Reset All
          </button>
        )}
      </div>
    </div>
  );
}
