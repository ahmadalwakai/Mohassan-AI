# Optional TypeScript slot inference bridge

`apps/server/src/assistant/slot-tagger.ts` loads the frozen own slot candidate
without Python, subprocesses, filesystem access or a provider. It is not imported
by application routing or context code. The candidate and export remain inactive.

The reviewable immutable export is
`artifacts/brain-slot-development-v1/typescript-export-v1-20261121-b`.
Its manifest, flat little-endian float32 weights, independent NumPy parity cases,
provenance and exporter source snapshot are covered by `checksums.json`.
The earlier export `typescript-export-v1-20261121-a` remains unchanged.

Model ID:
`8cbf99a72abcf18d433a4be4a659aa812c71c88ce814a0a35dc5522da0c7846a`.
Weights SHA-256:
`ece9ceb346bf71265f6f26e82d04e60207b5d0fe6b8a4863a327107f9b076fad`.
The 799,565 weights occupy 3,198,260 bytes; metadata occupies 49,623 bytes.

## Caller contract

```ts
import { loadSlotTagger } from './slot-tagger.js';

// The host reads the two files once and can pin the reviewed content ID.
const tagger = loadSlotTagger(manifestBytes, weightsBytes, {
  expectedModelId: reviewedModelId,
});
const result = tagger.infer(currentUserText);
// result.hypotheses: calibrated date/place hypotheses only.
// result.raw: diagnostic predictions, including rejected labels/confidences.
```

The loader accepts JSON bytes, a JSON string or plain metadata. It rejects unknown
fields, tensor names/order/shapes/offsets, mismatched byte counts or SHA-256,
unsupported labels/features/Unicode tables, nonfinite or oversized weights and
out-of-bound metadata. It copies the weights and metadata rather than retaining
mutable caller references. Content hashes detect changes; a trusted expected
model ID is the caller's pin, and hashes alone do not authenticate a source.

Model IDs use typed IEEE754 numeric canonicalization so Python `1.0` and JavaScript
`1` produce the same address. The manifest binds source candidate/split/calibration
hashes and every feature/decoder parameter. The source is the unchanged candidate
`first-cpu-20261121-a`; no retraining or threshold fitting occurs during export.

Input must be nonempty, contain a non-whitespace character, have at most 512
Unicode codepoints and produce at most 80 tokens. The complete string is checked
before token/model output allocation. The model refuses excess input instead of
silently truncating it. Each token also has a 1,600-feature bound. A bounded FIFO
cache holds at most 512 token embedding vectors.

The tokenizer implements the frozen Python Unicode 14.0 word, digit, uppercase,
space and lowercase definitions rather than JavaScript's ASCII `\w`. Unpaired
surrogates and codepoints unassigned in Unicode 14.0 are rejected. In particular,
Python whitespace includes U+001C and U+0085, while U+FEFF is a punctuation token.
Feature-only NFC/Arabic folding preserves original source boundaries.

Every span includes literal `text`, half-open `startCodepoint`/`endCodepoint` and
`startUtf16`/`endUtf16`. JavaScript callers slice with UTF-16 offsets; Python callers
slice with codepoint offsets. No date resolution, geocoding or new facts are
produced. `kind: 'hypothesis'` is not permission, evidence of correctness or
authority to change a public query. The host must separately validate relevance.

## Decode and calibration

The implementation uses the frozen hashed token/character features, mean
embedding, bidirectional GRU, classifier and legal BIO Viterbi decoder. Raw labels
include place/date/time/time-of-day/time-zone/news-topic. Only `date` and `place`
can appear in `hypotheses`; all other labels always abstain even at high confidence.
Confidence is the minimum predicted-tag posterior over the span. The original
temperature and thresholds are unchanged: temperature 1, date
0.7894228199771891 and place 0.9372185292962671.

`inspect()` additionally returns bounded tokens, feature IDs, flags, logits and
tag indices for independent lab parity checks. It is diagnostic rather than a
conversation logger. All public output objects/arrays are frozen.

## Verification and measured performance

The exporter uses NumPy and reads only the frozen public-data candidate. It first
checks every candidate checksum and compares its independent NumPy implementation
with the frozen candidate's original parity logits (maximum difference
0.0000038147). Thirteen new independent strings cover Arabic/English, repeated
entities, astral characters, combining marks, Turkish casing, Unicode numerals
and Python-specific whitespace. These are parity strings without gold extraction
labels; they do not estimate model accuracy or influence calibration.

TypeScript matched NumPy token boundaries, features, flags, BIO paths and selective
decisions on all those strings. Maximum logit difference was 0.0000008382 and
confidence difference was 0.0000002064. The always-available small test fixture is
untrained seeded random weights, not a second learned model or benchmark.

Observed Node v24.22.1 CPU measurements on this workstation:

| Measurement | Observed value |
| --- | ---: |
| One load and complete validation | 90.0 ms |
| Typical input, 300 warmed calls, median / p95 / maximum | 0.57 / 1.17 / 3.27 ms |
| Maximum 512-codepoint / 80-token input, 50 calls, median / p95 / maximum | 5.53 / 8.39 / 8.79 ms |
| ArrayBuffer increase after load | 3,329,296 bytes |
| Observed heap-used increase after load | 6,496,048 bytes |

Heap measurements include validation/cache/transient allocations and are not a
guaranteed steady-state memory ceiling. Timing is synchronous CPU inference, not
an event-loop deadline or an end-to-end chat measurement. No worker or cancellation
boundary is supplied by this pure bridge.

The frozen public test previously measured 92.27% precision and 34.05% recall for
accepted spans, with 52 accepted errors. That evaluation used a sampled public
dataset, not owner conversations or application traffic. This export adds no
accuracy evidence and is not a reason to activate the candidate.

```powershell
& '.venv-execution/Scripts/python.exe' -I scripts/router/test_export_slots_ts.py
npx vitest run tests/assistant-slot-tagger.test.ts
npx tsc --noEmit -p tsconfig.json
# New exports require a fresh name; existing directories cannot be overwritten.
& '.venv-execution/Scripts/python.exe' -I scripts/router/export_slots_ts.py --run-name unique-export-name
```

The Python exporter suite has nine tests and the TypeScript suite thirteen.
The TypeScript suite always checks the small fixture and additionally checks the
learned artifact when the optional local export exists. No application path,
existing runtime weights, context state or query/tool permission logic is changed.
