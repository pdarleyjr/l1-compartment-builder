// Validation/normalisation of the structured result of a `recognize` job.
import { HttpError } from '../http.js';

const isUnit = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;

/**
 * @param {unknown} raw
 * @returns {{objects:{label:string, quantity:number, region:{x:number,y:number,w:number,h:number}|null, candidates:{equipmentId:string|null, name:string, confidence:number}[]}[]}}
 */
export function parseRecognition(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.objects) || raw.objects.length > 50) {
    throw new HttpError('INVALID_REQUEST', 'result.objects must be a list of up to 50 recognized objects.');
  }
  const objects = raw.objects.map((o, i) => {
    if (!o || typeof o.label !== 'string' || !o.label.trim() || o.label.length > 200) throw new HttpError('INVALID_REQUEST', `Object ${i + 1}: label is required.`);
    const quantity = o.quantity === undefined ? 1 : o.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500) throw new HttpError('INVALID_REQUEST', `Object ${i + 1}: quantity must be 1-500.`);
    let region = null;
    if (o.region != null) {
      if (!['x', 'y', 'w', 'h'].every(k => isUnit(o.region[k]))) throw new HttpError('INVALID_REQUEST', `Object ${i + 1}: region must be normalized 0..1.`);
      region = { x: o.region.x, y: o.region.y, w: o.region.w, h: o.region.h };
    }
    const cands = o.candidates === undefined ? [] : o.candidates;
    if (!Array.isArray(cands) || cands.length > 5) throw new HttpError('INVALID_REQUEST', `Object ${i + 1}: candidates must be a list of up to 5.`);
    const candidates = cands.map(c => {
      if (!c || typeof c.name !== 'string' || !isUnit(c.confidence)) throw new HttpError('INVALID_REQUEST', `Object ${i + 1}: invalid candidate.`);
      return { equipmentId: typeof c.equipmentId === 'string' ? c.equipmentId : null, name: c.name.slice(0, 200), confidence: c.confidence };
    });
    return { label: o.label.trim(), quantity, region, candidates };
  });
  return { objects };
}
