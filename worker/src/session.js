// GET /api/session and GET /api/auth/login.
import { SETTINGS_DEFAULTS } from '../../shared/contracts.js';
import { empty, json } from './http.js';
import { getSettings } from './settings.js';

/** Same-origin path only: must start with '/', never '//' or '/\', no control characters or backslashes. */
export function safeReturnPath(value) {
  if (typeof value !== 'string' || value.length > 2000) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  return value;
}

/** GET /api/session -> {email|null, roles, studioEnabled, aiEnabled} */
export async function getSession(ctx) {
  const { actor, db } = ctx;
  let flags = { 'studio.enabled': SETTINGS_DEFAULTS['studio.enabled'], 'ai.enabled': SETTINGS_DEFAULTS['ai.enabled'] };
  try {
    if (db) flags = await getSettings(db, ['studio.enabled', 'ai.enabled']);
  } catch { /* defaults */ }
  return json({
    email: actor.kind === 'user' ? actor.email : null,
    roles: actor.kind === 'user' ? actor.roles : [],
    studioEnabled: flags['studio.enabled'] !== false,
    aiEnabled: flags['ai.enabled'] === true,
  });
}

/** GET /api/auth/login?return=/path -> 302 (editor-only route: Access forces sign-in before this runs). */
export async function login(ctx) {
  return empty(302, { Location: safeReturnPath(ctx.url.searchParams.get('return') ?? '/') });
}
