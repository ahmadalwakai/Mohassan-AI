# Answer selection development fixtures

`pages.json` contains excerpts from 62 distinct public Wikipedia pages, with 31 Arabic and 31 English articles. `questions.json` contains 232 agent-written development cases, with 111 Arabic and 121 English prompts. No separate model, external AI service, or question-generation API was called. Keep this visible development set out of training data. The labels have not been independently reviewed by a human.

## Source attribution and license

- The contributors to each Wikipedia article are its authors. Each row includes the article title, canonical URL and a pinned `revisionUrl`. The article history lists its contributors. Excerpts are provided under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), following the [Wikimedia Terms of Use](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use#7._Licensing_of_Content). This license applies to the article excerpts in `pages.json`.
- The source revisions were retrieved on 25 November 2026. The excerpts retain lead paragraphs, table rows, lists and selected sections with surrounding paragraphs and distractors. Formatting changes remove navigation, citations, scripts, images and hidden metadata, collapse intra-block whitespace and delimit retained table cells with ` | `. Sections and paragraphs outside the excerpts are omitted.
- Some excerpts contain facts that change with time. Judge answers against the captured revision. The age on the Lionel Messi page is the age displayed in the captured infobox. The later quoted sentence about his son describes a separate past event.

## Oracle and scope

Each question names its input documents in order with `pageIds`. Every inner array in `expected` lists fragments that must be present together in the answer quotation. Any one of those alternatives can be correct. An empty `expected` means the excerpts lack a sufficient single quotation and the chooser should abstain. A scoped regional or seasonal explanation cannot answer a general question about rain.

The documented regression cases include English telephone invention with the John Taylor distractor (`en-telephone-01`), Arabic Messi age with his son's age as a distractor (`ar-messi-01`), Algeria's independence with the verb and verbal noun forms (`ar-algeria-01`), general and scoped causes of rain (`ar-rain-01`, `en-rain-01`, `ar-rain-06`, `en-rain-05`), the origin of the Red Sea's current name (`ar-red-sea-01`), sky color (`ar-sky-01`, `ar-sky-02`, `en-sky-01`), and supported and unsupported comparisons (`ar-japan-04`, `ar-japan-05`, `en-africa-asia-area`, `en-amazon-nile-comparison`).

This is a replay over excerpts with explicit source pages. It measures selection given observed evidence. It does not measure live search, full-page browser extraction, answer translation, or generalisation to unseen evidence or questions.

## Calibration split

`split.json` records the page families assigned to development and holdout. Each family keeps translated pages and any pages referenced together in one question in the same partition. The SHA-256 for each partition covers the source records, questions and labels. The 68 holdout cases are part of the previously evaluated corpus. The split and calibration were fixed before the follow-up replay. [Holdout results](../../../docs/ANSWER-SELECTION-2026-11-25.md#holdout-results)
