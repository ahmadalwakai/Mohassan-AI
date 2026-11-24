# Router Model Plan — Mohassan's own request router

Date: 2026-11-20
Status: **B0 trained and measured (§8). Not wired into the app; shadow mode is next.**

## 8. First measured results (2026-11-20)

The owner approved reading his messages and said where data comes from: «ابحث و حمل من النت و اكتب انت».

- **Data:** Amazon MASSIVE 1.1, ar-SA and en-US (CC BY 4.0, 40 MB tarball from Amazon's S3), intents mapped to
  routes in `scripts/router/train.py`. Plus 510 sentences written by Claude Code in `scripts/router/data/written.py`,
  of which a fixed fifth (100) is held out as dev. **Sealed test:** 61 distinct owner messages (74 from Neon
  `old-frog-54514985`, 54 from the lab PGlite, read-only), kept in `.data/router/real-labeled.jsonl`
  (git-ignored). **Labels on the sealed set were written by Claude Code, not by the owner.**
- **Commands:** `npx tsx scripts/router/eval-rules.ts` (R0), then
  `.venv-execution/Scripts/python.exe -I scripts/router/train.py --model b0 [--sealed]`. Report:
  `artifacts/router/report-<date>.json`.

| Gate | Result |
|---|---|
| R0 rules v0 on sealed | 28/61 = 45.9% |
| B0 (hashed n-grams + linear, 16.8M params, mostly hash buckets) | sealed **72.1%**, dev 60.0%, MASSIVE test 85.9% |
| B1 (char transformer, 0.62M params) | dev 37.0%, MASSIVE test 35.1%: rejected on dev, not scored on sealed again |
| R2 B0 vs rules (McNemar exact) | model-only right 20, rules-only right 4, **p = 0.0015**: pass |
| R3 never-web routes sent to web | **0**: pass |
| R5 CPU latency | 0.45 ms per request |

Per route on sealed: ads 16/18, browser_command 8/10, chat 6/9, reply 6/13, web_search 2/3, image 2/3,
writing 2/2, pc 1/1, news 1/1, compute 0/1.

**Caveats:**
- The sealed set was scored twice. The first round (balanced weights off, 297 written sentences) gave B0 49.2% and
  B1 26.2%. The changes after it (balanced class weights, ×10 repeat of written rows, a second batch of 213
  sentences) were chosen from dev misses, but the sealed result had already been seen.
- 61 sentences is a small test, and the labels are Claude Code's own.
- `reply` (6/13) depends on whether a question card is pending, which the app already knows. That should be
  decided by code rather than the model.

## 1. The problem

The chat has no model that understands the owner's words. Today `apps/server/src/assistant/hands.ts`
routes requests with hand-written rules: browser commands, `notWebReason`, search by default, and
`withTopic` for follow-ups. Rules do not converge: every new sentence needs a new rule, and a rule
that fixes one sentence breaks another (2026-11-20: «بكرة» added for weather caught
«ذكرني بموعد الطبيب بكرة»).

## 2. What the model does — and does not do

It **classifies**; it does not write text. One request (plus the previous user message) in, one route
and its spans out:

| Route | Example | Today handled by |
|---|---|---|
| `web_search` | «كم سعر الذهب اليوم؟» | default rule |
| `browser_command` | «افتح يوتيوب وابحث عن…» | `parseHands` |
| `news` | «أخبار الجزيرة» | `parseNews` |
| `memory` | «هل تتذكر اسم شركتي؟» | `NOT_WEB` / memory recall |
| `reminder` | «ذكرني بموعد الطبيب بكرة» | `REMIND` (no reminder tool yet) |
| `compute` | «كم 5 ضرب 3» | mind `compute` |
| `ads` | «أنشئ حملة لمخبزي» | Ads model |
| `pc` | «ما النوافذ المفتوحة على جهازي؟» | computer tools |
| `writing` | «ترجم…», «اكتب لي إيميل» | none (needs a writer model) |
| `chat` | «شكرا», «من أنت؟» | `CHAT` |

Spans: `topic` (what to search), `place`, `time`, and `follow_up` (yes/no + which words replace the
previous ones; this fixes «طيب ومباراة النصر؟» keeping «الهلال»).

Executing a route stays in code exactly as today. The model only replaces the decision.

## 3. Model

From scratch, own weights, CPU-trainable. Two candidates, measured against each other, none adopted
by default:

- **B0, the baseline:** character n-gram features + linear classifier. Trains in seconds and gives
  the floor any network must beat.
- **B1, the network:** a tiny transformer encoder (≈1–5M parameters, character/BPE vocabulary
  covering Arabic, its dialects and English) with a classification head and a span tagger.

It is separate from the 38M chat trunk and from the nested-architecture track, which stays parked.

## 4. Data

- **Seed:** every sentence in `tests/assistant-hands.test.ts` and `scripts/hands-live.ts`, labelled.
- **Owner-written:** sentences the owner actually types, Gulf / Levantine / Egyptian / formal / English.
- **Real chat history (needs the owner's OK):** the owner's own messages in `chat_messages`, read-only,
  labelled by hand. The local `.env` points at the production database, so this is a read of real data.
- **No external AI** generates or labels anything.
- Splits frozen before training: train / dev / **sealed test** (never seen until the final run).

## 5. Gates (numbers from real runs only)

| Gate | Measure | Pass |
|---|---|---|
| R0 | rules v0 (today's code) accuracy on the sealed test | recorded, no threshold: this is the baseline |
| R1 | B0 vs rules v0 | reported only |
| R2 | B1 route accuracy vs max(rules v0, B0) | higher, McNemar p < 0.05 on the sealed test |
| R3 | never-web routes (`memory`, `reminder`, `pc`, `ads`) sent to `web_search` | 0 on the sealed test |
| R4 | follow-up topic span exact match | reported vs `withTopic` |
| R5 | latency on the owner's PC, CPU | p95 recorded |

Thresholds beyond R2/R3 are proposed by measurements, then the owner decides; nothing is adopted by
default.

## 6. Owner decisions needed before starting

1. May the owner's real chat messages be read and labelled (read-only)?
2. Target size of the sealed test (proposal: ≥ 300 sentences, ≥ 20 per route).

## 7. Rollout

The model runs in shadow first: rules still decide, and the model's choice is logged next to them.
It takes over only after R2 and R3 pass, with the rules kept as the fallback when its confidence is
low.

## 9. CPU B2 comparison (2026-11-24)

Retrained B0 with its existing trainer and compared three classifiers initialized from scratch.
Every run used the same route mapping, seed 7, and one PyTorch CPU thread. The training split
contained 27,094 MASSIVE ar-SA and en-US rows from the official train and dev partitions, plus
410 frozen written rows repeated ten times, for 31,194 training rows. The SHA-256 split in
`train.py` assigned 100 written rows to dev. MASSIVE's official test partitions provided 5,948
test rows. The written file retains its historical Claude Code authorship from §8. This run
generated no examples and used no context rows or seed additions.

Each B2 candidate assigns 14 learned route coefficients to each hash bucket. It averages the
vectors for the message's n-grams and adds a per-route bias. The candidates use the same
262,144 buckets and train with sparse Adagrad and weighted
cross-entropy. Each model's checkpoint was chosen by dev accuracy, with ties going to the
earliest epoch. Models were ranked by dev accuracy, then fewer dev never-web errors, then
experiment order. MASSIVE test predictions were computed after that ranking was fixed.

| Model | Training change | Epoch selected | Dev | MASSIVE test | Dev never-web → web_search |
|---|---|---:|---:|---:|---:|
| B0 | Existing character 2–4-grams, word unigrams, and class weights | 7 | 59/100 (59.0%) | 5,176/5,948 (87.02%) | 1/33 |
| B2 direct | Direct route coefficients with B0 features and class weights | 1 | 65/100 (65.0%) | 4,893/5,948 (82.26%) | 2/33 |
| B2 extended | Adds character 5-grams and word bigrams | 2 | 62/100 (62.0%) | 5,078/5,948 (85.37%) | 2/33 |
| B2 source-balanced | Extended features and equal total loss weight for each source and each observed route within it | 2 | 67/100 (67.0%) | 5,061/5,948 (85.09%) | 2/33 |

B2 source-balanced led on dev by 8 percentage points. It trailed B0 by 1.93 points on
MASSIVE and sent one additional never-web request to `web_search` on dev. Keep B0 as the
reference. The owner-message accuracy and safety gates in §5 remain unmeasured for B2.
The existing split contains 1 written dev row and 318 MASSIVE test rows whose folded text
occurs in training. These overlaps were preserved for the fixed-split comparison.

### Per-route dev accuracy

Values are correct / total. A dash indicates zero examples for that route.

| Route | B0 | B2 direct | B2 extended | B2 source-balanced |
|---|---:|---:|---:|---:|
| web_search | 3/4 | 3/4 | 3/4 | 3/4 |
| browser_command | 14/21 | 13/21 | 13/21 | 13/21 |
| news | 1/1 | 1/1 | 1/1 | 1/1 |
| memory | 2/5 | 2/5 | 2/5 | 4/5 |
| reminder | — | — | — | — |
| compute | — | — | — | — |
| ads | 10/11 | 10/11 | 10/11 | 10/11 |
| pc | 7/17 | 9/17 | 7/17 | 10/17 |
| writing | 4/7 | 4/7 | 4/7 | 5/7 |
| chat | 2/3 | 2/3 | 2/3 | 2/3 |
| reply | 7/15 | 10/15 | 10/15 | 10/15 |
| image | 9/16 | 11/16 | 10/16 | 9/16 |
| media | — | — | — | — |
| unsupported | — | — | — | — |

### Per-route MASSIVE test accuracy

| Route | B0 | B2 direct | B2 extended | B2 source-balanced |
|---|---:|---:|---:|---:|
| web_search | 1280/1512 | 1087/1512 | 1230/1512 | 1241/1512 |
| browser_command | — | — | — | — |
| news | 209/248 | 224/248 | 211/248 | 210/248 |
| memory | 256/284 | 249/284 | 254/284 | 257/284 |
| reminder | 910/996 | 891/996 | 904/996 | 899/996 |
| compute | 243/256 | 240/256 | 243/256 | 236/256 |
| ads | — | — | — | — |
| pc | 108/124 | 99/124 | 100/124 | 105/124 |
| writing | 356/390 | 345/390 | 355/390 | 360/390 |
| chat | 224/378 | 214/378 | 229/378 | 232/378 |
| reply | — | — | — | — |
| image | — | — | — | — |
| media | 785/866 | 778/866 | 788/866 | 776/866 |
| unsupported | 805/894 | 766/894 | 764/894 | 745/894 |

### CPU inference and parity

On a cloud AMD EPYC 9V74, the Python harness timed one request at a time over 20 warmed
passes of the 100 dev texts, including hashing and the forward pass.

| Model | Parameters | Mean (ms) | p95 (ms) |
|---|---:|---:|---:|
| B0 | 16,778,126 | 0.139 | 0.264 |
| B2 direct | 3,670,030 | 0.111 | 0.212 |
| B2 extended | 3,670,030 | 0.141 | 0.286 |
| B2 source-balanced | 3,670,030 | 0.134 | 0.252 |

The exported B2 source-balanced model took 0.224 ms mean and 0.300 ms p95 in Node 24.22.3
over 4,000 warmed dev requests, including hashing, logits, and confidence. The maximum
absolute difference between PyTorch and TypeScript logits on the trained export fixture
was `1.74689711e-06`. `loadRouterB2Model` provides explicit offline loading.

### Reproduce

Run from the repository root with Python 3.12.14 and Node 24. The archive comes from the
[official Amazon MASSIVE release](https://github.com/alexa/massive#accessing-and-processing-the-data)
under CC BY 4.0.

```sh
python -m venv .data/router/venv
. .data/router/venv/bin/activate
python -m pip install torch==2.7.1 --index-url https://download.pytorch.org/whl/cpu
python -m pip install numpy==2.2.6

archive=.data/router/massive-1.1.tar.gz
mkdir -p .data/router/download
curl -fL https://amazon-massive-nlu-dataset.s3.amazonaws.com/amazon-massive-dataset-1.1.tar.gz -o "$archive"
printf '%s  %s\n' 4cba5faa11c71437928e17cb1b9b3d8b8e727e7ea363a3a9a8045e19c0491577 "$archive" | sha256sum -c -
tar -xzf "$archive" -C .data/router/download 1.1/LICENSE 1.1/data/ar-SA.jsonl 1.1/data/en-US.jsonl

python scripts/router/train_b2.py
npm ci --ignore-scripts
ROUTER_B2_PARITY_DIR=artifacts/router-b2 python -m unittest discover -s scripts/router -p 'test_*b2.py'
npm test -- tests/assistant-router.test.ts
```

The runner writes the exact scores to `artifacts/router-b2/report.json` and exports the
dev-selected B2 weights and parity fixture in the same ignored directory. Use `--repo-only`
to run with the written rows when MASSIVE is unavailable. The report then leaves MASSIVE
accuracy undefined.
