"""Read a fixed sample of complete documents from the v5 training token bins."""

from __future__ import annotations

import argparse
from collections.abc import Iterator
from contextlib import suppress
from hashlib import sha256
import json
from itertools import zip_longest
from pathlib import Path
import random
import sys

import numpy as np

if __name__ == "__main__":
    sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages/execution-pipeline"))
from execution_pipeline.chat import conversation_prompt, sha256_file  # noqa: E402
from execution_pipeline.language_adaptation import LANGUAGES, corpus_manifest  # noqa: E402
from execution_pipeline.pretrain import TextEncoder  # noqa: E402


# Owner's training plan section 8.8, pre-registered 2026-11-25.
SEED = 20261125
DOCUMENTS_PER_LANGUAGE = 10
EOS = 258
CONTEXT_TOKENS = 512
PROSE_CHARACTERS = 600

# The same read-only little-endian uint16 mapping as the v5 trainer's adapt().
# https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff765071657cf200b5ee7d12fabaad738c0b/packages/execution-pipeline/execution_pipeline/language_adaptation.py#L337
# Retrieved 2026-11-25.
TOKEN_DTYPE = "<u2"
SCAN_TOKENS = 65_536


def next_eos(tokens: np.ndarray, offset: int) -> int | None:
    for start in range(offset, len(tokens), SCAN_TOKENS):
        matches = np.flatnonzero(tokens[start:start + SCAN_TOKENS] == EOS)
        if matches.size:
            return start + int(matches[0])
    return None


def document_cut(tokens: np.ndarray, draw_offset: int) -> tuple[int, int] | None:
    """Return the document's start and exclusive end, including its terminal EOS."""
    preceding_eos = next_eos(tokens, draw_offset)
    if preceding_eos is None:
        return None
    start = preceding_eos + 1
    end_eos = next_eos(tokens, start)
    return (start, end_eos + 1) if end_eos is not None else None


def document_draws(tokens: np.ndarray, rng: random.Random) -> Iterator[tuple[int, int, list[int]]]:
    # Without ten eligible starts the retry loop could never finish.
    boundary = -1
    for _ in range(DOCUMENTS_PER_LANGUAGE + 1):
        boundary = next_eos(tokens, boundary + 1)
        if boundary is None:
            raise ValueError("Training bin has fewer than ten complete documents after an EOS boundary.")

    seen = set()
    while len(seen) < DOCUMENTS_PER_LANGUAGE:
        draw_offset = rng.randrange(len(tokens))
        cut = document_cut(tokens, draw_offset)
        if cut is None:
            continue
        start, end = cut
        if start in seen:
            continue
        seen.add(start)
        yield draw_offset, start, tokens[start:end].tolist()


def frame_boundaries() -> tuple[str, str]:
    rendered = conversation_prompt([{"role": "user", "content": "a"}])
    json_start = rendered.index("[")
    _, json_end = json.JSONDecoder().raw_decode(rendered, json_start)
    return rendered[:json_start], rendered[json_end:]


def framing_check(encoder: TextEncoder, ids: list[int], text: str, prefix: str, suffix: str) -> dict:
    try:
        messages, json_end = json.JSONDecoder().raw_decode(text, len(prefix))
        prompt = conversation_prompt(messages)
    except ValueError as exc:
        return {"framing_round_trip": False, "first_differing_position": None, "framing_error": str(exc)}

    # Plan section 8.3 stores the framed prompt followed by the reply and EOS.
    # https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff765071657cf200b5ee7d12fabaad738c0b/docs/CHAT-MODEL-TRAINING-PLAN.md#83-design
    # Retrieved 2026-11-25.
    if text.startswith(suffix, json_end):
        reply = text[json_end + len(suffix):]
        expected = encoder.encode(prompt + reply) + [EOS]
    else:
        expected = encoder.encode(prompt)

    first_difference = next(
        (index for index, (actual, wanted) in enumerate(zip_longest(ids, expected)) if actual != wanted),
        None,
    )
    return {"framing_round_trip": first_difference is None, "first_differing_position": first_difference}


def describe_document(
    language: str, draw_offset: int, offset: int, ids: list[int], encoder: TextEncoder, prefix: str, suffix: str
) -> dict:
    ends_with_eos = ids[-1] == EOS
    body = ids[:-1] if ends_with_eos else ids
    text = encoder.tokenizer.decode_bytes(body).decode("utf-8", errors="replace")
    is_conversation = text.startswith(prefix)
    document = {
        "language": language,
        "draw_offset": draw_offset,
        "offset": offset,
        "length_tokens": len(ids),
        "ends_with_eos": ends_with_eos,
        "kind": "conversation" if is_conversation else "prose",
        "over_512_tokens": len(ids) > CONTEXT_TOKENS,
        "text": text if is_conversation else text[:PROSE_CHARACTERS],
    }
    if is_conversation:
        document.update(framing_check(encoder, ids, text, prefix, suffix))
    return document


