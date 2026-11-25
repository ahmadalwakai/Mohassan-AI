# Capability v2 factual preservation

PR #63 measured the original scratch classifier candidate at 335/1,200 sealed passes, including a 24-case factual loss against the product baseline. The PR #70 contamination audit retained 87 of the 88 overall net gains after masking fitted and selection overlap. This follow-up used the 2,400-case public development split for diagnosis and froze the new candidate before sealed evaluation. [Prior branch study](https://github.com/ahmadalwakai/Mohassan-AI/pull/63) · [Contamination audit](https://github.com/ahmadalwakai/Mohassan-AI/pull/70) · [Development release](https://github.com/ahmadalwakai/Mohassan-AI/pull/62)

## Cause and change

The original weights replaced 168 approved factual web searches and 10 comparison searches with `scratch_refuse` in a direct development routing replay. The route head sent one historical question to news. The full paired development run attributed 55 of 56 factual losses to `scratch_refuse` and one to the news route. It also attributed all six comparison losses to `scratch_refuse`. A 35-case controller replay confirmed that 12 unresolved factual candidates failed with either flag setting. The original speech-act head selected small talk for zero factual or comparison development cases.

The policy now limits learned refusals and news routing to eligible fallbacks. It preserves recognized public lookups and structured nominal factual requests, and preserves executable search when the speech head suggests small talk. It also protects a self-contained new task from inheriting a previous place or date due to a learned follow-up prediction. An additional development routing replay using the guarded weights found zero learned replacements of approved factual or comparison searches.

Native ingestion verifies both published registry partitions and filters each source before deduplication. CLINC uses its original split and row index, MASSIVE uses native item IDs, and CANARD checks both model-visible questions and the dialogue/question ID. The retraining report gives the guarded test delta for every head and corpus. [Guarded retraining report](V2-RETRAINING.md)

## V2 development

The original feature commit `76b1a9325a5ef4edda84816cc6523aa06026121e` supplied both before runs. The updated run used `f155f21f3ed61b7b11c8c66a7aa182fe6b9634f5`. Both scratch checkouts used an uncommitted `git merge --no-commit --no-ff` of v2 development revision `12cedfe592aab40cdd47ee00d05ea86a6d2bae89` from PR #62.

| Area | Original flag off | Original flag on | Updated flag on |
| --- | ---: | ---: | ---: |
| Overall | 499/2,400 | 599/2,400 | 660/2,400 |
| Factual | 470/1,244 | 414/1,244 | 470/1,244 |
| Factual, Arabic | 401/1,017 | 348/1,017 | 401/1,017 |
| Factual, English | 69/227 | 66/227 | 69/227 |
| Comparison | 23/32 | 17/32 | 23/32 |
| Refusal | 0/375 | 158/375 | 157/375 |
| Small talk | 6/68 | 10/68 | 10/68 |
| Follow-up | 0/240 | 0/240 | 0/240 |
| Calculation | 0/277 | 0/277 | 0/277 |
| Clarification | 0/9 | 0/9 | 0/9 |
| Coding | 0/155 | 0/155 | 0/155 |

Pairing by case ID against original flag-on results, the updated flag-on run gained 56 factual and six comparison passes and lost one refusal pass. Against the original flag-off results, it gained 157 refusal and four small-talk passes with zero losses. All three runs exited 0.

| Receipt | Wall time | SHA-256 |
| --- | ---: | --- |
| `dev-before-off.json` | 910.226 s | `96a663e13070bab30f1c2a21a0fe46b207f37935314a995637c952d9b742c9d8` |
| `dev-before-on.json` | 721.280 s | `22635219070eb0a42a3b949beb27d3d456851e951796053f3dc7bd30fcfac060` |
| `dev-after-on.json` | 813.295 s | `712414ea286f48105bd9f74e194b758fed53042f93b8566a01077178fb12fc0e` |

