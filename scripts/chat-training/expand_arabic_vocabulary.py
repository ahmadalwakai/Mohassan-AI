"""Append Arabic BPE merges and transplant only this project's own saved weights.

No old token ID, rank, embedding row, or transformer tensor is replaced. New
embedding rows are byte-length-weighted means of their ORIGINAL-token encoding.
Only Arabic foundation TRAIN text participates in merge learning; validation is
read afterwards for a held-out-document compression measurement.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import heapq
import json
from pathlib import Path
import re
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/execution-pipeline"))
from execution_pipeline.pretrain import TextEncoder, PRETOKENIZER, pretokenize
from execution_pipeline.ads_finetune import _load_payload
from execution_model.tokenizer import ByteBPETokenizer
from execution_model.config import ModelConfig

ARABIC = re.compile(r"[\u0621-\u064a\u066e-\u06d3]")


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def complete_arabic_tokens(tokenizer: ByteBPETokenizer) -> int:
    count = 0
    for token_id in range(tokenizer.vocab_size):
        try:
            text = tokenizer.token_bytes(token_id).decode("utf-8", "strict")
        except UnicodeDecodeError:
            continue
        count += bool(ARABIC.search(text))
    return count


def json_write(path: Path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")


def word_counts(train: Path, max_chars: int) -> tuple[Counter, dict]:
    if "train" not in train.name or "validation" in train.name:
        raise ValueError("An explicitly named training file is required.")
    counts = Counter()
    chars, documents, all_pieces = 0, 0, 0
    with train.open(encoding="utf-8") as stream:
        for line in stream:
            row = json.loads(line)
            if row.get("language") != "ar" or row.get("trainingAllowed") is False:
                raise ValueError("Only authorized Arabic training documents may teach merges.")
            text = row["text"]
            if not isinstance(text, str):
                raise ValueError("Document text must be a string.")
            if chars + len(text) > max_chars:
                break
            documents += 1
            chars += len(text)
            for piece in pretokenize(text.replace("\u00a0", " ")):
                all_pieces += 1
                if ARABIC.search(piece):
                    counts[piece] += 1
    if not counts:
        raise ValueError("No Arabic word pieces found.")
    return counts, {"documents": documents, "characters": chars, "all_pieces": all_pieces,
                    "arabic_piece_occurrences": sum(counts.values()), "arabic_distinct_pieces": len(counts),
                    "selection": "Deterministic source-order prefix of complete TRAIN documents, bounded by characters."}


def append_merges(base: ByteBPETokenizer, counts: Counter, *, target: int = 24576,
                  max_token_bytes: int = 24, min_frequency: int = 2) -> tuple[ByteBPETokenizer, dict]:
    if target not in (8192, 16384, 24576) or target <= base.vocab_size:
        raise ValueError("Target must be a supported larger vocabulary.")
    if not 2 <= max_token_bytes <= 256 or min_frequency < 1:
        raise ValueError("Invalid merge bounds.")
    original = base.to_dict()
    merges = [tuple(pair) for pair in original["merges"]]
    original_count = len(merges)
    tokens = [base.token_bytes(i) for i in range(base.vocab_size)]
    first = base.vocab_size - original_count
    # Sorting makes source JSON key / Counter insertion order irrelevant.
    words = [(base.encode(piece), frequency) for piece, frequency in sorted(counts.items())
             if frequency >= 1 and ARABIC.search(piece)]
    pairs: dict[tuple[int, int], int] = {}
    where: dict[tuple[int, int], set[int]] = {}
    eligibility: dict[tuple[int, int], bool] = {}

    def eligible(pair):
        if pair not in eligibility:
            data = tokens[pair[0]] + tokens[pair[1]]
            # UTF-8 Arabic/Syriac lead bytes. A new merge can never occur in
            # ASCII English; unlike allowing arbitrary high bytes, this also
            # leaves ordinary Latin accented English untouched.
            eligibility[pair] = len(data) <= max_token_bytes and any(0xD8 <= byte <= 0xDB for byte in data)
        return eligibility[pair]

    for index, (symbols, frequency) in enumerate(words):
        for pair in zip(symbols, symbols[1:]):
            if eligible(pair):
                pairs[pair] = pairs.get(pair, 0) + frequency
                where.setdefault(pair, set()).add(index)
    heap = [(-frequency, pair) for pair, frequency in pairs.items()]
    heapq.heapify(heap)
    selected_frequencies = []
    while heap and first + len(merges) < target:
        negative, pair = heapq.heappop(heap)
        if pairs.get(pair, 0) != -negative:
            continue
        if -negative < min_frequency:
            break
        new_id = len(tokens)
        merges.append(pair)
        tokens.append(tokens[pair[0]] + tokens[pair[1]])
        selected_frequencies.append(-negative)
        touched = set()
        for index in sorted(where.pop(pair, ())):
            symbols, frequency = words[index]
            if pair not in set(zip(symbols, symbols[1:])):
                continue  # Membership sets may conservatively contain stale IDs.
            for old in zip(symbols, symbols[1:]):
                if eligible(old):
                    pairs[old] -= frequency
                    touched.add(old)
            merged, position = [], 0
            while position < len(symbols):
                if position + 1 < len(symbols) and (symbols[position], symbols[position + 1]) == pair:
                    merged.append(new_id)
                    position += 2
                else:
                    merged.append(symbols[position])
                    position += 1
            for new in zip(merged, merged[1:]):
                if eligible(new):
                    pairs[new] = pairs.get(new, 0) + frequency
                    where.setdefault(new, set()).add(index)
                    touched.add(new)
            words[index] = (merged, frequency)
        pairs.pop(pair, None)
        for touched_pair in sorted(touched):
            count = pairs.get(touched_pair, 0)
            if count > 0 and touched_pair != pair:
                heapq.heappush(heap, (-count, touched_pair))
            elif touched_pair in pairs and count <= 0:
                pairs.pop(touched_pair)
        if len(merges) % 1000 == 0:
            print(json.dumps({"vocabulary": len(tokens), "added": len(merges)-original_count}), flush=True)
    result = ByteBPETokenizer(merges, special_tokens=dict(original["special_tokens"]), target_vocab_size=target)
    assert result.to_dict()["merges"][:original_count] == original["merges"]
    assert all(result.token_bytes(i) == base.token_bytes(i) for i in range(base.vocab_size))
    return result, {"old_vocab_size": base.vocab_size, "new_vocab_size": result.vocab_size,
                    "appended_merges": len(merges)-original_count, "target": target,
                    "min_selected_frequency": min(selected_frequencies) if selected_frequencies else None,
                    "old_ids_and_merge_ranks_preserved": True,
                    "all_new_merges_contain_arabic_lead_bytes": True}


def expand_weights(state: dict, old_config: ModelConfig, base: ByteBPETokenizer, expanded: ByteBPETokenizer):
    import torch
    if old_config.vocab_size != base.vocab_size:
        raise ValueError("Base weights and tokenizer dimensions differ.")
    config = ModelConfig.from_dict({**old_config.to_dict(), "vocab_size": expanded.vocab_size})
    old = state["token_embedding.weight"]
    embedding = torch.empty((expanded.vocab_size, old.shape[1]), dtype=old.dtype, device="cpu")
    embedding[:base.vocab_size].copy_(old)
    with torch.no_grad():
        for token_id in range(base.vocab_size, expanded.vocab_size):
            data = expanded.token_bytes(token_id)
            pieces = base.encode_bytes(data)
            byte_lengths = torch.tensor([len(base.token_bytes(i)) for i in pieces], dtype=old.dtype)
            embedding[token_id] = (old[pieces] * byte_lengths[:, None]).sum(0) / byte_lengths.sum()
    result = {**state, "token_embedding.weight": embedding}
    assert torch.equal(result["token_embedding.weight"][:base.vocab_size], state["token_embedding.weight"])
    assert all(torch.equal(value, result[key]) for key, value in state.items() if key != "token_embedding.weight")
    assert bool(torch.isfinite(embedding).all())
    return result, config


def fertility(path: Path, old_encoder: TextEncoder, new_encoder: TextEncoder, max_documents=100):
    counts = Counter()
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            row = json.loads(line)
            text = row["text"].replace("\u00a0", " ")
            a, b = old_encoder.encode(text), new_encoder.encode(text)
            assert old_encoder.tokenizer.decode_bytes(a).decode("utf-8") == text
            assert new_encoder.tokenizer.decode_bytes(b).decode("utf-8") == text
            counts.update(documents=1, characters=len(text), words=len(text.split()), old_tokens=len(a), new_tokens=len(b))
            if counts["documents"] >= max_documents:
                break
    return {**dict(counts), "old_tokens_per_word": counts["old_tokens"]/counts["words"],
            "new_tokens_per_word": counts["new_tokens"]/counts["words"],
            "token_reduction": 1-counts["new_tokens"]/counts["old_tokens"], "roundtrip_passed": True,
            "selection": "First100 complete articles from the specified separately split file."}


def verify_preservation(base_state, new_state, old_config, new_config, old_encoder, new_encoder):
    import random
    import string
    import torch
    from execution_model.model import ExecutionModel
    samples = ["A short English sentence about the garden.", "Café, naïve résumé; costs £19.50.",
               'Mohassan chat v1\n[{"role":"user","content":"Hello!"}]\nAssistant:\n',
               "tabs\tand\nnew lines; identifiers Item_439 and emoji 🐈"]
    rng = random.Random(20261115)
    samples += ["".join(rng.choice(string.printable) for _ in range(120)) for _ in range(100)]
    assert all(old_encoder.encode(text) == new_encoder.encode(text) for text in samples)
    previous_threads = torch.get_num_threads()
    torch.set_num_threads(1)
    try:
        old_model, new_model = ExecutionModel(old_config).eval(), ExecutionModel(new_config).eval()
        old_model.load_state_dict(base_state, strict=True)
        new_model.load_state_dict(new_state, strict=True)
        ids = torch.tensor([old_encoder.encode(samples[0])], dtype=torch.long)
        with torch.no_grad():
            old_logits = old_model(ids).logits
            new_logits = new_model(ids).logits[:, :, :old_config.vocab_size]
        delta = float((old_logits-new_logits).abs().max())
        equal = torch.equal(old_logits, new_logits)
        if not torch.allclose(old_logits, new_logits, rtol=1e-6, atol=1e-6):
            raise ValueError("Old-vocabulary logits changed beyond float32 tolerance.")
        return {"english_encoding_cases": len(samples), "english_encoding_unchanged": True,
                "old_embedding_rows_byte_exact": True, "transformer_weights_byte_exact": True,
                "old_vocab_logits_bit_exact": equal, "old_vocab_logits_max_abs_delta": delta,
                "logit_test_device": "cpu_float32", "old_parameters": old_config.parameter_count(),
                "new_parameters": new_config.parameter_count(),
                "limitation": "Full-vocabulary softmax probabilities can change because new output classes exist; English retention must be evaluated after adaptation."}
    finally:
        torch.set_num_threads(previous_threads)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, default=ROOT/"artifacts/execution-model-runs/text-b2-2026-11-12")
    parser.add_argument("--out", type=Path, default=ROOT/"artifacts/execution-model-runs/text-b3-ar-2026-11-15")
    parser.add_argument("--train", type=Path, default=ROOT/"artifacts/corpora/arabic-foundation-v1/text/ar.train.jsonl")
    parser.add_argument("--validation", type=Path, default=ROOT/"artifacts/corpora/arabic-foundation-v1/text/ar.validation.jsonl")
    parser.add_argument("--max-chars", type=int, default=20_000_000)
    args = parser.parse_args()
    if args.out.exists():
        raise ValueError("Never overwrite an existing model run.")
    started = time.perf_counter()
    old_encoder = TextEncoder(args.base)
    counts, sample_report = word_counts(args.train, args.max_chars)
    print(json.dumps({"stage":"training_merge_counts", **sample_report}), flush=True)
    expanded, merge_report = append_merges(old_encoder.tokenizer, counts)
    if expanded.vocab_size != 24576:
        raise ValueError("Corpus did not provide enough repeated pairs to fill the planned vocabulary.")
    args.out.mkdir(parents=True, exist_ok=False)
    expanded.save(args.out/"tokenizer.json")
    tokenizer_report = {"identity": expanded.identity, "vocab_size": expanded.vocab_size,
                        "pretokenizer": PRETOKENIZER, "normalization": "U+00A0 to space", "max_token_bytes":24,
                        "min_frequency":2, "sha256":sha256(args.out/"tokenizer.json"), "expansion":merge_report,
                        "base_tokenizer_sha256":sha256(args.base/"tokenizer.json"),
                        "merge_learning_train_sha256":sha256(args.train), "merge_learning_sample":sample_report,
                        "validation_used_for_learning":False}
    json_write(args.out/"tokenizer-report.json", tokenizer_report)
    print(json.dumps({"stage":"tokenizer_frozen", "run":str(args.out), "identity":expanded.identity}), flush=True)
    new_encoder = TextEncoder(args.out)
    base_checkpoint = args.base/"pretrain/best.pt"
    base_sha = sha256(base_checkpoint)
    payload, _, old_config = _load_payload(args.base, base_checkpoint)
    base_state = payload["model_state"]
    del payload
    new_state, new_config = expand_weights(base_state, old_config, old_encoder.tokenizer, expanded)
    preservation = verify_preservation(base_state, new_state, old_config, new_config, old_encoder, new_encoder)
    print(json.dumps({"stage":"weights_preserved", **preservation}), flush=True)
    measurements = {"train":fertility(args.train, old_encoder, new_encoder),
                    "heldout_articles":fertility(args.validation, old_encoder, new_encoder)}
    complete_arabic = complete_arabic_tokens(expanded)
    settings = {"config_identity":new_config.identity, "tokenizer_identity":expanded.identity,
                "tokenizer_sha256":sha256(args.out/"tokenizer.json"), "tokenizer_report_sha256":sha256(args.out/"tokenizer-report.json"),
                "base_checkpoint_sha256":base_sha, "weight_origin":"local_scratch_base_with_append_only_vocab_expansion",
                "parameters":new_config.parameter_count(), "languages":["ar","en"], "capabilities":[],
                "initialization":"New token row = byte-length-weighted mean of OLD embedding rows from OLD tokenizer.encode_bytes(new token bytes). No recursion through initialized new rows.",
                "optimizer_reset_required":True, "external_pretrained_weights":False, "prompt_hint":None}
    (args.out/"pretrain").mkdir()
    json_write(args.out/"pretrain/settings.json", settings)
    import torch
    torch.save({"model_state":new_state,"config":new_config.to_dict(),"settings":settings,"step":0,
                "checkpoint_kind":"weights_only_vocabulary_warm_start","schema_version":2}, args.out/"pretrain/best.pt")
    assert sha256(base_checkpoint)==base_sha
    _load_payload(args.out,args.out/"pretrain/best.pt")
    report={"schemaVersion":1,"status":"initialized_not_trained","base_checkpoint_sha256":base_sha,
            "initial_checkpoint_sha256":sha256(args.out/"pretrain/best.pt"),"base_tokenizer_identity":old_encoder.tokenizer.identity,
            "tokenizer_identity":expanded.identity,"merge_learning":tokenizer_report,"preservation":preservation,
            "fertility":measurements,"tokens_containing_complete_arabic_character":complete_arabic,
            "old_tokens_containing_complete_arabic_character":complete_arabic_tokens(old_encoder.tokenizer),
            "arabic_token_count_method":"Strictly valid UTF-8 tokens containing an Arabic letter.",
            "validation_article_sha256":sha256(args.validation),"validation_used_for_learning":False,
            "final_chat_holdout_read":False,"ready_for_chat":False,"seconds":round(time.perf_counter()-started,1)}
    json_write(args.out/"vocabulary-expansion.json",report)
    json_write(args.out/"pretrain/status.json",{"status":"initialized_not_trained","ready_for_chat":False,
               "parameters":new_config.parameter_count(),"initial_checkpoint_sha256":report["initial_checkpoint_sha256"]})
    print(json.dumps({"run":str(args.out),"status":report["status"],"fertility":measurements,
                      "complete_arabic_vocab_tokens":complete_arabic,"seconds":report["seconds"]}),flush=True)


if __name__ == "__main__":
    main()
