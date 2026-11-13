// /api router: dispatches shared/contracts.js ROUTES, enforces per-route auth, builds the handler ctx, wraps errors.
import { ROUTES } from '../../shared/contracts.js';
import * as audit from './audit.js';
import { getActor } from './auth.js';
import { errorResponse, HttpError, logEvent, SECURITY_HEADERS } from './http.js';
import * as migrate from './migrate.js';
import * as planner from './planner.js';
import * as session from './session.js';
import * as settings from './settings.js';
import * as studio from './studio-handlers.js';

const CORE = { session, planner, settings, migrate, audit };
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const compiled = ROUTES
  .map(route => {
    const segs = route.path.split('/').filter(Boolean);
    return { ...route, segs, literals: segs.filter(s => !s.startsWith(':')).length };
  })
  .sort((a, b) => b.literals - a.literals);

function matchPath(segs, parts) {
  if (segs.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].startsWith(':')) params[segs[i].slice(1)] = parts[i];
    else if (segs[i] !== parts[i]) return null;
  }
  return params;
}

function resolveHandler(spec) {
  const [mod, fn] = spec.split('.');
  const handler = (CORE[mod] ?? studio[mod])?.[fn];
  return typeof handler === 'function' ? handler : null;
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function authorize(route, actor) {
  if (route.auth === 'public') return;
  if (route.auth === 'service') {
    if (actor.kind === 'anonymous') throw new HttpError('AUTH_REQUIRED', 'Service authentication required.');
    if (actor.kind !== 'service') throw new HttpError('FORBIDDEN', 'This endpoint is for the image processor only.');
    return;
  }
  if (actor.kind === 'anonymous') throw new HttpError('AUTH_REQUIRED', 'Sign in to continue.');
  if (actor.kind === 'service') throw new HttpError('FORBIDDEN', 'Service identities may only call processor endpoints.');
  if (!actor.roles.includes('editor')) throw new HttpError('FORBIDDEN', 'You do not have permission to edit.');
  if (route.auth === 'admin' && !actor.roles.includes('admin')) throw new HttpError('FORBIDDEN', 'Administrator access is required.');
}

/** Handle one /api/* request. */
export async function handleApi(request, env, executionCtx) {
  const url = new URL(request.url);
  let route = null;
  try {
    let parts;
    try {
      parts = url.pathname.replace(/^\/api/, '').split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      throw new HttpError('INVALID_REQUEST', 'Malformed path.');
    }
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const pathMatches = compiled.map(r => ({ r, params: matchPath(r.segs, parts) })).filter(m => m.params);
    const hit = pathMatches.find(m => m.r.method === method);
    if (!pathMatches.length) throw new HttpError('NOT_FOUND', 'Not found.');
    if (!hit) {
      const allow = [...new Set(pathMatches.map(m => m.r.method))];
      return withSecurityHeaders(errorResponse('METHOD_NOT_ALLOWED', 'Method not allowed.', undefined, { Allow: allow.join(', ') }));
    }
    route = hit.r;

    // CSRF defense in depth: browsers always send Origin on cross-site mutations; it must be ours.
    const origin = request.headers.get('Origin');
    if (MUTATING.has(request.method) && origin !== null && origin !== env.PUBLIC_ORIGIN) {
      throw new HttpError('FORBIDDEN', 'Cross-origin requests are not allowed.');
    }

    const actor = await getActor(request, env);
    authorize(route, actor);
    const handler = resolveHandler(route.handler);
    if (!handler) {
      logEvent('error', 'router.missing_handler', { handler: route.handler });
      return withSecurityHeaders(errorResponse('INTERNAL', 'This feature is not available yet.', { handler: route.handler }));
    }
    const ctx = { request, env, executionCtx, params: hit.params, url, actor, db: env.DB, now: Date.now() };
    const response = await handler(ctx);
    const out = withSecurityHeaders(response instanceof Response ? response : errorResponse('INTERNAL', 'Invalid handler result.'));
    return request.method === 'HEAD' ? new Response(null, { status: out.status, headers: out.headers }) : out;
  } catch (err) {
    if (err instanceof HttpError) return withSecurityHeaders(errorResponse(err.code, err.message, err.details));
    logEvent('error', 'router.unhandled', {
      route: route ? `${route.method} ${route.path}` : null,
      name: err?.name, message: String(err?.message ?? err).slice(0, 200),
    });
    return withSecurityHeaders(errorResponse('INTERNAL', 'Something went wrong. Please try again.'));
  }
}
