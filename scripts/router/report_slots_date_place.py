"""Read-only postprocessing of fixed cached public predictions; no model inference."""
from __future__ import annotations
import hashlib
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASELINE = ROOT / "artifacts/brain-slot-development-v1/first-cpu-20261121-a"
RUN = ROOT / "artifacts/brain-slot-date-place-development-v2/first-three-cpu-20261121-b"
OUTPUT = ROOT / "artifacts/brain-slot-date-place-development-v2/first-three-cpu-20261121-b-analysis-a"
LABELS = ("date", "place")


def sha(value): return hashlib.sha256(value).hexdigest()
def read(path): return json.loads(path.read_text(encoding="utf-8"))
def encode(value): return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def verify(directory):
    values = read(directory / "checksums.json")
    for name, expected in values.items():
        if "/" in name or "\\" in name or Path(name).name != name or sha((directory / name).read_bytes()) != expected:
            raise ValueError("cached_report_checksum")
    return values


def summary(values):
    tp, fp, fn = values["tp"], values["fp"], values["fn"]
    return {**dict(values), "precision": tp / (tp + fp) if tp + fp else None, "recall": tp / (tp + fn) if tp + fn else None,
            "exactSpanF1": 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 0}


def metrics(entries, selected):
    total = Counter(); slots = {label: Counter() for label in LABELS}; languages = {locale: Counter() for locale in ("ar-SA", "en-US")}
    confidence = {label: [0] * 4 for label in LABELS}
    for entry in entries:
        gold = {tuple(span) for span in entry["gold"] if span[0] in LABELS}
        proposals = [span for span in entry["predictions"] if span["label"] in LABELS and (not selected or span["accepted"])]
        actual = {(span["label"], span["startCodepoint"], span["endCodepoint"]) for span in proposals}
        if len(proposals) != len(actual): raise ValueError("duplicate_cached_prediction")
        for span in proposals:
            value = span["confidence"]
            if not 0 <= value <= 1: raise ValueError("cached_confidence_bound")
            confidence[span["label"]][0 if value < .8 else 1 if value < .9 else 2 if value < .95 else 3] += 1
        for label in LABELS:
            truth, guesses = {key for key in gold if key[0] == label}, {key for key in actual if key[0] == label}
            update = {"tp": len(truth & guesses), "fp": len(guesses - truth), "fn": len(truth - guesses), "gold": len(truth), "predicted": len(guesses)}
            total.update(update); slots[label].update(update); languages[entry["locale"]].update(update)
    return {"overall": summary(total), "perSlot": {key: summary(value) for key, value in slots.items()},
            "perLocale": {key: summary(value) for key, value in languages.items()},
            "confidenceBuckets": {"intervals": ["[0,.8)", "[.8,.9)", "[.9,.95)", "[.95,1]"], "counts": confidence}}


def main():
    run_sums, baseline_sums = verify(RUN), verify(BASELINE)
    final, baseline = read(RUN / "final-test.json"), read(BASELINE / "report.json")
    old_entries, new_entries = baseline["test"]["selective"]["predictions"], final["predictions"]
    if {entry["rowHash"] for entry in old_entries} != {entry["rowHash"] for entry in new_entries}: raise ValueError("paired_membership")
    result = {name: {"raw": metrics(entries, False), "accepted": metrics(entries, True)} for name, entries in (("baseline", old_entries), ("candidate", new_entries))}
    if result["candidate"]["accepted"]["overall"] != final["selective"]["overall"] or result["candidate"]["raw"]["overall"] != final["raw"]["overall"]:
        raise ValueError("independent_cached_metric_disagreement")
    for name in result:
        raw = result[name]["raw"]["overall"]["predicted"]; kept = result[name]["accepted"]["overall"]["predicted"]
        result[name]["spanAcceptanceCoverage"] = kept / raw if raw else None
    report = {"active": False, "source": "fixed cached public predictions; no model inference or parameter changes", "rows": len(new_entries),
              "targetLabels": LABELS, "candidateId": final["candidateId"], "metrics": result, "pairedComparison": final["pairedComparison"],
              "inputs": {"finalTestSha256": run_sums["final-test.json"], "selectionSha256": run_sums["selection.json"], "baselineReportSha256": baseline_sums["report.json"]}}
    OUTPUT.mkdir(parents=True, exist_ok=False)
    for name, payload in (("report.json", encode(report)), ("source-report_slots_date_place.py", Path(__file__).read_bytes())):
        with (OUTPUT / name).open("xb") as handle: handle.write(payload)
    sums = {path.name: sha(path.read_bytes()) for path in OUTPUT.iterdir()}
    with (OUTPUT / "checksums.json").open("xb") as handle: handle.write(encode(sums))
    print(json.dumps({"directory": str(OUTPUT.relative_to(ROOT)), "baselineRaw": result["baseline"]["raw"]["overall"],
                      "candidateRaw": result["candidate"]["raw"]["overall"], "filesVerifiedInRun": len(run_sums)}, ensure_ascii=True))


if __name__ == "__main__": main()
