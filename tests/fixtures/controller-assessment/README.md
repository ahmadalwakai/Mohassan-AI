# Controller functional development assessment

This is a visible, agent-authored development benchmark, revision1, containing32 controlled tasks. It is not sealed, human-reviewed, training data, an IQ test, or evidence of a claimed multiplier in general intelligence. Do not train on these fixtures.

The runner calls the actual `createCommandChatControl`, creates a fresh in-memory PGlite database for every task, sets `recordExperiences:false`, and observes every turn's final answer, persisted run status, waiting state, tool calls and latency. It never loads `.env`, owner documents, owner memory, weight files, a training corpus, or an external inference provider. All supplied facts are fictional and declared in the JSON file. The two `scripted` cases use fixed, in-process provider decisions to exercise the real model-tool boundary; they do not use a model to judge results.

Run from the repository root:

```powershell
node --import tsx scripts/controller-assessment.ts
node --import tsx scripts/controller-assessment.ts --case compute-arabic-marked-fraction
node --import tsx scripts/controller-assessment.ts --real-browser
```

`--dataset <path>` selects a compatible visible fixture file. `--output <path>` selects the report destination. Reports are immutable: existing files are never overwritten. Default paths contain both a timestamp and a random identifier under `artifacts/controller-assessment/`. The CLI exits2 for task assertion failures,3 when declared source files changed during the run, and1 for an invalid invocation/report failure. A failed task remains in the report.

The source manifest hashes a declared, narrow list of controller/runtime modules, this harness, its scorer, the dependency lock, dataset and JPEG fixture before and after execution. It excludes environment files, private data, model weights and training artifacts. It is not a complete transitive build or dependency-binary hash. Static module loading may precede the first hash, so matching sampled manifests do not prove atomic loading of every source file. A manifest change makes the report's reproducibility status **invalid**, even if its behavior assertions passed. For a reproducible development run, use a consistent source snapshot and retain the immutable JSON artifact.

Cases cover multiple-turn private/public context, correction and acknowledgement, clarification and structured-card resume, Unicode arithmetic, marked Arabic fractions versus cardinals, calendar arithmetic, private memory and evaluated-document facts, missing/conflicting evidence, compound requests with no implicit effects, unavailable capabilities, two model-generated private-query attacks, and capture receipts. Assertions come from the declared facts and authored expected behavior, not from the controller's own opinion. Exact scalar assertions are preferred so `2` cannot pass an answer of `32`. Where prose is required, the report measures only the explicit required/forbidden substrings, not arbitrary semantic correctness.

Each turn must satisfy its expected status, conversation waiting state, answer/format assertions and call bounds. A passing case may intentionally end `partial` or `blocked`; case pass rate is not the proportion of user objectives fully completed. Final statuses remain visible in every case. A response persisted as `completed` despite a failed answer, format, status, privacy or effect invariant counts as **false completion under these authored assertions**. Counts are reported per category and separately for no-model and scripted-model tasks. Missing turns and harness errors reduce observed-turn coverage. Public-query leakage checks cover the declared synthetic canaries, including changes to their punctuation/case, and declared query bounds; they are not universal data-loss prevention.

The default capture cases use a clearly labeled synthetic browser boundary, a real2×2 JPEG fixture, and a synthetic sampled-stability receipt. This checks the controller's binding/HTTP-status behavior; it does not measure real webpage pixels, camera/browser correctness, or receipt forgery resistance. `--real-browser` replaces those two capture fixtures with a fresh isolated Chromium profile and an HTTP server bound to loopback. Browser navigation is restricted to that exact fixture origin. The profile is removed only after verifying its resolved path stays under the designated temporary directory. Real capture coverage is reported separately, and unsupported browser setup becomes a visible harness failure rather than a synthetic success.

Latency uses wall time from the user create/send call through the controller's settled state. Database/browser fixture setup is recorded separately. These controlled timings omit real provider/network latency and are not normalized for hardware, parallel development or load. No before/after improvement claim is made by this single-source run.

The2×2 JPEG was generated locally from a constant RGB color. It contains no user or webpage pixels. Production data and messages are never sent by this assessment; unexpected mutation attempts are counted and rejected by the fake boundaries.
