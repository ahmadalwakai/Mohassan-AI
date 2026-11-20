# Nested Architecture Plan — Shared Trunk, Early Exit, Specialist Adapters

Date: 2026-11-19 (revision 2, same day: owner decisions + audit)
Status: **P1 / P3–P5 mechanics built and CPU-tested (§11); no training, no GPU job, no trunk change.
Training phases wait for Gate 5.** Nothing here may touch the running Stage 3 → 5 chat-training
track, its gates, configs, datasets, checkpoints, or SHA pins.
**Thresholds:** the owner delegated decisions on 2026-11-19 ("تصرف من دون الرجوع إلي"). The values in
§6 are therefore **frozen as the working thresholds (D4)**; they are still labelled provisional in the
sense that each is copied into that phase's frozen case file before training and is changed only on
measured evidence, recorded in the receipt.

## 0b. Revision 4 change log (2026-11-19, documentation only)

- §12.6 rewritten: four separate kinds of size evidence (shape-derived counts, counts on
  instantiated modules, saved-file sizes, measured runtime memory); exact conditional fp32 raw-weight
  figures; reconciliation with the revision-3 total.
- §11 wording corrected: 512 and 565,248 for the 38m shape were computed from shapes/formulas, not
  counted on instantiated 38m addition modules.
- §12.8 rewritten: the attach-before-load defect in `execution_model/adapters.py` is a **blocker**
  for adapter runtime integration; future repair procedure and failure policy specified.
- §12.11 added: future acceptance cases for missing, malformed, incompatible and failed loads.
- Start condition unchanged: extension work begins only after the current training finishes and
  Gate 5 records a pass (§12.2). No code, model, checkpoint or training was touched.

## 0a. Revision 3 change log (2026-11-19, documentation only)

- Added §12 "Binding architectural constraints": sole base model, start condition, full base
  freeze, early-exit reuse without copies, adapter rules, raw-storage vs measured memory, early-exit
  evaluation and fallback, acceptance checks, missing/incompatible adapter handling, cache rules.
- Recorded the requested fp32 storage figures and reconciled them with counts derived from the
  module definitions (§12.6). All memory figures are estimates; nothing was measured.
- No code, checkpoint, experiment, or training change was made for this revision. `AGENTS.md`
  exists only at `apps/web/AGENTS.md` (Next.js rules) and contains nothing about the model.

## 0. Revision 2 change log

- Added owner decisions D1–D3 (§1).
- Audit of revision 1 claims (§3): early-exit parameter count, adapter counts (fused QKV), precision-
  dependent memory, speculative-decoding correctness. Three statements were corrected.
- Gates rewritten as isolated, measurable gates with baselines, sample sizes, statistics, rollback
  and acceptance tests (§6–§8).
- Datasets defined (§5). Risks listed (§10).

## 1. Owner decisions (2026-11-19)

| ID | Decision |
|---|---|
| D1 | Acceptance targets (provisional): zero critical test regressions; Coding ≥ 10 % improvement; zero Ads constraint violations; Browser ≥ 90 % task success; Early Exit ≥ 20 % latency improvement at acceptable quality; ≤ 15 % inference memory overhead. |
| D2 | P1 (early exit) runs **sequentially after Gate 5 passes**, and **not in parallel** with any adapter training. |
| D3 | Training data: verified TypeScript tasks (Coding), recorded Playwright traces (Browser), validated synthetic Ads campaigns (Ads). |
| D4 | Owner delegated the remaining choices (2026-11-19). Taken by the agent: §6 thresholds frozen as working values; exit layer 4; exit variant "norm" first, "projection" only if Gate EX fails; distillation temperature and KL weight picked on the `early-exit-v1` dev split only from {1, 2} × {0.5, 1.0}; LoRA rank 8, alpha 16, fused-qkv targets; speculative draft length picked on dev from {2, 4, 6} then fixed for the test run; greedy mode only. |

## 2. Constraints

- Own model only (external AI APIs cut 2026-11-12).
- No change to the live track or its artifacts; this plan starts from the Stage 5 checkpoint that
  passes Gate 5 (`aggregate_development_review.py`: ≥ 120/200 overall, ≥ 55/100 per language, no
  category at 0). If Gate 5 fails, the plan stays parked.
