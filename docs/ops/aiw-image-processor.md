# AIW image processor (`processor/`)

Operations guide for `l1-image-processor.service`, the Node 22 worker that turns queued "AI Compartment Studio" jobs
into images. Design: `docs/architecture/ai-compartment-studio.md` §8 and §10.

## 1. Purpose and architecture

The Cloudflare Worker owns all state (D1 `generation_jobs`, R2, budget ledger). The processor is **outbound-only** (no
listening port) and runs on **both** aiw-k8 and aiw-7070 as a hardened systemd unit under system user `l1img`.

```
Worker (D1/R2) ◄── HTTPS + Access service token ──► processor ── HTTPS (API key) ──► OpenAI
  claim / heartbeat(status) / assets GET / output PUT / complete / fail
```

Per job: `claim` → heartbeat every 20 s (status report doubles as heartbeat; answer carries `cancelRequested`) →
`preparing` (download references, normalise with sharp ≤ 2048 px, build contact sheets for overflow) → `generating`
(server records `provider_called_at` **before** the call) → provider call → `saving` → `PUT output/original|display|thumb`
→ `complete` (`actualCostUsd: null`; the server computes cost from `usage`). Recognize/verify jobs `complete` with `result`.

Rules the code enforces:

- A paid provider call is made **at most once** per claim and never retried by the processor; retries only happen when
  the server re-queues after a `fail {retryable:true}`.
- `LEASE_LOST` (409) or `cancelRequested` **before** `generating` → abort, no provider call (cancel posts
  `fail CANCELLED`, lease loss posts nothing). After `generating` the job is finished and the server decides.
- SIGTERM/SIGINT: stop claiming; jobs not yet `generating` are failed `retryable:true, providerCalled:false`
  (`PROCESSOR_SHUTDOWN`, they requeue immediately); jobs already generating get up to 120 s (unit `TimeoutStopSec=150`).
- Worker API calls: 30 s timeout, network errors/5xx retried with exponential backoff + jitter, 4xx never retried;
  only same-origin URLs are fetched so Access credentials cannot leak. References are capped at 40 MB.

### Error mapping (`fail` body `{code, message, retryable, providerCalled}`)

| Situation | code | retryable | providerCalled |
|---|---|---|---|
| Network error before any byte sent (DNS, refused, TLS) | `PROVIDER_UNREACHABLE` | true | **false** |
| HTTP 429 rate limit (no image produced → not charged) | `PROVIDER_RATE_LIMITED` | true | true |
| HTTP 5xx | `PROVIDER_UNAVAILABLE` | true | true |
| 429 `insufficient_quota` / billing | `PROVIDER_BILLING` | false | true |
| `moderation_blocked` (or Responses refusal) | `MODERATION_BLOCKED` | false | true |
| 400 / other 4xx | `PROVIDER_REJECTED` | false | true |
| 401/403 | `PROVIDER_AUTH` | false | true |
| 404 / `model_not_found` | `PROVIDER_MODEL_INVALID` | false | true |
| 300 s timeout or connection lost after send | `PROVIDER_TIMEOUT` / `PROVIDER_CONNECTION_LOST` | false | true (outcome unknown) |
| Download/sharp failure before the call | `PREP_FAILED` | only if Worker 5xx | false |
| Upload/complete failure after the call | `SAVE_FAILED` | false | true |

`providerCalled:true` on a 429 means "a request reached the provider"; no image was produced so the server should treat
it as uncharged and may release the reservation when it requeues.

## 2. Verified OpenAI facts

Checked 2026-11-12 against the official docs (no API calls were made).

