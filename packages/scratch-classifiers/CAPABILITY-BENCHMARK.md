# Capability benchmark

The 25 November 2026 runs used feature commit `9fac92ca3013402d97fc55ef891a8d3ecdaff0f9` and an uncommitted merge of `origin/feat/agent-capability-bench` at `a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f` in a detached scratch checkout. Both runs used Node 24.22.3 on Linux x64. Training, model selection and calibration were frozen before the evaluation-only benchmark runs.

| Measure | Development off | Development on | Sealed off | Sealed on |
| --- | ---: | ---: | ---: | ---: |
| Routing | 115/178 | 118/178 | 30/42 | 28/42 |
| Refusal | 1/16 | 4/16 | 0/4 | 1/4 |
| Small talk | 3/18 | 5/18 | 0/4 | 0/4 |
| Follow-up | 0/18 | 0/18 | 0/4 | 0/4 |
| Overall | 40/240 | 45/240 | 10/60 | 11/60 |

Routing counts cases with at least one route or handler assertion. All such assertions within the case must pass. Refusal, small talk, and follow-up use the benchmark's full-case scores. These scores include checks beyond the classifier label.

Each run emitted 344 shadow records. Off-mode decisions matched the rules for all four heads. In on-mode, effective labels differed from rule labels in 22 refusal, 4 speech act, 27 route, and 1 follow-up records. A single record can count towards several heads. The heads produced 78 refusal, 340 speech act, 179 route, and 156 follow-up labels above their thresholds in each run.

Sealed refusal improved by one case and sealed routing lost two. The follow-up head changed one decision across the two splits combined and neither split gained a passing full follow-up case. The training data for follow-up is English, and its dataset test recall for new requests was 18.7%. The server defaults to shadow. [Per-dataset metrics](models/metrics.json)

## Commands and reports

These commands ran in `/workspace/scratch/capability-bench` after merging the benchmark with `git merge --no-commit --no-ff origin/feat/agent-capability-bench` in the detached checkout.

```sh
env -u MOHASSAN_SCRATCH_CLASSIFIERS TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/scratch/mohassan-playwright npm run assistant:capability-bench -- --sealed tests/fixtures/agent-capability-bench/holdout/sealed.json --output /workspace/scratch/capability-runs/flag-off.json > /workspace/scratch/capability-runs/flag-off.log 2>&1
MOHASSAN_SCRATCH_CLASSIFIERS=1 TZ=Europe/London PLAYWRIGHT_BROWSERS_PATH=/workspace/scratch/mohassan-playwright npm run assistant:capability-bench -- --sealed tests/fixtures/agent-capability-bench/holdout/sealed.json --output /workspace/scratch/capability-runs/flag-on.json > /workspace/scratch/capability-runs/flag-on.log 2>&1
```

Both commands exited 0. Wall times were 78.555 s with the flag off and 72.165 s with the flag on. The raw reports and sealed examples stay in the scratch checkout and report directory.

| Report | SHA-256 |
| --- | --- |
| `flag-off.json` | `9bfcdfed4e417dddf9663e19f1074c96254dcd3172a8c2900587c786fd2d7afc` |
| `flag-on.json` | `1de01cb0aa5d55001f525a4343f270e9751e858305106f1a6e1eb41e05d85e96` |
