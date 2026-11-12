# Repository inspection and adapter requirements

Inspection was read-only. None of the packages below was changed. Existing TypeScript concepts inform the Python data contract; they are not imported or treated as automatically valid execution-training data.

| Inspected source | Existing behavior | Phase 3 use and boundary |
| --- | --- | --- |
| `packages/learning/src/experience.ts` | Owner/source/attempt identity; terminal outcomes; expected observation vs trusted test/page/API observation; artifact and evidence hashes; optional owner confirmation; redacted goals and trail hashes | Reuse source lineage and independently observed outcome concepts. `verified_success` alone is insufficient: owner confirmation is not independent execution verification, and hashes do not reconstruct a correct target. |
| `packages/learning/src/lessons.ts` | Strict lesson candidates, success/failure/correction links, scopes, versions and trusted baseline/candidate comparisons | Reuse explicit failure/correction lineage and independent evaluator boundaries. A verified lesson is guidance, not an execution input/output pair. |
| `packages/learning/src/training.ts` | Bounded owner-scoped routing readiness; excludes evaluation sources, redacted content, incomplete evidence, duplicate and conflicting labels; exports category routing only | Preserve explicit preparation, held-out exclusion and conflicting-label rejection. It explicitly does not have verified tool-argument or final-answer targets, so its category export is not this model's supervised execution corpus. Its temporal row split is not reused: Phase 3 groups project/template families. |
| `packages/learning/src/evaluation.ts`, `memory-training.ts`, `read-training.ts` | Fixture definitions, explicit training/holdout labels, trusted observations and independent oracles | Reuse fixture/evidence separation. Do not copy existing holdouts, prompts, answers, canaries or test feedback into this corpus. Explicit training fixtures still require usage approval and a compatible full execution contract. |
| `packages/memory/src/contracts.ts` | Versioned memories, active/revoked provenance, trust (`manual`/`observed`), confidence, expiry, feedback and skill evaluation records | Export adapters must check active status, owner authorization, expiry/revocation, evidence and source lineage. Memory confidence and observed status do not establish model-training consent or a correct implementation. |
| `packages/cognitive/src/index.ts` | Planner/runtime separation, capability permissions, untrusted context, model identity checks and heuristic credential redaction | Preserve the separation of planning authority from worker execution. Reuse recognizable credential categories while documenting heuristic limits. No Phase 1 execution-model files are imported or modified. |
| `packages/runtime/src/index.ts` | Explicit operation permissions, model-run usage records, trusted completion-verifier callbacks, lease/run links and verified experience capture | An approved later export must capture the actual authorized task, available context, expected output and concrete verifier artifact. A successful tool call or model-run status alone is not evidence of task correctness. |
| `packages/contracts/src/index.ts`, `ai-providers.ts` | Strict contracts; model IDs and context settings; measured vs estimated usage; coding/verification results | Keep strict parsing and distinguish observed metrics from estimates. Phase 3 has a local versioned contract and does not extend shared contracts. |
| `packages/providers/src/index.ts` | Injected provider interface, source model identity, token usage, failures and credential filtering | Record teacher model/source and permitted use, but never invoke providers to generate data here. Teacher output must pass an independent evidence resolver. |

## Required later export adapter

A trusted, separately authorized adapter must export complete examples to an explicitly selected JSONL file or Python object stream. It must:

1. Preserve owner/source/attempt/project/revision lineage without exposing owner identities unnecessarily.
2. Obtain actual license/usage and privacy authorization. Prior permission to execute a task or store a memory is not permission to train on it.
3. Supply the original task specification, required context, exact contracts, language and independently verified correct target. Never reverse-engineer a target from a hash-only trail.
4. Resolve actual verification artifacts through the trusted evidence store; bind subject and exact target digests. Merely copying a `passed` flag or a model verdict is insufficient.
5. Carry project and template family identifiers, parent-sample lineage, environment version and evaluation-origin flags. Export an evaluation exclusion inventory before any preparation.
6. For repairs, provide the failed candidate as input, reproduced concrete failure, verified correction and regression/test-preservation evidence. No test deletion or typecheck bypass is allowed.
7. Pass the new ingestion pipeline. Rejected or uncertain data must not be silently accepted because an older subsystem classified it as verified.

There is deliberately no automatic database, experience, lesson, memory or provider adapter. Production customer records, dumps and `.env` files are excluded. Phase 3's implemented adapters accept explicit, already exported source envelopes and perform the additional gates above.

