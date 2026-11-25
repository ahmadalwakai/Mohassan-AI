# Integration wave 2 · 25 November 2026

`integration/wave-2` starts at `93066fbb0984643110404372d5e32d3da3f324d2`, the latest `integration/wave-1` commit checked against origin. The draft targets `integration/wave-1` for review. [Wave 1 PR](https://github.com/ahmadalwakai/Mohassan-AI/pull/61)

## Plan compiler repair

Wave 1 already included the plan stack as a second-parent merge (`876df310`). Reversing `bd2efae1` restored it without replaying the ancestor PRs. The downstream tip `e150f149` includes `ccec5a67` from the base stack. [Plan compiler PR](https://github.com/ahmadalwakai/Mohassan-AI/pull/24) · [End-to-end PR](https://github.com/ahmadalwakai/Mohassan-AI/pull/52)

An explicit page open followed by a question about that page was compiled as two actions. The first could read the source, but the second had no independent executable operation. The compiled path also bypassed the native page reader, which records the URL and observed answer for subsequent turns. The compiler now treats the two fragments as one lookup when the existing page reader can bind the question to the explicit URL. The first repair recovered all 10 factual and 18 follow-up passes. It exposed a separate comparison loss. The numeric plan comparator needs two upstream values. The existing extractive writer compares contents from a single explicit page. The compiler now leaves an enabled extractive task on that one source with its native handler. Compound requests with additional independent actions keep their dependency graph. A subsequent v2 development run found six Arabic factual losses from splitting a question at a weak conjunction or comma. The compiler now requires a separately recognized action at those boundaries within a question. In the nine affected development cases used to diagnose the change, 6/9 passed with the compiler off, 0/9 passed before the boundary fix and 6/9 passed after it. Explicit sequences and independent computations and lookups still compile.

The focused plan tests cover a same-page lookup in Arabic and English, the recorded source reused in a following turn, the enabled writer's single-source comparison, weak boundaries inside a factual question, and a source-backed computation that still needs two plan steps. The restored stack's separate 120-case agent-authored replay fixture and its harness were excluded. The v1 development gate uses the frozen capability corpus throughout.

## Measurement method

The v1 runner, scorer, manifest and development payload came from PR #22 at `a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f`. An untracked overlay installs only those files for a run. The observer uses the published PR #41 startup adapters for reviewer publication and structured memory. When trying #55 it also configured the enabled deliberation intake and its per-database memory reader as documented by that PR. The score rules and fixtures stayed frozen. The runs use temporary PGlite and fixture tool ports. [Frozen v1 runner](https://github.com/ahmadalwakai/Mohassan-AI/pull/22) · [Observer adapters](https://github.com/ahmadalwakai/Mohassan-AI/pull/41)

PR #62 appeared after the initial v1 trials. The dual-gate pass pins the v2 development branch at `12cedfe592aab40cdd47ee00d05ea86a6d2bae89`, with 2,400 human cases and payload SHA-256 `6eda0e7052611d10fc87da4e3e8f3f30cfb64452c198eab20041b5da577508d1`. PR #62 reports a `c2a0ff7` baseline of 499/2,400. The dual-gate comparison uses the measured wave 1 results as its starting point. Each candidate has a frozen commit and separate development receipts. Any area loss on either split requires a revert and a tree equality check against the last retained tree. [V2 development PR](https://github.com/ahmadalwakai/Mohassan-AI/pull/62)

For v2 development, isolated Node processes assign case indices modulo the worker count and use separate fixture harnesses. Each worker validates the published bundle. The coordinator verifies the worker receipt hashes and commit, checks exact coverage and order of all 2,400 case IDs, and invokes the published scorer summary. Only development scheduling and startup adapters are different from the published CLI. The v2 sealed run uses the release runner with serial scheduling. [V2 sealed release](https://github.com/ahmadalwakai/Mohassan-AI/pull/56)

## Overall results

| Split | Skill-engine baseline | Wave 1 | Wave 2 |
| --- | ---: | ---: | ---: |
| V1 development | 40/240 | 104/240 | 176/240 |
| V1 sealed | 10/60 | 22/60 | 26/60 |
| V2 development | 499/2,400 | 508/2400 | 667/2400 |
| V2 sealed | 247/1,200 | — | 387/1200 |

The skill-engine baselines are published values at `c2a0ff7`. The wave 1 sealed count comes from PR #61. Wave 2 measured wave 1 on both development splits.

## Candidate decisions

| PR | Upstream tip | Measured product commit | Decision |
| --- | --- | --- | --- |
| #52 on #24 | `e150f149` | `b172e2e` | Kept after repair |
| #55 on #37 | `4a0a54f` | `f2cb55e` | Reverted in `7906505` |
| #58 | `bdabd28` | `45cc224` | Kept |
| #60 on #26 | `88865ba` | `28f51b2` | Kept |
| #50 on #26 | `27d0946` | `3639b0d` | Kept |
| #54 on #25 | `e245184` | `84df253` | Reverted in the earlier v1 trial and omitted from the dual pass |
| #59 on #32 | `3d1dff3` | `0db09d2` | Kept |
| #47 (first tip) | `76b1a93` | `cbdd9bc` | Superseded by the exclusion-filtered trial |
| #23 | `72575f3` | `215f626` | Reverted in `f0574ac` |
| #57 on #39 (first tip) | `f1ea533` | `5619639` | Superseded by the exclusion-filtered trial |
| #47 after exclusion refresh | `5127e56` | `44c300a` | Kept |
| #57 on #39 after exclusion refresh | `d6aa912` | `5306a36` | Kept |


## V1 development

| Group | Wave 1 | Repaired plan | #55 | #58 | #60 | #50 | #59 | #47 | #23 | #57 | #47 filtered | #57 filtered |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **All** | 104/240 | 121/240 | 103/240 | 132/240 | 139/240 | 149/240 | 161/240 | 164/240 | 156/240 | 176/240 | 164/240 | 176/240 |
| calculation | 11/18 | 11/18 | 11/18 | 11/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| clarification | 4/16 | 4/16 | 5/16 | 4/16 | 4/16 | 4/16 | 16/16 | 16/16 | 15/16 | 16/16 | 16/16 | 16/16 |
| coding | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 |
| comparison | 1/18 | 1/18 | 1/18 | 1/18 | 1/18 | 11/18 | 11/18 | 11/18 | 10/18 | 11/18 | 11/18 | 11/18 |
| desktop | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 |
| document-file | 5/18 | 5/18 | 5/18 | 16/18 | 16/18 | 16/18 | 16/18 | 16/18 | 16/18 | 16/18 | 16/18 | 16/18 |
| explanation | 8/18 | 8/18 | 2/18 | 8/18 | 8/18 | 8/18 | 8/18 | 8/18 | 8/18 | 8/18 | 8/18 | 8/18 |
| factual | 10/18 | 10/18 | 10/18 | 10/18 | 10/18 | 10/18 | 10/18 | 10/18 | 9/18 | 10/18 | 10/18 | 10/18 |
| follow-up | 18/18 | 18/18 | 9/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 14/18 | 18/18 | 18/18 | 18/18 |
| google-ads | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 |
| memory | 16/16 | 16/16 | 13/16 | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 |
| multi-step | 1/18 | 18/18 | 15/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| refusal | 1/16 | 1/16 | 3/16 | 1/16 | 1/16 | 1/16 | 1/16 | 4/16 | 3/16 | 16/16 | 4/16 | 16/16 |
| small-talk | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| Language / ar | 46/120 | 54/120 | 42/120 | 60/120 | 66/120 | 71/120 | 78/120 | 81/120 | 73/120 | 85/120 | 81/120 | 85/120 |
| Language / en | 58/120 | 67/120 | 61/120 | 72/120 | 73/120 | 78/120 | 83/120 | 83/120 | 83/120 | 91/120 | 83/120 | 91/120 |

### V1 development run receipts

| Step | Commit | Started UTC | Finished UTC | Report |
| --- | --- | --- | --- | --- |
| Wave 1 | `93066fbb0984` | 2026-11-25T03:42:55.067Z | 2026-11-25T03:43:43.826Z | `dev-wave1.json` |
| Repaired plan | `b172e2e2cd74` | 2026-11-25T04:03:41.948Z | 2026-11-25T04:04:58.241Z | `dev-plan-dual.json` |
| #55 | `f2cb55e711c0` | 2026-11-25T04:08:41.897Z | 2026-11-25T04:10:11.103Z | `dev-55-dual.json` |
| #58 | `45cc224b9391` | 2026-11-25T04:12:02.282Z | 2026-11-25T04:13:32.964Z | `dev-58-dual.json` |
| #60 | `28f51b2ee86d` | 2026-11-25T04:15:05.046Z | 2026-11-25T04:16:43.127Z | `dev-60-dual.json` |
| #50 | `3639b0d21bfe` | 2026-11-25T04:18:27.371Z | 2026-11-25T04:20:08.994Z | `dev-50-dual.json` |
| #59 | `0db09d202b4a` | 2026-11-25T04:22:06.980Z | 2026-11-25T04:23:42.898Z | `dev-59-dual.json` |
| #47 | `cbdd9bce2947` | 2026-11-25T04:27:37.620Z | 2026-11-25T04:29:46.216Z | `dev-47-dual.json` |
| #23 | `215f6267be6b` | 2026-11-25T04:31:38.257Z | 2026-11-25T04:33:29.234Z | `dev-23-dual.json` |
| #57 | `5619639626f7` | 2026-11-25T04:35:14.011Z | 2026-11-25T04:36:55.795Z | `dev-57-dual.json` |
| #47 filtered | `44c300a4bc60` | 2026-11-25T04:58:10.935Z | 2026-11-25T05:00:40.411Z | `dev-47-filtered.json` |
| #57 filtered | `5306a36c5506` | 2026-11-25T05:01:25.398Z | 2026-11-25T05:04:41.459Z | `dev-57-filtered.json` |

## V2 development

| Group | Wave 1 | Repaired plan | #55 | #58 | #60 | #50 | #59 | #47 | #23 | #57 | #47 filtered | #57 filtered |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **All** | 508/2400 | 508/2400 | 508/2400 | 508/2400 | 508/2400 | 508/2400 | 508/2400 | 565/2400 | 584/2400 | 667/2400 | 565/2400 | 667/2400 |
| calculation | 0/277 | 0/277 | 0/277 | 0/277 | 0/277 | 0/277 | 0/277 | 0/277 | 0/277 | 0/277 | 0/277 | 0/277 |
| clarification | 0/9 | 0/9 | 0/9 | 0/9 | 0/9 | 0/9 | 0/9 | 0/9 | 0/9 | 0/9 | 0/9 | 0/9 |
| coding | 0/155 | 0/155 | 0/155 | 0/155 | 0/155 | 0/155 | 0/155 | 0/155 | 0/155 | 0/155 | 0/155 | 0/155 |
| comparison | 23/32 | 23/32 | 23/32 | 23/32 | 23/32 | 23/32 | 23/32 | 23/32 | 23/32 | 23/32 | 23/32 | 23/32 |
| factual | 470/1244 | 470/1244 | 470/1244 | 470/1244 | 470/1244 | 470/1244 | 470/1244 | 470/1244 | 487/1244 | 470/1244 | 470/1244 | 470/1244 |
| follow-up | 0/240 | 0/240 | 0/240 | 0/240 | 0/240 | 0/240 | 0/240 | 0/240 | 0/240 | 0/240 | 0/240 | 0/240 |
| refusal | 0/375 | 0/375 | 0/375 | 0/375 | 0/375 | 0/375 | 0/375 | 54/375 | 56/375 | 156/375 | 54/375 | 156/375 |
| small-talk | 15/68 | 15/68 | 15/68 | 15/68 | 15/68 | 15/68 | 15/68 | 18/68 | 18/68 | 18/68 | 18/68 | 18/68 |
| Language / ar | 416/1200 | 416/1200 | 416/1200 | 416/1200 | 416/1200 | 416/1200 | 416/1200 | 449/1200 | 467/1200 | 485/1200 | 449/1200 | 485/1200 |
| Language / en | 92/1200 | 92/1200 | 92/1200 | 92/1200 | 92/1200 | 92/1200 | 92/1200 | 116/1200 | 117/1200 | 182/1200 | 116/1200 | 182/1200 |

### V2 development run receipts

| Step | Commit | Started UTC | Finished UTC | Report |
| --- | --- | --- | --- | --- |
| Wave 1 | `93066fbb0984` | 2026-11-25T03:57:20.043Z | 2026-11-25T04:05:59.253Z | `v2-dev-wave1.json` |
| Repaired plan | `b172e2e2cd74` | 2026-11-25T04:03:42.673Z | 2026-11-25T04:08:30.058Z | `v2-dev-plan-dual.json` |
| #55 | `f2cb55e711c0` | 2026-11-25T04:08:42.315Z | 2026-11-25T04:11:41.993Z | `v2-dev-55-dual.json` |
| #58 | `45cc224b9391` | 2026-11-25T04:12:02.336Z | 2026-11-25T04:14:57.863Z | `v2-dev-58-dual.json` |
| #60 | `28f51b2ee86d` | 2026-11-25T04:15:05.048Z | 2026-11-25T04:18:19.764Z | `v2-dev-60-dual.json` |
| #50 | `3639b0d21bfe` | 2026-11-25T04:18:27.390Z | 2026-11-25T04:21:46.050Z | `v2-dev-50-dual.json` |
| #59 | `0db09d202b4a` | 2026-11-25T04:22:06.744Z | 2026-11-25T04:25:29.135Z | `v2-dev-59-dual.json` |
| #47 | `cbdd9bce2947` | 2026-11-25T04:27:38.077Z | 2026-11-25T04:31:23.051Z | `v2-dev-47-dual.json` |
| #23 | `215f6267be6b` | 2026-11-25T04:31:38.485Z | 2026-11-25T04:35:04.901Z | `v2-dev-23-dual.json` |
| #57 | `5619639626f7` | 2026-11-25T04:35:12.496Z | 2026-11-25T04:38:48.099Z | `v2-dev-57-dual.json` |
| #47 filtered | `44c300a4bc60` | 2026-11-25T04:55:41.794Z | 2026-11-25T05:00:49.851Z | `v2-dev-47-filtered.json` |
| #57 filtered | `5306a36c5506` | 2026-11-25T05:01:32.204Z | 2026-11-25T05:07:10.271Z | `v2-dev-57-filtered.json` |

### Recorded flag settings

| Step | Explicit settings |
| --- | --- |
| Wave 1 | `MOHASSAN_SMALL_TALK_MANNERS=1` `MOHASSAN_CONVERSATION_REVIEW_APPLY=1` `MOHASSAN_CONVERSATION_SHADOW=decide` `MOHASSAN_STRUCTURED_MEMORY=1` `MOHASSAN_EXTRACTIVE_WRITING=1` |
| Repaired plan | `MOHASSAN_SMALL_TALK_MANNERS=1` `MOHASSAN_CONVERSATION_REVIEW_APPLY=1` `MOHASSAN_CONVERSATION_SHADOW=decide` `MOHASSAN_STRUCTURED_MEMORY=1` `MOHASSAN_EXTRACTIVE_WRITING=1` `MOHASSAN_PLAN_COMPILER=on` |
| #55 | `MOHASSAN_SMALL_TALK_MANNERS=1` `MOHASSAN_CONVERSATION_REVIEW_APPLY=1` `MOHASSAN_CONVERSATION_SHADOW=decide` `MOHASSAN_STRUCTURED_MEMORY=1` `MOHASSAN_EXTRACTIVE_WRITING=1` `MOHASSAN_PLAN_COMPILER=on` `DELIBERATION_BENCH_ENABLED=1` |
| #58 | `MOHASSAN_SMALL_TALK_MANNERS=1` `MOHASSAN_CONVERSATION_REVIEW_APPLY=1` `MOHASSAN_CONVERSATION_SHADOW=decide` `MOHASSAN_STRUCTURED_MEMORY=1` `MOHASSAN_EXTRACTIVE_WRITING=1` `MOHASSAN_PLAN_COMPILER=on` |
| #60 | `MOHASSAN_SMALL_TALK_MANNERS=1` `MOHASSAN_CONVERSATION_REVIEW_APPLY=1` `MOHASSAN_CONVERSATION_SHADOW=decide` `MOHASSAN_STRUCTURED_MEMORY=1` `MOHASSAN_EXTRACTIVE_WRITING=1` `MOHASSAN_PLAN_COMPILER=on` `MOHASSAN_REASONING=1` |
| #50 | `MOHASSAN_SMALL_TALK_MANNERS=1` `MOHASSAN_CONVERSATION_REVIEW_APPLY=1` `MOHASSAN_CONVERSATION_SHADOW=decide` `MOHASSAN_STRUCTURED_MEMORY=1` `MOHASSAN_EXTRACTIVE_WRITING=1` `MOHASSAN_PLAN_COMPILER=on` `MOHASSAN_REASONING=1` |
| #59 | `MOHASSAN_SMALL_TALK_MANNERS=1` `MOHASSAN_CONVERSATION_REVIEW_APPLY=1` `MOHASSAN_CONVERSATION_SHADOW=decide` `MOHASSAN_STRUCTURED_MEMORY=1` `MOHASSAN_EXTRACTIVE_WRITING=1` `MOHASSAN_PLAN_COMPILER=on` `MOHASSAN_REASONING=1` `MOHASSAN_CLARIFY_CHOICES=1` |
| #47 | `MOHASSAN_SMALL_TALK_MANNERS=1` `MOHASSAN_CONVERSATION_REVIEW_APPLY=1` `MOHASSAN_CONVERSATION_SHADOW=decide` `MOHASSAN_STRUCTURED_MEMORY=1` `MOHASSAN_EXTRACTIVE_WRITING=1` `MOHASSAN_PLAN_COMPILER=on` `MOHASSAN_REASONING=1` `MOHASSAN_CLARIFY_CHOICES=1` `MOHASSAN_SCRATCH_CLASSIFIERS=1` |
| #23 | `MOHASSAN_SMALL_TALK_MANNERS=1` `MOHASSAN_CONVERSATION_REVIEW_APPLY=1` `MOHASSAN_CONVERSATION_SHADOW=decide` `MOHASSAN_STRUCTURED_MEMORY=1` `MOHASSAN_EXTRACTIVE_WRITING=1` `MOHASSAN_PLAN_COMPILER=on` `MOHASSAN_REASONING=1` `MOHASSAN_CLARIFY_CHOICES=1` `MOHASSAN_SCRATCH_CLASSIFIERS=1` `MOHASSAN_ARABIC_UNDERSTANDING=1` |
| #57 | `MOHASSAN_SMALL_TALK_MANNERS=1` `MOHASSAN_CONVERSATION_REVIEW_APPLY=1` `MOHASSAN_CONVERSATION_SHADOW=decide` `MOHASSAN_STRUCTURED_MEMORY=1` `MOHASSAN_EXTRACTIVE_WRITING=1` `MOHASSAN_PLAN_COMPILER=on` `MOHASSAN_REASONING=1` `MOHASSAN_CLARIFY_CHOICES=1` `MOHASSAN_SCRATCH_CLASSIFIERS=1` `MOHASSAN_REFUSAL_POLICY=1` |
| #47 filtered | `MOHASSAN_SMALL_TALK_MANNERS=1` `MOHASSAN_CONVERSATION_REVIEW_APPLY=1` `MOHASSAN_CONVERSATION_SHADOW=decide` `MOHASSAN_STRUCTURED_MEMORY=1` `MOHASSAN_EXTRACTIVE_WRITING=1` `MOHASSAN_PLAN_COMPILER=on` `MOHASSAN_REASONING=1` `MOHASSAN_CLARIFY_CHOICES=1` `MOHASSAN_SCRATCH_CLASSIFIERS=1` |
| #57 filtered | `MOHASSAN_SMALL_TALK_MANNERS=1` `MOHASSAN_CONVERSATION_REVIEW_APPLY=1` `MOHASSAN_CONVERSATION_SHADOW=decide` `MOHASSAN_STRUCTURED_MEMORY=1` `MOHASSAN_EXTRACTIVE_WRITING=1` `MOHASSAN_PLAN_COMPILER=on` `MOHASSAN_REASONING=1` `MOHASSAN_CLARIFY_CHOICES=1` `MOHASSAN_SCRATCH_CLASSIFIERS=1` `MOHASSAN_REFUSAL_POLICY=1` |

## Sealed acceptance

Both sealed evaluations ran once on `1c33e42a6f7d518a35cb38fb15211ff92b85b078` with these settings.

`MOHASSAN_SMALL_TALK_MANNERS=1` `MOHASSAN_CONVERSATION_REVIEW_APPLY=1` `MOHASSAN_CONVERSATION_SHADOW=decide` `MOHASSAN_STRUCTURED_MEMORY=1` `MOHASSAN_EXTRACTIVE_WRITING=1` `MOHASSAN_PLAN_COMPILER=on` `MOHASSAN_REASONING=1` `MOHASSAN_CLARIFY_CHOICES=1` `MOHASSAN_SCRATCH_CLASSIFIERS=1` `MOHASSAN_REFUSAL_POLICY=1`

V1 started at `2026-11-25T05:10:08.924Z` and finished at `2026-11-25T05:11:51.301Z`. V2 started at `2026-11-25T05:10:07.812Z` and finished at `2026-11-25T05:19:25.048Z`. Both exited 0.
The ordinary development pass included in the v1 sealed invocation reproduced the final development counts in every area and both languages.

## V1 sealed

| Group | Passed |
| --- | ---: |
| **All** | 26/60 |
| calculation | 3/4 |
| clarification | 1/4 |
| coding | 0/4 |
| comparison | 0/4 |
| desktop | 3/4 |
| document-file | 1/4 |
| explanation | 1/4 |
| factual | 3/6 |
| follow-up | 3/4 |
| google-ads | 0/4 |
| memory | 2/4 |
| multi-step | 5/6 |
| refusal | 2/4 |
| small-talk | 2/4 |
| Language / ar | 13/30 |
| Language / en | 13/30 |

Compared with the published wave 1 sealed counts, multi-step went from 0/6 to 5/6 and refusal from 1/4 to 2/4. Factual stayed at 3/6 and follow-up at 3/4. Clarification and document/file each fell from 2/4 to 1/4. Candidate decisions were frozen using development results before this run. [Wave 1 sealed counts](https://github.com/ahmadalwakai/Mohassan-AI/blob/93066fbb0984643110404372d5e32d3da3f324d2/docs/INTEGRATION-WAVE-1-2026-11-25.md)

## V2 sealed

| Group | Passed |
| --- | ---: |
| **All** | 387/1200 |
| calculation | 0/110 |
| clarification | 0/17 |
| coding | 0/85 |
| comparison | 40/70 |
| factual | 204/515 |
| follow-up | 0/95 |
| refusal | 133/258 |
| small-talk | 10/50 |
| Language / ar | 257/600 |
| Language / en | 130/600 |

### V2 sealed by area and language

| Area | ar | en |
| --- | ---: | ---: |
| calculation | — | 0/110 |
| clarification | 0/2 | 0/15 |
| coding | — | 0/85 |
| comparison | 20/35 | 20/35 |
| factual | 171/425 | 33/90 |
| follow-up | — | 0/95 |
| refusal | 66/138 | 67/120 |
| small-talk | — | 10/50 |

Compared with the published `c2a0ff7` baseline, v2 sealed gained 140 passes. Refusal contributed 133, small-talk six and factual one. Arabic gained 66 and English gained 74. V2 follow-up stayed at 0/95. [V2 baseline results](https://github.com/ahmadalwakai/Mohassan-AI/blob/a130b239d9e6d2b1f6728128019d24bb26e9293f/docs/CAPABILITY-BENCH-V2-2026-11-25.md)

## Integration decisions and conflicts

- **Plan #52 on #24.** Reversing the wave 1 revert restored the already merged stack. The existing dispatcher and run-ledger hooks merged automatically. The repairs were made in the plan modules and their tests.
- **Deliberation #55 on #37.** Kept the manners import and the incoming contract import in `routing-decision.ts`. Its early intake returned clarification cards before the established follow-up, writing, memory and compiled-plan handlers could use their evidence. In the repeat, v1 follow-up fell 18→9, explanation 8→2, memory 16→13 and multi-step 18→15. The v2 development score held at 508/2,400. Its revert restored the previous tree.
- **Documents #58.** Git merged the branch without unmerged paths. The native document reader introduces a read variant in `DocumentTask`. The plan PDF tool now accepts create and edit variants explicitly and leaves standalone reads to the native document reader. A focused compiler test protects the read/write boundary.
- **Calculation #60 on #26.** Resolved `hands.ts` by preserving the existing source-bound page selection and adding reasoning for eligible reads. The reasoning path still checks the bound page before producing an answer. Existing lexical and computation tests and the plan compatibility tests exercise both paths.
- **Comparison #50 on #26.** Resolved `reasoning/index.ts` by applying the calculation branch's compound-input guard before the new previous-turn comparison and the existing reasoning chain. The two candidates share one rollout control.
- **Factual #54 on #25.** The earlier v1-only trial gained three factual passes and lost four follow-up passes. Stricter selection left some first-turn searches partial, so their next turns lost the confirmed page and fell back to search. That trial was reverted before the update, and the stack is absent from the dual-gate branch. The independent v2 study reported −174 overall and −137 factual for the original tip. [Branch measurement study](https://github.com/ahmadalwakai/Mohassan-AI/pull/63)
- **Clarification #59 on #32.** Combined the `hands.ts` and routing imports, kept native reasoning in the fallback predicate, and preserved both ingress hooks in the dispatcher. The unheld clarification host calls the same structured-memory filter before parsing the input or falling back to the underlying send method. The focused test verifies same-run resume and that a sensitive memory request stays redacted after the wrapper takes over.
- **Scratch classifiers #47.** Combined the routing imports, reason codes and the existing dispatcher predicates. The first resolution put the new route entry point inside the clarification interface. Both benchmark launches exited at the transform step before any measurement. The corrected merge preserves the interface and puts the entry point at module scope. PR #63 reported 24 factual and 10 comparison losses for the original branch. The active classifier now defers to an already ready public lookup with a validated query. Injected wrong refusal, small-talk and news predictions exercise the three former takeover paths, and the fallback refusal remains covered. The dual trial kept all 508 previous v2 passing cases and added 57.
- **Arabic understanding #23.** Preserved wave 1 conversation-state options and passed the canonical understanding to the legacy adapter. Joined the request-scope and routing helpers and retained the original reasoning context in the dispatcher. The trial used the source-quoted regression tests and excluded its separate 448-case agent-authored evaluation fixture. Several Arabic initial or follow-up lookups selected queries the fixture source could not serve. One comparison went from local computation to unsupported, one clarification moved from a waiting card to search, and one refusal selected memory with a different reply. Five v1 areas lost passes, so the branch was reverted even though v2 development gained 19.

- **Refusal #57 on #39.** Combined the app factory and clarification imports, placed the worker refusal check before plan admission, and preserved the page-read checks after refusal in `hands.ts`. Joined the routing imports and reason codes, and kept the existing wave 1 identity assertion in `mind-limits.test.ts`. The v1 refusal count rose from 4/16 to 16/16 and the v2 development refusal count rose from 54/375 to 156/375. Other areas held.

## Migrations and rollout defaults

| Order | Ledger entry | Location |
| --- | --- | --- |
| Wave 1 reviewer | `035_chat_conversation_review` | `packages/database/src/index.ts` |
| Wave 1 memory | `036_structured_memory` | `apps/server/src/assistant/structured-memory-migration.ts` |

`c2a0ff7` ends at prefix 034. Wave 2 adds zero migrations. The inherited entries may need renumbering at merge if the eventual target has allocated either number.

Product rollout controls are opt-in. The development and sealed wrapper commands set their selected flags in the evaluation process. The documents branch uses the existing native dispatch and introduces no selector.

| Behavior | Setting used in the final run | Unset behavior |
| --- | --- | --- |
| Manners | `MOHASSAN_SMALL_TALK_MANNERS=1` | Legacy replies |
| Reviewer application | `MOHASSAN_CONVERSATION_REVIEW_APPLY=1` | No application of reviewer edits |
| Follow-up decisions | `MOHASSAN_CONVERSATION_SHADOW=decide` | Legacy decisions, with existing non-production shadow observation |
| Structured memory | `MOHASSAN_STRUCTURED_MEMORY=1` | Legacy memory behavior |
| Extractive writing | `MOHASSAN_EXTRACTIVE_WRITING=1` | Legacy writing |
| Plan execution | `MOHASSAN_PLAN_COMPILER=on` | Off |
| Calculation and comparison reasoning | `MOHASSAN_REASONING=1` | Legacy reasoning |
| Clarification choices | `MOHASSAN_CLARIFY_CHOICES=1` | Legacy clarification |
| Scratch routing decisions | `MOHASSAN_SCRATCH_CLASSIFIERS=1` | Observe predictions without selecting them |
| Refusal enforcement | `MOHASSAN_REFUSAL_POLICY=1` | Observe the policy without enforcement |

### Classifier overlap remediation

PR #70 found substantial post-fit test overlap and zero shared native source IDs during fitting or model selection for #47 and #57. Its published clean sealed sensitivity retained +87 of +88 net passes for the earlier #47 weights across 1,169 cases and +94 of +94 for the earlier #57 weights across 1,198 cases. The audit published an exclusion registry with 3,600 source IDs and 4,484 distinct normalized-text hashes. These are upstream audit aggregates from the earlier standalone revisions. [PR #70](https://github.com/ahmadalwakai/Mohassan-AI/pull/70)

The refreshed #47 tip `5127e5672152` applies the registry at native ingestion before deduplication. It passes the original CLINC150 split and index, native MASSIVE IDs, and both model-visible CANARD questions with their dialogue/question IDs. The upstream retraining excluded 6,281 native rows and prepared 64,595 examples. Two runs produced seven byte-identical artifacts. The integration preserves ready public lookups, including nominal lookups, when the learned classifier proposes refusal. The refreshed upstream test used a ready nominal lookup to exercise learned refusal, so the integration asserts the public lookup behavior there. Existing tests exercise the learned refusal on unresolved fallback requests. [PR #47](https://github.com/ahmadalwakai/Mohassan-AI/pull/47) · [Retraining report](https://github.com/ahmadalwakai/Mohassan-AI/blob/5127e5672152128ea83d70d2c5ef0a7eb66febfa/packages/scratch-classifiers/V2-RETRAINING.md)

The refreshed #57 tip `d6aa9125b625` uses the same registry at native CLINC150, Aya and MASSIVE ingestion before split assignment and deduplication. It excluded 213 rows, comprising 197 CLINC150 test rows, 12 CLINC150 out-of-scope test rows, and four MASSIVE Arabic test rows. Upstream found no registry matches in a second scan of all 10,168 retained rows. Two retrains reproduced the model, metrics and test export byte for byte. Both branches report exclusion manifest SHA-256 `de192bdc7203e1aa24fa06b216d3976f4ea77ec103e085a4019af7a60c2f3054`. [PR #57](https://github.com/ahmadalwakai/Mohassan-AI/pull/57)

### Filtered development reruns

The earlier #47 trial used feature tip `76b1a93`, which contains the original trainer and weights at `9fac92c`. The earlier #57 trial used feature tip `f1ea533` with the earlier #47 stack. The refreshed #57 trial includes the refreshed #47 stack. Each pair of v1 and v2-dev receipts identifies the same integration commit. The area gate compares the refreshed #47 with the retained #59 step, and the refreshed #57 with the refreshed #47 step.

| Candidate | Development split | Earlier integration | Filtered integration | Per-area changes from earlier integration | Earlier ar / en | Filtered ar / en |
| --- | --- | ---: | ---: | --- | --- | --- |
| #47 | v1 | 164/240 | 164/240 | All counts matched | 81/120 / 83/120 | 81/120 / 83/120 |
| #47 | v2-dev | 565/2400 | 565/2400 | All counts matched | 449/1200 / 116/1200 | 449/1200 / 116/1200 |
| #57 | v1 | 176/240 | 176/240 | All counts matched | 85/120 / 91/120 | 85/120 / 91/120 |
| #57 | v2-dev | 667/2400 | 667/2400 | All counts matched | 485/1200 / 182/1200 | 485/1200 / 182/1200 |

- Refreshed #47 passed the per-area gate on both splits. v1 overall 161/240 → 164/240 with refusal 1/16 → 4/16. v2-dev overall 508/2400 → 565/2400 with refusal 0/375 → 54/375, small-talk 15/68 → 18/68.
- Refreshed #57 passed the per-area gate on both splits. v1 overall 164/240 → 176/240 with refusal 4/16 → 16/16. v2-dev overall 565/2400 → 667/2400 with refusal 54/375 → 156/375.

| Candidate | Development split | Earlier integration commit | Filtered integration commit | Filtered start UTC | Filtered finish UTC | Filtered receipt |
| --- | --- | --- | --- | --- | --- | --- |
| #47 | v1 | `cbdd9bce2947` | `44c300a4bc60` | 2026-11-25T04:58:10.935Z | 2026-11-25T05:00:40.411Z | `dev-47-filtered.json` |
| #47 | v2-dev | `cbdd9bce2947` | `44c300a4bc60` | 2026-11-25T04:55:41.794Z | 2026-11-25T05:00:49.851Z | `v2-dev-47-filtered.json` |
| #57 | v1 | `5619639626f7` | `5306a36c5506` | 2026-11-25T05:01:25.398Z | 2026-11-25T05:04:41.459Z | `dev-57-filtered.json` |
| #57 | v2-dev | `5619639626f7` | `5306a36c5506` | 2026-11-25T05:01:32.204Z | 2026-11-25T05:07:10.271Z | `v2-dev-57-filtered.json` |

## Merge notes

Wave 2 has no added or renumbered migration IDs. Wave 1 retains `035_chat_conversation_review` and `036_structured_memory`, with `035_structured_memory` still accepted as the legacy ID. The platform review at `43352a8` reserves prefixes 037–040. The inherited agent IDs may need renumbering if the eventual merge target has assigned them elsewhere. [Platform ledger](https://github.com/ahmadalwakai/Mohassan-AI/blob/43352a8d2d2961869a99b56c028dc38a956ef364/docs/MIGRATION-LEDGER-2026-11-25.md)

### Existing held files

| Path | Wave 2 added | Wave 2 removed | Wave 2 changed | Since c2a0ff7 added | Since c2a0ff7 removed | Since c2a0ff7 changed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `apps/server/src/app.ts` | 5 | 3 | 8 | 8 | 4 | 12 |
| `apps/server/src/assistant/agent-run.ts` | 3 | 3 | 6 | 3 | 3 | 6 |
| `apps/server/src/assistant/brain.ts` | 0 | 0 | 0 | 1 | 0 | 1 |
| `apps/server/src/command-chat.ts` | 30 | 7 | 37 | 54 | 12 | 66 |
| `apps/web/components/assistant-app.tsx` | 0 | 0 | 0 | 0 | 0 | 0 |
| `apps/web/components/markdown.tsx` | 0 | 0 | 0 | 5 | 2 | 7 |
| `apps/web/components/run-status.tsx` | 0 | 0 | 0 | 0 | 0 | 0 |

### Files added beside held files in wave 1

| Path | Wave 2 added | Wave 2 removed | Wave 2 changed | Since c2a0ff7 added | Since c2a0ff7 removed | Since c2a0ff7 changed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `apps/web/components/markdown-table.module.css` | 0 | 0 | 0 | 32 | 0 | 32 |
| `apps/web/components/markdown-table.tsx` | 0 | 0 | 0 | 86 | 0 | 86 |

### Files added beside held files in wave 2

None.

### New files beside held files introduced only during trials

| Path | Wave 2 added | Wave 2 removed | Wave 2 changed | Since c2a0ff7 added | Since c2a0ff7 removed | Since c2a0ff7 changed |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `apps/web/components/run-deliberation.tsx` | 0 | 0 | 0 | 0 | 0 | 0 |

### Pinned execution paths

None.

## Benchmark commands

The local orchestration commands ran from a checkout of the product commit in each receipt. `step` identifies the receipt and `flags` contains the settings shown above. The candidate trials used the paired launcher with eight v2 development workers. The wave 1 reference and plan repair had separate preflight launches before the paired launcher was used for the candidate chain.

```bash
/workspace/work/wave2-benchmark/score-both "$step" "${flags[@]}"
python /workspace/work/wave2-benchmark/gate-both.py "$previous" "$step"
/workspace/work/wave2-run-seals
```

The launchers mounted the pinned runner and payload temporarily. The working directories contained the product under test and its workspace dependencies. The effective runner commands used the shown environment settings, the installed local Chromium and fresh receipt paths.

```bash
# V1 development
node --import tsx scripts/agent-capability-bench/run.ts --output "$v1_dev_receipt"
# V2 development with isolated workers
node --import tsx scripts/agent-capability-bench/run.ts --v2-dev --output "$v2_dev_receipt" --workers 8
# V1 final, including the ordinary development pass emitted by the same invocation
node --import tsx scripts/agent-capability-bench/run.ts --output "$v1_final_receipt" --sealed "$sealed_v1_file"
# V2 final, the `assistant:capability-bench` package script body from the release
node --import tsx scripts/agent-capability-bench/run.ts --version 2 \
  --sealed tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output "$v2_final_receipt"
```

The v2 final command uses the serial runner at `a130b239d9e6d2b1f6728128019d24bb26e9293f` and its released hash checks and aggregate receipt procedure. Running the script body directly allowed the temporary overlay to leave the product's tracked `package.json` untouched. The observer adapters wired up the retained review, memory and clarification behaviors. [V2 sealed README](https://github.com/ahmadalwakai/Mohassan-AI/blob/a130b239d9e6d2b1f6728128019d24bb26e9293f/tests/fixtures/agent-capability-bench/v2/sealed/README.md)

## Earlier development attempts

| Attempt | V1 overall | V1 factual | V1 follow-up | V1 multi-step | V1 comparison | V2 dev overall | V2 dev factual |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| First plan repair at `e59b103` | 120/240 | 10/18 | 18/18 | 18/18 | 0/18 | — | — |
| Single-source comparison repair at `09e288c` | 121/240 | 10/18 | 18/18 | 18/18 | 1/18 | 502/2,400 | 464/1,244 |
| Factual #54 trial at `84df253` | 148/240 | 13/18 | 14/18 | 18/18 | 11/18 | — | — |

The first v1-only trials of #55, #58, #60 and #50 gave overall counts of 103, 132, 139 and 149 out of 240. The corresponding dual trials reproduced every v1 area count. The updated plan was measured on both splits before those candidates were reconsidered. The facts trial used the original heuristic weights and excluded the separate 232-question agent-authored replay; PR #63 evaluated the original upstream tip.

## Verification commands and observed failures

The isolated dependency installation and Chromium setup succeeded with the workspace-local cache and browser paths.

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --cache /workspace/work/wave2-npm-cache --no-audit --no-fund
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave2-chromium npm exec -- playwright install chromium
```

The first `npm ci --no-audit --no-fund` exited 254 because the sandbox could not create `/home/agent/.npm/_cacache`. The first combined plan test invocation without `PLAYWRIGHT_BROWSERS_PATH` failed five PDF assertions. Restoring the Chromium path passed 80 plan tests, and the later weak-boundary repair passed 85 across six plan files in its isolated checkout.

The first combined calculation/comparison and factual typechecks failed because the document parser added `DocumentReadTask` to the union the old plan PDF tool assumed was writable. The explicit create/edit narrowing fixed the type errors. The retained calculation commit passed `env -i PATH="$PATH" TZ=UTC nice -n 10 npm run typecheck`.

The revived plan, documents, reasoning/comparison, clarification and refusal leakage guards discovered the same two inherited small-talk occurrences from wave 1. The integrated checks compare against the original source revision, exact line hashes or original per-pattern counts. They still detect extra copies. The combined clarification test initially asserted conversation status instead of the completed worker's run status. The updated test asserts the new blocked run and verifies the sensitive value is absent from the returned and stored messages. The four focused suites passed 43/43 after those test repairs.

The initial #47 merge resolution placed a route function inside an interface, causing both development launches to exit 1 before creating a report. The amended merge passed the module import check and both development invocations. The integrated classifier and routing tests passed 39/39. A shell wrapper changed during its own #55 invocation and returned a trailing parsing error after both child runs returned 0. The two complete receipts passed the commit, fixture and count checks used for the gate.

The earlier plan, documents, clarification and classifier verification commands were run from their named commits or isolated checkouts with the following exact invocations. The development artifacts stayed in `/workspace/work/wave2-benchmark`.

<details>
<summary>Focused commands</summary>

```bash
env -i PATH="$PATH" TZ=UTC npm test -- tests/assistant-plan-compiler.test.ts tests/assistant-plan-chat.test.ts
env -i PATH="$PATH" TZ=UTC PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave2-chromium npm test -- --maxWorkers=2 --reporter=dot tests/assistant-plan-{compiler,executor,tools,web-tools,chat,source-computation}.test.ts
env -i PATH="$PATH" TZ=UTC PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave2-chromium npm test -- --maxWorkers=2 --reporter=default tests/assistant-plan-{compiler,executor,tools,web-tools,chat,source-computation}.test.ts
env -i PATH="$PATH" TZ=UTC PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave2-chromium npm test -- --maxWorkers=2 --reporter=dot tests/assistant-documents-chat.test.ts tests/assistant-documents.test.ts tests/assistant-inline-data-file.test.ts tests/assistant-local-knowledge-chat.test.ts tests/assistant-local-knowledge.test.ts
env -i PATH="$PATH" TZ=UTC npm test -- --reporter=dot tests/assistant-plan-compiler.test.ts -t 'local document read'
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave2-chromium nice -n 10 /workspace/work/wave2-benchmark/overlay checks -- --maxWorkers=2 --reporter=dot --disableConsoleIntercept tests/assistant-clarify-choices-chat.test.ts tests/assistant-structured-memory-chat.test.ts tests/assistant-hands-open-read.test.ts tests/agent-capability-source-guard.test.ts
env -i PATH="$PATH" TZ=UTC nice -n 10 npm test -- --maxWorkers=2 --reporter=dot tests/assistant-scratch-decisions.test.ts tests/assistant-routing-decision.test.ts
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s packages/scratch-classifiers -p test_prepare_data.py -v
(cd packages/scratch-classifiers && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest training.test_linear -v)
```

The documents command passed 90 tests, the focused document compatibility command passed one with 22 filtered out, and the two Python commands passed six and five respectively.

</details>

## Final verification

The sealed candidate is `1c33e42a6f7d518a35cb38fb15211ff92b85b078`. Its production paths are identical to the final paired development commit `5306a36`. The intervening changes affect test fixtures and assertions. The later review changes add this report and reconcile an inherited leakage-test reference. They leave the evaluated product paths byte-for-byte identical.

```bash
env -i PATH="$PATH" TZ=UTC npm run typecheck
env -i PATH="$PATH" TZ=UTC PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave2-chromium npm test -- --maxWorkers=1 --reporter=verbose --disableConsoleIntercept tests/assistant-scratch-decisions.test.ts tests/assistant-refusal-learned.test.ts tests/assistant-refusal-chat.test.ts
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s packages/scratch-classifiers -p 'test_prepare_data.py' -v
(cd packages/scratch-classifiers && PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest training.test_linear -v)
PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s scripts/refusal-classifier -p 'test_train.py' -v
```

Root and web typecheck exited 0. The classifier and refusal suites passed 42/42, and the Python checks passed 12/12 for preparation, 5/5 for linear training, and 3/3 for refusal preparation. The pre-reconciliation classifier suite passed 41 and failed one. The upstream expectation let a learned refusal override a nominal ready search. The reconciled assertion checks the stricter guard used in the two development runs, while the unresolved-fallback tests still check learned refusal.

The first browser safety check on wave 1 and on the original combined candidate intermittently failed with `AGENT_NAVIGATION_FAILED` and HTTP 502 during the iframe fixture navigation. This occurred before the assertion on navigation authorization. The fixture now waits for the blocked background request and checks its zero side effects before exercising iframe navigation in a fresh conversation. Both focused reruns of `tests/assistant-safety.test.ts` passed all 44 tests. The browser route implementation stayed outside the integration diff.

```bash
env -i PATH="$PATH" TZ=UTC PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave2-chromium npm test -- --maxWorkers=1 --reporter=default --disableConsoleIntercept --retry=0 tests/assistant-safety.test.ts
```

The earlier affected-suite precheck ran at `133cc99` with four workers while development benchmark processes were active. It exited 1 with 5,682 tests passed, 21 failed and 18 skipped across 279 files. Nineteen tests and two suite setup hooks exceeded deadlines between 20 and 60 seconds. The browser fixture failed once as described above. The classifier wall-clock assertion measured 8.261 ms p95 for long inputs against its 2 ms bound in that run. The separate active follow-up check, typecheck and scope checks exited 0.

```bash
nice -n 10 /workspace/work/verify-wave2 precheck
env -i PATH="$PATH" TZ=UTC PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave2-chromium npm test -- --reporter=verbose --disableConsoleIntercept tests/assistant-memory-publication-freshness-audit.test.ts -t 'does not complete calculation-status with'
```

The separately sampled memory freshness assertion passed in 29.49 seconds with its original 60-second subprocess deadline.

### Capability source checks

The first opt-in v1 sealed source guard found one occurrence compared with its older reference. A path-only check identified `tests/conversation-state-page.test.ts`, whose blob `0ad6b04b4ad8cbf7c641b9c0dd824d3197c52a9b` is identical in wave 1 and wave 2. The existing source-test helper now pins the wave 1 revision for that file. The guard compares occurrence counts and still rejects additional copies. The source scans inspected no case text for analysis and used no scoring or runtime tuning.

```bash
git diff --exit-code 93066fb 1c33e42 -- tests/conversation-state-page.test.ts
env -i PATH="$PATH" TZ=UTC MOHASSAN_CAPABILITY_GUARD_SEALED=1 nice -n 10 npm test -- --maxWorkers=1 --reporter=default tests/assistant-capability-overfitting.test.ts
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave2-chromium nice -n 10 /workspace/work/wave2-benchmark/overlay checks -- --maxWorkers=1 --reporter=verbose --disableConsoleIntercept tests/agent-capability-leakage.test.ts tests/agent-capability-source-guard.test.ts tests/assistant-capability-overfitting.test.ts tests/assistant-refusal-benchmark-isolation.test.ts tests/capability-prompt-leak.test.ts tests/comparison-corpus-isolation.test.ts
```

The unchanged-file check exited 0. The isolated source guard with the temporary v1 sealed file passed both active checks and skipped the development check. The six-suite run with the v1 development fixture passed 12 checks, with the sealed-only check disabled for that invocation. The two benchmark evaluations ran once each.

### Full affected verification

The 291-file affected-suite rerun is in progress on the frozen product `1c33e42`. It runs with three workers after the benchmark processes exited. This draft will record the exact exit and counts when the suite finishes.

```bash
WAVE2_VITEST_WORKERS=3 /workspace/work/verify-wave2 final
```
