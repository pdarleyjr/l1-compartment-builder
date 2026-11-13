import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Link2, Lock, Settings } from 'lucide-react';
import { signInUrl } from '../lib/api.js';
import { useActiveJobs } from '../lib/jobs.js';
import { AssetLibrary, AssociationDialog, CapturePanel, MountsPanel } from './capture/index.js';
import AdminPanel from './admin/AdminPanel.jsx';
import Dialog from './common/Dialog.jsx';
import StepBar from './common/StepBar.jsx';
import { ToastProvider } from './common/Toast.jsx';
import { useCompartmentData } from './common/data.js';
import EditStep from './edit/EditStep.jsx';
import GenerateStep from './generate/GenerateStep.jsx';
import ArrangeStep from './layout/ArrangeStep.jsx';
import PublishStep from './publish/PublishStep.jsx';
import ReviewStep from './review/ReviewStep.jsx';
import { versionLabels } from './review/reviewModel.js';
import { useVersions } from './review/useVersions.js';

const STEPS = [
  { id: 'photos', label: 'Photos', hint: 'Add photos of the compartment, tools and mounting hardware.' },
  { id: 'tools', label: 'Tools', hint: 'Link photos to the tools in this compartment. Tools without photos are drawn from their names.' },
  { id: 'mounts', label: 'Mounts', hint: 'Describe brackets, trays and holders that are part of the layout.' },
  { id: 'arrange', label: 'Arrange', hint: 'Choose where each item goes. This step is optional but improves the result.' },
  { id: 'generate', label: 'Generate', hint: 'Pick a quality level and create a draft image.' },
  { id: 'review', label: 'Review & Edit', hint: 'Compare drafts, request changes, or reject what is not right.' },
  { id: 'publish', label: 'Publish', hint: 'Approve one image to show as this compartment’s main image.' },
];

function Notice({ icon: Icon, title, children, action }) {
  return (
    <div className="p-6 max-w-md mx-auto text-center space-y-3"><Icon size={32} className="mx-auto text-slate-500" aria-hidden="true" />
      <h3 className="font-bold text-slate-900">{title}</h3><p className="text-sm text-slate-700">{children}</p>{action}</div>
  );
}

function ToolsStep({ data, onLink }) {
  return (
    <div className="p-3 sm:p-4 space-y-3" data-testid="tools-step">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold text-slate-900">Tools in this compartment</h3>
        <button type="button" onClick={onLink} className="touch-target px-3 rounded bg-slate-800 text-white text-sm font-semibold flex items-center gap-1.5"><Link2 size={14} /> Link photos</button></div>
      {!data.tools.length && <p className="text-sm text-slate-600">No tools are assigned to this compartment yet.</p>}
      <ul className="grid gap-2 sm:grid-cols-2">{data.tools.map(t => {
        const n = data.counts[t.ref] ?? 0;
        return <li key={t.ref} className="rounded-lg border border-slate-300 bg-white p-2 flex items-center gap-2 min-w-0"><span className="flex-1 min-w-0 text-sm font-semibold break-words">{t.qty > 1 ? `${t.qty}× ` : ''}{t.name}</span>
          {n ? <span className="shrink-0 text-xs font-bold text-green-800 bg-green-100 border border-green-300 rounded-full px-2 py-0.5">{n} photo{n === 1 ? '' : 's'}</span>
            : <span className="shrink-0 text-xs font-bold text-amber-900 bg-amber-100 border border-amber-300 rounded-full px-2 py-0.5">No photo</span>}</li>;
      })}</ul>
    </div>
  );
}

/**
 * AI Compartment Studio: full-screen on phones, large sheet on tablets+. Lazy-loaded by App.jsx.
 * @param {{compId:string, session:object, plannerDoc:object, plannerRevision:number, mainImage:object|null, initialStep?:'photos'|'tools'|'mounts'|'arrange'|'generate'|'review'|'publish', onClose:()=>void, onMainImageChanged:(m:object)=>void}} props
 */
