# Advertising workflow verification, 2026-11-24

**Final local verification record, 2026-11-24.** The latest file-level results contain **378/378 passing assertions across 22 files**. Root/web typechecks, the production web build, Android compilation and 16 model tests, and three Wasla service tests passed. Live Google Ads, installed browser/device execution, and a live-service release remain unverified. [verification-summary.json](../../artifacts/agent-workflow-20261124/verification-summary.json) records each file's actual result source; it does not pretend the earlier failed aggregate run passed.

Training was not stopped, restarted, reconfigured or used for this work. Verification ran serially with bounded CPU use; no model installation, GPU test job, checkpoint activation or live Google Ads mutation was performed.

The current request path is mapped in [advertising-agent-workflow.md](advertising-agent-workflow.md). The implemented loop observes the account, prepares a scoped proposal, obtains missing material answers, executes an authorized PAUSED creation through the typed API, compares fresh remote fields, persists evidence, and exposes readback-only recovery. Chrome connection/status remains available; browser Ads filling and replay are deliberately unsupported and fail closed.

## Source changes and consumers

These are task-specific changes within the existing implementation. Existing unrelated work was not a reason to reset, stash, commit, switch checkouts or replace modules.

| Paths | Symbols, contracts and affected consumers |
| --- | --- |
| `apps/server/src/command-chat.ts`; `apps/server/src/assistant/campaign-run.ts` | `createCommandChatControl`, `campaignContext`, `campaignInputQuestion`, `send`, `resumeCampaign`; `createPausedCampaign`, `checkCampaignDraft`, `resumeCampaignReadback`, `campaignReadbackChecks`. Both model-driven and established own-Ads-model creation use the persisted loop rather than a success string. Current run, account, intent, draft ID, operation receipt, corrections and readback survive interruptions. |
| `apps/server/src/assistant/campaign-authorization.ts`; `assistant/tools.ts`; `assistant/brain.ts`; `assistant/ads-model-chat.ts` | `campaignRequestedAccountIds`, `authorizeCampaignBrief`, existing Ads tools and decision schemas. Host-recorded owner answers bind material budget/currency/period, destination, service, geography, goal and account. Unsupported bid/schedule constraints must block rather than be silently discarded. Corrections cannot enlarge authority. Saved Chrome preference does not select an unverified filling path. |
| `apps/server/src/assistant/campaign-ledger.ts`; `assistant/agent-run.ts`; `assistant/campaign-verification.ts` | `observeCampaignLedger`, existing required-step/evidence ledger, `verifyCampaignCompletion`. Campaign completion is tied to fresh matching readback and the actual existing skill loader; registering a skill name does not prove invocation or grant authority. |
| `packages/google-ads/src/client.ts`, `control.ts`, `publisher.ts`, `verifier.ts`, `store.ts`, `experience.ts`, `gates.ts`, `draft.ts`, `index.ts` | `GoogleAdsClient.mutate`; `CampaignPublishingController.claim/publish/reconcile/launch`; exported `verifyPublishedCampaign`; `createGoogleAdsControl.createPausedCampaign`; scoped `RecoveryLessonMemory`. Account fencing, operation-hash approvals, returned resource IDs, full hierarchy readback, field mismatches, unknown outcomes and account-scoped lesson provenance are persisted. Migration extends existing tables. Test accounts support guarded PAUSED creation; test-account launch is blocked. |
| `packages/contracts/src/google-ads.ts`, `campaign-progress.ts`, `command-chat.ts`, `ai-providers.ts` | `GoogleAdsReadback`, optional `GoogleAdsDraft.readback`, campaign event/state/recovery data, `AssistantProviderSettingsInputSchema`, `AIProvidersStatus.assistant`. Server, web and phone consumers use these bounded additive fields rather than deriving success from text. |
| `apps/server/src/inference.ts`, `config.ts`; `packages/providers/src/index.ts`, `provider.test.ts` | `assistantOptIn`, `saveAssistant`, `checkAssistant`, `refreshAssistant`, `routerFor`, `visionProvider`; existing `GroqProvider` transport. Global external-provider cut remains for other features. Assistant consent defaults off, must be explicitly saved by the owner, and requires fresh listed/documented capabilities. Unknown models cannot acquire vision. Automatic and paid fallback remain off. |
| `packages/browser/src/agent-browser.ts`, `effect-policy.ts`, `engine.ts`, `index.ts` | Existing observation/action reservations, stale-target checks, cancellation/handoff cleanup, browser effect policy and Ads mutation restriction apply to the chat and independent skills browser. Browser actions cannot acquire Ads write scope from page content or generic approval. |
| `apps/server/src/chrome-extension.ts`; `packages/chrome-extension/background.js`, `relay.js`, `popup.js`, `popup.html` | `retireCampaignJobs`, `queueCampaign`, `claim`, `resume`, `result`; background `adapter/tick`. Connection, read/status and cancellation remain. Queued/running legacy leases and cached journals cannot authorize field edits or replay. Queue/resume return `GOOGLE_ADS_TYPED_API_REQUIRED`; claim supplies no job; stale results cannot establish saved creation. |
| `apps/server/src/app.ts`, `members.ts`, `wasla.ts` | Existing session/Origin/rate-limit/role boundaries; `waslaMigration`, `registerWaslaRoutes`, closed `WASLA_GATEWAY_ROUTES`. The gateway requires loopback, paired Bearer identity and a current owner. `WASLA_BRIDGE_ENABLED` was not enabled by the task; production refuses an enabled local bridge. |
| `apps/web/components/assistant-app.tsx`, `assistant-app.module.css`, `campaign-card.tsx`, `campaign-card.module.css`, `campaign-recovery-card.tsx`, `run-status.tsx`, `run-status.module.css`, `run-view.ts` | `AssistantApp`, `CampaignCard`, `CampaignRecoveryCard({busy,onResume})`, `RunDetails`, `RunVerdict`. Existing long polling displays server-authored steps, questions, cancellation, reconnect/error/partial states and readback-only recovery. |
| `apps/web/components/google-ads-workspace.tsx`, `google-ads-workspace.module.css`, `google-ads-view.ts`, `ai-providers.tsx`, `chrome-extension-panel.tsx` | `GoogleAdsReadbackEvidence`, `DraftDetail`, `AiProviders`. Account-bound evidence, correct currency formatting, guarded approvals, concrete model-sharing/cost opt-in and honest Chrome connection-only status. Existing layout/tokens and wrapping controls support the intended mobile layout; a final browser/360px visual check is not claimed. |
| `apps/android/app/src/main/java/com/ahmadalwakai/wasla/Models.kt`, `Mohassan.kt`, `Security.kt`, `ui/MohassanScreens.kt`; `apps/android/app/src/test/java/com/ahmadalwakai/wasla/ModelsTest.kt` | Optional campaign/recovery decoding, `MohassanCampaignRecovery`, stable `Idempotency-Key`, `resumeMohassanCampaign`, evidence/recovery controls and model tests. Main and test Kotlin compilation actually succeeded; installed APK/device behavior remains unverified. |
| Existing `.claude/worktrees/wasla-bridge/apps/wasla-service/wasla/server.py`, `mohassan.py`; `tests/test_mohassan.py` | Closed `mohassan_campaign_resume` route and `MohassanBridge.resume_campaign` forwarding exact `{runId}` plus validated request key. Generic action names remain restricted. Three focused service tests use fake services and loopback fixtures. |
| Existing `.claude/worktrees/wasla-bridge` and `.claude/worktrees/iphone-daily`, each under `apps/ios/Wasla/Models.swift`, `Mohassan.swift`, `Security.swift` and `apps/ios/Tools/PairingChecks.swift` | Both existing iOS sources were synchronized for evidence, supported readback-only offers and stable request keys while retaining their branch-specific lifecycle. Source checks do not establish Swift compilation, signing, installation or device success. |
| `docs/GOOGLE-ADS.md`, `FREELLMAPI.md`, `CHROME-EXTENSION.md`, `architecture/advertising-agent-workflow.md` | Current capability boundaries, opt-in, unsupported browser filling, routes, recovery, live prerequisites and evidence levels. |