- Stage 6 (sealed holdout) and Stage 7 (phone activation) are never used by this plan.
- **API preservation:** `ModelConfig`, `ARCHITECTURE_VERSION = "dense-decoder-v1"`,
  `ExecutionModel.forward(...)`, `generate` / `stream_generate`, `GenerationConfig`, the checkpoint
  format and `load_local_model(expected_config=...)` stay unchanged. New behaviour lives in new
  modules (e.g. `execution_model/early_exit.py`, `execution_model/adapters.py`,
  `execution_model/speculative.py`) and in **sidecar weight files** with their own SHA-256, loaded
  only when explicitly requested. Removing a sidecar must restore today's behaviour bit-for-bit.
- Measured numbers only; no proposal is adopted by default.

## 3. Audit of revision-1 claims

Inspected code: `packages/execution-model/execution_model/{config,model,attention,feed_forward,
normalization,generation,inference,resources}.py`; trunk config
`artifacts/chat-training/v4/stage-3-full-20261118/config.json`; Gate 5 in
`scripts/chat-training/aggregate_development_review.py` and
`packages/execution-pipeline/execution_pipeline/stage5_finetune.py`.

### 3.1 Trunk facts (verified)

| Field | Value | Source |
|---|---|---|
| Layers / hidden / heads / FFN | 8 / 512 / 8 / 1408 (SwiGLU: gate, up, down) | config.json, feed_forward.py |
| Vocab / context | 24,576 / **512 tokens** | config.json |
| Parameters | 38,281,728 (embeddings 12,582,912; 3,212,288 per layer; final norm 512) | `parameter_count()` formula, recomputed |
| Output head | **tied** to the embedding (`F.linear(hidden, token_embedding.weight)`), no separate head parameter | model.py |
| Attention projection | **fused** `qkv_proj` 512 → 1536, plus `output_proj` 512 → 512 | attention.py |
| Norm | scale-only RMSNorm, fp32 variance | normalization.py |
| Stored weight dtype | **float32**; `ResourceConfig.dtype` default `"float32"` (bf16/fp16 optional) | model.py, resources.py |
| Decoding | **no KV cache**: every step re-runs the whole prefix with `last_token_only=True` | generation.py, attention.py |

### 3.2 Early-exit head — "512 parameters" claim

- **Correct as a minimum.** An exit after block 4 = one new scale-only RMSNorm (512 params) +
  the existing tied head (0 new params).
- **Qualified:** with the trunk frozen (needed to keep Gate 5 weights bit-exact, §4 P1), 512 trainable
  parameters may be too few to make layer-4 states predictive. Pre-registered fallback, used only if
  Gate EX fails with the norm alone: norm + one 512×512 bias-free projection = **262,656 params
  (0.69 % of the trunk)**.
- **Not acceptable:** joint fine-tuning of the trunk inside P1. That changes the Gate-5 weights and
  would require re-running Gate 5 semantic review. Excluded from P1.

### 3.3 Adapter parameter counts — corrected

Revision 1 assumed separate q/k/v projections. The code has one fused `qkv_proj`. Rank r = 8:

| Variant | Per layer | 8 layers | Share of trunk |
|---|---|---|---|
| LoRA on fused qkv (512→1536) + output + gate/up/down | 16,384 + 8,192 + 46,080 = **70,656** | **565,248** | 1.48 % |
| LoRA split per q/k/v slice (rev-1 assumption) | 78,848 | 630,784 | 1.65 % |

Plan uses the fused variant (no change to the attention module). Rank is a provisional
hyper-parameter; counts scale linearly with r.

### 3.4 Memory — precision-dependent (weights only, computed, not measured)

| Item | fp32 (current default) | bf16 / fp16 |
|---|---|---|
| Trunk weights | 153.1 MB | 76.6 MB |
| Early-exit norm | 2 KB | 1 KB |
| Early-exit fallback projection | 1.05 MB | 0.53 MB |
| One adapter (fused, r=8) | 2.26 MB | 1.13 MB |
| Three adapters | 6.8 MB | 3.4 MB |
| Four separate 38M models (comparison) | 612.5 MB | 306.3 MB |

