import json
import unittest

from scripts.gates.blind import make_packet, validate_verdict
from scripts.gates.common import GateError


PACKET_HASH = "1" * 64


class BlindPacketTests(unittest.TestCase):
    def setUp(self):
        self.cases = [
            {"id": f"internal-{language}-{i}", "language": language, "criterion": "Answer directly."}
            for language in ("ar", "en")
            for i in range(4)
        ]
        self.items = {
            case["id"]: {
                "messages": [{"role": "user", "content": "Question about System Example"}],
                "text": "Candidate ckpt-42.pt, registered as private.MODEL",
            }
            for case in self.cases
        }
        self.terms = ["Private.Model", "ckpt-42.pt", "System Example"]

    def test_packet_redacts_nested_identity_and_mixes_languages_deterministically(self):
        result = make_packet(self.cases, self.items, 17, self.terms)
        packet, mapping, sides = result
        self.assertEqual(result, make_packet(self.cases, self.items, 17, self.terms))
        self.assertNotEqual(mapping, make_packet(self.cases, self.items, 29, self.terms)[1])
        self.assertEqual({}, sides)
        self.assertEqual(set(mapping.values()), set(self.items))
        self.assertEqual(list(mapping), [item["id"] for item in packet["items"]])
        languages = [case_id.split("-")[1] for case_id in mapping.values()]
        self.assertTrue(all(a != b for a, b in zip(languages, languages[1:])))
        serialized = json.dumps(packet).casefold()
        for identity in [*self.terms, *self.items]:
            self.assertNotIn(identity.casefold(), serialized)
        self.assertTrue(all(item["criterion"] == "Answer directly." for item in packet["items"]))
        self.assertIn("[redacted]", packet["items"][0]["messages"][0]["content"])

    def test_language_imbalance_keeps_spreading_the_smaller_group(self):
        cases = self.cases[:4] + self.cases[4:6]
        _, mapping, _ = make_packet(cases, self.items, 14, self.terms)
        languages = [case_id.split("-")[1] for case_id in mapping.values()]
        self.assertEqual(1, sum(a == b for a, b in zip(languages, languages[1:])))

    def test_paired_packet_keeps_one_item_per_case_and_hides_candidate_side(self):
        baseline = {case["id"]: {"text": "Reference result"} for case in self.cases}
        packet, mapping, sides = make_packet(
            self.cases, self.items, 17, self.terms, baseline_items=baseline
        )
        self.assertEqual(len(packet["items"]), len(self.cases))
        self.assertEqual(set(sides.values()), {"a", "b"})
        for item in packet["items"]:
            item_id = item["id"]
            side = sides[item_id]
            other = "a" if side == "b" else "b"
            self.assertEqual(item[other], baseline[mapping[item_id]])
            self.assertEqual(item[side]["text"], "Candidate [redacted], registered as [redacted]")
            self.assertEqual(set(item), {"id", "criterion", "a", "b"})
        self.assertNotIn("candidate_sides", packet)

    def test_redacts_criterion_and_does_not_allow_ambiguous_evidence_fields(self):
        case = {**self.cases[0], "criterion": "Do not identify Private.Model"}
        packet, _, _ = make_packet([case], self.items, 17, self.terms)
        self.assertEqual(packet["items"][0]["criterion"], "Do not identify [redacted]")
        with self.assertRaisesRegex(GateError, "reserved"):
            make_packet([case], {case["id"]: {"id": case["id"]}}, 17, self.terms)
        with self.assertRaisesRegex(GateError, "duplicate"):
            make_packet(
                [case], {case["id"]: {"evidence": {"Private.Model": 1, "CKPT-42.PT": 2}}},
                17, self.terms,
            )


class VerdictValidationTests(unittest.TestCase):
    def setUp(self):
        self.packet = {
            "schema_version": 1,
            "items": [{"id": "item-001"}, {"id": "item-002"}],
        }
        self.first = {"id": "item-001", "passed": True, "reason": " Answers the question. "}
        self.second = {"id": "item-002", "passed": False, "reason": "Off topic."}
        self.sheet = {
            "schema_version": 1,
            "judge_id": " reader-a ",
            "judged_at": "2026-11-25T14:30:00+02:00",
            "packet_sha256": PACKET_HASH,
            "verdicts": [self.second, self.first],
        }

    def test_normalizes_identity_time_reason_and_packet_order(self):
        result = validate_verdict(self.sheet, self.packet, PACKET_HASH)
        self.assertEqual(result["judge_id"], "reader-a")
        self.assertEqual(result["judged_at"], "2026-11-25T12:30:00Z")
        self.assertEqual(result["verdicts"], [{**self.first, "reason": "Answers the question."}, self.second])

    def test_refuses_packet_mismatch_and_invalid_judge_metadata(self):
        invalid = [
            ({"packet_sha256": "2" * 64}, "different packet"),
            ({"judge_id": " "}, "identify"),
            ({"judged_at": "2026-11-25T12:30:00"}, "time zone"),
            ({"judged_at": "2026-11-25T12:30:00-00:00"}, "time zone"),
            ({"judged_at": "2026-11-25T12:30:00+00:99"}, "timestamp"),
            ({"judged_at": "2026-02-30T12:30:00Z"}, "timestamp"),
            ({"schema_version": True}, "schema version"),
            ({"other": "unexpected"}, "sheet fields"),
        ]
        for patch, error in invalid:
            with self.subTest(patch=patch), self.assertRaisesRegex(GateError, error):
                validate_verdict({**self.sheet, **patch}, self.packet, PACKET_HASH)

    def test_refuses_duplicate_unknown_missing_or_malformed_verdicts(self):
        invalid = [
            ([self.first, self.first], "Duplicate"),
            ([self.first, {**self.second, "id": "other"}], "unknown"),
            ([self.first], "cover every"),
            ([{**self.first, "reason": " "}, self.second], "concrete reason"),
            ([{**self.first, "passed": 1}, self.second], "boolean"),
            ([{**self.first, "confidence": 1.0}, self.second], "exactly"),
        ]
        for verdicts, error in invalid:
            with self.subTest(verdicts=verdicts), self.assertRaisesRegex(GateError, error):
                validate_verdict({**self.sheet, "verdicts": verdicts}, self.packet, PACKET_HASH)

    def test_requires_both_sides_of_paired_item(self):
        packet = {"schema_version": 1, "items": [{"id": "item-001", "a": {}, "b": {}}]}
        a = {"passed": True, "reason": "Exact."}
        b = {"passed": False, "reason": "Partial."}
        row = {"id": "item-001", "a": a, "b": b}
        paired = {**self.sheet, "verdicts": [row]}
        self.assertEqual(validate_verdict(paired, packet, PACKET_HASH)["verdicts"], [row])
        with self.assertRaisesRegex(GateError, "both sides"):
            validate_verdict({**paired, "verdicts": [{"id": "item-001", "a": a}]}, packet, PACKET_HASH)
        with self.assertRaisesRegex(GateError, "exactly"):
            validate_verdict({**paired, "verdicts": [{**row, "b": True}]}, packet, PACKET_HASH)


if __name__ == "__main__":
    unittest.main()