| Fact | Value | Source |
|---|---|---|
| Endpoints | `POST /v1/images/generations` (JSON), `POST /v1/images/edits` (multipart or JSON), Responses `POST /v1/responses` | image-generation guide; reference pages |
| Model support | `gpt-image-2.6-sunburst`: image generation + image edit endpoints **only** (not Responses/Chat); text+image in, image out | https://developers.openai.com/api/docs/models/gpt-image-2.6-sunburst |
| Multipart field for multiple reference images | **`image[]`** repeated once per file (docs example: `-F "image[]=@a.png" -F "image[]=@b.png"`) | https://developers.openai.com/api/reference/resources/images/methods/edit |
| Max input images per edit | **16** for GPT image models (`images` array minItems 1, maxItems 16; "For GPT image models, you can provide up to 16 images") | same |
| Multipart `markup` | single file, transparent PNG, same dimensions as the first image (after orientation), ≤ 50 MB, ≤ 16,777,216 px; cannot combine with `mask`; edits only | image-generation guide; edit reference |
| Mask | must match image format/size, alpha channel, < 50 MB (unused here) | image-generation guide |
| Input file formats / byte limit | **Not stated** on the edit reference. The processor sends PNG or JPEG ≤ 2048 px (typically < 3 MB); `image_url` string max 20,971,520 chars for JSON requests | edit reference |
| `prompt` | 1–32,000 chars | generate/edit reference |
| `size` | `auto`, `1024x1024`, `1536x1024`, `1024x1536`; gpt-image-2.x accept custom `WxH`: both multiples of 16, ratio 1:3–3:1, max edge 3840, 655,360–8,294,400 px; > 2560x1440 experimental | generate reference; image-generation guide |
| `quality` | `low`, `medium`, `high`, `auto` for all GPT image models. `xhigh`/`max`: guide says GPT-Image-2.6 Sunburst/Flare support them; the generate/edit **reference** pages list them only for `gpt-image-2.5-sunburst/flare`. **Conflict — see open questions.** | generate reference vs. guide |
| `complexity` | `low`, `medium`, `high`; defaults to `high` if omitted; independent of `quality` | image-generation guide |
| `output_format` | `png` (default), `jpeg`, `webp`, `gif`, `svg` (svg: generations only, n=1) | generate reference |
| `output_compression` | 0–100, jpeg/webp only | generate reference |
| `moderation` | `auto` (default), `low` | generate/edit reference |
| `n` | 1–10 (processor always uses 1) | generate reference |
| Response | `{created, data:[{b64_json, revised_prompt?}], output_format, quality, size, usage}`; `url` unsupported, `revised_prompt` not returned by GPT image models | generate/edit reference |
| `usage` | `{input_tokens, output_tokens, total_tokens, input_tokens_details:{text_tokens,image_tokens}, output_tokens_details?:{text_tokens,image_tokens}}` | generate/edit reference |
| Pricing (2.6) | text in $5, image in $8, image out $30 per 1M tokens (cached text $1.25, cached image $2) | model page |
| Latency | complex prompts can take up to 2 min (hence the 300 s timeout) | image-generation guide |
| Errors | `error.type = image_generation_user_error`: do not retry unchanged. `error.code = moderation_blocked` (+ optional `moderation_details`). Retry rate-limit and server errors with backoff; **do not auto-retry quota errors** | image-generation guide |
| Vision input (Responses) | `input_image` with `image_url` = URL or base64 data URL (or `file_id`); PNG, JPEG, WEBP, non-animated GIF; ≤ 512 MB payload, ≤ 1,500 images; `detail` `low|high|original|auto` | https://developers.openai.com/api/docs/guides/images-vision |
| Structured output (Responses) | `text.format = {type:"json_schema", name, schema, strict:true}`; result at `output[].content[]` `type:"output_text"` (`text` = JSON string); refusals are `type:"refusal"`; check `status:"incomplete"` before parsing; strict schemas need `additionalProperties:false` and every property `required` (nullable via type array/`anyOf`) | https://developers.openai.com/api/docs/guides/structured-outputs |
| Org verification | GPT image models may require API Organization Verification | image-generation guide |
| Deprecation | `gpt-image-1` shut down 2026-10-23 | edit reference |

Reference selection in the processor: parent first, then in server order; `maxReferences` (claim or job field,
default 16) is the slot budget. Items tagged `sheet` (and any overflow, lowest importance first) are packed into
labelled contact sheets of ≤ 6 tiles (3 columns, SVG labels). Markup does not use an image slot. Install `fonts-dejavu-core`
on the host so sheet labels render.

### Open questions for the lead

1. `xhigh`/`max` quality on `gpt-image-2.6-*` (guide yes, reference pages no) — confirm with the staging smoke test
   before enabling the `max` preset; the 400 would come back as terminal `PROVIDER_REJECTED`.
2. Markup on 2.6: the edit reference says markup is "supported on GPT Image 2.5 only", the guide shows it on `gpt-image-2.6-flare`.
3. No documented per-file byte limit for edit inputs; the processor keeps inputs small by design.
4. The claim payload shape beyond the contract: the processor reads `job.{id,kind,model,quality,complexity,size,outputFormat|output_format,prompt,moderation?}`,
   `references[].{url,role,label,sheet?}` (`role`: `parent|compartment|tool|mount|markup|subject|…`; recognize/verify use `subject`),
   `spec.candidates:[{equipmentId,name}]` for recognize, and optional `maxReferences`. Output usage is forwarded verbatim (OpenAI snake_case).

## 3. Install, update, rollback

On each node (aiw-k8, aiw-7070), from a checkout of the repo at the wanted ref (needs `rsync`, Node 22, `fonts-dejavu-core`):

```bash
git fetch && git checkout <ref>
sudo bash processor/deploy/install.sh
```

