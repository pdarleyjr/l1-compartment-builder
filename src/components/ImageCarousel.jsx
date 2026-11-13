import { useMemo, useRef, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Image as ImageIcon, Lock, LogIn, Sparkles, Star, Upload, X } from 'lucide-react';
import { PROVENANCE_LABEL } from '../lib/gallery.js';
import { buildCarouselItems } from './carouselItems.js';

const SWIPE_PX = 50;

function ProvenanceBadge({ provenance }) {
  if (provenance === 'preset') {
    return (
      <span className="shrink-0 flex items-center gap-0.5 text-xs text-slate-700 border border-slate-300 rounded px-1.5 py-0.5 print:hidden">
        <Lock size={10} aria-hidden="true" /> locked
      </span>
    );
  }
  const label = PROVENANCE_LABEL[provenance] ?? 'Photo';
  const tone = provenance === 'ai_concept' ? 'text-indigo-800 bg-indigo-50 border-indigo-200'
    : provenance === 'approved_concept' ? 'text-green-800 bg-green-50 border-green-200'
    : provenance === 'as_built_photo' ? 'text-blue-800 bg-blue-50 border-blue-200'
    : 'text-slate-700 bg-slate-50 border-slate-300';
  return <span className={`shrink-0 text-xs border rounded px-1.5 py-0.5 ${tone}`}>{label}</span>;
}

/**
 * Compartment image carousel. Photos and main images come from the API (src/lib/gallery.js); adding photos and
 * generating renderings happen in the AI Compartment Studio.
 * @param {{compId:string, presetImages:{src:string,title:string}[], main:object|null, items:object[], canEdit:boolean,
 *   studioAvailable:boolean, signedOut:boolean, onOpenStudio:(step:'photos'|'generate')=>void, onSignIn:()=>void,
 *   onSetMain:(item:object)=>Promise<void>, onDelete:(item:object)=>Promise<void>}} props
 */
