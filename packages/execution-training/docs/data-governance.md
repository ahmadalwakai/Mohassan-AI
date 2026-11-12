# Data contracts and governance

## Versioned sample contract

`TrainingExample.from_dict` is the schema authority: `execution-example-v1`. Unknown fields, missing required fields, wrong primitive types, unsupported enum values, invalid identities/digests, nonfinite values, excessive nesting, invalid Unicode and malformed contracts are rejected. Booleans do not satisfy integer fields. Exact target text is preserved; no normalization, redaction, trimming, label repair or truncation is applied to accepted data.

| Field | Required meaning |
| --- | --- |
| `sample_id` | Stable source-owned identity. Duplicate IDs are rejected before deduplication. |
| `task_family`, `operation_category` | Supported task classification and concrete operation category. |
| `task_specification` | Complete task in exact text. |
| `required_context` | Explicit JSON object, including `{}` when appropriate. |
| `input_contract` | `{format: 'json', language: 'json', schema: ...}` describing required context. |
| `output_contract` | Exact output `format` (`text`, `json`, `typescript`), `language`, and JSON schema when applicable. |
| `expected_output` | Exact nonempty UTF-8 text of the independently verified target; JSON output remains serialized text. |
| `acceptance_criteria` | Nonempty sequence of explicit criteria. |
| `verification` | Evidence reference, method, verifier identity, subject SHA-256 and exact-target UTF-8 SHA-256. |
| `source` | Source kind/identity, review status/reviewer/reference, generator or teacher identity, explicit customer-data declaration. |
| `provenance` | Origin, source SHA-256, collection timestamp with timezone, transformation history, parent IDs, project revision and evaluation-origin flag. |
| `authorization` | License ID, usage-authorization reference, authorizer, allowed uses, rights verification, privacy classification, optional privacy approval reference and expiry. |
| `environment_version`, `schema_version` | Versioned execution environment and this schema version. |
| `template_family`, `project_family`, `language` | Required leakage grouping and output-language metadata. |
| `difficulty`, `curriculum_stage` | Optional at ingestion; difficulty 1–5. Training requires an explicit compatible A–E stage. |
| `repair` | Required only for repair tasks; absent for all other task families. |

Repair records contain `failed_candidate`, nonempty `failure_evidence`, `verified_correction`, `failure_category`, `verification_method`, nonempty `regression_evidence`, `tests_preserved` and `typecheck_bypassed`. The correction must exactly equal `expected_output` and differ from the failed candidate. Evidence must include `failed_candidate_reproduced`, `corrected_candidate_verified`, `regression_preserved`, `tests_preserved` and `no_typecheck_bypass`. Pattern checks additionally reject recognizable skipped tests and TypeScript suppression, but these are not a substitute for an independent execution harness.

The supported JSON Schema subset is explicit: typed objects/arrays/strings/numbers/integers/booleans/null, properties, required keys, explicit `additionalProperties`, items, enum/const, size and numeric bounds, and descriptions. Unknown or misplaced keywords fail; unsupported unions/references/combinators require a future schema revision. TypeScript semantic correctness beyond the built-in restricted oracle belongs to the external verifier.

## Evidence and rights

An injected `EvidenceResolver.resolve(reference)` supplies an `EvidenceRecord`, not a submitted model verdict. It binds the entire sample excluding its verification reference, exact output, method/verifier, real artifact digest, checks and scope. `LocalEvidenceStore` verifies both content-addressed immutable receipt and artifact. Only the trusted verification process should write that directory. Hashes are not authentication.

Permitted uses are `training`, `validation`, `evaluation`. Authorization requires `rights_verified=True`, an explicit license or usage authorization, authorizer and reference; expiry is checked. These declarations must come from the trusted data operator. The package does not determine copyright ownership or authenticate arbitrary legal documents.

Human examples require `review_status='approved'`, a reviewer and a review reference, plus independently resolved verification. Teacher examples require recorded teacher/source, permitted usage and a different independent verifier. Teacher output is never used to verify itself. No teacher API is called, and no teacher examples were generated during implementation. Rejected review status cannot pass through any adapter.

Evidence scopes are `training`, `validation`, `test`. Training receipts may be assigned to a stricter held-out split if usage permits it; validation/test receipts cannot enter training. Test receipts and evaluation-origin feedback cannot enter validation either. Existing test results never automatically become repair data.

## Privacy, exclusions and quarantine

The default pipeline is local. It accepts explicit objects or one bounded JSONL file (64 MiB total, 2 MiB per line by default), not directories, database queries or remote URLs. No automatic `.env`, private customer record or production-dump ingestion exists. The explicit JSONL reader rejects symlinks, non-JSONL files and filenames indicating env/customer/production dumps.

