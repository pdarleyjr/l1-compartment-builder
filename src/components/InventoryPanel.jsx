import React, { useState } from 'react';
import { AlertCircle, CheckCircle, Pencil, Ruler, Save, Trash2, X } from 'lucide-react';
import { COMP_LABEL } from '../../shared/apparatus.js';
import ActionButtons from './ActionButtons.jsx';
import AddToolForm from './AddToolForm.jsx';

/**
 * Inventory Status panel: editable quantities, dimensions, names and custom tools.
 * @param {{plan:ReturnType<import('./usePlan.js').default>, actions:ReturnType<import('./usePlanActions.js').default>,
 *   readOnly:boolean, onExport:()=>void}} props
 */
export default function InventoryPanel({ plan, actions, readOnly, onExport }) {
  const { effectiveInventory, effectiveDimensions, getQty, placedStats, totalPlaced, totalReq, isCustom: isCustomName } = plan;
  const [editingItem, setEditingItem] = useState(null);
  const [editValues, setEditValues]   = useState({});
  const handleRemoveItem = actions.removeItem;

  const startEdit = (item) => {
    setEditingItem(item.name);
    setEditValues({ name: item.name, qty: String(getQty(item.name)), dims: effectiveDimensions[item.name] || '' });
  };
  const saveEdit = (item) => {
    if (actions.saveEdit(item, editValues)) { setEditingItem(null); setEditValues({}); }
  };

    const fullyAssigned = effectiveInventory.filter(i => {
      const qty = getQty(i.name);
      return qty > 0 && (placedStats[i.name]?.total ?? 0) >= qty;
    }).length;

    return (
      <div className="flex-1 min-h-0 flex flex-col bg-white overflow-y-auto">
        <div className="px-4 py-3 sm:p-5 border-b border-slate-200 bg-slate-50 sticky top-0 z-10 flex justify-between items-center gap-2 print:static print:border-0">
          <div className="min-w-0">
            <h2 className="text-lg sm:text-xl font-bold text-slate-800">Inventory Status</h2>
            <p className="text-xs sm:text-sm text-slate-500">
              {totalPlaced} of {totalReq} placed &mdash; {fullyAssigned}/{effectiveInventory.length} types done
            </p>
          </div>
          <ActionButtons onExport={onExport} />
        </div>

        <div className="px-4 sm:px-6 pt-4">
          <div className="w-full bg-slate-200 rounded-full h-2 mb-1">
            <div className="bg-red-500 h-2 rounded-full transition-all"
              style={{ width: `${Math.min(100, (totalPlaced / Math.max(1, totalReq)) * 100)}%` }} />
          </div>
          <p className="text-xs text-slate-500 text-right">
            {Math.round((totalPlaced / Math.max(1, totalReq)) * 100)}% placed
          </p>
        </div>

        <div className="p-4 sm:p-6">
          <div className="overflow-x-auto rounded-lg border border-slate-200 shadow-sm">
            <table className="w-full text-sm min-w-[600px]">
              <thead>
                <tr className="bg-slate-800 text-white text-xs">
                  <th className="text-left px-4 py-3 font-semibold">Equipment Item</th>
                  <th className="text-center px-3 py-3 font-semibold w-20">Qty</th>
                  <th className="text-center px-3 py-3 font-semibold w-16">Placed</th>
                  <th className="hidden md:table-cell text-center px-3 py-3 font-semibold w-20">Remaining</th>
                  <th className="hidden lg:table-cell text-left px-4 py-3 font-semibold">Assigned To</th>
                  <th className="hidden lg:table-cell text-left px-4 py-3 font-semibold">
                    <span className="flex items-center gap-1"><Ruler size={11} />Dimensions</span>
                  </th>
                  <th className="text-center px-3 py-3 font-semibold w-20">Status</th>
                  {!readOnly && <th className="px-2 py-3 font-semibold text-center w-20 print:hidden">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {effectiveInventory.map((item, idx) => {
                  const stats      = placedStats[item.name];
                  const qty        = getQty(item.name);
                  const placed     = stats?.total ?? 0;
                  const remaining  = qty - placed;
                  const overPlaced = placed > qty;
                  const full       = qty > 0 && remaining === 0;
                  const partial    = placed > 0 && !full && !overPlaced;
                  const isCustom   = isCustomName(item.name);
                  const isEditing  = editingItem === item.name;

                  const assignedTo = Object.entries(stats?.byComp ?? {})
                    .map(([comp, cnt]) => cnt > 1 ? `${COMP_LABEL[comp] ?? comp} ×${cnt}` : (COMP_LABEL[comp] ?? comp))
                    .join(', ');

                  const statusBadge = overPlaced ? (
                    <span className="inline-flex items-center gap-1 bg-red-100 text-red-700 text-[10px] font-bold px-2 py-0.5 rounded-full">
                      <AlertCircle size={10} /> Over
                    </span>
                  ) : full ? (
                    <span className="inline-flex items-center gap-1 bg-green-100 text-green-700 text-[10px] font-bold px-2 py-0.5 rounded-full">
                      <CheckCircle size={10} /> Done
                    </span>
                  ) : placed > 0 ? (
                    <span className="inline-block bg-blue-100 text-blue-700 text-[10px] font-bold px-2 py-0.5 rounded-full">Partial</span>
                  ) : (
                    <span className="inline-block bg-slate-100 text-slate-700 text-[10px] px-2 py-0.5 rounded-full">Pending</span>
                  );

                  if (isEditing) {
                    return (
                      <React.Fragment key={item.name}>
                      <tr className="bg-amber-50 border-l-4 border-amber-400">
                        <td className="px-4 py-2">
                          <div className="flex flex-col gap-0.5">
                            <input
                              autoFocus
                              aria-label={`Equipment name for ${item.name}`}
                              value={editValues.name ?? ''}
                              onChange={e => setEditValues(prev => ({ ...prev, name: e.target.value }))}
                              className="min-h-11 w-full border-2 border-amber-300 rounded px-2 py-1 text-xs focus:ring-2 focus:ring-amber-400 outline-none bg-white text-slate-800 font-medium"
                            />
                            {!isCustom && editValues.name && editValues.name !== item.name && (
                              <span className="text-[9px] text-amber-600">Renaming will convert to custom item</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <input
                            type="number" min="0" aria-label={`Required quantity for ${item.name}`}
                            value={editValues.qty ?? ''}
                            onChange={e => setEditValues(prev => ({ ...prev, qty: e.target.value }))}
                            className="min-h-11 w-14 text-center font-mono border-2 border-amber-300 rounded px-1 py-1 text-xs focus:ring-2 focus:ring-amber-400 outline-none bg-white"
                          />
                        </td>
                        <td className="px-3 py-2 text-center font-mono font-bold">
                          <span className={placed > 0 ? 'text-blue-700' : 'text-slate-600'}>{placed}</span>
                        </td>
                        <td className="hidden md:table-cell px-3 py-2 text-center font-mono font-bold">
                          <span className={overPlaced ? 'text-red-600' : remaining === 0 ? 'text-green-600' : remaining < qty ? 'text-amber-600' : 'text-slate-600'}>{remaining}</span>
                        </td>
                        <td className="hidden lg:table-cell px-4 py-2 text-xs text-slate-500">{assignedTo || <span className="text-slate-300 italic">—</span>}</td>
                        <td className="hidden lg:table-cell px-4 py-2">
                          <input
                            aria-label={`Dimensions for ${item.name}`}
                            value={editValues.dims ?? ''}
                            onChange={e => setEditValues(prev => ({ ...prev, dims: e.target.value }))}
                            placeholder="e.g. 36 × 8 × 2 in"
                            className="min-h-11 w-full border-2 border-amber-300 rounded px-2 py-1 text-xs focus:ring-2 focus:ring-amber-400 outline-none bg-white font-mono text-slate-700"
                          />
                        </td>
                        <td className="px-3 py-2 text-center">{statusBadge}</td>
                        <td className="px-2 py-2 print:hidden">
                          <div className="flex items-center justify-center gap-1">
                            <button onClick={() => saveEdit(item)}
                              aria-label={`Save changes for ${item.name}`} title="Save changes" data-touch-target="true"
                              className="touch-target p-1.5 rounded text-green-600 hover:bg-green-100 active:bg-green-200 transition-colors touch-manipulation">
                              <Save size={14} />
                            </button>
                            <button onClick={() => { setEditingItem(null); setEditValues({}); }}
                              aria-label={`Cancel editing ${item.name}`} title="Cancel" data-touch-target="true"
                              className="touch-target p-1.5 rounded text-slate-400 hover:bg-slate-100 active:bg-slate-200 transition-colors touch-manipulation">
                              <X size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                      <tr className="lg:hidden bg-amber-50 border-l-4 border-amber-400">
                        <td colSpan={8} className="px-4 pb-3">
                          <label className="block text-[10px] font-bold uppercase tracking-wide text-amber-800 mb-1">
                            Dimensions
                          </label>
                          <input
                            aria-label={`Dimensions for ${item.name}`}
                            value={editValues.dims ?? ''}
                            onChange={e => setEditValues(prev => ({ ...prev, dims: e.target.value }))}
                            placeholder="e.g. 36 × 8 × 2 in"
                            className="min-h-11 w-full border-2 border-amber-300 rounded px-2 py-1 text-xs focus:ring-2 focus:ring-amber-400 outline-none bg-white font-mono text-slate-700"
                          />
                        </td>
                      </tr>
                      </React.Fragment>
                    );
                  }

                  return (
                    <tr key={item.name}
                      className={`transition-colors ${
                        overPlaced  ? 'bg-red-50'
                        : full      ? 'bg-green-50'
                        : partial   ? 'bg-blue-50'
                        : idx % 2 === 0 ? 'bg-white' : 'bg-slate-50'
                      }`}>
                      <td className="px-4 py-2.5 font-medium text-slate-800 text-xs sm:text-sm">
                        <span>{item.name}</span>
                        {isCustom && (
                          <span className="ml-2 text-[9px] font-bold uppercase tracking-wide text-amber-600 bg-amber-50 border border-amber-200 rounded px-1 py-0.5">custom</span>
                        )}
                        {effectiveDimensions[item.name] && (
                          <span className="lg:hidden block mt-1 font-mono text-[10px] font-normal text-indigo-700">
                            {effectiveDimensions[item.name]}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <span className="font-mono font-bold text-slate-700">{qty}</span>
                      </td>
                      <td className="px-3 py-2.5 text-center font-mono font-bold">
                        <span className={placed > 0 ? 'text-blue-700' : 'text-slate-600'}>{placed}</span>
                      </td>
                      <td className="hidden md:table-cell px-3 py-2.5 text-center font-mono font-bold">
                        <span className={
                          overPlaced        ? 'text-red-600'
                          : remaining === 0 ? 'text-green-600'
                          : remaining < qty ? 'text-amber-600'
                          : 'text-slate-600'
                        }>{remaining}</span>
                      </td>
                      <td className="hidden lg:table-cell px-4 py-2.5 text-xs text-slate-600">
                        {assignedTo || <span className="text-slate-300 italic">—</span>}
                      </td>
                      <td className="hidden lg:table-cell px-4 py-2.5 text-xs">
                        {effectiveDimensions[item.name]
                          ? <span className="font-mono text-indigo-700">{effectiveDimensions[item.name]}</span>
                          : <span className="text-slate-300 italic">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-center">{statusBadge}</td>
                      {!readOnly && (
                      <td className="px-2 py-2.5 text-center print:hidden">
                        <div className="flex items-center justify-center gap-1">
                          <button onClick={() => startEdit(item)}
                            aria-label={`Edit ${item.name}`} title="Edit row" data-touch-target="true"
                            className="touch-target p-1.5 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 active:bg-blue-100 transition-colors touch-manipulation">
                            <Pencil size={13} />
                          </button>
                          <button onClick={() => handleRemoveItem(item.name)}
                            aria-label={`Remove ${item.name}`} title="Remove item" data-touch-target="true"
                            className="touch-target p-1.5 rounded text-slate-400 hover:text-red-600 hover:bg-red-50 active:bg-red-100 transition-colors touch-manipulation">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!readOnly && (
            <>
          <p className="text-xs text-slate-400 mt-3 text-center print:hidden">
            Tap <Pencil size={10} className="inline mb-0.5" /> to edit a row (name, qty, dimensions) · Tap <Trash2 size={10} className="inline mb-0.5" /> to remove an item — changes save to the shared plan.
          </p>
          <AddToolForm effectiveInventory={effectiveInventory} onAdd={actions.addTool} />
            </>
          )}
        </div>
      </div>
    );
}