`apps/worker/src/index.ts` remains the queued general/skills/browser Runtime entry point. Chat dispatch and Ads creation run through the existing server chat worker; no duplicate worker or agent framework was introduced. Package entry points retain the existing `src/index.ts` exports.

### Exact component contracts and hooks

These are the inline props in `apps/web/components/`:

```text
assistant-app.tsx — AssistantApp:
  { name: string; onAdvanced: () => void; onOpenTool?: (view: AssistantToolView) => void; onSignOut: () => void }
campaign-card.tsx — CampaignCard:
  { stream: CampaignEventStream | null | undefined; running: boolean }
campaign-recovery-card.tsx — CampaignRecoveryCard:
  { busy: boolean; onResume: () => void }
run-status.tsx — RunVerdict: { run: ChatRunView | null | undefined }
run-status.tsx — RunDetails: { run: ChatRunView }
google-ads-workspace.tsx — GoogleAdsReadbackEvidence: { readback: GoogleAdsReadback; customerId: string }
google-ads-workspace.tsx — GoogleAdsWorkspace: { offline: boolean }
google-ads-workspace.tsx — internal DraftDetail:
  { draft: GoogleAdsDraft; status: GoogleAdsStatus; busy: boolean; onStep: (name: string) => void;
    onApprove: (action: 'publish' | 'launch') => void; onEdit: () => void; launchHash: string | null }
ai-providers.tsx — AiProviders: { offline: boolean }
chrome-extension-panel.tsx — ChromeExtensionPanel: { relevant?: boolean } = {} (relevant defaults to true)
```

