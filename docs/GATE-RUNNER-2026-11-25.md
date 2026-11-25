# موحسن | Gate runner

نسجّل سؤال التقييم وشروط النجاح وبصمات البيانات والنسخة المرشحة قبل إنتاج النتائج. يرى
المراجع الحالات والأدلة ومعيار كل حالة دون معرفة مصدر الإجابة. يطبق المشغّل الشروط
المسجّلة ويصدر تقريرًا لا يُستبدل، مع سجل منفصل لأي قرار يتخذه المالك.

The runner covers the generation probes in the chat training plan, head evaluations in
§§4.2–4.4 of the development plan, and task success in batch 5 of the agent upgrade
plan. It evaluates offline evidence with the Python 3.11+ standard library. Plans can also
require separate evidence, such as training loss or owner approval for activation.
[Chat training plan](CHAT-MODEL-TRAINING-PLAN.md) ·
[Development plan](MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md) ·
[Agent upgrade plan](AGENT-UPGRADE-PLAN-2026-11-24.md)

## Register and seal

Write the registration before generating any result. Use SHA-256 of the exact file bytes
for each pin. Paths can be absolute or relative to the registration file. Keep the
registration, emitted seal, frozen cases, artifact files, and run receipts together in
the evaluation archive. Run receipts reference absolute paths, so keep their original
locations available while the gate is active. For a rules baseline, pin its executable
or rules artifact.

This generation registration illustrates the development-v4 Gate 5 count criteria.
Substitute the actual paths, SHA-256 values, identity terms, and generation settings
before sealing.

```json
{
  "schema_version": 1,
  "gate_id": "development-v4-gate-5",
  "question": "Does the selected checkpoint meet the registered generation probe criteria?",
  "adapter": "generation",
  "cases": {
    "path": "cases.jsonl",
    "sha256": "<64 lowercase hex digits>",
    "sealed": false,
    "allow_reuse": false
  },
  "candidate": {"path": "checkpoint.pt", "sha256": "<64 lowercase hex digits>"},
  "generation": {"seed": 21, "temperature": 0, "max_tokens": 192, "eos_rule": "require_eos"},
  "judging": {
    "judges": 2,
    "aggregation": "unanimous",
    "shuffle_seed": 25,
    "identity_terms": ["model alias", "checkpoint alias", "system alias"]
  },
  "rule": {
    "test": {"name": "none"},
    "minimum_counts": {"overall": 200, "languages": {"ar": 100, "en": 100}},
    "minimum_passes": {"overall": 120, "languages": {"ar": 55, "en": 55}},
    "no_zero_pass_categories": true
  }
}
```

Use `"generation": null` for agent and classifier gates. Generation and agent
registrations select one or more judges with `unanimous` or `majority`. A majority
means strictly more than half. A classifier registration sets `"judges": 0` and
`"aggregation": "automatic"`. If the gate compares with a baseline, add a
`baseline` object with the same fields as `candidate` and collect both results in the
same run.

Frozen case sets are UTF-8 JSON Lines. Every case has a unique string `id` and
nonempty string `language` and `category` fields. Each generation and agent case
also has a nonempty string `criterion`, written before results are produced. Add any
distinct model name, checkpoint name, or system identifier likely to appear in the
visible evidence to `judging.identity_terms`.

## Run the gate

From the repository root, seal the registration and start a run at a new path.

```sh
python3 -m scripts.gates seal registration.json
python3 -m scripts.gates start registration.json run --who evaluator --why 'Registered release evaluation'
```

The seal is written beside the registration as `registration.json.seal.json`.
The runner verifies applicable SHA-256 pins before each step. A change to a pinned
input voids the gate. A detected mismatch writes an invalidation marker and the
runner still refuses the gate if the original bytes are put back. Starting a run
uses the case set and writes who, when, and why to a log under
`.gate-views/<case SHA-256>/` beside the case file.
Keep the log with the frozen set on the shared evaluation filesystem. Hashing the
bytes validates the pin. A started run counts as a use even if it is abandoned.
Set `"sealed": true` and `"allow_reuse": false` for a once-only set. A second
sealed run requires reuse permission in the current registration and in all
earlier view records. The sealed status cannot change after the first use.

