// State machine for one claimed job. The server is the source of truth for leases, retries and cost; this module
// only reports status, calls the provider at most once, and uploads the result. A paid call is never resubmitted here.
import { JOB_TIMING } from '../../shared/contracts.js';
import { ApiError } from './api-client.js';
import { ProviderError } from './openai-adapter.js';
import { sanitize } from './logger.js';
import { planReferences, MODEL_MAX_IMAGES } from './reference-plan.js';
import * as defaultPrep from './image-prep.js';

class Aborted extends Error {
  /** @param {'lease'|'cancel'|'shutdown'} reason */
  constructor(reason) { super(`aborted:${reason}`); this.reason = reason; }
}

const pick = (o, ...keys) => { for (const k of keys) if (o?.[k] != null) return o[k]; return undefined; };

/**
 * @param {{api:ReturnType<typeof import('./api-client.js').createApiClient>, adapter:any, node:string, logger:any,
 *   prep?: typeof defaultPrep, heartbeatMs?:number, secrets?:string[]}} deps
 */
export function createJobRunner(deps) {
  const { api, adapter, node, logger } = deps;
  const prep = deps.prep || defaultPrep;
  const heartbeatMs = deps.heartbeatMs ?? JOB_TIMING.heartbeatMs;
  const clean = s => sanitize(String(s), deps.secrets || []).slice(0, 300);

  /**
   * Start one claimed job.
   * @param {{job:object, spec?:object, references?:object[], maxReferences?:number}} claim
   * @returns {{done: Promise<{outcome:string}>, requestShutdown: () => string, phase: () => string}}
   */
  function start(claim) {
    const job = claim.job;
    const log = logger.child({ jobId: job.id, kind: job.kind });
    const ctrl = new AbortController();
    let phase = 'claimed'; // claimed → preparing → generating → saving
    let abortReason = null;
    let timer = null;
    const preGenerating = () => phase === 'claimed' || phase === 'preparing';
    const abort = reason => { if (preGenerating() && !abortReason) { abortReason = reason; ctrl.abort(); } };
    const ensure = () => { if (abortReason) throw new Aborted(abortReason); };

    /** Heartbeat = status report. Returns the server answer; LEASE_LOST/cancel are acted on here. */
    async function beat(status) {
      try {
        const r = await api.heartbeat(job.id, node, status);
        if (r?.cancelRequested) abort('cancel');
        return r;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          log.warn('lease lost', { code: err.code });
          abort('lease');
          if (!preGenerating()) lostAfterGenerating = true;
          return null;
        }
        throw err;
      }
    }
    let lostAfterGenerating = false;

    async function run() {
      timer = setInterval(() => { beat(phase === 'claimed' ? 'preparing' : phase).catch(e => log.warn('heartbeat failed', { err: e })); }, heartbeatMs);
      timer.unref?.();
      try {
        phase = 'preparing';
        await beat('preparing'); ensure();
        const out = job.kind === 'render' ? await render() : await analyse();
        log.info('job completed', { outcome: out });
        return { outcome: 'completed' };
      } catch (err) {
        return await finishError(err);
      } finally {
        clearInterval(timer);
      }
    }

    async function finishError(err) {
      if (abortReason && !(err instanceof Aborted)) err = new Aborted(abortReason); // in-flight I/O was cut by our own abort
      if (err instanceof Aborted) {
        if (err.reason === 'lease') { log.warn('abandoned: lease lost before generating'); return { outcome: 'lease_lost' }; }
        const body = err.reason === 'cancel'
          ? { code: 'CANCELLED', message: 'Cancelled before generation started.', retryable: false, providerCalled: false }
          : { code: 'PROCESSOR_SHUTDOWN', message: 'Processor restarted before generation started.', retryable: true, providerCalled: false };
        await postFail(body);
        return { outcome: err.reason };
      }
      const afterCall = !preGenerating();
      let body;
      if (err instanceof ProviderError) body = { code: err.code, message: clean(err.message), retryable: err.retryable, providerCalled: err.providerCalled };
      else if (err instanceof ApiError) body = { code: afterCall ? 'SAVE_FAILED' : 'PREP_FAILED', message: clean(err.message), retryable: !afterCall && err.status >= 500, providerCalled: afterCall };
      else body = { code: afterCall ? 'SAVE_FAILED' : 'PREP_FAILED', message: clean(err?.message || 'Unexpected error'), retryable: false, providerCalled: afterCall };
      if (err instanceof ApiError && err.status === 409) { log.warn('server rejected update (409)', { code: err.code }); return { outcome: 'conflict' }; }
      log.error('job failed', { code: body.code, retryable: body.retryable, providerCalled: body.providerCalled, err });
      await postFail(body);
      return { outcome: 'failed' };
    }

    async function postFail(body) {
      try { await api.fail(job.id, { node, ...body }); } catch (e) { log.error('could not report failure', { err: e }); }
    }

    /** Download + normalise a reference. */
    async function fetchRef(r) {
      const { bytes } = await api.download(r.url, { signal: ctrl.signal });
      return { ...(await prep.normalizeReference(bytes)), label: r.label || r.role || 'reference', role: r.role };
    }

    async function render() {
      const refs = claim.references || [];
      const markupRef = refs.find(r => r.role === 'markup');
      const inputs = refs.filter(r => r.role !== 'markup' && r.role !== 'subject');
      const maxImages = claim.maxReferences ?? job.maxReferences ?? MODEL_MAX_IMAGES;
      const plan = planReferences(inputs, maxImages);
      const images = [];
      for (const p of plan) {
        ensure();
        if (p.type === 'direct') images.push(await fetchRef(p.item));
        else {
          const tiles = [];
          for (const it of p.items) tiles.push({ bytes: (await fetchRef(it)).bytes, label: it.label || it.role || 'reference' });
          const sheet = await prep.buildContactSheet(tiles, { title: p.label });
          images.push({ ...sheet, label: p.label, role: 'sheet' });
        }
      }
      let markup;
      if (markupRef) {
        if (!images.length) throw new Error('markup edit requires a base image');
        const { bytes } = await api.download(markupRef.url, { signal: ctrl.signal });
        markup = await prep.normalizeMarkup(bytes, images[0]);
        markup.filename = 'markup.png';
      }
      ensure();
      // Pre-generation cancel check, then record the paid-call boundary on the server BEFORE calling the provider.
      await beat('preparing'); ensure();
      phase = 'generating';
      await beat('generating');
      log.info('calling provider', { model: job.model, images: images.length, markup: !!markup, prompt: job.prompt });
      const out = await adapter.generateImage({
        model: job.model, prompt: job.prompt || '', size: pick(job, 'size'), quality: pick(job, 'quality'), complexity: pick(job, 'complexity'),
        outputFormat: pick(job, 'outputFormat', 'output_format'), moderation: pick(job, 'moderation'),
        references: images.map((im, i) => ({ bytes: im.bytes, mime: im.mime, filename: `ref-${i + 1}.${im.mime === 'image/png' ? 'png' : 'jpg'}`, label: im.label })),
        markup,
      });
      phase = 'saving';
      await beat('saving').catch(e => log.warn('saving status not recorded', { err: e }));
      const d = await prep.buildDerivatives(out.bytes);
      for (const v of ['original', 'display', 'thumb']) await api.putOutput(job.id, v, d[v].bytes, d[v].mime);
      await api.complete(job.id, {
        node, usage: out.usage, actualCostUsd: null, providerRequestId: out.requestId, revisedPrompt: out.revisedPrompt,
        width: d.width, height: d.height,
      });
      return 'render';
    }

    /** recognize / verify: one subject image in, JSON result out. */
    async function analyse() {
      const refs = claim.references || [];
      const subject = refs.find(r => r.role === 'subject') || refs[0];
      if (!subject) throw new Error('job has no subject image');
      const img = await fetchRef(subject);
      ensure();
      await beat('preparing'); ensure();
      phase = 'generating';
      await beat('generating');
      let result; let usage; let requestId;
      if (job.kind === 'recognize') {
        const candidates = claim.spec?.candidates || job.candidates || claim.candidates || [];
        const r = await adapter.recognize({ model: job.model, imageBytes: img.bytes, mime: img.mime, candidates });
        result = { objects: r.objects }; usage = r.usage; requestId = r.requestId;
      } else {
        const r = await adapter.verify({ model: job.model, imageBytes: img.bytes, mime: img.mime, spec: claim.spec });
        result = { missing: r.missing, extra: r.extra, notes: r.notes, confidence: r.confidence }; usage = r.usage; requestId = r.requestId;
      }
      phase = 'saving';
      await beat('saving').catch(e => log.warn('saving status not recorded', { err: e }));
      await api.complete(job.id, { node, usage, actualCostUsd: null, providerRequestId: requestId, result });
      return job.kind;
    }

    const done = run();
    return {
      done,
      phase: () => phase,
      /** Before 'generating': abort and requeue (fail retryable, providerCalled false). Otherwise let it finish. */
      requestShutdown() { abort('shutdown'); return phase; },
      lostAfterGenerating: () => lostAfterGenerating,
    };
  }
  return { start };
}
