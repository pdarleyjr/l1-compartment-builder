// Compartment data used by several Studio steps: tools (from the planner), photos/links, mounts, geometry (part B2).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { compartmentAssignments } from '../../../shared/planner.js';
import { compartmentGeometry } from '../../../shared/apparatus-render.js';
import { toolItems } from '../layout/layoutModel.js';

const arr = (v, k) => (Array.isArray(v) ? v : Array.isArray(v?.[k]) ? v[k] : []);

/** Safe wrapper: part C's functions may throw on odd input. */
function safe(fn, fallback) { try { return fn() ?? fallback; } catch { return fallback; } }

/**
 * Count confirmed/suggested (not rejected) linked photos per tool item.
 * @param {{links?:{targetType:string,targetId:string,equipmentId?:string|null,state?:string}[]}[]} assets
 * @param {{equipmentId?:string, assignmentId?:string, name:string}[]} rows compartmentAssignments rows
 * @returns {Record<string, number>} keyed by tool ref (equipmentId || name)
 */
export function photoCounts(assets, rows) {
  const refByAssignment = new Map(), refByEquipment = new Map();
  for (const r of rows ?? []) {
    const ref = r.equipmentId || r.name;
    if (r.assignmentId) refByAssignment.set(r.assignmentId, ref);
    if (r.equipmentId) refByEquipment.set(r.equipmentId, ref);
  }
  const seen = new Map();
  for (const a of assets ?? []) {
    if (a?.status === 'deleted') continue;
    for (const l of a.links ?? []) {
      if (l.state === 'rejected') continue;
      const ref = (l.targetType === 'assignment' && refByAssignment.get(l.targetId))
        || (l.equipmentId && refByEquipment.get(l.equipmentId)) || (l.targetType === 'equipment' && refByEquipment.get(l.targetId));
      if (!ref) continue;
      if (!seen.has(ref)) seen.set(ref, new Set());
      seen.get(ref).add(a.id);
    }
  }
  return Object.fromEntries([...seen].map(([k, v]) => [k, v.size]));
}

/** Loads photos + mounts for a compartment and derives tools/geometry from the planner doc. */
export function useCompartmentData(compId, plannerDoc) {
  const [assets, setAssets] = useState([]);
  const [mounts, setMounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const refresh = useCallback(async () => {
    try {
      const [a, m] = await Promise.all([
        api(`/compartments/${encodeURIComponent(compId)}/assets`),
        api(`/compartments/${encodeURIComponent(compId)}/mounts`),
      ]);
      setAssets(arr(a, 'assets')); setMounts(arr(m, 'mounts')); setError(null);
    } catch (e) { setError(e); } finally { setLoading(false); }
  }, [compId]);
  useEffect(() => { setLoading(true); refresh(); }, [refresh]);
  const rows = useMemo(() => safe(() => compartmentAssignments(plannerDoc, compId), []), [plannerDoc, compId]);
  const tools = useMemo(() => toolItems(rows), [rows]);
  const counts = useMemo(() => photoCounts(assets, rows), [assets, rows]);
  const geometry = useMemo(() => safe(() => compartmentGeometry(compId, {}), null), [compId]);
  return { assets, mounts, rows, tools, counts, geometry, loading, error, refresh };
}
