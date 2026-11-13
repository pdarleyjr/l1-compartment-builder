import { describe, expect, it } from 'vitest';
import { IMAGE_MODELS, SETTINGS_DEFAULTS } from '../../shared/contracts.js';
import { canPublish, classifyPublishError, extractMain, publishBody } from '../../src/studio/publish/publishModel.js';
import { cleanOverrides, diffValues, normalizeHistory, normalizeSettings, SETTING_META, validateSetting, validateSize } from '../../src/studio/admin/settingsModel.js';
import { buildSummary, classifySubmitError, needsConfirm, pickMode, renderBody, usageMeters } from '../../src/studio/generate/generateModel.js';
import { humanError, isConfirmEstimate } from '../../src/studio/common/format.js';

describe('publish decisions', () => {
  it('STALE_SOURCE → stale choices', () => { expect(classifyPublishError({ status: 409, code: 'STALE_SOURCE' }).kind).toBe('stale'); });
  it('revision conflict → reload', () => {
    expect(classifyPublishError({ status: 409, code: 'REVISION_CONFLICT' }).kind).toBe('conflict');
    expect(classifyPublishError({ status: 409, code: 'CONFLICT' }).kind).toBe('conflict');
  });
  it('other errors pass the message through', () => {
    expect(classifyPublishError({ status: 500, message: 'boom' })).toEqual({ kind: 'other', message: 'boom' });
    expect(classifyPublishError({ code: 'FORBIDDEN' }).kind).toBe('forbidden');
  });
  it('builds the request body with revision and optional acknowledgeStale', () => {
    expect(publishBody({ id: 'iv_1' }, { revision: 4 })).toEqual({ kind: 'version', ref: 'iv_1', expectRevision: 4 });
    expect(publishBody({ id: 'iv_1' }, null, true)).toEqual({ kind: 'version', ref: 'iv_1', expectRevision: 0, acknowledgeStale: true });
  });
  it('extracts a compartment main image from {mainImages:{[compId]:MainImage}}', () => {
    const m = { compartmentId: 'LS1', revision: 2 };
    expect(extractMain({ mainImages: { LS1: m } }, 'LS1')).toBe(m);
    expect(extractMain({ mainImages: { LS1: m } }, 'LS2')).toBeNull();
    expect(extractMain({ mainImages: {} }, 'LS1')).toBeNull();
  });
  it('only drafts/approved can be published', () => {
    expect(canPublish({ status: 'draft' })).toBe(true);
    expect(canPublish({ status: 'rejected' })).toBe(false);
    expect(canPublish(null)).toBe(false);
  });
});

describe('admin settings validation', () => {
  it('has metadata and a valid default for every contract key', () => {
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
      expect(SETTING_META[key], key).toBeTruthy();
      const v = key === 'access.admins' ? ['a@b.co'] : SETTINGS_DEFAULTS[key];
      expect(validateSetting(key, v), key).toEqual([]);
    }
  });
  it('checks number ranges', () => {
    expect(validateSetting('budget.monthlyUsd', -1)).not.toEqual([]);
    expect(validateSetting('budget.monthlyUsd', null)).not.toEqual([]);
    expect(validateSetting('jobs.maxConcurrent', 2.5)).not.toEqual([]);
    expect(validateSetting('jobs.maxConcurrent', 3)).toEqual([]);
  });
  it('limits presets to contract enums', () => {
    const p = structuredClone(SETTINGS_DEFAULTS.presets);
    p.preview.model = 'gpt-4o';
    p.high.quality = 'ultra';
    p.max.outputFormat = 'gif';
    const errs = validateSetting('presets', p);
    expect(errs.length).toBe(3);
    p.preview.model = IMAGE_MODELS[0]; p.high.quality = 'high'; p.max.outputFormat = 'png';
    expect(validateSetting('presets', p)).toEqual([]);
  });
  it('validates admin emails', () => {
    expect(validateSetting('access.admins', ['nope'])).not.toEqual([]);
    expect(validateSetting('access.admins', ['a@b.co', 'A@b.co'])).not.toEqual([]);
    expect(validateSetting('access.admins', [])).not.toEqual([]);
  });
  it('validates house text and recognition model', () => {
    expect(validateSetting('style.houseText', 'x'.repeat(4001))).not.toEqual([]);
    expect(validateSetting('recognition.model', 'bad model!')).not.toEqual([]);
    expect(validateSetting('recognition.model', 'gpt-5.4-mini')).toEqual([]);
  });
  it('validates pricing numbers', () => {
    const p = structuredClone(SETTINGS_DEFAULTS.pricing);
    p['gpt-image-2.6-flare'].imageOut = -3;
    expect(validateSetting('pricing', p)).not.toEqual([]);
  });
  it('validates image sizes with the contract rules', () => {
    expect(validateSize('1536x1024')).toBeNull();
    expect(validateSize('1530x1024')).toMatch(/multiples/);
    expect(validateSize('4800x1008')).toMatch(/edge/);
    expect(validateSize('256x256')).toMatch(/pixels/);
    expect(validateSize('3840x1008')).toMatch(/ratio/);
    expect(validateSize('abc')).toMatch(/look like/);
  });
  it('validates and cleans per-compartment overrides', () => {
    const raw = { LS1: { orientation: 'portrait', size: '', zones: [], dimensions: { widthIn: 18, heightIn: null }, specText: ' ' }, ZZ9: {} };
    expect(validateSetting('compartments.overrides', raw).some(e => e.includes('ZZ9'))).toBe(true);
    expect(cleanOverrides({ LS1: raw.LS1 })).toEqual({ LS1: { orientation: 'portrait', dimensions: { widthIn: 18 } } });
    expect(validateSetting('compartments.overrides', { LS1: { zones: ['bogus'] } })).not.toEqual([]);
    expect(validateSetting('compartments.overrides', { LS1: { dimensions: { widthIn: -2 } } })).not.toEqual([]);
  });
  it('diffs values and normalizes responses', () => {
    expect(diffValues({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } })).toEqual([{ path: 'b.c', from: 2, to: 3 }]);
    expect(diffValues(1, 1)).toEqual([]);
    const n = normalizeSettings({ settings: { 'ai.enabled': { value: true, revision: 3 } } });
    expect(n['ai.enabled']).toEqual({ value: true, revision: 3 });
    expect(n['budget.dailyUsd']).toEqual({ value: 8, revision: 0 });
    expect(normalizeHistory({ history: [{ revision: 1 }, { revision: 3 }] }).map(h => h.revision)).toEqual([3, 1]);
  });
});

