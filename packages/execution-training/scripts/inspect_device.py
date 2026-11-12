"""Opt-in device inspection. Does not allocate a model or run training."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure local PyTorch/CUDA device availability.")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not args.execute:
        parser.error("No inspection performed. Pass --execute to query the local runtime.")
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import torch
    from execution_training.common import atomic_json
    from execution_training.resources import runtime_identity
    available = torch.cuda.is_available()
    result = {"schema_version": "execution-device-inspection-v1", "cuda_available": available,
              "cpu": runtime_identity(torch.device("cpu")), "cuda_devices": []}
    if available:
        for index in range(torch.cuda.device_count()):
            device = torch.device("cuda", index)
            identity = runtime_identity(device)
            identity.update(allocated_bytes=torch.cuda.memory_allocated(device),
                            reserved_bytes=torch.cuda.memory_reserved(device),
                            peak_reserved_bytes=torch.cuda.max_memory_reserved(device))
            result["cuda_devices"].append(identity)
    atomic_json(args.output, result)
    print("Device inspection saved:", args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

