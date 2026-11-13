/* eslint-disable no-unused-vars -- P0 interface stub; remove when implemented */
// Owner: part E2. Interface stub (P0). The router (E1) resolves 'module.export' handlers from ROUTES via this object.
// Each handler: async (ctx) => Response, where ctx = {request, env, executionCtx, params, url, actor, db, now}.
export const assets = {};
export const gallery = {};
export const links = {};
export const mounts = {};
export const designs = {};
export const jobs = {};
export const processor = {};
export const spend = {};
/** Cron housekeeping hook for studio tables (expired leases, pending-asset GC, stale reservations). */
export async function studioCron(env, now) { /* stub */ }