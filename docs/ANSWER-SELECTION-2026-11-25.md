# Answer selection for read pages

The flagged chooser ranks quotations from pages Mohassan already read. `selection/word-forms.ts` extends the shared skills stemmer with clitic alternatives and a small reviewed table of Arabic forms. `selection/answer-types.ts` checks the kind of answer requested, and `selection/entity.ts` checks who or what the clause describes. For example, a line about a relative's age is ineligible for an age question about the named person. A comparison needs a quotation that relates both subjects on the requested attribute.

`selection/ranker.ts` scores eligible candidates using type strength, subject agreement, stem overlap, position and a small source prior. It records the individual contributions and abstains below 61 points. `SentenceScorer` is the interface for a future scorer. The eligibility checks run independently of that interface. HTTP and browser observations carry bounded structure in memory. Headings can inform a candidate, and list and table quotes must occur in the captured text after whitespace normalization.

The flag is `MOHASSAN_ANSWER_SELECTION=1` and defaults to off. The server emits `answer_selection_shadow` records comparing the old lead quote and the new choice. The records contain selection outcomes, agreement flags, scores and counts. They omit requests, URLs and quotation text. Explicit page fields, live facts and unsupported question types use their existing paths. The current live-fact checks remain in place while the ranker runs in shadow. Date and quantity checks here identify answer-bearing quotations. Value parsing, time references, units, freshness and conflict reporting belong to structured evidence. [PR #18](https://github.com/ahmadalwakai/Mohassan-AI/pull/18)

## Development replay

The corpus replays both flag settings through `runHands` with the same fixed search hits and page excerpts. Each hit's snippet comes from the beginning of its excerpt. The evaluator grades the lead quotation against literal source fragments. An abstention includes a supported case for which the chooser returns no lead. Cases are weighted equally. This replay excludes live search, translation and downstream judge decisions. The article excerpts come from 62 version-pinned Wikipedia pages. The 232 development questions were written by agents inspecting the sources and are excluded from training. [Fixture provenance and license](../tests/fixtures/answer-selection/README.md)

| Language | Chooser | Correct | Wrong | Abstained |
| --- | --- | ---: | ---: | ---: |
| Arabic | Current | 42 | 42 | 27 |
| Arabic | Flagged | 25 | 5 | 81 |
| English | Current | 63 | 34 | 24 |
| English | Flagged | 39 | 2 | 80 |

Across the 30 cause questions, the current chooser selected 6 correct answers, showed 3 wrong answers and abstained 21 times. The flagged path selected 9 correct answers, showed zero wrong answers and abstained 21 times. Arabic contributed 3 and 4 correct answers respectively. English contributed 3 and 5. This is a different set of questions from the historical 23-question run.

The flagged path selected the telephone invention, Messi age and Algeria independence quotations. It selected both supported cross-entity comparisons in the regression checks and abstained on the two unsupported English comparisons. It abstained on why the Red Sea has its current name and missed the Arabic sky-color explanation. Across the corpus it reduced wrong leads from 76 to 7 and selected 41 fewer correct leads. The default remains off.

## Checks

- `npm run typecheck` passed.
- `npm test -- tests/assistant-selection-corpus.test.ts tests/assistant-selection-ranker.test.ts tests/assistant-selection-hands.test.ts tests/assistant-selection-answer-types.test.ts tests/assistant-selection-entity.test.ts tests/assistant-selection-word-forms.test.ts --disableConsoleIntercept` passed, 45 tests in six files.
- `npm test -- assistant-hands assistant-reason-question assistant-date-questions assistant-sentence-cleanup assistant-answer-layout assistant-releases assistant-two-sources answer-check page-cache assistant-readable-page skill-reader` passed, 259 tests in 24 files.
- `PLAYWRIGHT_BROWSERS_PATH=/tmp/mohassan-answer-playwright npm test -- tests/assistant-selection-browser.test.ts packages/browser/src/agent-browser-idle.test.ts packages/browser/src/agent-browser-settle.test.ts` passed, eight tests in three files.
- `git diff --cached --check` passed.