Revision 1 quoted bf16 numbers only ("≈ 77 MB") although the runtime default is fp32. Corrected.
Weight overhead for exit + one adapter ≈ 1.5 % (2.2 % with the fallback projection). **Process
memory is not weights only:** CUDA context, allocator caches, activations and Python runtime are
unmeasured and can dominate a 38M model. Gate MEM (§6) therefore measures peak process memory,
not weight bytes.

Adapter merging note: merged LoRA has zero runtime overhead but needs a separate merged copy of the
trunk per adapter (+100 % if two are resident). Plan: unmerged adapters, one active at a time.

### 3.5 Speculative decoding — "identical by construction" corrected

- **Greedy (`do_sample=False`) only:** acceptance of a drafted token iff it equals the full model's
  argmax at that position gives the same token sequence as `generate` **mathematically**, because
  attention is causal. **Numerically** it is not guaranteed: the verification pass runs a longer
  sequence through SDPA, so fp32/bf16 rounding can differ from the step-by-step pass and flip a near-tie
  argmax. Requirement: measured token-level mismatch on a frozen prompt set (§8, AT-SPEC).
- **Sampling (`do_sample=True`):** exact equivalence holds only *in distribution*, via rejection
  sampling where draft and target distributions use the same temperature/top-k/top-p filtering. Per-
  seed reproducibility of the existing `seed` contract is **lost** because RNG consumption changes.
  Sampling-mode speculation is out of scope until a separate decision.
- **No KV cache:** a verification pass over prefix + k drafts costs about one normal step (the normal
  step already re-runs the full prefix), so speculation can still pay off; but drafting k tokens with the
  4-layer exit also re-runs the prefix k times. Speed-up is an empirical question for Gate EX.
- **Confidence-exit mode** (answer from layer 4 when confident) is **not output-preserving**; it is a
  quality trade-off and is gated separately (§6, Gate EX-Q).
- **Rough compute check (per generated token, last-token head only):** a block costs ~3.21M MACs per
  position, the head 12.58M MACs once. For a prefix of n tokens, exit at layer 4 costs
  ≈ 4·3.21M·n + 12.58M versus 8·3.21M·n + 12.58M, so the theoretical saving tends to ~50 % for long
  prefixes and is lower for short ones. Wall-clock must be measured.

## 4. Phases (strictly sequential; D2)

| Phase | Work | GPU | Gate |
|---|---|---|---|
| P0 | Current track reaches Gate 5 pass | yes (running) | Gate 5 (existing) |
| P1 | Early-exit sidecar: frozen trunk, train exit norm (fallback: + projection) by distillation from the full head | yes | EX, EX-Q, MEM, REG |
| P2 | Rule router v0 + deterministic verifiers (TS type check / tests, Ads constraint validator, Playwright end-state assertions) as library code; no app change | no | REG + verifier unit tests |
| P3 | Coding adapter | yes | CODE, MEM, REG |
| P4 | Ads adapter | yes | ADS, MEM, REG |
| P5 | Browser adapter (read-only tasks first) | yes | BROWSER, MEM, REG |
| P6 | Router v1 from exit head vs v0 | small | ROUTE, REG |
| P7 | Failure log → adapter retraining; trunk untouched | yes | re-run that adapter's gate + REG |

One GPU job at a time; P1 must close (pass or documented fail) before P3 starts.

## 5. Datasets (D3)

All datasets: manifest with per-file SHA-256, frozen train / dev / test split **before** training,
split by task family and source time (no near-duplicate across splits; dedupe by normalized-content
hash), licence and provenance recorded per item. Test splits are sealed until the gate run. Nothing
from the chat-training sealed holdout is reused.

