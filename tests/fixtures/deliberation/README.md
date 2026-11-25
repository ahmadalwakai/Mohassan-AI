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
node node_modules/vitest/vitest.mjs run tests/deliberation-benchmark.test.ts
```

The first command fits temperature on development observations with binary negative log likelihood. The grid runs from 0.25 to 10 in 0.25 steps, followed by even values from 12 to 50. The route fit estimates the probability that the top eligible candidate is the expected act route. The decision fit recomputes decisions using the fitted route temperature, then holds those decisions fixed while fitting the probability that the selected act, ask, or abstain decision is correct. The fitted route temperature was 5.5 on 112 eligible development observations, with mean negative log likelihood 0.592459. The fitted decision temperature was 4.5 on all 296 development observations, with mean negative log likelihood 0.626957. Write and Ads routing use a fixed policy temperature of 2 because this slice lacks configured write and Ads handlers. Their calibration remains unverified.

The other benchmark modes run the actual command-chat controller in a temporary in-memory database with activation disabled and learning disabled. Every case starts a new owner conversation. The search adapter returns an empty result set and browser actions and network requests are disabled. Both scores come from the same run's observed first-match and shadow decisions. This measures dispatch choice, independently of tool success and answer quality. The runner fails if a case lacks an observed first-match decision or its trace. The development mode adds per-intent counts.

Accuracy requires an exact act route or the exact ask/abstain decision. The wrong-action rate counts any act on a different route or when ask/abstain was expected. The unnecessary-question rate counts an ask when act or abstain was expected. Each rate uses all messages as its denominator. ECE uses ten equal-width confidence bins and weights each bin's absolute confidence-to-accuracy gap by its population. The deterministic first-match path supplies no probabilities, so its ECE uses a fixed confidence of 1 as an explicit comparison convention. The benchmark also reports misses corrected and introduced by deliberation and lists example case IDs.

## Results

The benchmark completed with all 448 first-match decisions observed and corpus SHA-256 `768f6e0af9d982b0a25b1c6c7aabb50560174a83ed57a6088c0e7258e856e30e`.

| Path | Accuracy | Wrong-action rate | Unnecessary-question rate | ECE |
| --- | ---: | ---: | ---: | ---: |
| First match | 45.76% | 25.67% | 12.95% | 54.24% |
| Deliberation | 52.23% | 14.29% | 19.64% | 18.23% |

There were 77 disagreements, including 38 corrected wrong actions and 9 regressions. Corrected cases include unsupported private bank changes (`clinc-test-811`, `clinc-test-823`) and playback control (`clinc-test-994`). The benchmark test suite passed all four tests.

This benchmark covers English single-turn requests in the stated capabilities. Its labels inherit the scope of the selected public corpus, and upstream validation and test can share paraphrase patterns. Multilingual, contextual, advertising, permission, tool-outcome, and reply-quality performance are outside the benchmark's scope.
