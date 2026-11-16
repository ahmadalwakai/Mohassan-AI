"""Predict for offline evaluation or serve a reviewed local conversation checkpoint."""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline.chat import ChatModel, MODEL_ID, read_readiness, sha256_file


def predict(args, model):
    rows = [json.loads(line) for line in args.input.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len({row["id"] for row in rows}) != len(rows):
        raise ValueError("Evaluation IDs must be unique.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8", newline="\n") as stream:
        for index, row in enumerate(rows):
            started = time.perf_counter()
            try:
                result = model.answer(row["messages"], args.max_tokens)
            except (ValueError, RuntimeError) as error:
                result = {"text": "", "finished": False, "error": str(error)[:200]}
            record = {"id": row["id"], **result, "ms": round((time.perf_counter() - started) * 1000)}
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
            stream.flush()
            if (index + 1) % 10 == 0:
                print(json.dumps({"predicted": index + 1, "total": len(rows)}), flush=True)
    manifest = {"schemaVersion": 1, "model": MODEL_ID, "checkpoint_sha256": model.checkpoint_sha256,
                "input_sha256": sha256_file(args.input), "holdout_sha256": sha256_file(args.input),
                "predictions_sha256": sha256_file(args.output),
                "cases": len(rows), "device": args.device, "max_tokens": args.max_tokens, "decoding": "greedy"}
    args.output.with_suffix(".manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest), flush=True)


def create_server(args, model):
    read_readiness(args.readiness, model.checkpoint_sha256)
    busy = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *_):
            pass  # Conversation content and HTTP headers are never logged.

        def reply(self, status, body):
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)

        def authorized_origin(self):
            return not self.headers.get("Origin") and not self.headers.get("Sec-Fetch-Site")

        def health(self):
            read_readiness(args.readiness, model.checkpoint_sha256)
            return {"status": "ok", "model": MODEL_ID, "ready_for_chat": True,
                    "checkpoint_sha256": model.checkpoint_sha256, "context": model.worker.config.max_context_length}

        def do_GET(self):
            if self.path != "/health":
                return self.reply(404, {"error": {"code": "not_found"}})
            try:
                self.reply(200, self.health())
            except (ValueError, OSError, KeyError):
                self.reply(503, {"ready_for_chat": False, "model": MODEL_ID})

        def do_POST(self):
            if not self.authorized_origin():
                return self.reply(403, {"error": {"code": "browser_origin_denied"}})
            if self.path != "/v1/chat/completions":
                return self.reply(404, {"error": {"code": "not_found"}})
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 1 <= size <= 100000 or self.headers.get("Transfer-Encoding"):
                    raise ValueError("Request body must fit within 100000 bytes.")
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict) or body.get("model") != MODEL_ID or body.get("stream", False) is not False:
                    raise ValueError("Select the local model and non-streaming completion.")
                if set(body) - {"model", "messages", "max_tokens", "stream", "temperature"}:
                    raise ValueError("Unsupported completion fields.")
                self.health()
            except (ValueError, OSError, KeyError) as error:
                return self.reply(400, {"error": {"code": "invalid_request", "message": str(error)[:180]}})
            if not busy.acquire(blocking=False):
                return self.reply(429, {"error": {"code": "model_busy"}})
            try:
                result = model.answer(body.get("messages"), body.get("max_tokens", 192))
                if not result["text"] or "\ufffd" in result["text"]:
                    return self.reply(502, {"error": {"code": "invalid_generation"}})
                self.reply(200, {"model": MODEL_ID, "checkpoint_sha256": model.checkpoint_sha256,
                                 "choices": [{"message": {"role": "assistant", "content": result["text"]},
                                              "finish_reason": "stop" if result["finished"] else "length"}],
                                 "usage": {"prompt_tokens": result["input_tokens"]}})
            except ValueError as error:
                self.reply(400, {"error": {"code": "context_or_input", "message": str(error)[:180]}})
            except Exception:
                self.reply(503, {"error": {"code": "model_generation_failed"}})
            finally:
                busy.release()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    return server


def serve(args, model):
    server = create_server(args, model)
    print(json.dumps({"listening": f"127.0.0.1:{args.port}", "model": MODEL_ID,
                      "checkpoint_sha256": model.checkpoint_sha256}), flush=True)
    try:
        server.serve_forever()
    finally:
        server.server_close()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "diagnose":
        diagnostic = argparse.ArgumentParser(description="Run a predeclared scratch-model Stage-0 diagnostic")
        diagnostic.add_argument("action", choices=["diagnose"])
        diagnostic.add_argument("--config", type=Path, required=True)
        args = diagnostic.parse_args()
        from execution_pipeline.chat_diagnostics import run_stage_zero
        run_stage_zero(args.config)
        return
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["predict", "serve"])
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--finetune", required=True)
    parser.add_argument("--checkpoint-sha256", required=True)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cuda")
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--max-tokens", type=int, default=192)
    parser.add_argument("--readiness", type=Path)
    parser.add_argument("--port", type=int, default=47622)
    args = parser.parse_args()
    if args.action == "predict" and (not args.input or not args.output):
        parser.error("predict requires --input and --output")
    if args.action == "serve" and not args.readiness:
        parser.error("serve requires a pinned --readiness receipt")
    if args.action == "serve":
        read_readiness(args.readiness, args.checkpoint_sha256)
    model = ChatModel(args.run, args.finetune, args.device, args.checkpoint_sha256)
    predict(args, model) if args.action == "predict" else serve(args, model)


if __name__ == "__main__":
    main()
