import React, { useState, useMemo, useEffect, useId, useRef } from 'react';
import {
  Settings, LayoutGrid, CheckCircle, Trash2, ChevronRight, ChevronLeft, ChevronDown,
  AlertCircle, RotateCcw, Printer, Package, Image as ImageIcon,
  Download, Wifi, WifiOff, Ruler, Plus, X, Upload, Sparkles, Loader2,
  Star, Lock, Menu, Pencil, Save, Layers, CheckSquare, Square, ListPlus,
} from 'lucide-react';
import { calculateDropdownPosition } from './dropdown-position.js';

import {
  MASTER_INVENTORY, INVENTORY_BY_NAME, DIMENSIONS, VISUAL_DESCRIPTIONS, SLOTS_PER_COMPARTMENT,
  V3_RENAMES, CONSOLIDATION_RENAMES, COMPARTMENTS, OVERVIEWS, COMP_LABEL, COMPARTMENT_SPECS,
} from '../shared/apparatus.js';
const WORKER_URL = 'https://l1-state-sync.pdarleyjr.workers.dev';
const BUILD_VERSION = import.meta.env.VITE_BUILD_SHA || 'local';


const STORAGE_KEY = 'l1-compartment-builder-v4';


const BUNDLE_COLORS = [
  { bg: '#fef9c3', border: '#ca8a04', text: '#713f12' },
  { bg: '#dcfce7', border: '#16a34a', text: '#14532d' },
  { bg: '#dbeafe', border: '#2563eb', text: '#1e3a8a' },
  { bg: '#fce7f3', border: '#db2777', text: '#831843' },
  { bg: '#f3e8ff', border: '#9333ea', text: '#581c87' },
  { bg: '#ffedd5', border: '#ea580c', text: '#7c2d12' },
  { bg: '#cffafe', border: '#0891b2', text: '#164e63' },
  { bg: '#d1fae5', border: '#059669', text: '#064e3b' },
];
function nextBundleColor(existing) {
  const used = existing.map(b => b.colorIdx ?? 0);
  for (let i = 0; i < BUNDLE_COLORS.length; i++) {
    if (!used.includes(i)) return i;
  }
  return existing.length % BUNDLE_COLORS.length;
}


// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateUid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36);
}

function buildEmpty() {
  const s = {};
  COMPARTMENTS.forEach(c => { s[c.id] = Array(SLOTS_PER_COMPARTMENT).fill(''); });
  return s;
}

function migrateAllocations(allocs) {
  // Seed all current compartments with empty slots so newly-added compartments
  // (e.g. RR1) are never missing from allocations even when restoring old data.
  const out = {};
  COMPARTMENTS.forEach(c => { out[c.id] = Array(SLOTS_PER_COMPARTMENT).fill(''); });
  for (const [compId, slots] of Object.entries(allocs)) {
    if (out[compId] === undefined) continue; // ignore obsolete compartment ids
    out[compId] = slots.map(v => {
      const renamed = V3_RENAMES[v] ?? v;
      return CONSOLIDATION_RENAMES[renamed] ?? renamed;
    });
  }
  return out;
}

function loadSaved() {
  try {
    // v4 key — migrateAllocations seeds any compartments added after this data was written
    let raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved._ts !== undefined && saved.allocations && typeof saved.allocations === 'object') {
        return { ...saved, allocations: migrateAllocations(saved.allocations) };
      }
    }
    // v3 key — used em-dash item names; migrate those too
    raw = localStorage.getItem('l1-compartment-builder-v3');
    if (raw) {
      const saved3 = JSON.parse(raw);
      if (saved3._ts !== undefined && saved3.allocations && typeof saved3.allocations === 'object') {
        return {
          _ts: saved3._ts,
          allocations: migrateAllocations(saved3.allocations),
          customQtys: saved3.customQtys ?? {},
        };
      }
    }
    // v2 key — allocations stored as a flat object (no wrapper)
    raw = localStorage.getItem('l1-compartment-builder-v2');
    if (!raw) return null;
    const saved2 = JSON.parse(raw);
    if (!saved2 || typeof saved2 !== 'object') return null;
    return { _ts: 0, allocations: migrateAllocations(saved2), customQtys: {} };
  } catch { return null; }
}

