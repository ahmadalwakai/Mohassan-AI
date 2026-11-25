# Multisource explanation development fixtures

This agent-written set contains 60 development questions, with 10 each for why, how and comparison in Arabic and English. It covers the water cycle, changes of state, lunar phases and eclipses. The 95 key claims were marked before scoring. The questions and selectors were assembled from source topics and excerpts directly, with no calls to a model, AI API, model-based translation, or question generator. Use these fixtures for development evaluation only. They have never been used for training.

## Source snapshots

The 26 public snapshots were collected on 25 November 2026. Each page record has the source URL, page title, publisher, included text, and applicable reuse terms. To reconstruct a snapshot, fetch the cited page and extract its rendered article text. Normalize HTML layout whitespace, remove Wikipedia citation markers, and select the literal sentences shown in the snapshot in their original order. A blank line denotes an excerpt boundary. Editorial prose, illustrations, headlines added by the fixture, and site navigation are outside the source text. The evaluation runs against local snapshots and requires no live search or page access.

- **USGS, NOAA, and NASA** supply U.S. government public-domain prose. Only source article text is used. The respective copyright and media policies are recorded per page.
- **Wikipedia** excerpts are credited to the linked article's contributors under CC BY-SA 4.0. The linked articles provide author histories. The Arabic general water cycle article was excluded because it reproduces USGS text. The corpus uses separately edited topical articles instead.
- **OpenStax and the University of Tripoli Open Textbooks Initiative** supply the Arabic translation of *Concepts of Biology*, under the CC BY 4.0 notice in the chapter footer.
- **OpenStax via Physics LibreTexts** supplies text from the CC BY 4.0 edition of *Astronomy 2e*, by Andrew Fraknoi, David Morrison and Sidney Wolff.
- **NASA in Arabic** is a volunteer publication. Its terms permit attributed reuse of its translations for scientific and educational purposes. The third publisher on Arabic astronomy questions is the English-language LibreTexts text where an Arabic open snapshot was unavailable.

## Scoring

Each question supplies a frozen search-result list from at least three publishers. `keyClaims` records which source spans must be present for coverage. An `alternatives` entry marks another acceptable source span for the same key claim. The test credits each key claim at most once and validates every displayed citation against the page read and the exact characters retained by its evidence span.

Three cases also supply a deliberately false counterpart derived by reversing polarity in an identified source sentence. These test records have reserved `.test` URLs and identify the original real page in `seedOf`. The real snapshot remains intact. `conflicts` records both exact sides for conflict scoring.
