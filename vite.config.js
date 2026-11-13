import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const buildVersion = process.env.VITE_BUILD_SHA || 'local';
// Dev only: forward same-origin /api calls to a local Worker (e.g. `wrangler dev` on http://127.0.0.1:8787).
// changeOrigin must be true: with the browser's Host (the Vite port) `wrangler dev` hands the Worker an Origin
// that fails its CSRF check, so every POST/PUT/PATCH/DELETE got 403 (QA finding Q-01). Start the local Worker
// with `--var PUBLIC_ORIGIN:<vite origin>` (see e2e/helpers/real-backend/start-worker.sh).
const apiProxy = process.env.L1_API_PROXY;

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'release-provenance',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: JSON.stringify({ commit: buildVersion }, null, 2),
        });
      },
    },
  ],
  server: apiProxy ? { proxy: { '/api': { target: apiProxy, changeOrigin: true } } } : undefined,
  base: '/',
});
