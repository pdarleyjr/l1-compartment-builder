import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const buildVersion = process.env.VITE_BUILD_SHA || 'local';
// Dev only: forward same-origin /api calls to a local Worker (e.g. `wrangler dev` on http://127.0.0.1:8787).
const apiProxy = process.env.L1_API_PROXY;
// Test only (playwright.config.js): swap shared/planner.js for e2e/helpers/planner-shim.js while that module is the
// unimplemented P0 stub. Never set for production builds.
const plannerShim = process.env.L1_PLANNER_SHIM === '1'
  ? [{ find: /^.*\/shared\/planner\.js$/, replacement: fileURLToPath(new URL('./e2e/helpers/planner-shim.js', import.meta.url)) }]
  : [];

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
  resolve: { alias: plannerShim },
  server: apiProxy ? { proxy: { '/api': { target: apiProxy, changeOrigin: false } } } : undefined,
  base: '/',
});
