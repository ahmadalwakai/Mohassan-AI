"""Quarantine concrete Aya defects found by source-only review; preserve v2.

The 100-case review is stratified and purposive, not a random accuracy estimate.
Remaining annotations are not comprehensively fact-checked. This is a bounded
local language experiment, not a vetted knowledge base or production dataset.
"""
from __future__ import annotations

from collections import Counter
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "artifacts/chat-training/conversation-v2/dataset"
OUT = ROOT / "artifacts/chat-training/conversation-v2b"

REVIEW_FINDINGS = {
    5: ("scope_concern", "Factual market-news continuation is unsupported by a source and date; not a self-contained conversational answer."),
    10: ("suspected_factual_error", "The specific count236requires verification; quarantine rather than assume the annotation is correct."),
    11: ("underspecified_time", "World Cup qualification count depends on date and the country description is not unique."),
    16: ("scope_concern", "Continues undated foreign-exchange news with unsupported numeric prices."),
    17: ("concrete_defect", "Asked for praise poetry, but answer denigrates its subjects; intent mismatch."),
    19: ("missing_context", "Continues an unidentified Turkish company's real-world statement without its source."),
    21: ("unsupported_specificity", "Adds a specific40-day religious-history claim without establishing its source."),
    22: ("concrete_defect", "Prompt explicitly identifies novelistNajmWali and interviewerImadAbdAlRadi; answer chooses the interviewer as novelist."),
    29: ("malformed_name", "Proper-name answer is visibly corrupted; quarantine instead of silently repairing the label."),
    30: ("ambiguous_label", "Sarcasm label is ambiguous given the contradictory wording and emoji; no adjudication supplied."),
    33: ("concrete_defect", "Quoted Quran104:4contains corrupted words. Primary text: https://quran.ksu.edu.sa/tafseer/baghawy/sura104-aya4.html"),
    35: ("scope_concern", "Uncited historical source continuation is excluded from this natural-answer curriculum."),
    37: ("scope_concern", "Uncited historical source continuation is excluded from this natural-answer curriculum."),
    39: ("scope_concern", "Uncited historical source continuation is excluded from this natural-answer curriculum."),
    41: ("underspecified_ruling", "Categorical religious ruling lacks relevant interpretive context; excluded from this experimental curriculum."),
    45: ("unsupported_specificity", "Precise ancient lifespan claim is not established by supplied evidence."),
    49: ("concrete_defect", "Total human cell count stated as millions is misleading in scale; original research estimates tens of trillions. https://pmc.ncbi.nlm.nih.gov/articles/PMC10523466/"),
    50: ("underspecified_time", "Record-holder sports question has no date; excluded from static conversational supervision."),
    51: ("unverified_niche_premise", "Unverified culturally specific headgear premise and promotional assertions; quarantine pending source verification."),
    53: ("concrete_defect", "English-labelled prompt and response are Somali; script-only filtering missed the language-label error."),
    54: ("unverified_niche_premise", "Specific traditional-sport description is suspect and has not been verified from a primary source."),
    55: ("unverified_quantity", "Specific lake area requires a date/source and was not verified; quarantine numeric assertion."),
    63: ("scope_concern", "Input is an unfinished first-person fragment, rather than a self-contained chat request."),
    68: ("concrete_defect", "Definition's second half is a broken sentence beginning'While The capacity'and omits the term being defined."),
    81: ("concrete_defect", "Prompt omits the actual joke, but answer invents aTheodorejoke and explains absent content."),
    82: ("malformed_target", "Answer ends with an unmatched quotation mark; preserve source and exclude instead of silently repairing."),
    90: ("concrete_defect", "Odd-one-out rationale excludes the heart from physiological organs, contradicting its own criterion."),
}

