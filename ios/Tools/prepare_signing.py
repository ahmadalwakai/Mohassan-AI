#!/usr/bin/env python3
"""Prepare only Wasla's App Store profile on a Codemagic macOS build machine.

Requires integrations.app_store_connect: Vibeset Codemagic and
environment.ios_signing.certificates: [vibeset_distribution]. Codemagic imports
that stored identity before this script. No certificate/private-key export,
new certificate, device registration, capability change, or publishing occurs.

Run: python3 ios/Tools/prepare_signing.py
Then: xcode-project use-profiles --project ios/Wasla.xcodeproj
      --profile "$CM_BUILD_DIR/build/signing/Wasla.mobileprovision"

Uses documented app-store-connect CLI commands and JSON resource output:
https://github.com/codemagic-ci-cd/cli-tools/tree/master/docs/app-store-connect
Only public certificate DER and provisioning profiles are read by this helper.
The CLI consumes the existing integration credentials via named environment
variables. Output is captured; failures expose only bounded, redacted error
lines plus fixed stage names and exit codes, never raw command arguments.
"""
from __future__ import annotations

import base64
import binascii
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile
from typing import Callable
import uuid

BUNDLE_ID = "com.ahmadalwakai.wasla"
PROFILE_TYPE = "IOS_APP_STORE"
CERTIFICATE_TYPES = {"DISTRIBUTION", "IOS_DISTRIBUTION"}
RESOURCE_ID = re.compile(r"[A-Za-z0-9-]{1,128}\Z")
MAX_OUTPUT = 16 * 1024 * 1024


class SigningError(RuntimeError):
    """Contains only safe stage information and a sanitized error excerpt."""


def command_stage(arguments: list[str]) -> tuple[str, str]:
    """Labels are constants: never copy resource IDs, paths, or option values."""
    executable = Path(arguments[0]).name if arguments else ""
    if executable == "app-store-connect":
        if arguments[1:] == ["--version"]:
            return "read-cli-version", "app-store-connect --version"
        if arguments[1:] == ["--help"]:
            return "read-cli-help", "app-store-connect --help"
        action = tuple(arguments[1:3])
        names = {
            ("certificates", "list"): "list-distribution-certificates",
            ("bundle-ids", "list"): "find-wasla-bundle",
            ("bundle-ids", "create"): "create-wasla-bundle",
            ("bundle-ids", "profiles"): "find-wasla-profiles",
            ("profiles", "get"): "read-wasla-profile",
            ("profiles", "create"): "create-wasla-profile",
        }
        if action in names:
            return names[action], "app-store-connect " + " ".join(action)
    if executable == "security" and len(arguments) > 1:
        names = {"default-keychain": "select-build-keychain", "find-identity": "read-signing-identities",
                 "find-certificate": "read-public-certificates", "cms": "decode-public-profile"}
        if arguments[1] in names:
            return names[arguments[1]], "security " + arguments[1]
    if executable == "openssl" and arguments[1:2] == ["x509"]:
        return "read-certificate-team", "openssl x509"
    return "signing-tool", "signing tool"


def safe_error_excerpt(raw: bytes, environment=None) -> str:
    """Redact before selecting/truncating lines, including multiline key values."""
    if len(raw) > MAX_OUTPUT:
        return "Error output exceeded the diagnostic limit and was withheld."
    text = raw.decode("utf-8", errors="replace")
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    environment = os.environ if environment is None else environment
    values = {value for key, value in environment.items()
              if key.startswith("APP_STORE_CONNECT_") and isinstance(value, str) and value}
    for value in sorted(values, key=len, reverse=True):
        # CLI errors may JSON-escape a multiline value. Also redact individual
        # PEM body lines, so even a partial parser echo cannot reveal key bytes.
        variants = {value, json.dumps(value)[1:-1], *value.splitlines()}
        for variant in sorted((item for item in variants if item), key=len, reverse=True):
            text = text.replace(variant, "[REDACTED]")
    text = re.sub(r"-----BEGIN [A-Z0-9 ]+-----.*?-----END [A-Z0-9 ]+-----", "[REDACTED PEM]", text, flags=re.S)
    text = re.sub(r"-----BEGIN [A-Z0-9 ]+-----.*", "[REDACTED PEM]", text, flags=re.S)
    text = re.sub(r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])",
                  "[REDACTED JWT]", text)
    text = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]", text)
    text = re.sub(r"[A-Za-z0-9+/=_-]{80,}", "[REDACTED DATA]", text)
    text = "".join(char for char in text if char in "\n\t" or ord(char) >= 32)
    # Only parser/API error lines; never include successful resource JSON or
    # arbitrary output. At most six short lines / 1,600 characters survive.
    error_line = re.compile(r"(?i)(\berror\b|\bfailed\b|\bfailure\b|\bunauthorized\b|\bforbidden\b|"
                            r"\bpermission\b|\binvalid\b|\bunrecognized\b|\bdenied\b|\bunable\b|"
                            r"\bnot found\b|\bcould not\b|^usage:|^\s*[\"']?(code|title|detail|status)[\"']?\s*:)")
    lines = [line.strip()[:400] for line in text.splitlines() if error_line.search(line)]
    return "\n".join(lines[:6])[:1600]


