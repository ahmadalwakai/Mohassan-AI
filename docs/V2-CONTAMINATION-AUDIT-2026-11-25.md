# Capability benchmark v2 contamination audit — 25 November 2026

**PR #57 retained +94 of +94 and PR #47 retained +87 of +88** after excluding overlap with each branch’s fitted and model-selection data. The replay used the committed models and each branch was paired against the baseline on the identical retained cases.

Neither candidate fitted on a v2 case with the same upstream item ID. PR #57's fitted prompts had one sealed near match and no normalized exact matches. PR #47's fitted inputs matched 30 sealed cases by text, including 21 exact matches. CANARD contributed most of that overlap. The two branches' classifier test splits had substantially more overlap, reported below as post-fit evaluation exposure. PR #44's loaders can read overlapping rows and have no recorded head-training run in the audited branch. [Benchmark data cards](CAPABILITY-BENCH-V2-DATA.md) · [Prior paired study](https://github.com/ahmadalwakai/Mohassan-AI/pull/63)

## What was compared

- **#57** used CLINC150, Arabic MASSIVE v1.0, and English and Arabic Aya Red Teaming. The audit ran the pinned preparer, applied its deduplication and partition assignment, and recovered each retained row's native lineage. The trainer fitted on `train`, selected on `development`, calibrated on `calibration`, and evaluated on `test`. The local trainer reproduced the committed model byte for byte. [Origin snapshot](https://github.com/ahmadalwakai/Mohassan-AI/tree/f1ea533a3a33302b621b9e416c543941ccabbc53/scripts/refusal-classifier)
- **#47** used CLINC150, Arabic and English MASSIVE v1.0, CANARD, Palestinian ArBanking77, and English and Arabic Aya Red Teaming. The pinned preparer produced the SHA-256 in the committed model metrics. The four heads consume the labels available on each prepared row. The CANARD follow-up head consumes the current and previous questions and derives its label from the human rewrite. `dev` and `calibration` informed selection and operating thresholds. `test` was for evaluation. [Origin snapshot](https://github.com/ahmadalwakai/Mohassan-AI/tree/76b1a9325a5ef4edda84816cc6523aa06026121e/packages/scratch-classifiers)
- **#44** supplies public loaders and a sample owner-PC schedule. The inventory runs every catalog source/task pair, including rows the schedule may reserve or deduplicate later. Its `source_partition` records the upstream label. The later `split_examples` reserves entire groups with a loader `upstream_split` of `test`, reserves owner-receipt groups when supplied, and blocks duplicate model inputs across reserved or higher-priority splits. A native partition name alone does not guarantee reservation. For example, MLQA rows carry their native test or dev label but the loader marks them `unsplit` for training assignment. The example schedule exercise below ran only the loader and splitter. [Origin snapshot](https://github.com/ahmadalwakai/Mohassan-AI/tree/4eaa5f0cdc6769f02dff4b378cc8e41dd3bd939e/packages/head-training)

V2 uses the CLINC150 `test` and `oos_test` splits, MASSIVE v1.1 `test` in `en-US` and `ar-SA`, Mintaka `test` in English and Arabic, TyDi QA GoldP `dev` in English and Arabic, CANARD `test`, GSM8K standard `test`, and the sanitized MBPP subset in the original test ID range. The sealed and dev bundles use the same source pins and separate sampled cases. [Versions, split definitions and fingerprints](CAPABILITY-BENCH-V2-DATA.md)

The reader verifies each release payload against its committed SHA-256 and count before comparison. The source scripts verify pinned download bytes. The audit records each match method separately.

1. **Exact.** Compare after Unicode NFKC, Arabic alef, ya and ta marbuta folding, Arabic mark and tatweel removal, Arabic-Indic and Eastern Arabic-Indic digit conversion to ASCII, Unicode casefolding, and whitespace collapse. Punctuation is kept. Match whole normalized fields, including v2 turn input, field values, the raw CANARD final question and mapped human rewrite, and the bare MBPP prompt. Training fields include context and candidate text where the model consumes them. Individual benchmark QA tool passages, answer keys, and individual fragments of CANARD history are outside this comparison.
2. **Near.** Compare sets of overlapping five-Unicode-character shingles on nonidentical normalized text. Use 128 deterministic MinHash values in 32 ordered bands of four. A shared corresponding band is checked against exact shingle Jaccard of at least **0.80**, inclusive. Common-order prefix and set-size filters and a 0.75 Jaccard work threshold avoid computing signatures for impossible pairs. The prefix filter also permits a lossless fallback for a pair that meets 0.80 without a shared band. Text shorter than five characters participates in exact and ID matching. The comparison operates on fields independently. For example, a reused single CANARD question or a previous question can flag a test case even when the dialogues are different.
3. **Source ID.** Use namespaced native identifiers, including the actual CLINC150 split and original zero-based index, and CANARD dialogue and question number. MASSIVE and Mintaka retain locale-level provenance in the exclusion files and compare stable item IDs across translations. For TyDi QA, convert the pinned Google QA ID to the v2 mirror's language and key representation. Treat a QuAC ID as a CANARD alias only when the pinned dialogue, one-based question number, and question text agree. The training-data digest and ID comparison answer different questions because model preparation can preserve a text match from another item or discard a duplicate source occurrence.

## Overlap

