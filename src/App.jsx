import { Suspense, lazy, useCallback, useState } from 'react';
import { AlertCircle, LogIn, Menu, Settings, X } from 'lucide-react';
import { COMPARTMENTS, OVERVIEWS } from '../shared/apparatus.js';
import { usePlannerSync } from './lib/planner-sync.js';
import { refreshGalleries, useMainImages } from './lib/gallery.js';
import { useSession } from './lib/session.js';
import CompartmentPanel from './components/CompartmentPanel.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import InventoryPanel from './components/InventoryPanel.jsx';
import OverviewPanel from './components/OverviewPanel.jsx';
import Sidebar, { NavDrawer } from './components/Sidebar.jsx';
import SyncStatusPill from './components/SyncStatusPill.jsx';
import MigrationAction from './components/MigrationAction.jsx';
import exportExcel from './components/exportExcel.js';
import usePlan from './components/usePlan.js';
import usePlanActions from './components/usePlanActions.js';

// The Studio is a separate chunk: the planner never depends on it at runtime (a failed rollout cannot break planning).
const StudioShell = lazy(() => import('./studio/StudioShell.jsx'));

function Banner({ tone = 'blue', children, action }) {
  const tones = { blue: 'bg-blue-50 border-blue-200 text-blue-900', amber: 'bg-amber-50 border-amber-200 text-amber-900' };
  return (
    <div className={`flex items-center justify-between gap-3 flex-wrap px-4 py-2 border-b text-sm print:hidden ${tones[tone]}`}>
      <span className="flex items-start gap-2 min-w-0"><AlertCircle size={15} className="shrink-0 mt-0.5" aria-hidden="true" />{children}</span>
      {action}
    </div>
  );
}