def run(arguments: list[str], *, input_data: bytes | None = None) -> bytes:
    stage, action = command_stage(arguments)
    print(f"Signing stage: {stage}.", flush=True)
    try:
        result = subprocess.run(arguments, input=input_data, capture_output=True,
                                check=False, timeout=120)
    except subprocess.TimeoutExpired:
        raise SigningError(f"Stage {stage} ({action}) timed out after 120 seconds.") from None
    except OSError:
        raise SigningError(f"Stage {stage} could not launch {action}.") from None
    if result.returncode != 0:
        detail = safe_error_excerpt(result.stderr)
        suffix = f"\n{detail}" if detail else " No safe parser/API error text was available."
        raise SigningError(f"Stage {stage} ({action}) exited with code {result.returncode}.{suffix}")
    if len(result.stdout) > MAX_OUTPUT or len(result.stderr) > MAX_OUTPUT:
        raise SigningError("The signing command returned an unexpected amount of data.")
    return result.stdout


def resource_id(resource: dict, kind: str) -> str:
    value = resource.get("id")
    if resource.get("type") != kind or not isinstance(value, str) or not RESOURCE_ID.fullmatch(value):
        raise SigningError("The signing API returned an invalid resource.")
    if not isinstance(resource.get("attributes"), dict):
        raise SigningError("The signing API omitted resource attributes.")
    return value


def report_cli_version(runner: Callable = run) -> None:
    """Version/help do not initialize API credentials or make API requests."""
    try:
        raw = runner(["app-store-connect", "--version"])
        match = re.search(rb"^app-store-connect\s+([0-9][A-Za-z0-9.+-]{0,79})\s*$", raw, re.M)
        if match:
            print("Signing CLI version: " + match.group(1).decode("ascii"), flush=True)
            return
    except SigningError as error:
        print(f"Signing CLI version unavailable: {error}", flush=True)
    try:
        raw = runner(["app-store-connect", "--help"])
        header = next((line for line in safe_error_excerpt(raw).splitlines()
                       if line.lower().startswith("usage:")), "")
        if header:
            print("Signing CLI help: " + header[:400], flush=True)
        else:
            print("Signing CLI version/help header unavailable.", flush=True)
    except SigningError as error:
        print(f"Signing CLI help unavailable: {error}", flush=True)


def resources(raw: bytes, kind: str) -> list[dict]:
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeError):
        raise SigningError("The signing CLI did not return valid JSON.") from None
    # Codemagic emits an object for create/get and an array for list.
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list) or len(data) > 1000:
        raise SigningError("The signing API returned an unexpected resource collection.")
    for item in data:
        if not isinstance(item, dict):
            raise SigningError("The signing API returned an invalid resource.")
        resource_id(item, kind)
    return data


class AppleCLI:
    def __init__(self, runner: Callable = run):
        self.runner = runner

    def call(self, kind: str, *arguments: str) -> list[dict]:
        # No implicit key-file search, JWT cache, HTTP logs, or POST retries.
        # Codemagic registers these options on the leaf action, not the root
        # parser. Its retry counts include the initial attempt: 1 means no retry;
        # 0 is rejected by Types.ApiServerErrorRetries/ApiUnauthorizedRetries.
        command = ["app-store-connect", *arguments, "--no-color", "--json", "--disable-jwt-cache",
                   "--api-server-error-retries", "1", "--api-unauthorized-retries", "1",
                   "--issuer-id", "@env:APP_STORE_CONNECT_ISSUER_ID",
                   "--key-id", "@env:APP_STORE_CONNECT_KEY_IDENTIFIER",
                   "--private-key", "@env:APP_STORE_CONNECT_PRIVATE_KEY"]
        raw = self.runner(command)
        try:
            return resources(raw, kind)
        except SigningError as error:
            stage, action = command_stage(command)
            raise SigningError(f"Stage {stage} ({action}): {error}") from None


