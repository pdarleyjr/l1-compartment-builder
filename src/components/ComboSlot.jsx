import { useEffect, useId, useRef, useState } from 'react';
import { calculateDropdownPosition } from '../dropdown-position.js';

// ─── Searchable Combo Slot ────────────────────────────────────────────────────
/**
 * Searchable equipment dropdown for one slot. With `readOnly` it renders the current value as a disabled control.
 * @param {{options:{name:string}[], value:string, onChange:(name:string)=>void, getQty:(name:string)=>number,
 *   placedStats:Record<string,{total:number}>, slotLabel:string, readOnly?:boolean}} props
 */
export default function ComboSlot({ options, value, onChange, getQty, placedStats, slotLabel, readOnly = false }) {
  const [open, setOpen]       = useState(false);
  const [query, setQuery]     = useState('');
  const [hiIdx, setHiIdx]     = useState(-1);
  const [dropPos, setDropPos] = useState({ top: 0, left: 0, width: 0, listMaxHeight: 256 });
  const containerRef = useRef(null);
  const inputRef     = useRef(null);
  const triggerRef   = useRef(null);
  const listboxId    = useId();

  const filtered = query.trim()
    ? options.filter(item => item.name.toLowerCase().includes(query.toLowerCase()))
    : options;

  useEffect(() => {
    if (!open) return;
    const closeOnPointer = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false); setQuery(''); setHiIdx(-1);
      }
    };
    // Reposition (don't close) when the page scrolls or resizes — keeps the
    // fixed-position dropdown anchored to its trigger button. Closing on scroll
    // breaks on iOS/iPad because the on-screen keyboard popping up triggers a
    // window scroll event, which would dismiss the dropdown before the user
    // can tap an option.
    const reposition = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const viewport = window.visualViewport
        ? {
            width: window.visualViewport.width,
            height: window.visualViewport.height,
            offsetTop: window.visualViewport.offsetTop,
            offsetLeft: window.visualViewport.offsetLeft,
          }
        : undefined;
      setDropPos(calculateDropdownPosition(rect, viewport));
    };
    document.addEventListener('pointerdown', closeOnPointer);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('scroll', reposition);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointer);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      window.visualViewport?.removeEventListener('resize', reposition);
      window.visualViewport?.removeEventListener('scroll', reposition);
    };
  }, [open]);

  const openDropdown = () => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const viewport = window.visualViewport
        ? {
            width: window.visualViewport.width,
            height: window.visualViewport.height,
            offsetTop: window.visualViewport.offsetTop,
            offsetLeft: window.visualViewport.offsetLeft,
          }
        : undefined;
      setDropPos(calculateDropdownPosition(rect, viewport));
    }
    setOpen(true); setQuery(''); setHiIdx(-1);
    // Auto-focus search input on devices with a physical keyboard. Skip on
    // touch-only devices because focusing a text input pops the on-screen
    // keyboard, which is jarring when the user just wants to scroll the list.
    const isTouchOnly = typeof window !== 'undefined'
      && (window.matchMedia?.('(hover: none) and (pointer: coarse)').matches ?? false);
    if (!isTouchOnly) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  const select = (name) => {
    onChange(name);
    setOpen(false);
    setQuery('');
    setHiIdx(-1);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const handleKey = (e) => {
    if (e.key === 'ArrowDown')  { e.preventDefault(); setHiIdx(i => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHiIdx(i => Math.max(i - 1, -1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (hiIdx === -1 && query.trim() && filtered[0]) select(filtered[0].name);
      else if (hiIdx === -1) select('');
      else if (filtered[hiIdx]) select(filtered[hiIdx].name);
    }
    else if (e.key === 'Escape') { setOpen(false); setQuery(''); setHiIdx(-1); }
  };

  return (
    <div ref={containerRef} className="relative flex-1 min-w-0">
      <button
        ref={triggerRef}
        onClick={openDropdown}
        disabled={readOnly}
        onKeyDown={e => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            openDropdown();
          }
        }}
        role="combobox"
        aria-label={slotLabel}
        aria-expanded={open}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        data-touch-target="true"
        className={`touch-target w-full px-2 py-2 border rounded-md text-xs text-left truncate focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none touch-manipulation ${
          value ? 'border-green-300 bg-green-50 text-slate-800 font-medium' : 'border-slate-300 bg-white text-slate-600'
        }`}
      >
        {value || '— Empty Slot —'}
      </button>

      {open && !readOnly && (
        <div
          className="fixed z-[9999] shadow-xl"
          style={{ top: dropPos.top, left: dropPos.left, width: dropPos.width }}>
          <input
            ref={inputRef}
            type="search"
            role="searchbox"
            aria-label="Search equipment"
            value={query}
            onChange={e => { setQuery(e.target.value); setHiIdx(-1); }}
            onKeyDown={handleKey}
            placeholder="Type to search tools…"
            className="min-h-11 w-full p-2 border-2 border-red-400 rounded-t-md text-xs outline-none bg-white"
          />
          <div id={listboxId} role="listbox" aria-label="Equipment choices"
            className="bg-white border border-t-0 border-slate-300 rounded-b-md overflow-y-auto overscroll-contain"
            style={{ maxHeight: dropPos.listMaxHeight }}>
            <button
              type="button" role="option" aria-selected={!value}
              onClick={() => select('')}
              data-touch-target="true"
              className={`touch-target w-full text-left px-3 py-2.5 text-xs transition-colors touch-manipulation ${
                hiIdx === -1 ? 'bg-red-50 text-red-700' : 'text-slate-400 hover:bg-slate-50 active:bg-slate-100'
              }`}
            >— Empty Slot —</button>
            {filtered.map((item, i) => {
              const placed    = placedStats[item.name]?.total ?? 0;
              const qty       = getQty(item.name);
              const remaining = qty - placed + (value === item.name ? 1 : 0);
              return (
                <button key={item.name}
                  type="button" role="option" aria-selected={value === item.name}
                  onClick={() => select(item.name)}
                  data-touch-target="true"
                  className={`touch-target w-full text-left px-3 py-2.5 text-xs flex items-center justify-between gap-2 transition-colors touch-manipulation ${
                    i === hiIdx ? 'bg-red-50 text-red-700' : 'hover:bg-slate-50 active:bg-slate-100 text-slate-700'
                  }`}
                >
                  <span className="truncate flex-1">{item.name}</span>
                  <span className={`shrink-0 font-mono text-[10px] ${remaining === 0 ? 'text-red-400' : 'text-slate-400'}`}>
                    [{remaining}/{qty}]
                  </span>
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div className="px-3 py-3 text-xs text-slate-400 text-center italic">No matching tools</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
