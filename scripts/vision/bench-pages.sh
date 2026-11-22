#!/usr/bin/env bash
# Read the seven benchmark screenshots with one model and keep each page's comparison with its true text.
#   bash scripts/vision/bench-pages.sh artifacts/vision/ocr-v1 artifacts/vision-real-v1/bench/ocr-v1
set -euo pipefail
model="$1"; out="$2"; real=artifacts/vision-ocr-v1/real
mkdir -p "$out"
for png in "$real"/*.png; do
  name=$(basename "$png" .png)
  [ -f "$real/$name.txt" ] || continue
  npx tsx scripts/vision/read-image.ts "$png" --model "$model" --truth "$real/$name.txt" --json "$out/$name.json" > "$out/$name.log" 2>&1
  echo "$name $(grep -o '"wordRecall":[0-9.]*,"wordPrecision":[0-9.]*' "$out/$name.log" | head -1)"
done
