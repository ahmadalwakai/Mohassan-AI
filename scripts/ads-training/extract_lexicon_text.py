"""Collect plain Arabic and English lines from the local Common Crawl WET files for word statistics.

python -I scripts/ads-training/extract_lexicon_text.py --out artifacts/corpora/lexicon-text
Reads only files already on this machine (artifacts/corpora/commoncrawl-2026-43/raw). No network.
A line is kept when it is mostly one script, long enough to be a sentence and not seen before.
"""
import argparse
import glob
import gzip
import hashlib
import json
import re
import time
from pathlib import Path

ARABIC = re.compile(r"[؀-ۿ]")
LATIN = re.compile(r"[A-Za-z]")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--raw", default="artifacts/corpora/commoncrawl-2026-43/raw")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--english-bytes", type=int, default=400_000_000)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    seen: set[bytes] = set()
    counts = {"ar_lines": 0, "en_lines": 0, "ar_chars": 0, "en_chars": 0, "files": 0}
    started = time.time()
    with (args.out / "ar.txt").open("w", encoding="utf-8", newline="\n") as arabic, (args.out / "en.txt").open("w", encoding="utf-8", newline="\n") as english:
        for path in sorted(glob.glob(f"{args.raw}/*.wet.gz")):
            with gzip.open(path, "rt", encoding="utf-8", errors="ignore") as stream:
                for line in stream:
                    line = line.strip()
                    if not 30 <= len(line) <= 600 or line.startswith(("WARC", "Content-", "http")):
                        continue
                    letters = sum(1 for char in line if char.isalpha())
                    if letters < 20:
                        continue
                    arabic_share = len(ARABIC.findall(line)) / letters
                    latin_share = len(LATIN.findall(line)) / letters
                    if arabic_share >= 0.7:
                        target, name = arabic, "ar"
                    elif latin_share >= 0.95 and counts["en_chars"] < args.english_bytes and line.count(" ") >= 6:
                        target, name = english, "en"
                    else:
                        continue
                    key = hashlib.blake2b(line.encode("utf-8"), digest_size=8).digest()
                    if key in seen:
                        continue
                    seen.add(key)
                    target.write(line + "\n")
                    counts[f"{name}_lines"] += 1
                    counts[f"{name}_chars"] += len(line)
            counts["files"] += 1
            print(json.dumps({**counts, "seconds": round(time.time() - started)}), flush=True)
    (args.out / "manifest.json").write_text(json.dumps({**counts, "source": args.raw, "network": False}, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
