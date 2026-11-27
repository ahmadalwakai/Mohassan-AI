# Own-model reply gates

The server reads `own-model-provider.json` beside the permanent worker's `model-worker.json` at startup. The worker configuration retains its existing default and `MOHASSAN_MODEL_WORKER_CONFIG` override. Each capability needs a separate gate record. A missing file, an invalid pin, a result other than pass, or a different worker configuration leaves the affected capability off.

| Capability | Mode | Gate runner ID | Adapter |
| --- | --- | --- | --- |
| `route-choice` | Shadow | `own-model.route-choice.shadow` | `classifier` |
| `follow-up-turn-type` | Shadow | `own-model.follow-up-turn-type.shadow` | `classifier` |
| `phrasing` | Active | `own-model.phrasing.active` | `generation` |

### Register and run the evaluation

Run the evaluation with the matching ID and adapter. Register the exact worker configuration JSON as the candidate artifact. The worker reports the SHA-256 of the bytes it parsed, and the server compares that digest with the gate and the report. The worker configuration pins the checkpoint and any configured sidecars. Use the same text inputs, option order and scoring as the reply integration. [Gate runner documentation in PR #16](https://github.com/ahmadalwakai/Mohassan-AI/blob/2dd30cb94f36da99e73cd6afddee25f0235e1c09/docs/GATE-RUNNER-2026-11-25.md)

For each classifier capability, fit the temperature and choose the abstention thresholds on calibration data before running the sealed evaluation. Freeze those values for the evaluation and use them in the gate record. Preregister a maximum expected calibration error with `rule.classifier.max_ece`. For route choice, evaluate with the same B0 router binary that supplies the shortlist in the server.

The phrasing evaluation uses greedy decoding with `generation.temperature` set to `0`, `generation.max_tokens` set to `64`, and `generation.eos_rule` set to `"require_eos"`.

### Pin the results

After an approved pass, create a version 1 gate record beside the report or point to the report using a relative path. Use lowercase SHA-256 digests of each file's bytes. The route record pins the raw `router-b0.json` header, which specifies the router dimensions and pins `router-b0.bin`. The calibration and router fields are specific to classifier and route gates, respectively.

```json
{
  "schemaVersion": 1,
  "capability": "route-choice",
  "mode": "shadow",
  "workerConfigSha256": "<worker configuration SHA-256>",
  "routerSha256": "<router-b0.json SHA-256>",
  "report": { "path": "run/reports/report-0001.json", "sha256": "<report SHA-256>" },
  "calibration": {
    "temperature": 1.5,
    "minConfidence": 0.8,
    "minMargin": 0.2
  }
}
```

The calibration values in this example illustrate the file format. Use measured values from the evaluated model. Temperature must be finite and positive. Both probability thresholds must be greater than zero and at most one. The model abstains if either threshold is unmet or the top scores tie.

Pin the gate record itself in `own-model-provider.json`. Each record path resolves relative to that configuration.

```json
{
  "gates": {
    "route-choice": { "path": "gates/route-choice.json", "sha256": "<gate record SHA-256>" }
  }
}
```

On Windows, `(Get-FileHash -Algorithm SHA256 path\to\file).Hash.ToLowerInvariant()` prints the required digest. Restart the server to load updated pins. Shadow decisions leave routing and conversation state under the existing rules.

### Reply behavior

Own-model route observation, follow-up observation, and reply phrasing serve only full-reach owner accounts.

The route observer scores the three highest B0 candidates from the local router artifacts. The follow-up observer scores the conversation turn types when earlier user turns are available. The server compares the choices with the host route and the existing conversation parser. Neither choice changes the reply or grants permission to use a tool.

Phrasing can replace the first sentence of a sourced search answer when the judge has approved the quote and the generated sentence passes a second support check against that quote. The initial policy preserves every word and permits only whitespace and terminal-period changes. The displayed source and qualifications stay attached. If generation or review fails, the quote remains the answer. The provider's stream is for internal consumers and the chat publishes only after review.

### Metrics

The server emits one `own_model_reply` JSON event per call with the capability, outcome and latency in milliseconds. Decision events record whether the selected option agrees with the host and whether the host choice was in the option set. Divide abstentions by the total of abstentions and selections to measure the abstention rate. Divide agreements by selections to measure shadow agreement. Count `judgeRejected: true` to measure post-generation judge rejections. Unavailable calls have a separate outcome. The events carry no prompt, reply, evidence or conversation identifiers.
