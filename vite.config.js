import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const buildVersion = process.env.VITE_BUILD_SHA || 'local';
// Dev only: forward same-origin /api calls to a local Worker (e.g. `wrangler dev` on http://127.0.0.1:8787).
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
  server: apiProxy ? { proxy: { '/api': { target: apiProxy, changeOrigin: false } } } : undefined,
  base: '/',
});
