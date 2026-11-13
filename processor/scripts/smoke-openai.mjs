#!/usr/bin/env node
/* global console, process -- Node 22 runtime globals (AIW processor runs on Node, not in the browser/Worker) */
// MANUAL, owner-run live smoke test. Costs real money (one 1024x1024 `low` flare image, roughly a cent or less).
// Usage: L1_OPENAI_API_KEY=... node scripts/smoke-openai.mjs --i-understand-this-costs-money
// Prefer: sudo -u l1img env "$(sudo cat /etc/l1-image-processor/env | grep ^L1_OPENAI_API_KEY)" ... (never paste the key in argv).
import { createOpenAiAdapter } from '../src/openai-adapter.js';
import { SETTINGS_DEFAULTS } from '../../shared/contracts.js';

const args = process.argv.slice(2);
if (!args.includes('--i-understand-this-costs-money')) {
  console.error('Refusing: pass --i-understand-this-costs-money to run a paid OpenAI call.');
  process.exit(2);
}
const key = process.env.L1_OPENAI_API_KEY;
if (!key) { console.error('L1_OPENAI_API_KEY is required.'); process.exit(2); }
const qi = args.indexOf('--quality');
const quality = qi >= 0 ? args[qi + 1] : 'low';
if (quality !== 'low') { console.error('Refusing: the smoke test only allows quality=low.'); process.exit(2); }

const model = 'gpt-image-2.6-flare';
const adapter = createOpenAiAdapter({ apiKey: key, baseUrl: process.env.L1_OPENAI_BASE });
const prompt = 'Synthetic test: a single red fire-apparatus flare (road safety flare) lying on a plain grey metal shelf, studio lighting.';
const out = await adapter.generateImage({ model, prompt, size: '1024x1024', quality, complexity: 'low', outputFormat: 'jpeg' });
const u = out.usage || {};
const price = SETTINGS_DEFAULTS.pricing[model];
const est = ((u.input_tokens_details?.text_tokens || 0) * price.textIn + (u.input_tokens_details?.image_tokens || 0) * price.imageIn
  + (u.output_tokens || 0) * price.imageOut) / 1e6;
console.log(JSON.stringify({ requestId: out.requestId, mime: out.mime, bytes: out.bytes.length, usage: u, estimatedCostUsd: Number(est.toFixed(5)) }, null, 2));