`install.sh` is idempotent: creates user `l1img` (no shell/home), rsyncs `processor/` + `shared/` to
`/opt/l1-image-processor/` (root-owned, read-only to `l1img`), runs `npx -y npm@11.6.2 ci --omit=dev`, creates
`/etc/l1-image-processor/` (0750 root:l1img), **verifies** an existing env file is 0640 root:l1img, installs the unit,
`daemon-reload`, `enable`, `restart`, then runs `--health`. It never creates or prints secrets.

**Update** = check out the new ref and re-run the installer. **Rollback** = check out the previous git ref (tag/SHA of
the last good release) and re-run the installer; there is no other state on the node. Do nodes one at a time so one
stays active.

## 4. Secrets (never via argv or shell history)

`/etc/l1-image-processor/env` holds names listed in `processor/deploy/env.example`. Provision with stdin only:

```bash
sudo install -m 0640 -o root -g l1img /dev/null /etc/l1-image-processor/env     # first time only
read -rsp 'L1_OPENAI_API_KEY: ' v; echo; printf 'L1_OPENAI_API_KEY=%s\n' "$v" | sudo tee -a /etc/l1-image-processor/env >/dev/null; unset v
```

Repeat for `L1_API_BASE`, `L1_ACCESS_CLIENT_ID`, `L1_ACCESS_CLIENT_SECRET`, `L1_NODE_NAME` (e.g. `aiw-k8`). Edit/replace a
value with `sudoedit /etc/l1-image-processor/env` (the editor buffer is not shell history). The OpenAI key lives only in this
file: never `/etc/environment`, never AIW agent jobs, never the repo. The OpenAI project must also have a hard
provider-side monthly budget (owner action). Set `L1_DRY_RUN=1` to exercise the whole pipeline without any OpenAI call.

**Cloudflare Access service token** (owner, Zero Trust dashboard): Access → Service Auth → Create Service Token, name
`l1-image-processor`, copy Client ID/Secret once into the env file as above. Add a policy on the Worker's
`/api/processor/*` path with action *Service Auth* including that token. **Rotation**: create a second token, add it to
the policy, update the env file on one node and restart it, verify with `--health`, repeat on the other node, then delete
the old token (both nodes stay up throughout because both tokens are valid during the overlap).

## 5. Operations

- Logs: `journalctl -u l1-image-processor -f` (JSON lines; secrets, auth headers, prompts > 200 chars and image data are redacted).
- Status: `systemctl status l1-image-processor`; check: `sudo -u l1img node --env-file=/etc/l1-image-processor/env /opt/l1-image-processor/processor/src/index.js --health` (exit 0 = config valid and Worker reachable/authorised).
- One-shot: `--once` claims and runs at most one job, then exits.
- **Failover**: both nodes are active and claim from the same queue; the atomic claim + 120 s lease means a dead node's
  job is re-queued by the server (before `generating`) or marked `OUTCOME_UNKNOWN` (after). No manual action.
- **Kill switch**: an admin sets `ai.enabled=false` in the Studio admin settings; the Worker stops accepting jobs. To stop
  the processor itself: `sudo systemctl stop l1-image-processor` (graceful, up to 150 s).
- **Cost controls**: server-side caps (`budget.*`, concurrency, preset allowlist), `L1_MAX_PARALLEL` (default 1) per node,
  `quality` capped by presets, the smoke test refuses anything above `low`, plus the provider-side budget.
- **Live smoke test (owner, costs a few cents at most)**: `L1_OPENAI_API_KEY=… node scripts/smoke-openai.mjs --i-understand-this-costs-money`
  (one 1024x1024 `low` flare image; prints usage and estimated cost).

## 6. Troubleshooting

| Symptom | Likely cause / action |
|---|---|
| Service exits at start, journal "Invalid configuration: X is required" | Missing variable in the env file (value never printed); fix and restart |
| `--health` exit 1 "Worker rejected the request" | Access token wrong/expired or policy missing (401/403/redirect); rotate token |
| `--health` exit 1 "unreachable" | DNS/network from the node; `curl -sI $L1_API_BASE` |
| Jobs fail `PROVIDER_BILLING` | OpenAI quota/budget exhausted; top up or raise the project budget (never auto-retried) |
| Jobs fail `PROVIDER_AUTH` | Wrong/revoked key in env file |
| `PROVIDER_REJECTED` for `max` quality | Model may not accept `xhigh`/`max` (see open question 1); use `high` |
| `MODERATION_BLOCKED` | Provider safety filter; user must change instructions/photos |
| `OUTCOME_UNKNOWN` jobs | Node died or timed out after the call began; user may retry explicitly |
| Contact-sheet labels are boxes/blank | Install `fonts-dejavu-core` and restart |
| Install fails "env must be 0640 root:l1img" | `sudo chown root:l1img /etc/l1-image-processor/env && sudo chmod 0640 …` |
| Job stuck `queued` | Both services stopped, `ai.enabled=false`, or concurrency limits; check `journalctl` on both nodes |
