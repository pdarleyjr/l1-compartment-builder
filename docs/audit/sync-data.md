# Audit: sync-data (shared state, image sync, identity, bundles)

Base commit `c9e0d0e` (live production). Audit-only; no source file changed.
Auditor model: Claude Sonnet 5.5 (`claude-sonnet-5-5`). Synthetic data only; the production Worker was never contacted
(Playwright routes every Worker URL to the real `worker/index.js` module over a shared in-memory KV, two browser
contexts = two devices; vitest calls `worker.fetch(request, env)` with a Map-backed KV).

Reproduction files: `tests/audit/sync-data.test.js` (vitest), `e2e/audit-sync.spec.js` (Playwright, desktop project only).
Expected-fail markers: vitest `test.fails`, Playwright `test.fail()`. Run the e2e file with `AUDIT_RAW=1` to disable the
marker and see the real assertion failures (all 13 expected-fail e2e tests were verified to fail on their intended assertion).
Commands: `npx vitest run tests/audit`, `npx playwright test e2e/audit-sync.spec.js --project=desktop-chromium`.

## Summary

| ID | Title | Severity | Evidence |
|---|---|---|---|
| SD-01 | Whole-document last-write-wins loses edits made on another device | Critical | TEST VERIFIED |
| SD-02 | Photo deleted on one device is never removed on others (additive merge, no tombstones) | High | TEST VERIFIED |
| SD-03 | Reloading a stale device resurrects a deleted photo into KV | High | TEST VERIFIED |
| SD-04 | Featured-image change/removal never reaches a device that already has a selection | Medium | TEST VERIFIED |
| SD-05 | Every photo change re-sends the whole base64 document; localStorage mirror and Worker limits disagree | High | TEST VERIFIED (measured) |
| SD-06 | Failed state PUT is never retried; offline edits are discarded on reload | High | TEST VERIFIED |
| SD-07 | Equipment identity is the mutable name: remove/re-add and rename round-trips corrupt inventory | Medium | TEST VERIFIED |
| SD-08 | Reset All / item removal leave bundles pointing at empty slots | Medium | TEST VERIFIED |
| SD-09 | Concurrent last-unit assignment: no over-allocation, but only because one update is lost; server enforces no quantities | Info | TEST VERIFIED (does not reproduce as over-allocation) |
| SD-10 | Images validator accepts duplicate uids and dangling featured uids | Low | TEST VERIFIED |
| SD-11 | Worker has no handling for KV write failure (429 on 1 write/s/key) | Low | TEST VERIFIED |
| SD-12 | Client/Worker validation mismatch: one over-limit field blocks the whole document silently | Medium | TEST VERIFIED |
| SD-13 | Bundles may reference empty/out-of-range slots; no referential integrity | Low | TEST VERIFIED |
| SD-14 | `_serverTs` is `Date.now()`: same-millisecond writes get equal revisions | Low | TEST VERIFIED |
| SD-15 | Worker persists unknown fields verbatim | Low | TEST VERIFIED |
| SD-16 | Rejected image PUT is masked: sync indicator flips back to "Synced with team" | Medium | TEST VERIFIED |
| SD-17 | No binding between generated/uploaded images and an inventory snapshot | Medium | TEST VERIFIED |
| SD-18 | Pull overwrites pending local edits (300 ms debounce / in-flight PUT window) | Medium | INFERRED |

Counts: Critical 1, High 4, Medium 7, Low 5, Info 1 (18 total; 17 defects + 1 non-reproducing/info).

Not reproduced / ruled out: over-allocation from concurrent assignment (SD-09); slot-index shifting (slots are fixed-position,
`addRow` appends and `removeLastEmptyRow` only drops a trailing empty row, so indices never shift, `src/App.jsx:925-939`);
rename leaves allocations/customQtys/customDimensions consistent (`src/App.jsx:808-823`); `clearSlot` does prune bundles
(`src/App.jsx:859-868`) but the dropdown `onChange` (`:1596`) uses plain `assign` and the other paths below do not.

## Sync mechanics (as read)

* Push state: effect on `[allocations, customQtys, customTools, bundles, removedItems, customDimensions]`, 300 ms debounce, full-document
  `PUT /state`, no base revision (`src/App.jsx:477-501`). Worker overwrites key `allocations` and stamps `_serverTs=Date.now()`
  (`worker/index.js:~140-146`). Push of images: 1 s debounce, full document, also fires once when `imageSyncReady` flips true, i.e. on every page load (`:643-660`).
* Pull: every 5 s (`:586`) both documents. State is applied wholesale (all six fields) when `remoteTs > lastPushTs` or on the initial pull (`:521-536`). `isPullingRef` suppresses the echo push.
  Images: uploads merged additively by uid; featured: remote wins only if no local featured or initial (`:539-582`).
