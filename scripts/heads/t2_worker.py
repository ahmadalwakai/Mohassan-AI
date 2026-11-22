"""T2: one long-lived worker that loads the trunk once and serves several heads, on the CPU or the GPU.

Plan: docs/RESPONSE-QUALITY-PLAN-2026-11-22.md, section 3 ("تجارب التدريب T"). Proposed criterion, for the
owner to fix: p95 per head on the CPU at or under 50 ms means the CPU is chosen and the GPU stays free for
training; above it, int8 weights are tried (with an output-agreement check), then the GPU.

Heads come from T1:
  head   residual bottleneck after final_norm, a switchable hook (default: artifacts/heads-t1-20261122/head)
  lora   rank-8 adapter, attached and detached (default: artifacts/heads-t1-20261122/lora)
  last2  the last two blocks and final_norm, swapped in and out of the shared trunk (--last2-dir; optional)
One trunk serves all of them. Requests measured:
  select    one forward pass over up to 128 tokens, last token only: the shape of the H2/H4/H5 decisions
  select8   eight such requests in one pass, as concurrent requests would be batched
  pointer   the Ads pointer answer, greedy, up to 96 tokens, no KV cache (what the Ads worker does today)
  int8      CPU only: select with dynamically quantised Linear layers, and its agreement with fp32
  switch    attaching/detaching LoRA, and swapping the last2 weights in from memory and from disk, then back
Each device runs in a fresh process, so start-up time and memory are clean. The version that produced
artifacts/heads-t2-20261122 is kept as artifacts/heads-t2-20261122/code/t2_worker.py (no last2, fixed dirs).
  python -I scripts/heads/t2_worker.py --device cpu  --out artifacts/heads-t2-20261122
  python -I scripts/heads/t2_worker.py --device cuda --out artifacts/heads-t2-rerun-20261122 \
      --lora-dir artifacts/heads-t1-rerun-20261122/lora --last2-dir artifacts/heads-t1-rerun-20261122/last2
--smoke: one thread, a few requests, for a functional check only (its numbers are not measurements).
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
import threading  # noqa: E402
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
COUNTS = {"select": 50, "batch": 20, "pointer": 10, "warmup": 5, "switch": 5}
SMOKE_COUNTS = {"select": 3, "batch": 2, "pointer": 1, "warmup": 1, "switch": 1}


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


class Load(threading.Thread):
    """The machine's total CPU use and other jobs on the card every 15 s, so timings can be read against
    the load they ran under (other sessions share this laptop)."""

    def __init__(self) -> None:
        super().__init__(daemon=True)
        self.stop_event = threading.Event()
        self.cpu: list[float] = []
        self.foreign: set[str] = set()

    def run(self) -> None:
        while not self.stop_event.is_set():
            try:
                _, cpu = t1.adapters_memory(with_cpu=True)
                if cpu is not None:
                    self.cpu.append(cpu)
                self.foreign.update(entry.split(":", 1)[0] for entry in t1.foreign_gpu_users())
            except Exception:  # noqa: BLE001  (a failed sample must not stop the measurement)
                pass
            self.stop_event.wait(15)

    def summary(self) -> dict:
        values = sorted(self.cpu)
        return {"samples": len(values), "cpu_mean_pct": round(statistics.fmean(values), 1) if values else None,
                "cpu_max_pct": values[-1] if values else None, "other_gpu_processes": sorted(self.foreign)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", choices=["cpu", "cuda"], required=True)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--head-dir", type=Path, default=T1_DIR / "head")
    parser.add_argument("--lora-dir", type=Path, default=T1_DIR / "lora")
    parser.add_argument("--last2-dir", type=Path, default=None)
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()
    device = args.device
    counts = SMOKE_COUNTS if args.smoke else COUNTS
    if args.smoke:
        torch.set_num_threads(1)
    resolve = lambda path: path if path.is_absolute() else (ROOT / path).resolve()  # noqa: E731
    out = resolve(args.out)
    head_dir, lora_dir = resolve(args.head_dir), resolve(args.lora_dir)
    last2_dir = resolve(args.last2_dir) if args.last2_dir else None
    out.mkdir(parents=True, exist_ok=True)
    target = out / f"{device}.json"
    if target.exists():
        raise SystemExit(f"{target} exists; results are never overwritten")
    foreign = t1.foreign_gpu_users()
    if device == "cuda":
        if foreign:
            raise SystemExit(f"Another job holds GPU memory: {foreign}")
        t1.acquire_lock("T2 worker (cuda)" + (" smoke" if args.smoke else ""))
    load = Load()
    load.start()
    try:
        autocast = (lambda: torch.autocast("cuda", dtype=torch.bfloat16)) if device == "cuda" else None
        loaded = time.perf_counter()
        model, tokenizer, config = af._load_pretrained(t1.RUN, device, t1.BASE)
        model.eval()
        head = t1.ResidualHead(config.hidden_size, t1.ARMS["head"]["bottleneck"]).to(device)
        head.load_state_dict(torch.load(head_dir / "trainable-best.pt", map_location=device, weights_only=True))
        head.eval()
        active = {"head": False}
        model.final_norm.register_forward_hook(lambda module, inputs, output: head(output) if active["head"] else output)
        lora_state = torch.load(lora_dir / "trainable-best.pt", map_location=device, weights_only=True)
        ready = time.perf_counter()
        report: dict = {
            "device": device, "started": datetime.now(timezone.utc).isoformat(timespec="seconds"), "smoke": args.smoke,
            "threads": torch.get_num_threads(), "torch": torch.__version__, "counts": counts,
            "code_sha256": t1.sha256(Path(__file__)),
            "heads": {"head": str(head_dir), "lora": str(lora_dir), "last2": str(last2_dir) if last2_dir else None},
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
        selects = [prompt[-SELECT_TOKENS:] for prompt in prompts[:counts["select"] + counts["warmup"]]]

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
            for sequence in selects[:counts["warmup"]]:
                forward([sequence])
            single = []
            for sequence in selects[counts["warmup"]:]:
                sync(device)
                began = time.perf_counter()
                forward([sequence])
                sync(device)
                single.append(time.perf_counter() - began)
            batched = []
            for index in range(counts["batch"]):
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

        def time_pointer(arm_dir: Path) -> dict:
            answers = {json.loads(line)["id"]: json.loads(line)["answer_text"]
                       for line in (arm_dir / "answers" / "goal_test_unseen_phrasing.jsonl").read_text(encoding="utf-8").splitlines() if line}
            pointer(prompts[0])
            times, same = [], 0
            for record, prompt in zip(records[1:counts["pointer"] + 1], prompts[1:counts["pointer"] + 1]):
                text, seconds = pointer(prompt)
                times.append(seconds)
                same += int(text == answers.get(record["id"]))
            return {**percentiles(times), "same_answer_as_t1_batch_run": f"{same}/{len(times)}"}

        def timed(action) -> float:
            sync(device)
            began = time.perf_counter()
            action()
            sync(device)
            return time.perf_counter() - began

        results: dict = {}
        results["trunk_only"] = time_selects("trunk")
        active["head"] = True
        results["head"] = time_selects("head")
        results["head"]["pointer"] = time_pointer(head_dir)
        active["head"] = False
        began = time.perf_counter()
        handle = attach_adapter(model, "t2-lora", rank=t1.ARMS["lora"]["rank"], alpha=t1.ARMS["lora"]["alpha"], seed=t1.SEED)
        handle.state_module().load_state_dict(lora_state)
        attached = time.perf_counter() - began
        results["lora"] = time_selects("lora")
        results["lora"]["pointer"] = time_pointer(lora_dir)
        began = time.perf_counter()
        detach_adapter(model)
        results["switch_seconds"] = {"attach_and_load_lora": round(attached, 4), "detach_lora": round(time.perf_counter() - began, 4)}
        if last2_dir:
            path = last2_dir / "trainable-best.pt"
            from_disk = []
            for _ in range(counts["switch"]):
                began = time.perf_counter()
                last2_state = torch.load(path, map_location="cpu", weights_only=True)
                from_disk.append(time.perf_counter() - began)
            current = model.state_dict()
            base_blocks = {key: current[key].detach().clone() for key in last2_state}
            swap_in = [timed(lambda: model.load_state_dict(last2_state, strict=False)) for _ in range(counts["switch"])]
            results["last2"] = time_selects("last2")
            results["last2"]["pointer"] = time_pointer(last2_dir)
            swap_back = [timed(lambda: model.load_state_dict(base_blocks, strict=False)) for _ in range(counts["switch"])]
            results["switch_seconds"].update({
                "last2_parameters": sum(value.numel() for value in last2_state.values()),
                "last2_file_mib": round(path.stat().st_size / 2**20, 1),
                "last2_load_file_to_cpu_median": round(statistics.median(from_disk), 4),
                "last2_swap_in_from_cpu_memory_median": round(statistics.median(swap_in), 4),
                "last2_swap_back_from_device_copy_median": round(statistics.median(swap_back), 4),
                "repeats": counts["switch"]})
            state = model.state_dict()
            results["switch_seconds"]["base_restored_exactly"] = all(torch.equal(state[key], base_blocks[key]) for key in base_blocks)
            del base_blocks, last2_state
        if device == "cpu":
            reference = torch.stack([forward([sequence])[0] for sequence in selects[counts["warmup"]:]])
            quantised = torch.ao.quantization.quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8)
            original, model = model, quantised
            try:
                timing = time_selects("trunk_int8")
                approximate = torch.stack([forward([sequence])[0] for sequence in selects[counts["warmup"]:]])
                timing["argmax_agreement_with_fp32"] = f"{int((approximate.argmax(-1) == reference.argmax(-1)).sum())}/{len(selects) - counts['warmup']}"
                results["int8"] = timing
            finally:
                model = original
        report["results"] = results
        load.stop_event.set()
        report["machine_load"] = {"gpu_jobs_at_start": foreign, **load.summary()}
        report["memory_end"] = memory()
        if device == "cuda":
            report["gpu_end"] = {"max_allocated_mib": round(torch.cuda.max_memory_allocated() / 2**20),
                                 "nvidia_dedicated_mib": t1.nvidia()["dedicated_mib"]}
        report["criterion_proposed"] = "p95 per head on the CPU <= 50 ms for select requests; the owner fixes it"
        target.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(json.dumps({key: report[key] for key in ("device", "startup_seconds", "memory_ready", "machine_load")}, ensure_ascii=False))
        print(json.dumps({arm: {k: v for k, v in values.items() if k in ("select", "select8", "pointer", "argmax_agreement_with_fp32")}
                          for arm, values in results.items() if isinstance(values, dict) and "select" in values}, ensure_ascii=False))
        print(json.dumps(results["switch_seconds"], ensure_ascii=False))
        return 0
    finally:
        load.stop_event.set()
        if device == "cuda":
            t1.release_lock()


if __name__ == "__main__":
    raise SystemExit(main())
