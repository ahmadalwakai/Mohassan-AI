#!/usr/bin/env python3
"""Associate only the already-uploaded Wasla 1.0 (5) with Wasla Internal.

Run manually in Codemagic with the existing Vibeset Codemagic integration.
No uploads, review submissions, tester invitations, or signing operations.
Credentials are normalized in memory by the existing signing helper.

References:
https://docs.codemagic.io/partials/code-signing-ios-configure-environment-vars/
https://developer.apple.com/documentation/appstoreconnectapi/get-v1-builds
https://developer.apple.com/documentation/appstoreconnectapi/post-v1-betagroups-_id_-relationships-builds
"""
from __future__ import annotations

import os
import sys
import time

from prepare_signing import SigningError, prepare_integration_key

APP_ID = "6829577419"
BUNDLE_ID = "com.ahmadalwakai.wasla"
VERSION = "1.0"
BUILD_NUMBER = "5"
GROUP_ID = "892d8e1f-c4bf-4033-bac2-0ee41833f9aa"
GROUP_NAME = "Wasla Internal"
API_ORIGIN = "https://api.appstoreconnect.apple.com"


class DistributionError(RuntimeError):
    """Only fixed, non-secret diagnostics are included in errors."""


class AppleAPI:
    def __init__(self):
        # Both packages are dependencies of Codemagic's installed CLI tools.
        import jwt
        import requests

        prepare_integration_key()
        issuer = os.environ.get("APP_STORE_CONNECT_ISSUER_ID", "").strip()
        key_id = os.environ.get("APP_STORE_CONNECT_KEY_IDENTIFIER", "").strip()
        if not issuer or not key_id:
            raise DistributionError("The existing Apple integration credentials are missing.")
        now = int(time.time())
        token = jwt.encode(
            {"iss": issuer, "iat": now - 5, "exp": now + 300,
             "aud": "appstoreconnect-v1"},
            os.environ["APP_STORE_CONNECT_PRIVATE_KEY"],
            algorithm="ES256", headers={"kid": key_id, "typ": "JWT"},
        )
        self.session = requests.Session()
        self.session.trust_env = False
        self.session.headers.update({"Authorization": f"Bearer {token}",
                                     "Accept": "application/json"})

    def request(self, method, path, *, params=None, body=None):
        if method not in {"GET", "POST"} or not path.startswith("/v1/") or "?" in path:
            raise DistributionError("Unexpected Apple API request.")
        if method == "POST" and path != f"/v1/betaGroups/{GROUP_ID}/relationships/builds":
            raise DistributionError("Only the existing Wasla group relationship may be changed.")
        # No redirects or automatic request retries; normal certificate validation.
        response = self.session.request(
            method, API_ORIGIN + path, params=params, json=body,
            timeout=(10, 25), allow_redirects=False,
        )
        expected = 200 if method == "GET" else 204
        if response.status_code != expected:
            raise DistributionError(f"Apple API {method} failed (HTTP {response.status_code}).")
        if method == "POST":
            return None
        if len(response.content) > 2_000_000:
            raise DistributionError("Apple API response exceeded the expected size.")
        try:
            document = response.json()
        except ValueError:
            raise DistributionError("Apple API returned invalid JSON.") from None
        if not isinstance(document, dict):
            raise DistributionError("Apple API returned an invalid document.")
        return document

    def close(self):
        self.session.close()


def resource(document, expected_type, expected_id):
    item = document.get("data")
    if (not isinstance(item, dict) or item.get("type") != expected_type
            or item.get("id") != expected_id):
        raise DistributionError("Apple returned an unexpected resource identity.")
    return item


def unpaginated_items(document):
    items = document.get("data")
    if not isinstance(items, list) or document.get("links", {}).get("next"):
        raise DistributionError("Ambiguous or unexpectedly paginated Apple result; nothing changed.")
    if not all(isinstance(item, dict) for item in items):
        raise DistributionError("Apple returned invalid resource data.")
    return items


def related_id(item, relationship):
    data = item.get("relationships", {}).get(relationship, {}).get("data")
    return data.get("id") if isinstance(data, dict) else None


def has_group(api, build_id):
    document = api.request("GET", "/v1/betaGroups", params={
        "filter[app]": APP_ID, "filter[id]": GROUP_ID,
        "filter[builds]": build_id, "limit": 200,
    })
    return any(item.get("type") == "betaGroups" and item.get("id") == GROUP_ID
               for item in unpaginated_items(document))


def enable_internal_testflight(api):
    app = resource(api.request("GET", f"/v1/apps/{APP_ID}"), "apps", APP_ID)
    if app.get("attributes", {}).get("bundleId") != BUNDLE_ID:
        raise DistributionError("The app bundle does not match Wasla; nothing changed.")

    group = resource(api.request("GET", f"/v1/betaGroups/{GROUP_ID}",
                                 params={"include": "app"}), "betaGroups", GROUP_ID)
    group_attributes = group.get("attributes", {})
    if (group_attributes.get("name") != GROUP_NAME
            or group_attributes.get("isInternalGroup") is not True
            or related_id(group, "app") != APP_ID):
        raise DistributionError("The exact internal Wasla group could not be verified; nothing changed.")

    document = api.request("GET", "/v1/builds", params={
        "filter[app]": APP_ID, "filter[version]": BUILD_NUMBER,
        "filter[processingState]": "VALID",
        "include": "app,preReleaseVersion", "limit": 200,
    })
    included = {(item.get("type"), item.get("id")): item
                for item in document.get("included", []) if isinstance(item, dict)}
    matches = []
    for build in unpaginated_items(document):
        attributes = build.get("attributes", {})
        version = included.get(("preReleaseVersions", related_id(build, "preReleaseVersion")), {})
        version_attributes = version.get("attributes", {})
        if (build.get("type") == "builds" and related_id(build, "app") == APP_ID
                and attributes.get("version") == BUILD_NUMBER
                and attributes.get("processingState") == "VALID"
                and attributes.get("expired") is False
                and version_attributes.get("version") == VERSION
                and version_attributes.get("platform") == "IOS"):
            matches.append(build)
    if len(matches) != 1:
        raise DistributionError("Exactly one processed, unexpired Wasla 1.0 (5) is required; nothing changed.")
    build_id = matches[0].get("id", "")
    if not isinstance(build_id, str) or not build_id or not all(
            character.isascii() and (character.isalnum() or character == "-") for character in build_id):
        raise DistributionError("Apple returned an invalid build identifier.")
    if has_group(api, build_id):
        print("Wasla 1.0 (5) is already assigned to Wasla Internal. No change needed.")
        return

    api.request("POST", f"/v1/betaGroups/{GROUP_ID}/relationships/builds", body={
        "data": [{"type": "builds", "id": build_id}],
    })
    if not has_group(api, build_id):
        raise DistributionError("Apple accepted the association, but readback has not confirmed it. Rerun safely.")
    print("Confirmed: Wasla 1.0 (5) is assigned to Wasla Internal.")


def main():
    api = None
    try:
        api = AppleAPI()
        enable_internal_testflight(api)
        return 0
    except (DistributionError, SigningError) as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception:
        # Never print credentials, response bodies, or request headers on failures.
        print("Apple integration request failed. No upload or review submission was performed.", file=sys.stderr)
        return 1
    finally:
        if api is not None:
            api.close()


if __name__ == "__main__":
    raise SystemExit(main())