def markdown(report: dict) -> str:
    lines = ["# V5 training token sample", "", f"Seed {SEED}. {DOCUMENTS_PER_LANGUAGE} documents per language.", ""]
    for document in report["documents"]:
        lines.extend((
            f"## {document['language']} document at token {document['offset']}",
            "",
            f"- Document type **{document['kind']}**",
            f"- Draw offset **{document['draw_offset']}**",
            f"- Length **{document['length_tokens']} tokens**",
            f"- Ends with EOS {EOS} **{'yes' if document['ends_with_eos'] else 'no'}**",
            f"- Over {CONTEXT_TOKENS} tokens **{'yes' if document['over_512_tokens'] else 'no'}**",
        ))
        if document["kind"] == "conversation":
            lines.append(f"- Framing round trip **{'yes' if document['framing_round_trip'] else 'no'}**")
            difference = document["first_differing_position"]
            if difference is not None:
                lines.append(f"- First differing token position **{difference}**")
            if "framing_error" in document:
                lines.append(f"- {document['framing_error']}")
        # Indent corpus text so it is rendered literally even if it contains Markdown.
        lines.extend(("", *("    " + line for line in document["text"].split("\n")), ""))
    return "\n".join(lines)


def write_sample(corpus: Path, tokenizer_run: Path, training_settings: Path, output: Path) -> dict:
    if output.exists():
        raise FileExistsError(f"Output directory already exists: {output}")
    # adapt() records these pins in settings.json for the foundation pilot.
    # https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff765071657cf200b5ee7d12fabaad738c0b/packages/execution-pipeline/execution_pipeline/language_adaptation.py#L270-L288
    # Retrieved 2026-11-25.
    settings_bytes = training_settings.read_bytes()
    settings = json.loads(settings_bytes)
    if not isinstance(settings, dict) or not isinstance(settings.get("corpus_files"), dict):
        raise ValueError("Training settings must contain the tokenizer and corpus pins.")
    encoder = TextEncoder(tokenizer_run)
    if encoder.tokenizer.eos_token_id != EOS:
        raise ValueError(f"Training tokenizer must use EOS id {EOS}.")
    tokenizer_sha = sha256_file(tokenizer_run / "tokenizer.json")
    tokenizer_report_sha = sha256_file(tokenizer_run / "tokenizer-report.json")
    corpus_manifest_sha = sha256_file(corpus / "manifest.json")
    pins = {
        "tokenizer_identity": encoder.tokenizer.identity,
        "tokenizer_sha256": tokenizer_sha,
        "tokenizer_report_sha256": tokenizer_report_sha,
        "corpus_manifest_sha256": corpus_manifest_sha,
    }
    for field, expected in pins.items():
        if settings.get(field) != expected:
            raise ValueError(f"Training input differs from its settings pin for {field}.")
    manifest = corpus_manifest(corpus, encoder.tokenizer.identity, CONTEXT_TOKENS, splits=("train",))
    if manifest.get("tokenizer_sha256") != tokenizer_sha:
        raise ValueError("Tokenizer bytes differ from the training corpus manifest.")
    bins = {language: corpus / f"{language}.train.bin" for language in LANGUAGES}
    train_bin_hashes = {path.name: manifest["files"][path.name]["sha256"] for path in bins.values()}
    for name, digest in train_bin_hashes.items():
        if settings["corpus_files"].get(name) != digest:
            raise ValueError(f"Training bin differs from its settings pin for {name}.")
    rng = random.Random(SEED)
    prefix, suffix = frame_boundaries()
    documents = []
    for language, path in bins.items():
        tokens = np.memmap(path, dtype=TOKEN_DTYPE, mode="r")
        for draw_offset, offset, ids in document_draws(tokens, rng):
            documents.append(describe_document(language, draw_offset, offset, ids, encoder, prefix, suffix))

    report = {
        "seed": SEED,
        "documents_per_language": DOCUMENTS_PER_LANGUAGE,
        "eos_token_id": EOS,
        "training_settings_sha256": sha256(settings_bytes).hexdigest(),
        "corpus_manifest_sha256": corpus_manifest_sha,
        "tokenizer_sha256": tokenizer_sha,
        "tokenizer_report_sha256": tokenizer_report_sha,
        "train_bins_sha256": train_bin_hashes,
        "tool_sha256": sha256_file(Path(__file__)),
        "documents": documents,
    }
    files = {
        "training-token-sample.json": json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        "training-token-sample.md": markdown(report),
    }
    output.mkdir(parents=True, exist_ok=False)
    created = []
    try:
        for name, content in files.items():
            path = output / name
            with path.open("x", encoding="utf-8", newline="\n") as stream:
                created.append(path)
                stream.write(content)
    except BaseException:
        for path in created:
            with suppress(OSError):
                path.unlink()
        with suppress(OSError):
            output.rmdir()
        raise
    return report


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--corpus", type=Path, required=True, help="Pinned v5 corpus directory")
    parser.add_argument("--tokenizer-run", type=Path, required=True, help="Run directory containing the pinned tokenizer and report")
    parser.add_argument("--training-settings", type=Path, required=True, help="Trainer's settings.json from selected or a snapshot")
    parser.add_argument("--output", type=Path, required=True, help="New directory for the JSON and Markdown sample")
    args = parser.parse_args(argv)
    try:
        write_sample(args.corpus, args.tokenizer_run, args.training_settings, args.output)
    except (OSError, ValueError, KeyError) as exc:
        parser.exit(1, f"{exc}\n")


if __name__ == "__main__":
    main()