The before runs used `/workspace/scratch/scratch-v2-bench`. The updated run used `/workspace/scratch/scratch-v2-bench-final`.

```sh
env -u MOHASSAN_SCRATCH_CLASSIFIERS TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/scratch/mohassan-playwright npm run assistant:capability-bench -- --v2-dev --output /workspace/scratch/v2-bench-runs/dev-before-off.json > /workspace/scratch/v2-bench-runs/dev-before-off.log 2>&1
MOHASSAN_SCRATCH_CLASSIFIERS=1 TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/scratch/mohassan-playwright npm run assistant:capability-bench -- --v2-dev --output /workspace/scratch/v2-bench-runs/dev-before-on.json > /workspace/scratch/v2-bench-runs/dev-before-on.log 2>&1
MOHASSAN_SCRATCH_CLASSIFIERS=1 TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/scratch/mohassan-playwright npm run assistant:capability-bench -- --v2-dev --output /workspace/scratch/v2-bench-runs/dev-after-on.json > /workspace/scratch/v2-bench-runs/dev-after-on.log 2>&1
```

## V2 sealed release

The one sealed run used frozen product commit `f155f21f3ed61b7b11c8c66a7aa182fe6b9634f5` and the published release at `a130b239d9e6d2b1f6728128019d24bb26e9293f`, merged without committing in the detached `/workspace/scratch/scratch-v2-bench-final` checkout. The candidate ran on Node 24.22.3, Linux x64 and London time.

| Area | Published product baseline | Published original flag on | Updated flag on |
| --- | ---: | ---: | ---: |
| Overall | 247/1,200 | 335/1,200 | 369/1,200 |
| Factual | 203/515 | 179/515 | 203/515 |
| Comparison | 40/70 | 30/70 | 40/70 |
| Refusal | 0/258 | 120/258 | 120/258 |
| Small talk | 4/50 | 6/50 | 6/50 |
| Follow-up | 0/95 | 0/95 | 0/95 |
| Calculation | 0/110 | 0/110 | 0/110 |
| Clarification | 0/17 | 0/17 | 0/17 |
| Coding | 0/85 | 0/85 | 0/85 |

The sealed factual score was 171/425 in Arabic and 32/90 in English. Overall the update gained 34 passes against the published original candidate and 122 against the published product baseline. The 24-pass factual and 10-pass comparison increases restored the published baseline counts. This release reports aggregate results, so sealed case-level transitions and paired significance remain unmeasured for the updated candidate. [Published comparator scores](https://github.com/ahmadalwakai/Mohassan-AI/blob/9fefcb1a7fa6f46d5b13cf61bf20a5c90341d7db/docs/CAPABILITY-V2-BY-BRANCH-2026-11-25.md)

```sh
MOHASSAN_SCRATCH_CLASSIFIERS=1 TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/scratch/mohassan-playwright npm run assistant:capability-bench -- --version 2 --sealed tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output artifacts/agent-capability-bench/v2-frozen-candidate.json > /workspace/scratch/v2-bench-runs/sealed-final.log 2>&1
```

The command exited 0 on 25 November 2026 in 365.523 seconds. The aggregate receipt stayed in the scratch checkout and has SHA-256 `2654186ffa66ff32456e2e53ebb3ab5053997e0b0e9898815dfa1e3b41fa680f`.

## Integration checks

- `npm test -- tests/assistant-scratch-decisions.test.ts tests/assistant-routing-decision.test.ts tests/assistant-local-conversation.test.ts tests/assistant-unsupported-request.test.ts tests/assistant-request-context.test.ts tests/public-conversation-followup.test.ts` passed 213 tests across six suites.
- `python3 -m unittest discover -s packages/scratch-classifiers -p test_prepare_data.py -v` passed 12 tests.
- `(cd packages/scratch-classifiers && python3 -m unittest training.test_linear -v)` passed five tests.
- `npm run typecheck` passed for the root project and web workspace.
