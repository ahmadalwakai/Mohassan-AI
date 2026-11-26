#!/usr/bin/env python3
"""Inspect or enable Push Notifications for the existing iPhone App ID."""
from __future__ import annotations

import re
import sys

from apple_api import AppleAPI, AppleAPIError, DistributionError, list_resources
from prepare_signing import BUNDLE_ID, SigningError, certificate_team, installed_identities

PUSH_NOTIFICATIONS = "PUSH_NOTIFICATIONS"
CAPABILITIES_PATH = "/v1/bundleIdCapabilities"


def imported_certificate_team():
    # The check workflow imports one stored distribution identity into the build keychain.
    identities = installed_identities()
    if len(identities) != 1:
        raise SigningError("Expected one imported distribution identity in the build keychain.")
    return certificate_team(next(iter(identities.values())))


def exact_bundles(api):
    bundles = list_resources(api, "/v1/bundleIds", "bundleIds",
                             params={"filter[identifier]": BUNDLE_ID})
    return [bundle for bundle in bundles if bundle["attributes"].get("identifier") == BUNDLE_ID]


def capability_types(api, bundle_id):
    capabilities = list_resources(api, f"/v1/bundleIds/{bundle_id}/bundleIdCapabilities",
                                  "bundleIdCapabilities")
    types = set()
    for capability in capabilities:
        value = capability["attributes"].get("capabilityType")
        if not isinstance(value, str) or not re.fullmatch(r"[A-Z0-9_]{1,80}", value):
            raise DistributionError("Apple returned an invalid capability type.")
        types.add(value)
    return types


def print_capability_types(types):
    print("Capability types: " + (", ".join(sorted(types)) or "none"), flush=True)


def check_push_capability(api):
    bundles = exact_bundles(api)
    if len(bundles) != 1:
        print(f"Exactly one {BUNDLE_ID} for the integration key: no ({len(bundles)} found).", flush=True)
        return False
    bundle = bundles[0]
    platform = bundle["attributes"].get("platform")
    if not isinstance(platform, str) or not re.fullmatch(r"[A-Z0-9_]{1,80}", platform):
        raise DistributionError("Apple returned an invalid bundle platform.")
    print(f"Exactly one {BUNDLE_ID} for the integration key: yes. Platform: {platform}.", flush=True)
    print_capability_types(capability_types(api, bundle["id"]))
    return True


def enable_push_capability(api):
    bundles = exact_bundles(api)
    if len(bundles) != 1:
        raise DistributionError(f"Expected exactly one App ID {BUNDLE_ID} for the integration key.")
    bundle = bundles[0]
    if bundle["attributes"].get("platform") not in ("IOS", "UNIVERSAL"):
        raise DistributionError(f"The App ID {BUNDLE_ID} has an incompatible platform.")
    bundle_id = bundle["id"]
    types = capability_types(api, bundle_id)
    if PUSH_NOTIFICATIONS not in types:
        try:
            api.request("POST", CAPABILITIES_PATH, body={
                "data": {
                    "type": "bundleIdCapabilities",
                    "attributes": {"capabilityType": PUSH_NOTIFICATIONS},
                    "relationships": {"bundleId": {"data": {"type": "bundleIds", "id": bundle_id}}},
                },
            })
        except AppleAPIError as error:
            if error.status != 409:
                raise
            # A concurrent run may have enabled it. Read once and do not retry the POST.
        types = capability_types(api, bundle_id)
    print_capability_types(types)
    if PUSH_NOTIFICATIONS not in types:
        raise DistributionError(f"Read-back did not confirm Push Notifications for {BUNDLE_ID}.")


def main(argv=None):
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1 or args[0] not in ("check", "enable"):
        print("Usage: push_capability.py <check|enable>", file=sys.stderr)
        return 2
    check = args[0] == "check"
    api = None
    try:
        if check:
            print(f"Imported distribution certificate team: {imported_certificate_team()}", flush=True)
        api = AppleAPI()
        if check:
            return 0 if check_push_capability(api) else 1
        enable_push_capability(api)
        return 0
    except (DistributionError, SigningError) as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception:
        print("The Push Notifications workflow could not complete.", file=sys.stderr)
        return 1
    finally:
        if api is not None:
            api.close()


if __name__ == "__main__":
    raise SystemExit(main())
