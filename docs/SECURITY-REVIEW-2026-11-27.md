# Production security review | 27 November 2026

Wave 5 review candidate `201321031293999003bb0ae55a29dbd250ac96ce`. Production source under review `29448aea3fa10d226ef82ec5bf0a65e723d6ec39` on `feat/model-council`. The comparison covers 88 commits and 305 files, with 24,389 insertions and 479 deletions. Of those files, 174 are under `apps/server/src`, `packages` and `scripts/cloud-linux`. The review also covers the backup and restore controls expressly included in scope, which were already in the Wave 5 candidate. [Production comparison](https://github.com/ahmadalwakai/Mohassan-AI/compare/201321031293999003bb0ae55a29dbd250ac96ce...29448aea3fa10d226ef82ec5bf0a65e723d6ec39)

## Review status

Locations in the evidence below refer to `29448ae`. Scenarios describe the conditions and impact seen in source. Verification uses local fixtures, mocks and disposable state. The production deployment, live data, model files and operational settings were outside the verification environment.

The review records 22 Medium and Low findings. Sixteen have tested fixes. The other six require product or operational decisions, with additional verification items collected below.

## HTTP route inventory

The global hooks require the service credential and a configured web Origin on writes, then a live session for every registered route outside `PUBLIC_ROUTES`. The member check uses the registered method and path template. Generated `HEAD` uses the `GET` decision. A signed-in user outside the owner/member roles reaches only the existing limited member-data exceptions. See `apps/server/src/app.ts:228–259` and `apps/server/src/members.ts:23–67`.

| Method | Path | Registration at production | Authorization and input |
| --- | --- | --- | --- |
| GET, HEAD | `/api/chat/monitors` | `apps/server/src/monitors/routes.ts:34` | Member allow-listed. Owner rollout requires the owner, all-account rollout allows members. Account-scoped list and optional conversation UUID or v2 state selector. |
| POST | `/api/chat/monitors` | `apps/server/src/monitors/routes.ts:40` | Same rollout check. Account-scoped approval, candidate selection, action confirmation or proactive-offer preference. Approval rechecks role, locks the proposal and reserves member quota before activation. |
| POST | `/api/chat/monitors/:id/pause` | `apps/server/src/monitors/routes.ts:56–60` | Same rollout check. Strict empty body and UUID. Transaction changes the session account's monitor. |
| POST | `/api/chat/monitors/:id/resume` | `apps/server/src/monitors/routes.ts:56–60` | Same rollout check and ID/body validation. Rechecks source eligibility as part of the state change. |
| POST | `/api/chat/monitors/:id/stop` | `apps/server/src/monitors/routes.ts:56–60` | Same rollout check and ID/body validation. Account-scoped state change. |
| GET, HEAD | `/api/chat/monitors/decision-recording` | `apps/server/src/monitors/routes.ts:64` | Same rollout check. Returns the session account's recording setting. |
| POST | `/api/chat/monitors/decision-recording` | `apps/server/src/monitors/routes.ts:65–67` | Same rollout check. Strict boolean, writes to the session account. Opt-out removes its decision and feedback data through the recording transaction. |
| POST | `/api/chat/monitors/alerts/:alertId/feedback` | `apps/server/src/monitors-phase1/feedback.ts:13–48` | Same rollout check. UUID and closed rating/reason schema, then recording opt-in and an account-scoped monitor alert lookup in the write transaction. |
| GET, HEAD | `/api/models` | `apps/server/src/models-routes.ts:92–102` | Owner-only through the central default-deny gate and a second role check. Lists model metadata and availability. |
| POST | `/api/models/:id/run` | `apps/server/src/models-routes.ts:104–152` | Same owner checks. Registry ID and strict text/image schema, with a route-specific upload limit and rate limit. |
| GET, HEAD | `/api/sites/:id/p/:token/*` | `apps/server/src/sites.ts:317–321` | Session-free preview capability. Service credential still required at Fastify. UUID, fixed-length token and constrained file path. HMAC validation precedes file reads and binds the read to the current revision. |

The eight monitor registrations are conditional on the monitor control being installed. The per-route rollout check is in `apps/server/src/monitors/routes.ts:24–33` and `apps/server/src/monitors-phase1/rollout.ts:6–20`. Existing chat routes now dispatch with the authenticated Windows session scope and carry monitor, v5 and council data. Existing metrics JSON and CSV routes remain owner-only and grow new aggregate fields. The models view and monitor controls reuse the web API catch-all. Its model upload exception sets byte and time limits while the backend retains authorization. See `apps/server/src/app.ts:272–273,497–529`, `apps/server/src/windows-chat-session.ts:12–21`, `apps/server/src/ops/metrics/index.ts:83–89` and `apps/web/app/api/[...path]/route.ts:29–46`.

## HTTP and authorization findings

### Medium | A council choice could survive an owner-role change

- **Location** `apps/server/src/command-chat.ts:1513–1537,1553–1567,1608–1609`.
- **Scenario** A delegated owner starts a chat turn. The account loses owner privileges while the council is working, and the final transaction declines to include the council record. The replacement answer and status had already overwritten the pipeline result. The same signed-in account can receive that newly published text as a member.
- **Fix** The publication transaction applies a council replacement only while the owner grant is held. If the grant ends, the original pipeline answer and status remain available for publication. Regression in `tests/owner-model-council.test.ts`.

### Medium | Windows companion consent outlived the owner grant

- **Location** `apps/server/src/members.ts:24–32,100–107`, `packages/windows/src/index.ts:170–186,189–210` and `packages/windows/src/session.ts:27–32`.
- **Scenario** An administrator removes a delegated owner role while the account's ordinary session remains valid. The same session can still back an unconsumed companion pairing or a short-lived consent grant because the companion uses session liveness. Polling can continue to accept frames and deliver pending input while that grant is active.
- **Fix** The pairing transaction and the companion grant dispatch revalidate the owner grant. Polling fences account access before taking the device lock and revokes consent and pending work when owner access is lost. The browser session can remain an ordinary member session. Regression in `packages/windows/src/windows.test.ts`.

### Low | Preview URL remains readable for the current revision

- **Location** `apps/server/src/sites.ts:72–74,317–321`, `apps/server/src/site-preview.ts:11–29` and `apps/web/app/api/[...path]/relay-security.ts:26–30`.
- **Scenario** A preview URL copied into a support ticket or retained by ingress access logging allows a later holder to read the draft while the revision stays current. The sandbox, no-referrer header and revision-specific token reduce leakage. The token has no independent expiry.
- **Owner decision** Decide whether preview links need independent expiry or revocation. Verify preview path redaction at the actual ingress.

## Retained data and diagnostics

### Medium | Judge filtering missed common credential forms

- **Location** `apps/server/src/sensitive-credential-text.ts:9–18`, `apps/server/src/assistant/judge-shadow-privacy.ts:5–12` and `apps/server/src/assistant/judge-shadow.ts:106–113`.
- **Scenario** In a workspace that records owner judge text, the owner pastes a diagnostic URL carrying a generic token or a JSON token response into a turn. The detector can retain the original credential in a full-text diagnostic row.
- **Fix** Extend the shared detector to cover those fields. Preserve the verdict and metadata while omitting the unsafe text. Regression in `tests/assistant-judge-shadow.test.ts`.

### Medium | Monitor decision features retained credential-derived lexical data

- **Location** `apps/server/src/monitors/decision/features.ts:26–51`, `packages/scratch-classifiers/src/features.ts:70–132`, `apps/server/src/monitors/decision/records.ts:47–53` and `scripts/monitor-decision/export.ts:35–56`.
- **Scenario** An opted-in owner includes recognizable credentials in earlier context, then makes an ordinary monitoring request. Deterministic word and character buckets from the earlier text can survive in the stored proposal and in an export tied to that account's activity.
- **Fix** Redact known credential material before feature computation and omit proposal records whose decision context contains recognized credentials. Keep normal monitor proposal behavior. Regression in `tests/monitor-decision-feature-privacy.test.ts`.

### Medium | Keyed chat retries could duplicate council records

- **Location** `apps/server/src/chat-request-ledger.ts:33–54`, `apps/server/src/command-chat.ts:4675–4679` and `apps/server/src/assistant/model-council.ts:412–421`.
- **Scenario** With the council enabled independently of v5, a keyed write returns a conversation with a council record. The retry ledger can store a second copy of the losing candidates and replay stale content independently of later conversation read controls.
- **Fix** Write conversation references for council or v5 responses and rebuild legacy council retries via the current account-scoped conversation view. Existing replay expiry and deletion controls still apply to past stored rows. Regressions in `tests/chat-idempotency.test.ts`.

## Server-side requests and monitor sources

Monitor URLs pass the source policy before persistence and are checked again when used. The runtime uses bounded account budgets, one row lease per check and a bounded work batch. GitHub reads use the fixed public REST origin with bounded response parsing and GitHub API backoff. PDF reads use the guarded fetch path and a separate parser worker thread. Visual reads apply the guarded request policy to browser traffic, then use a local OCR reader with a confidence threshold. The host-side decisions cover browser egress and resource isolation.

### Medium | PDF change state could keep credentials

- **Location** `apps/server/src/monitors/sources/pdf.ts:80–82,121–137,176–181` and `apps/server/src/monitors/evaluation.ts:114–118`.
- **Scenario** A PDF at an approved public address acquires lines with credential-like fields. Excerpt filtering protects the displayed excerpt, but PDF change blocks can preserve the original text. A credential-bearing HTTP validator can also be retained and sent back on a later check.
- **Fix** Apply the monitor evidence filter before constructing change blocks and reject unsafe validators from both responses and older cache state. Regressions in `tests/smart-monitor-pdf.test.ts`.

### Medium | Visual previews and scheduled checks could start browsers concurrently beyond the check limit

- **Location** `apps/server/src/monitors/chat.ts:146–153`, `apps/server/src/monitors/sources/visual.ts:54–77`, `apps/server/src/monitors/sources/visual-browser.ts:148–158` and `apps/server/src/monitors/runtime.ts:236–266`.
- **Scenario** Several eligible visual previews arrive while scheduled checks are also running. The daily budget constrains total use, while the scheduled worker's limit does not account for interactive previews. Several Chromium and OCR jobs can compete for host memory and CPU.
- **Fix** Share the existing scheduled-read concurrency budget for both paths through the same reader. Defer excess reads before spending daily budget, and release the slot when the job settles. Regression in `tests/smart-monitor-source-visual.test.ts`.

### Low | An element could resize between the visual bounds check and capture

- **Location** `apps/server/src/monitors/sources/visual-browser.ts:188–205`.
- **Scenario** A page changes the size or position of its watched element during or after scrolling. The element screenshot calculates its own bounds, so the earlier size check does not constrain that capture. The byte cap applies after capture.
- **Fix** Compute and check the crop after scrolling. Pass the same viewport-bounded rectangle to the capture call. Regression in `tests/smart-monitor-source-visual.test.ts`.

### Low | Conversation polling loaded feedback beyond the visible message window

- **Location** `apps/server/src/monitors-phase1/feedback.ts:52–69`, `apps/server/src/monitors/chat.ts:204–211`, `apps/server/src/monitors/store.ts:294–302` and `apps/server/src/command-chat.ts:1088–1098,1121`.
- **Scenario** A long-running conversation accumulates alerts across successive monitors. Each detail poll joins and serializes historic conversation feedback beyond the bounded message and card views.
- **Fix** Fetch feedback for visible assistant messages and listed monitor cards. Each listed card keeps its alert history. Regression in `tests/monitor-alert-feedback.test.ts`.

### Network and parsing coverage

| Path | Production source and control |
| --- | --- |
| Monitor web, feed and search | `apps/server/src/monitors/sources.ts:70–75,174–217,232–253,326–379,423–447` checks saved destinations, redirects, robots rules and reading budgets. `packages/browser/src/network.ts:45–97,102–110` validates HTTPS and DNS, rejects private or mixed answers, pins the validated address at connection time, bounds body and time, and strips sensitive headers on cross-origin hops. |
| GitHub monitor | `apps/server/src/monitors/sources/github-network.ts:5–23,39–42,64–105` fixes the anonymous API origin and revalidates operation and query on redirects. It bounds attempts, body size and time. `apps/server/src/monitors/store.ts:190–208` shares the admission and response backoff state through the database. |
| PDF monitor | `apps/server/src/monitors/sources/pdf.ts:128–173` checks every hop and caps the PDF download. `packages/learning/src/pdf.ts:4–27,35–61` limits pages, extracted text, time and concurrent parser workers. The worker gets an empty inherited environment and is terminated on cancellation. |
| Visual monitor | `apps/server/src/monitors/sources/visual-browser.ts:8–16,44–75,148–158` applies the guarded fetch path to same-origin GETs, strips cookies and caps requests and capture. `packages/browser/src/engine.ts:39–77` disables browser service workers and WebSockets and uses a denying proxy. Chromium's process isolation and host egress remain operational checks. |
| Council web search | `apps/server/src/command-chat.ts:1482–1495` applies the public-query guard, bounds the selected sources and reads through the chat page reader. `apps/server/src/app.ts:465–496` applies SafeNetwork, robots, download limits and public cache rules. |
| Model runs | `apps/server/src/models-routes.ts:104–152` accepts text, an in-body passage or an in-body image. There is no request-supplied fetch URL. Registry files are selected by model ID and resolved from operator-configured local roots. |

## Model runs, council and resident worker

### Medium | Council round timeouts left work running

- **Location** `apps/server/src/assistant/model-council.ts:207–225,329–339,358–385`, `packages/model-relations/src/manager.ts:392–407` and `packages/model-relations/src/runtime.ts:125–168`.
- **Scenario** A council round times out on search or a model. The user-facing round returns, while the outstanding operation can still occupy a resident queue entry, a network request or runtime CPU capacity. Several ordinary owner turns can compound the backlog.
- **Fix** Propagate the round's abort signal into search, the resident queue, understanding and the model runtime. Keep a running model's resource reservation until its work settles. Regressions in `tests/model-council.test.ts` and `packages/model-relations/src/runtime.test.ts`.

### Medium | The IPC output budget was applied after buffering and parsing

- **Location** `packages/execution-integration/src/permanent-worker.ts:288–310,333–338`.
- **Scenario** A faulty subprocess starts a frame beyond its advertised output budget and leaves it incomplete. The host can buffer toward the global protocol limit and wait for a newline or timeout instead of rejecting at the lower worker budget.
- **Fix** Enforce the negotiated budget while receiving the frame, before buffering or JSON parsing. Keep cumulative output accounting. Regression in `packages/execution-integration/src/permanent-worker.test.ts`.

### Medium | Council excerpts could preserve partial credentials

- **Location** `apps/server/src/assistant/model-council.ts:124–129,341–347,369–374,412–421` and `apps/server/src/command-chat.ts:834–838`.
- **Scenario** A source title or candidate contains a credential near the excerpt boundary. Truncation can remove the part needed for exact vault matching before the conversation is written.
- **Fix** Apply the existing chat scrubber to the full title and candidate text before taking excerpts. Regression in `tests/model-council.test.ts`.

### Low | Model image admission trusted the declared media type

- **Location** `apps/server/src/models-routes.ts:123–132`, `packages/contracts/src/models.ts:39–42` and `packages/vision/src/image.ts:34–46`.
- **Scenario** An owner selects an image with mismatched metadata or an unsupported image format. The server chooses a temporary extension from the declaration and forwards the bytes to a decoder that can accept additional formats.
- **Fix** Check the declared format against the image signature before creating the temporary directory or invoking OCR. Request size limits, an isolated temporary directory, mode-0600 input and cleanup in the route's `finally` continue to apply. Regressions in `tests/models-routes-security.test.ts`.

### Low | The models page could fall back to a second v5 worker

- **Location** `apps/server/src/models-routes.ts:140–152`, `apps/server/src/app.ts:524–526` and `apps/server/src/v5-chat.ts:17–33`.
- **Scenario** The v5 resident pathway is unavailable or disabled while artifacts are present. The models page could submit the same model ID to the general runtime, outside the resident worker's identity and queue.
- **Fix** Require the resident path for v5. Report the run as unavailable and omit the page-use marker when the resident path is unconfigured. Regression in `tests/models-routes-security.test.ts`.

### Medium | An answer withheld by the judge could corroborate a replacement

- **Location** `apps/server/src/assistant/model-council.ts:275–289,395–405`.
- **Scenario** A council candidate is withheld by the judge. Its text can still supply the agreement a grounded candidate requires to replace the pipeline reply.
- **Fix** Exclude withheld answers from the agreement count. The private council record still marks the withheld candidate and its verdict. Regression in `tests/model-council.test.ts`.

The worker starts an isolated Python interpreter with a deliberately limited environment and validates its announced identity. It discards stderr and logs fixed health states. Python validates frames and configuration before loading pinned weights, and enforces memory, CPU and parser limits. It returns structured output that TypeScript validates again. v5 output goes to the chat publication boundary as labelled text and cannot itself invoke tools or publish action receipts. v5 receives bounded, scrubbed same-conversation history. The council reader receives current web text, while v5 receives the conversation history. Subsequent pipeline turns escape and frame history as untrusted data. See `apps/server/src/model-worker.ts:34–68,95–116`, `packages/execution-integration/model_worker/worker.py:88–107,120–161`, `packages/execution-integration/model_worker/runtime.py:83–97,138–199,230–243`, `packages/execution-integration/model_worker/checkpoints.py:53–95`, `packages/execution-integration/src/permanent-worker.ts:275–285`, `apps/server/src/command-chat.ts:1452–1465,1507–1547,2514–2516,3802–3815` and `apps/server/src/assistant/brain.ts:459–472,493–514`.

### Medium | Public evidence can lend authority to misleading prose

- **Location** `apps/server/src/command-chat.ts:1482–1495`, `apps/server/src/assistant/model-council.ts:136–169,273–298,358–375,395–425` and `apps/web/components/markdown.tsx:5–27`.
- **Scenario** An apparently relevant public page or search snippet contains misleading or instruction-like prose. It can enter the reader's prompt and satisfy a lexical evidence check. Related model answers can repeat the same claim, and a selected answer can expose a clickable HTTP(S) link or be reused as conversation history. The reviewed path publishes prose.
- **Owner decision** Decide whether any model replacement requires a fetched page and independent provenance, and whether to restrict clickable citations to verified sources. Decide how prior experimental replies should be shown and exported after an owner's role changes. Turn-time fencing is covered by the authorization fix.

## Production metrics, backup and recovery

Metrics requests are owner-only and use no-store responses. Request records use method, route template, role and status. Worker and monitor metrics use bounded aggregates with no prompt, reply, URL or upload fields. Snapshot parsing uses a fixed schema, the writer uses restricted permissions and snapshot/history sizes are bounded. The API's monitor feedback aggregate still runs synchronously on reads. See `apps/server/src/ops/metrics/index.ts:34–42,66–89`, `ops/metrics/request.ts:24–38`, `ops/metrics/monitor-feedback.ts:7–32`, `ops/metrics/snapshot-format.ts:13–51`, `ops/metrics/snapshots.ts:6–8,90–93,114–146` and `ops/metrics/store.ts:275–307`, all under `apps/server/src`.

### Medium | The v5 preflight missed the actual interpreter and runtime limits

- **Location** `scripts/cloud-linux/preflight-wave-6.mjs:89–111,186–197`, `apps/server/src/model-worker.ts:100–112` and `scripts/cloud-linux/model-worker.v5.example.json:25–33`.
- **Scenario** An operator preserves the pinned model identity but changes the configured resident interpreter or its resource and queue limits. The related readiness checks can still pass, allowing a restart with an unavailable worker or weaker resource bounds.
- **Fix** Probe the resolved interpreter selected by the resident worker configuration as the service account and compare the configuration against the reviewed profile, allowing relocated pinned artifact paths. Regression in `tests/preflight-wave-6.test.ts`. The live virtual environment and its package imports need host verification.

### Medium | Host preparation runs privileged dependency code from a service-writable tree

- **Location** `scripts/cloud-linux/prepare.sh:30,66–83`.
- **Scenario** During maintenance, service-account processes or dependency lifecycle scripts can still alter the checkout before the privileged Playwright OS dependency phase uses it. Stopping the API unit alone does not establish the integrity of that path.
- **Owner decision** Separate the root-only operating-system package step from service-owned dependency installation. Choose an independently verified dependency input and a maintenance procedure that covers remaining service processes.

### Medium | The restore drill shares the production PostgreSQL cluster

- **Location** `scripts/cloud-linux/backup-metadata.mjs:13,124–130,390–409` and `scripts/cloud-linux/mohassan-restore-drill.service:7–23`.
- **Scenario** The drill restores a dump as the cluster superuser into a scratch database on the live cluster. A valid large backup competes for live disk and I/O. After a prior compromise, a digest that accompanies a dump verifies integrity but does not independently establish trust in the archive's contents.
- **Owner decision** Choose an isolated restore cluster or host with explicit resource limits, or accept the same-cluster drill for trusted operator-generated dumps. [PostgreSQL 18 pg_restore documentation, retrieved 2026-11-27](https://www.postgresql.org/docs/18/app-pgrestore.html)

### Low | The pull account exposes the newest complete archive to its key holder

- **Location** `scripts/cloud-linux/prepare.sh:34–53,105–138`, `scripts/cloud-linux/mohassan-backup-pull.sshd.conf:3–14`, `scripts/cloud-linux/backup-ssh-command.sh:7–23` and `scripts/cloud-linux/backup-publish.sh:39–61`.
- **Scenario** The dedicated account and forced command restrict shell access, forwarding, TTY and user startup files. A holder of the configured key can read the newest published backup pair by design. Host-only status can report a good dump before an independent pull is verified.
- **Owner decision** Verify the effective SSH policy for the real pull client, including inherited CA and authentication settings. Confirm host permissions, pull-key rotation, independent encrypted storage, retention and a verified off-host receipt. The local drop-in passed an isolated syntax and policy check.

### Low | On-demand metrics share database capacity with application requests

- **Location** `apps/server/src/ops/metrics/index.ts:66–75`, `apps/server/src/ops/metrics/monitor-feedback.ts:8–22` and `packages/database/src/index.ts:85–90`.
- **Scenario** Repeated owner scraping or accumulated feedback can increase aggregate query load on the application pool even though the output stays small.
- **Owner decision** Set a freshness and latency budget for metrics and measure the query plan and load on disposable PostgreSQL with representative volume before adding cache, query deadlines or an index.

## PR #9 and Wave 5 applicability

PR #9 was open at `1bb51dd998c790db4894d17780585f054dd27384` when checked on 27 November 2026. Its relevant fixes were ported through Wave 5. The Wave 5 review head `9dcebb8` is in production's ancestry through `86bb188`. The SafeNetwork redirect leg was added by `25766e4`. [PR #9](https://github.com/ahmadalwakai/Mohassan-AI/pull/9) · [Wave 5 review](SECURITY-REVIEW-WAVE-5-2026-11-25.md)

| Previously reviewed control | Production applicability |
| --- | --- |
| Redirect header filtering | Both legs hold. The AgentBrowser subresource path filters on an origin change at `packages/browser/src/agent-browser.ts:825–844`. `SafeNetwork.text` carries the filtered header set through later hops at `packages/browser/src/network.ts:102–110`. Both call the shared passive-header allowlist at `packages/browser/src/redirect-headers.ts:1–5`. Both focused redirect suites passed. |
| Private fetch, Git and shared cache boundaries | Web Push sends a pinned request without following redirects at `apps/server/src/web-push-transport.ts:5–14`. The Git policy uses pinned resolution at `packages/coding/src/git-remote-network.ts:9–18`. The shared page cache excludes private responses at `apps/server/src/assistant/page-cache-policy.ts:3–15`. Local tests cover each path. |
| Session projection, anonymous request limiting and preview isolation | Credential fields stay out of auth JSON. The relay accepts only the verified ingress IP header, streams capped uploads and reapplies preview CSP, framing and referrer controls. The preview validates capability before snapshot reads. See `apps/server/src/member-data-bootstrap.ts:40–62`, `request-rate-limit.ts:10–19`, `site-preview.ts:12–29` and `apps/web/app/api/[...path]/route.ts:23–46`. Live ingress behavior remains to be verified. |
| Quota, retry and durable admission | Transactional member quota and mutation receipts remain. Deleting a conversation removes cached content. Durable drafts and run deadlines retain their fences. See `apps/server/src/member-run-quota.ts:32–43`, `chat-request-ledger.ts:23–31,45–61`, `command-chat.ts:4225,4302,4601` and `assistant/long-run/execution-guards.ts:20–47`. The council introduced an additional receipt-retention case fixed in this review. |
| Windows session binding, revocation and frames | Dispatch uses the authenticated session. Pairing and grant consumption recheck its liveness. Sign-out revokes by the validated session ID. Replacing a grant clears the frame. See `apps/server/src/app.ts:299,529` and `packages/windows/src/index.ts:56–72,140–146,175–180,198–218`. This review adds the current-owner check for companion delivery. |
| Diagnostics, member export and notifications | Fixed database URL diagnostics, share and export filtering, push registration limits and shadow filtering remain. The judge filter had a wider credential-text gap fixed here. APNs and Web Push now order work by account position before applying batch limits. Delivery lifetime and preview retention remain decisions. See `packages/database/src/connection-url.ts:1–7`, `apps/server/src/notification-security.ts:15–31`, `background-apns-delivery.ts:14–17,44–47` and `notifications-store.ts:347–374`. |

Paths shown without additional directory prefixes in the table are under `apps/server/src`.

## Owner decisions

1. **Council output and history.** Set the evidence and judge-failure policy for replacing replies, including whether search snippets count and whether source agreement must be independent. Set the visibility, export and retention policy for already-stored experimental replies and losing candidates after an owner role change. The same-account detail view includes historic model replies and metadata. Public sharing rejects v5 and chosen council replies. See `apps/server/src/command-chat.ts:1082–1106`, `conversation-share.ts:64–72` and `conversation-share-storage.ts:133–164`.
2. **Model-store ownership and host capacity.** Registry IDs prevent HTTP users from selecting artifact paths. Operator environment overrides and local manifests can resolve outside the root through links. The image adapter reads local OCR files before validating their contents, and the general runtime's local budget is separate from the resident worker and chat OCR. Verify deploy-only write access throughout the model store and virtual environment, choose an artifact symlink and integrity policy, and measure a combined memory and CPU envelope on the real host. See `packages/model-relations/src/registry.ts:344–369,386–409,428–449,473–476`, `adapters.ts:107–114`, `runtime.ts:93–104,125–168,246–254,276–289` and `apps/server/src/app.ts:499–506`.
3. **Parser and subprocess containment.** Verify the VM's outbound policy and browser containment before widening visual monitoring. Playwright Chromium sandboxing defaults off when it is unspecified, and the visual path runs site JavaScript. The PDF parser uses V8 worker heap limits inside the API process. The Python worker uses process limits and no-new-privileges under the service UID. Decide whether separate UIDs or network/filesystem namespaces are required, and verify CPU, shared memory and practical recovery times on the VM. See `packages/browser/src/engine.ts:39–54`, `packages/learning/src/pdf.ts:21–27`, `packages/execution-integration/model_worker/containment.py:20–40` and `scripts/cloud-linux/mohassan.service:7–26`. [Playwright BrowserType launch options, retrieved 2026-11-27](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-chromium-sandbox)
4. **Private record retention.** Choose retention and deletion rules for historical judge text, cached PDF evidence, and existing monitor decisions. Detached monitor exports retain stable hashed IDs, exact timestamps and lexical features that relate to a person's use of the service. Opting out deletes the service's decision rows. Backups and exports need their own removal policy. Decide whether metadata-only judge logs and aggregate monitor data meet the use cases. Review any historical exposure privately before deciding on credential rotation. See `apps/server/src/assistant/judge-shadow.ts:72–84,105–114`, `judge-shadow-log.ts:65–85`, `monitors/decision/records.ts:16–23,37–53` and `scripts/monitor-decision/export.ts:35–56`.
5. **Delivery, metrics and shadow resources.** Choose a terminal push delivery lifetime and decide whether to retain optional excerpts when previews are off. Define alert history pagination if full card histories become expensive. Measure metrics reads against representative PostgreSQL data and set a reporting budget. Before enabling model-relations shadow, set a concurrency ceiling and journal rotation policy. See `apps/server/src/monitors/delivery.ts:58–60`, `background-notification-payload.ts:53–62`, `ops/metrics/index.ts:66–75` and `assistant/model-relations-shadow.ts:50–78`.
6. **Operational credentials and recovery.** Choose preview token expiry and ingress log handling. Verify the actual anonymous ingress bucket, the production Git resolver option and the effective SSH policy. Decide the backup pull key, off-host encryption and restore isolation policy from the backup findings. Retain Wave 5's open decisions on clients without Fetch Metadata and attachments reused across conversations.

## Merge notes

| Held file | Hunks at production |
| --- | --- |
| `apps/server/src/app.ts` | Line 359 passes the existing transactional owner check to Windows. |
| `apps/server/src/command-chat.ts` | Line 1121 passes visible message IDs to monitor feedback. Line 1527 supplies the conversation scrubber to council. Lines 1534–1537 remove the pre-transaction council reply overwrite. Line 1557 gates the chosen council reply with the live owner grant. Line 1566 applies the gated reply and status. Line 1608 bases monitor offers on the gated choice. |

No deployment configuration, rollout switch, migration, `packages/execution-pipeline/` or `packages/execution-model/` files are changed.

## Verification

A detached checkout at `29448ae` received only the changed test files. The paired command ran there and on the review branch. Its filter selects all 26 new regressions plus an existing member/council assertion. The production checkout exited 1 with 26 failed and one passed. The review branch exited 0 with 27 passed. Both runs filtered out 96 other tests. The regressions cover every code fix above. No run used production endpoints or production data.

### Paired regression command

```sh
npm test -- \
  packages/windows/src/windows.test.ts \
  packages/execution-integration/src/permanent-worker.test.ts \
  packages/model-relations/src/runtime.test.ts \
  tests/assistant-judge-shadow.test.ts \
  tests/monitor-decision-feature-privacy.test.ts \
  tests/chat-idempotency.test.ts \
  tests/owner-model-council.test.ts \
  tests/smart-monitor-pdf.test.ts \
  tests/smart-monitor-source-visual.test.ts \
  tests/models-routes-security.test.ts \
  tests/model-council.test.ts \
  tests/preflight-wave-6.test.ts \
  tests/monitor-alert-feedback.test.ts \
  -t 'current owner access|council record|before council publication|redacts known credential fields|excludes privacy-filtered validators|shares in-flight render slots|passes the checked region dimensions|copied link contains|copied json contains|copied cookie field|decision context contains a copied credential field|advertised output budget|file supplied as PNG|fall back to an independent worker|round reaches its deadline|before extracting council excerpts|passes external cancellation|configured resident worker interpreter|reviewed queue and resource limits|visible conversation window|withheld council answer' \
  --reporter=verbose
```

### Authentication, Windows, chat and relay

Exit 0. Fourteen files, 115 tests passed and one native Windows test skipped.

```sh
npm test -- \
  packages/windows/src/windows.test.ts \
  tests/windows-assistant-scope.test.ts \
  tests/assistant-computer-cancel-queue-audit.test.ts \
  tests/assistant-computer-native-completion-audit.test.ts \
  tests/assistant-native-queue-owner-access-audit.test.ts \
  tests/chat-idempotency.test.ts \
  tests/owner-model-council.test.ts \
  tests/owner-v5-chat.test.ts \
  tests/members-access.test.ts \
  tests/member-data-routes.test.ts \
  tests/request-rate-limit.test.ts \
  tests/web-api-proxy.test.ts \
  tests/sites-api.test.ts \
  tests/response-policy-long-run.test.ts
```

### Model worker, council, preflight, backup and metrics

Exit 0. Seventeen files, 120 tests passed and two packaged-model smoke cases filtered out.

```sh
npm test -- \
  packages/execution-integration/src/permanent-worker.test.ts \
  packages/model-relations/src/runtime.test.ts \
  packages/model-relations/src/manager.test.ts \
  tests/model-council.test.ts \
  tests/models-routes-security.test.ts \
  tests/model-worker-server.test.ts \
  tests/v5-chat-generation.test.ts \
  tests/preflight-wave-6.test.ts \
  tests/backup-ssh.test.ts \
  tests/backup-status.test.ts \
  tests/backup-restore-drill.test.ts \
  tests/check-cloud-backup.test.ts \
  tests/production-metrics-api.test.ts \
  tests/production-metrics-hooks.test.ts \
  tests/production-metrics-monitor.test.ts \
  tests/production-metrics-store.test.ts \
  tests/production-metrics-v5.test.ts \
  -t '^(?!.*(?:loads and scores the packaged CPU classifiers|runs the checked-in arithmetic ranker))'
```

### Monitor sources, runtime and feedback

Exit 0. Fourteen files and 161 tests passed, including local browser fixtures.

```sh
PLAYWRIGHT_BROWSERS_PATH=/workspace/scratch/security-review-chromium npm test -- \
  tests/smart-monitor-pdf.test.ts \
  tests/smart-monitor-source-visual.test.ts \
  tests/smart-monitor-github.test.ts \
  tests/smart-monitor-sources.test.ts \
  tests/smart-monitor-sources-v2.test.ts \
  tests/monitors-api.test.ts \
  tests/monitors-owner-rollout.test.ts \
  tests/smart-monitor-runtime.test.ts \
  tests/smart-monitor-chat-v2.test.ts \
  tests/monitor-context-decision.test.ts \
  tests/smart-monitor-decisions.test.ts \
  tests/monitor-alert-feedback.test.ts \
  tests/monitor-decision-feature-privacy.test.ts \
  packages/learning/src/pdf.test.ts
```

### Privacy, notifications, networking and Wave 5 safeguards

Exit 0. Nineteen files, 179 tests passed and one model-artifact parity case filtered out.

```sh
npm test -- \
  tests/assistant-judge-shadow.test.ts \
  tests/assistant-judge-production.test.ts \
  tests/judge-shadow-rotation.test.ts \
  tests/assistant-router.test.ts \
  tests/conversation-state-shadow.test.ts \
  tests/model-relations-shadow.test.ts \
  tests/conversation-share-privacy.test.ts \
  tests/member-data-export.test.ts \
  tests/agent-run-ledger.test.ts \
  tests/long-run-credential-privacy.test.ts \
  packages/browser/src/agent-browser-redirect-headers.test.ts \
  packages/browser/src/network-redirect-headers.test.ts \
  packages/coding/src/git-remote-network.test.ts \
  tests/web-push-delivery.test.ts \
  tests/page-cache.test.ts \
  tests/postgres-connection-recovery.test.ts \
  tests/notifications.test.ts \
  tests/ios-push.test.ts \
  tests/reminders-scheduler.test.ts \
  -t '^(?!.*parity)'
```

### Additional checks

- `npm run typecheck` exited 0 for the root and web TypeScript projects.
- `node --check scripts/cloud-linux/preflight-wave-6.mjs` exited 0.
- `for script in scripts/cloud-linux/{prepare,backup,backup-publish,backup-ssh-command,restore-drill,setup-model-worker}.sh; do bash -n "$script" || exit; done` exited 0.
- `sshd -T -f scripts/cloud-linux/mohassan-backup-pull.sshd.conf -h "$fixture/host-key" -C user=mohassan-backup-pull,host=localhost,addr=127.0.0.1` exited 0 with a throwaway host key and confirmed the repository drop-in's forced command, public-key-only authentication and disabled forwarding, TTY and user startup file.
- `PYTHONPATH=/workspace/scratch/security-review-worker/pytest:packages/execution-integration python -B -m pytest -p no:cacheprovider -rs packages/execution-integration/model_worker/tests/test_runtime.py packages/execution-integration/model_worker/tests/test_containment.py` exited 0 with 19 passed and one Windows-only skip. Python source is unchanged.

The two pre-existing bundled inference smoke cases ran in an initial unfiltered model-runtime suite. The final verification explicitly excludes them, and no inference results or assets are included in this change. The final privacy group also filters parity checks that require optional model artifacts. No external model service was used.

### Unverified in production

The live ARM64 runtime, real weights and virtual environment, combined resource use, PostgreSQL locking and restore execution, reverse-proxy headers and egress, the installed SSH include stack, backup timers and independent pull, real push delivery and native Windows companion behavior were outside this environment. The checks use disposable PGlite, synthetic IPC and route fixtures, the pinned local Chromium build, and an isolated SSH configuration. Startup and restore on production were not attempted.
