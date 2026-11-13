// Cost estimation and settlement from the admin-editable price table (settings key 'pricing', USD per 1M tokens).
import { IMAGE_QUALITIES } from './contracts.js';

const PER_M = 1_000_000;
const isNum = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const ceilCents = usd => Math.ceil(Math.round(usd * 1e6) / 1e4) / 100; // round up to whole cents (avoids float fuzz)

function megapixels(size) {
  const m = /^(\d+)x(\d+)$/.exec(String(size ?? ''));
  return m ? (Number(m[1]) * Number(m[2])) / 1e6 : 0;
}

/**
 * Pre-generation estimate. Output tokens ≈ estimatedOutputTokensPerMegapixel[quality] × megapixels; input =
 * referenceCount × estimatedInputTokensPerReference image tokens + promptChars/4 text tokens. An unknown model or
 * quality falls back to the most expensive known entry (never under-estimates).
 * @param {{model:string, quality:string, size:string, referenceCount:number, promptChars:number}} req
 * @param {object} pricing settings 'pricing' value
 * @returns {{usd:number, basis:string}} usd rounded up to cents
 */
export function estimateCost({ model, quality, size, referenceCount = 0, promptChars = 0 }, pricing) {
  const tokensPerMp = pricing?.estimatedOutputTokensPerMegapixel ?? {};
  const known = Object.entries(pricing ?? {}).filter(([, v]) => v && typeof v === 'object' && isNum(v.imageOut)).map(([k, v]) => [k, v]);
  let rates = pricing?.[model];
  const notes = [];
  if (!(rates && isNum(rates.imageOut))) {
    rates = known.sort((a, b) => b[1].imageOut - a[1].imageOut)[0]?.[1] ?? { textIn: 0, imageIn: 0, imageOut: 0 };
    notes.push(`model ${model} not in price table; used the most expensive listed rates`);
  }
  let perMp = tokensPerMp[quality];
  if (!isNum(perMp)) {
    perMp = Math.max(0, ...IMAGE_QUALITIES.map(q => tokensPerMp[q]).filter(isNum));
    notes.push(`quality ${quality} not in token table; used the highest estimate`);
  }
  const mp = megapixels(size);
  const outTokens = Math.ceil(perMp * mp);
  const imgTokens = Math.max(0, referenceCount) * (pricing?.estimatedInputTokensPerReference ?? 0);
  const textTokens = Math.ceil(Math.max(0, promptChars) / 4);
  const usd = ceilCents((outTokens * (rates.imageOut ?? 0) + imgTokens * (rates.imageIn ?? 0) + textTokens * (rates.textIn ?? 0)) / PER_M);
  const basis = `≈ ${outTokens.toLocaleString('en-US')} output tokens (${perMp}/MP × ${mp.toFixed(2)} MP, ${quality}) × $${rates.imageOut}/M`
    + ` + ${imgTokens.toLocaleString('en-US')} reference-image tokens (${referenceCount}) × $${rates.imageIn}/M`
    + ` + ${textTokens.toLocaleString('en-US')} prompt tokens × $${rates.textIn}/M = $${usd.toFixed(2)} (rounded up)${notes.length ? `; ${notes.join('; ')}` : ''}`;
  return { usd, basis };
}

/**
 * Actual cost from provider usage. Images API usage {input_tokens, output_tokens, input_tokens_details:{text_tokens,
 * image_tokens, cached_tokens?}} and Responses usage {input_tokens, output_tokens} are supported. Cached tokens are
 * charged at imageInCached (taken from the image tokens first). Unknown model/usage → null. Result is not rounded to cents.
 * @param {object} usage @param {string} model @param {object} pricing @returns {number|null} USD
 */
export function actualCost(usage, model, pricing) {
  const rates = pricing?.[model];
  if (!usage || typeof usage !== 'object' || !rates || typeof rates !== 'object') return null;
  const { input_tokens: input, output_tokens: output, input_tokens_details: d } = usage;
  if (!isNum(input) || !isNum(output)) return null;
  const outRate = rates.imageOut ?? rates.textOut;
  if (!isNum(outRate)) return null;
  let inputUsd;
  if (d && typeof d === 'object') {
    const text = d.text_tokens ?? 0;
    const image = d.image_tokens ?? Math.max(0, input - text);
    const cached = Math.min(d.cached_tokens ?? 0, image);
    if (![text, image, cached].every(isNum)) return null;
    inputUsd = text * (rates.textIn ?? 0) + (image - cached) * (rates.imageIn ?? rates.textIn ?? 0) + cached * (rates.imageInCached ?? rates.imageIn ?? 0);
  } else {
    inputUsd = input * (rates.textIn ?? 0);
  }
  return Math.round(((inputUsd + output * outRate) / PER_M) * 1e6) / 1e6;
}
