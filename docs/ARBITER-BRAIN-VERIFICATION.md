# Arbiter brain verification

The comparison base is release candidate commit `d3ebd9223f44445627b9d3d0bdea08d5f9b0550a`. The arbiter belongs to the model relations manager. An existing component still handles each turn.

## Decision sites

| Decision | Candidate sources | Activation flag |
| --- | --- | --- |
| Routing | Qualified existing handlers and adopted scratch routing decisions | `MOHASSAN_ARBITER_ROUTING` |
| Question rewrite | Validated rewrite and the original eligible public query | `MOHASSAN_ARBITER_QUESTION_REWRITE` |
| Local computation | Reasoning result and the native calculator result | `MOHASSAN_ARBITER_LOCAL_COMPUTATION` |
| Compound plan | Compiled plan and the available direct handler | `MOHASSAN_ARBITER_COMPOUND_PLAN` |

Each activation flag requires a promoted decision type in the manager. Add `_KILL=1` to the flag name to restore the current precedence even if that type was promoted. `MOHASSAN_MODEL_RELATIONS=off` opts out of the relations manager. Refusal, account authorization and approval checks keep their authority.

The scorer is a regularized logistic model initialized from zero. Input features include claimant identity, any supplied score or label, language, bounded request length, conversation state and available states from the model registry. The case-family split holds the same family together. The trainer evaluates calibration on the held-out families and reports proposed changes. The choice operation uses CPU arithmetic and can fall back when the artifact or a relevant model is absent.

The owner command `npm run models:shadow-summary -- .data/model-relations-shadow.jsonl` summarizes decisions by type, reason and proposed transition. Individual entries carry labels, scores and timing metadata without prompt or answer text.

## Development data

The v1 development fixture at #22 has 240 cases with `provenance.author: agent`. Its README marks every case evaluation-only. The human v2 development fixture at #62 has 2,400 cases. The published #70 filter includes the v2 development and sealed exclusion indexes and rejects rows by native source ID or normalized text hash. A v2 development case matches its own source ID. Applying those rules leaves zero eligible cases for training or calibration across the two development splits. [V1 provenance](https://github.com/ahmadalwakai/Mohassan-AI/blob/a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f/tests/fixtures/agent-capability-bench/README.md) · [V2 development](https://github.com/ahmadalwakai/Mohassan-AI/pull/62) · [Exclusion audit](https://github.com/ahmadalwakai/Mohassan-AI/pull/70)

Development replay can still measure which components could pass the published scorer. It runs with fixture services and the documented release flags. Only eligible replay rows may reach model fitting. Replay receipts omit prompt and answer text. The release candidate's previously published scores are independent of this comparison. [Release verification protocol](RELEASE-CANDIDATE-2026-11-25.md#development-and-sealed-harness)

| Development split | Cases inspected | Human-authored | Matched PR #70 | Eligible |
| --- | ---: | ---: | ---: | ---: |
| V1 | 240 | 0 | 0 | 0 |
| V2 | 2,400 | 2,400 | 2,400 | 0 |

The v2 seal has already been used by several frozen candidates. A fresh sealed set would make the next claim stronger.

## Promotion

A decision type needs independently calibrated confidence and a paired run on both development splits before promotion. Each area and language must hold in each split. The release starts with every type in shadow. Sealed evaluation is conditional on promotion.

## Release baseline

The detached release candidate reproduced the published development totals and every published area and language count. Both splits use the release flags from the runbook, fixture tools, Node 24.22.3, Chromium 1248, and a network-disabled container with an unprivileged account and root-owned Python 3.12.14. V1 runs in one process. V2 uses the pinned index-modulo-eight lane assignment, one lane at a time.

| Split | Passes | Receipt SHA-256 |
| --- | ---: | --- |
| V1 | 176/240 | `5116b63d1bd38c2ef9074a6f15ff5abb93a0846b55f1ae069e718c30c0c819ed` |
| V2 | 1,588/2,400 | `43f47b18971b1e4d92e6ee4eec3a99b1ee379796e2006fa1b9566dff2f888d4f` |

