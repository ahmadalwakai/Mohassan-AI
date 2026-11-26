# خطة تدريب نموذج المحادثة (Chat model training plan, v4)

Written 2026-11-15. Status: **plan approved by the owner 2026-11-15 (D1 to D4 as in section 2);
nothing has been run yet.** Agents follow
[CHAT-MODEL-AGENT-INSTRUCTIONS.md](CHAT-MODEL-AGENT-INSTRUCTIONS.md).

**ملخص للمالك:** النموذج الحالي (38 مليون معامل، 32 مليون رمز تدريب لغوي) نجح في 9 من 108.
السبب نقص البيانات اللغوية بنحو 30 ضعفًا، ومشكلة غير مفسَّرة في تدريب الحوار. الخطة: تشخيص
المشكلة أولًا، ثم تدريب لغوي على نحو مليار رمز (يوم إلى يومين على كرت الشاشة الحالي)، ثم
تدريب حوار ضمن نطاق محدد، ثم اختبار مستقل مرة واحدة قبل أي تفعيل على الهاتف. اعتمد المالك
القرارات الأربعة في القسم 2 بتاريخ 2026-11-15.

## 1. Where we are (measured)

| Fact | Value | Source |
| --- | --- | --- |
| Model | 38,281,728 parameters, scratch-built, vocabulary 24,576 | `artifacts/chat-training/status.json` |
| Language pretraining | 32.0M tokens (24M Arabic, 8M English) in 41.1 min | same, `v3.foundationCompleted` |
| Measured speed | about 13,000 tokens/s on this GPU | derived from the row above |
| GPU | RTX 3050 Ti Laptop, 4 GB | `nvidia-smi` |
| Memory limit | SFT at batch 4 spilled into shared memory (3,959 MiB dedicated) | `v3.batch4MemoryEvidence` |
| Tokenizer | Arabic 1.9 tokens/word, English 1.6 | `artifacts/corpora/arabic-foundation-v1/manifest.json` |
| Best chat result | 9/108 development (Arabic 1/54, English 8/54) | `conversation-v3-dialogue-focus/development-last-assessment.json` |
| Earlier rounds | v1 6/84, v2b 7/84 | `status.json` |
| Independent holdout | 60 cases, never used | `conversation-v1/holdout` |

Two findings drive this plan:

1. **The language foundation is about 30 times too small.** A common rule is roughly 20 training
   tokens per parameter, so about 760M tokens for this size. It saw 32M. Raw continuations still
   repeated or drifted (`rawIntermediateLanguageProbe`). No dialogue fine-tuning can fix that.
2. **Dialogue fine-tuning never beat its own starting point.** In both v3 runs the best validation
   loss was at step 0 (broad: 6,000 steps; focus: 3.98 at step 0, 5.67 at step 3,000). The cause is
   not established. It may be the small batch (2) with learning rate 1e-4, a mismatch between
   training and validation sources, or a measurement difference at step 0. Until it is explained,
   more fine-tuning is wasted GPU time.

## 2. Owner decisions (approved by the owner 2026-11-15)

| # | Decision | Approved |
| --- | --- | --- |
| D1 | GPU time on the laptop for one full run | up to 72 hours, resumable, laptop kept awake and on power |
| D2 | Use public datasets that were machine-generated (for example TinyStories-style) | **No.** Human-written public data, templates and agent-authored rows only. **Changed 2026-11-23: Yes**, as downloaded files only (section 8) |
| D3 | Rent a cloud GPU (compute only, own code and weights) | **No.** Only raise it if Gate 3 fails. **Raised 2026-11-23 after Gate 3 failed: no paid GPU; the free Kaggle tier only** (section 8) |
| D4 | Pass marks for phone activation (section 6) | as written in section 6 |

Fixed rules, not open for agents to change: no external AI APIs, no pretrained weights, tokenizers
or embeddings from anyone else, no phone activation without the owner's explicit approval.

## 3. Target and honest expectation

Target: **Mohassan chat scope v1**, short replies (one to four sentences) in Arabic and English for:
greeting, identity, limits and uncertainty, clarifying questions, in-conversation memory, copying
exact text, accepting a correction, simple explanations of everyday concepts, short writing and
short summaries of text given in the message.

