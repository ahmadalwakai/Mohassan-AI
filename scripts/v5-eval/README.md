# v5 foundation end-of-run evaluation

Run these commands from the repository root in Git Bash with the owner's existing
`.venv-execution`. On Linux, use `.venv-execution/bin/python`. The probe runs
and diagnostic use the CPU. The commands below use the published `selected`
checkpoint. For a milestone, use the `finetune` folder and checkpoint SHA-256
from the trainer's `snapshot` receipt and choose fresh output paths.

## Run order

1. After the foundation run finishes, use its published `selected` checkpoint.
   If publication is still pending, run the trainer's existing `export` with
   the recorded config hash. The trainer publishes `best.pt`, `settings.json`
   and `manifest.json` in `selected`.

   ```bash
   PY=.venv-execution/Scripts/python
   export PYTHONIOENCODING=utf-8
   export PYTHONDONTWRITEBYTECODE=1
   RUN=artifacts/execution-model-runs/text-b5-2026-11-23
   CORPUS=artifacts/corpora/foundation-v5/corpus-20261123b
   PROBES=artifacts/chat-training/v5/probes
   OUT=artifacts/chat-training/v5/end-of-run-20261125
   mkdir -p "$OUT"
   # Only if publication is still pending, with CONFIG_SHA set from the training receipt:
   # "$PY" packages/execution-pipeline/scripts/train_v5_foundation.py export --config-sha256 "$CONFIG_SHA"
   FINETUNE=selected
   CKPT_SHA=$("$PY" -c 'import json, sys; from pathlib import Path; print(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))["files"]["best.pt"])' "$RUN/$FINETUNE/manifest.json")
   # To publish a milestone, set CONFIG_SHA and POSITIONS from the run:
   # "$PY" packages/execution-pipeline/scripts/train_v5_foundation.py snapshot --config-sha256 "$CONFIG_SHA" --tokens "$POSITIONS"
   # Use the snapshot receipt's finetune and checkpoint_sha256 as FINETUNE and CKPT_SHA.
   ```

2. Prepare, check and generate the frozen greedy outputs using the frozen probe
   commands. Take `CHAT_SHA` and `PROSE_SHA` from the respective prepare receipts
   (`protocol_sha256`).

   ```bash
   CHAT=packages/execution-pipeline/scripts/chat_probes.py
   PROSE=packages/execution-pipeline/scripts/gate3_probes.py
   "$PY" "$CHAT" prepare --run "$RUN" --finetune "$FINETUNE" --checkpoint-sha256 "$CKPT_SHA" --output "$OUT/chat-greedy"
   "$PY" "$PROSE" prepare --run "$RUN" --finetune "$FINETUNE" --checkpoint-sha256 "$CKPT_SHA" --device cpu --output "$OUT/prose-greedy"
   # Set CHAT_SHA and PROSE_SHA from the receipts before continuing.
   "$PY" "$CHAT" check --protocol "$OUT/chat-greedy/protocol.json" --protocol-sha256 "$CHAT_SHA"
   "$PY" "$CHAT" predict --protocol "$OUT/chat-greedy/protocol.json" --protocol-sha256 "$CHAT_SHA"
   "$PY" "$PROSE" check --protocol "$OUT/prose-greedy/protocol.json" --protocol-sha256 "$PROSE_SHA"
   "$PY" "$PROSE" predict --protocol "$OUT/prose-greedy/protocol.json" --protocol-sha256 "$PROSE_SHA"
   ```

3. Measure the greedy predictions. Run the same command for each available
   historical chat or prose predictions file. Set `M100_PREDICTIONS` and
   `M300_PREDICTIONS` to the corresponding saved `predictions.jsonl` paths and
   use a distinct score path for each file.

   ```bash
   EVAL=scripts/v5-eval
   "$PY" "$EVAL/loop_measure.py" score --predictions "$OUT/chat-greedy/predictions.jsonl" --output "$OUT/chat-objective.json"
   "$PY" "$EVAL/loop_measure.py" score --predictions "$OUT/prose-greedy/predictions.jsonl" --output "$OUT/prose-objective.json"
   "$PY" "$EVAL/loop_measure.py" score --predictions "$PROBES/baseline-v4-chat-20261123/predictions.jsonl" --output "$OUT/v4-chat-objective.json"
   "$PY" "$EVAL/loop_measure.py" score --predictions "$M100_PREDICTIONS" --output "$OUT/100m-objective.json"
   "$PY" "$EVAL/loop_measure.py" score --predictions "$M300_PREDICTIONS" --output "$OUT/300m-objective.json"
   ```

4. Run the sampling diagnostic in fresh folders. `--reference` selects the
   reference decoder and takes its own fresh output folder.

   ```bash
   "$PY" "$EVAL/sampling_diagnostic.py" --protocol "$OUT/chat-greedy/protocol.json" --protocol-sha256 "$CHAT_SHA" --output "$OUT/chat-sampling"
   "$PY" "$EVAL/sampling_diagnostic.py" --protocol "$OUT/prose-greedy/protocol.json" --protocol-sha256 "$PROSE_SHA" --output "$OUT/prose-sampling"
   ```