After `start`, run the existing local producer on the pinned cases and artifact.
Write its JSONL to `run/predictions.jsonl`, and if registered, write the baseline
JSONL to `run/baseline.jsonl`. Prepare a provenance JSON for each role with
`command` set to the actual producer argv as a JSON string array and `settings` set
to the observed generation settings, or `null` for agent and classifier gates.
Archive receipts and commands without credentials in their arguments.

```sh
python3 -m scripts.gates record run --role candidate --provenance candidate-provenance.json
python3 -m scripts.gates record run --role baseline --provenance baseline-provenance.json
python3 -m scripts.gates pack run
```

Run the baseline command only for a registered baseline. For generation from
`packages/execution-pipeline/scripts/chat_model.py predict`, pass
`--native-manifest run/predictions.manifest.json` to `record`. Its existing
manifest binds the cases, predictions, checkpoint, greedy decoding and token limit.
The provenance JSON adds the seed and EOS rule. Represent effective greedy decoding
as a temperature of zero. The current native producer uses its worker’s seed
default of 21, and its first and only candidate uses greedy token selection.
The runner checks the evidence supplied by the operator. The authorized evaluator
is responsible for running the declared command after registration and recording its
observed settings.

### Evidence by adapter

All prediction files must include the exact case IDs, with one row per case. Paired
runs use the same frozen case set in both files.

| Adapter | Frozen case fields in addition to the common fields | Prediction fields |
| --- | --- | --- |
| Generation | `prompt` string or `messages` conversation turns with `role` and `content` | `text` and boolean `finished`, plus optional `checkpoint_sha256`, `error`, `stop_reason`, and `output_tokens` |
| Agent | `request`, `expected_outcome` (`completed` or `refused`), and for completion, a nonempty `expected_final_state` object and `output_format` | `text`, `status` (`completed`, `refused`, `partial`, or `blocked`), with `final_state_path` and `output_file` for a completion claim |
| Classifier | `label` and optional boolean `never_web` for router gates | `label` and, for candidates, `confidence` from 0 to 1 |

Generation scoring requires nonempty well-formed text and no generation error.
`require_eos` requires `finished: true`. A registered `allow_token_limit` additionally
allows an unfinished row that explicitly declares `stop_reason: "length"` and reports
`output_tokens` equal to the registered `max_tokens`. System turns stay private.

For agent completion, export the actual final state independently of the agent’s
reply as a local JSON file. Its decoded object must match the registered expected
state. The result file must be a nonempty readable local file, and the runner
checks the registered format (`text`, `json`, or `csv`). These checks cover
local files up to 16 MiB. Application-specific formats require their own
openability check before the adapter can support them.
Both paths are relative to the predictions directory. A claim without both pieces of evidence
fails even if a human judge accepted the text. A case may instead register refusal
as its expected outcome. Reports distinguish completion, refusal, and other outcomes.

Classifier results use exact label equality and report accuracy and expected
calibration error (ECE) with the registered number of equal-width confidence bins.
Candidate predictions require confidence. A rules-only baseline can supply labels alone.
`rule.classifier` requires positive integer `ece_bins`. Optional `max_ece`
is inclusive. Optional `max_wrong_confidence` forbids any incorrect answer at
or above that confidence. With `router: true`, a single never-web case predicted
as `web_search` stops the gate. The frozen `never_web: true` flag can designate
additional cases beyond the repository’s never-web routes.

### Blind judging

For human judging, share only the bytes of `run/packet/judge-sheet.json`. This
file contains one item per case in seeded order with languages interleaved where
the mix allows. The criterion comes from the frozen case. Source identity metadata
and system turns are excluded. Configured identity terms and artifact identifiers
are redacted from visible evidence. The case map and A/B assignments stay private.
Each paired item contains both answers in case-local randomized order. Instructions
to judges should give only the registered criteria, and judges should submit their
sheets independently.

