"""Data for H4, the answer-sentence picker (docs/RESPONSE-QUALITY-PLAN-2026-11-22.md, phase 3).

Each example is a question with candidate sentences; the label is the index of the sentence
that holds the answer, or null when no candidate can answer. Built only from the human-written
QA sets already downloaded and licence-checked (artifacts/reading-data-raw, 2026-11-20/21):
  SQuAD 2.0 (en, CC BY-SA 4.0), TyDi QA GoldP (ar + en, Apache-2.0), ARCD (ar, MIT),
  Arabic-SQuAD (ar, MIT, SOQAL repository).
XQuAD is the spent independent set (final check only): only its article titles are read, to keep those
articles out of every split. ARCD test titles are kept out of dev and calibration for the same reason.

Hard cases, as the plan asks:
  same-page sentences   every candidate list is the answer's own paragraph window
  similar passages      sentences from the most word-similar paragraph of ANOTHER article are mixed in,
                        and some examples replace the paragraph with that one (label null)
  no answer             SQuAD 2.0 native no-answer questions, and the gold sentence deleted (label null)
  conflicting values    a copy of the gold sentence with another year, number or name (kind "conflict")

Splits never share an article title:
  train        SQuAD train, TyDi train (ar, en), ARCD train, Arabic-SQuAD
  dev          TyDi validation and SQuAD dev, about 70% of their titles
  calibration  the other 30% of those titles, for thresholds only
  test_arcd    ARCD test, never used for training or tuning
  conflict_eval a separate conflict set built from dev titles, for experiment E3.3

Usage (with .venv-execution): python -I scripts/answer-select/make_sentence_data.py OUT_DIR
"""
from __future__ import annotations

import hashlib
import json
import math
import random
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "artifacts" / "reading-data-raw"
SEED = 20261122
MAX_CANDIDATES = 12
MAX_PASSAGE_CHARS = 1600
SQUAD_TRAIN_ANSWERABLE = 30000
SQUAD_TRAIN_UNANSWERABLE = 6000
ARABIC_SQUAD_CAP = 30000
DELETED_SHARE = 0.10
SIMILAR_REPLACE_SHARE = 0.08
SIMILAR_MIX_SHARE = 0.25
SIMILAR_MIX_SENTENCES = 3
CONFLICT_SHARE = 0.03
CONFLICT_EVAL_SHARE = 0.5   # the first build gave only 21 conflict rows at 0.03, too few to measure E3.3
DEV_TITLE_SHARE = 0.70
# Every SQuAD 2.0 dev article is an XQuAD article (the first build lost all English dev rows once XQuAD
# titles were excluded), so English dev/calibration come from SQuAD train articles held out of training.
SQUAD_HELDOUT_TITLE_SHARE = 0.08
SQUAD_HELDOUT_CAP = 4000
SENTENCE = re.compile(r"(?<=[.!?؟])\s+|\n+")
WORD = re.compile(r"[\w؀-ۿ]+", re.UNICODE)
STOP = set("""the a an of in on at to for and or is are was were be by with from as that this which who what when where how
why did does do its it his her their they he she ما ماذا من متى متي كم أين اين هل في على علي عن إلى الى من التي الذي الذين هو هي
كان كانت و أو او ثم لم لن قد""".split())
LICENCES = {
    "squad2": {"licence": "CC BY-SA 4.0", "language": "en", "files": ["squad2/train-v2.0.json", "squad2/dev-v2.0.json"]},
    "tydi": {"licence": "Apache-2.0", "language": "ar, en", "files": ["tydiqa-goldp/train.parquet", "tydiqa-goldp/validation.parquet"]},
    "arcd": {"licence": "MIT", "language": "ar", "files": ["arcd/arcd-train.json", "arcd/arcd-test.json"]},
    "arabic-squad": {"licence": "MIT (SOQAL repository)", "language": "ar", "files": ["arabic-squad/Arabic-SQuAD.json"]},
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def spans(context: str) -> list[tuple[int, int]]:
    out, start = [], 0
    for match in SENTENCE.finditer(context):
        out.append((start, match.start()))
        start = match.end()
    out.append((start, len(context)))
    return [(a, b) for a, b in out if context[a:b].strip()]


def window(context: str, gold: int | None, rng: random.Random) -> list[str] | None:
    """Whole sentences around the gold one, at most MAX_CANDIDATES and MAX_PASSAGE_CHARS."""
    sentences = [context[a:b].strip() for a, b in spans(context)]
    if not sentences:
        return None
    if gold is None:
        gold = rng.randrange(len(sentences))
    lo = hi = gold
    if len(sentences[gold]) > MAX_PASSAGE_CHARS:
        return None
    size = len(sentences[gold])
    while hi - lo + 1 < MAX_CANDIDATES:
        options = [index for index in (lo - 1, hi + 1) if 0 <= index < len(sentences) and size + len(sentences[index]) <= MAX_PASSAGE_CHARS]
        if not options:
            break
        pick = rng.choice(options)
        size += len(sentences[pick])
        lo, hi = min(lo, pick), max(hi, pick)
    return sentences[lo:hi + 1], gold - lo  # type: ignore[return-value]


def gold_sentence(context: str, start: int, end: int) -> int | None:
    for index, (a, b) in enumerate(spans(context)):
        if a <= start and end <= b + 1:
            return index
    return None


def squad_like(path: Path, language: str, source: str, keep_impossible: bool) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))["data"]
    items = []
    for article in data:
        for paragraph in article["paragraphs"]:
            context = paragraph["context"]
            for qa in paragraph["qas"]:
                if qa.get("is_impossible"):
                    if keep_impossible:
                        items.append({"source": source, "language": language, "title": article["title"], "context": context,
                                      "question": qa["question"], "answer": None, "start": None, "native_no_answer": True})
                    continue
                answer = qa["answers"][0]
                start = answer["answer_start"]
                if context[start:start + len(answer["text"])] != answer["text"]:
                    start = context.find(answer["text"])
                    if start < 0:
                        continue
                items.append({"source": source, "language": language, "title": article["title"], "context": context,
                              "question": qa["question"], "answer": answer["text"], "start": start, "native_no_answer": False})
    return items


