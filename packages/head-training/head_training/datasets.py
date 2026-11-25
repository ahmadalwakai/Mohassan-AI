"""Download and normalize pinned, human-labelled public supervision."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tarfile
import tempfile
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.request import urlopen

from .dataset_catalog import CATALOG, TASKS, DatasetCard, SourceSpec
from .v2_exclusion import MANIFEST_SHA256, ExclusionReceipt, load_registry

__all__ = ["CATALOG", "TASKS", "Dataset", "DatasetCard", "Example", "SourceFile", "load_dataset"]

_PUBLIC_SPLIT = {"train": "train", "dev": "dev", "val": "dev", "validation": "dev", "test": "test"}
_SENTENCE_BREAK = re.compile(r"(?<=[.!?؟。！？])\s+|\n+")
_NITE = "{http://nite.sourceforge.net/}"
_ID_REF = re.compile(r"id\(([^)]+)\)")
_SCHEMA = "head-training.public-data.v2"
_QUAC_ID = re.compile(r"quac:(C_[a-f0-9]+_\d+)_q#(\d+)")
_TYDI_ID = re.compile(r"-?[0-9]+-[0-9]+")


@dataclass(frozen=True)
class Example:
    id: str
    source: str
    upstream_split: str
    group: str
    language: str
    task: str
    text: str
    label: str | None = None
    history: tuple[str, ...] = ()
    candidates: tuple[str, ...] = ()
    gold: tuple[int, ...] = ()
    source_partition: str = ""
    source_ref: str = ""
    document_title: str = ""


@dataclass(frozen=True)
class SourceFile:
    filename: str
    url: str
    sha256: str
    size_bytes: int
    cached_at: str


@dataclass(frozen=True)
class Dataset:
    card: DatasetCard
    provenance: tuple[SourceFile, ...]
    examples: tuple[Example, ...]
    fingerprint: str
    loader_sha256: str
    catalog_sha256: str
    exclusion: ExclusionReceipt


def _sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _download(spec: SourceSpec, directory: Path, *, allow_download: bool) -> tuple[Path, SourceFile]:
    path = directory / spec.filename
    if not path.exists():
        if not allow_download:
            raise FileNotFoundError(path)
        directory.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=directory, prefix=".download-", delete=False) as output:
            temporary = Path(output.name)
        try:
            with urlopen(spec.url, timeout=90) as response, temporary.open("wb") as output:
                shutil.copyfileobj(response, output)
            if _sha256(temporary) != spec.sha256:
                raise ValueError(f"Source SHA-256 mismatch for {spec.filename}")
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
    if _sha256(path) != spec.sha256:
        raise ValueError(f"Cached source SHA-256 mismatch: {path}")
    stat = path.stat()
    cached_at = datetime.fromtimestamp(stat.st_mtime, tz=UTC).isoformat()
    return path, SourceFile(spec.filename, spec.url, spec.sha256, stat.st_size, cached_at)


def _fold(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def _article_key(language: str, title: str) -> str:
    return f"wikipedia:{language}:{_fold(title.replace('_', ' '))}"


def _example(
    card: DatasetCard,
    task: str,
    partition: str,
    key: str,
    group: str,
    language: str,
    text: str,
    source_ref: str,
    *,
    document_title: str = "",
    label: str | None = None,
    history: tuple[str, ...] = (),
    candidates: tuple[str, ...] = (),
    gold: tuple[int, ...] = (),
) -> Example:
    local_split = "unsplit" if card.name in {"xquad", "mlqa", "ami"} else _PUBLIC_SPLIT[partition.removeprefix("oos_")]
    if not text.strip():
        raise ValueError(f"{card.name} has an empty input in {partition}: {key}")
    return Example(
        id=f"{card.name}:{key}",
        source=card.name,
        upstream_split=local_split,
        group=group,
        language=language,
        task=task,
        text=text,
        label=label,
        history=history,
        candidates=candidates,
        gold=gold,
        source_partition=partition,
        source_ref=source_ref,
        document_title=document_title,
    )


def _clinc(
    card: DatasetCard, task: str, paths: tuple[Path, ...]
) -> Iterator[Example]:
    source = json.loads(paths[0].read_text(encoding="utf-8"))
    domains_data = json.loads(paths[1].read_text(encoding="utf-8")) if task == "route" else {}
    domains = {intent: domain for domain, intents in domains_data.items() for intent in intents}
    for split, rows in sorted(source.items()):
        out_of_scope = split.startswith("oos_")
        if out_of_scope and task != "out_of_scope":
            continue
        for index, (text, intent) in enumerate(rows):
            key = f"{split}:{index}"
            if task == "out_of_scope":
                label = "out_of_scope" if out_of_scope else "in_scope"
            else:
                label = domains[intent] if task == "route" else intent
            group = hashlib.sha256(_fold(text).encode("utf-8")).hexdigest()
            yield _example(card, task, split, key, f"clinc:{group}", "en", text, paths[0].name, label=label)


def _massive(
    card: DatasetCard, task: str, paths: tuple[Path, ...]
) -> Iterator[Example]:
    members = {"1.1/data/ar-SA.jsonl": "ar", "1.1/data/en-US.jsonl": "en"}
    with tarfile.open(paths[0], "r|gz") as archive:
        found = set()
        for member in archive:
            if member.name not in members:
                continue
            stream = archive.extractfile(member)
            if stream is None or not member.isfile():
                raise ValueError(f"Expected MASSIVE file {member.name}")
            found.add(member.name)
            language = members[member.name]
            with stream:
                for line in stream:
                    row = json.loads(line)
                    key = str(row["id"])
                    yield _example(
                        card,
                        task,
                        row["partition"],
                        f"{language}:{key}",
                        f"massive:{key}",
                        language,
                        row["utt"],
                        f"{paths[0].name}:{member.name}",
                        label=row["intent" if task == "intent" else "scenario"],
                    )
        if found != members.keys():
            raise ValueError("MASSIVE is missing an Arabic or English release member")


def _canard_partitions(path: Path) -> Iterator[tuple[str, str, list[dict[str, Any]]]]:
    with zipfile.ZipFile(path) as archive:
        for partition in ("train", "dev", "test"):
            member = f"CANARD_Release/{partition}.json"
            with archive.open(member) as handle:
                yield partition, member, json.load(handle)


def _canard_questions(path: Path) -> dict[tuple[str, int], str]:
    questions: dict[tuple[str, int], str] = {}
    for _, _, rows in _canard_partitions(path):
        for row in rows:
            key = (row["QuAC_dialog_id"], row["Question_no"])
            question = row["Question"]
            if questions.setdefault(key, question) != question:
                raise ValueError("Conflicting questions in pinned CANARD alias source")
    return questions


def _canard(
    card: DatasetCard, task: str, paths: tuple[Path, ...]
) -> Iterator[Example]:
    for partition, member, rows in _canard_partitions(paths[0]):
        by_dialogue: dict[str, list[str]] = defaultdict(list)
        for row in rows:
            by_dialogue[row["QuAC_dialog_id"]].append(row["Rewrite"])
        for row in rows:
            question, rewrite = row["Question"], row["Rewrite"]
            dialogue = row["QuAC_dialog_id"]
            key = f"{dialogue}:{row['Question_no']}"
            common = (card, task, partition, key, f"quac:{dialogue}", "en", question, f"{paths[0].name}:{member}")
            history = tuple(row["History"])
            if task == "turn_type":
                label = "rewritten" if _fold(question) != _fold(rewrite) else "unchanged"
                yield _example(*common, label=label, history=history)
                continue
            # Negatives are human-written turns from this conversation, plus the original if it differs.
            choices = {_fold(rewrite): rewrite}
            for candidate in (question, *by_dialogue[dialogue]):
                choices.setdefault(_fold(candidate), candidate)
            if len(choices) < 2:
                continue
            # Stable per-example shuffling keeps the correct candidate from having a fixed position.
            ordered = tuple(sorted(choices.values(), key=lambda c: hashlib.sha256(f"{key}\0{c}".encode()).digest()))
            yield _example(*common, history=history, candidates=ordered, gold=(ordered.index(rewrite),))


def _quac(
    card: DatasetCard, task: str, paths: tuple[Path, ...]
) -> Iterator[Example]:
    labels = {"y": "follow_up", "n": "avoid_follow_up", "m": "maybe_follow_up"}
    for partition, path in zip(("train", "val"), paths, strict=True):
        articles = json.loads(path.read_text(encoding="utf-8"))["data"]
        for article in articles:
            for paragraph in article["paragraphs"]:
                group = f"quac:{paragraph['id']}"
                history = [article["title"], article["section_title"]]
                for qa in paragraph["qas"]:
                    yield _example(
                        card, task, partition, qa["id"], group, "en", qa["question"], path.name,
                        label=labels[qa["followup"]], history=tuple(history), document_title=article["title"],
                    )
                    history.extend((qa["question"], qa["orig_answer"]["text"]))


def _sentence_spans(context: str) -> Iterator[tuple[int, int]]:
    # Matches the punctuation/whitespace convention of scripts/answer-select/make_sentence_data.py.
    start = 0
    for match in _SENTENCE_BREAK.finditer(context):
        if context[start:match.start()].strip():
            yield start, match.start()
        start = match.end()
    if context[start:].strip():
        yield start, len(context)


def _answer_ranges(context: str, answers: Iterable[dict[str, Any]]) -> Iterator[tuple[int, int]]:
    for answer in answers:
        start = answer["answer_start"]
        text = answer["text"]
        if not text.strip():
            continue
        if start < 0 or context[start:start + len(text)] != text:
            # ARCD has a few shifted offsets. A unique literal match repairs those safely.
            start = context.find(text)
            if start < 0 or context.find(text, start + 1) >= 0:
                continue
        yield start, start + len(text)


def _selection(
    context: str, answers: Iterable[dict[str, Any]],
) -> tuple[tuple[str, ...], tuple[int, ...]]:
    ranges = tuple(_answer_ranges(context, answers))
    positions: dict[str, int] = {}
    candidates: list[str] = []
    gold = set()
    # Keep source spelling and order while coalescing normalized repetitions.
    for start, end in _sentence_spans(context):
        sentence = " ".join(context[start:end].split())
        normalized = _fold(sentence)
        if normalized not in positions:
            positions[normalized] = len(candidates)
            candidates.append(sentence)
        if any(start <= a and b <= end for a, b in ranges):
            gold.add(positions[normalized])
    return tuple(candidates), tuple(sorted(gold))


def _qa_example(
    card: DatasetCard,
    task: str,
    partition: str,
    language: str,
    title: str,
    group: str,
    source_ref: str,
    context: str,
    qa: dict[str, Any],
) -> Iterator[Example]:
    common = (card, task, partition, f"{language}:{qa['id']}", group, language, qa["question"], source_ref)
    if task == "sufficiency":
        yield _example(
            *common, document_title=title, label="insufficient" if qa["is_impossible"] else "sufficient",
            history=(context,),
        )
        return
    if qa.get("is_impossible"):
        return
    candidates, gold = _selection(context, qa["answers"])
    if gold and len(gold) < len(candidates):
        yield _example(*common, document_title=title, candidates=candidates, gold=gold)


def _squad_rows(
    card: DatasetCard,
    task: str,
    partition: str,
    language: str,
    source_ref: str,
    source: dict[str, Any],
    *,
    english_titles: dict[str, str] | None = None,
) -> Iterator[Example]:
    for article in source["data"]:
        title = article["title"]
        group = _article_key("en" if card.name == "xquad" else language, title)
        if english_titles is not None:
            aligned = {
                english_titles[qa["id"]]
                for paragraph in article["paragraphs"]
                for qa in paragraph["qas"]
                if qa["id"] in english_titles
            }
            if len(aligned) > 1:
                raise ValueError(f"MLQA article {title} maps to multiple English articles")
            if aligned:
                group = _article_key("en", next(iter(aligned)))
        for paragraph in article["paragraphs"]:
            for qa in paragraph["qas"]:
                yield from _qa_example(card, task, partition, language, title, group, source_ref, paragraph["context"], qa)


def _squad_files(
    card: DatasetCard, task: str, paths: tuple[Path, ...]
) -> Iterator[Example]:
    layouts = {
        "xquad": (("validation", "ar"), ("validation", "en")),
        "squad2": (("train", "en"), ("dev", "en")),
        "arcd": (("train", "ar"), ("test", "ar")),
    }
    for (partition, language), path in zip(layouts[card.name], paths, strict=True):
        yield from _squad_rows(card, task, partition, language, path.name, json.loads(path.read_text(encoding="utf-8")))


def _mlqa(
    card: DatasetCard, task: str, paths: tuple[Path, ...]
) -> Iterator[Example]:
    with zipfile.ZipFile(paths[0]) as archive:
        for partition in ("dev", "test"):
            english_titles = {}
            for language in ("en", "ar"):
                member = f"MLQA_V1/{partition}/{partition}-context-{language}-question-{language}.json"
                with archive.open(member) as handle:
                    source = json.load(handle)
                if language == "en":
                    english_titles = {
                        qa["id"]: article["title"]
                        for article in source["data"]
                        for paragraph in article["paragraphs"]
                        for qa in paragraph["qas"]
                    }
                yield from _squad_rows(
                    card, task, partition, language, f"{paths[0].name}:{member}", source,
                    english_titles=english_titles if language == "ar" else None,
                )


def _tydi(
    card: DatasetCard, task: str, paths: tuple[Path, ...]
) -> Iterator[Example]:
    from pyarrow import parquet  # type: ignore[import-untyped]

    languages = {"arabic": "ar", "english": "en"}
    for partition, path in zip(("train", "validation"), paths, strict=True):
        for batch in parquet.ParquetFile(path).iter_batches(batch_size=2048):
            for row in batch.to_pylist():
                language = languages.get(row["id"].partition("-")[0])
                if language is None:
                    continue
                answers = [
                    {"answer_start": start, "text": text}
                    for start, text in zip(row["answers"]["answer_start"], row["answers"]["text"], strict=True)
                ]
                yield from _qa_example(
                    card, task, partition, language, row["title"], _article_key(language, row["title"]),
                    path.name, row["context"], {"id": row["id"], "question": row["question"], "answers": answers},
                )


def _ami(
    card: DatasetCard, task: str, paths: tuple[Path, ...]
) -> Iterator[Example]:
    with zipfile.ZipFile(paths[0]) as archive:
        ontology = ET.fromstring(archive.read("ontologies/da-types.xml"))
        types = {node.attrib[_NITE + "id"]: node.attrib["name"] for node in ontology.iter("da-type")}
        for member in sorted(archive.namelist()):
            if not (member.startswith("dialogueActs/") and member.endswith(".dialog-act.xml")):
                continue
            speaker = Path(member).name.removesuffix(".dialog-act.xml")
            meeting = speaker.split(".")[0]
            # The four sessions in a single scenario series share participants and topic.
            series = re.sub(r"(?<=\d)[a-d]$", "", meeting)
            words = ET.fromstring(archive.read(f"words/{speaker}.words.xml"))
            word_list = list(words)
            word_positions = {node.attrib[_NITE + "id"]: index for index, node in enumerate(word_list)}
            acts = ET.fromstring(archive.read(member))
            for act in acts.findall("dact"):
                label_nodes = [pointer for pointer in act.findall(_NITE + "pointer") if pointer.get("role") == "da-aspect"]
                if not label_nodes:
                    continue
                refs = _ID_REF.findall(label_nodes[0].attrib["href"])
                label = types[refs[0]]
                text_parts: list[str] = []
                for child in act.findall(_NITE + "child"):
                    child_refs = _ID_REF.findall(child.attrib["href"])
                    start, end = word_positions[child_refs[0]], word_positions[child_refs[-1]]
                    text_parts.extend(node.text for node in word_list[start:end + 1] if node.tag == "w" and node.text)
                if text_parts:
                    yield _example(
                        card, task, "unsplit", act.attrib[_NITE + "id"], f"ami:{series}", "en", " ".join(text_parts),
                        f"{paths[0].name}:{member}", label=label, document_title=meeting,
                    )


_LOADERS = {
    "clinc150": _clinc,
    "massive": _massive,
    "canard": _canard,
    "quac": _quac,
    "xquad": _squad_files,
    "mlqa": _mlqa,
    "tydiqa": _tydi,
    "arcd": _squad_files,
    "squad2": _squad_files,
    "ami": _ami,
}


def _source_ids(
    example: Example, canard_questions: Mapping[tuple[str, int], str],
) -> tuple[str, tuple[str, ...]]:
    source_id = example.id
    if example.source == "massive":
        _, language, key = source_id.split(":", 2)
        locale = {"ar": "ar-SA", "en": "en-US"}[language]
        return f"massive:{locale}:{key}", ()
    if example.source == "tydiqa":
        _, language, source_key = source_id.split(":", 2)
        prefix = {"ar": "arabic-", "en": "english-"}[language]
        key = source_key.removeprefix(prefix)
        if key == source_key or _TYDI_ID.fullmatch(key) is None:
            raise ValueError("Unexpected TyDi QA question ID in pinned data")
        return f"tydiqa:{key}:{language}", ()
    if example.source == "quac" and (match := _QUAC_ID.fullmatch(source_id)):
        dialogue, index = match.groups()
        number = int(index) + 1
        if example.group == f"quac:{dialogue}" and canard_questions.get((dialogue, number)) == example.text:
            return source_id, (f"canard:{dialogue}:{number}",)
    return source_id, ()


def load_dataset(name: str, task: str, cache_dir: Path, *, allow_download: bool = True) -> Dataset:
    """Load a pinned public source and remove v2 overlaps before returning examples."""
    card = CATALOG.get(name)
    if card is None or task not in card.tasks:
        raise ValueError(f"Unsupported public dataset/task: {name}/{task}")
    registry = load_registry()
    specs = card.files[:1] if name == "clinc150" and task != "route" else card.files
    resources = [_download(spec, cache_dir / name, allow_download=allow_download) for spec in specs]
    paths = tuple(path for path, _ in resources)
    canard_questions = {}
    if name == "quac":
        alias_path, alias_source = _download(CATALOG["canard"].files[0], cache_dir / "canard", allow_download=allow_download)
        canard_questions = _canard_questions(alias_path)
        resources.append((alias_path, alias_source))
    provenance = tuple(source for _, source in resources)
    ids: set[str] = set()
    kept: list[Example] = []
    for example in _LOADERS[name](card, task, paths):
        if example.id in ids:
            raise ValueError(f"{name}/{task} yielded duplicate example IDs")
        ids.add(example.id)
        source_id, aliases = _source_ids(example, canard_questions)
        if not registry.matches((example.text, *example.history, *example.candidates),
                                source_id=source_id, source_ids=aliases):
            kept.append(example)
    if not ids:
        raise ValueError(f"{name}/{task} yielded zero rows")
    examples = tuple(sorted(kept, key=lambda example: example.id))
    receipt = ExclusionReceipt(MANIFEST_SHA256, len(ids), len(ids) - len(examples))
    fingerprint = hashlib.sha256()
    for value in (_SCHEMA, name, card.revision, task, receipt.manifest_sha256,
                  str(receipt.input_rows), str(receipt.dropped_rows), *(source.sha256 for source in provenance)):
        fingerprint.update(value.encode("utf-8") + b"\n")
    for example in examples:
        row = json.dumps(asdict(example), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        fingerprint.update(row.encode("utf-8") + b"\n")
    loader_path = Path(__file__)
    return Dataset(
        replace(card, exclusion=receipt), provenance, examples, fingerprint.hexdigest(), _sha256(loader_path),
        _sha256(loader_path.with_name("dataset_catalog.py")), receipt,
    )
