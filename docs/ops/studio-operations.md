# AI Compartment Studio: operations guide

How the MBFD Ladder 1 AI Compartment Studio works day to day. Sections 1 to 6 are for staff who edit the compartment
plan. Sections 7 to 9 are for the app owner or operator.

Open the Studio from a compartment page with the **AI Compartment Studio** button. The steps along the top are:
Photos, Tools, Mounts, Arrange, Generate, Review & Edit, Publish. You must be signed in to use it. Anonymous
visitors can still read the planner and the gallery.

## 1. How images are captured

1. Open the **Photos** step.
2. Pick what the new photos are in **New photos are…**: Compartment, One tool, Several tools, Mount / bracket,
   Installed arrangement, or Other reference.
3. Tap **Take Photo** (phone camera), **Choose Photos** (files, several at once), or drop files on the box. **Live
   camera** shows up only on browsers that allow it.
4. Review each photo. You can rotate, crop, retake, remove, or change its category. Then tap **Upload N photos**.
5. Photos of one tool or several tools open **Which tools are in this photo?** after they are saved (section 2).

- Accepted: JPEG, PNG, WebP and HEIC. The server checks the real file content, not the file name.
- HEIC: the browser decodes it if it can (iPhone Safari does). Otherwise the app tries to convert it to JPEG. If
  that fails you see "This HEIC photo could not be converted on this device." Share it as JPEG, or choose "Most
  Compatible" in the iPhone camera settings.
- Photos are re-encoded in the browser, which removes EXIF data including GPS location. Transparent areas turn white.
- Limits: a source file over 80 MB is refused. Saved sizes: full-size photo up to 25 MB and 4096 px, screen copy up
  to 4 MB and 1600 px, thumbnail up to 512 KB and 400 px. Up to 400 photos per compartment. Title up to 200
  characters, notes up to 2000.
- Offline: photos wait in a queue stored on the device and upload by themselves when the connection returns. If you
  are signed out, they wait until you sign in. A failed upload retries with growing delays, up to 6 tries, then shows
  a **Retry** button.

Source: `src/studio/capture/**`, `src/lib/image/**`, `src/lib/upload-queue.js`, `shared/contracts.js` (ASSET_LIMITS), `worker/src/assets.js`.

## 2. How grouped tools are linked

A photo is evidence. It never changes the inventory by itself.

1. Upload a photo as **Several tools**. **Which tools are in this photo?** opens. Reopen it later from the **Tools**
   step with **Link photos**, or from the photo detail with its edit-links button.
2. Choose **Multiple tools in this photo**, then tick each tool. Search with **Search tools by name**. Lists are
   "Already in <compartment>", "Available in inventory", and "Not available (assigned elsewhere)".
3. Optional: **Mark on photo** draws a box around a tool.
4. Read **What will happen**. Nothing is saved until you tap **Save links**.

- Tool already assigned to this compartment: the photo links to the existing assignment. The summary says "Link to N
  existing assignment(s) — no inventory change". Counts and slots stay as they are.
- Tool not assigned yet: the summary says "Assign N × <tool> to empty slot(s) …". Counts change only if you tap
  **Save links** with that line showing. Remove the tool from the selection to avoid it.
- If not enough units or empty slots exist, the summary shows the problem and **Save links** stays disabled.
- If another device changed the inventory first, the dialog reloads and asks you to review and save again.

Source: `src/studio/library/**`, `shared/associations.js`, `worker/src/links.js`.

## 3. How mounts are added

1. Open the **Mounts** step and tap **Add mount**.
2. Fill in **Name** (required), Manufacturer, Model, Description, Dimensions, Capacity (tools held), Orientation,
   Zone.
3. Choose a **Classification**:
   - Mounting hardware: carries tools, not counted as inventory.
   - Inventory item: the mount is itself equipment. You must choose the **Inventory item**.
   - Reference only: shown to the image generator as an example, not installed or counted.
4. Choose a **Status**: Existing, Proposed, Optional, or Awaiting verification.
5. Under **Tools carried by this mount**, tick the tools it holds. This is a link only, it does not change counts.
6. Under **Photo**, use **Choose from library** or **Take or upload photo**. **Remove photo** detaches it.
7. Tap **Save mount**. Use the pencil to edit later. Deleting a mount keeps its photo in the library.

