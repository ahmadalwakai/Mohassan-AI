#!/usr/bin/env python3
"""Rename the App Store Connect app using the existing Codemagic integration."""
from __future__ import annotations

import json
import sys

from apple_api import (
    APP_ID,
    AppleAPI,
    AppleAPIError,
    DistributionError,
    list_resources,
    resource,
)
from prepare_signing import BUNDLE_ID, SigningError

APP_NAME = "Mohassan AI"
APP_INFORMATION = "App Store Connect > Apps > your app > Distribution > General > App Information"


def read_names(api, app_info_id):
    names = {}
    path = f"/v1/appInfos/{app_info_id}/appInfoLocalizations"
    for item in list_resources(api, path, "appInfoLocalizations"):
        attributes = item["attributes"]
        locale = attributes.get("locale")
        name = attributes.get("name")
        if not isinstance(locale, str) or not locale or (name is not None and not isinstance(name, str)):
            raise DistributionError(f"Apple returned an invalid localization. Check {APP_INFORMATION}.")
        print(json.dumps({"locale": locale, "name": name}, ensure_ascii=False), flush=True)
        names[item["id"]] = name
    return names


def rename_app_store_name(api):
    app = resource(api.request("GET", f"/v1/apps/{APP_ID}"), "apps", APP_ID)
    if app.get("attributes", {}).get("bundleId") != BUNDLE_ID:
        raise DistributionError("The App Store Connect app has a different bundle ID. No changes were made.")

    editable = []
    for info in list_resources(api, f"/v1/apps/{APP_ID}/appInfos", "appInfos"):
        names = read_names(api, info["id"])
        attributes = info["attributes"]
        state = attributes.get("state") or attributes.get("appStoreState")
        if state in ("PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW"):
            editable.append((info["id"], names))
    if not editable:
        raise DistributionError(
            f"No App Information record is editable. Change the name in {APP_INFORMATION} when editing is available."
        )
    if len(editable) > 1:
        raise DistributionError(
            f"Several App Information records are eligible for edits. Change the name in {APP_INFORMATION}."
        )

    app_info_id, names = editable[0]
    if not names:
        raise DistributionError(f"The editable App Information record has no localizations. Check {APP_INFORMATION}.")

    for localization_id, name in names.items():
        if name == APP_NAME:
            continue
        try:
            api.request("PATCH", f"/v1/appInfoLocalizations/{localization_id}", body={
                "data": {
                    "type": "appInfoLocalizations",
                    "id": localization_id,
                    "attributes": {"name": APP_NAME},
                },
            })
        except AppleAPIError as error:
            if any("DUPLICATE" in code.split(".") for code in error.codes):
                raise DistributionError(
                    f"Another app already uses the name {APP_NAME}. "
                    f"Resolve the conflict and change the name in {APP_INFORMATION}."
                ) from None
            raise DistributionError(f"{error} Change the name in {APP_INFORMATION}.") from None

    confirmed = read_names(api, app_info_id)
    if names.keys() - confirmed.keys() or any(name != APP_NAME for name in confirmed.values()):
        raise DistributionError(
            f"Read-back did not confirm {APP_NAME} for every localization. Check and change the name in {APP_INFORMATION}."
        )


def main():
    api = None
    try:
        api = AppleAPI()
        rename_app_store_name(api)
        return 0
    except (DistributionError, SigningError) as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception:
        print(f"The Apple integration request failed. Check {APP_INFORMATION}.", file=sys.stderr)
        return 1
    finally:
        if api is not None:
            api.close()


if __name__ == "__main__":
    raise SystemExit(main())
