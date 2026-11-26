"""App Store Connect transport shared by the manual Codemagic tools."""
from __future__ import annotations

from contextlib import nullcontext, redirect_stdout
from io import StringIO
import os
import re
import time
from urllib.parse import parse_qsl, urlsplit

from prepare_signing import prepare_integration_key

APP_ID = "6829577419"
API_ORIGIN = "https://api.appstoreconnect.apple.com"
DIAGNOSTIC_PARAMETERS = {
    "include", "limit", "filter[app]", "filter[id]", "filter[version]",
    "filter[processingState]", "filter[builds]",
}


class DistributionError(RuntimeError):
    """Only fixed, non-secret diagnostics are included in errors."""


class AppleAPIError(DistributionError):
    """An HTTP error with sanitized Apple error codes for callers to inspect."""

    def __init__(self, method, path, status, diagnostic="", codes=()):
        super().__init__(f"Apple API {method} {path} failed (HTTP {status})." + diagnostic)
        self.status = status
        self.codes = codes


def safe_error_diagnostic(response):
    # Only known parameter names and short enum-like codes can leave this helper.
    # Apple error details, titles, URLs, headers, and response bodies never do.
    if len(response.content) > 64_000:
        return "", ()
    try:
        document = response.json()
    except ValueError:
        return "", ()
    errors = document.get("errors") if isinstance(document, dict) else None
    if not isinstance(errors, list):
        return "", ()
    diagnostics = []
    codes = []
    for error in errors[:3]:
        if not isinstance(error, dict):
            continue
        code = error.get("code")
        if isinstance(code, str) and re.fullmatch(r"[A-Z0-9_.-]{1,80}", code):
            codes.append(code)
            diagnostics.append("code=" + code)
        source = error.get("source")
        parameter = source.get("parameter") if isinstance(source, dict) else None
        if isinstance(parameter, str) and parameter in DIAGNOSTIC_PARAMETERS:
            diagnostics.append("parameter=" + parameter)
    return (" " + "; ".join(diagnostics) if diagnostics else ""), tuple(codes)


class AppleAPI:
    def __init__(self, *, report_key_setup=False):
        # Both packages are dependencies of Codemagic's installed CLI tools.
        import jwt
        import requests

        output = nullcontext() if report_key_setup else redirect_stdout(StringIO())
        with output:
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

    def request(self, method, path, *, params=None, body=None, expected_status=None):
        statuses = {"GET": 200, "POST": 201, "PATCH": 200}
        if method not in statuses or not re.fullmatch(r"/v1/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+", path):
            raise DistributionError("Unexpected Apple API request.")
        # No redirects or automatic request retries; normal certificate validation.
        response = self.session.request(
            method, API_ORIGIN + path, params=params, json=body,
            timeout=(10, 25), allow_redirects=False,
        )
        expected = statuses[method] if expected_status is None else expected_status
        if response.status_code != expected:
            diagnostic, codes = safe_error_diagnostic(response)
            raise AppleAPIError(method, path, response.status_code, diagnostic, codes)
        if expected == 204:
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


def list_resources(api, path, expected_type, *, params=None):
    """Read a complete Apple collection, staying on the original API endpoint."""
    items = []
    seen_ids = set()
    seen_links = set()
    while True:
        document = api.request("GET", path, params=params)
        page = document.get("data")
        if not isinstance(page, list):
            raise DistributionError("Apple returned an invalid resource collection.")
        for item in page:
            item_id = item.get("id") if isinstance(item, dict) else None
            if (not isinstance(item_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", item_id)
                    or item.get("type") != expected_type or item_id in seen_ids
                    or not isinstance(item.get("attributes"), dict)):
                raise DistributionError("Apple returned an invalid or repeated resource.")
            seen_ids.add(item_id)
            items.append(item)

        links = document.get("links", {})
        if not isinstance(links, dict):
            raise DistributionError("Apple returned invalid pagination links.")
        next_link = links.get("next")
        if next_link is None:
            return items
        if not isinstance(next_link, str) or next_link in seen_links:
            raise DistributionError("Apple returned an invalid or repeated pagination link.")
        next_page = urlsplit(next_link)
        if (next_page.scheme != "https" or next_page.netloc != "api.appstoreconnect.apple.com"
                or next_page.path != path or next_page.fragment or not next_page.query):
            raise DistributionError("Apple returned an unexpected pagination endpoint.")
        seen_links.add(next_link)
        params = parse_qsl(next_page.query, keep_blank_values=True)
