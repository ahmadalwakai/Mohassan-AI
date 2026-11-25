# Mohassan AI release candidate · 25 November 2026

> يجمع هذا المرشّح مسار الوكيل ومسار المنصّة في طلب دمج واحد للمالك. يشمل تحسينات المحادثة والبحث والحساب، والنسخ الاحتياطي والمقاييس والإشعارات والتذكيرات والمشاركة وحقوق بيانات الأعضاء. حصل الإصدار المختوم على ٢٦ من ٦٠ في v1 و٧٩٧ من ١٢٠٠ في v2. يوضّح التقرير نتائج الاختبارات وخطوات النشر والتراجع والقرارات التي بقيت للمالك.

## Contents

The release branch is `release/rc-2026-11-25`. Its review base is `feat/skill-engine` at `c2a0ff765071657cf200b5ee7d12fabaad738c0b`, the common base of both lines. The owner can use GitHub's merge-commit option to retain both lines and the included follow-up heads in one ancestry-preserving merge. [Owner draft #88](https://github.com/ahmadalwakai/Mohassan-AI/pull/88)

| Input | Fetched head | Responsibility |
| --- | --- | --- |
| Agent line #84 | `d4654f4f9e9ce7f142c4376c95a5dd4fe0fbc7b2` | Waves 1–4 for local routing, writing, evidence, memory, clarification, refusals and verified Python. |
| Platform line #76 | `ef54ec49b2c54e17321f0037064fb7b1dcce3dff` | Backups and restore drills, metrics, reminders, Web Push, conversation sharing, member data rights, live data, local training monitor, gate runner, corpus pipeline, structured evidence tooling, permanent model worker and deterministic coding repair. |

The two-parent platform merge is `013e6dceee11181a3f3a4b23539fe7aaaa44c726`, with the agent head first and platform head second. The conflict resolution retains the refusal-aware chat factory, ordered migration callbacks, clarification and structured-memory wrappers, notification recovery and both judge review and log rotation. It combines both sets of dependencies, retains wave‑4 date grammar and applies #68's original four-line additions and removals. [Wave 4 report](INTEGRATION-WAVE-4-2026-11-25.md) · [Platform report](RELEASE-PLATFORM-WAVE-1-2026-11-25.md)

- `5c9030b7b851f99c2fba400bd68c75a6c5b1ba93` adds the wave‑4 structured-memory tables to the account-data registry. Accounts export their structured facts and purge their facts and internal operation rows before deleting the account.
- `060c793063138f97acab32f09479c3d6f474b2ca` lets explicit unscheduled memory recalls reach the agent when their wording starts like a reminder. Dated and timed reminders still schedule, and unfinished action reminders still request timing. Tests cover English and Arabic recalls and the scheduled and unscheduled reminder paths.

- `b6b9183a94355577bf45f8b0c2aa292c37f6f172` updates the browser-files schema fixture and scopes the development source-guard exception to the single unchanged inherited occurrence.

## Exclusions

- #54 is held because it lost v2 factual cases.
- #10, #11 and #12 are alternatives of #3, #2 and #1, respectively.
- `fix/gpu-guard-retry` at `0f5f2a5839504c0bf2364736fddf308b6619256c` and `fix/gpu-guard-retry-alt` at `3f107e866b6ef561d08104f06841db9fda6dbc26` are held until the owner confirms the v5 training run has ended, expected around 26 November.
- `wip/local-snapshot-2026-11-25` at `b74324309791ae8afd6f5eb246eaa6f4c11cf682` is the owner's local work in progress.
- The PR inventory records exclusions outside the two lines and any approved follow-up ancestry. Benchmark fixtures and receipts are scratch inputs. The release preserves the pinned `packages/execution-pipeline/` and `packages/execution-model/` trees.

## Follow-up decisions

| Order | Follow-up | Fetched head | Trial merge | Development decision |
| ---: | --- | --- | --- | --- |
| 1 | #85 arithmetic expression search | `f161bbb84f24677efb5758195534ca46d3330b05` | `ebefa2666e0bc159f94bd4bcd0c4e3a9b97804ee` | Retained. V2 gained two English calculation passes. Every other group and case held. |
| 2 | #87 verified Python hardening | `94dff4a6f9025416b37d6c9dc2519a9c7b62bf48` | `94e2e594c8c11dece9d1602776c0784a01956539` | Retained after the split checks and verifier prerequisites were confirmed. Every development case held. |
| 3 | #86 local model-relations manager | `14a32baea43d1793839b53d144021c228e9ac30d` | `9b04aecd56708a6d36c6100122b80cdce6197cae` | Retained. Every development case held with `MOHASSAN_ARITHMETIC_SEARCH=1` and `MOHASSAN_MODEL_RELATIONS=off`. |

The model-relations branch brings its recorded #29, #44 and #8 ancestry, with #19 already present through the platform merge. The runbook includes both #86's model instructions and #87's verifier requirements. The PR descriptions supplied final development results at the heads listed above. [#85](https://github.com/ahmadalwakai/Mohassan-AI/pull/85) · [#87](https://github.com/ahmadalwakai/Mohassan-AI/pull/87) · [#86](https://github.com/ahmadalwakai/Mohassan-AI/pull/86)

### Not ready

All three requested follow-ups supplied the required development results. The remaining exclusions are shown in the inventory.

## Benchmark results

The frozen revision is `b6b9183a94355577bf45f8b0c2aa292c37f6f172` with tree `c7a9c4390fd5cc9a56a9433ef529216f5e74b27e`. Development measured the same runtime at `9b04aecd56708a6d36c6100122b80cdce6197cae`. The final differences are confined to the two Vitest fixture files named below.

