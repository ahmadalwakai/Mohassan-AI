# Scratch-trained refusal classifier

The classifier estimates whether request text looks like a supported request, an unavailable operation, or a harmful request. Application policy decides whether a prediction applies to a turn and which refusal to show. Scope labels reflect each dataset's taxonomy and can disagree with the application's capabilities.

## Data

Each download is pinned by revision and SHA-256 in [train.py](train.py). The downloaded prompts stay in the cache. The runtime artifact contains numeric coefficients, with no embedded examples.

| Corpus | Verified license and attribution | Included material |
| --- | --- | --- |
| CLINC150 | CC BY 3.0 Unported. Stefan Larson et al., *An Evaluation Dataset for Intent Classification and Out-of-Scope Prediction*. [Publisher's license](https://github.com/clinc/oos-eval/blob/828f8093932c8fe6ca7936c3d2e52903b1c523de/LICENSE) · [Paper](https://aclanthology.org/D19-1131/) | Human crowdsourced English utterances, including native out-of-scope examples and selected in-scope intent labels mapped to supported requests or unavailable operations. |
| Aya Red-teaming | Apache 2.0. Aakanksha et al. and Cohere Labs. [Publisher's card and license](https://huggingface.co/datasets/CohereLabs/aya_redteaming/blob/5a16fee03c19d681b4f3527b6a750e1ed4d434c7/README.md) · [Paper](https://arxiv.org/abs/2406.18682) | Original human-authored Arabic and English `prompt` values with human harm annotations. The filter retains globally harmful harassment, hate, non-consensual sexual content, and violent threat or incitement categories and excludes self-harm. |
| MASSIVE v1.0 Arabic | CC BY 4.0 International. Jack FitzGerald et al., © Amazon.com, Inc. or its affiliates. Underlying SLURP text by Emanuele Bastianelli et al. [Publisher's data notice](https://github.com/alexa/massive/blob/f966f21846043aabef9b0f974fa7970027f43738/NOTICE.md) · [Paper](https://aclanthology.org/2023.acl-long.235/) · [SLURP license](https://github.com/pswietojanski/slurp/blob/master/LICENSE.txt) | Human-localized Arabic requests with selected supported intents. This slice supplies allowed Arabic examples for training, calibration and testing. |

CLINC150 and MASSIVE keep their official train and test splits. The seeded hash of the normalized CLINC utterance or MASSIVE record ID divides the original validation set into development and calibration. Aya publishes language partitions. The seeded hash of the normalized original prompt assigns 70% to train, 10% to development, 10% to calibration and 10% to test. When a normalized prompt appears across splits, its most held-out occurrence takes precedence. Conflicting mapped labels are excluded. The model uses 6,333 training, 733 development, 625 calibration and 2,684 test examples after mapping and deduplication.

## Training and evaluation

Training fits multinomial logistic regression from zero using class-frequency weighting, L2 regularization, and hashed word 1–2-grams and character 2–5-grams. Development macro-F1 selects the L2 penalty. Calibration fits a softmax temperature and chooses the lowest threshold from 0.80 upward with at least 10 accepted examples and 95% empirical precision for each positive class. Both exported thresholds are 0.80. The artifact stores signed little-endian 16-bit weights and runs locally in Node.

Public held-out results for the thresholded model use the same quantized coefficients as Node. Precision counts correct refusal decisions divided by all refusal decisions. Recall counts correct refusals divided by all labelled refusals. Over-refusal counts refused allowed examples divided by all allowed examples.

| Test slice | Refusal precision | Refusal recall | Allowed over-refusal |
| --- | ---: | ---: | ---: |
| CLINC150 mapped | 496/496 (100%) | 496/1,330 (37.29%) | 0/540 (0%) |
| CLINC150 native OOS and mapped allowed | 192/192 (100%) | 192/1,000 (19.20%) | 0/540 (0%) |
| Aya English | 23/23 (positive-only) | 23/32 (71.88%) | N/A |
| Aya Arabic | 43/43 (positive-only) | 43/58 (74.14%) | N/A |
| Aya pooled | 66/66 (positive-only) | 66/90 (73.33%) | N/A |
| MASSIVE Arabic allowed | 0/1 | N/A | 1/724 (0.14%) |
| All mapped test rows | 562/563 (99.82%) | 562/1,420 (39.58%) | 1/1,264 (0.08%) |

Aya's selected slice can measure recall. The pooled row counts its positives alongside the CLINC150 and MASSIVE negatives for a mixed-population precision estimate. Native CLINC150 OOS remains difficult, with 19.20% recall at the runtime threshold and 54.90% under argmax. Some CLINC150 source intents mix a prohibited effect with an allowed lookup about the same subject. The application uses its capability assessment to constrain scope predictions.

The integrated policy uses the learned score for unmatched operations with unresolved sources. Supported document actions, explanatory requests and requests that need a reference keep their existing handling. These results run the standalone application classifier with full-access user context and default capability information, before routing or dispatch. The baseline is the original refusal policy at `d49ae71`.

| Test slice | Refusal precision before → after | Refusal recall before → after | Allowed over-refusal before → after |
| --- | ---: | ---: | ---: |
| CLINC150 mapped | 119/120 → 143/144 | 119/1,330 → 143/1,330 | 1/540 → 1/540 |
| CLINC150 native OOS and mapped allowed | 13/14 → 25/26 | 13/1,000 → 25/1,000 | 1/540 → 1/540 |
| Aya English | N/A → 9/9 | 0/32 → 9/32 | N/A |
| Aya Arabic | N/A → 7/7 | 0/58 → 7/58 | N/A |
| Aya pooled | N/A → 16/16 | 0/90 → 16/90 | N/A |
| MASSIVE Arabic allowed | 0/2 → 0/3 | N/A | 2/724 → 3/724 |
| All mapped test rows | 119/122 → 159/163 | 119/1,420 → 159/1,420 | 3/1,264 → 4/1,264 |

## Reproduce

The trainer was run with Python 3.12.14 and the pinned NumPy and SciPy versions. Install them into an isolated Python environment when unavailable. Run from the repository root with a scratch directory outside the source tree.

```sh
python3 -m pip install -r scripts/refusal-classifier/requirements.txt
python3 scripts/refusal-classifier/train.py \
  --cache /tmp/refusal-classifier-data \
  --model apps/server/src/assistant/refusal/learned-model.json \
  --metrics /tmp/refusal-classifier-data/model-test-metrics.json \
  --test-rows /tmp/refusal-classifier-data/test-rows.jsonl
node --import tsx scripts/refusal-classifier/evaluate-policy.ts /tmp/refusal-classifier-data/test-rows.jsonl
```

The generated model SHA-256 is `b655e0cb5f4785bfe1b6ff9d873cfece9b1f4c3dba50a7ba2fd74657cdd4dfb7`. Two runs in the same environment produced identical model and metrics bytes. The final command reports standalone application classification with a full-access user in addition to the model metrics from training. The optional JSONL has public red-team prompts. Keep it in the scratch directory.
