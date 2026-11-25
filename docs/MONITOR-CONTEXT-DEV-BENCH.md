# Monitor context development benchmark

This run uses the published V1 and V2 development cases, the PR #95 arm C profile, and V2 monitors in every arm. The candidate arms use the same commit. Only the two monitor context flags change between them. The reviewed monitoring-request allowlist is empty for these published cases. [PR #95 arm C profile](INTEGRATION-WAVE-5-2026-11-25.md#three-arm-development-run) · [PR #100 review of monitoring requests](MONITORS.md#three-arm-development-benchmark)

The candidate chat path was measured at `09034c388fa4b1f938df52dbd9df697413a224d0`. Later branch commits cover feedback administration, offline training and promotion evidence, and the verification reports.

## Commands

Fetch the benchmark inputs and install the browser pinned by the npm lockfile.

```bash
git fetch origin \
  a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f \
  0dfff7c54d3658a02cf878ff11faac7f630a6c10 \
  12cedfe592aab40cdd47ee00d05ea86a6d2bae89 \
  a1e1cb020b7ba093885edbf501149e7b8252c0cb
npm ci --cache /workspace/scratch/mohassan-npm-cache
PLAYWRIGHT_BROWSERS_PATH=/workspace/scratch/monitor-context-chromium \
  npx --no-install playwright install chromium
```

The Git fetch, lockfile install, and browser install exited 0. The local runtime used Node 24.22.3 and root-owned Python 3.12.14 from the two digest-pinned images in `scripts/dev-bench/Dockerfile`. The image was assembled offline using copies of the existing Debian host's Git, fonts, and shared libraries. Its image ID was `sha256:96ad629e238836f6ca1ee66f2a99e8505ab51e2987e089adb7b0be48e0223c66`. The runner verified and hashed the local tools, including `libseccomp.so.2` and Playwright Chromium build 1248. [Runtime recipe](../scripts/dev-bench/Dockerfile) · [Runner](../scripts/dev-bench/runner.py)

```bash
docker pull node:24.22.3-bookworm-slim@sha256:e0e989b967dacc279681ed81774b2ce9eeebbb0efb8e0c427573235bebf1eda1
docker pull python:3.12.14-slim-bookworm@sha256:1aaa65a85fda306ffb8b910824d4e93bdce61e212c7e87168123ea3073b41a1a
python3 -B /workspace/scratch/monitor-context-runtime/copy-installed-runtime.py
docker build --network none --pull=false -t mohassan-monitor-context-bench:local /workspace/scratch/monitor-context-runtime
```

The command below expands the launcher invocation, run from `/workspace/Mohassan-AI`.

```bash
base=c88a38a3bb5f07186885af31cdc8c18174af12f1
candidate=09034c388fa4b1f938df52dbd9df697413a224d0
output=/workspace/scratch/monitor-context-dev-three-arms
args=(--workers 2 --offline --audit-monitors --output "$output"
      --arm "a=$base" --arm "b=$candidate" --arm "c=$candidate")
for arm in a b c; do
  rollout=0
  if [[ "$arm" == c ]]; then rollout=1; fi
  for setting in \
    MOHASSAN_ARITHMETIC_SEARCH=1 TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3.12 \
    MOHASSAN_MODEL_RELATIONS=shadow MOHASSAN_REPLY_POLICY_ENABLED=1 MOHASSAN_CONTEXT_POLICY_ENABLED=1 \
    MOHASSAN_LONG_RUN_ENABLED=1 MOHASSAN_BACKGROUND_RESULTS_ENABLED=1 MOHASSAN_ARBITER_ROUTING=1 \
    MOHASSAN_ARBITER_QUESTION_REWRITE=1 MOHASSAN_ARBITER_LOCAL_COMPUTATION=1 MOHASSAN_ARBITER_COMPOUND_PLAN=1 \
    MOHASSAN_MONITORS_ENABLED=1 MOHASSAN_MONITORS_V2=1 \
    "MOHASSAN_MONITOR_CONTEXT=$rollout" "MOHASSAN_MONITOR_CONTEXT_SHADOW=$rollout"; do
    args+=(--set "$arm:$setting")
  done
done
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
  --mount type=bind,source=/workspace,target=/workspace --workdir /workspace/Mohassan-AI \
  --env PLAYWRIGHT_BROWSERS_PATH=/workspace/scratch/monitor-context-chromium \
  --env npm_config_cache=/workspace/scratch/mohassan-npm-cache \
  mohassan-monitor-context-bench:local python3 -B scripts/dev-bench/run.py "${args[@]}"
printf '%s\n' '{"v1":[],"v2":[]}' > /workspace/scratch/monitor-context-dev-requests.json
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
  --mount type=bind,source=/workspace,target=/workspace --workdir /workspace/Mohassan-AI \
  mohassan-monitor-context-bench:local python3 -B scripts/dev-bench/compare.py \
  --monitor-context --monitor-requests /workspace/scratch/monitor-context-dev-requests.json \
  --baseline "$output/a/receipt.json" --flags-off "$output/b/receipt.json" --flags-on "$output/c/receipt.json" \
  --output "$output/comparison.json"
```

