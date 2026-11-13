import { Component } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';

/**
 * Catches render errors below it and shows a recovery panel instead of a white screen (FM-20).
 * `variant="panel"` is a compact in-flow panel (used around the lazy Studio); the default fills the screen.
 * @extends {Component<{children:any, variant?:'screen'|'panel', title?:string, onClose?:()=>void}, {error:Error|null}>}
 */
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) { return { error }; }

  componentDidCatch(error, info) {
    console.error('L1 Compartment Builder render error:', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { variant = 'screen', title = 'Something went wrong', onClose } = this.props;
    return (
      <div role="alert"
        className={variant === 'screen'
          ? 'min-h-[100dvh] flex items-center justify-center bg-slate-100 p-6'
          : 'p-6 flex items-center justify-center bg-white'}>
        <div className="max-w-md w-full bg-white border border-slate-300 rounded-xl shadow-sm p-6 text-center">
          <AlertCircle size={36} className="mx-auto mb-3 text-red-600" aria-hidden="true" />
          <h2 className="text-lg font-bold text-slate-800">{title}</h2>
          <p className="mt-2 text-sm text-slate-600">
            Your plan is safe: saved changes live on the server and unsent edits stay on this device. Reload to continue.
          </p>
          <p className="mt-2 text-xs text-slate-600 break-words font-mono">{String(error?.message ?? error).slice(0, 200)}</p>
          <div className="mt-4 flex flex-col sm:flex-row gap-2 justify-center">
            <button onClick={() => window.location.reload()} data-touch-target="true"
              className="touch-target inline-flex items-center justify-center gap-1.5 bg-red-600 hover:bg-red-700 active:bg-red-800 text-white text-sm font-bold px-4 py-2.5 rounded-lg touch-manipulation">
              <RotateCcw size={14} /> Reload
            </button>
            {onClose && (
              <button onClick={() => { this.setState({ error: null }); onClose(); }} data-touch-target="true"
                className="touch-target inline-flex items-center justify-center bg-slate-50 border border-slate-200 hover:bg-red-50 hover:border-red-300 text-slate-700 text-sm font-semibold px-4 py-2.5 rounded-lg touch-manipulation">
                Close
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
}
