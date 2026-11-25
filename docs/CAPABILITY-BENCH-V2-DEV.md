# Capability benchmark v2 development split

Use the public, human-written v2 development cases to inspect failures and tune the controller. The runner uses the same expectations, scorer, and offline harness as the sealed release. The JSON report contains per-case checks, and its summary groups results by area, language, and area within language.

```bash
npm run assistant:capability-bench -- --v2-dev
```

Set `--output PATH` to choose the receipt location. Freeze the candidate commit and settings after tuning. Run the sealed acceptance benchmark once and keep its aggregate receipt. Never move cases between the dev and sealed splits. [Sealed acceptance command](../tests/fixtures/agent-capability-bench/v2/sealed/README.md)

## Split and source accounting

The dev sampler starts with the same seven pinned datasets and mappings used for the seal. It excludes sealed source IDs, normalized text from every sealed turn, and source families such as translated variants and turns from the same dialogue. The separate committed seed selects 2,400 cases, with 1,200 in each language.

The sampler targets twice each sealed source, area, and language quota, then reallocates shortages within the language. Comparison has 32 cases against a target of 140, clarification has 9 against 34, and refusal has 375 against 516. Factual lookup absorbs the largest share of the reallocated cases and makes up 51.8% of dev and 42.9% of sealed. Use the per-area results to compare progress across the two splits. [Development accounting](../tests/fixtures/agent-capability-bench/v2/dev/accounting.json) · [V2 data cards](CAPABILITY-BENCH-V2-DATA.md)

For fixture verification, rebuild into a fresh directory and compare it with the committed bundle. The importer reads the sealed fixture to apply the exclusions. [Source attribution and licenses](../tests/fixtures/agent-capability-bench/v2/dev/attribution/ATTRIBUTION.md)

```bash
check=$(mktemp -d)
node --import tsx scripts/agent-capability-bench/v2/import-dev.ts --cache "$check/cache" --out "$check/rebuilt"
diff -qr tests/fixtures/agent-capability-bench/v2/dev "$check/rebuilt"
```

## Baseline procedure

The product checkout was detached at `c2a0ff765071657cf200b5ee7d12fabaad738c0b`. The runner verified the pinned commit and a clean tracked product tree. The fixture and runtime files copied for the run matched commit `fe15cbd` byte for byte. These commands ran from the dev branch checkout, with Node.js `v24.22.3` on Linux x64.

```bash
git worktree add --detach /workspace/work/mohassan-v2-dev-baseline c2a0ff7
install -d -m 700 /workspace/work/mohassan-v2-dev-check
npm ci --cache /workspace/work/npm-cache --no-audit --no-fund --prefer-offline
(cd /workspace/work/mohassan-v2-dev-baseline && npm ci --cache /workspace/work/npm-cache --no-audit --no-fund --prefer-offline)
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright npx playwright install chromium
set -euo pipefail
tar -cf - scripts/agent-capability-bench tests/fixtures/agent-capability-bench/v2/dev | tar -xf - -C /workspace/work/mohassan-v2-dev-baseline
cd /workspace/work/mohassan-v2-dev-baseline
umask 077
TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright node --import tsx scripts/agent-capability-bench/run.ts --v2-dev --baseline true --output /workspace/work/mohassan-v2-dev-check/baseline-c2a0ff7.json > /workspace/work/mohassan-v2-dev-check/baseline-c2a0ff7.log 2>&1
```

## Baseline results

The single dev run exited 0 and took 924.7 seconds, from `2026-11-25T03:28:54.871Z` to `2026-11-25T03:44:19.523Z`. The dev payload SHA-256 is `6eda0e7052611d10fc87da4e3e8f3f30cfb64452c198eab20041b5da577508d1`. The JSON receipt SHA-256 is `ae7bba9f16570d8db17e72e08ca65862d97f2dcb07c83460a8622bd9b3e78810`. Sealed values come from the published PR #56 baseline. [Sealed baseline](CAPABILITY-BENCH-V2-2026-11-25.md#baseline-results)

| Area | Dev Arabic | Dev English | Dev overall | Sealed overall | Dev − sealed (pp) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `calculation` | — | 0/277 (0.0%) | 0/277 (0.0%) | 0/110 (0.0%) | 0.0 |
| `clarification` | 0/2 (0.0%) | 0/7 (0.0%) | 0/9 (0.0%) | 0/17 (0.0%) | 0.0 |
| `coding` | — | 0/155 (0.0%) | 0/155 (0.0%) | 0/85 (0.0%) | 0.0 |
| `comparison` | 17/26 (65.4%) | 6/6 (100.0%) | 23/32 (71.9%) | 40/70 (57.1%) | +14.7 |
| `factual` | 401/1017 (39.4%) | 69/227 (30.4%) | 470/1244 (37.8%) | 203/515 (39.4%) | −1.6 |
| `follow-up` | — | 0/240 (0.0%) | 0/240 (0.0%) | 0/95 (0.0%) | 0.0 |
| `refusal` | 0/155 (0.0%) | 0/220 (0.0%) | 0/375 (0.0%) | 0/258 (0.0%) | 0.0 |
| `small-talk` | — | 6/68 (8.8%) | 6/68 (8.8%) | 4/50 (8.0%) | +0.8 |
| **All** | **418/1200 (34.8%)** | **81/1200 (6.8%)** | **499/2400 (20.8%)** | **247/1200 (20.6%)** | **+0.2** |

Across the eight shared areas, the unweighted Pearson correlation of exact pass rates is **0.9905** and Spearman's rank correlation with average ranks for ties is **1.000**. Five areas tie at zero in both splits. Comparison has the largest absolute gap and only six English dev cases. This measures agreement for `c2a0ff7`. The effect of later controller changes on that agreement remains unmeasured.

Of the 1,901 failing dev cases, the first failed check was in understanding for 516, routing for 553, planning for 0, tool use for 556, answer for 274, and verification for 2. For refusal specifically, routing was first for 284 of 375 cases and understanding for 91.
