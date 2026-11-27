# Council v2 review benchmark

The development-only benchmark used the same recorded fixtures, scorer, and concurrency for all three arms. Baseline arms used `29448ae`. Head owner used the measured pre-receipt snapshot `7a36efb`. The review commit adds these receipts and focused tests. It also narrows the executor pipeline’s TypeScript type while retaining the same text and status values.

The owner fixture runs each arm against temporary PGlite data and rejects calls outside the recorded fixtures. The real resident v5 checkpoint is unavailable in this environment. The v5 eligibility and publication columns count the observed local fixture turns.

The [JSON receipt](council-v2-review-2026-11-27.json) contains full area, language, and area-by-language pass totals, plus each member’s recorded, graded, and correct totals and accuracy. A member without a gradeable output has null accuracy. The benchmark records eligible council turns even when v5 cannot generate.

## Results

| Split | Arm | Cases passed | Council turns | Changed total (correct / wrong / ungraded) | Council p50 / p95 (ms) | v5 eligible / chosen / published |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| V1 | base-off | 176/240 | 0 | 0 (0 / 0 / 0) | — / — | 0 / 0 / 0 |
| V1 | base-owner | 176/240 | 82 | 0 (0 / 0 / 0) | 52 / 822 | 1 / 0 / 0 |
| V1 | head-owner | 176/240 | 82 | 0 (0 / 0 / 0) | 50 / 573 | 1 / 0 / 0 |
| V2 | base-off | 1,478/2,400 | 0 | 0 (0 / 0 / 0) | — / — | 0 / 0 / 0 |
| V2 | base-owner | 1,478/2,400 | 1,738 | 0 (0 / 0 / 0) | 42 / 855 | 1 / 0 / 0 |
| V2 | head-owner | 1,478/2,400 | 1,738 | 31 (1 / 30 / 0) | 61 / 831 | 1 / 0 / 0 |

Elapsed percentiles use nearest rank over the published council records within each split. Changed replies and member answers use the fixture’s required- and forbidden-content checks when it has a required-content oracle. Case verdicts use the full benchmark scorer.

## Uncertainty replies

| Split | Path | Selected | Correct | Wrong | Ungraded | Case pass | Case fail |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| V1 | Blocked pipeline with pages | 0 | 0 | 0 | 0 | 0 | 0 |
| V1 | Completed pipeline withheld by judge | 0 | 0 | 0 | 0 | 0 | 0 |
| V1 | Empty pipeline | 0 | 0 | 0 | 0 | 0 | 0 |
| V2 | Blocked pipeline with pages | 28 | 1 | 27 | 0 | 0 | 28 |
| V2 | Completed pipeline withheld by judge | 3 | 0 | 3 | 0 | 0 | 3 |
| V2 | Empty pipeline | 0 | 0 | 0 | 0 | 0 | 0 |

The case-pass and case-fail columns count the cases containing each uncertain turn, once per selected turn. Neither baseline arm has an uncertainty decision. The report classifies an empty pipeline before other causes.

## Pass counts by group

### V1 by area

| Area | Base off | Base owner | Head owner |
| --- | ---: | ---: | ---: |
| calculation | 18/18 | 18/18 | 18/18 |
| clarification | 16/16 | 16/16 | 16/16 |
| coding | 0/16 | 0/16 | 0/16 |
| comparison | 11/18 | 11/18 | 11/18 |
| desktop | 11/16 | 11/16 | 11/16 |
| document-file | 16/18 | 16/18 | 16/18 |
| explanation | 8/18 | 8/18 | 8/18 |
| factual | 10/18 | 10/18 | 10/18 |
| follow-up | 18/18 | 18/18 | 18/18 |
| google-ads | 0/16 | 0/16 | 0/16 |
| memory | 16/16 | 16/16 | 16/16 |
| multi-step | 18/18 | 18/18 | 18/18 |
| refusal | 16/16 | 16/16 | 16/16 |
| small-talk | 18/18 | 18/18 | 18/18 |

### V1 by language

| Language | Base off | Base owner | Head owner |
| --- | ---: | ---: | ---: |
| ar | 85/120 | 85/120 | 85/120 |
| en | 91/120 | 91/120 | 91/120 |

### V1 by area and language

