# Inactive date/place-only slot development

This second OWN experiment uses only the existing local public MASSIVE 1.1
Arabic/English annotations. It does not use owner conversations, assessment
fixtures, pretrained weights, providers, network or any application data. The
original trainer, first candidate, calibration, TypeScript bridge and application
remain unchanged.

The first candidate's calibration accepted only date/place. This development
experiment therefore defines those two supported tasks explicitly, without
choosing an objective from individual test mistakes. All other original slot
annotations become `O`; this is not a generic topic, time or reasoning model.

## Frozen data and predeclared candidates

The first manifest and grouped row membership are reused exactly, rather than
resampling or rerunning hygiene against later outcomes. Translation IDs remain
grouped and official train/test boundaries remain fixed. Assignment SHA-256:
`33289c6b14a6611535e081c31cb250ee74611cc7303c38f2b660aebd1bde1642`.

| Partition | Rows | Date spans | Place spans |
| --- | ---: | ---: | ---: |
| Train | 9,426 | 3,498 | 1,941 |
| Development | 840 | 324 | 164 |
| Calibration | 822 | 296 | 178 |

The unchanged final test contains 2,214 rows. Its date/place labels and utterances
are processed for evaluation only after an immutable selection record exists.
Raw public files, including test bytes, are hashed for integrity. Test row/split
metadata is already present in the frozen manifest. Accordingly, this experiment
claims that test outcomes are excluded from selection, not that every test byte
was unread. The public test is not sealed and the baseline has evaluated it before.

All three candidates are fixed before training, share seed 53, 32,768 hash buckets,
24 embedding dimensions, six shape flags, Adagrad learning rate 0.03, batches of
64 and a request for five epochs:

| Candidate | Bidirectional GRU hidden size | Training class weighting |
| --- | ---: | --- |
| `target32-cap3` | 32 | Square root of `O` count / tag count, capped at 3 |
| `target48-cap3` | 48 | Same capped weights |
| `target48-uniform` | 48 | Uniform |

There are five BIO tags: `O`, `B-place`, `I-place`, `B-date`, `I-date`. Exact source
tokenization, literal alignment, codepoint/UTF-16 offsets and legal BIO decoding
follow the frozen public-data helper. No global labels or functions in that helper
are modified. An independent NumPy forward pass checks exported model parity.

## Selection and final comparison

Each checkpoint maximizes development macro exact-span F1 over date/place. The
calibration partition alone chooses from the original temperature grid
`0.5, 0.75, 1, 1.5, 2, 3`. Each label's acceptance threshold must have at least
20 calibration proposals and a 95% Wilson precision lower bound of 90%; lack of
sufficient evidence causes that label to abstain entirely.

The winning candidate is chosen by this fixed order:

1. Number of labels supported by calibration.
2. Calibration macro recall over date/place.
3. Development macro exact-span F1.
4. Smaller parameter count.
5. Candidate ID as a deterministic final tie-break.

Calibration metrics are used for candidate selection, so they are development
evidence and can be optimistic. The immutable selection binds the plan, model
metadata, weights, calibration and selection-report hashes. A single-use final
evaluation reservation is written before test inference. Unselected candidates
are never evaluated on test.

Only the chosen model gets one cached test inference. Raw and accepted metrics
reuse that same cache. The baseline's previously cached predictions are read
after selection and filtered to the identical date/place gold and predictions.
This avoids comparing a new two-label recall denominator with the original
six-label headline recall of 34.05%. Per-slot and per-language results, accepted
coverage and remaining errors must all be reported.

Paired confidence intervals use 2,000 percentile bootstrap samples of translation
groups, keeping both languages together. They describe sampling uncertainty for
this fixed selected model on this public split, not model-seed variability,
selection uncertainty or general task success. Exact-utterance paired counts are
also retained. A confidence interval crossing zero is not evidence of a reliable
gain.

## Resource and artifact boundaries

The orchestrator has a real 600-second watchdog. It terminates its active worker
and exits at the total deadline, including preprocessing, selection and final
evaluation. Each candidate worker has a 150-second parent wall timeout, a
120-second training-loop budget and at most four CPU threads. The parent polls
RSS and terminates above 2 GiB when measurement is available; training also checks
observed process memory. Reports retain actual epochs, full/partial epochs,
timeouts, elapsed time and observed RSS instead of substituting budget targets.

