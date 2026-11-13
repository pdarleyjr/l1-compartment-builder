import { useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';

/** Static apparatus/overview photo with a graceful fallback. @param {{src:string, alt:string}} props */
export default function CompartmentImage({ src, alt }) {
  const [err, setErr] = useState(false);
  return (
    <div className="w-full bg-slate-100 rounded-lg border border-slate-300 flex items-center justify-center overflow-hidden min-h-[260px] print-image-container">
      {!err ? (
        <img src={src} alt={alt} loading="eager" fetchpriority="high" decoding="async"
          className="max-w-full max-h-[500px] object-contain p-2"
          onError={() => setErr(true)} />
      ) : (
        <div className="flex flex-col items-center text-slate-400 p-8 text-center">
          <ImageIcon size={48} className="mb-3 opacity-40" />
          <p className="font-semibold text-slate-600 text-sm">{alt}</p>
          <p className="text-xs mt-1 text-slate-500">Image not available</p>
        </div>
      )}
    </div>
  );
}
