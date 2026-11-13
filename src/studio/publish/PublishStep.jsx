import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Undo2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import { ProvenanceBadge, StatusPill } from '../common/badges.jsx';
import Dialog from '../common/Dialog.jsx';
import { humanError } from '../common/format.js';
import { useToast } from '../common/toastContext.js';
import { canPublish, classifyPublishError, extractMain, publishBody } from './publishModel.js';

const base = compId => `/compartments/${encodeURIComponent(compId)}/main-image`;

/**
 * Step 7: approve a version and make it the compartment's main image.
 * @param {{compId:string, version:object|null, versionLabel:string, mainImage:object|null, onMainImageChanged:(m:object)=>void,
 *   onRegenerate:()=>void, onRefreshVersions:()=>void}} props
 */
export default function PublishStep({ compId, version, versionLabel, mainImage, onMainImageChanged, onRegenerate, onRefreshVersions }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState('');

  const reload = async () => {
    try { const m = extractMain(await api('/public/main-images'), compId); if (m) onMainImageChanged?.(m); } catch { /* keep current */ }
  };
  const run = async (path, body, okText) => {
    setBusy(true); setMessage('');
    try {
      const res = await api(path, { method: 'POST', json: body });
      onMainImageChanged?.(res.main); onRefreshVersions?.(); setStale(false); toast(okText, 'success');
    } catch (e) {
      const o = classifyPublishError(e);
      if (o.kind === 'stale') setStale(true);
      else { setMessage(o.kind === 'other' ? humanError(e) : o.message); if (o.kind === 'conflict') await reload(); }
    } finally { setBusy(false); }
  };
  const publish = ack => run(base(compId), publishBody(version, mainImage, ack), 'Main image updated for everyone.');
  const restore = () => run(`${base(compId)}/restore`, { expectRevision: mainImage?.revision ?? 0 }, 'Previous main image restored.');

  const card = (title, src, children) => (
    <figure className="min-w-0 space-y-1"><figcaption className="text-xs font-bold uppercase tracking-wide text-slate-600">{title}</figcaption>
      {src ? <img src={src} alt={title} className="w-full max-h-[45dvh] object-contain bg-slate-900 rounded-lg" /> : <div className="h-40 rounded-lg bg-slate-100 border border-dashed border-slate-300 flex items-center justify-center text-sm text-slate-600">No image</div>}
      {children}</figure>
  );
  return (
    <div className="p-3 sm:p-4 space-y-4" data-testid="publish-step">
      {mainImage?.stale && <p role="status" className="flex items-start gap-1.5 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-sm text-amber-950"><AlertTriangle size={16} className="mt-0.5 shrink-0" />The current main image may be outdated — equipment assignments changed since it was made.</p>}
      <div className="grid gap-4 md:grid-cols-2">
        {card('Current main image', mainImage?.url, mainImage?.previous && <button type="button" disabled={busy} onClick={restore} className="touch-target px-3 rounded border border-slate-300 text-sm font-semibold flex items-center gap-1.5 hover:bg-slate-100"><Undo2 size={14} /> Restore previous main image</button>)}
        {card(version ? `Selected: ${versionLabel}` : 'Selected version', version?.variants?.display, version && <div className="flex items-center gap-2"><StatusPill status={version.status} /></div>)}
      </div>
      <ProvenanceBadge />
      {message && <p role="alert" className="text-sm rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-amber-950">{message}</p>}
      {!version && <p className="text-sm text-slate-700">Pick a version in Review first.</p>}
      <button type="button" data-testid="publish-approve" disabled={busy || !canPublish(version)} onClick={() => publish(false)}
        className="touch-target px-5 rounded-lg bg-red-700 hover:bg-red-800 disabled:opacity-50 text-white font-bold flex items-center gap-2"><CheckCircle2 size={16} /> Approve &amp; Set as Main Image</button>
      <p className="text-xs text-slate-600">The approved image becomes visible to everyone who opens this compartment, labelled as an AI concept.</p>

      <Dialog open={stale} title="Image may be outdated" onClose={() => setStale(false)}
        actions={<>
          <button type="button" onClick={() => setStale(false)} data-autofocus className="touch-target px-4 rounded border border-slate-300 text-sm font-semibold">Cancel</button>
          <button type="button" onClick={() => { setStale(false); onRegenerate?.(); }} className="touch-target px-4 rounded bg-slate-800 text-white text-sm font-semibold">Regenerate</button>
          <button type="button" data-testid="publish-anyway" disabled={busy} onClick={() => publish(true)} className="touch-target px-4 rounded bg-red-700 text-white text-sm font-bold">Publish anyway</button>
        </>}>
        <p className="p-4 text-sm text-slate-800">Equipment assignments changed since this image was generated. It may not match what is assigned now.</p>
      </Dialog>
    </div>
  );
}
