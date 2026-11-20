# مهمة Codex: الاختبار المستقل الجديد (independent-v2)

Write the fresh, frozen final test for the Ads goal model. A separate agent is training the
model now; your set is the only thing that will judge it, once.

## What to produce

`artifacts/ads-training/independent-v2/` with:

- `build-independent.ts`: the hand-authored cases and the build script, in the same shape as
  `artifacts/ads-training/independent-v1/build-independent.ts`.
- `goal_independent.jsonl`: **100 English and 100 Arabic** rows, same row schema as
  `artifacts/ads-training/independent-v1/goal_independent.jsonl` (`split: "test_independent"`,
  `trainingAllowed: false`, `prompt`, `target`, `expected`, `category`, `language`).
- `manifest.json`: row counts, categories, authoring note, and the file's SHA-256.

## Rules for the labels

Follow `docs/ADS-GOAL-LABELING-GUIDE.md` exactly. Every row must pass `checkGoal` with no
issues and `goalToPointer` must not return `null` (the build script throws otherwise).
Where the guide says "avoid in test sentences", avoid it.

## Rules for the sentences

- Write them yourself, the way real business owners type. Vary length, order of details, tone,
  punctuation and sentence count.
- Arabic: mix Modern Standard, Gulf, Egyptian and Levantine wording; mix Arabic-Indic and
  Western digits; include some English words inside Arabic sentences.
- New businesses, services, cities and domains: do not reuse the services, places or domains
  of independent-v1.
- Roughly 55% plain requests and 45% hard cases, spread over both languages: reordered details,
  missing details stated in words, negated goal, negated or corrected location, corrected
  budget, two amounts undecided, two websites undecided, missing currency, missing period,
  number inside a domain, grouped and decimal numbers, attached Arabic prepositions and
  conjunctions, multi-word places, and `other` requests (questions, reports, pause/edit of an
  existing campaign, website check, unrelated task, explicit "do not create").

## Independence

- Do **not** open or read: `scripts/ads-training/goal-grammar.ts`,
  `scripts/ads-training/generate-goal-tagger.ts`, `artifacts/ads-training/tagger-*`,
  `packages/execution-pipeline/execution_pipeline/goal_tagger.py`, or any model answers.
- You may read `scripts/ads-training/goal.ts`, `scripts/ads-training/pointer.ts`, the guide and
  independent-v1.
- Do not run any model on your set and do not change `goal.ts` or `pointer.ts`. If a label you
  believe is right fails the checker, drop that sentence and write another.
- Touch only files inside `artifacts/ads-training/independent-v2/`. Commit nothing.

## Done

`npx tsx artifacts/ads-training/independent-v2/build-independent.ts` runs clean and writes the
three files. Report only the counts and the SHA-256, not the sentences.
