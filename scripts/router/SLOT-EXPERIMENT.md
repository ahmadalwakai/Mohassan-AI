# Own slot-span tagger development experiment

This isolated experiment trains a small Mohassan-owned sequence tagger from
scratch on CPU. It reads only the two existing local public MASSIVE 1.1 files
for `ar-SA` and `en-US`. The public dataset is licensed CC BY 4.0. No owner
messages, production data, separate brain assessment, previous context-router
experiment, pretrained weights, providers or network are used.

Artifacts are inactive and live only under `artifacts/brain-slot-development-v1`.
No application extraction or routing path is changed.

## Labels and exact alignment

| Original MASSIVE label | Experiment label | Scope |
| --- | --- | --- |
| `place_name` | `place` | Exactly the annotated place phrase |
| `date` | `date` | Literal date phrase, without resolving it |
| `time` | `time` | Literal time phrase, without resolving it |
| `timeofday` | `time_of_day` | Annotated part of day |
| `time_zone` | `time_zone` | Annotated time-zone phrase |
| `news_topic` | `news_topic` | Only explicitly annotated `news_query` subjects |

Unannotated text and other labels remain `O`. There is no general-purpose
`topic` label, geocoding or inferred date. Of 546 public `news_topic` annotations,
29 outside `news_query` are deliberately not treated as topic supervision.

The parser removes `[label : surface]` markup and requires the reconstructed
string to equal the original utterance exactly. It does not find approximate
substrings, normalize source text, repair whitespace or choose among repeated
matches. Thus the two occurrences in `Paris to Paris` retain separate positions.
Malformed/nested markup, unaligned token boundaries, overlapping spans, invalid
Unicode and out-of-bound inputs are rejected.

Tokens are exact original Unicode word/punctuation spans matching
`\w+|[^\w\s]`. BIO labels attach to those tokens. Whitespace between tokens
inside a predicted entity stays part of the exact returned source substring.

Every projected span contains:

- `startCodepoint` / `endCodepoint`: half-open Python Unicode scalar indices.
- `startUtf16` / `endUtf16`: half-open JavaScript UTF-16 code-unit indices.
- `text`: exactly the original substring at those boundaries.

An astral character such as an emoji occupies one codepoint and two UTF-16
units. Tests cover this distinction and combining Arabic marks. Unicode folding
is used only for model features; it never changes returned boundaries or text.

## Model and decoder

Each token contributes a hashed word feature and character 2/3/4-grams. Mean
embeddings and six bounded script/shape flags feed a small bidirectional GRU and
a 13-tag BIO classifier. The default uses 32,768 hash buckets, 24 embedding
dimensions and 32 hidden units per direction. All weights start from scratch.

A fixed legal BIO Viterbi decoder forbids `I` at the start and `I` after the wrong
label. It does not repair an invalid tag into an invented boundary. Exported
weights have explicit tensor layouts, and independent NumPy mean-embedding,
GRU-gate, classifier and decode calculations verify PyTorch export parity.

## Data partitions and evaluation

Translation IDs remain grouped. Official public train/test partitions are
preserved, while development IDs divide deterministically into development and
calibration. Canonical utterance collisions across partitions exclude whole
groups; identical model features with contradictory BIO labels do the same.

The initial preparation retained 13,302 of 33,042 public utterances after group
exclusion and bounded positive/negative sampling. The selected partitions are
9,426 train, 840 development, 822 calibration and 2,214 test rows, with balanced
Arabic/English counts. All public annotations passed exact reconstruction and
token alignment. Group hygiene excluded 1,161 groups, including 361 canonical
cross-partition collisions and 16 contradictory feature signatures.

The sampled evaluation is richer in annotated slots than ordinary traffic;
its precision cannot be assumed to match a production conversation workload.
Original annotation quality also limits what this public evaluation establishes.

Checkpoint selection uses development exact-span micro F1. A separate calibration
partition selects temperature and per-slot confidence thresholds. Span confidence
is the minimum posterior of its predicted token tags. Accepted thresholds need
the configured precision lower bound using a 95% Wilson error upper bound. A
label abstains completely when evidence is insufficient; two calibration
`time_zone` spans cannot establish high precision.

Test inference is cached once and reused for raw and selective precision, recall
and exact-span F1, per label and language. Reports also distinguish accepted-span
coverage, positive-utterance exact accuracy and false positives on negative rows.
No output certifies source truth, permissions, task completion or readiness for
activation.

## Commands and limits

```powershell
& '.venv-execution/Scripts/python.exe' -I scripts/router/test_train_slots.py
& '.venv-execution/Scripts/python.exe' -I scripts/router/train_slots.py audit
& '.venv-execution/Scripts/python.exe' -I scripts/router/train_slots.py prepare --run-name unique-prepare-name
& '.venv-execution/Scripts/python.exe' -I scripts/router/train_slots.py train --run-name unique-train-name --threads 4 --epochs 5 --max-seconds 300
```

CPU threads are capped at four; observed process memory is checked against a
maximum 2 GiB target. The first model has a 300-second training-loop budget.
Preparation, calibration, evaluation and export also take time; this is not an
operating-system process deadline. Existing candidate directories and files
cannot be overwritten. Input/code/split manifests, inactive checkpoints, export
parity, calibration and reports all have checksums. The source implementation is
snapshotted before training.

## First bounded result

The inactive candidate `first-cpu-20261121-a` has 799,565 parameters. Training
took 32.0 seconds, with approximately 694 MiB peak observed resident memory.
Epoch four was selected using development F1; the final test was not used for
checkpoint selection or later tuning.

| Test measure | Raw proposals | Calibrated accepted proposals |
| --- | ---: | ---: |
| Exact-span precision | 63.00% | 92.27% |
| Exact-span recall | 71.88% | 34.05% |
| Exact-span F1 | 0.6714 | 0.4974 |
| Proposed / accepted spans | 2,081 | 673 |
| Fraction of raw spans retained | 100% | 32.34% |
| Negative utterances with any false span | 145 | 5 |

| Label | Raw exact-span F1 | Accepted precision | Accepted recall |
| --- | ---: | ---: | ---: |
| `date` | 0.7939 | 92.28% | 69.51% |
| `place` | 0.5826 | 92.22% | 18.65% |
| `time` | 0.6245 | No accepted spans | 0% |
| `time_of_day` | 0.7200 | No accepted spans | 0% |
| `time_zone` | 0.0000 | No accepted spans | 0% |
| `news_topic` | 0.2924 | No accepted spans | 0% |

Arabic raw F1 was 0.6287 and English raw F1 was 0.7148. Among accepted spans,
Arabic precision was 91.59% with 32.41% recall, and English precision was 92.90%
with 35.66% recall. Full label-by-language counts remain in the immutable report.

Calibration supported only date/place thresholds. All other labels abstained;
thresholds were not relaxed to raise test coverage. Even the accepted subset
contains 52 incorrect spans, so source-bound offsets and high confidence do not
establish semantic correctness. The candidate remains inactive. This experiment
did not measure the current application's word-rule baseline and establishes no
claim of an application-level improvement over that baseline.
