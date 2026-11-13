// Photo categories offered in the capture and library UI (labels over USER_ASSET_CATEGORIES in shared/contracts.js).
import { USER_ASSET_CATEGORIES } from '../../../shared/contracts.js';

export const CATEGORY_LABELS = Object.freeze({
  compartment: 'Compartment',
  tool: 'One tool',
  tool_group: 'Several tools',
  mount: 'Mount / bracket',
  arrangement: 'Installed arrangement',
  other: 'Other reference',
  rendering: 'AI rendering',
  markup: 'Markup',
  legacy_upload: 'Earlier upload',
});

export const CATEGORY_HINTS = Object.freeze({
  compartment: 'The compartment itself, empty or partly equipped.',
  tool: 'One piece of equipment. You will pick which tool next.',
  tool_group: 'Several tools in one photo. You will pick each tool next.',
  mount: 'Brackets, trays, hooks, holders or straps.',
  arrangement: 'Equipment as it is installed right now.',
  other: 'Manufacturer photo, catalog image, diagram or example.',
});

/** Options for category pickers: [{value,label,hint}] */
export const CATEGORY_OPTIONS = USER_ASSET_CATEGORIES.map(value => ({ value, label: CATEGORY_LABELS[value], hint: CATEGORY_HINTS[value] }));

export const PROVENANCE_LABELS = Object.freeze({
  user_photo: 'Photo',
  reference: 'Reference',
  ai_concept: 'AI concept',
  approved_concept: 'Approved concept',
  as_built_photo: 'As-built photo',
  legacy_upload: 'Earlier upload',
});

/** Categories whose photos should open the tool-association dialog once committed. */
export const ASSOCIATE_CATEGORIES = Object.freeze(['tool', 'tool_group']);

/** @param {string} category */
export const needsAssociation = category => ASSOCIATE_CATEGORIES.includes(category);
