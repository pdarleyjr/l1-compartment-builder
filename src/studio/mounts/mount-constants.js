import { MOUNT_CLASSIFICATIONS, MOUNT_STATUSES } from '../../../shared/contracts.js';

export const CLASSIFICATION_INFO = Object.freeze({
  mounting: { label: 'Mounting hardware', help: 'A bracket, tray, hook or holder that carries tools. Not counted as inventory.' },
  inventory: { label: 'Inventory item', help: 'The mount itself is equipment on the inventory list.' },
  reference: { label: 'Reference only', help: 'Shown to the image generator as an example. Not installed or counted.' },
});
export const STATUS_LABELS = Object.freeze({ existing: 'Existing', proposed: 'Proposed', optional: 'Optional', awaiting_verification: 'Awaiting verification' });
export const MOUNT_DISCLAIMER = 'Planning only — a rendering never verifies fit, load rating or crashworthiness.';
export const ORIENTATION_LABELS = Object.freeze({ vertical: 'Vertical', horizontal: 'Horizontal', angled: 'Angled' });

export { MOUNT_CLASSIFICATIONS, MOUNT_STATUSES };

/** @returns {object} blank form state */
export const emptyMount = () => ({ name: '', manufacturer: '', model: '', description: '', dimensions: '', orientation: '', zone: '', capacity: '', classification: 'mounting', status: 'proposed', assetId: null, equipmentIds: [] });

/** Mount (API shape, links as [{targetType,targetId}]) → form state. */
export function mountToForm(m) {
  const links = m.links ?? [];
  return {
    name: m.name ?? '', manufacturer: m.manufacturer ?? '', model: m.model ?? '', description: m.description ?? '', dimensions: m.dimensions ?? '',
    orientation: m.orientation ?? '', zone: m.zone ?? '', capacity: m.capacity == null ? '' : String(m.capacity),
    classification: m.classification ?? 'mounting', status: m.status ?? 'proposed',
    assetId: links.find(l => l.targetType === 'asset')?.targetId ?? m.assetId ?? null,
    equipmentIds: links.filter(l => l.targetType === 'equipment').map(l => l.targetId),
  };
}

/** Form state → request body for POST/PATCH (empty strings become null; capacity becomes an integer or null). */
export function formToPayload(f) {
  const n = v => (v.trim() ? v.trim() : null);
  const cap = parseInt(f.capacity, 10);
  return {
    name: n(f.name), manufacturer: n(f.manufacturer), model: n(f.model), description: n(f.description), dimensions: n(f.dimensions),
    orientation: f.orientation || null, zone: f.zone || null, capacity: Number.isFinite(cap) && cap >= 0 ? cap : null,
    classification: f.classification, status: f.status,
    links: [...(f.assetId ? [{ targetType: 'asset', targetId: f.assetId }] : []), ...f.equipmentIds.map(id => ({ targetType: 'equipment', targetId: id }))],
  };
}

/** @returns {string} first validation problem or '' */
export function validateMountForm(f) {
  if (!f.name.trim()) return 'Give the mount a name.';
  if (f.capacity !== '' && !(parseInt(f.capacity, 10) >= 0)) return 'Capacity must be a whole number, 0 or more.';
  return '';
}
