# Mohassan execution training — Phase 3

This directory implements local data preparation and a real, explicitly invoked PyTorch training pipeline for a randomly initialized execution worker. The Cognitive Runtime remains the planner, permission controller and independent verifier. This package neither deploys the worker nor grants it authority.

**Implementation status:** source implemented and statically reviewed; no imports, generation, compilation, builds, tests, typechecks, lint, training, profiling, benchmarks, installations or deployments were executed for this phase. No checkpoint, model, dataset, verification result, throughput measurement or proficiency claim has been produced. Runtime compatibility and numerical behavior still require later integration verification.

The package is intentionally isolated: no npm/Python manifest, lockfile, environment variable or existing package was changed. It is importable as `execution_training` when this directory is on the host's Python module search path. Nothing runs when the package is imported. Use Python 3.11+ and a separately provisioned compatible PyTorch 2.5+ environment; no dependency was installed. NumPy is optional, and its presence/version is part of resume compatibility.

## Implementation map

| Area | Files under `execution_training/` |
| --- | --- |
| Package and durable metadata | `__init__.py`, `errors.py`, `common.py` |
| Strict examples, evidence and governance | `schemas.py`, `provenance.py`, `privacy.py`, `validation.py`, `ingestion.py` |
| Deterministic fixtures | `synthetic.py` |
| Deduplication, split manifests and datasets | `deduplication.py`, `splitting.py`, `dataset.py` |
| Curriculum, tokenizer and sample order | `curriculum.py`, `tokenization.py`, `sampling.py` |
| Phase 2 model injection | `model_factory.py` |
| Training settings and execution | `configuration.py`, `optimization.py`, `precision.py`, `activation.py`, `training.py` |
| Recovery, measurement and versions | `checkpoints.py`, `resources.py`, `reports.py`, `registry.py` |

Additional files are `scripts/inspect_device.py`, `scripts/profile_training.py`, this README, and the four documentation files linked below. There are no generated training artifacts or dependency manifests.

## Read in this order

1. [Existing repository concepts and required adapters](docs/repository-adapters.md)
2. [Data contracts, provenance, privacy, generators and splits](docs/data-governance.md)
3. [Training, resource budgets, recovery and limitations](docs/training-and-recovery.md)
4. [Phase 2, 4 and 5 integration contracts](docs/integration.md)

## Main entry points

- `IngestionPipeline`, `HumanReviewedAdapter`, `TeacherGeneratedAdapter`, `SyntheticAdapter`: explicit local inputs, verified evidence, sanitized acceptance/exclusion/quarantine receipts.
- `generate_synthetic`: deterministic fixtures with independently checkable restricted-domain answers. It requires actual authorization and a trusted evidence directory; it has not been called.
- `reserve_families`, `prepare_dataset`, `load_dataset`: frozen family assignments, deduplication audits and full example revalidation.
- `TokenizerAdapter`, `ModelFactory`: dependency injection only; no Phase 2 imports, architecture definitions or second tokenizer.
- `train`: causal LM or supervised execution/repair learning, accumulation, mixed precision, bounded validation and exact-state boundary checkpoints.
- `ModelVersionRegistry`: immutable local provenance and independent evaluation receipts. There is no promotion or deployment method.

Experimental presets `17m`, `34m`, `70m` and `126m` identify expected size classes, not exact architectures or verified parameter counts. They require the architecture identity supplied by Phase 2. The complete input and target must fit; initial 256/512-token contexts may need explicit expansion to 1024 or more once the real tokenizer is connected.

The full data, evidence and checkpoint directories must be controlled by the trusted local operator. Content hashes establish integrity, not identity, legal authorization, privacy or verifier independence. No path discovery, production database access, teacher API calls or paid inference is implemented.

