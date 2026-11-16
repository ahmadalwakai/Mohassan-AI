"""Bounded raw continuation comparison; diagnostic snapshots never replace training weights."""
from __future__ import annotations
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
RUN = ROOT / "artifacts/execution-model-runs/text-b3-ar-2026-11-15"
PREFIXES = [
    ("ar-01", "ar", "في نهاية الطريق توجد حديقة صغيرة، وفي وسطها"),
    ("ar-02", "ar", "عندما يصل المطر إلى التربة، تبدأ النباتات"),
    ("ar-03", "ar", "وضعت سلمى الكتاب على الطاولة ثم"),
    ("ar-04", "ar", "يستطيع القارئ أن يتعلم أشياء جديدة عندما"),
    ("en-01", "en", "At the end of the road there is a small garden, and in its center"),
    ("en-02", "en", "When rain reaches the soil, the plants begin"),
    ("en-03", "en", "Salma placed the book on the table and then"),
    ("en-04", "en", "A reader can learn new things by"),
]


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def atomic_bytes(path: Path, data: bytes) -> None:
    temporary = path.with_suffix(path.suffix + ".partial")
    with temporary.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def checkpoint_snapshot(path: Path) -> bytes:
    # The trainer publishes immutable files using os.replace. On Windows allow
    # delete/rename sharing while holding one source file handle, so its atomic
    # publication is not blocked by this diagnostic reader.
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        import msvcrt
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                      wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        handle = kernel.CreateFileW(str(path), 0x80000000, 7, None, 3, 0x80, None)
        if handle == wintypes.HANDLE(-1).value:
            raise ctypes.WinError(ctypes.get_last_error())
        descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
        with os.fdopen(descriptor, "rb") as stream:
            return stream.read()
    return path.read_bytes()


def child(name: str) -> None:
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    import torch
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    sys.path.insert(0, str(ROOT / "packages/execution-pipeline"))
    from execution_pipeline.ads_worker import AdsWorker
    folder = RUN / name
    provenance = json.loads((folder / "provenance.json").read_text(encoding="utf-8"))
    provenance["torch_threads"] = torch.get_num_threads()
    provenance["torch_interop_threads"] = torch.get_num_interop_threads()
    provenance["torch_version"] = torch.__version__
    provenance["workers"] = {}
    outputs = []
    started = time.monotonic()
    for label, finetune, expected in (
        ("expanded_initialization", "pretrain", provenance["expanded_checkpoint_sha256"]),
        ("arabic_foundation_snapshot", name, provenance["snapshot_checkpoint_sha256"]),
    ):
        worker = AdsWorker(RUN, "cpu", finetune, expected_sha256=expected)
        assert worker.device == "cpu" and worker.hint is None
        provenance["workers"][label] = worker.handshake()
        for identifier, language, prefix in PREFIXES:
            case_start = time.monotonic()
            answer = worker.sample({"prompt": prefix, "candidates": 1, "max_new_tokens": 64,
                                    "top_k": 1, "temperature": 0.7, "seed": 21})[0]
            words = re.findall(r"\w+", answer["text"].casefold())
            trigrams = list(zip(words, words[1:], words[2:]))
            counts = Counter(trigrams)
            row = {"checkpoint": label, "case": identifier, "language": language, "prefix": prefix,
                   "continuation": answer["text"], "finished_eos": answer["finished"],
                   "elapsed_seconds": round(time.monotonic() - case_start, 3),
                   "word_count": len(words), "unique_word_count": len(set(words)),
                   "repeated_word_trigram_occurrences": sum(count - 1 for count in counts.values()),
                   "maximum_word_trigram_multiplicity": max(counts.values(), default=0)}
            outputs.append(row)
            with (folder / "outputs.jsonl").open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")
            print(json.dumps(row, ensure_ascii=False), flush=True)
        del worker
    provenance["elapsed_generation_seconds"] = round(time.monotonic() - started, 3)
    provenance["snapshot_embedded_step"] = provenance["workers"]["arabic_foundation_snapshot"]["finetune_step"]
    provenance["outputs_sha256"] = sha((folder / "outputs.jsonl").read_bytes())
    provenance["complete"] = len(outputs) == 16
    atomic_bytes(folder / "completed-provenance.json", (json.dumps(provenance, ensure_ascii=False, indent=2) + "\n").encode())


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--child")
    args = parser.parse_args()
    if args.child:
        child(args.child)
        return
    started = time.monotonic()
    name = "diagnostic-raw-cpu-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    folder = RUN / name
    folder.mkdir(exist_ok=False)
    snapshot = checkpoint_snapshot(RUN / "language-ar-v1/best.pt")
    atomic_bytes(folder / "best.pt", snapshot)
    settings = (RUN / "language-ar-v1/settings.json").read_bytes()
    atomic_bytes(folder / "settings.json", settings)
    provenance = {"diagnostic_only": True, "readiness_evaluation": False, "created_at": datetime.now(timezone.utc).isoformat(),
                  "source_checkpoint": "language-ar-v1/best.pt", "snapshot_checkpoint_sha256": sha(snapshot),
                  "snapshot_bytes": len(snapshot), "source_settings_sha256": sha(settings),
                  "expanded_checkpoint_sha256": sha((RUN / "pretrain/best.pt").read_bytes()),
                  "tokenizer_sha256": sha((RUN / "tokenizer.json").read_bytes()),
                  "probe_script_sha256": sha(Path(__file__).read_bytes()),
                  "prefixes": [{"id": i, "language": language, "text": text} for i, language, text in PREFIXES],
                  "device": "cpu", "cpu_threads": 2, "candidate_count": 1, "decode": "greedy candidate 0", "max_new_tokens": 64,
                  "chat_framing": False, "final_holdout_accessed": False, "status_file_used": False,
                  "snapshot_method": "One shared-delete source handle on an atomically published checkpoint; fsync and atomic destination rename.",
                  "timeout_seconds": 290, "active_training_weights_modified": False}
    atomic_bytes(folder / "provenance.json", (json.dumps(provenance, ensure_ascii=False, indent=2) + "\n").encode())
    del snapshot
    print(json.dumps({"diagnostic_folder": str(folder), "snapshot_sha256": provenance["snapshot_checkpoint_sha256"]}), flush=True)
    try:
        subprocess.run([sys.executable, str(Path(__file__).resolve()), "--child", name], check=True,
                       timeout=max(1, 290 - (time.monotonic() - started)),
                       env={**os.environ, "CUDA_VISIBLE_DEVICES": "", "OMP_NUM_THREADS": "2", "MKL_NUM_THREADS": "2"})
    except subprocess.TimeoutExpired:
        atomic_bytes(folder / "timeout.json", json.dumps({"timed_out": True, "elapsed_seconds": time.monotonic() - started}).encode())
        raise
    print(json.dumps({"complete": True, "diagnostic_folder": str(folder), "elapsed_seconds": round(time.monotonic() - started, 3)}), flush=True)


if __name__ == "__main__":
    main()
