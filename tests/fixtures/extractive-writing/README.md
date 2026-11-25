# Extractive writing fixtures

These evaluation-only excerpts reproduce pre-existing human-authored source prose. Every row declares `trainingAllowed: false`. Keep both files out of training datasets.

- `public-pages.json` contains 30 distinct Wikipedia pages, with 15 Arabic pages and 15 English pages. Every link points to a revision from 2021. The linked revision and its history credit the contributors. The excerpts are available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- `user-texts.json` contains 10 Arabic posts from the Wikisource community discussion archives and 10 English historical letters. The Arabic entries retain the poster's attribution, date and a pinned link to the archived section. They are available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The English excerpts are from public-domain letters by Jane Austen, George Washington, Carl Schurz and Horace Greeley, transcribed on English Wikisource. These excerpts stand in for text a user might paste.

The plain-text excerpts retain source wording. Formatting is limited to paragraph breaks, list markers, whitespace normalization and the removal of inline reference or page markers. Each entry has two `keyFacts` markers selected from its source before running the writing algorithm. A marker counts as covered if an output span contains the exact substring. Coverage measures the selected facts.
