/* global process */
// Ports and shared paths of the real local QA stack (override with env when a port is taken; 8787 is the AIW status page on aiw-k8).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const WORKER_PORT = Number(process.env.L1_E2E_WORKER_PORT || 8791);
export const VITE_PORT = Number(process.env.L1_E2E_VITE_PORT || 5183);
export const MOCK_PORT = Number(process.env.L1_E2E_MOCK_PORT || 8792);
export const WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;
export const APP_URL = `http://127.0.0.1:${VITE_PORT}`;
export const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
export const PERSIST = path.join(ROOT, '.wrangler/e2e');
/** Control files shared between tests and the processor/mock (kept outside PERSIST, which the worker script wipes on start). */
export const CONTROL_DIR = path.join(ROOT, '.wrangler/e2e-control');
export const ADMIN_ACTOR = 'user:qa.admin@miamibeachfl.gov,admin';
export const EDITOR_ACTOR = 'user:qa.editor@miamibeachfl.gov';