def tydi(path: Path, prefix: str, language: str) -> list[dict]:
    import pyarrow.parquet as pq
    items = []
    for row in pq.read_table(path).to_pylist():
        if not row["id"].startswith(prefix + "-"):
            continue
        text, start, context = row["answers"]["text"][0], row["answers"]["answer_start"][0], row["context"]
        if context[start:start + len(text)] != text:
            start = context.find(text)
            if start < 0:
                continue
        items.append({"source": "tydi", "language": language, "title": row["title"], "context": context,
                      "question": row["question"], "answer": text, "start": start, "native_no_answer": False})
    return items


def words(text: str) -> list[str]:
    return [word for word in (w.lower() for w in WORD.findall(text)) if len(word) > 2 and word not in STOP]


class SimilarIndex:
    """Most word-similar paragraph from another article, by IDF-weighted overlap with the question."""

    def __init__(self, items: list[dict]) -> None:
        self.paragraphs: list[tuple[str, str]] = []
        seen: dict[str, int] = {}
        for item in items:
            if item["context"] not in seen:
                seen[item["context"]] = len(self.paragraphs)
                self.paragraphs.append((item["title"], item["context"]))
        self.postings: dict[str, list[int]] = defaultdict(list)
        for index, (_, context) in enumerate(self.paragraphs):
            for word in set(words(context)):
                self.postings[word].append(index)
        total = len(self.paragraphs)
        self.idf = {word: math.log(1 + total / len(ids)) for word, ids in self.postings.items()}

    def best(self, question: str, title: str, answer: str | None) -> str | None:
        scores: Counter = Counter()
        for word in set(words(question)):
            ids = self.postings.get(word, [])
            if len(ids) > 2000:
                continue
            for index in ids:
                scores[index] += self.idf[word]
        for index, _ in scores.most_common(20):
            other_title, context = self.paragraphs[index]
            if other_title != title and (answer is None or answer not in context):
                return context
        return None


def example(item: dict, split: str, candidates: list[dict], label: int | None, kind: str, **extra) -> dict:
    key = json.dumps([item["source"], item["title"], item["question"], kind, [c["text"] for c in candidates]], ensure_ascii=False)
    return {"id": hashlib.sha256(key.encode("utf-8")).hexdigest()[:16], "split": split, "language": item["language"],
            "source": item["source"], "title": item["title"], "question": " ".join(item["question"].split()),
            "candidates": candidates, "label": label, "kind": kind, "answer": item["answer"], **extra}


