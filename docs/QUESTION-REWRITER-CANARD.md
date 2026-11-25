# CANARD development data card

CANARD pairs QuAC dialogue context and questions with standalone rewrites written by crowd workers. Ahmed Elgohary, Denis Peskov, and Jordan Boyd-Graber released it under CC BY-SA 4.0. The original dialogues come from QuAC by Eunsol Choi and coauthors, with source passages by Wikipedia contributors. This evaluation uses the official `dev.json` member distributed by the University of Maryland. The local filtered copy removes complete rows and preserves the original fields of retained rows. The same CC BY-SA 4.0 license applies to redistribution of that copy. [Dataset release](https://doi.org/10.13016/zcop-ns5d) · [CANARD paper](https://aclanthology.org/D19-1605/) · [QuAC](https://quac.ai/) · [License](https://creativecommons.org/licenses/by-sa/4.0/)

The exclusion step checks the native CANARD identifier, the titles and dialogue utterances, the current question, and the reference with and without terminal punctuation. It applies the v2 exclusion registry to the upstream development split before evaluation. Every retained row keeps its original weight, including first questions and unchanged rewrites. The rewriter uses hand-written rules and no fitted parameters. Evaluation reads the development member only.

| Source | Input | Excluded | Evaluated |
| --- | ---: | ---: | ---: |
| Official CANARD `dev.json` | 3,430 | 831 | 2,599 |

- SHA-256 of `dev.json` is `fafd9f53be0684fd33f85f6bf12a63e61b835ecb9e987c9bd2186149366ce2e5`.
- SHA-256 of the v2 exclusion manifest is `de192bdc7203e1aa24fa06b216d3976f4ea77ec103e085a4019af7a60c2f3054`.

## Reproduce the evaluation

Use a fresh scratch directory for the official development member and filtered output. Set `AUDIT_ROOT` to a checkout containing the PR #70 exclusion filter and all three registry files. Install the repository dependencies for the `tsx` loader.

```sh
canard_work=$(mktemp -d)
curl -fsSL https://drum.lib.umd.edu/bitstreams/7bce2c7e-9df3-4134-a5cc-78d0784c5f45/download |
  python3 -c 'import io, pathlib, sys, zipfile; archive = zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); pathlib.Path(sys.argv[1]).write_bytes(archive.read("CANARD_Release/dev.json"))' "$canard_work/dev.json"
python3 -B scripts/question-rewriter/prepare-canard-dev.py \
  --audit-root "$AUDIT_ROOT" --input "$canard_work/dev.json" --output "$canard_work/dev-filtered.json"
node --import tsx scripts/question-rewriter/evaluate-canard-dev.ts "$canard_work/dev-filtered.json"
```

The pronoun-replacement baseline substitutes the article title for third-person personal pronouns and its possessive form for possessives. Exact match is string equality with the original reference. Normalized substring match applies NFC, collapses whitespace and folds case as the capability scorer does. It strips ending punctuation from the reference as in the capability mapping. The evaluator also reports the subset with a prior question and a reference that the input question does not already contain.

## Follow-up v2 measurement

The filter ran once on the official release and retained 2,599 of 3,430 rows. All three evaluations used those same filtered rows and Node `v24.22.3`. The base checkout was detached at `201321031293999003bb0ae55a29dbd250ac96ce`. The feature checkout was at `e30a31b265bca6b50ee8a82284b5f992b925a72b`.

Run from `/workspace/Mohassan-AI` to prepare the measured input. The checkout at the base commit contained the same PR #70 exclusion manifest and registry files.

```sh
mkdir -p /workspace/work/canard-followup && curl -fsSL https://drum.lib.umd.edu/bitstreams/7bce2c7e-9df3-4134-a5cc-78d0784c5f45/download |
  python3 -c 'import io, pathlib, sys, zipfile; archive = zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); pathlib.Path(sys.argv[1]).write_bytes(archive.read("CANARD_Release/dev.json"))' /workspace/work/canard-followup/dev.json &&
  sha256sum /workspace/work/canard-followup/dev.json
python3 -B scripts/question-rewriter/prepare-canard-dev.py --audit-root /workspace/Mohassan-AI --input /workspace/work/canard-followup/dev.json --output /workspace/work/canard-followup/dev-filtered.json
```

Run the first evaluation from `/workspace/work/canard-followup/base-guard` and the other two from `/workspace/Mohassan-AI`.

```sh
MOHASSAN_FOLLOWUP_V2=0 node --import /workspace/Mohassan-AI/node_modules/tsx/dist/loader.mjs scripts/question-rewriter/evaluate-canard-dev.ts /workspace/work/canard-followup/dev-filtered.json > /workspace/work/canard-followup/canard-reviewed-a.json
MOHASSAN_FOLLOWUP_V2=0 node --import /workspace/Mohassan-AI/node_modules/tsx/dist/loader.mjs scripts/question-rewriter/evaluate-canard-dev.ts /workspace/work/canard-followup/dev-filtered.json > /workspace/work/canard-followup/canard-reviewed-b.json
MOHASSAN_FOLLOWUP_V2=1 node --import /workspace/Mohassan-AI/node_modules/tsx/dist/loader.mjs scripts/question-rewriter/evaluate-canard-dev.ts /workspace/work/canard-followup/dev-filtered.json > /workspace/work/canard-followup/canard-reviewed-c.json
cmp /workspace/work/canard-followup/canard-reviewed-a.json /workspace/work/canard-followup/canard-reviewed-b.json
```

The input checksum matched the data card, the exclusion filter dropped 831 rows, and all three evaluations exited 0. `cmp` exited 0 with byte-identical base and flag-off receipts.

| Rewriter on all 2,599 rows | Exact match | Normalized substring match |
| --- | ---: | ---: |
| Pronoun replacement control | 613 | 717 |
| Base | 685 | 787 |
| Feature flag off | 685 | 787 |
| Feature flag on | 684 | 786 |

| Rewriter on 2,040 context-dependent follow-ups | Exact match | Normalized substring match |
| --- | ---: | ---: |
| Pronoun replacement control | 361 | 438 |
| Base | 409 | 487 |
| Feature flag off | 409 | 487 |
| Feature flag on | 408 | 486 |

Enabling the feature reduced each match count by one. These measures compare each standalone rewrite with one human reference on filtered English CANARD rows. The capability benchmark measures chat outcomes on its own development partitions.
