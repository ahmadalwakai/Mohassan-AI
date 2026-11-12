# Integration boundaries

## Phase 2: injected tokenizer and random model factory

No Phase 2 module is imported, and no unfinished import path is guessed. The later integration host supplies a wrapper implementing `Phase2Tokenizer`:

```python
class Phase2Tokenizer(Protocol):
    identity: str
    vocabulary_version: str
    vocabulary_size: int
    special_tokens: Mapping[str, int]  # required pad/eos; optional bos
    def encode(self, text: str) -> Sequence[int]: ...
    def decode(self, token_ids: Sequence[int]) -> str: ...
```

Encode/decode must preserve exact text, avoid implicit special tokens and normalization, and expose stable vocabulary identity. `TokenizerAdapter` validates IDs, identity changes and roundtrips. It appends the declared EOS, optionally prepends BOS, and checks complete sequence length against training/model context. If Phase 2 has a different concrete interface, adapt it in the integration phase without implementing another tokenizer. Hash the actual tokenizer vocabulary/configuration into its supplied identity; a mutable vocabulary hidden behind an unchanged identity violates the host contract.

The factory receives `ModelRequest(architecture_id, preset, seed, vocabulary_size, context_length, initialization='random', allow_pretrained=False)` and returns `ModelBundle` with:

- A materialized trainable `torch.nn.Module`.
- Matching architecture identity and SHA-256 of its complete resolved architecture configuration.
- Vocabulary size, supported context length, random initialization attestation and seed.
- Versioned factory implementation identity.
- Optional `activation_checkpointing_hook(model, enabled) -> bool` confirming the actual state.

The module implements `forward(input_ids=..., attention_mask=...)` and returns `[batch, sequence, vocabulary]` logits directly, as `.logits`, or under `{'logits': ...}`. It must enforce causal attention and respect padding masks. The trainer owns label shifting and loss; the model must not shift targets again. No architecture parameters are defined in Phase 3. The factory must never download or load pretrained weights. Resuming loads only an explicitly trusted compatible Phase 3 checkpoint after a fresh random factory construction; the saved lineage is random initialization.

Phase 2 owns parameter initialization, preset resolution, embeddings/output vocabulary consistency, forward behavior and activation-checkpoint placement. The hook should preserve RNG across recomputation. Initialization and causality need independent later checks; the bundle's declaration alone is not proof against a malicious factory.

## Explicit local workflow

This is an integration outline, not an executed experiment. The host provides real authorization, approved examples and trusted evidence. No fictitious verification references are supplied here.

```python
from execution_training.dataset import prepare_dataset
from execution_training.configuration import preset_config
from execution_training.curriculum import CurriculumPlan
from execution_training.tokenization import TokenizerAdapter
from execution_training.training import train

# Inputs below come from the trusted integration host, not dataset-controlled code.
dataset = prepare_dataset(
    approved_examples,
    dataset_version=dataset_version,
    evidence_resolver=trusted_evidence,
    privacy_policy=approved_privacy_policy,
    seed=dataset_seed,
    reserved_families=frozen_family_reservation,
)
dataset.write(operator_selected_dataset_directory)
config = preset_config(
    "17m", architecture_id=phase2_architecture_id,
    context_length=operator_selected_context_length,
)
curriculum = CurriculumPlan.for_budget(config.max_processed_tokens, stages=("A", "B"))
# Calling this next operation really starts training. It was NOT called in Phase 3.
report = train(
    config=config, dataset=dataset, evidence_resolver=trusted_evidence,
    privacy_policy=approved_privacy_policy, curriculum=curriculum,
    tokenizer=TokenizerAdapter(phase2_tokenizer), model_factory=phase2_random_factory,
    output_directory=operator_selected_fresh_run_directory,
)
```

The frozen reservation must use the same dataset version, seed and ratios. Use explicit supervised training for any C/repair data. All enabled stages need actual training examples. If tokenization overflows, select a supported larger context or curate/reverify the dataset; there is no automatic content removal.

To resume, keep the same output directory and configuration except for `resume_checkpoint`, provide `trusted_resume=True`, and preferably pin the previously recorded checkpoint SHA-256. The previous run manifest, source hash, dataset audit, privacy policy, sampler, precision and runtime must match. A changed dataset/configuration is a new experiment, not a silently compatible resume.

## Phase 4: independent evaluation

Training validation loss does not establish execution proficiency. Phase 4 must independently evaluate the exact checkpoint hash against frozen held-out families/suites, including execution correctness, TypeScript checks where applicable, regressions, repair safety, abstention/missing-context behavior and the relevant supported scope. Evaluation infrastructure must resolve actual artifacts, not accept training-produced `passed` flags.

`ModelVersionRegistry.register(ModelVersionManifest(...))` records a real checkpoint, architecture, tokenizer, dataset version/identity, training configuration/provenance, rollback reference, `not_evaluated` status and `unpromoted` status. Training provenance requires `initialization='random'`, run ID, source revision and report reference. Registration hashes the artifact and checks its committed receipt against supplied identities. Use `dataset.identity` (the complete dataset including preparation audit), not only the lower-level split-manifest hash.

`record_evaluation(version, evidence_reference, resolver)` consumes an injected Phase 4 resolver returning `EvaluationAttestation`. It must bind evaluator identity, model version, checkpoint SHA-256, complete dataset identity, suite identity, timezone-aware completion time, independent verdict and the `test` split. The registry writes an immutable evaluation receipt. It can report `eligible_for_promotion_review=True` only for a matching independently passed evaluation. One final decision is recorded per model version; revised evaluation requires an explicitly managed new version.

The registry cannot authenticate an arbitrary evaluator process. Its directory and resolver are trusted host components. Phase 4 must verify held-out coverage and evidence authenticity. Failed test outputs are not automatically exported to Stage C, and test data cannot be returned to training under a different sample ID/family without violating the governance contract.

## Phase 5: runtime integration and promotion

There is no deployment, promotion, runtime-provider registration or live configuration update in Phase 3. Phase 5 must make an explicit decision after independent evaluation, verify the exact version/checkpoint/tokenizer/configuration identities, preserve rollback metadata, and maintain the Cognitive Runtime's permissions and independent verification. Eligibility for review is not promotion.

The local manifest always stays unpromoted; Phase 5 owns a separate runtime promotion/deployment record. Model versions may reference an existing earlier local version for rollback. This package never swaps active models or writes to runtime, applications, shared contracts, schemas, credentials or environment variables.

## Verification deferred by instruction

Later authorized verification should cover adversarial data/authorization/privacy cases; exact/near/group leakage and immutable manifests; real tokenizer roundtrip/overflow; causal attention and prompt/padding loss masks; token-weighted accumulated gradients; FP32/AMP behavior; interrupted and corrupt saves; trusted reload and continuation; OOM/disk handling; registry/evaluation identity binding; and resource measurements on the actual device. These are required integration checks, not results obtained in this phase.

