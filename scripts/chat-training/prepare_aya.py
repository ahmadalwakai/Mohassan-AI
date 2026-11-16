"""Prepare a pinned, short bilingual subset of Aya's public TRAIN split.

Downloads only the official training parquet and its README, plus the canonical
Apache license text. It never accesses Aya's test split or this project's final
holdout. Filtering is mechanical and does not establish factual correctness.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
import unicodedata
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/execution-pipeline"))
from execution_pipeline.pretrain import TextEncoder

REPOSITORY = "CohereLabs/aya_dataset"
COMMIT = "f9ea04583f02a8f86404ff6c58bf75fe637df8a2"
TRAIN_PATH = "data/train-00000-of-00001.parquet"
TRAIN_BYTES = 137195800
TRAIN_SHA256 = "51baa85043b569ba117f41516b32d1b0e4e2647fb203a08933f98a556fb1fb06"
LANGUAGES = {"arb": "ar", "ary": "ar", "eng": "en"}
CAP_BYTES = 2_000_000_000
URL_BASE = f"https://huggingface.co/datasets/{REPOSITORY}/resolve/{COMMIT}"


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path: Path, value: object) -> None:
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def download(url: str, destination: Path, *, expected_size: int | None = None, expected_sha256: str | None = None) -> dict:
    if destination.exists():
        if expected_size is not None and destination.stat().st_size != expected_size:
            raise RuntimeError(f"Existing source size mismatch: {destination.name}")
        if expected_sha256 is not None and sha256(destination) != expected_sha256:
            raise RuntimeError(f"Existing source checksum mismatch: {destination.name}")
    else:
        temporary = destination.with_suffix(destination.suffix + ".part")
        if temporary.exists():
            raise RuntimeError(f"Partial source exists; inspect it before retrying: {temporary}")
        request = urllib.request.Request(url, headers={"User-Agent": "Mohassan-local-training/1.0"})
        total = 0
        with urllib.request.urlopen(request, timeout=90) as response, temporary.open("xb") as stream:
            declared = int(response.headers.get("Content-Length", "0"))
            if declared > CAP_BYTES:
                raise RuntimeError("Source exceeds the two-gigabyte download limit.")
            while block := response.read(1024 * 1024):
                total += len(block)
                if total > CAP_BYTES:
                    raise RuntimeError("Source exceeded the two-gigabyte download limit.")
                stream.write(block)
        if expected_size is not None and total != expected_size:
            raise RuntimeError("Downloaded source size mismatch.")
        if expected_sha256 is not None and sha256(temporary) != expected_sha256:
            raise RuntimeError("Downloaded source checksum mismatch.")
        temporary.replace(destination)
    return {"url": url, "file": str(destination.relative_to(ROOT)), "bytes": destination.stat().st_size,
            "sha256": sha256(destination)}


def fetch_sources(directory: Path) -> dict:
    directory.mkdir(parents=True, exist_ok=True)
    sources = [
        download(URL_BASE + "/" + TRAIN_PATH, directory / "train.parquet", expected_size=TRAIN_BYTES, expected_sha256=TRAIN_SHA256),
        download(URL_BASE + "/README.md", directory / "README.md"),
        download("https://www.apache.org/licenses/LICENSE-2.0.txt", directory / "LICENSE.APACHE-2.0.txt"),
    ]
    card = (directory / "README.md").read_text(encoding="utf-8")
    if not re.search(r"^license:\s*apache-2\.0\s*$", card, re.MULTILINE):
        raise RuntimeError("The pinned dataset card no longer declares the expected license.")
    metadata = {"repository": REPOSITORY, "commit": COMMIT, "license": "Apache-2.0",
                "repository_license_file": None,
                "license_evidence": "Pinned README declares apache-2.0. The repository has no separate LICENSE file; canonical Apache text is archived separately.",
                "source_split": "train", "test_split_downloaded": False, "demographics_downloaded": False,
                "pretrained_weights_downloaded": False, "sources": sources}
    path = directory / "source-manifest.json"
    if not path.exists():
        write_json(path, metadata)
    else:
        if json.loads(path.read_text(encoding="utf-8")) != metadata:
            raise RuntimeError("Existing source manifest differs from current sources.")
    return metadata


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).casefold()
    text = "".join(c for c in text if not unicodedata.combining(c) and c != "ـ")
    return " ".join(text.translate(str.maketrans("أإآى", "اااي")).split())


def family_key(text: str) -> str:
    # Punctuation/spacing, diacritic and numeral variants stay in one split.
    words = re.findall(r"[^\W\d_]+|\d+", normalize(text), flags=re.UNICODE)
    return " ".join("#" if word.isdecimal() else word for word in words)


def prompt(messages: list[dict[str, str]]) -> str:
    return "Mohassan chat v1\n" + json.dumps(messages, ensure_ascii=False, separators=(",", ":")) + "\nAssistant:\n"


# Coarse curriculum exclusions, not a safety classifier or fact-checker.
HIGH_STAKES = re.compile(
    r"\b(?:suicid\w*|self.harm|kill myself|sexual\w*|porn\w*|nude\w*|rape|bomb\w*|explosiv\w*|"
    r"weapon\w*|firearm\w*|hack\w*|malware|phish\w*|drug\w*|dosage\w*|prescri\w*|diagnos\w*|"
    r"cancer|antibiotic\w*|pregnan\w*|invest\w*|stock market|legal advice|lawsuit\w*|tax advice)\b|"
    r"انتحار|إنتحار|أقتل نفسي|اقتل نفسي|إيذاء النفس|ايذاء النفس|اغتصاب|إباحي|اباحي|جنس|عاري|"
    r"قنبل|متفجر|سلاح|أسلحة|اسلحة|اختراق|برمجيات خبيثة|مخدر|جرعة|تشخيص|سرطان|مضاد حيوي|استثمار|فتوى",
    re.IGNORECASE)
TIME_SENSITIVE = re.compile(r"\b(?:current|currently|today|latest|nowadays|president|prime minister)\b|حالي[ًاا]*|اليوم|الأحدث|رئيس الوزراء|رئيس الجمهورية", re.IGNORECASE)
UNSUPPORTED = re.compile(r"\b(?:as an ai|as a language model|openai|chatgpt|i (?:have |just )?(?:sent|opened|browsed|searched the web))\b|كنموذج لغوي|بصفتي نموذج|أرسلت الرسالة|فتحت المتصفح", re.IGNORECASE)
CONTACT = re.compile(r"https?://|www\.|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?<!\d)\d[\d ()+-]{8,}\d", re.IGNORECASE)


def clean(text: str) -> str:
    return unicodedata.normalize("NFC", text).replace("\r\n", "\n").replace("\r", "\n").strip()


def quality_reason(question: str, answer: str, language: str) -> str | None:
    if len(question) < 6 or len(answer) < 2:
        return "too_short"
    if len(question) > 8000 or len(answer) > 2000:
        return "character_limit"
    if any(ord(c) < 32 and c not in "\n\t" for c in question + answer) or "\ufffd" in question + answer:
        return "control_or_replacement_character"
    if HIGH_STAKES.search(question + "\n" + answer):
        return "coarse_sensitive_topic_exclusion"
    if TIME_SENSITIVE.search(question):
        return "time_sensitive_question"
    if CONTACT.search(question + "\n" + answer):
        return "contact_or_link_exclusion"
    if UNSUPPORTED.search(answer):
        return "unsupported_identity_or_action_claim"
    if answer.endswith(("...", "…", ":")) or answer.count("```") % 2:
        return "apparently_incomplete_answer"
    if normalize(question) == normalize(answer):
        return "echo"
    words = normalize(answer).split()
    if len(words) >= 12 and len(set(words)) / len(words) < 0.25:
        return "repetitive_answer"
    if len(answer) > 32 and re.search(r"(.)\1{8,}", answer):
        return "repeated_character"
    for text, label in ((question, "question"), (answer, "answer")):
        letters = [c for c in text if c.isalpha()]
        if len(letters) < 3:
            continue
        if language == "ar":
            matching = sum("ARABIC" in unicodedata.name(c, "") for c in letters)
            threshold = 0.45 if label == "question" else 0.6
        else:
            matching = sum("LATIN" in unicodedata.name(c, "") for c in letters)
            threshold = 0.85
        if matching / len(letters) < threshold:
            return f"{label}_script_mismatch"
    return None


def select_sources(path: Path, encoder: TextEncoder, maximum: int) -> tuple[dict[str, list[dict]], dict]:
    import pyarrow
    import pyarrow.parquet as pq
    drops: Counter = Counter()
    seen_languages: Counter = Counter()
    groups: dict[str, list[dict]] = defaultdict(list)
    parquet = pq.ParquetFile(path)
    for batch in parquet.iter_batches(batch_size=2048, columns=["inputs", "targets", "language_code"]):
        for raw in batch.to_pylist():
            code = raw["language_code"]
            if code not in LANGUAGES:
                drops["other_language"] += 1
                continue
            seen_languages[code] += 1
            if not isinstance(raw["inputs"], str) or not isinstance(raw["targets"], str):
                drops["non_text"] += 1
                continue
            question, answer, language = clean(raw["inputs"]), clean(raw["targets"]), LANGUAGES[code]
            reason = quality_reason(question, answer, language)
            if reason:
                drops[reason] += 1
                continue
            target_tokens = len(encoder.encode(answer)) + 1
            if target_tokens > 192:
                drops["answer_exceeds_192_tokens_without_truncation"] += 1
                continue
            messages = [{"role": "user", "content": question}]
            rendered = prompt(messages)
            total_tokens = len(encoder.encode(rendered)) + target_tokens
            if total_tokens > 512:
                drops["example_exceeds_512_tokens_without_truncation"] += 1
                continue
            normalized = normalize(question)
            identifier = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
            family = hashlib.sha256(family_key(question).encode("utf-8")).hexdigest()
            row = {"id": f"aya-{identifier}", "language": language, "capability": "chat.reply.v1",
                   "category": "public_instruction", "source": "aya_train", "source_language_code": code,
                   "messages": messages, "prompt": rendered, "target": answer,
                   "prompt_family_sha256": family, "answer_tokens": target_tokens, "total_tokens": total_tokens}
            groups[identifier].append(row)
    candidates = {"ar": [], "en": []}
    for grouped in groups.values():
        if len({normalize(row["target"]) for row in grouped}) > 1:
            drops["conflicting_answers_for_normalized_prompt"] += len(grouped)
            continue
        drops["duplicate_normalized_prompt"] += len(grouped) - 1
        chosen = min(grouped, key=lambda row: row["prompt"])
        candidates[chosen["language"]].append(chosen)
    available = {language: len(rows) for language, rows in candidates.items()}
    per_language = min(maximum // 2, *available.values())
    selected = {}
    for language, rows in candidates.items():
        ordered = sorted(rows, key=lambda row: row["id"])
        selected[language] = ordered[:per_language]
        drops[f"balance_or_cap_{language}"] += len(rows) - per_language
    summary = {"parquet_rows": parquet.metadata.num_rows, "source_language_counts": dict(seen_languages),
               "candidate_counts_after_filters": available, "selected_per_language": per_language,
               "drop_counts": dict(sorted(drops.items())), "pyarrow_version": pyarrow.__version__}
    print(json.dumps({"stage": "source_selection", **summary}), flush=True)
    return selected, summary


def inherited_rows(path: Path) -> tuple[list[dict], dict]:
    original = [json.loads(line) for line in (path / "train.jsonl").read_text(encoding="utf-8").splitlines()]
    authored = [row for row in original if row["source"] in {"authored_card", "authored_dialogue"}]
    systematic = [row for row in original if row["source"] == "systematic_template"]
    kept = []
    for language in ("ar", "en"):
        for category in ("memory", "correction", "copy", "structured_text"):
            rows = [row for row in systematic if row["language"] == language and row["category"] == category]
            rows.sort(key=lambda row: hashlib.sha256(row["id"].encode()).hexdigest())
            kept.extend(rows[:40])
    return authored + kept, {"source_train_sha256": sha256(path / "train.jsonl"), "authored_rows": len(authored),
                             "systematic_rows": len(kept), "prior_validation_included": False}


def build(source_dir: Path, destination: Path, run: Path, v1: Path, maximum: int) -> dict:
    if destination.exists():
        raise RuntimeError("Output dataset already exists; no overwrite is allowed.")
    source_metadata = fetch_sources(source_dir)
    encoder = TextEncoder(run)
    chosen, filter_report = select_sources(source_dir / "train.parquet", encoder, maximum)
    inherited, inherited_report = inherited_rows(v1)
    prior_validation = [json.loads(line) for line in (v1 / "validation.jsonl").read_text(encoding="utf-8").splitlines()]
    prior_families = {hashlib.sha256(family_key(row["messages"][-1]["content"]).encode()).hexdigest() for row in prior_validation}
    prior_answers = {normalize(row["target"]) for row in prior_validation}
    prior_exclusions = Counter()
    for language, rows in chosen.items():
        kept = []
        for row in rows:
            if row["prompt_family_sha256"] in prior_families or normalize(row["target"]) in prior_answers:
                prior_exclusions[language] += 1
            else:
                kept.append(row)
        rows[:] = kept
    inherited_report["prior_validation_sha256"] = sha256(v1 / "validation.jsonl")
    inherited_report["source_matches_to_prior_validation_excluded"] = dict(prior_exclusions)
    # V1 training families and answers remain training-only, even if repeated by Aya.
    reserved_families = {hashlib.sha256(family_key(row["messages"][-1]["content"]).encode()).hexdigest() for row in inherited}
    reserved_answers = {normalize(row["target"]) for row in inherited}
    train, validation = [], []
    validation_drops = Counter()
    for language in ("ar", "en"):
        for row in chosen[language]:
            family = row["prompt_family_sha256"]
            development = int(family[:16], 16) % 1000 < 50
            if development and (family in reserved_families or normalize(row["target"]) in reserved_answers):
                validation_drops["overlaps_inherited_train"] += 1
                continue
            (validation if development else train).append(row)
    train_targets = {normalize(row["target"]) for row in train} | reserved_answers
    disjoint_validation = []
    for row in validation:
        if normalize(row["target"]) in train_targets:
            validation_drops["answer_also_present_in_train"] += 1
        else:
            disjoint_validation.append(row)
    validation = disjoint_validation
    # Maintain exact language balance separately in each split after all exclusions.
    balancing_drops = {}
    for name, rows in (("train", train), ("validation", validation)):
        by_language = {language: sorted((row for row in rows if row["language"] == language), key=lambda row: row["id"]) for language in ("ar", "en")}
        take = min(len(values) for values in by_language.values())
        if not take:
            raise RuntimeError(f"No usable balanced {name} data.")
        balancing_drops[name] = {language: len(values) - take for language, values in by_language.items()}
        rows[:] = [row for language in ("ar", "en") for row in by_language[language][:take]]
    existing = {row["prompt"] for row in train}
    skipped_inherited = 0
    for row in inherited:
        if row["prompt"] in existing:
            skipped_inherited += 1
            continue
        train.append(row)
        existing.add(row["prompt"])
    assert not ({row["prompt"] for row in train} & {row["prompt"] for row in validation})
    assert not ({normalize(row["target"]) for row in train} & {normalize(row["target"]) for row in validation})
    assert not ({row.get("prompt_family_sha256") for row in train if row.get("prompt_family_sha256")} & {row["prompt_family_sha256"] for row in validation})
    manifest = {"schema_version": 1, "curriculum": "mohassan-conversation-v2-aya", "created_at": datetime.now(timezone.utc).isoformat(),
                "sources": source_metadata, "source_filters": filter_report, "inherited_v1_training": inherited_report,
                "tokenizer_identity": encoder.tokenizer.identity, "tokenizer_sha256": sha256(run / "tokenizer.json"),
                "limits": {"answer_tokens_including_eos": 192, "example_tokens_including_eos": 512, "answer_truncation": False},
                "split_method": "SHA256 of normalized prompt family; first64bits modulo1000<50 => development validation. Exact/numeric/punctuation variants share a split. Balance/cap and answer-overlap exclusions are applied afterwards.",
                "validation_is_independent_final_test": False, "final_holdout_read": False,
                "validation_exclusions": dict(validation_drops), "split_balancing_exclusions": balancing_drops,
                "duplicate_inherited_prompts_excluded": skipped_inherited,
                "removed_metadata": ["user_id", "annotation_type"], "language_semantics": "Primary user/source language; inherited explicit translation tasks may target the other language.",
                "quality_limits": ["Public annotations are not individually fact-checked.", "Regex exclusions are incomplete and can over-filter.",
                                   "Normalized prompt families reduce simple near-duplicate leakage, not semantic paraphrase leakage.",
                                   "Aya source examples are single-turn instructions; inherited80dialogue rows cover only one follow-up.",
                                   "This dataset and validation loss do not establish general chat competence or production readiness."],
                "splits": {}}
    destination.mkdir(parents=True, exist_ok=False)
    for split, rows in (("train", train), ("validation", validation)):
        rows.sort(key=lambda row: hashlib.sha256(("shuffle-v2:" + row["id"]).encode()).hexdigest())
        data = ("\n".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows) + "\n").encode("utf-8")
        (destination / f"{split}.jsonl").write_bytes(data)
        manifest["splits"][split] = {"rows": len(rows), "languages": dict(Counter(row["language"] for row in rows)),
                                      "sources": dict(Counter(row["source"] for row in rows)), "sha256": hashlib.sha256(data).hexdigest()}
    write_json(destination / "manifest.json", manifest)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--sources", type=Path, default=ROOT / "artifacts/corpora/aya-chat" / COMMIT)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/chat-training/conversation-v2/dataset")
    parser.add_argument("--run", type=Path, default=ROOT / "artifacts/execution-model-runs/text-b2-2026-11-12")
    parser.add_argument("--v1", type=Path, default=ROOT / "artifacts/chat-training/conversation-v1/dataset")
    parser.add_argument("--max-source-rows", type=int, default=19000)
    parser.add_argument("--download-only", action="store_true")
    args = parser.parse_args()
    if not 2 <= args.max_source_rows <= 19000:
        raise ValueError("Source row cap must be between2and19000.")
    result = fetch_sources(args.sources) if args.download_only else build(args.sources, args.output, args.run, args.v1, args.max_source_rows)
    print(json.dumps(result if args.download_only else {"output": str(args.output), "splits": result["splits"], "source_filters": result["source_filters"]}, ensure_ascii=False, indent=2))
