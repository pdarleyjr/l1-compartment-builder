import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Images, Upload, Video } from 'lucide-react';
import { signInUrl } from '../../lib/api.js';
import { useUploadQueue } from '../../lib/upload-queue.js';
import { AssociationDialog } from '../library/AssociationDialog.jsx';
import { notifyAssetsChanged } from '../library/events.js';
import { CATEGORY_OPTIONS, needsAssociation } from './categories.js';
import { CropEditor } from './CropEditor.jsx';
import { canUseLiveCamera } from './camera-support.js';
import { LiveCamera } from './LiveCamera.jsx';
import { PendingGrid } from './PendingGrid.jsx';
import { summarizeQueue } from './queue-status.js';
import { BTN_PRIMARY, BTN_SECONDARY, CARD, INPUT } from './styles.js';
import { UploadProgressList } from './UploadProgressList.jsx';
import { usePendingPhotos } from './usePendingPhotos.js';

/**
 * Photo capture and upload: Take Photo, Choose Photos, optional live camera, drag-and-drop, review (rotate / crop /
 * retake / remove / category) and a durable upload queue. Tool photos open the association dialog after commit.
 * @param {{compId:string, session:{status:string, canEdit?:boolean}, plannerDoc:object|null, onAssetsCommitted?:(assets:object[])=>void,
 *   defaultCategory?:string}} props
 */
