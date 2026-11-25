"""Export row lineage from the frozen public-data preparers and loaders for the v2 audit."""

import argparse
import hashlib
import importlib
import importlib.util
import json
import re
import sys
import tempfile
import zipfile
from collections import Counter, defaultdict, deque
from pathlib import Path


def load_script(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def clinc_lineage(path):
    locations = defaultdict(deque)
    rows = json.loads(path.read_bytes())
    for split in ("train", "val", "test"):
        for partition in (split, f"oos_{split}"):
            for index, (text, intent) in enumerate(rows[partition]):
                locations[split, text, intent].append((partition, f"clinc150:{partition}:{index}"))
    return locations


def aya_lineage(path):
    locations = defaultdict(deque)
    with path.open(encoding="utf-8") as stream:
        for index, line in enumerate(stream):
            locations[line].append(index)
    return locations


def record(branch, source, split, upstream_split, source_id, texts, *, aliases=(), task=None):
    role = "eligible" if branch == 44 else {
        "train": "fit", "dev": "selection", "development": "selection",
        "calibration": "selection", "test": "evaluation",
    }[split]
    result = {
        "branch": branch, "source": source, "split": split, "role": role,
        "upstream_split": upstream_split, "source_id": source_id,
        "texts": list(dict.fromkeys(texts)),
    }
    if aliases:
        result["source_ids"] = list(aliases)
    if task is not None:
        result["task"] = task
    return result


def refusal_rows(root, cache):
    trainer = load_script("audit_refusal_train", root / "scripts/refusal-classifier/train.py")
    sources = {name: trainer.pinned_source(cache, name) for name in trainer.SOURCES}
    clinc = clinc_lineage(sources["clinc150.json"])
    aya = {locale: aya_lineage(sources[f"aya-{locale}.jsonl"]) for locale in ("arb", "eng")}
    observed = {}
    generated = trainer.public_rows(cache)
    rows = []
    for row in generated:
        # The generator still holds its upstream row at each yield. Capture its
        # ID before the original deduplicator removes or moves occurrences.
        local = generated.gi_frame.f_locals
        if row.dataset == "clinc150":
            lineage = clinc[local["partition"], row.text, row.source].popleft()
        elif row.dataset == "massive-ar":
            native = local["row"]
            lineage = native["partition"], f"massive:ar-SA:{native['id']}"
        else:
            locale = local["locale"]
            lineage = locale, f"aya-redteaming:{locale}:{aya[locale][local['line']].popleft()}"
        observed[id(row)] = lineage
        rows.append(row)
    for row in trainer.deduplicate(rows):
        upstream, source_id = observed[id(row)]
        yield record(57, row.dataset, row.split, upstream, source_id, [row.text])


def scratch_lineage(dataset, local, clinc, aya):
    if dataset == "clinc150":
        return clinc[local["name"], local["text"], local["intent"]].popleft()
    native = local["row"]
    if dataset.startswith("massive-"):
        return native["partition"], f"massive:{local['locale']}:{native['id']}"
    if dataset == "canard":
        return local["name"], f"canard:{native['QuAC_dialog_id']}:{native['Question_no']}"
    if dataset == "arbanking77-pal":
        return local["name"], f"arbanking77:{native['QID']}"
    locale = local["locale"]
    return locale, f"aya-redteaming:{locale}:{aya[locale][local['line']].popleft()}"


def scratch_rows(root, cache):
    package = root / "packages/scratch-classifiers"
    sys.path.insert(0, str(package))
    preparer = load_script("audit_scratch_prepare", package / "prepare_data.py")
    source_metadata = json.loads((preparer.DATA_DIR / "sources.json").read_bytes())
    sources = {name: preparer.pin_source(cache, name, spec) for name, spec in source_metadata.items()}
    mapping = json.loads((preparer.DATA_DIR / "label-map.json").read_bytes())
    seed = preparer.SEED
    clinc = clinc_lineage(sources["clinc150.json"])
    aya = {locale: aya_lineage(sources[f"aya-{locale}.jsonl"]) for locale in ("arb", "eng")}
    readers = (
        preparer.clinc_rows(sources["clinc150.json"], mapping, seed),
        preparer.massive_rows(sources["massive.tar.gz"], mapping, seed),
        preparer.canard_rows(sources["canard.zip"], seed),
        preparer.dialect_rows(sources["arbanking77.csv"], mapping, seed),
        preparer.red_teaming_rows(sources["aya-arb.jsonl"], mapping, seed, "arb"),
        preparer.red_teaming_rows(sources["aya-eng.jsonl"], mapping, seed, "eng"),
    )
    observed = {}
    rows = []
    for reader in readers:
        for row in reader:
            observed[id(row)] = scratch_lineage(row.dataset, reader.gi_frame.f_locals, clinc, aya)
            rows.append(row)
    prepared = preparer.deduplicate(rows)
    digest = hashlib.sha256()
    for row in prepared:
        # The deduplicator can construct a replacement with a subset of the
        # labels. Its suspended `row` remains the input whose text was kept.
        original = prepared.gi_frame.f_locals["row"]
        upstream, source_id = observed[id(original)]
        texts = [row.text, row.previous] if row.previous is not None else [row.text]
        digest.update((json.dumps(row.as_json(), ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8"))
        yield record(47, row.dataset, row.split, upstream, source_id, texts)
    expected = json.loads((package / "models/metrics.json").read_bytes())["dataSha256"]
    if digest.hexdigest() != expected:
        raise ValueError("PR #47 preparation does not match the committed model's training-data digest")
    print(f"PR #47 prepared data SHA-256 {digest.hexdigest()}")


def canard_quac_index(path):
    questions = {}
    with zipfile.ZipFile(path) as archive:
        for partition in ("train", "dev", "test"):
            with archive.open(f"CANARD_Release/{partition}.json") as stream:
                for row in json.load(stream):
                    questions[row["QuAC_dialog_id"], row["Question_no"]] = row["Question"]
    return questions


def head_source_ids(example, canard_questions):
    source_id = example.id
    aliases = ()
    if example.source == "massive":
        _, language, key = source_id.split(":", 2)
        locale = {"ar": "ar-SA", "en": "en-US"}[language]
        source_id = f"massive:{locale}:{key}"
    elif example.source == "tydiqa":
        _, language, key = source_id.split(":", 2)
        prefix = {"ar": "arabic-", "en": "english-"}[language]
        if not key.startswith(prefix):
            raise ValueError("Unexpected TyDiQA question ID language prefix")
        source_id = f"tydiqa:{key.removeprefix(prefix)}:{language}"
    elif example.source == "quac":
        match = re.fullmatch(r"(C_[a-f0-9]+_\d+)_q#(\d+)", source_id.removeprefix("quac:"))
        if match:
            dialogue, index = match.groups()
            number = int(index) + 1
            if canard_questions.get((dialogue, number)) == example.text:
                aliases = (f"canard:{dialogue}:{number}",)
    return source_id, aliases


def head_rows(root, cache):
    sys.path.insert(0, str(root / "packages/head-training"))
    datasets = importlib.import_module("head_training.datasets")
    canard_file, _ = datasets._download(
        datasets.CATALOG["canard"].files[0], cache / "canard", allow_download=True,
    )
    canard_questions = canard_quac_index(canard_file)
    for name, card in datasets.CATALOG.items():
        for task in card.tasks:
            loaded = datasets.load_dataset(name, task, cache)
            print(f"PR #44 {name}/{task} {len(loaded.examples)} {loaded.fingerprint}", flush=True)
            for row in loaded.examples:
                source_id, aliases = head_source_ids(row, canard_questions)
                texts = (row.text, *row.history, *row.candidates)
                yield record(44, name, row.source_partition, row.source_partition, source_id, texts,
                             aliases=aliases, task=task)


def write_rows(path, rows):
    """Publish a complete private JSONL file without replacing an existing export."""
    counts = Counter()
    output = tempfile.NamedTemporaryFile(dir=path.parent, encoding="utf-8", mode="w", newline="\n", delete=False)
    temporary = Path(output.name)
    try:
        with output:
            for row in rows:
                output.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
                counts[row["source"], row["split"]] += 1
        path.hardlink_to(temporary)
    finally:
        temporary.unlink()
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshots", type=Path, required=True, help="Git-exported candidate scripts")
    parser.add_argument("--cache", type=Path, required=True, help="Scratch directory for pinned public sources")
    parser.add_argument("--branch", type=int, choices=(44, 47, 57), required=True)
    parser.add_argument("--output", type=Path, required=True, help="New private scratch JSONL file")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    extract = {44: head_rows, 47: scratch_rows, 57: refusal_rows}[args.branch]
    counts = write_rows(args.output, extract(args.snapshots.resolve(), args.cache))
    for (source, split), count in sorted(counts.items()):
        print(f"PR #{args.branch} {source} {split} {count}")


if __name__ == "__main__":
    main()
