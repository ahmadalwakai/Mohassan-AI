# Mohassan corpus pipeline

هذه بوابة تنظيف بيانات نموذج المحادثة التالي. توثّق مصدر كل مجموعة، وتستبعد النص المكرر أو الضعيف والمتداخل مع التقييم، ثم تحفظ بصمة البيانات التي يراجعها المالك قبل بدء التدريب.

The package implements the data policy in [batch 6](../../docs/AGENT-UPGRADE-PLAN-2026-11-24.md) and [section 4.4](../../docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md). It uses Python 3.11+ and the standard library. All inputs are local files. The tests use pytest, matching the execution pipeline package.

## Run the pipeline

From `packages/corpus-pipeline`, using the repository's Python interpreter:

```bash
python -m corpus_pipeline run --config /path/to/config.json --output /path/to/new-run --dry-run
python -m corpus_pipeline run --config /path/to/config.json --output /path/to/new-run
python -m pytest tests -q
```

The dry run performs the checks and prints the prospective manifest without creating files. Use a fresh output directory for every saved run. Keep corpus files and run outputs under the repository's ignored `artifacts/` directory or outside the repository.

## Configuration

Define a JSON object and use paths relative to that file's directory, or absolute paths. Replace the example SHA-256 values with the 64 lowercase hexadecimal characters from the corresponding files. Production runs declare sources for the train, development and calibration splits. The sealed split lives outside those outputs.

```json
{
  "sources": [
    {"id": "ar-train", "path": "ar-train.jsonl", "card": "ar-train.card.json", "split": "train", "kind": "text", "language": "ar"},
    {"id": "en-train", "path": "en-train.jsonl", "card": "en-train.card.json", "split": "train", "kind": "text", "language": "en"},
    {"id": "ar-dev", "path": "ar-dev.jsonl", "card": "ar-dev.card.json", "split": "development", "kind": "text", "language": "ar"},
    {"id": "en-dev", "path": "en-dev.jsonl", "card": "en-dev.card.json", "split": "development", "kind": "text", "language": "en"},
    {"id": "ar-cal", "path": "ar-cal.jsonl", "card": "ar-cal.card.json", "split": "calibration", "kind": "text"},
    {"id": "conversations", "path": "conversations.jsonl", "card": "conversations.card.json", "split": "train", "kind": "dialogue"}
  ],
  "frozen_evaluations": [{"path": "frozen-development.jsonl", "sha256": "<sha256>"}],
  "prior_manifests": ["earlier-run/manifest.json"],
  "near_duplicate_threshold": 0.8,
  "contamination_span_tokens": 13,
  "assistant_end_marker": "<|eos|>"
}
```

- `sources` lists a unique source ID, local file, card, split and kind for each input. Use `language` on text sources with known labels. Supply at least one labeled train text source and one labeled development text source for each of `ar` and `en`.
- `frozen_evaluations` requires at least one local JSONL file and its SHA-256 pin. Supply designated frozen development or calibration references in the text source schema. The pipeline reads these files and verifies their pins before using them. The owner-sealed holdout stays outside the pipeline.
- `prior_manifests` is optional. Use manifest paths from earlier corpus pipeline runs; preserve each manifest with its output shards.
- `near_duplicate_threshold` is the minimum Jaccard similarity for a candidate pair to be considered a near duplicate.
- `contamination_span_tokens` is the minimum length of an overlapping evaluation span.
- `assistant_end_marker` is the exact marker expected at the end of an assistant turn.
- `fixture_mode` defaults to `false`. Set it to `true` only for test or benchmark inputs marked `synthetic_fixture`. Fixture outputs fail pre-training verification.

Each UTF-8 source file contains one JSON object per line, with unique string IDs within the file. A text row has `id` and `text`. A dialogue row has `id` and a `turns` array. Each turn has a `role` and `content`.