Out of scope for v1: translation, long writing, multi-step planning, factual questions that need
world knowledge, code. In-scope replies to these are a polite limit statement, and they are tested
as such.

Expectation: on this hardware the realistic outcome is a narrow, reliable assistant voice, not
general chat. If the gates below fail, the plan stops and reports; it does not loop on more
fine-tuning rounds.

## 4. Stages and gates

Each stage has one owner agent, a written output and a gate. A failed gate stops the plan and goes
to the owner. Time estimates use the measured 13,000 tokens/s and are estimates until Stage 0.3.

### Stage 0. Diagnose and freeze (GPU under 2 hours)

- **0.1 Explain the fine-tuning failure.** On the existing v3 data: plot training loss against
  validation loss, split validation loss by source, confirm step-0 loss is computed the same way as
  later steps, and sweep learning rate {2e-5, 5e-5, 1e-4} at an effective batch of 16 or more using
  gradient accumulation.
  **Gate 0:** a written cause, plus one configuration whose validation answer loss stays below its
  step-0 value for at least 1,000 steps. If no configuration does, report that and stop.
- **0.2 Freeze scope and evaluation.** Write the scope rules and per-category pass criteria. Build
  `development-v4`: 200 new cases (100 per language) inside scope v1, including out-of-scope
  requests whose correct reply is a limit statement. The 108 old cases stay as a regression set.
  The 60-case holdout stays sealed.
- **0.3 Benchmark sizes.** Ten minutes each for the current 38M shape and two larger shapes (about
  60M and 85M) at context 512: tokens/s and peak dedicated memory. No shared-memory use allowed.

### Stage 1. Foundation corpus v2 (CPU only, runs in parallel with Stage 0)

Target about **1.0 to 1.2 billion tokens** with the current tokenizer (kept and pinned):

| Part | Target tokens | Candidate sources |
| --- | --- | --- |
| Arabic prose | about 450M | full Arabic Wikipedia, Arabic pages already in `commoncrawl-2026-43` |
| English prose | about 400M | `simplewiki-20261101`, an English Wikipedia subset, Common Crawl |
| Conversational register | about 150M or more | OpenSubtitles (Arabic, English), `openassistant-chat`, `aya-chat`, Tatoeba |

Rules: record source, licence and attribution per file; deduplicate documents; split validation by
document; keep the old validation files from `arabic-foundation-v1` as a fixed reference so new
runs compare with the 32M run; SHA-256 manifest. Volumes are targets to measure, not promises.

**Gate 1:** manifest with measured token counts per language and register, a licence table, and a
100-sample quality read per source (share of clean, natural text reported with its denominator).

### Stage 2. Learning-curve pilot (GPU about 10 hours)

- Train the 38M shape from fresh random initialisation on corpus v2; evaluate at 32M, 100M and 300M
  tokens on the fixed reference validation files.
- Train the best larger shape from 0.3 to 100M tokens.

Decision rules:

- Continue to Stage 3 only if validation loss at 300M tokens is clearly lower than at 100M and lower
  than the old 32M run (Arabic 3.26, English 3.20).
- Choose the larger shape only if at 100M tokens its loss is lower by at least 0.15 **and** its
  projected full run fits D1. Otherwise keep 38M.

**Gate 2:** the curve, the chosen shape, and a projected duration for Stage 3.

### Stage 3. Full foundation run (GPU about 21 to 32 hours at 38M; more for a larger shape)

- 1.0 to 1.5 billion tokens, a checkpoint every 50M tokens, resumable after sleep or reboot,
  context 512, mixed precision, language-balanced batches.
- Stop early if validation loss is flat for 150M tokens.

**Gate 3:** validation loss below the pilot's 300M value in both languages, and a continuation
probe: 20 fixed prompts per language, judged by the evaluation agent; at least 16 of 20 per language
stay on topic without repetition loops. If Gate 3 fails, stop; the owner reconsiders D2 and D3.

### Stage 4. Conversational adaptation (GPU about 3 to 4 hours)

Continue next-token training on the conversational part, rendered in the exact chat prompt format
used at inference, about 150M tokens, loss on all tokens. Purpose: learn turn-taking and the format
before any answer-only fine-tuning.

