// Worker entry: /api/* -> router; legacy *.workers.dev host -> read-only legacy shim; everything else 404.
import { handleLegacy } from './src/legacy.js';
import { errorResponse, logEvent } from './src/http.js';
import { handleApi } from './src/router.js';
import { runCron } from './src/cron.js';

export { getCorsHeaders } from './src/legacy.js';

export default {
  async fetch(request, env, executionCtx) {
    try {
      const url = new URL(request.url);
      if (url.hostname.endsWith('.workers.dev')) return await handleLegacy(request, env);
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await handleApi(request, env, executionCtx);
      return errorResponse('NOT_FOUND', 'Not found.');
    } catch (err) {
      logEvent('error', 'worker.unhandled', { name: err?.name, message: String(err?.message ?? err).slice(0, 200) });
      return errorResponse('INTERNAL', 'Something went wrong. Please try again.');
    }
  },

  async scheduled(event, env, executionCtx) {
    const work = runCron(env, Date.now());
    if (executionCtx?.waitUntil) executionCtx.waitUntil(work);
    else await work;
  },
};