Every cell counts distinct v2 cases. The order is **exact / near / source ID / any**. The same case can match several methods or source rows, so the union can be smaller than the sum. Row counts are prepared records for #47 and #57, and loader examples for #44. A head receives only rows with labels for that head. #44 can emit an upstream item for several tasks.

| PR | Exposure measured | Rows | Sealed / 1,200 | Dev / 2,400 |
| --- | --- | ---: | ---: | ---: |
| #47 | evaluation | 12,307 | 371 / 12 / 369 / 371 | 627 / 19 / 623 / 628 |
| #47 | fit | 50,617 | 21 / 23 / 0 / 30 | 61 / 66 / 0 / 91 |
| #47 | selection | 7,240 | 13 / 6 / 0 / 17 | 40 / 16 / 0 / 51 |
| #57 | evaluation | 2,684 | 98 / 2 / 98 / 98 | 115 / 5 / 115 / 115 |
| #57 | fit | 6,333 | 0 / 1 / 0 / 1 | 0 / 7 / 0 / 7 |
| #57 | selection | 1,358 | 0 / 1 / 0 / 1 | 0 / 3 / 0 / 3 |
| #44 | **loader inventory** | 684,384 | **545 / 115 / 545 / 545** | **1000 / 281 / 997 / 1004** |
| #47 | **fit + selection union** | 57,857 | **21 / 24 / 0 / 31** | **64 / 75 / 0 / 100** |
| #57 | **fit + selection union** | 7,691 | **0 / 2 / 0 / 2** | **0 / 10 / 0 / 10** |

| V2 source | Sealed cases | Dev cases |
| --- | ---: | ---: |
| canard | 95 | 240 |
| clinc150 | 125 | 133 |
| gsm8k | 110 | 277 |
| massive | 200 | 319 |
| mbpp | 85 | 155 |
| mintaka | 400 | 828 |
| tydiqa | 185 | 448 |

<details>
<summary>PR #57 by source and split</summary>

| Training source | Upstream split or locale | Pipeline split | Rows | Sealed | Dev |
| --- | --- | --- | ---: | ---: | ---: |
| aya-arb | arb | calibration | 49 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| aya-arb | arb | development | 50 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| aya-arb | arb | test | 58 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| aya-arb | arb | train | 377 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| aya-eng | eng | calibration | 35 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| aya-eng | eng | development | 32 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| aya-eng | eng | test | 32 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| aya-eng | eng | train | 253 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| clinc150 | oos_test | test | 1,000 | 6 / 0 / 6 / 6 | 6 / 0 / 6 / 6 |
| clinc150 | oos_train | train | 100 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| clinc150 | oos_val | calibration | 53 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| clinc150 | oos_val | development | 47 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| clinc150 | test | test | 870 | 90 / 2 / 90 / 90 | 107 / 5 / 107 / 107 |
| clinc150 | train | train | 2,869 | 0 / 1 / 0 / 1 | 0 / 6 / 0 / 6 |
| clinc150 | val | calibration | 242 | 0 / 1 / 0 / 1 | 0 / 0 / 0 / 0 |
| clinc150 | val | development | 336 | 0 / 0 / 0 / 0 | 0 / 3 / 0 / 3 |
| massive-ar | dev | calibration | 246 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| massive-ar | dev | development | 268 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| massive-ar | test | test | 724 | 2 / 0 / 2 / 2 | 2 / 0 / 2 / 2 |
| massive-ar | train | train | 2,734 | 0 / 0 / 0 / 0 | 0 / 1 / 0 / 1 |

</details>

<details>
<summary>PR #47 by source and split</summary>

| Training source | Upstream split or locale | Pipeline split | Rows | Sealed | Dev |
| --- | --- | --- | ---: | ---: | ---: |
| arbanking77-pal | dev | calibration | 163 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| arbanking77-pal | dev | dev | 155 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| arbanking77-pal | test | test | 894 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| arbanking77-pal | train | train | 2,719 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| aya-arb | arb | calibration | 51 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| aya-arb | arb | dev | 54 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| aya-arb | arb | test | 60 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| aya-arb | arb | train | 369 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| aya-eng | eng | calibration | 35 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| aya-eng | eng | dev | 32 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| aya-eng | eng | test | 32 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| aya-eng | eng | train | 253 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| canard | dev | calibration | 1,508 | 13 / 5 / 0 / 16 | 35 / 6 / 0 / 39 |
| canard | dev | dev | 1,369 | 11 / 1 / 0 / 11 | 29 / 5 / 0 / 32 |
| canard | test | test | 4,728 | 95 / 8 / 93 / 95 | 240 / 11 / 236 / 240 |
| canard | train | train | 26,453 | 21 / 19 / 0 / 26 | 61 / 49 / 0 / 74 |
| clinc150 | oos_test | test | 998 | 6 / 0 / 6 / 6 | 6 / 0 / 6 / 6 |
| clinc150 | oos_train | train | 100 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| clinc150 | oos_val | calibration | 53 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| clinc150 | oos_val | dev | 47 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| clinc150 | test | test | 930 | 90 / 2 / 90 / 90 | 107 / 5 / 107 / 107 |
| clinc150 | train | train | 3,058 | 0 / 1 / 0 / 1 | 0 / 6 / 0 / 6 |
| clinc150 | val | calibration | 262 | 0 / 1 / 0 / 1 | 0 / 0 / 0 / 0 |
| clinc150 | val | dev | 355 | 0 / 0 / 0 / 0 | 0 / 3 / 0 / 3 |
| massive-ar-SA | dev | calibration | 761 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| massive-ar-SA | dev | dev | 782 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| massive-ar-SA | test | test | 2,308 | 129 / 1 / 175 / 179 | 137 / 2 / 261 / 263 |
| massive-ar-SA | train | train | 8,563 | 0 / 2 / 0 / 2 | 0 / 4 / 0 / 4 |
| massive-en-US | dev | calibration | 796 | 0 / 0 / 0 / 0 | 0 / 2 / 0 / 2 |
| massive-en-US | dev | dev | 817 | 0 / 0 / 0 / 0 | 0 / 3 / 0 / 3 |
| massive-en-US | test | test | 2,357 | 51 / 1 / 180 / 180 | 137 / 1 / 274 / 275 |
| massive-en-US | train | train | 9,102 | 0 / 1 / 0 / 1 | 0 / 8 / 0 / 8 |