**Gate 4:** answer loss on the Stage 5 validation set is lower after this stage than before it.

### Stage 5. In-scope dialogue fine-tuning (GPU under 4 hours)

- Dataset v4: at least 20,000 rows per language inside scope v1. Sources: agent-authored dialogues,
  systematic templates with wide lexical variety, and filtered human rows from OpenAssistant and
  Aya. At least 25% multi-turn. Arabic rows mix Modern Standard and dialects.
- Every source is quality-checked on a sample before use (v2 was quarantined for label errors).
- Use the configuration that passed Gate 0. Answer-only loss. Stop when validation loss has not
  improved for six evaluations.
- Pick the checkpoint by validation loss and confirm it on `development-v4`. The final-step
  checkpoint is not used when validation loss has risen.

**Gate 5:** `development-v4` at least 120/200 with each language at least 55/100, and no category
at zero.

### Stage 6. Independent test (once)

Only after Gate 5 and the owner's go-ahead: run the single chosen checkpoint on the sealed 60-case
holdout, greedy decoding, one run, no retries and no changes afterwards.

### Stage 7. Phone activation

Only after section 6 is met and the owner approves: pin the checkpoint by SHA-256, activate the
existing phone adapter, and verify the real phone flow end to end.

## 5. Schedule (estimates)

| Stage | GPU time | Depends on |
| --- | --- | --- |
| 0 Diagnose and freeze | under 2 h | nothing |
| 1 Corpus v2 | none (CPU, downloads) | nothing |
| 2 Pilot | about 10 h | 0.3, 1 |
| 3 Foundation | 21 to 32 h (38M) | 2 |
| 4 Adaptation | 3 to 4 h | 3 |
| 5 Fine-tuning | under 4 h | 0.1, 0.2, 4 |
| 6 and 7 | minutes | 5, owner |

About two to three days of GPU time in total at the current size. One job on the GPU at a time.

## 6. Activation pass marks (D4)

- Holdout: at least 42/60 overall and at least 20/30 in each language.
- No reply that invents an identity, claims an action it did not take, or answers an out-of-scope
  request with made-up facts.
- Results reported with denominators, per language and per category.

## 7. When to stop

- Gate 0 fails: fine-tuning is not understood; stop before spending GPU days.
- Gate 2 shows no gain from more data: the size or the corpus is the limit; report, do not run
  Stage 3.
- Gate 3 or Gate 5 fails: report the numbers and the three remaining options to the owner: narrow
  the scope further, allow D2, or allow D3. No further fine-tuning rounds on the same foundation.

## 8. Version 5 (2026-11-23): a conversation-first foundation

**ملخص للمالك:** فشل v4 لأن 99.6% مما تعلّمه كان ويكيبيديا (3.7 مليون رمز محادثة فقط). في v5 يصبح
نصف ما يتعلّمه على الأقل محادثات، من بيانات مولَّدة سمحتَ بها، على نموذج أكبر (85 مليون معامل)
يتسع لكرتك. التوقع الواقعي: ردود قصيرة سليمة في نطاق v1، لا مساعد عام.

### 8.1 What failed in v4 (measured)

Stage 3 trained 38M parameters on 1B positions. The training text was 99.6% prose (Wikipedia and
SimpleWiki); human dialogue was 3.7M tokens (ar 0.71M, en 3.0M). The loss gate passed, and Gate 3
failed at 0/20 per language: all 40 continuations looped, none ended with EOS
(`artifacts/chat-training/v4/autopilot/STOPPED.json`).

### 8.2 Owner decisions (in chat, 2026-11-23)

- D2: yes. Public machine-generated conversation datasets, downloaded as files. Still no external
  AI API calls and no pretrained weights, tokenizers or embeddings.
- D3: no paid cloud GPU. The free Kaggle tier is allowed if a larger run is needed later; it needs
  the owner's own Kaggle account.
- Downloads approved, all Apache-2.0 on their dataset cards, into
  `artifacts/corpora/conversational-d2-20261123/`:

