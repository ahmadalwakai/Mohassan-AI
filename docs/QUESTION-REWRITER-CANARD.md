# CANARD data card

CANARD pairs QuAC dialogue context and questions with standalone rewrites written by crowd workers. Ahmed Elgohary, Denis Peskov, and Jordan Boyd-Graber released it under CC BY-SA 4.0. The original dialogues come from QuAC by Eunsol Choi and coauthors, with source passages by Wikipedia contributors. Preparation uses the official `train.json` and `dev.json` members distributed by the University of Maryland. The local filtered copies remove complete rows and preserve the original fields of retained rows. The same CC BY-SA 4.0 license applies to redistribution of those copies. [Dataset release](https://doi.org/10.13016/zcop-ns5d) · [CANARD paper](https://aclanthology.org/D19-1605/) · [QuAC](https://quac.ai/) · [License](https://creativecommons.org/licenses/by-sa/4.0/)

The exclusion step checks the native CANARD identifier, the titles and dialogue utterances, the current question, and the reference with and without terminal punctuation. It applies the v2 exclusion registry to each upstream split before deduplication, fitting, tuning or evaluation. After screening, training preparation keeps the first occurrence of each full normalized history and current question and removes any training input identical to a screened development input. The splits have no QuAC dialogues in common. Each retained development row keeps its original evaluation weight, including first questions and unchanged rewrites. The official test member was never opened.

| Source | Input | Excluded by PR #70 | Training duplicates removed | Development overlaps removed from training | Retained |
| --- | ---: | ---: | ---: | ---: | ---: |
| Official CANARD `train.json` | 31,526 | 6,353 | 19 | 5 | 25,149 |
| Official CANARD `dev.json` | 3,430 | 831 | — | — | 2,599 |

- SHA-256 of `train.json` is `5877563d4258cf40d660cf2ff65935bf1d15573c7cd98e717ca86a0a6d457ed5`.
- SHA-256 of `dev.json` is `fafd9f53be0684fd33f85f6bf12a63e61b835ecb9e987c9bd2186149366ce2e5`.
- SHA-256 of the v2 exclusion manifest is `de192bdc7203e1aa24fa06b216d3976f4ea77ec103e085a4019af7a60c2f3054`.
- SHA-256 of the prepared `train-clean.json` is `6f6e2db0c4502ab2be29d182d330708b592ae49c1f96616ccb37e193736d1653`.

## Learned edit ranker

The ranker chooses among bounded edits of the current question. The candidates keep or remove existing words, copy spans from the titles and recent turns, and apply small grammatical edits such as adding possessive punctuation. The model scores these candidates with numeric weights over hashed local word and edit features. It starts at zero and fits only on screened, deduplicated training rows. A training row supplies a target when its human rewrite is reachable by an exact or punctuation-normalized candidate. The trainer quantizes each checkpoint and selects its epoch, abstention margin, and combination order on screened CANARD dev by normalized substring count, then exact count.

The learned weights in `apps/server/src/assistant/question-edit-weights.ts` are distributed under CC BY-SA 4.0 with the CANARD, QuAC, and Wikipedia attribution above. The runtime loads the weights and abstention margin from the artifact. V2 development separately compares the two runtime orders with those values fixed. The product uses the rules first because that order preserved all 46 existing follow-up passes. Arabic continues through the existing rules. [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)

## Reproduce the training and evaluation

From the feature checkout, use a fresh scratch directory for the official members and filtered output. Set `AUDIT_ROOT` to the local scratch checkout containing the PR #70 exclusion filter and all three registry files.

```sh
canard_work=$(mktemp -d)
curl -fsSL https://drum.lib.umd.edu/bitstreams/7bce2c7e-9df3-4134-a5cc-78d0784c5f45/download |
  python3 -c '
import io, sys, zipfile
from pathlib import Path
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    for split in ("train", "dev"):
        name = f"{split}.json"
        (Path(sys.argv[1]) / name).write_bytes(archive.read(f"CANARD_Release/{name}"))
' "$canard_work"
python3 -B scripts/question-rewriter/prepare-canard.py --split train \
  --audit-root "$AUDIT_ROOT" --input "$canard_work/train.json" \
  --dev-input "$canard_work/dev.json" --output "$canard_work/train-clean.json"
python3 -B scripts/question-rewriter/prepare-canard.py --split dev \
  --audit-root "$AUDIT_ROOT" --input "$canard_work/dev.json" --output "$canard_work/dev-filtered.json"
node scripts/question-rewriter/train-question-edit.ts "$canard_work/train-clean.json" \
  "$canard_work/dev-filtered.json" "$canard_work/question-edit-weights.ts" 8
cmp "$canard_work/question-edit-weights.ts" apps/server/src/assistant/question-edit-weights.ts
node scripts/question-rewriter/evaluate-canard-dev.ts "$canard_work/dev-filtered.json"
```

The pronoun-replacement baseline substitutes the article title for third-person personal pronouns and its possessive form for possessives. Exact match is string equality with the original reference. Normalized substring match applies NFC, collapses whitespace and folds case as the capability scorer does. It strips ending punctuation from the reference as in the capability mapping. The evaluator also reports the subset with a prior question and a reference that the input question does not already contain.
