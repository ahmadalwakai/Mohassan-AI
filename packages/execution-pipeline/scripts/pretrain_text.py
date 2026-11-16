"""CLI: python -I pretrain_text.py <step> --run <dir> [...]. Steps: tokenizer, encode, train, benchmark, export.

Raw-text pre-training of the scratch model (see execution_pipeline/pretrain.py).
Create a file named STOP in the run directory to pause training; rerun "train" to resume.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_pipeline import pretrain  # noqa: E402


def main() -> int:
    if sys.argv[1:2] == ["benchmark"]:
        benchmark = argparse.ArgumentParser(description="Benchmark one guarded scratch pretraining shape")
        benchmark.add_argument("step", choices=["benchmark"])
        benchmark.add_argument("--run", required=True, type=Path, help="Run containing the pinned tokenizer")
        benchmark.add_argument("--corpus", required=True, type=Path)
        benchmark.add_argument("--output", required=True, type=Path)
        benchmark.add_argument("--shape", required=True, choices=pretrain.BENCHMARK_SHAPES)
        benchmark.add_argument("--microbatch", type=int, default=2)
        benchmark.add_argument("--accumulation", type=int, default=8)
        args = benchmark.parse_args()
        result = pretrain.benchmark_text(args.run.resolve(), args.corpus.resolve(), args.output.resolve(), args.shape,
                                         microbatch=args.microbatch, accumulation=args.accumulation)
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0

    p = argparse.ArgumentParser()
    p.add_argument("step", choices=["tokenizer", "word-tokenizer", "encode", "train", "export"])
    p.add_argument("--run", required=True, type=Path)
    p.add_argument("--vocab", type=int, default=16384)
    p.add_argument("--wiki-bytes", type=int, default=20_000_000)
    p.add_argument("--ads-bytes", type=int, default=4_000_000)
    p.add_argument("--workers", type=int, default=12)
    p.add_argument("--limit", type=int, default=None)
    p.add_argument("--preset", default="B")
    p.add_argument("--tokens", type=int, default=200_000_000)
    p.add_argument("--sequence", type=int, default=512)
    p.add_argument("--microbatch", type=int, default=8)
    p.add_argument("--accumulation", type=int, default=8)
    p.add_argument("--lr", type=float, default=8e-4)
    p.add_argument("--warmup", type=int, default=300)
    p.add_argument("--eval-every", type=int, default=250)
    p.add_argument("--max-minutes", type=float, default=None)
    p.add_argument("--source", default="best.pt")
    p.add_argument("--name", default="inference")
    a = p.parse_args()
    run = a.run.resolve()
    if a.step == "tokenizer":
        out = pretrain.train_tokenizer(run, vocab=a.vocab, wiki_bytes=a.wiki_bytes, ads_bytes=a.ads_bytes)
    elif a.step == "word-tokenizer":
        out = pretrain.train_word_tokenizer(run, vocab=a.vocab)
    elif a.step == "encode":
        out = pretrain.encode_corpus(run, workers=a.workers, limit=a.limit)
    elif a.step == "train":
        out = pretrain.train_text(run, preset=a.preset, total_tokens=a.tokens, sequence=a.sequence,
                                  microbatch=a.microbatch, accumulation=a.accumulation, peak_lr=a.lr,
                                  warmup_steps=a.warmup, eval_every=a.eval_every, max_minutes=a.max_minutes)
    else:
        out = pretrain.export_text_checkpoint(run, source=a.source, name=a.name)
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