Every mount carries the note "Planning only — a rendering never verifies fit, load rating or crashworthiness."

Source: `src/studio/mounts/**`, `worker/src/mounts.js`.

## 4. How generation is requested

1. **Arrange** step (optional, improves results): under **Where does each item go?** pick a zone and orientation per
   tool or mount, add notes, tap **Save**. A status shows "Unsaved changes", "Saved" or "Save failed".
2. **Generate** step: pick a quality under **Quality**. Each card shows its own "about $X (estimate)".

| Card | Default model | Quality | Output | Needs cost OK |
|---|---|---|---|---|
| Fast Preview | gpt-image-2.6-flare | low | jpeg | no |
| High Quality | gpt-image-2.6-sunburst | high | jpeg | no |
| Maximum Detail | gpt-image-2.6-sunburst | max | png | yes |

3. Check **What will be rendered**. Mode is "Using your photos as references" when tool, compartment, mount or
   arrangement photos exist, otherwise "Plan-only (no tool photos yet)". Warnings list tools without photos and
   unknown dimensions.
4. Optionally type **Instructions (optional)** (up to 2000 characters), then tap **Generate image**.
5. Maximum Detail opens **Confirm cost**. Tap **Generate** to accept the estimate.

Progress text on the job card: "Waiting for the image worker…", "Preparing photos…", "Generating image (can take
up to 2 minutes)…", "Saving…", "Done — your draft image is ready." Failed shows "Generation failed" with a short
reason and **Try again**. **Cancel** is on active jobs. **Review result** opens the draft.

When AI is off, the Generate step shows "AI image generation is currently turned off. You can keep preparing; an
admin can turn it on." and **Generate image** returns the same message as an error.

Admins can change models and quality per preset (section 9), so the table shows defaults.

Source: `src/studio/layout/**`, `src/studio/generate/**`, `src/lib/jobs.js`, `shared/contracts.js` (PRESETS, SETTINGS_DEFAULTS), `shared/cost.js`.

## 5. How images are edited

1. In **Review & Edit**, select a version in the list and tap **Edit this version**.
2. Under **What should change?** describe the change in plain words, or tap an example chip.
3. Optional markup on the image: Arrow, Circle, Rectangle, Freehand, with Undo and Redo. Optional **Replace reference
   photo** swaps in a different photo.
4. Pick a quality, then tap **Create edited version**. The cost rules from section 4 apply.
5. Markup edits are best effort. The note on screen says to check the new draft carefully.

- An edit never changes the image you started from. It creates a new version that records its parent
  ("branch of v3"). Every version keeps its image, model, preset, author, time and cost.
- Versions are numbered v1, v2 in order. **Versions (N)** lists them newest first.
- **Compare** shows two versions (or the compartment photo) side by side, or as a slider on phones.
- **Use as base** marks a version as the base for the next edit.
- **Reject** keeps the version in history but it can no longer be published. **Delete draft** hides a draft. Only
  drafts can be rejected or deleted.
- The "Automatic check (hints only — not authoritative)" box appears only when the admin has turned the check on.

Source: `src/studio/edit/**`, `src/studio/review/**`.

## 6. How final images are published

1. In **Review & Edit**, select the version and tap **Publish…**, or open the **Publish** step.
2. Compare "Current main image" with the selected version.
3. Tap **Approve & Set as Main Image**. A message says "Main image updated for everyone."

- The publish is one database batch. It sets the main image, marks the version approved, and makes the image public
  together, or does none of it. If someone else published at the same moment, you see "The main image was changed
  by someone else. The latest one was loaded — please review and publish again."
- Other devices pick it up when their tab becomes visible again. The public badge reads "AI concept" or "Approved
  concept" depending on the image's status.
- **Stale warning:** if equipment assignments changed after the image was generated, the gallery shows "Image may
  be outdated — equipment assignments changed". Publishing it opens **Image may be outdated** with **Cancel**,
  **Regenerate** (goes to the Generate step) and **Publish anyway**.
- **Restore an earlier image:** tap **Restore previous main image** to swap back to the one before. For anything older,
  select that older version in Review and publish it again. Rejected versions cannot be published.

Source: `src/studio/publish/**`, `worker/src/gallery.js`, `src/lib/gallery.js`, `src/components/ImageCarousel.jsx`.

