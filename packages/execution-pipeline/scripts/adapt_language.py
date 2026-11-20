"""CLI for local language adaptation and pinned foundation experiments."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline.language_adaptation import adapt

if __name__ == "__main__":
    if sys.argv[1:2] == ["comparison"]:
        from execution_pipeline.foundation_comparison import run_comparison

        parser = argparse.ArgumentParser(description="Train one arm of the frozen comparison")
        parser.add_argument("action", choices=["comparison"])
        parser.add_argument("--config", required=True, type=Path)
        parser.add_argument("--config-sha256", required=True)
        parser.add_argument("--view", required=True, choices=("existing", "repaired"))
        parser.add_argument("--mix", required=True, choices=("current_like", "simplewiki_enriched"))
        parser.add_argument("--seed", required=True, type=int, choices=(719, 1729))
        parser.add_argument("--resume", action="store_true")
        args = parser.parse_args()
        result = run_comparison(args.config, args.config_sha256, args.view, args.mix, args.seed, resume=args.resume)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        raise SystemExit(0 if result["status"] == "completed" else 1)

    if sys.argv[1:2] == ["pilot"]:
        from execution_pipeline.foundation_pilot import run_pilot

        parser = argparse.ArgumentParser(description="Train one pinned Stage 2 model shape")
        parser.add_argument("action", choices=["pilot"])
        parser.add_argument("--config", required=True, type=Path)
        parser.add_argument("--config-sha256", required=True)
        parser.add_argument("--shape", required=True)
        parser.add_argument("--resume", action="store_true")
        parser.add_argument("--max-minutes", type=float)
        args = parser.parse_args()
        result = run_pilot(args.config, args.config_sha256, args.shape, resume=args.resume, max_minutes=args.max_minutes)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        raise SystemExit(0)

    parser = argparse.ArgumentParser()
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--out", default="language-ar-v1")
    parser.add_argument("--base-checkpoint", type=Path, default=Path("pretrain/best.pt"))
    parser.add_argument("--tokens", type=int, default=32_000_000)
    parser.add_argument("--sequence", type=int, default=512)
    parser.add_argument("--microbatch", type=int, default=8)
    parser.add_argument("--accumulation", type=int, default=2)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--warmup", type=int, default=100)
    parser.add_argument("--eval-every", type=int, default=200)
    parser.add_argument("--arabic-fraction", type=float, default=0.75)
    parser.add_argument("--seed", type=int, default=719)
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cuda")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--max-minutes", type=float)
    args = parser.parse_args()
    result = adapt(args.run, corpus=args.corpus, out_name=args.out, base_checkpoint=args.base_checkpoint,
                   total_tokens=args.tokens, sequence=args.sequence, microbatch=args.microbatch,
                   accumulation=args.accumulation, peak_lr=args.lr, warmup=args.warmup,
                   eval_every=args.eval_every, arabic_fraction=args.arabic_fraction,
                   seed=args.seed, device=args.device, resume=args.resume, max_minutes=args.max_minutes)
    print(json.dumps(result, ensure_ascii=False, indent=2))
