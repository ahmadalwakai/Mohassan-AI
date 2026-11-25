# Answer realizer

`src/index.ts` exports `realize(frame)`. It turns a verified `AnswerFrame` into Arabic or English using local grammar and sentence plans. It has no runtime dependencies. Callers supply the relation, ranking, plan outcome, memory content and evidence scope. For disagreements they supply each competing value with its attribution. The realizer uses those fields as given.

```ts
import { realize } from "./packages/realizer/src/index.js";

const reply = realize({
  intent: "calculation",
  language: "ar",
  conversationSeed: "conversation-key",
  numberStyle: "words",
  value: {
    kind: "number",
    amount: 3,
    unit: {
      ar: { gender: "masculine", singular: "كتاب", plural: "كتب", rational: false },
      en: { singular: "book" },
    },
  },
});
```

- Use the same `conversationSeed` and supply a different `replyIndex` for successive replies. The seed sets the starting sentence plan and the index cycles through three plans. The shorter presentation is the default. Detailed replies can show plan steps, memory recording dates and source labels.
- Arabic uses Modern Standard Arabic. Supply irregular noun forms in the frame, including broken plurals, irregular duals and accusative forms where applicable. A plural entity requires a plural form. Set `rational: false` for nonhuman plurals. Unit nouns should be Arabic lexemes in the Arabic locale. A quantity that requires an unavailable plural uses the exact digit and a parenthesized unit label.
- `numberStyle: "words"` uses Arabic cardinal words for nonnegative integral counts with a unit below one quadrillion and ordinal words through 99. Digit display keeps a compact unit label for zero, one, two and fractions. `digits` selects Western or Arabic-Indic digits for numeric displays. Arabic isolates inserted numbers and Latin or mixed-script labels for right-to-left display.
- English noun forms support article overrides, irregular plurals and mass nouns. Supply a measure noun or symbol as the unit for numeric values. Calendar fields accept full dates, month precision or year precision. `dateStyle` selects month-first English, day-first, or ISO-style numeric layout. The frame supplies the calendar and any approximation flag. The realizer formats that date directly.
- Single-source and approximate qualifiers can be combined. Source URLs stay in the frame alongside display labels. Dates attached to evidence retain their distinct observation scope. Contradictions use the disagreement frame, which attributes each reading separately.

## Producer examples

`src/adapters.ts` follows the structural contracts at the cited draft PR heads. The pinned base predates those additions, so the examples define the narrowest shapes they need and use type-only imports from the pinned code where available.

| Producer PR | Input represented by the example |
| --- | --- |
| #18 structured evidence | Selected number, range or date with observation date and source, or an attributed conflicting pair |
| #26 reasoning | Confirmed numeric result or explicitly typed approximate calendar conversion |
| #24 plan compiler | Execution status and supported step values, including an unverified effect |
| #31 structured memory | Stored value and its UTC recording date |
| #38 knowledge base | Supported Wikidata quantity with source attribution and available precision |
| #27 truth checks | Certainty from a measured verdict over an already structured fact, or a decline |

The examples decline for data that lacks a safe structured interpretation, such as prose-only comparisons, verbatim memory validity qualifiers and knowledge quantities that would lose precision. They have no live call sites.

## Development verification

The exact-output matrix under `tests/fixtures/answer-realizer/` enumerates frames locally from lexical paradigms, arithmetic, and calendar data. A separate reference computes exact expected strings. The matrix covers 816 cases, with 518 Arabic and 298 English cases. The matrix and focused probes are development fixtures produced by local code without any AI model or API and are never training data.

The blind rubric in `tests/answer-realizer-review.test.ts` receives the reply and its language only. A reply passes an axis when every rule for that axis passes.

| Axis | Scripted rules |
| --- | --- |
| Grammaticality | Complete utterance or labeled value, terminal punctuation, orthography and spacing, common agreement and article errors, repeated function words |
| Naturalness | Readable clause punctuation, balanced bidirectional isolates, absence of unresolved placeholders and control characters |

The scripted review passed both axes for 662 of 662 Arabic outputs and 442 of 442 English outputs. The grounding suite checks numeric literals, source and entity names from a controlled lexicon, and whole date tuples across 288 probes. Mutation controls add an unknown name, change a signed number, and recombine date fields. The exact-output matrix separately checks Arabic number words across noun genders and count ranges. Human fluency and live reply behavior remain unverified.
