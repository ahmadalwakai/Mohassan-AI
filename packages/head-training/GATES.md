# Data partitions and evaluator handoff

The kit assigns related examples by source group and removes exact normalized
matches from competing splits. Matching uses the prompt, history, and candidates
regardless of candidate order. Upstream test groups and matching public inputs
are withheld. Within the fitting material, calibration takes priority over
development, and development takes priority over training. The remaining
upstream development groups are divided between development and calibration.
A source without an upstream development split uses a seeded group
partition with a target of 80% training, 10% development and 10% calibration.
Small strata and large groups can change those proportions. The training report
records the resulting row counts and fingerprints. A public benchmark's original
partition is documented in its data card when the benchmark is used as development
material for this project.

## Owner's sealed receipt

Keep the canonical case file and gate view ledger in the evaluator's private
workspace. The owner writes or reviews cases before the evaluation. Supply only a
receipt to training. The case path can be absolute or relative to the receipt.

```json
{
  "schema_version": 1,
  "path": "private-evaluation/cases.jsonl",
  "sha256": "<64 lowercase hex digits>",
  "reviewer": "<owner name>",
  "review_kind": "owner_authored",
  "reviewed_at": "<ISO 8601 timestamp with time zone>"
}
```

Use `owner_reviewed` for an independent source reviewed by the owner. If the
owner takes cases from public supervision, add an `excluded_group_sha256` array
with the SHA-256 of each corresponding public `Example.group` as UTF-8 text.
The whole group and its exact-input matches are reserved before partitioning.
Use freshly authored cases for the router promotion gate in §4.2. The kit reads
only the receipt and passes its SHA-256 pin through to the evaluator.

## Independent gate

Use the `registration.json` in the gate packet with the `scripts.gates` CLI from
PR #16. Keep `handoff.json` with the training artifacts for provenance. The
candidate registration pins the head manifest, which binds the worker
configuration, tokenizer, sidecar, input codec and calibration. Before producing
predictions, the evaluator verifies the manifest and the nested worker config
pin. The baseline registration pins the executable or artifact for the existing
rules.

1. An evaluator seals the registration and starts one run, using the same
   canonical case path and its `.gate-views` ledger. These are the commands from
   the gate runner checkout. [PR #16](https://github.com/ahmadalwakai/Mohassan-AI/pull/16)

   ```sh
   python -m scripts.gates seal registration.json
   python -m scripts.gates start registration.json run --who evaluator --why 'Registered head evaluation'
   ```

2. The evaluator runs the pinned worker and the pinned rules on the authorized
   cases. Include `id`, `language`, `category` and an expected string `label` in
   each case. For a mutually exclusive sentence choice, use the zero-based
   candidate index as a string in both arms. Define any mapping to labels and
   valid abstentions beforehand. Provide `id`, `label`, and numeric `confidence`
   for each candidate prediction and `id` and `label` for each baseline
   prediction. Record actual argv and `"settings": null` in each provenance file.

3. The evaluator records the results and asks the runner to decide. The runner
   produces Wilson intervals, exact McNemar against the rules, and classifier
   calibration results. The router packet requires at least 150 cases, zero
   never-web misroutes and zero wrong predictions at confidence 0.8 or higher.
   The evaluator attaches the separate H3 precision check over accepted
   predictions, with a 95% Wilson lower bound of at least 90%, plus place recall.
   For H4 and H5, pre-register evidence for wrong answers shown and correct-answer
   retention with the owner. These release criteria require additional evidence
   because PR #16's classifier Wilson intervals use all cases in a fixed group.

   ```sh
   python -m scripts.gates record run --role candidate --provenance candidate-provenance.json
   python -m scripts.gates record run --role baseline --provenance baseline-provenance.json
   python -m scripts.gates pack run
   python -m scripts.gates decide run
   ```

## Reviewed corpus provenance

For a reviewed source corpus, use the optional PR #15 lineage settings. The kit
calls `python -m corpus_pipeline verify --manifest ... --review ...` in the
separate corpus-pipeline checkout and records the manifest, review, and train
shard pins. Corpus shards contain source text. They need a separate supervised
labeling step before use as head examples. [PR #15](https://github.com/ahmadalwakai/Mohassan-AI/pull/15)
