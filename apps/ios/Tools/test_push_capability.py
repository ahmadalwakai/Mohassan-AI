from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import unittest
from unittest.mock import Mock, call, patch

from apple_api import AppleAPIError
from prepare_signing import BUNDLE_ID
from push_capability import imported_certificate_team, main

BUNDLES_PATH = "/v1/bundleIds"
CAPABILITIES_PATH = "/v1/bundleIdCapabilities"
BUNDLE_RECORD = "exact-app-record"
BUNDLE_CAPABILITIES_PATH = f"/v1/bundleIds/{BUNDLE_RECORD}/bundleIdCapabilities"
BUNDLE_FILTER = {"filter[identifier]": BUNDLE_ID}


def bundle_fixture(record_id, identifier, platform="IOS"):
    return {"type": "bundleIds", "id": record_id,
            "attributes": {"identifier": identifier, "platform": platform}}


def capability_fixture(record_id, capability):
    return {"type": "bundleIdCapabilities", "id": record_id,
            "attributes": {"capabilityType": capability}}


EXACT_BUNDLE = bundle_fixture(BUNDLE_RECORD, BUNDLE_ID)
OTHER_BUNDLE = bundle_fixture("different-app-record", BUNDLE_ID + ".other")
APP_GROUPS = capability_fixture("app-groups-record", "APP_GROUPS")
PUSH = capability_fixture("push-notifications-record", "PUSH_NOTIFICATIONS")


class PushCapabilityTests(unittest.TestCase):
    def run_action(self, action, *responses):
        api = Mock()
        api.request.side_effect = responses
        output = StringIO()
        errors = StringIO()
        with (patch("push_capability.AppleAPI", return_value=api),
              patch("push_capability.imported_certificate_team", return_value="AB123CD456") as team,
              redirect_stdout(output), redirect_stderr(errors)):
            status = main([action])
        if action == "check":
            team.assert_called_once_with()
        else:
            team.assert_not_called()
        api.close.assert_called_once_with()
        return status, output.getvalue(), errors.getvalue(), api.request.call_args_list

    def test_certificate_team_comes_from_the_imported_public_identity(self):
        der = b"test public DER"
        with (patch("push_capability.installed_identities", return_value={"test-digest": der}),
              patch("push_capability.certificate_team", return_value="AB123CD456") as team):
            self.assertEqual(imported_certificate_team(), "AB123CD456")
        team.assert_called_once_with(der)

    def test_check_reads_the_exact_bundle_and_capabilities_without_writing(self):
        status, output, errors, requests = self.run_action(
            "check", {"data": [OTHER_BUNDLE, EXACT_BUNDLE]}, {"data": [PUSH, APP_GROUPS]},
        )
        self.assertEqual(status, 0)
        self.assertEqual(errors, "")
        self.assertIn("Imported distribution certificate team: AB123CD456", output)
        self.assertIn(f"Exactly one {BUNDLE_ID} for the integration key: yes. Platform: IOS.", output)
        self.assertIn("Capability types: APP_GROUPS, PUSH_NOTIFICATIONS", output)
        self.assertEqual(requests, [
            call("GET", BUNDLES_PATH, params=BUNDLE_FILTER),
            call("GET", BUNDLE_CAPABILITIES_PATH, params=None),
        ])

    def test_check_reports_no_exact_bundle_without_writing(self):
        status, output, errors, requests = self.run_action("check", {"data": [OTHER_BUNDLE]})
        self.assertEqual(status, 1)
        self.assertEqual(errors, "")
        self.assertIn(f"Exactly one {BUNDLE_ID} for the integration key: no (0 found).", output)
        self.assertEqual(requests, [call("GET", BUNDLES_PATH, params=BUNDLE_FILTER)])

    def test_enable_posts_only_push_for_the_exact_bundle_then_verifies(self):
        status, output, errors, requests = self.run_action(
            "enable", {"data": [OTHER_BUNDLE, EXACT_BUNDLE]},
            {"data": [APP_GROUPS]}, {"data": PUSH}, {"data": [APP_GROUPS, PUSH]},
        )
        self.assertEqual(status, 0)
        self.assertEqual(errors, "")
        self.assertIn("Capability types: APP_GROUPS, PUSH_NOTIFICATIONS", output)
        self.assertEqual(requests, [
            call("GET", BUNDLES_PATH, params=BUNDLE_FILTER),
            call("GET", BUNDLE_CAPABILITIES_PATH, params=None),
            call("POST", CAPABILITIES_PATH, body={
                "data": {
                    "type": "bundleIdCapabilities",
                    "attributes": {"capabilityType": "PUSH_NOTIFICATIONS"},
                    "relationships": {"bundleId": {"data": {"type": "bundleIds", "id": BUNDLE_RECORD}}},
                },
            }),
            call("GET", BUNDLE_CAPABILITIES_PATH, params=None),
        ])

    def test_enable_does_not_post_when_push_is_already_present(self):
        status, output, errors, requests = self.run_action(
            "enable", {"data": [EXACT_BUNDLE]}, {"data": [PUSH]},
        )
        self.assertEqual(status, 0)
        self.assertEqual(errors, "")
        self.assertIn("Capability types: PUSH_NOTIFICATIONS", output)
        self.assertEqual(requests, [
            call("GET", BUNDLES_PATH, params=BUNDLE_FILTER),
            call("GET", BUNDLE_CAPABILITIES_PATH, params=None),
        ])

    def test_enable_fails_when_read_back_lacks_push(self):
        status, output, errors, requests = self.run_action(
            "enable", {"data": [EXACT_BUNDLE]},
            {"data": []}, {"data": PUSH}, {"data": [APP_GROUPS]},
        )
        self.assertEqual(status, 1)
        self.assertIn("Capability types: APP_GROUPS", output)
        self.assertIn("Read-back did not confirm Push Notifications", errors)
        self.assertEqual([request.args[0] for request in requests], ["GET", "GET", "POST", "GET"])

    def test_enable_fails_before_writing_when_the_exact_bundle_is_ambiguous(self):
        duplicate = bundle_fixture("second-exact-app-record", BUNDLE_ID, "UNIVERSAL")
        status, _, errors, requests = self.run_action("enable", {"data": [EXACT_BUNDLE, duplicate]})
        self.assertEqual(status, 1)
        self.assertIn(f"Expected exactly one App ID {BUNDLE_ID}", errors)
        self.assertEqual(requests, [call("GET", BUNDLES_PATH, params=BUNDLE_FILTER)])

    def test_enable_conflict_checks_read_back_once_without_retrying_post(self):
        status, output, errors, requests = self.run_action(
            "enable", {"data": [EXACT_BUNDLE]}, {"data": []},
            AppleAPIError("POST", CAPABILITIES_PATH, 409), {"data": [PUSH]},
        )
        self.assertEqual(status, 0)
        self.assertEqual(errors, "")
        self.assertIn("Capability types: PUSH_NOTIFICATIONS", output)
        self.assertEqual([request.args[0] for request in requests], ["GET", "GET", "POST", "GET"])


if __name__ == "__main__":
    unittest.main()