`AssistantApp` uses React `useState/useRef/useCallback/useEffect`, with `refreshHistory` as the callback and inline selection/progress effects. Abort controllers clean up pending requests. The existing `api<Conversation>` long poll carries the version and an 8000ms wait; `run-view.ts:isNewerSnapshot` prevents stale UI replacement and `progressRetryDelay` controls reconnect backoff. These source contracts were inspected; they do not establish final browser/mobile visual QA.

## Checks actually completed

| Check | Observed result and conditions | Evidence |
| --- | --- | --- |
| Focused release suite before final hardening | **344/344 passed across 20 files**, zero failed/pending. Serial Vitest, isolated environment, disposable databases, injected model/HTTP/browser ports. This snapshot predates the last Chrome/auth/mismatch/own-model preference changes. | [release-tests.json](../../artifacts/agent-workflow-20261124/release-tests.json) |
| Repeated local workflow gate within that suite | **60/60 expected outcomes passed:** 20 representative scenarios, each run three times through the real campaign loop, event reducer and ledger with injected remote ports. This is not 60 successful live advertising tasks. | `tests/ads-agent-workflow.test.ts`; same release JSON |
| Earlier full API suite | **36/36 passed** in the release snapshot. It covers actual Fastify routes and temporary persistence with Google/OAuth stand-ins. It does not prove acceptance by Google. | Release JSON, `tests/google-ads-api.test.ts` |
| Provider opt-in | **11/11 passed** in the release snapshot: default no-network behavior, discovery-only consent, strict planner payload, verified vision routing, rejected/unlisted models, revocation, expiry, malformed data/future timestamps and late-check discard. Transport is mocked; owner credentials were not called. | Release JSON, `tests/assistant-provider-opt-in.test.ts` |
| Android model tests and compilation | **16/16 `ModelsTest` passed**, skipped/failures/errors all zero; main and test Kotlin sources compiled. Gradle finished **BUILD SUCCESSFUL in 4m 50s**. No APK assembly/install or device test is asserted. | [android-online.log](../../artifacts/agent-workflow-20261124/android-online.log); `apps/android/app/build/test-results/testDebugUnitTest/TEST-com.ahmadalwakai.wasla.ModelsTest.xml` |
| Focused Python Wasla service recovery | **3/3 passed in 2.570s**, exit 0. Existing Python 3.11, fake services and loopback fixtures; no GPU/model job. Existing aiohttp `NotAppKeyWarning` was nonfatal. | [python-wasla-final.log](../../artifacts/agent-workflow-20261124/python-wasla-final.log); [phone-source-sync.json](../../artifacts/agent-workflow-20261124/phone-source-sync.json) |
| Prior typecheck | `npm run typecheck` passed for root and web at the earlier recorded source revision. The final-source check is recorded separately below. | [typecheck-release.log](../../artifacts/agent-workflow-20261124/typecheck-release.log) |
| Latest source tests | **378/378 passed across 22 files**, using the latest executed result for each file. The 22-file run exposed fixture isolation and Chrome mock/message failures. The affected chat/Chrome files were rerun successfully, and the paused API file passed all 25 cases after FK-safe fixture cleanup. This includes the new cross-owner remote-mismatch fence. Failed raw reports are retained. | [final-source-tests.json](../../artifacts/agent-workflow-20261124/final-source-tests.json), [repaired-boundaries-tests.json](../../artifacts/agent-workflow-20261124/repaired-boundaries-tests.json), [paused-final.json](../../artifacts/agent-workflow-20261124/paused-final.json), consolidated by the summary |
| Final source typecheck | **Passed, exit 0**, for root and web after the last implementation and fixture changes. This is a static check, not browser or live-service evidence. | [typecheck-delivery.log](../../artifacts/agent-workflow-20261124/typecheck-delivery.log) |
| Google Ads setup diagnostic | `npm run ads:setup` returned **exit 1 as the expected configuration blocker**, not a software-test regression. Exactly `GOOGLE_ADS_CLIENT_ID` and `GOOGLE_ADS_CLIENT_SECRET` are missing; `invalid` is empty, the existing token key is valid, publishing is false and production access is unverified. Database configuration was detected but no database, OAuth or Google request was opened. | [google-ads-setup.json](../../artifacts/agent-workflow-20261124/google-ads-setup.json), checked 05:26:18 UTC |
| Next.js build | **Passed, exit 0** through `npm run build` / `next build --webpack`. Next 16.4.5 compiled successfully in 94s, completed its TypeScript check, prerendered 3/3 pages and collected traces. Used isolated `.next-workflow-20261124`; verified generated changes to `tsconfig.json` and `next-env.d.ts` were archived and restored byte-for-byte to preserve the existing lab configuration. | [build-web.log](../../artifacts/agent-workflow-20261124/build-web.log) |
| Playwright / real browser / live Ads / physical phones | **Not executed or verified.** See constraints and external blockers below. | No fabricated live artifact |

