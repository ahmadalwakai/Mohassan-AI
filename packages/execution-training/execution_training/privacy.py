"""Conservative local screening. A clean scan is not proof of anonymization."""
from __future__ import annotations

from dataclasses import dataclass
import fnmatch
import re
from typing import Any

from .common import digest
from .schemas import TrainingExample

SECRET_PATTERNS = (
    ("private_key", r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    ("provider_token", r"\b(?:gsk_|npg_|sk-(?:proj-)?|ghp_|github_pat_|xox[baprs]-|AIza)[A-Za-z0-9_-]{12,}"),
    ("aws_access_key", r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    ("jwt", r"\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
    ("bearer_token", r"\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*"),
    ("credential_url", r"[a-z][a-z0-9+.-]*://[^\s/@:]+:[^\s/@]+@"),
    ("assigned_secret", r"\b(?:password|passwd|secret|api[_ -]?key|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token)\s*[\"']?\s*[:=]\s*[\"']?[^\s,\"';]{4,}"),
)
SENSITIVE_PATTERNS = (
    ("email_address", r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    # Word boundaries prevent matching digit runs embedded in typed SHA-256/ID
    # tokens, while still flagging standalone or space/hyphen-separated numbers.
    ("long_digit_sequence", r"(?<!\w)(?:\d[ -]?){12,19}(?!\w)"),
    ("ip_address", r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
    ("redacted_source", r"\[(?:REDACTED|[^\]]*محجوب)[^\]]*\]"),
)
SENSITIVE_FIELDS = frozenset({"email", "email_address", "phone", "phone_number", "full_name", "first_name", "last_name",
    "customer", "customer_id", "customer_record", "home_address", "street_address", "date_of_birth", "ssn", "national_id",
    "credit_card", "card_number", "medical_record", "ip_address"})
SECRET_FIELDS = frozenset({"password", "passwd", "secret", "api_key", "apikey", "access_token", "refresh_token", "client_secret",
    "private_key", "authorization", "cookie", "session_token"})


@dataclass(frozen=True)
class PrivacyFinding:
    rule_id: str
    field_path_hash: str
    severity: str  # exclude or review; deliberately no match text or raw path


@dataclass(frozen=True)
class PrivacyApproval:
    """Approval is supplied by a trusted local operator, scoped to unchanged data."""
    subject_sha256: str
    approved_rule_ids: tuple[str, ...]
    reference: str
    reviewer_id: str


@dataclass(frozen=True)
class PrivacyPolicy:
    excluded_source_globs: tuple[str, ...] = ("*.env", "*.env.*", "*/.env", "*/.env.*", "*production*dump*", "*customer*dump*")
    excluded_field_globs: tuple[str, ...] = ()
    additional_secret_patterns: tuple[tuple[str, str], ...] = ()
    additional_review_patterns: tuple[tuple[str, str], ...] = ()
    approvals: tuple[PrivacyApproval, ...] = ()
    maximum_sample_characters: int = 2_000_000

    def __post_init__(self) -> None:
        if type(self.maximum_sample_characters) is not int or self.maximum_sample_characters < 1:
            raise ValueError("maximum_sample_characters must be positive")
        for _, pattern in self.additional_secret_patterns + self.additional_review_patterns:
            re.compile(pattern)
        for approval in self.approvals:
            if not approval.reference.strip() or not approval.reviewer_id.strip():
                raise ValueError("Privacy approval requires a reference and reviewer")

    def identity(self) -> str:
        from dataclasses import asdict
        return digest(asdict(self))


@dataclass(frozen=True)
class PrivacyDecision:
    status: str
    findings: tuple[PrivacyFinding, ...]
    approval_references: tuple[str, ...] = ()


def inspect_privacy(example: TrainingExample, policy: PrivacyPolicy | None = None) -> PrivacyDecision:
    policy = policy or PrivacyPolicy()
    findings: list[PrivacyFinding] = []
    size = 0
    secret_patterns = tuple((name, re.compile(pattern, re.IGNORECASE)) for name, pattern in SECRET_PATTERNS + policy.additional_secret_patterns)
    review_patterns = tuple((name, re.compile(pattern, re.IGNORECASE)) for name, pattern in SENSITIVE_PATTERNS + policy.additional_review_patterns)

    def finding(rule: str, path: str, severity: str) -> None:
        findings.append(PrivacyFinding(rule, digest(path), severity))

    def visit(value: Any, path: str, *, count_size: bool = True) -> None:
        nonlocal size
        if isinstance(value, dict):
            for key, child in value.items():
                child_path = f"{path}.{key}"
                normalized = re.sub(r"[^a-z0-9]+", "_", key.lower()).strip("_")
                if normalized in SECRET_FIELDS and child_path != "sample.authorization":
                    finding("secret_field", child_path, "exclude")
                elif normalized in SENSITIVE_FIELDS:
                    finding("sensitive_field", child_path, "review")
                if any(fnmatch.fnmatchcase(child_path, rule) for rule in policy.excluded_field_globs):
                    finding("configured_field_exclusion", child_path, "exclude")
                visit(key, child_path + ".key", count_size=count_size)
                visit(child, child_path, count_size=count_size)
        elif isinstance(value, (tuple, list)):
            for index, child in enumerate(value):
                visit(child, f"{path}[{index}]", count_size=count_size)
        elif isinstance(value, str):
            if count_size:
                size += len(value)
            if size > policy.maximum_sample_characters:
                return
            for rule, pattern in secret_patterns:
                if pattern.search(value):
                    finding(rule, path, "exclude")
            for rule, pattern in review_patterns:
                if pattern.search(value):
                    finding(rule, path, "review")

    # Scan payload and metadata: credentials sometimes arrive in evidence/source URLs.
    visit(example.to_dict(), "sample")
    if example.output_contract["format"] == "json":
        # Decode field names too: serialized JSON may quote or Unicode-escape a
        # sensitive key, including keys admitted by additionalProperties. Use a
        # local import to keep module initialization free of circular imports.
        from .validation import parse_json
        try:
            parsed_target = parse_json(example.expected_output)
            visit(parsed_target, "sample.expected_output.json", count_size=False)
        except (ValueError, TypeError, RecursionError):
            finding("invalid_json_target", "sample.expected_output", "exclude")
    if size > policy.maximum_sample_characters:
        finding("sample_size_limit", "sample", "exclude")
    origins = (example.provenance.origin.lower().replace("\\", "/"), example.source.source_id.lower())
    if any(fnmatch.fnmatchcase(origin, rule.lower()) for origin in origins for rule in policy.excluded_source_globs):
        finding("configured_source_exclusion", "source", "exclude")
    if example.authorization.privacy_classification == "uncertain":
        finding("uncertain_classification", "authorization", "review")
    if example.source.contains_customer_data or example.authorization.privacy_classification == "private_customer":
        finding("customer_data", "source", "exclude")
    findings = list(dict.fromkeys(findings))
    if any(item.severity == "exclude" for item in findings):
        return PrivacyDecision("rejected", tuple(findings))
    review_rules = {item.rule_id for item in findings}
    approvals = tuple(approval for approval in policy.approvals if approval.subject_sha256 == example.verification_hash
        and approval.reference == example.authorization.privacy_approval_reference)
    approved_rules = {rule for approval in approvals for rule in approval.approved_rule_ids}
    if review_rules - approved_rules:
        return PrivacyDecision("quarantined", tuple(findings))
    return PrivacyDecision("accepted", tuple(findings), tuple(approval.reference for approval in approvals))