| Source | Part | Rows | Parquet |
| --- | --- | --- | --- |
| `AdaMLLab/smolkalam-arabic-conversational-sft` (Arabic translation of SmolTalk2) | 8 conversational `no_think` subsets: everyday conversations, system chats, magpie-ultra, rewrite, summarize, explore-instruct rewriting, Tulu personas, OpenHermes 2.5 | 1,037,684 | 2.46 GB |
| `HuggingFaceTB/smol-smoltalk` (English, built for models under 1B) | all | 484,570 | 0.97 GB |
| `arbml/CIDAR` (Arabic) | all | 10,000 | 3.6 MB |

Not audited: the terms of the models that originally generated or translated these rows.

### 8.3 Design

- **Corpus `artifacts/corpora/foundation-v5/`:** per language, at least half the tokens are
  conversations rendered exactly as at inference (`conversation_prompt(messages)` + reply + EOS,
  one document per assistant turn, prompt and reply within 512 tokens). The rest is the existing
  Wikipedia prose. Excluded: reasoning traces, tool calls, code-heavy and long-context subsets.
  Validation is split by conversation, 1% per language. Same pinned tokenizer and `uint16` layout.
- **Model:** the 85M shape, fresh weights. Measured at 100M positions it beat 38M by 0.11 (ar) and
  0.13 (en) in loss, below v4's 0.15 rule; v5 takes it anyway because v4 failed on coherence at
  38M. Measured speed 5,833 positions/s, so 1.0B positions is about 48 hours, inside D1.
- **Trainer:** the existing `language_adaptation.adapt()` pilot path (balanced languages, fresh
  initialization, checkpoints, resume, plateau stop) and the `GpuJob` guard. A new stage script
  calls it; no trainer copy.

### 8.4 Stages and gates

- **V5-1 Data (CPU).** Build the corpus. **Gate A:** measured tokens per language and source,
  conversation share at least 50% per language, and an independent read of 200 random rows per
  source and language with at most 3% wrong or unnatural. A source over 3% is dropped or fixed.
  No reading of `development-v4` or the holdout.
- **Gate A result (2026-11-23): failed.** Independent reads of 200 rows per source
  (`artifacts/chat-training/v5/gate-a-20261123/assessment.json`): SmolKalam Arabic 107/200 wrong or
  unnatural (53.5%), CIDAR Arabic 111/200 (55.5%), smol-smoltalk English 45/200 (22.5%); the limit
  is 3%. No subset with a real sample passes (best: English smol-magpie-ultra-short 26/158, 16%).
  Main faults: tasks broken by machine translation, grammar and wrong terms, maths errors, persona
  and web-search claims left from removed system prompts. SmolKalam's own scores do not predict the
  verdicts (its top 10% by `rank_score` is still 11/20 bad). No GPU time was spent; the owner decides.
- **Owner decision (in chat, 2026-11-23, «تجربة محدودة»):** use this data for the foundation stage
  only, as a bounded experiment; the V5-3 fine-tuning data must pass the 3% limit on its own read;
  Gate B stops the run early as pre-registered. Receipt:
  `artifacts/chat-training/v5/gate-a-20261123/owner-override.json`, bound to the corpus
  `artifacts/corpora/foundation-v5/corpus-20261123b` (conversation 51.0% ar, 50.9% en; its quality
  samples are byte-identical to the judged ones). Known risk accepted: broken Arabic from translated rows.
- **V5-2 Foundation (GPU, about 48 h).** Resume test first. 1.0B positions, checkpoint and
  evaluation every 100M (one full 85M checkpoint is about 1 GB and the disk had 31 GB free on
  2026-11-23), plateau stop after two evaluations without a better validation loss.
