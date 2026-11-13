import { describe, expect, test } from 'vitest';
import { SETTINGS_DEFAULTS } from '../../shared/contracts.js';
import { actualCost, estimateCost } from '../../shared/cost.js';

const P = SETTINGS_DEFAULTS.pricing;
const FLARE = 'gpt-image-2.6-flare';

describe('estimateCost', () => {
  test('image output tokens ≈ per-MP × megapixels; inputs from references and prompt chars; rounded up to cents', () => {
    // 2560x1440 = 3.6864 MP, high = 4200/MP → 15,483 tokens * $30/M = 0.46449; refs 2 * 1500 * $8/M = 0.024; text 1000/4=250 * $5/M = 0.00125
    const r = estimateCost({ model: 'gpt-image-2.6-sunburst', quality: 'high', size: '2560x1440', referenceCount: 2, promptChars: 1000 }, P);
    expect(r.usd).toBe(0.49);
    expect(r.basis).toContain('15,483 output tokens');
    expect(r.basis).toContain('4200/MP');
    expect(r.basis).toContain('3.69 MP');
    expect(r.basis).toContain('3,000 reference-image tokens (2)');
    expect(r.basis).toContain('250 prompt tokens');
  });
  test.each([
    ['low', '1024x1024', 0, 0, 0.01],
    ['medium', '1024x1024', 0, 0, 0.04],
    ['max', '2560x1440', 0, 0, 1],
    ['low', '1024x1024', 10, 4000, 0.14],
  ])('quality %s %s refs=%i chars=%i → usd %s', (quality, size, referenceCount, promptChars, want) => {
    const r = estimateCost({ model: FLARE, quality, size, referenceCount, promptChars }, P);
    expect(r.usd).toBeCloseTo(want, 2);
    expect(Number.isInteger(Math.round(r.usd * 100))).toBe(true);
  });
  test('always rounds UP to the cent and never to 0 for non-zero cost', () => {
    const r = estimateCost({ model: FLARE, quality: 'low', size: '1024x1024', referenceCount: 0, promptChars: 0 }, P);
    expect(r.usd).toBe(0.01); // 0.0094 → 0.01
    const exact = estimateCost({ model: FLARE, quality: 'low', size: '1000x1000', referenceCount: 0, promptChars: 0 }, { ...P, estimatedOutputTokensPerMegapixel: { low: 1000 }, [FLARE]: { textIn: 0, imageIn: 0, imageOut: 10 } });
    expect(exact.usd).toBe(0.01); // exactly 1 MP × 1000 tokens × $10/M = $0.01, no float fuzz upward
    expect(estimateCost({ model: FLARE, quality: 'low', size: '0x0', referenceCount: 0, promptChars: 0 }, P).usd).toBe(0);
  });
  test('monotonic in quality, size, references and prompt length', () => {
    const base = { model: FLARE, quality: 'low', size: '1024x1024', referenceCount: 0, promptChars: 0 };
    const usd = o => estimateCost({ ...base, ...o }, P).usd;
    expect(usd({ quality: 'medium' })).toBeGreaterThan(usd({}));
    expect(usd({ quality: 'high' })).toBeGreaterThan(usd({ quality: 'medium' }));
    expect(usd({ size: '2048x2048' })).toBeGreaterThan(usd({}));
    expect(usd({ referenceCount: 20 })).toBeGreaterThan(usd({}));
    expect(usd({ promptChars: 400_000 })).toBeGreaterThan(usd({}));
  });
  test('unknown model / quality fall back conservatively and say so', () => {
    const known = estimateCost({ model: FLARE, quality: 'max', size: '1536x1024', referenceCount: 1, promptChars: 100 }, P);
    const unk = estimateCost({ model: 'gpt-image-9', quality: 'ultra', size: '1536x1024', referenceCount: 1, promptChars: 100 }, P);
    expect(unk.usd).toBe(known.usd);
    expect(unk.basis).toContain('model gpt-image-9 not in price table');
    expect(unk.basis).toContain('quality ultra not in token table');
  });
  test('missing pricing / missing arguments do not throw', () => {
    expect(estimateCost({ model: 'x', quality: 'low', size: '1024x1024' }, undefined).usd).toBe(0);
    expect(estimateCost({ model: FLARE, quality: 'low', size: 'bad', referenceCount: -3, promptChars: -4 }, P).usd).toBe(0);
  });
});

