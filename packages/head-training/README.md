# Mohassan head training kit

يدرّب هذا المسار رؤوسًا صغيرة على جذع موحسن v5 المحلي. تبدأ التجربة بنسخة مجمّدة من
الجذع. يتعلّم كل رأس اختيار فئة أو ترتيب خيارات موجودة. تبقى ترقية النتائج بيد المالك
بعد مقارنة مستقلة مع القواعد على مجموعة مختومة.

The kit reads the pinned 85M trunk and its own tokenizer from the existing
execution packages. It trains classifications with a linear projection on the
last token, or uses a shared token projection for pairwise ranking and sentence
or span selection. For a span task, the caller supplies candidate spans and the
head scores their end markers. The trunk is frozen by default. Optional LoRA
uses the existing adapter implementation with a ceiling of 600,000 parameters.

- [Public dataset cards and licenses](DATASETS.md)
- [Partitions, sealed receipt and gate runner](GATES.md)
- [Development plan §4](../../docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md)

## Run on the owner's PC

Run these commands in PowerShell from the branch checkout root. Use the existing
`.venv-execution` and its PyTorch 2.10 CUDA wheel. The TyDi loader needs PyArrow.

```powershell
$python = '.\.venv-execution\Scripts\python.exe'
New-Item -ItemType Directory -Force .data | Out-Null
& $python -m pip install -r packages/head-training/requirements.txt
Copy-Item packages/head-training/pc-schedule.example.json .data/head-training-schedule.json
& $python packages/head-training/run.py schedule --config .data/head-training-schedule.json --output artifacts/head-training/v5-first
```

The dry run reads readiness and configuration only. Exit status 2 means the
GPU or v5 blocked the run. Use `prefetch` while v5 runs to download public files
and verify their pins on CPU if you want them cached before your GPU slot.

```powershell
& $python packages/head-training/run.py prefetch --config .data/head-training-schedule.json
& $python packages/head-training/run.py schedule --config .data/head-training-schedule.json --output artifacts/head-training/v5-first --execute
```

Execution polls until the foundation is `completed` or `early_stopped`, the
shared `.data/gpu.lock` is clear, and the v5 assessment and `selected/best.pt`
have been published. A paused v5 run keeps the kit waiting. `--no-wait` turns
waiting into a one-shot readiness check, and `--poll-seconds` sets the interval.
Supplemental paths in `v5_status_paths` let a local installation declare other
v5 trainers it needs to track. A present lock blocks even if the recorded process
has disappeared. The scheduler stops at the first failed job and releases the
lock it acquired. Each run uses a fresh output directory and writes a scheduler
report plus per-head manifests containing the command, times, hashes, counts,
development loss and calibration metrics.

Run on AC power. The CUDA path reuses the pinned trainer's memory and speed
guard and runs one head at a time. Defaults are a microbatch of 2, up to 512
tokens, 8 accumulation steps and CUDA mixed precision. Keep a smaller batch or
context for larger adapter experiments. A starting learning rate for LoRA is
`0.0003`. GPU throughput and peak memory depend on
the owner's checkpoint and hardware. For a tiny CPU run, set `device` to `cpu`
and provide an explicit `trunk` object containing `checkpoint` and `tokenizer`
pins. Each pin is `{ "path": "...", "sha256": "..." }`. When present,
`tokenizer-report.json` beside `tokenizer.json` needs a `tokenizer_report` pin.
The PC scheduler still observes the owner's shared v5 lock and status on CPU.

## Configure supervision

Schedule paths resolve relative to the configuration file. The default cache is
`.data/head-training/datasets` in the checkout. The example is a training run for
public tasks. Public route domains, dialogue labels and answerability are
proxies. They do not supply the deployed router's 14 classes, the production
conversation taxonomy, or labels over actual H4 evidence. Select separate jobs
for incompatible public taxonomies. Tune `training` with `seed`, `epochs`,
`batch_size`, `accumulation`, `learning_rate`, `patience` or `mixed_precision`.
Each classification job can set the exact ordered `labels`. All labels must
appear in fitting material. For a source with an explicit `label_map`, map each
source label to a target label or `null` to drop it. A route job can also use
`"task": "intent"` in a source and map intents to routes. The B0 mappings in
`scripts/router/train.py` provide a starting point for reviewing MASSIVE, and
owner-reviewed examples can cover the routes that are missing from public data.
The historical B0 run used a spent sealed set, so its reported 72.1% versus
45.9% for the rules is context for the new independent gate.