Screening covers recognizable private keys, provider/API tokens, AWS keys, JWTs, bearer tokens, credential URLs, assigned secrets, credential fields, email/IP/long-digit patterns and common personal/customer fields. Configurable source/field exclusions and additional secret/review regexes are available. Suspected credentials and customer data are excluded; suspicious or uncertain noncustomer data is quarantined until a trusted `PrivacyApproval` names the exact subject digest, rule IDs, reviewer and matching approval reference. Blanket approval never overrides detected secrets. Teacher data with uncertain privacy classification remains excluded/quarantined until actually reviewed and reclassified.

**Pattern matching is not proof that all secrets or personal data have been removed.** Obfuscated credentials, domain-specific personal data and false positives remain possible. A private source does not become public merely because a regex found nothing. Operator review and control of provenance/evidence directories are mandatory trust assumptions.

The ingestion audit records only subject/submission digests, decision codes, evidence/policy digests and review status. Quarantine stores a receipt, not raw suspicious data. Retain original content only in its explicitly authorized access-controlled source, then re-submit for fresh validation. Labels are never silently redacted and reused.

## Deterministic synthetic sources

`generate_synthetic` takes an explicit seed, count, domain list, collection timestamp, `UsageAuthorization` and trusted `LocalEvidenceStore`. Recipe hashes seed independent per-example PRNGs and stable IDs. Matching inputs and generator version reproduce examples. Every emitted example passes a separate predicate oracle and general validation; the computed verification artifact is written before its receipt. Importing the module does nothing, and generation has not been executed in this phase.

| Domain | Known-answer construction |
| --- | --- |
| Identifier copying | Exact mixed-case, Unicode and underscore identifiers. |
| Value preservation | Preserve integer, boolean and string values, including leading-zero numeric strings. |
| Structured operations | Copy operations with exact identifiers, required fields and `overwrite=false`. |
| Boundary conditions | Inclusive numeric intervals with lower/upper and adjacent values. |
| Type-compatible transformations | Integer arrays to canonical decimal-string arrays, including empty arrays. |
| Small TypeScript functions | Named null/undefined-safe arithmetic function with explicit types and no imports. |
| Input validation | Distinguish nonnegative integer numbers from strings, booleans, null and negatives. |
| Missing-context recognition | Report required absent fields without inventing their values. |
| Unsupported-task recognition | Return a structured refusal for operations outside an explicit supported set. |

The TypeScript oracle accepts a deliberately narrow grammar and checks its symbolic semantics. Its receipt is `restricted-typescript-static-v1` and explicitly says `not_runtime_typechecked`. It does not claim that `tsc`, tests or JavaScript execution occurred. General TypeScript examples require actual independent harness evidence.

## Deduplication and immutable splits

Exact hashes use the exact rendered model prompt plus target, canonical JSON encoding and SHA-256. Case, identifiers, Unicode and string whitespace are preserved. Identical model inputs with conflicting targets fail preparation for manual adjudication. Removed duplicates retain sample-to-kept mappings and family links in `preparation-audit.json`; the dataset identity binds that audit and privacy-policy identity.

Near detection uses token-shingle Jaccard similarity (default 0.92) to group candidates, not discard labels. It has explicit sample/comparison bounds (250,000 comparisons by default), fails when exhausted and makes no semantic-equivalence guarantee. An audited external grouping method can be supplied through the lower-level split API.

Project and template families form connected components, including exact-duplicate aliases and near-duplicate relationships. Every component belongs wholly to train, validation or test. The same template in multiple projects therefore joins those projects. Deterministic hash assignment uses dataset version, seed and immutable group identity. Ratios are expected proportions across groups, not exact row quotas.

Use `synthetic_family_plan` and `reserve_families` **before** generating related variants. A `FamilyReservation` enforces a complete inventory; explicit mapping constraints can reserve partial external family inventories. If later duplicate evidence connects incompatible reserved splits, preparation fails rather than moving a held-out family. Nine synthetic domains alone can yield empty held-out splits; reserve sufficient independent families explicitly, and never split scalar variants of one template across sets to manufacture coverage.

Prepared files are `train.json`, `validation.json`, `test.json`, `preparation-audit.json`, and `split-manifest.json` (published last). Writes are immutable and idempotent for identical bytes. The manifest stores all sample hashes, assignments, component families, held-out group IDs and duplicate links. Loading rebuilds and validates these relationships. A changed test set requires a new dataset version and new run, never an in-place manifest edit. The training loop never encodes or optimizes test samples.

