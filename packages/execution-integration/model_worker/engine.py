"""One local model trunk and its inference heads, shared by the stdio worker."""
from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path
import re
from typing import Any

import torch
from torch import Tensor, nn

from execution_model.errors import ExecutionModelError, InvalidRequestError, NumericalError
from execution_model.generation import GenerationConfig
from execution_model.model import ExecutionModel
from execution_pipeline import goal_tagger

from .checkpoints import (
    EngineError, GpuLease, acquire_device, fields, load_dense_inference, load_dense_training,
    load_goal_tagger, load_projection, local_path, pin,
)
from .decoding import CACHE_AFTER_TOKENS, GenerateInput, GenerationBatch, TokenStep
from .quantization import apply_quantization, use_int8


@dataclass(frozen=True)
class DenseInput:
    input_ids: tuple[int, ...]
    candidates: tuple[int, ...] = ()


def _integer(value: Any, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise EngineError("invalid_request")
    return value


def _integers(value: Any, max_length: int, max_value: int) -> tuple[int, ...]:
    if type(value) is not list or not 1 <= len(value) <= max_length:
        raise EngineError("invalid_request")
    return tuple(_integer(item, 0, max_value) for item in value)


def _generation_config(payload: dict, context_room: int, vocab_size: int, max_output: int) -> GenerationConfig:
    max_tokens = _integer(payload["maxNewTokens"], 1, min(context_room, max_output))
    top_k = _integer(payload.get("topK", 0), 0, vocab_size)
    top_p = payload.get("topP", 1.0)
    temperature = payload.get("temperature", 1.0 if top_k or top_p != 1.0 else 0.0)
    if (type(temperature) not in (int, float) or type(top_p) not in (int, float)
            or not 0 <= temperature <= 100 or not 0 < top_p <= 1
            or not math.isfinite(temperature) or not math.isfinite(top_p)
            or temperature == 0 and (top_k or top_p != 1.0)):
        raise EngineError("invalid_request")
    try:
        return GenerationConfig(
            max_new_tokens=max_tokens, do_sample=temperature != 0,
            temperature=temperature or 1.0, top_k=top_k, top_p=top_p,
            seed=_integer(payload.get("seed", 0), 0, 2**63 - 1),
        )
    except InvalidRequestError as error:
        raise EngineError("invalid_request") from error


@dataclass(frozen=True)
class DenseHead:
    trunk: ExecutionModel
    operations: tuple[str, ...]
    projection: nn.Sequential | None = None
    eos: int | None = None

    def prepare(self, operation: str, payload: Any, max_output: int) -> DenseInput | GenerateInput:
        required = {"inputIds"}
        optional: set[str] = set()
        if operation == "generate":
            required.add("maxNewTokens")
            optional = {"temperature", "topK", "topP", "seed"}
        elif operation in ("score", "select"):
            required.add("candidatePositions")
        data = fields(payload, required, optional, "invalid_request")
        config = self.trunk.config
        ids = _integers(data["inputIds"], config.max_context_length, config.vocab_size - 1)
        if operation == "generate":
            return GenerateInput(ids, _generation_config(
                data, config.max_context_length - len(ids), config.vocab_size, max_output,
            ))
        if operation == "classify":
            return DenseInput(ids)
        candidates = _integers(data["candidatePositions"], len(ids), len(ids) - 1)
        if len(candidates) != len(set(candidates)):
            raise EngineError("invalid_request")
        return DenseInput(ids, candidates)

    def batch_key(self, value: DenseInput | GenerateInput) -> int:
        return len(value.input_ids)

    def logits(self, values: list[DenseInput] | list[GenerateInput]) -> list[Tensor]:
        ids = torch.tensor([value.input_ids for value in values], dtype=torch.long,
                           device=self.trunk.token_embedding.weight.device)
        if self.projection is None:
            result = self.trunk(ids, last_token_only=True).logits[:, -1]
            return list(result.unbind())
        hidden = self.trunk.embedding_dropout(self.trunk.token_embedding(ids))
        valid = torch.ones_like(ids, dtype=torch.bool)
        positions = torch.arange(ids.shape[1], device=ids.device).expand_as(ids)
        for block in self.trunk.blocks:
            hidden = block(hidden, valid, positions)
        if self.operations == ("classify",):
            result = self.projection(self.trunk.final_norm(hidden[:, -1]))
            return list(result.unbind())
        result = self.projection(self.trunk.final_norm(hidden)).squeeze(-1)
        return [row[list(value.candidates)] for row, value in zip(result, values)]

    def prediction(self, _value: DenseInput | GenerateInput, logits: Tensor) -> int:
        return int(logits.argmax())

    def result(self, operation: str, value: DenseInput, logits: Tensor) -> dict:
        if operation == "classify":
            return {"logits": logits.tolist(), "classIndex": self.prediction(value, logits)}
        output = {"scores": logits.tolist()}
        if operation == "select":
            selected = self.prediction(value, logits)
            output.update({"selectedIndex": selected, "selectedPosition": value.candidates[selected]})
        return output

    def new_generation(self, values: list[GenerateInput], *, use_cache: bool | None = None) -> GenerationBatch:
        return GenerationBatch(self.trunk, values, self.eos, use_cache=use_cache)


@dataclass(frozen=True)
class GoalTaggerHead:
    trunk: nn.Module
    vocabulary: goal_tagger.Vocabulary
    operations: tuple[str, ...]
    output_name: str | None = None
    projection: None = None

    def prepare(self, _operation: str, payload: Any, _max_output: int) -> dict:
        data = fields(payload, {"text"}, set(), "invalid_request")
        text = data["text"]
        if type(text) is not str or not 1 <= len(text) <= 32_000:
            raise EngineError("invalid_request")
        if not 1 <= len(goal_tagger.split_words(text)[0]) <= goal_tagger.MAX_WORDS:
            raise EngineError("invalid_request")
        return goal_tagger.encode_sentence(self.vocabulary, text)

    def batch_key(self, value: dict) -> int:
        return len(value["ids"])

    def logits(self, values: list[dict]) -> list[Tensor | dict[str, Tensor]]:
        tensors = goal_tagger.collate(values, str(next(self.trunk.parameters()).device))
        outputs = self.trunk(tensors["ids"], tensors["chars"], tensors["features"], tensors["mask"])
        if self.output_name is not None:
            return list(outputs[self.output_name].unbind())
        return [{name: logits[index] for name, logits in outputs.items()} for index in range(len(values))]

    def prediction(self, value: dict, logits: Tensor | dict[str, Tensor]) -> int | str:
        if self.output_name is not None:
            return int(logits.argmax())
        return goal_tagger.decode(value, {name: row.unsqueeze(0) for name, row in logits.items()}, 0)

    def result(self, operation: str, value: dict, logits: Tensor | dict[str, Tensor]) -> dict:
        if operation == "classify":
            return {"logits": logits.tolist(), "classIndex": self.prediction(value, logits)}
        scores = {name: row.tolist() for name, row in logits.items()}
        if operation == "select":
            return {"scores": scores, "selection": self.prediction(value, logits)}
        return {"scores": scores}


def _finite(logits: Tensor | dict[str, Tensor]) -> bool:
    tensors = logits.values() if isinstance(logits, dict) else (logits,)
    return all(bool(torch.isfinite(tensor).all()) for tensor in tensors)


@dataclass(frozen=True)
class RoutedGeneration:
    batch: GenerationBatch
    quantized: bool

    def step(self, active: list[int]) -> dict[int, TokenStep]:
        try:
            with use_int8(self.quantized):
                return self.batch.step(active)
        except NumericalError as error:
            raise EngineError("invalid_model_output") from error


class WorkerEngine:
    def __init__(self, heads: dict[str, DenseHead | GoalTaggerHead], device: torch.device,
                 checkpoint_sha256: str, max_output_tokens: int, lease: GpuLease | None = None) -> None:
        self.heads = heads
        self.device = device
        self.checkpoint_sha256 = checkpoint_sha256
        self.max_output_tokens = max_output_tokens
        self.lease = lease
        self.quantized_heads: set[str] = set()
        self.parity_report: dict[str, dict] = {}

    def close(self) -> None:
        if self.lease is not None:
            torch.cuda.synchronize(self.device)
            self.lease.close()
            self.lease = None

    def prepare(self, operation: str, head: str, payload: Any) -> DenseInput | GenerateInput | dict:
        if head not in self.heads or operation not in self.heads[head].operations:
            raise EngineError("unsupported_capability")
        return self.heads[head].prepare(operation, payload, self.max_output_tokens)

    def batch_key(self, operation: str, head: str, value: DenseInput | GenerateInput | dict) -> tuple:
        cache = isinstance(value, GenerateInput) and value.config.max_new_tokens > CACHE_AFTER_TOKENS
        return operation, head, self.heads[head].batch_key(value), cache

    @torch.inference_mode()
    def run_batch(self, operation: str, head: str, values: list) -> list[dict]:
        adapter = self.heads[head]
        try:
            with use_int8(head in self.quantized_heads):
                logits = adapter.logits(values)
                if not all(_finite(row) for row in logits):
                    raise NumericalError("Nonfinite model output.")
                return [adapter.result(operation, value, row) for value, row in zip(values, logits)]
        except NumericalError as error:
            raise EngineError("invalid_model_output") from error

    def new_generation(self, head: str, values: list[GenerateInput]) -> RoutedGeneration:
        return RoutedGeneration(self.heads[head].new_generation(values), head in self.quantized_heads)


def _dense_heads(base_dir: Path, trunk: ExecutionModel, digest: str, descriptors: Any,
                 eos: int | None) -> dict[str, DenseHead]:
    if type(descriptors) is not dict or not 1 <= len(descriptors) <= 32:
        raise EngineError("invalid_config")
    heads = {}
    for name, descriptor in descriptors.items():
        if type(name) is not str or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", name) is None:
            raise EngineError("invalid_config")
        spec = fields(descriptor, {"kind"}, {"sidecar"}, "invalid_config")
        kind = spec["kind"]
        if kind == "generate" and "sidecar" not in spec:
            heads[name] = DenseHead(trunk, ("generate",), eos=eos)
        elif kind in ("classify", "pointer") and "sidecar" in spec:
            operations = ("classify",) if kind == "classify" else ("score", "select")
            heads[name] = DenseHead(trunk, operations, load_projection(base_dir, spec, trunk, digest))
        else:
            raise EngineError("invalid_config")
    return heads


def load_engine(config: dict, *, base_dir: Path, max_output_tokens: int) -> WorkerEngine:
    spec = fields(config.get("checkpoint"), {"path", "sha256"},
                  {"format", "manifestSha256", "tokenizerId"}, "invalid_config")
    path, digest = local_path(base_dir, spec["path"]), pin(spec["sha256"])
    format_name = spec.get("format", "training")
    if format_name not in ("training", "inference", "goal-tagger"):
        raise EngineError("invalid_config")
    if format_name != "inference" and {"manifestSha256", "tokenizerId"} & spec.keys():
        raise EngineError("invalid_config")
    device, lease = acquire_device(config.get("device", "cpu"))
    try:
        if format_name == "goal-tagger":
            if "heads" in config or "eosTokenId" in config:
                raise EngineError("invalid_config")
            trunk, vocabulary = load_goal_tagger(path, digest)
            heads = {"goal-tagger": GoalTaggerHead(trunk, vocabulary, ("score", "select"))}
            classifiers = ["intent", "currency", "period", "goal"]
            if trunk.field_presence:
                classifiers.extend(goal_tagger.PRESENCE_FIELDS)
            for name in classifiers:
                heads[name] = GoalTaggerHead(trunk, vocabulary, ("classify",), output_name=name)
        else:
            eos = None
            if format_name == "inference":
                trunk, eos = load_dense_inference(path, digest, spec)
            else:
                trunk = load_dense_training(path, digest)
            if "eosTokenId" in config:
                configured = config["eosTokenId"]
                if (type(configured) is not int or not 0 <= configured < trunk.config.vocab_size
                        or eos is not None and eos != configured):
                    raise EngineError("invalid_config")
                eos = configured
            heads = _dense_heads(base_dir, trunk, digest, config.get("heads", {"lm": {"kind": "generate"}}), eos)
        trunk.to(device)
        for head in heads.values():
            if head.projection is not None:
                head.projection.to(device)
        engine = WorkerEngine(heads, device, digest, max_output_tokens, lease)
        try:
            engine.parity_report = apply_quantization(engine, config.get("quantization"))
        except ValueError as error:
            raise EngineError("invalid_config") from error
        return engine
    except BaseException as error:
        if lease is not None:
            lease.close()
        if isinstance(error, (EngineError, KeyboardInterrupt, SystemExit, MemoryError, torch.OutOfMemoryError)):
            raise
        if isinstance(error, (ExecutionModelError, KeyError, OSError, RuntimeError, TypeError, ValueError)):
            raise EngineError("invalid_checkpoint") from error
        raise