export default function ImageCarousel({ compId, presetImages, main, items, canEdit, studioAvailable, signedOut, onOpenStudio, onSignIn, onSetMain, onDelete }) {
  const [selKey, setSelKey] = useState(null);
  const [imgErr, setImgErr] = useState(false);
  const [error, setError] = useState('');
  const touch = useRef(null);
  const all = useMemo(() => buildCarouselItems({ main, presets: presetImages, items }), [main, presetImages, items]);
  const found = all.findIndex(i => i.key === selKey);
  const idx = found >= 0 ? found : 0;
  const cur = all[idx];

  const goTo = i => { setSelKey(all[i]?.key ?? null); setImgErr(false); };
  const prev = () => goTo((idx - 1 + all.length) % all.length);
  const next = () => goTo((idx + 1) % all.length);

  const onKeyDown = e => {
    if (all.length < 2) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  };
  const onPointerDown = e => { touch.current = { x: e.clientX, y: e.clientY }; };
  const onPointerUp = e => {
    const t = touch.current; touch.current = null;
    if (!t || all.length < 2) return;
    const dx = e.clientX - t.x; const dy = e.clientY - t.y;
    if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.5) (dx < 0 ? next : prev)();
  };

  const run = async fn => {
    setError('');
    try { await fn(); } catch (err) { setError(err?.message || 'That did not work. Please try again.'); }
  };
  const handleDelete = () => {
    if (!cur?.deletable) return;
    if (!window.confirm(`Remove “${cur.title}” for everyone? This cannot be undone from here.`)) return;
    run(async () => { await onDelete(cur); setSelKey(null); });
  };

  return (
    <section className="w-full" role="region" aria-roledescription="carousel" aria-label={`Images for ${compId}`} onKeyDown={onKeyDown}>
      <div className="w-full bg-slate-100 rounded-lg border border-slate-300 overflow-hidden print-image-container">
        <div className="relative flex items-center justify-center min-h-[260px] touch-pan-y"
          onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerCancel={() => { touch.current = null; }}>
          {!imgErr && cur ? (
            <img src={cur.src} alt={cur.title || 'Compartment'} key={cur.src}
              loading="lazy" decoding="async" draggable={false}
              className="max-w-full max-h-[500px] object-contain p-2"
              onError={() => setImgErr(true)} />
          ) : (
            <div className="flex flex-col items-center text-slate-400 p-8 text-center">
              <ImageIcon size={48} className="mb-3 opacity-40" />
              <p className="text-xs text-slate-500">Image not available</p>
            </div>
          )}
          {all.length > 1 && (
            <>
              <button onClick={prev} aria-label="Previous image" data-touch-target="true"
                className="touch-target absolute left-2 top-1/2 -translate-y-1/2 bg-black/30 hover:bg-black/60 active:bg-black/80 text-white rounded-full p-2 transition-colors print:hidden touch-manipulation">
                <ChevronLeft size={18} />
              </button>
              <button onClick={next} aria-label="Next image" data-touch-target="true"
                className="touch-target absolute right-2 top-1/2 -translate-y-1/2 bg-black/30 hover:bg-black/60 active:bg-black/80 text-white rounded-full p-2 transition-colors print:hidden touch-manipulation">
                <ChevronRight size={18} />
              </button>
            </>
          )}
        </div>

        {cur?.stale && (
          <div role="status" className="flex items-start gap-1.5 text-xs text-amber-900 bg-amber-50 border-t border-amber-200 px-3 py-2">
            <AlertCircle size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
            <span>Image may be outdated — equipment assignments changed</span>
          </div>
        )}

        {(all.length > 1 || cur?.title) && (
          <div className="py-2 px-3 flex flex-wrap items-center justify-between bg-white border-t border-slate-200 gap-x-2 gap-y-1">
            <div className="flex items-center gap-1.5 min-w-0 max-w-full">
              <span className="text-xs font-medium text-slate-600 truncate">{cur?.title || ''}</span>
              {cur && <ProvenanceBadge provenance={cur.provenance} />}
              {cur?.isMain && (
                <span className="shrink-0 flex items-center gap-0.5 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                  <Star size={10} fill="currentColor" aria-hidden="true" /> main image
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-x-2 min-w-0 max-w-full">
              {all.length > 1 && (
                <div className="flex flex-wrap items-center justify-center">
                  {all.map((it, i) => (
                    <button key={it.key} onClick={() => goTo(i)}
                      aria-label={`Show image ${i + 1} of ${all.length}`}
                      aria-current={i === idx ? 'true' : undefined}
                      data-touch-target="true"
                      className="touch-target w-11 h-11 flex items-center justify-center rounded-full touch-manipulation">
                      <span className={`block w-2.5 h-2.5 rounded-full transition-colors ${i === idx ? 'bg-red-500' : 'bg-slate-300'}`} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              )}
              {canEdit && cur && !cur.isMain && (cur.kind === 'preset' || cur.kind === 'asset') && (
                <button onClick={() => run(() => onSetMain(cur))}
                  aria-label="Set as main image" data-touch-target="true"
                  title="Set as main image — shown first on every device"
                  className="touch-target p-1.5 rounded transition-colors print:hidden touch-manipulation text-slate-500 hover:text-amber-600 active:text-amber-700">
                  <Star size={15} />
                </button>
              )}
              {canEdit && cur?.deletable && (
                <button onClick={handleDelete} aria-label="Remove this image" data-touch-target="true" title="Remove this image"
                  className="touch-target p-1.5 rounded text-slate-600 hover:text-red-600 active:text-red-700 transition-colors print:hidden touch-manipulation">
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {error && (
        <div role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 print:hidden">
          <AlertCircle size={13} className="shrink-0 mt-0.5" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-2 print:hidden">
        {canEdit && studioAvailable && (
          <>
            <button onClick={() => onOpenStudio('photos')} data-touch-target="true"
              className="touch-target inline-flex items-center gap-1.5 text-xs text-slate-700 hover:text-red-700 bg-slate-50 hover:bg-red-50 border border-slate-200 hover:border-red-300 rounded-lg px-3 py-2 font-medium transition-colors touch-manipulation">
              <Upload size={13} aria-hidden="true" /> Add photos
            </button>
            <button onClick={() => onOpenStudio('generate')} data-touch-target="true"
              className="touch-target inline-flex items-center gap-1.5 text-xs text-slate-700 hover:text-indigo-800 bg-slate-50 hover:bg-indigo-50 border border-slate-200 hover:border-indigo-300 rounded-lg px-3 py-2 font-medium transition-colors touch-manipulation">
              <Sparkles size={13} aria-hidden="true" /> Generate rendering
            </button>
          </>
        )}
        {signedOut && (
          <button onClick={onSignIn} data-touch-target="true"
            className="touch-target inline-flex items-center gap-1.5 text-xs text-slate-700 hover:text-red-700 bg-slate-50 hover:bg-red-50 border border-slate-200 hover:border-red-300 rounded-lg px-3 py-2 font-medium transition-colors touch-manipulation">
            <LogIn size={13} aria-hidden="true" /> Sign in to add photos
          </button>
        )}
      </div>
    </section>
  );
}
