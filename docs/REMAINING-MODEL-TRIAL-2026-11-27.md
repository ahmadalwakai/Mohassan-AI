# Remaining model trial · 2026-11-27

Assessment of production commit `29448aea3fa10d226ef82ec5bf0a65e723d6ec39`. **Selected `monitor-context-head` for an owner-PC CPU trial.** No candidate could start real cloud training. The monitor requires private human decisions and feedback, which are absent. The ten v5 heads need the pinned internal 85,133,440-parameter trunk and its own tokenizer. The 1,021,749,913-byte checkpoint is operator-held, and Gate 3 failed both rules. The owner's earlier permission covers the owner-chat experiment. The training hard stop still applies. [Registry](../packages/model-relations/src/registry.ts) · [Training instructions](CHAT-MODEL-AGENT-INSTRUCTIONS.md) · [Gate criteria](CHAT-MODEL-TRAINING-PLAN.md#84-stages-and-gates) · [Owner chat receipt](V5-OWNER-CHAT-2026-11-26.md)

## Assessment

The pilot host was an Intel Xeon Platinum 8573C with five visible logical CPUs, a four-vCPU quota, 16 GiB memory limit and no NVIDIA device. The v5 kit supports CPU fitting and is configured for the PC's CUDA path in the example schedule. Even CPU scheduling requires v5 readiness. No schedule or checkpoint override was used to get around the failed gate. [Head-training kit](../packages/head-training/README.md) · [Exact ten-job schedule](../packages/head-training/pc-schedule.example.json)

| Model | Required data, trunk and hardware | Cloud eligibility | Data preparation | CPU training | Development evaluation | Owner PC training from receipts |
| --- | --- | --- | ---: | ---: | ---: | --- |
| `head-clinc-intent` | CLINC150 intents · pinned v5 trunk/tokenizer · CPU or CUDA | Blocked by Gate 3 and missing trunk | 0.4 s encoding | 5 h 41 m | 36 m | No comparable measurement |
| `head-massive-intent` | MASSIVE ar-SA/en-US intents · pinned v5 trunk/tokenizer · CPU or CUDA | Same v5 block | 0.6 s encoding | 8 h 44 m | 49 m | No comparable measurement |
| `head-clinc-domain` | CLINC150 domains · pinned v5 trunk/tokenizer · CPU or CUDA | Same v5 block | 0.4 s encoding | 5 h 41 m | 36 m | No comparable measurement |
| `head-massive-scenario` | MASSIVE ar-SA/en-US scenarios · pinned v5 trunk/tokenizer · CPU or CUDA | Same v5 block | 0.6 s encoding | 8 h 44 m | 49 m | No comparable measurement |
| `head-out-of-scope` | CLINC150 in-scope and OOS examples · pinned v5 trunk/tokenizer · CPU or CUDA | Same v5 block | 0.4 s encoding | 5 h 44 m | 37 m | No comparable measurement |
| `head-follow-up` | QuAC dialogues and human follow-up annotations · pinned v5 trunk/tokenizer · CPU or CUDA | Same v5 block | 16.5 s encoding | 103 h | 9 h 51 m | No comparable measurement |
| `question-edit` | CANARD human rewrites · pinned v5 trunk/tokenizer · CPU or CUDA | Same v5 block | 4.3 s encoding | 97 h | 2 h 52 m | No comparable measurement |
| `head-answer-sentence` | XQuAD, MLQA, TyDiQA-GoldP and ARCD · pinned v5 trunk/tokenizer · CPU or CUDA | Same v5 block | 20.5 s encoding | 249 h | 11 h 18 m | No comparable measurement |
| `head-sufficiency` | SQuAD 2.0 · pinned v5 trunk/tokenizer · CPU or CUDA | Same v5 block | 26–49 s encoding using initial proxies | 161–601 h | 16–22 h | No comparable measurement |
| `head-speech-act` | Manual AMI annotations · pinned v5 trunk/tokenizer · CPU or CUDA | Same v5 block | About 16 s download, parsing and encoding before exclusions | 34 h | 4 h 28 m | No comparable measurement |
| `monitor-context-head` | Private human outcomes and guarded CLINC150 and MASSIVE 1.0 fitting proxies · CPU | Blocked by absence of private outcomes | About 9–12 s for public source and feature work, plus unknown export time | 0.09–0.25 s fitted solver | 0.007–0.029 s sample calculation | CPU job. No comparable owner CPU fitting measurement |

