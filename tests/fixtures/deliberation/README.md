# Deliberation decision benchmark

`clinc150.json` uses verbatim English utterances and intent labels from the human-crowdsourced CLINC150 release. Its 448 benchmark messages come from the upstream test split. Its 296 development messages come from the upstream validation split. The extractor preserves upstream row positions as IDs and removes duplicates across both splits. Development examples are used only for evaluation and scalar calibration. Neither split is used for training. The extractor makes no model or API calls.

This slice adapts the published intent classes to Mohassan's decisions through the explicit rules in `extract_clinc.py`. Local conversation and calendar/calculator requests have `chat` and `compute` act labels. Public facts have `web_search` act labels. Requests missing a place, expression, or other required operand ask for it. Private bank changes, SMS sends, and playback controls abstain when the corresponding integration is absent. The original intent class remains on each row. The act labels measure the intended route and allow different handlers on that route.

Source attribution goes to Stefan Larson, Anish Mahendran, Joseph J. Peper, Christopher Clarke, Andrew Lee, Parker Hill, Jonathan K. Kummerfeld, Kevin Leach, Michael A. Laurenzano, Lingjia Tang, and Jason Mars, *An Evaluation Dataset for Intent Classification and Out-of-Scope Prediction* (EMNLP-IJCNLP 2019). The upstream `data/data_full.json` is pinned at `828f8093932c8fe6ca7936c3d2e52903b1c523de`, SHA-256 `36923c3705a59e08fe9c3883d8bc2dd966ef93e22cb78ac41171782a698d56e0`. The redistributed slice retains its [CC BY 3.0 license](CLINC150-LICENSE.txt). [Paper](https://aclanthology.org/D19-1131/) · [Pinned source](https://github.com/clinc/oos-eval/blob/828f8093932c8fe6ca7936c3d2e52903b1c523de/data/data_full.json)

To regenerate the slice, pass a local copy of the pinned source to the extractor from the repo root.

```bash
python tests/fixtures/deliberation/extract_clinc.py /path/to/data_full.json
```

## Commands

```bash
node --import tsx apps/server/src/assistant/deliberation/benchmark.ts --fit-temperature
node --import tsx apps/server/src/assistant/deliberation/benchmark.ts --development
node --import tsx apps/server/src/assistant/deliberation/benchmark.ts
node --import tsx apps/server/src/assistant/deliberation/benchmark.ts --full-worktree /workspace/Mohassan-deliberation-full
node node_modules/vitest/vitest.mjs run tests/deliberation-benchmark.test.ts
```

The first command fits temperature on development observations with binary negative log likelihood. The grid runs from 0.25 to 10 in 0.25 steps, followed by even values from 12 to 50. The route fit estimates the probability that the top eligible candidate is the expected act route. The decision fit recomputes decisions using the fitted route temperature, then holds those decisions fixed while fitting the probability that the selected act, ask, or abstain decision is correct. The fitted route temperature was 5.5 on 112 eligible development observations, with mean negative log likelihood 0.592459. The fitted decision temperature was 4.5 on all 296 development observations, with mean negative log likelihood 0.626957. Write and Ads routing use a fixed policy temperature of 2 because this slice lacks configured write and Ads handlers. Their calibration remains unverified.

The default command runs the actual Phase 1 controller twice, using separate temporary in-memory databases with the flag off and on. Every case starts a new owner conversation with learning disabled. The search adapter records the attempted route and returns no results. Browser dispatch attempts are recorded without executing them, and network calls are disabled. The runner scores the observable outcome in each mode and separately scores the flag-off shadow proposal. A consultation can allow the legacy cascade to run, so the proposal is scored independently of the flag-on outcome.

A question card identifies an ask. The first mocked tool attempt identifies a search or browser action even when the result is unavailable. A recorded local computation or local sequence identifies that route. A completed direct answer is a chat action, corroborated by the ledger path or by an exact match to a deterministic local reply. A blocked or partial run that ends without those actions is an observed abstention. Phase 1 records the constrained dispatch candidate as a legacy estimate. The benchmark uses the observed outcome and fails on missing thought records or unclassifiable outcomes. The development mode adds per-intent counts.

Accuracy requires an exact act route or the exact ask/abstain decision. The wrong-action rate counts any act on a different route or when ask/abstain was expected. The unnecessary-question rate counts an ask when act or abstain was expected. Each rate uses all messages as its denominator. ECE uses ten equal-width confidence bins and weights each bin's absolute confidence-to-accuracy gap by its population. Decisions with no matching enforced policy confidence use a fixed confidence of 1 as a comparison convention. The benchmark also reports misses corrected and introduced by deliberation and lists example case IDs.

## Saved full implementation

The full implementation at `9cf2a80f6a803af05f8e0a9bfeac75b324f3cbf9` was rerun in a detached worktree with its own dependency install. Run its original calibration and benchmark from that worktree. The `--full-worktree` command above uses the same observation protocol as Phase 1 to measure the archived controller with the flag off and on.

```bash
git worktree add --detach /workspace/Mohassan-deliberation-full 9cf2a80
cd /workspace/Mohassan-deliberation-full
npm ci --offline --ignore-scripts --cache /tmp/mohassan-deliberation-npm
node --import tsx apps/server/src/assistant/deliberation/benchmark.ts --fit-temperature
node --import tsx apps/server/src/assistant/deliberation/benchmark.ts
```

The original full benchmark observed all 448 first-match paths with the flag off, alongside the full policy's shadow proposals. The corpus SHA-256 is `768f6e0af9d982b0a25b1c6c7aabb50560174a83ed57a6088c0e7258e856e30e`.

| Path | Accuracy | Wrong-action rate | Unnecessary-question rate | ECE |
| --- | ---: | ---: | ---: | ---: |
| Full version, observed first match | 45.76% | 25.67% | 12.95% | 54.24% |
| Full version, shadow proposal | 52.23% | 14.29% | 19.64% | 18.23% |

There were 77 disagreements, including 38 corrected wrong actions and 9 regressions. Corrected cases include unsupported private bank changes (`clinc-test-811`, `clinc-test-823`) and playback control (`clinc-test-994`).

## Comparable observed outcomes

The shared benchmark classified all 448 decisions in each flag mode for both implementations. Its flag-off outcome agrees across worktrees. The earlier first-match table observes handler selection, which can precede a guard stopping the request without an attempted action.

| Path | Accuracy | Wrong-action rate | Unnecessary-question rate | ECE |
| --- | ---: | ---: | ---: | ---: |
| Both, flag off observed outcome | 45.31% | 21.65% | 12.95% | 54.69% |
| Full version, flag on observed outcome | 52.46% | 13.84% | 19.64% | 18.04% |
| Phase 1, flag on observed outcome | 52.46% | 13.84% | 19.64% | 30.50% |
| Both, shadow proposal | 52.23% | 14.29% | 19.64% | 18.23% |

With the flag on, the full version enforced 446 decisions and 445 matched the observed outcome. Phase 1 intercepted 222 requests and all 222 produced the proposed ask or abstention. The remaining outcomes receive the fixed confidence convention, which affects the ECE comparison. Each implementation had two proposed acts without a matching observed route and 65 changes in observed outcomes, including 35 corrected wrong actions and three regressions. The focused benchmark suite passed six tests.

This benchmark covers English single-turn requests in the stated capabilities. Its labels inherit the scope of the selected public corpus, and upstream validation and test can share paraphrase patterns. Multilingual, contextual, advertising, permission, tool-outcome, and reply-quality performance are outside the benchmark's scope.
