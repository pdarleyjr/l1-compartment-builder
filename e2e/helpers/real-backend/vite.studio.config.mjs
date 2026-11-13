// Vite config for the QA stack: the app's own config plus a proxy with changeOrigin:true. With the root config's changeOrigin:false the
// browser's Host (the Vite port) reaches `wrangler dev`, which then rejects every browser mutation as cross-origin (finding Q-01 in
// docs/qa/findings.md); production has no such proxy, so this only affects local development.
import { mergeConfig } from 'vite';
import base from '../../../vite.config.js';
import { WORKER_URL } from './ports.mjs';

export default mergeConfig(base, { server: { proxy: { '/api': { target: WORKER_URL, changeOrigin: true } } } });
