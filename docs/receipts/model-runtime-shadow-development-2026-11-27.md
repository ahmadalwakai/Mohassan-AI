# Model runtime shadow development benchmark

The pinned harness measured `29448aea3fa10d226ef82ec5bf0a65e723d6ec39` and local candidate `5391ea2d55572861cc7e56620ad6a5454f8a7700` with `MOHASSAN_MODEL_RELATIONS=shadow` in both arms. The run used the development split and 8 V2 workers in the repository Docker image with networking disabled and a four-CPU cap. Both arms used the existing unmeasured budgets. A single commit publishes the candidate tree plus these two receipts. The measured candidate tree is `632ffde776fd9495644856cf260a4a09a7883b9d`. [Aggregate JSON receipt](model-runtime-shadow-development-2026-11-27.json) · [Pinned development harness](../../scripts/dev-bench/README.md)

The aggregate JSON SHA-256 is `e13648fa0d4b280f9a3194dbc82e4783bc2386bdf20b97b305c4b734cc714560`. It records the native receipt and shadow log hashes, input digests, flags and toolchain. The underlying development replies and JSONL journals are retained in the local benchmark output.

### Paired development benchmark

Both arms used shadow mode and the same V2 worker count (8). The receipts record the exact measured commits.

Timings show p50 / p95 in milliseconds. End-to-end timing uses each scored turn with a recorded latency. Publication and background timings use the shadow journal.

| Arm | Split | Passed cases | Timed turns | Shadow rows | End-to-end | Publication | Shadow background |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| base | V1 | 176/240 | 279/279 | 279 | 45.317 / 330.140 | 0.026 / 0.177 | 0.381 / 6.156 |
| base | V2 | 1,586/2,400 | 2,400/2,400 | 2,400 | 106.746 / 1197.072 | 0.036 / 0.142 | 1.181 / 71.437 |
| head | V1 | 176/240 | 279/279 | 279 | 49.684 / 342.032 | 0.036 / 0.190 | 119.919 / 869.048 |
| head | V2 | 1,586/2,400 | 2,400/2,400 | 2,400 | 118.517 / 1215.907 | 0.041 / 0.178 | 74.360 / 323.345 |

V1 and V2 combined. Each cell shows considered / compared / disagreements / busy / timeout.

| Model | Base | Head |
| --- | ---: | ---: |
| `arithmetic` | 272 / 0 / 0 / 235 / 7 | 272 / 0 / 0 / 0 / 25 |
| `head-answer-sentence` | 368 / 0 / 0 / 268 / 0 | 368 / 0 / 0 / 0 / 0 |
| `head-sufficiency` | 1,251 / 0 / 0 / 1,071 / 0 | 1,251 / 0 / 0 / 0 / 0 |
| `question-edit` | 2 / 0 / 0 / 2 / 0 | 2 / 0 / 0 / 0 / 0 |
| `refusal` | 2,679 / 492 / 228 / 2,127 / 0 | 2,679 / 2,260 / 739 / 0 / 19 |
| `router-b0` | 2,679 / 0 / 0 / 2,127 / 0 | 2,679 / 0 / 0 / 0 / 49 |
| `router-b2` | 2,679 / 0 / 0 / 2,127 / 0 | 2,679 / 0 / 0 / 0 / 171 |
| `scratch-follow-up` | 24 / 1 / 0 / 21 / 0 | 24 / 1 / 0 / 0 / 21 |
| `scratch-refusal` | 2,679 / 266 / 223 / 2,127 / 2 | 2,679 / 1,091 / 726 / 0 / 313 |
| `scratch-route` | 2,679 / 305 / 192 / 2,127 / 0 | 2,679 / 1,269 / 672 / 0 / 522 |
| `scratch-speech-act` | 2,679 / 551 / 3 / 2,127 / 1 | 2,679 / 2,471 / 9 / 0 / 197 |

| Head refusal language | Considered | Compared | Disagreements | Busy | Timeout |
| --- | ---: | ---: | ---: | ---: | ---: |
| `ar` | 1,179 | 1,142 | 116 | 0 | 8 |
| `en` | 1,326 | 975 | 580 | 0 | 11 |
| `mixed` | 174 | 143 | 43 | 0 | 0 |