The initial v1 run scored 169/240 because the container UID's home resolved to `/` and the desktop fixture adapter could not normalize folder paths. A service account with a normal home restored the seven desktop passes. The same initial run's v2 split reproduced the published counts.

The first v1 shadow replay at `4550e5a8ea3c2370d63b04aaa3ede624afca301c` matched all 240 baseline scorer signatures. It found 19 contested sites and scored all 38 forced choices. No alternative recovered a failing case. The 19 synchronous timings had a p95 of 1.088 ms, so extra candidate discovery was moved into existing post-publication observation for default shadow operation.

## Paired development and counterfactual outcomes

All 2,640 cases kept their exact scorer signatures. All 28 overall, area and language groups held. Across the 49 contested cases, every one of the 98 forced trials applied and every repeated precedence trial reproduced the original pass or fail.

The v1 oracle gained zero passes. The v2 oracle gained one pass in English factual lookup by using the existing lookup handler on a compound-plan decision. This raises the measured v2 single-override upper bound from 1,588 to 1,589 of 2,400. Each of the 29 v2 routing alternatives lost a pass.

### V1 development

| Group | Release baseline | Arbiter shadow | Change |
| --- | ---: | ---: | ---: |
| Overall | 176/240 | 176/240 | 0 |
| Area / calculation | 18/18 | 18/18 | 0 |
| Area / clarification | 16/16 | 16/16 | 0 |
| Area / coding | 0/16 | 0/16 | 0 |
| Area / comparison | 11/18 | 11/18 | 0 |
| Area / desktop | 11/16 | 11/16 | 0 |
| Area / document-file | 16/18 | 16/18 | 0 |
| Area / explanation | 8/18 | 8/18 | 0 |
| Area / factual | 10/18 | 10/18 | 0 |
| Area / follow-up | 18/18 | 18/18 | 0 |
| Area / google-ads | 0/16 | 0/16 | 0 |
| Area / memory | 16/16 | 16/16 | 0 |
| Area / multi-step | 18/18 | 18/18 | 0 |
| Area / refusal | 16/16 | 16/16 | 0 |
| Area / small-talk | 18/18 | 18/18 | 0 |
| Language / ar | 85/120 | 85/120 | 0 |
| Language / en | 91/120 | 91/120 | 0 |

Pass/fail changed on 0 cases. Published scorer check signatures differed on 0 cases.

### V1 counterfactual replay

| Group | Contested cases | Decision sites | Forced trials with scores | Baseline passes | Additional oracle passes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Overall | 19 | 19 | 38/38 | 16 | 0 |
| Type / compound-plan | 17 | 17 | 34/34 | 14 | 0 |
| Type / question-rewrite | 2 | 2 | 4/4 | 2 | 0 |
| Area / coding | 1 | 1 | 2/2 | 0 | 0 |
| Area / factual | 2 | 2 | 4/4 | 0 | 0 |
| Area / follow-up | 2 | 2 | 4/4 | 2 | 0 |
| Area / multi-step | 14 | 14 | 28/28 | 14 | 0 |
| Language / ar | 8 | 8 | 16/16 | 6 | 0 |
| Language / en | 11 | 11 | 22/22 | 10 | 0 |


### V2 development

| Group | Release baseline | Arbiter shadow | Change |
| --- | ---: | ---: | ---: |
| Overall | 1,588/2,400 | 1,588/2,400 | 0 |
| Area / calculation | 7/277 | 7/277 | 0 |
| Area / clarification | 9/9 | 9/9 | 0 |
| Area / coding | 108/155 | 108/155 | 0 |
| Area / comparison | 28/32 | 28/32 | 0 |
| Area / factual | 976/1,244 | 976/1,244 | 0 |
| Area / follow-up | 46/240 | 46/240 | 0 |
| Area / refusal | 348/375 | 348/375 | 0 |
| Area / small-talk | 66/68 | 66/68 | 0 |
| Language / ar | 982/1,200 | 982/1,200 | 0 |
| Language / en | 606/1,200 | 606/1,200 | 0 |

