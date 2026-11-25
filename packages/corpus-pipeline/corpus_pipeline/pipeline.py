"""Build immutable corpus shards and their review evidence."""

from collections import Counter
from collections.abc import Iterator, Sequence
from contextlib import ExitStack
from dataclasses import asdict
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from shlex import join
from typing import BinaryIO
import unicodedata

from . import contamination, dedup, language, normalization, quality
from .inputs import Config, LANGUAGES, SPLITS, Source, evidence_path, file_sha256, json_bytes, source_rows


AUDIT_NAMES = ("removals.jsonl", "contamination.jsonl", "language-confusion.json")
SCHEMA_VERSION = 1


class Artifact:
    """Fingerprint exactly the bytes written, including during a dry run."""

    def __init__(self, name: str, stream: BinaryIO | None) -> None:
        self.name = name
        self.stream = stream
        self.digest = sha256()
        self.size = 0
        self.records = 0

    def write(self, data: bytes) -> None:
        self.digest.update(data)
        self.size += len(data)
        self.records += 1
        if self.stream is not None:
            self.stream.write(data)

    def evidence(self) -> dict:
        return {"path": self.name, "sha256": self.digest.hexdigest(), "bytes": self.size, "records": self.records}


def _train_language_model(config: Config, evaluation: contamination.EvaluationIndex) -> language.LanguageModel:
    # Exclude development examples (and their duplicates) before fitting the routing classifier.
    labeled_index = dedup.Deduplicator(config.near_duplicate_threshold)

    def examples() -> Iterator[tuple[str, str]]:
        for split in ("development", "train"):
            for source in config.sources:
                if source.split != split or source.language is None:
                    continue
                for document_id, row in source_rows(source):
                    text = normalization.normalize_text(row["text"])
                    if quality.quality_reasons(text, config.quality):
                        continue
                    if split == "train" and evaluation.find(normalization.match_key(text)):
                        continue
                    for paragraph in language.paragraphs(text):
                        if quality.quality_reasons(paragraph, config.quality):
                            continue
                        reference = {"source": source.id, "id": document_id}
                        match = labeled_index.check_and_add(normalization.match_key(paragraph), reference)
                        if split == "train" and match is None:
                            yield source.language, paragraph

    model = language.LanguageModel.train(examples())
    if set(model.labels) != set(LANGUAGES):
        raise ValueError("language classifier requires usable labeled training text in Arabic and English")
    return model


def _content(source: Source, row: dict, marker: str) -> tuple[str, list[dict] | None, list[str]]:
    if source.kind == "text":
        return normalization.normalize_text(row["text"]), None, []
    raw_turns = row.get("turns")
    reasons = quality.dialogue_reasons(raw_turns, marker)
    turns = []
    if isinstance(raw_turns, list):
        for turn in raw_turns:
            if isinstance(turn, dict) and isinstance(turn.get("content"), str):
                turns.append({"role": turn.get("role"), "content": normalization.normalize_text(turn["content"])})
    return dedup.dialogue_text(turns, marker), turns, reasons


def _units(text: str, model: language.LanguageModel, is_dialogue: bool) -> Iterator[tuple[int | None, str, str]]:
    if not normalization.TOKEN_PATTERN.search(text):
        yield None, text, "und"
        return
    if is_dialogue:
        yield None, text, model.predict(text)
        return
    paragraphs = list(language.paragraphs(text))
    labels = [model.predict(paragraph) for paragraph in paragraphs]
    if len(set(labels)) <= 1:
        yield None, text, labels[0] if labels else "und"
        return
    for index, (paragraph, label) in enumerate(zip(paragraphs, labels)):
        yield index, paragraph, label


