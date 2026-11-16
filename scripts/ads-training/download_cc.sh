#!/usr/bin/env bash
# Downloads the Common Crawl WET files listed in source-paths.txt, then filters them.
#   bash scripts/ads-training/download_cc.sh artifacts/corpora/commoncrawl-2026-43
# Skips files already complete (size equals the server's Content-Length). Data only: nothing is executed.
set -u
DIR=$1; RAW=$DIR/raw; mkdir -p "$RAW"
n=0; total=$(wc -l < "$DIR/source-paths.txt")
while read -r path; do
  n=$((n+1)); file=$RAW/$(basename "$path"); url=https://data.commoncrawl.org/$path
  want=$(curl -sI "$url" | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}')
  if [ -f "$file" ] && [ "$(stat -c %s "$file")" = "$want" ]; then echo "[$n/$total] have $(basename "$file")"; continue; fi
  for try in 1 2 3 4 5; do
    curl -sS --fail -o "$file.part" "$url" && [ "$(stat -c %s "$file.part")" = "$want" ] && mv "$file.part" "$file" && break
    echo "[$n/$total] retry $try"; sleep $((try*10))
  done
  [ -f "$file" ] && echo "[$n/$total] got $(basename "$file") $want bytes" || echo "[$n/$total] FAILED $path"
done < "$DIR/source-paths.txt"
python -I scripts/ads-training/extract_cc.py "$DIR/sites" "$RAW"/*.wet.gz