The latest results cover Chrome connection-only enforcement (15 API/chat cases and 10 VM cases), 42 authorization cases including unsupported CPC/CPA/ROAS/schedule constraints, mismatch write/reconcile/discard fences, and the actual own-model app path with a saved Chrome preference. Shared fake account numbers are isolated between independent test cases; a separate test retains and checks the cross-owner account lock. A failed readback with an existing remote identifier cannot be discarded or treated as permission to create a replacement; fresh readback can verify recovery without another write. `git diff --check` also passed.

### Execution conditions and reproducible commands

Root verification used a dedicated shell at `BelowNormal` priority and processor-affinity mask `4` (CPU 2), serial jobs and one test worker. Earlier exploratory agent batches used the same low-priority/single-core strategy on a different selected core. No full test sweep or browser runner competed with training.

The final 22-file selection is preserved by `final-test-files.txt`. These are focused files, not the repository-wide test command:

```powershell
$env:MOHASSAN_ISOLATED_TEST = 'true'
$taskFiles = @(Get-Content -LiteralPath artifacts/agent-workflow-20261124/final-test-files.txt)
node node_modules/vitest/vitest.mjs run @taskFiles --maxWorkers=1 --no-file-parallelism --reporter=json --outputFile=artifacts/agent-workflow-20261124/final-tests-reproduced.json
```

