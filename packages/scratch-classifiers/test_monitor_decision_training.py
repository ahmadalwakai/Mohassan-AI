import json
import tempfile
import unittest
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

from train_monitor_decision import (
    Features, RealDecision, REGISTRY_SHA256, STAGES, Schema, chronological_split, digest, load_export, matrix,
)


class MonitorDecisionTrainingTest(unittest.TestCase):
    def test_time_split_excludes_crossing_conversations_and_unavailable_labels(self):
        start = datetime(2026, 1, 1, tzinfo=UTC)
        rows = [
            RealDecision(
                str(i), str(i), str(i), ("ar", "en")[i % 2], "offer",
                start + timedelta(days=i), start + timedelta(days=i, hours=1), "pending", 7,
                {"label": "offer", "score": 0.8}, Features([0], {"waiting": 1}),
            )
            for i in range(30)
        ]
        rows[5] = replace(rows[5], conversation_key=rows[-1].conversation_key)
        rows[6] = replace(rows[6], feedback_at=rows[-1].feedback_at)
        final = replace(rows[0], case_id="newer", expected="none", feedback_at=start + timedelta(hours=2))

        splits, report = chronological_split([*rows, final])

        self.assertEqual(1, report["supersededEvents"])
        self.assertEqual({"conversationSpansBoundary": 2, "feedbackCrossesBoundary": 1}, report["excludedDecisions"])
        self.assertIn(final, splits["headTrain"])
        for first, second in zip(STAGES, STAGES[1:]):
            self.assertLess(max(row.feedback_at for row in splits[first]), min(row.proposed_at for row in splits[second]))
        self.assertFalse(any(
            row.case_id in {"5", "6", "29"} for stage in splits.values() for row in stage
        ))

    def test_generated_export_cannot_enter_human_training(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "decisions.jsonl"
            path.write_bytes(b"{}\n")
            path.with_name("decisions.jsonl.manifest.json").write_text(json.dumps({
                "version": 1, "sha256": digest(path.read_bytes()), "source": "pipeline-check",
                "v2ExclusionSha256": REGISTRY_SHA256, "rows": 1,
            }))
            with self.assertRaisesRegex(ValueError, "required provenance"):
                load_export(path, "human", Schema(["waiting"], 4))

    def test_numeric_frame_features_follow_binary_text_buckets(self):
        result = matrix([Features([0, 3], {"history": 4, "waiting": 1})], Schema(["history", "waiting"], 4))
        self.assertEqual([[1, 0, 0, 1, 4, 1]], result.toarray().tolist())


if __name__ == "__main__":
    unittest.main()
