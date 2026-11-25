# Answer selection for read pages

The flagged chooser ranks quotations from pages Mohassan already read. `selection/word-forms.ts` extends the shared skills stemmer with clitic alternatives and a small reviewed table of Arabic forms. `selection/answer-types.ts` checks the kind of answer requested, and `selection/entity.ts` checks who or what the clause describes. For example, a line about a relative's age is ineligible for an age question about the named person. A comparison needs a quotation that relates both subjects on the requested attribute.

`selection/ranker.ts` scores eligible candidates using type strength, subject agreement, stem overlap, position and a small source prior. It records the individual contributions and abstains below 61 points. `SentenceScorer` is the interface for a future scorer. The eligibility checks run independently of that interface. HTTP and browser observations carry bounded structure in memory. Headings can inform a candidate, and list and table quotes must occur in the captured text after whitespace normalization.

The flag is `MOHASSAN_ANSWER_SELECTION=1` and defaults to off. With the flag on, the calibrated ranker gets first choice. When it abstains, the legacy lead can be used if it is grounded in the same read source and passes both the answer-type and entity checks. The existing abstention text is used when the lead fails either check or the question type is unsupported. Explicit page fields and live facts continue through their existing paths. The `answer_selection_shadow` record includes the selection path and omits requests, URLs and quotation text. Date and quantity checks identify answer-bearing quotations. Value parsing, time references, units, freshness and conflict reporting belong to structured evidence. [PR #18](https://github.com/ahmadalwakai/Mohassan-AI/pull/18)

## Page split and calibration

The replay runs all three choosers through `runHands` with the same fixed search hits and page excerpts. It grades the lead quotation against literal source fragments. The corpus has 232 agent-written cases from 62 revision-pinned Wikipedia pages. It was evaluated as a single development corpus in the initial implementation. The new split was fixed before follow-up calibration. Related Arabic and English page versions and pages referenced by the same question stay together. [Fixture provenance and license](../tests/fixtures/answer-selection/README.md)

| Partition | Pages | Arabic cases | English cases |
| --- | ---: | ---: | ---: |
| Development | 44 | 77 | 87 |
| Holdout | 18 | 34 | 34 |

The holdout SHA-256 is `dda5539833425ac8700c755876356adc7adacf33e44d3692fe1940094a72f10f`. It covers page records, prompts and answer labels. The split manifest SHA-256 is `f8bbb31fe202bca8aef6af0540075a1ace67bc305ffc7f1e0bfcc4a9b1b91d43`. Commit `4d6e2ab` froze the partition. Commit `8560956` locked the chooser and calibration before the holdout replay. [Split manifest](../tests/fixtures/answer-selection/split.json)

The development grid tried 729 shared weight and threshold settings. It preferred settings within each language's wrong-lead budget, then maximized correct leads, minimized wrong leads and favored the smaller change from the original weights. The winning setting increased the type weight from 12 to 16 and kept the threshold at 61. It returned 14 correct Arabic leads and 26 correct English leads with zero wrong leads. Those were all the development cases with a correct lead available under the evidence checks. The current chooser returned 30 and 46 correct leads respectively. [Calibration and replay](../tests/assistant-selection-corpus.test.ts)

## Holdout results

Cells show the count and its two-sided 95% Wilson interval as a percentage of the 34 cases for that language. Case-level intervals describe the replay. Several questions share each page, so the intervals do not account for clustering by page. The original flagged ranker replays the initial flag-on behavior, including its passthrough for unsupported question types.

| Language | Chooser | Correct | Wrong | Abstained |
| --- | --- | ---: | ---: | ---: |
| Arabic | Current | 12 [21.5–52.1%] | 15 [28.9–60.5%] | 7 [10.3–36.8%] |
| Arabic | Original flagged ranker | 8 [12.4–40.0%] | 0 [0.0–10.2%] | 26 [60.0–87.6%] |
| Arabic | Combined | 7 [10.3–36.8%] | 0 [0.0–10.2%] | 27 [63.2–89.7%] |
| English | Current | 17 [34.1–65.9%] | 10 [16.8–46.2%] | 7 [10.3–36.8%] |
| English | Original flagged ranker | 11 [19.1–49.2%] | 2 [1.6–19.1%] | 21 [45.0–76.1%] |
| English | Combined | 6 [8.3–33.5%] | 0 [0.0–10.2%] | 28 [66.5–91.7%] |

The combined chooser met the wrong-lead cap in both languages, with zero against caps of five in Arabic and three in English. It missed the correct-lead target by five in Arabic and eleven in English. No holdout legacy lead qualified for fallback after a ranker abstention. Live search, translation and downstream judge decisions are outside the replay.

## Follow-up checks

- `npm run typecheck` passed.
- `npm test -- tests/assistant-selection-corpus.test.ts -t 'calibrates on development pages only' --disableConsoleIntercept` passed, one test with the other two skipped.
- `npm test -- tests/assistant-selection-corpus.test.ts --disableConsoleIntercept` passed, three tests including holdout replay.
- `npm test -- tests/assistant-selection-ranker.test.ts tests/assistant-selection-hands.test.ts tests/assistant-selection-split.test.ts tests/assistant-selection-metrics.test.ts tests/assistant-hands.test.ts tests/assistant-answer-layout.test.ts tests/assistant-date-questions.test.ts tests/assistant-sentence-cleanup.test.ts tests/assistant-releases.test.ts tests/assistant-two-sources.test.ts` passed, 135 tests across ten files.
- `PLAYWRIGHT_BROWSERS_PATH=/tmp/mohassan-answer-playwright npm test -- tests/assistant-selection-browser.test.ts tests/assistant-selection-answer-types.test.ts tests/assistant-selection-entity.test.ts tests/assistant-selection-word-forms.test.ts` passed, 30 tests across four files.
- `git diff --check` passed. `git diff --exit-code b24f19f -- apps/server/src/assistant/hands.ts apps/server/src/app.ts apps/server/src/command-chat.ts packages/browser/src/agent-browser.ts packages/browser/src/index.ts packages/browser/src/research.ts packages/execution-pipeline packages/execution-model` returned no differences.

## Initial full-corpus replay

| Language | Chooser | Correct | Wrong | Abstained |
| --- | --- | ---: | ---: | ---: |
| Arabic | Current | 42 | 42 | 27 |
| Arabic | Flagged | 25 | 5 | 81 |
| English | Current | 63 | 34 | 24 |
| English | Flagged | 39 | 2 | 80 |

Across the 30 cause questions, the current chooser selected 6 correct answers, showed 3 wrong answers and abstained 21 times. The flagged path selected 9 correct answers, showed zero wrong answers and abstained 21 times. Arabic contributed 3 and 4 correct answers respectively. English contributed 3 and 5. This is a different set of questions from the historical 23-question run.

The original flagged path selected the telephone invention, Messi age and Algeria independence quotations. It selected both supported cross-entity comparisons in the regression checks and abstained on the two unsupported English comparisons. It abstained on why the Red Sea has its current name and missed the Arabic sky-color explanation.