All times are illustrative compute estimates. Most preparation entries cover token encoding only. Checkpoint I/O, publisher downloads and parsing, collection, data review, grouping and V2 filtering may add time or reduce the number of rows. The higher estimate is relevant only where the examples fill the assumed token width. CPU timing varied with the workload. The completed 512-token SQuAD classification probe refines the initial `head-sufficiency` estimates to about **60 s encoding, 372 h fitting and 19 h 55 m evaluation** in the same max-epoch scenario. [Head-training implementation](../packages/head-training/head_training/training.py) · [Partition rules](../packages/head-training/head_training/splits.py)

The RTX 3050 Ti Laptop has 4 GB. The repository records **5,833 positions/s** for full 85M next-token training on it. The historical sidecar report explicitly leaves sidecar throughput on that GPU unverified. The monitor job uses the PC's CPU. The repository's monitor latency measurements cover warm inference using pipeline-check weights. Neither measurement gives the requested owner-PC training throughput. [Foundation throughput](CHAT-MODEL-TRAINING-PLAN.md#83-model-and-tooling) · [Head-training PR #44](https://github.com/ahmadalwakai/Mohassan-AI/pull/44) · [Monitor inference measurement](MONITOR-CONTEXT-DEV-BENCH.md#cpu-head-latency)

### Sources, licences and reference sizes

The inputs in the table come from the approved head-kit schedule. Reference sizes are for extrapolation and use published split counts, with approximately half the publisher development rows assigned to development and half to calibration. Sizes are listed as fit / development / calibration. They precede filtering and are not estimates of language quality or coverage. The documentation and publisher references were retrieved on 2026-11-27. [Head-kit data cards and publisher licence evidence](../packages/head-training/DATASETS.md)

| Reference | Rows | Publisher terms |
| --- | ---: | --- |
| CLINC150 intent and domain | 15,000 / 1,500 / 1,500 | CC BY 3.0. [Pinned release](https://github.com/clinc/oos-eval/blob/828f8093932c8fe6ca7936c3d2e52903b1c523de/README.md) |
| MASSIVE intent and scenario | 23,028 / 2,033 / 2,033 | CC BY 4.0. [Publisher split counts](https://huggingface.co/datasets/AmazonScience/massive/blob/main/README.md#data-splits) · [Notice](https://github.com/alexa/massive/blob/main/NOTICE.md) |
| CLINC150 out of scope | 15,100 / 1,550 / 1,550 | CC BY 3.0. [Pinned release](https://github.com/clinc/oos-eval/blob/828f8093932c8fe6ca7936c3d2e52903b1c523de/README.md) |
| QuAC | 83,568 / 3,677 / 3,677 | CC BY-SA 4.0. [Paper table 2](https://aclanthology.org/D18-1241.pdf) · [Publisher terms](https://quac.ai/#getting-started) |
| CANARD | 31,526 / 1,715 / 1,715 | CC BY-SA 4.0. [Author release and counts](https://qanta-org.github.io/research/projects/canard.html#dataset-statistics) |
| Answer sentence, rounded high workload scenario | 54,000 / 3,000 / 3,000 | XQuAD CC BY-SA 4.0, MLQA CC BY-SA 3.0, TyDiQA-GoldP Apache 2.0 and Wikipedia attribution, ARCD MIT and Wikipedia attribution. [XQuAD](https://github.com/google-deepmind/xquad/blob/7d30520c717524000f0d9d2f9c10a069acd9d285/README.md) · [MLQA](https://github.com/facebookresearch/MLQA) · [TyDiQA-GoldP](https://huggingface.co/datasets/google-research-datasets/tydiqa/blob/da78f23f9119363459acbaf46bf89426ff26c259/README.md) · [ARCD paper](https://aclanthology.org/W19-4612.pdf) · [ARCD licence](https://github.com/husseinmozannar/SOQAL/blob/1229d34aa2b7a0b9a2e4858c9268e68f45d7e3c4/LICENSE) |
| SQuAD 2.0 | 130,319 / 5,937 / 5,936 | CC BY-SA 4.0. [Paper table 1](https://aclanthology.org/P18-2124.pdf) · [Publisher release](https://rajpurkar.github.io/SQuAD-explorer/) |
| Manual AMI, approximate group allocation | 88,615 / 11,077 / 11,077 | CC BY 4.0. 110,769 usable source acts counted before exclusions. [Manual annotations](https://groups.inf.ed.ac.uk/ami/download/) |

The H4 scenario uses TyDi's published all-language counts (49,881 fitting and 5,077 development) as a ceiling, adding published Arabic/English XQuAD and MLQA development counts and ARCD training counts. Its actual Arabic/English span-filtered count remains unknown. The code uses V2 fingerprints of model-visible fields, native source IDs and verified aliases before splitting. Only the published exclusion metadata was used here. Some v5 dataset readers open upstream test files even when a test score will not be requested. Any future development-only v5 run needs an audit of those readers before source preparation. [Head-kit dataset code](../packages/head-training/head_training/datasets.py) · [V2 exclusion implementation](../scripts/agent-capability-bench/v2/exclusion.py)

### Actual timing receipt

- The five-shape v5 probe took **185.850 s** including random architecture initialization, warm-up and repeated measurements. It used PyTorch 2.10.0+cpu, four threads, the frozen 85M architecture built in memory, numeric token IDs and deterministic patterns for encoding. It timed one optimizer update over 16 rows and a development-like forward pass over 16 rows. No real checkpoint, model evaluation or weight file was used.
- The CPU monitor probe took **19.960 s** including six bridge invocations. Its median bridge and feature parse was 2.969 s for 1,000 patterns, including an estimated 1.961 s startup. One-thread CSR assembly was 0.009/0.093 s for 600/6,000 rows. The solver was 0.088/0.249 s, and numerical calibration and scoring were 0.0069/0.0289 s for 100/1,000 examples. Those kernel measurements use 4,124 features, 80 active text buckets and four present classes. They do not measure prediction quality or full I/O.
- Downloading and verifying both named monitor archives took **1.911 s**. Reading their fitting partitions with the real V2 guard took **4.324 s** and retained 15,100 CLINC150 rows, 11,462 Saudi Arabic MASSIVE rows and 11,510 US English MASSIVE rows. The trainer will select a much smaller labelled proxy subset based on actual real fitting support. The AMI download and parsing were **2.573 s** and **10.614 s**, respectively. Only the pinned ARCD training input was parsed for the H4 spot check. It downloaded in **0.834 s** and parsed in **0.154 s**, yielding 486 sentence-selection inputs from 693 raw training pairs before the V2 guard. [Monitor source pins](../packages/scratch-classifiers/data/sources.json) · [AMI archive](https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip) · [Pinned ARCD training file](https://raw.githubusercontent.com/husseinmozannar/SOQAL/1229d34aa2b7a0b9a2e4858c9268e68f45d7e3c4/data/arcd-train.json)

| v5 numeric shape | Encode s / 1,000 | Fit s / 16 | Score s / 16 | Calibrate s / 16 |
| --- | ---: | ---: | ---: | ---: |
| 32 tokens, classification | 0.02159 | 1.09255 | 1.05419 | 0.03156 |
| 128 tokens, contextual classification | 0.18146 | 3.55334 | 7.00967 | 0.01280 |
| 128 tokens, pairwise, 4 candidates | 0.12190 | 8.86657 | 4.36760 | 0.01313 |
| 512 tokens, selection, 12 candidates | 0.34215 | 13.28959 | 9.86821 | 0.01443 |
| 512 tokens, classification with evidence | 0.42187 | 8.21987 | 8.77978 | 0.01427 |

Preparation scales encoding by total rows. Training scales median update time by `20 × fit_rows / 16` for the kit's configured maximum, with earlier stopping possible. Evaluation scales the median scoring pass by `(21 × development_rows + calibration_rows) / 16` and adds a calibrated score calculation. The contextual classification probe uses the double-pass evidence encoding cost as an approximation for QuAC. No full run took place, so total preparation, training and evaluation wall times and any real-data gain against the no-model baseline remain unverified.

## Owner PC run

The monitor head is the candidate because it can train from zero on CPU without the v5 trunk and its limited decision can be checked against the reasoner that made the original offer. The production trainer constructs and reads a five-window holdout. Use this branch's bounded exporter and development trainer for this trial. [CPU trainer](../packages/scratch-classifiers/train_monitor_decision.py) · [Monitor training plan](MONITOR-DECISION-TRAINING.md) · [Decision model and gate](MONITOR-CONTEXT-DECISION-MODEL.md)

### Prepare eligible data

Use a **PC-local PGlite snapshot** from before the reserved evaluation interval. Copy it while the local server is stopped. Keep the snapshot, exports, cache and outputs local. Use only human monitor approvals, declines, early stops and alert feedback from authorized recordings. The exporter preserves the owner, member-consent and deletion filters. It bounds both proposal and feedback timestamps in SQL. It exports numeric and hashed features and hashed conversation and monitor identifiers. Local outcome data is private and authorized only for the owner-local trial. [Recording exporter](../scripts/monitor-decision/export-development.ts) · [Feature schema](../apps/server/src/monitors/decision/features.ts)

Before export, record four increasing UTC timestamps that define three consecutive half-open windows for fitting, calibration and development. Their last boundary must be at or before the start of anything reserved. Supply the actual dates from the owner's collection plan. Records qualify only if the proposal and feedback both fall in the same window. Use distinct conversations across windows. The latest in-window feedback per monitor supplies its label. Fitting must include positive and negative feedback. The development gate also needs eligible positive and negative offers in both Arabic and English. An empty window or crossing group stops the trial. No collection or feedback wait is included in the compute estimates.

The existing source cache helper downloads only the two requested archives and verifies both SHA-256 pins. CLINC150 is CC BY 3.0. MASSIVE **1.0** is CC BY 4.0. The trainer reads the official training partitions, selects guarded weak supervision for `none` and `reminder`, and caps public fitting rows by language using the real fitting support. The public rows never supply calibration or development outcomes. Record the actual retrieval date of the fresh cache. Source pins and license information were retrieved on 2026-11-27. [CLINC publisher license](https://github.com/clinc/oos-eval/blob/828f8093932c8fe6ca7936c3d2e52903b1c523de/LICENSE) · [MASSIVE publisher notice](https://github.com/alexa/massive/blob/main/NOTICE.md) · [Pinned archive URLs and hashes](../packages/scratch-classifiers/data/sources.json)

### Run from the branch checkout in PowerShell 7.2 or later

Use Node 24 and Python 3.12. Start in the existing repository. The commands create a separate sparse worktree to leave local edits in place and keep benchmark case payloads out of the checkout. The one exception is the published exclusion fingerprint file required by the guard. The four UTC timestamps and the owner's local snapshot path are the run-specific inputs. Keep scripts, cutoffs and receipts fixed for this candidate before examining results.

```powershell
git fetch origin refs/heads/model/remaining-model-trial:refs/remotes/origin/model/remaining-model-trial
if ($LASTEXITCODE -ne 0) { throw 'Trial branch fetch failed.' }
$trialCheckout = Join-Path (Split-Path -Parent (Get-Location).Path) 'Mohassan-AI-remaining-model-trial'
if (Test-Path $trialCheckout) { throw 'Choose a fresh worktree directory.' }
git worktree add --detach --no-checkout $trialCheckout refs/remotes/origin/model/remaining-model-trial
if ($LASTEXITCODE -ne 0) { throw 'Trial worktree setup failed.' }
git -C $trialCheckout sparse-checkout set --no-cone '/*' '!*holdout*' '!*sealed*' `
    '/tests/fixtures/agent-capability-bench/v2/exclusion/sealed.jsonl'
if ($LASTEXITCODE -ne 0) { throw 'Trial sparse checkout setup failed.' }
git -C $trialCheckout checkout --detach refs/remotes/origin/model/remaining-model-trial
if ($LASTEXITCODE -ne 0) { throw 'Trial revision checkout failed.' }
Set-Location $trialCheckout
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Dependency install failed.' }
py -3.12 -m venv .data/monitor-trial-venv
if ($LASTEXITCODE -ne 0) { throw 'Python environment setup failed.' }
$python = (Resolve-Path '.data/monitor-trial-venv/Scripts/python.exe').Path
& $python -m pip install -r packages/scratch-classifiers/requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Python dependency install failed.' }

$databaseDir = (Resolve-Path (Read-Host 'Local PGlite snapshot directory')).Path
$ownerId = Read-Host 'Primary owner user ID' -MaskInput
$trainStart = Read-Host 'Fit start UTC (YYYY-MM-DDTHH:mm:ss.sssZ)'
$calibrationStart = Read-Host 'Calibration start UTC (YYYY-MM-DDTHH:mm:ss.sssZ)'
$developmentStart = Read-Host 'Development start UTC (YYYY-MM-DDTHH:mm:ss.sssZ)'
$developmentEnd = Read-Host 'Exclusive development cutoff UTC (YYYY-MM-DDTHH:mm:ss.sssZ)'
$ordered = @($trainStart, $calibrationStart, $developmentStart, $developmentEnd) | Sort-Object -Unique
if ($ordered.Count -ne 4 -or ($ordered -join ',') -cne (@($trainStart, $calibrationStart, $developmentStart, $developmentEnd) -join ',')) {
    throw 'Declare four increasing UTC cutoffs before exporting.'
}
$run = Join-Path '.data/remaining-model-trial' ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
if (Test-Path $run) { throw 'Choose a fresh run directory.' }
$cache = Join-Path $run 'sources'
New-Item -ItemType Directory -Path $cache -ErrorAction Stop | Out-Null
$preparation = [Diagnostics.Stopwatch]::StartNew()
$env:PYTHONIOENCODING = 'utf-8'

@'
import sys
from pathlib import Path
sys.path.insert(0, "packages/scratch-classifiers")
from monitor_corpora import pins
from prepare_data import pin_source
for name, metadata in pins().items():
    pin_source(Path(sys.argv[1]), name, metadata)
'@ | & $python - $cache
if ($LASTEXITCODE -ne 0) { throw 'Pinned source retrieval failed.' }
$retrievedOn = [DateTime]::UtcNow.ToString('yyyy-MM-dd')

$windows = @(
    @{ Name = 'train'; From = $trainStart; Until = $calibrationStart }
    @{ Name = 'calibration'; From = $calibrationStart; Until = $developmentStart }
    @{ Name = 'development'; From = $developmentStart; Until = $developmentEnd }
)
foreach ($window in $windows) {
    $exportPath = Join-Path $run ($window.Name + '.jsonl')
    node --import tsx scripts/monitor-decision/export-development.ts --database-dir $databaseDir `
        --owner-id $ownerId --from $window.From --until $window.Until --out $exportPath
    if ($LASTEXITCODE -ne 0) { throw 'Bounded local export failed.' }
}
$preparation.Stop()
Remove-Variable ownerId
@{ sourceCacheAndExportSeconds = $preparation.Elapsed.TotalSeconds; publicSourcesRetrievedOn = $retrievedOn } |
    ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $run 'preparation-timing.json')

$trial = [Diagnostics.Stopwatch]::StartNew()
& $python packages/scratch-classifiers/train_monitor_decision_dev.py `
    --train-decisions (Join-Path $run 'train.jsonl') `
    --calibration-decisions (Join-Path $run 'calibration.jsonl') `
    --development-decisions (Join-Path $run 'development.jsonl') `
    --development-end $developmentEnd --cache $cache --sources-retrieved-on $retrievedOn `
    --output (Join-Path $run 'candidate') |
    Tee-Object -FilePath (Join-Path $run 'trainer.log')
$exitCode = $LASTEXITCODE
$trial.Stop()
@{ wallSeconds = $trial.Elapsed.TotalSeconds; exitCode = $exitCode } |
    ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $run 'trial-timing.json')
if ($exitCode -ne 0) { throw 'Trial stopped. Check the local development report or trainer error.' }
```

The four cutoffs must describe eligible material on that snapshot. Keep the cutoff and hash receipts with the candidate.

### Judge the result

Training and quantized calibration finish before the development rows are loaded. Calibration uses the existing trainer's 0.80 acceptance target. It can yield complete abstention when there is insufficient calibrated support. Compare each frozen candidate decision with the recorded no-model reasoner decision for that same proposal. Use windows recorded under the production reasoner you want to compare against, and confirm that revision from the deployment receipt. The snapshot stores the reasoner label and score without its originating code hash, so the trial cannot verify that version. The only simulated change is a `none` prediction meeting the calibrated confidence threshold vetoing a discretionary offer. Keep explicit proposals, management actions, reminders and abstentions under the existing rules. Report both correct counts, gains and losses, offer support and timing per language where available. Gains require a net improvement with zero paired losses and a one-sided exact paired sign probability at most 0.05, counting an improved conversation once. Both Arabic and English must have positive and negative eligible offers. This is the paired development screen. Compare measured cost and effect before counting the model as useful. The development sample consists of previously exposed monitor proposals. It cannot measure missed offers, reconstruct the live protection flag or prove an improvement in production. [Current override rule](../packages/model-relations/src/monitor-decision.ts) · [Promotion criteria](MONITOR-CONTEXT-DECISION-MODEL.md)

Read the output under the fresh ignored `.data/remaining-model-trial/<timestamp>/candidate/`. `development.json` contains the development comparison and trainer phase times. `manifest.json` pins weights, results, source archives and usage terms, code, three bounded exports and the V2 guard. `trial-weights.json` uses trial-only provenance. Preserve the outputs even on a failed development screen. Keep real exports, weights, and row-level data off Git and leave registration and activation alone. The independent promotion gate requires a separate reserved run owned by its authorized custodian.

### GPU lock

The CPU monitor trial does not use CUDA and does not acquire or clear `.data/gpu.lock`. When a future v5 job is eligible, run `nvidia-smi` and verify both `.data/gpu.lock` and `artifacts/chat-training/v4/gpu.lock` are absent. Use the scheduler's atomic lease with one GPU job at a time. A present lock blocks the run. Only clear an abandoned lease after verifying its owner process exited and the GPU is idle. The CUDA scheduler applies the documented dedicated/shared-memory and sustained speed-drop guard. The existing owner-facing chat exception does not pass Gate 3 for the sidecars. [Head scheduler](../packages/head-training/head_training/scheduler.py) · [GPU guard and hard stops](CHAT-MODEL-AGENT-INSTRUCTIONS.md)