The final `npm run typecheck` script ran `tsc --noEmit -p tsconfig.json` followed by the web workspace typecheck. The final build ran `npm run build` with `NEXT_DIST_DIR=.next-workflow-20261124`, in the same bounded shell. Earlier failures were fixed and affected checks rerun; the summary selects actual latest file results rather than counting duplicate runs.

Android command, executed in `apps/android`, with `JAVA_HOME` pointing to the existing Microsoft JDK `17.0.16.8-hotspot` and `ANDROID_HOME` to the existing Android SDK:

```powershell
.\gradlew.bat ':app:testDebugUnitTest' '--tests' 'com.ahmadalwakai.wasla.ModelsTest' '--no-daemon' '--max-workers=1' '--no-parallel' '-Dorg.gradle.jvmargs=-Xmx768m -XX:ActiveProcessorCount=1 -Dfile.encoding=UTF-8' '-Pkotlin.compiler.execution.strategy=in-process' '-Pandroid.aapt2FromMavenOverride=C:\Users\Administrator\AppData\Local\Android\Sdk\build-tools\35.0.0\aapt2.exe' '--console=plain'
```

The first offline Android attempts did not pass: Gradle's file-access journal was corrupt, and required AAPT/Kotlin artifacts were not cached. The original journal was preserved as [gradle-file-access-before.bin](../../artifacts/agent-workflow-20261124/gradle-file-access-before.bin). The successful invocation selected the installed SDK 35 `aapt2` through the CLI override and downloaded only already-pinned Kotlin `2.0.21` dependencies. No model or new model package was installed and no project dependency version was changed for this recovery. Earlier failure logs remain available as `android-final.log` and `android-retry.log`. Existing `OpenInNew` deprecation warnings in unrelated Android screens did not fail compilation.

Python service command used the existing interpreter and the exact three names recorded in `phone-source-sync.json`, with `PYTHONPATH` containing the existing `wasla-service` and its `tests` directory:

```powershell
$taskSync = Get-Content -LiteralPath artifacts/agent-workflow-20261124/phone-source-sync.json -Raw | ConvertFrom-Json
$taskWaslaChecks = @($taskSync.pythonWasla.tests)
$env:PYTHONPATH = 'C:\Mohassan AI\.claude\worktrees\wasla-bridge\apps\wasla-service;C:\Mohassan AI\.claude\worktrees\wasla-bridge\apps\wasla-service\tests'
& 'C:\Users\Administrator\AppData\Local\Programs\Python\Python311\python.exe' -m unittest @taskWaslaChecks -v
```

## Gate measurements and their limits

| Metric | Measured or unavailable |
| --- | --- |
| Local representative-scenario expected-outcome rate | 60/60 = **100%** in the release snapshot, exceeding the proposed 57/60 local threshold. Expected refusals/unknown/partial outcomes count as correct test outcomes, not successful campaign creation. |
| Unauthorized, wrong-account and duplicate mutations | No such mutation was observed in the controlled fixture assertions. This is not a guarantee about untested accounts, deployed versions or future failures. |
| Mutation evidence | Local mutation scenarios require fresh matching readback; separate typed-control tests compare the complete created hierarchy. A simulated readback is not a Google-produced live receipt. |
| Local assertion-duration latency | From the 60 final-source gate assertions, nearest-rank p50 **3.88 ms**, p95 **16.08 ms**, maximum **120.03 ms**. Includes test/fixture setup; mocked waits and ports exclude real network, model, browser and human delays. These are local test durations, not production task latency. |
| Real chat-to-verified-campaign latency | **Not measured.** Local assertion durations must not be presented as user task latency. |
| Real advertising task success rate / business performance | **Not measured.** No live campaign, eligibility decision, conversion improvement or profit was observed. |
| Human intervention count | **Not measured for real tasks.** Scripted fixture responses are not a recorded human-intervention study. |
| Model/provider cost | **Not measured.** No actual generation request was made with the owner's keys; no billing proof was collected. Do not report zero cost as a measured result. |

