# Monitor decision training

يراجع موحسن الرسائل القريبة قبل اقتراح مراقبة. سجلات التدريب المحلية تحفظ قرار
المستخدم وسمات رقمية دون نص الرسائل. يبقى النموذج المتعلّم في وضع الظل حتى
تنجح المقارنة على قرارات بشرية أحدث من بيانات التدريب.

## CPU head on the owner’s PC

Run the export against the owner's local database using the primary owner's
user ID. Keep the JSONL and its manifest together in a fresh, ignored local
directory. This example uses the local PGlite store. Use the pinned Python
requirements and put the two verified archives in the local source cache
before going offline. The trainer verifies the hashes and applies the
capability v2 exclusions.
[Sources and licences](../packages/scratch-classifiers/data/sources.json)

```sh
mkdir -p .data/monitor-decision-input
node --import tsx scripts/monitor-decision/export.ts --database-dir .data/postgres --owner-id "$monitor_owner_id" --out .data/monitor-decision-input/decisions.jsonl
python packages/scratch-classifiers/train_monitor_decision.py --decisions .data/monitor-decision-input/decisions.jsonl --cache .data/scratch-classifiers/sources --output .data/monitor-decision-run-01
```

The command writes weights, a model card, calibration and a chronological
evaluation, an arbiter replay, and a SHA-256 manifest. Use a fresh output
directory for every run. Fit and freeze a candidate before considering its
holdout. For a subsequent candidate, reserve a newer set of untouched decisions
before fitting and document the window. Keep chronological calibration and
arbiter fitting separate from evaluation. The trainer fails if a split is
empty or fitting lacks positive and negative feedback. The accepted operating
point can abstain on every input when support is insufficient.

The public corpus annotations are weak supervision for ordinary requests and
reminder near misses. The trainer samples within each language and
limits public training volume by the amount of real feedback. The chronological
report describes feedback on existing monitor proposals. It cannot quantify
missed monitor needs in conversations where no monitor was proposed. A held-out
approval or helpful alert supports the original offer or proposed action.
Declines, early stops and unhelpful alerts count against that action. Only the
latest signal for a given monitor supplies a label.

The head uses the same fixed vector schema in training and runtime. Installation
for shadow requires `weights.json` and `manifest.json` under
`.data/monitor-decision/`. Keep the real export and replay local to the owner.
The relations manager and arbiter run the normal safety checks before a learned
decision can affect any visible offer. [Arbiter verification](ARBITER-BRAIN-VERIFICATION.md)

## Generated pipeline check

Generate the temporary PGlite decisions with the recording fixture, then run the
same CPU trainer against its marked export. The trainer refuses the fixture
without `--pipeline-check`. The runtime loader and arbiter gate require human
provenance. The check reports split sizes and artifact creation. Those counts
measure pipeline coverage.

```sh
mkdir -p /tmp/monitor-decision-check
node --import tsx scripts/monitor-decision/check-recording.ts --out /tmp/monitor-decision-check/decisions.jsonl
python packages/scratch-classifiers/train_monitor_decision.py --decisions /tmp/monitor-decision-check/decisions.jsonl --output /tmp/monitor-decision-check/trained --pipeline-check
```

## v5 trunk decision interface

Reuse the head-training kit's frozen-trunk `classification` sidecar and local
tokenizer when the owner has a ready v5 checkpoint. The decision labels, in
sidecar order, are `none`, `offer`, `propose`, `manage` and `reminder`.
Format the current user turn as `text`. Send the bounded earlier user and
assistant turns as ordered `history` entries prefixed with `user:` or
`assistant:`. A first history entry can hold the ordered numeric context
features as `key=value` fields. Preserve that format in fitting and
inference. The existing `encode_input` keeps space for the current turn,
retains the newest earlier turns and appends the final EOS. The sidecar
maps the trunk's last valid token state to five logits. This initial job
freezes the trunk and uses only the sidecar projection.
[Encoding implementation](../packages/head-training/head_training/encoding.py)
[Existing head interface](../packages/head-training/README.md)

