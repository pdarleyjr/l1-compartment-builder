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
 * @param {{status:'loading'|'saved'|'saving'|'offline'|'signin'|'problem', pending?:number, className?:string, light?:boolean}} props
 */
export default function SyncStatusPill({ status, pending = 0, className = '' }) {
  const [text, color, Icon] = COPY[status] ?? COPY.loading;
  const label = status === 'offline' && pending === 0 ? 'Offline — showing saved copy' : text;
  return (
    <div data-testid="sync-status" aria-live="polite" className={`flex items-center gap-1.5 text-[11px] ${color} ${className}`}>
      <Icon size={11} className={status === 'saving' ? 'animate-spin' : ''} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
