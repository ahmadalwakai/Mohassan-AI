# Capability v2 exclusion retraining

The 25 November 2026 training run compared the new exports against the original weights from commit `76b1a9325a5ef4edda84816cc6523aa06026121e`. Both guarded runs fit from zero with seed `20261125` in Python 3.12.14, NumPy 2.3.5 and SciPy 1.17.0.

The published exclusion registry blocked **6,281 native rows** before preparation deduplication. The resulting public data contained 64,595 rows. The registry manifest SHA-256 was `de192bdc7203e1aa24fa06b216d3976f4ea77ec103e085a4019af7a60c2f3054` and the guarded JSONL SHA-256 was `c294972463e9329fc88f99d05eb858681c73472c523bb5142376ff260f981929`. [Training receipt](models/metrics.json) · [Data provenance](DATA-CARD.md)

| Source | Blocked native rows by partition | Total |
| --- | --- | ---: |
| canard | `dev` 441, `test` 1,182, `train` 3,294 | 4,917 |
| clinc150 | `oos_test` 12, `test` 246 | 258 |
| massive-ar-SA | `dev` 9, `test` 520, `train` 52 | 581 |
| massive-en-US | `test` 521, `train` 4 | 525 |

## Public dataset test results

The exclusion changes the test population. The original metric columns show the previous model on the original test population. The guarded comparisons score both models on exactly the same test rows. Rates are percentages and changes in parentheses are percentage points calculated before rounding. ECE is expected calibration error, where lower is better.

| Head | Original → guarded rows | Original macro-F1 | Original ECE | Guarded macro-F1 | Guarded ECE | Guarded coverage | Guarded accepted accuracy |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Refusal and scope | 5,567 → 4,690 | 86.52 | 9.38 | 84.65 → 84.68 (+0.03) | 11.49 → 11.48 (-0.01) | 85.76 → 85.91 (+0.15) | 84.39 → 84.26 (-0.12) |
| Speech act | 6,489 → 5,403 | 97.43 | 0.15 | 94.82 → 94.82 (+0.00) | 0.23 → 0.23 (+0.01) | 99.50 → 99.54 (+0.04) | 99.91 → 99.91 (+0.00) |
| Route | 4,477 → 3,612 | 93.21 | 1.21 | 92.45 → 92.35 (-0.09) | 1.18 → 1.16 (-0.03) | 90.42 → 90.42 (+0.00) | 98.59 → 98.62 (+0.03) |
| Follow-up | 4,728 → 3,588 | 61.98 | 3.50 | 61.75 → 62.71 (+0.96) | 4.42 → 4.61 (+0.18) | 86.62 → 86.48 (-0.14) | 95.75 → 95.68 (-0.07) |

Macro-F1 counts the top label even when the model abstains. Coverage counts predictions meeting the model’s threshold. Accepted accuracy uses only those predictions. The per-dataset rows also compare both models on the same guarded test rows. Only classes with true support are listed in the recall column. [Full guarded test metrics](models/metrics.json)