The future runtime adapter sends the locally encoded `inputIds` to the
permanent worker's `classify` operation and converts its calibrated score
and label to a claimant through the relations manager. Abstention leaves the
reasoner in charge. Preserve the worker config, checkpoint, tokenizer, sidecar,
label order, input format version and calibration pins in the handoff. Use
the existing dual gate with a fresh chronological, real monitor holdout. The
CPU head's input IDs are hashing bins. Trunk inputs are tokens from Mohassan's
own tokenizer and need a separately owner-approved, PC-local supervision file.

## Future v5 training job on the owner's PC

1. Wait for the owner to select a v5 checkpoint from a completed assessment.
   Prepare an owner-approved local supervision file in the head-training kit's
   JSONL format with `id`, `group`, `language`, `text`, `history`, `label`
   and `split`. Include reviewed source IDs for any public examples. Pair
   genuine monitor feedback with separately consented local input and use the
   pinned, guard-filtered public sources only for fitting negatives and time
   reminders. Use chronological, conversation-grouped `train`, `dev` and
   `test` windows. The kit allocates the `dev` groups to validation and
   calibration and reserves `test`. Keep the later arbiter and final
   evaluation stages independent and local. Stop if any required class is
   missing from fitting data. Keep the approval card and JSONL under `.data`.
   Apply the exclusion guard to the underlying turns before adding role markers.
   [Owner source format](../packages/head-training/README.md#configure-supervision)
2. Create the job configuration in PowerShell from the checkout root. Use
   the actual files and their checksums. The example uses the scheduler's
   selected foundation resolution. If the owner selects another approved
   v5 checkpoint, set `trunk` to its explicit checkpoint and tokenizer
   pins as described in the kit.

   ```powershell
   $python = '.\.venv-execution\Scripts\python.exe'
   $rows = (Resolve-Path '.data/monitor-decision-v5/supervision.jsonl').Path
   $card = (Resolve-Path '.data/monitor-decision-v5/approval.json').Path
   $config = '.data/monitor-decision-v5/schedule.json'
   $schedule = @{
       trunk = 'v5-foundation'
       device = 'cuda'
       jobs = @(@{
           name = 'monitor-context'
           task = 'intent'
           kind = 'classification'
           labels = @('none', 'offer', 'propose', 'manage', 'reminder')
           max_tokens = 512
           lora_rank = 0
           training = @{ batch_size = 2; accumulation = 8; mixed_precision = $true }
           sources = @(@{
               labelled = @{ path = $rows; sha256 = (Get-FileHash -Algorithm SHA256 $rows).Hash.ToLowerInvariant() }
               card = @{ path = $card; sha256 = (Get-FileHash -Algorithm SHA256 $card).Hash.ToLowerInvariant() }
           })
       })
   }
   if (Test-Path $config) { throw 'Choose a new schedule path.' }
   $schedule | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8NoBOM $config
   & $python packages/head-training/run.py schedule --config $config --output artifacts/head-training/v5-monitor-01
   ```

3. Keep the PC on AC power. Once the readiness check passes and
   `nvidia-smi` shows an idle GPU, use the explicit run below. The existing
   scheduler atomically reserves `.data/gpu.lock` before touching CUDA
   and holds the legacy training lock during execution. An active job or
   existing lock blocks the run. Stop for a GPU spill or sustained speed
   drop under the chat-model memory guard. If interrupted, verify the owning
   process ended and the GPU is idle before clearing an abandoned lease.
   [Scheduler](../packages/head-training/head_training/scheduler.py)
   [Chat training instructions](CHAT-MODEL-AGENT-INSTRUCTIONS.md)

   ```powershell
   & $python packages/head-training/run.py schedule --config $config --output artifacts/head-training/v5-monitor-01 --execute --no-wait
   ```

4. Keep the sidecar in shadow and retain the scheduler report, input and
   artifact checksums, split counts by language, calibration, and paired
   arbiter results. A failed gate ends the run before any activation. This
   change provides the interface and job specification. Execution requires
   the owner's ready checkpoint and new human supervision.
