# Mohassan model runbook

هذا الدليل لتشغيل نماذج موحسن المحلية وفحصها على ويندوز ولينكس. يعرض
`npm run models:list` حالة كل نموذج. ظهور `absent` طبيعي عندما تكون الأوزان
موجودة على جهاز المالك فقط. مدير العلاقات يعمل في وضع الظل افتراضيًا ويحفظ
قرارات المقارنة دون نص المحادثة أو تغيير الرد. يبقى قفل `.data/gpu.lock`
ملكًا للعملية التي أخذته.

## Run from the checkout root

Install the workspace dependencies with Node 24 and the repository lockfile.
The same npm scripts run in PowerShell and a Linux shell. They use environment
variables exported by the shell. Python models also need the project's local
execution environment with PyTorch and dependencies for the corresponding
checkpoint. Set `EXECUTOR_PYTHON` if that environment lives elsewhere.

| Setting | Windows default | Linux default |
| --- | --- | --- |
| Permanent inference interpreter | `.venv-execution/Scripts/python.exe` | `.venv-execution/bin/python` |
| Permanent worker configuration | `.data/model-worker.json` | `.data/model-worker.json` |
| Permanent worker device with `model.device` omitted | `cpu` | `cpu` |

The commands for a registry ID are the same on both systems.

```text
npm run models:list
npm run models:health
npm run models:health -- <model-id>
npm run models:run -- <model-id> <input.json>
npm run models:latency -- <model-id> <input.json> [iterations]
```

The list shows each model's artifact paths, available SHA-256 pins,
contracts, budgets and state. Missing required files give the model the
state `absent`. The other states describe the model's intended use
when present. Health loads or warms a candidate with
its own loader. A check of the whole inventory reports absent files in JSON
and continues. A check of one model exits nonzero if that model cannot run.
Run and latency expect a JSON file up to 1 MiB and report non-success as a
structured result when it comes from the runtime. Use `npm run -s` in place
of `npm run` if piping the JSON to another command. Latency includes one
cold invocation and defaults to 20 warm calls on the same input, with a
median and nearest-rank p95 in milliseconds. The samples exclude process
startup and input-file reading.

The runtime defaults to a 4,608 MiB model reservation budget, two CPU
inference slots, one concurrent heavy inference, and unload after 60 seconds
idle. Each registered model has its own request budget.

Run the standalone refusal classifier with an example input. In PowerShell,
use the owner's normal project checkout.

```powershell
$probe = [System.IO.Path]::GetTempFileName()
'{"text":"What is the time?"}' | Set-Content -Encoding utf8 $probe
npm run models:health -- refusal
npm run models:run -- refusal $probe
npm run models:latency -- refusal $probe 20
```

On the Linux VM, use the same commands with a shell-created file.

```sh
probe=$(mktemp)
printf '%s\n' '{"text":"What is the time?"}' > "$probe"
npm run models:health -- refusal
npm run models:run -- refusal "$probe"
npm run models:latency -- refusal "$probe" 20
```

### Local artifacts

For files under `artifacts/` or `.data/`, get the exact checkpoint, tokenizer,
sidecar and manifest from the owner's corresponding run or approved deployment
copy. Keep those files with their recorded lineage. Match the registry pin,
export manifest or worker configuration as applicable before running
inference. Use `Get-FileHash -Algorithm SHA256` on Windows or `sha256sum` on
Linux to compare a local file with a documented digest. A gate receipt that lives
in an ignored run directory needs the corresponding owner copy.

If an artifact is absent, continue with the existing rules and report the
missing registry ID. Restore a tracked artifact from the same commit or copy
an approved owner export to the path listed by the registry, then rerun
`models:health -- <model-id>`. Restore all required files from the same
export. An incompatible or invalid artifact needs a matching verified
configuration. For GPU jobs, the permanent worker reserves `.data/gpu.lock`
and rejects an existing lock. Use CPU inference while that lock is held.

## Observe model relations

`MOHASSAN_MODEL_RELATIONS` defaults to `shadow`. Set it to `off` to disable
the manager. The published turn follows the existing application policy.
That includes the existing scratch and refusal switches when enabled.

