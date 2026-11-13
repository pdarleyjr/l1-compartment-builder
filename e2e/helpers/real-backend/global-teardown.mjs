// wrangler dev writes bundled Worker code to worker/.wrangler/tmp (gitignored, but `eslint .` would lint it): remove it after the run.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './ports.mjs';

export default async function globalTeardown() {
  fs.rmSync(path.join(ROOT, 'worker/.wrangler'), { recursive: true, force: true });
}