Owner-labelled sources use `{"labelled": <rows pin>, "card": <approval pin>}`.
The card records `source`, `license`, `download_date` (ISO date), `consent`,
`reviewer`, `origin` (`human`), `decision` (`approved`) and `sha256` (of the
JSONL). Keep private files in ignored local storage. Each JSONL row supplies
`id`, `group`, `language`, `text` and either `label` or `candidates` with `gold`
(zero-based indices). `history` is an optional sequence of prior turns or
retrieved evidence. `split` is `train`, `dev`, `test` or `unsplit`. Reuse a
`group` for examples from the same conversation, original document or template.
For H5, put the actual H4 evidence shown in `history` and use the owner's
human sufficiency verdict as `label`. The training code omits a row when its
full evidence would be truncated. For H3, H6 and H7, configure `slots`,
`retrieval` or `ads_pointer` jobs with reviewed candidate labels.

For PR #15 source lineage, set `corpus_lineage` with `checkout`, `manifest` and
`review` paths. The verifier records the reviewed corpus and shard pins. For
PR #16, add `gate` with `sealed_reference`, a pinned `baseline`, and optionally
`max_ece` and a `rule` for pre-registered minimum counts or Wilson bounds.
Read the [evaluator handoff](GATES.md) for the separate owner and evaluator steps.
If an independent sealed receipt arrives after fitting, put the `gate` settings
in the schedule and use `run.py register-gate --config ... --job ... --manifest ...
--manifest-sha256 ... --output ...`. The manifest digest is in
`scheduler-report.json`. Exclusions for public groups belong in the sealed
receipt before fitting.

## Consume an export

Each head exports a `worker.json` and a `sidecar/` containing pinned weights and
metadata. The run also writes a shared `model-worker.json` for all heads on the
unchanged trunk. A LoRA head has its own config and derived trunk file, because
the resident worker loads one trunk per process. Keep the files and resolved
paths available to the worker. All generated configurations default to CPU.

Send `classify` for class heads or `select` for pointer heads through the
persistent worker's dense token-ID interface. Load the pinned tokenizer with
`execution_pipeline.pretrain.TextEncoder`. Call
`head_training.encoding.encode_input` with the text, history, candidate list
and the `max_tokens` and `eos_token_id` from the head manifest. Its
`worker_payload()` produces `inputIds` and, for pointer heads, `candidatePositions`.
Pass the raw `logits` or `scores` to `head_training.calibration.decide` with
`manifest["inference"]["calibration"]`. Use `manifest["inference"]["labels"]`
for a class index or `HeadInput.candidate_indices` for a pointer index. A missing
index means use the rules. Keep the same input content and candidate order for
both arms of a gate. Pairwise and selection heads are both exported as pointer
sidecars. [Permanent worker PR #19](https://github.com/ahmadalwakai/Mohassan-AI/pull/19)

The calibration record uses the `temperature`, `minConfidence` and `minMargin`
fields documented in PR #29. Its existing shadow callers use the language
model's `score-options` operation. Learned dense sidecars use `classify` or
`select`, so those callers need an adapter before they can use this kit's
artifacts. Gate packages for the learned heads are independent of the existing
`own-model.*` IDs. [Own-model provider PR #29](https://github.com/ahmadalwakai/Mohassan-AI/pull/29)

## CPU verification

From the checkout root with the pinned torch, pytest, mypy and Ruff installed,
run the following. For parity against both upstream worker revisions, fetch
`refs/pull/19/head:refs/remotes/origin/pr/19` and
`refs/pull/29/head:refs/remotes/origin/pr/29` from `origin` first. Parity checks
read the worker files from the fetched refs into temporary directories.

```sh
python -m pytest -q -c packages/head-training/pyproject.toml packages/head-training/tests
python -m mypy --config-file packages/head-training/pyproject.toml packages/head-training/head_training packages/head-training/run.py
python -m ruff check packages/head-training
```