## 7. How job failures are recovered (operator)

Job states: queued, claimed, preparing, generating, saving, then completed, failed or cancelled. The processor
sends a heartbeat every 20 seconds. A job holds a 120 second lease. A job gets at most 2 attempts. Retry delay starts
at 15 seconds and doubles.

The paid-call line is `provider_called_at`. The server records it before the processor calls OpenAI.

| Where it failed | What happens | Money |
|---|---|---|
| Before the paid call (lease expired, processor stopped, network error) | Requeued automatically while attempts remain, then failed "Nothing was charged." | Reservation released |
| After the paid call began (lease expired, timeout, lost connection) | Failed with code `OUTCOME_UNKNOWN`: "…the result is unknown and you may have been charged. Retry if you still need it." Never resubmitted automatically. | Settled at the estimate |
| Provider said no (billing, moderation, rejected, auth) | Failed, not retried. | Settled |

Recovery runs when processors claim work and in the 5 minute scheduled cleanup.

**Retry or cancel (the requester or an admin):** open Generate or Edit, find the job card, tap **Try again**
(failed jobs) or **Cancel** (active jobs). Retry makes a new job with a new reservation. A Maximum Detail job needs cost confirmation, so
start it again from the Generate step instead of **Try again**. A queued job cancels at once. A running job is asked to stop and does so only before the paid call.
For `OUTCOME_UNKNOWN`, check the OpenAI usage page first, then retry only if you still need the image.

**Processor checks** (on aiw-k8 and aiw-7070):

```bash
systemctl status l1-image-processor
journalctl -u l1-image-processor -n 50
sudo -u l1img node --env-file=/etc/l1-image-processor/env /opt/l1-image-processor/processor/src/index.js --health
```

Exit 0 means the settings are valid and the Worker is reachable and accepts the service token. Both nodes claim from
one queue, so one node can be down. A job stuck in queued usually means both services are stopped, AI is switched
off, or a concurrency limit is reached. Install, update, rollback and the error table are in
[aiw-image-processor.md](aiw-image-processor.md).

Source: `shared/contracts.js` (JOB_STATES, JOB_TIMING), `worker/src/jobs.js`, `worker/src/processor.js`, `worker/src/studio/recovery.js`, `worker/src/cron.js`, `processor/src/**`.

## 8. How credentials are managed (operator)

- **OpenAI key:** only in `/etc/l1-image-processor/env` on the AIW workers, mode 0640, owner root, group `l1img`, as
  `L1_OPENAI_API_KEY`. Never in the browser, Worker variables, git, logs, job records or `/etc/environment`.
  Admin settings never show or edit secrets. Names of all variables are in `processor/deploy/env.example`.
- **Who can call the API:** Cloudflare Access protects `/api` for signed-in MBFD staff (editors). A separate bypass
  Access app covers only `/api/public`. The Worker also checks the Access token itself. Admins are the emails in the
  `access.admins` setting.
- **Processor to Worker:** a Cloudflare Access service token (`L1_ACCESS_CLIENT_ID`, `L1_ACCESS_CLIENT_SECRET`) that
  is valid only on `/api/processor/*`.

**Rotate the OpenAI key** (one node at a time):

1. Create a new key in the OpenAI project. Keep the old one active for now.
2. On the node run `sudoedit /etc/l1-image-processor/env`. Replace the `L1_OPENAI_API_KEY=` line with
   `L1_OPENAI_API_KEY=<OPENAI_API_KEY>`. Save. The editor buffer is not shell history. Do not paste the key on a
   command line.
3. Check the file is still 0640 root:`l1img`: `ls -l /etc/l1-image-processor/env`.
4. `sudo systemctl restart l1-image-processor`, then `systemctl status l1-image-processor` and the `--health` command
   from section 7. Health does not test the OpenAI key. A real test is one Fast Preview image.
5. Repeat on the other node. Then revoke the old key in OpenAI. A `PROVIDER_AUTH` failure means the key is wrong.

**Rotate the Access service token:**

1. In Cloudflare Zero Trust, create a second service token and add it to the `/api/processor/*` policy.
2. On one node `sudoedit` the env file and set `L1_ACCESS_CLIENT_ID=<ACCESS_CLIENT_ID>` and
   `L1_ACCESS_CLIENT_SECRET=<ACCESS_CLIENT_SECRET>`. Restart the service and run `--health`.
