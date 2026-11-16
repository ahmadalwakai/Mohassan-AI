"""Generate a bounded TypeScript candidate from an explicitly supplied contract.

The user supplies the request, signature and independent expected test outputs.
This utility does not invent a specification, generate expected answers, execute
the candidate or apply it to a project. It writes JSON review/evaluation artifacts
only. Run the produced verification job with scripts/code-training/verify.ts.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any

from .code_tasks import IDENTIFIER, render_prompt


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def prepare_input(document: Any) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ValueError("Input must be a JSON object with message, signature, functionName and probes.")
    required = {"message", "signature", "functionName", "probes"}
    allowed = required | {"mode", "language", "family", "failed_candidate", "failure_evidence"}
    if not required <= document.keys() or set(document) - allowed:
        raise ValueError("Input has missing or unsupported fields; expected outputs belong only in probes.")
    given = json.loads(_json(document))
    if len(_json(given).encode("utf-8")) > 65536:
        raise ValueError("Input exceeds the 64 KiB limit.")
    for field, limit in (("message", 4000), ("signature", 300), ("functionName", 48)):
        if not isinstance(given[field], str) or not given[field].strip() or len(given[field]) > limit:
            raise ValueError(f"Invalid {field}.")
    if not IDENTIFIER.fullmatch(given["functionName"]):
        raise ValueError("Invalid exported function name.")
    if not given["signature"].startswith(given["functionName"] + "("):
        raise ValueError("Signature must begin with the supplied functionName followed by '('.")
    given.setdefault("mode", "implement")
    given.setdefault("language", "en")
    if given["mode"] not in {"implement", "repair"} or given["language"] not in {"ar", "en"}:
        raise ValueError("Choose implement or repair and language ar or en.")
    probes = given["probes"]
    if not isinstance(probes, list) or not 1 <= len(probes) <= 30:
        raise ValueError("Supply 1–30 independent behavioral probes.")
    for probe in probes:
        if not isinstance(probe, dict) or set(probe) != {"args", "expected"} or not isinstance(probe["args"], list) or len(probe["args"]) > 4:
            raise ValueError("Every probe must contain args (up to four arguments) and an expected value.")
    if given["mode"] == "repair":
        if not isinstance(given.get("failed_candidate"), str) or not 1 <= len(given["failed_candidate"]) <= 4000:
            raise ValueError("Repair requires the actual failed candidate source.")
        evidence = given.get("failure_evidence")
        if not isinstance(evidence, dict) or not {"args", "observed", "expected"} <= evidence.keys() \
                or not isinstance(evidence["args"], list) or len(evidence["args"]) > 4 \
                or evidence["observed"] == evidence["expected"]:
            raise ValueError("Repair requires a concrete failing probe with different observed and expected values.")
    elif "failed_candidate" in given or "failure_evidence" in given:
        raise ValueError("Failure evidence is only used with mode repair.")
    return given


def generate(given: dict[str, Any], worker: Any, *, max_new_tokens: int = 384) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Calls the model once, greedily. The supplied oracle probes are preserved."""
    given = prepare_input(given)
    prompt = render_prompt(given)
    candidates = worker.sample({"prompt": prompt, "input": given, "candidates": 1, "top_k": 1,
                                "max_new_tokens": max_new_tokens})
    if not isinstance(candidates, list) or len(candidates) != 1 or not isinstance(candidates[0], dict) \
            or not isinstance(candidates[0].get("text"), str) or type(candidates[0].get("finished")) is not bool:
        raise ValueError("Model returned an invalid candidate response.")
    candidate = candidates[0]
    finished = candidate["finished"] and bool(candidate["text"].strip())
    input_hash = hashlib.sha256(_json(given).encode()).hexdigest()
    candidate_hash = hashlib.sha256(candidate["text"].encode()).hexdigest()
    identity = "code-request-" + input_hash[:20]
    result = {"status": "needs_verification" if finished else "incomplete_generation", "id": identity,
              "model": worker.handshake(), "inputSha256": input_hash, "candidateSha256": candidate_hash,
              "input": given, "prompt": prompt, "candidates": candidates, "decoding": "greedy",
              "verified": False, "applied": False}
    job = None
    if finished:
        job = {"inputSha256": input_hash, "model": result["model"], "candidates": [
            {"id": identity, "content": candidate["text"], "functionName": given["functionName"], "signature": given["signature"],
             "probes": given["probes"], "language": given["language"], "mode": given["mode"],
             "family": given.get("family", "user_supplied_contract")}]}
    return result, job


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="JSON with the user's explicit contract and independent test expectations.")
    parser.add_argument("--output", required=True, type=Path, help="New JSON artifact; existing files are never overwritten.")
    parser.add_argument("--verification-job", type=Path, help="New verification job path; defaults beside --output.")
    parser.add_argument("--run", required=True, type=Path)
    parser.add_argument("--finetune", required=True)
    parser.add_argument("--checkpoint-sha256")
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--max-new-tokens", type=int, default=384)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,64}", args.finetune) or args.finetune in {".", ".."}:
        parser.error("--finetune must be a plain checkpoint-folder name.")
    if args.checkpoint_sha256 and not re.fullmatch(r"[a-f0-9]{64}", args.checkpoint_sha256):
        parser.error("--checkpoint-sha256 must be a lowercase SHA-256 digest.")
    if not 16 <= args.max_new_tokens <= 384:
        parser.error("--max-new-tokens must be between 16 and 384.")
    output = args.output.resolve()
    job_path = (args.verification_job or output.with_name(output.stem + ".verify-job.json")).resolve()
    if output == job_path or output.exists() or job_path.exists():
        parser.error("Output paths must be different and must not already exist.")
    try:
        if args.input.stat().st_size > 65536:
            raise ValueError("Input exceeds the 64 KiB limit.")
        given = prepare_input(json.loads(args.input.read_text(encoding="utf-8-sig")))
        import torch
        from .ads_worker import AdsWorker
        if args.device == "cuda" and not torch.cuda.is_available():
            raise ValueError("CUDA is unavailable; choose --device cpu explicitly.")
        worker = AdsWorker(args.run.resolve(), args.device, args.finetune, args.checkpoint_sha256)
        result, job = generate(given, worker, max_new_tokens=args.max_new_tokens)
        output.parent.mkdir(parents=True, exist_ok=True)
        if job is not None:
            job_path.parent.mkdir(parents=True, exist_ok=True)
            with job_path.open("x", encoding="utf-8") as stream:
                stream.write(json.dumps(job, ensure_ascii=False, indent=2) + "\n")
        result["verificationJob"] = str(job_path) if job is not None else None
        with output.open("x", encoding="utf-8") as stream:
            stream.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"status": result["status"], "output": str(output), "verificationJob": result["verificationJob"],
                          "verified": False, "applied": False}, ensure_ascii=False))
        return 0 if job is not None else 2
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, f"{type(error).__name__}: {error}\n")


if __name__ == "__main__":
    raise SystemExit(main())
