# Monitor context verification

`MOHASSAN_MONITOR_CONTEXT=1` selects the context reasoner for smart monitors v2. `MOHASSAN_MONITOR_CONTEXT_SHADOW=1` sends the decision and numeric features to model relations in shadow. Both flags default to off. A public condition can yield a proposal, a clock trigger uses the reminder handler, and a proactive offer requires a current source observation before publication. Monitor creation and management continue through the v2 approval and confirmation paths.

The reasoner uses up to 12 earlier messages, rebuilt conversation state v2, response policy, public source evidence, time expressions, existing monitors and reminders, and earlier accepts and declines. Its scores express rule confidence. Real user decisions are required to measure empirical calibration.

Migration `046_smart_monitor_decisions` stores the proposal feature vector and subsequent human feedback separately. Features are fixed-schema counts and bounded, redacted text hash buckets. The primary owner is enrolled by default. Members may use `GET /api/chat/monitors/decision-recording` to read the setting and `POST` on the same path with `{"decisionRecording":true}` to opt in. A member's opt-out deletes their recorded data. The member deletion path also purges these records. A monitor alert can be rated with `POST /api/chat/monitors/alert-feedback` and `{"noticeId":"<alert-message-id>","helpful":true}`. The existing owner's chat feedback also labels confirmed monitor alerts. Existing proposals without a captured feature vector have no training rows. Owner exports are local copies managed by the owner. [Training and export commands](MONITOR-DECISION-TRAINING.md)

## Offline commands

Commands run from the repository root. Workspace paths and the container tag identify the verification environment. The files mounted under `/opt/pinned-python` provided the lockfile versions NumPy 2.3.5 and SciPy 1.17.0.

```sh
npm ci --cache /workspace/scratch/mohassan-npm-cache

docker run --pull never --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --user 1000:1000 --mount type=bind,source=/workspace,target=/workspace \
  --workdir /workspace/Mohassan-AI --env PLAYWRIGHT_BROWSERS_PATH=/workspace/scratch/monitor-context-chromium \
  --env npm_config_cache=/workspace/scratch/mohassan-npm-cache --env npm_config_offline=true \
  mohassan-monitor-context-bench:local nice -n 19 npm run typecheck

docker run --pull never --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --user 1000:1000 --mount type=bind,source=/workspace,target=/workspace \
  --workdir /workspace/Mohassan-AI --env PLAYWRIGHT_BROWSERS_PATH=/workspace/scratch/monitor-context-chromium \
  --env npm_config_cache=/workspace/scratch/mohassan-npm-cache --env npm_config_offline=true \
  mohassan-monitor-context-bench:local nice -n 19 npm test -- --maxWorkers=1 \
  tests/monitor-context-decision.test.ts tests/monitors-detection.test.ts tests/smart-monitor-chat-v2.test.ts \
  tests/monitors-api.test.ts tests/smart-monitor-decisions.test.ts tests/smart-monitor-reasoning-v2.test.ts \
  tests/smart-monitor-runtime.test.ts tests/smart-monitor-schedule-v2.test.ts tests/smart-monitor-sources.test.ts \
  tests/smart-monitor-sources-v2.test.ts tests/reminders-chat.test.ts tests/reminders-api.test.ts \
  tests/reminder-time.test.ts tests/reminders-scheduler.test.ts tests/assistant-scratch-decisions.test.ts

docker run --pull never --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --user 1000:1000 --mount type=bind,source=/workspace,target=/workspace \
  --workdir /workspace/Mohassan-AI --env PLAYWRIGHT_BROWSERS_PATH=/workspace/scratch/monitor-context-chromium \
  --env npm_config_cache=/workspace/scratch/mohassan-npm-cache --env npm_config_offline=true \
  mohassan-monitor-context-bench:local npm test -- --maxWorkers=1 \
  tests/member-deletion.test.ts tests/member-data-registry.test.ts tests/member-data-export.test.ts

docker run --pull never --rm --network none --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --volume /workspace:/workspace --workdir /workspace/Mohassan-AI \
  mohassan-monitor-context-bench:local npm test -- --maxWorkers=1 packages/model-relations/src \
  tests/model-relations-arbiter.test.ts tests/model-relations-shadow.test.ts

docker run --pull never --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --user 1000:1000 --mount type=bind,source=/workspace,target=/workspace \
  --workdir /workspace/Mohassan-AI --env npm_config_offline=true \
  mohassan-monitor-context-bench:local npm test -- --maxWorkers=1 packages/scratch-classifiers/src

docker run --pull never --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --user 1000:1000 --mount type=bind,source=/workspace,target=/workspace \
  --mount type=bind,source=/opt/codex/runtimes/codex-primary-runtime/dependencies/python/lib/python3.12/site-packages,target=/opt/pinned-python,readonly \
  --workdir /workspace/Mohassan-AI --env PYTHONDONTWRITEBYTECODE=1 \
  --env PYTHONPATH=/workspace/Mohassan-AI/packages/scratch-classifiers:/opt/pinned-python \
  mohassan-monitor-context-bench:local bash -ec 'python3 -B -m unittest discover -s packages/scratch-classifiers -p "test*.py" -v && python3 -B -m unittest discover -s packages/scratch-classifiers/training -p "test*.py" -v'

docker run --pull never --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --user 1000:1000 --mount type=bind,source=/workspace,target=/workspace \
  --mount type=bind,source=/opt/codex/runtimes/codex-primary-runtime/dependencies/python/lib/python3.12/site-packages,target=/opt/pinned-python,readonly \
  --workdir /workspace/Mohassan-AI --env PYTHONDONTWRITEBYTECODE=1 \
  --env PYTHONPATH=/workspace/Mohassan-AI/packages/scratch-classifiers:/opt/pinned-python \
  mohassan-monitor-context-bench:local bash -ec 'mkdir /workspace/scratch/monitor-decision-pipeline-offline && node --import tsx scripts/monitor-decision/check-recording.ts --out /workspace/scratch/monitor-decision-pipeline-offline/decisions.jsonl && python3 -B packages/scratch-classifiers/train_monitor_decision.py --decisions /workspace/scratch/monitor-decision-pipeline-offline/decisions.jsonl --output /workspace/scratch/monitor-decision-pipeline-offline/trained --pipeline-check'
```

