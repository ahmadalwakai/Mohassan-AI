# Development capability benchmark

Run this launcher from a full clone. It builds a disposable detached Git worktree for each measured commit. The main checkout's source and local changes are independent of the measurement. Use a new output directory outside the clone and retain it to audit the run.

## Prerequisites

- Git, Node `24.22.3`, npm, Python `3.12.14` and Linux `libseccomp.so.2`. The release candidate's local Python verifier also needs a non-root account with a normal home and a trusted, root-owned Python installation. See the release candidate's [verifier development replays](../../docs/RELEASE-CANDIDATE-2026-11-25.md#verifier-development-replays).
- Playwright Chromium build `1248` (`156.0.8078.4`), including the headless shell and its shared libraries. The document cases use the headless renderer.
- npm access or a populated npm cache for each measured commit's lockfile. The benchmark itself uses temporary PGlite databases and fixture tools.

Make these pinned Git objects available locally:

| Input | Commit |
| --- | --- |
| V1 development bundle and runner, [#22](https://github.com/ahmadalwakai/Mohassan-AI/pull/22) | `a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f` |
| Review, structured-memory and clarification adapters, [#41](https://github.com/ahmadalwakai/Mohassan-AI/pull/41) | `0dfff7c54d3658a02cf878ff11faac7f630a6c10` |
| V2 published development bundle, [#62](https://github.com/ahmadalwakai/Mohassan-AI/pull/62) | `12cedfe592aab40cdd47ee00d05ea86a6d2bae89` |
| V2 runner and audit tree, [#70](https://github.com/ahmadalwakai/Mohassan-AI/pull/70) | `a1e1cb020b7ba093885edbf501149e7b8252c0cb` |

If missing, fetch the specific objects with `git fetch origin <full-sha>`. The launcher checks the V2 development tree against #62 before using the #70 runner. It runs only development fixtures, with V1 first. V1 uses the review and structured-memory adapters. V2 adds the clarification adapter and runs eight isolated lanes, assigned by case index modulo eight. The audit merge is local to the disposable worktree. The pinned scorer receives the same observer results, and the receipts also capture the public reply text per turn.

## Run

```bash
npm ci
export PLAYWRIGHT_BROWSERS_PATH=/absolute/path/to/chromium
npx --no-install playwright install chromium
python3 -B scripts/dev-bench/run.py \
  --output /absolute/path/to/frozen-receipts \
  --arm frozen=e7274aa6cc9aacbf3d03c1b3be572720cfb9c5a3
```

The wave 4 target is `176/240` on V1 and `1586/2400` on V2. Run without competing workloads, especially during V2 coding evaluation. The principal settings come from the [wave 4 runbook](../../docs/INTEGRATION-WAVE-4-2026-11-25.md#flags). For a paired run, repeat `--arm NAME=COMMIT` in measurement order, and use `--set NAME:KEY=VALUE` for that arm's rollout flags. See the wave 5 report for the release and candidate arm commands. `--workers 1` runs all eight V2 lanes serially, as in the release candidate's final comparison. `--offline` uses the npm cache selected by `npm_config_cache` and supports a network-disabled runner with a populated cache.

`Dockerfile` recreates the Linux runtime for commits with the hardened verifier. Build it with `docker build -t mohassan-wave5-bench:2026-11-25 scripts/dev-bench`. The container uses an unprivileged account and root-owned Python. For each arm in that runtime, pass `--set NAME:TEST_DRIVEN_CODING_PYTHON=/usr/local/bin/python3.12`. Mount the clone, Chromium and populated npm cache at the paths used by the launcher and run with Docker networking disabled.

`summary.json` records the measured commits, input and tool SHA-256 digests, effective settings, toolchain, receipt hashes and recomputed summaries. Each arm directory has the V1 and eight V2 lane receipts plus the validated `receipt.json` with cases in release order. If the product writes a model-relations shadow journal, it is copied into the output for latency measurement. Keep this directory local. The receipts contain development reply text, and the coordinator prints counts and commit IDs.

Run the parity and subgroup checks against the coordinated receipts:

```bash
python3 -B scripts/dev-bench/compare.py \
  --baseline /absolute/path/to/paired-receipts/a/receipt.json \
  --flags-off /absolute/path/to/paired-receipts/b/receipt.json \
  --flags-on /absolute/path/to/paired-receipts/c/receipt.json \
  --output /absolute/path/to/paired-receipts/comparison.json
```

When a repeated baseline proves that a reply value varies, supply `--baseline-repeat` with that baseline's coordinated receipt and `--reply-masks` with a JSON array. Each entry names `version`, `caseId`, 1-based `turn`, and a `values` object with the exact `baseline`, `baselineRepeat` and `flagsOff` literals. Each literal must occur once in its specified reply. The comparator requires identical surrounding text and records hashes of the masked values.

## Smart monitor comparison

Run the three arms together with `--offline --audit-monitors` in a network-disabled container. Apply [PR #95's arm C settings](../../docs/INTEGRATION-WAVE-5-2026-11-25.md#three-arm-development-run) and `MOHASSAN_MONITORS_ENABLED=1` to every arm. Set `MOHASSAN_MONITORS_V2=0` on the pinned monitor baseline and the candidate's flags-off arm, and set it to `1` on the same candidate commit in the flags-on arm.

For the Phase 2 source comparison, enable `MOHASSAN_MONITORS_V2=1` on every arm. Set `MOHASSAN_MONITORS_GITHUB`, `MOHASSAN_MONITORS_PDF` and `MOHASSAN_MONITORS_VISUAL` to `0` on the v2 baseline and candidate flags-off arms and to `1` on the candidate flags-on arm.

The audit uses a deterministic UUID stream scoped to each fixture and a fixed recorded-source timestamp. It keeps the native scorer, runs the production decisions, and serves monitor reads from the case's recorded pages. Temporary worktrees record the instrumented file hashes. No holdout data is materialized.

Add `--monitor-requests /path/to/reviewed-ids.json` to the comparison command. The file maps `v1` and `v2` to arrays of published case IDs whose users ask for monitoring. Review the actual case turns before classifying requests, including quoted and private-source requests. The comparison checks identical case verdicts, scored turn details and replies between the first two arms and checks every group for score loss in the enabled arm. It fails on any published offer outside the reviewed IDs. It reports matching IDs and turn numbers, plus nearest-rank p50 and p95 decision time summed per turn when the checker ran.

## Historical PR #89 controls

In a separate detached checkout at `7f9c417f2e06b77c26eb6ff677d06e3457da650b`, install that lockfile and run its own `scripts/response-policy/development-bench.mjs` with `prepare OUTPUT` followed by `off OUTPUT 4`. To reproduce the browser-missing run, use a normal account without a default Playwright browser install and leave `PLAYWRIGHT_BROWSERS_PATH` unset for those two commands. Then run the controls from that checkout:

```bash
bash /path/to/integration-clone/scripts/dev-bench/forensics/case-probes.sh \
  /path/to/legacy-output /path/to/canonical-receipt.json \
  /path/to/new-evidence /path/to/chromium
```

The control script derives the affected V2 case IDs from the receipt comparison. It repeats the V1 document-file cases with Chromium, then tests those V2 cases with each inherited classifier restored in isolation. [Commands and results](../../docs/INTEGRATION-WAVE-5-2026-11-25.md#pr-89-reproduction-and-5-whys)
