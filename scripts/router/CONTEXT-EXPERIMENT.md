# Isolated context-router development experiment

This experiment trains Mohassan-owned weights from scratch on CPU. It does not
change `artifacts/router`, application routing, provider configuration or model
activation. Its format is deliberately separate from the current B0 format.

`train_context.py` reads exactly these default inputs:

- `.data/router/download/1.1/data/ar-SA.jsonl`
- `.data/router/download/1.1/data/en-US.jsonl`
- `scripts/router/data/context-training-v1.jsonl`

The first two files are the public Amazon MASSIVE 1.1 dataset (CC BY 4.0). The
third is reproducibly generated, agent-authored synthetic development data. Its
labels have **not** been reviewed by a human. Production conversations, owner
messages, existing router weights and the separate brain assessment fixtures
are not inputs. The old trainer is not imported or invoked.

## Data and split policy

MASSIVE translation pairs share their original ID and remain in the same
partition. Official train/test partitions are preserved. Original development
IDs are split deterministically into development and calibration groups.

Authored semantic families include translations, courtesy variants, unrelated
prior-state controls and pending-question controls. All members of a family
have one predeclared partition. Matching current utterances with different prior
sources are also grouped together.

Canonical current-text collisions across partitions exclude every implicated
family. Identical text/context features with conflicting labels also exclude
their families. No heldout record is moved into training. Every exclusion and
remaining class/source/locale count appears in the immutable manifest. Public
route caps preserve entire translation groups.

Authored test data is a development holdout; it is not sealed or human-validated.
The first comparison is predeclared as text-only versus context-aware. Once its
test results have been inspected, that test must not be represented as unseen in
later experiments.

## Model and host boundary

Both candidates use hashed current-text character 2/3/4-grams and word features,
a mean embedding and a small nonlinear classification head. The context model
also receives separate whitelisted previous-route, previous-source, scope and
pending-field indicators. Row IDs, family IDs, partition, provenance and target
labels are never input features.

`reply` is excluded from the learned route classes. A deterministic host gate
recognizes bounded answers to a pending question, with explicit new requests and
calculations taking precedence. A routing reply never grants approval or action
authority. Capability, source and permission checks remain the host's job.

Checkpoint selection uses development data only. Temperature and abstention
threshold selection use the separate calibration partition. Threshold acceptance
requires a 95% Wilson upper error bound within the configured target; if no
threshold qualifies, the learned model abstains completely. Exact routing,
selective accuracy, coverage, per-class performance and private-to-public errors
are reported separately. Confidence error bins exclude host-routed replies.

## Reproduction

From the repository root, using the existing local Python environment:

```powershell
& '.venv-execution/Scripts/python.exe' -I scripts/router/test_train_context.py
& '.venv-execution/Scripts/python.exe' -I scripts/router/train_context.py prepare --run-name unique-prepare-name
& '.venv-execution/Scripts/python.exe' -I scripts/router/train_context.py train --run-name unique-train-name --threads 4 --epochs 6 --max-seconds-per-model 180
```

The default model has 65,536 hash buckets and 32 embedding dimensions. The CPU
thread count is limited to four. Training has a per-model wall-clock loop budget
and checks process resident memory against a maximum 2 GiB target between
batches. Preparation, calibration, reporting and export also consume time;
the configured training-loop budget is not an operating-system process deadline.

## Artifacts and independent checks

Every run creates a new directory under
`artifacts/router-context-development-v1`. Existing run directories and files
cannot be overwritten. The manifest records input hashes, group/row hashes,
fixed split assignments, configuration and data provenance. Training runs add
inactive checkpoints, raw little-endian weights, explicit layout metadata,
calibration, detailed reports and checksums.

Export parity is checked independently through NumPy inference over the raw
binary layout. Unit tests cover grouping and duplicate exclusions, bounds,
determinism, train/test separation, host reply precedence and export integrity.
No runtime adapter or activation path is installed by this experiment.

## First bounded development run

`first-cpu-20261121-a` used 9,536 training rows, 1,848 development rows,
1,808 calibration rows and 2,840 test rows. Canonical cross-partition collisions
and identical-feature label contradictions excluded 1,188 whole groups. Both
models used six epochs, with epoch five selected using development accuracy.

| Measure on the development test | Text only | Context aware |
| --- | ---: | ---: |
| Raw exact route accuracy | 73.03% | 73.59% |
| Macro F1 | 0.577 | 0.610 |
| Selective coverage | 62.08% | 62.46% |
| Accuracy among accepted routes | 91.72% | 90.64% |
| Accepted private-to-public errors | 9 | 11 |
| Agent-authored rows correct | 171 / 404 | 192 / 404 |
| Public MASSIVE rows correct | 1,903 / 2,436 | 1,898 / 2,436 |

Training took 16.7 seconds and 15.8 seconds respectively. Peak observed resident
memory was 654 MiB and 687 MiB. The small raw/macro improvement did not improve
selective accuracy or private-source protection. **Neither candidate qualifies
for activation.** A learned confidence threshold must not replace host source and
permission boundaries.

The paired comparison had 145 cases correct only for text-only and 161 correct
only for context. The two-sided exact McNemar p-value was 0.391; this experiment
does not establish a reliable overall routing improvement.

The first run's source snapshot is preserved separately in
`first-cpu-20261121-a-source-a`, explicitly marked as captured after the run. The
pipeline subsequently gained automatic pre-training source snapshots for future
runs; the original candidate and its checksums were left unchanged. No second
training run was performed after examining this test.