| Dataset | Item | "Verified" means | Provisional size (dev / test) |
|---|---|---|---|
| `coding-ts-v1` | repo snapshot ref + instruction + expected patch + hidden tests | pre-state fails the tests; reference patch applies cleanly, passes `tsc --noEmit` and the tests; items re-verified at freeze time | ≥ 100 / ≥ 200 |
| `browser-traces-v1` | goal + recorded Playwright trace (actions, accessibility snapshots) + end-state assertion | trace replays deterministically against the recorded/local page and the assertion passes 3/3 replays; read-only tasks first | ≥ 100 / ≥ 200 |
| `ads-synthetic-v1` | brief (site facts, goal, budget) + campaign JSON | generated synthetically, then passes the constraint validator (schema, status `PAUSED`, budget bounds, text-length limits, policy word list, required fields); a reviewed subset of real owner briefs is held out for distribution-shift checks | ≥ 300 / ≥ 300 |
| `early-exit-v1` | prompts drawn from the Stage 5 training distribution (not from development-v4 or holdout) | frozen prompt set; outputs of the full model recorded as reference | 200 prompts |

Context limit: the trunk window is **512 tokens**. Items that do not fit (prompt + target) are
excluded and the exclusion count is reported, not truncated silently.

## 6. Acceptance gates (isolated, provisional)

**Isolation rule:** each gate compares exactly one change against a fixed baseline on its own
frozen case file; other adapters are unloaded; same hardware, same dtype, same decoding settings,
same commit of evaluation code. A gate's eval items are never in any training set.

| Gate | Metric | Baseline | Provisional threshold | Statistics |
|---|---|---|---|---|
| **REG** | failures in the critical suite: `tests/*.test.ts`, execution-model and execution-pipeline Python tests, Gate 5 non-regression check (§7) | same suite on the pre-change commit | **0 new failures, 0 new skips** | deterministic; flaky tests quarantined only by owner decision, listed in receipt |
| **CODE** | pass@1 on `coding-ts-v1` test (patch applies + `tsc` + tests pass) | Gate-5 trunk without adapter, same decoding | **≥ +10 percentage points absolute** (relative % is undefined if baseline is 0) | Wilson 95 % CI per arm; paired exact McNemar, one-sided p < 0.05 |
| **ADS** | constraint violations on `ads-synthetic-v1` test + real-brief subset | validator itself | **0 violations** | with n = 300 and 0 observed, 95 % upper bound on violation rate = 1.3 % (rule of three / Wilson); report it |
| **BROWSER** | task success on `browser-traces-v1` test (end-state assertion) | Gate-5 trunk without adapter | **≥ 90 %** point estimate **and** Wilson 95 % lower bound ≥ 85 % (needs n ≈ 200: 180/200 → [85.1 %, 93.4 %]) | Wilson CI |
| **EX** (speculative, greedy) | median wall-clock latency per generated token on `early-exit-v1` | full model `generate`, greedy | **≥ 20 % lower** latency **and** token mismatch = 0 in fp32 deterministic mode; mismatch rate reported for bf16 | median of ≥ 5 warm runs per prompt; bootstrap 95 % CI (10k resamples) on the ratio, lower bound of improvement > 0 |
| **EX-Q** (confidence exit) | development-v4 semantic pass count with confidence exit enabled | Gate-5 result of the same checkpoint | **"acceptable quality" = drop ≤ 3 passes overall and still ≥ 55 per language and no category at 0**, plus ≥ 20 % latency improvement | same independent semantic review protocol as Gate 5; reviewer blind to arm |
| **MEM** | peak process memory (`torch.cuda.max_memory_allocated` + process working set) during the gate's eval | base trunk, same dtype and inputs | **≤ +15 %** | max over the eval run; reported per dtype |
| **ROUTE** | routing accuracy on a frozen labelled request set | router v0 (rules) | ≥ v0, McNemar not significantly worse | Wilson CI |

## 7. Gate 5 non-regression

- P1 and adapters keep the trunk **frozen**; trunk SHA-256 must equal the Gate-5 candidate SHA and
  logits on 200 frozen prompts must be bit-identical with sidecars unloaded (fp32, deterministic).
- Any phase that changes trunk weights is out of this plan and must re-run Gate 5 in full.

## 8. Acceptance tests (written before each phase's code)