The historical refusal run recorded 489/2,679 comparable, with 2,130 busy. This run recorded 492/2,679 comparable, with 2,127 busy in base and 2,260/2,679 comparable, with 0 busy in head. [Historical reference](https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/docs/MODEL-RELATIONS-VERIFICATION.md#L115-L135)

Summed across the model rows, `busy` fell from 14,359 to 0 and `timeout` rose from 10 to 1,317. The candidate also recorded a higher shadow background p95 on both splits. Both scored pass totals held.

## Model counts per split

Each cell shows considered / compared / disagreements / busy / timeout. A dash indicates that the arm recorded no calls for that model.

| Split | Model | Base | Head |
| --- | ---: | ---: | ---: |
| V1 | `arithmetic` | 39 / 0 / 0 / 38 / 0 | 39 / 0 / 0 / 0 / 0 |
| V1 | `head-answer-sentence` | 50 / 0 / 0 / 49 / 0 | 50 / 0 / 0 / 0 / 0 |
| V1 | `head-sufficiency` | 58 / 0 / 0 / 56 / 0 | 58 / 0 / 0 / 0 / 0 |
| V1 | `question-edit` | 2 / 0 / 0 / 2 / 0 | 2 / 0 / 0 / 0 / 0 |
| V1 | `refusal` | 279 / 19 / 4 / 250 / 0 | 279 / 195 / 28 / 0 / 0 |
| V1 | `router-b0` | 279 / 0 / 0 / 250 / 0 | 279 / 0 / 0 / 0 / 6 |
| V1 | `router-b2` | 279 / 0 / 0 / 250 / 0 | 279 / 0 / 0 / 0 / 100 |
| V1 | `scratch-follow-up` | 23 / 1 / 0 / 21 / 0 | 23 / 1 / 0 / 0 / 20 |
| V1 | `scratch-refusal` | 279 / 6 / 3 / 250 / 0 | 279 / 66 / 27 / 0 / 0 |
| V1 | `scratch-route` | 279 / 17 / 15 / 250 / 0 | 279 / 79 / 62 / 0 / 140 |
| V1 | `scratch-speech-act` | 279 / 29 / 2 / 250 / 0 | 279 / 275 / 7 / 0 / 0 |
| V2 | `arithmetic` | 233 / 0 / 0 / 197 / 7 | 233 / 0 / 0 / 0 / 25 |
| V2 | `head-answer-sentence` | 318 / 0 / 0 / 219 / 0 | 318 / 0 / 0 / 0 / 0 |
| V2 | `head-sufficiency` | 1,193 / 0 / 0 / 1,015 / 0 | 1,193 / 0 / 0 / 0 / 0 |
| V2 | `refusal` | 2,400 / 473 / 224 / 1,877 / 0 | 2,400 / 2,065 / 711 / 0 / 19 |
| V2 | `router-b0` | 2,400 / 0 / 0 / 1,877 / 0 | 2,400 / 0 / 0 / 0 / 43 |
| V2 | `router-b2` | 2,400 / 0 / 0 / 1,877 / 0 | 2,400 / 0 / 0 / 0 / 71 |
| V2 | `scratch-follow-up` | 1 / 0 / 0 / 0 / 0 | 1 / 0 / 0 / 0 / 1 |
| V2 | `scratch-refusal` | 2,400 / 260 / 220 / 1,877 / 2 | 2,400 / 1,025 / 699 / 0 / 313 |
| V2 | `scratch-route` | 2,400 / 288 / 177 / 1,877 / 0 | 2,400 / 1,190 / 610 / 0 / 382 |
| V2 | `scratch-speech-act` | 2,400 / 522 / 1 / 1,877 / 1 | 2,400 / 2,196 / 2 / 0 / 197 |

## Head model counts by turn language

These rows combine V1 and V2. The JSON receipt also contains per-split language rows and denominators for every observed outcome.

| Model | Language | Considered | Compared | Disagreements | Busy | Timeout |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `arithmetic` | `ar` | 18 | 0 | 0 | 0 | 0 |
| `arithmetic` | `en` | 251 | 0 | 0 | 0 | 25 |
| `arithmetic` | `mixed` | 3 | 0 | 0 | 0 | 0 |
| `head-answer-sentence` | `ar` | 240 | 0 | 0 | 0 | 0 |
| `head-answer-sentence` | `en` | 116 | 0 | 0 | 0 | 0 |
| `head-answer-sentence` | `mixed` | 12 | 0 | 0 | 0 | 0 |
| `head-sufficiency` | `ar` | 936 | 0 | 0 | 0 | 0 |
| `head-sufficiency` | `en` | 245 | 0 | 0 | 0 | 0 |
| `head-sufficiency` | `mixed` | 70 | 0 | 0 | 0 | 0 |
| `question-edit` | `en` | 2 | 0 | 0 | 0 | 0 |
| `refusal` | `ar` | 1,179 | 1,142 | 116 | 0 | 8 |
| `refusal` | `en` | 1,326 | 975 | 580 | 0 | 11 |
| `refusal` | `mixed` | 174 | 143 | 43 | 0 | 0 |
| `router-b0` | `ar` | 1,179 | 0 | 0 | 0 | 26 |
| `router-b0` | `en` | 1,326 | 0 | 0 | 0 | 21 |
| `router-b0` | `mixed` | 174 | 0 | 0 | 0 | 2 |
| `router-b2` | `ar` | 1,179 | 0 | 0 | 0 | 62 |
| `router-b2` | `en` | 1,326 | 0 | 0 | 0 | 82 |
| `router-b2` | `mixed` | 174 | 0 | 0 | 0 | 27 |
| `scratch-follow-up` | `ar` | 8 | 0 | 0 | 0 | 8 |
| `scratch-follow-up` | `en` | 12 | 1 | 0 | 0 | 10 |
| `scratch-follow-up` | `mixed` | 4 | 0 | 0 | 0 | 3 |
| `scratch-refusal` | `ar` | 1,179 | 273 | 191 | 0 | 151 |
| `scratch-refusal` | `en` | 1,326 | 756 | 508 | 0 | 144 |
| `scratch-refusal` | `mixed` | 174 | 62 | 27 | 0 | 18 |
| `scratch-route` | `ar` | 1,179 | 461 | 221 | 0 | 240 |
| `scratch-route` | `en` | 1,326 | 724 | 403 | 0 | 234 |
| `scratch-route` | `mixed` | 174 | 84 | 48 | 0 | 48 |
| `scratch-speech-act` | `ar` | 1,179 | 1,079 | 5 | 0 | 98 |
| `scratch-speech-act` | `en` | 1,326 | 1,229 | 3 | 0 | 88 |
| `scratch-speech-act` | `mixed` | 174 | 163 | 1 | 0 | 11 |

## Commands

The benchmark ran in the pinned Docker image with `--network none` and `--cpus 4`. The four summary commands ran in the branch checkout.

```sh
python3 -B scripts/dev-bench/run.py --offline \
  --output /workspace/work/model-runtime-measurement/paired-shadow-dev \
  --arm base=29448aea3fa10d226ef82ec5bf0a65e723d6ec39 \
  --arm head=5391ea2d55572861cc7e56620ad6a5454f8a7700 \
  --set base:MOHASSAN_MODEL_RELATIONS=shadow \
  --set head:MOHASSAN_MODEL_RELATIONS=shadow \
  --set base:TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3.12 \
  --set head:TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3.12 \
  --workers 8
```

```sh
npm run -s models:shadow-summary -- /workspace/work/model-runtime-measurement/paired-shadow-dev/base/v1-shadow.jsonl
npm run -s models:shadow-summary -- /workspace/work/model-runtime-measurement/paired-shadow-dev/base/v2-shadow.jsonl
npm run -s models:shadow-summary -- /workspace/work/model-runtime-measurement/paired-shadow-dev/head/v1-shadow.jsonl
npm run -s models:shadow-summary -- /workspace/work/model-runtime-measurement/paired-shadow-dev/head/v2-shadow.jsonl
```
