/* eslint-disable no-unused-vars -- P0 interface stub; remove when implemented */
// Owner: part C. Interface stub (P0). Structured geometry derived from shared/apparatus.js COMPARTMENT_SPECS + admin overrides.
/** @returns {{id, label, specText, dimensions:{widthIn?, heightIn?, depthIn?, doorWidthIn?, doorHeightIn?}, features:string[], zones:string[], orientation:'landscape'|'portrait'|'square', aspect:number}} */
export function compartmentGeometry(compId, overrides = {}) { throw new Error('NOT_IMPLEMENTED: interface stub, owner replaces it'); }
/** Output size 'WxH' valid for gpt-image-2.6 (shared/contracts.js IMAGE_SIZE_RULES). */ export function renderSizeFor(compId, overrides = {}, opts = {}) { throw new Error('NOT_IMPLEMENTED: interface stub, owner replaces it'); }