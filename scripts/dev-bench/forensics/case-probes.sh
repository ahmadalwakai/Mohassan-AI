#!/usr/bin/env bash
set -euo pipefail
umask 077

if (( $# != 4 )); then
  printf 'Usage: %s HISTORICAL_OUTPUT CANONICAL_RECEIPT NEW_EVIDENCE_DIR CHROMIUM_DIR\n' "$0" >&2
  exit 2
fi

helpers=$(dirname "$(realpath "${BASH_SOURCE[0]}")")
historical=$(realpath "$1")
canonical=$(realpath "$2")
evidence=$(realpath -m "$3")
chromium=$(realpath "$4")
home=$(node -p "require('node:os').homedir()")
if [[ $home == / || ! -d $home ]]; then
  printf 'Use an account with a normal home directory for the desktop fixture adapter.\n' >&2
  exit 2
fi
if [[ $(git rev-parse HEAD) != 7f9c417f2e06b77c26eb6ff677d06e3457da650b ]]; then
  printf 'Run from the detached #89 implementation checkout.\n' >&2
  exit 2
fi
mkdir -m 700 "$evidence"

profile() {
  local browser=$1 scratch=$2
  shift 2
  local browser_setting=()
  if [[ -n $browser ]]; then
    browser_setting=("PLAYWRIGHT_BROWSERS_PATH=$browser")
  fi
  env -i PATH="$PATH" HOME="$home" TZ=UTC VITEST=1 \
    "${browser_setting[@]}" \
    MOHASSAN_SCRATCH_CLASSIFIERS="$scratch" \
    MOHASSAN_SMALL_TALK_MANNERS=1 \
    MOHASSAN_CONVERSATION_REVIEW_APPLY=1 \
    MOHASSAN_CONVERSATION_SHADOW=decide \
    MOHASSAN_STRUCTURED_MEMORY=1 \
    MOHASSAN_EXTRACTIVE_WRITING=1 \
    MOHASSAN_PLAN_COMPILER=on \
    MOHASSAN_REASONING=1 \
    MOHASSAN_CLARIFY_CHOICES=1 \
    MOHASSAN_REFUSAL_POLICY=1 \
    TEST_DRIVEN_CODING_ENABLED=true \
    MOHASSAN_QUESTION_REWRITER=1 \
    MOHASSAN_REPLY_POLICY_ENABLED=0 \
    MOHASSAN_CONTEXT_POLICY_ENABLED=0 \
    MOHASSAN_LONG_RUN_ENABLED=0 \
    node --no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx \
    "$helpers/profile-probe.mjs" "$historical" "$@"
}

diffs="$evidence/per-case-differences.json"
cases="$evidence/v2-difference-ids.json"
python3 -B "$helpers/compare-pr89.py" "$historical" "$canonical" "$diffs" "$cases"
profile "$chromium" 0 v1 document-file "$evidence/chromium-only.json" disabled > "$evidence/chromium-only.log" 2>&1
profile '' 1 v2 "$cases" "$evidence/scratch-only.json" disabled > "$evidence/scratch-only.log" 2>&1
profile '' 0 v2 "$cases" "$evidence/learned-only.json" loaded > "$evidence/learned-only.log" 2>&1