| Head | Dataset | Rows | Macro-F1 | ECE | Per-class recall after retraining (change) |
| --- | --- | ---: | ---: | ---: | --- |
| Refusal and scope | arbanking77-pal | 894 | 99.55 → 99.55 (+0.00) | 2.64 → 2.71 (+0.07) | `out_of_scope` 99.11 (+0.00) |
| Refusal and scope | aya-arb | 60 | 96.55 → 96.55 (+0.00) | 6.13 → 6.07 (-0.06) | `refuse` 93.33 (+0.00) |
| Refusal and scope | aya-eng | 32 | 100.00 → 100.00 (+0.00) | 9.09 → 9.04 (-0.05) | `refuse` 100.00 (+0.00) |
| Refusal and scope | clinc150 | 1,719 | 52.54 → 52.60 (+0.06) | 36.59 → 36.61 (+0.02) | `allow` 98.76 (+0.00), `out_of_scope` 34.60 (+0.08) |
| Refusal and scope | massive-ar-SA | 982 | 93.11 → 93.30 (+0.19) | 4.90 → 4.75 (-0.15) | `allow` 97.41 (+0.00), `out_of_scope` 90.00 (+0.59) |
| Refusal and scope | massive-en-US | 1,003 | 94.96 → 94.96 (+0.00) | 3.73 → 3.67 (-0.06) | `allow` 97.22 (+0.00), `out_of_scope` 95.45 (+0.00) |
| Speech act | arbanking77-pal | 894 | 100.00 → 100.00 (+0.00) | 0.03 → 0.03 (+0.00) | `request` 100.00 (+0.00) |
| Speech act | clinc150 | 733 | 96.37 → 96.37 (+0.00) | 0.72 → 0.79 (+0.07) | `request` 99.70 (+0.00), `smalltalk` 90.32 (+0.00) |
| Speech act | massive-ar-SA | 1,873 | 49.99 → 49.99 (+0.00) | 0.20 → 0.19 (0.00) | `request` 100.00 (+0.00), `smalltalk` 0.00 (+0.00) |
| Speech act | massive-en-US | 1,903 | 66.61 → 66.61 (+0.00) | 0.38 → 0.39 (+0.01) | `request` 99.79 (+0.00), `smalltalk` 100.00 (+0.00) |
| Route | arbanking77-pal | 894 | 99.83 → 99.83 (+0.00) | 1.12 → 1.11 (-0.01) | `unsupported` 99.66 (+0.00) |
| Route | clinc150 | 733 | 95.16 → 95.00 (-0.16) | 1.86 → 1.54 (-0.32) | `chat` 90.32 (+0.00), `compute` 96.67 (+0.00), `reminder` 95.00 (+0.00), `unsupported` 96.41 (+0.00), `web_search` 99.00 (-0.33), `writing` 80.00 (+0.00) |
| Route | massive-ar-SA | 982 | 77.14 → 77.21 (+0.07) | 3.33 → 3.15 (-0.19) | `chat` 0.00 (+0.00), `compute` 80.56 (+0.00), `news` 86.29 (+0.00), `reminder` 98.94 (+0.00), `unsupported` 92.94 (+0.59), `web_search` 96.23 (+0.00) |
| Route | massive-en-US | 1,003 | 80.63 → 80.63 (+0.00) | 1.06 → 1.25 (+0.19) | `chat` 100.00 (+0.00), `compute` 83.33 (+0.00), `news` 82.26 (+0.00), `reminder` 98.96 (+0.00), `unsupported` 96.59 (+0.00), `web_search` 95.26 (+0.00) |
| Follow-up | canard | 3,588 | 61.75 → 62.71 (+0.96) | 4.42 → 4.61 (+0.18) | `follow_up` 98.33 (-0.12), `new` 20.68 (+1.70) |

The follow-up head’s new-request recall rose from 18.98% to 20.68% on the same 353 requests. The Arabic and English MASSIVE test sets each retained one annotated small-talk example, so their small-talk recall remains sensitive to a single item.

## Reproducibility checks

These commands ran from the repository root. The first command prepared source data internally. The second and third commands prepared a separate JSONL and companion receipt before training. The training commands and directory comparison exited 0. All seven exported files matched byte for byte.

```sh
python3 packages/scratch-classifiers/train.py --cache /workspace/scratch/classifier-sources --output /workspace/scratch/scratch-classifiers-v2/first
python3 packages/scratch-classifiers/prepare_data.py --cache /workspace/scratch/classifier-sources --output /workspace/scratch/scratch-classifiers-v2/guarded.jsonl
python3 packages/scratch-classifiers/train.py --data /workspace/scratch/scratch-classifiers-v2/guarded.jsonl --output /workspace/scratch/scratch-classifiers-v2/repeat
diff -rq /workspace/scratch/scratch-classifiers-v2/first /workspace/scratch/scratch-classifiers-v2/repeat
npm test -- --reporter=verbose --silent=false packages/scratch-classifiers/src/index.test.ts packages/scratch-classifiers/src/features.test.ts
npm run typecheck
```

All 12 TypeScript feature, artifact and parity tests passed. Warm all-head p95 inference was 0.145 ms on mixed inputs and 1.035 ms on bounded long inputs, with 300 messages per sample. Root and web typecheck passed.