```json
{"id":"text-1","text":"First paragraph.\n\nSecond paragraph."}
{"id":"dialogue-1","turns":[{"role":"user","content":"كيف أحفظ نسخة من الملف؟"},{"role":"assistant","content":"اختر حفظ باسم وحدّد مكان النسخة الجديدة. <|eos|>"}]}
```

Supply a JSON card for every source. Its `sha256` pins the original file bytes and `download_date` uses YYYY-MM-DD. Use a source URL or description specific enough to locate the data and record the actual consent or use permission basis. The license must match the [package allow-list](corpus_pipeline/licenses.json). The production origin must be `human`. Public AI-generated data is excluded from this corpus.

```json
{
  "source": "Original dataset URL or recorded collection location",
  "license": "CC0-1.0",
  "sha256": "<sha256>",
  "download_date": "2026-11-25",
  "consent": "Specific permission and collection basis",
  "origin": "human"
}
```

## Cleaning rules

Stored text uses Unicode NFKC and removes tatweel, zero-width characters and bidirectional controls. It preserves diacritics. Match keys additionally unify alef forms, ta marbuta and alef maqsura, map both Arabic-Indic digit sets to ASCII, remove diacritics and collapse whitespace. Exact duplicate keys use SHA-256.

The Arabic and English multinomial Naive Bayes classifier trains from scratch on the labeled train text sources. It uses character 1–3 grams with Laplace smoothing of 1. The confusion report uses the labeled development text sources. Mixed text documents split at paragraph boundaries. Dialogue turns remain together to preserve the conversation.

Deduplication checks records within sources, across sources and across the verified shards of prior manifests. Calibration and development records have priority over training records. Within a split, the first accepted match in input order takes priority. Near-duplicate detection uses unique, contiguous five-token shingles from the match key and deterministic densified MinHash with 16 locality-sensitive hashing bands of four rows each. A candidate must meet the configured Jaccard threshold, inclusive, to be removed. Approximate candidate lookup can miss a pair above the threshold. Text with fewer than five tokens is eligible for exact matching.

Training rows are checked against pinned frozen evaluation text for any shared continuous span of at least 13 tokens by default. Matching uses case-sensitive alphanumeric tokens from the match key. For every maximal qualifying span the log records the frozen file pin, the matching record ID, the token offsets and the span length. The frozen input files are read-only and their text is excluded from the audit logs.

Quality filters have named removal reasons. Adjust the numeric cutoffs with an optional `quality` object. These are the default settings.

| Parameter | Default | Measurement |
| --- | ---: | --- |
| `repetition_ngram_size` | 3 | Token width for frequent n-grams |
| `min_repetition_ngrams` | 4 | Minimum windows before checking n-gram repetition |
| `max_top_ngram_share` | 0.25 | Most frequent n-gram occurrences divided by all windows |
| `max_repeated_line_share` | 0.35 | Extra copies of repeated lines divided by nonblank lines |
| `max_symbol_ratio` | 0.30 | Non-letter/non-digit characters divided by non-space characters |
| `max_digit_ratio` | 0.35 | Digits divided by non-space characters |
| `short_line_min_tokens` | 4 | Lines below this token count are short |
| `max_short_line_share` | 0.75 | Short lines divided by nonblank lines |
| `min_short_line_count` | 3 | Minimum lines before checking the short-line share |

Boilerplate lists cover Arabic and English navigation and cookie notices. Normalized whole-line entries and known cookie-banner prefixes trigger the filter. Dialogues must contain complete user-assistant pairs. Turn text must be nonempty, and the configured marker must appear exactly once at the end of each assistant turn.

## Review and approve a run before training

