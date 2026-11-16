"""Prepare attributed Arabic Wikipedia language data and English replay.

Only original public prose is used. No generated answers, models, final chat
holdout, or conversational test data are accessed. Tokenizer remains unchanged.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from multiprocessing import Pool
from pathlib import Path
import re
import sys
import time
import unicodedata
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/execution-pipeline"))
from execution_pipeline.pretrain import TextEncoder, _is_validation, wiki_articles

COMMIT = "b04c8d1ceb2f5cd4588862100d08de323dccfbaa"
AR_FILE = "20231101.ar/train-00001-of-00007.parquet"
AR_BYTES = 172208447
AR_SHA = "66f657f16a9e00e914d6c244d3783c93d30594db8c9d2e745d8f26647c9aeff2"
ARABIC = re.compile(r"[\u0621-\u063a\u0641-\u064a\u066e-\u06d3]")
FOOTERS = {"مراجع", "المراجع", "مصادر", "المصادر", "المصدر", "مصدر", "وصلات خارجية", "روابط خارجية",
           "انظر أيضا", "انظر أيضًا", "أنظر أيضا", "اقرأ أيضا", "اقرأ أيضًا", "قراءة إضافية"}
ENCODER = None


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def fetch(url: str, destination: Path, size=None, expected=None) -> dict:
    if not destination.exists():
        temporary = destination.with_suffix(destination.suffix + ".part")
        total = 0
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mohassan-local-training/1.0"}), timeout=60) as response, temporary.open("xb") as stream:
            while block := response.read(1 << 20):
                total += len(block)
                if total > 3_000_000_000:
                    raise RuntimeError("Source download exceeded cap.")
                stream.write(block)
        temporary.replace(destination)
    actual = digest(destination)
    if size is not None and destination.stat().st_size != size or expected is not None and actual != expected:
        raise RuntimeError(f"Source identity mismatch: {destination.name}")
    return {"file": destination.name, "url": url, "bytes": destination.stat().st_size, "sha256": actual}


def sources(out: Path) -> dict:
    source = out / "source"
    source.mkdir(parents=True, exist_ok=True)
    base = f"https://huggingface.co/datasets/wikimedia/wikipedia/resolve/{COMMIT}"
    files = [fetch(f"{base}/{AR_FILE}", source / "ar-train-00001.parquet", AR_BYTES, AR_SHA),
             fetch(f"{base}/README.md", source / "README.md"),
             fetch("https://creativecommons.org/licenses/by-sa/3.0/legalcode.txt", source / "CC-BY-SA-3.0.txt"),
             fetch("https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt", source / "CC-BY-SA-4.0.txt")]
    english_manifest = ROOT / "artifacts/corpora/simplewiki-20261101/text/manifest.json"
    english = json.loads(english_manifest.read_text(encoding="utf-8"))
    for shard in english["shards"]:
        if digest(english_manifest.parent / shard["file"]) != shard["sha256"]:
            raise RuntimeError("Original SimpleWiki shard changed.")
    result = {"repository": "wikimedia/wikipedia", "commit": COMMIT, "configuration": "20231101.ar",
              "source_split": "train", "licenses": ["CC-BY-SA-3.0", "GFDL"], "files": files,
              "arabic_source": f"https://huggingface.co/datasets/wikimedia/wikipedia/tree/{COMMIT}/20231101.ar",
              "english_source": english, "english_manifest_sha256": digest(english_manifest),
              "pretrained_weights_downloaded": False,
              "limitations": "One Arabic source shard, not a representative sample of all Wikipedia. Public prose has not been fact-checked."}
    write_json(source / "manifest.json", result)
    return result


def clean_arabic(text: str) -> str:
    text = text.replace("\xa0", " ").replace("\r\n", "\n")
    lines = []
    for line in text.splitlines():
        line = " ".join(line.split())
        if line.strip(" =:：") in FOOTERS:
            break
        if not line:
            if lines and lines[-1]:
                lines.append("")
            continue
        if re.fullmatch(r"https?://\S+", line) or line.startswith(("[[تصنيف:", "{{", "|")):
            continue
        lines.append(line)
    return "\n".join(lines).strip()


def content_hash(text: str) -> str:
    return hashlib.sha256(" ".join(text.split()).encode("utf-8")).hexdigest()


def collect(out: Path) -> tuple[dict, dict]:
    import pyarrow.parquet as pq
    records = {"ar.train": [], "ar.validation": [], "en.train": [], "en.validation": []}
    seen = set()
    counts = Counter()
    parquet = pq.ParquetFile(out / "source/ar-train-00001.parquet")
    for batch in parquet.iter_batches(batch_size=2048):
        for row in batch.to_pylist():
            counts["ar_source_documents"] += 1
            body = clean_arabic(row["text"])
            letters = sum(char.isalpha() for char in body)
            if not 300 <= len(body) <= 60000:
                counts["ar_length_rejected"] += 1
                continue
            if letters < 150 or len(ARABIC.findall(body)) / letters < 0.7 or "\ufffd" in body:
                counts["ar_script_or_encoding_rejected"] += 1
                continue
            key = content_hash(body)
            if key in seen:
                counts["ar_exact_content_duplicate"] += 1
                continue
            seen.add(key)
            split = "validation" if int(key[:16], 16) % 100 == 0 else "train"
            records[f"ar.{split}"].append({"language": "ar", "source": "arabic-wikipedia-20231101",
                                           "id": row["id"], "url": row["url"], "title": row["title"],
                                           "text": row["title"] + "\n" + body, "content_sha256": key,
                                           "license": "CC-BY-SA-3.0", "contributors": "Wikipedia contributors; see article history"})
    # All replay TRAIN articles come from the original SimpleWiki training split.
    # English validation retains the original held-out title split and is never replayed.
    english_groups = {}
    for title, body in wiki_articles():
        counts["en_source_documents"] += 1
        if not 200 <= len(body) <= 60000 or "\ufffd" in body:
            counts["en_length_or_encoding_rejected"] += 1
            continue
        key = content_hash(body)
        if key in english_groups:
            counts["en_exact_content_duplicate"] += 1
            if _is_validation(title):
                english_groups[key]["validation"] = True
            continue
        english_groups[key] = {"title": title, "body": body, "validation": _is_validation(title)}
    for key, group in english_groups.items():
        title, body = group["title"], group["body"]
        split = "validation" if group["validation"] else "train"
        if split == "train" and int(key[16:32], 16) % 3:
            counts["en_train_not_sampled"] += 1
            continue
        records[f"en.{split}"].append({"language": "en", "source": "simplewiki-20261101", "id": title,
                                       "url": "https://simple.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_")),
                                       "title": title, "text": body, "content_sha256": key, "license": "CC-BY-SA-4.0",
                                       "contributors": "Wikipedia contributors; see article history"})
    for name, rows in records.items():
        rows.sort(key=lambda row: hashlib.sha256(("foundation-v1:" + row["content_sha256"]).encode()).hexdigest())
        counts[name + "_available"] = len(rows)
    return records, dict(counts)


def init_encoder(run: str) -> None:
    global ENCODER
    ENCODER = TextEncoder(Path(run))


def encode_document(text: str) -> tuple[bytes, int, int]:
    import numpy as np
    tokens = ENCODER.encode(text) + [ENCODER.tokenizer.eos_token_id]
    words = len(re.findall(r"\S+", text))
    return np.asarray(tokens, dtype="<u2").tobytes(), len(text), words


def prepare(args) -> dict:
    started = time.perf_counter()
    out = args.output.resolve()
    source = sources(out)
    if args.download_only:
        return source
    if (out / "manifest.json").exists():
        raise RuntimeError("Never overwrite a prepared corpus.")
    text_dir = out / "text"
    if (text_dir / "manifest.json").exists():
        cached = json.loads((text_dir / "manifest.json").read_text(encoding="utf-8"))
        filters = cached["filters"]
        records = {}
        for name, metadata in cached["files"].items():
            path = text_dir / name
            if digest(path) != metadata["sha256"]:
                raise RuntimeError("Clean text cache changed.")
            records[name.removesuffix(".jsonl")] = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    else:
        records, filters = collect(out)
        print(json.dumps({"phase": "selected", "counts": filters}), flush=True)
        write_json(out / "selection.json", filters)
        text_dir.mkdir(parents=True, exist_ok=False)
        cached = {"schemaVersion": 1, "source_manifest_sha256": digest(out / "source/manifest.json"), "filters": filters, "files": {}}
        for name, rows in records.items():
            path = text_dir / f"{name}.jsonl"
            with path.open("x", encoding="utf-8", newline="\n") as stream:
                for row in rows:
                    stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
            cached["files"][path.name] = {"documents": len(rows), "characters": sum(len(row["text"]) for row in rows),
                                          "sha256": digest(path), "bytes": path.stat().st_size}
            print(json.dumps({"phase": "text_ready", "path": str(path), **cached["files"][path.name]}), flush=True)
        write_json(text_dir / "manifest.json", cached)
    if args.prepare_text_only:
        return cached
    encoder = TextEncoder(args.run)
    if encoder.tokenizer.vocab_size > 65535:
        raise RuntimeError("Tokenizer does not fit uint16.")
    limits = {"ar.train": args.ar_tokens, "ar.validation": args.validation_tokens,
              "en.train": args.en_tokens, "en.validation": args.validation_tokens}
    report = {"schemaVersion": 1, "createdAt": datetime.now(timezone.utc).isoformat(),
              "tokenizer_identity": encoder.tokenizer.identity, "tokenizer_sha256": digest(args.run / "tokenizer.json"),
              "tokenizer_report_sha256": digest(args.run / "tokenizer-report.json"), "dtype": "uint16-le",
              "eos_token_id": encoder.tokenizer.eos_token_id,
              "recommended_sequence_length": 512, "document_separation": "One EOS after each complete article; no truncation.",
              "source_manifest_sha256": digest(out / "source/manifest.json"), "files": {}, "filters": filters,
              "split_method": {"ar": "normalized content SHA256 first64bits modulo100==0 is validation; exact duplicate bodies grouped; full eligible train candidates in deterministic hash order before token budget",
                               "en": "original SimpleWiki title SHA1 modulo200==0 is validation; all other replay texts belonged to original training, then sampled by content hash"},
              "text_changes": "NBSP and whitespace normalization; drop Arabic reference/link footer and markup-only/URL-only lines; no factual rewriting and no document truncation.",
              "limitations": ["Language-model prose, not instruction or dialogue supervision.",
                              "Wikipedia statements can be wrong or dated; not a verified knowledge base.",
                              "One source shard and bounded hash sample can have topic and time biases.",
                              "Only exact-content deduplication; semantic paraphrase leakage is not ruled out.",
                              "Final conversation holdout is not accessed."]}
    sample = []
    with Pool(args.workers, initializer=init_encoder, initargs=(str(args.run.resolve()),)) as pool:
        for name, rows in records.items():
            path = out / f"{name}.bin"
            index_path = out / f"{name}.documents.jsonl"
            tokens = chars = words = docs = 0
            with path.open("xb") as binary, index_path.open("x", encoding="utf-8") as index:
                for begin in range(0, len(rows), 128):
                    if tokens >= limits[name]:
                        break
                    chunk = rows[begin:begin + 128]
                    for row, (encoded, length, word_count) in zip(chunk, pool.imap(encode_document, (row["text"] for row in chunk), chunksize=16)):
                        if tokens >= limits[name]:
                            break
                        count = len(encoded) // 2
                        binary.write(encoded)
                        metadata = {key: value for key, value in row.items() if key != "text"}
                        metadata.update(token_offset=tokens, tokens=count, characters=length, words=word_count)
                        index.write(json.dumps(metadata, ensure_ascii=False) + "\n")
                        if docs < 6:
                            sample.append({**metadata, "split": name, "excerpt": row["text"][:1000]})
                        tokens += count
                        chars += length
                        words += word_count
                        docs += 1
                        if docs % 5000 == 0:
                            print(json.dumps({"phase": "encoding", "split": name, "documents": docs, "tokens": tokens}), flush=True)
            report["files"][path.name] = {"tokens": tokens, "sha256": digest(path), "documents": docs,
                                           "characters": chars, "words": words, "characters_per_token": round(chars / tokens, 4),
                                           "tokens_per_word": round(tokens / max(words, 1), 4),
                                           "document_index": index_path.name, "document_index_sha256": digest(index_path),
                                           "eos_separators": docs}
            print(json.dumps({"phase": "encoded", "file": path.name, **report["files"][path.name]}), flush=True)
    report["seconds"] = round(time.perf_counter() - started, 1)
    write_json(out / "quality-sample.json", sample)
    write_json(out / "manifest.json", report)
    return report


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/corpora/arabic-foundation-v1")
    parser.add_argument("--run", type=Path, default=ROOT / "artifacts/execution-model-runs/text-b2-2026-11-12")
    parser.add_argument("--ar-tokens", type=int, default=25000000)
    parser.add_argument("--en-tokens", type=int, default=10000000)
    parser.add_argument("--validation-tokens", type=int, default=250000)
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--download-only", action="store_true")
    parser.add_argument("--prepare-text-only", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.workers <= 12 or min(args.ar_tokens, args.en_tokens, args.validation_tokens) < 1024:
        parser.error("Use 1..12 workers and token budgets >=1024")
    print(json.dumps(prepare(args), ensure_ascii=False, indent=2))