</details>

<details>
<summary>PR #44 by source and split</summary>

| Training source | Upstream split or locale | Pipeline split | Rows | Sealed | Dev |
| --- | --- | --- | ---: | ---: | ---: |
| ami | unsplit | unsplit | 110,769 | 0 / 4 / 0 / 4 | 0 / 1 / 0 / 1 |
| arcd | test | test | 549 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| arcd | train | train | 486 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| canard | dev | dev | 6,860 | 13 / 6 / 0 / 16 | 40 / 8 / 0 / 43 |
| canard | test | test | 11,142 | 95 / 94 / 95 / 95 | 240 / 237 / 240 / 240 |
| canard | train | train | 63,052 | 21 / 19 / 0 / 26 | 62 / 49 / 0 / 75 |
| clinc150 | oos_test | oos_test | 1,000 | 6 / 0 / 6 / 6 | 6 / 0 / 6 / 6 |
| clinc150 | oos_train | oos_train | 100 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| clinc150 | oos_val | oos_val | 100 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| clinc150 | test | test | 13,500 | 119 / 4 / 119 / 119 | 127 / 7 / 127 / 127 |
| clinc150 | train | train | 45,000 | 0 / 5 / 0 / 5 | 0 / 7 / 0 / 7 |
| clinc150 | val | val | 9,000 | 0 / 2 / 0 / 2 | 0 / 3 / 0 / 3 |
| massive | dev | dev | 8,132 | 5 / 0 / 0 / 5 | 4 / 5 / 0 / 9 |
| massive | test | test | 11,896 | 201 / 2 / 200 / 201 | 320 / 3 / 319 / 321 |
| massive | train | train | 46,056 | 13 / 3 / 0 / 16 | 11 / 13 / 0 / 23 |
| mlqa | dev | dev | 1,573 | 0 / 0 / 0 / 0 | 0 / 1 / 0 / 1 |
| mlqa | test | test | 15,906 | 1 / 0 / 0 / 1 | 0 / 1 / 0 / 1 |
| quac | train | train | 83,568 | 30 / 22 / 0 / 33 | 75 / 65 / 0 / 89 |
| quac | val | val | 7,354 | 95 / 8 / 95 / 95 | 240 / 14 / 240 / 240 |
| squad2 | dev | dev | 17,641 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| squad2 | train | train | 214,326 | 0 / 0 / 0 / 0 | 2 / 5 / 0 / 6 |
| tydiqa | train | train | 13,102 | 0 / 1 / 0 / 1 | 2 / 4 / 0 / 6 |
| tydiqa | validation | validation | 977 | 125 / 2 / 125 / 125 | 305 / 0 / 305 / 305 |
| xquad | validation | validation | 2,295 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |

</details>

The MinHash band join confirmed 12 field pairs for #57 fit plus selection, 493 for #47 fit plus selection, and 9,080 for #44's loader inventory. These counts include a match each time it recurs on a different prepared record. The lossless comparison recovered zero additional pairs in any role.

For #57, the two sealed exposure matches came from CLINC150 and both were near matches. For #47, the CANARD fit split matched 26 sealed cases. The independent source-ID checks found substantial overlap with the post-fit test splits, which reflects reuse of official public test data. #57 also ran an application-integrated test on official CLINC150 test items. The clean score measures exposure during fitting and selection and still includes cases used only for those prior checks.

## Corrected sealed gains

The original per-case receipts stayed in the earlier study’s private workspace. This audit regenerated them once using PR #63’s unmodified paired collector and the same pinned benchmark, frozen commits, offline fixture observer and flags. Across all 1,200 cases the baseline passed 247, #57 passed 341, and #47 passed 335. Baseline and candidate outcomes were paired by case ID. The replay reproduced 22 of 22 published overall and area/language counts for baseline passes, candidate passes, gains and losses. [PR #63 report](https://github.com/ahmadalwakai/Mohassan-AI/blob/9fefcb1a7fa6f46d5b13cf61bf20a5c90341d7db/docs/CAPABILITY-V2-BY-BRANCH-2026-11-25.md)

The primary mask removes every sealed case with a measured overlap against either fitted rows or rows used for model selection or calibration. Each candidate is compared with the baseline on its own retained cases. The fit-only mask checks sensitivity to the treatment of selection and calibration. Net gain subtracts paired losses from paired gains.

