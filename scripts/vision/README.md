# Own image reader (OCR) — training side

Everything here is built from scratch: synthetic text lines rendered from the fonts on this
computer, a small CRNN trained with CTC, and an export the TypeScript reader in
`packages/vision` loads. No outside model, dataset or API is used.

Python environment: `C:\Users\Administrator\.venvs\mohassan-vision` (torch 2.14 + CUDA 12.6, pillow,
numpy, arabic-reshaper, python-bidi). The system Python only needs pillow + numpy + arabic-reshaper
for rendering.

| step | command |
| --- | --- |
| look at samples | `python -I scripts/vision/preview.py out.png [seed] [count] [--holdout]` |
| render shards | `python -I scripts/vision/make_shards.py --out artifacts/vision-ocr-v1/data --train-lines 480000 --shards 8 --holdout-lines 3000 --workers 5` |
| train | `<venv>/python -I scripts/vision/train.py --data artifacts/vision-ocr-v1/data --out artifacts/vision-ocr-v1/run-1 --steps 30000 --batch 64 --workers 2` (`--arch v2` for the lighter model) |
| evaluate | `<venv>/python -I scripts/vision/eval.py --run artifacts/vision-ocr-v1/run-1 --data artifacts/vision-ocr-v1/data --json metrics.json` |
| export for the server | `<venv>/python -I scripts/vision/export.py --run artifacts/vision-ocr-v1/run-1 --data artifacts/vision-ocr-v1/data --out artifacts/vision/ocr-v1` |
| TypeScript parity | `npx vitest run packages/vision/src/ocr-parity.test.ts` (reads `artifacts/vision/ocr-v1/parity.json`) |
| read one image | `npx tsx scripts/vision/read-image.ts image.png [--truth page.txt] [--dump crops-dir] [--model dir]` |
| capture real pages | `npx tsx scripts/vision/capture-real.ts --out artifacts/vision-ocr-v1/real` |
| speed | `npx tsx scripts/vision/bench-ocr.ts --widths 200,400,800` |

## Real screenshots (fine-tuning data)

Labels come from the page itself, never from a model: the browser reports every visible
character's box, the reader's own layout finds the lines, and a crop is kept only when the
page's characters fully explain its ink (see the header of each script for the checks).

| step | command |
| --- | --- |
| capture pages | `npx tsx scripts/vision/capture-lines.ts --out artifacts/vision-real-v1/captures [--concurrency 3] [--generated 150] [--limit-pages N]` (seeds: `real-pages.json`; honours robots.txt and skips sites that opt out of AI crawlers) |
| match lines | `npx tsx scripts/vision/match-lines.ts --captures artifacts/vision-real-v1/captures --out artifacts/vision-real-v1/lines [--part 0/4]` |
| build shards | `<venv>/python -I scripts/vision/build_real_shards.py --lines artifacts/vision-real-v1/lines --out artifacts/vision-real-v1/data` |
| check labels by eye | `<venv>/python -I -X utf8 scripts/vision/show_shard.py artifacts/vision-real-v1/data real-train sheet.png [count] [seed]` |
| measure | `eval.py ... --real artifacts/vision-real-v1/data` adds `real-heldout-site` (sites never trained on) and `real-heldout-page` |
| fine-tune | `train.py --data artifacts/vision-ocr-v1/data --real artifacts/vision-real-v1/data --init artifacts/vision-ocr-v1/run-1/best.pt --select real-heldout-page --lr 3e-4 ...` |
| benchmark pages | `bash scripts/vision/bench-pages.sh <model dir> <out dir>` (the seven pages of `artifacts/vision-ocr-v1/real`) |
| benchmark screenshots | `npx tsx scripts/vision/bench-captures.ts --captures artifacts/vision-real-v1/captures-site2 --model artifacts/vision/ocr-v1 --out <file>` (whole screenshots of sites never trained on; the truth is the page's visible characters) |
| diagnose pages | `npx tsx scripts/vision/diagnose-pages.ts --captures <dir> [--select <bench json>] --out <file>` (traces every visible word: missed, dropped, cut by splitting, in a box with two rows, in an oversized box, misread; and lines read where no text is visible) |

Files: `charset.py` (classes, normalisation, visual order — mirrored by `packages/vision/src/bidi.ts`),
`textgen.py` (corpus windows + generated strings), `render.py` (fonts, shaping, degradations, the
"screen" and "print" modes), `model.py` (CRNN, batch-norm folding), `train.py`, `eval.py`, `export.py`.

GPU rule (owner, RESPONSE-QUALITY-PLAN §6): one training job on the card at a time. `train.py` and
`eval.py` wait while `.data/gpu.lock` exists, then create it exclusively (JSON: owner, purpose, pid,
started) and remove it when done. Never delete another job's lock by hand.

The server loads `artifacts/vision/ocr-v1` (or `MOHASSAN_OCR_MODEL_DIR`) at start; without the files,
image messages are refused with a clear message. Since 2026-11-22 that folder holds the real-screenshot
fine-tune (`ocr-v1-real2`, id `194922ae…`); the synthetic-only original is kept in `artifacts/vision/ocr-v1-base`. Measured results are in
`docs/IMAGE-READING-2026-11-22.md`.