| Area and language | Base off | Base owner | Head owner |
| --- | ---: | ---: | ---: |
| calculation/ar | 9/9 | 9/9 | 9/9 |
| calculation/en | 9/9 | 9/9 | 9/9 |
| clarification/ar | 8/8 | 8/8 | 8/8 |
| clarification/en | 8/8 | 8/8 | 8/8 |
| coding/ar | 0/8 | 0/8 | 0/8 |
| coding/en | 0/8 | 0/8 | 0/8 |
| comparison/ar | 5/9 | 5/9 | 5/9 |
| comparison/en | 6/9 | 6/9 | 6/9 |
| desktop/ar | 5/8 | 5/8 | 5/8 |
| desktop/en | 6/8 | 6/8 | 6/8 |
| document-file/ar | 8/9 | 8/9 | 8/9 |
| document-file/en | 8/9 | 8/9 | 8/9 |
| explanation/ar | 4/9 | 4/9 | 4/9 |
| explanation/en | 4/9 | 4/9 | 4/9 |
| factual/ar | 3/9 | 3/9 | 3/9 |
| factual/en | 7/9 | 7/9 | 7/9 |
| follow-up/ar | 9/9 | 9/9 | 9/9 |
| follow-up/en | 9/9 | 9/9 | 9/9 |
| google-ads/ar | 0/8 | 0/8 | 0/8 |
| google-ads/en | 0/8 | 0/8 | 0/8 |
| memory/ar | 8/8 | 8/8 | 8/8 |
| memory/en | 8/8 | 8/8 | 8/8 |
| multi-step/ar | 9/9 | 9/9 | 9/9 |
| multi-step/en | 9/9 | 9/9 | 9/9 |
| refusal/ar | 8/8 | 8/8 | 8/8 |
| refusal/en | 8/8 | 8/8 | 8/8 |
| small-talk/ar | 9/9 | 9/9 | 9/9 |
| small-talk/en | 9/9 | 9/9 | 9/9 |

### V2 by area

| Area | Base off | Base owner | Head owner |
| --- | ---: | ---: | ---: |
| calculation | 5/277 | 5/277 | 5/277 |
| clarification | 9/9 | 9/9 | 9/9 |
| coding | 0/155 | 0/155 | 0/155 |
| comparison | 28/32 | 28/32 | 28/32 |
| factual | 976/1,244 | 976/1,244 | 976/1,244 |
| follow-up | 46/240 | 46/240 | 46/240 |
| refusal | 348/375 | 348/375 | 348/375 |
| small-talk | 66/68 | 66/68 | 66/68 |

### V2 by language

| Language | Base off | Base owner | Head owner |
| --- | ---: | ---: | ---: |
| ar | 982/1,200 | 982/1,200 | 982/1,200 |
| en | 496/1,200 | 496/1,200 | 496/1,200 |

### V2 by area and language

| Area and language | Base off | Base owner | Head owner |
| --- | ---: | ---: | ---: |
| calculation/en | 5/277 | 5/277 | 5/277 |
| clarification/ar | 2/2 | 2/2 | 2/2 |
| clarification/en | 7/7 | 7/7 | 7/7 |
| coding/en | 0/155 | 0/155 | 0/155 |
| comparison/ar | 22/26 | 22/26 | 22/26 |
| comparison/en | 6/6 | 6/6 | 6/6 |
| factual/ar | 818/1,017 | 818/1,017 | 818/1,017 |
| factual/en | 158/227 | 158/227 | 158/227 |
| follow-up/en | 46/240 | 46/240 | 46/240 |
| refusal/ar | 140/155 | 140/155 | 140/155 |
| refusal/en | 208/220 | 208/220 | 208/220 |
| small-talk/en | 66/68 | 66/68 | 66/68 |

## Command

```bash
PLAYWRIGHT_BROWSERS_PATH=/workspace/scratch/council-v2-playwright \
  npm_config_cache=/tmp/council-v2-npm \
  python3 -B scripts/dev-bench/run.py --output /workspace/scratch/council-v2-review-three-arm \
    --arm base-off=29448aea3fa10d226ef82ec5bf0a65e723d6ec39 --set base-off:MOHASSAN_MODEL_COUNCIL=off \
    --arm base-owner=29448aea3fa10d226ef82ec5bf0a65e723d6ec39 --set base-owner:MOHASSAN_MODEL_COUNCIL=owner \
    --arm head-owner=7a36efb506f1deaa9221babf20b591caadb3a3c6 --set head-owner:MOHASSAN_MODEL_COUNCIL=owner \
    --workers 3 --offline
```

The measured snapshot was created locally before the receipts were available. To rerun from the PR, use a fresh output directory and the review commit for `head-owner`.

## Advisory publication timing

The 500 ms advisory wait covers the owner precheck and model deliberation. The tests held the model promise open to measure how long the original result waited before publication.

| Publication path | Baseline (ms) | Stalled advisory (ms) | Added end-to-end time (ms) | Model wait until cancellation (ms) |
| --- | ---: | ---: | ---: | ---: |
| Ads clarification | 79.6 | 550.6 | 471.0 | 500.9 |
| Image reply | 240.6 | 608.9 | 368.2 | 504.2 |
| Executor result | 8 | 503 | 495 | 501.0 |

These local fixture timings include scheduling and publication overhead. The delta uses the unrounded times. A fake-clock test verifies that the owner check and stalled model share one 500 ms deadline.

```bash
npx vitest run --maxWorkers=1 --silent=false --reporter=verbose \
  tests/ads-own-campaign-chat.test.ts tests/assistant-image-messages.test.ts \
  tests/executor-experiment.test.ts -t 'advisory deliberation stalls'
# 3 passed, 27 filtered
```