| Candidate | Exclusion mask | Cases removed | Cases retained | Baseline passes | Candidate passes | Gains | Losses | Net | Delta rate | Full gain retained |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| #57 | Fit + selection | 2 | 1,198 | 246 | 340 | 94 | 0 | **+94** | +7.85 pp | **100%** |
| #47 | Fit + selection | 31 | 1,169 | 246 | 333 | 121 | 34 | **+87** | +7.44 pp | **98.86%** |
| #57 | Fit only | 1 | 1,199 | 247 | 341 | 94 | 0 | +94 | +7.84 pp | 100% |
| #47 | Fit only | 30 | 1,170 | 247 | 334 | 121 | 34 | +87 | +7.44 pp | 98.86% |

| Candidate | Mask | Excluded cases | Baseline passes | Candidate passes | Gains | Losses | Net |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| #57 | Fit + selection | 2 | 1 | 1 | 0 | 0 | 0 |
| #47 | Fit + selection | 31 | 1 | 2 | 1 | 0 | +1 |
| #57 | Fit only | 1 | 0 | 0 | 0 | 0 | 0 |
| #47 | Fit only | 30 | 0 | 1 | 1 | 0 | +1 |

On the primary clean subset, all 94 gains for #57 were in refusal. For #47, 119 refusal gains and two small-talk gains remained, along with 10 comparison losses and 24 factual losses. These are paired branch-stack effects relative to `c2a0ff7`, including the #39 stack for #57. Isolating the learned heads from the other changes would require a separate ablation.

The audit ran on Linux x64, Node.js `v24.22.3`, timezone `Europe/London`, with the lockfile’s Chromium `156.0.8078.4`. Each used `scripts/agent-capability-bench/observe.ts` with SHA-256 `d7fc412372917c89f0fdcd100133dc4fa5b667f3969244badcefaae980e9bdff`. The common collector SHA-256 was `5e3c96492703f5529972ffe61390fd7e1ad67868806d8f745c13fe228bc3d1bd`.

| Lane | Flag | Lockfile SHA-256 | Receipt SHA-256 | Started and finished (UTC) |
| --- | --- | --- | --- | --- |
| Baseline | Defaults | `be0681e77c59af142f13a81cf84a835322b654238e7a030739d2907cda325738` | `06008024d7d71bd31b701b0030c6fd23e04ca943766e2ae204f091dac1caf6df` | 04:01:32.874–04:07:27.852 |
| #47 | `MOHASSAN_SCRATCH_CLASSIFIERS=1` | `5ca3eb97d734f4403734d865f08e52065675e46877f75000e3646b1fddbdbb4e` | `6b8e80c253be9211963cf9f8109a2c6f2fecb4a311c6f8aee80335f64f42cb4a` | 04:01:32.876–04:06:02.000 |
| #57 | `MOHASSAN_REFUSAL_POLICY=1` | `be0681e77c59af142f13a81cf84a835322b654238e7a030739d2907cda325738` | `e50af843bb3fe58322a75f8bf144033418b49a440ede8893c3a9a2f4acad8e75` | 04:01:32.994–04:07:20.039 |

<details>
<summary>Paired replay and verification commands</summary>

### Paired scoring commands

The reproducibility commands below start in `/workspace/work/mohassan-audit`. An initial merge-tree attempt returned exit 128 because the checkout was shallow. Deepening provided the common `c2a0ff7` ancestor. The following preparation recreated both PR #63 scratch commit IDs and produced the same release and collector hashes in all three lanes.

```bash
git fetch --no-tags origin 9fefcb1a7fa6f46d5b13cf61bf20a5c90341d7db f1ea533a3a33302b621b9e416c543941ccabbc53 76b1a9325a5ef4edda84816cc6523aa06026121e
git fetch --no-tags --deepen=25 origin 9fefcb1a7fa6f46d5b13cf61bf20a5c90341d7db f1ea533a3a33302b621b9e416c543941ccabbc53 76b1a9325a5ef4edda84816cc6523aa06026121e && git merge-base --all 74035b9 f1ea533 && git merge-base --all 74035b9 76b1a932
set -euo pipefail
umask 077
audit=/workspace/work/v2-contamination/score
mkdir -p "$audit"/{worktrees,receipts}
git cat-file -t 74035b9cca7e94a750234abf574cdbad2e692239
git cat-file -t c2a0ff765071657cf200b5ee7d12fabaad738c0b
tree57=$(git merge-tree --write-tree 74035b9cca7e94a750234abf574cdbad2e692239 f1ea533a3a33302b621b9e416c543941ccabbc53)
tree47=$(git merge-tree --write-tree 74035b9cca7e94a750234abf574cdbad2e692239 76b1a9325a5ef4edda84816cc6523aa06026121e)
test "$tree57" = 15f3f0a29cd3a9281482b723835da8811c1f02a7
test "$tree47" = 2a60c7f37a7aefa158456ef7e95a962e2a61884e
export GIT_AUTHOR_NAME='Capability benchmark' GIT_AUTHOR_EMAIL=capability-benchmark@example.invalid GIT_AUTHOR_DATE=2026-11-25T03:24:11Z
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL" GIT_COMMITTER_DATE="$GIT_AUTHOR_DATE"
merge57=$(git commit-tree "$tree57" -p 74035b9cca7e94a750234abf574cdbad2e692239 -p f1ea533a3a33302b621b9e416c543941ccabbc53 -m 'Scratch capability v2: e2e/refusal-generalization')
merge47=$(git commit-tree "$tree47" -p 74035b9cca7e94a750234abf574cdbad2e692239 -p 76b1a9325a5ef4edda84816cc6523aa06026121e -m 'Scratch capability v2: feat/scratch-classifiers')
test "$merge57" = 1374bc44c0d73e8567acb5814e938f2576676fde
test "$merge47" = 8d6be4c66329679eb901e8129690562cb5df183a
git worktree add --detach "$audit/worktrees/baseline" c2a0ff765071657cf200b5ee7d12fabaad738c0b
git worktree add --detach "$audit/worktrees/pr-57" "$merge57"
git worktree add --detach "$audit/worktrees/pr-47" "$merge47"
git archive a130b239d9e6d2b1f6728128019d24bb26e9293f scripts/agent-capability-bench | tar -x -C "$audit/worktrees/baseline"
git show 74035b9cca7e94a750234abf574cdbad2e692239:scripts/agent-capability-bench/collect-paired-outcomes.ts > "$audit/worktrees/baseline/scripts/agent-capability-bench/collect-paired-outcomes.ts"
sha256sum tests/fixtures/agent-capability-bench/v2/sealed/payload.json
for lane in baseline pr-47 pr-57; do
  sha256sum "$audit/worktrees/$lane/scripts/agent-capability-bench/collect-paired-outcomes.ts" "$audit/worktrees/$lane/scripts/agent-capability-bench/v2/manifest.json"
done
for lane in baseline pr-47 pr-57; do
  sha256sum /workspace/work/v2-contamination/score/worktrees/$lane/scripts/agent-capability-bench/observe.ts /workspace/work/v2-contamination/score/worktrees/$lane/package-lock.json
done
```

