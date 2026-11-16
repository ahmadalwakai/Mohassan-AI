# تعليمات الوكلاء: تدريب نموذج المحادثة (Agent instructions, chat model v4)

Read [CHAT-MODEL-TRAINING-PLAN.md](CHAT-MODEL-TRAINING-PLAN.md) and
`artifacts/chat-training/status.json` before anything else. The plan says what and why; this file
says who does what and under which rules. If the two disagree, stop and ask the owner.

## Rules for every agent

1. **Own model only.** No external AI API calls. No pretrained weights, tokenizers or embeddings.
   Dataset downloads are allowed only for the sources named in the plan, and only human-written
   ones unless the owner changes decision D2.
2. **The holdout is sealed.** Do not open, list, hash-compare or run anything on
   `artifacts/chat-training/conversation-v1/holdout`. Only the Evaluation agent touches it, once,
   at Stage 6, after the owner says so in chat.
3. **No activation.** Do not set `ready_for_chat` or `phoneAdapterActivated` to true, and do not
   change which checkpoint the phone adapter loads. Stage 7 needs the owner's explicit approval.
4. **One GPU job at a time.** The GPU has 4 GB. Before a GPU job, check `nvidia-smi` and
   `artifacts/chat-training/v4/gpu.lock`. Create the lock (agent name, stage, start time) when you
   start and delete it when you finish.
   **Memory guard (clarified 2026-11-16).** The thing to prevent is training spilling out of the
   4 GB into shared system memory, which makes it crawl. That only happens when dedicated memory
   is nearly full. Stop a job only when one of these is true:
   - whole-GPU dedicated memory in use is 3,700 MiB or more **and** the process's shared GPU
     memory is more than 256 MiB above its baseline (baseline taken after CUDA starts, before the
     model loads); or
   - training speed stays more than 30% below its first-minute value for two minutes.
   A small rise in shared memory while dedicated memory is well below 3,700 MiB is normal driver
   bookkeeping on Windows: log it and continue. For reference, the real spill on 2026-11-15 was
   3,959 MiB dedicated with 1,500 MiB shared; the false stop on 2026-11-16 was 1,762 MiB dedicated
   with a 4 MiB rise. When a real stop happens, lower the batch and use accumulation; do not let
   the job run slowly.
5. **Stay in your folders.** The working tree holds uncommitted work from other agents. Touch only
   the paths listed for your role. Do not commit, push, stash, reset or reformat anything.
6. **Never overwrite.** New work goes in new folders. Every dataset, corpus, prediction file and
   checkpoint gets a `manifest.json` with SHA-256, row or token counts, and the code hashes used.
7. **Gates are hard stops.** When a gate fails, write the report and stop. Do not retry with
   changed settings to get past it, and do not start the next stage.
8. **Report plainly.** Every count has its denominator, per language. Say development when it is
   development; only the holdout is independent. Report failures and unfinished generations.
   State what you did not verify.
9. **Ask the owner** when a change to the approved decisions D1 to D4 is needed, a licence is unclear, a gate fails, or the
   plan does not cover your case. Do not decide these yourself.
10. **Environment.** Windows, `.venv-execution/Scripts/python`, set `PYTHONIOENCODING=utf-8`.
    Existing entry points are in `packages/execution-pipeline/scripts/` (`pretrain_text.py`,
    `adapt_language.py`, `chat_model.py`, `lexicon.py`). Extend them; do not fork copies. Run the
    package tests after any code change and report the counts.

When you finish a stage, update only your own block under `v4` in
`artifacts/chat-training/status.json` and write `artifacts/chat-training/v4/<stage>/report.md`:
what was run, the numbers, the gate result, what is unverified, and what the next agent needs.

## Role A. Data agent (CPU only)

Stages 1 and the dataset part of 5. Writes only under `artifacts/corpora/foundation-v2/`,
`artifacts/corpora/conversational-v1/` and `artifacts/chat-training/v4/dataset/`.

**Stage 1, foundation corpus v2**

- Build the three parts in the plan's table with the pinned tokenizer
  (`artifacts/execution-model-runs/text-b3-ar-2026-11-15/tokenizer.json`; check its SHA-256 against
  `arabic-foundation-v1/manifest.json`). Same file layout and `uint16` format as
  `arabic-foundation-v1`.
- Clean: strip markup, tables, reference lists and boilerplate; drop documents under 200
  characters; deduplicate exact and near-exact documents; one EOS after each document.
- Subtitles: join lines into exchanges, drop timing and sound descriptions, drop lines that are
  mostly names or symbols.
- Split validation by document, 1% per language. Copy nothing from the old validation files into
  training; they remain the fixed reference.
