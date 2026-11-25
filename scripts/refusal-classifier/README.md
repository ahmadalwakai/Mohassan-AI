# Scratch-trained refusal classifier

The classifier estimates whether request text looks like a supported request, an unavailable operation, or a harmful request. Application policy decides whether a prediction applies to a turn and which refusal to show. Scope labels reflect each dataset's taxonomy and can disagree with the application's capabilities.

## Data

Each download is pinned by revision and SHA-256 in [train.py](train.py). The downloaded prompts stay in the cache. The runtime artifact contains numeric coefficients, with no embedded examples.

| Corpus | Verified license and attribution | Included material |
| --- | --- | --- |
| CLINC150 | CC BY 3.0 Unported. Stefan Larson et al., *An Evaluation Dataset for Intent Classification and Out-of-Scope Prediction*. [Publisher's license](https://github.com/clinc/oos-eval/blob/828f8093932c8fe6ca7936c3d2e52903b1c523de/LICENSE) · [Paper](https://aclanthology.org/D19-1131/) | Human crowdsourced English utterances, including native out-of-scope examples and selected in-scope intent labels mapped to supported requests or unavailable operations. |
| Aya Red-teaming | Apache 2.0. Aakanksha et al. and Cohere Labs. [Publisher's card and license](https://huggingface.co/datasets/CohereLabs/aya_redteaming/blob/5a16fee03c19d681b4f3527b6a750e1ed4d434c7/README.md) · [Paper](https://arxiv.org/abs/2406.18682) | Original human-authored Arabic and English `prompt` values with human harm annotations. The filter retains globally harmful harassment, hate, non-consensual sexual content, and violent threat or incitement categories and excludes self-harm. |
| MASSIVE v1.0 Arabic | CC BY 4.0 International. Jack FitzGerald et al., © Amazon.com, Inc. or its affiliates. Underlying SLURP text by Emanuele Bastianelli et al. [Publisher's data notice](https://github.com/alexa/massive/blob/f966f21846043aabef9b0f974fa7970027f43738/NOTICE.md) · [Paper](https://aclanthology.org/2023.acl-long.235/) · [SLURP license](https://github.com/pswietojanski/slurp/blob/master/LICENSE.txt) | Human-localized Arabic requests with selected supported intents. This slice supplies allowed Arabic examples for training, calibration and testing. |

At native source ingestion, the trainer checks raw input text and the original source ID against both published capability v2 exclusion partitions. It preserves CLINC150's exact native split and zero-based index, MASSIVE's locale and record ID, and Aya's language and original JSONL index. Exclusion runs before split assignment and deduplication. The published loader verifies both exclusion files at startup and training stops if the registry is missing or invalid. The metrics receipt records the manifest SHA-256 and counts of excluded eligible rows by source and native partition. [Contamination audit](https://github.com/ahmadalwakai/Mohassan-AI/pull/70)

CLINC150 and MASSIVE keep their official train and test splits. The seeded hash of the normalized CLINC utterance or MASSIVE record ID divides the original validation set into development and calibration. Aya publishes language partitions. The seeded hash of the normalized original prompt assigns 70% to train, 10% to development, 10% to calibration and 10% to test. When a normalized prompt appears across splits, its most held-out occurrence takes precedence. Conflicting mapped labels are excluded. The pinned registry excluded 213 eligible input rows from native test splits. After filtering and deduplication, the model uses 6,338 training, 733 development, 626 calibration and 2,471 test examples.

## Training and evaluation

Training fits multinomial logistic regression from zero using class-frequency weighting, L2 regularization, and hashed word 1–2-grams and character 2–5-grams. Development macro-F1 selects the L2 penalty. Calibration fits a softmax temperature and chooses the lowest threshold from 0.80 upward with at least 10 accepted examples and 95% empirical precision for each positive class. Both exported thresholds are 0.80. The artifact stores signed little-endian 16-bit weights and runs locally in Node.

Public held-out results for the thresholded model use the same quantized coefficients as Node. Precision counts correct refusal decisions divided by all refusal decisions. Recall counts correct refusals divided by all labelled refusals. Over-refusal counts refused allowed examples divided by all allowed examples.

| Test slice | Refusal precision | Refusal recall | Allowed over-refusal |
| --- | ---: | ---: | ---: |
| CLINC150 mapped | 413/413 (100%) | 413/1,239 (33.33%) | 0/422 (0%) |
| CLINC150 native OOS and mapped allowed | 177/177 (100%) | 177/988 (17.91%) | 0/422 (0%) |
| Aya English | 21/21 (positive-only) | 21/32 (65.63%) | N/A |
| Aya Arabic | 43/43 (positive-only) | 43/58 (74.14%) | N/A |
| Aya pooled | 64/64 (positive-only) | 64/90 (71.11%) | N/A |
| MASSIVE Arabic allowed | 0/1 | N/A | 1/720 (0.14%) |
| All mapped test rows | 477/478 (99.79%) | 477/1,329 (35.89%) | 1/1,142 (0.09%) |

Aya's selected slice can measure recall. The pooled row counts its positives alongside the CLINC150 and MASSIVE negatives for a mixed-population precision estimate. Some CLINC150 source intents mix a prohibited effect with an allowed lookup about the same subject. The application uses its capability assessment to constrain scope predictions.

The integrated policy uses the learned score for unmatched operations with unresolved sources. Supported document actions, explanatory requests and requests that need a reference keep their existing handling. These results run the standalone application classifier with full-access user context and default capability information. The prior model at `f1ea533` and the retrained model were both evaluated on the same filtered test rows.

| Test slice | Refusal precision before → after | Refusal recall before → after | Allowed over-refusal before → after |
| --- | ---: | ---: | ---: |
| CLINC150 mapped | 70/70 → 70/70 | 70/1,239 → 70/1,239 | 0/422 → 0/422 |
| CLINC150 native OOS and mapped allowed | 20/20 → 20/20 | 20/988 → 20/988 | 0/422 → 0/422 |
| Aya English | 9/9 → 8/8 | 9/32 → 8/32 | N/A |
| Aya Arabic | 7/7 → 7/7 | 7/58 → 7/58 | N/A |
| Aya pooled | 16/16 → 15/15 | 16/90 → 15/90 | N/A |
| MASSIVE Arabic allowed | 0/3 → 0/3 | N/A | 3/720 → 3/720 |
| All mapped test rows | 86/89 → 85/88 | 86/1,329 → 85/1,329 | 3/1,142 → 3/1,142 |

## Reproduce

The trainer was run with Python 3.12.14 and the pinned NumPy and SciPy versions. Install them into an isolated Python environment when unavailable. Run from the repository root with a scratch directory outside the source tree. If the published filter is already in the checkout, omit `--exclusion-root`. To reproduce this run from the refusal branch, export just the library and hash registry from PR #70.

```sh
python3 -m pip install -r scripts/refusal-classifier/requirements.txt
git fetch origin refs/heads/test/v2-contamination-audit
mkdir -p /tmp/capability-v2-exclusions
git archive a1e1cb020b7ba093885edbf501149e7b8252c0cb \
  scripts/agent-capability-bench/v2/exclusion.py \
  tests/fixtures/agent-capability-bench/v2/exclusion | tar -x -C /tmp/capability-v2-exclusions
python3 -B scripts/refusal-classifier/train.py \
  --cache /tmp/refusal-classifier-data \
  --exclusion-root /tmp/capability-v2-exclusions \
  --model apps/server/src/assistant/refusal/learned-model.json \
  --metrics /tmp/refusal-classifier-data/model-test-metrics.json \
  --test-rows /tmp/refusal-classifier-data/test-rows.jsonl
node --import tsx scripts/refusal-classifier/evaluate-policy.ts /tmp/refusal-classifier-data/test-rows.jsonl
```

The exclusion manifest SHA-256 is `de192bdc7203e1aa24fa06b216d3976f4ea77ec103e085a4019af7a60c2f3054`. The generated model SHA-256 is `e79b38d5d57bcb945dd9290627b3e6813a8a2d7924d73495c3c3649c11ab25bf`. Two runs produced identical model, metrics and test-export bytes. The final command reports standalone application classification with a full-access user. The optional JSONL has public red-team prompts and native source provenance. Keep it in the scratch directory.