These installs, the local Chromium/PDF probe and all three fixture-free preflights exited 0.

```bash
(cd /workspace/work/v2-contamination/score/worktrees/baseline && npm ci --no-audit --no-fund --prefer-offline --cache /workspace/work/v2-contamination/score/npm-cache --logs-dir /workspace/work/v2-contamination/score/npm-logs-baseline)
(cd /workspace/work/v2-contamination/score/worktrees/pr-47 && npm ci --no-audit --no-fund --prefer-offline --cache /workspace/work/v2-contamination/score/npm-cache --logs-dir /workspace/work/v2-contamination/score/npm-logs-pr-47)
(cd /workspace/work/v2-contamination/score/worktrees/pr-57 && npm ci --no-audit --no-fund --prefer-offline --cache /workspace/work/v2-contamination/score/npm-cache --logs-dir /workspace/work/v2-contamination/score/npm-logs-pr-57)
(cd /workspace/work/v2-contamination/score/worktrees/baseline && PLAYWRIGHT_BROWSERS_PATH=/workspace/work/v2-contamination/score/browsers node node_modules/playwright/cli.js install chromium)
(cd /workspace/work/v2-contamination/score/worktrees/baseline && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/v2-contamination/score/browsers node --input-type=module -e 'import { chromium } from "playwright"; const browser = await chromium.launch(); try { const page = await browser.newPage(); await page.setContent("<p>PDF probe</p>"); const pdf = await page.pdf(); if (pdf.subarray(0, 5).toString() !== "%PDF-") process.exitCode = 1; } finally { await browser.close(); }')
(cd /workspace/work/v2-contamination/score/worktrees/baseline && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/v2-contamination/score/browsers node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --preflight true --output /workspace/work/v2-contamination/score/receipts/baseline.preflight.json)
(cd /workspace/work/v2-contamination/score/worktrees/pr-47 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/v2-contamination/score/browsers MOHASSAN_SCRATCH_CLASSIFIERS=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --preflight true --output /workspace/work/v2-contamination/score/receipts/pr-47.preflight.json)
(cd /workspace/work/v2-contamination/score/worktrees/pr-57 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/v2-contamination/score/browsers MOHASSAN_REFUSAL_POLICY=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --preflight true --output /workspace/work/v2-contamination/score/receipts/pr-57.preflight.json)
```

The regenerated paired receipts came from these invocations, each run once with a new private receipt path. All three exits were 0.

```bash
(cd /workspace/work/v2-contamination/score/worktrees/baseline && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/v2-contamination/score/browsers node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --sealed /workspace/work/mohassan-audit/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/v2-contamination/score/receipts/baseline.paired.json --baseline true)
(cd /workspace/work/v2-contamination/score/worktrees/pr-47 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/v2-contamination/score/browsers MOHASSAN_SCRATCH_CLASSIFIERS=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --sealed /workspace/work/mohassan-audit/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/v2-contamination/score/receipts/pr-47.paired.json)
(cd /workspace/work/v2-contamination/score/worktrees/pr-57 && env -i PATH="$PATH" TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/v2-contamination/score/browsers MOHASSAN_REFUSAL_POLICY=1 node --import tsx scripts/agent-capability-bench/collect-paired-outcomes.ts --sealed /workspace/work/mohassan-audit/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/v2-contamination/score/receipts/pr-57.paired.json)
```

```bash
python3 -B scripts/agent-capability-bench/v2/score_contamination.py /workspace/work/v2-contamination/score/receipts /workspace/work/v2-contamination/overlap-final.json > /workspace/work/v2-contamination/score/aggregate.json
PYTHONPATH=scripts/agent-capability-bench/v2 python3 -B -m unittest discover -s tests -p test_v2_contamination_score.py -v
```

