import { useState } from 'react';
import { Plus, X } from 'lucide-react';

// ─── Add Custom Tool Form ─────────────────────────────────────────────────────
/**
 * Form that adds a custom tool to the inventory.
 * @param {{effectiveInventory:{name:string}[], onAdd:(tool:{name:string, qty:number, dimensions:string})=>void}} props
 */
export default function AddToolForm({ effectiveInventory, onAdd }) {
  const [name, setName]   = useState('');
  const [qty, setQty]     = useState(1);
  const [dims, setDims]   = useState('');

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (effectiveInventory.some(i => i.name.toLowerCase() === trimmed.toLowerCase())) {
      alert(`"${trimmed}" already exists in the inventory.`);
      return;
    }
    onAdd({ name: trimmed, qty: Math.max(1, qty), dimensions: dims.trim() });
    setName('');
    setQty(1);
    setDims('');
  };

  return (
    <div className="mt-6 bg-slate-50 border border-dashed border-slate-300 rounded-lg p-4 print:hidden">
      <h3 className="text-sm font-bold text-slate-700 mb-3 flex items-center gap-2">
        <Plus size={14} className="text-red-600" /> Add Custom Tool to Inventory
      </h3>
      <div className="flex flex-col sm:flex-row flex-wrap gap-3">
        <input
          type="text"
          aria-label="Custom tool name"
          placeholder="Tool name *"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          className="min-h-11 flex-1 min-w-0 border border-slate-300 rounded px-3 py-2.5 text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none bg-white"
        />
        <input
          type="number"
          aria-label="Custom tool quantity"
          placeholder="Qty"
          min="1"
          value={qty}
          onChange={e => setQty(Math.max(1, parseInt(e.target.value, 10) || 1))}
          className="min-h-11 w-full sm:w-20 border border-slate-300 rounded px-3 py-2.5 text-sm text-center focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none bg-white"
        />
        <input
          type="text"
          aria-label="Custom tool dimensions"
          placeholder='Dimensions — optional (e.g. 42.5 × 5.9 × 8.3 in)'
          value={dims}
          onChange={e => setDims(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          className="min-h-11 flex-1 min-w-0 border border-slate-300 rounded px-3 py-2.5 text-sm focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none bg-white"
        />
        <button
          onClick={handleSubmit}
          disabled={!name.trim()}
          data-touch-target="true"
          className="touch-target w-full sm:w-auto bg-red-600 hover:bg-red-700 active:bg-red-800 disabled:bg-slate-300 disabled:cursor-not-allowed text-white px-4 py-2.5 rounded text-sm font-medium transition-colors flex items-center justify-center gap-1.5 touch-manipulation"
        >
          <Plus size={14} /> Add Tool
        </button>
      </div>
      <p className="text-xs text-slate-500 mt-2">
        Custom tools are tagged <span className="text-amber-600 font-bold">custom</span> in the table, appear in all compartment dropdowns immediately, and sync to all team members.
        Use the <X size={10} className="inline" /> button to remove a custom tool.
      </p>
    </div>
  );
}