# Additional defects observed in the initial24-case sample, before the100-case
# stratified review. Prefixes are resolved to unique full IDs before writing.
INITIAL_FINDINGS = {
    "aya-f5c8bb2e97fcdcb3": ("concrete_defect", "Incorrect claim that teleportation enables instant communication. Classical communication remains necessary: https://www.nasa.gov/wp-content/uploads/2024/07/quantum-communication-101-final.pdf"),
    "aya-e70507ad235f7d17": ("concrete_defect", "Part-of-speech answer tags additional words not present in the input."),
    "aya-4aee54d078a1e52b": ("unverified_quantity", "Europe-country count32has no definition, date or support; exclude rather than invent a corrected total."),
    "aya-198fc1d9c97060f0": ("ambiguous_label", "Riddle claims air exists in everything; an unsupported universal claim is unsuitable as factual supervision."),
    "aya-4729409f18031549": ("malformed_prompt", "Question ends in malformed wordالمسلمينات; quarantine rather than guess the intended historical question."),
    "aya-db7a4a0e364d6c9a": ("underspecified_time", "Most-users app claim has no metric or date; source targetInstagramis not established."),
    "aya-6cc34004728955d2": ("unverified_niche_premise", "Describes a contentious metallic-hydrogen research claim as an achievement without qualification; requires source review."),
    "aya-1a59daa9aa66692c7": ("underspecified_ruling", "Sweeping religious-duty exemptions andmake-upobligations lack context; excluded from this curriculum."),
    "aya-0e252d34575642c2": ("underspecified_ruling", "Categorical religious marriage ruling without interpretive context; excluded from this curriculum."),
    "aya-4c92e4d55fd59d1": ("unverified_date", "Specific foundation date suspected inconsistent; quarantine pending verification, not relabeling."),
}

CONTINUATION = re.compile(r"^(?:كمل|أكمل|اكمل)\s+(?:النص|الفقرة|الجملة)|\b(?:complete|continue)\s+(?:the\s+|this\s+|following\s+)*(?:sentence|paragraph|passage)\b", re.IGNORECASE)
RULING = re.compile(r"حلال|حرام|يجوز للمسلمين|الأعذار.*الفروض|الاعذار.*الفروض")
SOMALI = re.compile(r"\b(?:waa maxay|qayb ka mid|taas oo|waxaa|waxay|cilmiga)\b", re.IGNORECASE)