The focused paired scorer suite passed all six tests.

The published-count verification exited 0 with `22/22 published paired pass and switch counts reproduced.`

```bash
git show 9fefcb1a7fa6f46d5b13cf61bf20a5c90341d7db:docs/CAPABILITY-V2-BY-BRANCH-2026-11-25.md > /workspace/work/v2-contamination/score/reference.md
PYTHONPATH=scripts/agent-capability-bench/v2 python3 -B - /workspace/work/v2-contamination/score/receipts /workspace/work/v2-contamination/score/reference.md <<'PY'
import re
import sys
from pathlib import Path
from score_contamination import BASELINE, CANDIDATES, count_pairs, read_receipt

directory = Path(sys.argv[1])
reference = Path(sys.argv[2]).read_text(encoding="utf-8")
ranking = reference.split("## Ranking\n", 1)[1].split("\n##", 1)[0]
baseline_passed, baseline_total = map(int, re.search(r"baseline passed \*\*(\d+)/(\d+)", ranking).groups())
baseline, _ = read_receipt(directory, "baseline", BASELINE)
matched = 0
groups = 0
for pr, commit in CANDIDATES.items():
    candidate, _ = read_receipt(directory, f"pr-{pr}", commit)
    fields = next(line.split("|") for line in ranking.splitlines() if f"| [#{pr}]" in line)
    passed, total = map(int, fields[3].split("/"))
    assert total == baseline_total
    expected = (baseline_passed, passed, int(fields[7]), int(fields[8]), total)
    stats = count_pairs(baseline, baseline, candidate)
    observed = tuple(stats[key] for key in ("baselinePassed", "candidatePassed", "gains", "losses", "cases"))
    groups += 1
    matched += observed == expected
    if observed != expected:
        print(f"#{pr} overall replay {observed} differs from {expected}")
    block = re.search(rf"<summary>#{pr} [^<]*</summary>(.*?)</details>", reference, re.S).group(1)
    rows = re.findall(r"^\| ([^|]+) \| (\d+)/(\d+) \| (\d+)/(\d+) \| [^|]+ \| [^|]+ \| [^|]+ \| (\d+) \| (\d+) \|", block, re.M)
    assert len(rows) == 10
    for label, base, total, current, candidate_total, gains, losses in rows:
        assert total == candidate_total
        label = label.strip("`")
        field, value = ("language", {"Arabic": "ar", "English": "en"}[label]) if label in {"Arabic", "English"} else ("area", label)
        stats = count_pairs((case for case in baseline if baseline[case][field] == value), baseline, candidate)
        observed = tuple(stats[key] for key in ("baselinePassed", "candidatePassed", "gains", "losses", "cases"))
        expected = tuple(map(int, (base, current, gains, losses, total)))
        groups += 1
        matched += observed == expected
        if observed != expected:
            print(f"#{pr} {label} replay {observed} differs from {expected}")
print(f"{matched}/{groups} published paired pass and switch counts reproduced.")
raise SystemExit(matched != groups)
PY
```

</details>

## Rule for future training

Every future training pipeline must load the complete [v2 exclusion manifest](../tests/fixtures/agent-capability-bench/v2/exclusion/manifest.json) and reject a whole row when any model-visible text or known source ID matches either partition. Apply the gate before deduplication, split assignment, example expansion, fitting, or model selection. Preserve the upstream identifier before renumbering or dropping metadata, and pass verified aliases along with the native ID. Transfer the manifest and its two checked JSONL files together. A missing or corrupt exclusion file must stop the preparation job. Record the registry fingerprint and aggregate drop counts in the training receipt.

The registry has 3,600 source item keys and 4,484 distinct text digests, with no plaintext, embeddings, or per-case scores. It blocks exact normalized strings and source IDs. An edited copy with a different source ID can evade those checks. Use the report's private near-duplicate audit for new sources as a release custodian. Only the registry is needed by the training job.

```python
# Add scripts/agent-capability-bench/v2 to the training script's import path.
from exclusion import Exclusions