* localStorage mirrors state (`l1-compartment-builder-v4`, which stores `_ts` that `loadSaved` never uses), uploads, featured, removed, cdims.
* Hydration boundary: `pullDone` is set after the first state GET *attempt* (success or not); local state is replaced by remote on first successful pull.

## Findings

### SD-01 Whole-document last-write-wins loses concurrent edits — Critical
Rationale: two firefighters editing different compartments within one poll window silently destroy one edit; the sync indicator says "Synced".
Location: `src/App.jsx:477-501` (push without revision), `:525-534` (wholesale apply); `worker/index.js:~129-146` (unconditional `put`).
Evidence: TEST VERIFIED.
Repro: `e2e/audit-sync.spec.js` "SD-01 two devices editing different compartments do not lose either edit" (test.fail) — A sets LS1 slot 1, B (not yet polled) sets RS1 slot 1; KV ends with `LS1[0]===''`. Worker-level: `tests/audit/sync-data.test.js` "SD-01 a stale full-document PUT…" (test.fails) plus characterization test showing second PUT wins.
Root cause: PUT carries the entire client copy with no base revision; server never merges or compares.
Correction (narrow): add `baseRev` to the PUT; Worker compares with stored `rev` and returns 409 + current doc on mismatch; client then re-applies its pending edits as operations on top of the fresh doc and retries (compare-and-set loop). Minimum viable step before a redesign: per-compartment sub-documents (`state:LS1` …) with per-key CAS so different compartments never conflict.
Keep: both tests above (flip to normal tests).

### SD-02 Deleted photo is not removed on other devices — High
Location: `src/App.jsx:546-562` (merge only adds), `:697-714` (delete just filters locally).
Evidence: TEST VERIFIED. Repro: "SD-02 a photo deleted on device A disappears from device B…" (test.fail): after A deletes and pushes, B's localStorage still has the photo after >5 s.
Root cause: additive set-union merge with no deletion record.
Correction: tombstones `{uid, deletedAt}` (or `deletedUids` list) in the images doc; merge = union of photos minus tombstoned uids; GC tombstones after N days.

### SD-03 Reload resurrects deleted photo — High
Location: `src/App.jsx:643-660` (push runs as soon as `imageSyncReady`, with the merged local+remote set).
Evidence: TEST VERIFIED. Repro: "SD-03 reloading a device that still holds a deleted photo does not resurrect it in KV" (test.fail): B reload → KV again contains the photo, A then re-pulls it too.
Root cause: SD-02 plus an unconditional push on load, so any stale device rewrites KV with its old photo set.
Correction: tombstones (SD-02) and do not push on load unless local state differs from what was pulled.

### SD-04 Featured image changes/removal not propagated — Medium
Location: `src/App.jsx:564-578` ("remote wins only where local has no featured or on initial pull"). Deleting the featured *uploaded* photo is also not propagated (SD-02); the dangling uid then stays in B's featured map.
Evidence: TEST VERIFIED. Repros: two tests "SD-04 …" (test.fail): change (B keeps `LS2.webp`) and removal (B keeps the selection).
Root cause: featured selection merged with "local wins if set"; removals cannot be expressed (absence = unknown).
Correction: per-compartment featured entry with its own revision/`updatedAt` and explicit `null` for "cleared"; last-writer-by-revision per compartment.

### SD-05 Whole base64 document per change; limits disagree — High
Location: `src/App.jsx:643-660`, `worker/index.js:7` (`MAX_IMAGES_BYTES = 12_000_000`), `:~160-190`.
Evidence: TEST VERIFIED (measured). Production-shaped doc (11 comps × 2 photos ≈ 2.86 MB): adding one 300 KB photo PUTs **3,162,421 B (10.5× the photo)** and rewrites one KV value of that size; every page load also PUTs the full doc. Worker accepts ≤12 MB (11 MB test passes, 13 MB → 413); the KV 25 MiB value limit is therefore not the binding one, but Chromium localStorage accepted at most **5,000,000 chars** in a single value (e2e evidence test) so any images doc > ~5 M chars cannot be mirrored (`setStorageError`, sidebar "Device storage is full") and, worse, is still pushed to a doc that a fresh device must download in one GET. A device on a slow link re-uploads ~3 MB per edit; two devices editing images exceed 1 KV write/s/key easily (see SD-11).
Repro: vitest "SD-05 (measurement)" and "SD-05 (limits)"; e2e "SD-05 (evidence) localStorage…". These pass (they document current behaviour).
Root cause: images live inline in one KV value keyed `images`.
Correction: store each photo as its own KV key (or R2 object) `img:<uid>` with metadata doc `{uid, comp, title, createdAt, bytes, sha256}`; the shared doc holds metadata only; PUT/DELETE per photo; clients fetch bytes lazily and cache in IndexedDB (not localStorage).

