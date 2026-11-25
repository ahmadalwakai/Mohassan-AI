# Extractive writing evaluation

Enable the chat route with `MOHASSAN_EXTRACTIVE_WRITING=1`. The default is off. The `extractive_writing_shadow` server event records the candidate operation, input kind, format, language, source count, quote count and completion status. With the flag off, the observer scores available literal text locally. For a request that would need a page or PDF read, it records the candidate and leaves completion unset.

## Corpus and method

The evaluation uses 30 archived public pages and 20 human-authored letters, requests and work notes. Each corpus is evenly split between Arabic and English. The [fixture README](../tests/fixtures/extractive-writing/README.md) documents provenance, licensing, and the evaluation-only designation. All 100 fact markers were selected from the source text before running the algorithm.

Run `npm test -- --disableConsoleIntercept tests/extractive-writing-corpus.test.ts` to reproduce the report. The suite measures the four summary formats on every excerpt and checks each selected quotation against its exact start and end offsets. A fact is covered when its marked substring appears in a selected span. The redundancy measure counts pairs with content-word Jaccard overlap of at least 0.65. One-line summaries have no pairs. The length budget applies to the quoted text before inline citations and formatting.

## Results

| Corpus | Language | Format | Facts covered | Similar pairs | Within length budget | All sentence slots filled |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Public pages | Arabic | One line | 6/30 | 0/0 | 15/15 | 15/15 |
| Public pages | Arabic | Paragraph | 19/30 | 0/45 | 15/15 | 15/15 |
| Public pages | Arabic | Bullets | 24/30 | 0/87 | 15/15 | 14/15 |
| Public pages | Arabic | Detailed | 30/30 | 0/228 | 15/15 | 1/15 |
| Public pages | English | One line | 14/30 | 0/0 | 15/15 | 15/15 |
| Public pages | English | Paragraph | 25/30 | 0/45 | 15/15 | 15/15 |
| Public pages | English | Bullets | 25/30 | 0/90 | 15/15 | 15/15 |
| Public pages | English | Detailed | 30/30 | 0/246 | 15/15 | 2/15 |
| User-style text | Arabic | One line | 4/20 | 0/0 | 10/10 | 10/10 |
| User-style text | Arabic | Paragraph | 13/20 | 0/30 | 10/10 | 10/10 |
| User-style text | Arabic | Bullets | 15/20 | 0/54 | 10/10 | 8/10 |
| User-style text | Arabic | Detailed | 19/20 | 0/163 | 10/10 | 4/10 |
| User-style text | English | One line | 3/20 | 0/0 | 10/10 | 10/10 |
| User-style text | English | Paragraph | 9/20 | 0/30 | 10/10 | 10/10 |
| User-style text | English | Bullets | 10/20 | 0/57 | 10/10 | 9/10 |
| User-style text | English | Detailed | 19/20 | 0/226 | 10/10 | 7/10 |

All 200 summaries fit the length limits, and none of the 1,301 tested quote pairs reached the overlap threshold. One-line coverage was 27/100, rising to 66/100 for paragraphs, 74/100 for bullets and 98/100 for detailed summaries. Sentence slots are upper bounds. The algorithm leaves slots empty when the excerpt or remaining word and character budgets cannot supply another distinct quotation.

## Scope of the checks

- The corpus measures marked-fact retention on archived excerpts. It provides no estimate of coverage for arbitrary public pages, complete PDFs, or production chat traffic.
- The chat tests exercise the guarded page-reading port with offline fixtures and exercise the existing PDF text extractor on a generated PDF containing verbatim public prose. The PDF path requires a text layer. Image-only scans need OCR outside this route.
- Explanation and comparison rely on textual cues and report «لم أجد» for missing evidence. Action extraction relies on literal instructions, checklist markers and explicit commitments. Chronological sorting uses the date forms supported by the parser.
