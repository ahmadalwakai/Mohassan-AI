"""Long-lived local worker for the Ads model (owner-only lab).

python -I -m execution_pipeline.ads_worker --run <run dir> [--device cuda|cpu] [--finetune ads-finetune]

Loads <run>/<finetune>/best.pt (ads-finetune for the lab's brief tasks, pointer-v3 for the chat's
goal and site pointer tasks) and the run's own tokenizer once, then reads one JSON request
per stdin line: {"id", "prompt", "input", "candidates", "temperature", "top_k", "max_new_tokens"}.
The prompt is rendered by the caller (scripts/ads-training/lib.ts renderPrompt); the name hint the
model was fine-tuned with is added here from ads-finetune/settings.json. Replies one JSON line:
{"id", "candidates": [{"text", "finished"}], "ms"} or {"id", "error"}. Candidate 0 is greedy.
No network, no files written, no tools: text in, text out. The checker gate runs in the caller.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

from . import REPOSITORY_ROOT  # noqa: F401  (extends sys.path)

from execution_model.config import ModelConfig

from .ads_finetune import _run_hint, prompt_text
from .pretrain import TextEncoder

LIMITS = {"candidates": (1, 8), "max_new_tokens": (16, 384), "top_k": (1, 50)}


def _bounded(request: dict[str, Any], key: str, default: int) -> int:
    low, high = LIMITS[key]
    value = request.get(key, default)
    return default if not isinstance(value, int) else max(low, min(high, value))


class AdsWorker:
    def __init__(self, run: Path, device: str, finetune: str = "ads-finetune", expected_sha256: str | None = None) -> None:
        import torch
        from execution_model.model import ExecutionModel
        checkpoint = run / finetune / "best.pt"
        with checkpoint.open("rb") as stream:
            self.checkpoint_sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
            if expected_sha256 is not None and self.checkpoint_sha256 != expected_sha256:
                raise ValueError("Checkpoint does not match the selected evaluated version.")
            stream.seek(0)
            payload = torch.load(stream, map_location="cpu", weights_only=True)
        self.config = ModelConfig.from_dict(payload["config"])
        self.encoder = TextEncoder(run)
        self.tokenizer = self.encoder.tokenizer
        settings = json.loads((run / finetune / "settings.json").read_text(encoding="utf-8"))
        if settings.get("tokenizer_identity") != self.tokenizer.identity or settings.get("config_identity") != self.config.identity:
            raise ValueError("Checkpoint, tokenizer and training configuration identities do not match.")
        embedded = payload.get("settings", settings)
        if embedded.get("tokenizer_identity") != self.tokenizer.identity or embedded.get("config_identity") != self.config.identity:
            raise ValueError("Embedded checkpoint identities do not match this run.")
        for metadata in (settings, embedded):
            for key, filename in (("tokenizer_sha256", "tokenizer.json"), ("tokenizer_report_sha256", "tokenizer-report.json")):
                expected = metadata.get(key)
                if expected is not None:
                    with (run / filename).open("rb") as stream:
                        actual = hashlib.file_digest(stream, "sha256").hexdigest()
                    if actual != expected:
                        raise ValueError("Tokenizer or pre-tokenization settings do not match the checkpoint.")
        if embedded.get("languages", ["en"]) != settings.get("languages", ["en"]):
            raise ValueError("Checkpoint language metadata does not match its settings.")
        if self.config.vocab_size != self.tokenizer.vocab_size:
            raise ValueError("Tokenizer vocabulary does not match model dimensions.")
        self.languages = settings.get("languages", ["en"])
        model = ExecutionModel(self.config)
        model.load_state_dict(payload["model_state"], strict=True)
        self.device = device
        self.model = model.to(device).eval()
        self.hint = _run_hint(run, finetune)
        self.finetune = finetune
        self.step = payload.get("step")
        self.parameters = sum(parameter.numel() for parameter in model.parameters())

    def handshake(self) -> dict[str, Any]:
        return {"ready": True, "finetune": self.finetune, "device": self.device, "parameters": self.parameters, "finetune_step": self.step,
                "prompt_hint": self.hint, "tokenizer_identity": self.tokenizer.identity,
                "config_identity": self.config.identity, "context": self.config.max_context_length,
                "checkpoint_sha256": self.checkpoint_sha256, "languages": self.languages}

    def sample(self, request: dict[str, Any]) -> list[dict[str, Any]]:
        import torch
        count = _bounded(request, "candidates", 8)
        top_k = min(_bounded(request, "top_k", 20), self.config.vocab_size)
        max_new = _bounded(request, "max_new_tokens", 140)
        temperature = float(request.get("temperature", 0.7))
        temperature = 0.7 if not 0.05 <= temperature <= 2.0 else temperature
        if not isinstance(request.get("prompt"), str) or not request["prompt"].strip() or len(request["prompt"]) > 32000:
            raise ValueError("A nonempty bounded text prompt is required.")
        prompt = self.encoder.encode(prompt_text({"prompt": request["prompt"], "input": request.get("input") or {}}, self.hint))
        if len(prompt) + max_new > self.config.max_context_length:
            max_new = self.config.max_context_length - len(prompt)
            if max_new < 8:
                raise ValueError("The brief is too long for the model context.")
        pad, eos = self.tokenizer.pad_token_id, self.tokenizer.eos_token_id
        generator = torch.Generator(device=self.device).manual_seed(int(request.get("seed", 21)))
        generated: list[list[int]] = [[] for _ in range(count)]
        finished = [False] * count
        active = list(range(count))
        for _ in range(max_new):
            if not active:
                break
            sequences = [prompt + generated[slot] for slot in active]
            width = max(len(sequence) for sequence in sequences)
            ids = torch.full((len(active), width), pad, dtype=torch.long)
            mask = torch.zeros((len(active), width), dtype=torch.bool)
            for row, sequence in enumerate(sequences):
                ids[row, width - len(sequence):] = torch.tensor(sequence)
                mask[row, width - len(sequence):] = True
            with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16, enabled=self.device == "cuda"):
                logits = self.model(ids.to(self.device), attention_mask=mask.to(self.device), last_token_only=True).logits[:, -1].float()
            greedy = logits.argmax(dim=-1)
            values, indices = logits.topk(top_k, dim=-1)
            sampled = indices.gather(1, torch.multinomial(torch.softmax(values / temperature, dim=-1), 1, generator=generator)).squeeze(1)
            tokens = torch.where(torch.tensor([slot == 0 for slot in active], device=self.device), greedy, sampled).tolist()
            still = []
            for slot, token in zip(active, tokens):
                if token == eos:
                    finished[slot] = True
                else:
                    generated[slot].append(token)
                    still.append(slot)
            active = still
        return [{"text": self.tokenizer.decode_bytes(ids_).decode("utf-8", "replace"), "finished": done}
                for ids_, done in zip(generated, finished)]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", required=True, type=Path)
    parser.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    parser.add_argument("--finetune", default="ads-finetune", help="Fine-tune folder inside the run (a plain name, no path).")
    parser.add_argument("--checkpoint-sha256", default=None, help="Optional exact evaluated checkpoint identity.")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", args.finetune) or args.finetune in {".", ".."}:
        parser.error("--finetune must be a folder name inside the run")
    import torch
    if args.device == "cuda" and not torch.cuda.is_available():
        parser.error("CUDA was requested but is unavailable; choose --device cpu explicitly.")
    device = args.device
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    out = sys.stdout
    try:
        worker = AdsWorker(args.run.resolve(), device, args.finetune, args.checkpoint_sha256)
    except Exception as error:  # noqa: BLE001  (reported to the caller, not raised)
        out.write(json.dumps({"ready": False, "error": f"{type(error).__name__}: {error}"[:400]}) + "\n")
        out.flush()
        return 1
    out.write(json.dumps(worker.handshake()) + "\n")
    out.flush()
    for line in sys.stdin:
        if not line.strip():
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            started = time.perf_counter()
            candidates = worker.sample(request)
            reply = {"id": request_id, "candidates": candidates, "ms": round((time.perf_counter() - started) * 1000)}
        except Exception as error:  # noqa: BLE001
            reply = {"id": request_id, "error": f"{type(error).__name__}: {error}"[:400]}
        out.write(json.dumps(reply, ensure_ascii=False) + "\n")
        out.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
