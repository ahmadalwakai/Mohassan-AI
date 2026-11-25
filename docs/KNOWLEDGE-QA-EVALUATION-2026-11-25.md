# Offline knowledge QA evaluation and data card

يجرّب القياس نفس السؤال البشري بالعربية والإنجليزية عندما تتوفر ترجمة منشورة. يجيب موحسن من ملف محلي صغير ويحفظ رابط مراجعة ويكي بيانات وتاريخ اللقطة مع العبارات التي استند إليها. يُحسب طلب التوضيح والامتناع ضمن الأسئلة التي بقيت بلا جواب.

## Public questions

| Dataset | Provenance and license | Inputs in this evaluation |
| --- | --- | --- |
| Mintaka | Questions elicited from Mechanical Turk workers, linked to Wikidata, and professionally translated into Arabic. CC BY 4.0, Sen, Aji and Saffari (2022). [Paper](https://aclanthology.org/2022.coling-1.138/) · [Amazon Science](https://www.amazon.science/blog/amazon-releases-dataset-for-complex-multilingual-question-answering) · [Pinned license](https://github.com/amazon-science/mintaka/blob/b6146ffb41562803c45df3c028b4cdad8c09dd4d/LICENSE.md) | English questions and Arabic translations from the [published test file](https://github.com/amazon-science/mintaka/blob/b6146ffb41562803c45df3c028b4cdad8c09dd4d/data/mintaka_test.json). |
| QALD-10 | Human-curated questions with Wikidata SPARQL queries and published answer bindings. The authors specify the MIT license for the dataset, Jiang et al. (2023). [Paper](https://journals.sagepub.com/doi/10.3233/SW-233471) · [Pinned license](https://github.com/KGQA/QALD-10/blob/89caa86371c7a65c6c87a64e0eeaa0e247ff5fe5/LICENSE) | English from the [published test file](https://github.com/KGQA/QALD-10/blob/89caa86371c7a65c6c87a64e0eeaa0e247ff5fe5/data/qald_10/qald_10.json). Adds an independently collected English set with query-grounded lookup, qualifier and aggregate cases. |

The preparation script accepts scorable entity, quantity, Gregorian-formatted date, text or Boolean gold values. It omits missing answers and QALD bindings with unsupported RDF datatypes, multiple output variables or mixed binding types. It keeps each bilingual Mintaka question under one ID. It groups questions by dataset and question type, orders IDs by SHA-256 of the fixed version salt and dataset-qualified ID, and removes duplicate normalized utterances across both folds. A group contributes up to 8 development and 16 held-out IDs. Groups with fewer than 24 eligible IDs contribute at most one third to development and the remainder to held-out.

Mintaka retains its published complexity labels. The QALD types come from its SPARQL structure. The categories are `yesno` for `ASK`, `count` for `COUNT`, `superlative` for ordering with `LIMIT 1`, `qualified` for a qualifier predicate, `multirelation` for more than one remaining Wikidata predicate, and `lookup` for the remaining queries. These are dataset labels for breakdowns, independent of the parser result.

| Dataset | Development IDs | Held-out IDs | Held-out Arabic | Held-out English |
| --- | ---: | ---: | ---: | ---: |
| Mintaka | 72 | 144 | 144 | 144 |
| QALD-10 | 37 | 75 | 0 | 75 |
| Total | 109 | 219 | 144 | 219 |

The lock pins the raw source downloads in the preparation script and freezes the prepared JSONL bytes. The held-out SHA-256 is `f32edf677cb3c09dc4beda0a8f6ae12667ad82275f786e94b1bfddc1b34410cb`. The development SHA-256 is `f0bb335b6e5ac2a74db81a566f33fc83b2beb34e2279c35de7b081426746b0b9`.

## Wikidata evaluation slice

The local store projection starts from QIDs in Mintaka question annotations and constants in QALD SPARQL queries from both folds. Explicit gold answer fields contribute zero seeds. The runner passes raw question text and its language to the same QA entry point used by the shadow adapter. Thus the benchmark conditions on a subject-anchored slice. Coverage on an independently selected store can differ.

The projection follows a bounded set of geographic joins and a fixed set of item-valued predicate labels, then follows `P31` and up to seven additional `P279` class expansions for the stock importer. Subjects preserve the selected predicates with their original statement IDs, ranks, values, qualifiers and reference snaks. Label and class items preserve the classification predicates. The projection retains Arabic and English labels, aliases and descriptions and the sitelink site IDs used for the popularity prior. It normalizes optional snak `datatype` annotations that differ between MediaWiki response formats and keeps the canonical `datavalue.type`. The preparation script lists the retained predicates, including all 50 properties supported by the question parser at measurement. The revision lock records the individual revision IDs, retrieval date, source URL, selection counts and projected JSON SHA-256. Wikidata structured data is CC0 1.0. [Preparation script](../scripts/knowledge-base/qa/prepare-slice.py) · [Revision lock](../scripts/knowledge-base/qa/public-eval-lock.json) · [Data access](https://www.wikidata.org/wiki/Wikidata:Data_access) · [Licensing](https://www.wikidata.org/wiki/Wikidata:Licensing)

The 2026-11-25 projection has 398 seed QIDs and 6,904 projected entities, consisting of 1,013 subjects, 1,609 label items and 4,282 class items. It occupies 57,585,148 bytes and has SHA-256 `6b7644c40f747e60e019eca64bf32e9c10676a45d791997b56eef1e05bed15c0`. The stock importer retained 2,359 entities and 58,723 statements across its eight categories, with 4,545 projected records outside the resulting index. SQLite occupies 89,210,880 bytes. The archived facts are from their individually pinned Wikidata revisions, many of which predate the retrieval date.

Each rerun checks the same question and slice hashes. For a fresh slice, the preparer reads the pinned revision contents via the Wikidata API. The store is built with the ordinary category rules. Global rankings in this projection can only describe its indexed scope. The distribution here includes dataset-specific reasoning types, single- and multiple-valued questions, older gold answers and professionally translated Arabic. Dialect performance is covered by focused tests and remains unmeasured on this public holdout.

## Scoring

Accuracy divides correct responses by all questions. Coverage divides emitted answers by all questions. Abstention includes both explicit abstentions and unresolved choice cards. Answered accuracy divides correct responses by emitted answers. The score compares complete sets of typed values. Entity equality uses QIDs. Quantity equality is exact decimal equality in the nominal units expected by the gold values. Date equality uses the fields present in the gold date, with Gregorian calendar required. Text uses Unicode normalization, case folding and collapsed whitespace. A claimed answer also needs a statement, source URL and snapshot date. Booleans are scored as a separate gold type.

A wrong answer is an emitted claim set falling short of exact gold equality or lacking the required provenance. The report preserves those rows separately with dataset ID, gold values, predicted values and statement IDs. A discrepancy can result from a changed fact between the benchmark snapshot and this evaluation slice. Classification as wrong describes the exact-match score.

## Held-out results

| Language | Questions | Correct | Wrong | Explicit abstentions | Choice cards | Accuracy | Coverage | Abstention |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Arabic | 144 | 1 | 0 | 143 | 0 | 0.7% | 0.7% | 99.3% |
| English | 219 | 7 | 1 | 210 | 1 | 3.2% | 3.7% | 96.3% |
| Total | 363 | 8 | 1 | 353 | 1 | 2.2% | 2.5% | 97.5% |

| Dataset | Language | Question type | Questions | Accuracy | Coverage | Abstention |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Mintaka | Arabic | Comparative | 16 | 0.0% | 0.0% | 100.0% |
| Mintaka | Arabic | Count | 16 | 0.0% | 0.0% | 100.0% |
| Mintaka | Arabic | Difference | 16 | 0.0% | 0.0% | 100.0% |
| Mintaka | Arabic | Generic | 16 | 6.2% | 6.2% | 93.8% |
| Mintaka | Arabic | Intersection | 16 | 0.0% | 0.0% | 100.0% |
| Mintaka | Arabic | Multihop | 16 | 0.0% | 0.0% | 100.0% |
| Mintaka | Arabic | Ordinal | 16 | 0.0% | 0.0% | 100.0% |
| Mintaka | Arabic | Superlative | 16 | 0.0% | 0.0% | 100.0% |
| Mintaka | Arabic | Yes/no | 16 | 0.0% | 0.0% | 100.0% |
| Mintaka | English | Comparative | 16 | 0.0% | 0.0% | 100.0% |
| Mintaka | English | Count | 16 | 0.0% | 0.0% | 100.0% |
| Mintaka | English | Difference | 16 | 0.0% | 0.0% | 100.0% |
| Mintaka | English | Generic | 16 | 12.5% | 12.5% | 87.5% |
| Mintaka | English | Intersection | 16 | 0.0% | 0.0% | 100.0% |
| Mintaka | English | Multihop | 16 | 0.0% | 0.0% | 100.0% |
| Mintaka | English | Ordinal | 16 | 0.0% | 0.0% | 100.0% |
| Mintaka | English | Superlative | 16 | 0.0% | 0.0% | 100.0% |
| Mintaka | English | Yes/no | 16 | 0.0% | 0.0% | 100.0% |
| QALD-10 | English | Count | 16 | 0.0% | 0.0% | 100.0% |
| QALD-10 | English | Lookup | 16 | 31.2% | 37.5% | 62.5% |
| QALD-10 | English | Multirelation | 16 | 0.0% | 0.0% | 100.0% |
| QALD-10 | English | Qualified | 1 | 0.0% | 0.0% | 100.0% |
| QALD-10 | English | Superlative | 10 | 0.0% | 0.0% | 100.0% |
| QALD-10 | English | Yes/no | 16 | 0.0% | 0.0% | 100.0% |

Mintaka English coverage is 2/144 (1.4%) and QALD-10 English coverage is 6/75 (8.0%). Across both languages, 324 prompts used unsupported question shapes, 28 had no linked entity, one lacked comparable evidence, and one prompted an entity choice. Eight of nine emitted answers matched their gold sets. All nine included provenance. The split's coverage shows the limited grammar and relationship scope on naturally worded questions.

### Wrong answers

| Dataset ID | Language and type | Gold | Predicted | Difference |
| --- | --- | --- | --- | --- |
| QALD-10 270 | English lookup | `1919-01-01T00:00:00Z` | `1919` | The Wikidata statement gives year-level precision. Exact matching required the month and day in the published gold value. [Pinned Wikidata revision](https://www.wikidata.org/wiki/Special:PermanentLink/2573879995) |

The separate development run emitted one wrong answer on 72 Arabic prompts and three on 109 English prompts. It answered 3 Arabic prompts and 9 English prompts. The evaluator records wrong rows separately in the `wrong` array.

## Reproduction

Run from the repository root with Python 3 and Node.js 24. `artifact_dir` points to a directory outside the checkout for datasets, cache, SQLite store and reports.

```sh
artifact_dir=/workspace/scratch/knowledge-qa-data
PYTHONDONTWRITEBYTECODE=1 python scripts/knowledge-base/qa/prepare-questions.py "$artifact_dir"
PYTHONDONTWRITEBYTECODE=1 python scripts/knowledge-base/qa/prepare-slice.py "$artifact_dir"
npx tsx scripts/knowledge-base/build.ts wikidata --input "$artifact_dir/wikidata-slice.json" \
  --output "$artifact_dir/wikidata.sqlite" --source https://www.wikidata.org/wiki/Special:EntityData \
  --dump-date 2026-11-25
npx tsx scripts/knowledge-base/qa/evaluate.ts --data "$artifact_dir" --store "$artifact_dir/wikidata.sqlite" \
  --split held-out > "$artifact_dir/held-out-report.json"
npx tsx scripts/knowledge-base/qa/evaluate.ts --data "$artifact_dir" --store "$artifact_dir/wikidata.sqlite" \
  --split dev > "$artifact_dir/dev-report.json"
```

```sh
PYTHONDONTWRITEBYTECODE=1 python scripts/knowledge-base/qa/prepare-questions.py /workspace/scratch/knowledge-qa-questions-rebuild
PYTHONDONTWRITEBYTECODE=1 python scripts/knowledge-base/qa/prepare-slice.py /workspace/scratch/knowledge-qa-slice-cold-rebuild
cmp /workspace/scratch/knowledge-qa-data/wikidata-slice.json /workspace/scratch/knowledge-qa-slice-cold-rebuild/wikidata-slice.json
npx vitest run tests/knowledge-base-qa-scoring.test.ts
```

The independent question rebuild downloaded both pinned source files and reproduced both fold hashes. The cold slice rebuild fetched all 6,904 pinned revisions in a separate directory, resumed there after normalizing empty claims in the raw revision format, and exited 0 with the frozen SHA-256. The two projected files were byte-identical. The SQLite build and both evaluation commands exited 0, and the scoring suite passed 3 tests. The final evaluation started on 2026-11-25 at 02:29:39 UTC. The held-out report SHA-256 is `5297c85dec2b5575e2e21ec0dfb48dc3068027b7ef2f63615c1fa30ebbd5e7e7`.

A second SQLite build and held-out run from the cold projection exited 0. The reports were byte-identical.

```sh
npx tsx scripts/knowledge-base/build.ts wikidata --input /workspace/scratch/knowledge-qa-slice-cold-rebuild/wikidata-slice.json --output /workspace/scratch/knowledge-qa-slice-cold-rebuild/wikidata.sqlite --source https://www.wikidata.org/wiki/Special:EntityData --dump-date 2026-11-25
npx tsx scripts/knowledge-base/qa/evaluate.ts --data /workspace/scratch/knowledge-qa-data --store /workspace/scratch/knowledge-qa-slice-cold-rebuild/wikidata.sqlite --split held-out > /workspace/scratch/knowledge-qa-slice-cold-rebuild/held-out-report.json
cmp /workspace/scratch/knowledge-qa-data/held-out-report.json /workspace/scratch/knowledge-qa-slice-cold-rebuild/held-out-report.json
```
