import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { BTN_ICON } from './styles.js';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal: role=dialog, focus trap, Escape closes, focus returns to the opener.
 * Bottom sheet on phones, centered card from sm up.
 * @param {{open:boolean, onClose:()=>void, title:string, children:any, footer?:any, wide?:boolean, testId?:string}} props
 */
export function Modal({ open, onClose, title, children, footer, wide = false, testId }) {
  const ref = useRef(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    const node = ref.current;
    const first = node?.querySelector('[data-autofocus]') ?? node?.querySelector(FOCUSABLE);
    first?.focus();
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); onCloseRef.current(); return; }
      if (e.key !== 'Tab' || !node) return;
      const items = Array.from(node.querySelectorAll(FOCUSABLE)).filter(el => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) return;
      const a = items[0]; const z = items[items.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/60 p-0 sm:p-4" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId}
        className={`bg-white w-full ${wide ? 'sm:max-w-3xl' : 'sm:max-w-xl'} max-h-[92vh] flex flex-col rounded-t-xl sm:rounded-xl shadow-xl overflow-hidden`}>
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-slate-200 bg-slate-800 text-white">
          <h2 id={titleId} className="text-base font-semibold truncate">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className={`${BTN_ICON} text-white hover:bg-slate-700 active:bg-slate-600`}><X size={18} aria-hidden="true" /></button>
        </div>
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 min-w-0">{children}</div>
        {footer && <div className="border-t border-slate-200 p-3 flex flex-wrap gap-2 justify-end bg-slate-50">{footer}</div>}
      </div>
    </div>
  );
}
