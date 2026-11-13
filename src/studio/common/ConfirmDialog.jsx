import Dialog from './Dialog.jsx';

/**
 * @param {{open:boolean, title:string, message:any, confirmLabel?:string, cancelLabel?:string, danger?:boolean,
 *   onConfirm:()=>void, onCancel:()=>void, extraActions?:any, testId?:string}} props
 */
export default function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger, onConfirm, onCancel, extraActions, testId }) {
  return (
    <Dialog open={open} title={title} onClose={onCancel} zIndex="z-[60]"
      actions={<>
        <button type="button" onClick={onCancel} data-autofocus className="touch-target px-4 rounded border border-slate-300 text-slate-700 text-sm font-semibold hover:bg-slate-100">{cancelLabel}</button>
        {extraActions}
        <button type="button" onClick={onConfirm} data-testid={testId}
          className={`touch-target px-4 rounded text-white text-sm font-bold ${danger ? 'bg-red-700 hover:bg-red-800' : 'bg-slate-800 hover:bg-slate-900'}`}>{confirmLabel}</button>
      </>}>
      <div className="p-4 text-sm text-slate-700 space-y-2">{message}</div>
    </Dialog>
  );
}
