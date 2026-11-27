"""Run one registered local model for the council. Requests are data, with no tool dispatch."""

from __future__ import annotations

import json
from pathlib import Path
import re
import signal
import sys

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / name) for name in (
    "packages/execution-integration", "packages/execution-model", "packages/execution-pipeline", "scripts/context-use",
)]

from model_worker.checkpoints import (  # noqa: E402
    CHECKPOINT_BYTES, METADATA_BYTES, EngineError, acquire_device, load_dense_training,
    load_tensors, materialize, snapshot,
)
from model_worker.text import load_text_codec  # noqa: E402

MAX_LINE_BYTES = 256 * 1024


def stop(*_args):
    raise SystemExit(0)


def document(pin, limit=METADATA_BYTES):
    with snapshot(Path(pin["path"]), pin["sha256"], limit) as handle:
        return json.load(handle)


def load_codec(artifacts, model):
    tokenizer = artifacts["tokenizer"]
    report = artifacts["report"]
    metadata = document(report)
    return load_text_codec(ROOT, {**tokenizer, "reportPath": report["path"], "reportSha256": report["sha256"]},
                           f"sha256:{metadata['identity']}", model.config.vocab_size)


def load_retriever(artifacts, device):
    from execution_model.config import ModelConfig
    from execution_model.model import ExecutionModel
    from retriever import P_MAX, Q_MAX
    import torch

    base = artifacts["config"]
    with snapshot(Path(base["path"]), base["sha256"], CHECKPOINT_BYTES) as handle:
        config = ModelConfig.from_dict(load_tensors(handle, CHECKPOINT_BYTES)["config"])
    checkpoint = artifacts["checkpoint"]
    with snapshot(Path(checkpoint["path"]), checkpoint["sha256"], CHECKPOINT_BYTES) as handle:
        state = load_tensors(handle, CHECKPOINT_BYTES)
    with torch.device("meta"):
        model = ExecutionModel(config)
    materialize(model, state, CHECKPOINT_BYTES).to(device)
    codec = load_codec(artifacts, model)

    # Same prefixes, token limits, final hidden-state mean and normalization as the recorded retriever.
    # https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/scripts/context-use/retriever.py#L49 (retrieved 2026-11-27).
    def embed(text, prefix, limit):
        tokens = codec.encode_raw(prefix + text)[:limit]
        ids = torch.tensor([tokens], dtype=torch.long, device=device)
        valid = torch.ones_like(ids, dtype=torch.bool)
        positions = valid.long().cumsum(-1) - 1
        with torch.autocast(device.type, dtype=torch.bfloat16, enabled=device.type == "cuda"):
            hidden = model.token_embedding(ids)
            for block in model.blocks:
                hidden = block(hidden, valid, positions)
            hidden = model.final_norm(hidden)
        return torch.nn.functional.normalize(hidden.float().mean(1), dim=-1)

    @torch.no_grad()
    def retrieve(request):
        query = embed(request["question"], "query: ", Q_MAX)
        scores = [(index, float((query @ embed(passage, "passage: ", P_MAX).T).item()))
                  for index, passage in enumerate(request["passages"])]
        return {"ranking": [{"index": index, "score": score} for index, score in sorted(scores, key=lambda item: -item[1])]}

    return retrieve