The observer sees the finished turn and any evidence the product already
retrieved. It compares refusal, speech act and route first. Its proposed
route gives precedence to standalone refusal, scratch refusal, small talk,
B2, B0 and scratch routing, in that order where each produces a candidate.
The host's refusal and small-talk decisions take precedence for the
published answer. The proposed route and turn type can feed a shadow
rewrite, then a sufficiency test and sentence selection over the available
evidence, then the rule reply judge. Missing, incompatible, unavailable or
timed-out models leave the existing rule values in place.

Each turn appends one row to `.data/model-relations-shadow.jsonl`. It records
the selected rule result, model outcomes, fixed categorical labels, keyed
hashes, and elapsed times. The per-process hash key limits cross-process
correlation. `schedulingMs` measures synchronous scheduling work at the
publication hook. `elapsedMs` measures asynchronous manager work. To count
disagreements across the file, run the following from the workspace root.

```text
npm run models:shadow-summary
npm run models:shadow-summary -- <copied-log.jsonl>
```

The disagreement rate divides disagreements by calls that returned a
value comparable to the rule output. A model with zero comparable calls
has a null rate. Considered calls include stages that reached their time
budget before dispatch. Fallback counts include abstentions and runtime
errors.

The server observer keeps heavy shadow inference idle while the existing
resident worker or local executor experiment is enabled. It records these
attempts as busy. The explicit CLI uses its own runtime. Each heavy model
warms on demand, and switching between heads may cause a cold load. With
a tight turn budget, the later shadow stages can fall back while a new
worker starts.

## Models

Use the ID and input contract from `models:list` with the health, run and
latency commands above. All model-specific settings below are application
defaults unless described as a registry setting. An explicit local CLI run
leaves product flags at their current values.

### Chat trunk and v5 heads

The v5 foundation selection lives under
`artifacts/execution-model-runs/text-b5-2026-11-23/selected/`. The assessment,
trainer status and selection manifest bind `best.pt` to its tokenizer and
tokenizer report. A later dialogue checkpoint has its own lineage. Keep the
approved checkpoint pin and vetted tokenizer together. [Chat model plan](CHAT-MODEL-TRAINING-PLAN.md)

