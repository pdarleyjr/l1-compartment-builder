import { AlertCircle, CheckCircle, Loader2, LogIn, Wifi, WifiOff } from 'lucide-react';

const COPY = {
  loading: ['Connecting…', 'text-slate-400', Wifi],
  saved: ['Saved', 'text-green-400', CheckCircle],
  saving: ['Saving…', 'text-yellow-400', Loader2],
  offline: ['Offline — changes queued', 'text-red-400', WifiOff],
  signin: ['Sign in to save', 'text-yellow-400', LogIn],
  problem: ['Sync problem (retrying)', 'text-red-400', AlertCircle],
};

/**
 * Truthful sync indicator (Saved · Saving… · Offline — changes queued · Sign in to save · Sync problem (retrying)).
 * When the status is "signin" and `onSignIn` is given, the pill is a real button that starts the MBFD sign-in
 * (it used to look like a button but did nothing).
 * @param {{status:'loading'|'saved'|'saving'|'offline'|'signin'|'problem', pending?:number, className?:string,
 *   onSignIn?:()=>void}} props
 */
export default function SyncStatusPill({ status, pending = 0, className = '', onSignIn }) {
  const [text, color, Icon] = COPY[status] ?? COPY.loading;
  const label = status === 'offline' && pending === 0 ? 'Offline — showing saved copy' : text;
  if (status === 'signin' && onSignIn) {
    return (
      <button type="button" onClick={onSignIn} data-testid="sync-status" data-touch-target="true"
        className={`touch-target inline-flex items-center gap-1.5 px-2 rounded-md text-xs font-semibold underline underline-offset-2 hover:bg-slate-800 active:bg-slate-700 touch-manipulation ${color} ${className}`}>
        <Icon size={13} aria-hidden="true" />
        <span>{label}</span>
      </button>
    );
  }
  return (
    <div data-testid="sync-status" aria-live="polite" className={`flex items-center gap-1.5 text-[11px] ${color} ${className}`}>
      <Icon size={11} className={status === 'saving' ? 'animate-spin' : ''} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
