"""T2: one long-lived worker that loads the trunk once and serves several heads, on the CPU or the GPU.

Plan: docs/RESPONSE-QUALITY-PLAN-2026-11-22.md, section 3 ("تجارب التدريب T"). Proposed criterion, for the
owner to fix: p95 per head on the CPU at or under 50 ms means the CPU is chosen and the GPU stays free for
training; above it, int8 weights are tried (with an output-agreement check), then the GPU.

Heads come from T1 (artifacts/heads-t1-20261122): `head` (residual bottleneck after final_norm) and `lora`
(rank 8). One trunk serves both: the bottleneck is a switchable hook, the adapter is attached or detached.
Requests measured:
  select    one forward pass over up to 128 tokens, last token only: the shape of the H2/H4/H5 decisions
  select8   eight such requests in one pass, as concurrent requests would be batched
  pointer   the Ads pointer answer, greedy, up to 96 tokens, no KV cache (what the Ads worker does today)
  int8      CPU only: select with dynamically quantised Linear layers, and its agreement with fp32
Each device runs in a fresh process, so start-up time and memory are clean:
  python -I scripts/heads/t2_worker.py --device cpu  --out artifacts/heads-t2-20261122
  python -I scripts/heads/t2_worker.py --device cuda --out artifacts/heads-t2-20261122
"""
from __future__ import annotations

import time

STARTED = time.perf_counter()

import argparse  # noqa: E402
import ctypes  # noqa: E402
import json  # noqa: E402
import statistics  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402
from ctypes import wintypes  # noqa: E402
from datetime import datetime, timezone  # noqa: E402
from pathlib import Path  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "packages" / "execution-pipeline"))

import torch  # noqa: E402

IMPORTED = time.perf_counter()

import t1_head_forms as t1  # noqa: E402
from execution_pipeline import ads_finetune as af  # noqa: E402
from execution_model.adapters import attach_adapter, detach_adapter  # noqa: E402

T1_DIR = ROOT / "artifacts" / "heads-t1-20261122"
SELECT_TOKENS = 128
SELECT_REQUESTS = 50
BATCH_REQUESTS = 20
POINTER_REQUESTS = 10
WARMUP = 5


class Counters(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t), ("PrivateUsage", ctypes.c_size_t)]


def memory() -> dict:
    counters = Counters()
    counters.cb = ctypes.sizeof(Counters)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.K32GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
    kernel32.K32GetProcessMemoryInfo(kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb)
    return {"working_set_mib": round(counters.WorkingSetSize / 2**20), "private_mib": round(counters.PrivateUsage / 2**20),
            "peak_working_set_mib": round(counters.PeakWorkingSetSize / 2**20)}


def percentiles(values: list[float]) -> dict:
    ordered = sorted(values)
    pick = lambda q: ordered[min(len(ordered) - 1, round(q * (len(ordered) - 1)))]  # noqa: E731
    return {"n": len(values), "p50_ms": round(pick(0.5) * 1000, 2), "p95_ms": round(pick(0.95) * 1000, 2),
            "max_ms": round(ordered[-1] * 1000, 2)}