| ID | Test |
|---|---|
| AT-API | existing public signatures and checkpoint loading unchanged; old checkpoints load without sidecars |
| AT-ROLLBACK | loading then unloading every sidecar gives logits bit-identical to the base on frozen prompts |
| AT-SPEC | greedy speculative output token-identical to `generate` on `early-exit-v1` (fp32, deterministic algorithms); bf16 mismatch rate recorded; stop/EOS/context-limit behaviour identical |
| AT-EXIT-SHAPE | exit sidecar adds exactly 512 params (or 262,656 with fallback); verified by count |
| AT-ADAPTER-SHAPE | adapter adds exactly 565,248 params at r = 8; one adapter active at a time enforced |
| AT-ADS-VALIDATOR | validator rejects every seeded violation fixture and accepts every valid fixture |
| AT-BROWSER-REPLAY | each trace replays 3/3 before entering a split |
| AT-CODING-VERIFY | each coding item fails before and passes after its reference patch |
| AT-ISOLATION | gate harness refuses to run with more than one adapter loaded |

## 9. Rollback criteria

- Gate fails → the sidecar is not promoted; previous state stays active; receipt records the failure
  and evidence paths. No retry with changed settings without an owner decision.
- After promotion, any REG failure, any Ads violation, MEM above threshold, or a measured quality drop
  beyond the gate's threshold on re-evaluation → unload the sidecar (one switch), confirm AT-ROLLBACK,
  record the incident.
- Trunk is never modified by this plan, so rollback never needs a trunk restore.

## 10. Unresolved risks

1. **512-token context** may exclude most realistic TypeScript edits and DOM snapshots; dataset
   exclusion rates may make CODE / BROWSER unreachable at this trunk size.
2. **Capacity:** a 38M trunk scored 0 on TypeScript in earlier execution-model work; a ≥ 10-point
   coding gain may not be reachable with r = 8 adapters.
3. **Frozen-trunk early exit** may be too weak with 512 params; fallback projection pre-registered,
   but EX-Q can still fail.
4. **No KV cache:** speculative speed-up is unproven; drafting also re-runs the prefix.
5. **bf16 numerics** can break token equality in speculation; fp32 is the reference mode.
6. **Synthetic Ads data** may not match real briefs; zero violations on synthetic data bounds the rate
   only to ≤ 1.3 % at 95 % confidence, not to zero.
7. **Process memory** for a model this small is dominated by runtime overhead; the 15 % memory gate is
   measured on process peak and can be noisy across drivers.
8. **Semantic review cost** for EX-Q repeats the Gate 5 review effort.
9. **Thresholds were frozen by delegation (D4)**, not by measured baselines; the first gate run may
   show a target is unreachable at 38M parameters, and that result is reported, not hidden.

## 11. Implementation status (2026-11-19)

New modules only; no existing file edited (pinned `execution_model/__init__.py` SHA unchanged,
`8fc52d22…`). The running Stage 3 trainer was not touched.

| File | Content |
|---|---|
| `packages/execution-model/execution_model/early_exit.py` | `EarlyExitHead` (variants norm / projection), `run_with_exit` (re-traces the trunk forward with its own modules, taps block k, cheap path stops at k), `freeze_trunk`, `assert_trunk_frozen`, `distillation_loss` (CE + T²·KL, teacher detached) |
| `packages/execution-model/execution_model/speculative.py` | `speculative_generate_greedy` (draft with exit head, verify with one full pass, same CPU-fp32 argmax rule as `generate`), result carries drafted / accepted / pass counts |
| `packages/execution-model/execution_model/adapters.py` | `LoRALinear`, `attach_adapter` / `detach_adapter` (one at a time, originals restored), `expected_parameters` |
| `packages/execution-model/execution_model/sidecar.py` | `save_sidecar` / `load_sidecar`: weights + manifest, pinned to trunk SHA, own SHA, refuses overwrite, `weights_only` load |
| `packages/execution-pipeline/tests/test_nested_architecture.py` | 18 CPU tests |

Measured on CPU, fp32, tiny random trunks (mechanics only, not quality):
- `test_nested_architecture.py`: **18 / 18 pass**; existing `test_model_and_tokenizer.py` still 18 / 18.
- AT-EXIT-SHAPE: counted on instantiated **tiny** heads (width 32). For the 38m shape, 512 / 262,656
  come from the formula `EarlyExitHead.expected_parameters`, not from an instantiated 38m head.