Each sealed set ran once, after the frozen revision was pushed. V1 scored **26/60**, one below wave 4. The difference is one English small-talk pass. V2 scored **797/1,200**, matching every published wave‑4 area and language and exceeding the published `c2a0ff7` score of 247/1,200 by 550 passes. [Wave 4 results](INTEGRATION-WAVE-4-2026-11-25.md) · [Published v2 baseline](https://github.com/ahmadalwakai/Mohassan-AI/pull/56)

### V1 development

| Group | Wave 4 calibration | Platform merge | #85 | #87 | #86 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Overall | 176/240 | 176/240 | 176/240 | 176/240 | 176/240 |
| Area / calculation | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| Area / clarification | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 |
| Area / coding | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 |
| Area / comparison | 11/18 | 11/18 | 11/18 | 11/18 | 11/18 |
| Area / desktop | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 |
| Area / document-file | 16/18 | 16/18 | 16/18 | 16/18 | 16/18 |
| Area / explanation | 8/18 | 8/18 | 8/18 | 8/18 | 8/18 |
| Area / factual | 10/18 | 10/18 | 10/18 | 10/18 | 10/18 |
| Area / follow-up | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| Area / google-ads | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 |
| Area / memory | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 |
| Area / multi-step | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| Area / refusal | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 |
| Area / small-talk | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| Language / ar | 85/120 | 85/120 | 85/120 | 85/120 | 85/120 |
| Language / en | 91/120 | 91/120 | 91/120 | 91/120 | 91/120 |

### V2 development

| Group | Wave 4 calibration | Platform merge | #85 | #87 | #86 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Overall | 1,586/2,400 | 1,586/2,400 | 1,588/2,400 | 1,588/2,400 | 1,588/2,400 |
| Area / calculation | 5/277 | 5/277 | 7/277 | 7/277 | 7/277 |
| Area / clarification | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| Area / coding | 108/155 | 108/155 | 108/155 | 108/155 | 108/155 |
| Area / comparison | 28/32 | 28/32 | 28/32 | 28/32 | 28/32 |
| Area / factual | 976/1,244 | 976/1,244 | 976/1,244 | 976/1,244 | 976/1,244 |
| Area / follow-up | 46/240 | 46/240 | 46/240 | 46/240 | 46/240 |
| Area / refusal | 348/375 | 348/375 | 348/375 | 348/375 | 348/375 |
| Area / small-talk | 66/68 | 66/68 | 66/68 | 66/68 | 66/68 |
| Language / ar | 982/1,200 | 982/1,200 | 982/1,200 | 982/1,200 | 982/1,200 |
| Language / en | 604/1,200 | 604/1,200 | 606/1,200 | 606/1,200 | 606/1,200 |

### V1 sealed

| Group | Wave 4 (published) | Frozen candidate |
| --- | ---: | ---: |
| Overall | 27/60 | 26/60 |
| Area / calculation | 3/4 | 3/4 |
| Area / clarification | 1/4 | 1/4 |
| Area / coding | 0/4 | 0/4 |
| Area / comparison | 0/4 | 0/4 |
| Area / desktop | 3/4 | 3/4 |
| Area / document-file | 1/4 | 1/4 |
| Area / explanation | 1/4 | 1/4 |
| Area / factual | 4/6 | 4/6 |
| Area / follow-up | 3/4 | 3/4 |
| Area / google-ads | 0/4 | 0/4 |
| Area / memory | 2/4 | 2/4 |
| Area / multi-step | 5/6 | 5/6 |
| Area / refusal | 2/4 | 2/4 |
| Area / small-talk | 2/4 | 1/4 |
| Language / ar | 14/30 | 14/30 |
| Language / en | 13/30 | 12/30 |

### V2 sealed

| Group | Wave 4 (published) | Frozen candidate |
| --- | ---: | ---: |
| Overall | 797/1,200 | 797/1,200 |
| Area / calculation | 0/110 | 0/110 |
| Area / clarification | 11/17 | 11/17 |
| Area / coding | 51/85 | 51/85 |
| Area / comparison | 65/70 | 65/70 |
| Area / factual | 399/515 | 399/515 |
| Area / follow-up | 16/95 | 16/95 |
| Area / refusal | 228/258 | 228/258 |
| Area / small-talk | 27/50 | 27/50 |
| Language / ar | 493/600 | 493/600 |
| Language / en | 304/600 | 304/600 |

### Benchmark receipts

| Split | Revision | Measured commit | UTC start and finish | Receipt SHA-256 |
| --- | --- | --- | --- | --- |
| V1 development | Wave 4 calibration | `d4654f4f9e9ce7f142c4376c95a5dd4fe0fbc7b2` | 2026-11-25T11:47:06.297Z → 2026-11-25T11:47:43.740Z | `dd999741373f689a88af9a250432600de698cd04a4980ecb91aad5ae57be3ac2` |
| V1 development | Platform merge | `013e6dceee11181a3f3a4b23539fe7aaaa44c726` | 2026-11-25T11:52:30.585Z → 2026-11-25T11:53:31.657Z | `7d25324c85d22b8a12d875578aeb12c763c9f74d1e791e4798fcf06c1faa35cd` |
| V1 development | #85 | `ebefa2666e0bc159f94bd4bcd0c4e3a9b97804ee` | 2026-11-25T12:44:31.166Z → 2026-11-25T12:45:18.722Z | `423dd778ac6178b78f606ae1e1b2c4c48668ae0dc20495c24a16a38cb675589f` |
| V1 development | #87 | `94e2e594c8c11dece9d1602776c0784a01956539` | 2026-11-25T13:06:49.941Z → 2026-11-25T13:08:22.896Z | `b5c29c0ea9ebcfe4c84e4b20f669ef1fc57df8594e34200f7e392f980254f635` |
| V1 development | #86 | `9b04aecd56708a6d36c6100122b80cdce6197cae` | 2026-11-25T13:24:07.276Z → 2026-11-25T13:25:23.373Z | `3ff607236cb2bd608e3eea0f7b54cce8271a155cef04fe18f643fdaa72f63a5b` |
| V2 development | Wave 4 calibration | `d4654f4f9e9ce7f142c4376c95a5dd4fe0fbc7b2` | 2026-11-25T11:47:49.567Z → 2026-11-25T11:50:36.567Z | `a823f873d40a660aba89c037a46dfce29c514dfa8e04a54480b6c10da5b3b2b2` |
| V2 development | Platform merge | `013e6dceee11181a3f3a4b23539fe7aaaa44c726` | 2026-11-25T11:53:41.573Z → 2026-11-25T11:56:39.626Z | `2e597097e02b0a86093e93713af136cff93ba848cf25303dfeeba66a48fda2bd` |
| V2 development | #85 | `ebefa2666e0bc159f94bd4bcd0c4e3a9b97804ee` | 2026-11-25T12:45:26.044Z → 2026-11-25T12:47:50.262Z | `ea85cf7bdb94a198732cdb3634345ac31d3815b9836aed8f0a836d3c0238ee8d` |
| V2 development | #87 | `94e2e594c8c11dece9d1602776c0784a01956539` | 2026-11-25T12:51:56.580Z → 2026-11-25T12:54:55.293Z | `819a59a4d1d9e5d460bd0382abf2878accf218114f08a85906a168d9aefba4c2` |
| V2 development | #86 | `9b04aecd56708a6d36c6100122b80cdce6197cae` | 2026-11-25T13:25:54.443Z → 2026-11-25T13:42:42.059Z | `1ec7cfe767fdb8240dd65ace7f73055284c3e4c59cde7b7e5b30f0c17fe38be1` |
| V1 sealed | Final product | `b6b9183a94355577bf45f8b0c2aa292c37f6f172` | 2026-11-25T14:41:36.589Z → 2026-11-25T14:42:23.385Z | `5b95ea89a40e513ede70681241a033d702c8401ff1d3fc1595a02da8c2eeb9a3` |
| V2 sealed | Final product | `b6b9183a94355577bf45f8b0c2aa292c37f6f172` | 2026-11-25T14:42:35.252Z → 2026-11-25T14:45:45.989Z | `b463e6eb1e630fe3a6e666399c2e4b5f26db49b58a7f1cb58e61aa1906ef644b` |

## Test suite comparison

### Full Vitest

The table reports the original serial runs. Each exited 1. The final full run tested the product through #86 at `9b04aec`. The frozen revision has the same runtime tree and changes two test files. The focused runs below exercise both updates and complete the two files whose Vitest workers exited early.

| Revision | Collected files | Passed | Failed | Expected fail | Skipped | Duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline `c2a0ff7` | 403 | 7,555 | 20 | 1 | 48 | 3,608.40 s |
| Platform merge `013e6dc` | 546 | 9,797 | 22 | 1 | 75 | 5,515.40 s |
| #85 trial `ebefa26` | 550 | 9,846 | 21 | 1 | 75 | 6,503.18 s |
| #87 trial `94e2e59` | 551 | 9,852 | 25 | 1 | 75 | 6,343.66 s |
| #86 trial `9b04aec` | 562 | 9,915 | 23 | 1 | 83 | 6,102.37 s |

The baseline and #86 shared 17 failures by test identity. Sixteen were in the Ads corpus and grammar tests that require `artifacts/ads-training/service-vocab.json`. One was the Windows-only scaffolding test invoking `cmd.exe` on Linux. The intermittent iframe safety case failed in the baseline run and passed in the #86 run.

#### #86 failures after a baseline pass

| Test | Finding |
| --- | --- |
| `tests/assistant-model-recovery-chat.test.ts` · keeps the input-rejected free candidate out of the decision retry while the real 30000ms rate-limit cooldown expires | The full run saw a cooldown timer assertion fire after the active block was already cleared. Vitest also reported the callback as an uncaught exception. All nine tests passed in the focused rerun. |
| `tests/assistant-runtime-constraints-chat.test.ts` · completes the supported recall request without forbidden I/O (`Do not save anything. What is my depot …`) | Reproduced on the unmerged wave‑4 head. #83 treats the unqualified memory wording as a public-subject reference. The code token then takes the coding path and reports missing capability while the save veto remains active. |
| `tests/browser-files.test.ts` · suite setup hook | Wave 4's `035_chat_conversation_review` creates the canonical conversation table before the older test issues its manual CREATE. The frozen test uses the production migration sequence and supplies a fixture title. Its ten cases passed. |

#### #86 failures with no baseline case

- `tests/assistant-capability-case-leakage.test.ts` · detects frozen development inputs beyond the pinned source baseline. The guard's former whole-file hash stopped matching after unrelated edits to the manners source. The flagged occurrence already existed on the exact same line of the reviewed #40 source. The frozen test exempts only that one unchanged occurrence and checks that edits and duplicate occurrences remain visible. All three guard tests passed.
- `tests/assistant-test-driven-coding.test.ts` · publishes a verified function when enabled.
- `tests/assistant-test-driven-coding.test.ts` · withholds a declaration on contradictory assertions and when the flag is off.
- `tests/assistant-test-driven-coding.test.ts` · does not discard an unsupported assertion before supported examples.

The three verified-coding tests passed within a 20-test rerun on the same product code with root-owned Python 3.12.14 and an unprivileged UID. The native sandbox reported its Python executable as UID 65534, so the hardened launcher refused it.

The raw #86 run had two V8 WebAssembly allocation assertion failures, which ended the Vitest workers with `SIGTRAP` in `tests/assistant-user-fact-memory-verification-chat.test.ts` and `tests/assistant-clarification-time-audit.test.ts`. Both files ran again on the frozen revision and passed all 36 cases. The third unhandled error was the model-recovery timer callback described above.

#### Follow-up gates

- **#85 compared with the platform merge.** The only new raw failure was `tests/assistant-slot-shadow.test.ts`, “drops startup requests and concurrent work without a queue or per-request semantic return.” Its snapshot missed the completion under load. The focused file passed all 12 tests. Both member-data registry failures present in the raw platform run passed on #85 after the registry repair.
- **#87 compared with #85.** The incremental raw differences were the three verified-coding cases above, the permanent worker's “refuses startup wrong-id” test, the scratch classifier's 2 ms p95 test, and slot shadow's “loads the real own model in a compiled worker and exports only summaries” test. The focused reruns passed 20 verifier tests, 13 permanent-worker tests, seven classifier tests and 12 slot-shadow tests. The prior memory lifetime case passed after the reminder routing repair.
- **#86 compared with #87.** The only extra named failed test was the model-recovery case above. Both interrupted files passed when rerun. An extra focused classifier replay under load recorded a long-input p95 of 2.059 ms and failed the 2 ms gate. The same command after the full runs passed all seven classifier tests.

### Rerun commands

```bash
export PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave4/chromium
npm test -- tests/assistant-slot-shadow.test.ts
npm test -- --reporter=default packages/execution-integration/src/permanent-worker.test.ts
npm test -- packages/scratch-classifiers/src/index.test.ts
npm test -- --reporter=default tests/assistant-model-recovery-chat.test.ts
npm test -- tests/browser-files.test.ts tests/assistant-capability-case-leakage.test.ts
npm_config_cache=/workspace/work/rc-npm-cache npm test -- --reporter=default --reporter=json --outputFile.json=/workspace/work/rc-evidence/pr86-interrupted-files.json tests/assistant-user-fact-memory-verification-chat.test.ts tests/assistant-clarification-time-audit.test.ts
```

The slot-shadow command passed 12 tests in each of the #85, #87 and #86 trial checkouts. The permanent-worker command passed 13 on #87. The classifier command passed seven on #87 and passed seven on #86 after the full runs, following one failed timing check in the earlier focused #86 run. The model-recovery command passed nine on #86. Both fixture files passed all 13 tests on the frozen revision. The final line passed all 36 tests across the interrupted files on the frozen revision. The isolated verified-coding command in the focused checks below ran on #87 and #86 and passed 20 tests on each.

### Playwright

Playwright ran all five configurations on `c2a0ff7` and product trial `9b04aecd56708a6d36c6100122b80cdce6197cae`.
Counts are passed / failed / skipped.

| Configuration | Baseline | Candidate |
| --- | ---: | ---: |
| `playwright.config.ts` | 28 / 7 / 0 | 31 / 8 / 1 |
| `playwright.browser-visibility.config.ts` | 4 / 0 / 0 | 5 / 0 / 0 |
| `playwright.browser-autonomy.config.ts` | 1 / 1 / 0 | 1 / 1 / 0 |
| `playwright.agent-execution.config.ts` | 0 / 1 / 0 | 0 / 1 / 0 |
| `playwright.skills-focus-audit.config.ts` | 4 / 0 / 0 | 4 / 0 / 0 |

#### Candidate-only failures

- **`assistant-browser-visibility.spec.ts:101`, “a hidden tab keeps following its task and gets one system notice when it finishes” (default Playwright config).** The baseline test passed with the earlier behavior and did not assert restoring the conversation after a notice click. The candidate default run confirmed one notice and navigation to the correct conversation URL. After the HTML response, client startup took roughly ten seconds before the first session and setup calls. The 45-second test budget expired before the chat history loaded. A focused replay on the same candidate passed the full sequence, including conversation restoration and clearing the URL parameter, in 48.495 seconds of test time (206.46 seconds including setup). The replay used the default application fixture, a 120-second test budget, frontend and backend ports 3130 and 4130, and an isolated test site port 4231. The first focused invocation with the stock spec did not enter the test body because its fixed test site port 4201 was in use.

The default serial block skipped the notification-permission case after the hidden-notice timeout.
The stock browser-visibility configuration completed both cases.

The successful focused command ran from `/workspace/work/rc-pr86`.

```bash
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave4/chromium npm_config_cache=/workspace/work/rc-npm-cache NODE_OPTIONS=--require=/workspace/work/rc-e2e/preload.cjs MOHASSAN_E2E_WEB_PORT=3130 MOHASSAN_E2E_SERVER_PORT=4130 PLAYWRIGHT_JSON_OUTPUT_FILE=/workspace/work/rc-evidence/pr86-hidden-notice-isolated.json npm run test:e2e -- --config=/workspace/work/rc-e2e/hidden-notice-probe/playwright.config.ts --grep 'a hidden tab keeps following its task' --output=/workspace/work/rc-evidence/pr86-hidden-notice-isolated-traces --reporter=line,json
```

## Verification commands

### Development and sealed harness

The wave‑4 launcher lived in scratch. The release launcher reconstructed its pinned fixtures, observer adapters and scoring from #22, #41, #56, #62 and #70. The v1 development fixture SHA-256 was `712a170d3d60c6aec41f9fe44e7d5cc222bbafbe28d9ca763b5f396db2d2410b`. The v2 development and sealed directories matched the audit tree at `a1e1cb020b7ba093885edbf501149e7b8252c0cb`. Development worktrees imported only development data. The v2 coordinator validated each lane's case order and receipt hash and recomputed the published per-group scores.

All measurements used Node 24.22.3, Playwright Chromium 1248 (156.0.8078.4) and Python 3.12.14 with libseccomp. The wave‑4 calibration and platform ran with eight v2 lane processes. The isolated verifier trials used a network-disabled Debian container and an unprivileged service UID with root-owned Python. Every lane used the same modulo-eight assignment. The verifier contention probe limited concurrent lanes to two, and the model-relations trial ran the eight lanes one at a time. Both kept the pinned corpus and the original modulo-eight assignments. The Python time budget stayed at 2,500 ms.

The wave‑4 flags were `MOHASSAN_SMALL_TALK_MANNERS=1`, `MOHASSAN_CONVERSATION_REVIEW_APPLY=1`, `MOHASSAN_CONVERSATION_SHADOW=decide`, `MOHASSAN_STRUCTURED_MEMORY=1`, `MOHASSAN_EXTRACTIVE_WRITING=1`, `MOHASSAN_PLAN_COMPILER=on`, `MOHASSAN_REASONING=1`, `MOHASSAN_CLARIFY_CHOICES=1`, `MOHASSAN_SCRATCH_CLASSIFIERS=1`, `MOHASSAN_REFUSAL_POLICY=1`, `TEST_DRIVEN_CODING_ENABLED=true`, and `MOHASSAN_QUESTION_REWRITER=1`. The isolated launcher also set `MOHASSAN_ARITHMETIC_SEARCH=1` and `MOHASSAN_MODEL_RELATIONS=off`. #86 adds these settings. In #85 and #87, the arithmetic search does not require a flag.

The common CLI was `node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx scripts/agent-capability-bench/run.ts`. The development commands appended `--output "$receipt"` for v1 and `--v2-dev --output "$worker_receipt"` for each v2 lane. The review and memory adapters ran on both splits. The v2 runners and v1 sealed runner also used the clarification adapter.

```bash
/workspace/work/wave4/run development wave4 d4654f4f9e9ce7f142c4376c95a5dd4fe0fbc7b2
/workspace/work/wave4/run development platform 013e6dceee11181a3f3a4b23539fe7aaaa44c726
python3 -B /workspace/work/wave4/release-gate.py wave4 platform d4654f4f9e9ce7f142c4376c95a5dd4fe0fbc7b2 013e6dceee11181a3f3a4b23539fe7aaaa44c726 --exact
/workspace/work/wave4/run development pr85 ebefa2666e0bc159f94bd4bcd0c4e3a9b97804ee
python3 -B /workspace/work/wave4/release-gate.py platform pr85 013e6dceee11181a3f3a4b23539fe7aaaa44c726 ebefa2666e0bc159f94bd4bcd0c4e3a9b97804ee
```

The commands in this block exited 0. Wave 4 and the platform merge matched all 2,640 case outcomes. #85 gained two English calculation passes. Its other groups held.

### Verifier development replays

The first isolated #87 run exited 0. V2 matched #85 on all 2,400 cases. V1 scored 169/240 because the slim container lacked Chromium libraries used for document rendering. A focused Chromium PDF probe confirmed the missing dependencies. Installing the browser libraries restored v1 to 176/240 with all 16 document passes.

The eight-concurrent-lane rerun overlapped additional full suites and scored 1,577/2,400. Eleven previously passing English coding cases reached the coding handler and ended blocked after about 2.8–3.7 seconds. With two lanes at a time, v2 scored 1,587/2,400. The gate exited 1 for both contention runs. The accepted paired gate uses the v1 browser-enabled receipt and the v2 receipt from the first isolated run. Both record the same tested product SHA and lockfile. It exited 0 with every group and case outcome held. The contention results remain evidence of sensitivity to host load.

```bash
/workspace/work/wave4/run-isolated development pr87 94e2e594c8c11dece9d1602776c0784a01956539
MOHASSAN_RC_VERIFIER_IMAGE=mohassan-rc-verifier:2026-11-25-complete /workspace/work/wave4/run-isolated development pr87 94e2e594c8c11dece9d1602776c0784a01956539
MOHASSAN_RC_BENCH_WORKERS=2 MOHASSAN_RC_VERIFIER_IMAGE=mohassan-rc-verifier:2026-11-25-complete /workspace/work/wave4/run-isolated development pr87 94e2e594c8c11dece9d1602776c0784a01956539
python3 -B /workspace/work/wave4/release-gate.py pr85 pr87 ebefa2666e0bc159f94bd4bcd0c4e3a9b97804ee 94e2e594c8c11dece9d1602776c0784a01956539 --exact
```

The scratch launcher wrote a fresh receipt directory each time. Original receipts were retained under `pr87-incomplete-runtime`, `pr87-eight-concurrent` and `pr87-two-concurrent`. The `pr87` comparison paths refer to the accepted split receipts.

### Model-relations development and sealed commands

```bash
MOHASSAN_RC_BENCH_WORKERS=1 MOHASSAN_RC_VERIFIER_IMAGE=mohassan-rc-verifier:2026-11-25-complete /workspace/work/wave4/run-isolated development pr86 9b04aecd56708a6d36c6100122b80cdce6197cae
python3 -B /workspace/work/wave4/release-gate.py pr87 pr86 94e2e594c8c11dece9d1602776c0784a01956539 9b04aecd56708a6d36c6100122b80cdce6197cae
MOHASSAN_RC_VERIFIER_IMAGE=mohassan-rc-verifier:2026-11-25-complete /workspace/work/wave4/run-isolated sealed final b6b9183a94355577bf45f8b0c2aa292c37f6f172
python3 -B /workspace/work/wave4/check-seals.py b6b9183a94355577bf45f8b0c2aa292c37f6f172 final pr86
```

All four commands exited 0. The v1 sealed invocation used `--output "$receipt" --sealed tests/fixtures/agent-capability-bench/holdout/sealed.json`. The v2 original #56 invocation used `--version 2 --sealed tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output "$receipt"` and ran serially. The receipt verifier checked one start marker per split, the frozen SHA, lockfile hash, group denominators and the retained v1 development scores. The v2 sealed receipt is aggregate only.

### Full suite commands

The Vitest launcher used the repository's serial configuration in isolated checkouts with the same Chromium. For each candidate, the suffix in `--outputFile.json` was `platform`, `pr85`, `pr87`, or `pr86`. The baseline used `baseline`.

```bash
export PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave4/chromium
export npm_config_cache=/workspace/work/rc-npm-cache
npm test -- --reporter=default --reporter=json --outputFile.json=/workspace/work/rc-evidence/baseline-vitest.json
```

Both Playwright runs used the same local ports and a scratch preload to supply the matching Chromium path and first-party Alexandria font files to the isolated fixture. Each of the five repository configs ran separately. The runner stores a JSON receipt and exit status for each run.

```bash
/workspace/work/rc-e2e/run baseline
/workspace/work/rc-e2e/run pr86
```

The runner exports `PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave4/chromium`, `npm_config_cache=/workspace/work/rc-npm-cache`, `NODE_OPTIONS=--require=/workspace/work/rc-e2e/preload.cjs`, `MOHASSAN_E2E_WEB_PORT=3100`, and `MOHASSAN_E2E_SERVER_PORT=4100`. For each config it invokes `PLAYWRIGHT_JSON_OUTPUT_FILE="$result.json" npm run test:e2e -- --config="$config" --reporter=line,json`.

### Focused checks

| Revision | Command | Result |
| --- | --- | --- |
| Platform merge, #87 trial, #86 trial, frozen revision | `npm_config_cache=/workspace/work/rc-npm-cache npm run typecheck` | Exit 0 for root and web. |
| Platform merge and #86 trial | `PLATFORM_MIGRATION_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:32768/postgres PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave4/chromium npm test -- tests/platform-wave-migrations.test.ts` | Exit 0 on disposable PostgreSQL 18.7. Each run passed one test covering all application and auth ledger entries, 037–040 in order, an unchanged second start and legacy ID adoption. |
| Platform merge | `PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave4/chromium npm test -- tests/mind-compute.test.ts tests/live-data-hijri.test.ts tests/assistant-request-constraints-chat.test.ts` | Exit 0, 146 tests passed. |
| Structured-memory data rights repair | `PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave4/chromium npm test -- tests/member-data-registry.test.ts tests/member-data-export.test.ts tests/member-deletion.test.ts` | Exit 0, 10 tests passed. |
| Reminder and memory repair | `PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave4/chromium npm test -- tests/assistant-structured-memory-chat.test.ts tests/assistant-structured-memory-parser.test.ts tests/reminders-chat.test.ts tests/reminder-time.test.ts` | Exit 0, 164 tests passed. |
| #85 trial | `PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave4/chromium npm test -- tests/assistant-arithmetic-search-candidates.test.ts tests/assistant-arithmetic-search-quantities.test.ts tests/assistant-arithmetic-search-training.test.ts tests/assistant-refusal-arithmetic.test.ts tests/assistant-scratch-decisions.test.ts tests/assistant-word-problem-chat.test.ts tests/assistant-word-problem.test.ts` | Exit 0, 88 tests passed. |
| #87 trial | `TEST_DRIVEN_CODING_ENABLED=true /workspace/work/wave4/isolated-node node_modules/vitest/vitest.mjs run --maxWorkers=2 --fileParallelism --reporter=dot --disableConsoleIntercept tests/assistant-python-verifier-launcher.test.ts tests/assistant-test-driven-coding-retry.test.ts tests/assistant-test-driven-coding.test.ts` | Exit 0, 20 tests passed with an unprivileged service process and root-owned Python. |
| #87 trial | `docker run --rm --network none --user 1000:1000 -v /workspace/work/rc-pr87:/source:ro -w /source mohassan-rc-verifier:2026-11-25 /usr/local/bin/python3.12 -B -m unittest discover -s tests -p 'test_python_verifier_*.py' -v` | Exit 0, 12 tests passed. |
| #86 trial | `PYTHONDONTWRITEBYTECODE=1 python -m unittest discover -s scripts/gates -t .` | Exit 0, 53 tests passed. |
| #86 trial, from `packages/corpus-pipeline` | `PYTHONDONTWRITEBYTECODE=1 uv run --no-project --cache-dir /workspace/work/rc-uv-cache --with pytest==7.4.3 -- python -m pytest tests -q -p no:cacheprovider` | Exit 0, 47 tests passed. |
| #86 trial | `npm run models:list` | Exit 0. Reported local registry availability without running owner checkpoints. |

## Production settings

Set server values in the root-owned `/etc/mohassan/server.env` with mode 0600. Keep the existing production PostgreSQL 18 connection, authentication and internal API secrets, and integration encryption keys. Keep external AI credentials and experimental execution settings unset. These settings are for operator use after review.

### Runtime flags

| Server flag | Default when unset | Recommended production value |
| --- | --- | --- |
| `MOHASSAN_SMALL_TALK_MANNERS` | Off | `1` |
| `MOHASSAN_CONVERSATION_REVIEW_APPLY` | Off, observes the review | `1`, with the judge enabled |
| `MOHASSAN_CONVERSATION_SHADOW` | Legacy decisions. Non-production can observe in shadow. | `decide` |
| `MOHASSAN_STRUCTURED_MEMORY` | Off | `1` |
| `MOHASSAN_EXTRACTIVE_WRITING` | Off, observes candidate metadata | `1` |
| `MOHASSAN_PLAN_COMPILER` | `off` | `on` |
| `MOHASSAN_REASONING` | Off | `1` |
| `MOHASSAN_CLARIFY_CHOICES` | Off | `1` |
| `MOHASSAN_SCRATCH_CLASSIFIERS` | Shadow predictions without applying guarded decisions | `1` |
| `MOHASSAN_REFUSAL_POLICY` | Shadow policy without enforcement | `1` |
| `MOHASSAN_QUESTION_REWRITER` | Off | `1` |
| `TEST_DRIVEN_CODING_ENABLED` | `false` | `true` after the VM prerequisites and unprivileged smoke check pass. Use `false` through initial cutover if the VM check is pending. |
| `PRODUCTION_METRICS_ENABLED` | `true` in production, `false` elsewhere | `true` after checking state-directory access. Use `false` to suspend collection. |
| `MOHASSAN_MODEL_WORKER` | Off | `0`. Keep resident inference off until the owner supplies and validates the local artifacts. |
| `MOHASSAN_DESKTOP_SHELL` | Unset. Production training monitor is unavailable without the desktop signal and loopback origins. | Unset on the VM. Use the monitor on the owner's PC. |
| `MOHASSAN_JUDGE_SHADOW`, `MOHASSAN_JUDGE_FIX`, `MOHASSAN_JUDGE_WITHHOLD` | On outside Vitest for the judge, and on for its owner-scoped fix and withhold controls | Keep enabled. `0` disables the named control. The judge logs conversation text only for the owner in production. |
| `RUN_WORKER` | `true` in the server. The VM environment example sets `false`. | `false` for first startup and verification, then `true` once the single production writer is ready. |
| `SKILL_ENGINE_ENABLED`, `WINDOWS_REMOTE_ENABLED` | `false` in production | `false` for the cloud template. Preserve any explicitly approved inspected-skill configuration. |

Use the wave 4 development settings to compare the agent behavior. Metrics default to enabled only in production. Web Push requires a complete VAPID configuration. The installed reminder scheduler, exports, account rights and recognized live-data routes have no general enable flag. Member sharing starts enabled on a fresh migration and can be switched off in owner member settings. Set the intended policy before public traffic. Structured-evidence extraction is available as a standalone library. The training monitor, blind gate runner and corpus pipeline serve owner workflows. [Wave 4 flags](INTEGRATION-WAVE-4-2026-11-25.md) · [Platform settings](RELEASE-PLATFORM-WAVE-1-2026-11-25.md) · [Structured evidence](STRUCTURED-EVIDENCE-2026-11-25.md)

| #86 server flag | Default when unset | Recommended production value |
| --- | --- | --- |
| `MOHASSAN_ARITHMETIC_SEARCH` | Off | `1` to retain the #85 solver and its associated refusal and routing fixes. |
| `MOHASSAN_MODEL_RELATIONS` | `shadow` | `off` for the initial VM rollout. Validate shadow locally. The VM release is read-only for the service user and the observer's default log path is relative to the release directory. |
| `MOHASSAN_ROUTER_SHADOW` | Off in production. Outside production it can observe when the B0 export is present. | Leave unset. |

The `own-model-provider.json` file beside the permanent worker configuration selects individually verified model capabilities. Leave it absent for the first rollout. Route and follow-up model proposals are shadow-only. The phrasing capability needs its separately passed gate and matching worker configuration. [Model runbook](MODELS-RUNBOOK.md) · [Provider gate requirements](OWN-MODEL-PROVIDER.md)

### Server environment and Vercel

| Variable or grouped settings | Default | Production setting |
| --- | --- | --- |
| `WEB_PUSH_VAPID_SUBJECT` | Unset | Leave unset until the push stage, then set a `mailto:` contact or public HTTPS contact URL. |
| `WEB_PUSH_VAPID_PUBLIC_KEY` and `WEB_PUSH_VAPID_PRIVATE_KEY` | Unset | Install both with the subject for Web Push. Generate the pair in a private file using `node apps/server/scripts/generate-vapid-keys.mjs .env.web-push.local` and keep the pair stable across releases. Keep the private key on the API host. |
| `PRODUCTION_METRICS_DIR` | `production-metrics` under the first systemd `STATE_DIRECTORY` entry, otherwise `.data/production-metrics` | Use the systemd default `/var/lib/mohassan/production-metrics` or an explicit persistent directory writable by `mohassan`. |
| `MOHASSAN_MODEL_WORKER_CONFIG` | `.data/model-worker.json` relative to the checkout | Leave unset while the worker is off. If enabled later, name the owner-approved worker configuration. |
| `EXECUTOR_PYTHON` | Worker fallback `.venv-execution/bin/python` on Linux or `.venv-execution/Scripts/python.exe` on Windows | Leave unset while resident inference is off. This is separate from the assertion verifier interpreter. |
| `MOHASSAN_JUDGE_LOG_DIR` | `.data/judge` | Keep the existing `/var/lib/mohassan/judge` setting. The writer rotates daily or at 16 MiB and retains 14 compressed archives. |
| `PLATFORM_MIGRATION_TEST_DATABASE_URL`, `MODEL_WORKER_TEST_PYTHON` | Unset | Leave unset on production. These variables select isolated test dependencies. |

`TEST_DRIVEN_CODING_PYTHON` defaults to `/usr/bin/python3` with #87. Leave it unset if that interpreter meets the verifier requirements. For an override, use an absolute path to a root-owned Python 3.11+ executable and ensure the dedicated service user can read and execute it and lacks write access to it and its resolved parent paths. Verify `libseccomp.so.2` and the worker smoke check as the same user before enabling the flag. [Verifier runbook](MODELS-RUNBOOK.md)

Vercel needs no new manually configured variables. Keep `MOHASSAN_SERVER_URL` pointed at the verified HTTPS API origin and `INTERNAL_API_SECRET` matched privately to the server. Vercel provides `VERCEL=1` and `x-vercel-forwarded-for` for trusted auth request metadata. VAPID signing and runtime agent settings belong on the API host. [Vercel request headers](https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for) · [VM environment example](../scripts/cloud-linux/server.env.example)

### systemd and off-host backup

| Unit or host component | Setting |
| --- | --- |
| `mohassan.service` | Existing API and Chromium service, running as `mohassan` from `/opt/mohassan/app` with state in `/var/lib/mohassan`. The new `30-journal-namespace.conf` drop-in sets `LogNamespace=mohassan`. |
| `journald@mohassan.conf.d/30-size-cap.conf` | 128 MiB persistent and 32 MiB runtime journal caps. Use `journalctl --namespace=mohassan -u mohassan.service` for API logs. |
| `mohassan-backup.service` and `mohassan-backup.timer` | Revised root oneshot and existing persistent schedule, daily at 03:15 UTC with up to 15 minutes of jitter. Writes the dump, manifest and status, publishes the newest verified pair for the restricted pull user, and retains seven daily pairs. |
| `mohassan-restore-drill.service` and `mohassan-restore-drill.timer` | New root oneshot and persistent schedule, Sunday at 05:00 UTC. Restores into a scratch database on the PostgreSQL cluster, verifies the manifest and ledgers, and retains 12 drill reports. |
| Restricted SSH pull and Windows task | `prepare.sh` installs the `mohassan-backup-pull` account and the SSH drop-in that forces the backup command. Install the dedicated public key and reload SSH after validation. Import the owner PC's Task Scheduler template for 05:00 UTC daily and verify the first off-host copy. |

The API's reminder scheduler and member purge are part of the API process. They run even when `RUN_WORKER=false`. [Cloud deployment guide](../scripts/cloud-linux/README.md) · [Backup and restore](BACKUP-RESTORE-2026-11-25.md) · [Owner PC pull setup](../scripts/backup-pull/README.md)

## Deployment and rollback

The owner runs these stages after the decisions below. Rehearse against an isolated PostgreSQL database and disposable accounts. Use the existing local PostgreSQL 18 production database identified in the VM guide.

| Stage | Deploy | Rollback |
| --- | --- | --- |
| 1. Preserve the recovery point | Save the previous source, Vercel deployment, private environment, state, unit files and drop-ins. Fence traffic, drain active work, then stop the entire old API, its workers and the backup timers. Let in-progress backup or drill services finish. Take a verified pre-release database backup and copy it off-host. | Before any new writer starts, restore prior service and timer settings and reopen the previous frontend after checking health. Preserve the verified backup. |
| 2. Prepare the VM | Stage the reviewed code in `/opt/mohassan/app`. Run `sudo bash /opt/mohassan/app/scripts/cloud-linux/prepare.sh` before installing `mohassan-backup.service`. This script creates the backup, status and pull directories before it installs and verifies the unit. Complete the private environment and Chromium check. Validate SSH before reloading it if enabling the pull. | Keep services stopped, restore the saved source, environment, units, drop-ins and helpers. Run `systemctl daemon-reload`. Validate and reload the restored SSH configuration if applicable. Retain backup files and receipts. |
| 3. Start one backend and migrate | Start the candidate with `RUN_WORKER=false` after confirming all previous writers and supervisors are stopped. Check the recorded agent IDs `035_chat_conversation_review` and `036_structured_memory`, and confirm platform `037_notifications`, `038_reminders`, `039_conversation_shares`, then `040_member_data_rights`. Verify API health on loopback and HTTPS, owner access, member sharing policy, and any due reminders or deletion requests before opening traffic. Confirm the verifier prerequisite before enabling verified coding. | Fence traffic and stop the entire new API and workers. Boot the previous backend against the migrated database only after checking schema compatibility. For a schema restore, restore the verified pre-release backup into an isolated replacement database and reconcile writes made after the backup before redirecting the API. |
| 4. Deploy matching Vercel code and reopen | Deploy the matching frontend after the backend checks. Test owner sign-in, member access, export downloads and share revocation. Verify a reminder on a disposable account and registered-browser push if configured. Restore the intended queue worker setting and release traffic after the checks pass. | Restore the previous Vercel deployment and matching API origin and secret if changed. Drain and stop the new backend before switching to an old backend. Restore the old worker configuration after verifying schema compatibility. |
| 5. Enable backup and drill schedules | Enable `mohassan-backup.timer` and `mohassan-restore-drill.timer`. Run the oneshots once, check the owner backup status screen and verify the first PC copy before leaving it scheduled. | Disable the new timers and PC task. Let running jobs finish. Restore prior unit versions and timer enablement if reverting the release. Revoke the dedicated pull key if retiring access while keeping verified backups. |

The release has no down migrations. Restoring a pre-release snapshot requires reconciling newer database and filesystem writes. Rollback cannot recall delivered pushes, exported ZIP or PDF files, snapshots copied by recipients, or completed account purges. Cancelling an account deletion during the seven-day recovery window resumes eligible reminders. Revoked sessions, share links and device subscriptions need to be recreated. Preserve any needed historical dumps and logs before retention removes them. [Migration ledger](MIGRATION-LEDGER-2026-11-25.md) · [Recovery runbook](BACKUP-RESTORE-2026-11-25.md) · [Member data rights](MEMBER-DATA-RIGHTS-2026-11-25.md)

## Decisions for the owner

1. **Open-Meteo terms (#68).** Confirm the forecast and geocoding usage terms before production cutover and arrange a compliant service if required. The free hosted endpoints have noncommercial use and volume limits. Prayer-time location lookup also uses geocoding. [Terms](https://open-meteo.com/en/terms) · [Licence](https://open-meteo.com/en/licence) · [Live-data design](LIVE-DATA-2026-11-25.md)
2. **Mind C change (#68).** Approve the four additions and four removals in `apps/server/src/assistant/mind/compute.ts` inherited from #68. The patch imports and calls the two Hijri helpers and retires the previous unavailable response. Role D owns this file. [PR #68](https://github.com/ahmadalwakai/Mohassan-AI/pull/68) · [Mind C ownership](BRAIN-AGENT-INSTRUCTIONS.md#الدور-د--المسارات-المحلية)
3. **GitGuardian findings (#69).** Review both `Generic Password` alerts for `tests/member-data-export.test.ts`, in source commit `ec70880` and platform merge `0962bcb`. Confirm how to disposition them before release. [Platform report](https://github.com/ahmadalwakai/Mohassan-AI/pull/76) · [PR #69](https://github.com/ahmadalwakai/Mohassan-AI/pull/69)
4. **Verified coding on the production VM.** Check Python 3.11+ and `libseccomp.so.2` on the host and run the verifier smoke check as the unprivileged service account. Enable verified coding after it passes. [Verifier hardening #87](https://github.com/ahmadalwakai/Mohassan-AI/pull/87)
5. **Live web gain (#74).** The measured gains use the recorded benchmark fixtures. Improvement on live public retrieval remains unmeasured. Decide whether to require a separate live acceptance check before relying on that gain. [PR #74](https://github.com/ahmadalwakai/Mohassan-AI/pull/74)

## Open PR inventory

Open PR snapshot for #1–#87, evaluated against `b6b9183a94355577bf45f8b0c2aa292c37f6f172`. The ancestor check uses each full fetched head SHA. A later revert leaves history in the branch, and the disposition records that when applicable. [Open PRs](https://github.com/ahmadalwakai/Mohassan-AI/pulls)

| PR | Open head | Commits contained | Disposition |
| --- | --- | --- | --- |
| [#1 Fix assistant live request handling and judge shutdown](https://github.com/ahmadalwakai/Mohassan-AI/pull/1) | [`7c81d5b4ea6c`](https://github.com/ahmadalwakai/Mohassan-AI/commit/7c81d5b4ea6c40967ecf1718bf713ee7a8577bb5) | No | Outside both integration lines and the retained follow-up stack. |
| [#2 Recover English ad skill routing and filter generic matches](https://github.com/ahmadalwakai/Mohassan-AI/pull/2) | [`8889496feb36`](https://github.com/ahmadalwakai/Mohassan-AI/commit/8889496feb36b2a7975c58835a4ffad68a6edbfa) | No | Outside both integration lines and the retained follow-up stack. |
| [#3 Connect Android to the Mohassan cloud](https://github.com/ahmadalwakai/Mohassan-AI/pull/3) | [`16558bba05bb`](https://github.com/ahmadalwakai/Mohassan-AI/commit/16558bba05bb2562b4a5b33d835db8c1666da06a) | No | Outside both integration lines and the retained follow-up stack. |
| [#4 Add GitHub Actions CI](https://github.com/ahmadalwakai/Mohassan-AI/pull/4) | [`a3cef12d8e5e`](https://github.com/ahmadalwakai/Mohassan-AI/commit/a3cef12d8e5e684e4fe49861461057537cdef767) | No | Outside both integration lines and the retained follow-up stack. |
| [#5 Validate recorded phone API contracts](https://github.com/ahmadalwakai/Mohassan-AI/pull/5) | [`ebae053c2c81`](https://github.com/ahmadalwakai/Mohassan-AI/commit/ebae053c2c8119de6b0b77857846df87f5935463) | No | Outside both integration lines and the retained follow-up stack. |
| [#6 Stabilize the test suite and fix public follow-ups](https://github.com/ahmadalwakai/Mohassan-AI/pull/6) | [`0cab2a978e32`](https://github.com/ahmadalwakai/Mohassan-AI/commit/0cab2a978e32fe8060b0193ebab83d8c56dd5697) | No | Outside both integration lines and the retained follow-up stack. |
| [#7 Test server migration safety and idempotence](https://github.com/ahmadalwakai/Mohassan-AI/pull/7) | [`c39375ee6ca1`](https://github.com/ahmadalwakai/Mohassan-AI/commit/c39375ee6ca16de353a4884b32e715867052de23) | No | Outside both integration lines and the retained follow-up stack. |
| [#8 Compare CPU-trained B2 request routers](https://github.com/ahmadalwakai/Mohassan-AI/pull/8) | [`80af7fc56be0`](https://github.com/ahmadalwakai/Mohassan-AI/commit/80af7fc56be08c816a0ddc62027022eebcf14bfe) | Yes | Included through the model relations manager stack (#86). |
| [#9 Security review of the public server](https://github.com/ahmadalwakai/Mohassan-AI/pull/9) | [`1bb51dd998c7`](https://github.com/ahmadalwakai/Mohassan-AI/commit/1bb51dd998c790db4894d17780585f054dd27384) | No | Outside both integration lines and the retained follow-up stack. |
| [#10 [ALT] Connect Android to the Mohassan cloud API](https://github.com/ahmadalwakai/Mohassan-AI/pull/10) | [`46852de0a6f9`](https://github.com/ahmadalwakai/Mohassan-AI/commit/46852de0a6f9f12ef131be62ce49a9b1a5182fef) | No | Alternative to #3. Outside both integration lines. |
| [#11 [ALT] Recover English ad campaign and copywriting skill routing](https://github.com/ahmadalwakai/Mohassan-AI/pull/11) | [`7ed9be832c92`](https://github.com/ahmadalwakai/Mohassan-AI/commit/7ed9be832c927228a6d8a97597339952f04ca714) | No | Alternative to #2. Outside both integration lines. |
| [#12 [ALT] Fix live chat reply handling and judge shutdown](https://github.com/ahmadalwakai/Mohassan-AI/pull/12) | [`7321c8680427`](https://github.com/ahmadalwakai/Mohassan-AI/commit/7321c868042712cd4f6ab8038e8857387832935c) | No | Alternative to #1. Outside both integration lines. |
| [#13 Fix five model-free chat reasoning gaps](https://github.com/ahmadalwakai/Mohassan-AI/pull/13) | [`38c5f83b538e`](https://github.com/ahmadalwakai/Mohassan-AI/commit/38c5f83b538e3e54e91a66b7f42942ba5cc0e190) | No | Outside both integration lines and the retained follow-up stack. |
| [#14 Audit npm workspace dependencies](https://github.com/ahmadalwakai/Mohassan-AI/pull/14) | [`c6aa84065e32`](https://github.com/ahmadalwakai/Mohassan-AI/commit/c6aa84065e322ce6337efcb700108047e582cfd7) | No | Outside both integration lines and the retained follow-up stack. |
| [#15 Add a reviewed corpus pipeline for Mohassan chat](https://github.com/ahmadalwakai/Mohassan-AI/pull/15) | [`b43ee56c3d2a`](https://github.com/ahmadalwakai/Mohassan-AI/commit/b43ee56c3d2a914cc016da9c9a310ea3e500a941) | Yes | Platform integration line. |
| [#16 Add reusable blind evaluation gate runner](https://github.com/ahmadalwakai/Mohassan-AI/pull/16) | [`2dd30cb94f36`](https://github.com/ahmadalwakai/Mohassan-AI/commit/2dd30cb94f36da99e73cd6afddee25f0235e1c09) | Yes | Platform integration line. |
| [#17 Add an owner-only local training monitor](https://github.com/ahmadalwakai/Mohassan-AI/pull/17) | [`cc577ba70d2a`](https://github.com/ahmadalwakai/Mohassan-AI/commit/cc577ba70d2a85500f7d712c432f4965660973fa) | Yes | Platform integration line. |
| [#18 feat(assistant): extract structured evidence from read pages](https://github.com/ahmadalwakai/Mohassan-AI/pull/18) | [`0915bdc450fb`](https://github.com/ahmadalwakai/Mohassan-AI/commit/0915bdc450fbdbad52ac2ed74ebf6c73417c872b) | Yes | Platform integration line. |
| [#19 Add a permanent local model worker](https://github.com/ahmadalwakai/Mohassan-AI/pull/19) | [`9eab15c0ba9c`](https://github.com/ahmadalwakai/Mohassan-AI/commit/9eab15c0ba9c4880b657e10a0fb7478dfb424dab) | Yes | Platform integration line. |
| [#20 Notify users about background chat tasks](https://github.com/ahmadalwakai/Mohassan-AI/pull/20) | [`ae8b33121f31`](https://github.com/ahmadalwakai/Mohassan-AI/commit/ae8b33121f312fce5a75e32fb7a21ac64946d7b6) | Yes | Platform integration line. |
| [#21 Restore verified coding repairs without an AI provider](https://github.com/ahmadalwakai/Mohassan-AI/pull/21) | [`65e701499ddf`](https://github.com/ahmadalwakai/Mohassan-AI/commit/65e701499ddf75acea1da12e6284fbeaf196773a) | Yes | Platform integration line. |
| [#22 Benchmark Mohassan chat capabilities and rank measured gaps](https://github.com/ahmadalwakai/Mohassan-AI/pull/22) | [`a258b3d47e39`](https://github.com/ahmadalwakai/Mohassan-AI/commit/a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f) | No | Pinned v1 benchmark source. Used from detached verification checkouts. |
| [#23 Add shared Arabic request understanding in shadow mode](https://github.com/ahmadalwakai/Mohassan-AI/pull/23) | [`72575f37799c`](https://github.com/ahmadalwakai/Mohassan-AI/commit/72575f37799c1de1299a48eafd61c6e57d10ca8f) | Yes | Wave 2 trial history. Its behavior was reverted in `f0574ac` after v1 losses. |
| [#24 Add a deterministic bilingual plan compiler](https://github.com/ahmadalwakai/Mohassan-AI/pull/24) | [`ccec5a67f543`](https://github.com/ahmadalwakai/Mohassan-AI/commit/ccec5a67f543454fb214d0691e9fe1226da41b03) | Yes | Agent stack. Wave 2 restored and repaired the #52/#24 plan stack. |
| [#25 Rank answers from read pages by type and entity](https://github.com/ahmadalwakai/Mohassan-AI/pull/25) | [`e3cc45d16398`](https://github.com/ahmadalwakai/Mohassan-AI/commit/e3cc45d16398006f6c20d24f3bac825ac35b909f) | No | Parent of the held #54 factual-answer stack. Outside both integration lines. |
| [#26 Extend model-free reasoning in Arabic and English](https://github.com/ahmadalwakai/Mohassan-AI/pull/26) | [`5ccc61789b9a`](https://github.com/ahmadalwakai/Mohassan-AI/commit/5ccc61789b9a3ba93891897037e0e6b38fa6cd2f) | Yes | Agent integration line. |
| [#27 Check factual replies against their question and evidence](https://github.com/ahmadalwakai/Mohassan-AI/pull/27) | [`7eb3713c42a1`](https://github.com/ahmadalwakai/Mohassan-AI/commit/7eb3713c42a1a7ab7dc0a666cf3b8cd97b271e2b) | No | Outside both integration lines and the retained follow-up stack. |
| [#28 Add conversation review before assistant replies](https://github.com/ahmadalwakai/Mohassan-AI/pull/28) | [`eb5166e0431d`](https://github.com/ahmadalwakai/Mohassan-AI/commit/eb5166e0431d0706be8a61dbdcf085ed4df3b3c4) | Yes | Agent integration line. |
| [#29 Gate Mohassan's own model in the reply loop](https://github.com/ahmadalwakai/Mohassan-AI/pull/29) | [`5315f2525158`](https://github.com/ahmadalwakai/Mohassan-AI/commit/5315f2525158e3e958dcc8c69b028a061425d6a3) | Yes | Included through the model relations manager stack (#86). |
| [#30 Apply reviewed feedback to answer evidence](https://github.com/ahmadalwakai/Mohassan-AI/pull/30) | [`7a99ba76f58f`](https://github.com/ahmadalwakai/Mohassan-AI/commit/7a99ba76f58f4493d90221442f2d1ed190cb1ced) | No | Outside both integration lines and the retained follow-up stack. |
| [#31 Add structured Arabic and English fact memory](https://github.com/ahmadalwakai/Mohassan-AI/pull/31) | [`c365b368446e`](https://github.com/ahmadalwakai/Mohassan-AI/commit/c365b368446e178a15d39de55ec736e5f1343bff) | Yes | Agent integration line. |
| [#32 Ask focused clarification questions with choices](https://github.com/ahmadalwakai/Mohassan-AI/pull/32) | [`e4e55b3cf4fb`](https://github.com/ahmadalwakai/Mohassan-AI/commit/e4e55b3cf4fbf34ae9698d0ee233762e54312a4c) | Yes | Agent integration line. |
| [#33 Add model-free extractive writing](https://github.com/ahmadalwakai/Mohassan-AI/pull/33) | [`21bd4de30b04`](https://github.com/ahmadalwakai/Mohassan-AI/commit/21bd4de30b04517b5ac3dece6daa4b065ac03a33) | Yes | Agent integration line. |
| [#34 Plan browser tasks and resume after owner handovers](https://github.com/ahmadalwakai/Mohassan-AI/pull/34) | [`09e96baf3a9c`](https://github.com/ahmadalwakai/Mohassan-AI/commit/09e96baf3a9cd7184a61dfbb293898f551b37903) | No | Outside both integration lines and the retained follow-up stack. |
| [#35 Use conversation state v2 to classify and resolve turns](https://github.com/ahmadalwakai/Mohassan-AI/pull/35) | [`2d171b0dce3a`](https://github.com/ahmadalwakai/Mohassan-AI/commit/2d171b0dce3ab9eac4721aee0a6b6d0f436d2a64) | Yes | Agent integration line. |
| [#36 feat: add floating live browser view and takeover](https://github.com/ahmadalwakai/Mohassan-AI/pull/36) | [`6cf96af677dc`](https://github.com/ahmadalwakai/Mohassan-AI/commit/6cf96af677dcc8fc8eb95a5ff1a08d618a5c992d) | No | Outside both integration lines and the retained follow-up stack. |
| [#37 Add phase 1 deliberation to Mohassan](https://github.com/ahmadalwakai/Mohassan-AI/pull/37) | [`15583669c7e7`](https://github.com/ahmadalwakai/Mohassan-AI/commit/15583669c7e7882cfde7a55d0057d141e0d6a520) | Yes | Wave 2 trial history. The #55/#37 deliberation stack was reverted in `7906505` after v1 losses. |
| [#38 feat(knowledge): build an offline factual knowledge base](https://github.com/ahmadalwakai/Mohassan-AI/pull/38) | [`9bdec96ef5f1`](https://github.com/ahmadalwakai/Mohassan-AI/commit/9bdec96ef5f194646e19c9e1cb33642365dac9f2) | No | Outside both integration lines and the retained follow-up stack. |
| [#39 Add model-free refusal policy to command chat](https://github.com/ahmadalwakai/Mohassan-AI/pull/39) | [`d49ae714ebc2`](https://github.com/ahmadalwakai/Mohassan-AI/commit/d49ae714ebc29ecd4a402e83da5988164c7cc0be) | Yes | Agent integration line. |
| [#40 Handle everyday small talk in Mohassan](https://github.com/ahmadalwakai/Mohassan-AI/pull/40) | [`f50520112a23`](https://github.com/ahmadalwakai/Mohassan-AI/commit/f50520112a23632ec4f6e4a121018077d1c422be) | Yes | Agent integration line. |
| [#41 Measure feature branches on the frozen capability benchmark](https://github.com/ahmadalwakai/Mohassan-AI/pull/41) | [`0dfff7c54d36`](https://github.com/ahmadalwakai/Mohassan-AI/commit/0dfff7c54d3658a02cf878ff11faac7f630a6c10) | No | Pinned observer adapters used in detached verification checkouts. |
| [#42 feat(realizer): render verified answers in Arabic and English](https://github.com/ahmadalwakai/Mohassan-AI/pull/42) | [`14ea9894949f`](https://github.com/ahmadalwakai/Mohassan-AI/commit/14ea9894949f3e92382ed6cda6a4892595bddcdf) | No | Outside both integration lines and the retained follow-up stack. |
| [#43 Add the owner's activation console](https://github.com/ahmadalwakai/Mohassan-AI/pull/43) | [`470d5593e4c8`](https://github.com/ahmadalwakai/Mohassan-AI/commit/470d5593e4c8d41bb7b41f1980cd87ab61d9546c) | No | Outside both integration lines and the retained follow-up stack. |
| [#44 Train and export local heads on the Mohassan v5 trunk](https://github.com/ahmadalwakai/Mohassan-AI/pull/44) | [`763db24ae4e1`](https://github.com/ahmadalwakai/Mohassan-AI/commit/763db24ae4e1ec24c4bedbc0f00eaabac35dac1c) | Yes | Included through the model relations manager stack (#86). |
| [#45 Add offline programming answers and shadow evaluation](https://github.com/ahmadalwakai/Mohassan-AI/pull/45) | [`460a93f67a19`](https://github.com/ahmadalwakai/Mohassan-AI/commit/460a93f67a19e81935c330b08b4d6ee7cb09d8d9) | No | Outside both integration lines and the retained follow-up stack. |
| [#46 Add sourced Arabic and English offline knowledge QA](https://github.com/ahmadalwakai/Mohassan-AI/pull/46) | [`c65b7c738f02`](https://github.com/ahmadalwakai/Mohassan-AI/commit/c65b7c738f028479c80e9c29075afb127b40101a) | No | Outside both integration lines and the retained follow-up stack. |
| [#47 Train and shadow scratch request classifiers](https://github.com/ahmadalwakai/Mohassan-AI/pull/47) | [`5127e5672152`](https://github.com/ahmadalwakai/Mohassan-AI/commit/5127e5672152128ea83d70d2c5ef0a7eb66febfa) | Yes | Agent integration line. |
| [#48 Premium browser live view and automatic hand-over](https://github.com/ahmadalwakai/Mohassan-AI/pull/48) | [`2ca532328cd5`](https://github.com/ahmadalwakai/Mohassan-AI/commit/2ca532328cd50c36ab32906b21786e43ac4fb3f3) | No | Outside both integration lines and the retained follow-up stack. |
| [#49 Add model-free multisource explanations and comparisons](https://github.com/ahmadalwakai/Mohassan-AI/pull/49) | [`70c0ba4588dc`](https://github.com/ahmadalwakai/Mohassan-AI/commit/70c0ba4588dc472bdbbdc89aaab0681b90fd333e) | Yes | Agent integration line. |
| [#50 Ground comparison answers in supplied and observed values](https://github.com/ahmadalwakai/Mohassan-AI/pull/50) | [`27d09463d6d3`](https://github.com/ahmadalwakai/Mohassan-AI/commit/27d09463d6d386c63707f5c68fc68fc319690a7c) | Yes | Agent integration line. |
| [#51 Resolve follow-up questions against observed sources](https://github.com/ahmadalwakai/Mohassan-AI/pull/51) | [`4f17a0cab6c9`](https://github.com/ahmadalwakai/Mohassan-AI/commit/4f17a0cab6c9aec71780b2794aa6f3d87b3f4e85) | Yes | Agent integration line. |
| [#52 Fix plan compiler multi-step execution](https://github.com/ahmadalwakai/Mohassan-AI/pull/52) | [`e150f149223e`](https://github.com/ahmadalwakai/Mohassan-AI/commit/e150f149223e3ad6570f2d3a72a06fbe22fa5c2e) | Yes | Agent stack. Wave 2 restored and repaired this plan stack. |
| [#53 Make structured memory work end to end in chat](https://github.com/ahmadalwakai/Mohassan-AI/pull/53) | [`06f2a00cc96d`](https://github.com/ahmadalwakai/Mohassan-AI/commit/06f2a00cc96d1e2edf99c5496ccac3a9860d3704) | Yes | Agent integration line. |
| [#54 fix(assistant): restore factual answers end to end](https://github.com/ahmadalwakai/Mohassan-AI/pull/54) | [`e245184feaf1`](https://github.com/ahmadalwakai/Mohassan-AI/commit/e245184feaf17a98aff4fff64814db1efac60888) | No | Held. Its v2 trial lost 137 factual passes. |
| [#55 Preserve native dispatch during deliberation](https://github.com/ahmadalwakai/Mohassan-AI/pull/55) | [`4a0a54fbe742`](https://github.com/ahmadalwakai/Mohassan-AI/commit/4a0a54fbe7429ddcc88a542d71391b67f3cd40b5) | Yes | Wave 2 trial history. Its behavior was reverted in `7906505` after v1 losses. |
| [#56 test(agent): add a sealed human capability benchmark v2](https://github.com/ahmadalwakai/Mohassan-AI/pull/56) | [`a130b239d9e6`](https://github.com/ahmadalwakai/Mohassan-AI/commit/a130b239d9e6d2b1f6728128019d24bb26e9293f) | No | Pinned v2 sealed release source. Verification fixture. |
| [#57 Generalize refusal decisions before tool dispatch](https://github.com/ahmadalwakai/Mohassan-AI/pull/57) | [`d6aa9125b625`](https://github.com/ahmadalwakai/Mohassan-AI/commit/d6aa9125b6251e6bce3b0ed34b9b583ce5451ae1) | Yes | Agent integration line. |
| [#58 Complete document and file requests end to end](https://github.com/ahmadalwakai/Mohassan-AI/pull/58) | [`bdabd28b2f8f`](https://github.com/ahmadalwakai/Mohassan-AI/commit/bdabd28b2f8f09010f6e26b4ca80296032447000) | Yes | Agent integration line. |
| [#59 Fix clarification decisions and same-run resume](https://github.com/ahmadalwakai/Mohassan-AI/pull/59) | [`3d1dff31267e`](https://github.com/ahmadalwakai/Mohassan-AI/commit/3d1dff31267e489d68aeab5aaeab0cb6e4029f1f) | Yes | Agent integration line. |
| [#60 Improve end-to-end calculations in Arabic and English](https://github.com/ahmadalwakai/Mohassan-AI/pull/60) | [`88865ba46c55`](https://github.com/ahmadalwakai/Mohassan-AI/commit/88865ba46c55ce2e1d3accb63c75a3256e89b69f) | Yes | Agent integration line. |
| [#61 Integration wave 1: measured capability upgrades](https://github.com/ahmadalwakai/Mohassan-AI/pull/61) | [`93066fbb0984`](https://github.com/ahmadalwakai/Mohassan-AI/commit/93066fbb0984643110404372d5e32d3da3f324d2) | Yes | Agent integration line. |
| [#62 Add a disjoint human-sourced development split for capability v2](https://github.com/ahmadalwakai/Mohassan-AI/pull/62) | [`12cedfe592aa`](https://github.com/ahmadalwakai/Mohassan-AI/commit/12cedfe592aab40cdd47ee00d05ea86a6d2bae89) | No | Pinned v2 development release source. Verification fixture. |
| [#63 Measure capability benchmark v2 by candidate branch](https://github.com/ahmadalwakai/Mohassan-AI/pull/63) | [`9fefcb1a7fa6`](https://github.com/ahmadalwakai/Mohassan-AI/commit/9fefcb1a7fa6f46d5b13cf61bf20a5c90341d7db) | No | Independent branch measurement tooling. Outside both integration lines. |
| [#64 Make production backups recoverable and verify weekly restores](https://github.com/ahmadalwakai/Mohassan-AI/pull/64) | [`3a4ff3c35584`](https://github.com/ahmadalwakai/Mohassan-AI/commit/3a4ff3c35584a86df6bab75dce1aad228f2a16a3) | Yes | Platform integration line. |
| [#65 Add in-app reminders for owners and members](https://github.com/ahmadalwakai/Mohassan-AI/pull/65) | [`bccfe23ed5cf`](https://github.com/ahmadalwakai/Mohassan-AI/commit/bccfe23ed5cf74157bcdd354d4f308da694d55a6) | Yes | Platform integration line. |
| [#66 Export conversations and share privacy-checked snapshots](https://github.com/ahmadalwakai/Mohassan-AI/pull/66) | [`4e6d5bacb60a`](https://github.com/ahmadalwakai/Mohassan-AI/commit/4e6d5bacb60a9437aaceecee45e3f62c6db95662) | Yes | Platform integration line. |
| [#67 Add owner-only production metrics](https://github.com/ahmadalwakai/Mohassan-AI/pull/67) | [`74e85830758e`](https://github.com/ahmadalwakai/Mohassan-AI/commit/74e85830758e2e6e20fa23a9daafd9afeec30419) | Yes | Platform integration line. |
| [#68 Answer live calendar and data questions directly in chat](https://github.com/ahmadalwakai/Mohassan-AI/pull/68) | [`81f3304e5840`](https://github.com/ahmadalwakai/Mohassan-AI/commit/81f3304e5840bfda42cac2e2b1635cbc52912687) | Yes | Platform integration line. |
| [#69 Add account data rights and member audit log](https://github.com/ahmadalwakai/Mohassan-AI/pull/69) | [`eb0b47e566b5`](https://github.com/ahmadalwakai/Mohassan-AI/commit/eb0b47e566b5911c33b6b48ccd41f4917812956e) | Yes | Platform integration line. |
| [#70 Audit capability v2 training contamination](https://github.com/ahmadalwakai/Mohassan-AI/pull/70) | [`a1e1cb020b7b`](https://github.com/ahmadalwakai/Mohassan-AI/commit/a1e1cb020b7ba093885edbf501149e7b8252c0cb) | No | Verification audit source. Wave 2 includes the exclusion library and hash registries. |
| [#71 Rewrite follow-up questions from conversation history](https://github.com/ahmadalwakai/Mohassan-AI/pull/71) | [`8305ab4abca1`](https://github.com/ahmadalwakai/Mohassan-AI/commit/8305ab4abca14ec35a7091070d90784ccf4db77b) | No | Wave 3 retained the measured rules-only head `b470d2a8e5e16febe79ac071f478362f8efd29b2`. The listed head adds the learned fallback. |
| [#72 Handle everyday English conversation and focused clarification](https://github.com/ahmadalwakai/Mohassan-AI/pull/72) | [`bd5008ae2408`](https://github.com/ahmadalwakai/Mohassan-AI/commit/bd5008ae24087edebf653b06e56ff6b599c6ca09) | Yes | Agent integration line. |
| [#73 Solve arithmetic word problems with the local calculator](https://github.com/ahmadalwakai/Mohassan-AI/pull/73) | [`ca50fd6a7650`](https://github.com/ahmadalwakai/Mohassan-AI/commit/ca50fd6a765058b1d3587d76f92d7c5472a8ebed) | Yes | Agent integration line. |
| [#74 Improve factual public lookup and evidence reading](https://github.com/ahmadalwakai/Mohassan-AI/pull/74) | [`55450bbd9e1c`](https://github.com/ahmadalwakai/Mohassan-AI/commit/55450bbd9e1c6a8c2acffabddd6b00254c66c359) | Yes | Agent stack. Wave 3 restored the public lookup changes after an Arabic routing repair. Live gain remains unmeasured. |
| [#75 Add git-based PR merge map and first snapshot](https://github.com/ahmadalwakai/Mohassan-AI/pull/75) | [`6a8b464b5b5f`](https://github.com/ahmadalwakai/Mohassan-AI/commit/6a8b464b5b5fc2ee44d98df0c02936bdcaf4da24) | No | PR inventory tooling. Outside both integration lines. |
| [#76 Integrate platform wave 1](https://github.com/ahmadalwakai/Mohassan-AI/pull/76) | [`ef54ec49b2c5`](https://github.com/ahmadalwakai/Mohassan-AI/commit/ef54ec49b2c54e17321f0037064fb7b1dcce3dff) | Yes | Platform integration head. |
| [#77 Synthesize and verify small Python functions without a model](https://github.com/ahmadalwakai/Mohassan-AI/pull/77) | [`2698ce10d60a`](https://github.com/ahmadalwakai/Mohassan-AI/commit/2698ce10d60ad5696cf1b8a6f48b1fd4d0d4eabe) | Yes | Agent integration line. |
| [#78 Integrate the remaining measured assistant upgrades](https://github.com/ahmadalwakai/Mohassan-AI/pull/78) | [`3c429a0e68f2`](https://github.com/ahmadalwakai/Mohassan-AI/commit/3c429a0e68f2c23b4dbb301225ba8be0ecd0ade7) | Yes | Agent integration line. |
| [#79 Improve refusal recall for unsupported external actions](https://github.com/ahmadalwakai/Mohassan-AI/pull/79) | [`892308680c8c`](https://github.com/ahmadalwakai/Mohassan-AI/commit/892308680c8c2780c750137cb33460cfe4c0fcea) | Yes | Agent integration line. |
| [#80 Integration wave 3 · verifier and routing follow-up](https://github.com/ahmadalwakai/Mohassan-AI/pull/80) | [`cae773746c65`](https://github.com/ahmadalwakai/Mohassan-AI/commit/cae773746c6598c854e207b5a866bb035f82660c) | Yes | Agent integration line. |
| [#81 Expand verified Python synthesis within existing budgets](https://github.com/ahmadalwakai/Mohassan-AI/pull/81) | [`c20f41ff4b2c`](https://github.com/ahmadalwakai/Mohassan-AI/commit/c20f41ff4b2c65bcace11481e3a4f732465f5770) | Yes | Agent integration line. |
| [#82 Improve small-talk and unsupported-action routing](https://github.com/ahmadalwakai/Mohassan-AI/pull/82) | [`499a5c92b6b3`](https://github.com/ahmadalwakai/Mohassan-AI/commit/499a5c92b6b36ad421e4db082764e9ed0288ec47) | Yes | Agent integration line. |
| [#83 Improve factual question routing and grounded answers](https://github.com/ahmadalwakai/Mohassan-AI/pull/83) | [`6a7d12a55684`](https://github.com/ahmadalwakai/Mohassan-AI/commit/6a7d12a55684a6136f1c2dd5366d76e24c04c75d) | Yes | Agent integration line. |
| [#84 Integration wave 4](https://github.com/ahmadalwakai/Mohassan-AI/pull/84) | [`d4654f4f9e9c`](https://github.com/ahmadalwakai/Mohassan-AI/commit/d4654f4f9e9ce7f142c4376c95a5dd4fe0fbc7b2) | Yes | Starting agent integration head. |
| [#85 Add calibrated expression search for arithmetic word problems](https://github.com/ahmadalwakai/Mohassan-AI/pull/85) | [`f161bbb84f24`](https://github.com/ahmadalwakai/Mohassan-AI/commit/f161bbb84f24677efb5758195534ca46d3330b05) | Yes | Arithmetic search follow-up. |
| [#86 Connect Mohassan’s local models in a shadow relations manager](https://github.com/ahmadalwakai/Mohassan-AI/pull/86) | [`14a32baea43d`](https://github.com/ahmadalwakai/Mohassan-AI/commit/14a32baea43d1793839b53d144021c228e9ac30d) | Yes | Model relations manager follow-up. |
| [#87 Harden the verified Python worker](https://github.com/ahmadalwakai/Mohassan-AI/pull/87) | [`94dff4a6f902`](https://github.com/ahmadalwakai/Mohassan-AI/commit/94dff4a6f9025416b37d6c9dc2519a9c7b62bf48) | Yes | Verifier hardening follow-up. |