The head training kit publishes `worker.json`, `sidecar/sidecar.json` and
`sidecar/weights.pt` for each head. A schedule can also publish one
`model-worker.json` for heads on the same trunk. Use the separate config
for a LoRA-derived trunk. The worker validates the sidecar's trunk pin, and
the declared registry trunk version must also match. Keep the original
worker configuration and manifests byte-for-byte when copying from Windows
to Linux. The runtime verifies those pins and resolves the local artifact
paths before starting the worker. Pass `text` and optional
`history` to classification heads. Include `candidates` in order for a
selection head. The runtime uses the same tokenizer, maximum length and EOS
ID as the head kit. For a pre-encoded classification input, send `inputIds`.
For a pre-encoded selection input, add `candidatePositions`. [Head
worker payload and calibration](../packages/head-training/README.md#consume-an-export)

| Model family | Run input and healthy response |
| --- | --- |
| `chat-v5` | A bounded generation request with `inputIds` and `maxNewTokens`, or `text` with a pinned text tokenizer. The response includes token IDs and a stop reason. A worker with an options head also accepts `operation: "score-options"` with a prompt and tokenized options. |
| `head-clinc-intent`, `head-massive-intent`, `head-clinc-domain`, `head-massive-scenario` | Class requests for H1 intent and route experiments. The configured label order interprets the returned logits. |
| `head-out-of-scope`, `head-speech-act` | Class requests for the related out-of-scope and speech act jobs. |
| `head-follow-up` | An H2 class request with prior turns encoded by the kit. The returned class index refers to the exported taxonomy. |
| H3 slots | The kit defines a slot selection task. The example schedule publishes no slot artifact. See the separately trained Node slot taggers below. |
| `question-edit` | The kit's `rewrite` job selects a candidate edit. The product's existing question rewriter uses maintained rules, with live use controlled by `MOHASSAN_QUESTION_REWRITER=1` (default off). [CANARD data card](QUESTION-REWRITER-CANARD.md) |
| `head-answer-sentence` | An H4 selection request over candidate sentence positions. The selected index maps to a supplied sentence. |
| `head-sufficiency` | An H5 class request with the evidence encoded as history. The result identifies the configured sufficiency class. |
| H6 retrieval | The kit defines a passage selection task. The example schedule publishes no H6 artifact. See the historical retriever below. |
| H7 Ads pointer | The kit defines a campaign field selection task. The example schedule publishes no H7 artifact. See the two separately trained Ads models below. |

`MOHASSAN_MODEL_WORKER=1` starts the resident application worker at server
startup and defaults off. `MOHASSAN_MODEL_WORKER_CONFIG` selects the config
described above. The CLI opens a worker on demand. For the separate existing
provider, `own-model-provider.json` beside the worker config binds each
capability to its own passed receipt. With that file or its pins missing, the
capability is off. For a configured server, `GET /health` reports the running
worker's state. [Worker configuration and limits](../packages/execution-integration/docs/permanent-model-worker.md) · [Provider gates](OWN-MODEL-PROVIDER.md) · [Head data and licenses](../packages/head-training/DATASETS.md) · [Head gates](../packages/head-training/GATES.md)

To check an approved CPU worker configuration with an explicit interpreter
and config path, use the commands for your shell. Both need the owner's v5
artifact and a configuration that pins it.

```powershell
$env:EXECUTOR_PYTHON = '.venv-execution/Scripts/python.exe'
$env:MOHASSAN_MODEL_WORKER_CONFIG = '.data/model-worker.json'
npm run models:health -- chat-v5
```

```sh
EXECUTOR_PYTHON=.venv-execution/bin/python \
  MOHASSAN_MODEL_WORKER_CONFIG=.data/model-worker.json \
  npm run models:health -- chat-v5
```

### Execution model

The `execution`, `execution-c9m`, `execution-b` and `execution-a` inference
exports are published by the
execution packages under `artifacts/execution-model-runs/`. The local lab
selects `exec-c40m-2026-11-12` unless overridden. Its report records the
earlier A, B and C9M candidates and the failed promotion measurements for
C40M. Use the exported `manifest.json`, `weights.pt`, `config.json` and
`tokenizer.json` together. The product execution experiment has a separate
task schema and evaluation receipt. The registry uses the resident worker
interface. Supply `inputIds` and `maxNewTokens` to inspect pinned local
inference. [Model report](EXECUTION-MODEL-REPORT-2026-11-12.md) · [Inference export format](../packages/execution-model/docs/checkpoints.md)

| Existing execution experiment setting | Default |
| --- | --- |
| `EXECUTOR_EXPERIMENT` | Unset. The local lab sets `uncontained-local` outside production. |
| `EXECUTOR_CHECKPOINT` | Unset. The local lab uses `artifacts/execution-model-runs/run-2026-11-12-c/inference-train-40m`. |
| `EXECUTOR_REGISTRY_ENTRY` | Unset. The local lab uses `artifacts/execution-model-runs/registry/exec-c40m-2026-11-12.json`. |
| `EXECUTOR_EVALUATION_REPORT` | Unset. The local lab uses `artifacts/execution-model-runs/run-2026-11-12-c/evaluation/report.json`. |
| `EXECUTOR_PYTHON` | Legacy experiment defaults to the Windows interpreter path on both OSes. Export the Linux interpreter path as shown above if using that experiment on Linux. |
| `EXECUTOR_DEVICE` | `cpu`, including the registry's execution configuration. |
| `EXECUTOR_STARTUP_TIMEOUT_SECONDS` | `90`. |
| `EXECUTOR_REQUEST_TIMEOUT_SECONDS` | `60`. |
| `LOCAL_MODEL_URL` | Unset. Keep it unset for this workflow. |

### Router and scratch classifiers

| Model | Artifact source and settings |
| --- | --- |
| `router-b0` | The owner export from `scripts/router/export.py` contains `artifacts/router/router-b0.json` and `router-b0.bin`. App shadow routing defaults on outside production and Vitest when the export exists. Set `MOHASSAN_ROUTER_SHADOW=0` to turn that observer off. |
| `router-b1` | Historical `artifacts/router/router-b1.pt` from `scripts/router/train.py`. It was rejected on development results and is recorded for audit. Its native checkpoint needs the original experimental architecture. |
| `router-b2` | Use the `router-b2.json` and `router-b2.bin` pair from the selected export under `artifacts/router-b2/`. This is an experimental CPU model. B0 remains the app's existing shadow router. |
| `router-context-text`, `router-context-history` | Use the owner comparison export and report from `scripts/router/train_context.py`. These artifacts are recorded for audit. With their files installed, the CLI reports `unsupported` because their offline architecture needs a different inference adapter. [Experiment and export format](../scripts/router/CONTEXT-EXPERIMENT.md) |
| `scratch-route`, `scratch-refusal`, `scratch-speech-act`, `scratch-follow-up` | Checked-in JSON heads and manifest in `packages/scratch-classifiers/models/`. The runtime validates the manifest and model pins. `MOHASSAN_SCRATCH_CLASSIFIERS` defaults off and `1` enables existing guarded product decisions. |
| `refusal` | Checked-in `apps/server/src/assistant/refusal/learned-model.json`. `MOHASSAN_REFUSAL_POLICY` defaults off and `1` enables the existing policy. The CLI scores the learned artifact. |
| `slot-tagger`, `slot-date-place-tagger` | Use the trained owner exports from the corresponding TypeScript bridge scripts. The loader verifies their identities. The broad tagger also has a synthetic test fixture in the repository. There is no product activation environment variable for these taggers. |

Use the same JSON text input on Windows and Linux for text classifiers.
Scratch's follow-up model also accepts the previous text. Health checks
validate the local artifact and run a small inference probe where supported.
For a disposition of `absent`, the app continues with the existing
rules. [Router plan and results](ROUTER-MODEL-PLAN-2026-11-20.md) · [Scratch data card](../packages/scratch-classifiers/DATA-CARD.md) · [Refusal data and results](../scripts/refusal-classifier/README.md) · [Slot tagger bridge](../scripts/router/SLOT-TYPESCRIPT-BRIDGE.md) · [Date/place bridge](../scripts/router/SLOT-DATE-PLACE-TS-BRIDGE.md)

### Arithmetic ranker

The `arithmetic` artifact is the checked-in
`apps/server/src/assistant/arithmetic-search-model.json`, produced by the
arithmetic expression search trainer. Use `{"text":"..."}` with a local
arithmetic word problem. A
successful run returns a selected expression or an abstention. The existing
solver handles the request when the ranker is unavailable or abstains.
`MOHASSAN_ARITHMETIC_SEARCH` defaults off for product use. [Data card and development evidence](WORD-PROBLEM-SOLVER-DATA.md)

### OCR readers

For `ocr`, `ocr-base` or `ocr-v2`, pass `{"path":"./image.png"}` on either
platform. Copy
`manifest.json` and `weights.bin` from one approved export and
`parity.json` with them for the parity suite. The current app reader resolves
`MOHASSAN_OCR_MODEL_DIR`, default `artifacts/vision/ocr-v1`. On a deployed
VM the copied directory can be `/var/lib/mohassan/ocr-v1`. The app worker
count comes from `MOHASSAN_OCR_WORKERS`, default `3`. The v1 real-page
fine-tune occupies the default export. The original and v2 candidates use
separate paths listed in the registry. Image requests receive the existing
unavailable result when the app reader is absent. [OCR exports and measurements](../scripts/vision/README.md) · [Deployment and rollback](IMAGE-READING-2026-11-22.md)

### Google Ads models

The `google-ads-pointer-lm` model, Ads lab and main-chat pointer use existing
execution model fine-tunes, with the tokenizer beside the selected run. In the registry,
pass the formatted prompt in `text` with `maxNewTokens`, or send
`inputIds` with that limit. The independently trained `google-ads-pointer`
is the GoalTagger checkpoint. Send `text` and check the decoded goal
response from the permanent worker's pointer head.
For an Ads fine-tune, keep the matching tokenizer and prompt framing.
[Goal labelling guide](ADS-GOAL-LABELING-GUIDE.md) · [Pointer comparison and receipts](RESPONSE-QUALITY-RESULTS-2026-11-22.md)

To run the GoalTagger, use a separate owner configuration with
`checkpoint.format` set to `goal-tagger` and the approved checkpoint SHA-256.
Set `MOHASSAN_MODEL_WORKER_CONFIG` to that file in the shell running
`models:health` or `models:run`. [Worker checkpoint formats](../packages/execution-integration/docs/permanent-model-worker.md#configuration)

| Existing Ads lab setting | Default |
| --- | --- |
| `ADS_MODEL_RUN` | Unset for a regular server. Local lab uses `artifacts/execution-model-runs/text-b2-2026-11-12`. |
| `ADS_CHAT_FINETUNE` | `pointer-v3`. |
| `ADS_MODEL_DEVICE` | `cuda` in that legacy lab. Set `cpu` for CPU-only inference. |
| `EXECUTOR_EXPERIMENT` | Unset. The local lab sets `uncontained-local` outside production. |

The registry CLI uses the permanent worker on demand. A config with an
explicit device selects that device. An Ads pointer export opened without
a worker config defaults to CPU unless `ADS_MODEL_DEVICE=cuda` is set. An
absent pointer leaves the existing application route and rules available.

### Historical chat and reading experiments

These entries keep failed or superseded work visible in the inventory.
Their original formats do not have a verified registry inference path.
Use the source and receipt to identify the exact owner copy.

| ID | Artifact provenance |
| --- | --- |
| `chat-v4` | The selected 38M foundation checkpoint under `artifacts/execution-model-runs/text-b4-2026-11-18/stage-3-full/selected/`. It failed the semantic continuation gate. [Chat model plan](CHAT-MODEL-TRAINING-PLAN.md) |
| `reading-v3-last`, `reading-v4-hn-last` | Reading fine-tunes in that v4 run. The original experiment passes a question and a passage and evaluates an extracted answer or abstention. [Context experiment source](../scripts/context-use/run_context_test.py) |
| `reading-abstain-verifier` | The eleven-signal calibrated verifier preserved as `artifacts/abstain-verifier-20261120/verifier.json`. It depends on outputs from the original reader. [Verifier source](../scripts/context-use/abstain_verifier.py) |
| `reading-dense-retriever` | The independent bi-encoder checkpoint under `artifacts/retriever-20261121/`. It uses the v4 foundation encoder and ranked passages did not outperform the baseline on the documented comparison. [Retriever source](../scripts/context-use/retriever.py) · [Results](MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md) |

## Verification on the Linux VM

| Command | Result |
| --- | --- |
| `npm run -s models:list` | Exit 0. Listed 38 models. |
| `npm run -s models:health` | Exit 0. Six checked-in CPU artifacts warmed successfully, and 32 models were reported as absent. |
| `npm run models:health -- refusal` | Exit 0. |
| `npm run models:run -- refusal "$probe"` | Exit 0. The example returned `allow`. |
| `npm run models:latency -- refusal "$probe" 20` | Exit 0. Reported cold time and 20 warm samples. |
| `npm run models:run -- arithmetic <input.json>` | Exit 0. The checked-in ribbon problem returned `(8 * 14) / 4` with value `28`. |
| `npm run models:shadow-summary -- <copied-log.jsonl>` | Exit 0 against a two-record fixture and against two local turns emitted by the manager. |
| `npm test -- packages/model-relations/src/cli.test.ts` | 4 tests passed, including absent worker, input and file-based disagreement summary. |

Actual inference with owner-only checkpoints, exports and GPU is unverified.
PowerShell commands and the optional server `GET /health` worker report are
unverified here. The checked-in CLI tests exercised CRLF log lines and a
UTF-8 BOM in input JSON on Linux.
