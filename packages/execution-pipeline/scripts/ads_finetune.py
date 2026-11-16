"""CLI: python -I ads_finetune.py <train|answers> --run <dir> [--limit N]. See execution_pipeline/ads_finetune.py."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import ads_finetune  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("step", choices=["train", "answers", "candidates"])
    p.add_argument("--run", required=True, type=Path)
    p.add_argument("--epochs", type=int, default=3)
    p.add_argument("--batch", type=int, default=32)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--eval-every", type=int, default=150)
    p.add_argument("--patience", type=int, default=4)
    p.add_argument("--warmup", type=int, default=100)
    p.add_argument("--seed", type=int, default=None, help="default: 5 for training, 21 for candidate generation")
    p.add_argument("--device", choices=["cuda", "cpu"], default="cuda")
    p.add_argument("--base-checkpoint", type=Path, default=None,
                   help="train only: warm-start from an existing .pt inside --run; new optimizer, not an exact resume")
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--candidates", type=int, default=8)
    p.add_argument("--temperature", type=float, default=0.7)
    p.add_argument("--out", default="ads-finetune", help="folder inside the run for the fine-tuned model and its outputs")
    p.add_argument("--data-dir", type=Path, default=None, help="dataset folder (default artifacts/ads-training/dataset)")
    p.add_argument("--splits", default=None, help="comma-separated splits for answers/candidates")
    p.add_argument("--max-new-tokens", type=int, default=None)
    p.add_argument("--drop-long", action="store_true", help="train only: leave out examples above the context")
    p.add_argument("--group-by-length", action="store_true", help="train only: batch examples of similar length")
    p.add_argument("--balance-languages", action="store_true",
                   help="train only: homogeneous ar/en batches with equal row/update exposure and language-macro validation")
    p.add_argument("--hint", choices=[ads_finetune.NAME_HINT], default=None,
                   help="train only: add the brief's names to the prompt; generation reads it from settings.json")
    a = p.parse_args()
    run = a.run.resolve()
    if a.step == "train":
        out = ads_finetune.finetune(run, epochs=a.epochs, batch=a.batch, peak_lr=a.lr, eval_every=a.eval_every,
                                    patience=a.patience, limit=a.limit, hint=a.hint, out_name=a.out, data_dir=a.data_dir,
                                    drop_long=a.drop_long, group_by_length=a.group_by_length, warmup=a.warmup,
                                    seed=5 if a.seed is None else a.seed, device=a.device, base_checkpoint=a.base_checkpoint,
                                    balanced_languages=a.balance_languages)
    else:
        extra = {"splits": tuple(a.splits.split(","))} if a.splits else {}
        if a.max_new_tokens:
            extra["max_new_tokens"] = a.max_new_tokens
        if a.step == "answers":
            out = ads_finetune.generate_answers(run, batch=a.batch, limit=a.limit, out_name=a.out, data_dir=a.data_dir, device=a.device, **extra)
        else:
            out = ads_finetune.generate_candidates(run, candidates=a.candidates, temperature=a.temperature,
                                                   batch=a.batch, limit=a.limit, out_name=a.out, data_dir=a.data_dir,
                                                   device=a.device, seed=21 if a.seed is None else a.seed, **extra)
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
