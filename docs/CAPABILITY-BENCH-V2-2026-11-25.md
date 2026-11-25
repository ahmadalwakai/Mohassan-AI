# Mohassan capability benchmark v2 — 25 November 2026

The v2 release contains **1,200 sealed cases**, 600 Arabic and 600 English, from seven public human-written datasets. The product baseline is `c2a0ff765071657cf200b5ee7d12fabaad738c0b`. PR #22 supplied the benchmark base at `a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f`. The runner and mapping used for this audit are from `0ee43007d5186b8963e9e4592d62fad06e4250e8`. [V1 root audit](AGENT-ROOT-AUDIT-2026-11-25.md) · [V2 data cards and mapping](CAPABILITY-BENCH-V2-DATA.md)

## Coverage and interpretation

The v1 source defines 14 area labels. Eight have a faithful v2 mapping with the checked datasets. Explanation, multi-step workflows, document and file handling, Google Ads, desktop and memory remain covered by v1. Available labels or answer spans did not establish the relevant explanations, artifacts, authorized actions or persisted state in those areas. Calculation, coding, supplied-history rewriting and small talk have enough eligible English material for a sealed stratum. Arabic clarification has two eligible sampled cases and a correspondingly wide interval. The public Arabic sources support a larger factual stratum. [Canonical areas](../scripts/agent-capability-bench/corpus.ts) · [Seal and strata](../scripts/agent-capability-bench/v2/manifest.json)

The offline harness uses the real controller with temporary PGlite state, isolated owners, recorded evidence and no conversation-model provider. A case passes when every v1 expectation passes. Wilson 95% intervals describe this stratified release. The Arabic and English rates reflect different source and area mixes. V1 and v2 use different prompts, quotas, and coverage. Factual lookup uses controlled evidence, CANARD tests a supplied-history rewrite against one reference, and MBPP tests routing and the requested interface. [Harness](../scripts/agent-capability-bench/observe.ts) · [Shared scorer](../scripts/agent-capability-bench/score.ts)

## Baseline results

One evaluation ran from `2026-11-25T02:53:34.012Z` to `2026-11-25T02:59:34.234Z` (360.2 s) on linux x64, Node.js `v24.22.3`, with the `Europe/London` timezone.

- Sealed payload SHA-256 `6ab7dac41ba54eccf0a48fd0958eada651e0c0fcb3a1156913bd6b9fdb25abbf`
- Aggregate receipt SHA-256 `1dfe91b449ea1a3844c23136cec0ec908dbfa9773f670a488188a55f6f81a33e`
- Manifest SHA-256 `f61ed0b9afc502b9ffea922a577416841cfb7b5ccd8f5b3a4971ff630dec2130`
- Baseline lockfile SHA-256 `be0681e77c59af142f13a81cf84a835322b654238e7a030739d2907cda325738`

| Group | Passed / total | Pass rate | Wilson 95% CI | p50 ms | p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| All cases | 247/1200 | 20.6% | 18.4%–23.0% | 42.1 | 1177.1 |
| Arabic | 191/600 | 31.8% | 28.2%–35.7% | 47.9 | 1187.9 |
| English | 56/600 | 9.3% | 7.3%–11.9% | 29.8 | 1156.3 |

| Area | Passed / total | Pass rate | Wilson 95% CI | Arabic passed / total (95% CI) | English passed / total (95% CI) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `small-talk` | 4/50 | 8.0% | 3.2%–18.8% | — | 4/50 (3.2%–18.8%) |
| `factual` | 203/515 | 39.4% | 35.3%–43.7% | 171/425 (35.7%–45.0%) | 32/90 (26.4%–45.8%) |
| `follow-up` | 0/95 | 0.0% | 0.0%–3.9% | — | 0/95 (0.0%–3.9%) |
| `comparison` | 40/70 | 57.1% | 45.5%–68.1% | 20/35 (40.9%–72.0%) | 20/35 (40.9%–72.0%) |
| `explanation` | — | — | — | — | — |
| `calculation` | 0/110 | 0.0% | 0.0%–3.4% | — | 0/110 (0.0%–3.4%) |
| `multi-step` | — | — | — | — | — |
| `document-file` | — | — | — | — | — |
| `coding` | 0/85 | 0.0% | 0.0%–4.3% | — | 0/85 (0.0%–4.3%) |
| `google-ads` | — | — | — | — | — |
| `desktop` | — | — | — | — | — |
| `memory` | — | — | — | — | — |
| `clarification` | 0/17 | 0.0% | 0.0%–18.4% | 0/2 (0.0%–65.8%) | 0/15 (0.0%–20.4%) |
| `refusal` | 0/258 | 0.0% | 0.0%–1.5% | 0/138 (0.0%–2.7%) | 0/120 (0.0%–3.1%) |

