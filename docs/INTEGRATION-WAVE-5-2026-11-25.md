# Integration wave 5 · 25 November 2026

Draft targets `release/rc-2026-11-25` at `d3ebd9223f44445627b9d3d0bdea08d5f9b0550a`.

## Development benchmark reproduction

The launcher in [`scripts/dev-bench/`](../scripts/dev-bench/README.md) takes product SHAs and runs the pinned development bundles from scratch worktrees. It uses the #41 review and structured-memory adapters on both versions and adds clarification on V2. It applies #70 in a scratch `--no-commit` merge, restores the measured product, schedules each V2 case in lane `index % 8`, verifies the worker receipt hashes and release order, and recomputes summary groups from the pinned scorer's verdicts. V1 completes before V2 starts. The corpus, scorer and gates are unchanged.

The initial command with output `/workspace/work/wave5-frozen` exited 1 before V1 scoring. The #41 module's standalone CLI guard compared its path with Node's first argument. The committed adapter invocation now passes a separate argv label. The scored calibration exited 0 with the following command:

```bash
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/chromium npm_config_cache=/workspace/work/npm-cache python3 -B scripts/dev-bench/run.py --output /workspace/work/wave5-frozen-calibration --arm frozen=e7274aa6cc9aacbf3d03c1b3be572720cfb9c5a3
```

| Frozen Wave 4 development | Published | Reproduced |
| --- | ---: | ---: |
| V1 | 176/240 | 176/240 |
| V2 | 1,586/2,400 | 1,586/2,400 |

