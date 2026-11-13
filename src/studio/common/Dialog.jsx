import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { trapTab } from './dom.js';

/**
 * Accessible modal: focus trap, Escape to close, focus restored to the opener, scroll lock.
 * @param {{open?:boolean, title:string, onClose:()=>void, children:any, variant?:'center'|'sheet', closeLabel?:string,
 *   actions?:any, labelledBy?:string, zIndex?:string, headerExtra?:any}} props
 */
export default function Dialog({ open = true, title, onClose, children, variant = 'center', closeLabel = 'Close', actions, headerExtra, zIndex = 'z-50' }) {
  const ref = useRef(null);
  const opener = useRef(null);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    opener.current = document.activeElement;
    const root = ref.current;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    (root?.querySelector('[data-autofocus]') ?? root)?.focus();
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); onCloseRef.current?.(); } else trapTab(e, root);
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      opener.current?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  const sheet = variant === 'sheet';
  return (
    <div className={`fixed inset-0 ${zIndex} flex ${sheet ? 'items-stretch justify-center md:p-4' : 'items-center justify-center p-3'} bg-slate-900/70`}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        className={`bg-white flex flex-col min-h-0 min-w-0 shadow-2xl outline-none ${sheet ? 'w-full h-full md:max-w-6xl md:rounded-xl md:border md:border-slate-300' : 'w-full max-w-md max-h-[90dvh] rounded-xl'}`}>
        <div className="flex items-center gap-2 px-3 py-2 bg-slate-900 text-white shrink-0 md:rounded-t-xl">
          <h2 className="flex-1 min-w-0 font-bold text-sm sm:text-base truncate">{title}</h2>
          {headerExtra}
          <button type="button" onClick={onClose} aria-label={closeLabel}
            className="touch-target flex items-center justify-center rounded text-slate-300 hover:text-white hover:bg-slate-700"><X size={20} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">{children}</div>
        {actions && <div className="shrink-0 border-t border-slate-200 p-3 flex flex-wrap justify-end gap-2">{actions}</div>}
      </div>
    </div>
  );
}
