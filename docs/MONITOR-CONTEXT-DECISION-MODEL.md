# Monitor context decision model

The local CPU head classifies a turn as `none`, `offer`, `propose`, `manage`, or `reminder`. It uses named numeric frame features and hashed text buckets from the current request and previous assistant turn. Weights use the scratch classifiers' class-major, signed 16-bit little-endian layout with a shared scale and softmax temperature. The training job writes the model card and names the sources for each artifact.

Set `MOHASSAN_MONITOR_CONTEXT_SHADOW=1` to observe the head through the model relations manager. Install human-trained `weights.json` and its checksum-pinning `manifest.json` in `.data/monitor-decision/`. The default adapter rejects pipeline-check weights. Shadow observations record classifier labels, scores, elapsed time and outcome in the existing model relations log. The head receives frame numbers and hashed bucket indices. The observation omits both.

## Promotion

The `monitor-context` decision type compares the context reasoner with the local head. A future promotion can suppress a discretionary offer if the head recommends `none`. Management, explicit requests and reminders keep the normal rules and approval flow. The released manager has no promoted monitor decision.

Use the owner-generated chronological replay from the CPU training script. Its three arbiter pools follow head training and head calibration. The arbiter fits on the first pool and selects an operating threshold on the second. It tests the frozen threshold on the last pool. The held-out gate requires approval and decline examples in Arabic and English, zero paired losses, and a one-sided exact paired sign test at 0.05. The second gate uses full paired v1 and v2 development receipts with overall, area, language and area/language counts. The latter receipts stay out of the model and arbiter fitting loops.

```bash
node --import tsx packages/model-relations/src/arbiter-train-cli.ts monitor-gate \
  --replay .data/monitor-decision/arbiter-replay.json \
  --weights .data/monitor-decision/weights.json \
  --before development-reasoner.json --after development-candidate.json \
  --report monitor-gate.json --artifact .data/monitor-decision/promotion.json
```

The promotion artifact binds the decision scorer to the exact head weights and both gate input receipts by SHA-256. After review of both gates, the owner can approve a code change to the manager's promoted decision list. Active use also requires `MOHASSAN_ARBITER_MONITOR_CONTEXT=1` and the shadow flag. `MOHASSAN_ARBITER_MONITOR_CONTEXT_KILL=1` cancels arbiter authority.