Pass/fail changed on 0 cases. Published scorer check signatures differed on 0 cases.

### V2 counterfactual replay

| Group | Contested cases | Decision sites | Forced trials with scores | Baseline passes | Additional oracle passes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Overall | 30 | 30 | 60/60 | 29 | 1 |
| Type / compound-plan | 1 | 1 | 2/2 | 0 | 1 |
| Type / routing | 29 | 29 | 58/58 | 29 | 0 |
| Area / clarification | 3 | 3 | 6/6 | 3 | 0 |
| Area / factual | 1 | 1 | 2/2 | 0 | 1 |
| Area / small-talk | 26 | 26 | 52/52 | 26 | 0 |
| Language / ar | 1 | 1 | 2/2 | 1 | 0 |
| Language / en | 29 | 29 | 58/58 | 28 | 1 |

The v2 scoped replay ran against the exact measured product commit and records receipt SHA-256 `94bbf8d16776ed884eef41b86ebfe2133ad822a99553dbe97f507b9a15991f03`. Synchronous collection and arbitration in replay measured 6.462 ms p95 across 30 contests. The default shadow path runs that extra discovery after publication.

Refusal and authorization vetoes sit outside the forceable choices. The report covers recorded competing claims at the four arbiter sites. Deterministic recognizers reported labels and supplied no numeric scores for these cases. The runner records numeric scores when a component supplies one.

<details>
<summary>All 49 contested cases and their scored choices</summary>

