// Studio capture / library / mounts entry (part B1). Imported lazily by src/studio/StudioShell.jsx (part B2).
// Props contract:
//  CapturePanel      {compId, session, plannerDoc, onAssetsCommitted(assets[]), defaultCategory?}
//  AssetLibrary      {compId, session, plannerDoc, onSelect?(asset), selectable?:boolean, filterCategory?}
//  AssociationDialog {compId, asset, plannerDoc, open, onClose, onSaved(asset)}  (+ optional session)
//  MountsPanel       {compId, session, plannerDoc}
export { CapturePanel } from './CapturePanel.jsx';
export { AssetLibrary } from '../library/AssetLibrary.jsx';
export { AssociationDialog } from '../library/AssociationDialog.jsx';
export { MountsPanel } from '../mounts/MountsPanel.jsx';