A verdict file contains the SHA-256 of the exact shared packet bytes and the judge’s
zoned timestamp. That time must fall between packet creation and submission.
Provide a boolean and a concrete reason for every packet item.
This is a one-item illustration.

```json
{
  "schema_version": 1,
  "judge_id": "reviewer-1",
  "judged_at": "2026-11-25T13:05:00Z",
  "packet_sha256": "<64 lowercase hex digits>",
  "verdicts": [
    {"id": "item-001", "passed": true, "reason": "Answered the question in the user's language."}
  ]
}
```

For a paired packet, each row has `id`, `a`, and `b`. Both `a` and `b` are
objects with `passed` and `reason`. Submit each complete verdict and decide
after the registered number of distinct judges has submitted.

```sh
python3 -m scripts.gates submit run reviewer-1.json
python3 -m scripts.gates submit run reviewer-2.json
python3 -m scripts.gates decide run
```

Classifier runs go directly from `pack` to `decide` because the frozen labels
determine correctness. Human gates record each judge’s identity and judgment and
receipt times. For multiple judges, the report includes pairwise Cohen’s kappa on
the same blind items. Kappa is null when the expected agreement is 100%.

## Read and preserve the decision

| Registered setting | Decision criterion |
| --- | --- |
| `minimum_counts` | Positive integer sample size |
| `minimum_passes` | Minimum integer number of passes |
| `minimum_pass_rate` | Minimum fraction passed from 0 to 1 |
| `minimum_wilson_lower` | Minimum lower endpoint of the two-sided Wilson 95% interval from 0 to 1 |
| `no_zero_pass_categories` | At least one pass in each category present in the frozen set |
| `test` | `{"name":"none"}` or `{"name":"mcnemar_exact","alpha":0.05}`. The latter requires a pinned baseline, more candidate-only than baseline-only passes, and an exact two-sided p-value strictly below the registered alpha |

Thresholds in the first four rows can apply to `overall`, to a map of `languages`,
or to a map of `categories`. The report includes passes, denominators, and Wilson
intervals overall and by language and category. A registered threshold needs a
corresponding measured group. The first report is `run/reports/report-0001.json`.
It records the outcome and rule IDs, paths and hashes, commands and timestamps, and
an Arabic summary.

The decision is `pass` when the registered rules are met. An observed router or
high-confidence error violation stops a classifier gate even when sample counts fall
short. Otherwise, insufficient evidence yields `inconclusive`, and a failed
performance or significance criterion with sufficient evidence yields `stop`.
Missing independent judge sheets yield `inconclusive`. A malformed or changed
artifact raises an error and cannot be used to issue a decision.

A report is write-once. To issue an updated report against the same run, pass the
latest report as `--previous`. The next numbered report links to it by path and
SHA-256.

```sh
python3 -m scripts.gates decide run --previous run/reports/report-0001.json
```

When the owner explicitly overrides a rule, record their exact words in a UTF-8 file
and reference the original report and relevant rule ID. The override record also
has its own time, owner identity and declared decision. The report remains intact.

```sh
python3 -m scripts.gates override run run/reports/report-0001.json \
  --decision stop --owner owner --rule minimum_passes.overall \
  --words-file owner-words.txt --output owner-override.json
```

The archive provides integrity checks and an audit trail for a trusted local
operator. Filesystem permissions protect sealed cases, private receipts, and view
logs. Keep the canonical frozen file and log together so runs share the same record
of use. The CLI records the identities supplied to it. Authenticating operators and
judges, auditing out-of-band access, and recognizing unlisted identities in natural
language depend on the evaluation process outside the CLI.

## Replay the bundled fixtures

Run this from the repository root. The example uses only bundled evidence and
fixture-only verdicts in fresh temporary runs.

