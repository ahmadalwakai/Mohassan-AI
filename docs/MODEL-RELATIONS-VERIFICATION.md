# Model relations development verification

The product base was `d4654f4f9e9ce7f142c4376c95a5dd4fe0fbc7b2`, the fetched tip of `integration/wave-4` (PR #84). The retained Wave 4 product tree was `e7274aa6cc9aacbf3d03c1b3be572720cfb9c5a3`. Its later commit added the integration report. [Wave 4 protocol](./INTEGRATION-WAVE-4-2026-11-25.md)

## Protocol

Each measurement used a detached checkout of its product SHA, temporary PGlite and fixture tool ports. V1 ran serially before V2. V2 scheduled each case by its release index modulo eight in eight isolated Node processes. The coordinator verified the source SHA, lockfile, manifest, harness and lane hashes, and case ordering. It then restored release order and recomputed the published scorer summary. Each area and each language was compared to the last retained tree.

V1 used the runner and development payload from #22 at `a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f`. V2 used the runner and development payload from #62 at `12cedfe592aab40cdd47ee00d05ea86a6d2bae89`, verified against the scratch audit merge tree for #70 at `a1e1cb020b7ba093885edbf501149e7b8252c0cb`. The launcher materialized only the matching tooling and development paths. The #41 observer at `0dfff7c54d3658a02cf878ff11faac7f630a6c10` adapted reviewer publication and structured memory for both splits and clarification for V2. A scorer overlay recorded reply hashes so we could inspect reply text parity with no text in the receipts. Scoring continued to use the published checks.

Both measured splits were development splits. All commands used Node `v24.22.3` with `--no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx`, Playwright Chromium build `1248` (`156.0.8078.4`), and Python `3.12.14` with `libseccomp.so.2`. The launcher cleared the caller's model and provider environment and set the Wave 4 flags.

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

## Merge gates

| Order | Pull request | Fetched head | Merge commit |
| ---: | --- | --- | --- |
| 1 | [#29 own model provider and permanent worker](https://github.com/ahmadalwakai/Mohassan-AI/pull/29) | `5315f2525158e3e958dcc8c69b028a061425d6a3` | `e268e2dca3eb85ca0833ade147c5748efd98c30d` |
| 2 | [#44 v5 head training kit](https://github.com/ahmadalwakai/Mohassan-AI/pull/44) | `763db24ae4e1ec24c4bedbc0f00eaabac35dac1c` | `a559f8501c0dec12657d009ef8caa548abb6cc5b` |
| 3 | [#8 B2 router](https://github.com/ahmadalwakai/Mohassan-AI/pull/8) | `80af7fc56be08c816a0ddc62027022eebcf14bfe` | `71bf013f2405afcb357b92bb7f67e555efaeb77c` |
| 4 | [#85 arithmetic ranker](https://github.com/ahmadalwakai/Mohassan-AI/pull/85) | `f161bbb84f24677efb5758195534ca46d3330b05` | `d59fe5c73fd332cc582492665b560f5511344b31` |

All four paired gates held each area and language and matched every case's scored checks. The #85 merge gates its new answer and classifier paths with the opt-in `MOHASSAN_ARITHMETIC_SEARCH=1`.

### V1 development

| Group | baseline | pr29 | pr44 | pr8 | pr85 | shadow |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Overall | 176/240 | 176/240 | 176/240 | 176/240 | 176/240 | 176/240 |
| Area / calculation | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| Area / clarification | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 |
| Area / coding | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 |
| Area / comparison | 11/18 | 11/18 | 11/18 | 11/18 | 11/18 | 11/18 |
| Area / desktop | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 |
| Area / document-file | 16/18 | 16/18 | 16/18 | 16/18 | 16/18 | 16/18 |
| Area / explanation | 8/18 | 8/18 | 8/18 | 8/18 | 8/18 | 8/18 |
| Area / factual | 10/18 | 10/18 | 10/18 | 10/18 | 10/18 | 10/18 |
| Area / follow-up | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| Area / google-ads | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 |
| Area / memory | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 |
| Area / multi-step | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| Area / refusal | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 |
| Area / small-talk | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| Language / ar | 85/120 | 85/120 | 85/120 | 85/120 | 85/120 | 85/120 |
| Language / en | 91/120 | 91/120 | 91/120 | 91/120 | 91/120 | 91/120 |

| Run | Product SHA | Started UTC | Finished UTC | Receipt SHA-256 |
| --- | --- | --- | --- | --- |
| `baseline` | `d4654f4f9e9ce7f142c4376c95a5dd4fe0fbc7b2` | `2026-11-25T11:06:15.505Z` | `2026-11-25T11:07:08.871Z` | `b0f2e615360f897c419748342fc691424460e2f20c243338c2fd43defb114d19` |
| `pr29` | `e268e2dca3eb85ca0833ade147c5748efd98c30d` | `2026-11-25T11:10:55.511Z` | `2026-11-25T11:11:51.873Z` | `207506b44eab0b924c707b7587a23a658556152e68ec229aae88eb9ce2a256ce` |
| `pr44` | `a559f8501c0dec12657d009ef8caa548abb6cc5b` | `2026-11-25T11:16:26.248Z` | `2026-11-25T11:17:49.424Z` | `acbfc579d94727f3e3709df1410f3ff2c3fac3aa3ad6cb376d3ba63ce9cc8dab` |
| `pr8` | `71bf013f2405afcb357b92bb7f67e555efaeb77c` | `2026-11-25T11:23:06.281Z` | `2026-11-25T11:24:45.711Z` | `4e5955485bee78cde983c4432c7ad8f30f410a4c232d4ad335da570f0749242b` |
| `pr85` | `d59fe5c73fd332cc582492665b560f5511344b31` | `2026-11-25T11:30:32.243Z` | `2026-11-25T11:31:52.250Z` | `5f3fa217efc361b3bca79883fe07ff49fb9ead2db10b68ee2271897c95dbd9a8` |
| `shadow` | `20f50aceefad0bdae860a6fc5cdc2a28ed2cb7bc` | `2026-11-25T11:36:28.717Z` | `2026-11-25T11:37:29.052Z` | `63f619f45c8599e0d1fbb18d835a0865ac1baf86c224e7fff32ab8c76f720869` |

### V2 development

| Group | baseline | pr29 | pr44 | pr8 | pr85 | shadow |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Overall | 1,586/2,400 | 1,586/2,400 | 1,586/2,400 | 1,586/2,400 | 1,586/2,400 | 1,586/2,400 |
| Area / calculation | 5/277 | 5/277 | 5/277 | 5/277 | 5/277 | 5/277 |
| Area / clarification | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| Area / coding | 108/155 | 108/155 | 108/155 | 108/155 | 108/155 | 108/155 |
| Area / comparison | 28/32 | 28/32 | 28/32 | 28/32 | 28/32 | 28/32 |
| Area / factual | 976/1,244 | 976/1,244 | 976/1,244 | 976/1,244 | 976/1,244 | 976/1,244 |
| Area / follow-up | 46/240 | 46/240 | 46/240 | 46/240 | 46/240 | 46/240 |
| Area / refusal | 348/375 | 348/375 | 348/375 | 348/375 | 348/375 | 348/375 |
| Area / small-talk | 66/68 | 66/68 | 66/68 | 66/68 | 66/68 | 66/68 |
| Language / ar | 982/1,200 | 982/1,200 | 982/1,200 | 982/1,200 | 982/1,200 | 982/1,200 |
| Language / en | 604/1,200 | 604/1,200 | 604/1,200 | 604/1,200 | 604/1,200 | 604/1,200 |

| Run | Product SHA | Started UTC | Finished UTC | Receipt SHA-256 |
| --- | --- | --- | --- | --- |
| `baseline` | `d4654f4f9e9ce7f142c4376c95a5dd4fe0fbc7b2` | `2026-11-25T11:07:35.360Z` | `2026-11-25T11:10:25.897Z` | `4ec856705d9ff9b4cff60b541b387aa010ea4e6ef8f3a4d1a34b00b9c5843f77` |
| `pr29` | `e268e2dca3eb85ca0833ade147c5748efd98c30d` | `2026-11-25T11:12:20.978Z` | `2026-11-25T11:15:41.107Z` | `d2049e94cff6ad3a7ab77ab87a849f8c3e621f02be135ffd7f3dce930ce5372c` |
| `pr44` | `a559f8501c0dec12657d009ef8caa548abb6cc5b` | `2026-11-25T11:18:26.876Z` | `2026-11-25T11:22:37.369Z` | `e054151578c05d06f30bc904054f4d62e3f89d2ebd44c3f0803145ad38f26156` |
| `pr8` | `71bf013f2405afcb357b92bb7f67e555efaeb77c` | `2026-11-25T11:25:32.085Z` | `2026-11-25T11:29:57.472Z` | `9df97db9825218350306226c3522f50077285d88f393ae12dfe4ed440c104e38` |
| `pr85` | `d59fe5c73fd332cc582492665b560f5511344b31` | `2026-11-25T11:32:28.781Z` | `2026-11-25T11:35:58.552Z` | `7507f154c45685f25c0985547f1ea486cc85b955ebff1115159a35403e733450` |
| `shadow` | `20f50aceefad0bdae860a6fc5cdc2a28ed2cb7bc` | `2026-11-25T11:37:56.195Z` | `2026-11-25T11:41:47.781Z` | `b8c31ebc47a0e97c3944ae2e40a3581648382178468e68015103a2acf5895934` |

## Exact shadow parity

The gate compares each ordered case and each turn’s scored checks. Independent raw reply hashes also capture existing source read timestamps, nonce-selected small-talk copy and generated document identifiers. Those varied in the pre-manager control comparison of the baseline and #29, even though all scored checks matched. [Source timestamps](../apps/server/src/assistant/hands.ts) · [Small-talk variations](../apps/server/src/assistant/manners/chat.ts)

| Comparison | V1 exact scored cases | V2 exact scored cases | V1 raw reply hashes | V2 raw reply hashes |
| --- | ---: | ---: | ---: | ---: |
| Wave 4 vs #29, before the manager | 240/240 | 2,400/2,400 | 210/240 | 1,345/2,400 |
| Wave 4 vs default shadow | 240/240 | 2,400/2,400 | 209/240 | 1,352/2,400 |

## Latency and shadow observations

Scheduling measures the synchronous work before the chat resumes. Background evaluation covers the manager's work after scheduling. Each row counts measured observations.

| Split | Measure | Observations | Median (ms) | p95 (ms) |
| --- | --- | ---: | ---: | ---: |
| V1 | Synchronous scheduling | 279 | 0.036241 | 0.149431 |
| V1 | Background evaluation | 279 | 0.688587 | 11.582356 |
| V2 | Synchronous scheduling | 2,400 | 0.050104 | 0.271988 |
| V2 | Background evaluation | 2,400 | 3.262519 | 173.608148 |

The observer recorded 279 V1 events and 2,400 V2 events. The benchmark scored 279 and 2,400 timed turns. The product can publish multiple events in one scored turn, for example a pause followed by completion.

Disagreement rates use outputs that could be compared to a recorded host decision. Absent models and abstentions use the existing rules.
The concurrency limit also skipped observations during the benchmark burst.
The refusal classifier recorded `busy` for 250 of 279 V1 turns and 1,880 of
2,400 V2 turns. The disagreement rates describe the comparable outputs from
that workload.

| Model | Considered | Comparable | Disagreements | Rate | Fallbacks |
| --- | ---: | ---: | ---: | ---: | ---: |
| `arithmetic` | 272 | 0 | 0 | — | 272 |
| `head-answer-sentence` | 368 | 0 | 0 | — | 368 |
| `head-sufficiency` | 1,251 | 0 | 0 | — | 1,251 |
| `question-edit` | 2 | 0 | 0 | — | 2 |
| `refusal` | 2,679 | 489 | 227 | 46.4% | 2,190 |
| `router-b0` | 2,679 | 0 | 0 | — | 2,679 |
| `router-b2` | 2,679 | 0 | 0 | — | 2,679 |
| `scratch-follow-up` | 24 | 1 | 0 | 0.0% | 23 |
| `scratch-refusal` | 2,679 | 262 | 220 | 84.0% | 2,417 |
| `scratch-route` | 2,679 | 297 | 186 | 62.6% | 2,382 |
| `scratch-speech-act` | 2,679 | 542 | 3 | 0.6% | 2,137 |

## Development commands

Run the commands from the repository root.

```bash
bench=/workspace/work/model-relations-bench
"$bench/run" development baseline d4654f4f9e9ce7f142c4376c95a5dd4fe0fbc7b2
python3 -B "$bench/gate.py" baseline d4654f4f9e9ce7f142c4376c95a5dd4fe0fbc7b2
"$bench/run" development pr29 e268e2dca3eb85ca0833ade147c5748efd98c30d
python3 -B "$bench/gate.py" baseline pr29 d4654f4f9e9ce7f142c4376c95a5dd4fe0fbc7b2 e268e2dca3eb85ca0833ade147c5748efd98c30d
python3 -B "$bench/gate.py" --exact baseline pr29 d4654f4f9e9ce7f142c4376c95a5dd4fe0fbc7b2 e268e2dca3eb85ca0833ade147c5748efd98c30d
"$bench/run" development pr44 a559f8501c0dec12657d009ef8caa548abb6cc5b
python3 -B "$bench/gate.py" pr29 pr44 e268e2dca3eb85ca0833ade147c5748efd98c30d a559f8501c0dec12657d009ef8caa548abb6cc5b
"$bench/run" development pr8 71bf013f2405afcb357b92bb7f67e555efaeb77c
python3 -B "$bench/gate.py" pr44 pr8 a559f8501c0dec12657d009ef8caa548abb6cc5b 71bf013f2405afcb357b92bb7f67e555efaeb77c
"$bench/run" development pr85 d59fe5c73fd332cc582492665b560f5511344b31
python3 -B "$bench/gate.py" pr8 pr85 71bf013f2405afcb357b92bb7f67e555efaeb77c d59fe5c73fd332cc582492665b560f5511344b31
"$bench/run" development shadow 20f50aceefad0bdae860a6fc5cdc2a28ed2cb7bc
python3 -B "$bench/gate.py" --exact baseline shadow d4654f4f9e9ce7f142c4376c95a5dd4fe0fbc7b2 20f50aceefad0bdae860a6fc5cdc2a28ed2cb7bc
python3 -B "$bench/latency.py" shadow
```

The baseline V1 and V2 runners and both receipt validators completed successfully. The baseline launcher exited 2 after writing both receipts because its cleanup script was edited while the launcher was still running. The independent receipt gate exited 0. The corrected launcher completed the later runs.

The paired end-to-end latency difference with shadow disabled remains unverified. The scheduling and background timings above come directly from the shadow observations.

## Implementation checks

Root and web typecheck passed with `nice -n 10 npm run typecheck`. The registry listed 47 model entries with `npm run -s models:list`. The inventory health run with `npm run -s models:health` returned six healthy CPU artifacts and 41 absent entries. The Linux runbook records the refusal and arithmetic CLI probes. The following commands exercised the recorded V1 shadow decisions, the isolated worker and the final shadow deadline fix.

```sh
npm run -s models:shadow-summary -- /workspace/work/model-relations-bench/receipts/shadow/v1-shadow.jsonl
npm run test -- packages/model-relations/src/runtime.test.ts packages/model-relations/src/cli.test.ts
npx vitest run packages/model-relations/src/registry.test.ts
MODEL_WORKER_TEST_PYTHON=/workspace/work/model-relations-pr/python/bin/python npm run test -- packages/model-relations/src/runtime-worker.e2e.test.ts
python3 -B -m unittest discover -s packages/model-relations/src -p test_encode_input.py
npm test -- --maxWorkers=1 packages/model-relations/src/manager.test.ts tests/model-relations-shadow.test.ts
OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 nice -n 15 /workspace/work/model-relations-pr/python/bin/python -B -m pytest -q -p no:cacheprovider packages/execution-integration/model_worker/tests
```

These commands exited 0. The summary read 279 V1 turns. The runtime and CLI passed 17 tests, the registry passed four, the CPU worker test and tokenizer test passed one each, and the manager and server observer passed nine. The worker Python suite passed 37 with one skip. The CPU worker test used a random-initialized fixture. Owner checkpoint inference, native GPU inference and Windows execution remain unverified.

The broader Vitest run at lower priority while benchmarks were active passed 306 tests and skipped nine, with 10 failed tests and a worker setup failure. The following isolated rerun passed 41 tests and failed six. It rechecked the timing-sensitive package and provider suites after the benchmark lanes exited.

```sh
MODEL_WORKER_TEST_PYTHON=/workspace/work/model-relations-pr/python/bin/python \
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/model-relations-bench/chromium \
nice -n 15 npm test -- --maxWorkers=1 --reporter=dot --disableConsoleIntercept \
  packages/model-relations/src packages/execution-integration/src/permanent-worker.test.ts \
  packages/execution-integration/src/permanent-worker.e2e.test.ts \
  packages/scratch-classifiers/src packages/vision/src tests/model-relations-shadow.test.ts \
  tests/model-worker-server.test.ts tests/own-model-*.test.ts tests/assistant-router.test.ts \
  tests/assistant-arithmetic-search-candidates.test.ts tests/assistant-arithmetic-search-quantities.test.ts \
  tests/assistant-refusal-arithmetic.test.ts tests/assistant-refusal-learned.test.ts \
  tests/assistant-scratch-decisions.test.ts tests/assistant-word-problem*.test.ts \
  tests/assistant-structured-memory-chat.test.ts tests/question-rewrite-chat.test.ts

MODEL_WORKER_TEST_PYTHON=/workspace/work/model-relations-pr/python/bin/python \
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/model-relations-bench/chromium \
npm test -- --maxWorkers=1 --hookTimeout=60000 --testTimeout=60000 --reporter=dot \
  packages/model-relations/src/runtime.test.ts \
  packages/execution-integration/src/permanent-worker.e2e.test.ts \
  packages/scratch-classifiers/src/index.test.ts \
  tests/own-model-provider.test.ts tests/own-model-chat.test.ts \
  tests/own-model-phrasing.test.ts tests/own-model-reply.test.ts
```

The isolated failures were four permanent worker startup or readiness checks, one provider phrasing fixture startup, and the scratch classifier's long-input timing gate. Scratch p95 was 2.323 ms for the 2 ms gate.

The same worker and scratch suites ran in a detached checkout of the retained #29 merge at `e268e2dca3eb85ca0833ade147c5748efd98c30d`, before the relations manager. They passed 18 tests and reproduced four of the later failures. The scratch timing gate passed on this control run.

```sh
cd /workspace/work/model-relations-pr/worker-control
MODEL_WORKER_TEST_PYTHON=/workspace/work/model-relations-pr/python/bin/python \
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/model-relations-bench/chromium \
npm test -- --maxWorkers=1 --hookTimeout=60000 --testTimeout=60000 --reporter=dot \
  packages/execution-integration/src/permanent-worker.e2e.test.ts \
  packages/scratch-classifiers/src/index.test.ts tests/own-model-phrasing.test.ts
```

A branch-only rerun with `npm test -- --maxWorkers=1 packages/scratch-classifiers/src/index.test.ts` passed six tests and failed the long-input timing check at 5.294 ms p95. The scratch classifier package is byte-identical to the Wave 4 base according to `git diff --name-only origin/integration/wave-4 HEAD -- packages/scratch-classifiers`.

The final typecheck and the focused relation and arithmetic suites both exited 0. The Vitest run passed all 67 tests across nine files.

```sh
npm run typecheck
MODEL_WORKER_TEST_PYTHON=/workspace/work/model-relations-pr/python/bin/python \
npm test -- --maxWorkers=1 --hookTimeout=60000 --testTimeout=60000 \
  packages/model-relations/src tests/model-relations-shadow.test.ts \
  tests/assistant-word-problem-chat.test.ts tests/assistant-refusal-arithmetic.test.ts \
  tests/assistant-scratch-decisions.test.ts
```
