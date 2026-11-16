"""Keep English business pages (home or one-level landing pages) from Common Crawl WET files, as text only.

    python -I scripts/ads-training/extract_cc.py OUT_DIR WET_FILE [WET_FILE ...]

Common Crawl's terms: the content belongs to each site's owner, and personal data may not be
harvested. So email addresses and phone numbers are removed before anything is written, only
one page per site is kept, and the output stays under artifacts/ (git-ignored), never republished.
Reads data only: nothing in the files is executed.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

HOME_PATHS = {"", "/", "/index.html", "/index.htm", "/index.php", "/home", "/home/", "/en", "/en/", "/en-gb/", "/en-us/"}
# Platforms and reference sites are not one business's own website.
SKIP_HOSTS = re.compile(r"(^|\.)(wikipedia|wikimedia|blogspot|wordpress\.com|tumblr|medium|github|substack|wixsite|weebly|reddit|facebook|"
                        r"twitter|x\.com|youtube|linkedin|instagram|pinterest|amazon|ebay|etsy\.com|yelp|tripadvisor|gov|edu|ac\.uk|nhs\.uk|"
                        r"bbc|news|forum|wiki)\b", re.I)
SIGNALS = {
    "contact": r"\bcontact( us)?\b", "call": r"\bcall (us|now|today)\b", "quote": r"\b(free )?(quote|estimate)s?\b",
    "book": r"\bbook (now|online|an? \w+)\b|\bappointments?\b", "services": r"\bour services\b|\bservices\b", "about": r"\babout us\b",
    "touch": r"\bget in touch\b", "hours": r"\bopening (hours|times)\b|\bopen (daily|7 days|monday)\b", "shop": r"\bshop (now|online)\b|\badd to (cart|basket)\b",
    "delivery": r"\b(free )?delivery\b", "experience": r"\b\d+\+? years'? (of )?experience\b", "family": r"\bfamily[- ](run|owned)\b",
    "insured": r"\b(fully )?(insured|licensed|accredited|certified)\b", "enquire": r"\benquir(y|ies|e)\b|\binquir(y|ies|e)\b",
    "customers": r"\b(our )?(customers|clients)\b", "local": r"\b(serving|based in|covering)\b", "price": r"\b(prices?|pricing|from [£$€]\d+)\b",
    "team": r"\bour team\b|\bmeet the team\b",
}
SIGNAL_PATTERNS = {name: re.compile(pattern, re.I) for name, pattern in SIGNALS.items()}
# Restricted or unsafe advertising categories are not good training examples.
BLOCKED = re.compile(r"\b(porn|xxx|escort|casino|betting|gambl\w*|slots?|poker|viagra|cialis|cbd|vape|cannabis|crypto\w*|bitcoin|forex|"
                     r"payday|loans?|sex|nude|adult|onlyfans|replica|hookup|dating)\b", re.I)
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")
# Digit boundaries, not word boundaries: pages often glue a number to the next word ("347-6861Request").
PHONE = re.compile(r"(?<!\d)(\+?\d[\d ()./-]{7,}\d)(?!\d)")
MIN_CHARS, MAX_CHARS, MIN_SIGNALS = 400, 15000, 3
# A one-level page ("/plumber-in-north-york/") is often the landing page an ad points to,
# so it is kept with a stricter business test. News, blog and dated article slugs are not.
INNER_MIN_SIGNALS = 4
ARTICLE = re.compile(r"news|blog|article|post|tag|categor|event|report|review|press|story|forum|\d{4}", re.I)
# Slug words that read like a headline ("deck-staining-tips", "new-to-selling-albums-get-started").
QUESTION_WORDS = {"how", "why", "what", "when", "where", "tips", "guide", "ideas", "ways", "vs", "should", "can", "does", "things", "reasons"}
TITLE_WORDS = {"the", "your", "you", "to", "of", "is", "are", "a", "an", "my", "our", "it", "this", "adds", "announces", "names"}
NOT_LANDING = re.compile(r"sitemap|privacy|terms|cookie|career|job|login|account|cart|checkout|search|feed|wp-|cdn-cgi|disclaimer|faq|"
                         r"accessibility|shipping|returns|dashboard|portal|byprice|page\d", re.I)
NON_LATIN = re.compile(r"[^\x00-ɏ -⁯₠-⃏]")


def article_slug(slug: str) -> bool:
    words = [word for word in re.split(r"[-_.]+", slug.lower()) if word and word not in {"html", "htm", "php", "aspx"}]
    return (bool(ARTICLE.search(slug)) or len(words) > 7 or any(word in QUESTION_WORDS for word in words)
            or (len(words) >= 4 and any(word in TITLE_WORDS for word in words)))


def records(path: Path):
    """Yields (headers, text) for each conversion record of a WET file."""
    with gzip.open(path, "rb") as stream:
        headers: dict[str, str] = {}
        for raw in stream:
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if line == "WARC/1.0":
                headers = {}
                continue
            if not line:
                if "Content-Length" in headers:
                    body = stream.read(int(headers["Content-Length"]))
                    if headers.get("WARC-Type") == "conversion":
                        yield headers, body.decode("utf-8", "replace")
                    headers = {}
                continue
            if ":" in line and "Content-Length" not in headers:
                key, _, value = line.partition(":")
                headers[key.strip()] = value.strip()


def clean(text: str) -> str:
    text = EMAIL.sub(" ", text.replace(" ", " "))
    text = PHONE.sub(lambda match: " " if sum(ch.isdigit() for ch in match.group(1)) >= 9 else match.group(0), text)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line)


def judge(headers: dict[str, str], text: str) -> tuple[str, dict | None]:
    """Returns (reason, row); row is None when the page is rejected."""
    if not headers.get("WARC-Identified-Content-Language", "").startswith("eng"):
        return "not_english", None
    url = urlsplit(headers.get("WARC-Target-URI", ""))
    host = (url.hostname or "").lower().removeprefix("www.")
    segments = [segment for segment in url.path.split("/") if segment]
    kind = "home" if url.path in HOME_PATHS else "inner" if len(segments) == 1 else None
    if kind is None or url.query:
        return "not_home_or_landing_page", None
    if kind == "inner" and NOT_LANDING.search(segments[0]):
        return "utility_page", None
    if kind == "inner" and article_slug(segments[0]):
        return "article_page", None
    if not host or SKIP_HOSTS.search(host):
        return "platform_or_reference", None
    if BLOCKED.search(text):
        return "restricted_category", None
    body = clean(text)
    if not MIN_CHARS <= len(body) <= MAX_CHARS:
        return "length", None
    signals = sorted(name for name, pattern in SIGNAL_PATTERNS.items() if pattern.search(body))
    if len(signals) < (MIN_SIGNALS if kind == "home" else INNER_MIN_SIGNALS):
        return "not_business", None
    title = body.split("\n", 1)[0][:200]
    # The language tag is page-wide; a non-Latin title or body share means a mixed-language site.
    if NON_LATIN.search(title) or len(NON_LATIN.findall(body)) > len(body) * 0.02:
        return "mixed_language", None
    return "kept", {"url": headers["WARC-Target-URI"], "host": host, "title": title, "text": body, "page": kind, "signals": signals,
                    "crawl_date": headers.get("WARC-Date"), "language": headers.get("WARC-Identified-Content-Language")}


def main(out_dir: Path, files: list[Path]) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    reasons: Counter[str] = Counter()
    seen_hosts: set[str] = set()
    kept = 0
    with open(out_dir / "sites.jsonl", "w", encoding="utf-8") as output:
        for path in files:
            for headers, text in records(path):
                reason, row = judge(headers, text)
                if row and row["host"] in seen_hosts:
                    reason, row = "duplicate_host", None
                reasons[reason] += 1
                if row:
                    seen_hosts.add(row["host"])
                    output.write(json.dumps(row, ensure_ascii=False) + "\n")
                    kept += 1
    manifest = {
        "files": [{"name": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "bytes": path.stat().st_size} for path in files],
        "pages": sum(reasons.values()), "kept": kept, "reasons": dict(reasons.most_common()),
        "rules": {"min_chars": MIN_CHARS, "max_chars": MAX_CHARS, "min_signals": MIN_SIGNALS, "inner_min_signals": INNER_MIN_SIGNALS, "home_paths": sorted(HOME_PATHS)},
        "personal_data": "email addresses and phone numbers (9+ digits) removed before writing",
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    result = main(Path(sys.argv[1]), [Path(name) for name in sys.argv[2:]])
    print(json.dumps({key: result[key] for key in ("pages", "kept", "reasons")}, indent=2))