- AT-ADAPTER-SHAPE: the attached adapter's tensor count matched `expected_parameters` on the **tiny**
  trunk. For the 38m shape, 565,248 was computed by `expected_parameters` from `nn.Linear` shapes of
  a meta-device trunk; no 38m adapter tensors were counted (revision 4 correction).
- `run_with_exit` full logits bit-identical to `ExecutionModel.forward` (with and without padding,
  last-token and full sequence).
- AT-SPEC: greedy speculative output token-identical to `generate` on 9 / 9 seed × draft-length cases
  and on the EOS stop case. Not yet measured: bf16, CUDA, the real 38m trunk, latency.
- Rollback: adapter detach restores state-dict keys and logits bit-identically; second attach refused.
- Distillation: gradients reach only the head; trunk gradients stay `None`.

Not built yet: training CLIs for P1 / P3–P5, the three datasets, the Ads constraint validator, the
gate harness (MEM, latency), router v0. These follow after Gate 5, sequentially (D2).

## 12. Binding architectural constraints (revision 3)

These constraints override any looser wording earlier in this document. Paths and symbols below
were read from the repository on 2026-11-19; nothing was executed for this revision.

### 12.1 Sole base model
- The only base model is the current `dense-decoder-v1` trunk built by `ExecutionModel`
  (`packages/execution-model/execution_model/model.py`) from
  `artifacts/chat-training/v4/stage-3-full-20261118/config.json`: 8 layers (`num_layers`), width 512
  (`hidden_size`), 8 heads, SwiGLU width 1408, vocabulary 24,576, context 512; 38,281,728 parameters
  by `ModelConfig.parameter_count()` (≈ 38.28M).
- No second base model is trained, copied, or distilled into a separate network. The early-exit path
  and all adapters are additions to this one trunk.

### 12.2 Start condition
- No extension work (P1–P7) starts until (a) the running Stage 3 → 5 training has finished, and
  (b) Gate 5 has recorded **passing** evidence: `gate5_passed: true` next to the Stage 5 receipt, based
  on `scripts/chat-training/aggregate_development_review.py` (≥ 120/200, ≥ 55 per language, no
  category at 0). A missing, failed or unrecorded Gate 5 keeps the plan parked.
- Every phase uses the Gate-5-passing checkpoint, identified by its SHA-256.

### 12.3 Full base freeze
- After Gate 5, every base parameter is frozen for all extension work, including
  `token_embedding.weight` (also the output projection), each block's `attention_norm` and
  `ffn_norm` weights, `final_norm.weight`, `attention.qkv_proj`, `attention.output_proj`, and
  `feed_forward.gate_proj` / `up_proj` / `down_proj`.
- Optimizers receive only addition parameters (exit head, one adapter). A base parameter with
  `requires_grad=True` or a non-`None` gradient during extension training is a hard failure.
- The base checkpoint file is never rewritten; additions are stored only as sidecars.

### 12.4 Early exit
- Reuses the trunk's existing first four blocks (`ExecutionModel.blocks[0:4]`) and the existing tied
  output projection (`token_embedding.weight`, applied in `ExecutionModel.forward` as
  `F.linear(hidden, self.token_embedding.weight)`). No weights are copied or duplicated.
- **The 512-parameter figure is valid only** if the sole addition is one width-512 scale-only
  normalization (`RMSNorm(512)` from `normalization.py`, whose only parameter is a 512-element
  `weight`) or an equivalent module whose count is verified to be 512. Any other addition (e.g. the
  "projection" fallback, 262,656 by definition) is reported with its own verified count.
- Usefulness is **unproven**: with a frozen base there is no evidence yet that layer-4 states give
  acceptable quality or any wall-clock speed-up (generation has no KV cache, §12.9).
- Evaluation is always against the **full-depth (8-layer) baseline** on the same frozen prompts,
  dtype, device and decoding settings: quality per Gate EX / EX-Q (§6), latency as median of warm
  runs with bootstrap CI.
- **Fallback:** if any early-exit acceptance criterion fails, or on any error in the exit path, the
  request runs all eight layers through the unchanged `ExecutionModel.forward` / `generate` path.
  A failure of the exit path never fails a request.