def mechanical_reason(row: dict) -> str | None:
    if row["source"] != "aya_train":
        return None
    question, answer = row["messages"][0]["content"], row["target"]
    if CONTINUATION.search(question) and not re.search(r"multiple choices|answer choices|\na\.", question, re.IGNORECASE):
        return "source_continuation_outside_curriculum"
    if question.endswith(("...", "…")):
        return "unfinished_prompt_fragment"
    if RULING.search(question):
        return "context_dependent_religious_ruling"
    if answer.count('"') % 2:
        return "unmatched_double_quote_in_answer"
    if row["language"] == "en" and SOMALI.search(question + "\n" + answer) and "translat" not in question.lower():
        return "english_label_with_somali_markers"
    if "predict the tags for each word:" in question.lower():
        supplied = question.split(":", 1)[1]
        allowed = {token.casefold() for token in re.findall(r"\w+|[^\w\s]", supplied)}
        for line in answer.splitlines():
            matched = re.fullmatch(r"([^:]+):\s*(?:NOUN|ADJ|ADV|VERB|AUX|PRON|DET|ADP|CCONJ|SCONJ|PUNCT|SYM|PROPN|NUM|PART|noun|adjective|adverb|verb).*", line.strip())
            if matched and any(token.casefold() not in allowed for token in re.findall(r"\w+|[^\w\s]", matched[1])):
                return "pos_answer_adds_absent_tokens"
    return None


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main() -> None:
    destination = OUT / "dataset"
    if destination.exists():
        raise RuntimeError("Never overwrite an existing dataset version.")
    sample = json.loads((OUT / "qa/source-review-sample.json").read_text(encoding="utf-8"))
    source_rows = {split: [json.loads(line) for line in (SOURCE / f"{split}.jsonl").read_text(encoding="utf-8").splitlines()] for split in ("train", "validation")}
    all_rows = [row for rows in source_rows.values() for row in rows]
    manual = {row["id"]: REVIEW_FINDINGS[row["review_index"]] for row in sample if row["review_index"] in REVIEW_FINDINGS}
    for prefix, finding in INITIAL_FINDINGS.items():
        matches = [row["id"] for row in all_rows if row["id"].startswith(prefix)]
        if len(matches) != 1:
            raise RuntimeError(f"Manual exclusion prefix is not unique: {prefix}")
        manual[matches[0]] = finding
    exclusions = []
    result = {}
    for split, rows in source_rows.items():
        kept = []
        for row in rows:
            finding = manual.get(row["id"])
            reason = mechanical_reason(row)
            if finding or reason:
                exclusions.append({"split": split, "id": row["id"], "language": row["language"],
                                   "category": finding[0] if finding else "mechanical_filter",
                                   "reason": finding[1] if finding else reason,
                                   "mechanical_reason": reason})
            else:
                kept.append(row)
        # Balance language counts without replacing excluded examples or resplitting.
        by_language = {language: [row for row in kept if row["language"] == language] for language in ("ar", "en")}
        take = min(len(values) for values in by_language.values())
        balanced = []
        for language, group in by_language.items():
            # Preserve the local authored curriculum before taking public rows.
            group.sort(key=lambda row: (row["source"] == "aya_train", hashlib.sha256(row["id"].encode()).hexdigest()))
            balanced.extend(group[:take])
            for row in group[take:]:
                exclusions.append({"split": split, "id": row["id"], "language": language,
                                   "category": "balance", "reason": "language_balance_after_quarantine", "mechanical_reason": None})
        result[split] = balanced
    review = []
    for row in sample:
        finding = REVIEW_FINDINGS.get(row["review_index"])
        review.append({"index": row["review_index"], "id": row["id"], "language": row["language"],
                       "verdict": finding[0] if finding else "no_obvious_defect_in_limited_review",
                       "reason": finding[1] if finding else "Read for obvious instruction/answer consistency and language. Not independently fact-checked."})
    qa = {"sample_rows": len(sample), "sample_sha256": digest(OUT / "qa/source-review-sample.json"),
          "method": json.loads((OUT / "qa/sampling.json").read_text(encoding="utf-8")),
          "reviewer": "coding_agent_source_review", "human_verified": False,
          "concrete_defects_in_sample": sum(item["verdict"] == "concrete_defect" for item in review),
          "other_quarantined_concerns_in_sample": sum(item["verdict"] not in {"concrete_defect", "no_obvious_defect_in_limited_review"} for item in review),
          "findings": review,
          "limits": "Purposive stratification oversamples rare annotation/length groups. These counts are not population error-rate estimates. Remaining public annotations are not comprehensively verified; cleaned data is suitable only for a bounded local language-training experiment with independent behavioral evaluation."}
    (OUT / "qa/source-review-results.json").write_text(json.dumps(qa, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (OUT / "qa/exclusions.json").write_text(json.dumps(exclusions, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
    manifest["curriculum"] = "mohassan-conversation-v2b-aya-quarantine"
    manifest["parent_dataset"] = {"path": str(SOURCE.relative_to(ROOT)), "train_sha256": digest(SOURCE / "train.jsonl"), "validation_sha256": digest(SOURCE / "validation.jsonl"), "modified": False}
    manifest["source_qa"] = {"review_file": str((OUT / "qa/source-review-results.json").relative_to(ROOT)),
                             "review_sha256": digest(OUT / "qa/source-review-results.json"), "sample_rows": len(sample),
                             "concrete_defects_in_sample": qa["concrete_defects_in_sample"], "other_concerns_in_sample": qa["other_quarantined_concerns_in_sample"],
                             "exclusions_sha256": digest(OUT / "qa/exclusions.json"), "exclusion_categories": dict(Counter(item["category"] for item in exclusions)),
                             "mechanical_exclusions": dict(Counter(item["mechanical_reason"] for item in exclusions if item["mechanical_reason"])),
                             "vetted": False, "production_ready": False, "all_rows_fact_checked": False}
    manifest["splits"] = {}
    destination.mkdir(parents=True, exist_ok=False)
    for split, rows in result.items():
        rows.sort(key=lambda row: hashlib.sha256(("v2b:" + row["id"]).encode()).hexdigest())
        data = ("\n".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows) + "\n").encode("utf-8")
        (destination / f"{split}.jsonl").write_bytes(data)
        manifest["splits"][split] = {"rows": len(rows), "languages": dict(Counter(row["language"] for row in rows)),
                                      "sources": dict(Counter(row["source"] for row in rows)), "sha256": hashlib.sha256(data).hexdigest()}
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(destination), "splits": manifest["splits"], "source_qa": manifest["source_qa"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
