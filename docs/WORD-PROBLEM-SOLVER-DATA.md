# Word-problem solver data card

The held-out evaluation and development probes use the standard English GSM8K **train** split by Karl Cobbe et al., copyright OpenAI (2021), under the MIT license. Humans wrote the questions and prepared the annotated solutions. The pinned file is `grade_school_math/data/train.jsonl` at `3101c7d5072418e28b9008a6636bde82a006892c` with SHA-256 `17f347dc51477c50d4efb83959dbb7c56297aba886e5544ee2aaed3024813465`. Only the train file and license were requested from upstream. [Source](https://github.com/openai/grade-school-math/blob/3101c7d5072418e28b9008a6636bde82a006892c/grade_school_math/data/train.jsonl) · [License](https://github.com/openai/grade-school-math/blob/3101c7d5072418e28b9008a6636bde82a006892c/LICENSE) · [Paper](https://arxiv.org/abs/2110.14168)

| Preparation step | Rows |
| --- | ---: |
| Pinned source | 7,473 |
| Dropped by v2 exclusion | 0 |
| Dropped by normalized question deduplication | 0 |
| Eligible | 7,473 |
| Held out | 1,494 |
| Eligible for training | 5,979 |

The preparation script loads and verifies both v2 exclusion partitions from the contamination audit's manifest before processing rows. The manifest SHA-256 is `de192bdc7203e1aa24fa06b216d3976f4ea77ec103e085a4019af7a60c2f3054`. The filter checks each problem, entire annotated solution, individual solution lines and split-qualified source ID `gsm8k:train:<one-based line>` before deduplicating or assigning splits. The `train` namespace distinguishes upstream train offsets from the benchmark's test offsets. [Contamination audit](https://github.com/ahmadalwakai/Mohassan-AI/pull/70)

Before tuning, eligible rows were ranked by SHA-256 of the UTF-8 seed `mohassan-word-problem-holdout-v1`, a zero byte and the ASCII hex digest of the normalized question. The first `floor(eligible / 5)` rows were held out. The prepared hold-out SHA-256 is `ddd39b03baf3e5c6c3c4fa2c970ae8e8996b57b841426a8cd9860931fd7eb985`. The other rows have SHA-256 `ec38e14d05011f85b5016e2cdecabbbbfc61e3f1379796d40af8307b8aeae94d` and were used to probe grammar coverage during development. The solver is deterministic and uses no fitted components. Arabic coverage uses hand-written unit tests only.

The held-out evaluator supplies only the problem text to the offline capability harness. Correct answers require a completed compute route, a recorded `calculate` call, zero questions, and a single designated final number equivalent to the gold number under exact rational comparison. Other completed calculate responses and responses with a designated final number count as answered for precision. Cases without either count as abstentions when the harness observes the turn successfully. Harness errors are counted separately. Accuracy and abstention rate divide their counts by all hold-out cases. Precision divides correct answers by answered cases.

## Reproduction

Use an ignored scratch directory outside the repository and a local scratch merge of the product branch with `origin/test/v2-contamination-audit` with dependencies installed. Set `repo` to the product checkout, `merged` to the scratch merge checkout and `scratch` to the scratch directory. Run these commands from any directory.

```sh
revision=3101c7d5072418e28b9008a6636bde82a006892c
git clone --depth=1 --filter=blob:none --no-checkout https://github.com/openai/grade-school-math.git "$scratch/upstream"
git -C "$scratch/upstream" fetch --depth=1 --filter=blob:none origin "$revision"
git -C "$scratch/upstream" show "$revision:grade_school_math/data/train.jsonl" > "$scratch/raw-train.jsonl"
git -C "$scratch/upstream" show "$revision:LICENSE" > "$scratch/LICENSE"
PYTHONDONTWRITEBYTECODE=1 python3 "$repo/scripts/word-problem-evaluation/prepare.py" "$merged" "$scratch/raw-train.jsonl" "$scratch/frozen"
"$merged/node_modules/.bin/tsx" "$repo/scripts/word-problem-evaluation/evaluate.mjs" "$merged" "$scratch/frozen/heldout.jsonl"
```

For parallel evaluation, pass an additional zero-based shard index and a common shard count to the evaluator. Run all indexes and sum the returned category counts before computing rates. The scripts write aggregate results and keep source rows in the scratch directory.
