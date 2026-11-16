"""Extract plain English text from a Simple English Wikipedia dump for language pre-training.

    python -I scripts/ads-training/extract_wiki.py <dump.xml.bz2> <out_dir> --sha1 <expected>

Standard library only. Streams the compressed dump, keeps main-namespace articles that are not
redirects, strips wiki markup, and writes UTF-8 text shards with one article per block. The
dump is treated as untrusted data: nothing in it is executed, and only text is kept.
Licence: Wikipedia text is CC BY-SA 4.0 (and GFDL); the manifest records the source and hash.
"""
from __future__ import annotations

import argparse
import bz2
import hashlib
import json
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

SHARD_CHARS = 64 * 1024 * 1024
MIN_ARTICLE_CHARS = 200

COMMENT = re.compile(r"<!--.*?-->", re.S)
REF = re.compile(r"<ref[^>/]*?/>|<ref[^>]*?>.*?</ref>", re.S | re.I)
BLOCK_TAGS = re.compile(r"<(math|gallery|timeline|score|syntaxhighlight|source|pre|code|chem|hiero|imagemap|templatedata|graph)\b[^>]*>.*?</\1>", re.S | re.I)
TAG = re.compile(r"</?[a-zA-Z][^>]*>")
FILE_LINK = re.compile(r"\[\[(?:File|Image|Media|Category|Wikipedia|WP|Template|Help|Portal|Special|Module|Draft|User|Talk|[a-z]{2,3}(?:-[a-z]+)?):[^\[\]]*(?:\[\[[^\[\]]*\]\][^\[\]]*)*\]\]", re.I)
PIPED_LINK = re.compile(r"\[\[[^\[\]|]*\|([^\[\]]*)\]\]")
LINK = re.compile(r"\[\[([^\[\]]*)\]\]")
EXTERNAL_TEXT = re.compile(r"\[(?:https?:)?//[^\s\]]+\s+([^\]]*)\]")
EXTERNAL_BARE = re.compile(r"\[(?:https?:)?//[^\]]*\]|https?://\S+")
EMPHASIS = re.compile(r"'{2,}")
HEADING = re.compile(r"^=+\s*(.*?)\s*=+\s*$", re.M)
LIST_MARK = re.compile(r"^[*#:;]+\s*", re.M)
ENTITY = {"&nbsp;": " ", "&ndash;": "-", "&mdash;": "-", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&minus;": "-"}
SKIP_HEADINGS = {"references", "notes", "other websites", "external links", "related pages", "sources", "further reading", "bibliography", "gallery"}


def strip_nested(text: str, opener: str, closer: str) -> str:
    """Remove balanced {{...}} or {|...|} blocks, including nested ones."""
    out, depth, i = [], 0, 0
    while i < len(text):
        if text.startswith(opener, i):
            depth += 1; i += len(opener); continue
        if depth and text.startswith(closer, i):
            depth -= 1; i += len(closer); continue
        if not depth:
            out.append(text[i])
        i += 1
    return "".join(out)


def clean(wikitext: str) -> str:
    text = COMMENT.sub("", wikitext)
    text = REF.sub("", text)
    text = BLOCK_TAGS.sub("", text)
    text = strip_nested(text, "{{", "}}")
    text = strip_nested(text, "{|", "|}")
    for _ in range(3):  # links inside link captions
        text = FILE_LINK.sub("", text)
    text = PIPED_LINK.sub(r"\1", text)
    text = LINK.sub(r"\1", text)
    text = EXTERNAL_TEXT.sub(r"\1", text)
    text = EXTERNAL_BARE.sub("", text)
    text = TAG.sub("", text)
    text = EMPHASIS.sub("", text)
    for entity, value in ENTITY.items():
        text = text.replace(entity, value)
    # Drop trailing reference-style sections.
    kept, skipping = [], False
    for line in text.splitlines():
        heading = HEADING.match(line)
        if heading:
            skipping = heading.group(1).strip().lower() in SKIP_HEADINGS
            if not skipping and heading.group(1).strip():
                kept.append(heading.group(1).strip())
            continue
        if skipping:
            continue
        line = LIST_MARK.sub("", line).strip()
        if line and not line.startswith(("|", "!", "{", "}")) and any(ch.isalpha() for ch in line):
            kept.append(re.sub(r"[ \t]{2,}", " ", line))
    return "\n".join(kept).strip()


def sha1_of(path: Path) -> str:
    digest = hashlib.sha1()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("dump", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--sha1", required=True)
    args = parser.parse_args()
    actual = sha1_of(args.dump)
    if actual != args.sha1:
        print(f"SHA1_MISMATCH expected {args.sha1} got {actual}", file=sys.stderr)
        return 2
    args.out.mkdir(parents=True, exist_ok=True)
    started = time.time()
    counts = {"pages": 0, "articles": 0, "redirects": 0, "other_namespaces": 0, "too_short": 0, "characters": 0, "words": 0}
    shards: list[dict] = []
    shard_text: list[str] = []
    shard_chars = 0

    def flush() -> None:
        nonlocal shard_text, shard_chars
        if not shard_text:
            return
        name = f"shard-{len(shards):03d}.txt"
        data = "\n\n".join(shard_text).encode("utf-8") + b"\n"
        (args.out / name).write_bytes(data)
        shards.append({"file": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        shard_text, shard_chars = [], 0

    with bz2.open(args.dump, "rb") as stream:
        namespace = ""
        for event, element in ET.iterparse(stream, events=("start", "end")):
            if event == "start":
                if not namespace and element.tag.startswith("{"):
                    namespace = element.tag[: element.tag.index("}") + 1]
                continue
            if element.tag != namespace + "page":
                continue
            counts["pages"] += 1
            ns = element.findtext(namespace + "ns")
            title = element.findtext(namespace + "title") or ""
            text = element.findtext(f"{namespace}revision/{namespace}text") or ""
            element.clear()
            if ns != "0":
                counts["other_namespaces"] += 1; continue
            if element.find(namespace + "redirect") is not None or text.lstrip().lower().startswith("#redirect"):
                counts["redirects"] += 1; continue
            body = clean(text)
            if len(body) < MIN_ARTICLE_CHARS:
                counts["too_short"] += 1; continue
            article = f"{title}\n{body}"
            counts["articles"] += 1
            counts["characters"] += len(article)
            counts["words"] += len(article.split())
            shard_text.append(article)
            shard_chars += len(article)
            if shard_chars >= SHARD_CHARS:
                flush()
    flush()
    manifest = {
        "source": "https://dumps.wikimedia.org/simplewiki/20261101/simplewiki-20261101-pages-articles.xml.bz2",
        "source_sha1": actual, "licence": "CC BY-SA 4.0 and GFDL (Wikipedia text)",
        "extractor": "scripts/ads-training/extract_wiki.py", "min_article_chars": MIN_ARTICLE_CHARS,
        "counts": counts, "shards": shards, "seconds": round(time.time() - started, 1),
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: manifest[k] for k in ("counts", "seconds")} | {"shards": len(shards)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