export function CapturePanel({ compId, session, plannerDoc, onAssetsCommitted, defaultCategory = 'tool' }) {
  const pending = usePendingPhotos(defaultCategory);
  const [category, setCategory] = useState(defaultCategory);
  const [camera, setCamera] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [crop, setCrop] = useState(null);
  const [preparing, setPreparing] = useState(null);
  const [prepError, setPrepError] = useState('');
  const [assocQueue, setAssocQueue] = useState([]);
  const takeRef = useRef(null);
  const chooseRef = useRef(null);
  const committedRef = useRef(onAssetsCommitted);
  committedRef.current = onAssetsCommitted;
  const signedIn = session?.status === 'signed_in' && session.canEdit !== false;

  const onCommitted = useCallback(item => {
    if (!item.asset) return;
    notifyAssetsChanged(item.compId);
    committedRef.current?.([item.asset]);
    if (needsAssociation(item.category)) setAssocQueue(q => (q.some(a => a.id === item.asset.id) ? q : [...q, item.asset]));
  }, []);
  const queue = useUploadQueue(compId, { onCommitted });
  useEffect(() => { setCategory(defaultCategory); }, [defaultCategory, compId]);

  const addFiles = files => { setPrepError(''); pending.addFiles(files, category); };
  const readyCount = pending.items.filter(i => i.status === 'ready').length;

  const upload = async () => {
    const ready = pending.items.filter(i => i.status === 'ready');
    setPrepError('');
    let n = 0;
    for (const item of ready) {
      n += 1;
      setPreparing(`Preparing photo ${n} of ${ready.length}…`);
      try {
        const { variants } = await pending.encodeForUpload(item);
        await queue.enqueue({ compId, category: item.category, label: item.name, variants });
        pending.remove(item.id);
      } catch (e) {
        setPrepError(`${item.name}: ${e?.message || 'could not be prepared.'}`);
      }
    }
    setPreparing(null);
  };

  const onDrop = e => {
    e.preventDefault(); setDragging(false);
    const files = Array.from(e.dataTransfer?.files ?? []).filter(f => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
    if (files.length) addFiles(files);
  };

  if (!signedIn) {
    return (
      <section className={`${CARD} p-4`} aria-label="Add photos">
        <p className="text-sm text-slate-700">Sign in to add photos.</p>
        <a href={signInUrl()} className={`${BTN_PRIMARY} mt-3`}>Sign in</a>
      </section>
    );
  }

  const cropItem = pending.items.find(i => i.id === crop);
  return (
    <section className="flex flex-col gap-4 min-w-0" aria-label="Add photos" data-testid="capture-panel">
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}
        className={`rounded-lg border-2 border-dashed p-4 flex flex-col gap-3 ${dragging ? 'border-red-500 bg-red-50' : 'border-slate-300 bg-slate-50'}`}>
        <div className="grid grid-cols-1 min-[420px]:grid-cols-2 gap-3">
          <button type="button" className={`${BTN_PRIMARY} min-h-14 text-base`} data-testid="capture-take-photo" onClick={() => takeRef.current?.click()}>
            <Camera size={20} aria-hidden="true" /> Take Photo
          </button>
          <button type="button" className={`${BTN_SECONDARY} min-h-14 text-base`} data-testid="capture-choose" onClick={() => chooseRef.current?.click()}>
            <Images size={20} aria-hidden="true" /> Choose Photos
          </button>
        </div>
        <input ref={takeRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" data-testid="capture-input-camera"
          onChange={e => { addFiles(e.target.files ?? []); e.target.value = ''; }} />
        <input ref={chooseRef} type="file" accept="image/*,.heic,.heif" multiple className="sr-only" tabIndex={-1} aria-hidden="true" data-testid="capture-input-files"
          onChange={e => { addFiles(e.target.files ?? []); e.target.value = ''; }} />
        <p className="text-xs text-slate-500 text-center">Or drop photos here. JPEG, PNG, WebP and HEIC are accepted.</p>
        <label className="block">
          <span className="block text-xs font-semibold text-slate-600 mb-1">New photos are…</span>
          <select className={INPUT} value={category} data-testid="capture-category" onChange={e => setCategory(e.target.value)}>
            {CATEGORY_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        {canUseLiveCamera() && !camera && (
          <button type="button" className={BTN_SECONDARY} onClick={() => setCamera(true)} data-testid="capture-live-camera"><Video size={16} aria-hidden="true" /> Live camera</button>
        )}
      </div>

      {camera && <LiveCamera onCapture={f => addFiles([f])} onClose={() => setCamera(false)} />}

      {pending.items.length > 0 && (
        <div className="flex flex-col gap-3" data-testid="capture-review">
          <h3 className="text-sm font-bold text-slate-700">Review {pending.items.length} photo{pending.items.length === 1 ? '' : 's'}</h3>
          <PendingGrid items={pending.items} onCategory={pending.setCategory} onRotate={pending.rotate90} onCrop={i => setCrop(i.id)}
            onRetake={pending.replace} onRemove={pending.remove} />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BTN_PRIMARY} data-testid="capture-upload" disabled={!readyCount || !!preparing} onClick={upload}>
              <Upload size={16} aria-hidden="true" /> Upload {readyCount} photo{readyCount === 1 ? '' : 's'}
            </button>
            <button type="button" className={BTN_SECONDARY} onClick={pending.clear} disabled={!!preparing}>Discard all</button>
          </div>
        </div>
      )}
      <div aria-live="polite" className="text-sm text-slate-600">{preparing}</div>
      {prepError && <p role="alert" className="text-sm text-red-700">{prepError}</p>}

      {queue.paused === 'offline' && <p role="status" className="text-sm text-amber-700">You are offline. Photos stay on this device and upload automatically when you reconnect.</p>}
      {queue.paused === 'signed_out' && (
        <p role="alert" className="text-sm text-amber-800">Signed out — <a className="underline font-medium" href={signInUrl()}>sign in</a> to finish uploading. Your photos are kept on this device.</p>
      )}
      <UploadProgressList items={queue.items} onCancel={queue.cancel} onRetry={queue.retry} onRemove={queue.remove}
        onLink={it => needsAssociation(it.category) && setAssocQueue(q => (q.some(a => a.id === it.asset.id) ? q : [...q, it.asset]))} />
      <p className="sr-only" aria-live="polite">{summarizeQueue(queue.items)}</p>
      {queue.items.some(i => i.state === 'done' || i.state === 'cancelled') && (
        <button type="button" className={`${BTN_SECONDARY} self-start`} onClick={queue.clearFinished}>Clear finished</button>
      )}

      {cropItem && (
        <CropEditor open name={cropItem.name} rotate={cropItem.rotate} crop={cropItem.crop}
          loadPreview={r => pending.loadEditorPreview(cropItem.file, r)}
          onApply={t => { pending.applyTransform(cropItem.id, cropItem.file, t); setCrop(null); }} onClose={() => setCrop(null)} />
      )}
      <AssociationDialog compId={compId} session={session} asset={assocQueue[0] ?? null} plannerDoc={plannerDoc} open={assocQueue.length > 0}
        onClose={() => setAssocQueue(q => q.slice(1))}
        onSaved={asset => { notifyAssetsChanged(compId); committedRef.current?.([asset]); setAssocQueue(q => q.slice(1)); }} />
    </section>
  );
}
