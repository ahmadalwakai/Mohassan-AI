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
| D2 | Use public datasets that were machine-generated (for example TinyStories-style) | **No.** Human-written public data, templates and agent-authored rows only |
| D3 | Rent a cloud GPU (compute only, own code and weights) | **No.** Only raise it if Gate 3 fails |
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
