import { useCallback, useEffect, useMemo, useState } from 'react';
import { ToastCtx } from './toastContext.js';

/** Provides useToast() and renders a polite live region. */
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((message, kind = 'info') => {
    const id = `${Date.now()}${Math.random()}`;
    setItems(l => [...l.slice(-2), { id, message, kind }]);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="fixed bottom-3 inset-x-3 sm:inset-x-auto sm:right-3 sm:w-80 z-[70] space-y-2 pointer-events-none" role="status" aria-live="polite">
        {items.map(t => <ToastItem key={t.id} t={t} onDone={() => setItems(l => l.filter(x => x.id !== t.id))} />)}
      </div>
    </ToastCtx.Provider>
  );
}

function ToastItem({ t, onDone }) {
  useEffect(() => { const h = setTimeout(onDone, t.kind === 'error' ? 8000 : 4500); return () => clearTimeout(h); }, [t, onDone]);
  const tone = t.kind === 'error' ? 'bg-red-700' : t.kind === 'success' ? 'bg-green-700' : 'bg-slate-800';
  return <div className={`pointer-events-auto ${tone} text-white text-sm rounded-lg px-3 py-2.5 shadow-lg`}>{t.message}</div>;
}
