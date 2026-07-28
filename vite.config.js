import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const buildVersion = process.env.VITE_BUILD_SHA || 'local';

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
  base: '/',
});
