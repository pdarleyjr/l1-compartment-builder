// Offline adapter for L1_DRY_RUN: produces synthetic output without any network call or cost.
import sharp from 'sharp';

/** Same interface as createOpenAiAdapter. */
export function createDryRunAdapter() {
  return {
    name: 'dry-run',
    async generateImage(a) {
      const [w, h] = (/^(\d+)x(\d+)$/.exec(a.size || '') || [null, '1024', '1024']).slice(1).map(Number);
      const s = Math.min(w, 1024) / w;
      const W = Math.max(16, Math.round(w * s)); const H = Math.max(16, Math.round(h * s));
      const bytes = await sharp({ create: { width: W, height: H, channels: 3, background: '#9b1c1c' } }).png().toBuffer();
      return { bytes, mime: 'image/png', width: W, height: H, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, dry_run: true }, requestId: 'dry-run', revisedPrompt: null };
    },
    async recognize() { return { objects: [], usage: { dry_run: true }, requestId: 'dry-run' }; },
    async verify() { return { missing: [], extra: [], notes: 'dry run', confidence: 0, usage: { dry_run: true }, requestId: 'dry-run' }; },
  };
}