// ─── CompartmentImage ─────────────────────────────────────────────────────────
function CompartmentImage({ src, alt }) {
  const [err, setErr] = useState(false);
  return (
    <div className="w-full bg-slate-100 rounded-lg border border-slate-300 flex items-center justify-center overflow-hidden min-h-[260px] print-image-container">
      {!err ? (
        <img src={src} alt={alt} loading="eager" fetchpriority="high" decoding="async"
          className="max-w-full max-h-[500px] object-contain p-2"
          onError={() => setErr(true)} />
      ) : (
        <div className="flex flex-col items-center text-slate-400 p-8 text-center">
          <ImageIcon size={48} className="mb-3 opacity-40" />
          <p className="font-semibold text-slate-600 text-sm">{alt}</p>
          <p className="text-xs mt-1 text-slate-500">Image not available</p>
        </div>
      )}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [activeTab, setActiveTab]     = useState('LeftOverview');
  const [allocations, setAllocations] = useState(() => loadSaved()?.allocations ?? buildEmpty());
  const [customQtys, setCustomQtys]   = useState(() => loadSaved()?.customQtys  ?? {});
  const [customTools, setCustomTools] = useState(() => loadSaved()?.customTools  ?? []);
  const [uploadedImages, setUploadedImages] = useState(() => {
    try {
      const raw = localStorage.getItem('l1-compartment-builder-uploads');
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      const migrated = {};
      for (const [compId, imgs] of Object.entries(parsed)) {
        migrated[compId] = imgs
          .filter(img => img.dataUrl && !img.dataUrl.includes('W29iamVjdCBPYmplY3Rd') && img.dataUrl.length > 100)
          .map(img => img.uid ? img : { ...img, uid: generateUid() });
      }
      return migrated;
    } catch { return {}; }
  });
  const [featuredImages, setFeaturedImages] = useState(() => {
    try {
      const raw = localStorage.getItem('l1-compartment-builder-featured');
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const [syncStatus, setSyncStatus]   = useState('connecting');
  const [storageError, setStorageError] = useState(false);
  const [pullDone, setPullDone]       = useState(false);
  const [stateSyncReady, setStateSyncReady] = useState(false);
  const [imageSyncReady, setImageSyncReady] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [removedItems, setRemovedItems] = useState(() => {
    try { return JSON.parse(localStorage.getItem('l1-compartment-builder-removed') || '[]'); }
    catch { return []; }
  });
  const [customDimensions, setCustomDimensions] = useState(() => {
    try { return JSON.parse(localStorage.getItem('l1-compartment-builder-cdims') || '{}'); }
    catch { return {}; }
  });
  const [editingItem, setEditingItem] = useState(null);
  const [editValues, setEditValues]   = useState({});
  const [bundles, setBundles]               = useState(() => loadSaved()?.bundles ?? {});
  const [bundleMode, setBundleMode]         = useState(false);
  const [selectedSlots, setSelectedSlots]   = useState([]);
  const [bundleNamePrompt, setBundleNamePrompt] = useState(false);
  const [bundleNameInput, setBundleNameInput]   = useState('');
  const [bulkFillOpen, setBulkFillOpen]     = useState(false);
  const [bulkFillItem, setBulkFillItem]     = useState('');
  const [bulkFillQty, setBulkFillQty]       = useState(1);
  const [expandedBundles, setExpandedBundles] = useState({});

  const isPullingRef  = useRef(false);
  const lastPushTs    = useRef(0);
  const imgLastPushTs = useRef(0);

  // ── Merged inventory: standard items + user-added custom tools ───────────
  const effectiveInventory = useMemo(() => [
    ...MASTER_INVENTORY.filter(i => !removedItems.includes(i.name)),
    ...customTools,
  ], [customTools, removedItems]);

  // ── Merged dimensions: static map + user overrides + custom tool dimensions
  const effectiveDimensions = useMemo(() => {
    const dims = { ...DIMENSIONS, ...customDimensions };
    customTools.forEach(t => { if (t.dimensions) dims[t.name] = t.dimensions; });
    return dims;
  }, [customTools, customDimensions]);

  // ── Helper: effective qty (custom override, then default, then custom tool)
  const getQty = (name) => {
    if (customQtys[name] !== undefined) return customQtys[name];
    if (INVENTORY_BY_NAME[name]) return INVENTORY_BY_NAME[name].qty;
    const ct = customTools.find(t => t.name === name);
    return ct ? ct.qty : 0;
  };

  // ── Auto-save to localStorage on every change ────────────────────────────
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        _ts: lastPushTs.current,
        allocations,
        customQtys,
        customTools,
        bundles,
      }));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [allocations, customQtys, customTools, bundles]);

  // ── Push to KV (300ms debounce, waits for initial pull to finish) ────────
  useEffect(() => {
    if (!pullDone || !stateSyncReady) return;
    if (isPullingRef.current) {
      isPullingRef.current = false;
      return;
    }
    setSyncStatus('syncing');
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`${WORKER_URL}/state`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ allocations, customQtys, customTools, bundles, removedItems, customDimensions }),
        });
        if (!res.ok) throw new Error(`State sync failed (${res.status})`);
        const data = await res.json();
        // Use the server-assigned timestamp to avoid clock-skew rejection
        lastPushTs.current = data._serverTs ?? Date.now();
        setSyncStatus('synced');
      } catch {
        setSyncStatus('offline');
      }
    }, 300);
    return () => clearTimeout(t);
  }, [pullDone, stateSyncReady, allocations, customQtys, customTools, bundles, removedItems, customDimensions]);

  // ── Pull from KV every 5s; initial pull on mount ─────────────────────────
  useEffect(() => {
    const pull = async (isInitial) => {
      const fetchJson = path => fetch(`${WORKER_URL}/${path}`).then(async response => {
        if (!response.ok) throw new Error(`${path} sync failed (${response.status})`);
        return response.json();
      });
      // Start both requests together, but unblock the UI as soon as the small
      // state document is hydrated. The much larger shared image document can
      // finish in the background without delaying the overview LCP.
      const stateRequest = fetchJson('state')
        .then(payload => ({ ok: true, payload }))
        .catch(() => ({ ok: false, payload: null }));
      const imageRequest = fetchJson('images')
        .then(payload => ({ ok: true, payload }))
        .catch(() => ({ ok: false, payload: null }));

      const stateResult = await stateRequest;
      if (stateResult.ok) {
          const payload = stateResult.payload;
          // Use _serverTs (set by worker) to compare; fall back to _ts for old records
          const remoteTs = payload?._serverTs ?? payload?._ts ?? 0;
          if (remoteTs && payload?.allocations && (isInitial || remoteTs > lastPushTs.current)) {
            isPullingRef.current = true;
            setAllocations(migrateAllocations(payload.allocations));
            if (payload.customQtys)      setCustomQtys(payload.customQtys);
            if (payload.customTools)     setCustomTools(payload.customTools);
            if (payload.bundles)         setBundles(payload.bundles);
            if (payload.removedItems)    setRemovedItems(payload.removedItems);
            if (payload.customDimensions) setCustomDimensions(payload.customDimensions);
            lastPushTs.current = remoteTs;
          }
          setStateSyncReady(true);
      }
      if (isInitial) setPullDone(true);

      const imageResult = await imageRequest;
      if (imageResult.ok) {
          const imgPayload = imageResult.payload;
          const remoteImgTs = imgPayload?._serverTs ?? 0;
          if (imgPayload && (isInitial || remoteImgTs > imgLastPushTs.current)) {
            imgLastPushTs.current = remoteImgTs;

            if (imgPayload.uploadedImages) {
              // Merge: keep every local image, add any remote images missing locally (dedup by uid)
              setUploadedImages(prev => {
                let changed = false;
                const merged = { ...prev };
                for (const [cid, remoteImgs] of Object.entries(imgPayload.uploadedImages)) {
                  const localImgs = prev[cid] ?? [];
                  const localUids = new Set(localImgs.map(u => u.uid).filter(Boolean));
                  const newImgs   = (remoteImgs ?? []).filter(u => u.uid && !localUids.has(u.uid));
                  if (newImgs.length > 0) {
                    merged[cid] = [...localImgs, ...newImgs];
                    changed = true;
                  }
                }
                return changed ? merged : prev;
              });
            }

            if (imgPayload.featuredImages) {
              // Remote wins for any compartment where local has no featured set
              // On initial pull, remote always wins (it's the canonical shared state)
              setFeaturedImages(prev => {
                let changed = false;
                const merged = { ...prev };
                for (const [cid, remoteFeatured] of Object.entries(imgPayload.featuredImages)) {
                  if (remoteFeatured && (!prev[cid] || isInitial)) {
                    merged[cid] = remoteFeatured;
                    changed = true;
                  }
                }
                return changed ? merged : prev;
              });
            }
            // Don't set isImgPullingRef — merged state should be pushed back to KV
          }
          setImageSyncReady(true);
      }
      setSyncStatus(stateResult.ok && imageResult.ok ? 'synced' : 'offline');
    };
    pull(true);
    const id = setInterval(() => pull(false), 5000);
    return () => clearInterval(id);
  }, []);

  // ── Derived: placed count per tool, per compartment breakdown ────────────
  const placedStats = useMemo(() => {
    const stats = {};
    effectiveInventory.forEach(item => { stats[item.name] = { total: 0, byComp: {} }; });
    COMPARTMENTS.forEach(comp => {
      allocations[comp.id].forEach(slot => {
        if (slot && stats[slot]) {
          stats[slot].total += 1;
          stats[slot].byComp[comp.id] = (stats[slot].byComp[comp.id] ?? 0) + 1;
        }
      });
    });
    return stats;
  }, [allocations, effectiveInventory]);

  const totalPlaced = useMemo(
    () => Object.values(placedStats).reduce((a, s) => a + s.total, 0),
    [placedStats]
  );

  const totalReq = useMemo(
    () => effectiveInventory.reduce((a, i) => a + getQty(i.name), 0),
    [customQtys, effectiveInventory]
  );

  // ── Options available for a dropdown slot ────────────────────────────────
  const getOptions = (currentValue) =>
    effectiveInventory.filter(item => {
      const placed = placedStats[item.name]?.total ?? 0;
      const qty = getQty(item.name);
      return qty > 0 && (placed < qty || item.name === currentValue);
    });

  // ── Persist uploaded images and featured selections to localStorage ─────────
  useEffect(() => {
    try {
      localStorage.setItem('l1-compartment-builder-uploads', JSON.stringify(uploadedImages));
    } catch {
      setStorageError(true);
    }
  }, [uploadedImages]);

  useEffect(() => {
    try {
      localStorage.setItem('l1-compartment-builder-featured', JSON.stringify(featuredImages));
    } catch {
      setStorageError(true);
    }
  }, [featuredImages]);

  // ── Push images to KV (1s debounce, waits for initial pull) ─────────────
  // No isPullingRef gate here — after a merge-pull we want to push the merged
  // state back so all other devices receive the full combined image set.
  useEffect(() => {
    if (!imageSyncReady) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`${WORKER_URL}/images`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadedImages, featuredImages }),
        });
        if (!res.ok) throw new Error(`Image sync failed (${res.status})`);
        const data = await res.json();
        imgLastPushTs.current = data._serverTs ?? Date.now();
      } catch {
        setSyncStatus('offline');
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [imageSyncReady, uploadedImages, featuredImages]);

  useEffect(() => {
    try {
      localStorage.setItem('l1-compartment-builder-removed', JSON.stringify(removedItems));
    } catch {
      setStorageError(true);
    }
  }, [removedItems]);

  useEffect(() => {
    try {
      localStorage.setItem('l1-compartment-builder-cdims', JSON.stringify(customDimensions));
    } catch {
      setStorageError(true);
    }
  }, [customDimensions]);

  useEffect(() => {
    setBundleMode(false);
    setSelectedSlots([]);
    setBulkFillOpen(false);
    setBulkFillItem('');
    setBulkFillQty(1);
    setBundleNamePrompt(false);
    setBundleNameInput('');
    setExpandedBundles({});
  }, [activeTab]);

  // ── Image upload handlers ─────────────────────────────────────────────────
  const handleUploadImage = (compId, { dataUrl, title, fileName }) => {
    setUploadedImages(prev => ({
      ...prev,
      [compId]: [...(prev[compId] ?? []), { dataUrl, title, fileName, uid: generateUid() }],
    }));
  };

  const handleDeleteUploadedImage = (compId, imgIdx) => {
    setUploadedImages(prev => {
      const current = prev[compId] ?? [];
      const deleted = current[imgIdx];
      if (deleted?.uid) {
        setFeaturedImages(fp => {
          const f = fp[compId];
          if (f?.kind === 'uploaded' && f?.uid === deleted.uid) {
            const next = { ...fp };
            delete next[compId];
            return next;
          }
          return fp;
        });
      }
      return { ...prev, [compId]: current.filter((_, i) => i !== imgIdx) };
    });
  };

  const handleSetFeatured = (compId, imageRef) => {
    setFeaturedImages(prev => {
      const current = prev[compId];
      const isSame = current?.kind === imageRef?.kind &&
        (imageRef.kind === 'preset' ? current?.src === imageRef?.src : current?.uid === imageRef?.uid);
      if (isSame) {
        const next = { ...prev };
        delete next[compId];
        return next;
      }
      return { ...prev, [compId]: imageRef };
    });
  };

  // ── AI image generation ───────────────────────────────────────────────────
  const handleGenerateAIImage = async (compId, userText) => {
    const slots = allocations[compId].filter(Boolean);
    const toolMap = {};
    slots.forEach(name => { toolMap[name] = (toolMap[name] ?? 0) + 1; });
    const toolsPayload = Object.entries(toolMap).map(([name, qty]) => ({
      name, qty,
      dims: effectiveDimensions[name] || '',
      visual: VISUAL_DESCRIPTIONS[name] || '',
    }));

    const res = await fetch(`${WORKER_URL}/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        compId,
        tools: toolsPayload,
        compartmentSpec: COMPARTMENT_SPECS[compId] || `Compartment ${compId}`,
        userText: userText || '',
      }),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Server error ${res.status}`);
    }
    const { dataUrl } = await res.json();
    if (!dataUrl) throw new Error('No image returned from server');
    handleUploadImage(compId, { dataUrl, title: 'AI Rendering', fileName: 'ai-rendering.png' });
  };

  // ── Custom tool CRUD ──────────────────────────────────────────────────────
  const handleAddTool = ({ name, qty, dimensions }) => {
    setCustomTools(prev => [...prev, { name, qty, dimensions }]);
  };

  // ── Inventory row actions ─────────────────────────────────────────────────
  const handleRemoveItem = (name) => {
    const isCustom = !INVENTORY_BY_NAME[name];
    if (!window.confirm(`Remove "${name}" from inventory? It will be cleared from all compartments.`)) return;
    if (isCustom) {
      setCustomTools(prev => prev.filter(t => t.name !== name));
    } else {
      setRemovedItems(prev => [...prev, name]);
    }
    setCustomQtys(prev => { const next = { ...prev }; delete next[name]; return next; });
    setAllocations(prev => {
      const next = {};
      for (const [compId, slots] of Object.entries(prev)) {
        next[compId] = slots.map(s => s === name ? '' : s);
      }
      return next;
    });
  };

  const startEdit = (item) => {
    setEditingItem(item.name);
    setEditValues({
      name: item.name,
      qty: String(getQty(item.name)),
      dims: effectiveDimensions[item.name] || '',
    });
  };

  const saveEdit = (item) => {
    const isCustom  = !INVENTORY_BY_NAME[item.name];
    const newQty    = Math.max(0, parseInt(editValues.qty, 10) || 0);
    const newDims   = (editValues.dims ?? '').trim();
    const newName   = ((editValues.name ?? '').trim() || item.name);
    const nameChanged = newName !== item.name;

    if (nameChanged && effectiveInventory.some(
      i => i.name.toLowerCase() === newName.toLowerCase() && i.name !== item.name
    )) {
      alert(`"${newName}" already exists in the inventory.`);
      return;
    }

    if (nameChanged) {
      setAllocations(prev => {
        const next = {};
        for (const [compId, slots] of Object.entries(prev)) {
          next[compId] = slots.map(s => s === item.name ? newName : s);
        }
        return next;
      });
      setCustomQtys(prev => {
        const next = { ...prev }; delete next[item.name];
        return { ...next, [newName]: newQty };
      });
      setCustomDimensions(prev => {
        const next = { ...prev }; delete next[item.name];
        return newDims ? { ...next, [newName]: newDims } : next;
      });
      if (isCustom) {
        setCustomTools(prev => prev.map(t =>
          t.name === item.name ? { ...t, name: newName, qty: newQty, dimensions: newDims } : t
        ));
      } else {
        // Promote standard item to custom with new name
        setRemovedItems(prev => [...prev, item.name]);
        setCustomTools(prev => [...prev, { name: newName, qty: newQty, dimensions: newDims }]);
      }
    } else {
      if (isCustom) {
        setCustomTools(prev => prev.map(t =>
          t.name === item.name ? { ...t, qty: newQty, dimensions: newDims } : t
        ));
      }
      setCustomQtys(prev => ({ ...prev, [item.name]: newQty }));
      if (newDims) {
        setCustomDimensions(prev => ({ ...prev, [item.name]: newDims }));
      } else {
        setCustomDimensions(prev => { const next = { ...prev }; delete next[item.name]; return next; });
      }
    }
    setEditingItem(null);
    setEditValues({});
  };

  // ── Mutations ─────────────────────────────────────────────────────────────
  const assign = (compId, idx, val) => {
    setAllocations(prev => {
      const next = { ...prev, [compId]: [...prev[compId]] };
      next[compId][idx] = val;
      return next;
    });
  };

  const clearSlot = (compId, idx) => {
    assign(compId, idx, '');
    setBundles(prev => {
      const cb = prev[compId] ?? [];
      const updated = cb
        .map(b => ({ ...b, slotIndices: b.slotIndices.filter(si => si !== idx) }))
        .filter(b => b.slotIndices.length > 0);
      return { ...prev, [compId]: updated };
    });
  };

  const handleBulkFill = (compId) => {
    if (!bulkFillItem) return;
    const available  = getQty(bulkFillItem) - (placedStats[bulkFillItem]?.total ?? 0);
    const emptySlots = (allocations[compId] ?? []).filter(s => !s).length;
    const canFill    = Math.min(available, emptySlots);
    const toFill     = Math.min(bulkFillQty, canFill);
    if (toFill <= 0) {
      if (available <= 0) {
        alert(`No remaining capacity for "${bulkFillItem}" — all ${getQty(bulkFillItem)} units are already placed.`);
      } else {
        alert(`No empty slots available in compartment ${compId}.`);
      }
      return;
    }
    setAllocations(prev => {
      const slots = [...prev[compId]];
      let filled = 0;
      for (let i = 0; i < slots.length && filled < toFill; i++) {
        if (!slots[i]) { slots[i] = bulkFillItem; filled++; }
      }
      return { ...prev, [compId]: slots };
    });
    if (toFill < bulkFillQty) {
      alert(`Filled ${toFill} slot${toFill !== 1 ? 's' : ''} (only ${canFill} slot${canFill !== 1 ? 's' : ''} available for "${bulkFillItem}").`);
    }
    setBulkFillOpen(false);
    setBulkFillItem('');
    setBulkFillQty(1);
  };

  const handleCreateBundle = (compId) => {
    const name = bundleNameInput.trim();
    if (!name) return;
    // Re-validate: only include slots that are still filled (KV pull may have cleared some)
    const validSlots = selectedSlots.filter(idx => !!(allocations[compId] ?? [])[idx]);
    if (validSlots.length === 0) return;
    const existing = bundles[compId] ?? [];
    const colorIdx = nextBundleColor(existing);
    setBundles(prev => ({
      ...prev,
      [compId]: [...(prev[compId] ?? []), { id: generateUid(), name, colorIdx, slotIndices: validSlots }],
    }));
    setSelectedSlots([]);
    setBundleMode(false);
    setBundleNamePrompt(false);
    setBundleNameInput('');
  };

  const handleDeleteBundle = (compId, bundleId) => {
    setBundles(prev => ({
      ...prev,
      [compId]: (prev[compId] ?? []).filter(b => b.id !== bundleId),
    }));
  };

  const addRow = (compId) => {
    setAllocations(prev => ({
      ...prev,
      [compId]: [...prev[compId], ''],
    }));
  };

  const removeLastEmptyRow = (compId) => {
    setAllocations(prev => {
      const slots = prev[compId];
      if (slots.length <= SLOTS_PER_COMPARTMENT) return prev;
      if (slots[slots.length - 1] !== '') return prev;
      return { ...prev, [compId]: slots.slice(0, -1) };
    });
  };

  const handleReset = () => {
    if (window.confirm('Clear ALL compartment assignments? This cannot be undone.')) {
      setAllocations(buildEmpty());
    }
  };

  // ── Excel Export ──────────────────────────────────────────────────────────
  const handleExportExcel = async () => {
    const { default: writeXlsxFile } = await import('write-excel-file/browser');

    // Sheet 1: Compartment Assignments
    const compHeaders = ['Slot', ...COMPARTMENTS.map(c => c.label ?? c.id)];
    const compRows = [];
    const maxSlots = Math.max(SLOTS_PER_COMPARTMENT, ...COMPARTMENTS.map(c => (allocations[c.id] ?? []).length));
    for (let i = 0; i < maxSlots; i++) {
      compRows.push([i + 1, ...COMPARTMENTS.map(c => (allocations[c.id] ?? [])[i] || '')]);
    }

    // Sheet 2: Inventory Status
    const invHeaders = ['Equipment Item', 'Total Qty', 'Placed', 'Remaining', 'Assigned To', 'Dimensions', 'Status'];
    const invRows = effectiveInventory.map(item => {
      const stats = placedStats[item.name];
      const qty = getQty(item.name);
      const placed = stats?.total ?? 0;
      const remaining = qty - placed;
      const assignedTo = Object.entries(stats?.byComp ?? {})
        .map(([comp, cnt]) => cnt > 1 ? `${COMP_LABEL[comp] ?? comp} x${cnt}` : (COMP_LABEL[comp] ?? comp))
        .join(', ');
      const status = placed > qty ? 'Over' : remaining === 0 ? 'Complete' : placed > 0 ? 'Partial' : 'Pending';
      return [item.name, qty, placed, remaining, assignedTo || '', effectiveDimensions[item.name] || '', status];
    });
    const toSheet = rows => rows.map((row, rowIndex) => row.map(value => ({
      value,
      type: typeof value === 'number' ? Number : String,
      fontWeight: rowIndex === 0 ? 'bold' : undefined,
    })));
    await writeXlsxFile([
      {
        data: toSheet([compHeaders, ...compRows]),
        sheet: 'Compartments',
        stickyRowsCount: 1,
      },
      {
        data: toSheet([invHeaders, ...invRows]),
        sheet: 'Inventory Status',
        stickyRowsCount: 1,
      },
    ]).toFile('L1_Compartment_Plan.xlsx');
  };

  // ── Shared action buttons ─────────────────────────────────────────────────
  const ActionButtons = () => (
    <div className="flex items-center gap-2 print:hidden shrink-0">
      <button onClick={handleExportExcel}
        data-touch-target="true" aria-label="Export Excel"
        className="touch-target flex items-center justify-center gap-1.5 bg-green-700 hover:bg-green-600 active:bg-green-800 text-white text-sm px-2.5 py-2 rounded transition-colors">
        <Download size={14} /> <span className="hidden sm:inline">Export Excel</span>
      </button>
      <button onClick={() => window.print()}
        data-touch-target="true" aria-label="Print PDF"
        className="touch-target flex items-center justify-center gap-1.5 bg-slate-800 hover:bg-slate-700 active:bg-slate-900 text-white text-sm px-2.5 py-2 rounded transition-colors">
        <Printer size={14} /> <span className="hidden sm:inline">Print PDF</span>
      </button>
    </div>
  );

  // ── Sidebar ───────────────────────────────────────────────────────────────
  const nav = (tab) => { setActiveTab(tab); setSidebarOpen(false); };

  const Sidebar = () => (
    <div id="sidebar" className="w-64 bg-slate-900 text-slate-300 flex flex-col h-full overflow-y-auto shrink-0 print:hidden">
      <div className="p-4 bg-slate-950 flex items-center gap-3 shrink-0">
        <div className="bg-red-600 p-2 rounded-md text-white shrink-0"><Settings size={20} /></div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-white text-sm leading-tight">L1 Mid-Mount</p>
          <p className="text-[11px] text-slate-400">Compartment Builder</p>
        </div>
        <button onClick={() => setSidebarOpen(false)}
          data-touch-target="true"
          className="touch-target lg:hidden text-slate-400 hover:text-white p-1.5 rounded transition-colors touch-manipulation"
          aria-label="Close menu">
          <X size={18} />
        </button>
      </div>

      <div className="p-3 flex-1 space-y-4 overflow-y-auto">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Overviews</p>
          <div className="space-y-0.5">
            {OVERVIEWS.map(ov => (
              <SideBtn key={ov.id} active={activeTab === ov.id} onClick={() => nav(ov.id)}>
                <LayoutGrid size={13} />{ov.label}
              </SideBtn>
            ))}
            <SideBtn active={activeTab === 'inventory'} onClick={() => nav('inventory')}>
              <Package size={13} />Inventory Status
            </SideBtn>
          </div>
        </div>

        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Cab</p>
          <div className="space-y-0.5">
            {COMPARTMENTS.filter(c => c.side === 'Cab').map(comp => (
              <CompBtn key={comp.id} comp={comp} active={activeTab === comp.id}
                count={allocations[comp.id].filter(Boolean).length}
                onClick={() => nav(comp.id)} />
            ))}
          </div>
        </div>

        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Left Side</p>
          <div className="space-y-0.5">
            {COMPARTMENTS.filter(c => c.side === 'Left').map(comp => (
              <CompBtn key={comp.id} comp={comp} active={activeTab === comp.id}
                count={allocations[comp.id].filter(Boolean).length}
                onClick={() => nav(comp.id)} />
            ))}
          </div>
        </div>

        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Right Side</p>
          <div className="space-y-0.5">
            {COMPARTMENTS.filter(c => c.side === 'Right').map(comp => (
              <CompBtn key={comp.id} comp={comp} active={activeTab === comp.id}
                count={allocations[comp.id].filter(Boolean).length}
                onClick={() => nav(comp.id)} />
            ))}
          </div>
        </div>

        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Rear</p>
          <div className="space-y-0.5">
            {COMPARTMENTS.filter(c => c.side === 'Rear').map(comp => (
              <CompBtn key={comp.id} comp={comp} active={activeTab === comp.id}
                count={allocations[comp.id].filter(Boolean).length}
                onClick={() => nav(comp.id)} />
            ))}
          </div>
        </div>
      </div>

      <div className="p-3 bg-slate-950 border-t border-slate-800 space-y-2">
        <div className="flex justify-between text-xs text-slate-400">
          <span>Total Placed:</span>
          <span className="font-bold text-white bg-slate-800 px-2 py-0.5 rounded">
            {totalPlaced} / {totalReq}
          </span>
        </div>
        <div className="w-full bg-slate-800 rounded-full h-1.5">
          <div
            className="bg-red-500 h-1.5 rounded-full transition-all"
            style={{ width: `${Math.min(100, (totalPlaced / Math.max(1, totalReq)) * 100)}%` }}
          />
        </div>

        <div aria-live="polite" className={`flex items-center gap-1.5 text-[10px] ${
          syncStatus === 'synced'     ? 'text-green-400'  :
          syncStatus === 'syncing'    ? 'text-yellow-400' :
          syncStatus === 'offline'    ? 'text-red-400'    : 'text-slate-500'
        }`}>
          {syncStatus === 'offline' ? <WifiOff size={10} /> : <Wifi size={10} />}
          {syncStatus === 'connecting' ? 'Connecting...' :
           syncStatus === 'syncing'    ? 'Syncing...'     :
           syncStatus === 'synced'     ? 'Synced with team' :
           'Offline — changes saved locally'}
        </div>
        {storageError && (
          <div role="alert" className="flex items-start gap-1.5 text-[10px] text-amber-300">
            <AlertCircle size={11} className="mt-0.5 shrink-0" />
            Device storage is full. Export a backup and remove uploaded images.
          </div>
        )}
        <p className="text-[9px] text-slate-400">Build {BUILD_VERSION.slice(0, 12)}</p>

        <button onClick={handleReset} data-touch-target="true"
          className="touch-target w-full flex items-center justify-center gap-1.5 bg-slate-700 hover:bg-red-700 text-white text-xs py-1.5 rounded transition-colors">
          <RotateCcw size={12} /> Reset All
        </button>
      </div>
    </div>
  );

  // ── Inventory Status panel (editable quantities) ──────────────────────────
  const renderInventory = () => {
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
          <ActionButtons />
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
                  <th className="px-2 py-3 font-semibold text-center w-20 print:hidden">Actions</th>
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
                  const isCustom   = !INVENTORY_BY_NAME[item.name];
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
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-400 mt-3 text-center print:hidden">
            Tap <Pencil size={10} className="inline mb-0.5" /> to edit a row (name, qty, dimensions) · Tap <Trash2 size={10} className="inline mb-0.5" /> to remove an item — changes sync instantly.
          </p>
          <AddToolForm effectiveInventory={effectiveInventory} onAdd={handleAddTool} />
        </div>
      </div>
    );
  };

  // ── Overview panel ────────────────────────────────────────────────────────
  const renderOverview = (ov) => {
    const sideComps = COMPARTMENTS.filter(c => c.side === ov.side);
    return (
      <div className="flex-1 min-h-0 flex flex-col bg-white overflow-y-auto">
        <div className="px-4 py-3 sm:p-5 border-b border-slate-200 bg-slate-50 sticky top-0 z-10 flex justify-between items-center gap-2 print:static print:border-0">
          <h2 className="text-lg sm:text-xl font-bold text-slate-800">{ov.label}</h2>
          <ActionButtons />
        </div>
        <div className="p-4 sm:p-6 space-y-5">
          <CompartmentImage src={ov.image} alt={ov.label} />
          <div>
            <h3 className="text-base font-bold text-slate-800 mb-3 border-b pb-2">Compartment Summary</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4">
              {sideComps.map(comp => {
                const tools = allocations[comp.id].filter(Boolean);
                return (
                  <div key={comp.id} className="bg-slate-50 rounded-lg border border-slate-200 overflow-hidden">
                    <div className="bg-slate-200 px-4 py-2 font-bold text-slate-700 flex justify-between items-center text-sm">
                      {comp.label ?? comp.id}
                      <span className="text-xs bg-white px-2 py-0.5 rounded-full text-slate-600">{tools.length} items</span>
                    </div>
                    <div className="p-3">
                      {tools.length === 0
                        ? <p className="text-xs text-slate-600 italic">No tools assigned.</p>
                        : (
                          <ul className="space-y-1.5">
                            {tools.map((t, i) => (
                              <li key={i} className="text-xs flex items-start gap-1.5 text-slate-700">
                                <CheckCircle size={12} className="text-green-500 mt-0.5 shrink-0" />{t}
                              </li>
                            ))}
                          </ul>
                        )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ── Compartment panel ─────────────────────────────────────────────────────
  const renderCompartment = (comp) => {
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
              <ActionButtons />
            </div>
          </div>

          {/* Feature toolbar — always visible */}
          <div className="px-4 pb-3 flex flex-col sm:flex-row gap-2 print:hidden">
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
          </div>

          {/* Bulk Add Panel */}
          {bulkFillOpen && (
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
              <ImageCarousel
                presetImages={comp.images}
                uploaded={uploadedImages[comp.id] ?? []}
                compId={comp.id}
                onUpload={handleUploadImage}
                onDelete={handleDeleteUploadedImage}
                featuredImage={featuredImages[comp.id] ?? null}
                onSetFeatured={(imageRef) => handleSetFeatured(comp.id, imageRef)}
                onGenerateAI={(text) => handleGenerateAIImage(comp.id, text)}
              />
            </div>
          </div>

          <div>
            {/* Bundle mode active bar */}
            {bundleMode && (
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
                          onChange={val => assign(comp.id, idx, val)}
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
                        <button
                          onClick={() => clearSlot(comp.id, idx)}
                          disabled={!cur}
                          data-touch-target="true" aria-label={`Clear slot ${idx + 1}`}
                          className={`touch-target p-1 rounded transition-colors shrink-0 ${
                            cur ? 'text-red-500 hover:bg-red-50' : 'text-slate-200 cursor-not-allowed'
                          }`}
                          title="Clear slot">
                          <Trash2 size={15} />
                        </button>
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
              <div className="px-2 pb-2 pt-1 flex gap-2 print:hidden">
                <button
                  onClick={() => addRow(comp.id)}
                  data-touch-target="true"
                  className="touch-target flex-1 flex items-center justify-center gap-1.5 text-xs text-slate-400 hover:text-green-700 hover:bg-green-50 border border-dashed border-slate-200 hover:border-green-300 rounded-lg py-2 transition-colors touch-manipulation">
                  <Plus size={12} /> Add Row
                </button>
                {slots.length > SLOTS_PER_COMPARTMENT && slots[slots.length - 1] === '' && (
                  <button
                    onClick={() => removeLastEmptyRow(comp.id)}
                    data-touch-target="true"
                    className="touch-target flex items-center justify-center gap-1.5 text-xs text-slate-400 hover:text-red-600 hover:bg-red-50 border border-dashed border-slate-200 hover:border-red-300 rounded-lg px-3 py-2 transition-colors touch-manipulation">
                    <X size={12} /> Remove
                  </button>
                )}
              </div>
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
                          <button onClick={() => handleDeleteBundle(comp.id, b.id)}
                            className="shrink-0 text-slate-400 hover:text-red-500 p-1 rounded transition-colors touch-manipulation"
                            title="Remove bundle">
                            <X size={12} />
                          </button>
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
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const activeOv   = OVERVIEWS.find(o => o.id === activeTab);
  const activeComp = COMPARTMENTS.find(c => c.id === activeTab);

  return (
    <div
      className="flex h-[100dvh] min-h-screen w-full bg-slate-100 overflow-hidden"
      aria-busy={!pullDone}
    >
      {!pullDone && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/95 px-6 text-center text-white"
          role="status"
          aria-live="polite"
        >
          <div>
            <Settings size={34} className="mx-auto mb-4 animate-pulse text-red-500" aria-hidden="true" />
            <p className="text-lg font-bold">Loading L1 Compartment Builder</p>
            <p className="mt-2 text-sm text-slate-300">Retrieving the latest shared apparatus plan…</p>
          </div>
        </div>
      )}
      {/* Mobile backdrop overlay — only rendered when open so it never blocks touches */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar — fixed overlay on mobile, static on desktop.
          CRITICAL: pointer-events-none when closed so iOS touch events reach the main content. */}
      <div className={`
        fixed lg:static inset-y-0 left-0 z-50 flex-shrink-0
        transition-transform duration-300 ease-in-out
        lg:transform-none lg:translate-x-0 lg:pointer-events-auto
        ${sidebarOpen
          ? 'translate-x-0 pointer-events-auto'
          : '-translate-x-full pointer-events-none'}
      `}>
        <Sidebar />
      </div>

      <main className="flex-1 overflow-hidden flex flex-col min-w-0">
        {/* Mobile top bar */}
        <div className="lg:hidden flex items-center justify-between bg-slate-900 px-4 py-3 shrink-0 print:hidden shadow-md">
          <div className="flex items-center gap-2.5">
            <div className="bg-red-600 p-1.5 rounded-md text-white shrink-0"><Settings size={15} /></div>
            <div>
              <p className="font-bold text-white text-sm leading-tight">L1 Mid-Mount</p>
              <p className="text-[10px] text-slate-400">Compartment Builder</p>
            </div>
          </div>
          <button
            onClick={() => setSidebarOpen(true)}
            data-touch-target="true"
            className="touch-target text-white p-2 rounded-md hover:bg-slate-700 active:bg-slate-600 transition-colors touch-manipulation"
            aria-label="Open navigation menu">
            <Menu size={22} />
          </button>
        </div>

        {activeTab === 'inventory' && renderInventory()}
        {activeOv   && renderOverview(activeOv)}
        {activeComp && renderCompartment(activeComp)}
      </main>
    </div>
  );
}

// ─── Image Carousel ───────────────────────────────────────────────────────────
function ImageCarousel({ presetImages, uploaded, compId, onUpload, onDelete, featuredImage, onSetFeatured, onGenerateAI }) {
  const [idx, setIdx]             = useState(0);
  const [imgErr, setImgErr]       = useState(false);
  const [aiText, setAiText]       = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError]     = useState('');
  const prevUploadedLen = useRef(uploaded.length);
  const pendingNav      = useRef(false);

  const all = [
    ...presetImages,
    ...(uploaded ?? []).map((u, i) => ({ src: u.dataUrl, title: u.title || u.fileName, isUploaded: true, uploadIdx: i, uid: u.uid })),
  ];

  // Reset state when switching compartments; navigate to featured image if set
  useEffect(() => {
    setImgErr(false);
    setAiText('');
    setAiError('');
    prevUploadedLen.current = uploaded.length;
    pendingNav.current = false;
    if (featuredImage) {
      if (featuredImage.kind === 'preset') {
        const fi = presetImages.findIndex(p => p.src === featuredImage.src);
        setIdx(fi >= 0 ? fi : 0);
      } else if (featuredImage.kind === 'uploaded') {
        const fi = (uploaded ?? []).findIndex(u => u.uid === featuredImage.uid);
        setIdx(fi >= 0 ? presetImages.length + fi : 0);
      } else {
        setIdx(0);
      }
    } else {
      setIdx(0);
    }
  }, [compId]);

  // Navigate to newly added image (upload or AI generation)
  useEffect(() => {
    if (pendingNav.current && uploaded.length > prevUploadedLen.current) {
      pendingNav.current = false;
      setIdx(presetImages.length + uploaded.length - 1);
      setImgErr(false);
    }
    prevUploadedLen.current = uploaded.length;
  });

  const cur  = all[Math.min(idx, all.length - 1)];
  const isFeatured = featuredImage != null && (
    (featuredImage.kind === 'preset' && cur?.src === featuredImage.src) ||
    (featuredImage.kind === 'uploaded' && cur?.uid === featuredImage.uid)
  );
  const goTo = (i) => { setIdx(i); setImgErr(false); };
  const prev = () => goTo((idx - 1 + all.length) % all.length);
  const next = () => goTo((idx + 1) % all.length);

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setAiError('Choose a PNG, JPEG, or WebP image.');
      e.target.value = '';
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      setAiError('That image is larger than 12 MB. Choose a smaller file.');
      e.target.value = '';
      return;
    }
    setAiError('');
    const reader = new FileReader();
    reader.onload = async (ev) => {
      pendingNav.current = true;
      const compressed = await compressImage(ev.target.result);
      onUpload(compId, { dataUrl: compressed, title: file.name.replace(/\.[^/.]+$/, ''), fileName: file.name });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleGenerateAI = async () => {
    setAiLoading(true);
    setAiError('');
    pendingNav.current = true;
    try {
      await onGenerateAI(aiText);
      setAiText('');
    } catch (err) {
      pendingNav.current = false;
      setAiError(err.message || 'Generation failed. Please try again.');
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div className="w-full">
      <div className="w-full bg-slate-100 rounded-lg border border-slate-300 overflow-hidden print-image-container">
        <div className="relative flex items-center justify-center min-h-[260px]">
          {!imgErr && cur ? (
            <img src={cur.src} alt={cur.title || 'Compartment'} key={cur.src}
              loading="lazy" decoding="async"
              className="max-w-full max-h-[500px] object-contain p-2"
              onError={() => setImgErr(true)} />
          ) : (
            <div className="flex flex-col items-center text-slate-400 p-8 text-center">
              <ImageIcon size={48} className="mb-3 opacity-40" />
              <p className="text-xs text-slate-500">Image not available</p>
            </div>
          )}
          {all.length > 1 && (
            <>
              <button onClick={prev} aria-label="Previous image" data-touch-target="true"
                className="touch-target absolute left-2 top-1/2 -translate-y-1/2 bg-black/30 hover:bg-black/60 active:bg-black/80 text-white rounded-full p-2 transition-colors print:hidden touch-manipulation">
                <ChevronLeft size={18} />
              </button>
              <button onClick={next} aria-label="Next image" data-touch-target="true"
                className="touch-target absolute right-2 top-1/2 -translate-y-1/2 bg-black/30 hover:bg-black/60 active:bg-black/80 text-white rounded-full p-2 transition-colors print:hidden touch-manipulation">
                <ChevronRight size={18} />
              </button>
            </>
          )}
          {aiLoading && (
            <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center z-10 rounded-lg">
              <Loader2 size={36} className="text-white animate-spin mb-3" />
              <p className="text-white text-sm font-semibold">Generating AI rendering…</p>
              <p className="text-white/60 text-xs mt-1">This may take up to 60 seconds</p>
            </div>
          )}
        </div>

        {(all.length > 1 || cur?.title) && (
          <div className="py-2 px-3 flex items-center justify-between bg-white border-t border-slate-200 gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-xs font-medium text-slate-600 truncate">{cur?.title || ''}</span>
              {!cur?.isUploaded && (
                <span className="shrink-0 flex items-center gap-0.5 text-[9px] text-slate-600 border border-slate-300 rounded px-1 py-0.5 print:hidden">
                  <Lock size={8} /> locked
                </span>
              )}
              {isFeatured && (
                <span className="shrink-0 flex items-center gap-0.5 text-[9px] text-amber-600 bg-amber-50 border border-amber-200 rounded px-1 py-0.5">
                  <Star size={8} fill="currentColor" /> featured
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {all.length > 1 && (
                <div className="flex items-center">
                  {all.map((_, i) => (
                    <button key={i} onClick={() => goTo(i)}
                      aria-label={`Show image ${i + 1} of ${all.length}`}
                      data-touch-target="true"
                      className="touch-target w-11 h-11 flex items-center justify-center rounded-full touch-manipulation">
                      <span className={`block w-2.5 h-2.5 rounded-full transition-colors ${
                        i === idx ? 'bg-red-500' : 'bg-slate-300 group-hover:bg-slate-400'
                      }`} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              )}
              {onSetFeatured && cur && (
                <button
                  onClick={() => {
                    const imageRef = cur.isUploaded
                      ? { kind: 'uploaded', uid: cur.uid }
                      : { kind: 'preset', src: cur.src };
                    onSetFeatured(imageRef);
                  }}
                  aria-label={isFeatured ? 'Remove as featured image' : 'Set as featured image'}
                  data-touch-target="true"
                  title={isFeatured ? 'Remove as featured image' : 'Set as featured — loads first when opening this compartment'}
                  className={`touch-target p-1.5 rounded transition-colors print:hidden touch-manipulation ${isFeatured ? 'text-amber-400 hover:text-slate-300' : 'text-slate-300 hover:text-amber-400 active:text-amber-500'}`}
                >
                  <Star size={15} fill={isFeatured ? 'currentColor' : 'none'} />
                </button>
              )}
              {cur?.isUploaded && (
                <button onClick={() => { onDelete(compId, cur.uploadIdx); goTo(Math.max(0, idx - 1)); }}
                  aria-label="Remove this image" data-touch-target="true"
                  className="touch-target p-1.5 rounded text-slate-400 hover:text-red-500 active:text-red-600 transition-colors print:hidden touch-manipulation" title="Remove this image">
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="mt-2 print:hidden">
        <label className="min-h-11 inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-red-700 active:text-red-800 cursor-pointer transition-colors bg-slate-50 hover:bg-red-50 border border-slate-200 hover:border-red-300 rounded-lg px-3 py-2 touch-manipulation select-none">
          <Upload size={13} />
          <span className="font-medium">Upload rendering or photo</span>
          <input type="file" accept="image/*" className="hidden" onChange={handleFile} />
        </label>
      </div>

      {onGenerateAI && (
        <div className="mt-3 bg-gradient-to-br from-indigo-50 to-slate-50 border-2 border-indigo-200 rounded-xl p-4 shadow-sm print:hidden">
          <div className="flex items-center gap-3 mb-3">
            <div className="bg-indigo-600 text-white p-2 rounded-lg shrink-0">
              <Sparkles size={18} />
            </div>
            <div>
              <p className="text-sm font-bold text-indigo-900 leading-tight">Generate AI Rendering</p>
              <p className="text-[10px] text-indigo-400 mt-0.5">Powered by Cloudflare Workers AI · Llama + Flux</p>
            </div>
          </div>

          <p className="text-xs text-slate-600 mb-3 leading-relaxed">
            The AI generates a photorealistic rendering of <span className="font-semibold text-slate-800">this exact compartment</span> with
            your currently assigned tools and real dimensional specs. Use the field below to send
            additional instructions directly to the AI — tool placement, shelf configuration, mounting style, or any other details.
          </p>

          <label className="block text-xs font-semibold text-indigo-800 mb-1.5">
            Additional instructions for the AI <span className="font-normal text-indigo-400">(optional)</span>
          </label>
          <textarea
            aria-label="Additional AI rendering instructions"
            value={aiText}
            onChange={e => setAiText(e.target.value)}
            placeholder={`Describe specific details you want included in the rendering — e.g.\n• "Mount the Holmatro V-Struts vertically on the right wall"\n• "Show the chainsaw on a saw mount bracket, blade facing outward"\n• "Add a pull-out tray at the bottom with the hose rolled flat"\n• "Remove the fixed shelf and use the full open bay"\nLeave blank to use standard AI configuration.`}
            rows={5}
            disabled={aiLoading}
            className="w-full text-xs border-2 border-indigo-200 rounded-lg px-3 py-2.5 resize-none focus:ring-2 focus:ring-indigo-400 focus:border-indigo-500 outline-none bg-white text-slate-700 placeholder-slate-400 leading-relaxed disabled:opacity-60"
          />

          {aiError && (
            <div className="mt-2 flex items-start gap-1.5 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <AlertCircle size={13} className="shrink-0 mt-0.5" />
              <span>{aiError}</span>
            </div>
          )}

          <button
            onClick={handleGenerateAI}
            disabled={aiLoading}
            className="mt-3 w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 disabled:bg-slate-300 disabled:cursor-not-allowed text-white text-sm font-bold px-4 py-3 rounded-lg transition-colors shadow-sm tracking-wide"
          >
            {aiLoading
              ? <><Loader2 size={16} className="animate-spin" /> Generating — up to 60 seconds…</>
              : <><Sparkles size={16} /> Generate AI Rendering</>}
          </button>
        </div>
      )}
    </div>
  );
}

function compressImage(dataUrl, maxDimension = 1400, quality = 0.82) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, maxDimension / Math.max(width, height));
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// ─── Searchable Combo Slot ────────────────────────────────────────────────────
function ComboSlot({ options, value, onChange, getQty, placedStats, slotLabel }) {
  const [open, setOpen]       = useState(false);
  const [query, setQuery]     = useState('');
  const [hiIdx, setHiIdx]     = useState(-1);
  const [dropPos, setDropPos] = useState({ top: 0, left: 0, width: 0, listMaxHeight: 256 });
  const containerRef = useRef(null);
  const inputRef     = useRef(null);
  const triggerRef   = useRef(null);
  const listboxId    = useId();

  const filtered = query.trim()
    ? options.filter(item => item.name.toLowerCase().includes(query.toLowerCase()))
    : options;

  useEffect(() => {
    if (!open) return;
    const closeOnPointer = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false); setQuery(''); setHiIdx(-1);
      }
    };
    // Reposition (don't close) when the page scrolls or resizes — keeps the
    // fixed-position dropdown anchored to its trigger button. Closing on scroll
    // breaks on iOS/iPad because the on-screen keyboard popping up triggers a
    // window scroll event, which would dismiss the dropdown before the user
    // can tap an option.
    const reposition = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const viewport = window.visualViewport
        ? {
            width: window.visualViewport.width,
            height: window.visualViewport.height,
            offsetTop: window.visualViewport.offsetTop,
            offsetLeft: window.visualViewport.offsetLeft,
          }
        : undefined;
      setDropPos(calculateDropdownPosition(rect, viewport));
    };
    document.addEventListener('pointerdown', closeOnPointer);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('scroll', reposition);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointer);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      window.visualViewport?.removeEventListener('resize', reposition);
      window.visualViewport?.removeEventListener('scroll', reposition);
    };
  }, [open]);

  const openDropdown = () => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const viewport = window.visualViewport
        ? {
            width: window.visualViewport.width,
            height: window.visualViewport.height,
            offsetTop: window.visualViewport.offsetTop,
            offsetLeft: window.visualViewport.offsetLeft,
          }
        : undefined;
      setDropPos(calculateDropdownPosition(rect, viewport));
    }
    setOpen(true); setQuery(''); setHiIdx(-1);
    // Auto-focus search input on devices with a physical keyboard. Skip on
    // touch-only devices because focusing a text input pops the on-screen
    // keyboard, which is jarring when the user just wants to scroll the list.
    const isTouchOnly = typeof window !== 'undefined'
      && (window.matchMedia?.('(hover: none) and (pointer: coarse)').matches ?? false);
    if (!isTouchOnly) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  const select = (name) => {
    onChange(name);
    setOpen(false);
    setQuery('');
    setHiIdx(-1);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const handleKey = (e) => {
    if (e.key === 'ArrowDown')  { e.preventDefault(); setHiIdx(i => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHiIdx(i => Math.max(i - 1, -1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (hiIdx === -1 && query.trim() && filtered[0]) select(filtered[0].name);
      else if (hiIdx === -1) select('');
      else if (filtered[hiIdx]) select(filtered[hiIdx].name);
    }
    else if (e.key === 'Escape') { setOpen(false); setQuery(''); setHiIdx(-1); }
  };

  return (
    <div ref={containerRef} className="relative flex-1 min-w-0">
      <button
        ref={triggerRef}
        onClick={openDropdown}
        onKeyDown={e => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            openDropdown();
          }
        }}
        role="combobox"
        aria-label={slotLabel}
        aria-expanded={open}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        data-touch-target="true"
        className={`touch-target w-full px-2 py-2 border rounded-md text-xs text-left truncate focus:ring-2 focus:ring-red-500 focus:border-red-500 outline-none touch-manipulation ${
          value ? 'border-green-300 bg-green-50 text-slate-800 font-medium' : 'border-slate-300 bg-white text-slate-600'
        }`}
      >
        {value || '— Empty Slot —'}
      </button>

      {open && (
        <div
          className="fixed z-[9999] shadow-xl"
          style={{ top: dropPos.top, left: dropPos.left, width: dropPos.width }}>
          <input
            ref={inputRef}
            type="search"
            role="searchbox"
            aria-label="Search equipment"
            value={query}
            onChange={e => { setQuery(e.target.value); setHiIdx(-1); }}
            onKeyDown={handleKey}
            placeholder="Type to search tools…"
            className="min-h-11 w-full p-2 border-2 border-red-400 rounded-t-md text-xs outline-none bg-white"
          />
          <div id={listboxId} role="listbox" aria-label="Equipment choices"
            className="bg-white border border-t-0 border-slate-300 rounded-b-md overflow-y-auto overscroll-contain"
            style={{ maxHeight: dropPos.listMaxHeight }}>
            <button
              type="button" role="option" aria-selected={!value}
              onClick={() => select('')}
              data-touch-target="true"
              className={`touch-target w-full text-left px-3 py-2.5 text-xs transition-colors touch-manipulation ${
                hiIdx === -1 ? 'bg-red-50 text-red-700' : 'text-slate-400 hover:bg-slate-50 active:bg-slate-100'
              }`}
            >— Empty Slot —</button>
            {filtered.map((item, i) => {
              const placed    = placedStats[item.name]?.total ?? 0;
              const qty       = getQty(item.name);
              const remaining = qty - placed + (value === item.name ? 1 : 0);
              return (
                <button key={item.name}
                  type="button" role="option" aria-selected={value === item.name}
                  onClick={() => select(item.name)}
                  data-touch-target="true"
                  className={`touch-target w-full text-left px-3 py-2.5 text-xs flex items-center justify-between gap-2 transition-colors touch-manipulation ${
                    i === hiIdx ? 'bg-red-50 text-red-700' : 'hover:bg-slate-50 active:bg-slate-100 text-slate-700'
                  }`}
                >
                  <span className="truncate flex-1">{item.name}</span>
                  <span className={`shrink-0 font-mono text-[10px] ${remaining === 0 ? 'text-red-400' : 'text-slate-400'}`}>
                    [{remaining}/{qty}]
                  </span>
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div className="px-3 py-3 text-xs text-slate-400 text-center italic">No matching tools</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Add Custom Tool Form ─────────────────────────────────────────────────────
function AddToolForm({ effectiveInventory, onAdd }) {
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

// ─── Small shared components ──────────────────────────────────────────────────
function SideBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick} data-touch-target="true"
      className={`touch-target w-full text-left px-3 py-1.5 rounded flex items-center gap-2 text-xs transition-colors ${
        active ? 'bg-red-600 text-white font-medium' : 'hover:bg-slate-800 text-slate-300'
      }`}>
      {children}
    </button>
  );
}

function CompBtn({ comp, active, count, onClick }) {
  return (
    <button onClick={onClick} data-touch-target="true"
      className={`touch-target w-full text-left px-3 py-1.5 rounded flex items-center justify-between text-xs transition-colors ${
        active ? 'bg-slate-700 text-white font-medium' : 'hover:bg-slate-800 text-slate-300'
      }`}>
      <div className="flex items-center gap-1.5">
        <ChevronRight size={12} className={active ? 'text-red-400' : 'text-slate-500'} />
        {comp.label ?? comp.id}
      </div>
      {count > 0 && (
        <span className="bg-slate-600 text-white text-[9px] px-1.5 py-0.5 rounded-full">{count}</span>
      )}
    </button>
  );
}
