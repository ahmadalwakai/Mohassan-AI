import base64
from contextlib import redirect_stdout
from datetime import datetime, timezone
import hashlib
from io import StringIO
import json
from pathlib import Path
import plistlib
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import ANY, Mock, call
from uuid import UUID

from prepare_signing import (
    AppleCLI,
    BUNDLE_ID,
    SigningError,
    app_requires_push,
    ensure_profile,
    matches_profile,
    report_push_capability,
)

BUNDLE_RESOURCE = {"type": "bundleIds", "id": "wasla-bundle", "attributes": {}}


class AppStoreProfileTests(unittest.TestCase):
    team = "AB123CD456"
    certificate_der = b"test distribution certificate"
    now = datetime(2026, 11, 26, tzinfo=timezone.utc)
    expiration = datetime(2027, 1, 1)
    certificate = {"type": "certificates", "id": "wasla-certificate", "attributes": {}}

    def profile_fixture(self, number, aps_environment=None):
        profile_uuid = str(UUID(int=number))
        entitlements = {
            "application-identifier": f"{self.team}.{BUNDLE_ID}",
            "com.apple.developer.team-identifier": self.team,
            "get-task-allow": False,
        }
        if aps_environment is not None:
            entitlements["aps-environment"] = aps_environment
        content = plistlib.dumps({
            "UUID": profile_uuid,
            "TeamIdentifier": [self.team],
            "ApplicationIdentifierPrefix": [self.team],
            "Entitlements": entitlements,
            "ExpirationDate": self.expiration,
            "Platform": ["iOS"],
            "DeveloperCertificates": [self.certificate_der],
        })
        resource = {
            "type": "profiles",
            "id": f"profile-{number}",
            "attributes": {
                "uuid": profile_uuid,
                "profileState": "ACTIVE",
                "profileType": "IOS_APP_STORE",
                "expirationDate": self.expiration.isoformat() + "Z",
                "profileContent": base64.b64encode(content).decode("ascii"),
            },
        }
        return resource, content

    def matches(self, aps_environment, *, requires_push=True):
        resource, content = self.profile_fixture(1, aps_environment)
        return matches_profile(plistlib.loads(content), resource, self.certificate_der,
                               self.team, self.now, requires_push=requires_push)

    def ensure(self, api):
        return ensure_profile(api, BUNDLE_RESOURCE, self.certificate, self.certificate_der,
                              self.team, self.now, decoder=plistlib.loads, requires_push=True)

    def test_rejects_profile_without_push(self):
        self.assertFalse(self.matches(None))

    def test_rejects_development_push_for_app_store(self):
        self.assertFalse(self.matches("development"))

    def test_accepts_production_push_for_app_store(self):
        self.assertTrue(self.matches("production"))

    def test_accepts_profile_without_push_when_app_does_not_request_it(self):
        self.assertTrue(self.matches(None, requires_push=False))

    def test_reuses_production_profile_among_stale_candidates(self):
        production, content = self.profile_fixture(1, "production")
        missing_push, _ = self.profile_fixture(2)
        development, _ = self.profile_fixture(3, "development")
        api = Mock(spec=AppleCLI)
        api.call.return_value = [missing_push, production, development]

        self.assertEqual(self.ensure(api), (production, content, False))
        api.call.assert_called_once_with("profiles", "bundle-ids", "profiles", "--bundle-ids",
                                         "wasla-bundle", "--type", "IOS_APP_STORE", "--state", "ACTIVE")

    def test_creates_profile_when_no_active_profile_qualifies(self):
        missing_push, _ = self.profile_fixture(1)
        old_name = "Wasla App Store " + hashlib.sha256(self.certificate_der).hexdigest()[:16]
        missing_push["attributes"]["name"] = old_name
        development, _ = self.profile_fixture(2, "development")
        production, content = self.profile_fixture(3, "production")
        api = Mock(spec=AppleCLI)
        api.call.side_effect = [[missing_push, development], [production]]

        self.assertEqual(self.ensure(api), (production, content, True))
        self.assertEqual(api.call.call_args_list, [
            call("profiles", "bundle-ids", "profiles", "--bundle-ids", "wasla-bundle",
                 "--type", "IOS_APP_STORE", "--state", "ACTIVE"),
            call("profiles", "profiles", "create", "wasla-bundle", "--certificate-ids",
                 "wasla-certificate", "--type", "IOS_APP_STORE", "--name", ANY),
        ])
        self.assertNotEqual(api.call.call_args.args[-1], old_name)

    def test_created_profile_without_push_explains_how_to_enable_it(self):
        missing_push, _ = self.profile_fixture(1)
        api = Mock(spec=AppleCLI)
        api.call.side_effect = [[], [missing_push]]

        with self.assertRaises(SigningError) as raised:
            self.ensure(api)

        message = str(raised.exception)
        self.assertIn("Push Notifications is not enabled", message)
        self.assertIn(BUNDLE_ID, message)
        self.assertIn("Apple Developer", message)
        self.assertIn("Identifiers", message)
        self.assertEqual(api.call.call_count, 2)
        api.call.assert_called_with("profiles", "profiles", "create", "wasla-bundle",
                                    "--certificate-ids", "wasla-certificate", "--type",
                                    "IOS_APP_STORE", "--name", ANY)


class PushEntitlementTests(unittest.TestCase):
    def test_checks_for_entitlement_key_in_source_plist(self):
        cases = [
            ({"aps-environment": "$(APS_ENVIRONMENT)"}, True),
            ({}, False),
        ]
        with TemporaryDirectory() as directory:
            path = Path(directory) / "Wasla.entitlements"
            for entitlements, expected in cases:
                with self.subTest(entitlements=entitlements):
                    path.write_bytes(plistlib.dumps(entitlements))
                    self.assertEqual(app_requires_push(path), expected)


class PushCapabilityTests(unittest.TestCase):
    def test_reports_capability_from_codemagic_json(self):
        push = {
            "type": "bundleIdCapabilities",
            "id": "ABC123_PUSH_NOTIFICATIONS",
            "attributes": {"capabilityType": "PUSH_NOTIFICATIONS"},
        }
        cases = [([push], "enabled"), ([], "not reported")]
        for capabilities, expected in cases:
            with self.subTest(status=expected):
                runner = Mock(return_value=json.dumps(capabilities).encode("utf-8"))
                with redirect_stdout(StringIO()) as output:
                    report_push_capability(AppleCLI(runner), BUNDLE_RESOURCE)

                runner.assert_called_once()
                self.assertEqual(runner.call_args.args[0][:4], [
                    "app-store-connect", "bundle-ids", "capabilities", "wasla-bundle",
                ])
                self.assertEqual(output.getvalue(),
                                 f"Wasla App ID PUSH_NOTIFICATIONS capability: {expected}.\n")

    def test_capability_lookup_failure_is_nonfatal(self):
        runner = Mock(side_effect=SigningError("Tool diagnostic"))
        with redirect_stdout(StringIO()) as output:
            report_push_capability(AppleCLI(runner), BUNDLE_RESOURCE)

        self.assertEqual(output.getvalue(),
                         "Wasla App ID PUSH_NOTIFICATIONS capability: lookup unavailable.\n")


if __name__ == "__main__":
    unittest.main()