def binary_content(value, label: str) -> bytes:
    if not isinstance(value, str) or not value or len(value) > MAX_OUTPUT:
        raise SigningError(f"The signing API omitted {label}.")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise SigningError(f"The signing API returned invalid {label}.") from None
    if not decoded:
        raise SigningError(f"The signing API returned empty {label}.")
    return decoded


def utc_date(value) -> datetime:
    try:
        if isinstance(value, str):
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if not isinstance(value, datetime):
            raise ValueError()
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    except (ValueError, TypeError):
        raise SigningError("The signing API returned an invalid expiration date.") from None


def public_identities(identity_output: bytes, pem_output: bytes) -> dict[str, bytes]:
    """SHA-256 DER fingerprints of valid code-signing identities in one keychain."""
    try:
        identities = identity_output.decode("utf-8")
    except UnicodeError:
        raise SigningError("The build keychain returned invalid identity metadata.") from None
    sha1s = set(re.findall(r'^\s*\d+\)\s+([A-Fa-f0-9]{40})\s+"', identities, re.M))
    sha1s = {value.lower() for value in sha1s}
    result = {}
    for pem in re.findall(br"-----BEGIN CERTIFICATE-----\s*(.*?)\s*-----END CERTIFICATE-----", pem_output, re.S):
        try:
            der = base64.b64decode(re.sub(br"\s+", b"", pem), validate=True)
        except (ValueError, binascii.Error):
            raise SigningError("The build keychain returned an invalid public certificate.") from None
        if hashlib.sha1(der).hexdigest() in sha1s:
            result[hashlib.sha256(der).hexdigest()] = der
    if not result:
        raise SigningError("No valid signing identity is installed in the build keychain.")
    return result


def installed_identities(runner: Callable = run) -> dict[str, bytes]:
    keychain = runner(["/usr/bin/security", "default-keychain", "-d", "user"]).decode("utf-8").strip()
    if len(keychain) >= 2 and keychain[0] == keychain[-1] == '"':
        keychain = keychain[1:-1]
    if not Path(keychain).is_absolute() or "\n" in keychain or "\x00" in keychain:
        raise SigningError("The build did not select a valid signing keychain.")
    # find-certificate -p exports public certificate bytes only. No key export.
    identities = runner(["/usr/bin/security", "find-identity", "-v", "-p", "codesigning", keychain])
    certificates = runner(["/usr/bin/security", "find-certificate", "-a", "-p", keychain])
    return public_identities(identities, certificates)


def select_certificate(certificates: list[dict], installed: dict[str, bytes], now: datetime) -> tuple[dict, bytes]:
    matches = []
    for certificate in certificates:
        resource_id(certificate, "certificates")
        attrs = certificate["attributes"]
        # Apple Distribution is cross-platform; Apple may omit its platform.
        if attrs.get("certificateType") not in CERTIFICATE_TYPES or attrs.get("platform") not in (None, "IOS", "UNIVERSAL"):
            continue
        if utc_date(attrs.get("expirationDate")) <= now:
            continue
        der = binary_content(attrs.get("certificateContent"), "public certificate")
        digest = hashlib.sha256(der).hexdigest()
        if digest in installed and der == installed[digest]:
            matches.append((certificate, der))
    if len(matches) != 1:
        raise SigningError("Expected exactly one active iOS distribution certificate matching the imported identity; none or several matched.")
    return matches[0]


def certificate_team(der: bytes, runner: Callable = run) -> str:
    # OpenSSL reads public DER from stdin. No .p12 or private key is opened.
    subject = runner(["/usr/bin/openssl", "x509", "-inform", "DER", "-noout", "-subject",
                      "-nameopt", "RFC2253"], input_data=der).decode("utf-8")
    matches = re.findall(r"(?:^|[,=])OU=([A-Z0-9]{10})(?:,|$)", subject.strip())
    # RFC2253 starts with 'subject=' followed by the first RDN.
    if not matches:
        matches = re.findall(r"(?:^|,)OU=([A-Z0-9]{10})(?:,|$)", subject.removeprefix("subject=").strip())
    if len(matches) != 1:
        raise SigningError("The imported certificate has no unique Apple team identifier.")
    return matches[0]