5. Sample the training bins using the tokenizer copied into the foundation run.
   The published training settings supply the corpus and tokenizer hashes.
   Read `training-token-sample.md` and use the JSON for the token and framing
   details.

   ```bash
   "$PY" "$EVAL/training_token_sample.py" --corpus "$CORPUS" --tokenizer-run "$RUN" --training-settings "$RUN/$FINETUNE/settings.json" --output "$OUT/training-token-sample"
   ```

6. Have the reader score the greedy outputs against the frozen criteria and save
   one JSON object per line in `chat-verdicts.jsonl` and `prose-verdicts.jsonl`.
   The existing pre-registration supplies the chat ID groups. The tallies are
   reports for the owner.

   ```bash
   PREREG="$PROBES/gate-b-preregistration-20261123.json"
   "$PY" "$EVAL/gate_tally.py" --predictions "$OUT/chat-greedy/predictions.jsonl" --verdicts "$OUT/chat-verdicts.jsonl" --preregistration "$PREREG" --output "$OUT/chat-tally.json"
   "$PY" "$EVAL/gate_tally.py" --predictions "$OUT/prose-greedy/predictions.jsonl" --verdicts "$OUT/prose-verdicts.jsonl" --preregistration "$PREREG" --output "$OUT/prose-tally.json"
   ```

## Frozen rules

The source is the owner's training plan, `docs/CHAT-MODEL-TRAINING-PLAN.md`
section 8.8, registered on 2026-11-25 at about 15:35 UTC before the final
checkpoint outputs existed. The owner supplied section 8.8 in the task. The
checked-in plan records the earlier baseline, milestones and Gate 3.
[Training plan at c2a0ff7, retrieved 2026-11-25](https://github.com/ahmadalwakai/Mohassan-AI/blob/c2a0ff765071657cf200b5ee7d12fabaad738c0b/docs/CHAT-MODEL-TRAINING-PLAN.md#84-stages-and-gates)

- **EOS.** Count a record when its stop reason is `eos` and its terminal token
  is 258, within 192 generated tokens including EOS.
- **Loops.** Normalize text with Unicode NFKC, lowercase, and split on
  whitespace. Count a loop when any four consecutive words occur at least three
  times. Count every starting position, including overlaps. Count `length`
  stops separately. The score reports the highest count even below the loop
  threshold. If several repeated phrases share the highest count, it reports
  the one that occurs first.
- **Sampling.** Use the pinned probe framing and encoding, CPU float32 and EOS
  stopping. Sample with `do_sample=True`, temperature 0.7, top-p 0.9, top-k 0,
  and 192 new tokens, with seeds 1, 2 and 3 for each probe. Sampling is
  diagnostic only. Sampled records are excluded from all gate counts.
- **Training tokens.** Draw 10 documents per language from the pinned
  `ar.train.bin` and `en.train.bin`, with seed 20261125. From a random token
  offset, find the next EOS (258), then take the document through the following
  EOS, including that terminal token. Skip repeated draws of a document.
  Report the zero-based draw and document offsets, length in tokens, EOS,
  kind, any length over 512 and the framing round-trip for conversations. A
  malformed message frame gets an error and a null first differing position
  when no reference framing can be produced. Include the whole decoded
  conversation or the first 600 characters of decoded prose.
- **Reader verdicts.** Each row contains `id`, `verdict`, `content`, `loop`
  and `reason`. Use `pass` or `fail` for the strict `verdict` and for
  `content`, which sets ending and length aside. Use `yes` or `no` for
  `loop` and give a one-line reason. The Gate 3 rule uses the strict
  verdicts for all 20 frozen prose probes per language and requires at least
  16 passes in each language. Chat core IDs and known-hard IDs are reported
  using the owner's pre-registration.

## Refusals

- `loop_measure.py` refuses malformed or empty prediction input, duplicate IDs
  and an existing output file. Its score binds the exact input and tool bytes
  by SHA-256.
- `sampling_diagnostic.py` refuses a bad protocol hash, unsupported protocol
  type or failed pinned check, and a loaded checkpoint with a prompt hint or
  unexpected EOS, or a prompt that exceeds context with the full output budget.
  It refuses the protocol's own output folder and any other
  existing output folder, including folders with `protocol.json`,
  `predictions.jsonl` or `assessment.json`. It provides no CLI overrides for
  the frozen sampling settings.
- `training_token_sample.py` refuses hashes that disagree with the published
  training settings, invalid corpus or tokenizer inputs, bins with
  insufficient complete documents and an existing output folder.
- `gate_tally.py` refuses missing, duplicate or extra IDs, invalid values,
  incorrect language assignments, inconsistent chat group membership and
  sampled rows. It writes one new tally file and refuses gate receipt and
  assessment destinations.

## Tests

```bash
.venv-execution/Scripts/python -m pytest scripts/v5-eval/tests -q
```

The tests use small fixtures. The checkpoint, frozen probe outputs, tokenizer
assets, corpus and section 8.8 stay on the owner's PC.