- **Gate B (pre-registered before any v5 checkpoint, after the owner's review on 2026-11-23):**
  `artifacts/chat-training/v5/probes/gate-b-preregistration-20261123.json`
  (SHA-256 `5f12aed84db7ae27d33ccefffa804d709bb9fadfa83e0d5fcb6c887c3e46150b`).
  - Known-hard probes are reported apart and are in no stop rule before V5-3: the name
    (`chat-ar-03`, `chat-en-03`) and the out-of-scope refusals (`chat-ar-20` translation,
    `chat-en-20` code). The downloaded data never names the assistant and does translate and code.
  - The name spelling is not tested: `chat-ar-03` is also judged spelling-tolerant (محسن or موحسن).
  - At 100M positions, objective: stop if 4 or fewer of 20 chat replies end with EOS in either
    language (v4 ended 0 of 40). The 18 core chat probes and 20 prose probes per language are
    judged and reported.
  - At 300M positions: stop if core chat passes are 3 or fewer of 18 in either language.
  - Every probe generation, during and after training: CPU, float32, greedy, 192 new tokens,
    512 context, the same pinned code, so the numbers compare. Baseline: v4's own 38M candidate
    on the same probes.
  - **Baseline measured 2026-11-23** (`artifacts/chat-training/v5/probes/baseline-v4-chat-20261123`):
    replies ending with EOS ar 5/20, en 2/20; a four-word phrase repeated three or more times in
    ar 15/20, en 18/20; 40 probes in 7.2 minutes. Measured inside the process: 1.1 GB peak working
    set (2.0 GB private) for the 38M model; a random-weight 85M model took 46 s and 1.2 GB (2.1 GB
    private) for 192 new tokens on 4 CPU threads, so one Gate B snapshot needs up to about an hour of
    CPU next to the training.
- **Gate 3 (unchanged criteria)** on the selected checkpoint: at least 16 of 20 per language on
  topic, no repetition loop, finished with EOS.
- **V5-3 Chat fine-tuning.** Answer-only fine-tuning on in-scope rows, then Gate 5 as in Stage 5.
  Prepared on 2026-11-23 while the foundation trains:
  - Data: v4's in-house set `artifacts/chat-training/v4/dataset/stage5-candidate-20261118-v5`
    (26,400 training rows per language, 30% multi-turn, 10% limit replies, the name «موحسن»), already
    eligible through `stage5-handoff-20261118/eligibility.json` with independent reads of 200/200 per
    language, so it meets the 3% limit the owner kept for this stage.
  - Runner: `packages/execution-pipeline/execution_pipeline/v5_finetune.py` with
    `scripts/v5_finetune.py` (prepare, check, run, smoke). It reuses Stage 5's trainer, Gate 0
    parameters, data and QA validators; the base must be the exact checkpoint that passed Gate 3
    (v5 has no Stage 4); it holds both GPU locks; runtime ceiling 8 hours for 85M. Tests:
    `tests/test_v5_finetune.py`, 7 cases.
  - Gate 5: replies on the CPU with `scripts/chat_model.py predict --device cpu --max-tokens 192` over
    `development-v4` (200 cases), an independent reader writes `{id, verdict: pass|fail, reason}`,
    then `artifacts/chat-training/v5/gate5/tally.py` applies the marks (at least 120/200, 55/100 per
    language, no category at zero) and refuses a pass on an unfinished reply.
  - Still to do: a CPU smoke run of two updates on the 100M snapshot after Gate B; `prepare` only
    after Gate 3 passes, because it pins that checkpoint.
- **Stages 6 and 7** unchanged: holdout once and activation only with the owner's approval.
- **Serving speed (prepared 2026-11-23, for Stage 7 only).** The reference decoder
  (`execution_model/generation.py`) recomputes the whole sequence for every token: 46 to 73 seconds
  for a 192-token reply from the 85M shape on 4 CPU threads. A new module,
  `execution_model/cached_generation.py`, keeps each block's rotated keys and values and runs only the
  new token through the model's own layers. Pinned files were not edited, so the running v5 job can
  still resume. Measured: v4's 38M weights on 8 chat probes, 8/8 identical token sequences, 105.7 s
  to 17.1 s (6.2×); the 85M shape, identical 192 tokens, 73.1 s to 6.3 s (11.5×, 30 tokens/s).
  Tests: `tests/test_cached_generation.py` (same tokens, per-step logits within 1e-4 of a full
  recompute, same EOS stop, same context refusal). Every gate evaluation keeps the reference decoder,
  as pre-registered; the cached path is for serving after activation.

### 8.5 Premortem

| Failure | Prevention (requirement) | Check (acceptance) |
| --- | --- | --- |
| The Arabic rows are machine-translated and read unnaturally, so the model learns broken Arabic | Independent quality read per source; drop sources over 3%; keep the human Aya rows | Gate A report with denominators before any GPU time |
| The model still loops or drifts as v4 did | Conversation-first corpus and the larger shape; semantic check early, not only loss | Gate B at 100M positions decides whether the remaining ~40 GPU hours run |
| The 48-hour run dies (sleep, heat, memory spill, a full disk) or another job takes the GPU | Resume test before the real run; checkpoint every 100M (about 10 GB in all); `GpuJob` lock, `.data/gpu.lock` and Rule 4 guard; laptop on power and awake | Resume receipt; tokens/s logged; lock files present while running; free disk checked before start |

### 8.6 Gate B result (2026-11-23, 100M positions)

- Stop rule (objective): **passed**. Chat replies ending with EOS: Arabic 10/20, English 10/20 (stop at 4 or fewer; v4 was 5/20 and
  2/20). The run continues. Validation loss at 100M: Arabic 2.885, English 3.162.
- Independent reader (reported only): core chat 0/18 Arabic, 0/18 English; prose 0/20 and 0/20; the four known-hard probes fail.
  The finished replies are in the right language and conversational form but do not answer what was asked; most others loop.
- Incident: the speed guard stopped the run at 101.07M because the CPU probe jobs ran beside it; resumed from 100M at 23:30 UTC.
  Rule for the next gates: pause training, run the probes alone, resume.
- Next stop rule at 300M: core chat passes 3 or fewer of 18 in either language stop the run.
- Report: `artifacts/chat-training/v5/probes/gate-b-report-20261123.md`.

### 8.7 300M result (2026-11-24): the run stops

- Stop rule: **stop**. Core chat passes by the blind independent reader: Arabic 0/18, English 0/18 (stop at 3 or fewer).
  Prose 0/20 and 0/20; the four known-hard probes fail. Chat replies ending with EOS: 11/20 and 11/20 (10/20 and 10/20 at 100M).
- Validation loss still falls (Arabic 2.885 → 2.700 → 2.612, English 3.162 → 2.973 → 2.879 at 100M, 200M and 300M), but the
  outputs do not answer: 55 of 80 hit the length limit in loops, and the 25 that finish invent identities or drift off topic.
- The run stays paused at 300,008,192 positions with its STOP file; all checkpoints are kept. V5-3 needs a checkpoint that
  passed Gate 3, so it does not start. The next step is the owner's decision.
- Incident: a Dell SupportAssist disk snapshot stalled the GPU memory guard at 285.07M (07:56 UTC); about 85M positions were
  redone from 200M. The Dell service was paused at the owner's word and restored after the stop.
- Report: `artifacts/chat-training/v5/probes/gate-300m-report-20261124.md`.
- **Owner override (12:47 UTC):** «اكمل التدريب». The run resumed from 300M toward 1B with the same config and code
  (`artifacts/chat-training/v5/probes/gate-300m-owner-override-20261124.json`). The final Gate 3 and the V5-3 condition are
  unchanged.

### 8.8 End of the run (owner decisions, 2026-11-25)

The owner made these decisions on 2026-11-25 at about 15:30 UTC, in session 0ac0a23a. That session's shared note
`v5-gate3-review-2026-11-25.md` holds the draft review for item 4. The scoring definitions and diagnostic settings below were
registered at about 15:35 UTC, before any output existed from the 800M checkpoint or any later one.

- **No test during the run.** A chat test needs the training paused. The 800M checkpoint is therefore tested after the run
  ends, together with the selected checkpoint.
- **When the run ends.** At 15:26 UTC the run had 834.9M positions at about 5,700 positions/s, so it should end at about
  23:30 UTC. The best checkpoint so far is 800M (weighted validation loss 2.464). The run has ended when `status.json` reads
  `completed` or `early_stopped`. The supervisor stops by itself in either state.

Steps at the end, in order:

1. **Restore and export.**
   - **Owner change (2026-11-25, about 22:20 UTC):** «تأجيل خدمة dell و مهمة اللقطة في ويندوز الأولوية اجراء الفحوصات».
     - The tests come first. The restore below waits until the tests of steps 3 to 5 are done, or until the owner
       says so, so that no disk snapshot stalls them.
     - The export and the 800M snapshot still run first.
   - Restore the two snapshot sources that were paused for the run, from an elevated shell:
     - `sc.exe config "Dell SupportAssist Remediation" start= delayed-auto`
     - `Start-Service 'Dell SupportAssist Remediation'`
     - `Enable-ScheduledTask -TaskPath '\Microsoft\Windows\Setup\' -TaskName PITRTask`
   - Run `train_v5_foundation.py export --config-sha256 01cd6507…eb1b`. This publishes the best checkpoint as `selected` and
     writes the assessment receipt (`gate3_passed: null`).
   - If 800M is not the selected checkpoint, also take a `snapshot` at 800M.
2. **Freeze the rule before any result (item 4).**
   - Before any final probe output is opened, record the owner's choice among the review's options A, B and C, with its time
     and SHA-256, in `artifacts/chat-training/v5/probes/gate3-condition-decision-20261125.json`.
   - With no recorded choice, option A is the rule. Option A is this plan as written.
   - A change made after the outputs are opened is recorded as a post-hoc owner override, as at 300M, and never as a Gate 3
     pass.
   - **Recorded: option B** (file written 2026-11-25 21:24:49 UTC, SHA-256 `01ab3856a1a41afc115bebcf86ec51a3045887f2be49f0f6ab85881d96431728`).
     - The owner delegated the choice at about 21:15 UTC: «عند الانتهاء انت اختر المناسب بدون الرجوع لي».
     - Session 0ac0a23a (local_b0c71abe) chose B at 21:21 UTC. No output from 900M or any later checkpoint existed then,
       or when the choice was recorded.
     - **V5-3 condition under B.** It uses the Gate 3 prose probes from the official greedy run on `selected`. An item
       passes when the reader marks `content` pass and `loop` no. The condition needs at least 16 of 20 such items per
       language.
     - **Reported beside the condition:** EOS, length-limit stops and the objective loop measure. They are not part of the
       condition, and Gate 5 enforces finishing.
     - **The official original Gate 3 result** (option A: strict verdicts, 16 of 20) is still computed and reported beside it.
   - **Addendum 1, after the owner's review** (`gate3-condition-decision-20261125-addendum-1.json`, written 21:40:42 UTC,
     SHA-256 `6fb5c617dae6ba5829a7b8ba7a37cefeab7b598fad9bb344185a5aed525e9c73`). It changes neither B nor A.
     - **Timing.** B was fixed after the 100M and 300M probe results were known, and before any probe output from a
       later checkpoint.
     - **Which checkpoint is `selected`.** It is the milestone checkpoint (100M, 200M, …, 1B) with the lowest
       weighted validation loss, 0.5 × Arabic + 0.5 × English. A tie keeps the earlier milestone.
       - The pinned trainer applies this rule during the run, before any probe.
       - So `selected` is 1B if its loss is below 2.4355; otherwise it is 900M.
       - Probe results never change the choice.
     - **Wording when B passes and A fails:** «passed the modified transition criterion (B), failed the original
       criterion (A)».
     - **What a B pass means.** It is not a measure of factual correctness, language soundness or coherence. It is
       never reported as a general quality percentage. The EOS and length-limit counts are always shown.
     - **The sampling diagnostic.** The three seeds are samples of one question, not three questions. There is no
       best-of-seeds count.
     - **A hand count of B** keeps each item's verdicts and the reader's reason.
     - **The framing check** compares the token ids stored in the pinned bins on disk with the ids the chat probes
       feed.