### SD-06 Failed state PUT is not retried; offline edits lost on reload — High
Location: `src/App.jsx:477-501` (push only when dependencies change; failure just sets `offline`), `:521-536` (initial/any newer remote replaces local), `:461-474` (`_ts` saved but never read).
Evidence: TEST VERIFIED. Repros: "SD-06 an edit made while the state PUT fails is retried once connectivity returns" (KV never receives the edit within 12 s after network returns) and "SD-06b an offline edit survives a reload" (after reload slot 1 is empty).
Root cause: no dirty flag / outbox; the "offline — changes saved locally" message is untrue after a reload.
Correction: persist a `dirty` flag + base revision in localStorage; retry with backoff; on reconnect rebase local ops onto the server doc (SD-01 mechanism) instead of replacing it.

### SD-07 Identity by mutable name — Medium
Location: `src/App.jsx:83` (`INVENTORY_BY_NAME`), `:453-458` (`getQty`), `:767-783` (remove), `:794-848` (rename), `:2268-2282`.
Evidence: TEST VERIFIED. Repros (test.fail): (a) remove standard "1 Ton Griphoist" (qty 1) then add custom tool of the same name qty 5 → table shows 1 because `getQty` prefers the built-in quantity and the add-form duplicate check ignores removed items; (b) rename standard item away and back (the name check ignores the removed original), then Remove → row stays, because it is now treated as non-custom (`!INVENTORY_BY_NAME[name]` false) so only `removedItems` grows while the custom copy stays in `customTools`.
Other consequences (INFERRED from source): a rename on device A while B places the old name leaves a ghost name in B's allocations that is not in `placedStats` (`:591-603`), so it is silently excluded from totals/exports; `removedItems` is an ever-growing name list with duplicates; photos hold no tool references (no breakage) and bundles hold slot indices (unaffected by rename, see SD-08 for removal).
Correction: stable `itemId` for every inventory item (built-ins get fixed ids), allocations store ids, name is display-only; migrate on load by name→id map (`V3_RENAMES`/`CONSOLIDATION_RENAMES` become the migration table).

### SD-08 Reset All / removal leave stale bundles — Medium
Location: `src/App.jsx:941-945` (`handleReset` only `setAllocations(buildEmpty())`), `:767-783` (`handleRemoveItem` blanks slots, never touches `bundles`), `:1596` (dropdown change).
Evidence: TEST VERIFIED. Repros (test.fail): Reset All with a 2-slot bundle leaves `bundles.LS1[0].slotIndices=[0,1]` in KV; removing an item leaves its slot in the bundle. A later assignment silently joins the old bundle (`slotBundleMap`, `:1399-1401`), and the bundle list reads "(2 items)" for empty slots.
Also stale after reset (design decision needed): `customQtys`, `customTools`, `removedItems`, images/featured. Bulk-fill and expand do not move indices.
Correction: single `pruneBundles(allocations)` applied inside the same state update for reset/remove/dropdown-clear; drop bundles whose slots are all empty.

### SD-09 Concurrent last-unit assignment — Info (not an over-allocation)
Evidence: TEST VERIFIED. "SD-09 (evidence)" (passes): A and B each place the single "1 Ton Griphoist"; KV ends with exactly one placement — A's is overwritten (SD-01). So current LWW makes over-allocation impossible via assignment, at the price of data loss. Over-allocation *can* be stored through quantity edits or by any client (Worker accepts allocations beyond `customQtys`, vitest "SD-09 (characterization)"); the UI intentionally shows an "Over" badge, so server rejection would break that flow. Once SD-01 is fixed with merging, quantity must be re-validated server-side (reject or flag the losing assignment).

### SD-10 Duplicate uids / dangling featured uid accepted — Low
Location: `worker/index.js:~103-125`. Evidence: TEST VERIFIED (vitest test.fails x2). Client merge dedups only against *local* uids (`src/App.jsx:553-554`), so a remote list containing a duplicate uid yields two entries, and delete-by-index (`:697`) removes only one. Entries without uid are ignored on merge. Correction: reject duplicate uids per document and featured uids that do not exist.

### SD-11 No handling of KV write failure — Low
Location: `worker/index.js:~146`, `~190` (bare `await env.L1_STATE.put`). KV allows ~1 write/s/key; two devices pushing images/state can trip 429. Evidence: TEST VERIFIED (vitest test.fails): `fetch` rejects rather than returning a JSON 503 + `Retry-After`. Correction: try/catch → 503; client backoff.