Refusal passed 0 of 258 cases. Routing was its first failed check in 187 cases, and understanding was first in 71. Factual and comparison passes accounted for 243 of the 247 passes.

## Failure attribution

The first failed check in the earliest failing turn assigns each of the 953 failed cases to one stage. The “any failed check” column can count a case in multiple stages. The stage marks where the rubric observed the failure. 176 cases had a turn report `completed` while failing a check.

| Stage | First failed check | Any failed check |
| --- | ---: | ---: |
| understanding | 269 | 269 |
| routing | 314 | 581 |
| planning | 0 | 12 |
| tool | 229 | 564 |
| answer | 140 | 685 |
| verification | 1 | 525 |

| Group | Understanding | Routing | Planning | Tool | Answer | Verification |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Arabic | 113 | 90 | 0 | 176 | 29 | 1 |
| English | 156 | 224 | 0 | 53 | 111 | 0 |
| `small-talk` | 13 | 32 | 0 | 0 | 1 | 0 |
| `factual` | 75 | 0 | 0 | 200 | 37 | 0 |
| `follow-up` | 0 | 61 | 0 | 0 | 34 | 0 |
| `comparison` | 3 | 0 | 0 | 23 | 4 | 0 |
| `calculation` | 102 | 2 | 0 | 6 | 0 | 0 |
| `coding` | 0 | 32 | 0 | 0 | 53 | 0 |
| `clarification` | 5 | 0 | 0 | 0 | 11 | 1 |
| `refusal` | 71 | 187 | 0 | 0 | 0 | 0 |

## Import accounting

| Dataset | Examined | Admitted | Dropped before sampling | Selected ar / en | Drop counts |
| --- | ---: | ---: | ---: | ---: | --- |
| `clinc150` | 5,500 | 267 | 5,233 | 0 / 125 | `no-faithful-mapping` 4,245, `oos-scope-unconfirmed` 988 |
| `massive` | 5,948 | 821 | 5,127 | 140 / 60 | `no-faithful-mapping` 4,762, `arabic-intent-unconfirmed` 365 |
| `mintaka` | 8,000 | 5,849 | 2,151 | 320 / 80 | `answer-in-question` 376, `boolean-answer` 1,146, `unlinked-answer` 134, `unsupported-answer-format` 192, `missing-entity-label` 303 |
| `tydiqa` | 1,361 | 1,357 | 4 | 140 / 45 | `no-scoreable-answer` 4 |
| `canard` | 5,571 | 4,408 | 1,163 | 0 / 95 | `no-previous-turn` 771, `no-context-dependent-rewrite` 392 |
| `gsm8k` | 1,319 | 1,319 | 0 | 0 / 110 | — |
| `mbpp` | 427 | 241 | 186 | 0 / 85 | `non-test-split` 170, `test-needs-imports` 13, `no-direct-entry-point` 3 |

## Original private-staging commands and checks

These historical commands built the release twice on the task branch. Each import verified the pinned source bytes. The three `cmp` checks exited 0. The sampler found zero exact normalized input overlaps with either pinned v1 partition among the admitted rows. The inventory command downloaded the public artifacts before the two builds. The custody paths below refer to the private audit workspace.