describe('generate helpers', () => {
  it('auto-selects mode', () => {
    expect(pickMode([])).toBe('plan');
    expect(pickMode([{ category: 'other' }])).toBe('plan');
    expect(pickMode([{ category: 'tool' }])).toBe('reference');
    expect(pickMode([{ category: 'tool', status: 'deleted' }])).toBe('plan');
  });
  it('builds a bounded request body', () => {
    expect(renderBody({ mode: 'plan', preset: 'high', instructions: '  ' })).toEqual({ kind: 'render', mode: 'plan', preset: 'high' });
    expect(renderBody({ mode: 'plan', preset: 'high', instructions: 'x'.repeat(5000) }).instructions).toHaveLength(2000);
  });
  it('max preset needs confirmation unless the server says otherwise', () => {
    expect(needsConfirm('max')).toBe(true);
    expect(needsConfirm('preview')).toBe(false);
    expect(needsConfirm('preview', { requiresConfirm: true })).toBe(true);
  });
  it('maps submit errors to human messages', () => {
    expect(classifySubmitError({ status: 402, code: 'BUDGET_EXCEEDED' }).kind).toBe('budget');
    expect(classifySubmitError({ status: 429, code: 'CONCURRENCY_LIMIT' }).kind).toBe('busy');
    expect(classifySubmitError({ status: 503, code: 'AI_DISABLED' }).message).toMatch(/turned off/);
    const c = classifySubmitError({ status: 409, code: 'CONFLICT', message: 'needs confirmation', details: { estimate: { usd: 0.4, basis: 'b' }, requiresConfirm: true } });
    expect(c).toMatchObject({ kind: 'confirm', estimateUsd: 0.4 });
    expect(isConfirmEstimate({ status: 409, code: 'STALE_SOURCE', message: 'confirm' })).toBe(false);
    expect(isConfirmEstimate({ status: 409, code: 'CONFLICT', message: 'confirm', details: {} })).toBe(false);
    expect(humanError({ message: 'plain' })).toBe('plain');
  });
  it('summarizes with warnings', () => {
    const s = buildSummary({ tools: [{ ref: 'a', name: 'A', qty: 2 }, { ref: 'b', name: 'B', qty: 1 }], counts: { a: 1 }, assets: Array.from({ length: 11 }, () => ({ category: 'tool' })), mounts: [{}], geometry: null });
    expect(s.toolCount).toBe(3);
    expect(s.withoutPhotos.map(t => t.ref)).toEqual(['b']);
    expect(s.warnings).toHaveLength(3);
  });
  it('normalizes usage meters', () => {
    const m = usageMeters({ month: { spent: 4, reserved: 1, cap: 25 }, today: { spent: 1, reserved: 0, cap: 8 }, user: { spent: 0, reserved: 0, cap: 5 } });
    expect(m[0]).toMatchObject({ label: 'This month', used: 5, limit: 25, pct: 20 });
    expect(m.map(x => x.label)).toEqual(['This month', 'Today', 'You today']);
    expect(usageMeters(null)).toEqual([]);
  });
});