def sync(device: str) -> None:
    if device == "cuda":
        torch.cuda.synchronize()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", choices=["cpu", "cuda"], required=True)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    device = args.device
    out = (ROOT / args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    target = out / f"{device}.json"
    if target.exists():
        raise SystemExit(f"{target} exists; results are never overwritten")
    if device == "cuda":
        users = t1.gpu_users()
        if users:
            raise SystemExit(f"The GPU has compute processes: {users}")
        t1.acquire_lock("T2 worker (cuda)")
    try:
        autocast = (lambda: torch.autocast("cuda", dtype=torch.bfloat16)) if device == "cuda" else None
        loaded = time.perf_counter()
        model, tokenizer, config = af._load_pretrained(t1.RUN, device, t1.BASE)
        model.eval()
        head = t1.ResidualHead(config.hidden_size, t1.ARMS["head"]["bottleneck"]).to(device)
        head.load_state_dict(torch.load(T1_DIR / "head" / "trainable-best.pt", map_location=device, weights_only=True))
        head.eval()
        active = {"head": False}
        model.final_norm.register_forward_hook(lambda module, inputs, output: head(output) if active["head"] else output)
        lora_state = torch.load(T1_DIR / "lora" / "trainable-best.pt", map_location=device, weights_only=True)
        ready = time.perf_counter()
        report: dict = {
            "device": device, "started": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "threads": torch.get_num_threads(), "torch": torch.__version__,
            "startup_seconds": {"import_torch": round(IMPORTED - STARTED, 2), "load_trunk_and_heads": round(ready - loaded, 2),
                                "process_to_ready": round(ready - STARTED, 2)},
            "memory_ready": memory(),
            "precision": "bf16 autocast" if device == "cuda" else "fp32",
        }
        if device == "cuda":
            report["gpu_ready"] = {"allocated_mib": round(torch.cuda.memory_allocated() / 2**20),
                                   "nvidia_dedicated_mib": t1.nvidia()["dedicated_mib"]}
        encoder = af.TextEncoder(t1.RUN)
        records = af.load_split("goal_test_unseen_phrasing", t1.TEST_DIR)
        prompts = [encoder.encode(af.prompt_text(record, None)) for record in records]
        selects = [prompt[-SELECT_TOKENS:] for prompt in prompts[:SELECT_REQUESTS + WARMUP]]

        def forward(batch: list[list[int]]):
            width = max(len(ids) for ids in batch)
            ids = torch.full((len(batch), width), tokenizer.pad_token_id, dtype=torch.long)
            mask = torch.zeros((len(batch), width), dtype=torch.bool)
            for row, sequence in enumerate(batch):
                ids[row, width - len(sequence):] = torch.tensor(sequence)
                mask[row, width - len(sequence):] = True
            with torch.no_grad():
                if autocast:
                    with autocast():
                        return model(ids.to(device), attention_mask=mask.to(device), last_token_only=True).logits[:, -1]
                return model(ids.to(device), attention_mask=mask.to(device), last_token_only=True).logits[:, -1]

        def time_selects(label: str) -> dict:
            for sequence in selects[:WARMUP]:
                forward([sequence])
            single = []
            for sequence in selects[WARMUP:]:
                sync(device)
                began = time.perf_counter()
                forward([sequence])
                sync(device)
                single.append(time.perf_counter() - began)
            batched = []
            for index in range(BATCH_REQUESTS):
                batch = [selects[(index * 8 + offset) % len(selects)] for offset in range(8)]
                sync(device)
                began = time.perf_counter()
                forward(batch)
                sync(device)
                batched.append(time.perf_counter() - began)
            return {"label": label, "select": percentiles(single), "select8": percentiles(batched)}

        def pointer(prompt: list[int]) -> tuple[str, float]:
            generated: list[int] = []
            sync(device)
            began = time.perf_counter()
            for _ in range(t1.MAX_NEW_TOKENS):
                if len(prompt) + len(generated) > config.max_context_length:
                    break
                token = int(forward([prompt + generated]).argmax(dim=-1)[0])
                if token == tokenizer.eos_token_id:
                    break
                generated.append(token)
            sync(device)
            return tokenizer.decode_bytes(generated).decode("utf-8", "replace"), time.perf_counter() - began

        def time_pointer(arm: str) -> dict:
            answers = {json.loads(line)["id"]: json.loads(line)["answer_text"]
                       for line in (T1_DIR / arm / "answers" / "goal_test_unseen_phrasing.jsonl").read_text(encoding="utf-8").splitlines() if line}
            pointer(prompts[0])
            times, same = [], 0
            for record, prompt in zip(records[1:POINTER_REQUESTS + 1], prompts[1:POINTER_REQUESTS + 1]):
                text, seconds = pointer(prompt)
                times.append(seconds)
                same += int(text == answers.get(record["id"]))
            return {**percentiles(times), "same_answer_as_t1_batch_run": f"{same}/{len(times)}"}

        results: dict = {}
        results["trunk_only"] = time_selects("trunk")
        active["head"] = True
        results["head"] = time_selects("head")
        results["head"]["pointer"] = time_pointer("head")
        active["head"] = False
        began = time.perf_counter()
        handle = attach_adapter(model, "t2-lora", rank=t1.ARMS["lora"]["rank"], alpha=t1.ARMS["lora"]["alpha"], seed=t1.SEED)
        handle.state_module().load_state_dict(lora_state)
        attached = time.perf_counter() - began
        results["lora"] = time_selects("lora")
        results["lora"]["pointer"] = time_pointer("lora")
        began = time.perf_counter()
        detach_adapter(model)
        results["switch_seconds"] = {"attach_and_load_lora": round(attached, 4), "detach_lora": round(time.perf_counter() - began, 4)}
        if device == "cpu":
            reference = torch.stack([forward([sequence])[0] for sequence in selects[WARMUP:]])
            quantised = torch.ao.quantization.quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8)
            original, model = model, quantised
            try:
                timing = time_selects("trunk_int8")
                approximate = torch.stack([forward([sequence])[0] for sequence in selects[WARMUP:]])
                timing["argmax_agreement_with_fp32"] = f"{int((approximate.argmax(-1) == reference.argmax(-1)).sum())}/{len(selects) - WARMUP}"
                results["int8"] = timing
            finally:
                model = original
        report["results"] = results
        report["memory_end"] = memory()
        if device == "cuda":
            report["gpu_end"] = {"max_allocated_mib": round(torch.cuda.max_memory_allocated() / 2**20),
                                 "nvidia_dedicated_mib": t1.nvidia()["dedicated_mib"]}
        report["criterion_proposed"] = "p95 per head on the CPU <= 50 ms for select requests; the owner fixes it"
        target.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(json.dumps({key: report[key] for key in ("device", "startup_seconds", "memory_ready")}, ensure_ascii=False))
        print(json.dumps({arm: {k: v for k, v in values.items() if k in ("select", "select8", "pointer", "argmax_agreement_with_fp32")}
                          for arm, values in results.items() if isinstance(values, dict) and "select" in values}, ensure_ascii=False))
        return 0
    finally:
        if device == "cuda":
            t1.release_lock()


if __name__ == "__main__":
    raise SystemExit(main())