```bash
node --import tsx scripts/agent-capability-bench/v2/import.ts --cache /workspace/work/mohassan-public-source-cache --inventory true
umask 077
node --import tsx scripts/agent-capability-bench/v2/import.ts --cache /workspace/work/mohassan-public-source-cache --seed /workspace/work/mohassan-capability-custody/sampling-v2.seed --out /workspace/work/mohassan-capability-custody/release
node --import tsx scripts/agent-capability-bench/v2/import.ts --cache /workspace/work/mohassan-public-source-cache --seed /workspace/work/mohassan-capability-custody/sampling-v2.seed --out /workspace/work/mohassan-capability-custody/reproduction
cmp /workspace/work/mohassan-capability-custody/release/payload.json /workspace/work/mohassan-capability-custody/reproduction/payload.json
cmp /workspace/work/mohassan-capability-custody/release/manifest.json /workspace/work/mohassan-capability-custody/reproduction/manifest.json
cmp /workspace/work/mohassan-capability-custody/release/accounting.json /workspace/work/mohassan-capability-custody/reproduction/accounting.json
```

The following commands prepared the detached product worktree, exported only benchmark scripts from the frozen tooling commit and ran the baseline once. `--baseline true` verified the exact baseline commit and a clean tracked product tree. The only untracked files reported by Git were the benchmark scripts. The baseline exited 0. Its receipt and log were written in the private custody directory.

```bash
mkdir -p /workspace/work && git worktree add --detach /workspace/work/mohassan-capability-baseline c2a0ff7
(cd /workspace/work/mohassan-capability-baseline && npm ci --cache /workspace/work/npm-cache --no-audit --no-fund --prefer-offline)
git archive 0ee4300 scripts/agent-capability-bench | tar -x -C /workspace/work/mohassan-capability-baseline
cd /workspace/work/mohassan-capability-baseline
umask 077
TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright node --import tsx scripts/agent-capability-bench/run.ts --version 2 --baseline true --sealed /workspace/work/mohassan-capability-custody/release/payload.json --output /workspace/work/mohassan-capability-custody/baseline-c2a0ff7.json > /workspace/work/mohassan-capability-custody/baseline-c2a0ff7.log 2>&1
```

On the task branch, `npm run typecheck` exited 0 for the root and web projects. Chromium installed successfully with `PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright npx playwright install chromium`. The following affected suites passed **182/182 tests across 18 files**.

```bash
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright npm test -- tests/agent-capability-*.test.ts tests/controller-assessment.test.ts tests/assistant-local-computation-chat.test.ts tests/assistant-live-test-repairs-chat.test.ts tests/assistant-documents-chat.test.ts tests/assistant-campaign-request-chat.test.ts tests/assistant-desktop-chat.test.ts tests/assistant-judge-production.test.ts tests/assistant-context-chat.test.ts tests/assistant-local-memory-chat.test.ts tests/public-conversation-followup.test.ts
```

## Committed release verification

Commit `74290d7039615f3215ec7281d79415bbbee80d2a` packages the original payload and binary seed with source notices and a Wikipedia contributor index. The manifest pins all 18 files. All seven benchmark sources are redistributable with the included terms. Zero sources and zero cases were excluded for redistribution. The v1 loader rejects direct and symbolic-link paths into the v2 seal before opening corpus data. [Release README and honor rule](../tests/fixtures/agent-capability-bench/v2/sealed/README.md) · [Source licenses](../tests/fixtures/agent-capability-bench/v2/sealed/attribution/ATTRIBUTION.md)

Both imports exited 0. Every `cmp` and directory comparison exited 0. These compare each rebuilt file to the tracked checkout and then to the files independently exported from Git. The first rebuild fetched pinned sources and notices into a fresh cache, and the second verified the cached bytes.

```bash
set -euo pipefail
seal=tests/fixtures/agent-capability-bench/v2/sealed
check=/workspace/work/mohassan-v2-redistribution-check
install -d -m 700 "$check"
for build in first second; do
  node --import tsx scripts/agent-capability-bench/v2/import.ts --cache "$check/source-cache" --seed "$seal/sampling-v2.seed" --out "$check/$build" > "$check/$build.log"
  cmp scripts/agent-capability-bench/v2/manifest.json "$check/$build/manifest.json"
  while IFS= read -r -d '' file; do
    cmp "$file" "$check/$build/release/${file#"$seal"/}"
  done < <(git ls-files -z -- "$seal")
  printf '%s rebuild matched the committed manifest and all 18 release files\n' "$build"
done
diff -qr "$check/first/release" "$check/second/release" && cmp "$check/first/manifest.json" "$check/second/manifest.json"

bundle=/workspace/work/mohassan-v2-git-bundle/tests/fixtures/agent-capability-bench/v2/sealed
git show 74290d7:scripts/agent-capability-bench/v2/manifest.json > "$check/manifest.from-git.json"
for build in first second; do
  diff -qr "$bundle" "$check/$build/release"
  cmp "$check/manifest.from-git.json" "$check/$build/manifest.json"
done
```