def select_bundle(bundles: list[dict]) -> dict | None:
    matches = []
    for bundle in bundles:
        resource_id(bundle, "bundleIds")
        attrs = bundle["attributes"]
        if attrs.get("identifier") == BUNDLE_ID:
            if attrs.get("platform") not in ("IOS", "UNIVERSAL"):
                raise SigningError("Wasla's existing bundle has an incompatible platform.")
            matches.append(bundle)
    if len(matches) > 1:
        raise SigningError("The signing API returned several exact Wasla bundle identifiers.")
    return matches[0] if matches else None


def ensure_bundle(api: AppleCLI) -> dict:
    def lookup():
        return select_bundle(api.call("bundleIds", "bundle-ids", "list", "--bundle-id-identifier",
                                      BUNDLE_ID, "--strict-match-identifier"))
    existing = lookup()
    if existing:
        return existing
    try:
        created = select_bundle(api.call("bundleIds", "bundle-ids", "create", BUNDLE_ID,
                                         "--name", "Wasla", "--platform", "IOS"))
        if created is None:
            raise SigningError("The signing API did not return the Wasla bundle after creation.")
        return created
    except SigningError as failure:
        # A timeout/concurrent build may have created it: read once, never repeat POST.
        recovered = lookup()
        if recovered:
            return recovered
        raise SigningError(f"Wasla bundle creation was not confirmed. No creation retry was attempted. {failure}") from None


def decode_profile(content: bytes, runner: Callable = run) -> dict:
    with tempfile.TemporaryDirectory(prefix="wasla-profile-") as directory:
        source = Path(directory) / "public.mobileprovision"
        source.write_bytes(content)
        raw = runner(["/usr/bin/security", "cms", "-D", "-i", str(source)])
    try:
        profile = plistlib.loads(raw)
    except (ValueError, plistlib.InvalidFileException):
        raise SigningError("The provisioning profile is not a valid Apple property list.") from None
    if not isinstance(profile, dict):
        raise SigningError("The provisioning profile is not a dictionary.")
    return profile


def matches_profile(profile: dict, resource: dict, der: bytes, team: str, now: datetime) -> bool:
    """Validate decoded content, not just an API profile name/relationship."""
    attrs = resource["attributes"]
    if attrs.get("profileState") != "ACTIVE" or attrs.get("profileType") != PROFILE_TYPE:
        return False
    if utc_date(attrs.get("expirationDate")) <= now or utc_date(profile.get("ExpirationDate")) <= now:
        return False
    if profile.get("UUID") != attrs.get("uuid") or profile.get("TeamIdentifier") != [team]:
        return False
    entitlements = profile.get("Entitlements")
    if not isinstance(entitlements, dict):
        return False
    prefixes = profile.get("ApplicationIdentifierPrefix")
    if not isinstance(prefixes, list) or len(prefixes) != 1 or not isinstance(prefixes[0], str):
        return False
    if not re.fullmatch(r"[A-Z0-9]{10}", prefixes[0]):
        return False
    if entitlements.get("application-identifier") != f"{prefixes[0]}.{BUNDLE_ID}":
        return False
    if entitlements.get("com.apple.developer.team-identifier") != team:
        return False
    if entitlements.get("get-task-allow", False) is not False or profile.get("ProvisionsAllDevices", False) is not False:
        return False
    if "ProvisionedDevices" in profile or "iOS" not in profile.get("Platform", []):
        return False
    certificates = profile.get("DeveloperCertificates")
    # App Store profiles must be bound to the one selected certificate.
    if not isinstance(certificates, list) or len(certificates) != 1 or not isinstance(certificates[0], bytes):
        return False
    return hashlib.sha256(certificates[0]).digest() == hashlib.sha256(der).digest() and certificates[0] == der