### 12.5 Adapters
- Coding, Ads and Browser each use a **separate** adapter; no shared or combined adapter.
- Size: **≈ 0.57M parameters each — estimate, pending verification from the adapter definitions**.
  Derived from module shapes at rank 8 on fused `qkv_proj` (512→1536), `output_proj` (512→512),
  `gate_proj` / `up_proj` (512→1408) and `down_proj` (1408→512) in 8 blocks: 8 × 70,656 = **565,248**
  (derived, not yet verified on a trained adapter file).
- At most **one adapter is active per request**.
- Adapters stay **unmerged**: base weights are never modified by folding an adapter into them.

### 12.6 Size evidence: four separate kinds
These are different quantities and are never mixed or substituted for each other:

| Kind | Meaning | Status for the 38m additions |
|---|---|---|
| A. Shape-derived count | parameters computed from layer shapes / formulas | 512 (exit norm) and 565,248 (one adapter) — **calculated from shapes** |
| B. Instantiated-module count | `sum(p.numel())` over the actual addition modules built on the 38m trunk | **not done yet** |
| C. Saved-file size | bytes of a sidecar file on disk (includes container overhead and the manifest) | **no 38m sidecar exists** |
| D. Measured runtime memory | peak process / device memory during inference or training (CUDA context, allocator, activations, optimizer state) | **not measured**; produced only by Gate MEM (§6) |

Confirming a parameter count (kind B) **does not require training**: it only needs the addition
modules instantiated against the trunk shape (e.g. on the meta device) and their tensors counted.
Until that check is run against the actual implementation, 565,248 stays labelled "calculated from
shapes". Kind A/B numbers say nothing about kinds C or D.

**Conditional fp32 raw-weight calculations** (kind A × 4 bytes; decimal MB = 10⁶ bytes; valid only
if the kind-A counts are confirmed and weights are held in fp32):

| Item | Parameters | Raw fp32 weights |
|---|---|---|
| Base | 38,281,728 | 153.126912 MB |
| One adapter | 565,248 | 2.260992 MB |
| Three adapters + 512 early-exit parameters | 1,696,256 | 6.785024 MB |
| Total | 39,977,984 | 159.911936 MB |

Reconciliation with the revision-3 total of 159.962048 MB (153.12 MB rounded base + 3 × 2.28 MB
rounded adapters + 0.002048 MB norm):
- Total difference: 159.962048 − 159.911936 = **0.050112 MB**.
- Adapter rounding alone, holding the base count constant: 3 × (2.28 − 2.260992) = **0.057024 MB**.
- The two differ because revision 3 also rounded the base down: 153.126912 − 153.12 = 0.006912 MB,
  and 0.057024 − 0.006912 = 0.050112 MB.

### 12.7 Acceptance checks (deterministic evaluation, fresh state)
Run in fp32 with `torch.use_deterministic_algorithms(True)` set by the host, eval mode, a fresh
process and model load per check, and empty caches:
- **Unchanged base tensors:** SHA-256 of every base tensor and of the base checkpoint file is
  identical before and after each extension training run and after attach/detach cycles.
- **True output-weight sharing:** the early-exit path uses the same tensor as
  `token_embedding.weight` (same storage pointer); the state dict holds no separate output-head
  tensor; early exit adds exactly 512 parameters (or the verified count from §12.4).
- **Adapter isolation:** attaching a second adapter while one is active is refused; results for one
  adapter are identical whether or not other adapters' sidecars are present on disk.
- **Restoration of baseline outputs:** after detaching an adapter or disabling early exit, logits on a
  frozen prompt set are bit-identical to the base model loaded fresh.

### 12.8 Missing or incompatible adapters
- An adapter is **compatible** only if its sidecar manifest matches kind, base trunk SHA-256, its own
  weights SHA-256, rank and target layout, and every tensor shape.
- If the requested adapter is **missing or incompatible**: attach nothing (no partial attach), record
  the reason, and either run the base model without an adapter where the task allows it, or return a
  clear "adapter unavailable" error. Never substitute a different adapter.
