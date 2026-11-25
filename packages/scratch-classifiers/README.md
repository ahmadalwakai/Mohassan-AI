# Scratch classifiers

This workspace package trains four independent CPU classifiers for refusal and scope, small talk, routing, and follow-up. The published JSON heads contain 16-bit linear weights. The Node server verifies their SHA-256 pins at startup and scores the heads together using shared character and word features.

## Training and tests

Use Python 3.12 and install the pinned numeric dependencies from the repository root. The trainer downloads the pinned corpora into its local cache, verifies their digests, then prepares the splits, trains both candidates, calibrates the selected models, and writes the weights and evaluation reports with seed `20261125`.

```sh
python3 -m pip install -r packages/scratch-classifiers/requirements.txt
python3 packages/scratch-classifiers/train.py
```

Use `--cache` to supply a local download directory and `--output` to compare a repeat run without overwriting the packaged outputs. The source licenses and Mohassan label mapping are in the [data card](DATA-CARD.md). The selection, calibration, and metric definitions are in the [model card](MODEL-CARD.md). The full test metrics, per-class support and recall, and calibration coverage are in [metrics.json](models/metrics.json).

The [capability benchmark report](CAPABILITY-BENCHMARK.md) records development and sealed application results for both flag settings.

```sh
python3 -m unittest discover -s packages/scratch-classifiers -p test_prepare_data.py -v
(cd packages/scratch-classifiers && python3 -m unittest training.test_linear -v)
npm test -- packages/scratch-classifiers/src tests/assistant-scratch-decisions.test.ts
```

## Server operation

`MOHASSAN_SCRATCH_CLASSIFIERS=1` enables decisions from the heads. With the flag unset or `0`, the server uses the existing rule decisions and still emits one `scratch_classifiers` JSON record per scored routing decision outside Vitest. The record contains rule labels, model top-k scores, abstentions and selected labels. It contains no current or previous message text. Missing or invalid artifacts make the server fall back to rules.

The server keeps explicit tool, account, privacy, source and pending-question checks. Learned replies use the existing fixed reply and capability paths. Recognized factual lookups retain their search path. The route head can select news from an unstructured nominal fallback or supply writing, reminder, or chat on an unresolved routing fallback. Learned refusals can resolve those unstructured nominal or unresolved fallbacks. Follow-up decisions use the previous host-persisted topic and the existing reference resolver and public-query checks. This previous topic can differ from the verbatim previous question used for CANARD training. Bounded inference discards text beyond its feature limit. The server leaves decisions on longer requests to the existing rules.