def load_verifier(artifacts, device):
    import math
    from types import SimpleNamespace
    import torch
    import abstain_verifier as verifier
    import eval_reading_v2 as evaluation
    import run_context_test as reader

    config = document(artifacts["verifier"])
    if config["features"] != verifier.FEATS:
        raise EngineError("invalid_checkpoint")
    weights = config["model"]
    number_features = len(verifier.FEATS)
    if (any(len(weights[key]) != number_features or any(type(value) not in (int, float) or not math.isfinite(value)
                                                        for value in weights[key]) for key in ("mu", "sd", "w"))
            or any(value <= 0 for value in weights["sd"]) or not math.isfinite(weights["b"])):
        raise EngineError("invalid_checkpoint")
    thresholds = {name: config["thresholds"][name]["threshold"] for name in ("ar", "en")}
    if any(not 0 <= value <= 1 for value in thresholds.values()):
        raise EngineError("invalid_checkpoint")
    checkpoint = artifacts["checkpoint"]
    model = load_dense_training(Path(checkpoint["path"]), checkpoint["sha256"]).to(device)
    codec = load_codec(artifacts, model)

    class Scorer(reader.Scorer):
        def __init__(self):
            self.w = SimpleNamespace(encoder=SimpleNamespace(encode=codec.encode_raw), tokenizer=codec.tokenizer)
            self.eos = codec.tokenizer.eos_token_id
            self.split_mismatch = 0

        def logits(self, ids):
            return model(torch.tensor([ids], device=device)).logits[0].float()

    scorer = Scorer()
    not_stated = {codec.encode_raw(" " + answer)[0] for answer in evaluation.NOT.values()}
    banned = frozenset(not_stated | {scorer.eos})
    reader.GEN_MAX = 48  # `collect` in scripts/context-use/abstain_verifier.py, retrieved 2026-11-27.

    @torch.no_grad()
    def verify(request):
        question, passage, answer = request["question"], request["passage"], request["answer"]
        language = "ar" if re.search(r"[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]", question) else "en"
        prompt = reader.prefix({"question": question, "language": language}, passage)
        ids = codec.encode_raw(prompt)
        if not ids or len(ids) + reader.GEN_MAX >= model.config.max_context_length:
            return {"verdict": "unsure"}
        generated = scorer.greedy(prompt, banned)
        span = generated["text"].strip()
        if not span or evaluation.norm(span, language) != evaluation.norm(answer, language):
            return {"verdict": "unsure"}

        initial = torch.log_softmax(scorer.logits(ids)[-1], dim=-1)
        allowed = initial.clone()
        allowed[list(banned)] = -float("inf")
        all_ids, prefix_size = scorer.encode_pair(prompt, " " + span)
        continued = all_ids[prefix_size:]
        if not continued or len(all_ids) > model.config.max_context_length:
            return {"verdict": "unsure"}
        logits = torch.log_softmax(scorer.logits(all_ids)[prefix_size - 1:len(all_ids) - 1], dim=-1)
        probabilities = logits.gather(1, torch.tensor(continued, device=device)[:, None]).squeeze(1)
        terms = set(reader.terms(question))
        sentences = verifier.sentences(passage) or [passage]
        overlaps = [len(terms & set(reader.terms(sentence))) / max(1, len(terms)) for sentence in sentences]
        holder = next((index for index, sentence in enumerate(sentences) if span in sentence), None)
        # Feature order, rounding and calibration come from the frozen verifier's collection and verifier.json.
        # https://github.com/ahmadalwakai/Mohassan-AI/blob/29448aea3fa10d226ef82ec5bf0a65e723d6ec39/scripts/context-use/abstain_verifier.py#L107 (retrieved 2026-11-27).
        signals = {
            "margin": round(float(allowed.max() - initial[list(not_stated)].max()), 4),
            "lp_mean": round(float(probabilities.mean()), 4), "lp_min": round(float(probabilities.min()), 4),
            "n_tok": len(continued), "stop_eos": int(generated["stop"] == "eos"),
            "in_passage": int(" ".join(evaluation.norm(span, language)) in " ".join(evaluation.norm(passage, language))),
            "sent_overlap": round(overlaps[holder], 4) if holder is not None else 0.0, "best_overlap": round(max(overlaps), 4),
        }
        features = verifier.featurize({"language": language}, signals)
        logit = weights["b"] + sum((feature - mu) / sd * weight
                                    for feature, mu, sd, weight in zip(features, weights["mu"], weights["sd"], weights["w"]))
        probability = 1 / (1 + math.exp(-max(-700, min(700, logit))))
        return {"verdict": "supports" if probability >= thresholds[language] else "contradicts"}

    return verify


def load_execution(artifacts, device):
    from execution_model.generation import GenerationConfig, generate
    from execution_model.tokenizer import ByteBPETokenizer
    from execution_pipeline.tasks import UnsupportedTask, render
    from execution_pipeline.worker import MAX_OUTPUT_TOKENS
    from model_worker.checkpoints import load_dense_inference

    manifest = document(artifacts["manifest"])
    directory = Path(artifacts["manifest"]["path"]).parent
    model, eos = load_dense_inference(directory, artifacts["weights"]["sha256"], {
        "manifestSha256": artifacts["manifest"]["sha256"], "tokenizerId": manifest["tokenizer_identity"],
    })
    model.to(device)
    tokenizer = ByteBPETokenizer.load(directory / "tokenizer.json")
    if tokenizer.identity != manifest["tokenizer_identity"]:
        raise EngineError("invalid_checkpoint")

    def run(request):
        try:
            prompt = render(request["capability"], request["fields"])
        except UnsupportedTask as error:
            raise EngineError("invalid-input") from error
        ids = tokenizer.encode(prompt, add_bos=True)
        room = model.config.max_context_length - len(ids)
        if room < 1:
            raise EngineError("invalid-input")
        result = generate(model, ids, GenerationConfig(max_new_tokens=min(MAX_OUTPUT_TOKENS, room)),
                          eos_token_id=eos, max_context_length=model.config.max_context_length,
                          blocked_token_ids=tuple(token for token in tokenizer.special_token_ids.values() if token != eos))
        ids = result.token_ids[:-1] if result.terminal_token_id is not None else result.token_ids
        return {"text": tokenizer.decode_bytes(ids).decode("utf-8", "replace")}

    return run


def read_request():
    data = sys.stdin.buffer.readline(MAX_LINE_BYTES + 1)
    if not data:
        return None
    if len(data) > MAX_LINE_BYTES:
        raise SystemExit(2)
    return json.loads(data)


def emit(**message):
    print(json.dumps(message, ensure_ascii=True, allow_nan=False, separators=(",", ":")), flush=True)


def main():
    import torch

    signal.signal(signal.SIGTERM, stop)
    config = read_request()
    if not config:
        return
    torch.set_num_threads(config["cpuThreads"])
    lease = None
    try:
        device, lease = acquire_device(config["device"])
        model = {"verifier": load_verifier, "retriever": load_retriever, "execution": load_execution}[config["kind"]](config["artifacts"], device)
        emit(output="ready")
        while (request := read_request()) is not None:
            try:
                emit(output=model(request))
            except EngineError as error:
                emit(reason=error.code if error.code == "invalid-input" else "unhealthy")
    except (EngineError, KeyError, OSError, RuntimeError, TypeError, ValueError):
        emit(reason="incompatible")
    finally:
        if lease is not None:
            lease.close()


if __name__ == "__main__":
    main()
