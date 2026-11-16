"""Goal tagger: a small from-scratch encoder that marks the words of an Ads request.

The generative model answered the goal task by writing "service 6-7; locations 14" as text,
and on new phrasings it wrote wrong numbers or broken answers (9/50 Arabic, 13/50 English on
the first independent test). This model does not write. It reads the sentence's words in both
directions and gives each word one tag (link, service, place, amount or nothing) and the
sentence four choices (intent, currency, period, goal). The answer is then spelt in the same
pointer format as before, so the existing decoder, repair and checker judge it unchanged.

Random initialization, local training data only, no pretrained weights and no external model.

    python -I -m execution_pipeline.goal_tagger train --data <dataset dir> --out <model dir>
    python -I -m execution_pipeline.goal_tagger answers --model <model dir> --input <jsonl> --output <jsonl>
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import re
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

TAGS = ["O", "URL", "SVC_B", "SVC_I", "LOC_B", "LOC_I", "AMT"]
CURRENCIES = ["none", "£", "$", "€", "SAR", "AED", "EGP"]
PERIODS = ["none", "day", "week", "month"]
GOALS = ["none", "calls", "bookings", "leads"]
PRESENCE_FIELDS = ("service_present", "locations_present")
PAD, UNK = 0, 1
MAX_WORDS, MAX_CHARS, MAX_SPAN = 96, 20, 6

# ---------------------------------------------------------------- words (mirrors pointer.ts and goal.ts)
EDGE_START = re.compile(r"^[(\[\"'“‘«]+")
EDGE_END = re.compile(r"[)\]\"'”’»,.!?;:،؛؟]+$")
URL_WORD = re.compile(r"^[A-Za-z0-9_:/.\-]+\.[A-Za-z]{2,}(?:/[A-Za-z0-9_/\-]*)?$")
NUMBER_RUN = re.compile(r"[+-]?[0-9٠-٩۰-۹]+(?:[.,٬٫][0-9٠-٩۰-۹]+)*")
NUMBER_SHAPE = re.compile(r"^(?:[0-9]{1,6}|[0-9]{1,3}(?:[,٬][0-9]{3})+)(?:[.٫][0-9]{1,2})?$")
CANONICAL = re.compile(r"^[0-9]{1,6}(?:\.[0-9]{1,2})?$")
ARABIC_WORD = re.compile(r"^[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿̀-ͯ]+$")
ARABIC_MARK = re.compile(r"^[ً-ٰٟۖ-ۭ]")
DIGIT = re.compile(r"[0-9٠-٩۰-۹]")
_ASCII_DIGITS = {**{0x660 + i: str(i) for i in range(10)}, **{0x6f0 + i: str(i) for i in range(10)}}


def split_words(message: str) -> tuple[list[str], list[str]]:
    """The raw chunks and the words the pointer format numbers (outer punctuation removed)."""
    raw = [chunk for chunk in re.split(r"\s+", message) if chunk]
    return raw, [EDGE_END.sub("", EDGE_START.sub("", chunk)) or chunk for chunk in raw]


def _amount(raw: str) -> str | None:
    text = raw.translate(_ASCII_DIGITS)
    if not NUMBER_SHAPE.match(text):
        return None
    canonical = text.replace(",", "").replace("٬", "").replace("٫", ".")
    return canonical if CANONICAL.match(canonical) else None


def one_number(word: str) -> bool:
    """True when the word holds exactly one valid amount, as the pointer decoder requires."""
    return sum(1 for run in NUMBER_RUN.findall(word) if _amount(run) is not None) == 1


FEATURES = 20


def word_features(raw: str, word: str, first: bool, after_stop: bool) -> list[float]:
    latin = bool(re.search(r"[A-Za-z]", word))
    arabic = bool(re.search(r"[؀-ۿ]", word))
    url = bool(URL_WORD.match(word))
    return [float(value) for value in (
        url, one_number(word) and not url, bool(DIGIT.search(word)), bool(re.search(r"[£$€]", word)),
        latin and word[:1].isupper(), latin and len(word) > 1 and word.isupper(), latin and word.islower(), arabic, latin,
        raw.endswith((",", "،")), raw.endswith((".", "?", "!", "؟")), raw.endswith((";", ":", "؛")), bool(EDGE_START.match(raw)),
        first, after_stop, "-" in word, "/" in word, len(word) <= 2, len(word) >= 8, not re.search(r"\w", word),
    )]


def word_key(word: str) -> str:
    if URL_WORD.match(word):
        return "<url>"
    return DIGIT.sub("0", word.lower())


def word_keys(word: str) -> list[str]:
    """The word and, for an Arabic word, the word without its first one, two and three letters."""
    key = word_key(word)
    if not ARABIC_WORD.match(word):
        return [key, "", "", ""]
    return [key] + [key[cut:] if len(key) > cut + 1 else "" for cut in (1, 2, 3)]


def clip_chars(word: str) -> str:
    return word if len(word) <= MAX_CHARS else word[:12] + word[-(MAX_CHARS - 12):]


# ---------------------------------------------------------------- labels from a pointer answer
def parse_pointer(target: str, count: int) -> dict[str, Any]:
    """Tags, span offsets and sentence choices of one pointer answer."""
    fields = {}
    for part in [piece.strip() for piece in target.split(";") if piece.strip()]:
        name, _, value = part.partition(" ")
        fields[name] = value.strip()
    labels: dict[str, Any] = {"tags": [0] * count, "offsets": [-100] * count, "intent": 0, "currency": 0, "period": 0, "goal": 0,
                              "service_present": 0, "locations_present": 0}
    if fields.get("intent") != "create_campaign":
        return labels
    labels["intent"] = 1

    def span(ref: str) -> tuple[int, int, int]:
        match = re.fullmatch(r"(\d+)(?:-(\d+))?(?:@(\d))?", ref)
        if not match:
            raise ValueError(f"Bad pointer span: {ref}")
        start = int(match.group(1))
        return start, int(match.group(2) or start), int(match.group(3) or 0)

    def mark(ref: str, begin: int, inside: int) -> None:
        start, end, offset = span(ref)
        if not 1 <= start <= end <= count:
            raise ValueError(f"Pointer span outside the sentence: {ref}")
        labels["tags"][start - 1] = begin
        for index in range(start, end):
            labels["tags"][index] = inside
        labels["offsets"][start - 1] = offset

    if "url" in fields:
        labels["tags"][span(fields["url"])[0] - 1] = TAGS.index("URL")
    if "service" in fields:
        mark(fields["service"], TAGS.index("SVC_B"), TAGS.index("SVC_I"))
        labels["service_present"] = 1
    for ref in fields.get("locations", "").split():
        mark(ref, TAGS.index("LOC_B"), TAGS.index("LOC_I"))
        labels["locations_present"] = 1
    if "amount" in fields:
        labels["tags"][int(fields["amount"]) - 1] = TAGS.index("AMT")
        labels["currency"] = CURRENCIES.index(fields["currency"])
        labels["period"] = PERIODS.index(fields["period"])
    if "goal" in fields:
        labels["goal"] = GOALS.index(fields["goal"])
    return labels


# ---------------------------------------------------------------- encoding
class Vocabulary:
    def __init__(self, words: list[str], chars: list[str]) -> None:
        self.words, self.chars = words, chars
        self.word_id = {word: index for index, word in enumerate(words)}
        self.char_id = {char: index for index, char in enumerate(chars)}
        # Optional words of the local-text lexicon (lexicon.py); their ids follow the four word ids.
        self.lexicon_words: list[str] | None = None
        self.lexicon_id: dict[str, int] = {}

    def set_lexicon(self, words: list[str]) -> None:
        self.lexicon_words = words
        self.lexicon_id = {word: index for index, word in enumerate(words)}

    @classmethod
    def build(cls, sentences: list[list[str]], minimum: int = 2) -> "Vocabulary":
        words: Counter[str] = Counter()
        chars: Counter[str] = Counter()
        for sentence in sentences:
            for word in sentence:
                words[word_key(word)] += 1
                chars.update(word)
        return cls(["<pad>", "<unk>"] + sorted(word for word, seen in words.items() if seen >= minimum),
                   ["<pad>", "<unk>"] + sorted(char for char, seen in chars.items() if seen >= 5))

    def word(self, key: str) -> int:
        return PAD if not key else self.word_id.get(key, UNK)

    def encode_word(self, word: str) -> tuple[list[int], list[int]]:
        chars = [self.char_id.get(char, UNK) for char in clip_chars(word)]
        keys = word_keys(word)
        ids = [self.word(key) for key in keys]
        if self.lexicon_words is not None:
            ids += [PAD if not key else self.lexicon_id.get(key, UNK) for key in keys]
        return ids, chars + [PAD] * (MAX_CHARS - len(chars))


def encode_sentence(vocabulary: Vocabulary, message: str) -> dict[str, Any]:
    raw, words = split_words(message)
    raw, words = raw[:MAX_WORDS], words[:MAX_WORDS]
    ids, chars, features = [], [], []
    for index, (chunk, word) in enumerate(zip(raw, words)):
        word_ids, char_ids = vocabulary.encode_word(word)
        ids.append(word_ids)
        chars.append(char_ids)
        features.append(word_features(chunk, word, index == 0, index > 0 and raw[index - 1].endswith((".", "?", "!", "؟"))))
    return {"raw": raw, "words": words, "ids": ids, "chars": chars, "features": features}


_LATIN = "abcdefghijklmnopqrstuvwxyz"
_ARABIC = "ابتثجحخدذرزسشصضطظعغفقكلمنهوي"


def _invented(word: str, keep: int, rng: random.Random) -> str:
    """A made-up word of the same script and shape, so a name is learnt from its place in the sentence."""
    if ARABIC_WORD.match(word):
        head = word[:keep] + ("ال" if word[keep:keep + 2] == "ال" else "")
        return head + "".join(rng.choice(_ARABIC) for _ in range(rng.randint(3, 6)))
    if re.fullmatch(r"[A-Za-z]+", word):
        made = "".join(rng.choice(_LATIN) for _ in range(rng.randint(4, 10)))
        return made.capitalize() if word[0].isupper() else made
    return word


def augment(vocabulary: Vocabulary, example: dict[str, Any], rng: random.Random,
            entity_word_dropout: float | None = None, invented_name_probability: float | None = None,
            context_word_dropout: float = 0.1) -> dict[str, Any]:
    """Hide vocabulary identities, preserving characters, features and labels.

    Configured entity dropout hides a whole service/location span together. This models an
    unseen name more faithfully than letting the remaining familiar words identify it.
    The optional invented names also vary the character input; neither changes the source.
    Omitting the new options retains the v1 augmentation policy.
    """
    ids, chars, features = [list(row) for row in example["ids"]], list(example["chars"]), list(example["features"])
    tags, offsets = example["tags"], example["offsets"]
    hide_span, previous_tag = False, 0
    for index, tag in enumerate(tags):
        named = tag in (2, 3, 4, 5)
        if entity_word_dropout is not None:
            if tag in (2, 4) or (tag in (3, 5) and previous_tag not in (tag - 1, tag)):
                hide_span = rng.random() < entity_word_dropout
            elif not named:
                hide_span = False
        probability = invented_name_probability if invented_name_probability is not None else (0.15 if tag in (2, 3) else 0.1)
        if named and rng.random() < probability:
            word = _invented(example["words"][index], max(offsets[index], 0), rng)
            if word != example["words"][index]:
                raw = example["raw"][index].replace(example["words"][index], word)
                ids[index], chars[index] = vocabulary.encode_word(word)
                ids[index] = list(ids[index])
                features[index] = word_features(raw, word, index == 0, bool(example["features"][index][14]))
        hide_word = hide_span if named and entity_word_dropout is not None else rng.random() < (0.5 if tag in (2, 3) else 0.3 if tag in (4, 5) else context_word_dropout)
        if hide_word:
            # Only the trained word identity is hidden; the lexicon ids stay, as they would for a new word.
            ids[index] = [UNK if value != PAD else PAD for value in ids[index][:4]] + ids[index][4:]
        previous_tag = tag
    return {**example, "ids": ids, "chars": chars, "features": features}


def collate(examples: list[dict[str, Any]], device: str) -> dict[str, Any]:
    import torch
    width = max(len(example["ids"]) for example in examples)
    size = len(examples)
    ids = torch.zeros((size, width, len(examples[0]["ids"][0])), dtype=torch.long)
    chars = torch.zeros((size, width, MAX_CHARS), dtype=torch.long)
    features = torch.zeros((size, width, FEATURES), dtype=torch.float)
    mask = torch.zeros((size, width), dtype=torch.bool)
    tags = torch.full((size, width), -100, dtype=torch.long)
    offsets = torch.full((size, width), -100, dtype=torch.long)
    for row, example in enumerate(examples):
        count = len(example["ids"])
        ids[row, :count] = torch.tensor(example["ids"])
        chars[row, :count] = torch.tensor(example["chars"])
        features[row, :count] = torch.tensor(example["features"])
        mask[row, :count] = True
        if "tags" in example:
            tags[row, :count] = torch.tensor(example["tags"])
            offsets[row, :count] = torch.tensor(example["offsets"])
    batch = {"ids": ids, "chars": chars, "features": features, "mask": mask, "tags": tags, "offsets": offsets}
    if "intent" in examples[0]:
        for name in ("intent", "currency", "period", "goal"):
            batch[name] = torch.tensor([example[name] for example in examples])
        # Existing examples can derive presence from their supervised tags. No new data
        # annotation is required, and inference batches do not contain these labels.
        for name, positive_tags in (("service_present", (2, 3)), ("locations_present", (4, 5))):
            batch[name] = torch.tensor([example.get(name, int(any(tag in positive_tags for tag in example["tags"])))
                                        for example in examples], dtype=torch.long)
    return {name: value.to(device) for name, value in batch.items()}


# ---------------------------------------------------------------- model
def build_model(settings: dict[str, Any]) -> Any:
    import torch
    from torch import nn

    class GoalTagger(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            width, word_width, char_width = settings["width"], settings["word_width"], settings["char_width"]
            self.word_variant_normalization = settings.get("word_variant_normalization", "none")
            if self.word_variant_normalization not in ("none", "sqrt"):
                raise ValueError("Unsupported word variant normalization")
            self.field_presence = settings.get("field_presence", False)
            if not isinstance(self.field_presence, bool):
                raise ValueError("field_presence must be boolean")
            self.word = nn.Embedding(settings["words"], word_width, padding_idx=PAD)
            # The same word table reads the word without an attached Arabic letter ("بالخبر" -> "الخبر").
            self.strip = nn.Parameter(torch.zeros(3, word_width))
            self.char = nn.Embedding(settings["chars"], 32, padding_idx=PAD)
            self.convolutions = nn.ModuleList(nn.Conv1d(32, char_width, kernel, padding=kernel - 1) for kernel in (2, 3, 4))
            self.features = nn.Linear(FEATURES, 64)
            # Local-text lexicon: frozen vectors and statistics, read through a small trained layer.
            self.lexicon = settings.get("lexicon")
            lexicon_width = 0
            if self.lexicon:
                lexicon_width = 96
                self.lexicon_vectors = nn.Embedding(self.lexicon["words"], self.lexicon["width"], padding_idx=PAD)
                self.lexicon_statistics = nn.Embedding(self.lexicon["words"], 2, padding_idx=PAD)
                self.lexicon_vectors.weight.requires_grad_(False)
                self.lexicon_statistics.weight.requires_grad_(False)
                self.lexicon_strip = nn.Parameter(torch.zeros(3))
                self.lexicon_read = nn.Linear(self.lexicon["width"] + 7, lexicon_width)
            self.join = nn.Linear(word_width + 3 * char_width + 64 + lexicon_width, width)
            self.position = nn.Embedding(MAX_WORDS + 1, width)
            self.sentence = nn.Parameter(torch.zeros(width))
            layer = nn.TransformerEncoderLayer(width, settings["heads"], settings["feed_forward"], settings["dropout"], batch_first=True, norm_first=True, activation="gelu")
            self.encoder = nn.TransformerEncoder(layer, settings["layers"], enable_nested_tensor=False)
            self.norm = nn.LayerNorm(width)
            self.drop = nn.Dropout(settings["dropout"])
            self.tag = nn.Linear(width, len(TAGS))
            self.offset = nn.Linear(width, 4)
            self.intent = nn.Linear(width, 2)
            self.currency = nn.Linear(width, len(CURRENCIES))
            self.period = nn.Linear(width, len(PERIODS))
            self.goal = nn.Linear(width, len(GOALS))
            nn.init.normal_(self.sentence, std=0.02)
            nn.init.normal_(self.strip, std=0.02)
            # Construct optional heads only after all legacy initialization. Missing or
            # false settings leave both state keys and random initialization unchanged.
            if self.field_presence:
                for name in PRESENCE_FIELDS:
                    setattr(self, name, nn.Linear(width, 2))

        def forward(self, ids: Any, chars: Any, features: Any, mask: Any) -> dict[str, Any]:
            batch, count = mask.shape
            words = self.word(ids[:, :, 0])
            for cut in range(3):
                words = words + self.word(ids[:, :, cut + 1]) * (1 + self.strip[cut])
            if self.word_variant_normalization == "sqrt":
                # Arabic can supply four vocabulary variants while Latin supplies one.
                # Keep their combined scale comparable without discarding suffix information.
                variants = ids[:, :, :4].ne(PAD).sum(dim=2).clamp_min(1).to(words.dtype)
                words = words / variants.sqrt().unsqueeze(-1)
            letters = self.char(chars.view(batch * count, MAX_CHARS)).transpose(1, 2)
            shapes = torch.cat([convolution(letters).amax(dim=2) for convolution in self.convolutions], dim=1).view(batch, count, -1)
            parts = [words, shapes, torch.relu(self.features(features))]
            if self.lexicon:
                known = ids[:, :, 4:8]
                vectors = self.lexicon_vectors(known[:, :, 0])
                for cut in range(3):
                    vectors = vectors + self.lexicon_vectors(known[:, :, cut + 1]) * (1 + self.lexicon_strip[cut])
                # How common the whole word is, how often it is capitalized, and which spellings the lexicon knows.
                facts = torch.cat([self.lexicon_statistics(known[:, :, 0]), known.gt(UNK).to(vectors.dtype),
                                   self.lexicon_statistics(known[:, :, 1:]).amax(dim=2)[:, :, :1]], dim=2)
                parts.append(torch.relu(self.lexicon_read(torch.cat([vectors, facts], dim=2))))
            hidden = self.join(torch.cat(parts, dim=2))
            hidden = torch.cat([self.sentence.expand(batch, 1, -1), hidden], dim=1)
            hidden = self.drop(hidden + self.position(torch.arange(count + 1, device=mask.device)))
            padding = torch.cat([torch.zeros((batch, 1), dtype=torch.bool, device=mask.device), ~mask], dim=1)
            hidden = self.norm(self.encoder(hidden, src_key_padding_mask=padding))
            first, rest = hidden[:, 0], hidden[:, 1:]
            outputs = {"tags": self.tag(rest), "offsets": self.offset(rest), "intent": self.intent(first),
                       "currency": self.currency(first), "period": self.period(first), "goal": self.goal(first)}
            if self.field_presence:
                for name in PRESENCE_FIELDS:
                    outputs[name] = getattr(self, name)(first)
            return outputs

    return GoalTagger()


def loss_of(outputs: dict[str, Any], batch: dict[str, Any]) -> Any:
    from torch.nn import functional as F
    loss = F.cross_entropy(outputs["tags"].flatten(0, 1).float(), batch["tags"].flatten(), ignore_index=-100)
    if (batch["offsets"] != -100).any():
        loss = loss + 0.5 * F.cross_entropy(outputs["offsets"].flatten(0, 1).float(), batch["offsets"].flatten(), ignore_index=-100)
    for name in ("intent", "currency", "period", "goal"):
        loss = loss + F.cross_entropy(outputs[name].float(), batch[name])
    for name in PRESENCE_FIELDS:
        if name in outputs:
            loss = loss + 0.5 * F.cross_entropy(outputs[name].float(), batch[name])
    return loss


# ---------------------------------------------------------------- decoding
def _field_present(outputs: dict[str, Any], name: str, row: int) -> bool:
    """An omitted optional head preserves legacy span emission exactly."""
    return name not in outputs or int(outputs[name][row].argmax()) == 1


def confidence_of(example: dict[str, Any], outputs: dict[str, Any], row: int) -> float:
    """Weakest model decision, calibrated on development data, never a guarantee of correctness.

    Include O tokens so omitted fields lower confidence too. Intent=other ignores fields
    that the decoder discards. Impossible URL/amount tags use the same masks as decoding.
    """
    import torch
    intent = outputs["intent"][row].float().softmax(dim=-1)
    values = [float(intent.max())]
    count = len(example["words"])
    if not count or int(intent.argmax()) == 0:
        return min(values)
    for name in PRESENCE_FIELDS:
        if name in outputs:
            values.append(float(outputs[name][row].float().softmax(dim=-1).max()))
    logits = outputs["tags"][row, :count].float().clone()
    features = torch.tensor(example["features"], device=logits.device)
    logits[features[:, 0] < 0.5, TAGS.index("URL")] = -1e9
    logits[features[:, 1] < 0.5, TAGS.index("AMT")] = -1e9
    probabilities = logits.softmax(dim=-1)
    values.append(float(probabilities.max(dim=-1).values.min()))
    tags = probabilities.argmax(dim=-1).tolist()
    for index, tag in enumerate(tags):
        start = tag in (2, 4) or (tag in (3, 5) and (index == 0 or tags[index - 1] not in (tag - 1, tag)))
        if tag in (2, 3) and not _field_present(outputs, "service_present", row):
            continue
        if tag in (4, 5) and not _field_present(outputs, "locations_present", row):
            continue
        if start and ARABIC_WORD.match(example["words"][index]):
            values.append(float(outputs["offsets"][row, index].float().softmax(dim=-1).max()))
    for name in ("goal", "period"):
        values.append(float(outputs[name][row].float().softmax(dim=-1).max()))
    if TAGS.index("AMT") in tags and int(outputs["period"][row].argmax()) != 0:
        values.append(float(outputs["currency"][row].float().softmax(dim=-1).max()))
    return min(values)


def decode(example: dict[str, Any], outputs: dict[str, Any], row: int) -> str:
    """The pointer answer of one sentence. A link tag needs a link-shaped word, an amount tag a number."""
    import torch
    count = len(example["words"])
    if count == 0 or int(outputs["intent"][row].argmax()) == 0:
        return "intent other"
    logits = outputs["tags"][row, :count].float().clone()
    features = torch.tensor(example["features"], device=logits.device)
    logits[features[:, 0] < 0.5, TAGS.index("URL")] = -1e9
    logits[features[:, 1] < 0.5, TAGS.index("AMT")] = -1e9
    probabilities = logits.softmax(dim=1)
    tags = probabilities.argmax(dim=1).tolist()
    offsets = outputs["offsets"][row, :count].argmax(dim=1).tolist()
    parts = ["intent create_campaign"]

    def best(tag: int) -> int | None:
        picks = [index for index in range(count) if tags[index] == tag]
        return max(picks, key=lambda index: float(probabilities[index, tag])) if picks else None

    def spans(begin: int, inside: int) -> list[tuple[int, int, float]]:
        found, index = [], 0
        while index < count:
            if tags[index] in (begin, inside):
                end = index
                while end + 1 < count and tags[end + 1] == inside and end + 1 - index < MAX_SPAN:
                    end += 1
                score = sum(float(probabilities[at, tags[at]]) for at in range(index, end + 1)) / (end + 1 - index)
                found.append((index, end, score))
                index = end + 1
            else:
                index += 1
        return found

    def ref(start: int, end: int) -> str:
        word, offset = example["words"][start], offsets[start]
        valid = offset and ARABIC_WORD.match(word) and offset < len(word) and not ARABIC_MARK.match(word[offset:])
        return (str(start + 1) if start == end else f"{start + 1}-{end + 1}") + (f"@{offset}" if valid else "")

    url = best(TAGS.index("URL"))
    if url is not None:
        parts.append(f"url {url + 1}")
    services = spans(TAGS.index("SVC_B"), TAGS.index("SVC_I"))
    if services and _field_present(outputs, "service_present", row):
        start, end, _ = max(services, key=lambda item: item[2])
        parts.append(f"service {ref(start, end)}")
    places, seen = [], set()
    for start, end, _ in spans(TAGS.index("LOC_B"), TAGS.index("LOC_I")):
        text = " ".join(example["words"][start:end + 1]).lower()
        if text not in seen:
            seen.add(text)
            places.append(ref(start, end))
    if places and _field_present(outputs, "locations_present", row):
        parts.append("locations " + " ".join(places))
    amount, period = best(TAGS.index("AMT")), int(outputs["period"][row].argmax())
    if amount is not None and period:
        parts += [f"amount {amount + 1}", f"currency {CURRENCIES[int(outputs['currency'][row].argmax())]}", f"period {PERIODS[period]}"]
    goal = int(outputs["goal"][row].argmax())
    if goal:
        parts.append(f"goal {GOALS[goal]}")
    return "; ".join(parts)


def answer_all(model: Any, vocabulary: Vocabulary, messages: list[str], device: str, batch: int = 256,
               confidence_scores: list[float | None] | None = None) -> list[str | None]:
    """Return answers in input order, or None for requests beyond the supported word limit.

    A discarded suffix could contain a correction or negation. Such requests must not be
    presented as completed predictions from the truncated prefix.
    """
    import torch
    examples = {index: encode_sentence(vocabulary, message) for index, message in enumerate(messages)
                if len(split_words(message)[1]) <= MAX_WORDS}
    answers: list[str | None] = [None] * len(messages)
    if confidence_scores is not None:
        confidence_scores[:] = [None] * len(messages)
    order = sorted(examples, key=lambda index: len(examples[index]["ids"]))
    model.eval()
    with torch.no_grad():
        for start in range(0, len(order), batch):
            chunk = [index for index in order[start:start + batch]]
            filled = [index for index in chunk if examples[index]["ids"]]
            for index in chunk:
                answers[index] = "intent other"
                if confidence_scores is not None:
                    confidence_scores[index] = 0.0
            if not filled:
                continue
            tensors = collate([examples[index] for index in filled], device)
            with torch.autocast("cuda", dtype=torch.bfloat16, enabled=device == "cuda"):
                outputs = model(tensors["ids"], tensors["chars"], tensors["features"], tensors["mask"])
            for row, index in enumerate(filled):
                answers[index] = decode(examples[index], outputs, row)
                if confidence_scores is not None:
                    confidence_scores[index] = confidence_of(examples[index], outputs, row)
    return answers


# ---------------------------------------------------------------- files
def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_rows(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def load_model(directory: Path, device: str) -> tuple[Any, Vocabulary, dict[str, Any]]:
    import torch
    payload = torch.load(directory / "best.pt", map_location="cpu", weights_only=True)
    vocabulary = Vocabulary(payload["vocabulary"]["words"], payload["vocabulary"]["chars"])
    if payload["vocabulary"].get("lexicon") is not None:
        vocabulary.set_lexicon(payload["vocabulary"]["lexicon"])
    model = build_model(payload["settings"])
    model.load_state_dict(payload["model_state"], strict=True)
    return model.to(device).eval(), vocabulary, payload


def initialize_from_local(model: Any, vocabulary: Vocabulary, directory: Path) -> dict[str, Any]:
    """Continue a locally trained checkpoint, remapping changed vocabulary by identity."""
    import torch
    payload = torch.load(directory / "best.pt", map_location="cpu", weights_only=True)
    original, current = payload["model_state"], model.state_dict()
    if (payload["settings"].get("word_variant_normalization", "none") != model.word_variant_normalization
            or payload["settings"]["heads"] != model.encoder.layers[0].self_attn.num_heads):
        raise ValueError("Local checkpoint architecture mismatch in normalization or attention heads")
    embeddings = {"word.weight": ("words", vocabulary.words), "char.weight": ("chars", vocabulary.chars)}
    new_head_keys = {f"{name}.{kind}" for name in PRESENCE_FIELDS for kind in ("weight", "bias")}
    source_presence = payload["settings"].get("field_presence", False)
    source_head_keys = set(original) & new_head_keys
    if not isinstance(source_presence, bool) or source_head_keys != (new_head_keys if source_presence else set()):
        raise ValueError("Local checkpoint presence settings do not match saved heads")
    missing, unexpected = set(current) - set(original), set(original) - set(current)
    # Only the complete pair of freshly introduced heads may be absent. A partial
    # presence checkpoint is corruption, not a legacy checkpoint to initialize from.
    adding_presence = (model.field_presence and not source_presence
                       and missing == new_head_keys)
    if unexpected or (missing and not adding_presence):
        raise ValueError("Local checkpoint architecture does not match the requested model")
    for key, value in current.items():
        if key in missing:
            continue
        if key in embeddings:
            if original[key].shape[1:] != value.shape[1:]:
                raise ValueError(f"Local checkpoint embedding width mismatch: {key}")
        elif original[key].shape != value.shape:
            raise ValueError(f"Local checkpoint architecture shape mismatch: {key}")
    transferred = {}
    with torch.no_grad():
        for key, value in current.items():
            if key in missing:
                continue
            if key not in embeddings:
                value.copy_(original[key])
                continue
            kind, names = embeddings[key]
            previous = {name: index for index, name in enumerate(payload["vocabulary"][kind])}
            transferred[kind] = 0
            for index, name in enumerate(names):
                if name in previous:
                    value[index].copy_(original[key][previous[name]])
                    transferred[kind] += 1
    return {"directory": str(directory.resolve()), "checkpointSha256": _sha256(directory / "best.pt"),
            "transferredVocabulary": transferred, "optimizer": "fresh", "newHeadParameters": sorted(missing)}


def set_presence_training_stage(model: Any, epoch: int, warmup_epochs: int = 0) -> bool:
    """Warm up only optional heads, then restore all model parameters for joint training."""
    if warmup_epochs < 0 or (warmup_epochs and not model.field_presence):
        raise ValueError("Presence warmup requires field_presence and a nonnegative epoch count")
    head_only = epoch < warmup_epochs
    for name, parameter in model.named_parameters():
        if name.split(".", 1)[0] in ("lexicon_vectors", "lexicon_statistics"):
            parameter.requires_grad_(False)  # learnt from local text, never changed by the synthetic sentences
            continue
        parameter.requires_grad_(not head_only or name.split(".", 1)[0] in PRESENCE_FIELDS)
    return head_only


def train(args: argparse.Namespace) -> int:
    import torch
    out: Path = args.out
    if (out / "best.pt").exists():
        raise SystemExit(f"Refusing to overwrite an existing model: {out}")
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)
    torch.manual_seed(args.seed)
    started = time.time()
    data = {split: read_rows(args.data / f"{split}.jsonl") for split in ("train", "validation")}
    vocabulary = Vocabulary.build([split_words(row["input"]["message"])[1] for row in data["train"]])
    lexicon_path = getattr(args, "lexicon", None)
    lexicon = torch.load(lexicon_path / "lexicon.pt", map_location="cpu", weights_only=True) if lexicon_path is not None else None
    if lexicon is not None:
        vocabulary.set_lexicon(lexicon["words"])

    def prepare(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        prepared = []
        for row in rows:
            example = encode_sentence(vocabulary, row["input"]["message"])
            if not example["ids"] or len(split_words(row["input"]["message"])[1]) > MAX_WORDS:
                continue
            example.update(parse_pointer(row["target"], len(example["ids"])))
            example["target"], example["language"] = row["target"], row.get("language", "")
            prepared.append(example)
        return prepared

    training, validation = prepare(data["train"]), prepare(data["validation"])
    if not training or not validation:
        raise SystemExit("Training and validation must both contain supported nonempty examples.")
    dropout = getattr(args, "dropout", 0.1)
    weight_decay = getattr(args, "weight_decay", 0.01)
    entity_word_dropout = getattr(args, "entity_word_dropout", None)
    context_word_dropout = getattr(args, "context_word_dropout", 0.1)
    invented_name_probability = getattr(args, "invented_name_probability", None)
    word_variant_normalization = getattr(args, "word_variant_normalization", "none")
    patience = getattr(args, "patience", 0)
    settings = {"words": len(vocabulary.words), "chars": len(vocabulary.chars), "width": args.width, "word_width": 160, "char_width": 64,
                "heads": 4, "feed_forward": args.width * 3, "layers": args.layers, "dropout": dropout,
                "word_variant_normalization": word_variant_normalization,
                "field_presence": getattr(args, "field_presence", False)}
    if lexicon is not None:
        settings["lexicon"] = {"words": len(lexicon["words"]), "width": int(lexicon["vectors"].shape[1]), "sha256": _sha256(lexicon_path / "lexicon.pt")}
    model = build_model(settings)
    if lexicon is not None:
        with torch.no_grad():
            model.lexicon_vectors.weight.copy_(lexicon["vectors"])
            model.lexicon_statistics.weight.copy_(torch.stack([lexicon["frequency"], lexicon["capital"]], dim=1))
            model.lexicon_statistics.weight[:2] = 0
    model = model.to(args.device)
    presence_warmup_epochs = getattr(args, "presence_warmup_epochs", 0)
    set_presence_training_stage(model, 0, presence_warmup_epochs)
    local_source = getattr(args, "initialize_from", None)
    initialization = initialize_from_local(model, vocabulary, local_source) if local_source is not None else None
    parameters = sum(parameter.numel() for parameter in model.parameters())
    steps = math.ceil(len(training) / args.batch) * args.epochs
    # Warmup temporarily freezes the shared encoder. Keep those parameters in the
    # optimizer so they really update when the joint-training stage unfreezes them.
    # Permanently frozen lexicon embeddings have no gradients and are skipped by AdamW.
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=weight_decay)
    schedule = torch.optim.lr_scheduler.OneCycleLR(optimizer, max_lr=args.lr, total_steps=steps, pct_start=0.06, anneal_strategy="cos")
    print(json.dumps({"train": len(training), "validation": len(validation), "parameters": parameters, "steps": steps,
                      "words": len(vocabulary.words), "chars": len(vocabulary.chars), "prepare_seconds": round(time.time() - started)}), flush=True)

    def validate() -> dict[str, float]:
        answers = answer_all(model, vocabulary, [" ".join(example["raw"]) for example in validation], args.device)
        totals: Counter[str] = Counter()
        right: Counter[str] = Counter()
        for example, answer in zip(validation, answers):
            totals[example["language"]] += 1
            right[example["language"]] += answer == example["target"]
        return {language: right[language] / totals[language] for language in sorted(totals)}

    best, best_epoch, stale_epochs, step, log = -1.0, 0, 0, 0, []
    data_report = {split: {"rows": len(rows), "preparedRows": len(training if split == "train" else validation),
                           "sha256": _sha256(args.data / f"{split}.jsonl")} for split, rows in data.items()}

    def write_report(status: str) -> dict[str, Any]:
        report = {"model": "goal-tagger-v3", "architecture": "goal-tagger-v1-presence" if settings["field_presence"] else "goal-tagger-v1", "initialization": "local_checkpoint" if initialization else "random",
                  "initializationSource": initialization, "externalPretrainedWeights": False, "externalModel": False,
                  "parameters": parameters, "settings": settings,
                  "arguments": {"epochs": args.epochs, "batch": args.batch, "lr": args.lr, "seed": args.seed,
                                "dropout": dropout, "weight_decay": weight_decay, "entity_word_dropout": entity_word_dropout,
                                "context_word_dropout": context_word_dropout, "word_variant_normalization": word_variant_normalization,
                                "invented_name_probability": invented_name_probability, "patience": patience,
                                "field_presence": settings["field_presence"], "presence_warmup_epochs": presence_warmup_epochs,
                                "lexicon": str(lexicon_path).replace("\\", "/") if lexicon_path is not None else None},
                  "data": data_report, "dataDirectory": str(args.data).replace("\\", "/"),
                  "checkpointSha256": _sha256(out / "best.pt"), "bestValidationExactMinimum": best, "bestEpoch": best_epoch,
                  "checkpointSelection": "maximum_minimum_per_language_validation_pointer_exact",
                  "epochsCompleted": len(log), "status": status, "log": log,
                  "seconds": round(time.time() - started), "device": args.device}
        temporary = out / "report.json.tmp"
        temporary.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        temporary.replace(out / "report.json")
        return report

    for epoch in range(args.epochs):
        presence_head_only = set_presence_training_stage(model, epoch, presence_warmup_epochs)
        model.train()
        rng.shuffle(training)
        running, seen = 0.0, 0
        for start in range(0, len(training), args.batch):
            batch = collate([augment(vocabulary, example, rng, entity_word_dropout, invented_name_probability, context_word_dropout)
                             for example in training[start:start + args.batch]], args.device)
            with torch.autocast("cuda", dtype=torch.bfloat16, enabled=args.device == "cuda"):
                outputs = model(batch["ids"], batch["chars"], batch["features"], batch["mask"])
            loss = loss_of(outputs, batch)
            if not torch.isfinite(loss):
                raise SystemExit("Training loss is not finite.")
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            schedule.step()
            step += 1
            running += float(loss.detach())
            seen += 1
        exact = validate()
        score = min(exact.values())
        if not math.isfinite(score):
            raise SystemExit("Validation accuracy is not finite.")
        entry = {"epoch": epoch + 1, "step": step, "train_loss": round(running / seen, 4), "validation_exact": {k: round(v, 4) for k, v in exact.items()},
                 "seconds": round(time.time() - started), "presence_head_only": presence_head_only}
        log.append(entry)
        print(json.dumps(entry, ensure_ascii=False), flush=True)
        if score > best:
            best, best_epoch, stale_epochs = score, epoch + 1, 0
            checkpoint = out / "best.pt.tmp"
            torch.save({"model_state": model.state_dict(), "settings": settings, "vocabulary": {"words": vocabulary.words, "chars": vocabulary.chars, "lexicon": vocabulary.lexicon_words},
                        "step": step, "epoch": epoch + 1, "validation_exact": exact}, checkpoint)
            checkpoint.replace(out / "best.pt")
        else:
            stale_epochs += 1
        stopping = patience > 0 and stale_epochs >= patience
        write_report("early_stopped" if stopping else "training")
        if stopping:
            print(json.dumps({"early_stopping": True, "epoch": epoch + 1, "best_epoch": best_epoch, "patience": patience}), flush=True)
            break
    report = write_report("early_stopped" if patience > 0 and stale_epochs >= patience else "completed")
    print(json.dumps({"best": best, "checkpointSha256": report["checkpointSha256"]}), flush=True)
    return 0


def answers(args: argparse.Namespace) -> int:
    if args.output.exists():
        raise SystemExit(f"Refusing to overwrite existing predictions: {args.output}")
    model, vocabulary, _ = load_model(args.model, args.device)
    rows = read_rows(args.input)
    confidence_scores: list[float | None] = []
    results = answer_all(model, vocabulary, [row["input"]["message"] for row in rows], args.device,
                         confidence_scores=confidence_scores)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8", newline="\n") as stream:
        for row, answer, confidence in zip(rows, results, confidence_scores):
            result = {"id": row.get("id"), "split": args.input.stem, "source": row.get("source"), "capability": row.get("capability", "ads.goal.v2"),
                      "language": row.get("language"), "category": row.get("category"), "input": row["input"],
                      "expected": row.get("expected", row.get("output")), "answer_text": answer if answer is not None else "", "finished": answer is not None,
                      "confidence": confidence, "confidenceMethod": "minimum_decision_probability_v1"}
            if answer is None:
                result["error"] = "INPUT_TOO_LONG"
                result["error_detail"] = {"words": len(split_words(row["input"]["message"])[1]), "maximum_words": MAX_WORDS}
            stream.write(json.dumps(result, ensure_ascii=False) + "\n")
    print(json.dumps({"rows": len(rows), "output": str(args.output).replace("\\", "/"), "checkpointSha256": _sha256(args.model / "best.pt")}))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    training = commands.add_parser("train")
    training.add_argument("--data", required=True, type=Path)
    training.add_argument("--out", required=True, type=Path)
    training.add_argument("--epochs", type=int, default=8)
    training.add_argument("--batch", type=int, default=256)
    training.add_argument("--lr", type=float, default=1e-3)
    training.add_argument("--width", type=int, default=256)
    training.add_argument("--layers", type=int, default=4)
    training.add_argument("--seed", type=int, default=7)
    training.add_argument("--dropout", type=float, default=0.1)
    training.add_argument("--weight-decay", type=float, default=0.01)
    training.add_argument("--entity-word-dropout", type=float, default=None,
                          help="Probability of masking vocabulary IDs for a whole service/location span; characters remain available.")
    training.add_argument("--context-word-dropout", type=float, default=0.1,
                          help="Probability of masking vocabulary IDs for non-entity tokens; characters remain available.")
    training.add_argument("--word-variant-normalization", choices=["none", "sqrt"], default="none",
                          help="Normalize summed word variants by the square root of their non-padding count.")
    training.add_argument("--invented-name-probability", type=float, default=None,
                          help="Probability of replacing an entity word with a same-script invented word.")
    training.add_argument("--patience", type=int, default=0,
                          help="Stop after this many epochs without improvement in the weakest language; zero disables.")
    training.add_argument("--initialize-from", type=Path, default=None,
                          help="Continue a local checkpoint, remapping word/character embeddings to the new vocabulary.")
    training.add_argument("--field-presence", action="store_true",
                          help="Train optional sentence-level service/location presence heads and gate absent fields.")
    training.add_argument("--lexicon", type=Path, default=None,
                          help="folder with lexicon.pt from lexicon.py: word vectors and statistics learnt from local text")
    training.add_argument("--presence-warmup-epochs", type=int, default=0,
                          help="Train only new presence heads for the first N epochs, then unfreeze all parameters.")
    answering = commands.add_parser("answers")
    answering.add_argument("--model", required=True, type=Path)
    answering.add_argument("--input", required=True, type=Path)
    answering.add_argument("--output", required=True, type=Path)
    for command in (training, answering):
        command.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    args = parser.parse_args()
    if args.command == "train":
        if min(args.epochs, args.batch, args.width, args.layers) <= 0 or args.width % 4:
            parser.error("Epochs, batch, width and layers must be positive; width must be divisible by four.")
        if not math.isfinite(args.lr) or args.lr <= 0 or not math.isfinite(args.weight_decay) or args.weight_decay < 0:
            parser.error("Learning rate must be positive and weight decay nonnegative.")
        if args.patience < 0 or not 0 <= args.dropout < 1:
            parser.error("Patience must be nonnegative and dropout in [0, 1).")
        for probability in (args.entity_word_dropout, args.invented_name_probability, args.context_word_dropout):
            if probability is not None and not 0 <= probability <= 1:
                parser.error("Augmentation probabilities must be in [0, 1].")
    import torch
    if args.device == "cuda" and not torch.cuda.is_available():
        parser.error("CUDA was requested but is unavailable; choose --device cpu explicitly.")
    sys.stdout.reconfigure(encoding="utf-8")
    return train(args) if args.command == "train" else answers(args)


if __name__ == "__main__":
    raise SystemExit(main())
