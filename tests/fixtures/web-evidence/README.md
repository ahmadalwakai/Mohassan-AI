# Web evidence cassette

`cassette.json` holds the live search outcomes and HTTP page reads for the 12 frozen questions from `scripts/quality/council-questions.ts`. The recorder ran the real chat controller, with the judge's owner fix and withhold decisions and the single correction loop enabled. The checked-in capture fetched Wikimedia responses through the recording environment's HTTPS proxy. The recorded text is the reader's output after HTML cleanup and the bounded text window. Each read stores its requested and response URLs, title, text, HTTP status and `fetchedAt`. A null status means no page HTTP response was available.

Run the offline replay from the repository root.

```sh
npx vitest run tests/web-evidence-replay.test.ts
```

Replay checks the SHA-256 of the cassette bytes and the frozen question set, feeds the same search and read responses to the real controller, and fails on any unrecorded call or network attempt. A separate synthetic test, derived from the existing agent-cycle regression fixture, asserts that the judge rejects the first source and the controller sends the corrected answer from the second.

The expected quality result is 10/12, with `d5` and `e1` marked as expected failures for `fix/event-bound-dates`. Replay checks the fall date for `e1` because a chronology can contain `1989` without answering the question. The replay criterion for `p2` also accepts a sourced, dated estimate rounded from the UN's 2026 projection. This number is beyond the council script's frozen range, which continues to be reported by the recorder. The primary sources were retrieved 2026-11-27. [Berlin's account of the fall of the Wall](https://www.berlin.de/en/history/8482274-8619314-opening-and-fall-of-the-berlin-wall.en.html) · [UN World Population Prospects 2024, Medium variant CSV](https://population.un.org/wpp/assets/Excel%20Files/1_Indicator%20(Standard)/CSV_FILES/WPP2024_Demographic_Indicators_Medium.csv.gz)

The server defaults to the flat 60,000-character HTTP evidence profile. Set `MOHASSAN_SECTIONED_WEB_EVIDENCE=1` in the server environment before startup to enable the section-aware 200,000-character profile. The local index uses its 60,000-character extraction independently of this setting.

To refresh the live cassette, run this command from an internet-connected checkout. The recorder explicitly uses the section-aware profile captured in this cassette. It uses an in-memory database and the production search and HTTP reader, with the original eight-second spacing between questions. Review the score and the manifest diff before committing a new capture because Wikipedia's articles and rankings change.

```sh
npx tsx scripts/quality/record-web-evidence.ts
```

## Wikipedia attribution

The captured Wikipedia article text and search excerpts are by the contributors to the articles listed under `sources` in `manifest.json`. Each source link leads to the article and its contributor revision history. The manifest records the capture time and each result records its evidence time. The text is redistributed under CC BY-SA 4.0. The reader removed HTML, figures and some navigation, normalized whitespace and bounded the retained text. License and attribution terms retrieved 2026-11-27. [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) · [Wikimedia Terms of Use](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use)
