import React, { useState } from 'react';
import {
  AlertCircle, ChevronDown, Layers, ListPlus, Plus, Ruler, Settings, Sparkles, Trash2, X, CheckSquare, Square,
} from 'lucide-react';
import { SLOTS_PER_COMPARTMENT } from '../../shared/apparatus.js';
import ActionButtons from './ActionButtons.jsx';
import ComboSlot from './ComboSlot.jsx';
import CompartmentMedia from './CompartmentMedia.jsx';
import { BUNDLE_COLORS } from './usePlanActions.js';

/**
 * One compartment: image carousel, equipment slots (search dropdown), bulk add, bundles. Bundle/bulk UI state is local;
 * render with key={comp.id} so it resets when the compartment changes.
 * @param {object} props see App.jsx for the wiring
 */
export default function CompartmentPanel({ comp, allocations, bundles, plan, actions, readOnly, onExport, session, signIn, plannerRevision, mainImage, studioAvailable, onOpenStudio }) {
  const { getQty, getOptions, placedStats, effectiveDimensions } = plan;
  const [bundleMode, setBundleMode]         = useState(false);
  const [selectedSlots, setSelectedSlots]   = useState([]);
  const [bundleNamePrompt, setBundleNamePrompt] = useState(false);
  const [bundleNameInput, setBundleNameInput]   = useState('');
  const [bulkFillOpen, setBulkFillOpen]     = useState(false);
  const [bulkFillItem, setBulkFillItem]     = useState('');
  const [bulkFillQty, setBulkFillQty]       = useState(1);
  const [expandedBundles, setExpandedBundles] = useState({});

  const handleBulkFill = (compId) => {
    if (!bulkFillItem) return;
    const { filled, message } = actions.bulkFill(compId, bulkFillItem, bulkFillQty, allocations);
    if (message) alert(message);
    if (filled <= 0) return;
    setBulkFillOpen(false);
    setBulkFillItem('');
    setBulkFillQty(1);
  };

  const handleCreateBundle = (compId) => {
    const name = bundleNameInput.trim();
    if (!name) return;
    const validSlots = selectedSlots.filter(idx => !!(allocations[compId] ?? [])[idx]);
    if (validSlots.length === 0) return;
    actions.createBundle(compId, name, validSlots);
    setSelectedSlots([]);
    setBundleMode(false);
    setBundleNamePrompt(false);
    setBundleNameInput('');
  };

    const slots       = allocations[comp.id];
    const filled      = slots.filter(Boolean).length;
    const compBundles = bundles[comp.id] ?? [];
    const slotBundleMap = {};
    compBundles.forEach(b => b.slotIndices.forEach(si => { slotBundleMap[si] = b; }));

    return (
      <div className="flex-1 min-h-0 flex flex-col bg-white overflow-y-auto">
        {/* ── Header ── */}
        <div className="border-b border-slate-200 bg-slate-50 sticky top-0 z-10 print:static print:border-0">
          {/* Title row */}
          <div className="px-4 py-3 flex justify-between items-center gap-2">
            <div className="min-w-0">
              <h2 className="text-lg sm:text-xl font-bold text-slate-800">Compartment {comp.label ?? comp.id}</h2>
              <p className="text-xs sm:text-sm text-slate-500">{filled} of {slots.length} slots filled</p>
            </div>
            <div className="print:hidden shrink-0">
              <ActionButtons onExport={onExport} />
            </div>
          </div>

          {/* Feature toolbar — editors only */}
          {(!readOnly || studioAvailable) && (
          <div className="px-4 pb-3 flex flex-col sm:flex-row gap-2 print:hidden">
            {studioAvailable && (
              <button onClick={() => onOpenStudio()} data-touch-target="true"
                className="touch-target flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg font-bold text-sm bg-red-600 hover:bg-red-700 active:bg-red-800 text-white shadow-sm transition-colors touch-manipulation">
                <Sparkles size={16} aria-hidden="true" />
                AI Compartment Studio
              </button>
            )}
            {!readOnly && (<>
            <button
              onClick={() => { setBulkFillOpen(o => !o); setBundleMode(false); setSelectedSlots([]); }}
              data-touch-target="true"
              className={`touch-target flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg font-semibold text-sm transition-colors touch-manipulation ${
                bulkFillOpen
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'bg-blue-50 hover:bg-blue-100 active:bg-blue-200 text-blue-700 border border-blue-200'
              }`}>
              <ListPlus size={16} />
              Bulk Add to Compartment
            </button>
            <button
              onClick={() => { setBundleMode(o => !o); setSelectedSlots([]); setBulkFillOpen(false); setBundleNamePrompt(false); }}
              data-touch-target="true"
              className={`touch-target flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg font-semibold text-sm transition-colors touch-manipulation ${
                bundleMode
                  ? 'bg-purple-600 text-white shadow-sm'
                  : 'bg-purple-50 hover:bg-purple-100 active:bg-purple-200 text-purple-700 border border-purple-200'
              }`}>
              <Layers size={16} />
              Create Bundle
            </button>
            </>)}
          </div>
          )}

          {/* Bulk Add Panel */}
          {bulkFillOpen && !readOnly && (
            <div className="mx-4 mb-3 p-4 bg-blue-50 border-2 border-blue-300 rounded-xl print:hidden">
              <p className="text-sm font-bold text-blue-900 mb-3 flex items-center gap-2">
                <ListPlus size={15} /> Bulk Add Items to {comp.label ?? comp.id}
              </p>
              <div className="space-y-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-blue-800">Select Item</label>
                  <select
                    aria-label="Bulk add equipment"
                    value={bulkFillItem}
                    onChange={e => setBulkFillItem(e.target.value)}
                    className="min-h-11 w-full border-2 border-blue-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-blue-400 outline-none">
                    <option value="">— Choose an inventory item —</option>
                    {getOptions('').map(item => {
                      const rem = getQty(item.name) - (placedStats[item.name]?.total ?? 0);
                      return (
                        <option key={item.name} value={item.name}>
                          {item.name}  ·  {rem} unit{rem !== 1 ? 's' : ''} available
                        </option>
                      );
                    })}
                  </select>
                </div>
                <div className="flex flex-col sm:flex-row sm:items-end gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-blue-800">Quantity</label>
                    <input
                      type="number" min="1" aria-label="Bulk add quantity"
                      value={bulkFillQty}
                      onChange={e => setBulkFillQty(Math.max(1, parseInt(e.target.value, 10) || 1))}
                      className="min-h-11 w-24 border-2 border-blue-300 rounded-lg px-3 py-2 text-sm text-center bg-white focus:ring-2 focus:ring-blue-400 outline-none" />
                  </div>
                  <button
                    onClick={() => handleBulkFill(comp.id)}
                    disabled={!bulkFillItem}
                    data-touch-target="true"
                    className="touch-target w-full sm:flex-1 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:bg-slate-300 disabled:cursor-not-allowed text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors touch-manipulation">
                    Add {bulkFillQty} Slot{bulkFillQty !== 1 ? 's' : ''}
                  </button>
                  <button
                    onClick={() => { setBulkFillOpen(false); setBulkFillItem(''); setBulkFillQty(1); }}
                    data-touch-target="true"
                    className="touch-target text-slate-500 hover:text-slate-700 text-sm px-3 py-2 touch-manipulation">
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8">
          <div>
            <div className="lg:sticky lg:top-20 print:static">
              <CompartmentMedia
                comp={comp}
                session={session}
                signIn={signIn}
                plannerRevision={plannerRevision}
                mainImage={mainImage}
                studioAvailable={studioAvailable}
                onOpenStudio={onOpenStudio}
              />
            </div>
          </div>

          <div>
            {/* Bundle mode active bar */}
            {bundleMode && !readOnly && (
              <div className="mb-3 p-4 bg-purple-50 border-2 border-purple-300 rounded-xl print:hidden">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <p className="text-sm font-bold text-purple-900 flex items-center gap-2">
                    <Layers size={15} /> Bundle Mode
                    {selectedSlots.length > 0
                      ? <span className="bg-purple-600 text-white text-xs px-2 py-0.5 rounded-full">{selectedSlots.length} slot{selectedSlots.length !== 1 ? 's' : ''} selected</span>
                      : <span className="text-xs font-normal text-purple-600">— tap checkboxes on filled slots below</span>}
                  </p>
                  <button onClick={() => { setBundleMode(false); setSelectedSlots([]); setBundleNamePrompt(false); }}
                    className="text-purple-400 hover:text-purple-700 touch-manipulation">
                    <X size={16} />
                  </button>
                </div>
                {bundleNamePrompt ? (
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      autoFocus
                      placeholder="Bundle name (e.g. Highrise Pack, Extrication Kit…)"
                      value={bundleNameInput}
                      onChange={e => setBundleNameInput(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleCreateBundle(comp.id)}
                      className="flex-1 border-2 border-purple-300 rounded-lg px-3 py-2 text-sm bg-white focus:ring-2 focus:ring-purple-400 outline-none" />
                    <button
                      onClick={() => handleCreateBundle(comp.id)}
                      disabled={!bundleNameInput.trim() || selectedSlots.length === 0}
                      className="bg-purple-600 hover:bg-purple-700 active:bg-purple-800 disabled:bg-slate-300 disabled:cursor-not-allowed text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors touch-manipulation">
                      Save Bundle
                    </button>
                    <button onClick={() => { setBundleNamePrompt(false); setBundleNameInput(''); }}
                      className="text-slate-500 hover:text-slate-700 text-sm px-3 py-2 touch-manipulation">Back</button>
                  </div>
                ) : (
                  <button
                    onClick={() => setBundleNamePrompt(true)}
                    disabled={selectedSlots.length === 0}
                    className="w-full bg-purple-600 hover:bg-purple-700 active:bg-purple-800 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-white text-sm font-semibold py-2 rounded-lg flex items-center justify-center gap-2 transition-colors touch-manipulation">
                    <Layers size={15} />
                    {selectedSlots.length === 0 ? 'Select slots below to bundle them' : `Bundle ${selectedSlots.length} Selected Slot${selectedSlots.length !== 1 ? 's' : ''}`}
                  </button>
                )}
              </div>
            )}

            <div className="bg-white rounded-lg border border-slate-200 shadow-sm">
              <div className="bg-slate-800 text-white px-4 py-3 font-bold flex items-center gap-2 text-sm rounded-t-lg">
                <Settings size={15} /> Equipment — {comp.label ?? comp.id}
              </div>
              <div className="divide-y divide-slate-100 p-1.5">
                {slots.map((cur, idx) => {
                  const options   = getOptions(cur);
                  const bundle    = slotBundleMap[idx];
                  const bc        = bundle ? BUNDLE_COLORS[bundle.colorIdx ?? 0] : null;
                  const isSelected = selectedSlots.includes(idx);
                  return (
                    <React.Fragment key={idx}>
                      <div
                        className={`p-2 flex items-center gap-2 rounded transition-colors ${!bc ? 'hover:bg-slate-50' : ''}`}
                        style={bc ? { backgroundColor: bc.bg } : undefined}>
                        {/* Bundle-mode checkbox (only for filled slots) */}
                        {bundleMode && cur && (
                          <button
                            className="shrink-0 touch-manipulation"
                            aria-label={`${isSelected ? 'Remove' : 'Add'} slot ${idx + 1} ${isSelected ? 'from' : 'to'} bundle`}
                            onPointerDown={e => {
                              e.preventDefault();
                              setSelectedSlots(prev =>
                                prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx]
                              );
                            }}>
                            {isSelected
                              ? <CheckSquare size={16} className="text-purple-600" />
                              : <Square size={16} className="text-slate-300" />}
                          </button>
                        )}
                        <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center text-slate-700 font-bold text-[10px] border border-slate-200 shrink-0">
                          {idx + 1}
                        </div>
                        <ComboSlot
                          options={options}
                          value={cur}
                          onChange={val => actions.assign(comp.id, idx, val)}
                          readOnly={readOnly}
                          getQty={getQty}
                          placedStats={placedStats}
                          slotLabel={`Equipment for slot ${idx + 1}`}
                        />
                        {bundle && (
                          <span className="shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap"
                            style={{ backgroundColor: bc.border, color: '#fff' }}>
                            {bundle.name.length > 10 ? bundle.name.slice(0, 9) + '…' : bundle.name}
                          </span>
                        )}
                        {!readOnly && <button
                          onClick={() => actions.clearSlot(comp.id, idx)}
                          disabled={!cur}
                          data-touch-target="true" aria-label={`Clear slot ${idx + 1}`}
                          className={`touch-target p-1 rounded transition-colors shrink-0 ${
                            cur ? 'text-red-500 hover:bg-red-50' : 'text-slate-200 cursor-not-allowed'
                          }`}
                          title="Clear slot">
                          <Trash2 size={15} />
                        </button>}
                      </div>
                      {cur && effectiveDimensions[cur] && (
                        <div className="ml-9 -mt-1 mb-1 flex items-center gap-1 text-[10px] text-indigo-600 bg-indigo-50 border border-indigo-100 rounded px-2 py-0.5 w-fit">
                          <Ruler size={9} className="shrink-0" />
                          <span className="font-mono">{effectiveDimensions[cur]}</span>
                        </div>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
              {/* Add / Remove row controls */}
              {!readOnly && <div className="px-2 pb-2 pt-1 flex gap-2 print:hidden">
                <button
                  onClick={() => actions.addRow(comp.id)}
                  data-touch-target="true"
                  className="touch-target flex-1 flex items-center justify-center gap-1.5 text-xs text-slate-400 hover:text-green-700 hover:bg-green-50 border border-dashed border-slate-200 hover:border-green-300 rounded-lg py-2 transition-colors touch-manipulation">
                  <Plus size={12} /> Add Row
                </button>
                {slots.length > SLOTS_PER_COMPARTMENT && slots[slots.length - 1] === '' && (
                  <button
                    onClick={() => actions.removeLastEmptyRow(comp.id)}
                    data-touch-target="true"
                    className="touch-target flex items-center justify-center gap-1.5 text-xs text-slate-400 hover:text-red-600 hover:bg-red-50 border border-dashed border-slate-200 hover:border-red-300 rounded-lg px-3 py-2 transition-colors touch-manipulation">
                    <X size={12} /> Remove
                  </button>
                )}
              </div>}
            </div>

            {/* Existing bundles — collapsible */}
            {compBundles.length > 0 && (
              <div className="mt-3 bg-slate-50 border border-slate-200 rounded-lg overflow-hidden print:hidden">
                <div className="bg-slate-100 px-3 py-2 text-xs font-bold text-slate-600 flex items-center gap-1.5">
                  <Layers size={11} /> Bundles ({compBundles.length})
                </div>
                <div className="divide-y divide-slate-100">
                  {compBundles.map(b => {
                    const c = BUNDLE_COLORS[b.colorIdx ?? 0];
                    const isExpanded = expandedBundles[b.id] === true;
                    return (
                      <div key={b.id} style={{ backgroundColor: c.bg }}>
                        {/* Bundle header row */}
                        <div className="px-3 py-2 flex items-center justify-between gap-2">
                          <button
                            onClick={() => setExpandedBundles(prev => ({ ...prev, [b.id]: !prev[b.id] }))}
                            className="flex items-center gap-2 min-w-0 flex-1 text-left touch-manipulation">
                            <div className="w-3 h-3 rounded-full shrink-0 border-2"
                              style={{ backgroundColor: c.border, borderColor: c.border }} />
                            <span className="text-xs font-medium truncate" style={{ color: c.text }}>{b.name}</span>
                            <span className="text-[10px] text-slate-400 shrink-0">
                              ({b.slotIndices.length} item{b.slotIndices.length !== 1 ? 's' : ''})
                            </span>
                            <ChevronDown
                              size={12}
                              className="shrink-0 transition-transform duration-200"
                              style={{
                                color: c.text,
                                transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                              }}
                            />
                          </button>
                          {!readOnly && <button onClick={() => actions.deleteBundle(comp.id, b.id)}
                            className="shrink-0 text-slate-400 hover:text-red-500 p-1 rounded transition-colors touch-manipulation"
                            title="Remove bundle">
                            <X size={12} />
                          </button>}
                        </div>
                        {/* Expanded items list */}
                        {isExpanded && (
                          <div className="mx-2 mb-2 space-y-px rounded overflow-hidden border"
                            style={{ borderColor: c.border }}>
                            {b.slotIndices.map((si, i) => {
                              const item = (allocations[comp.id] ?? [])[si] || '(empty)';
                              return (
                                <div key={si}
                                  className={`flex items-center gap-2 px-2 py-1.5 text-xs ${i > 0 ? 'border-t' : ''}`}
                                  style={{ borderColor: c.border, backgroundColor: c.bg }}>
                                  <span className="font-mono text-[10px] shrink-0 w-5 text-right font-bold"
                                    style={{ color: c.border }}>
                                    {si + 1}
                                  </span>
                                  <span className="w-px h-3 shrink-0 opacity-40"
                                    style={{ backgroundColor: c.border }} />
                                  <span className="truncate flex-1" style={{ color: c.text }}>{item}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {filled > 0 && (
              <div className="mt-3 bg-slate-50 border border-slate-200 rounded-lg p-3">
                <p className="text-xs font-bold text-slate-600 mb-2">Items in this compartment:</p>
                <div className="space-y-1">
                  {Object.entries(
                    slots.filter(Boolean).reduce((acc, t) => { acc[t] = (acc[t] ?? 0) + 1; return acc; }, {})
                  ).map(([name, count]) => {
                    const qty            = getQty(name);
                    const totalPlacedFor = placedStats[name]?.total ?? 0;
                    return (
                      <div key={name} className="flex items-center justify-between text-xs">
                        <span className="text-slate-700 truncate flex-1 pr-2">{name}</span>
                        <span className="text-slate-500 shrink-0">
                          {count} here · {totalPlacedFor}/{qty} total placed
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="mt-3 bg-blue-50 border border-blue-200 rounded-lg p-3 flex gap-2 text-blue-800 text-xs print:hidden">
              <AlertCircle size={14} className="shrink-0 text-blue-500 mt-0.5" />
              <p>
                Dropdowns show remaining quantity in brackets. Use <strong>Bulk Fill</strong> to fill multiple slots at once.
                Use <strong>Bundles</strong> to visually group related equipment. Changes sync to all team members.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
}