def candidates_of(sentences: list[str], passage: str) -> list[dict]:
    return [{"text": " ".join(text.split()), "passage": passage, "position": index} for index, text in enumerate(sentences)]


ANSWER_TYPES = {"year": re.compile(r"^(?:1[0-9]{3}|20[0-9]{2})$"), "number": re.compile(r"^\d[\d,.]*$")}


def answer_type(item: dict) -> str | None:
    answer = (item["answer"] or "").strip()
    for name, pattern in ANSWER_TYPES.items():
        if pattern.match(answer):
            return name
    question = item["question"].strip().lower()
    if (question.startswith("who ") or question.startswith("من ")) and 2 <= len(answer) <= 40 and not any(ch.isdigit() for ch in answer):
        return "name"
    return None


def build(items: list[dict], split: str, index: SimilarIndex, rng: random.Random, pools: dict[str, dict[str, list[str]]],
          stats: Counter, conflicts_out: list[dict] | None = None) -> list[dict]:
    out = []
    for item in items:
        if item["native_no_answer"]:
            built = window(item["context"], None, rng)
            if not built:
                continue
            sentences, _ = built
            out.append(example(item, split, candidates_of(sentences, "A"), None, "unanswerable_native"))
            stats[(split, item["language"], "unanswerable_native")] += 1
            continue
        gold = gold_sentence(item["context"], item["start"], item["start"] + len(item["answer"]))
        if gold is None:
            stats[(split, item["language"], "dropped_answer_across_sentences")] += 1
            continue
        built = window(item["context"], gold, rng)
        if not built:
            stats[(split, item["language"], "dropped_long_sentence")] += 1
            continue
        sentences, position = built
        if item["answer"] not in sentences[position]:
            stats[(split, item["language"], "dropped_answer_not_in_sentence")] += 1
            continue
        roll = rng.random()
        if roll < DELETED_SHARE:
            kept = [text for i, text in enumerate(sentences) if i != position]
            if kept and not any(item["answer"] in text for text in kept):
                out.append(example(item, split, candidates_of(kept, "A"), None, "unanswerable_deleted"))
                stats[(split, item["language"], "unanswerable_deleted")] += 1
                continue
        elif roll < DELETED_SHARE + SIMILAR_REPLACE_SHARE:
            other = index.best(item["question"], item["title"], item["answer"])
            built_other = other and window(other, None, rng)
            if built_other:
                out.append(example(item, split, candidates_of(built_other[0], "B"), None, "unanswerable_similar"))
                stats[(split, item["language"], "unanswerable_similar")] += 1
                continue
        candidates = candidates_of(sentences, "A")
        label = position
        kind = "answerable"
        if rng.random() < SIMILAR_MIX_SHARE:
            other = index.best(item["question"], item["title"], item["answer"])
            if other:
                extra = [text for text in (other[a:b].strip() for a, b in spans(other)) if text][:SIMILAR_MIX_SENTENCES]
                if extra and not any(item["answer"] in text for text in extra):
                    candidates += [{"text": " ".join(text.split()), "passage": "B", "position": i} for i, text in enumerate(extra)]
                    kind = "answerable_with_similar"
        kind_of_answer = answer_type(item)
        if kind_of_answer and rng.random() < (CONFLICT_EVAL_SHARE if conflicts_out is not None else CONFLICT_SHARE):
            pool = pools[item["language"]].get(kind_of_answer, [])
            replacement = next((value for value in rng.sample(pool, min(20, len(pool))) if value != item["answer"]), None)
            if replacement:
                changed = candidates[label]["text"].replace(item["answer"], replacement, 1)
                conflict = candidates + [{"text": changed, "passage": "C", "position": 0}]
                record = example(item, split, conflict, None, "conflict", conflict_indices=[label, len(conflict) - 1],
                                 conflict_value=replacement, answer_type=kind_of_answer)
                (conflicts_out if conflicts_out is not None else out).append(record)
                stats[(split, item["language"], "conflict")] += 1
                if conflicts_out is not None:
                    pass
                else:
                    continue
        out.append(example(item, split, candidates, label, kind))
        stats[(split, item["language"], kind)] += 1
    return out


