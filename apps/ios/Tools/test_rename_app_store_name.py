from contextlib import redirect_stdout
from io import StringIO
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, call

from apple_api import APP_ID, AppleAPIError, DistributionError
from prepare_signing import BUNDLE_ID
from rename_app_store_name import APP_INFORMATION, APP_NAME, rename_app_store_name

APP_PATH = f"/v1/apps/{APP_ID}"
LIVE_PATH = "/v1/appInfos/live/appInfoLocalizations"
DRAFT_PATH = "/v1/appInfos/draft/appInfoLocalizations"
PATCH_PATH = "/v1/appInfoLocalizations/draft-fr"


def app(bundle_id=BUNDLE_ID):
    return {"data": {"type": "apps", "id": APP_ID, "attributes": {"bundleId": bundle_id}}}


def app_info(info_id, **attributes):
    return {"type": "appInfos", "id": info_id, "attributes": attributes}


def localization(localization_id, locale, name):
    return {
        "type": "appInfoLocalizations",
        "id": localization_id,
        "attributes": {
            "locale": locale,
            "name": name,
            "subtitle": "Keep this subtitle",
            "privacyPolicyUrl": "https://example.com/privacy",
        },
    }


def collection(*resources):
    return {"data": list(resources)}


def fake_api(*responses):
    return SimpleNamespace(request=Mock(side_effect=responses))


DRAFT = app_info("draft", state="PREPARE_FOR_SUBMISSION")
ENGLISH = localization("draft-en", "en-US", APP_NAME)
FRENCH = localization("draft-fr", "fr-FR", "Wasla")
RENAMED_FRENCH = localization("draft-fr", "fr-FR", APP_NAME)


class AppStoreRenameTests(unittest.TestCase):
    def run_rename(self, api):
        output = StringIO()
        with redirect_stdout(output):
            rename_app_store_name(api)
        return [json.loads(line) for line in output.getvalue().splitlines()]

    def writes(self, api):
        return [request for request in api.request.call_args_list if request.args[0] != "GET"]

    def assert_stops_with(self, api, message):
        with self.assertRaises(DistributionError) as error:
            self.run_rename(api)
        self.assertIn(message, str(error.exception))
        self.assertIn(APP_INFORMATION, str(error.exception))

    def test_skips_already_named_localization_and_patches_only_name_in_draft(self):
        live = app_info("live", state="READY_FOR_DISTRIBUTION")
        live_name = localization("live-en", "en-US", "Wasla")
        api = fake_api(app(), collection(live, DRAFT), collection(live_name),
                       collection(ENGLISH, FRENCH), {"data": RENAMED_FRENCH},
                       collection(ENGLISH, RENAMED_FRENCH))

        output = self.run_rename(api)

        self.assertEqual([request.args for request in api.request.call_args_list], [
            ("GET", APP_PATH),
            ("GET", f"{APP_PATH}/appInfos"),
            ("GET", LIVE_PATH),
            ("GET", DRAFT_PATH),
            ("PATCH", PATCH_PATH),
            ("GET", DRAFT_PATH),
        ])
        self.assertEqual(self.writes(api), [call("PATCH", PATCH_PATH, body={
            "data": {
                "type": "appInfoLocalizations",
                "id": "draft-fr",
                "attributes": {"name": "Mohassan AI"},
            },
        })])
        self.assertEqual(output, [
            {"locale": "en-US", "name": "Wasla"},
            {"locale": "en-US", "name": "Mohassan AI"},
            {"locale": "fr-FR", "name": "Wasla"},
            {"locale": "en-US", "name": "Mohassan AI"},
            {"locale": "fr-FR", "name": "Mohassan AI"},
        ])

    def test_reads_all_localization_pages_before_renaming(self):
        first_page = {
            "data": [ENGLISH],
            "links": {"next": f"https://api.appstoreconnect.apple.com{DRAFT_PATH}?cursor=second"},
        }
        api = fake_api(app(), collection(DRAFT), first_page, collection(FRENCH),
                       {"data": RENAMED_FRENCH}, collection(ENGLISH, RENAMED_FRENCH))

        self.run_rename(api)

        self.assertEqual(api.request.call_args_list[3],
                         call("GET", DRAFT_PATH, params=[("cursor", "second")]))
        self.assertEqual([request.args for request in self.writes(api)], [("PATCH", PATCH_PATH)])

    def test_accepts_ready_for_review_from_legacy_state_field(self):
        draft = app_info("draft", appStoreState="READY_FOR_REVIEW")
        api = fake_api(app(), collection(draft), collection(FRENCH),
                       {"data": RENAMED_FRENCH}, collection(RENAMED_FRENCH))

        self.run_rename(api)

        self.assertEqual([request.args for request in self.writes(api)], [("PATCH", PATCH_PATH)])

    def test_different_bundle_id_stops_before_writes(self):
        api = fake_api(app("com.example.other"))

        with self.assertRaisesRegex(DistributionError, "different bundle ID"):
            self.run_rename(api)

        api.request.assert_called_once_with("GET", APP_PATH)

    def test_duplicate_name_points_to_app_information(self):
        failure = AppleAPIError("PATCH", PATCH_PATH, 409,
                                codes=("ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE.SAME_ACCOUNT",))
        api = fake_api(app(), collection(DRAFT), collection(FRENCH), failure)

        self.assert_stops_with(api, "Another app already uses the name Mohassan AI.")
        self.assertEqual([request.args for request in self.writes(api)], [("PATCH", PATCH_PATH)])

    def test_noneditable_app_info_points_to_app_information(self):
        live = app_info("live", state="READY_FOR_DISTRIBUTION")
        api = fake_api(app(), collection(live), collection(localization("live-en", "en-US", "Wasla")))

        self.assert_stops_with(api, "No App Information record is editable.")
        self.assertEqual(self.writes(api), [])

    def test_read_back_mismatch_points_to_app_information(self):
        api = fake_api(app(), collection(DRAFT), collection(FRENCH),
                       {"data": RENAMED_FRENCH}, collection(FRENCH))

        self.assert_stops_with(api, "Read-back did not confirm Mohassan AI")

    def test_read_back_missing_localization_points_to_app_information(self):
        api = fake_api(app(), collection(DRAFT), collection(ENGLISH, FRENCH),
                       {"data": RENAMED_FRENCH}, collection(ENGLISH))

        self.assert_stops_with(api, "Read-back did not confirm Mohassan AI")


if __name__ == "__main__":
    unittest.main()
