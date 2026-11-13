import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, RefreshCw, X } from 'lucide-react';
import { BTN_PRIMARY, BTN_SECONDARY } from './styles.js';

function describeCameraError(err) {
  switch (err?.name) {
    case 'NotAllowedError': case 'SecurityError':
      return 'Camera access is blocked. Allow the camera for this site in your browser settings (tap the lock or camera icon in the address bar), then try again — or use Take Photo.';
    case 'NotFoundError': case 'OverconstrainedError':
      return 'No camera was found on this device. Use Take Photo or Choose Photos instead.';
    case 'NotReadableError': return 'The camera is in use by another app. Close it and try again.';
    default: return 'The camera could not be started. Use Take Photo or Choose Photos instead.';
  }
}

/**
 * Inline viewfinder using getUserMedia (rear camera first, switchable).
 * @param {{onCapture:(file:File)=>void, onClose:()=>void}} props
 */
export function LiveCamera({ onCapture, onClose }) {
  const video = useRef(null);
  const stream = useRef(null);
  const [facing, setFacing] = useState('environment');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);

  const stop = useCallback(() => { stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; }, []);

  useEffect(() => {
    let alive = true;
    setReady(false); setError('');
    (async () => {
      try {
        stop();
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 4096 }, height: { ideal: 3072 } }, audio: false });
        if (!alive) { s.getTracks().forEach(t => t.stop()); return; }
        stream.current = s;
        if (video.current) { video.current.srcObject = s; await video.current.play().catch(() => {}); }
        setReady(true);
      } catch (e) { if (alive) setError(describeCameraError(e)); }
    })();
    return () => { alive = false; stop(); };
  }, [facing, stop]);

  const snap = () => {
    const v = video.current;
    if (!v?.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    c.toBlob(b => { if (b) onCapture(new File([b], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' })); }, 'image/jpeg', 0.95);
  };

  return (
    <div className="rounded-lg border border-slate-300 bg-slate-900 overflow-hidden" data-testid="live-camera">
      {error ? (
        <p role="alert" className="p-4 text-sm text-white">{error}</p>
      ) : (
        <video ref={video} playsInline muted aria-label="Camera viewfinder" className="w-full max-h-[60vh] bg-black object-contain" />
      )}
      <div className="flex flex-wrap items-center gap-2 p-3 bg-slate-800">
        <button type="button" className={BTN_PRIMARY} onClick={snap} disabled={!ready} data-testid="live-camera-shutter"><Camera size={16} aria-hidden="true" /> Capture</button>
        <button type="button" className={BTN_SECONDARY} onClick={() => setFacing(f => (f === 'environment' ? 'user' : 'environment'))}>
          <RefreshCw size={16} aria-hidden="true" /> {facing === 'environment' ? 'Use front camera' : 'Use rear camera'}
        </button>
        <button type="button" className={`${BTN_SECONDARY} ml-auto`} onClick={onClose}><X size={16} aria-hidden="true" /> Close camera</button>
      </div>
    </div>
  );
}