exclusions = Exclusions.load()
keep = not exclusions.matches(model_texts, source_id=native_id, source_ids=verified_aliases)
```

## Merge notes

- **#44** Wire the filter at the loader boundary before assigning groups to the training job. Pass `Example.text`, `history`, `candidates`, and canonical source IDs. Carry the verified QuAC/CANARD alias and the TyDi QA ID conversion into the gate.
- **#47** Wire it at native row preparation in `packages/scratch-classifiers/prepare_data.py`, keeping original CLINC split/index, MASSIVE ID/locale and CANARD dialogue/question IDs before fields are discarded. Pass the current and previous questions for CANARD.
- **#57** Wire it at the native source loops in `scripts/refusal-classifier/train.py`, keeping original CLINC split/index and MASSIVE ID/locale through the gate. The integration tests show the proposed filtering behavior using all three archived preparation paths.

## Reproducing the source and overlap audit

Run from the root of this audit checkout. The scratch paths below were outside the Git tree. The extractors never use benchmark items as training data. Python was 3.12.14 with NumPy 2.3.5 and SciPy 1.17.0 for the pinned trainers and PyArrow 23.0.1 for the head kit's Parquet loader. The Node checks used Node 24.22.3.

```bash
git fetch --depth 1 --no-tags origin refs/heads/e2e/refusal-generalization:refs/remotes/origin/e2e/refusal-generalization refs/heads/feat/scratch-classifiers:refs/remotes/origin/feat/scratch-classifiers refs/heads/feat/head-training-kit:refs/remotes/origin/feat/head-training-kit
mkdir -p /workspace/work/v2-training-snapshots /workspace/work/v2-training-data
git archive f1ea533a3a33302b621b9e416c543941ccabbc53 scripts/refusal-classifier apps/server/src/assistant/refusal/learned-model.json | tar -xf - -C /workspace/work/v2-training-snapshots
git archive 76b1a9325a5ef4edda84816cc6523aa06026121e packages/scratch-classifiers | tar -xf - -C /workspace/work/v2-training-snapshots
git archive 4eaa5f0cdc6769f02dff4b378cc8e41dd3bd939e packages/head-training | tar -xf - -C /workspace/work/v2-training-snapshots
python3 -m venv --system-site-packages /workspace/work/v2-contamination-python
/workspace/work/v2-contamination-python/bin/python -m pip install 'pyarrow==23.0.1'
```

The original refusal trainer fitted 6,333 rows and evaluated 2,684 test rows. `cmp` verified its model against the committed `learned-model.json` with SHA-256 `b655e0cb5f4785bfe1b6ff9d873cfece9b1f4c3dba50a7ba2fd74657cdd4dfb7`. The scratch preparer produced SHA-256 `0d1ffaf90ceb6828eeaba9ee203292ca2c4d2e7b957ba66ed0f6327a31eee20a`, the `dataSha256` in the committed metrics. The scratch trainer completed with the same per-head split sizes and selected model kinds, with numerical differences in its exported weights. The sealed replay used the committed weights. The cause of the numerical difference is unverified.

```bash
PYTHONDONTWRITEBYTECODE=1 python3 /workspace/work/v2-training-snapshots/scripts/refusal-classifier/train.py --cache /workspace/work/v2-training-data/refusal-cache --model /workspace/work/v2-training-data/refusal-rerun-model.json --metrics /workspace/work/v2-training-data/refusal-rerun-metrics.json
cmp /workspace/work/v2-training-snapshots/apps/server/src/assistant/refusal/learned-model.json /workspace/work/v2-training-data/refusal-rerun-model.json
sha256sum /workspace/work/v2-training-data/refusal-rerun-model.json
PYTHONDONTWRITEBYTECODE=1 python3 /workspace/work/v2-training-snapshots/packages/scratch-classifiers/prepare_data.py --cache /workspace/work/v2-training-data/scratch-cache --output /workspace/work/v2-training-data/scratch-prepared.jsonl
sha256sum /workspace/work/v2-training-data/scratch-prepared.jsonl
PYTHONDONTWRITEBYTECODE=1 python3 /workspace/work/v2-training-snapshots/packages/scratch-classifiers/train.py --data /workspace/work/v2-training-data/scratch-prepared.jsonl --output /workspace/work/v2-training-data/scratch-rerun-models
diff -rq /workspace/work/v2-training-snapshots/packages/scratch-classifiers/models /workspace/work/v2-training-data/scratch-rerun-models
```

The extractors preserve the native split, preparation split, and text fields. The output SHA-256 values below cover the full private lineage exports. The extractor independently checks the prepared #47 bytes against the committed training-data digest while adding lineage. Keep row exports and overlap IDs in a private audit directory.

```bash
umask 077
PYTHONDONTWRITEBYTECODE=1 /workspace/work/v2-contamination-python/bin/python scripts/agent-capability-bench/v2/training_rows.py --snapshots /workspace/work/v2-training-snapshots --cache /workspace/work/v2-training-data/head-cache --branch 44 --output /workspace/work/v2-training-data/rows-44.jsonl
PYTHONDONTWRITEBYTECODE=1 /workspace/work/v2-contamination-python/bin/python scripts/agent-capability-bench/v2/training_rows.py --snapshots /workspace/work/v2-training-snapshots --cache /workspace/work/v2-training-data/scratch-cache --branch 47 --output /workspace/work/v2-training-data/rows-47.jsonl
PYTHONDONTWRITEBYTECODE=1 /workspace/work/v2-contamination-python/bin/python scripts/agent-capability-bench/v2/training_rows.py --snapshots /workspace/work/v2-training-snapshots --cache /workspace/work/v2-training-data/refusal-cache --branch 57 --output /workspace/work/v2-training-data/rows-57.jsonl
wc -l /workspace/work/v2-training-data/rows-{44,47,57}.jsonl
sha256sum /workspace/work/v2-training-data/rows-{44,47,57}.jsonl
PYTHONDONTWRITEBYTECODE=1 python3 scripts/agent-capability-bench/v2/contamination.py --rows /workspace/work/v2-training-data/rows-57.jsonl /workspace/work/v2-training-data/rows-47.jsonl /workspace/work/v2-training-data/rows-44.jsonl --out /workspace/work/v2-contamination/overlap-final.json
jq '{benchmark,byBranch,byRole,byTrainingSource}' /workspace/work/v2-contamination/overlap-final.json
```

| PR | Rows | SHA-256 of lineage export |
| --- | ---: | --- |
| #44 | 684,384 | `f5f16a9c1aedf825bbd1f95db3c39961751fd621ecb5abb89fa72b8d6e4974ce` |
| #47 | 70,164 | `15676ab4528b86c2f1e2cd1e17a354791f658654ca88b25715d7193bbad490b8` |
| #57 | 10,375 | `c155b1643a9bf47f5e1641ceddc984af3113ca5b509fc417a02604154c7bc2e4` |

<details>
<summary>PR #44 example schedule diagnostic</summary>

Run the example split assignments against the same pinned cache. The command passed for all ten jobs. This is a feature-branch example configuration without owner receipt inputs or an actual training run.

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/workspace/work/v2-training-snapshots/packages/head-training /workspace/work/v2-contamination-python/bin/python - <<'PY'
from collections import Counter
from pathlib import Path
from head_training.config import load_config
from head_training.datasets import load_dataset
from head_training.splits import split_examples
root = Path('/workspace/work/v2-training-snapshots')
cache = Path('/workspace/work/v2-training-data/head-cache')
config = load_config(root / 'packages/head-training/pc-schedule.example.json', root)
for job in config.jobs:
    assert all(source.label_map is None for source in job.sources)
    rows = [row for source in job.sources for row in load_dataset(source.name, source.task, cache, allow_download=False).examples]
    replay = split_examples(rows, seed=job.training.get('seed', 0))
    result = {split: dict(sorted(Counter(row.source for row in getattr(replay, split)).items())) for split in ('train', 'development', 'calibration')}
    print(job.name, len(rows), result, 'reserved', replay.reserved_count, 'deduplicated', replay.duplicate_count, flush=True)
PY
```