describe('actualCost', () => {
  test('Images API usage with details', () => {
    const usage = { input_tokens: 1500, output_tokens: 4000, input_tokens_details: { text_tokens: 500, image_tokens: 1000 } };
    // 500*5 + 1000*8 + 4000*30 = 2500 + 8000 + 120000 = 130500 / 1e6
    expect(actualCost(usage, FLARE, P)).toBeCloseTo(0.1305, 6);
  });
  test('cached tokens are charged at the cached rate (taken from image tokens)', () => {
    const usage = { input_tokens: 1500, output_tokens: 0, input_tokens_details: { text_tokens: 500, image_tokens: 1000, cached_tokens: 400 } };
    expect(actualCost(usage, FLARE, P)).toBeCloseTo((500 * 5 + 600 * 8 + 400 * 2) / 1e6, 6);
    const over = { input_tokens: 1000, output_tokens: 0, input_tokens_details: { text_tokens: 0, image_tokens: 1000, cached_tokens: 5000 } };
    expect(actualCost(over, FLARE, P)).toBeCloseTo((1000 * 2) / 1e6, 6);
  });
  test('details without image_tokens derive them from input_tokens', () => {
    const usage = { input_tokens: 1000, output_tokens: 0, input_tokens_details: { text_tokens: 200 } };
    expect(actualCost(usage, FLARE, P)).toBeCloseTo((200 * 5 + 800 * 8) / 1e6, 6);
  });
  test('Responses usage {input_tokens, output_tokens}: text model and image model', () => {
    expect(actualCost({ input_tokens: 2000, output_tokens: 500 }, 'gpt-5.4-mini', P)).toBeCloseTo((2000 * 0.75 + 500 * 4.5) / 1e6, 6);
    expect(actualCost({ input_tokens: 100, output_tokens: 1000 }, FLARE, P)).toBeCloseTo((100 * 5 + 1000 * 30) / 1e6, 6);
  });
  test('unknown model, bad usage, missing rates → null', () => {
    expect(actualCost({ input_tokens: 1, output_tokens: 1 }, 'nope', P)).toBeNull();
    expect(actualCost(null, FLARE, P)).toBeNull();
    expect(actualCost('x', FLARE, P)).toBeNull();
    expect(actualCost({ input_tokens: 'a', output_tokens: 1 }, FLARE, P)).toBeNull();
    expect(actualCost({ output_tokens: 1 }, FLARE, P)).toBeNull();
    expect(actualCost({ input_tokens: 1, output_tokens: 1 }, FLARE, undefined)).toBeNull();
    expect(actualCost({ input_tokens: 1, output_tokens: 1 }, 'estimatedInputTokensPerReference', P)).toBeNull();
    expect(actualCost({ input_tokens: 1, output_tokens: 1 }, FLARE, { [FLARE]: { textIn: 1 } })).toBeNull();
    expect(actualCost({ input_tokens: 5, output_tokens: 1, input_tokens_details: { text_tokens: -1, image_tokens: 2 } }, FLARE, P)).toBeNull();
  });
  test('actual vs estimate stay in the same order of magnitude for a typical call', () => {
    const est = estimateCost({ model: FLARE, quality: 'low', size: '1536x1024', referenceCount: 3, promptChars: 3000 }, P).usd;
    const act = actualCost({ input_tokens: 5250, output_tokens: Math.round(300 * 1.57), input_tokens_details: { text_tokens: 750, image_tokens: 4500 } }, FLARE, P);
    expect(act).toBeLessThanOrEqual(est);
    expect(act).toBeGreaterThan(est / 10);
  });
});

describe('actualCost with the documented provider usage shapes (snake_case, exactly as returned)', () => {
  // Images API (gpt-image-*): https://platform.openai.com/docs/api-reference/images/object — usage on every generate/edit response.
  const imagesUsage = { total_tokens: 100, input_tokens: 50, output_tokens: 50, input_tokens_details: { text_tokens: 10, image_tokens: 40 } };
  test('Images API usage: text in + image in + image out at the price table rates', () => {
    expect(actualCost(imagesUsage, FLARE, P)).toBeCloseTo((10 * 5 + 40 * 8 + 50 * 30) / 1e6, 10); // $0.00187
    expect(actualCost(imagesUsage, FLARE, P)).toBe(0.00187);
  });
  test('Images API usage with cached input tokens charges the cached image rate for them', () => {
    const cached = { ...imagesUsage, input_tokens_details: { ...imagesUsage.input_tokens_details, cached_tokens: 30 } };
    expect(actualCost(cached, FLARE, P)).toBeCloseTo((10 * 5 + 10 * 8 + 30 * 2 + 50 * 30) / 1e6, 10);
  });
  test('Responses API usage (recognition model): input_tokens_details has only cached_tokens', () => {
    const responses = { input_tokens: 1200, input_tokens_details: { cached_tokens: 200 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1280 };
    expect(actualCost(responses, 'gpt-5.4-mini', P)).toBeCloseTo((1000 * 0.75 + 200 * 0.075 + 80 * 4.5) / 1e6, 10);
  });
  test('camelCase or malformed usage is not silently priced', () => {
    expect(actualCost({ inputTokens: 5, outputTokens: 5 }, FLARE, P)).toBeNull();
    expect(actualCost({ input_tokens: 'many', output_tokens: 1 }, FLARE, P)).toBeNull();
    expect(actualCost(null, FLARE, P)).toBeNull();
  });
});