def _summary(manifest: dict, run: dict, confusion: dict) -> str:
    counts = manifest["counts"]
    kept = sum(shard["records"] for shard in manifest["shards"])
    removed = sum(tally["removed"] for tally in counts["languages"].values())
    lines = [
        "# تقرير تنقية بيانات محادثة موحسن",
        "",
        f'- بدء التشغيل بتوقيت UTC `{run["started_at"]}` والانتهاء `{run["finished_at"]}`.',
        f'- الأمر `{run["command"]}`.',
        f'- مسار المخرجات الخام `{run["output"]}`.',
        f'- بصمة البيان SHA-256 `{run["manifest_sha256"]}`.',
        f'- المستندات الواردة {sum(counts["input_documents"].values())}، والوحدات المقبولة '
        f'{kept}، والوحدات المرفوضة {removed}. قد يتكون المستند من عدة وحدات.',
        f'- تصنيف اللغة على بيانات التطوير المقبولة {confusion["correct"]} من {confusion["total"]}.',
        "- يلزم اعتماد بشري لبصمة البيان قبل استخدام البيانات في التدريب.",
    ]
    if manifest["fixture_mode"]:
        lines.append("- تشغيل ببيانات اختبارية. يرفض أمر التحقق اعتماده للتدريب.")
    lines.extend(("", "## الوحدات حسب اللغة", ""))
    for label, tally in counts["languages"].items():
        lines.append(f'- `{label}` قُبلت {tally["kept"]} من {tally["kept"] + tally["removed"]}.')
    for label, row in confusion["matrix"].items():
        lines.append(f'- `{label}` صُنّفت في التطوير تصنيفًا صحيحًا {row[label]} من {sum(row.values())}.')
    lines.extend(("", "## أسباب الرفض", "", "قد تحمل الوحدة أكثر من سبب.", ""))
    for reason, count in counts["reasons"].items():
        lines.append(f"- `{reason}` {count} من {kept + removed}.")
    lines.extend(("", "## بصمات المخرجات", ""))
    for entry in [*manifest["shards"], *manifest["audits"]]:
        lines.append(f'- `{entry["path"]}` ‏`{entry["sha256"]}`.')
    return "\n".join(lines) + "\n"