| Split | Case ID | Turn | Decision type | Precedence | Forced claimant labels and outcomes |
| --- | --- | ---: | --- | --- | --- |
| v1 | `dev-factual-027` | 1 | compound-plan | `plan-compiler` | `plan-compiler` (`compound`) fail, `browser-plan` (`deterministic_browser_plan`) fail |
| v1 | `dev-factual-034` | 1 | compound-plan | `plan-compiler` | `plan-compiler` (`compound`) fail, `browser-plan` (`deterministic_browser_plan`) fail |
| v1 | `dev-follow-up-046` | 2 | question-rewrite | `question-rewriter` | `question-rewriter` (`rewritten_question`) pass, `factual-lookup` (`public_lookup`) pass |
| v1 | `dev-follow-up-047` | 2 | question-rewrite | `question-rewriter` | `question-rewriter` (`rewritten_question`) pass, `factual-lookup` (`public_lookup`) pass |
| v1 | `dev-multi-step-109` | 1 | compound-plan | `plan-compiler` | `plan-compiler` (`compound`) pass, `local-calculator` (`local_computation`) fail |
| v1 | `dev-multi-step-110` | 1 | compound-plan | `plan-compiler` | `plan-compiler` (`compound`) pass, `local-calculator` (`local_computation`) fail |
| v1 | `dev-multi-step-113` | 1 | compound-plan | `plan-compiler` | `plan-compiler` (`compound`) pass, `browser-plan` (`deterministic_browser_plan`) fail |
| v1 | `dev-multi-step-114` | 1 | compound-plan | `plan-compiler` | `plan-compiler` (`compound`) pass, `factual-lookup` (`public_lookup`) fail |
| v1 | `dev-multi-step-115` | 1 | compound-plan | `plan-compiler` | `plan-compiler` (`compound`) pass, `browser-plan` (`deterministic_browser_plan`) fail |
| v1 | `dev-multi-step-116` | 1 | compound-plan | `plan-compiler` | `plan-compiler` (`compound`) pass, `factual-lookup` (`public_lookup`) fail |
| v1 | `dev-multi-step-118` | 1 | compound-plan | `plan-compiler` | `plan-compiler` (`compound`) pass, `local-calculator` (`local_computation`) fail |
| v1 | `dev-multi-step-119` | 1 | compound-plan | `plan-compiler` | `plan-compiler` (`compound`) pass, `local-calculator` (`local_computation`) fail |
| v1 | `dev-multi-step-120` | 1 | compound-plan | `plan-compiler` | `plan-compiler` (`compound`) pass, `local-calculator` (`local_computation`) fail |
| v1 | `dev-multi-step-122` | 1 | compound-plan | `plan-compiler` | `plan-compiler` (`compound`) pass, `browser-plan` (`deterministic_browser_plan`) fail |
| v1 | `dev-multi-step-123` | 1 | compound-plan | `plan-compiler` | `plan-compiler` (`compound`) pass, `factual-lookup` (`public_lookup`) fail |
| v1 | `dev-multi-step-124` | 1 | compound-plan | `plan-compiler` | `plan-compiler` (`compound`) pass, `browser-plan` (`deterministic_browser_plan`) fail |
| v1 | `dev-multi-step-125` | 1 | compound-plan | `plan-compiler` | `plan-compiler` (`compound`) pass, `browser-plan` (`deterministic_browser_plan`) fail |
| v1 | `dev-multi-step-126` | 1 | compound-plan | `plan-compiler` | `plan-compiler` (`compound`) pass, `browser-plan` (`deterministic_browser_plan`) fail |
| v1 | `dev-coding-146` | 1 | compound-plan | `plan-compiler` | `plan-compiler` (`compound`) fail, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-58acca47d8c0141f7f3d189b` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-7117b6e303e65bed82670773` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-e24f0fd2c046313a6d61cadd` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-5688eb25b45b78899c0d8f8a` | 1 | routing | `everyday-clarification` | `everyday-clarification` (`missing_reference`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-1cb779b1a7a5d0070bcce813` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-2cd86227de240b7d53082c42` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-ae0039adea5a3fea884a3f36` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-64e759c4d2e6480202baa93f` | 1 | routing | `everyday-clarification` | `everyday-clarification` (`missing_reference`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-2b268ddd6133ebfc70b21048` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-25d5164520d65732fbd5e669` | 1 | compound-plan | `plan-compiler` | `plan-compiler` (`compound`) fail, `factual-lookup` (`public_lookup`) pass |
| v2 | `human-fe381b7195d75f3280332a68` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-ea9494bf5341ecedd5a9a417` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-24a6efaef28f00fe99541b23` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-df3dd4f0aac306e8cbf9dbca` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-6657fc86580ac29f989084fa` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-53ced0144d62a76d9d74c261` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-4677712880b2e7a3042856cd` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-80c0ff1c4b315b09d5b90891` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-cf71aca0fea8247a50226039` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-0320e78d1034e991a35361a5` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-79fbc5508d298b72c1907e36` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-4949ed0b7eceb351f1a7646f` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-5c9f60826b534ba236d40722` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-2f438fe08a99fe32f31bede6` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-5545dc8cedfed4c810447292` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-165ddff645aa2dca3e133f48` | 1 | routing | `everyday-clarification` | `everyday-clarification` (`missing_reference`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-1fa7c7a4110fb76025ac480d` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-9721e1cf7212092ec1ccca31` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-da523caa1002f128eb0d2a75` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |
| v2 | `human-58836838106188459923805f` | 1 | routing | `small-talk` | `small-talk` (`local_conversation`) pass, `factual-lookup` (`public_lookup`) fail |

</details>

## Training and promotion gate

The trainer loaded 49 complete counterfactual rows. Nineteen were agent-authored v1 rows and 30 were v2 rows excluded by PR #70. The combined metadata-only replay receipt has SHA-256 `29a1ae07007a4236e835ec195b613eda25e292db3d47ad54349ad92c4c2ac6aa`.

Training and calibration each had zero rows. The trainer emitted no weights or thresholds. Accuracy, Brier score and calibration error are unavailable. The shadow run made zero changes. The paired gate exited 0 for both development splits. All promotion flags remain gated, and no sealed evaluation ran.

## Shadow latency

The measured implementation is `28e4ac347ce8febef37392c91f4eb273970f2bc9`. Default shadow queues additional candidate discovery and completes that work in the existing post-publication observer. A scoped replay collects synchronously so it can force an eligible choice before dispatch. The critical-path and replay timings use different boundaries.

| Measurement | Samples | p95 |
| --- | ---: | ---: |
| Default shadow enqueue, warmed focused test | 4,000 | 0.003 ms |
| Manager scoring with a test artifact, warmed focused test | 4,000 | 0.090 ms |
| Default shadow publication hook, full v1 development | 279 | 0.147 ms |
| Background arbitration in the default shadow v1 run | 19 | 0.600 ms |
| Scoped v1 replay arbitration | 19 | 0.463 ms |

The normal v1 shadow run matched every baseline scorer signature. Its owner summary recorded 17 compound-plan contests and two rewrite contests. Each reported an untrained scorer, with zero disagreements or changes. The final scoped replay also matched every v1 baseline scorer signature and reproduced all 38 forced outcomes. Fourteen alternatives lost an existing pass, two tied a pass, and three left an existing failure.

The v1 normal shadow receipt is `2d3cd611cc195ddea25cfe43b734759f109e14470ac9beec5ecc46a1c6a02175`. The v1 scoped replay receipt is `33f19b9412d0f5c8393ef1e99de94be05dbbff453ae71b333a2d4e3a2302b3c3`. The v1 runs used a separate worktree and lower CPU priority while one v2 lane ran. Live promotion latency is unverified.

## Merge notes

- `apps/server/src/command-chat.ts` adds two lines and deletes one to bind arbiter observation to the existing run. This is the only held-file hook.
- The branch adds no schema migration, benchmark payload, or model weights. The Mind C and pinned execution trees have empty diffs against the release candidate.

## Benchmark commands

The runner uses the published fixtures, adapters and scorer. The release baseline turns the relations manager off as documented. Replay uses the same wave flags, scorer and fixture services, with per-case in-process overrides. Each forced trial starts the full case again and checks that the declared claimant actually won at that turn and site. A case with several contested sites contributes at most one additional pass to the overall oracle. The oracle reports the best observed single forced choice per case.

The following commands exited 0 for both baseline splits and for the v1 shadow and replay runs. The combined baseline run's initial v1 result was discarded after diagnosing the home-directory mismatch. Its v2 result is retained.

```bash
node scripts/arbiter-bench/prepare.mjs /workspace/Mohassan-Arbiter-Base
docker run --rm --network none --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --env PLAYWRIGHT_BROWSERS_PATH=/workspace/work/arbiter-bench/chromium --env TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3 --volume /workspace:/workspace --workdir /workspace/Mohassan-Arbiter-Base mohassan-arbiter-bench node --import tsx /workspace/Mohassan-AI/scripts/arbiter-bench/run.mjs /workspace/Mohassan-Arbiter-Base base /workspace/work/arbiter-bench/rc-base
docker run --rm --network none --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --env PLAYWRIGHT_BROWSERS_PATH=/workspace/work/arbiter-bench/chromium --env TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3 --volume /workspace:/workspace --workdir /workspace/Mohassan-Arbiter-Base mohassan-arbiter-bench nice -n 10 node --import tsx /workspace/Mohassan-AI/scripts/arbiter-bench/run.mjs /workspace/Mohassan-Arbiter-Base base /workspace/work/arbiter-bench/rc-base-v1 --v1
node scripts/arbiter-bench/prepare.mjs /workspace/Mohassan-Arbiter-After --capture
node scripts/arbiter-bench/prepare.mjs /workspace/Mohassan-Arbiter-Shadow --capture
docker run --rm --network none --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --env PLAYWRIGHT_BROWSERS_PATH=/workspace/work/arbiter-bench/chromium --env TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3 --volume /workspace:/workspace --workdir /workspace/Mohassan-Arbiter-Shadow mohassan-arbiter-bench nice -n 10 node --import tsx /workspace/Mohassan-AI/scripts/arbiter-bench/run.mjs /workspace/Mohassan-Arbiter-Shadow shadow /workspace/work/arbiter-bench/final-shadow-v1 --v1
docker run --rm --network none --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --env PLAYWRIGHT_BROWSERS_PATH=/workspace/work/arbiter-bench/chromium --env TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3 --volume /workspace:/workspace --workdir /workspace/Mohassan-Arbiter-Shadow mohassan-arbiter-bench nice -n 10 node --import tsx /workspace/Mohassan-AI/scripts/arbiter-bench/run.mjs /workspace/Mohassan-Arbiter-Shadow replay /workspace/work/arbiter-bench/final-replay-v1 --v1
npm run -s models:shadow-summary -- /workspace/work/arbiter-bench/final-shadow-v1/default-shadow-log.jsonl
```


The v2 replay, paired comparison, trainer, and all-group gate each exited 0.

```bash
docker run --rm --network none --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --env PLAYWRIGHT_BROWSERS_PATH=/workspace/work/arbiter-bench/chromium --env TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3 --volume /workspace:/workspace --workdir /workspace/Mohassan-Arbiter-After mohassan-arbiter-bench node --import tsx /workspace/Mohassan-AI/scripts/arbiter-bench/run.mjs /workspace/Mohassan-Arbiter-After replay /workspace/work/arbiter-bench/final-replay-v2-28e4ac3 --v2
node scripts/arbiter-bench/report.mjs /workspace/work/arbiter-bench/rc-base-v1/v1-development.json /workspace/work/arbiter-bench/rc-base/v2-development.json /workspace/work/arbiter-bench/final-replay-v1/v1-development.json /workspace/work/arbiter-bench/final-replay-v2-28e4ac3/v2-development.json /workspace/work/arbiter-bench/final-combined/paired.json > /workspace/work/arbiter-bench/final-combined/paired-summary.json
node --import tsx packages/model-relations/src/arbiter-train-cli.ts train --replay /workspace/work/arbiter-bench/final-combined/replay-dataset.json --report /workspace/work/arbiter-bench/final-combined/training-report.json --artifact /workspace/work/arbiter-bench/final-combined/model.json
node --import tsx packages/model-relations/src/arbiter-train-cli.ts gate --before /workspace/work/arbiter-bench/final-combined/before.json --after /workspace/work/arbiter-bench/final-combined/after.json --report /workspace/work/arbiter-bench/final-combined/gate.json
test ! -e /workspace/work/arbiter-bench/final-combined/model.json
```

The trainer's input combines the two text-free replay receipts after verifying their schema, exclusion manifest and split identities. The gate uses the two per-case arrays from the paired comparison receipt.

## Code and source checks

| Check | Result |
| --- | --- |
| Root and web typecheck | Exit 0 |
| Affected assistant and model relations suites with Chromium | Exit 0, 224 passed in 17 suites. One permanent-worker integration test skipped because its optional Python model-worker configuration was unavailable. |
| Focused manager, observer, and owner summary suites | Exit 0, 31 passed in four suites |
| Pinned v1 source and isolation guards | Exit 0, six passed in three suites with the development fixture materialized |
| V2 development literal scan relative to the release candidate | Exit 0, zero new matches across 2,400 development cases |
| V2 hash guards relative to the release candidate | Exit 0, four passed with the original detectors and both hash registries |

The initial affected-suite invocation omitted the downloaded Chromium path. Five PDF tests failed, 216 passed, and one skipped. The Chromium-configured rerun above passed. In that run the warmed manager scoring test measured 0.047 ms p95 and default shadow scheduling measured 0.003 ms p95.

The original v2 guard references flagged the same 12 inherited occurrences across 10 paths on the release candidate and this branch. The release-relative scratch launcher used the same detectors and exact release bytes as its reference. The development literal scan additionally inspected changed source against the pinned v2 development literals. Both paths confined benchmark data access to development payloads and the published exclusion hashes.

```bash
nice -n 15 npm run typecheck > /tmp/mohassan-arbiter-final-typecheck.log 2>&1
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/arbiter-bench/chromium nice -n 15 npm test -- --maxWorkers=1 --reporter=dot --disableConsoleIntercept packages/model-relations/src tests/model-relations-arbiter.test.ts tests/model-relations-shadow.test.ts tests/assistant-routing-decision.test.ts tests/assistant-scratch-decisions.test.ts tests/question-rewrite-chat.test.ts tests/question-rewriter.test.ts tests/assistant-manners-chat.test.ts tests/assistant-clarify-choices-chat.test.ts tests/assistant-local-computation.test.ts tests/assistant-local-computation-chat.test.ts tests/assistant-plan-chat.test.ts tests/assistant-reasoning-chat.test.ts > /tmp/mohassan-arbiter-final-affected.log 2>&1
nice -n 10 npm test -- --maxWorkers=1 --reporter=dot --disableConsoleIntercept tests/model-relations-arbiter.test.ts tests/model-relations-shadow.test.ts packages/model-relations/src/manager.test.ts packages/model-relations/src/cli.test.ts
nice -n 10 npm test -- --maxWorkers=1 --reporter=dot --disableConsoleIntercept tests/agent-capability-source-guard.test.ts tests/agent-capability-leakage.test.ts tests/assistant-refusal-benchmark-isolation.test.ts
nice -n 10 python3 -B /workspace/work/arbiter-verify/v2-release-development-literals.py
nice -n 10 python3 -B /workspace/work/arbiter-verify/v2-release-source-guards.py
```

The v1 guard command ran in the detached fixture-equipped checkout. The original v2 guard commands below exited 1 in their historical form. The combined command in the detached release candidate reproduced the same two failures.

```bash
nice -n 10 python3 -B -m unittest discover -s tests -p test_v2_case_strings.py -v
nice -n 10 python3 -B -m unittest discover -s tests -p test_v2_source_leakage.py -v
nice -n 10 python3 -B -m unittest discover -s tests -p 'test_v2_*.py' -v
```

A separate 800-pair production routing probe exited 0. Whole-routing p95 was 4.996 ms with relations off and 4.907 ms in default shadow. The p95 of individual paired differences was 1.137 ms. Deferred discovery measured 2.432 ms p95 across 300 background contests in that synthetic workload. The focused enqueue test and the publication hook measurement isolate the synchronous shadow work.

```bash
MOHASSAN_SMALL_TALK_MANNERS=1 MOHASSAN_REASONING=1 MOHASSAN_SCRATCH_CLASSIFIERS=1 MOHASSAN_REFUSAL_POLICY=1 MOHASSAN_ARITHMETIC_SEARCH=1 nice -n 10 node --import tsx /workspace/work/arbiter-verify/route-latency.mjs 800
```

The held-file and protected-tree checks below exited 0. The held-file list contained only `2 1 apps/server/src/command-chat.ts`. The protected-tree list was empty.

```bash
git diff --check d3ebd9223f44445627b9d3d0bdea08d5f9b0550a
git diff --name-only d3ebd9223f44445627b9d3d0bdea08d5f9b0550a -- apps/server/src/assistant/mind packages/execution-pipeline packages/execution-model
git diff --numstat d3ebd9223f44445627b9d3d0bdea08d5f9b0550a -- 'apps/web/components/**' 'packages/google-ads/src/**' 'packages/browser/src/**' 'packages/chrome-extension/**' 'apps/android/**' 'packages/providers/src/**' apps/server/src/{app,chrome-extension,command-chat,config,inference,members}.ts apps/server/src/assistant/{ads-model-chat,agent-run,brain,campaign-run,tools,hands}.ts packages/contracts/src/{ai-providers,campaign-progress,command-chat,google-ads}.ts
```