export default function StudioShell({ compId, session, plannerDoc, plannerRevision = 0, mainImage, initialStep = 'photos', onClose, onMainImageChanged }) {
  const [view, setView] = useState('steps');
  const [step, setStep] = useState(STEPS.some(s => s.id === initialStep) ? initialStep : 'photos');
  const [reviewMode, setReviewMode] = useState('review');
  const [selectedId, setSelectedId] = useState(null);
  const [baseId, setBaseId] = useState(null);
  const [linkPicker, setLinkPicker] = useState(false);
  const [linkAsset, setLinkAsset] = useState(null);
  const signedIn = session?.status === 'signed_in' && session.canEdit !== false;
  const enabled = signedIn && session.studioEnabled;
  const data = useCompartmentData(compId, plannerDoc);
  const versions = useVersions(compId);
  const jobsState = useActiveJobs(compId);
  const label = data.geometry?.label ?? compId;

  // Resume: if a job is running when we open, land on Generate once.
  const resumed = useRef(false);
  useEffect(() => { if (!resumed.current && jobsState.loaded) { resumed.current = true; if (jobsState.active.length) setStep('generate'); } }, [jobsState.loaded, jobsState.active.length]);
  // New completed jobs → refresh versions.
  const doneKey = jobsState.jobs.filter(j => j.status === 'completed').map(j => j.id).join(',');
  useEffect(() => { if (doneKey) versions.refresh(); }, [doneKey]);

  const labels = useMemo(() => versionLabels(versions.versions), [versions.versions]);
  const selected = versions.versions.find(v => v.id === selectedId) ?? null;
  const editing = versions.versions.find(v => v.id === (baseId ?? selectedId)) ?? null;
  const missing = data.tools.filter(t => !data.counts[t.ref]).length;
  const steps = STEPS.map(s => ({ ...s, badge: s.id === 'tools' && missing ? missing : null }));
  const current = STEPS.find(s => s.id === step);

  // Photos, links and mounts are edited inside steps, so every step change reloads the shared data (otherwise Arrange/Generate miss new mounts).
  const go = id => { setView('steps'); setStep(id); data.refresh(); if (id === 'review') setReviewMode('review'); };
  const openResult = job => { if (job?.resultVersionId) setSelectedId(job.resultVersionId); versions.refresh(); setReviewMode('review'); go('review'); };

  const admin = session?.isAdmin;
  let body;
  if (session?.status === 'loading') body = <p className="p-6 text-sm text-slate-600">Loading…</p>;
  else if (!signedIn) body = <Notice icon={Lock} title="Sign in to use the Studio" action={<a href={signInUrl()} className="touch-target inline-flex items-center px-4 rounded bg-red-700 text-white font-bold">Sign in</a>}>The AI Compartment Studio is for signed-in MBFD editors. The planner stays available without signing in.</Notice>;
  else if (!enabled) body = <Notice icon={AlertTriangle} title="The Studio is turned off">An admin has switched the AI Compartment Studio off for now. Everything else in the planner works as usual.</Notice>;
  else if (view === 'admin') body = <AdminPanel session={session} />;
  else {
    const stepBody = {
      photos: <div className="p-3 sm:p-4 space-y-4"><CapturePanel compId={compId} session={session} plannerDoc={plannerDoc} plannerRevision={plannerRevision} onAssetsCommitted={data.refresh} />
        <AssetLibrary compId={compId} session={session} plannerDoc={plannerDoc} plannerRevision={plannerRevision} /></div>,
      tools: <ToolsStep data={data} onLink={() => setLinkPicker(true)} />,
      mounts: <div className="p-3 sm:p-4"><MountsPanel compId={compId} session={session} plannerDoc={plannerDoc} plannerRevision={plannerRevision} /></div>,
      arrange: <ArrangeStep compId={compId} tools={data.tools} mounts={data.mounts} geometry={data.geometry} />,
      generate: <GenerateStep compId={compId} session={session} data={data} jobsState={jobsState} onOpenResult={openResult} onGotoStep={go} />,
      review: reviewMode === 'edit'
        ? <EditStep compId={compId} session={session} plannerDoc={plannerDoc} jobsState={jobsState} version={editing} versionLabel={editing ? labels.get(editing.id) : ''} onOpenResult={openResult} onPickVersion={() => setReviewMode('review')} />
        : <ReviewStep versions={versions.versions} jobs={jobsState.jobs} assets={data.assets} selectedId={selectedId} baseId={baseId} onSelect={setSelectedId}
          onEdit={v => { setSelectedId(v.id); setBaseId(v.id); setReviewMode('edit'); }} onUseAsBase={v => { setSelectedId(v.id); setBaseId(v.id); }}
          onPublish={v => { setSelectedId(v.id); go('publish'); }} onRefresh={versions.refresh} />,
      publish: <PublishStep compId={compId} version={selected} versionLabel={selected ? labels.get(selected.id) : ''} mainImage={mainImage} onMainImageChanged={onMainImageChanged}
        onRegenerate={() => go('generate')} onRefreshVersions={versions.refresh} />,
    }[step];
    body = (
      <>
        <StepBar steps={steps} current={step} onSelect={go} hint={reviewMode === 'edit' && step === 'review' ? 'Describe what to change, optionally draw on the image, then create a new version.' : current.hint} />
        <div data-testid={`studio-panel-${step}`}>{stepBody}</div>
        {reviewMode === 'edit' && step === 'review' && <div className="px-3 pb-3"><button type="button" onClick={() => setReviewMode('review')} className="touch-target px-3 rounded border border-slate-300 text-sm font-semibold">Back to versions</button></div>}
      </>
    );
  }

  const adminButton = admin && enabled ? (
    <button type="button" onClick={() => setView(v => (v === 'admin' ? 'steps' : 'admin'))} data-testid="studio-admin-entry" aria-pressed={view === 'admin'} aria-label={view === 'admin' ? 'Back to the Studio steps' : 'Admin settings'}
      className="touch-target px-2.5 rounded text-sm font-semibold flex items-center gap-1.5 text-slate-200 hover:bg-slate-700"><Settings size={16} /> <span className="hidden sm:inline">{view === 'admin' ? 'Back' : 'Admin'}</span></button>
  ) : null;

  return (
    <ToastProvider>
      <Dialog variant="sheet" title={`AI Compartment Studio — ${label}`} onClose={onClose} headerExtra={adminButton} closeLabel="Close Studio">
        {body}
      </Dialog>
      <Dialog open={linkPicker} title="Choose a photo to link" variant="sheet" zIndex="z-[55]" onClose={() => setLinkPicker(false)}>
        <AssetLibrary compId={compId} session={session} plannerDoc={plannerDoc} plannerRevision={plannerRevision} selectable onSelect={a => { setLinkPicker(false); setLinkAsset(a); }} />
      </Dialog>
      {linkAsset && <AssociationDialog compId={compId} asset={linkAsset} plannerDoc={plannerDoc} plannerRevision={plannerRevision} open onClose={() => setLinkAsset(null)} onSaved={() => { setLinkAsset(null); data.refresh(); }} />}
    </ToastProvider>
  );
}