function StudioLayer({ studio, session, sync, mainImage, onClose, onMainImageChanged }) {
  return (
    <div className="fixed inset-0 z-[60] bg-white overflow-auto print:hidden">
      <ErrorBoundary variant="panel" title="The Studio could not be loaded" onClose={onClose}>
        <Suspense fallback={
          <div role="status" className="flex h-full items-center justify-center text-sm text-slate-600">Loading AI Compartment Studio…</div>
        }>
          <StudioShell
            compId={studio.compId}
            initialStep={studio.step}
            session={session}
            plannerDoc={sync.doc}
            plannerRevision={sync.revision}
            mainImage={mainImage}
            onClose={onClose}
            onMainImageChanged={onMainImageChanged}
          />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const { session, signIn } = useSession();
  const sync = usePlannerSync({ canEdit: session.canEdit, signedOut: session.status === 'signed_out' });
  const { mainImages } = useMainImages();
  const [activeTab, setActiveTab] = useState('LeftOverview');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [studio, setStudio] = useState(null); // { compId, step }

  const view = sync.view;
  const plan = usePlan(view);
  const actions = usePlanActions(sync, plan);
  const readOnly = sync.readOnly;
  const studioAvailable = session.canEdit && session.studioEnabled && sync.migrated !== false && !!sync.doc;

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const nav = tab => { setActiveTab(tab); setSidebarOpen(false); };
  const handleReset = () => {
    if (window.confirm('Clear ALL compartment assignments? This cannot be undone.')) actions.reset();
  };
  const handleExport = () => exportExcel(view.allocations, plan);
  const closeStudio = useCallback(() => { setStudio(null); refreshGalleries(); }, []);
  const counts = Object.fromEntries(COMPARTMENTS.map(c => [c.id, view.allocations[c.id].filter(Boolean).length]));

  const activeOv = OVERVIEWS.find(o => o.id === activeTab);
  const activeComp = COMPARTMENTS.find(c => c.id === activeTab);

  return (
    <div className="flex h-[100dvh] min-h-screen w-full bg-slate-100 overflow-hidden" aria-busy={!sync.ready}>
      {!sync.ready && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/95 px-6 text-center text-white" role="status" aria-live="polite">
          <div>
            <Settings size={34} className="mx-auto mb-4 animate-pulse text-red-500" aria-hidden="true" />
            <p className="text-lg font-bold">Loading L1 Compartment Builder</p>
            <p className="mt-2 text-sm text-slate-300">Retrieving the latest shared apparatus plan…</p>
          </div>
        </div>
      )}

      <NavDrawer open={sidebarOpen} onClose={closeSidebar}>
        <Sidebar
          activeTab={activeTab} onNav={nav} onClose={closeSidebar} counts={counts}
          totalPlaced={plan.totalPlaced} totalReq={plan.totalReq}
          sync={{ status: sync.status, pending: sync.pending }} session={session}
          canEdit={!readOnly} onReset={handleReset} onSignIn={signIn}
        />
      </NavDrawer>

      <main className="flex-1 overflow-hidden flex flex-col min-w-0">
        {/* Mobile top bar */}
        <div className="lg:hidden flex items-center justify-between gap-2 bg-slate-900 px-4 py-3 shrink-0 print:hidden shadow-md">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="bg-red-600 p-1.5 rounded-md text-white shrink-0"><Settings size={15} /></div>
            <div className="min-w-0">
              <p className="font-bold text-white text-sm leading-tight">L1 Mid-Mount</p>
              <p className="text-[10px] text-slate-400">Compartment Builder</p>
            </div>
          </div>
          <SyncStatusPill status={sync.status} pending={sync.pending} className="ml-auto" onSignIn={signIn} />
          <button onClick={() => setSidebarOpen(true)} data-touch-target="true"
            className="touch-target text-white p-2 rounded-md hover:bg-slate-700 active:bg-slate-600 transition-colors touch-manipulation"
            aria-label="Open navigation menu">
            <Menu size={22} />
          </button>
        </div>

        {sync.migrated === false && (
          <Banner tone="amber" action={<MigrationAction session={session} signIn={signIn} />}>
            <span>The shared plan is being moved to the new service. It is read-only until that finishes.</span>
          </Banner>
        )}
        {sync.migrated !== false && session.status === 'signed_out' && (
          <Banner action={
            <button onClick={signIn} data-touch-target="true"
              className="touch-target inline-flex items-center gap-1.5 bg-red-600 hover:bg-red-700 active:bg-red-800 text-white text-sm font-bold px-4 py-2 rounded-lg touch-manipulation">
              <LogIn size={14} aria-hidden="true" /> Sign in to edit
            </button>}>
            <span>You are viewing the shared plan. Sign in to make changes.</span>
          </Banner>
        )}
        {session.status === 'unavailable' && (
          <Banner tone="amber"><span>Sign-in is unavailable right now, so the plan is read-only.</span></Banner>
        )}
        {sync.authLost && session.status === 'signed_in' && (
          <Banner tone="amber" action={
            <button onClick={signIn} data-touch-target="true"
              className="touch-target bg-red-600 hover:bg-red-700 text-white text-sm font-bold px-4 py-2 rounded-lg touch-manipulation">Sign in to save</button>}>
            <span>Your sign-in expired. Your changes are kept on this device and will save after you sign in.</span>
          </Banner>
        )}
        {sync.storageError && (
          <div role="alert" className="flex items-start gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-sm text-amber-900 print:hidden">
            <AlertCircle size={15} className="shrink-0 mt-0.5" aria-hidden="true" />
            Device storage is full. Changes still save to the team plan while you are online, but may not survive a reload while offline.
          </div>
        )}
        {sync.notices.map(n => (
          <div key={n.id} role="status" className="flex items-start justify-between gap-3 px-4 py-2 bg-amber-50 border-b border-amber-200 text-sm text-amber-900 print:hidden">
            <span className="flex items-start gap-2"><AlertCircle size={15} className="shrink-0 mt-0.5" aria-hidden="true" />{n.message}</span>
            <button onClick={() => sync.dismissNotice(n.id)} aria-label="Dismiss notice" data-touch-target="true"
              className="touch-target shrink-0 p-1.5 rounded text-amber-900 hover:bg-amber-100 touch-manipulation"><X size={14} /></button>
          </div>
        ))}

        {activeTab === 'inventory' && (
          <InventoryPanel plan={plan} actions={actions} readOnly={readOnly} onExport={handleExport} />
        )}
        {activeOv && (
          <OverviewPanel ov={activeOv} allocations={view.allocations} mainImages={mainImages} onExport={handleExport} />
        )}
        {activeComp && (
          <CompartmentPanel
            key={activeComp.id}
            comp={activeComp} allocations={view.allocations} bundles={view.bundles}
            plan={plan} actions={actions} readOnly={readOnly} onExport={handleExport}
            session={session} signIn={signIn} plannerRevision={sync.revision}
            mainImage={mainImages[activeComp.id]}
            studioAvailable={studioAvailable}
            onOpenStudio={(step) => setStudio({ compId: activeComp.id, step })}
          />
        )}
      </main>

      {studio && studioAvailable && (
        <StudioLayer
          studio={studio} session={session} sync={sync} mainImage={mainImages[studio.compId] ?? null}
          onClose={closeStudio} onMainImageChanged={refreshGalleries}
        />
      )}
    </div>
  );
}