3. **Decode a sample of the training tokens (item 3).** This step does not depend on the model, so it runs before the
   probes.
   - Take 10 documents per language from the pinned `ar.train.bin` and `en.train.bin` of `corpus-20261123b`. Draw them with
     seed 20261125, cut them at EOS boundaries (id 258), and decode them with the pinned tokenizer.
   - For each document, record its kind (conversation or prose), its length in tokens, and whether it ends with 258.
   - For each conversation document, record whether re-framing its messages with `execution_pipeline.chat.conversation_prompt`
     reproduces its tokens exactly. The chat probes use this same framing.
   - Report any mismatch to the owner before the probe results are read, because it changes what the probes measure.
4. **Run the original tests, unchanged (item 1).**
   - The tests are the frozen chat probes (20 per language, 18 core) and the Gate 3 prose probes (20 per language). Run them
     with `chat_probes.py` and `gate3_probes.py` unchanged, on `selected` and, as a reported point, on 800M.
   - Run settings: CPU, float32, greedy decoding, 192 new tokens, the reference decoder and the pinned code.
   - Score three parts separately and report each per language:
     - **EOS (objective):** `stop_reason` is `eos` and `terminal_token_id` is 258, within 192 tokens.
     - **Loop (objective):** after NFKC normalization and lowercasing, some run of four whitespace-separated words occurs
       three or more times, counted at every word position. Also report the outputs that hit the 192-token limit. The same
       code recomputes the v4 baseline, 100M and 300M, so every point is measured the same way.
     - **Content (blind reader):** the same packet builder, instructions and frozen criteria as at 300M, with no checkpoint
       information. The reader first gives the strict verdict as before. Two fields are then asked after it:
       - `content`: pass or fail on the criterion, setting the ending and the length aside;
       - `loop`: yes or no, as the reader sees it.
   - The official Gate 3 result is computed exactly as before: the strict verdicts on the prose probes, at least 16 of 20
     per language. The separate parts are reported beside it and change no verdict.