New directories under `artifacts/brain-slot-date-place-development-v2` are created
exclusively. Sources and plans are captured before training. Weights are flat
little-endian float32 with strict tensor geometry, finite-value bounds and hashes.
The new format is `mohassan-slot-date-place-gru-v2`: its five-tag contract is
deliberately incompatible with the frozen thirteen-tag TypeScript bridge.
Artifacts are inactive and have no application import or activation path.

```powershell
& '.venv-execution/Scripts/python.exe' -I scripts/router/test_train_slots_date_place.py
& '.venv-execution/Scripts/python.exe' -I scripts/router/train_slots_date_place.py prepare --run-name unique-prepare-name
& '.venv-execution/Scripts/python.exe' -I scripts/router/train_slots_date_place.py run --run-name unique-training-name
```

Preparation and training run names cannot be reused. A stopped or failed run is
preserved for review. No settings are changed after observing its final test.

## First completed result

Immutable run: `first-three-cpu-20261121-b`. The fixed selection rule chose
`target48-cap3`. All candidates completed five full epochs and selected epoch
five. The uniform-loss candidate had the highest development macro F1 (0.7999)
but calibration could not support place precision, so it lost to the two-label
candidate as predeclared. The winner had development macro F1 0.7730 and
calibration macro accepted recall 0.5492. No unselected candidate was run on test.

The final test has 1,219 date/place gold spans in the same 2,214 rows:

| Fixed target-only measure | Frozen baseline | New candidate |
| --- | ---: | ---: |
| Raw exact-span precision | 66.79% | 70.64% |
| Raw exact-span recall | 77.03% | 79.74% |
| Raw exact-span F1 | 0.7154 | 0.7491 |
| Accepted exact-span precision | 92.27% | 93.76% |
| Accepted exact-span recall | 50.94% | 57.92% |
| Accepted exact-span F1 | 0.6564 | 0.7160 |
| Correct accepted / incorrect accepted | 621 / 52 | 706 / 47 |
| Missed gold spans | 598 | 513 |
| Accepted proposals | 673 | 753 |
| Accepted fraction of raw target proposals | 47.87% | 54.72% |

| Accepted label/language | Baseline precision / recall | Candidate precision / recall |
| --- | ---: | ---: |
| Date | 92.28% / 69.51% | 93.48% / 75.97% |
| Place | 92.22% / 18.65% | 95.16% / 26.52% |
| Arabic | 91.59% / 48.43% | 92.47% / 56.67% |
| English | 92.90% / 53.43% | 95.01% / 59.15% |

The paired 1,107-group bootstrap gives recall improvement +6.97 percentage
points, 95% interval [+5.07, +8.89], and F1 improvement +0.0596, interval
[+0.0422, +0.0771]. The precision difference +1.48 points has interval
[-0.61, +3.59], so a reliable precision gain is not established. Exact-utterance
comparison corrected 106 former failures and introduced 39 regressions.

The winner has 809,957 parameters, 3,239,828 weight bytes and independent NumPy
maximum logit difference 0.0000023842 with identical decoded paths. Temperature
and label thresholds are stored unchanged from calibration; no test adjustment
was made. Place still misses roughly three quarters of its gold spans and the
accepted output still contains 47 errors. These results do not justify activation.

The completed run took 150.9 seconds overall. Candidate parent wall times were
43.0, 46.6 and 52.8 seconds, with training-loop times 33.7, 37.2 and 41.3 seconds.
Observed actual-worker RSS peaks were approximately 646.8, 652.6 and 655.2 MiB.
No time or memory limit fired.

A provisional `first-three-cpu-20261121-a` used train/development/calibration for
modeling and was stopped before selection or final test (raw test bytes and
frozen metadata were still touched for integrity as described above):
Windows' virtualenv launcher exposed its own small RSS rather than the actual
PyTorch worker and would not provide reliable kill semantics. It is preserved
with an interruption record. The launch path was corrected to the actual
interpreter plus the same reviewed virtualenv packages. An OS-backed test checks
PID identity, measured allocation and direct worker termination. The repeated
first candidate had bit-identical weights, and no candidate settings changed.
The provisional run, resource fix and completed replacement together remained
under the approved ten-minute experiment window.

`first-three-cpu-20261121-b-analysis-a` independently recomputes raw/accepted
target-only metrics and confidence histograms from the already fixed cached
predictions. It performs no additional model inference. The original first
candidate, thirteen-tag bridge and runtime remain unchanged and inactive.