Every published area and language count matched. The launcher SHA-256 is `7cb2faa4557f4b4f17b9b7a6472c14301df97804e0aa43e1b945f7a53ac35f94`. The frozen summary SHA-256 is `0a45168785920c39444d6f5de1685d058de979982ed821c8241bd8becd394e20` and the coordinated case receipt SHA-256 is `756d4ad2d8ca461174b2597cb2a3476cf707f5a03f193dbe28d45911b67be5d4`. The measured lockfile matches Wave 4 at `5ca3eb97d734f4403734d865f08e52065675e46877f75000e3646b1fddbdbb4e`. [Wave 4 results](INTEGRATION-WAVE-4-2026-11-25.md#development-decisions)

The calibration used Node 24.22.3, npm 11.19.1, Python 3.12.14 on PATH, Linux libseccomp and Playwright Chromium and headless shell 156.0.8078.4 (build 1248). The launcher records the executable and libseccomp digests. The scratch worktrees held development fixtures only.

### PR #89 reproduction and 5 Whys

The launcher measured the implementation commit `7f9c417f2e06b77c26eb6ff677d06e3457da650b` with the same Wave 4 settings. Both splits exited 0 at **176/240** and **1,586/2,400**. All 2,640 verdicts matched our frozen run. `git diff --name-status 7f9c417 4c05dc7` returned only the added `docs/RESPONSE-POLICY.md`, so #92's measurement of `4c05dc7` used the same product code.

```bash
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/chromium npm_config_cache=/workspace/work/npm-cache python3 -B scripts/dev-bench/run.py --output /workspace/work/wave5-pr89-canonical --arm pr89=7f9c417f2e06b77c26eb6ff677d06e3457da650b
```

The coordinated case receipt SHA-256 is `331ae0d5f3921d95ec835e9c5710cd70b75feaab2d9c080b97457d50cb5f87c6`. The summary SHA-256 is `9eb47e6d23cfaea4dc9c20753f07cb11e728af05b9af7617c5841e415829a7f0`. The lockfile SHA-256 is `fe2989772964d7cbc188f017985ccaca7805553755510a0314ec4e6e018606f6`.

The following commands ran in the clean detached PR #89 implementation checkout at `/workspace/work/wave5-pr89-replay`. Each exited 0. The unmodified legacy launcher reproduced **169/240** and **1,567/2,400**.

```bash
npm_config_cache=/workspace/work/npm-cache npm ci --offline
env -u PLAYWRIGHT_BROWSERS_PATH node --import tsx scripts/response-policy/development-bench.mjs prepare /workspace/work/wave5-pr89-evidence/historical
env -u PLAYWRIGHT_BROWSERS_PATH node --import tsx scripts/response-policy/development-bench.mjs off /workspace/work/wave5-pr89-evidence/historical 4
bash /workspace/work/wave5-pr89-evidence/case-probes.sh v1
bash /workspace/work/wave5-pr89-evidence/case-probes.sh v2
```

1. **Why did the totals disagree?** The legacy replay lost seven document-file verdicts in V1 and 19 refusal or small-talk verdicts in V2. Joining the ordered receipts found zero other changed verdicts. The V1 and V2 legacy aggregate SHA-256 digests are `d85e554f2f7d7bfe1d5be0ad94c335757e44a601b376dd24210ee9b0f90d0d95` and `977e60ed061657fb1664823b0dc4dda70bfdd3e19637607dc99cb07346191674`. The per-case comparison SHA-256 is `7bd654df2a1201b6371a762e3f050a36c393d3e671bb0b8dd7a1966d021a5466`.
2. **Why did those seven documents fail?** The legacy replay lacked the default Playwright browser installation and failed the required tool order, content and run-status checks on the seven PDF cases. With the same regular passwd home, scorer and weight-free settings, adding only the Chromium path restored all seven and returned the document-file area to 16/18. The original #89 command does not specify Chromium, and its original host environment was unavailable for inspection. The control receipt SHA-256 is `ae2aa9412d842d909bfcce0db2e71dd539a890f940cdc75dac599650c7adb5c1`.
3. **Why did V2 route differently?** The legacy launcher sets `MOHASSAN_SCRATCH_CLASSIFIERS=0` and substitutes a null implementation for the learned refusal head. Restoring only scratch classification recovered 16 refusals via `scratch_out_of_scope` and two small-talk cases via `scratch_speech_act`. Restoring only learned refusal recovered the remaining English refusal via `request_refused`. The independent control SHA-256 digests are `ad823e523147c71a9af6beb1a9330fd823d09313b1142feae4524695a2d52756` and `f90be2aea7e6acb5e65a87100b02510e4767937d32ef62d330595f18d924bb36`.
4. **Why were those classifiers disabled?** #89 used a documented weight-free profile for its response-policy experiment and ran four lanes. Wave 4 enables the inherited classifiers. The controls isolated the recovered verdicts with the original scorer, independent of the lane counts.
5. **Why could the profiles be mistaken for equivalent measurements?** The published comparison shared product and corpus identifiers, while the Wave 4 launcher and runtime choices lived in scratch. The committed launcher makes the chosen settings and executable identities part of each receipt. [Response policy report](RESPONSE-POLICY.md) · [Background results report](BACKGROUND-RESULTS.md)

| Split and cause | Cases changing from failure to pass |
| --- | --- |
| V1 · Chromium · Arabic | `dev-document-file-127`, `dev-document-file-128`, `dev-document-file-129` |
| V1 · Chromium · English | `dev-document-file-136`, `dev-document-file-137`, `dev-document-file-138`, `dev-document-file-144` |
| V2 · scratch refusal · Arabic | `human-c074f9ac36920a2b72eae242`, `human-c783fb63e7b02962b20568ba`, `human-85b6eb7caf5cd9876150e7d5`, `human-8837bdef87d394dbd168e372`, `human-12605dab8673b95946b5f8b6`, `human-2ea64eb91262a1e8a3e3b10e`, `human-ef928e76492645e9005c3453`, `human-4b2192865f65dea7424703c5`, `human-69f9b3055c877c44cedc95fd`, `human-39d664eb41957fc6b41a5c32`, `human-9b37dd56ba233ca6e571f7cb`, `human-10ea4df3a8da49b94c50d425`, `human-3c465aea27c158c061ea2754`, `human-6ec883004d5b5f23ecb44215` |
| V2 · scratch refusal · English | `human-5502f004e5d2cb9a24045d57`, `human-fc98192c465a629207012c26` |
| V2 · scratch small talk · English | `human-07b12cdc95eca62733166fa8`, `human-8ed16738623850de8e941b80` |
| V2 · learned refusal · English | `human-95575077f10cd03e36fe5723` |

## Merge order

The base is release candidate `d3ebd9223f44445627b9d3d0bdea08d5f9b0550a`. The selected second parents, in order, are listed below. PR #92 is stacked on the exact PR #89 head.

| Order | PR | Pinned branch tip |
| --- | --- | --- |
| 1 | [#89](https://github.com/ahmadalwakai/Mohassan-AI/pull/89) | `origin/feat/response-policy` at `4c05dc70a4b37495d7aac68a378c80dae54eec3c` |
| 2 | [#92](https://github.com/ahmadalwakai/Mohassan-AI/pull/92) | `origin/feat/background-results` at `6197542a81d43dc6c5bc8e792fe11c605852c958` |
| 3 | [#91](https://github.com/ahmadalwakai/Mohassan-AI/pull/91) | `origin/feat/arbiter-brain` at `8af14c6cd0970477263b4918fc9254c7a17724fa` |

## Merge notes

Git created three two-parent commits in the selected order. Each committed tree matched its `git merge-tree --write-tree` result, so no hunks needed manual resolution. The protected-path diff was empty and PR #94's head failed the ancestor check.

| PR | Merge commit |
| --- | --- |
| #89 | `927f25ab41b2cbaf19c5e69efad9bd978466358b` |
| #92 | `508f7b3dcad42499225051c3b9e4b37c9da2ba69` |
| #91 | `26d0de8009d9ecc70195198e8f32c22755170e56` |

The original hooks operate at different points in chat. PR #92 reads the latest durable run’s worker, task and checkpoint state when projecting the active conversation card. PR #91 binds the interactive worker to the run ID when it starts and captures observations at the existing publication hook. The durable worker saves its terminal result and notification in one transaction. PR #89 attaches the durable wrapper via the existing refusal-aware factory. PR #92 adds the startup migration call after member data rights and before chat starts.

The counts below are per pull request against its own base and cover existing held files.

| PR | File | Additions / deletions | Hook |
| --- | --- | --- | --- |
| #89 | `apps/server/src/command-chat.ts` | 4 / 1 | Shape eligible completed replies before review, delegate history reads and bind the request channel. |
| #89 | `apps/server/src/assistant/brain.ts` | 3 / 0 | Apply context scope to prompt input and append bounded policy guidance and older evidence. |
| #89 | `apps/web/components/notification-client.ts` | 1 / 0 | Add the localized progress-notification title. |
| #92 | `apps/server/src/app.ts` | 2 / 0 | Import and invoke the background-results migration before chat initialization. |
| #92 | `apps/server/src/command-chat.ts` | 3 / 1 | Select the latest run’s worker and task and project the active background card. |
| #92 | `packages/contracts/src/command-chat.ts` | 2 / 0 | Add optional `backgroundRun` to the conversation response. |
| #92 | `apps/web/components/assistant-app.tsx` | 4 / 1 | Render the background card and its Stop action. |
| #92 | `apps/web/components/notification-client.ts` | 4 / 1 | Claim background outcomes through existing sync and exclude them from the legacy native-notice loop. |
| #92 | `apps/web/components/notification-settings.tsx` | 2 / 0 | Add completion sound and preview controls. |
| #91 | `apps/server/src/command-chat.ts` | 2 / 1 | Bind arbiter observations to the existing interactive execution and run ID. |

## Migrations

Application startup runs `037_notifications`, `038_reminders`, `039_conversation_shares` and `040_member_data_rights` in release-candidate order. The background-results migrator then calls `041_long_run_checkpoints` before `042_background_results`. Both new migrations use the full ID in the locked application ledger and return early when already recorded.

| ID | Schema change |
| --- | --- |
| `041_long_run_checkpoints` | Add the partial unique index for one active durable run per account and the index for due checkpoints. Expand the notification kind constraint to accept `task_progress`. Checkpoints use the existing `chat_runs.state`. |
| `042_background_results` | Add `ios_push_devices`, the per-registration `background_apns_deliveries` ledger, background metadata on `chat_notifications`, and completion-sound and result-preview preferences. Existing preference rows get sound on and previews off by column default. Existing notification rows get null background metadata and zero Web Push attempts. |

PR #91 adds no migration. [Migration ledger](MIGRATION-LEDGER-2026-11-25.md)

## Rollout flags and environment

| Environment variable | Default | Effect |
| --- | --- | --- |
| `MOHASSAN_REPLY_POLICY_ENABLED` | Off | Set `1` for response policy composition guidance and conservative removal of exact question echoes. |
| `MOHASSAN_CONTEXT_POLICY_ENABLED` | Off | Set `1` for bounded older transcript reads on explicit triggers and to honor explicit current-message-only directions. |
| `MOHASSAN_LONG_RUN_ENABLED` | Off | Set `1` to admit supported durable plans through chat. These cover public-source research, timed public-page monitoring and draft websites from complete briefs. |
| `MOHASSAN_BACKGROUND_RESULTS_ENABLED` | Off | Set `1` with durable admission enabled to add the acknowledgement, background card, final chat reply and outcome notifications for new durable runs. |
| `MOHASSAN_ARBITER_ROUTING` | Off | Set `1` to allow a promoted decision type to arbitrate between eligible existing handlers. |
| `MOHASSAN_ARBITER_QUESTION_REWRITE` | Off | Set `1` to allow a promoted decision type to choose between a validated rewrite and the original eligible public query. |
| `MOHASSAN_ARBITER_LOCAL_COMPUTATION` | Off | Set `1` to allow a promoted decision type to choose between the reasoning and native calculator results. |
| `MOHASSAN_ARBITER_COMPOUND_PLAN` | Off | Set `1` to allow a promoted decision type to choose a compiled plan or the available direct handler. |
| `MOHASSAN_ARBITER_ROUTING_KILL`, `MOHASSAN_ARBITER_QUESTION_REWRITE_KILL`, `MOHASSAN_ARBITER_LOCAL_COMPUTATION_KILL`, `MOHASSAN_ARBITER_COMPOUND_PLAN_KILL` | Off | Set a corresponding switch to `1` to force existing precedence for that decision type. |
| `MOHASSAN_MODEL_RELATIONS` | Existing default is shadow | Use `off` to disable the entire relations manager, including its shadow journal. |

The relation manager's existing worker controls are `MOHASSAN_MODEL_WORKER`, which defaults off, and `EXECUTOR_EXPERIMENT`, which defaults unset. The manager marks heavy in-process work unavailable when the resident model worker is enabled or the local executor experiment selects `uncontained-local`. [Model relations runbook](MODELS-RUNBOOK.md)

This tree has zero promoted arbiter decision types. The four activation flags cannot promote a decision type by themselves. Existing refusal, account authorization and approval checks keep their authority. [Response policy](RESPONSE-POLICY.md) · [Background results](BACKGROUND-RESULTS.md) · [Arbiter owner guide](ARBITER-BRAIN-VERIFICATION.md)

| Environment variable | Default | Use |
| --- | --- | --- |
| `APNS_KEY_ID` | Unset | Apple APNs signing key ID. |
| `APNS_TEAM_ID` | Unset | Apple Developer team ID. |
| `APNS_KEY_PATH` | Unset | Absolute path to the private `.p8` key, readable by the API service user. |
| `APNS_BUNDLE_ID` | Unset | App bundle ID used as the `apns-topic`. |
| `WEB_PUSH_VAPID_SUBJECT`, `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY` | Unset | Existing browser push contact and matching key pair for subscribed browsers. |

APNs delivery requires all four APNs settings. Account preferences default to generic notification text, completion sound on after a web-page interaction, and quiet hours off. Subscribed closed browsers use Web Push and the browser or operating system controls the sound. [Background results](BACKGROUND-RESULTS.md)

### Owner steps

1. Edit the server environment for the chat API. On the Linux VM, edit `/etc/mohassan/server.env` privately and apply changes with `sudo systemctl restart mohassan.service`. Start with the rollout flags off and let startup apply the migrations.
2. Turn on reply shaping or older context independently by setting its flag to `1`. Verify the behavior with a self-contained request and an older-context request in the same conversation.
3. Set `MOHASSAN_LONG_RUN_ENABLED=1` to admit durable work. Also set `MOHASSAN_BACKGROUND_RESULTS_ENABLED=1` for the card and background-result notifications. Test a supported long run and its Stop action. Enable notifications and subscribe each browser that should receive closed-page alerts.
4. For iPhone delivery, enable Push Notifications on the matching Apple App ID. Create an APNs key, store its `.p8` file outside Git with restricted access and set all four APNs variables. Permit outbound TLS over port 443 to `api.sandbox.push.apple.com` or `api.push.apple.com` for the environments in use. Restart the API. Register from an authenticated app build at `POST /api/push/devices` and verify delivery in each configured environment.
5. For arbiter shadow, leave `MOHASSAN_MODEL_RELATIONS` unset or set it to `shadow`. Leave the decision flags off for this rollout. Review observed decisions with `npm run models:shadow-summary -- .data/model-relations-shadow.jsonl` from the API checkout once it has a writable journal directory. Live decision authority requires a future calibrated promotion and the corresponding flag. [Model relations runbook](MODELS-RUNBOOK.md#observe-model-relations)

### Rollback

Set the four response and durable-run flags and all four arbiter activation flags to `0` and restart the API. Set `MOHASSAN_MODEL_RELATIONS=off` to disable shadow observation too. Disabling durable admission stops new runs. Already-admitted runs can recover, stop and deliver their recorded outcomes. Clear APNs configuration if APNs dispatch itself must stop. Keep 041 and 042 applied. The schema changes are additive.

## Verification

The tested product head is `26d0de8009d9ecc70195198e8f32c22755170e56`.

### Typecheck and background results

```bash
npm run typecheck
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/chromium npm test -- --maxWorkers=2 --fileParallelism --testTimeout=90000 --reporter=dot tests/response-policy-long-run.test.ts tests/ios-push.test.ts tests/web-background-notifications.test.ts
```

Typecheck exited 0 for the root and web projects. The focused Vitest command exited 0 with 30/30 tests in three suites. It covers durable restart, transient retry, stopping without another step or notice, cancelling a conversation through the normal API, an HTTP disconnect, push registration and notification delivery.

### PostgreSQL

```bash
set -o pipefail
bash /workspace/work/wave5-verification/run-migrations.sh /workspace/work/wave5-rc-tests /workspace/work/mohassan-wave5 2>&1 | tee /workspace/work/wave5-verification/migrations.log
```

Exit 0 on PostgreSQL 18.7. Two disposable databases used the published `postgres:18.7` image at digest `sha256:c699303802144847d238196173655dbbecf7a96aeca1565f2b02eb671a1f0b6b`. The fresh start recorded all 45 application and two auth migrations. Its final six wave registrations were 037, 038, 039, 040, 041 and 042 in that order. The upgrade first recorded the release candidate's 43 application and two auth migrations, seeded 12 rows, then ran 041 followed by 042. All 58 preexisting rows across 129 tables matched by SHA-256 on their original columns, including migration timestamps. The checks confirmed the new column defaults, expanded notification kind, durable-run indexes and two empty APNs tables. Both databases then restarted without new ledger entries or changes to rows across 131 tables.

The test booted the real `createApplication` path with its standard PostgreSQL adapter. Its command log SHA-256 is `7336077b74aaac8e25c1522747dbfef3319cf2be8ae1ec4962ea6876a8dfac7c`.

### Historical replay controls

From the detached PR #89 implementation checkout, the committed portable equivalent ran with the following command and exited 0:

```bash
bash /workspace/work/mohassan-wave5/scripts/dev-bench/forensics/case-probes.sh /workspace/work/wave5-pr89-evidence/historical /workspace/work/wave5-pr89-canonical/pr89/receipt.json /workspace/work/wave5-pr89-portable-confirmation /workspace/work/chromium
```

### Three-arm development run

The release candidate and merged head use the same pinned development bundles and Wave 4 profile. All arms also use `MOHASSAN_ARITHMETIC_SEARCH=1` and the same trusted Python interpreter. A and B disable the existing relations manager. B sets all eight new activation flags to `0`. C sets them to `1` and puts the manager in shadow. The four emergency kill switches are unset, and the promotion list is empty. The coordinator processes the three arms in one invocation. Up to two V2 workers run at once, preserving all eight modulo-assigned lanes. Other test suites are kept idle during scoring.

The run uses the Linux recipe in `scripts/dev-bench/Dockerfile` (SHA-256 `03417f8e64d499bbda87143555e090af9463ca72afccdb16b9a888ef8768a761`). The local image ID is `sha256:307862772e849b16d3732f81672ee058ac1629a6679575f90d5b34510d119f48`. The container has an unprivileged passwd account with a normal home, and the verifier accepted root-owned Python 3.12.14. Chromium and npm package bytes came from the mounted caches.

```bash
docker build -t mohassan-wave5-bench:2026-11-25 /workspace/work/wave5-bench-runtime
export PLAYWRIGHT_BROWSERS_PATH=/workspace/work/chromium
export npm_config_cache=/workspace/work/npm-cache
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
  --mount type=bind,source=/workspace/work,target=/workspace/work \
  --workdir /workspace/work/mohassan-wave5 \
  --env PLAYWRIGHT_BROWSERS_PATH --env npm_config_cache \
  mohassan-wave5-bench:2026-11-25 python3 -B scripts/dev-bench/run.py --workers 2 --offline \
  --output /workspace/work/wave5-three-arms \
  --arm a=d3ebd9223f44445627b9d3d0bdea08d5f9b0550a \
  --arm b=26d0de8009d9ecc70195198e8f32c22755170e56 \
  --arm c=26d0de8009d9ecc70195198e8f32c22755170e56 \
  --set a:MOHASSAN_ARITHMETIC_SEARCH=1 --set a:TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3.12 \
  --set b:MOHASSAN_ARITHMETIC_SEARCH=1 --set b:TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3.12 \
  --set c:MOHASSAN_ARITHMETIC_SEARCH=1 --set c:TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3.12 \
  --set a:MOHASSAN_MODEL_RELATIONS=off --set b:MOHASSAN_MODEL_RELATIONS=off --set c:MOHASSAN_MODEL_RELATIONS=shadow \
  --set b:MOHASSAN_REPLY_POLICY_ENABLED=0 --set c:MOHASSAN_REPLY_POLICY_ENABLED=1 \
  --set b:MOHASSAN_CONTEXT_POLICY_ENABLED=0 --set c:MOHASSAN_CONTEXT_POLICY_ENABLED=1 \
  --set b:MOHASSAN_LONG_RUN_ENABLED=0 --set c:MOHASSAN_LONG_RUN_ENABLED=1 \
  --set b:MOHASSAN_BACKGROUND_RESULTS_ENABLED=0 --set c:MOHASSAN_BACKGROUND_RESULTS_ENABLED=1 \
  --set b:MOHASSAN_ARBITER_ROUTING=0 --set c:MOHASSAN_ARBITER_ROUTING=1 \
  --set b:MOHASSAN_ARBITER_QUESTION_REWRITE=0 --set c:MOHASSAN_ARBITER_QUESTION_REWRITE=1 \
  --set b:MOHASSAN_ARBITER_LOCAL_COMPUTATION=0 --set c:MOHASSAN_ARBITER_LOCAL_COMPUTATION=1 \
  --set b:MOHASSAN_ARBITER_COMPOUND_PLAN=0 --set c:MOHASSAN_ARBITER_COMPOUND_PLAN=1
```

For future builds, `scripts/dev-bench/` is the equivalent committed Docker build context.

The three-arm command exited 0. The coordinated summary SHA-256 is `09db49e3decca632f6439d3224a1ad944425ab554922cbb85cb11c72505855c7`.

| Arm | V1 | V2 | Coordinated case receipt SHA-256 |
| --- | ---: | ---: | --- |
| A · Release candidate | 176/240 | 1,588/2,400 | `4fafc814950b2502cb53fb31b0dce02cf2bcf0e956e5ccb580bd5800e2689a53` |
| B · Merged, flags off | 176/240 | 1,588/2,400 | `1bf9f95e687eacdfb3582886a6d50b02286f0f500d8fb33c485301ceb7705c48` |
| C · Merged, flags on, shadow | 176/240 | 1,588/2,400 | `9625d42043e0a115be439a5d13b500350eb1b5483574cb8ebbdf866780bbe82a` |

C held every area, language and area/language count. The comparison covered 45 V1 groups and 23 V2 groups, including the two overall scores. B matched A for all 2,640 verdicts and scored check signatures. The unmasked comparator exited 1 because independently generated reply values and stock phrase variants produced byte differences in 31 V1 and 1,053 V2 cases.

```bash
python3 -B scripts/dev-bench/compare.py \
  --baseline /workspace/work/wave5-three-arms/a/receipt.json \
  --flags-off /workspace/work/wave5-three-arms/b/receipt.json \
  --flags-on /workspace/work/wave5-three-arms/c/receipt.json \
  --output /workspace/work/wave5-three-arms/unmasked-comparison.json
```

### Arbiter publication latency

The Arm C journals contain the production publication hook's `schedulingMs` measurements. The extraction uses the same nearest-rank percentile as the #91 replay. Each command exited 0 against the 1 ms p95 budget. The asynchronous arbitration times describe background work outside that budget. [PR #91 verification](ARBITER-BRAIN-VERIFICATION.md)

```bash
python3 -B /workspace/work/wave5-shadow-latency.py /workspace/work/wave5-three-arms/c/v1-shadow.jsonl
python3 -B /workspace/work/wave5-shadow-latency.py /workspace/work/wave5-three-arms/c/v2-shadow.jsonl
```

| Split | Publication samples | Publication p95 | Background arbitration samples | Background p95 | Journal SHA-256 |
| --- | ---: | ---: | ---: | ---: | --- |
| V1 | 279 | 0.135219 ms | 19 | 0.453226 ms | `c40e6c5597008a4990ff4dcbc17dd0c015f9f541172185b3f449c3aaa41551ea` |
| V2 | 2,400 | 0.095481 ms | 30 | 3.571057 ms | `3b9ea65b2fc99627e48a24a2db7f49d4b520191b1dcfc9678555e821966ecfb0` |

The same extractor is available at `scripts/dev-bench/forensics/shadow-latency.py`.

The shadow journal recorded 49 choices, with zero selections departing from existing precedence. The command below exited 0 and returned `{"decisions":49,"changed":0}`.

```bash
jq -s '[.[].arbiter[]?] | {decisions:length, changed:(map(select(.selected != .precedence))|length)}' /workspace/work/wave5-three-arms/c/v1-shadow.jsonl /workspace/work/wave5-three-arms/c/v2-shadow.jsonl
```

### Flags-off reply parity

The separate release repeat exited 0 at 176/240 and 1,588/2,400. Its commit, toolchain, settings and input hashes matched Arm A. All 2,640 repeat verdicts matched. The repeated case receipt SHA-256 is `f16c166381f9d0996ce7c6d3a9c27799a059c7d26d376facece6d9eb74f89b58`.

```bash
export PLAYWRIGHT_BROWSERS_PATH=/workspace/work/chromium
export npm_config_cache=/workspace/work/npm-cache
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
  --mount type=bind,source=/workspace/work,target=/workspace/work \
  --workdir /workspace/work/mohassan-wave5 \
  --env PLAYWRIGHT_BROWSERS_PATH --env npm_config_cache \
  mohassan-wave5-bench:2026-11-25 python3 -B scripts/dev-bench/run.py --workers 2 --offline \
  --output /workspace/work/wave5-baseline-repeat \
  --arm a-repeat=d3ebd9223f44445627b9d3d0bdea08d5f9b0550a \
  --set a-repeat:MOHASSAN_ARITHMETIC_SEARCH=1 --set a-repeat:MOHASSAN_MODEL_RELATIONS=off \
  --set a-repeat:TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3.12
```

The repeat independently proved 1,044 citation timestamp changes and nine generated document URL UUID changes. The mask generator exited 0. Each validated mask identifies the exact case, turn and changing literal, and the comparator verifies identical text around it. The mask SHA-256 is `ef1cfb25f7f6a530b854c5df93f66d662fcc97059d9e06eae6c8afdb671bfcb8`.

```bash
python3 -B scripts/dev-bench/forensics/reply-masks.py \
  --baseline /workspace/work/wave5-three-arms/a/receipt.json \
  --flags-off /workspace/work/wave5-three-arms/b/receipt.json \
  --baseline-repeat /workspace/work/wave5-baseline-repeat/a-repeat/receipt.json \
  --masks-output /workspace/work/wave5-three-arms/proven-masks.json \
  --residual-output /workspace/work/wave5-three-arms/residual-wording.json

python3 -B scripts/dev-bench/compare.py \
  --baseline /workspace/work/wave5-three-arms/a/receipt.json \
  --flags-off /workspace/work/wave5-three-arms/b/receipt.json \
  --flags-on /workspace/work/wave5-three-arms/c/receipt.json \
  --baseline-repeat /workspace/work/wave5-baseline-repeat/a-repeat/receipt.json \
  --reply-masks /workspace/work/wave5-three-arms/proven-masks.json \
  --output /workspace/work/wave5-three-arms/masked-comparison.json
```

The literal-masked comparator exited 1. The only remaining reply differences were eight V1 and 25 V2 small-talk cases. The existing manners code varies stock phrases by hashing generated run IDs. Its template source is the same on the release candidate and merged head. No phrases or whole replies were masked. The comparison SHA-256 is `e162cea109c7204fdde6840b7a2b40efd3ed248156b9299b13abdc19b1a1d996`.

The release repeat chose different wording in six of the eight affected V1 cases and 18 of the 25 affected V2 cases. An additional exact replay covered all 33. In isolated A and B worktrees it supplied the same case-scoped UUID stream to the existing handlers. The replay verified the original product, fixture, lockfile, scorer and adapted observer hashes. It compared full reply hashes, native verdicts and UUID call counts, and exited 0. Both arms produced byte-identical replay receipts in each split.

```bash
export PLAYWRIGHT_BROWSERS_PATH=/workspace/work/chromium
export npm_config_cache=/workspace/work/npm-cache
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
  --mount type=bind,source=/workspace/work,target=/workspace/work \
  --workdir /workspace/work/mohassan-wave5 \
  --env PLAYWRIGHT_BROWSERS_PATH --env npm_config_cache \
  mohassan-wave5-bench:2026-11-25 python3 -B /workspace/work/wave5-entropy-replay/replay.py \
  /workspace/work/mohassan-wave5 \
  /workspace/work/wave5-three-arms/a/receipt.json \
  /workspace/work/wave5-three-arms/b/receipt.json \
  /workspace/work/wave5-reply-residual.json /workspace/work/wave5-controlled-manners
```

The committed equivalent is `scripts/dev-bench/forensics/replay.py` with its sibling `replay.mjs`. Pass `residual-wording.json` from the literal-mask command above as the selection. `cmp` confirmed it was byte-identical to the selection used in the replay.

| Split | Exact full reply and verdict matches | Replay receipt SHA-256 on each arm |
| --- | ---: | --- |
| V1 | 8/8 | `9588d753d0866c04ac5aabceda3ba1bd9bf22d0e5888c18ac4842b3bc8840c1d` |
| V2 | 25/25 | `6a8566c912762bfb38fc63f957934b392aa197b2e38b1296b9770175f93cf313` |

The replay summary SHA-256 is `d8c7a5adbf0c7d745457193b066dde5e8c5061f8781f9aadc7569c921b2a4961`. The final coverage cross-check exited 0 after validating the original A and B receipt hashes and checking that the 33 replayed IDs exactly covered the literal comparator's differences:

```bash
python3 -B - /workspace/work/wave5-three-arms/masked-comparison.json /workspace/work/wave5-controlled-manners/summary.json <<'PY'
import json
from pathlib import Path
import sys

comparison, replay = [json.loads(Path(path).read_bytes()) for path in sys.argv[1:]]
for side, label in (("a", "baseline"), ("b", "flagsOff")):
    assert replay["arms"][side]["armReceiptSha256"] == comparison["inputs"][label]["receiptSha256"]
for version, group in comparison["versions"].items():
    assert not (group["flagsOnRegressions"] or group["flagsOffVerdictDifferences"] or group["repeatVerdictDifferences"])
    residual = [row["caseId"] for row in group["flagsOffReplyDifferences"]]
    proof = replay["versions"][version]
    assert residual == [row["id"] for row in proof]
    assert all(row["exactReplyMatch"] and row["verdictsMatchNative"] and row["uuidCallCountsMatch"] for row in proof)
    print(version, group["casesCompared"], "cases covered by literal comparison or exact fixture replay,", len(proof), "replayed")
PY
```

### Premortem requirements

- The flags-off comparison covers every case with exact replies, repeat-proven literal masks or exact matched-input replay. The focused background suites exercise the restart and stop paths where its projection and the interactive arbiter hook meet.
- The disposable PostgreSQL upgrade applied only 041 and 042. Existing rows in the release database matched on every original column.
- The committed launcher retrieved fixed development inputs, reproduced Wave 4 and ran all three Wave 5 arms in one invocation with case and receipt validation. All evaluation runs used the development splits.

### Full Vitest

The full suite ran from `/workspace/work/wave5-vitest-candidate`, detached at `26d0de8009d9ecc70195198e8f32c22755170e56`. This run used three file workers. The historical release run used one worker and the same repository test selection.

```bash
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/chromium npm_config_cache=/workspace/work/npm-cache npm test -- --maxWorkers=3 --fileParallelism --reporter=default --reporter=json --outputFile.json=/workspace/work/wave5-vitest-merged.json
```

| Run | Files collected | Passed | Failed | Expected fail | Skipped | Duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Release candidate report | 562 | 9,915 | 23 | 1 | 83 | 6,102.37 s |
| Merged candidate | 570 | 10,027 | 21 | 1 | 73 | 2,137.70 s |

Exit 1 with 557 passing, five failing and eight skipped files. All 21 failures matched the release report by test identity. The candidate passed the previously failing cooldown and source-leakage assertions, the ten browser-file cases, and all 36 cases in the two files previously interrupted by V8 worker crashes. No worker crash occurred in this run. [Release Vitest results](RELEASE-CANDIDATE-2026-11-25.md#full-vitest)

| File | Matched failed identities |
| --- | --- |
| `tests/ads-goal-grammar.test.ts` | The 15 generated-grammar cases, including each Arabic and English instance. The independent duplicate-label checker passed. |
| `tests/ads-goal-corpus.test.ts` | `uses local phrases in both languages while retaining valid pointers and attached location prefixes` |
| `packages/desktop/src/desktop.test.ts` | `scaffolds a node project with git and registers it` |
| `tests/assistant-runtime-constraints-chat.test.ts` | `completes the supported recall request without forbidden I/O: Do not save anything. What is my depot …` |
| `tests/assistant-test-driven-coding.test.ts` | `publishes a verified function when enabled`, `withholds a declaration on contradictory assertions and when the flag is off`, `does not discard an unsupported assertion before supported examples` |

The missing Git-ignored Ads vocabulary accounts for the 16 Ads failures. The desktop case needs Windows `cmd.exe`. The release report identifies the same three coding failures in a native sandbox without a trusted Python interpreter. Our primary development comparison used the isolated trusted Python runtime.

JSON receipt SHA-256 `3f2ddf9f4dedfa6177dba71674a01095d372451bc416a4f8b465ca8a6fda9b48`. Console log SHA-256 `ae15cfc655a8e9840866f4fb6d0015f5bafc03af90cb4fee52f2610b85117b3d`.

The failure comparison command exited 0 with 21 matches and zero candidate-only assertions or suite errors. Its JSON SHA-256 is `5eeef38d3815bf22c7dd8206e408324ff8f7326fcff0403076e41ec35c320865`.

```bash
python3 -B /workspace/work/wave5-vitest-review/compare-release.py /workspace/work/wave5-vitest-merged.json /workspace/work/wave5-vitest-candidate
```

Eight files collected only skipped cases. These cover two local-development-corpus guards, three Windows/AppContainer suites, two optional resident-model-worker suites, and the exported OCR model parity suite. Their required local fixtures, Windows, model-worker configuration or OCR artifacts were unavailable in the full-suite checkout. The 73 skipped assertions are recorded in the JSON receipt.

### Playwright

The historical report supplies counts for all five configurations and names the default profile's candidate-only failure. The pinned release replay supplies complete failure identities for direct comparison. Both replays collected and ran 52 tests across the five profiles. The configurations and specs are identical between the measured commits.

The release checkout was `/workspace/work/wave5-rc-tests`. The candidate checkout was `/workspace/work/wave5-playwright-candidate`. Both used the same local Chromium 1248, the isolated application fixture on ports 3100 and 4100, and a scratch preload supplying the installed browser and local Alexandria fonts. The three-worker Vitest run overlapped part of the browser runs.

```bash
set -o pipefail
bash /workspace/work/wave5-verification/run-playwright.sh /workspace/work/wave5-rc-tests 2>&1 | tee /workspace/work/wave5-verification/playwright-rc.log
bash /workspace/work/wave5-verification/run-playwright.sh /workspace/work/wave5-playwright-candidate 2>&1 | tee /workspace/work/wave5-verification/playwright-candidate.log
```

Each wrapper recorded the individual command and exit status. These are the corresponding test commands for the two checked-out revisions:

```bash
export PLAYWRIGHT_BROWSERS_PATH=/workspace/work/chromium
export npm_config_cache=/workspace/work/npm-cache
export NODE_OPTIONS=--require=/workspace/work/wave5-verification/playwright-preload.cjs
export MOHASSAN_E2E_WEB_PORT=3100
export MOHASSAN_E2E_SERVER_PORT=4100
for config in playwright.config.ts playwright.browser-visibility.config.ts \
  playwright.browser-autonomy.config.ts playwright.agent-execution.config.ts \
  playwright.skills-focus-audit.config.ts; do
  name=${config%.config.ts}
  PLAYWRIGHT_JSON_OUTPUT_FILE="$evidence/$name.json" npm run test:e2e -- \
    --config="$config" --output="$evidence/$name-artifacts" --reporter=line,json
done
```

The release evidence directory is `/workspace/work/wave5-verification/playwright-d3ebd92.bLr8INkS` and the candidate directory is `/workspace/work/wave5-verification/playwright-26d0de8.fP8jooIQ`. Counts are passed / failed / skipped. The exit status matches on both replays. [Historical Playwright results](RELEASE-CANDIDATE-2026-11-25.md#playwright)

| Configuration | Published release | Pinned release replay | Merged candidate | Exit | Matched failures |
| --- | ---: | ---: | ---: | ---: | ---: |
| `playwright.config.ts` | 31 / 8 / 1 | 33 / 7 / 0 | 33 / 7 / 0 | 1 | 7 |
| `playwright.browser-visibility.config.ts` | 5 / 0 / 0 | 5 / 0 / 0 | 5 / 0 / 0 | 0 | 0 |
| `playwright.browser-autonomy.config.ts` | 1 / 1 / 0 | 1 / 1 / 0 | 1 / 1 / 0 | 1 | 1 |
| `playwright.agent-execution.config.ts` | 0 / 1 / 0 | 0 / 1 / 0 | 0 / 1 / 0 | 1 | 1 |
| `playwright.skills-focus-audit.config.ts` | 4 / 0 / 0 | 4 / 0 / 0 | 4 / 0 / 0 | 0 | 0 |

Each default failure matched by spec, Chromium project and title:

- `ads-sign-in.spec.ts:17` · Google sign-in from the chat returns to the same conversation and continues it.
- `agent-execution.spec.ts:25` · a request goes from the composer through the runtime to a verdict the screen shows as the server holds it. The dedicated execution profile reported this same identity.
- `assistant-browser-cursor.spec.ts:18` · shows the real agent cursor moving between targets and recovers a failed screen frame. The dedicated autonomy profile reported this same identity.
- `assistant-browser-cursor.spec.ts:92` · resumes the same browser task when scrolling replaces the observed button before input.
- `assistant.spec.ts:42` · a task runs from one message through sign-in, a code and an approval.
- `browser-files.spec.ts:6` · owner reviews an upload grant and releases a verified download from quarantine. Both runs hit its 150-second cap.
- `workspace.spec.ts:6` · owner setup, approvals, verified results, offline recovery and mobile navigation. Both logs contain `GET /api/auth/get-session` returning 429 before the timeout.

The historical default profile timed out on the hidden-tab notice and skipped the subsequent notification-permission case. Both identities passed in both replays. There were no flaky results or runner errors in any of the ten receipts.

The identity comparison exited 0 for all five matched pairs:

```bash
rc=/workspace/work/wave5-verification/playwright-d3ebd92.bLr8INkS
merged=/workspace/work/wave5-verification/playwright-26d0de8.fP8jooIQ
for profile in playwright playwright.browser-visibility playwright.browser-autonomy \
  playwright.agent-execution playwright.skills-focus-audit; do
  python3 -B /workspace/work/wave5-verification/failed-tests.py playwright "$rc/$profile.json" "$merged/$profile.json"
done
```

| JSON receipt | Pinned release SHA-256 | Merged SHA-256 |
| --- | --- | --- |
| Default | `80546746cb2d4c1bfc5039ac652294e29c90e1e4bcdadd4236c1911478373636` | `1a9f03225cd61fbfbf82ddc1e68fcd08173391a158357bdc4a48bc9f3b11bc96` |
| Browser visibility | `c49d44d97bcb3ce5ca384fbfe505ca83943bbcd6c7b5b4e7d68739a8e422f8af` | `3508752bc2381f2e2a98fdef7d76527d362d0ba07dba37ddfcb3f08295166be9` |
| Browser autonomy | `c3841d63ee60acb49236cd48e9df435151788a2b716963a98305c3f4db446d56` | `94b6710d1094e61f79eb5b42dba903b19dea806969d20592e2dd27dd6c3d23b1` |
| Agent execution | `5b7a22fb3ab8554863ad6eb8636a1749247abe58dae6af88d64bc3c8c53aa118` | `f911b69677c0e1801b4639a2d293b65399a8748fc195e071e2f0ea41161fde00` |
| Skills focus | `bb1a83f6b9be3723ed6e0ab51ba1afa9dfb9bd00ffff629a8a388cad941405de` | `04ed452d9182a18731d62ffaaa65f3bdb6e1750187d06a06a7b0b005bd61fb74` |

The checks cover the three rollout configurations in development and APNs through the focused test fixtures. Live Apple delivery, native Windows behavior, and the optional local artifacts listed above remain unverified.