def answer_pools(items: list[dict]) -> dict[str, dict[str, list[str]]]:
    pools: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for item in items:
        kind = answer_type(item) if item["answer"] else None
        if kind:
            pools[item["language"]][kind].add(item["answer"].strip())
    return {language: {kind: sorted(values) for kind, values in kinds.items()} for language, kinds in pools.items()}


def write_jsonl(path: Path, rows: list[dict]) -> str:
    with path.open("w", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    return sha256(path)


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: make_sentence_data.py OUT_DIR")
    out = Path(sys.argv[1]).resolve()
    if not out.is_relative_to((ROOT / "artifacts").resolve()):
        raise SystemExit("OUT_DIR must be inside artifacts/")
    out.mkdir(parents=True, exist_ok=False)
    rng = random.Random(SEED)
    squad_train = squad_like(RAW / "squad2/train-v2.0.json", "en", "squad2", keep_impossible=True)
    squad_dev = squad_like(RAW / "squad2/dev-v2.0.json", "en", "squad2", keep_impossible=True)
    arcd_train = squad_like(RAW / "arcd/arcd-train.json", "ar", "arcd", keep_impossible=False)
    arcd_test = squad_like(RAW / "arcd/arcd-test.json", "ar", "arcd", keep_impossible=False)
    arabic_squad = squad_like(RAW / "arabic-squad/Arabic-SQuAD.json", "ar", "arabic-squad", keep_impossible=False)
    tydi_train = tydi(RAW / "tydiqa-goldp/train.parquet", "arabic", "ar") + tydi(RAW / "tydiqa-goldp/train.parquet", "english", "en")
    tydi_dev = tydi(RAW / "tydiqa-goldp/validation.parquet", "arabic", "ar") + tydi(RAW / "tydiqa-goldp/validation.parquet", "english", "en")

    xquad_titles = {article["title"] for name in ("xquad.en.json", "xquad.ar.json")
                    for article in json.loads((RAW / "xquad" / name).read_text(encoding="utf-8"))["data"]}
    arcd_test_titles = {item["title"] for item in arcd_test}
    squad_dev = [item for item in squad_dev if item["title"] not in xquad_titles]
    tydi_dev = [item for item in tydi_dev if item["title"] not in xquad_titles and item["title"] not in arcd_test_titles]
    squad_dev = [item for item in squad_dev if item["title"] not in arcd_test_titles]
    # Held-out titles: dev/calibration/test (and XQuAD) titles never appear in training, whatever the source.
    held_titles = {item["title"] for item in squad_dev + tydi_dev + arcd_test} | xquad_titles
    removed = Counter()

    def keep(items: list[dict], name: str) -> list[dict]:
        kept = [item for item in items if item["title"] not in held_titles]
        removed[name] = len(items) - len(kept)
        return kept

    squad_titles = sorted({item["title"] for item in squad_train} - held_titles)
    rng.shuffle(squad_titles)
    squad_heldout_titles = set(squad_titles[:int(len(squad_titles) * SQUAD_HELDOUT_TITLE_SHARE)])
    squad_heldout = [item for item in squad_train if item["title"] in squad_heldout_titles]
    rng.shuffle(squad_heldout)
    squad_heldout = squad_heldout[:SQUAD_HELDOUT_CAP]
    squad_train = [item for item in squad_train if item["title"] not in squad_heldout_titles]
    held_titles |= squad_heldout_titles
    squad_dev = squad_dev + squad_heldout
    rng.shuffle(squad_train)
    squad_answerable = [item for item in squad_train if not item["native_no_answer"]][:SQUAD_TRAIN_ANSWERABLE]
    squad_unanswerable = [item for item in squad_train if item["native_no_answer"]][:SQUAD_TRAIN_UNANSWERABLE]
    rng.shuffle(arabic_squad)
    train_items = (keep(squad_answerable + squad_unanswerable, "squad2_train") + keep(tydi_train, "tydi_train")
                   + keep(arcd_train, "arcd_train") + keep(arabic_squad[:ARABIC_SQUAD_CAP], "arabic_squad"))
    dev_titles = sorted({item["title"] for item in squad_dev + tydi_dev})
    rng.shuffle(dev_titles)
    cut = int(len(dev_titles) * DEV_TITLE_SHARE)
    dev_set, calibration_set = set(dev_titles[:cut]), set(dev_titles[cut:])
    dev_items = [item for item in squad_dev + tydi_dev if item["title"] in dev_set]
    calibration_items = [item for item in squad_dev + tydi_dev if item["title"] in calibration_set]

    stats: Counter = Counter()
    by_language: dict[str, list[dict]] = defaultdict(list)
    for item in train_items + dev_items + calibration_items + arcd_test:
        by_language[item["language"]].append(item)
    indexes = {language: SimilarIndex(items) for language, items in by_language.items()}
    pools = {language: answer_pools(items) for language, items in by_language.items()}
    pools = {language: pools[language][language] if language in pools[language] else {} for language in pools}

    def build_split(items: list[dict], split: str, conflicts: list[dict] | None = None) -> list[dict]:
        rows = []
        for language in ("ar", "en"):
            subset = [item for item in items if item["language"] == language]
            if subset:
                rows += build(subset, split, indexes[language], rng, pools, stats, conflicts)
        rng.shuffle(rows)
        return rows

    conflict_eval: list[dict] = []
    splits = {
        "train": build_split(train_items, "train"),
        "dev": build_split(dev_items, "dev", conflict_eval),
        "calibration": build_split(calibration_items, "calibration"),
        "test_arcd": build_split(arcd_test, "test_arcd"),
    }
    splits["conflict_eval"] = conflict_eval
    titles = {name: {row["title"] for row in rows} for name, rows in splits.items()}
    titles["xquad"] = xquad_titles
    overlaps = {f"{a}&{b}": len(titles[a] & titles[b]) for a in titles for b in titles if a < b}
    by_design = {"conflict_eval&dev"}  # conflict_eval is built from dev titles on purpose
    hashes = {name: write_jsonl(out / f"{name}.jsonl", rows) for name, rows in splits.items()}
    card = {
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"), "seed": SEED,
        "purpose": "H4 answer-sentence picker and H5 sufficiency check, phase 3 of docs/RESPONSE-QUALITY-PLAN-2026-11-22.md",
        "sources": {name: {**info, "sha256": {file: sha256(RAW / file) for file in info["files"]}} for name, info in LICENCES.items()},
        "xquad_use": "article titles only, to keep the spent independent set's articles out of every split",
        "excluded_from_dev_and_calibration": "XQuAD titles and ARCD test titles",
        "squad_dev_note": "SQuAD 2.0 dev is unused: all of its articles are XQuAD articles. English dev/calibration "
                          "come from SQuAD train articles held out of training",
        "squad_heldout_titles": len(squad_heldout_titles), "squad_heldout_rows": len(squad_heldout),
        "rules": {"max_candidates": MAX_CANDIDATES, "max_passage_chars": MAX_PASSAGE_CHARS, "deleted_share": DELETED_SHARE,
                  "similar_replace_share": SIMILAR_REPLACE_SHARE, "similar_mix_share": SIMILAR_MIX_SHARE,
                  "similar_mix_sentences": SIMILAR_MIX_SENTENCES, "conflict_share": CONFLICT_SHARE,
                  "squad_train_answerable_cap": SQUAD_TRAIN_ANSWERABLE, "squad_train_unanswerable_cap": SQUAD_TRAIN_UNANSWERABLE,
                  "arabic_squad_cap": ARABIC_SQUAD_CAP, "dev_title_share": DEV_TITLE_SHARE,
                  "sentence_split": SENTENCE.pattern, "similar_index": "IDF-weighted question-word overlap, other article only"},
        "train_rows_removed_for_held_out_titles": dict(removed),
        "title_overlap_between_splits": overlaps,
        "rows": {name: len(rows) for name, rows in splits.items()},
        "rows_by_split_language_kind": {f"{s}|{l}|{k}": n for (s, l, k), n in sorted(stats.items())},
        "sha256": hashes, "code_sha256": sha256(Path(__file__)),
    }
    (out / "data-card.json").write_text(json.dumps(card, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"rows": card["rows"], "title_overlap_between_splits": overlaps,
                      "removed": dict(removed)}, ensure_ascii=False))
    return 0 if not any(count for pair, count in overlaps.items() if pair not in by_design) else 2


if __name__ == "__main__":
    raise SystemExit(main())
