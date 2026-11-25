# Clarification assessment fixture

This evaluation-only fixture is a deterministic adaptation of the human-authored
MASSIVE 1.0 dataset by Amazon.com Inc. or its affiliates. The fixture records the
release archive's SHA-256. The locale and `sourceId` fields identify each excerpt
in the corresponding source JSONL. [MASSIVE 1.0](https://github.com/alexa/massive) ·
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) ·
[Release archive](https://amazon-massive-nlu-dataset.s3.amazonaws.com/amazon-massive-dataset-1.0.tar.gz)

The utterance scaffolds are the original text on either side of one annotated
slot. Each candidate label is a distinct human-written annotated value from the
same locale. Each ambiguous subject is the shared first word of those labels.
The assessment replaces the scaffold's slot with either the short subject or one
full label, preserving all surrounding words. Candidate groups were selected by
source ID to exclude alternate spellings of the same name. No model, inference
API, weights, embeddings, or tokenizers produce or grade these cases. These are
synthetic development cases. Keep them out of training.

There are 25 candidate groups and three utterance scaffolds per language.
Crossing those within each language creates 75 ambiguous and 75 clear requests
in Arabic and the same counts in English. Pairs differ only in the subject.
These controlled pairs measure entity ambiguity and user-facing recovery.
They reuse a small number of scaffolds and have no independent holdout or
production coverage. Required-slot and competing-route behavior is tested
separately.

The public-search, page-reading, and browser callbacks are in-process fixtures.
They expose the declared candidate titles as a disambiguation page and the
selected title as a catalog result. URLs identify those local fixtures and are
never fetched. The catalog pages render each label's source record number and
locale mechanically. They contain no biographical or geographic claims.

Run both variants from the repository root with Node 24 and the installed
workspace dependencies. Choose a fresh output path.

```sh
node --import tsx scripts/clarification-assessment.ts /tmp/clarification-assessment.json
```

The report gives the question confusion matrix, exact candidate sets, individual
correct suggestions, and coverage of the intended choice. A resume dispatch
requires the original run ID, no further pending question, and a request for
the selected target observed by the search or page callback after the answer.
The report counts a completed answer when the run reaches completed status,
reads the expected catalog page, and names its expected title and source record.
Separate article-backed regressions exercise excerpts from real articles.