### SD-12 Client/Worker validation mismatch silently blocks sync — Medium
Evidence: TEST VERIFIED (characterization tests pass). Worker limits that the client never enforces: 300-char names/titles/fileNames (file names come straight from `file.name`, `src/App.jsx:1894`; tool names `AddToolForm`), 500 slots per compartment (`addRow` unbounded), 50 photos per compartment, 5 M-char photo, 12 MB total, qty ≤ 10 000. One violation makes the *entire* document PUT return 400/413 forever; the UI only sets "offline", and SD-16 hides even that. Correction: share the limits as constants, enforce them at input time, and surface the Worker's `error` string.

### SD-13 Bundles lack referential integrity — Low
Worker accepts `slotIndices` pointing at empty or non-existent slots (vitest test.fails). Correction: validate against `allocations[comp].length` and non-empty (or use ids, see data model).

### SD-14 `_serverTs` not a revision — Low
`Date.now()` (`worker/index.js:~140`); client pulls only when `remoteTs > lastPushTs` (`src/App.jsx:525`). Two writes in one ms (or isolate clock skew) get equal/decreasing values and one is never pulled. Evidence: TEST VERIFIED (vitest test.fails with fake timers). Correction: monotonic integer `rev = prev.rev + 1` stored with the value (CAS).

### SD-15 Unknown fields persisted — Low
200 KB `junk` field stored verbatim (vitest test.fails). Correction: rebuild the stored object from validated fields only.

### SD-16 Failed image PUT masked — Medium
Location: `src/App.jsx:655-657` sets `offline`, then the 5 s pull sets `synced` when both GETs succeed (`:583`). Evidence: TEST VERIFIED. "SD-16 …" (test.fail): with `/images` PUT always 413, the indicator reads "Synced with team" after the next poll while the photos exist on one device only. Correction: track push errors in their own state and show them until a push succeeds; do not derive status from GET success alone.

### SD-17 No binding between images and inventory — Medium
Location: `src/App.jsx:690-695`, `:731-759`. Uploaded/AI images are stored as `{dataUrl,title,fileName,uid}`; AI rendering ("AI Rendering" title) carries no prompt, tool list, compartment revision, timestamp, or source flag; the static "Rendering with Tools" (`LS2_rendering.webp`) is likewise unlinked. After any assignment change the image can show tools that are no longer there with no indication. Evidence: TEST VERIFIED ("SD-17 …", test.fail). Correction: add `source: 'upload'|'ai'`, `createdAt`, and for AI `generatedFrom: {allocationsRevision, items:[{itemId,qty}]}`; show a "stale" badge when the current compartment contents differ.

### SD-18 Pull overwrites pending edits — Medium (INFERRED)
`src/App.jsx:479-481`: when a pull lands, `isPullingRef` makes the push effect return *and its cleanup cancels the pending 300 ms timer*, so an edit made in the preceding 300 ms (or whose PUT is in flight when a newer remote arrives) is overwritten by the remote copy without any push. Not reproduced deterministically (needs sub-300 ms timing). Correction: same rebase mechanism as SD-01.

## Recommended data model

* **Stable ids**: `itemId` for inventory (built-ins fixed ids; custom = uuid), `slotId` (uuid) per slot, `bundleId`, `photoId`, `compId` (already stable). Allocations become `{compId: [{slotId, itemId|null}]}`; bundles `{bundleId, compId, name, slotIds[]}`; photos `{photoId, compId, title, source, createdAt, sha256, bytes}`; featured `{compId: photoId|presetKey|null, rev}`.
* **Migration** (client on load + one-off Worker script): name → `itemId` using `MASTER_INVENTORY`, `V3_RENAMES`, `CONSOLIDATION_RENAMES`; unknown names become custom items; slot index → `slotId` (position at migration time); bundle `slotIndices` → `slotIds`, dropping bundles whose slots are empty; keep old keys read-only for rollback.
* **Revisions & CAS**: split the document into entities (one KV key per compartment, inventory, bundles-per-compartment, images metadata, one key per photo blob) each with an integer `rev`; PUT takes `ifRev`, 409 returns the current entity; client rebases pending ops (assign/clear/rename/…) rather than resending snapshots.
* **Tombstones**: `{id, deletedAt, rev}` for photos, bundles, custom items, featured selections; merges treat tombstone > older live copy; GC after a retention window.
* **Server-authoritative**: revision/timestamp assignment, quantity invariants (placed ≤ qty or an explicit `over` flag), referential integrity (slot/item/photo ids exist), size limits (single shared constants with the client), uniqueness of ids and names, and the dedupe/tombstone decision. Client is authoritative only for the *intent* of an edit; the Worker applies it atomically and returns the resulting entity.
* Images: metadata in KV, bytes in R2 (or per-photo KV keys), content-addressed by sha256 so duplicate uploads dedupe and AI renderings can reference the exact inventory revision they were generated from.