def ensure_profile(api: AppleCLI, bundle: dict, certificate: dict, der: bytes,
                   team: str, now: datetime, decoder: Callable = decode_profile) -> tuple[dict, bytes, bool]:
    bundle_id = resource_id(bundle, "bundleIds")
    certificate_id = resource_id(certificate, "certificates")

    def matching():
        profiles = api.call("profiles", "bundle-ids", "profiles", "--bundle-ids", bundle_id,
                            "--type", PROFILE_TYPE, "--state", "ACTIVE")
        found = []
        for resource in profiles:
            attrs = resource["attributes"]
            if attrs.get("profileType") != PROFILE_TYPE or attrs.get("profileState") != "ACTIVE":
                continue
            if utc_date(attrs.get("expirationDate")) <= now:
                continue
            if not attrs.get("profileContent"):
                items = api.call("profiles", "profiles", "get", resource_id(resource, "profiles"))
                if len(items) != 1:
                    raise SigningError("The profile lookup returned an unexpected result.")
                resource = items[0]
            content = binary_content(resource["attributes"].get("profileContent"), "provisioning profile")
            if matches_profile(decoder(content), resource, der, team, now):
                found.append((resource, content))
        # Deterministically reuse the longest-lived matching profile.
        found.sort(key=lambda item: (utc_date(item[0]["attributes"]["expirationDate"]), item[0]["id"]), reverse=True)
        return found[0] if found else None

    existing = matching()
    if existing:
        return *existing, False
    profile_name = "Wasla App Store " + hashlib.sha256(der).hexdigest()[:16]
    try:
        created = api.call("profiles", "profiles", "create", bundle_id, "--certificate-ids", certificate_id,
                           "--type", PROFILE_TYPE, "--name", profile_name)
        if len(created) != 1:
            raise SigningError("The signing API did not return exactly one created profile.")
        resource = created[0]
        content = binary_content(resource["attributes"].get("profileContent"), "provisioning profile")
        if not matches_profile(decoder(content), resource, der, team, now):
            raise SigningError("The created profile did not match Wasla and its imported certificate.")
        return resource, content, True
    except SigningError as failure:
        recovered = matching()
        if recovered:
            return *recovered, False
        raise SigningError(f"Wasla profile creation was not confirmed. No creation retry was attempted. {failure}") from None


def save_profile(resource: dict, content: bytes, directory: Path) -> Path:
    try:
        profile_uuid = str(uuid.UUID(resource["attributes"]["uuid"]))
    except (ValueError, KeyError, TypeError, AttributeError):
        raise SigningError("The signing API returned an invalid profile UUID.") from None
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / f"{profile_uuid}.mobileprovision"
    return save_profile_file(destination, content)


def save_build_profile(content: bytes, build_directory: Path) -> Path:
    root = build_directory.resolve(strict=True)
    destination = root / "build/signing/Wasla.mobileprovision"
    if not destination.resolve().is_relative_to(root):
        raise SigningError("The Wasla profile output must remain inside this build directory.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    return save_profile_file(destination, content)


def save_profile_file(destination: Path, content: bytes) -> Path:
    if destination.exists() and destination.read_bytes() == content:
        return destination
    descriptor, temporary = tempfile.mkstemp(prefix=".wasla-", dir=destination.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return destination


def main() -> int:
    if sys.platform != "darwin" or not os.environ.get("CM_BUILD_DIR"):
        raise SigningError("Run this helper only inside a Codemagic macOS build.")
    required = ("APP_STORE_CONNECT_ISSUER_ID", "APP_STORE_CONNECT_KEY_IDENTIFIER", "APP_STORE_CONNECT_PRIVATE_KEY")
    if not all(os.environ.get(name) for name in required):
        raise SigningError("The Vibeset Codemagic App Store Connect integration is missing.")
    now = datetime.now(timezone.utc)
    api = AppleCLI()
    report_cli_version()
    installed = installed_identities()
    certificate, der = select_certificate(api.call("certificates", "certificates", "list",
                                                   "--profile-type", PROFILE_TYPE), installed, now)
    team = certificate_team(der)
    bundle = ensure_bundle(api)
    profile, content, created = ensure_profile(api, bundle, certificate, der, team, now)
    save_profile(profile, content, Path.home() / "Library/MobileDevice/Provisioning Profiles")
    # Both copies come exclusively from ensure_profile's validated Wasla result.
    # This exact path lets use-profiles exclude the bootstrap profile entirely.
    save_build_profile(content, Path(os.environ["CM_BUILD_DIR"]))
    print(f"Wasla App Store signing profile ready ({'created' if created else 'reused'}).")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SigningError as error:
        print(f"Signing preparation stopped: {error}", file=sys.stderr)
        raise SystemExit(1)