The comparison checks the flag-off verdict, scored turn details, and public replies case by case. It compares every area, language, and area/language group with the flags on. Monitor audit receipts retain the per-turn V2 detector and context decision matches, the published proposal cards, and nearest-rank latencies.

## Results

The three-arm launcher and comparator each exited 0. Each arm audited 279 V1 turns and 2,400 V2 turns. The comparison found zero flag-off verdict, scored-check, or reply differences across all 2,640 cases. The enabled arm kept every case verdict and every subgroup score. No case IDs differed on those checks.

| Development split | A, baseline | B, flags off | C, flags on | Area groups | Language groups | Area/language groups | Enabled group losses |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| V1 | 176/240 | 176/240 | 176/240 | 14 | 2 | 28 | 0 |
| V2 | 1,588/2,400 | 1,588/2,400 | 1,588/2,400 | 8 | 2 | 12 | 0 |

| Arm and split | V2 detector matches | Management matches | Proactive matches | Context monitor decisions | Displayed offers | False offers |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A, V1 | 0 | 0 | 0 | 0 | 0 | 0 |
| A, V2 | 0 | 0 | 0 | 0 | 0 | 0 |
| B, V1 | 0 | 0 | 0 | 0 | 0 | 0 |
| B, V2 | 0 | 0 | 0 | 0 | 0 | 0 |
| C, V1 | 0 | 0 | 0 | 0 | 0 | 0 |
| C, V2 | 0 | 0 | 0 | 0 | 0 | 0 |

In C, all 261 V1 reasoner calls and 2,336 V2 calls returned `none`. Across the 2,597 measured turns, decision time after frame construction was **0.006930 ms p50** and **0.013069 ms p95**. A and B made zero reasoner calls. The human-corpus audit measures frame construction and reasoning together. [Human corpus audit](MONITOR-CONTEXT-HUMAN-AUDIT.md)

The C journals recorded 261 V1 and 2,336 V2 requests for shadow review. The shared runtime returned `busy` for 234 V1 and 1,820 V2 requests and `absent` for 27 V1 and 516 V2 requests. The run used no installed human decision head. The timing below exercises the head in isolation with pipeline-check weights.

| File | SHA-256 |
| --- | --- |
| `summary.json` | `78110a2b8ece2984da32a58d75c5984a284446e49dbdb6ae1ad76be2219c8af0` |
| `comparison.json` | `0e138d67369b5f025d8f590a060f1c6879a06b74009c6abf023efd7f1c7de5d1` |
| `a/receipt.json` | `86ced886bd932d17609ea58e5a9d1f231c0a56bbfd567681977d6489004448f4` |
| `b/receipt.json` | `600272a64d6234c8d98a64845cdb4157edd056e158a944121e9f4cd8c90c0be6` |
| `c/receipt.json` | `205310662ff8269510d4813ba521c93429fdfa7b7a594de1bb35a05cbd1d18f1` |

The full receipts, comparison, and journals remain under `/workspace/scratch/monitor-context-dev-three-arms`. The launcher used only development fixtures. An earlier baseline-only preflight exited 0 at the same reference totals. The initial three-arm invocation on the superseded `6e68bda` candidate was stopped before its first case receipt so the final run could include the timed one-off fix.

## Shadow head latency

The CPU head was measured with the production `ModelRuntime` and `ModelRelationsManager` on the private pipeline-check export. The benchmark injects the same scorer in an isolated adapter because the normal adapter rejects pipeline-check weights. Timing includes warmed inference and arbitration after feature extraction. [Latency script](../scripts/monitor-decision/latency.ts)

```bash
install -d -m 700 /workspace/scratch/monitor-context-latency-fixture
install -m 600 /tmp/mohassan-recording-check/decisions.jsonl \
  /tmp/mohassan-recording-check/decisions.jsonl.manifest.json \
  /tmp/mohassan-recording-check/trained/weights.json \
  /workspace/scratch/monitor-context-latency-fixture/
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
  --mount type=bind,source=/workspace,target=/workspace --workdir /workspace/Mohassan-AI \
  mohassan-monitor-context-bench:local node --import tsx scripts/monitor-decision/latency.ts \
  /workspace/scratch/monitor-context-latency-fixture/weights.json \
  /workspace/scratch/monitor-context-latency-fixture/decisions.jsonl 10000
```

Exit 0. After 256 warm-up turns, 10,000 measured turns over 48 pipeline-check rows had a p50 of 0.010455 ms and a p95 of 0.071987 ms. The pipeline threshold caused 10,000 abstentions, with zero timeouts, and the reasoner kept its original decision. The weights SHA-256 was `d8244261a902f0220c1ea7043dff477791bf9a55df3ee669da0ffbd70307a09e`.
