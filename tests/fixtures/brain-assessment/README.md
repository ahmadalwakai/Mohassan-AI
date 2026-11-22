# Brain assessment development benchmark

`development-v1.json` contains 132 newly authored synthetic cases: twelve in each
of eleven categories, across formal Arabic, Gulf, Levantine and Egyptian wording,
English and one mixed-language continuation. No production conversations were
read to create this dataset. The labels were authored by an agent and have not
been independently human-reviewed.

Both the `development` partition (88 cases) and the `validation` partition (44
cases) are visible development data. **Neither is sealed or an unseen test.**
They must not be used for weight training. An independently collected unseen set
is needed before making promotion or generalisation claims. Dataset validation
checks canonical input duplicates and declared paraphrase-family overlap; it
cannot establish absence of overlap with unknown model-training corpora.

## Running it

From the repository root:

```powershell
node --import tsx scripts/brain-assessment.ts
node --import tsx scripts/brain-assessment.ts --model-dir artifacts/router --split validation --output artifacts/brain-assessment/validation.json
node node_modules/vitest/vitest.mjs run tests/brain-assessment.test.ts tests/assistant-routing-decision.test.ts
```

The runner reads fixture JSON, TypeScript classifiers, and optional explicitly
named local B0 weight files. It does not load `.env`, read a database, launch a
browser or inference worker, contact a network service, download weights or train
a model. Reports are written to the chosen output file. B0 is optional: omit
`--model-dir` to avoid reading its weights. Explicitly asking for absent or invalid
weights fails rather than silently replacing the model.

## What the report measures

- `rules-v0-exact` measures the exported `rulesRoute` **diagnostic helper**. It
  does not run `command-chat`. That helper returns the broad `memory_ads_pc`
  bucket, which cannot prove a specific memory, advertising or computer route.
  It is therefore incorrect under exact-label scoring. The real chat also has
  downstream handlers that this helper-only result does not exercise.
- `request-context-v1` measures only the deterministic context boundary. It
  bootstraps earlier user-role records; assistant messages cannot become trusted
  user instructions. A pending answer is labelled `reply`, with its original
  destination recorded separately as `intent`. Image/media labels are outside
  this boundary's current taxonomy and remain visible errors.
- `routing-decision-candidate-v1` measures the new read-only shared routing
  adapter. This is not evidence that production uses the adapter. Its host
  capabilities are explicitly synthetic, and its computation clock is pinned.
  It uses the shared source/projection guard to distinguish public lookup,
  earlier conversation, visible local state, supplied content and unresolved
  references. An unavailable solver or writer does not justify public search.
- `router-b0-text-only`, when requested, measures the existing local classifier
  using current text only, matching its trained interface. It does not receive
  history, pending-question state or capability information. Confidence is raw
  softmax output and must not be called calibrated confidence.

Overall accuracy includes abstentions and predictor errors in its denominator.
Coverage and selective accuracy show how much a confidence threshold excludes;
high selective accuracy at very low coverage is not broad understanding. Reports
also include per-category, language, route and capability-dependency groups,
confusion counts, confidence bins, forbidden-route selections, source-independent
dataset fingerprints and small-sample accuracy intervals.

Expected capability dependencies describe what executing a request would need.
They are not installed-service probes. Correctly recognising a reminder request
does not create a reminder, and a correct advertising route does not create a
campaign. The benchmark does not score answer quality, tool outcomes, permissions
or general intelligence. Forbidden-behavior labels are future evaluation targets;
unless a predictor supplies actual behavior observations, behavior remains
unassessed. A forbidden **route** selection is directly observable and is counted.

## Extending it

The reusable evaluator is `packages/learning/src/brain-assessment.ts`. A predictor
declares the dimensions it actually supports (`route`, `context`, `slots`,
`behavior`) and returns a bounded prediction. Missing output on a declared
dimension fails that dimension; unsupported dimensions remain unscored.

Add a stable case ID and a meaningful `family`. Keep paraphrases and related
variants in one partition, label expected context disposition separately from the
semantic destination, and use explicit `forbiddenRoutes` for private-to-public
misrouting cases. Changing data or labels requires a new dataset revision. The
reported SHA-256 identifies the parsed dataset including labels and provenance.
Inspect mistakes and review disputed labels before using a score to select code.

The source guard's regressions are separate from the 132 benchmark prompts:

```powershell
node node_modules/vitest/vitest.mjs run tests/assistant-request-scope.test.ts
```

`assessRequestScope` preserves source and requested operation separately, so
writing about the owner's business stays a transformation even when its source
is private. `reviewPublicProjection` also checks the proposed query and prevents
extra words from an earlier private task from entering a new public request.
Its source metadata contains reason codes rather than copied private values.
Quoted public titles and actual supplied document content have different roles.
These are tested boundaries, not a claim of complete semantic privacy detection
on all possible language or of observed runtime behavior in this benchmark.

Generated outbound queries also have a separate positive provenance boundary in
`apps/server/src/assistant/public-query-provenance.ts`. Its vocabulary may be
merged only from explicitly public user context and actual public-search result
titles/snippets. Private tool outputs, model prose and arbitrary browser page
bodies cannot grant vocabulary. Every generated query still needs the source,
permission and network checks; word provenance alone does not authorize a query
or establish its semantic relevance.

The main-controller tests use an isolated in-memory database and fake model,
search and browser boundaries:

```powershell
node node_modules/vitest/vitest.mjs run tests/assistant-public-query-provenance.test.ts tests/assistant-public-projection-chat.test.ts
```

They exercise private-to-public transitions, intervening public turns, generated
search URLs, searchbox submission, usable public-result refinement, and exclusion
of arbitrary page-body vocabulary. They also verify unresolved references,
greeting/filler tasks, supported conversion and unsupported computation behavior.
These tests inspect controller dispatch. They do not replace real browser/form
permission, network-policy, account authorization or production tests. The URL
search-operand recognizer covers documented engine/path/parameter shapes and
does not certify arbitrary URLs free of private data.
