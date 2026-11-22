# Inactive five-tag TypeScript date/place bridge

This bridge exports and evaluates the already selected `target48-cap3` weights
from `first-three-cpu-20261121-b`. It does not train, choose a new candidate,
refit calibration, read final-test predictions, or activate a model. Its output
contains literal date/place hypotheses, not resolved dates, facts, permissions,
or evidence that a user task succeeded.

## Separate contract and immutable bundle

The new format is `mohassan-slot-date-place-tagger-ts-v1`, with exactly
`O, B-place, I-place, B-date, I-date`. It deliberately cannot load the older
thirteen-tag format. That bridge's public API, model IDs and serialization are
unchanged. Both use the same bounded GRU, classifier, legal BIO and posterior
arithmetic in `slot-tagger-math.ts`; label contracts remain separate.

The derivative bundle is:

```text
artifacts/brain-slot-date-place-typescript-v1/typescript-export-v1-20261121-a
modelId: 4443f07d0322db1326de784b5aae4b04023cd4b3125877a8de854bf7d96e9314
weights SHA-256: 3b1e0c3a6ec1e4a9f5057aad3358271e592850084e9e23e05fe1828717267e64
manifest SHA-256: 6dfce87cff685e36a1a58b164b444d3527a4ac63593d8c9f727c11aeb331637b
```

Weights are the original 3,239,828 bytes. Temperature remains `1.0`; acceptance
thresholds remain date `0.8228255028191475` and place `0.9688093835656453`.
`manifest.json` binds the exact source selection, plan, model, weights,
calibration, selection report, development parity and assignment hashes.
`provenance.json` records exporter/bridge/math hashes, interpreter versions and
parity errors. `checksums.json` covers every other bundle file. The exporter
uses exclusive writes and refuses a reused directory; do not update this bundle
in place.

The immutable [peer-review audit](../../artifacts/brain-slot-date-place-typescript-v1/peer-review-audit-20261121-a.json)
adds the SHA-256 of the dynamically imported `scripts/router/export_slots_ts.py`
dependency (`18e67e02fe4503cfd244ce60e32fe29f026e811365c5e5e0c1aa072a2b1f35da`),
which the original derivative provenance omitted. It records independent source
and bundle checks without changing that bundle. Fresh PyTorch matched the
exported PyTorch reference logits exactly; TypeScript's separate maximum logit
error remains `0.000003275585`.

## Inactive read-only API

```ts
import { loadDatePlaceSlotTagger } from './slot-date-place-tagger.js';

const tagger = loadDatePlaceSlotTagger(manifestBytes, weightBytes, {
  expectedModelId: trustedModelId,
  cacheEmbeddings: false,
});
const proposals = tagger.infer(currentText);
const diagnostics = tagger.inspect(publicParityText);
```

`expectedModelId` is mandatory and must come from trusted host configuration,
independently of the supplied bundle. A self-consistent model ID alone does not
approve arbitrary weights. The loader rejects a different format, tag order,
tensor shape/order/offset, weight length/hash, nonfinite or out-of-range weights,
changed Unicode contract, calibration or unpinned metadata. Metadata is bounded
to 256 KiB and weights to 4 MiB. Requests have at most 512 Unicode codepoints and
80 tokens; unsupported Unicode and unpaired surrogates fail rather than silently
changing source text.

`infer()` returns frozen `scope: 'inactive_date_place_hypotheses'`, `active: false`,
model ID, token count, accepted hypotheses and raw diagnostics. `inspect()` also
returns tokens, feature IDs, flags, logits and legal BIO tags. Half-open codepoint
and UTF-16 spans select the exact original literal. Token embedding caching is
disabled by default; explicit caching is available only to a trusted caller.
The module has no imports into main chat, routing or the existing shadow worker.

## Parity evidence and limits

The exporter loads the frozen weights into an actual CPU PyTorch
`EmbeddingBag`/bidirectional GRU/linear model with strict state-dict geometry.
It evaluates the twelve existing cached public development inputs plus the
older exporter's thirteen predeclared Unicode boundary strings. It does not
open the final-test cache or use these inputs to alter the model. A separate
NumPy forward implementation is an additional check; PyTorch is the reference.

The exported 25 inputs contain 167 tokens. On this bundle:

| Check | Maximum absolute error |
| --- | ---: |
| Fresh PyTorch versus cached development PyTorch logits | 0.000001430512 |
| Independent NumPy versus fresh PyTorch logits | 0.000003337861 |
| TypeScript versus fresh PyTorch logits | 0.000003275585 |
| TypeScript versus fresh PyTorch span confidence | 0.000000442020 |

Tokens, feature IDs, flags, decoded tags, raw/accepted literal spans, rejection
reasons and thresholds match exactly; logit tolerance is `5e-5`. Tests include
Unicode codepoint/UTF-16 boundaries, exhaustive small legal BIO path oracles,
a closed-form GRU recurrence, malformed inputs, coherent-hash tampering,
nonfinite weights, size limits and both cross-format rejection directions.
The learned-artifact test group is skipped when the separately pinned bundle is
absent; it ran all 25 cases in this workspace.

The existing thirteen-tag bridge and shadow tests also pass. A read-only
comparison against the pre-extraction source snapshot
`2026-11-21T08-51-10-176Z-34408-ff071cc7` compared both `inspect()` and `infer()`
with caching on/off, on its fixture and original learned candidate: 104
serialized outputs were bit-identical (aggregate SHA-256
`8806476edfb9a328eeddfb436868d5a536c52aa397414ed64614d698d62baf3d`).

Parity establishes compatible inference, not model quality or general
intelligence. The already published date/place experiment reported accepted
precision 93.76%, recall 57.92%, place recall 26.52%, and 47 incorrect accepted
spans. Those limitations remain. No new final-test evaluation or promotion was
performed here; see [the frozen experiment](SLOT-DATE-PLACE-EXPERIMENT.md).

## Reproduction and snapshot inputs

```powershell
node node_modules/vitest/vitest.mjs run tests/assistant-slot-date-place-tagger.test.ts tests/assistant-slot-tagger.test.ts tests/assistant-slot-shadow.test.ts
& '.venv-execution/Scripts/python.exe' -I scripts/router/test_export_slots_ts.py
& '.venv-execution/Scripts/python.exe' -I scripts/router/test_export_slots_date_place_ts.py
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

These checks passed: 78 TypeScript tests, 18 Python exporter tests, core
typecheck. Exporting another immutable copy requires a new unique name:

```powershell
& '.venv-execution/Scripts/python.exe' -I scripts/router/export_slots_date_place_ts.py --run-name unique-export-name
```

The exporter reads only the separately pinned source directory under
`artifacts/brain-slot-date-place-development-v2`. Future isolated full-test
snapshots must explicitly include the derivative bundle:

```text
--share-artifact artifacts/brain-slot-date-place-typescript-v1/typescript-export-v1-20261121-a
```

This exact path is outside the older artifact trees used by concurrent runs;
their bytes were not changed. Python reproduction additionally needs the pinned
source selection and the existing Python environment. Sharing that environment
does not claim isolation from its editable dependency paths.