1. Record source provenance in the cards and verify license, consent and authorship. Keep required attribution with the review evidence. Prepare documented train, development and calibration partitions. The owner writes or reviews the separate sealed split, governs access and records every access. Use the sealed split once for its independent evaluation.
2. Run the pipeline using the approved inputs and parameters. Keep the raw inputs and pinned frozen evaluation data. Inspect the split sizes, removals and contamination hits. Review mistakes in the language confusion report using held-out labeled development rows from both languages. If either language lacks usable evidence, prepare a new run with suitable labeled sources.
3. Independently sample up to 200 accepted units per source per language, using all units when fewer are available. Record the sample size and count of wrong or unnatural units for each group. Correct or exclude sources with more than 3% wrong or unnatural units, following the [v4 data-stage standard](../../docs/CHAT-MODEL-AGENT-INSTRUCTIONS.md). Resolve outstanding provenance and partitioning failures before approving a new run.
4. Have the reviewer record the approval and the SHA-256 of the exact `manifest.json` reviewed in a separate JSON file. Preserve that file alongside the review notes. Verify the approved package before handing off the fingerprinted training shard for training data preparation.

```json
{
  "manifest_sha256": "<sha256>",
  "reviewer": "<reviewer name>",
  "reviewed_at": "2026-11-25T12:00:00Z",
  "decision": "approved"
}
```

```bash
python -m corpus_pipeline verify --manifest /path/to/run/manifest.json --review /path/to/review.json
```

Start training only after verification succeeds. This preflight checks the review's manifest pin, the split and audit output fingerprints and counts, and the presence of nonempty train, development and calibration outputs. It prints the verified training JSONL path. If the training job uses tokenized data, derive it from the approved training shard and keep the source fingerprint with the derived corpus.

Every run keeps `manifest.json`, `removals.jsonl`, `contamination.jsonl`, `language-confusion.json`, the split JSONL shards, `run.json` and the Arabic `report.ar.md`. Each removal names its source and original document ID, with a zero-based paragraph number for a removed paragraph from a split document. The manifest contains input and shard fingerprints, policy versions and parameters, and counts by language and removal reason. For identical inputs, config and code its bytes are identical. The run record and Arabic summary retain command, times, raw output locations and fingerprints. Save every rerun in a new directory.

## Synthetic CPU benchmark

On Linux, run this from `packages/corpus-pipeline` with a new output directory.

```bash
python scripts/benchmark.py --work-dir /path/to/new-benchmark --text-mib 100
```

The benchmark assembles at least 100 MiB of UTF-8 Arabic and English text from fixed word lists and a fixed random seed. It runs the normal CLI on the resulting fixtures and measures elapsed time, CPU time and peak resident memory of the pipeline process, excluding input generation. The output includes `benchmark.json` with the recorded command, times, raw output directory and fingerprints.

The benchmark ran on Linux with an Intel Xeon Platinum 8573C and Python 3.12.14 on 25 November 2026. It started at 00:34:33 UTC and finished at 00:36:46 UTC with exit status 0.

```bash
/workspace/work/corpus-venv/bin/python scripts/benchmark.py --work-dir /workspace/work/corpus-bench-v6-final --text-mib 100
```

| Measurement | Result |
| --- | ---: |
| UTF-8 text bytes, excluding JSONL overhead | 104,984,230 |
| Accepted input documents | 53,721 of 53,722 |
| Accepted Arabic documents | 24,588 of 24,588 |
| Accepted English documents | 29,133 of 29,134 |
| Frozen evaluation hits | 1 |
| Correct labeled development classifications | 24 of 24 |
| Elapsed time | 132.753 s |
| CPU time | 132.527 s |
| Peak resident memory | 498,794,496 bytes (475.7 MiB) |

The raw inputs, stdout, stderr and pipeline outputs are in `/workspace/work/corpus-bench-v6-final` in the benchmark workspace. The SHA-256 of `benchmark.json` is `679c64749af1e7c219010126ec8ff4b02a3c02a0e64fb6231f5bd325d469e059`. The SHA-256 of `cleaned/manifest.json` is `d54f18006d725b91b6c940b73d190e13cc14e72e8c88d1f8b248157404c9ecb8`.
