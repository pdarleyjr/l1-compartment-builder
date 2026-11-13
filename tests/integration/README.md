# Full-stack integration tests

These vitest suites run the **real** Worker (`worker/index.js` default export, all of `worker/src/**` and `shared/**`) on the
`node:sqlite` D1 fake, an in-memory R2 and KV (`worker/test/helpers`), with `AUTH_MODE=test` and `ENVIRONMENT=development`.
Nothing in `shared/**` or `worker/src/**` is mocked; the only stand-ins are infrastructure (D1/R2/KV) and a `node:http`
OpenAI server. They are driven like the browser (`device()` → `worker.fetch`, plus the real UI client modules through a
routed global `fetch`) and like the AIW processor (the real `processor/src` job runner, in-process, through a fetch shim that
authenticates as the service actor). Synthetic data only; no network, Cloudflare or OpenAI access.

| File | Covers |
|---|---|
| `migration-planner.test.js` | (a) legacy KV fixture → `POST /api/admin/migrate-legacy` until done, counts match, legacy hostname projection; (b) ops from two devices on different compartments both persist, offline-retry dedupe, last unit → `QUANTITY`, stale slot → `PRECONDITION` |
| `assets-mounts-designs.test.js` | (c) create → PUT 3 variants (real JPEG/WebP bytes) → commit with association: group photo of assigned tools → 0 planner ops, one unassigned tool → `setSlot`, links visible in the list, interrupted upload never linked, stale-quantity commit refused atomically; (d) mounts with links (UI payload round trip, `expectRevision`), design PUT/GET with the canonical layout |
| `jobs-processor.test.js` | (e) AI setting → estimate → create (idempotent replay) → real processor against a mock OpenAI: claim payload, `X-L1-Node`, one provider call, draft version, ledger settled from snake_case usage; (f) cancel queued / cancel after claim / lease expiry before and after generating (`OUTCOME_UNKNOWN`, no requeue); (g) recognize → `subject` reference, inventory candidates, suggested links only; (h) publish, stale detection, `STALE_SOURCE` vs acknowledge, restore previous, public main-images / gallery / legacy `GET /images` |
| `budget-caps.test.js` | (i) daily / monthly / per-user budget and global / per-user concurrency caps under parallel `createJob`; parallel same-key retries create one job |
| `ui-clients.test.js` | the real `src/lib/{api,session,gallery,jobs}.js`, `markupUpload`, admin/usage/publish models against the real handlers (response envelopes) |

Run: `npx vitest run tests/integration`. `harness.js` holds the shared helpers (`createStack`, `device`, `uploadPhoto`,
`runProcessorOnce`, `startMockOpenAI`, `installBrowserFetch`).