- Record per file: source URL, licence, attribution, date, counts.
- Done: Gate 1 in the plan. Report measured token counts; if a part falls short of its target, say
  by how much and what else could fill it.

**Stage 5, dialogue dataset v4**

- At least 20,000 rows per language inside scope v1 (plan section 3), in the row schema of
  `conversation-v3/dataset/train.jsonl`, with `source` set truthfully per row.
- Write natural user messages: varied length, typos, dialects (Gulf, Egyptian, Levantine and
  Modern Standard), mixed digits, English words inside Arabic. At least 25% multi-turn, including
  corrections ("no, I meant...") and references to earlier turns.
- Out-of-scope requests (translation, long writing, facts, code) get a short honest limit reply,
  about 10% of rows.
- Templates: no slot value or carrier sentence may appear in more than 0.5% of rows. Group rows
  from one template or one source conversation so they never straddle train and validation.
- Quality check: an independent read of 200 random rows per language per source; a source with
  more than 3% wrong or unnatural rows is fixed or dropped before use.
- **Do not read** `artifacts/chat-training/v4/development-v4/`, the old 108 development cases or
  the holdout. Your data must not be written to match them.

## Role B. Training agent (the only GPU user)

Stages 0.1, 0.3, 2, 3, 4 and the training part of 5. Writes only under
`artifacts/execution-model-runs/text-b4-<date>/` and `artifacts/chat-training/v4/<stage>/`.
Code changes only in `packages/execution-pipeline/`.

- **0.1** Follow the plan. Deliver the loss curves as data files plus a one-page cause analysis.
  State the cause only if an experiment shows it; otherwise list what was ruled out.
- **0.3** Benchmark the three shapes. Report tokens/s and peak dedicated memory for each.
- **2** Fresh random initialisation, fixed seed, corpus v2. Evaluate on the fixed reference
  validation files at 32M, 100M and 300M tokens. Apply the plan's decision rules exactly and write
  the projected Stage 3 duration.
- **3** The long run. It must be resumable: checkpoint every 50M tokens, resume test done before
  the real run starts (kill at a checkpoint, resume, confirm the loss continues). Ask the owner to
  keep the laptop on power and awake. Log tokens/s; if speed drops by more than 30%, check for
  shared-memory use or thermal throttling and report it.
- **4** Continue on the conversational part in the inference prompt format. Do not change the
  prompt format without the Evaluation agent and the phone adapter (`chat.py`) changing together.
- **5** Use only the configuration that passed Gate 0. Select by validation loss. Hand the
  Evaluation agent exactly one checkpoint, named by SHA-256.
- You do not judge replies. Generation for evaluation is run by you (greedy decoding, fixed
  maximum length, a manifest with the checkpoint and input hashes); the judging is Role C.
- **Do not read** `development-v4` case texts beyond what generation needs, and never tune
  settings on the holdout.

## Role C. Evaluation agent

Stages 0.2, the probes in 3, the judging in 5, and Stage 6. Writes only under
`artifacts/chat-training/v4/development-v4/`, `v4/probes/` and `v4/reviews/`.

- **0.2** Write `scope-v1.md` (what counts as a correct reply per category, in both languages) and
  the 200 `development-v4` cases with a written pass criterion for each. Freeze both with SHA-256
  before any Stage 2 training starts. Write 20 continuation prompts per language for Gate 3.
- Write cases yourself. **Do not read** the Stage 5 training rows or the Data agent's templates.
- **Judging.** Judge meaning against the written criterion, each language by a reader fluent in
  it. A reply passes only if it is correct, in the user's language, complete and finished. One
  verdict per case with a one-line reason. No partial credit. Judge blind to which checkpoint
  produced the reply when more than one is compared.
- **Stage 6.** Only after Gate 5 and the owner's go-ahead in chat. One checkpoint, one run. The
  result stands as it is; no re-runs, no changes to criteria afterwards. After this the holdout is
  spent and must be labelled so.
- Write `readiness.json` in the existing format. `ready_for_chat` stays false unless plan
  section 6 is met; even then activation waits for the owner.

## Role D. Integration agent (waits for Stage 7)

Nothing to do until the owner approves activation. Then: pin the approved checkpoint by SHA-256 in
the phone adapter, run the adapter and Wasla service tests, and verify the real phone flow in
Arabic and English. Report what was verified on the device and what was only tested in software.

## Order of work

1. Now, in parallel: Role A Stage 1, Role B Stage 0.1 and 0.3, Role C Stage 0.2.
2. After Gates 0 and 1: Role B Stage 2, then 3, then 4. Role A writes dataset v4 meanwhile.
3. After Gate 4: Role B Stage 5, Role C judges.
4. After Gate 5: owner decides on Stage 6, then Stage 7.
