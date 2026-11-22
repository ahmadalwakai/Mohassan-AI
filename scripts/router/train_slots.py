"""Inactive own slot-span tagger experiment using local PUBLIC MASSIVE only.

No owner messages, other router/assessment data, pretrained models, external
inference or network are inputs. Annotation alignment is exact and source-bound.
Offsets are half-open Unicode codepoints plus explicitly converted UTF-16 units.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import math
import os
import random
import re
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
PUBLIC_DATA = ROOT / ".data/router/download/1.1/data"
OUTPUT = ROOT / "artifacts/brain-slot-development-v1"
SLOTS = ("place", "date", "time", "time_of_day", "time_zone", "news_topic")
SLOT_MAPPING = {"place_name": "place", "date": "date", "time": "time", "timeofday": "time_of_day", "time_zone": "time_zone", "news_topic": "news_topic"}
TAGS = ("O", *(tag for slot in SLOTS for tag in (f"B-{slot}", f"I-{slot}")))
TAG_ID = {tag: index for index, tag in enumerate(TAGS)}
PARTITIONS = ("train", "dev", "calibration", "test")
MAX_TEXT = 512
MAX_TOKENS = 80
MAX_ROWS = 40_000
MAX_SOURCE_BYTES = 64 * 1024 * 1024
MAX_LINE_BYTES = 64 * 1024
MARKER = re.compile(r"\[([A-Za-z][A-Za-z0-9_]*)\s*:\s*")
TOKEN = re.compile(r"\w+|[^\w\s]", re.UNICODE)
MODEL_FORMAT = "mohassan-slot-gru-v1"


def sha(value: str | bytes) -> str:
    return hashlib.sha256(value.encode("utf-8") if isinstance(value, str) else value).hexdigest()


def stable(value: str) -> int:
    return int(sha(value)[:8], 16)


def json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def fold(value: str) -> str:
    text = unicodedata.normalize("NFC", value)
    text = re.sub(r"[\u0640\u064b-\u065f\u0670]", "", text)
    text = re.sub(r"[أإآٱ]", "ا", text).replace("ى", "ي").replace("ة", "ه")
    text = text.translate(str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789"))
    return re.sub(r"\s+", " ", text.lower()).strip()


def canonical(value: str) -> str:
    return " ".join("".join(char if char.isalnum() or char.isspace() else " " for char in fold(value)).split())


def utf16_offset(text: str, codepoint: int) -> int:
    if type(codepoint) is not int or not 0 <= codepoint <= len(text):
        raise ValueError("invalid_codepoint_offset")
    return len(text[:codepoint].encode("utf-16-le")) // 2


@dataclass(frozen=True)
class Token:
    text: str
    start_cp: int
    end_cp: int


@dataclass(frozen=True)
class Span:
    label: str
    start_cp: int
    end_cp: int
    text: str
    original_label: str = ""

    def projection(self, utterance: str) -> dict[str, Any]:
        if self.label not in SLOTS or type(self.start_cp) is not int or type(self.end_cp) is not int or not 0 <= self.start_cp < self.end_cp <= len(utterance) or utterance[self.start_cp:self.end_cp] != self.text:
            raise ValueError("span_source_mismatch")
        return {"label": self.label, "startCodepoint": self.start_cp, "endCodepoint": self.end_cp,
                "startUtf16": utf16_offset(utterance, self.start_cp), "endUtf16": utf16_offset(utterance, self.end_cp), "text": self.text}


def tokenize(text: str) -> tuple[Token, ...]:
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT or any(0xD800 <= ord(char) <= 0xDFFF for char in text):
        raise ValueError("utterance_bounds_or_unicode")
    tokens = tuple(Token(match[0], match.start(), match.end()) for match in TOKEN.finditer(text))
    if not tokens or len(tokens) > MAX_TOKENS:
        raise ValueError("token_count_bounds")
    return tokens


def align_annotation(utterance: str, annotated: str, intent: str = "") -> tuple[Span, ...]:
    """Strip bracket markup and require exact reconstruction, never substring search.

    Repeated entities stay attached to their annotated occurrence. No Unicode
    normalization, fuzzy matching or whitespace repair is used for alignment.
    """
    tokenize(utterance)
    if not isinstance(annotated, str) or len(annotated) > 4096:
        raise ValueError("annotation_bounds")
    cursor = 0
    reconstructed = ""
    spans: list[Span] = []
    while cursor < len(annotated):
        opening = annotated.find("[", cursor)
        if opening < 0:
            remainder = annotated[cursor:]
            if "]" in remainder:
                raise ValueError("unbalanced_annotation")
            reconstructed += remainder
            break
        prefix = annotated[cursor:opening]
        if "]" in prefix:
            raise ValueError("unbalanced_annotation")
        reconstructed += prefix
        marker = MARKER.match(annotated, opening)
        if not marker:
            raise ValueError("ambiguous_annotation_bracket")
        closing = annotated.find("]", marker.end())
        if closing < 0 or "[" in annotated[marker.end():closing]:
            raise ValueError("nested_or_unclosed_annotation")
        surface = annotated[marker.end():closing]
        if not surface or surface != surface.strip():
            raise ValueError("ambiguous_annotation_boundary")
        start = len(reconstructed)
        reconstructed += surface
        source_label = marker.group(1)
        label = SLOT_MAPPING.get(source_label)
        if label and (label != "news_topic" or intent == "news_query"):
            spans.append(Span(label, start, len(reconstructed), surface, source_label))
        cursor = closing + 1
    if reconstructed != utterance:
        raise ValueError("annotation_reconstruction_mismatch")
    for span in spans:
        span.projection(utterance)
    return tuple(spans)


def spans_to_bio(text: str, tokens: tuple[Token, ...], spans: tuple[Span, ...]) -> tuple[int, ...]:
    tags = [0] * len(tokens)
    occupied: set[int] = set()
    for span in spans:
        span.projection(text)
        indices = [index for index, token in enumerate(tokens) if token.start_cp >= span.start_cp and token.end_cp <= span.end_cp]
        if not indices or tokens[indices[0]].start_cp != span.start_cp or tokens[indices[-1]].end_cp != span.end_cp:
            raise ValueError("annotation_inside_token_boundary")
        if any(index in occupied for index in indices):
            raise ValueError("overlapping_gold_spans")
        for position, index in enumerate(indices):
            tags[index] = TAG_ID[f"{'B' if position == 0 else 'I'}-{span.label}"]
            occupied.add(index)
    return tuple(tags)


def legal_bio(tags: list[int] | tuple[int, ...]) -> bool:
    previous = "O"
    for identity in tags:
        if type(identity) is not int or not 0 <= identity < len(TAGS):
            return False
        current = TAGS[identity]
        if current.startswith("I-") and previous not in (f"B-{current[2:]}", current):
            return False
        previous = current
    return True


def bio_to_spans(text: str, tokens: tuple[Token, ...], tags: list[int] | tuple[int, ...]) -> tuple[Span, ...]:
    if len(tags) != len(tokens) or not legal_bio(tags):
        raise ValueError("illegal_bio_sequence")
    output: list[Span] = []
    index = 0
    while index < len(tags):
        tag = TAGS[tags[index]]
        if tag == "O":
            index += 1
            continue
        label = tag[2:]
        start = index
        index += 1
        while index < len(tags) and TAGS[tags[index]] == f"I-{label}":
            index += 1
        start_cp, end_cp = tokens[start].start_cp, tokens[index - 1].end_cp
        span = Span(label, start_cp, end_cp, text[start_cp:end_cp])
        span.projection(text)
        output.append(span)
    return tuple(output)


@dataclass(frozen=True)
class SlotRow:
    id: str
    group_id: str
    text: str
    locale: str
    partition: str
    intent: str
    tokens: tuple[Token, ...]
    spans: tuple[Span, ...]
    tags: tuple[int, ...]

    def validate(self) -> None:
        if not self.id or len(self.id) > 180 or not self.group_id or len(self.group_id) > 180 or self.locale not in ("ar-SA", "en-US") or self.partition not in PARTITIONS:
            raise ValueError("row_identity_or_partition")
        if self.tokens != tokenize(self.text) or self.tags != spans_to_bio(self.text, self.tokens, self.spans):
            raise ValueError("row_alignment_mismatch")


def load_public(directory: Path = PUBLIC_DATA) -> tuple[list[SlotRow], dict[str, Any]]:
    rows: list[SlotRow] = []
    rejected: Counter[str] = Counter()
    by_locale: dict[str, Counter[str]] = defaultdict(Counter)
    source_counts: Counter[str] = Counter()
    topic_excluded = 0
    for locale in ("ar-SA", "en-US"):
        path = directory / f"{locale}.jsonl"
        if path.stat().st_size > MAX_SOURCE_BYTES:
            raise ValueError("public_file_bounds")
        with path.open("rb") as handle:
            for line in handle:
                if len(line) > MAX_LINE_BYTES:
                    raise ValueError("public_line_bounds")
                item = json.loads(line)
                if item.get("locale") != locale or item.get("partition") not in ("train", "dev", "test"):
                    raise ValueError("public_identity_or_partition")
                source_counts[locale] += 1
                try:
                    text, annotated = item["utt"], item["annot_utt"]
                    if item["intent"] != "news_query":
                        topic_excluded += len(re.findall(r"\[news_topic\s*:", annotated))
                    tokens = tokenize(text)
                    spans = align_annotation(text, annotated, item["intent"])
                    tags = spans_to_bio(text, tokens, spans)
                except (ValueError, KeyError) as error:
                    rejected[str(error)] += 1
                    by_locale[locale][str(error)] += 1
                    continue
                identity = str(item["id"])
                if not identity or len(identity) > 80:
                    raise ValueError("public_id_bounds")
                group = f"massive:{identity}"
                partition = item["partition"]
                if partition == "dev":
                    partition = "dev" if stable(f"slot-calibration:{group}") % 2 == 0 else "calibration"
                row = SlotRow(f"{group}:{locale}", group, text, locale, partition, item["intent"], tokens, spans, tags)
                row.validate()
                rows.append(row)
                if len(rows) > MAX_ROWS:
                    raise ValueError("public_row_bounds")
    return rows, {"sourceRows": dict(source_counts), "acceptedRows": len(rows), "rejectedRows": dict(rejected),
                  "rejectedByLocale": {locale: dict(counts) for locale, counts in by_locale.items()},
                  "acceptedSpans": dict(Counter(span.label for row in rows for span in row.spans)),
                  "outOfScopeNewsTopicAnnotationsExcluded": topic_excluded,
                  "topicScope": "news_topic only when explicitly annotated in news_query; no generic topic labels"}


def split_public(rows: list[SlotRow], max_train: int = 10000, max_other: int = 4000, negative_ratio: float = 0.5) -> tuple[dict[str, list[SlotRow]], dict[str, Any]]:
    if not rows or len(rows) > MAX_ROWS or not 100 <= max_train <= 25000 or not 100 <= max_other <= 10000 or not 0 <= negative_ratio <= 2:
        raise ValueError("split_bounds")
    groups: dict[str, list[SlotRow]] = defaultdict(list)
    seen: set[str] = set()
    for row in rows:
        row.validate()
        if row.id in seen:
            raise ValueError("duplicate_row_identity")
        seen.add(row.id)
        groups[row.group_id].append(row)
    if any(len({row.partition for row in group}) != 1 for group in groups.values()):
        raise ValueError("translation_group_crosses_partition")
    canonical_groups: dict[str, set[str]] = defaultdict(set)
    feature_targets: dict[str, set[tuple[int, ...]]] = defaultdict(set)
    feature_groups: dict[str, set[str]] = defaultdict(set)
    for row in rows:
        canonical_groups[sha(canonical(row.text))].add(row.group_id)
        features = sha(json_bytes([(fold(token.text), token_flags(token)) for token in row.tokens]))
        feature_targets[features].add(row.tags)
        feature_groups[features].add(row.group_id)
    excluded: set[str] = set()
    collision_count = 0
    for members in canonical_groups.values():
        if len({groups[group][0].partition for group in members}) > 1:
            excluded.update(members)
            collision_count += 1
    inconsistent = 0
    for identity, targets in feature_targets.items():
        if len(targets) > 1:
            excluded.update(feature_groups[identity])
            inconsistent += 1
    splits = {partition: [] for partition in PARTITIONS}
    for partition in PARTITIONS:
        available = [group for name, group in groups.items() if name not in excluded and group[0].partition == partition]
        positive = sorted([group for group in available if any(row.spans for row in group)], key=lambda group: (stable(group[0].group_id), group[0].group_id))
        negative = sorted([group for group in available if not any(row.spans for row in group)], key=lambda group: (stable(group[0].group_id), group[0].group_id))
        cap = max_train if partition == "train" else max_other
        chosen: list[SlotRow] = []
        # Reserve a bounded negative pool without splitting translation families.
        positive_cap = int(cap / (1 + negative_ratio)) if negative_ratio else cap
        for group in positive:
            if len(chosen) + len(group) <= positive_cap:
                chosen.extend(group)
        negative_cap = min(cap - len(chosen), int(len(chosen) * negative_ratio))
        negatives: list[SlotRow] = []
        for group in negative:
            if len(negatives) + len(group) <= negative_cap:
                negatives.extend(group)
        splits[partition] = sorted(chosen + negatives, key=lambda row: row.id)
    assert_splits(splits)
    return splits, {"inputRows": len(rows), "selectedRows": sum(map(len, splits.values())), "excludedGroups": len(excluded),
                    "canonicalCrossPartitionCollisions": collision_count, "contradictoryFeatureSignatures": inconsistent,
                    "excludedGroupHashes": sorted(sha(group) for group in excluded),
                    "counts": {partition: {"rows": len(part), "groups": len({row.group_id for row in part}), "positiveRows": sum(bool(row.spans) for row in part),
                               "locales": dict(Counter(row.locale for row in part)), "spans": dict(Counter(span.label for row in part for span in row.spans))} for partition, part in splits.items()}}


def assert_splits(splits: dict[str, list[SlotRow]]) -> None:
    group_seen: dict[str, str] = {}
    text_seen: dict[str, str] = {}
    for partition, rows in splits.items():
        if partition not in PARTITIONS:
            raise ValueError("invalid_split")
        for row in rows:
            if row.partition != partition:
                raise ValueError("row_partition_mismatch")
            text_hash = sha(canonical(row.text))
            if row.group_id in group_seen and group_seen[row.group_id] != partition or text_hash in text_seen and text_seen[text_hash] != partition:
                raise ValueError("split_leakage")
            group_seen[row.group_id] = partition
            text_seen[text_hash] = partition


def token_flags(token: Token) -> list[float]:
    value = token.text
    return [float(any("\u0600" <= char <= "\u06ff" for char in value)), float(any("a" <= char.lower() <= "z" for char in value)),
            float(any(char.isdigit() for char in value)), float(any(char.isupper() for char in value)),
            float(all(not char.isalnum() for char in value)), min(len(value), 20) / 20]


def token_features(token: Token, buckets: int) -> list[int]:
    if not 128 <= buckets <= 1 << 18 or buckets & (buckets - 1) or not token.text or len(token.text) > MAX_TEXT:
        raise ValueError("token_feature_bounds")
    text = f"^{fold(token.text)}$"
    values = [stable(f"token:{text}") % buckets]
    values.extend(stable(f"c{size}:{text[index:index + size]}") % buckets for size in (2, 3, 4) for index in range(max(0, len(text) - size + 1)))
    if len(values) > 1600:
        raise ValueError("token_feature_count")
    return values


@dataclass(frozen=True)
class SlotConfig:
    seed: int = 53
    buckets: int = 1 << 15
    dim: int = 24
    hidden: int = 32
    epochs: int = 5
    batch_size: int = 64
    learning_rate: float = 0.03
    threads: int = 4
    max_seconds: float = 300.0
    memory_limit_mb: int = 2048
    max_train: int = 10000
    max_other: int = 4000
    negative_ratio: float = 0.5
    target_precision: float = 0.90
    min_calibration_spans: int = 20

    def validate(self) -> None:
        if not 128 <= self.buckets <= 1 << 18 or self.buckets & (self.buckets - 1) or not 4 <= self.dim <= 64 or not 4 <= self.hidden <= 64:
            raise ValueError("model_config_bounds")
        if not 1 <= self.epochs <= 10 or not 4 <= self.batch_size <= 128 or not 1 <= self.threads <= 4 or not 0.001 <= self.learning_rate <= 0.1:
            raise ValueError("training_config_bounds")
        if not 1 <= self.max_seconds <= 300 or not 128 <= self.memory_limit_mb <= 2048 or not 0.5 < self.target_precision < 1 or not 1 <= self.min_calibration_spans <= 1000:
            raise ValueError("resource_or_calibration_bounds")
        if self.buckets * self.dim * 4 * 5 > self.memory_limit_mb * 1024 * 1024 // 2:
            raise ValueError("parameter_memory_bound")


def memory_mb() -> float:
    if os.name == "nt":
        class Counters(ctypes.Structure):
            _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong)] + [(name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        get_process = ctypes.windll.kernel32.GetCurrentProcess
        get_process.restype = ctypes.c_void_p
        get_memory = ctypes.windll.psapi.GetProcessMemoryInfo
        get_memory.argtypes = [ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_ulong]
        if not get_memory(get_process(), ctypes.byref(counters), counters.cb):
            raise RuntimeError("memory_measurement_unavailable")
        return counters.WorkingSetSize / 1024 / 1024
    import resource
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return value / (1024 * 1024 if sys.platform == "darwin" else 1024)


def make_model(config: SlotConfig):
    import torch
    import torch.nn as nn
    from torch.nn.utils.rnn import pack_padded_sequence, pad_packed_sequence, pad_sequence

    class SlotGRU(nn.Module):
        def __init__(self):
            super().__init__()
            self.embedding = nn.EmbeddingBag(config.buckets, config.dim, mode="mean")
            self.encoder = nn.GRU(config.dim + 6, config.hidden, batch_first=True, bidirectional=True)
            self.classifier = nn.Linear(config.hidden * 2, len(TAGS))

        def forward(self, ids, offsets, flags, lengths):
            flattened = self.embedding(ids, offsets)
            sequences = list(torch.split(flattened, lengths.tolist()))
            padded = pad_sequence(sequences, batch_first=True)
            features = torch.cat((padded, flags), dim=2)
            packed = pack_padded_sequence(features, lengths.cpu(), batch_first=True, enforce_sorted=False)
            encoded, _ = self.encoder(packed)
            encoded, _ = pad_packed_sequence(encoded, batch_first=True, total_length=flags.shape[1])
            return self.classifier(encoded)

    return SlotGRU()


def batch(rows: list[SlotRow], config: SlotConfig):
    import torch
    lengths = [len(row.tokens) for row in rows]
    maximum = max(lengths)
    features = [token_features(token, config.buckets) for row in rows for token in row.tokens]
    offsets, size = [], 0
    for values in features:
        offsets.append(size)
        size += len(values)
    flags = [([token_flags(token) for token in row.tokens] + [[0.0] * 6 for _ in range(maximum - len(row.tokens))]) for row in rows]
    labels = [list(row.tags) + [-100] * (maximum - len(row.tokens)) for row in rows]
    inputs = (torch.tensor([value for values in features for value in values], dtype=torch.long), torch.tensor(offsets, dtype=torch.long),
              torch.tensor(flags, dtype=torch.float32), torch.tensor(lengths, dtype=torch.long))
    return inputs, torch.tensor(labels, dtype=torch.long)


def sequence_logits(model, rows: list[SlotRow], config: SlotConfig) -> list[Any]:
    import torch
    model.eval()
    output = []
    with torch.no_grad():
        for start in range(0, len(rows), config.batch_size):
            chunk = rows[start:start + config.batch_size]
            inputs, _ = batch(chunk, config)
            logits = model(*inputs).numpy()
            output.extend(logits[index, :len(row.tokens)].copy() for index, row in enumerate(chunk))
    return output


def viterbi_decode(logits) -> list[int]:
    import numpy as np
    scores = np.asarray(logits, dtype=np.float64)
    if scores.ndim != 2 or scores.shape[1] != len(TAGS) or not 1 <= scores.shape[0] <= MAX_TOKENS or not np.isfinite(scores).all():
        raise ValueError("decoder_logits_bounds")
    transition = np.zeros((len(TAGS), len(TAGS)), dtype=np.float64)
    for current, tag in enumerate(TAGS):
        if tag.startswith("I-"):
            for previous, earlier in enumerate(TAGS):
                if earlier not in (f"B-{tag[2:]}", tag):
                    transition[previous, current] = -np.inf
    state = scores[0].copy()
    for index, tag in enumerate(TAGS):
        if tag.startswith("I-"):
            state[index] = -np.inf
    back = []
    for emission in scores[1:]:
        choices = state[:, None] + transition
        preceding = choices.argmax(axis=0)
        state = choices[preceding, np.arange(len(TAGS))] + emission
        back.append(preceding)
    result = [int(state.argmax())]
    for preceding in reversed(back):
        result.append(int(preceding[result[-1]]))
    result.reverse()
    if not legal_bio(result):
        raise RuntimeError("constrained_decoder_produced_illegal_bio")
    return result


def span_key(span: Span) -> tuple[str, int, int]:
    return span.label, span.start_cp, span.end_cp


def predictions(row: SlotRow, logits, temperature: float = 1.0) -> list[dict[str, Any]]:
    import numpy as np
    if not math.isfinite(temperature) or not 0 < temperature <= 100:
        raise ValueError("temperature_bounds")
    tags = viterbi_decode(logits)
    scaled = np.asarray(logits, dtype=np.float64) / temperature
    probability = np.exp(scaled - scaled.max(axis=1, keepdims=True))
    probability /= probability.sum(axis=1, keepdims=True)
    output = []
    for span in bio_to_spans(row.text, row.tokens, tags):
        indices = [index for index, token in enumerate(row.tokens) if token.start_cp >= span.start_cp and token.end_cp <= span.end_cp]
        confidence = min(float(probability[index, tags[index]]) for index in indices)
        output.append({"span": span, "confidence": confidence})
    return output


def metrics(rows: list[SlotRow], logits: list[Any], temperature: float = 1.0, thresholds: dict[str, float] | None = None) -> dict[str, Any]:
    if len(rows) != len(logits):
        raise ValueError("prediction_row_mismatch")
    per_slot = {slot: Counter() for slot in SLOTS}
    per_locale = {locale: Counter() for locale in ("ar-SA", "en-US")}
    per_slot_locale = {f"{locale}:{slot}": Counter() for locale in ("ar-SA", "en-US") for slot in SLOTS}
    exact = positive_exact = positives = accepted_utterances = raw_predictions = accepted_predictions = negative_fp = 0
    output = []
    for row, values in zip(rows, logits):
        proposed = predictions(row, values, temperature)
        selected = [item for item in proposed if thresholds is None or item["confidence"] >= thresholds.get(item["span"].label, 1.000001)]
        gold = {span_key(span) for span in row.spans}
        actual = {span_key(item["span"]) for item in selected}
        exact += actual == gold
        positives += bool(gold)
        positive_exact += bool(gold) and actual == gold
        accepted_utterances += bool(actual)
        raw_predictions += len(proposed)
        accepted_predictions += len(selected)
        negative_fp += not gold and bool(actual)
        for slot in SLOTS:
            expected = {key for key in gold if key[0] == slot}
            guessed = {key for key in actual if key[0] == slot}
            counts = {"tp": len(expected & guessed), "fp": len(guessed - expected), "fn": len(expected - guessed), "gold": len(expected), "predicted": len(guessed)}
            per_slot[slot].update(counts)
            per_locale[row.locale].update(counts)
            per_slot_locale[f"{row.locale}:{slot}"].update(counts)
        output.append({"rowHash": sha(row.id), "locale": row.locale, "gold": [list(key) for key in sorted(gold)],
                       "predictions": [{**item["span"].projection(row.text), "confidence": item["confidence"],
                                        "accepted": thresholds is None or item["confidence"] >= thresholds.get(item["span"].label, 1.000001)} for item in proposed]})
    def summary(counts):
        precision = counts["tp"] / (counts["tp"] + counts["fp"]) if counts["tp"] + counts["fp"] else None
        recall = counts["tp"] / (counts["tp"] + counts["fn"]) if counts["tp"] + counts["fn"] else None
        f1 = 2 * counts["tp"] / max(1, 2 * counts["tp"] + counts["fp"] + counts["fn"])
        return {**dict(counts), "precision": precision, "recall": recall, "exactSpanF1": f1}
    overall = Counter()
    for counts in per_slot.values():
        overall.update(counts)
    return {"rows": len(rows), "overall": summary(overall), "perSlot": {slot: summary(counts) for slot, counts in per_slot.items()},
            "perLocale": {locale: summary(counts) for locale, counts in per_locale.items()},
            "perSlotLocale": {key: summary(counts) for key, counts in per_slot_locale.items()},
            "utteranceExactAccuracy": exact / max(1, len(rows)), "positiveUtteranceExactAccuracy": positive_exact / max(1, positives),
            "rawPredictedSpans": raw_predictions, "acceptedSpans": accepted_predictions,
            "spanAcceptanceCoverage": accepted_predictions / raw_predictions if raw_predictions else 0.0,
            "utterancesWithAcceptedSpan": accepted_utterances, "negativeUtterancesWithFalsePositive": negative_fp,
            "predictions": output}


def train(splits: dict[str, list[SlotRow]], config: SlotConfig):
    import torch
    import torch.nn.functional as functional
    config.validate()
    torch.set_num_threads(config.threads)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    torch.use_deterministic_algorithms(True)
    torch.manual_seed(config.seed)
    rng = random.Random(config.seed)
    rows = list(splits["train"])
    dev = list(splits["dev"])
    if not rows or not dev:
        raise ValueError("train_and_dev_required")
    model = make_model(config)
    optimizer = torch.optim.Adagrad(model.parameters(), lr=config.learning_rate)
    counts = Counter(tag for row in rows for tag in row.tags)
    weights = torch.tensor([min(6.0, math.sqrt(counts[0] / max(1, counts[index]))) for index in range(len(TAGS))])
    started = time.monotonic()
    peak = memory_mb()
    best_score, best_epoch, best = -1.0, 0, None
    history = []
    timed_out = False
    for epoch in range(config.epochs):
        model.train()
        rng.shuffle(rows)
        total = processed = 0
        for start in range(0, len(rows), config.batch_size):
            if time.monotonic() - started > config.max_seconds:
                timed_out = True
                break
            peak = max(peak, memory_mb())
            if peak > config.memory_limit_mb:
                raise RuntimeError("memory_target_exceeded")
            chunk = rows[start:start + config.batch_size]
            inputs, labels = batch(chunk, config)
            loss = functional.cross_entropy(model(*inputs).reshape(-1, len(TAGS)), labels.reshape(-1), ignore_index=-100, weight=weights)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
            total += float(loss.item()) * len(chunk)
            processed += len(chunk)
        if not processed:
            break
        dev_metrics = metrics(dev, sequence_logits(model, dev, config))
        value = dev_metrics["overall"]["exactSpanF1"]
        record = {"epoch": epoch + 1, "loss": total / processed, "devExactSpanF1": value, "processedRows": processed}
        history.append(record)
        print(json.dumps(record), flush=True)
        if value > best_score:
            best_score, best_epoch = value, epoch + 1
            best = {name: tensor.detach().clone() for name, tensor in model.state_dict().items()}
        if timed_out:
            break
    if best is None:
        raise RuntimeError("training_budget_before_checkpoint")
    model.load_state_dict(best)
    return model, {"history": history, "bestEpoch": best_epoch, "selectionMetric": "development exact-span micro F1", "seconds": time.monotonic() - started,
                   "memoryObservedPeakMiB": max(peak, memory_mb()), "timedOut": timed_out, "parameters": sum(value.numel() for value in model.parameters()),
                   "classWeighting": "sqrt(O-token count / tag count), maximum6; train only"}


def wilson_upper(errors: int, total: int) -> float:
    if not total:
        return 1.0
    z = 1.96
    rate = errors / total
    return (rate + z * z / (2 * total) + z * math.sqrt(rate * (1 - rate) / total + z * z / (4 * total * total))) / (1 + z * z / total)


def calibrate(rows: list[SlotRow], logits: list[Any], config: SlotConfig) -> dict[str, Any]:
    import numpy as np
    if not rows or len(rows) != len(logits):
        raise ValueError("calibration_partition_required")
    def nll(temperature):
        total = count = 0.0
        for row, values in zip(rows, logits):
            scaled = values.astype(np.float64) / temperature
            maximum = scaled.max(axis=1, keepdims=True)
            logsum = maximum[:, 0] + np.log(np.exp(scaled - maximum).sum(axis=1))
            total += float((logsum - scaled[np.arange(len(row.tags)), list(row.tags)]).sum())
            count += len(row.tags)
        return total / count
    temperature = min((0.5, 0.75, 1.0, 1.5, 2.0, 3.0), key=nll)
    candidates: dict[str, list[tuple[float, bool]]] = defaultdict(list)
    for row, values in zip(rows, logits):
        gold = {span_key(span) for span in row.spans}
        for item in predictions(row, values, temperature):
            candidates[item["span"].label].append((item["confidence"], span_key(item["span"]) in gold))
    thresholds = {}
    per_slot = {}
    for slot in SLOTS:
        values = candidates[slot]
        best = {"threshold": 1.000001, "accepted": 0, "correct": 0, "wilsonUpperError95": 1.0}
        for threshold in sorted({value for value, _ in values}):
            kept = [correct for confidence, correct in values if confidence >= threshold]
            errors = sum(not correct for correct in kept)
            upper = wilson_upper(errors, len(kept))
            if len(kept) >= config.min_calibration_spans and upper <= 1 - config.target_precision and len(kept) > best["accepted"]:
                best = {"threshold": threshold, "accepted": len(kept), "correct": sum(kept), "wilsonUpperError95": upper}
        thresholds[slot] = best["threshold"]
        per_slot[slot] = {**best, "rawCandidates": len(values)}
    return {"partition": "calibration", "temperature": temperature, "tokenNLL": nll(temperature), "thresholds": thresholds, "perSlot": per_slot,
            "targetPrecision": config.target_precision, "confidence": "minimum predicted BIO-tag posterior among tokens of a proposed span", "active": False}


def exported_logits(header: dict[str, Any], payload: bytes, row: SlotRow):
    """Independent NumPy mean-embedding, bidirectional GRU and output head."""
    import numpy as np
    if header.get("format") != MODEL_FORMAT or sha(payload) != header.get("sha256") or header.get("tags") != list(TAGS):
        raise ValueError("export_identity_mismatch")
    values = {}
    total = 0
    for field in header["layout"]:
        offset, length = field["offsetBytes"], field["lengthBytes"]
        if type(offset) is not int or type(length) is not int or offset != total or length < 0 or offset + length > len(payload):
            raise ValueError("export_layout_bounds")
        array = np.frombuffer(payload[offset:offset + length], dtype="<f4")
        if math.prod(field["shape"]) != len(array):
            raise ValueError("export_shape_mismatch")
        values[field["name"]] = array.reshape(field["shape"])
        total += length
    if total != len(payload):
        raise ValueError("export_trailing_bytes")
    config = header["config"]
    features = [np.concatenate((values["embedding.weight"][token_features(token, config["buckets"])].mean(0),
                                np.asarray(token_flags(token), dtype=np.float32))) for token in row.tokens]
    hidden = config["hidden"]
    def direction(reverse: bool):
        suffix = "_reverse" if reverse else ""
        weight_ih, weight_hh = values[f"encoder.weight_ih_l0{suffix}"], values[f"encoder.weight_hh_l0{suffix}"]
        bias_ih, bias_hh = values[f"encoder.bias_ih_l0{suffix}"], values[f"encoder.bias_hh_l0{suffix}"]
        state = np.zeros(hidden, dtype=np.float32)
        output = [None] * len(features)
        for index in (range(len(features) - 1, -1, -1) if reverse else range(len(features))):
            input_gates = weight_ih @ features[index] + bias_ih
            recurrent = weight_hh @ state + bias_hh
            reset = 1 / (1 + np.exp(-np.clip(input_gates[:hidden] + recurrent[:hidden], -40, 40)))
            update = 1 / (1 + np.exp(-np.clip(input_gates[hidden:2 * hidden] + recurrent[hidden:2 * hidden], -40, 40)))
            candidate = np.tanh(input_gates[2 * hidden:] + reset * recurrent[2 * hidden:])
            state = (1 - update) * candidate + update * state
            output[index] = state.copy()
        return output
    forward, reverse = direction(False), direction(True)
    encoded = np.stack([np.concatenate((left, right)) for left, right in zip(forward, reverse)])
    return encoded @ values["classifier.weight"].T + values["classifier.bias"]


def export(model, config: SlotConfig, rows: list[SlotRow]) -> dict[str, bytes]:
    import numpy as np
    layout, pieces, offset = [], [], 0
    for name, tensor in model.state_dict().items():
        array = tensor.detach().cpu().numpy().astype("<f4")
        payload = array.tobytes()
        layout.append({"name": name, "shape": list(array.shape), "offsetBytes": offset, "lengthBytes": len(payload)})
        pieces.append(payload)
        offset += len(payload)
    weights = b"".join(pieces)
    header = {"format": MODEL_FORMAT, "active": False, "config": asdict(config), "tags": list(TAGS), "slotMapping": SLOT_MAPPING,
              "sha256": sha(weights), "layout": layout, "dtype": "float32-little-endian",
              "offsetContract": {"codepoints": "Python Unicode scalar indices, half-open", "utf16": "JavaScript UTF-16 code units, half-open", "surface": "exact original substring; never normalized"},
              "featureContract": {"tokenizer": r"Unicode \w+|[^\w\s]", "hash": "SHA256 first32bits big-endian modulo power-of-two buckets",
                                  "ngrams": [2, 3, 4], "aggregation": "mean", "flags": ["Arabic", "Latin", "digit", "uppercase", "punctuation", "min(token codepoints,20)/20"]},
              "decoder": "fixed legal BIO Viterbi, no I-start or mismatched I transition; no learned transition scores",
              "topicCapability": "news_topic only; generic topic unavailable"}
    parity_rows = sorted(rows, key=lambda row: (not bool(row.spans), row.id))[:12]
    torch_logits = sequence_logits(model, parity_rows, config)
    parity = []
    for row, expected in zip(parity_rows, torch_logits):
        actual = exported_logits(header, weights, row)
        if not np.allclose(expected, actual, rtol=1e-5, atol=1e-5) or viterbi_decode(expected) != viterbi_decode(actual):
            raise RuntimeError("independent_export_parity_failed")
        parity.append({"text": row.text, "tokens": [asdict(token) for token in row.tokens], "logits": expected.tolist(),
                       "decoded": [item["span"].projection(row.text) for item in predictions(row, expected)]})
    return {"weights.bin": weights, "model.json": json_bytes(header), "parity.json": json_bytes(parity)}


def write_exclusive(path: Path, value: bytes) -> str:
    with path.open("xb") as handle:
        handle.write(value)
    return sha(value)


def new_run(name: str | None = None, output: Path = OUTPUT) -> Path:
    name = name or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", name):
        raise ValueError("invalid_run_name")
    base = output.resolve()
    target = (base / name).resolve()
    if target.parent != base:
        raise ValueError("output_path_escape")
    base.mkdir(parents=True, exist_ok=True)
    target.mkdir(exist_ok=False)
    return target


def make_manifest(splits: dict[str, list[SlotRow]], audit: dict[str, Any], split_report: dict[str, Any], config: SlotConfig, implementation: list[dict[str, str]]) -> dict[str, Any]:
    assignments = [{"rowHash": sha(row.id), "groupHash": sha(row.group_id), "textHash": sha(row.text), "canonicalHash": sha(canonical(row.text)),
                    "annotationHash": sha(json_bytes([asdict(span) for span in row.spans])), "partition": partition, "locale": row.locale,
                    "goldSpanCounts": dict(Counter(span.label for span in row.spans))} for partition, rows in splits.items() for row in rows]
    return {"format": "public-slot-development-manifest-v1", "active": False, "createdAt": datetime.now(timezone.utc).isoformat(),
            "provenance": {"dataset": "Amazon MASSIVE v1.1 ar-SA/en-US", "license": "CC BY 4.0", "labels": "original public slot annotations; selected mapping only",
                           "ownerMessagesUsed": False, "assessmentFixturesRead": False, "priorContextExperimentRead": False, "externalModelsUsed": False},
            "config": asdict(config), "slotMapping": SLOT_MAPPING, "tags": TAGS, "implementation": implementation,
            "inputs": [{"path": str((PUBLIC_DATA / f"{locale}.jsonl").relative_to(ROOT)), "sha256": sha((PUBLIC_DATA / f"{locale}.jsonl").read_bytes())} for locale in ("ar-SA", "en-US")],
            "alignmentAudit": audit, "splitReport": split_report, "assignments": assignments, "assignmentHash": sha(json_bytes(assignments)),
            "policy": {"checkpointSelection": "dev exact-span micro F1 only", "temperatureAndAbstention": "calibration only, per-slot precision confidence bound", "test": "one final raw/selective report from one cached inference", "testIsSealed": False}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("audit", "prepare", "train"))
    parser.add_argument("--run-name")
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--max-seconds", type=float, default=300.0)
    parser.add_argument("--max-train", type=int, default=10000)
    parser.add_argument("--max-other", type=int, default=4000)
    parser.add_argument("--negative-ratio", type=float, default=0.5)
    parser.add_argument("--seed", type=int, default=53)
    args = parser.parse_args()
    config = SlotConfig(epochs=args.epochs, threads=args.threads, max_seconds=args.max_seconds, max_train=args.max_train,
                        max_other=args.max_other, negative_ratio=args.negative_ratio, seed=args.seed)
    config.validate()
    rows, audit = load_public()
    if args.command == "audit":
        print(json.dumps({**audit, "partitions": {partition: {"rows": sum(row.partition == partition for row in rows),
              "positiveRows": sum(row.partition == partition and bool(row.spans) for row in rows)} for partition in PARTITIONS}}, ensure_ascii=False), flush=True)
        return
    splits, split_report = split_public(rows, config.max_train, config.max_other, config.negative_ratio)
    run = new_run(args.run_name)
    implementation, checksums = [], {}
    for source in (Path(__file__).resolve(), Path(__file__).with_name("test_train_slots.py").resolve()):
        payload = source.read_bytes()
        artifact = f"source-{source.name}"
        checksums[artifact] = write_exclusive(run / artifact, payload)
        implementation.append({"path": str(source.relative_to(ROOT)), "artifact": artifact, "sha256": sha(payload), "capture": "before-training"})
    manifest = make_manifest(splits, audit, split_report, config, implementation)
    checksums["manifest.json"] = write_exclusive(run / "manifest.json", json_bytes(manifest))
    print(json.dumps({"run": str(run.relative_to(ROOT)), "counts": split_report["counts"], "assignmentHash": manifest["assignmentHash"]}), flush=True)
    report: dict[str, Any] = {"active": False, "command": args.command, "assignmentHash": manifest["assignmentHash"],
        "limitations": ["Public dataset evaluation, not owner task success or general intelligence.", "Only exact source spans are proposed; classification can still be wrong.",
                        "news_topic is conditional annotated news subject, not generic topic understanding.", "Rare labels may abstain completely if calibration lacks evidence.",
                        "No model activation, runtime extraction changes, owner data or prior experiment tuning."]}
    if args.command == "train":
        import io
        import torch
        model, training = train(splits, config)
        calibration_logits = sequence_logits(model, splits["calibration"], config)
        calibration = calibrate(splits["calibration"], calibration_logits, config)
        # Final test inference is run once, then reused for raw/selective metrics.
        test_logits = sequence_logits(model, splits["test"], config)
        raw = metrics(splits["test"], test_logits, calibration["temperature"])
        selective = metrics(splits["test"], test_logits, calibration["temperature"], calibration["thresholds"])
        report.update({"runtime": {"python": sys.version.split()[0], "torch": torch.__version__, "device": "cpu", "threads": config.threads},
                       "training": training, "calibration": calibration, "test": {"raw": raw, "selective": selective}})
        for filename, payload in export(model, config, splits["train"]).items():
            checksums[filename] = write_exclusive(run / filename, payload)
        checkpoint = io.BytesIO()
        torch.save({"format": MODEL_FORMAT, "active": False, "state": model.state_dict(), "config": asdict(config),
                    "assignmentHash": manifest["assignmentHash"], "tags": TAGS}, checkpoint)
        checksums["checkpoint.pt"] = write_exclusive(run / "checkpoint.pt", checkpoint.getvalue())
        checksums["calibration.json"] = write_exclusive(run / "calibration.json", json_bytes(calibration))
        print(json.dumps({"raw": raw["overall"], "selective": selective["overall"], "spanAcceptanceCoverage": selective["spanAcceptanceCoverage"],
                          "seconds": training["seconds"], "peakMiB": training["memoryObservedPeakMiB"]}), flush=True)
    checksums["report.json"] = write_exclusive(run / "report.json", json_bytes(report))
    write_exclusive(run / "checksums.json", json_bytes(checksums))
    print(json.dumps({"completed": str(run.relative_to(ROOT)), "active": False, "files": len(checksums) + 1}), flush=True)


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main()