5. **Run a diagnostic with sampling (item 2).** It is reported in its own file and never counts toward Gate 3 or any stop
   rule. No setting is tuned after its results.
   - It uses the same 80 probes and framing, the CPU, float32 and 192 new tokens, on `selected` only.
   - It samples with the pinned generator's own options: `do_sample=True`, `temperature=0.7`, `top_p=0.9`, `top_k=0`. Seeds
     1, 2 and 3 run per probe, for 240 outputs.
   - The cached decoder may be used, because this is not a gate evaluation and it chooses tokens with the same `_choose`.
   - EOS and loops are counted on all 240 outputs. The blind reader judges content on seed 1 only, 80 items in their own
     packet.
6. **Review the Gate 3 → V5-3 condition (item 4).**
   - The draft review becomes `artifacts/chat-training/v5/probes/gate3-condition-review-20261125.md`, with the results
     attached. Its points are that Gate 3 is the prose-continuation probe, that its EOS part may belong in Gate 5, and the
     options A, B and C.
   - The original Gate 3 result is kept as measured, whatever is chosen.
   - V5-3 starts only on the owner's decision, from the exact checkpoint named by the rule in force.
7. **Report.** Write `gate-1b-report-<date>.md` in the 300M report's format, and send a short Arabic summary to the owner.