No superiority claim or controlled comparison with another agent was performed.

## Remaining external and verification blockers

1. **Google Ads account access:** the actual configuration-only `ads:setup` run reports exactly missing `GOOGLE_ADS_CLIENT_ID` and `GOOGLE_ADS_CLIENT_SECRET`, no invalid fields, valid existing token key, publishing false and production access unverified. It detected database configuration without opening the database. No authorized test account was provided. Current fingerprint-bound publishing/regression/read-access gates must be satisfied for the actual deployed code and intended account. Developer tokens were sunset on September 9, 2026 and are now optional/ignored; the missing token alone is not the blocker. See the precise [developer-token sunset/migration page](https://developers.google.com/google-ads/api/docs/api-policy/developer-token), not the stale token summary on the generic OAuth overview. OAuth, project access and account permissions still apply.
2. **Assistant provider availability:** the owner opt-in was not enabled by the task and the configured key was not called. The owner can review the sharing/cost note and explicitly enable/check the configured models; documentation plus a mock does not establish that account's live availability or model quality. Automatic paid fallback remains disabled. [Structured output](https://console.groq.com/docs/structured-outputs) and [vision](https://console.groq.com/docs/vision) capabilities are documented separately from account availability.
3. **Wasla and installed phone clients:** source routes are connected, but `WASLA_BRIDGE_ENABLED` was not enabled, the server/service rollout was not performed, and no updated APK/iOS application was installed or exercised on a real phone. Both iOS worktrees have synchronized source; `swiftc`, `xcodebuild` and `xcrun` were unavailable, so no native iOS build is claimed.
4. **Browser and extension:** source guards reject Ads filling and cached-job replay. Reloading/deploying an installed extension and inspecting its live browser state were not performed. Supported Ads mutations require the typed API; a Chrome connection is not a fallback around missing account authorization or credentials.
5. **Training-preserving visual verification:** the repository's [brain-agent instruction, rule 2](../BRAIN-AGENT-INSTRUCTIONS.md) states: “ما دام `artifacts/chat-training/v4/gpu.lock` موجودًا لا تشغّل `npm test` الكامل ولا Playwright”. The lock exists during this work and the user explicitly required training to continue, so the expressly prohibited full `npm test` and Playwright were not run. Screenshot/360px visual QA and real-browser end-to-end verification were also not performed; no visual result is inferred from typechecks or source inspection. Focused CPU-bounded checks and the requested final typecheck/build are distinct from those unperformed checks.

An unresolved remote write is intentionally not converted to “nothing happened” merely because a campaign is not yet observed. It can keep account writes blocked until positive reconciliation or an explicit authorized resolution. Saved, PAUSED, enabled, eligible and observed business performance remain separate claims.

## Training observation

At 05:44 UTC on 2026-11-24, the existing Python training process (PID 16592) was still running. Its status recorded 235,094,528 of 1,000,000,000 token positions; the latest speed sample was 6,649.65 tokens/second and the last ten samples averaged 6,676.52. The speed monitor reported zero consecutive slow seconds. No action stopped, resumed, reconfigured or installed a model for this training.

At that measured average, the remaining work is approximately 31.8 active hours, suggesting about 13:34 on 2026-11-25 UTC / London. This estimate excludes evaluation, checkpoint saving and interruptions, so actual completion may be later. The summary records the observation time and formula inputs; it is an estimate rather than a promised deadline.
