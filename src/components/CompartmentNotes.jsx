import { useEffect, useId, useRef, useState } from 'react';
import { StickyNote } from 'lucide-react';
import { NOTE_LIMITS } from '../../shared/contracts.js';

const draftKey = compId => `l1.noteDraft.${compId}`;
// eslint-disable-next-line no-control-regex
const STRIP = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

function readDraft(compId) {
  try {
    const d = JSON.parse(localStorage.getItem(draftKey(compId)) ?? 'null');
    if (d && typeof d.text === 'string') return { text: d.text, saved: d.saved === true };
  } catch { /* unavailable or corrupt: no draft */ }
  return null;
}
function writeDraft(compId, draft) {
  try { localStorage.setItem(draftKey(compId), JSON.stringify(draft)); } catch { /* storage unavailable */ }
}
function clearDraft(compId) {
  try { localStorage.removeItem(draftKey(compId)); } catch { /* storage unavailable */ }
}

const timeOf = ts => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const btn = 'touch-target min-h-11 px-4 rounded-lg text-sm font-semibold transition-colors touch-manipulation';

/**
 * Per-compartment note (plain text). Rendered for every compartment except NOTES_LOCKED_COMPARTMENTS (the caller
 * skips those). The draft lives in localStorage until the server copy equals what this device saved.
 * @param {{comp:{id:string,label?:string}, note?:{text:string,updatedAt:number}, serverNote?:{text:string,updatedAt:number},
 *   sync?:{status:string,pending:number,hasDoc:boolean}, readOnly:boolean, onSave:(text:string)=>void}} props
 */
export default function CompartmentNotes({ comp, note, serverNote, sync, readOnly, onSave }) {
  const id = useId();
  const label = comp.label ?? comp.id;
  const localText = note?.text ?? '';
  const serverText = serverNote?.text ?? '';
  const [initial] = useState(() => (readOnly ? null : readDraft(comp.id)));
  const [editing, setEditing] = useState(() => !!initial && !initial.saved);
  const [draft, setDraft] = useState(() => (initial && !initial.saved ? initial.text : ''));
  const [mine, setMine] = useState(() => (initial?.saved ? initial.text : null)); // text this device saved, until the server confirms
  const areaRef = useRef(null);
  const settled = !!sync && sync.pending === 0 && sync.status === 'saved' && sync.hasDoc;

  useEffect(() => {
    if (mine !== null && settled && serverText === mine) { clearDraft(comp.id); setMine(null); }
  }, [mine, settled, serverText, comp.id]);

  useEffect(() => { if (editing) areaRef.current?.focus(); }, [editing]);

  const conflict = !readOnly && !editing && mine !== null && settled && serverText !== mine;

  const startEdit = () => { setDraft(localText); writeDraft(comp.id, { text: localText, saved: false }); setEditing(true); };
  const cancel = () => { clearDraft(comp.id); setEditing(false); };
  const save = () => {
    const text = draft.replace(/\s+$/, '');
    setEditing(false);
    if (text === localText && text === serverText) { clearDraft(comp.id); return; }
    writeDraft(comp.id, { text, saved: true });
    setMine(text);
    onSave(text);
  };
  const onChange = e => {
    const text = e.target.value.replace(STRIP, '');
    setDraft(text);
    writeDraft(comp.id, { text, saved: false });
  };
  const onKeyDown = e => {
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  };

  if (readOnly && !localText) return null;

  let status = '';
  if (conflict) status = '';
  else if (localText) {
    status = settled && serverText === localText
      ? `Saved to the team plan · ${timeOf(serverNote.updatedAt)}`
      : 'Saved on this device — not synced yet';
  }

  return (
    <section aria-labelledby={`${id}-h`} className="mt-3 bg-white border border-slate-200 rounded-lg p-3 print:break-inside-avoid">
      <div className="flex items-center justify-between gap-2">
        <h3 id={`${id}-h`} className="text-xs font-bold text-slate-600 flex items-center gap-1.5"><StickyNote size={12} aria-hidden="true" /> Notes</h3>
        {!readOnly && !editing && !conflict && (
          <button type="button" onClick={startEdit} data-touch-target="true" aria-label={localText ? `Edit notes for ${label}` : `Add note for ${label}`}
            className={`${btn} border border-slate-300 text-slate-700 hover:bg-slate-50 print:hidden`}>
            {localText ? 'Edit' : 'Add note'}
          </button>
        )}
      </div>

      {editing ? (
        <div className="mt-2">
          <textarea ref={areaRef} id={`${id}-t`} aria-label={`Notes for ${label}`} aria-describedby={`${id}-hint`} value={draft}
            onChange={onChange} onKeyDown={onKeyDown} maxLength={NOTE_LIMITS.textMax} rows={4}
            className="w-full border-2 border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-800 focus:ring-2 focus:ring-blue-400 outline-none" />
          <div className="flex justify-between gap-2 text-xs text-slate-500 mt-1">
            <p id={`${id}-hint`}>Placement, access or handling details. Not a substitute for equipment lines.</p>
            <p aria-live="off" className="shrink-0 font-mono">{draft.length} / {NOTE_LIMITS.textMax}</p>
          </div>
          <div className="flex gap-2 mt-2">
            <button type="button" onClick={save} data-touch-target="true" className={`${btn} bg-slate-800 text-white hover:bg-slate-700`}>Save</button>
            <button type="button" onClick={cancel} data-touch-target="true" className={`${btn} border border-slate-300 text-slate-700 hover:bg-slate-50`}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          {localText && <p className="mt-2 text-sm text-slate-800 whitespace-pre-wrap break-words" data-testid="note-text">{localText}</p>}
          {!localText && !readOnly && !conflict && <p className="mt-2 text-xs text-slate-500">No note yet.</p>}
        </>
      )}

      {conflict && (
        <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="group" aria-label="Note conflict">
          <p className="font-semibold">Another device changed this note. Your version is kept below.</p>
          <p className="mt-2 text-xs font-bold">Team plan</p>
          <p className="whitespace-pre-wrap break-words text-slate-800" data-testid="note-server-text">{serverText || '(no note)'}</p>
          <p className="mt-2 text-xs font-bold">Your version</p>
          <p className="whitespace-pre-wrap break-words text-slate-800" data-testid="note-mine-text">{mine || '(no note)'}</p>
          <div className="flex gap-2 mt-2">
            <button type="button" data-touch-target="true" className={`${btn} bg-slate-800 text-white hover:bg-slate-700`}
              onClick={() => { writeDraft(comp.id, { text: mine, saved: true }); onSave(mine); }}>Use my version</button>
            <button type="button" data-touch-target="true" className={`${btn} border border-slate-300 text-slate-700 hover:bg-slate-50`}
              onClick={() => { clearDraft(comp.id); setMine(null); }}>Keep theirs</button>
          </div>
        </div>
      )}

      <p aria-live="polite" className="mt-2 text-xs text-slate-500 empty:hidden" data-testid="note-status">{status}</p>
    </section>
  );
}
