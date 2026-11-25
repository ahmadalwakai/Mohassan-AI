# Monitor context audit on human utterances

The audit compares the v2 detector and the context reasoner on standalone utterances from the pinned CLINC150 and MASSIVE native test splits. CLINC150 supplies English and includes its `oos_test` split. MASSIVE supplies English and human-localized Arabic. The v2 guard checks native IDs and normalized text hashes before the audit. The runner uses empty conversation history and local inputs. [Source pins and licences](../packages/scratch-classifiers/data/sources.json) · [Exclusion guard](../packages/scratch-classifiers/data_guard.py)

MASSIVE families use the publishers’ `scenario` field. CLINC150 has no scenario field in the pinned file, so its families use native intent names with the calendar and reminder update intents grouped with their corresponding intents. Every retained row contributes to its family denominator. A detector match or a reasoner decision of `offer`, `propose`, or `manage` counts as a monitor signal. The alarm, timer, and calendar families require zero reasoner monitor signals.

These corpora label assistant intents. They can contain wording that would plausibly request a monitor in a real conversation. The count therefore measures potential false positives on this negative and near-miss sample. The receipt records native source IDs and decisions for every monitor signal. Latency measures the frame and reasoner together, with a 256-turn warmup, and excludes corpus I/O and shadow inference.

## Commands

The setup fetched only these two pinned archives and verified both digests.

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=packages/scratch-classifiers python3 - <<'PY'
import json
from pathlib import Path
from prepare_data import DATA_DIR, pin_source

cache = Path('/tmp/mohassan-monitor-corpora')
cache.mkdir(exist_ok=True)
pins = json.loads((DATA_DIR / 'sources.json').read_text())
for name in ('clinc150.json', 'massive.tar.gz'):
    path = pin_source(cache, name, pins[name])
    print(f'{name} {pins[name]["sha256"]} {path.stat().st_size} bytes verified', flush=True)
PY
```

CLINC150 verified as 2,495,390 bytes and MASSIVE as 39,500,415 bytes. The audit reads cached archives, verifies the pins again, and writes only aggregate counts, source IDs, and digests.

```sh
docker run --pull never --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --user 1000:1000 --mount type=bind,source=/workspace,target=/workspace \
  --mount type=bind,source=/tmp/mohassan-monitor-corpora,target=/corpora,readonly \
  --workdir /workspace/Mohassan-AI --env PYTHONDONTWRITEBYTECODE=1 \
  mohassan-monitor-context-bench:local python3 scripts/monitor-decision/audit_human.py \
  --cache /corpora --output /workspace/scratch/monitor-context-human-final.json
cp /workspace/scratch/monitor-context-human-final.json docs/MONITOR-CONTEXT-HUMAN-AUDIT.json
```

## Results

The offline command exited zero on Node 24.22.3 and Python 3.12.14. The guard excluded 258 CLINC150, 520 MASSIVE Arabic, and 521 MASSIVE English test utterances.

| Corpus and language | Retained cases | V2 detector monitor signals | Context reasoner monitor signals | Context reasoner reminders |
| --- | ---: | ---: | ---: | ---: |
| CLINC150 English | 5,242 | 0 | 0 | 36 |
| MASSIVE Arabic | 2,454 | 1 | 0 | 16 |
| MASSIVE English | 2,453 | 1 | 0 | 60 |
| Total | 10,149 | 2 | 0 | 112 |

| Clock-related family | CLINC150 English | MASSIVE Arabic | MASSIVE English |
| --- | --- | --- | --- |
| Alarm | 17 reminder, 13 none | 3 reminder, 93 none | 23 reminder, 73 none |
| Timer | 10 reminder, 20 none | No native family | No native family |
| Calendar | 1 reminder, 59 none | 13 reminder, 389 none | 37 reminder, 365 none |

The reasoner produced zero monitor signals across 1,116 alarm, timer, or calendar utterances. V2 triggered on one Arabic cinema recommendation containing the word «كل» in the sense of all and one English `calendar_set` example requesting an alert when unspecified registration opens. The reasoner returned `none` for both. [Per-family counts, native source IDs and digests](MONITOR-CONTEXT-HUMAN-AUDIT.json)

Frame and reasoner latency was 0.227666 ms p50 and 0.608429 ms p95 per turn over 10,149 single-turn inputs in this run.