**Still to build before the end.** The probe scripts hard-wire greedy decoding: `DECODING` in `chat_probes.py`, and
`GenerationConfig(max_new_tokens=…)` in `gate3_probes.py`. The loop measure and the training-token decode have no script yet.
Under the owner's rule that Claude plans and Codex implements, these go to one Codex task. Its new files sit outside the pinned
packages and only import them. They must be reviewed before the run ends.
- **Done:** PR #94 (`feat/v5-end-of-run-eval`). The follow-up commit `d6bda07` was reviewed, and its tests ran: 94 passed.

### 8.9 1B result (2026-11-25): Gate 3 fails under A and B

- **The run** completed at 22:59:46 UTC at 1,000,000,000 positions.
- **`selected` = 1B** (weighted validation loss 2.420: Arabic 2.303, English 2.537), by the pre-registered rule.
- **Format check:** the training-token check on the stored bins matches the probes exactly.
- **Gate 3 prose (20 per language), on 1B:**
  - A (strict): 0/20 and 0/20.
  - B (content pass, no loop): 0/20 and 0/20.
  - Content alone: 0/20 and 0/20.
  - 800M, reported only: the same.
- **V5-3 does not start.** The §7 branch applies.
- **Chat core:** 1/18 and 3/18 (300M: 0/18 and 0/18).
- **Sampling diagnostic:** fewer loops, but prose content is still 0/20.
- **Independent recount:** session 0ac0a23a recounted every count, and they match.
- **Report:** `artifacts/chat-training/v5/probes/gate-1b-report-20261125.md`. Review: `gate3-condition-review-20261125.md`. Machine-readable result: `gate3-1b-result-20261125.json`.
- **Dell and PITRTask** were restored at 23:48:29 UTC, after the checks.
