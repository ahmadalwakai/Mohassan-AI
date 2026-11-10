#!/usr/bin/env python3
"""Associate only the already-uploaded Wasla 1.0 build (WASLA_BUILD_NUMBER, default 6) with Wasla Internal.

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
import re
import sys
import time

from prepare_signing import SigningError, prepare_integration_key

APP_ID = "6829577419"
BUNDLE_ID = "com.ahmadalwakai.wasla"
VERSION = "1.0"
# The build to enable; the Codemagic workflow passes it explicitly.
BUILD_NUMBER = os.environ.get("WASLA_BUILD_NUMBER", "6").strip()
if not re.fullmatch(r"[1-9][0-9]{0,3}", BUILD_NUMBER):
    raise SystemExit("WASLA_BUILD_NUMBER must be a positive build number.")
GROUP_ID = "892d8e1f-c4bf-4033-bac2-0ee41833f9aa"
GROUP_NAME = "Wasla Internal"
API_ORIGIN = "https://api.appstoreconnect.apple.com"
INTERNAL_STATES = {
    "PROCESSING", "PROCESSING_EXCEPTION", "MISSING_EXPORT_COMPLIANCE",
    "READY_FOR_BETA_TESTING", "IN_BETA_TESTING", "EXPIRED", "IN_EXPORT_COMPLIANCE_REVIEW",
}
DIAGNOSTIC_PARAMETERS = {
    "include", "limit", "filter[app]", "filter[id]", "filter[version]",
    "filter[processingState]", "filter[builds]",
}


class DistributionError(RuntimeError):
    """Only fixed, non-secret diagnostics are included in errors."""


def request_stage(method, path):
    stages = {
        ("GET", f"/v1/apps/{APP_ID}"): "verify-wasla-app",
        ("GET", f"/v1/betaGroups/{GROUP_ID}"): "verify-internal-group",
        ("GET", "/v1/builds"): "find-processed-build",
        ("GET", f"/v1/betaGroups/{GROUP_ID}/relationships/builds"): "read-group-build-membership",
        ("POST", f"/v1/betaGroups/{GROUP_ID}/relationships/builds"): "associate-build-with-internal-group",
    }
    if method == "GET" and re.fullmatch(r"/v1/builds/[A-Za-z0-9-]{1,128}/buildBetaDetail", path):
        return "verify-internal-testflight-state"
    if (method, path) not in stages:
        raise DistributionError("Unexpected Apple API request; no request sent.")
    return stages[(method, path)]


def safe_error_diagnostic(response):
    # Only known parameter names and short enum-like codes can leave this helper.
    # Apple error details, titles, URLs, headers, and response bodies never do.
    if len(response.content) > 64_000:
        return ""
    try:
        document = response.json()
    except ValueError:
        return ""
    errors = document.get("errors") if isinstance(document, dict) else None
    if not isinstance(errors, list):
        return ""
    diagnostics = []
    for error in errors[:3]:
        if not isinstance(error, dict):
            continue
        code = error.get("code")
        if isinstance(code, str) and re.fullmatch(r"[A-Z0-9_.-]{1,80}", code):
            diagnostics.append("code=" + code)
        source = error.get("source")
        parameter = source.get("parameter") if isinstance(source, dict) else None
        if isinstance(parameter, str) and parameter in DIAGNOSTIC_PARAMETERS:
            diagnostics.append("parameter=" + parameter)
    return (" " + "; ".join(diagnostics)) if diagnostics else ""


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
        print("Distribution stage: " + request_stage(method, path) + ".", flush=True)
        # No redirects or automatic request retries; normal certificate validation.
        response = self.session.request(
            method, API_ORIGIN + path, params=params, json=body,
            timeout=(10, 25), allow_redirects=False,
        )
        expected = 200 if method == "GET" else 204
        if response.status_code != expected:
            # Paths contain only fixed app/group IDs or the verified build ID.
            # Never include headers, tokens, request data, or raw response bodies.
            raise DistributionError(
                f"Apple API {method} {path} failed (HTTP {response.status_code})."
                + safe_error_diagnostic(response))
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
    document = api.request("GET", f"/v1/betaGroups/{GROUP_ID}/relationships/builds",
                           params={"limit": 200})
    return any(item.get("type") == "builds" and item.get("id") == build_id
               for item in unpaginated_items(document))


def report_internal_readiness(api, build_id):
    document = api.request("GET", f"/v1/builds/{build_id}/buildBetaDetail")
    detail = document.get("data")
    if not isinstance(detail, dict) or detail.get("type") != "buildBetaDetails":
        raise DistributionError("Apple returned invalid internal testing state data.")
    state = detail.get("attributes", {}).get("internalBuildState")
    if not isinstance(state, str) or state not in INTERNAL_STATES:
        raise DistributionError("Apple has not returned a recognized internal testing state.")
    print("Internal TestFlight state: " + state + ".", flush=True)
    if state == "IN_BETA_TESTING":
        print(f"Confirmed: Wasla {VERSION} ({BUILD_NUMBER}) is available to the existing Wasla Internal testers.", flush=True)
        return True
    print("The group association is confirmed, but Apple has not activated internal testing. "
          "Availability is pending; rerunning this workflow is safe.", flush=True)
    return False


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
        raise DistributionError(f"Exactly one processed, unexpired Wasla {VERSION} ({BUILD_NUMBER}) is required; nothing changed.")
    build_id = matches[0].get("id", "")
    if not isinstance(build_id, str) or not build_id or not all(
            character.isascii() and (character.isalnum() or character == "-") for character in build_id):
        raise DistributionError("Apple returned an invalid build identifier.")
    if has_group(api, build_id):
        print(f"Wasla {VERSION} ({BUILD_NUMBER}) is already assigned to Wasla Internal. No change needed.", flush=True)
        return report_internal_readiness(api, build_id)

    api.request("POST", f"/v1/betaGroups/{GROUP_ID}/relationships/builds", body={
        "data": [{"type": "builds", "id": build_id}],
    })
    if not has_group(api, build_id):
        raise DistributionError("Apple accepted the association, but readback has not confirmed it. Rerun safely.")
    print(f"Confirmed: Wasla {VERSION} ({BUILD_NUMBER}) is assigned to Wasla Internal.", flush=True)
    return report_internal_readiness(api, build_id)


def main():
    api = None
    try:
        api = AppleAPI()
        ready = enable_internal_testflight(api)
        # A pending state must not appear as a completed distribution workflow.
        return 0 if ready else 2
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