- **Blocker for adapter runtime integration (reported defect):** in the CPU prototype,
  `attach_adapter` (`packages/execution-model/execution_model/adapters.py`) installs `LoRALinear`
  wrappers into the live model and registers the handle (`active_adapter`) **before** any weights are
  loaded; weights are loaded afterwards through `AdapterHandle.state_module()` and `load_sidecar`
  (`execution_model/sidecar.py`). If `load_sidecar` raises, the wrappers stay installed with
  initial (not loaded) weights and the model reports an active adapter that was never loaded.
  `attach_adapter` also refuses while another adapter is active, so switching means calling
  `detach_adapter` first, which drops the previous adapter before the new one is known to be good.
  No adapter may be wired into any runtime path until this is repaired.
- **Future repair (not implemented):**
  1. Prepare a **detached candidate**: build the adapter's own parameter tensors outside the live
     model, sized from the trunk's layer shapes. Never copy the base model or its weights.
  2. **Validate compatibility** before touching the model: manifest kind, base trunk SHA-256, rank,
     target layout, weights SHA-256, key set, tensor shapes, finiteness.
  3. **Load completely** into the candidate.
  4. **Activate** only then, in one step that requests cannot observe half-done (for example, under
     the same lock that serializes requests): swap out the previous adapter, if any, and swap in the
     candidate.
  5. On any failure in steps 1–3 the live model is untouched: base tensors and the previously active
     adapter (or "no adapter") remain exactly as they were.
- **Failure policy (explicit, per request):** the caller chooses one of two declared modes and the
  choice is recorded in the response:
  - `base_fallback`: run the base model with no adapter and report "adapter unavailable: <reason>";
    allowed only for tasks declared safe without the specialist.
  - `error`: return "adapter unavailable: <reason>" and produce no model output.
  Silently using a different adapter is never allowed.

### 12.9 Caches
- The current code has **no KV cache**: the docstrings of `attention.py` and `generation.py` say so,
  and `InferenceEngine` reports `"kv_cache": False`.
- Any cache added later (KV, draft, prompt or response cache) is keyed by the full model state: base
  trunk SHA, active adapter id and sidecar SHA (or "none"), early-exit sidecar SHA (or "off"), dtype
  and device. An entry is never reused across a different adapter state; attaching, detaching or
  switching an adapter clears all caches.

### 12.10 Status of existing prototype code
`early_exit.py`, `speculative.py`, `adapters.py`, `sidecar.py` under
`packages/execution-model/execution_model/`, and `packages/execution-pipeline/tests/test_nested_architecture.py`,
are uncommitted CPU prototypes (§11). Nothing in the apps, server or runtime imports them, and this
revision did not change them. The word "adapters" also names unrelated tool adapters in
`apps/server/src/skill-tools.ts` and `packages/execution-evaluation`; keep the two apart.

### 12.11 Future acceptance cases for adapter loading (to be written with the repair)
Each case runs twice: once with no adapter active and once with a different, valid adapter active.
Every failed attempt must leave (a) every base tensor bit-identical (SHA-256 per tensor), (b) the
previously active adapter (or "none") still active with identical tensors, (c) logits on a frozen
prompt set bit-identical to before the attempt, and (d) the declared failure policy (§12.8) applied,
with no other adapter substituted.

| Case | Input | Expected result |
|---|---|---|
| Missing file | sidecar directory, `weights.pt` or `sidecar.json` absent | `ModelLoadError` (reason: missing/unreadable); live state unchanged |
| Malformed checkpoint | truncated or non-ZIP `weights.pt`, invalid JSON manifest, or non-finite values | load refused with a typed error; live state unchanged |
| Incompatible keys | extra or missing tensor names vs the candidate layout | refused before activation; live state unchanged |
| Incompatible shapes | right names, wrong rank or wrong layer width | refused before activation; live state unchanged |
| Wrong pins | manifest kind, base trunk SHA-256 or weights SHA-256 mismatch | refused before activation; live state unchanged |
| Loading failure | exception raised part-way through filling the candidate (injected) | candidate discarded; live state unchanged |
| Successful switch (control) | valid adapter B while A is active | B active; A fully removed; base tensors unchanged; caches cleared (§12.9) |
