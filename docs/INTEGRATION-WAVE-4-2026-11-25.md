# Integration wave 4 · 25 November 2026

The draft targets `integration/wave-3` for review. The starting commit is `cae773746c6598c854e207b5a866bb035f82660c`, the tip fetched from origin. The wave 3 reports were the only changes since its measured product commit, `9684a31e2644d9f13db9f0e2d579cc0ef0264bf7`. [Wave 3 report](./INTEGRATION-WAVE-3-2026-11-25.md)

## Candidate readiness

Each PR description contains its final development tables and one v2 sealed result. The PR description head matched the SHA returned by `git fetch origin pull/<n>/head` for each candidate. The standalone scores below are upstream measurements against wave 3.

| Trial order | Candidate | Fetched head | Standalone v1 development | Standalone v2 development | Standalone v2 sealed |
| ---: | --- | --- | ---: | ---: | ---: |
| 1 | [#82 small talk and refusal](https://github.com/ahmadalwakai/Mohassan-AI/pull/82) | `499a5c92b6b36ad421e4db082764e9ed0288ec47` | 176/240 | 1,515/2,400 | 781/1,200 |
| 2 | [#81 verified Python synthesis](https://github.com/ahmadalwakai/Mohassan-AI/pull/81) | `c20f41ff4b2c65bcace11481e3a4f732465f5770` | 176/240 | 1,481/2,400 | 756/1,200 |
| 3 | [#83 factual evidence](https://github.com/ahmadalwakai/Mohassan-AI/pull/83) | `6a7d12a55684a6136f1c2dd5366d76e24c04c75d` | 176/240 | 1,460/2,400 | 756/1,200 |

### Not ready

All three candidates qualified for an integration trial.

## Measurement

The v1 bundle is pinned to `a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f`. The v2 development split is pinned to `12cedfe592aab40cdd47ee00d05ea86a6d2bae89`, and the sealed release is pinned to `a130b239d9e6d2b1f6728128019d24bb26e9293f`. Both v2 payloads match the pinned `origin/test/v2-contamination-audit` tree at `a1e1cb020b7ba093885edbf501149e7b8252c0cb`. [V1 runner #22](https://github.com/ahmadalwakai/Mohassan-AI/pull/22) · [V2 development #62](https://github.com/ahmadalwakai/Mohassan-AI/pull/62) · [V2 sealed #56](https://github.com/ahmadalwakai/Mohassan-AI/pull/56) · [V2 audit #70](https://github.com/ahmadalwakai/Mohassan-AI/pull/70)

The runners use detached checkouts of each measured product commit, temporary PGlite databases and fixture tool ports. The v2 checkout merges the audit branch locally with `--no-commit` and restores product paths to the measured SHA. The v2 development CLI validates the published bundle and schedules cases by index modulo eight across eight isolated processes. The coordinator validates lane coverage and receipt hashes, restores release order, and recomputes the published score summary. V1 and v2 execute sequentially to avoid competition between the two runners. The v1 development run includes the #41 review and structured-memory adapters. The v1 sealed run and both v2 runs also include the clarification adapter. [Observer adapters #41](https://github.com/ahmadalwakai/Mohassan-AI/pull/41)

The paired gate verifies both development receipts against their product commit, lockfile, pinned inputs, case order and score summaries. Each area and each language must hold independently against the last retained tree. The development receipts share lockfile SHA-256 `5ca3eb97d734f4403734d865f08e52065675e46877f75000e3646b1fddbdbb4e`. The calibration matched all of wave 3's published development groups. The baseline scratch merge materialized the v2 sealed fixture. The development CLI read only the development bundle, and subsequent development checkouts removed the holdout paths before either runner started.

Node `v24.22.3` ran with `--no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx`. Chromium was Playwright build `1248` (`156.0.8078.4`). Python was `3.12.14` and `libseccomp.so.2` was available. The wave 3 process-CPU search budget and single retry within the original worker deadline remained active.

### Flags

The following wave 3 settings were active in every development run and in both sealed runs. #82 and #83 need no additional setting. #81 uses the already-enabled `TEST_DRIVEN_CODING_ENABLED=true`.

```text
MOHASSAN_SMALL_TALK_MANNERS=1
MOHASSAN_CONVERSATION_REVIEW_APPLY=1
MOHASSAN_CONVERSATION_SHADOW=decide
MOHASSAN_STRUCTURED_MEMORY=1
MOHASSAN_EXTRACTIVE_WRITING=1
MOHASSAN_PLAN_COMPILER=on
MOHASSAN_REASONING=1
MOHASSAN_CLARIFY_CHOICES=1
MOHASSAN_SCRATCH_CLASSIFIERS=1
MOHASSAN_REFUSAL_POLICY=1
TEST_DRIVEN_CODING_ENABLED=true
MOHASSAN_QUESTION_REWRITER=1
```

## Development decisions

| Step | Product commit | Decision |
| --- | --- | --- |
| Wave 3 calibration | `cae773746c6598c854e207b5a866bb035f82660c` | Reproduced the retained wave 3 development results |
| #82 | `e9847395015a52a0f91c8c7db8ff98b368e9f6aa` | Retained |
| #81 | `9fb02b0da9070c3ce27171008d3e291e2efc7371` | Retained |
| #83 | `e7274aa6cc9aacbf3d03c1b3be572720cfb9c5a3` | Retained and frozen |

- **#82** added 50 v2 refusal passes and 30 v2 small-talk passes. Arabic gained 17 passes and English gained 63.
- **#81** added 47 v2 English coding passes and lost one, for a net gain of 46. For the lost case, the receipt recorded `assertion-failed` with `search-evaluations`. The coding area and English group both improved.
- **#83** added 25 v2 factual passes, 13 Arabic and 12 English. Every other area held.

Every v1 area and language held in all three trials. All three paired gate commands exited 0.

### V1 development

| Group | Wave 3 | #82 | #81 | #83 |
| --- | ---: | ---: | ---: | ---: |
| Overall | 176/240 | 176/240 | 176/240 | 176/240 |
| Area / calculation | 18/18 | 18/18 | 18/18 | 18/18 |
| Area / clarification | 16/16 | 16/16 | 16/16 | 16/16 |
| Area / coding | 0/16 | 0/16 | 0/16 | 0/16 |
| Area / comparison | 11/18 | 11/18 | 11/18 | 11/18 |
| Area / desktop | 11/16 | 11/16 | 11/16 | 11/16 |
| Area / document-file | 16/18 | 16/18 | 16/18 | 16/18 |
| Area / explanation | 8/18 | 8/18 | 8/18 | 8/18 |
| Area / factual | 10/18 | 10/18 | 10/18 | 10/18 |
| Area / follow-up | 18/18 | 18/18 | 18/18 | 18/18 |
| Area / google-ads | 0/16 | 0/16 | 0/16 | 0/16 |
| Area / memory | 16/16 | 16/16 | 16/16 | 16/16 |
| Area / multi-step | 18/18 | 18/18 | 18/18 | 18/18 |
| Area / refusal | 16/16 | 16/16 | 16/16 | 16/16 |
| Area / small-talk | 18/18 | 18/18 | 18/18 | 18/18 |
| Language / ar | 85/120 | 85/120 | 85/120 | 85/120 |
| Language / en | 91/120 | 91/120 | 91/120 | 91/120 |

| Run | Receipt | Product commit | Started (UTC) | Finished (UTC) | Receipt SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Wave 3 | `baseline/v1-development.json` | `cae773746c6598c854e207b5a866bb035f82660c` | 2026-11-25T08:34:29.622Z | 2026-11-25T08:34:58.768Z | `9db0d9d0210a822a80051b28acdea15fca501cf7062ee8eeaf889027eaad9aa3` |
| #82 | `pr82/v1-development.json` | `e9847395015a52a0f91c8c7db8ff98b368e9f6aa` | 2026-11-25T08:36:57.044Z | 2026-11-25T08:37:27.111Z | `fceb3b45aadd09f37492ec762e8219933b012880f597d94f8d0eaf88d1584ebe` |
| #81 | `pr81/v1-development.json` | `9fb02b0da9070c3ce27171008d3e291e2efc7371` | 2026-11-25T08:39:14.871Z | 2026-11-25T08:39:45.191Z | `0e06268852006d6f22a9915a2cb9633380f8e90472f4d8dc8987d5bf8705c42c` |
| #83 | `pr83/v1-development.json` | `e7274aa6cc9aacbf3d03c1b3be572720cfb9c5a3` | 2026-11-25T08:41:34.301Z | 2026-11-25T08:42:08.437Z | `a07f039af1a5024e0c2f2726fbc468bc7a97d104f1eca909539dd577c341ebff` |

### V2 development

| Group | Wave 3 | #82 | #81 | #83 |
| --- | ---: | ---: | ---: | ---: |
| Overall | 1,435/2,400 | 1,515/2,400 (+80) | 1,561/2,400 (+46) | 1,586/2,400 (+25) |
| Area / calculation | 5/277 | 5/277 | 5/277 | 5/277 |
| Area / clarification | 9/9 | 9/9 | 9/9 | 9/9 |
| Area / coding | 62/155 | 62/155 | 108/155 (+46) | 108/155 |
| Area / comparison | 28/32 | 28/32 | 28/32 | 28/32 |
| Area / factual | 951/1,244 | 951/1,244 | 951/1,244 | 976/1,244 (+25) |
| Area / follow-up | 46/240 | 46/240 | 46/240 | 46/240 |
| Area / refusal | 298/375 | 348/375 (+50) | 348/375 | 348/375 |
| Area / small-talk | 36/68 | 66/68 (+30) | 66/68 | 66/68 |
| Language / ar | 952/1,200 | 969/1,200 (+17) | 969/1,200 | 982/1,200 (+13) |
| Language / en | 483/1,200 | 546/1,200 (+63) | 592/1,200 (+46) | 604/1,200 (+12) |

| Run | Receipt | Product commit | Started (UTC) | Finished (UTC) | Receipt SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Wave 3 | `baseline/v2-development.json` | `cae773746c6598c854e207b5a866bb035f82660c` | 2026-11-25T08:35:08.628Z | 2026-11-25T08:36:34.414Z | `6e7057f2bcadcd91be5d99a542aaea23ec1b4e98b4cd58b37bf697b0460157a7` |
| #82 | `pr82/v2-development.json` | `e9847395015a52a0f91c8c7db8ff98b368e9f6aa` | 2026-11-25T08:37:38.499Z | 2026-11-25T08:38:59.262Z | `47866938acf6a46e3fa74fd785cdd6acd0c28ca2121c42f0f1eb492cf93a877e` |
| #81 | `pr81/v2-development.json` | `9fb02b0da9070c3ce27171008d3e291e2efc7371` | 2026-11-25T08:39:56.469Z | 2026-11-25T08:41:20.834Z | `4ed2da27b40236181292000a4ff1f58baf1f07e041c71a6260d4b9dacc0beb21` |
| #83 | `pr83/v2-development.json` | `e7274aa6cc9aacbf3d03c1b3be572720cfb9c5a3` | 2026-11-25T08:42:19.899Z | 2026-11-25T08:43:38.550Z | `c8e86d95fab9dbcaeb8d1bb435912ff7351da3fb74bcd5a3d1a91ada61546fd8` |

### Development commands

All launcher commands exited 0. Receipt paths in the tables are relative to `/workspace/work/wave4/receipts`.

```bash
/workspace/work/wave4/run development baseline cae773746c6598c854e207b5a866bb035f82660c
python3 -B /workspace/work/wave4/gate.py baseline cae773746c6598c854e207b5a866bb035f82660c
/workspace/work/wave4/run development pr82 e9847395015a52a0f91c8c7db8ff98b368e9f6aa
python3 -B /workspace/work/wave4/gate.py baseline pr82 cae773746c6598c854e207b5a866bb035f82660c e9847395015a52a0f91c8c7db8ff98b368e9f6aa
/workspace/work/wave4/run development pr81 9fb02b0da9070c3ce27171008d3e291e2efc7371 TEST_DRIVEN_CODING_ENABLED=true
python3 -B /workspace/work/wave4/gate.py pr82 pr81 e9847395015a52a0f91c8c7db8ff98b368e9f6aa 9fb02b0da9070c3ce27171008d3e291e2efc7371
/workspace/work/wave4/run development pr83 e7274aa6cc9aacbf3d03c1b3be572720cfb9c5a3
python3 -B /workspace/work/wave4/gate.py pr81 pr83 9fb02b0da9070c3ce27171008d3e291e2efc7371 e7274aa6cc9aacbf3d03c1b3be572720cfb9c5a3
```

The v1 runner invokes `scripts/agent-capability-bench/run.ts --output "$receipt"`. The v2 development workers invoke `scripts/agent-capability-bench/run.ts --v2-dev --output "$worker_receipt"`.

## Merge notes

Each candidate was merged in order with a two-parent merge commit. All three merges resolved automatically. On their respective changed paths, the combined product trees match the fetched heads on all 10, 8, and 21 paths. The wave 3 coding router, verifier worker, isolation and retry hooks carry through the merge. All held-file hunks relative to wave 3 are below.

| File | Line at freeze | Added / removed | Hook |
| --- | ---: | ---: | --- |
| `apps/server/src/command-chat.ts` | 24 | 1 / 1 | Import the `isLiveWebQuestion` predicate from Hands in place of `LIVE`. |
| `apps/server/src/command-chat.ts` | 2976 | 1 / 1 | Apply the predicate to search steps to select fresh page reads. |
| `packages/browser/src/search/ranking.ts` | 2 | 2 / 0 | Import and re-export the new `webFreshnessText` helper. |
| `packages/browser/src/search/ranking.ts` | 85 | 1 / 1 | Apply `webFreshnessText` to the existing query freshness check. |

The new `packages/browser/src/search/freshness.ts` handles the physical senses of “current” for freshness detection and leaves the retrieval query intact. Each existing held file has four changed lines. The history scan found zero changes to the pinned execution packages or benchmark paths. The migration path scan also returned no changes.

## Verification

All commands below exited 0 on the frozen product. Root and web typecheck passed. Vitest passed 961 tests across 52 suites. Its two native Windows sandbox suites skipped 12 tests, and the product checkout skipped one v1 isolation test that requires the pinned development fixture. Both Python runs passed, with 34 synthesis tests and 10 worker tests. The v2 source guard passed all seven tests using only the audit's hashed development and sealed registries.

```bash
npm run typecheck
export PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave4/chromium
npm test -- --maxWorkers=2 --fileParallelism --reporter=dot --disableConsoleIntercept \
  packages/browser/src/search/source-ranking.test.ts \
  packages/scratch-classifiers/src/features.test.ts \
  packages/scratch-classifiers/src/index.test.ts \
  tests/assistant-browser-visibility.test.ts \
  tests/assistant-chat-supervision.test.ts \
  tests/assistant-clarify-choices-chat.test.ts \
  tests/assistant-factual-evidence.test.ts \
  tests/assistant-factual-quantity.test.ts \
  tests/assistant-factual-question-routing.test.ts \
  tests/assistant-hands-attribute-pronoun.test.ts \
  tests/assistant-hands-http-chat.test.ts \
  tests/assistant-hands-open-ask-chat.test.ts \
  tests/assistant-hands-open-ask.test.ts \
  tests/assistant-hands-open-read.test.ts \
  tests/assistant-hands-page-choice.test.ts \
  tests/assistant-hands-subject-name.test.ts \
  tests/assistant-hands.test.ts \
  tests/assistant-judge-chat.test.ts \
  tests/assistant-judge-production.test.ts \
  tests/assistant-judge-shadow.test.ts \
  tests/assistant-judge.test.ts \
  tests/assistant-manners-chat.test.ts \
  tests/assistant-manners-detection.test.ts \
  tests/assistant-manners-development.test.ts \
  tests/assistant-manners-replies.test.ts \
  tests/assistant-plan-compiler.test.ts \
  tests/assistant-plan-web-tools.test.ts \
  tests/assistant-public-projection-chat.test.ts \
  tests/assistant-refusal-actions.test.ts \
  tests/assistant-refusal-benchmark-isolation.test.ts \
  tests/assistant-refusal-chat.test.ts \
  tests/assistant-refusal-development.test.ts \
  tests/assistant-refusal-learned.test.ts \
  tests/assistant-refusal-permissions.test.ts \
  tests/assistant-refusal-replies.test.ts \
  tests/assistant-request-constraints-chat.test.ts \
  tests/assistant-request-constraints.test.ts \
  tests/assistant-request-context.test.ts \
  tests/assistant-request-scope-nominal.test.ts \
  tests/assistant-request-scope.test.ts \
  tests/assistant-routing-decision.test.ts \
  tests/assistant-search-routing.test.ts \
  tests/assistant-test-driven-coding-retry.test.ts \
  tests/assistant-test-driven-coding.test.ts \
  tests/conversation-state-decides-chat.test.ts \
  tests/everyday-clarification.test.ts \
  tests/everyday-social.test.ts \
  tests/extractive-writing-request.test.ts \
  tests/public-conversation-followup.test.ts \
  tests/question-rewrite-chat.test.ts \
  tests/run-plan-completeness-20261124.test.ts \
  tests/sandbox-control-plane.test.ts \
  tests/sandbox-escape.test.ts \
  tests/sandbox-gateway.test.ts
python3 -B -m unittest discover -s tests -p 'test_python_*synthesis.py' -v
python3 -B tests/test_test_driven_coding.py -v
git diff --check origin/integration/wave-3 e7274aa6cc9aacbf3d03c1b3be572720cfb9c5a3
```

The detached v2 scratch guard ran the three commands below with the #70 exclusion module and hash registries. The guard unit suite passed 3/3. The two source scans each passed 2/2.

```bash
bash /workspace/work/wave4/guard/run e7274aa6cc9aacbf3d03c1b3be572720cfb9c5a3
python3 -B -m unittest discover -s tests -p test_check_v2_case_text.py -v
python3 -B -m unittest discover -s tests -p test_v2_source_leakage.py -v
python3 -B -m unittest discover -s tests -p test_v2_case_strings.py -v
```

An earlier focused run on the #82 merge passed all 201 tests in eight suites.

```bash
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave4/chromium npm test -- \
  --maxWorkers=2 --fileParallelism --reporter=dot --disableConsoleIntercept \
  tests/assistant-manners-chat.test.ts tests/assistant-manners-replies.test.ts \
  tests/assistant-manners-detection.test.ts tests/assistant-manners-development.test.ts \
  tests/assistant-refusal-actions.test.ts tests/assistant-refusal-chat.test.ts \
  tests/assistant-refusal-replies.test.ts tests/everyday-social.test.ts
```

The v1 source-isolation check that skipped in the product checkout passed 1/1 in the detached guard checkout. The #22 development fixture matched SHA-256 `712a170d3d60c6aec41f9fe44e7d5cc222bbafbe28d9ca763b5f396db2d2410b`.

```bash
cd /workspace/work/wave4/guard/product
git archive a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f -- tests/fixtures/agent-capability-bench/development.json | tar -xf -
ln -s /workspace/Mohassan-AI/node_modules node_modules
npm test -- --maxWorkers=1 --reporter=dot --disableConsoleIntercept tests/assistant-refusal-benchmark-isolation.test.ts
```

The two native Windows sandbox suites and live public web retrieval remain unverified. The Python and libseccomp checks cover this Linux environment.

## Frozen sealed results

The product was frozen at `e7274aa6cc9aacbf3d03c1b3be572720cfb9c5a3` (tree `f03324fcf084f9be99a5258cf9dc33f42579b242`). Each sealed set ran once with the final settings. The v1 command includes the development partition, and its groups matched the last retained v1 development receipt. V2 used the original #56 release CLI and ran serially in the #70 audit scratch checkout. Its receipt contains only aggregate results. The report is recorded in a subsequent documentation-only commit.

```bash
/workspace/work/wave4/run sealed final e7274aa6cc9aacbf3d03c1b3be572720cfb9c5a3
python3 -B /workspace/work/wave4/check-seals.py e7274aa6cc9aacbf3d03c1b3be572720cfb9c5a3 pr83 e7274aa6cc9aacbf3d03c1b3be572720cfb9c5a3
```

Both commands exited 0. The receipt check validated the pinned payloads, frozen SHA, flags, single start marker per split, group denominators and reported summaries. The v1 invocation was `scripts/agent-capability-bench/run.ts --output "$receipt" --sealed tests/fixtures/agent-capability-bench/holdout/sealed.json`. The v2 invocation was `scripts/agent-capability-bench/run.ts --version 2 --sealed tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output "$receipt"`.

### V1 sealed

| Group | Wave 4 |
| --- | ---: |
| Overall | 27/60 |
| Area / calculation | 3/4 |
| Area / clarification | 1/4 |
| Area / coding | 0/4 |
| Area / comparison | 0/4 |
| Area / desktop | 3/4 |
| Area / document-file | 1/4 |
| Area / explanation | 1/4 |
| Area / factual | 4/6 |
| Area / follow-up | 3/4 |
| Area / google-ads | 0/4 |
| Area / memory | 2/4 |
| Area / multi-step | 5/6 |
| Area / refusal | 2/4 |
| Area / small-talk | 2/4 |
| Language / ar | 14/30 |
| Language / en | 13/30 |

| Run | Receipt | Product commit | Started (UTC) | Finished (UTC) | Receipt SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Wave 4 | `final/v1-sealed.json` | `e7274aa6cc9aacbf3d03c1b3be572720cfb9c5a3` | 2026-11-25T08:47:51.423Z | 2026-11-25T08:48:32.864Z | `9602b70afb087b59ccfeba458bf688a1556c7b242398af5834ab15e6667289c3` |

### V2 sealed

| Group | Wave 4 |
| --- | ---: |
| Overall | 797/1,200 |
| Area / calculation | 0/110 |
| Area / clarification | 11/17 |
| Area / coding | 51/85 |
| Area / comparison | 65/70 |
| Area / factual | 399/515 |
| Area / follow-up | 16/95 |
| Area / refusal | 228/258 |
| Area / small-talk | 27/50 |
| Language / ar | 493/600 |
| Language / en | 304/600 |

| Run | Receipt | Product commit | Started (UTC) | Finished (UTC) | Receipt SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Wave 4 | `final/v2-sealed.json` | `e7274aa6cc9aacbf3d03c1b3be572720cfb9c5a3` | 2026-11-25T08:48:36.457Z | 2026-11-25T08:51:12.363Z | `4e8f4ce57b7ec1c1ddab714b1475a8338d683e91e0c3f38da76ee80d05cc2ced` |

The published wave 3 sealed totals were 27/60 and 748/1,200. Wave 4 changed by +0 passes on v1 and +49 on v2.