3. Repeat on the other node, then delete the old token. Both tokens work during the overlap, so neither node goes down.

Never put a key or token in a chat, ticket, commit or command line. If one leaks, rotate it at once.

Source: `docs/architecture/ai-compartment-studio.md`, `docs/ops/aiw-image-processor.md`, `processor/deploy/**`, `worker/src/auth.js`, `docs/security/review-2026-11.md`.

## 9. How spending is controlled (operator)

Defaults (`SETTINGS_DEFAULTS`):

| Setting (Admin label) | Default |
|---|---|
| AI generation enabled (`ai.enabled`) | off |
| Monthly budget (USD) | 25 |
| Daily budget (USD) | 8 |
| Per-user daily budget (USD) | 5 |
| Max jobs at once (everyone) | 2 |
| Max jobs at once (per person) | 1 |

- `ai.enabled` is the master switch. It starts off, so nothing paid runs until an admin turns it on.
- **Before any paid call**, the Worker adds a reservation row to the spend ledger in one step that checks the month,
  day and per-user caps and both job limits together. If any cap would be exceeded, no row is added and the job is not
  created. Two people cannot both slip under a cap.
- The reservation is the **estimate** (shared price table times expected tokens, rounded up to the cent). When the
  job finishes, the ledger is settled with the **actual** cost computed from the provider's usage. The job card
  shows "(estimate)" or "(actual)". Failures before the paid call release the reservation. Days and months follow
  New York time.
- **What the user sees** (codes from `ERROR_CODES`):
  - `BUDGET_EXCEEDED` (402): "The AI spending limit has been reached for now. Ask an admin to raise it or try again
    later." The server detail names which cap, for example "Your daily AI budget would be exceeded …".
  - `CONCURRENCY_LIMIT` (429): "Too many images are being generated right now. Wait for one to finish, then try
    again." or "You already have an image generating. Wait for it to finish or cancel it."
  - `AI_DISABLED` (503): "AI image generation is turned off. An admin can turn it on in Studio settings."
  - `STUDIO_DISABLED` (503): "The AI Compartment Studio is turned off."
- **Change caps (admin):** in the Studio, tap **Admin** (gear) at the top, open **Settings**, find the **Spending**
  group, edit the number, tap **Save**. It applies to everyone at once. Each card has history with **Restore this
  version**. **Usage** shows this month, today and you today. **Audit log** lists changes. The Generate step shows
  the same meters under **AI spending**.
- **No automatic regeneration:** nothing re-runs a paid call by itself. The processor makes the call once per claim.
  After `OUTCOME_UNKNOWN` or any failure, only a person tapping **Try again** creates a new job. The stale dialog's
  **Regenerate** only moves to the Generate step.
- Also set a hard monthly budget on the OpenAI project itself (owner action).

Source: `worker/src/spend.js`, `worker/src/settings.js`, `worker/src/jobs.js`, `src/studio/admin/**`, `shared/cost.js`, `shared/contracts.js`.

## Quick reference

| Task | Where in the app | Who |
|---|---|---|
| Add photos | Studio, Photos, **Take Photo** / **Choose Photos** | Editor |
| Link tools to a photo | Studio, Tools, **Link photos** | Editor |
| Add or edit a mount | Studio, Mounts, **Add mount** | Editor |
| Place items in zones | Studio, Arrange, **Save** | Editor |
| Generate an image | Studio, Generate, **Generate image** | Editor |
| Cancel or retry a job | Job card, **Cancel** / **Try again** | Editor who started it, or admin |
| Edit an image | Studio, Review & Edit, **Edit this version** | Editor |
| Reject or delete a draft | Review & Edit | Editor |
| Publish the main image | Publish, **Approve & Set as Main Image** | Editor |
| Restore the previous main image | Publish, **Restore previous main image** | Editor |
| Change caps, presets, on/off | Studio, **Admin**, Settings | Admin |
| See spending and audit log | Studio, **Admin**, Usage / Audit log | Admin |
| Check or restart the processor | `systemctl` / `journalctl` on aiw-k8 and aiw-7070 | Operator |
| Rotate OpenAI key or service token | `sudoedit /etc/l1-image-processor/env`, restart | Operator |