| Example job | Loaded | Fit | Development | Calibration | Reserved | Deduplicated |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| clinc-intent | 22,500 | 14,995 | 1,501 | 1,502 | 4,502 | 0 |
| massive-intent | 33,042 | 22,420 | 1,980 | 1,986 | 6,501 | 155 |
| clinc-domain | 22,500 | 14,995 | 1,500 | 1,503 | 4,502 | 0 |
| massive-scenario | 33,042 | 22,420 | 1,976 | 1,989 | 6,501 | 156 |
| out-of-scope | 23,700 | 15,095 | 1,552 | 1,551 | 5,502 | 0 |
| follow-up | 90,922 | 83,568 | 3,709 | 3,645 | 0 | 0 |
| rewrite | 40,527 | 31,526 | 1,666 | 1,764 | 5,571 | 0 |
| answer-sentence | 34,888 | 28,567 | 2,540 | 2,962 | 819 | 0 |
| sufficiency | 142,192 | 130,319 | 5,989 | 5,884 | 0 | 0 |
| speech-act | 110,769 | 66,827 | 7,825 | 2,948 | 0 | 33,169 |

</details>

<details>
<summary>MASSIVE stable ID check</summary>

Both audited locales had 16,521 rows in each release, with identical IDs, partitions, intents and utterances for each locale across v1.0 and v1.1. The same 16,521 IDs and split assignments are shared between the two locales.

```bash
python3 - <<'PY'
import json
from pathlib import Path
import tarfile

cache = Path('/workspace/work/v2-training-data')
locales = ('ar-SA', 'en-US')

def load(path, version):
    expected = {f'{version}/data/{locale}.jsonl': locale for locale in locales}
    with tarfile.open(path, 'r|gz') as archive:
        result = {}
        for member in archive:
            if member.name in expected:
                with archive.extractfile(member) as stream:
                    rows = map(json.loads, stream)
                    result[expected[member.name]] = {row['id']: (row['partition'], row['intent'], row['utt']) for row in rows}
    return result

v10 = load(cache / 'scratch-cache/massive.tar.gz', '1.0')
v11 = load(cache / 'head-cache/massive/massive.tar.gz', '1.1')
for locale in locales:
    assert v10[locale] == v11[locale]
    print(locale, len(v10[locale]), 'same IDs, partitions, intents and utterances')
assert v11['ar-SA'].keys() == v11['en-US'].keys()
assert all(row[0] == v11['en-US'][key][0] for key, row in v11['ar-SA'].items())
print(len(v11['ar-SA']), 'IDs and partitions shared across locales')
PY
```

</details>

## Focused verification

| Command | Result |
| --- | --- |
| `python3 -B scripts/agent-capability-bench/v2/exclusion.py --check` | Exit 0. The release-pinned generator reproduced all three registry files byte for byte. |
| `PYTHONPATH=scripts/agent-capability-bench/v2 python3 -B -m unittest discover -s tests -p 'test_v2_*.py' -v` | Exit 0. All 24 audit, exclusion, lineage and paired scoring tests passed, including the three frozen preparation paths. |
| `npm ci --no-audit --no-fund --cache /workspace/work/npm-cache` | Exit 0. Installed the audit checkout's locked dependencies. |
| `npx --no-install vitest run tests/agent-capability-v2-dev-fixture.test.ts tests/agent-capability-v2-sealed.test.ts` | Exit 0. Both files passed, 13 tests total. |
| `git diff --exit-code 12cedfe592aab40cdd47ee00d05ea86a6d2bae89 -- tests/fixtures/agent-capability-bench/v2/sealed tests/fixtures/agent-capability-bench/v2/dev` | Exit 0. Both release trees match the base. |
| `git diff --cached --check` | Exit 0. The staged diff passed Git's whitespace check. |
