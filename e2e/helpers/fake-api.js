// In-memory implementation of the same-origin /api contract (shared/contracts.js ROUTES) for Playwright.
// One FakeApi = one "server" (planner document with revisions, galleries, main images, assets). Install it on one or
// more pages/contexts (= devices); each install returns a device handle with its own session and failure switches.
// Nothing here talks to the network; every image is a synthetic 1×1 PNG.
import * as planner from '../../shared/planner.js'; // the real op engine (shared with the Worker and the browser client)

export const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
export const COMP_IDS = ['CabRearZone', 'LS1', 'LS2', 'LS3', 'LS4', 'RS1', 'RS2', 'RS3', 'RS4', 'RS5', 'RR1'];

const rand = () => Math.random().toString(36).slice(2).padEnd(26, '0').slice(0, 26);
const newId = prefix => `${prefix}_${rand()}`;
const json = (route, status, body, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
const err = (route, status, code, message) => json(route, status, { error: { code, message } });

export class FakeApi {
  /** @param {{migrated?:boolean, studioEnabled?:boolean, patch?:object}} [opts] patch = v1 view fields applied to the empty doc */
  constructor(opts = {}) {
    this.migrated = opts.migrated ?? true;
    this.studioEnabled = opts.studioEnabled ?? true;
    this.doc = planner.emptyDocV2();
    this.revision = 1;
    if (opts.patch) this.seed(opts.patch);
    this.assets = new Map();      // id -> {id, compId, title, provenance, visibility, deleted}
    this.mains = {};              // compId -> {kind, ref, url, thumbUrl, provenance, revision, stale}
    this.opResults = new Map();   // clientOpId -> response (idempotent retries)
    this.opLog = [];              // every accepted ops request body
    this.stray = [];              // unhandled requests
    this.counts = { plannerGets: 0, plannerFull: 0, plannerNotModified: 0, mainImageGets: 0, galleryGets: 0 };
    this.devices = [];
  }

  /** Overwrite v1 fields of the planner document (no revision bump). */
  seed(patch, { raw = false } = {}) {
    for (const [k, v] of Object.entries(patch)) this.doc[k] = v;
    if (!raw && planner.normalizeDoc) this.doc = planner.normalizeDoc(this.doc, { newId }).doc;
  }

  /** v1 view of the current server document. */
  view() { return planner.projectV1(this.doc); }

  /** Apply ops as if another client had sent them. @returns {object} the response body */
  applyDirect(ops) { return this.#applyOps(ops, newId('op')); }

  addAsset(compId, { title = 'Site photo', provenance = 'user_photo', visibility = 'public', id } = {}) {
    const asset = { id: id ?? newId('ast'), compId, title, provenance, visibility, deleted: false };
    this.assets.set(asset.id, asset);
    return asset.id;
  }

  /** Set a main image directly. kind 'preset' uses ref as the static path; otherwise ref is an asset id. */
  setMain(compId, { kind = 'asset', ref, provenance = 'approved_concept', stale = false }) {
    const prev = this.mains[compId];
    const url = kind === 'preset' ? ref : this.#assetUrl(ref);
    this.mains[compId] = { kind, ref, url, thumbUrl: kind === 'preset' ? null : this.#assetUrl(ref, 'thumb'), provenance, revision: (prev?.revision ?? 0) + 1, stale };
  }

  markStale(compId, stale = true) { if (this.mains[compId]) this.mains[compId].stale = stale; }

  #assetUrl(id, variant = 'display') { return `/api/public/assets/${id}/${variant}`; }

  #mainBody(compId) { const m = this.mains[compId]; return m ? { compartmentId: compId, ...m } : null; }

  #applyOps(ops, clientOpId) {
    if (this.opResults.has(clientOpId)) return this.opResults.get(clientOpId);
    const res = planner.applyOps(this.doc, ops, { newId, now: Date.now() });
    if (res.applied.length) { this.doc = res.doc; this.revision += 1; }
    const body = { revision: this.revision, doc: this.doc, applied: res.applied, conflicts: res.conflicts };
    this.opResults.set(clientOpId, body);
    this.opLog.push({ clientOpId, ops });
    return body;
  }

  #items(compId, editor) {
    return [...this.assets.values()]
      .filter(a => a.compId === compId && !a.deleted && (editor || a.visibility === 'public'))
      .map(a => ({ id: a.id, kind: 'asset', url: this.#assetUrl(a.id), thumbUrl: this.#assetUrl(a.id, 'thumb'), title: a.title, provenance: a.provenance }));
  }

  /**
   * Route every /api/* request of a page or context to this server.
   * @param {import('@playwright/test').Page|import('@playwright/test').BrowserContext} target
   * @param {{signedIn?:boolean, email?:string}} [opts]
   */
  async install(target, opts = {}) {
    const device = {
      signedIn: opts.signedIn ?? true,
      email: opts.email ?? 'firefighter@example.test',
      offline: false,        // abort every request (network down)
      failOps: null,         // 'network' | status number: fail POST /planner/ops
      requests: [],
      frozen: null,          // {revision, doc}: this device keeps reading a stale planner document (it "has not polled yet")
      signOut() { this.signedIn = false; },
      signIn() { this.signedIn = true; },
      freezeReads: () => { device.frozen = { revision: this.revision, doc: this.doc }; },
      unfreezeReads: () => { device.frozen = null; },
    };
    this.devices.push(device);
    await target.route(url => new URL(url).pathname.startsWith('/api/'), route => this.#handle(route, device));
    return device;
  }

  async #handle(route, device) {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, '');
    const method = req.method();
    device.requests.push(`${method} ${path}${url.search}`);
    if (device.offline) return route.abort('internetdisconnected');
    const denied = () => { if (device.signedIn) return false; err(route, 401, 'AUTH_REQUIRED', 'Sign in to make changes.'); return true; };
    let m;

    if (method === 'GET' && path === '/session') {
      return json(route, 200, device.signedIn
        ? { email: device.email, roles: ['editor'], studioEnabled: this.studioEnabled, aiEnabled: false }
        : { email: null, roles: [], studioEnabled: this.studioEnabled, aiEnabled: false });
    }
    if (method === 'GET' && path === '/auth/login') {
      // Access login stand-in: signs the device in and redirects to the same-origin return path.
      device.signedIn = true;
      return route.fulfill({ status: 302, headers: { Location: url.searchParams.get('return') || '/' }, body: '' });
    }
    if (method === 'GET' && path === '/public/planner') {
      this.counts.plannerGets += 1;
      if (device.frozen) return json(route, 200, { revision: device.frozen.revision, doc: device.frozen.doc, migrated: this.migrated });
      const since = Number(url.searchParams.get('since'));
      if (since && since === this.revision) { this.counts.plannerNotModified += 1; return route.fulfill({ status: 304 }); }
      this.counts.plannerFull += 1;
      return json(route, 200, { revision: this.revision, doc: this.doc, migrated: this.migrated });
    }
    if (method === 'POST' && path === '/planner/ops') {
      if (denied()) return;
      if (device.failOps === 'network') return route.abort('internetdisconnected');
      if (typeof device.failOps === 'number') return err(route, device.failOps, 'INTERNAL', 'Synthetic failure');
      const body = req.postDataJSON();
      return json(route, 200, this.#applyOps(body.ops, body.clientOpId));
    }
    if (method === 'GET' && path === '/public/main-images') {
      this.counts.mainImageGets += 1;
      return json(route, 200, { mainImages: Object.fromEntries(Object.keys(this.mains).map(c => [c, this.#mainBody(c)])) });
    }
    if (method === 'GET' && (m = path.match(/^\/(public\/)?compartments\/([^/]+)\/gallery$/))) {
      const editor = !m[1];
      if (editor && denied()) return;
      this.counts.galleryGets += 1;
      return json(route, 200, { compartmentId: m[2], main: this.#mainBody(m[2]), items: this.#items(m[2], editor) });
    }
    if (method === 'POST' && (m = path.match(/^\/compartments\/([^/]+)\/main-image$/))) {
      if (denied()) return;
      const { kind, ref, expectRevision } = req.postDataJSON();
      const cur = this.mains[m[1]]?.revision ?? 0;
      if (expectRevision !== cur) return err(route, 409, 'REVISION_CONFLICT', 'The main image changed on another device.');
      this.setMain(m[1], { kind, ref, provenance: kind === 'preset' ? 'user_photo' : (this.assets.get(ref)?.provenance ?? 'user_photo') });
      return json(route, 200, { main: this.#mainBody(m[1]) });
    }
    if (method === 'DELETE' && (m = path.match(/^\/assets\/([^/]+)$/))) {
      if (denied()) return;
      const a = this.assets.get(m[1]);
      if (a) a.deleted = true;
      return route.fulfill({ status: 204 });
    }
    if (method === 'GET' && (m = path.match(/^\/(public\/)?assets\/([^/]+)\/(original|display|thumb)$/))) {
      if (!m[1] && denied()) return;
      return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' }, body: Buffer.from(TINY_PNG, 'base64') });
    }
    this.stray.push(`${method} ${path}`);
    return err(route, 404, 'NOT_FOUND', 'unhandled by fake API');
  }
}
