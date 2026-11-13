// Studio capture / library / mounts entry (part B1). Imported lazily by src/studio/StudioShell.jsx (part B2).
// Props contract:
//  CapturePanel      {compId, session, plannerDoc, plannerRevision, onAssetsCommitted(assets[]), defaultCategory?}
//  AssetLibrary      {compId, session, plannerDoc, plannerRevision, onSelect?(asset), selectable?:boolean, filterCategory?}
//  AssociationDialog {compId, asset, plannerDoc, plannerRevision, open, onClose, onSaved(asset)}  (+ optional session)
//  MountsPanel       {compId, session, plannerDoc, plannerRevision}
export { CapturePanel } from './CapturePanel.jsx';
export { AssetLibrary } from '../library/AssetLibrary.jsx';
export { AssociationDialog } from '../library/AssociationDialog.jsx';
export { MountsPanel } from '../mounts/MountsPanel.jsx';
