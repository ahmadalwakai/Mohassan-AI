"""CLI: python pipeline.py <step> --run <dir> [...]. Each step is explicit; nothing runs on import."""
import argparse, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import experiment as ex

def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("step", choices=["data", "tokenizer", "lengths", "train", "export", "evaluate"])
    p.add_argument("--run", required=True, type=Path)
    p.add_argument("--train-per-domain", type=int, default=300)
    p.add_argument("--validation-per-domain", type=int, default=10)
    p.add_argument("--heldout-per-domain", type=int, default=25)
    p.add_argument("--vocab", type=int, default=8192)
    p.add_argument("--max-token-bytes", type=int, default=256)
    p.add_argument("--isolate-digits", action="store_true")
    p.add_argument("--preset", default="17m")
    p.add_argument("--tokens", type=int, default=1_000_000)
    p.add_argument("--context", type=int, default=512)
    p.add_argument("--output", default="training")
    p.add_argument("--steps", type=int, default=None)
    p.add_argument("--accumulation", type=int, default=8)
    p.add_argument("--microbatch", type=int, default=1)
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--checkpoint-interval", type=int, default=1_000_000)
    p.add_argument("--checkpoint", default=None)
    p.add_argument("--device", default="cuda")
    a = p.parse_args()
    a.run.mkdir(parents=True, exist_ok=True)
    if a.step == "data":
        out = ex.build_dataset(a.run, ex.DataCounts(a.train_per_domain, a.validation_per_domain, a.heldout_per_domain))
    elif a.step == "tokenizer":
        out = ex.train_tokenizer(a.run, a.vocab, max_token_bytes=a.max_token_bytes, isolate_digits=a.isolate_digits)
    elif a.step == "lengths":
        out = ex.token_lengths(a.run)
    elif a.step == "train":
        r = ex.run_training(a.run, preset=a.preset, processed_tokens=a.tokens, context_length=a.context,
                            output_name=a.output, step_limit=a.steps, gradient_accumulation_steps=a.accumulation,
                            learning_rate=a.lr, checkpoint_interval_steps=a.checkpoint_interval,
                            microbatch_size=a.microbatch)
        out = {k: r[k] for k in ("status", "failure_code", "state", "session_optimizer_steps", "session_skipped_fp16_overflow_windows",
                                 "unique_dataset_tokens", "last_valid_checkpoint", "bounded_validation", "resources",
                                 "wall_seconds_measured_by_pipeline")}
        out["first_metrics"] = r["recent_metrics"][:3]; out["last_metrics"] = r["recent_metrics"][-3:]
        out["precision"] = r["compatibility"]["precision"]
    elif a.step == "export":
        from execution_pipeline.bridge import export_inference_checkpoint
        cfg = ex.model_config_for(a.run, preset=a.preset, context_length=a.context)
        out = export_inference_checkpoint(a.checkpoint, config=cfg, tokenizer=ex.load_tokenizer(a.run),
                                          output_directory=a.run / ("inference-" + a.output))
    elif a.step == "evaluate":
        from execution_pipeline.evaluate import evaluate
        report = evaluate(a.run, Path(a.checkpoint), device=a.device)
        out = {k: report[k] for k in ("test_tasks", "prompt_contract_checked", "per_family", "repairs_attempted", "repairs_unsupported")}
        out["rates"] = {arm: {name: value.get("value") for name, value in summary["rates"].items() if isinstance(value, dict) and value.get("observed")}
                        for arm, summary in report["summaries"].items()}
        out["latency_ms"] = {arm: summary["latency_ms"] for arm, summary in report["summaries"].items()}
        out["paired"] = report["paired_comparison_retrieval_vs_model"]
    print(json.dumps(out, indent=1, default=str)[:8000])
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