```sh
python3 - <<'PY'
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

fixtures = Path("scripts/gates/fixtures").resolve()
with tempfile.TemporaryDirectory() as temporary:
    workspace = Path(temporary)
    for adapter, total, minimum in [("generation", 2, 2), ("agent", 3, 2), ("classifier", 6, 6)]:
        directory = workspace / adapter
        directory.mkdir()
        fixture = fixtures / adapter
        run = directory / "run"

        def write(name, value):
            path = directory / name
            path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
            return path

        def hash_file(path):
            return hashlib.sha256(path.read_bytes()).hexdigest()

        def pin(path):
            return {"path": path.name, "sha256": hash_file(path)}

        def gate(*args):
            subprocess.run([sys.executable, "-m", "scripts.gates", *map(str, args)], check=True)

        automatic = adapter == "classifier"
        settings = None
        if adapter == "generation":
            settings = {"seed": 21, "temperature": 0, "max_tokens": 32, "eos_rule": "require_eos"}
        cases = Path(shutil.copyfile(fixture / "cases.jsonl", directory / "cases.jsonl"))
        candidate = write("candidate.json", {"fixture_artifact": "candidate"})
        rule = {
            "minimum_counts": {"overall": total},
            "minimum_passes": {"overall": minimum},
            "test": {"name": "none"},
        }
        registration = {
            "schema_version": 1,
            "gate_id": f"{adapter}-fixture",
            "question": "Does the runner score the archived fixture as expected?",
            "adapter": adapter,
            "cases": {**pin(cases), "sealed": True, "allow_reuse": False},
            "candidate": pin(candidate),
            "generation": settings,
            "judging": {
                "judges": 0 if automatic else 2,
                "aggregation": "automatic" if automatic else "unanimous",
                "shuffle_seed": 25,
                "identity_terms": [
                    "Fixture Model Identity", "Fixture Checkpoint Identity", "Fixture System Identity"
                ],
            },
            "rule": rule,
        }
        if automatic:
            registration["baseline"] = pin(write("baseline.json", {"fixture_artifact": "baseline"}))
            rule["test"] = {"name": "mcnemar_exact", "alpha": 0.05}
            rule["classifier"] = {"ece_bins": 10, "router": True, "max_wrong_confidence": 0.8}

        registration_path = write("registration.json", registration)
        gate("seal", registration_path)
        gate("start", registration_path, run, "--who", "fixture-evaluator", "--why", "Fixture replay")
        if adapter == "agent":
            for name in ("final-state.json", "output.txt"):
                shutil.copyfile(fixture / name, run / name)
        inputs = [("candidate", "predictions.jsonl")]
        if automatic:
            inputs.append(("baseline", "baseline.jsonl"))
        for role, name in inputs:
            command = [
                sys.executable, "-c", "import shutil, sys; shutil.copyfile(*sys.argv[1:])",
                str(fixture / name), str(run / name),
            ]
            subprocess.run(command, check=True)
            provenance = write(f"{role}-provenance.json", {"command": command, "settings": settings})
            gate("record", run, "--role", role, "--provenance", provenance)
        gate("pack", run)

        if not automatic:
            packet = run / "packet" / "judge-sheet.json"
            items = json.loads(packet.read_bytes())["items"]
            for number in (1, 2):
                verdict = write(f"judge-{number}.json", {
                    "schema_version": 1,
                    "judge_id": f"fixture-judge-{number}",
                    "judged_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                    "packet_sha256": hash_file(packet),
                    "verdicts": [
                        {"id": item["id"], "passed": True, "reason": "Fixture verdict."}
                        for item in items
                    ],
                })
                gate("submit", run, verdict)
        gate("decide", run)
        report = json.loads((run / "reports" / "report-0001.json").read_bytes())
        assert report["decision"] == "pass", report["reasons"]
        counts = report["counts"]["overall"]
        assert (counts["passed"], counts["total"]) == (minimum, total), counts
        if automatic:
            assert report["mcnemar"]["p_value"] == 0.03125
        print(f"{adapter}: {counts['passed']}/{counts['total']}")
PY
```

Expected counts are generation 2/2, agent 2/3, and classifier 6/6. The scripted
agent verdicts accept all three replies, so the 2/3 result demonstrates that a
completion claim without both evidence files still fails. The classifier fixture’s
paired comparison has six candidate-only passes and exact McNemar p = 0.03125.
