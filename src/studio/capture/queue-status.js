// Pure helpers that turn upload-queue items into human text (aria-live friendly) and progress numbers.

const VARIANT_LABEL = { original: 'full-size photo', display: 'screen copy', thumb: 'thumbnail' };

/** @param {number} n @returns {string} */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 KB';
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Overall 0–100 progress of one queue item (three variants weighted by size are overkill; equal thirds). */
export function itemPercent(item) {
  if (item.state === 'done') return 100;
  const variants = ['original', 'display', 'thumb'];
  const done = variants.filter(v => item.uploaded?.[v]).length;
  const partial = item.progress && item.progress.total ? item.progress.loaded / item.progress.total : 0;
  return Math.min(99, Math.round(((done + partial) / 3) * 100));
}

/**
 * One-line status for a queue item.
 * @param {{state:string, waiting?:string|null, progress?:{variant:string}|null, error?:string|null, attempts?:number, retryable?:boolean}} item
 * @returns {{text:string, tone:'info'|'ok'|'warn'|'error'}}
 */
export function describeItem(item) {
  switch (item.state) {
    case 'queued':
      if (item.waiting === 'offline') return { text: 'Waiting for a connection — kept on this device', tone: 'warn' };
      if (item.waiting === 'signed_out') return { text: 'Signed out — sign in to continue', tone: 'warn' };
      if (item.waiting === 'backoff') return { text: `Retrying soon (attempt ${(item.attempts ?? 0) + 1})${item.error ? ` — ${item.error}` : ''}`, tone: 'warn' };
      return { text: 'Waiting to upload', tone: 'info' };
    case 'creating': return { text: 'Starting upload…', tone: 'info' };
    case 'uploading': return { text: `Uploading ${VARIANT_LABEL[item.progress?.variant] ?? 'photo'}…`, tone: 'info' };
    case 'committing': return { text: 'Saving…', tone: 'info' };
    case 'done': return { text: 'Uploaded', tone: 'ok' };
    case 'cancelled': return { text: 'Cancelled', tone: 'warn' };
    case 'failed': return { text: `${item.error || 'Upload failed.'}${item.retryable ? ' Tap Retry to try again.' : ''}`, tone: 'error' };
    default: return { text: '', tone: 'info' };
  }
}

/** Summary sentence for the whole list, used in an aria-live region. */
export function summarizeQueue(items) {
  const c = s => items.filter(i => i.state === s).length;
  const active = items.filter(i => ['queued', 'creating', 'uploading', 'committing'].includes(i.state)).length;
  const parts = [];
  if (active) parts.push(`${active} uploading`);
  if (c('done')) parts.push(`${c('done')} uploaded`);
  if (c('failed')) parts.push(`${c('failed')} failed`);
  return parts.join(', ');
}