def run_pipeline(config: Config, output: Path, *, dry_run: bool, command: Sequence[str]) -> bytes:
    started = datetime.now(timezone.utc).isoformat()
    output = output.resolve()
    if not dry_run and output.exists():
        raise FileExistsError(f"output directory already exists: {output}")
    base = config.path.parent
    evaluation = contamination.EvaluationIndex(config.frozen_evaluations, config.contamination_span_tokens)
    evaluation_paths = {path.as_posix(): evidence_path(path, base) for path, _ in config.frozen_evaluations}
    index = dedup.Deduplicator(config.near_duplicate_threshold)
    prior_evidence = [index.add_manifest(path) for path in config.prior_manifests]
    prior_paths = {path.as_posix(): evidence_path(path, base) for path in config.prior_manifests}
    model = _train_language_model(config, evaluation)
    if not dry_run:
        output.mkdir(parents=True, exist_ok=False)

    input_documents = dict.fromkeys(SPLITS, 0)
    languages = {label: {"kept": 0, "removed": 0} for label in (*LANGUAGES, "und")}
    reason_counts: Counter[str] = Counter()
    matrix = {actual: dict.fromkeys(LANGUAGES, 0) for actual in LANGUAGES}

    with ExitStack() as stack:
        def artifact(name: str) -> Artifact:
            return Artifact(name, None if dry_run else stack.enter_context((output / name).open("xb")))

        shards = {split: artifact(f"{split}.jsonl") for split in SPLITS}
        removals, hits, confusion_artifact = (artifact(name) for name in AUDIT_NAMES)

        def remove(record: dict, reasons: list[str], duplicate: dedup.Duplicate | None = None) -> None:
            languages[record["language"]]["removed"] += 1
            reason_counts.update(reasons)
            payload = {**record, "reasons": reasons}
            if duplicate is not None:
                reference = dict(duplicate.reference)
                if "manifest" in reference:
                    reference["manifest"] = prior_paths[reference["manifest"]]
                payload["duplicate"] = {"reference": reference, "similarity": duplicate.similarity}
            removals.write(json_bytes(payload))

        for split in SPLITS:
            for source in config.sources:
                if source.split != split:
                    continue
                for document_id, row in source_rows(source):
                    input_documents[split] += 1
                    identity = {"source": source.id, "split": split, "document_id": document_id}
                    text, turns, shape_reasons = _content(source, row, config.assistant_end_marker)
                    key = normalization.match_key(text)
                    matches = evaluation.find(key) if split == "train" else []
                    for hit in matches:
                        hits.write(json_bytes({
                            **identity, **hit, "evaluation_path": evaluation_paths[hit["evaluation_path"]],
                        }))
                    document_reasons = [*shape_reasons, *quality.quality_reasons(text, config.quality)]
                    if matches:
                        document_reasons.append("contamination")
                    if document_reasons:
                        label = model.predict(text) if normalization.TOKEN_PATTERN.search(text) else "und"
                        remove({**identity, "language": label}, document_reasons)
                        continue
                    for number, unit, label in _units(text, model, turns is not None):
                        record = {**identity, "language": label}
                        if number is not None:
                            record["paragraph"] = number
                            reasons = quality.quality_reasons(unit, config.quality)
                            if reasons:
                                remove(record, reasons)
                                continue
                        output_id = sha256(json_bytes([source.id, document_id, number])).hexdigest()
                        reference = {"source": source.id, "id": output_id, "split": split}
                        duplicate = index.check_and_add(key if number is None else normalization.match_key(unit), reference)
                        if duplicate is not None:
                            remove(record, [duplicate.reason], duplicate)
                            continue
                        if split == "development" and source.language is not None and label in LANGUAGES:
                            matrix[source.language][label] += 1
                        payload = {"text": unit} if turns is None else {"turns": turns}
                        shards[split].write(json_bytes({**record, "id": output_id, **payload}))
                        languages[label]["kept"] += 1

        confusion = {
            "labels": list(LANGUAGES),
            "matrix": matrix,
            "total": sum(sum(row.values()) for row in matrix.values()),
            "correct": sum(matrix[label][label] for label in LANGUAGES),
        }
        confusion_artifact.write(json_bytes(confusion))

    manifest = {
        "schema_version": SCHEMA_VERSION,
        "fixture_mode": config.fixture_mode,
        "inputs": {
            "config": {"path": config.path.name, "sha256": config.sha256},
            "sources": [source.evidence(base) for source in config.sources],
            "frozen_evaluations": [
                {**entry, "path": evaluation_paths[entry["path"]]} for entry in evaluation.evidence
            ],
            "prior_manifests": [{**entry, "path": prior_paths[entry["path"]]} for entry in prior_evidence],
            "license_allow_list_sha256": config.license_allow_list_sha256,
        },
        "filter_versions": {
            "normalization": normalization.VERSION,
            "unicode_database": unicodedata.unidata_version,
            "language": language.VERSION,
            "quality": quality.VERSION,
            "deduplication": dedup.DEDUP_VERSION,
            "contamination": contamination.CONTAMINATION_VERSION,
        },
        "code_sha256": {path.name: file_sha256(path) for path in sorted(Path(__file__).parent.glob("*.py"))},
        "parameters": {
            "assistant_end_marker": config.assistant_end_marker,
            "quality": asdict(config.quality),
            "contamination_span_tokens": config.contamination_span_tokens,
            "near_duplicate_threshold": config.near_duplicate_threshold,
            "deduplication": {
                "shingle_tokens": dedup.SHINGLE_TOKENS,
                "minhash_bands": dedup.MINHASH_BANDS,
                "minhash_rows": dedup.MINHASH_ROWS,
            },
            "language": {"ngram_widths": language.NGRAM_WIDTHS, "laplace_alpha": language.LAPLACE_ALPHA},
        },
        "counts": {
            "input_documents": input_documents,
            "languages": languages,
            "reasons": dict(sorted(reason_counts.items())),
            "contamination_hits": hits.records,
        },
        "shards": [{"split": split, **artifact.evidence()} for split, artifact in shards.items()],
        "audits": [artifact.evidence() for artifact in (removals, hits, confusion_artifact)],
    }
    data = json_bytes(manifest)
    if not dry_run:
        run = {
            "started_at": started,
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "argv": list(command),
            "command": join(command),
            "output": str(output),
            "manifest_sha256": sha256(data).hexdigest(),
            "raw_outputs": [str(output / entry["path"]) for entry in [*manifest["shards"], *manifest["audits"]]],
        }
        for name, content in (
            ("run.json", json_bytes(run)),
            ("report.ar.md", _summary(manifest, run, confusion).encode("utf-8")),
            ("manifest.json", data),
        ):
            with (output / name).open("xb") as stream:
                stream.write(content)
    return data
