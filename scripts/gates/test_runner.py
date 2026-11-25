"""Exercise the offline gate lifecycle through its public CLI."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


REPO = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).resolve().with_name("fixtures")


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False) + "\n", encoding="utf-8")


def digest(path):
    return sha256(path.read_bytes()).hexdigest()


def read_rows(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def write_rows(path, rows):
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


class GateRunnerTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.run_dir = self.root / "run"
        self.registration = self.root / "registration.json"
        self.submissions = 0

    def cli(self, *arguments, ok=True):
        command = [sys.executable, "-m", "scripts.gates", *map(str, arguments)]
        result = subprocess.run(command, cwd=REPO, capture_output=True, text=True, encoding="utf-8", timeout=15)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertTrue(result.stderr.strip())
            self.assertNotIn("Traceback", result.stderr)
        return result

    def configure(self, adapter="generation", *, sealed=False, allow_reuse=False, pairs=False, judges=1, rule=None):
        self.fixture = FIXTURES / adapter
        self.cases = self.root / "frozen" / "cases.jsonl"
        self.cases.parent.mkdir()
        shutil.copyfile(self.fixture / "cases.jsonl", self.cases)
        self.artifact = self.root / "Private-Checkpoint.bin"
        self.artifact.write_bytes(b"fixture candidate artifact\n")
        self.generation = None
        if adapter == "generation":
            self.generation = {"seed": 19, "temperature": 0, "max_tokens": 32, "eos_rule": "require_eos"}
        self.rule = {
            "test": {"name": "none"},
            "minimum_counts": {"languages": {"ar": 1, "en": 1}},
            "minimum_passes": {"overall": 1},
        }
        if rule:
            self.rule.update(rule)
        if adapter == "classifier":
            self.rule.setdefault("classifier", {"ece_bins": 5, "router": True})
        registration = {
            "schema_version": 1,
            "gate_id": "fixture-gate",
            "question": "Does the fixture candidate meet the release criteria?",
            "adapter": adapter,
            "cases": {**self.pin(self.cases), "sealed": sealed, "allow_reuse": allow_reuse},
            "candidate": self.pin(self.artifact),
            "generation": self.generation,
            "judging": {
                "judges": 0 if adapter == "classifier" else judges,
                "aggregation": "automatic" if adapter == "classifier" else "unanimous",
                "shuffle_seed": 101,
                "identity_terms": ["Private Fixture Model", "private-system-marker"],
            },
            "rule": self.rule,
        }
        if pairs:
            baseline = self.root / "Private-Baseline.bin"
            baseline.write_bytes(b"fixture baseline artifact\n")
            registration["baseline"] = self.pin(baseline)
        write_json(self.registration, registration)

    def pin(self, path):
        return {"path": path.relative_to(self.root).as_posix(), "sha256": digest(path)}

    def seal_and_start(self):
        self.cli("seal", self.registration)
        self.cli("start", self.registration, self.run_dir, "--who", "fixture-operator", "--why", "Development example")

    def prepare_result(self, role):
        name = "predictions.jsonl" if role == "candidate" else "baseline.jsonl"
        for path in self.fixture.iterdir():
            if path.is_file() and path.name not in {"cases.jsonl", "predictions.jsonl", "baseline.jsonl"}:
                shutil.copyfile(path, self.run_dir / path.name)
        raw = self.run_dir / name
        shutil.copyfile(self.fixture / name, raw)
        provenance = self.root / f"{role}-provenance.json"
        write_json(provenance, {"command": ["copy-fixture", name], "settings": self.generation})
        return raw, provenance

    def record(self, *, role="candidate", use_native_manifest=False):
        raw, provenance = self.prepare_result(role)
        args = ["record", self.run_dir, "--role", role, "--provenance", provenance]
        if use_native_manifest:
            native = raw.with_suffix(".manifest.json")
            write_json(native, {
                "schemaVersion": 1,
                "model": "Private Fixture Model",
                "checkpoint_sha256": digest(self.artifact),
                "input_sha256": digest(self.cases),
                "holdout_sha256": digest(self.cases),
                "predictions_sha256": digest(raw),
                "cases": len(read_rows(raw)),
                "max_tokens": self.generation["max_tokens"],
                "decoding": "greedy",
            })
            args.extend(["--native-manifest", native])
        self.cli(*args)
        return raw

    def pack(self):
        self.cli("pack", self.run_dir)
        self.packet = self.run_dir / "packet" / "judge-sheet.json"
        return read_json(self.packet)

    def make_verdict(self, judge_id, flags=None):
        item_ids = [item["id"] for item in read_json(self.packet)["items"]]
        if flags is None:
            flags = [True] * len(item_ids)
        return {
            "schema_version": 1,
            "judge_id": judge_id,
            "judged_at": datetime.now(timezone.utc).isoformat(),
            "packet_sha256": digest(self.packet),
            "verdicts": [
                {"id": item_id, "passed": passed, "reason": "Inspected against the frozen criterion."}
                for item_id, passed in zip(item_ids, flags, strict=True)
            ],
        }

    def submit(self, verdict, *, ok=True):
        self.submissions += 1
        path = self.root / f"judge-input-{self.submissions}.json"
        write_json(path, verdict)
        return self.cli("submit", self.run_dir, path, ok=ok)

    def decide(self, *, previous=None, ok=True):
        arguments = ["decide", self.run_dir]
        if previous is not None:
            arguments.extend(["--previous", previous])
        self.cli(*arguments, ok=ok)
        version = 1 if previous is None else int(previous.stem.rsplit("-", 1)[1]) + 1
        return self.run_dir / "reports" / f"report-{version:04d}.json"

    def test_generation_blind_packet_independent_judges_and_report(self):
        self.configure(judges=2, rule={
            "no_zero_pass_categories": True,
        })
        self.seal_and_start()
        self.record(use_native_manifest=True)
        packet = self.pack()
        cases = read_rows(self.cases)
        self.assertEqual(len(packet["items"]), len(cases))
        self.assertTrue(all(item["criterion"] for item in packet["items"]))
        public_text = self.packet.read_text(encoding="utf-8").casefold()
        for forbidden in (
            "Private-Checkpoint.bin", "Private Fixture Model", "private-system-marker",
            "Fixture Model Identity", "Fixture Checkpoint Identity", "Fixture System Identity",
            digest(self.artifact), "checkpoint_sha256", "fixture-gate", *(case["id"] for case in cases),
        ):
            self.assertNotIn(forbidden.casefold(), public_text)
        first = self.make_verdict("first-judge", [True, False])
        second = self.make_verdict("second-judge", [True, False])
        self.submit(first)
        self.submit(second)
        report = read_json(self.decide())
        self.assertEqual(report["decision"], "pass")
        self.assertEqual(report["counts"]["overall"]["total"], len(cases))
        self.assertEqual(report["counts"]["overall"]["passed"], 1)
        self.assertEqual(set(report["counts"]["languages"]), {"ar", "en"})
        self.assertGreater(report["counts"]["overall"]["wilson_95"][0], 0)
        self.assertEqual(len(report["agreement"]), 1)
        self.assertEqual(report["agreement"][0]["candidate_kappa"], 1)
        private_data = json.dumps(report, ensure_ascii=False)
        for value in (digest(self.cases), digest(self.packet), "first-judge", "second-judge", first["judged_at"][:10]):
            self.assertIn(value, private_data)
        self.assertRegex(report["arabic_summary"], r"[\u0600-\u06ff]")

    def test_agent_completion_requires_exported_state_and_openable_output(self):
        self.configure("agent", rule={"minimum_passes": {"overall": 2}})
        self.seal_and_start()
        self.record()
        self.pack()
        self.submit(self.make_verdict("agent-judge"))
        report = read_json(self.decide())
        self.assertEqual(report["decision"], "pass")
        self.assertEqual(report["counts"]["overall"]["passed"], 2)
        self.assertGreater(report["counts"]["overall"]["total"], 2)

    def test_classifier_calibration_safe_router_and_exact_paired_decision(self):
        self.configure("classifier", pairs=True, rule={
            "test": {"name": "mcnemar_exact", "alpha": 0.05},
            "minimum_pass_rate": {"overall": 0.8},
            "classifier": {"ece_bins": 5, "max_ece": 0.3, "router": True},
        })
        self.seal_and_start()
        self.record()
        self.record(role="baseline")
        self.pack()
        report = read_json(self.decide())
        self.assertEqual(report["decision"], "pass")
        self.assertEqual(report["counts"]["overall"]["pass_rate"], 1)
        self.assertAlmostEqual(report["mcnemar"]["p_value"], 0.03125)
        self.assertAlmostEqual(report["metrics"]["expected_calibration_error"], 0.1)
        checks = {check["rule"]: check["status"] for check in report["checks"]}
        self.assertEqual(checks["classifier.max_ece"], "pass")
        self.assertEqual(checks["classifier.router"], "pass")

    def test_router_stops_when_a_never_web_case_reaches_web_search(self):
        self.configure("classifier")
        self.seal_and_start()
        raw, provenance = self.prepare_result("candidate")
        predictions = read_rows(raw)
        memory_case = next(row for row in predictions if row["label"] == "memory")
        memory_case["label"] = "web_search"
        write_rows(raw, predictions)
        self.cli("record", self.run_dir, "--role", "candidate", "--provenance", provenance)
        self.pack()
        report = read_json(self.decide())
        self.assertEqual(report["decision"], "stop")
        self.assertEqual(report["metrics"]["never_web_violations"], 1)
        self.assertEqual([reason["rule"] for reason in report["reasons"]], ["classifier.router"])

    def test_paired_human_verdicts_are_mapped_back_to_candidate_and_baseline(self):
        self.configure(pairs=True)
        self.seal_and_start()
        candidate = self.record()
        baseline = self.run_dir / "baseline.jsonl"
        write_rows(baseline, [{**row, "text": "Wrong number"} for row in read_rows(candidate)])
        provenance = self.root / "baseline-provenance.json"
        write_json(provenance, {"command": ["prepare-test-baseline"], "settings": self.generation})
        self.cli("record", self.run_dir, "--role", "baseline", "--provenance", provenance)
        packet = self.pack()
        judgment = self.make_verdict("paired-judge")
        judgment["verdicts"] = [
            {"id": item["id"], **{
                side: {"passed": "Wrong number" not in json.dumps(item[side]), "reason": "Compared with the criterion."}
                for side in ("a", "b")
            }}
            for item in packet["items"]
        ]
        self.submit(judgment)
        report = read_json(self.decide())
        self.assertEqual(report["counts"]["overall"]["passed"], len(packet["items"]))
        self.assertEqual(report["mcnemar"]["candidate_only"], len(packet["items"]))
        self.assertEqual(report["mcnemar"]["baseline_only"], 0)

    def test_seal_detects_edited_registration(self):
        self.configure()
        self.cli("seal", self.registration)
        original = self.registration.read_bytes()
        self.registration.write_bytes(original + b"\n")
        self.cli("start", self.registration, self.run_dir, "--who", "operator", "--why", "Check pin", ok=False)
        self.assertFalse(self.run_dir.exists())

    def test_start_refuses_a_result_directory_that_already_exists(self):
        self.configure(sealed=True)
        self.cli("seal", self.registration)
        self.run_dir.mkdir()
        shutil.copyfile(self.fixture / "predictions.jsonl", self.run_dir / "predictions.jsonl")
        self.cli("start", self.registration, self.run_dir, "--who", "operator", "--why", "Existing results", ok=False)
        self.assertFalse((self.run_dir / "start.json").exists())
        self.assertFalse((self.cases.parent / ".gate-views").exists())

    def test_record_refuses_settings_that_differ_from_registration(self):
        self.configure()
        self.seal_and_start()
        _, provenance = self.prepare_result("candidate")
        changed = read_json(provenance)
        changed["settings"]["seed"] += 1
        write_json(provenance, changed)
        self.cli("record", self.run_dir, "--role", "candidate", "--provenance", provenance, ok=False)
        self.record()
        self.pack()

    def test_native_prediction_manifest_must_name_the_registered_checkpoint(self):
        self.configure()
        self.seal_and_start()
        raw, provenance = self.prepare_result("candidate")
        manifest = raw.with_suffix(".manifest.json")
        write_json(manifest, {
            "checkpoint_sha256": "f" * 64,
            "input_sha256": digest(self.cases),
            "predictions_sha256": digest(raw),
            "max_tokens": self.generation["max_tokens"],
        })
        self.cli("record", self.run_dir, "--role", "candidate", "--provenance", provenance,
                 "--native-manifest", manifest, ok=False)

    def test_candidate_pin_is_checked_again_after_start(self):
        self.configure()
        self.seal_and_start()
        self.record()
        self.artifact.write_bytes(b"replacement artifact\n")
        self.cli("pack", self.run_dir, ok=False)
        self.assertFalse((self.run_dir / "packet").exists())

    def test_frozen_set_is_checked_again_before_submission(self):
        self.configure()
        self.seal_and_start()
        self.record()
        self.pack()
        self.cases.write_bytes(self.cases.read_bytes() + b"\n")
        self.submit(self.make_verdict("first-judge"), ok=False)

    def test_predictions_are_checked_again_before_decision(self):
        self.configure()
        self.seal_and_start()
        raw = self.record()
        self.pack()
        self.submit(self.make_verdict("first-judge"))
        original = raw.read_bytes()
        raw.write_bytes(original + b"\n")
        self.decide(ok=False)
        raw.write_bytes(original)
        result = self.cli("decide", self.run_dir, ok=False)
        self.assertIn("Gate void", result.stderr)

    def test_agent_file_evidence_is_checked_again_before_decision(self):
        self.configure("agent")
        self.seal_and_start()
        self.record()
        self.pack()
        self.submit(self.make_verdict("agent-judge"))
        output = self.run_dir / "output.txt"
        output.write_bytes(output.read_bytes() + b"\n")
        self.decide(ok=False)

    def test_second_sealed_use_is_refused_across_registrations(self):
        self.configure(sealed=True)
        self.seal_and_start()
        later = self.root / "later-registration.json"
        write_json(later, {**read_json(self.registration), "gate_id": "later-gate"})
        self.cli("seal", later)
        second_run = self.root / "second-run"
        outcome = self.cli("start", later, second_run, "--who", "another-operator", "--why", "Second use", ok=False)
        self.assertRegex(outcome.stderr.casefold(), "sealed|already")
        views = list((self.cases.parent / ".gate-views" / digest(self.cases)).glob("*.json"))
        self.assertEqual(len(views), 1)
        view = read_json(views[0])
        self.assertEqual(view["who"], "fixture-operator")
        self.assertEqual(view["why"], "Development example")

    def test_sealed_set_cannot_be_reused_by_relabeling_it_as_unsealed(self):
        self.configure(sealed=True)
        self.seal_and_start()
        later = self.root / "later-registration.json"
        modified = {**read_json(self.registration), "gate_id": "later-gate"}
        modified["cases"]["sealed"] = False
        write_json(later, modified)
        self.cli("seal", later)
        self.cli("start", later, self.root / "second-run", "--who", "operator", "--why", "Second use", ok=False)

    def test_preregistered_sealed_reuse_is_allowed_and_logged(self):
        self.configure(sealed=True, allow_reuse=True)
        self.seal_and_start()
        self.cli("start", self.registration, self.root / "second-run", "--who", "another-operator", "--why", "Registered reuse")
        views = list((self.cases.parent / ".gate-views" / digest(self.cases)).glob("*.json"))
        self.assertEqual({read_json(path)["who"] for path in views}, {"fixture-operator", "another-operator"})

    def test_simultaneous_attempts_cannot_both_reserve_a_single_use_set(self):
        self.configure(sealed=True)
        self.cli("seal", self.registration)

        def reserve(index):
            return subprocess.run(
                [sys.executable, "-m", "scripts.gates", "start", str(self.registration),
                 str(self.root / f"run-{index}"), "--who", "operator", "--why", "Concurrent attempts"],
                cwd=REPO, capture_output=True, text=True, encoding="utf-8", timeout=15,
            )

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(reserve, (1, 2)))
        self.assertEqual(sum(result.returncode == 0 for result in results), 1, results)
        self.assertEqual(len(list(self.root.glob("run-*/start.json"))), 1)

    def test_bad_coverage_and_duplicate_judge_do_not_consume_an_independent_slot(self):
        self.configure(judges=2)
        self.seal_and_start()
        self.record()
        self.pack()
        invalid = self.make_verdict("first-judge")
        invalid["verdicts"].pop()
        self.submit(invalid, ok=False)
        self.submit(self.make_verdict("first-judge"))
        self.submit(self.make_verdict(" FIRST-JUDGE "), ok=False)
        self.submit(self.make_verdict("second-judge"))
        self.assertEqual(read_json(self.decide())["decision"], "pass")

    def test_report_revisions_and_owner_override_preserve_original_bytes(self):
        self.configure()
        self.seal_and_start()
        self.record()
        self.pack()
        original = self.decide()
        original_hash = digest(original)
        self.assertEqual(read_json(original)["decision"], "inconclusive")
        self.decide(ok=False)
        self.assertEqual(digest(original), original_hash)
        self.submit(self.make_verdict("first-judge"))
        revised = self.decide(previous=original)
        self.assertEqual(read_json(revised)["decision"], "pass")
        self.assertIn(original_hash, revised.read_text(encoding="utf-8"))
        self.assertIn(original.name, revised.read_text(encoding="utf-8"))
        self.assertEqual(digest(original), original_hash)

        updated_hash = digest(revised)
        words = self.root / "owner-words.txt"
        owner_words = "أوقف الإطلاق للمراجعة.\n  أبقِ هذا النص كما هو.  \n"
        words.write_bytes(owner_words.encode("utf-8"))
        override = self.root / "owner-override.json"
        args = ["override", self.run_dir, revised, "--decision", "stop", "--owner", "fixture-owner",
                "--rule", "minimum_passes.overall", "--words-file", words, "--output", override]
        self.cli(*args)
        note = read_json(override)
        self.assertEqual(note["words"], owner_words)
        self.assertEqual(note["decision"], "stop")
        self.assertEqual(note["owner"], "fixture-owner")
        self.assertEqual(note["rule"], "minimum_passes.overall")
        self.assertEqual(note["report"]["sha256"], updated_hash)
        self.cli(*args, ok=False)
        self.assertEqual(digest(revised), updated_hash)
        self.assertEqual(digest(original), original_hash)

    def test_report_revision_refuses_an_edited_captured_verdict(self):
        self.configure()
        self.seal_and_start()
        self.record()
        self.pack()
        self.submit(self.make_verdict("first-judge"))
        original_report = self.decide()

        capture = self.run_dir / "verdicts" / "verdict-000001.json"
        receipt = read_json(capture)
        verdict = json.loads(receipt["source_json"])
        verdict["verdicts"][0]["reason"] = "Different but valid reasoning."
        receipt["source_json"] = json.dumps(verdict) + "\n"
        receipt["source_sha256"] = sha256(receipt["source_json"].encode("utf-8")).hexdigest()
        write_json(capture, receipt)

        result = self.cli("decide", self.run_dir, "--previous", original_report, ok=False)
        self.assertIn("Gate void", result.stderr)
        self.assertFalse((original_report.parent / "report-0002.json").exists())


if __name__ == "__main__":
    unittest.main()