A fresh detached worktree supplied the `c2a0ff7` product. The benchmark scripts and complete release bundle were exported from the packaging commit. After both rebuilds matched, the committed-payload baseline was run once.

```bash
git worktree add --detach /workspace/work/mohassan-capability-committed-baseline c2a0ff7
(cd /workspace/work/mohassan-capability-committed-baseline && npm ci --cache /workspace/work/npm-cache --no-audit --no-fund --prefer-offline)
git archive 74290d7 scripts/agent-capability-bench | tar -x -C /workspace/work/mohassan-capability-committed-baseline
mkdir -p /workspace/work/mohassan-v2-git-bundle
git archive 74290d7 tests/fixtures/agent-capability-bench/v2/sealed | tar -x -C /workspace/work/mohassan-v2-git-bundle
cd /workspace/work/mohassan-capability-committed-baseline
umask 077
TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright node --import tsx scripts/agent-capability-bench/run.ts --version 2 --baseline true --sealed /workspace/work/mohassan-v2-git-bundle/tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output /workspace/work/mohassan-v2-redistribution-check/baseline-c2a0ff7-committed.json > /workspace/work/mohassan-v2-redistribution-check/baseline-c2a0ff7-committed.log 2>&1
```

### Baseline result from the committed release

The rerun passed **247/1,200 cases (20.6%, Wilson 95% CI 18.4%–23.0%)**. Pass counts, Wilson intervals and failure-stage counts matched the original receipt in every reported group.

The run exited 0 and took 367.6 s from `2026-11-25T03:08:33.323Z` to `2026-11-25T03:14:40.889Z`. The aggregate receipt SHA-256 is `a70bf1a8f9fcdad996da253de2361186426db0446822c6dd8019bb5f9ec93e6b`. The payload SHA-256 remains `6ab7dac41ba54eccf0a48fd0958eada651e0c0fcb3a1156913bd6b9fdb25abbf`.

### Follow-up checks

`npm run typecheck` exited 0 for the root and web projects. The affected suites passed **190/190 tests across 20 files**, including the v1 development access guard and the v2 bundle checks.

```bash
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/mohassan-playwright npm test -- tests/agent-capability-*.test.ts tests/controller-assessment.test.ts tests/assistant-local-computation-chat.test.ts tests/assistant-live-test-repairs-chat.test.ts tests/assistant-documents-chat.test.ts tests/assistant-campaign-request-chat.test.ts tests/assistant-desktop-chat.test.ts tests/assistant-judge-production.test.ts tests/assistant-context-chat.test.ts tests/assistant-local-memory-chat.test.ts tests/public-conversation-followup.test.ts
```

The following Git checkout check also exited 0. It verified the pinned release bytes stay intact when Git is configured to convert line endings.

```bash
check=/workspace/work/mohassan-v2-redistribution-check
seal=tests/fixtures/agent-capability-bench/v2/sealed
manifest=scripts/agent-capability-bench/v2/manifest.json
git ls-files -z -- "$seal" "$manifest" tests/fixtures/agent-capability-bench/development.json tests/fixtures/agent-capability-bench/holdout/sealed.json | git -c core.autocrlf=true checkout-index -z --stdin --prefix="$check/crlf-checkout/"
diff -qr "$seal" "$check/crlf-checkout/$seal"
for file in "$manifest" tests/fixtures/agent-capability-bench/development.json tests/fixtures/agent-capability-bench/holdout/sealed.json; do
  cmp "$file" "$check/crlf-checkout/$file"
done
```