The dependency install exited zero with 866 packages. An initial install could not use the environment's read-only npm cache. Typecheck passed for the root and the web workspace. The affected TypeScript suites passed 359 tests in 15 files, including 18 bilingual context behavior tests. The member-data suites passed 10 tests in three files. Model relations passed 61 tests and skipped the optional permanent worker test. Scratch classifiers passed 12 TypeScript, 15 top-level Python, and five linear training tests. The scratch runtime's bounded long-input test measured 0.959 ms p95 on its isolated rerun after exceeding 2 ms during the concurrent run. The initial isolated Python commands exited with missing NumPy before the pinned packages were mounted.

The pipeline check recorded and exported 48 generated feedback events across 30 monitor groups. The CPU trainer wrote 56,104 bytes of weights, the model card, the evaluation and the manifest. The chronological split sizes were 18 head fitting, three head calibration, three arbiter fitting, three arbiter calibration, and three evaluation. The arbiter replay contained nine rows. The weights SHA-256 was `d8244261a902f0220c1ea7043dff477791bf9a55df3ee669da0ffbd70307a09e`. This check measures the operation of the pipeline.

## Measurement

The context reasoner produced zero monitor signals across 10,149 guard-filtered human test utterances. The v2 detector matched two. Across 1,116 alarm, timer and calendar examples, the reasoner selected a reminder or no action. Warm frame and reasoner latency measured 0.228 ms p50 and 0.608 ms p95. The linked receipt covers each native intent family. [Human audit](MONITOR-CONTEXT-HUMAN-AUDIT.md)

Real chronological feedback, arbiter promotion and the v5 PC training job remain unverified. The fixture artifact is isolated from production loading and promotion. The v5 specification uses the existing local head-training kit and shared GPU lock. [Decision head and gate](MONITOR-CONTEXT-DECISION-MODEL.md) · [v5 interface and job specification](MONITOR-DECISION-TRAINING.md)
