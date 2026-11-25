# Integration wave 3 · 25 November 2026

The draft targets `integration/wave-2` for review. The starting commit is `ee22b23041284a801f50f5930a875565c6f11785`, the tip fetched from origin. Its production tree matches the wave 2 sealed candidate `1c33e42a6f7d518a35cb38fb15211ff92b85b078`. During the run, wave 2 advanced to `3c429a0e68f2c23b4dbb301225ba8be0ecd0ade7`, which changes only its report. [Wave 2 report](./INTEGRATION-WAVE-2-2026-11-25.md)

The first integration pass is recorded below. [Follow-up results](#follow-up-integration)

## Measurement

Each candidate was fetched from `pull/<n>/head`. I read its PR description before the trial and matched its GitHub head to the fetched SHA. The five trialed PRs each published final standalone v2 development tables and one sealed result. Each integration trial used both development splits and was compared with the most recent retained tree. The gate checks each area and each language independently. It requires the frozen case identities in release order and matching denominators, recomputes the scorer summaries, and verifies the trial commit and lockfile across both receipts.

The v1 runner, scorer, manifest and development payload are pinned to #22 at `a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f`. The v2 development and sealed bundles and exclusion registry are pinned to #70 at `a1e1cb020b7ba093885edbf501149e7b8252c0cb`. They match the original development and sealed fixture trees at `12cedfe592aab40cdd47ee00d05ea86a6d2bae89` and `a130b239d9e6d2b1f6728128019d24bb26e9293f`, respectively. The v2 development payload SHA-256 is `6eda0e7052611d10fc87da4e3e8f3f30cfb64452c198eab20041b5da577508d1`. [V1 runner](https://github.com/ahmadalwakai/Mohassan-AI/pull/22) · [V2 audit](https://github.com/ahmadalwakai/Mohassan-AI/pull/70)

The detached scratch checkouts use temporary PGlite and fixture tool ports. The #41 adapters wire reviewer publication and structured memory in both versions, and clarification for v2 and the v1 sealed invocation. Eight isolated Node workers assign v2 development cases by index modulo eight, validate the published bundle and emit private receipts. The coordinator verifies source commit, manifest, receipt hashes, exact case coverage and ordering, then invokes the published scorer summary. V2 sealed uses the published serial runner. Runner files and payloads remain in scratch. [Observer adapters](https://github.com/ahmadalwakai/Mohassan-AI/pull/41)

The wave 2 flags were active for every trial.

```text
MOHASSAN_SMALL_TALK_MANNERS=1
MOHASSAN_CONVERSATION_REVIEW_APPLY=1
MOHASSAN_CONVERSATION_SHADOW=decide
MOHASSAN_STRUCTURED_MEMORY=1
MOHASSAN_EXTRACTIVE_WRITING=1
MOHASSAN_PLAN_COMPILER=on
MOHASSAN_REASONING=1
MOHASSAN_CLARIFY_CHOICES=1
MOHASSAN_SCRATCH_CLASSIFIERS=1
MOHASSAN_REFUSAL_POLICY=1
```

## Candidate decisions

| PR | Fetched head | Standalone v2 development | Standalone v2 sealed | Trial flag change |
| --- | --- | ---: | ---: | --- |
| [#74](https://github.com/ahmadalwakai/Mohassan-AI/pull/74) | `55450bbd9e1c6a8c2acffabddd6b00254c66c359` | 499 → 985/2,400 | 247 → 460/1,200 | None |
| [#77](https://github.com/ahmadalwakai/Mohassan-AI/pull/77) | `2698ce10d60ad5696cf1b8a6f48b1fd4d0d4eabe` | 499 → 561/2,400 | 247 → 291/1,200 | `TEST_DRIVEN_CODING_ENABLED=true` |
| [#72](https://github.com/ahmadalwakai/Mohassan-AI/pull/72) | `bd5008ae24087edebf653b06e56ff6b599c6ca09` | 499 → 535/2,400 | 247 → 274/1,200 | `MOHASSAN_SMALL_TALK_MANNERS=1` already active |
| [#71](https://github.com/ahmadalwakai/Mohassan-AI/pull/71) | `b470d2a8e5e16febe79ac071f478362f8efd29b2` | 499 → 545/2,400 | 247 → 263/1,200 | `MOHASSAN_QUESTION_REWRITER=1` |
| [#73](https://github.com/ahmadalwakai/Mohassan-AI/pull/73) | `ca50fd6a765058b1d3587d76f92d7c5472a8ebed` | 499 → 504/2,400 | 247 → 247/1,200 | None |

The standalone figures are upstream measurements. #74 reports that 342 of its 481 new factual development passes failed at baseline solely on a fixture miss (289 Arabic, 53 English). Its PR description contains no live check without replay. The #77 measurements predate `2698ce10`, which reduces the held hook and reports updated typecheck, Vitest and Python verification. #72 is stacked on #40 at `f50520112a23632ec4f6e4a121018077d1c422be`, already an ancestor of wave 2. The #71 standalone official runner used the rewriter flag's default off setting. The wave 3 trial enables the documented live pre-routing flag.

- **#74 reverted.** V2 improved by 486 passes to 1,153/2,400 and lost no area or language. V1 Arabic follow-up lost one pass. Follow-up fell from 18/18 to 17/18 and Arabic fell from 85/120 to 84/120. The receipt shows the two turns changing from completed public lookup to blocked clarification with one question per turn. The lost case then failed the route, question-count, required-content and run-status checks. Revert `e2570f147680a6953f82194bbd31f03d9970e121` restored the wave 2 tree `4bbd6eb8947c9d7e2f66e0c92629ae00e2258d1a`. `git diff --exit-code ee22b23041284a801f50f5930a875565c6f11785 e2570f147680a6953f82194bbd31f03d9970e121` exited 0.
- **#77 retained.** V1 stayed at 176/240 and reproduced all area and language counts. V2 coding improved from 0/155 to 61/155, giving 728/2,400 overall. The v2 English total rose from 182/1,200 to 243/1,200 and all other groups held. The Linux worker used the branch's existing default-deny seccomp, limits and fail-closed path. The isolated worker tests verified file, network and child-process denial and failure when seccomp is unavailable.
- **#72 retained.** V1 stayed at 176/240 in every group. V2 rose from 728 to 756/2,400. Clarification went from 0 to 9/9, covering both Arabic cases and all seven English cases. English small talk went from 18 to 36/68. One previously blocked coding case completed in the same route during this run, giving 62/155. The coding modules are byte-identical to the #77 trial.
- **#71 reverted.** V1 held all groups at 176/240. V2 rose to 799/2,400 and added 46 follow-up passes, while coding fell from 62/155 to 59/155. The three English losses reached the same private `local_coding` handler and finished blocked, failing required-content and run-status checks. They showed longer turn latencies, from approximately 769, 338 and 529 ms to 890, 1,347 and 1,423 ms respectively. The receipts give no verifier exit reason, so they establish failed verification outcomes and no routing change. The verifier code and limits were identical to the previous step. Revert `efb723eee1899ae8d1340db5afb875fceea588f9` restored the #72 tree `7504e070c9ad744349c05833b3cc444ec381ba84`. `git diff --exit-code a33146f45e31d6a32b0313bda086533b3f7f5ad7 efb723eee1899ae8d1340db5afb875fceea588f9` exited 0.
- **#73 reverted.** V1 held all groups at 176/240. V2 calculation rose from 0 to 5/277, but coding fell from 62/155 to 61/155. That English case reached the same private `local_coding` handler and finished blocked, failing required-content and run-status checks. The receipt gives no verifier exit reason. The verifier code and limits were identical to the last retained step. Revert `982917699b493705dd7529177f2250b648f0c1b3` restored the #72 tree `7504e070c9ad744349c05833b3cc444ec381ba84`. `git diff --exit-code a33146f45e31d6a32b0313bda086533b3f7f5ad7 982917699b493705dd7529177f2250b648f0c1b3` exited 0.

#71 was reached and merged for its trial at 06:01:37 UTC with the fetched rule-only head `b470d2a8e5e16febe79ac071f478362f8efd29b2`. GitHub records the first learned-model commit `b480cda33309fec0f2d68b730f68693d03f1e443` at 06:08:16 UTC, and the later observed head `8305ab4abca14ec35a7091070d90784ccf4db77b` at 06:12:27 UTC. Both follow the trial. The current PR description still identifies the rule-only commit as its standalone measured revision. [PR #71](https://github.com/ahmadalwakai/Mohassan-AI/pull/71)

### Not ready in the initial pass

| Candidate | Fetched head | Development reported upstream | Readiness |
| --- | --- | --- | --- |
| [#79](https://github.com/ahmadalwakai/Mohassan-AI/pull/79), `e2e/refusal-recall-v2` | `892308680c8c2780c750137cb33460cfe4c0fcea` | V1 176/240 unchanged. V2 667 → 809/2,400, refusal 156 → 298/375 with zero losses. 0/881 allowed public held-out requests refused. | Description reported that its serial sealed run was in progress when reached. No integration trial. |

The #79 head descends from wave 2's `3c429a0` and the diff contains only refusal implementation and tests. I fetched it after the first five trials, when the sixth candidate was added. Its readiness check left the frozen tree intact.

## V1 development

| Group | Wave 2 re-run | #74 | #77 | #72 | #71 | #73 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **All** | 176/240 | 175/240 | 176/240 | 176/240 | 176/240 | 176/240 |
| calculation | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| clarification | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 |
| coding | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 |
| comparison | 11/18 | 11/18 | 11/18 | 11/18 | 11/18 | 11/18 |
| desktop | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 |
| document-file | 16/18 | 16/18 | 16/18 | 16/18 | 16/18 | 16/18 |
| explanation | 8/18 | 8/18 | 8/18 | 8/18 | 8/18 | 8/18 |
| factual | 10/18 | 10/18 | 10/18 | 10/18 | 10/18 | 10/18 |
| follow-up | 18/18 | 17/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| google-ads | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 |
| memory | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 |
| multi-step | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| refusal | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 |
| small-talk | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| Language / ar | 85/120 | 84/120 | 85/120 | 85/120 | 85/120 | 85/120 |
| Language / en | 91/120 | 91/120 | 91/120 | 91/120 | 91/120 | 91/120 |

### Run receipts

| Step | Product commit | Started UTC | Finished UTC | Receipt | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Wave 2 re-run | `ee22b23041284a801f50f5930a875565c6f11785` | 2026-11-25T05:44:42.134Z | 2026-11-25T05:46:12.515Z | `wave2-v1-development.json` | `868acce46695445561259c736f4fdca887ac3c1f8462656d3f2fda17d8924c94` |
| #74 | `dd91657612de8c593ffaf1624e8476435d288a2f` | 2026-11-25T05:48:23.446Z | 2026-11-25T05:50:14.761Z | `pr74-v1-development.json` | `1f2359ccd4af2d0e91b27c2a43bbb228e8438a97a014a9c23d23959ee6ac69e6` |
| #77 | `1e509eeeffccbda37f0db78153eca59d291d93f9` | 2026-11-25T05:52:21.235Z | 2026-11-25T05:53:54.248Z | `pr77-v1-development.json` | `a597a071d726b3d4b02ab9166ec27a05cc6dfb50a6311734d8b8ce9358ebee48` |
| #72 | `a33146f45e31d6a32b0313bda086533b3f7f5ad7` | 2026-11-25T05:56:35.311Z | 2026-11-25T05:58:13.322Z | `pr72-v1-development.json` | `8d3f99cf6dcaa0c8c2a37a3a64ac256d9c831227684387d0346fe27cde44afc8` |
| #71 | `b6e3037e5e00d38080244fbd2113f180668cd9b5` | 2026-11-25T06:02:19.202Z | 2026-11-25T06:03:54.381Z | `pr71-v1-development.json` | `bd6d9cde25b7eb935a1e2110288fbc55f32592811ed5b049b7f1ac2e98e1745b` |
| #73 | `484ca551a25bad0ecb5dadee2417ca85914b156b` | 2026-11-25T06:07:12.765Z | 2026-11-25T06:08:48.362Z | `pr73-v1-development.json` | `708fbc88ecbb97104ac6dab9cd1d76564cb769e49b2340d5b900cfe21fa6a19a` |

## V2 development

| Group | Wave 2 re-run | #74 | #77 | #72 | #71 | #73 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **All** | 667/2,400 | 1,153/2,400 | 728/2,400 | 756/2,400 | 799/2,400 | 760/2,400 |
| calculation | 0/277 | 0/277 | 0/277 | 0/277 | 0/277 | 5/277 |
| clarification | 0/9 | 0/9 | 0/9 | 9/9 | 9/9 | 9/9 |
| coding | 0/155 | 0/155 | 61/155 | 62/155 | 59/155 | 61/155 |
| comparison | 23/32 | 28/32 | 23/32 | 23/32 | 23/32 | 23/32 |
| factual | 470/1,244 | 951/1,244 | 470/1,244 | 470/1,244 | 470/1,244 | 470/1,244 |
| follow-up | 0/240 | 0/240 | 0/240 | 0/240 | 46/240 | 0/240 |
| refusal | 156/375 | 156/375 | 156/375 | 156/375 | 156/375 | 156/375 |
| small-talk | 18/68 | 18/68 | 18/68 | 36/68 | 36/68 | 36/68 |
| Language / ar | 485/1,200 | 896/1,200 | 485/1,200 | 487/1,200 | 487/1,200 | 487/1,200 |
| Language / en | 182/1,200 | 257/1,200 | 243/1,200 | 269/1,200 | 312/1,200 | 273/1,200 |

### Run receipts

| Step | Product commit | Started UTC | Finished UTC | Receipt | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Wave 2 re-run | `ee22b23041284a801f50f5930a875565c6f11785` | 2026-11-25T05:44:42.194Z | 2026-11-25T05:47:47.331Z | `wave2-v2-development.json` | `dd27c355f73e93ced847c8aab7c82c9152291df12aae95c49958c090877f0cd5` |
| #74 | `dd91657612de8c593ffaf1624e8476435d288a2f` | 2026-11-25T05:48:23.361Z | 2026-11-25T05:51:08.975Z | `pr74-v2-development.json` | `24049a2a44e8579c508f355507b8aae373f5ad8aead419924011e46437f03f6e` |
| #77 | `1e509eeeffccbda37f0db78153eca59d291d93f9` | 2026-11-25T05:52:21.123Z | 2026-11-25T05:55:37.675Z | `pr77-v2-development.json` | `300d0980e828905765d5ccebadae02d5bbc32c8c3e4eac50326e85e49d9d5f9c` |
| #72 | `a33146f45e31d6a32b0313bda086533b3f7f5ad7` | 2026-11-25T05:56:35.656Z | 2026-11-25T06:00:06.915Z | `pr72-v2-development.json` | `7ebd40cce300661ae8ee7e5c366959adfe810ec7c61be00ababa89b973e4c014` |
| #71 | `b6e3037e5e00d38080244fbd2113f180668cd9b5` | 2026-11-25T06:02:18.892Z | 2026-11-25T06:05:38.670Z | `pr71-v2-development.json` | `f003261c6f47714840256572a5b4d575db51c217eedae9e8a77a8874fa167bed` |
| #73 | `484ca551a25bad0ecb5dadee2417ca85914b156b` | 2026-11-25T06:07:12.635Z | 2026-11-25T06:10:41.493Z | `pr73-v2-development.json` | `908713d9e5d80cc70e2e2c89e5463d96749f00601968f30c839f5747bbeb3d7c` |

## Frozen commit and sealed method

Both sealed invocations ran once on `6c9307c31db9d71533927477ec62ba6f58566a5d`. The final settings are the ten wave 2 flags with `TEST_DRIVEN_CODING_ENABLED=true`. The frozen product matches the #72 trial. The intervening source-guard commit changes only a Python test.

The v1 manifest pins the 60-case holdout SHA-256 to `9be281fe111c7af2e60163080ca044d54cf09d361d4d45a14b7a3a81d152df2c`. The v2 manifest pins the 1,200-case release SHA-256 to `6ab7dac41ba54eccf0a48fd0958eada651e0c0fcb3a1156913bd6b9fdb25abbf`. The launcher used one start marker for each split. V2 ran serially within its own process and emitted an aggregate receipt. Both commands exited 0. The ordinary development split embedded in the v1 invocation reproduced the final development counts overall, by area, by language and by area within language.

```bash
source /workspace/work/wave3-bench/wave2-flags.sh
/workspace/work/wave3-bench/run sealed final 6c9307c31db9d71533927477ec62ba6f58566a5d "${wave2_flags[@]}" TEST_DRIVEN_CODING_ENABLED=true
python3 -B /workspace/work/wave3-bench/check-seals.py
```

The v1 runner received `--output "$v1_receipt" --sealed tests/fixtures/agent-capability-bench/holdout/sealed.json`. The unchanged v2 release CLI at `a130b239d9e6d2b1f6728128019d24bb26e9293f` received `--version 2 --sealed tests/fixtures/agent-capability-bench/v2/sealed/payload.json --output "$v2_receipt"`. Only the published startup adapters adjusted the observers.

## V1 sealed

| Group | Wave 3 frozen |
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

| Step | Product commit | Started UTC | Finished UTC | Receipt | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Wave 3 frozen | `6c9307c31db9d71533927477ec62ba6f58566a5d` | 2026-11-25T06:14:25.936Z | 2026-11-25T06:15:27.808Z | `final-v1-sealed.json` | `9dbf8f89a8290780de0a3d64391f15f9e19f7d2ddc46aa96c5693999f6b85612` |

## V2 sealed

| Group | Wave 3 frozen |
| --- | ---: |
| **All** | 452/1,200 |
| calculation | 0/110 |
| clarification | 11/17 |
| coding | 43/85 |
| comparison | 40/70 |
| factual | 204/515 |
| follow-up | 0/95 |
| refusal | 133/258 |
| small-talk | 21/50 |
| Language / ar | 259/600 |
| Language / en | 193/600 |

| Step | Product commit | Started UTC | Finished UTC | Receipt | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Wave 3 frozen | `6c9307c31db9d71533927477ec62ba6f58566a5d` | 2026-11-25T06:14:26.095Z | 2026-11-25T06:22:25.441Z | `final-v2-sealed.json` | `1a7ccacd3a0c11194b77c7028ebb7d67107294b84fb400531304f0bd3d335ff2` |

V1 matched wave 2 in every area and language. V2 gained 65 passes over the wave 2 result of 387/1,200. Coding contributed 43, clarification 11 and small talk 11.

## Merge notes

- **#74, trial only.** `hands.ts` kept wave 2 reasoning and refusal imports with #74 evidence reading. The line-selection conflict kept wave 2's short factual statements and used #74's expanded digit detector. `request-scope.ts` kept knowledge-document routing and the existing explanatory-question form alongside the new factual-question syntax and coreference checks. Added a focused test covering a short sourced statement and a date in Persian numerals. The candidate touched no held files.
- **#77.** `.env.example` kept the review and extractive-writing entries and added the default-off Python flag. `routing-decision.ts` kept wave 2 request constraints, scratch routing, refusal review and inline-data writing. It added the private `local_coding` route with the account and capability checks. The inline-data route still runs before the coding parser. `run-plans.ts` supplies the direct coding handler.
- **#72.** `routing-decision.ts` kept inline-data handling and #77's coding handler before everyday clarification. The merged `command-chat.ts` keeps the earlier request, adds the clarification pause immediately before the existing extractive-writing hook, and preserves both the previous user goal and prior-turn count in the routing input.
- **#71, trial only.** `request-context.ts` and `request-scope.ts` kept the knowledge-document paths and imported the supplied-rewrite parser. `routing-decision.ts` retained the wave 2 refusal and scratch reasons, #77's coding handler and #72's history input while adding `rewritten_question`. The ingress wrapper passes both history inputs. It preserves the original admission refusal and #72's missing-zone clarification. The worker keeps its refusal review before the short-circuit completion hook. Rewritten-query selection lives in the new chat-rewrite module.
- **#73, trial only.** `calculator.ts` kept the new exact rational evaluator and wave 2's numeric `ArithmeticStep` evidence. The shared parser emits the existing ordered steps for numeric binary operators and percentages. `chat-supervision.ts` kept wave 2's knowledge and memory criteria and took the equivalent grouped computation condition. The new `word-problem-chat.ts` handles abstention before any successful computation evidence is logged. The retained computation reasoning and memory paths still precede the candidate fallback.

### Held-file hunks

Every row is in `apps/server/src/command-chat.ts`. The line is the start of the hunk in its trial merge commit. The revert commits apply the inverse of each reverted trial's hunks.

| Trial | Line | Added / removed | Hook |
| --- | ---: | ---: | --- |
| #77 | 90 | 1 / 0 | Import verified coding reply and hash binding. |
| #77 | 2082 | 3 / 0 | Dispatch the verified coding reply after refusal and action-ledger checks. |
| #77 | 4099 | 1 / 0 | Bind the accepted assertion text before the run insert. |
| #72 | 52 | 1 / 0 | Import everyday clarification. |
| #72 | 2351 | 3 / 0 | Ask for missing information before extractive writing. |
| #72 | 4047 | 1 / 1 | Add `previousTurns` to admission routing while keeping `previousUserTurn`. |
| #71, reverted | 87 | 1 / 1 | Import the question-rewrite entry points. |
| #71, reverted | 2018 | 2 / 0 | Complete a supplied rewrite after the worker refusal check. |
| #71, reverted | 2887 | 1 / 1 | Select the provenance-checked rewritten question through the new module. |
| #71, reverted | 4049 | 1 / 1 | Route admission through the rewrite wrapper with both history inputs. |
| #73, reverted | 47 | 1 / 0 | Import the abstention completion hook. |
| #73, reverted | 2775 | 2 / 0 | Finish an abstention as blocked before recording calculation evidence. |

The final held-file diff contains six hunks, with ten added lines and one removed line. The largest hook adds three lines. The protected execution paths and the benchmark paths were absent from the product diff. The platform ledger at `ef54ec49b2c54e17321f0037064fb7b1dcce3dff` ends at `040_member_data_rights`. This wave adds no database migration or legacy ID. [Platform migration ledger](https://github.com/ahmadalwakai/Mohassan-AI/blob/ef54ec49b2c54e17321f0037064fb7b1dcce3dff/docs/MIGRATION-LEDGER-2026-11-25.md)

## Benchmark commands

Commands ran in `/workspace/work/Mohassan-AI` against the commits shown in the receipts. The launcher clears the environment and supplies `PATH`, `HOME`, `TZ=UTC`, the pinned Chromium path and the listed flags. Node was `v24.22.3`. The Chromium release was Playwright `1248`, build `156.0.8078.4`.

```bash
source /workspace/work/wave3-bench/wave2-flags.sh
/workspace/work/wave3-bench/run development wave2 ee22b23041284a801f50f5930a875565c6f11785 "${wave2_flags[@]}"
/workspace/work/wave3-bench/run development pr74 dd91657612de8c593ffaf1624e8476435d288a2f "${wave2_flags[@]}"
/workspace/work/wave3-bench/run development pr77 1e509eeeffccbda37f0db78153eca59d291d93f9 "${wave2_flags[@]}" TEST_DRIVEN_CODING_ENABLED=true
/workspace/work/wave3-bench/run development pr72 a33146f45e31d6a32b0313bda086533b3f7f5ad7 "${wave2_flags[@]}" TEST_DRIVEN_CODING_ENABLED=true
/workspace/work/wave3-bench/run development pr71 b6e3037e5e00d38080244fbd2113f180668cd9b5 "${wave2_flags[@]}" TEST_DRIVEN_CODING_ENABLED=true MOHASSAN_QUESTION_REWRITER=1
/workspace/work/wave3-bench/run development pr73 484ca551a25bad0ecb5dadee2417ca85914b156b "${wave2_flags[@]}" TEST_DRIVEN_CODING_ENABLED=true
```

The flag file supplies the ten wave 2 assignments listed above and exports `PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave3-chromium`. Both development split runners exited 0 in each completed pair. The launchers pass `--no-wasm-tier-up --no-wasm-dynamic-tiering --import tsx` to Node. The v1 development invocation is `scripts/agent-capability-bench/run.ts --output "$receipt"`. The v2 development coordinator invokes the release CLI with `--v2-dev --output "$worker_receipt"`, adapting only case scheduling and observer wiring.

The same comparison command checked the receipt pairs in the order `wave2 → pr74`, `wave2 → pr77`, `pr77 → pr72`, `pr72 → pr71`, `pr72 → pr73`. The `previous_commit` and `current_commit` arguments are the product SHAs in the receipt tables.

```bash
bench=/workspace/work/wave3-bench
python3 -B "$bench/gate-both.py" \
  "$bench/receipts/$previous-v1-development.json" "$bench/receipts/$current-v1-development.json" \
  "$bench/receipts/$previous-v2-development.json" "$bench/receipts/$current-v2-development.json" \
  --previous-commit "$previous_commit" --current-commit "$current_commit" --json
```

The wave 2 calibration used the pinned v2 development archive. For each trial the scratch merge used `git merge-tree --write-tree HEAD refs/wave3/pr-70` and verified the selected benchmark paths against the #70 tree before materializing them. Product imports resolved in their own detached checkout.

## Verification

Root and web typecheck passed. The fourteen focused TypeScript suites passed 245 tests. Both Python suites passed ten tests each on the frozen tree with Python 3.12.14. They verify synthesis, subprocess isolation, resource limits, fail-closed startup, and denial of file, network and child-process operations.

```bash
npm run typecheck
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave3-chromium npm test -- \
  --maxWorkers=2 --fileParallelism --reporter=dot --disableConsoleIntercept \
  tests/assistant-test-driven-coding.test.ts tests/assistant-inline-data-file.test.ts \
  tests/assistant-refusal-chat.test.ts tests/assistant-routing-decision.test.ts \
  tests/assistant-user-fact-memory-chat.test.ts tests/assistant-user-fact-memory-verification-chat.test.ts \
  tests/run-plan-completeness-20261124.test.ts tests/assistant-manners-chat.test.ts \
  tests/assistant-manners-replies.test.ts tests/assistant-manners-detection.test.ts \
  tests/assistant-manners-development.test.ts tests/everyday-clarification.test.ts \
  tests/everyday-social.test.ts tests/assistant-clarify-choices-chat.test.ts
python3 -B tests/test_python_synthesis.py -v
python3 -B tests/test_test_driven_coding.py -v
```

The #74 trial also passed `npm run typecheck` and `npm test -- tests/assistant-factual-evidence.test.ts --reporter=dot --disableConsoleIntercept` (7/7). The first focused attempt scored 6/7 because the new test asked a date question that requires a number. I adjusted that test to exercise the short-statement path with a nonnumeric property before the trial. The #71 trial passed `PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave3-chromium npm test -- tests/question-rewrite-chat.test.ts tests/question-rewriter.test.ts --reporter=dot --disableConsoleIntercept` (15/15), including the new missing-zone assertion. The review identified that the existing live-search assertion shared mock calls across turns. That trial was reverted.

### V2 source guard

The original #74 guard exited 1 on the wave 2 calibration and the #74 trial. The retained #72 guard initially gave the same path and count results. The guards found seven inherited occurrences across five files. The flagged paths were byte-identical to wave 2.

| Inherited path | Occurrences |
| --- | ---: |
| `apps/server/src/assistant/review/language.ts` | 1 |
| `packages/scratch-classifiers/data/label-map.json` | 1 |
| `scripts/conversation-state/decision-eval.ts` | 2 |
| `tests/conversation-state-decides-chat.test.ts` | 2 |
| `tests/conversation-state-decisions.test.ts` | 1 |

Commit `6c9307c31db9d71533927477ec62ba6f58566a5d` pins those five paths to the exact wave 2 commit in the retained guard. Every other file still uses the upstream #40 baseline. Hash matching and occurrence-count comparison are unchanged. The reconciled guard passed 2/2. The independent #74 hash scan against wave 2 also passed 2/2. Both used the pinned v2 exclusion registry covering development and sealed. The scans reported paths and counts.

```bash
/workspace/work/wave3-bench/run guard trial74-guard dd91657612de8c593ffaf1624e8476435d288a2f
/workspace/work/wave3-bench/run guard wave2-guard ee22b23041284a801f50f5930a875565c6f11785
python3 -B -m unittest discover -s tests -p test_v2_source_leakage.py -v
/workspace/work/wave3-bench/run guard-relative final-relative 6c9307c31db9d71533927477ec62ba6f58566a5d \
  WAVE3_GUARD_BASELINE=ee22b23041284a801f50f5930a875565c6f11785
```

The first two commands exited 1 on the inherited paths. The direct unittest command exited 1 before the inherited-reference adjustment and 0 afterward. The last command exited 0. The path-limited `git diff --exit-code` from wave 2 over all five flagged files exited 0.

### Scope and setup

```bash
git diff --exit-code a33146f45e31d6a32b0313bda086533b3f7f5ad7 HEAD -- apps packages .env.example package.json package-lock.json
git diff --check ee22b23041284a801f50f5930a875565c6f11785 HEAD
python3 -B /workspace/work/wave3-bench/check-scope.py ee22b23041284a801f50f5930a875565c6f11785 HEAD
```

All three scope commands exited 0. The workspace-local dependency and browser installs also exited 0.

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --cache /workspace/work/wave3-npm-cache --no-audit --no-fund
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave3-chromium npm exec -- playwright install chromium
```

The initial `npm ci --no-audit --no-fund` exited 254 because its default cache could not be created. Its overlapping retry hit a transient `ENOTEMPTY` and exited 217. The workspace-cache command succeeded after the first process exited.

The remaining deployment check is whether the production image supplies Linux Python and libseccomp. #74's public measurement still has no live result outside replay. The #79 sealed result was pending at its readiness check.

## Follow-up integration

The follow-up starts from the pushed wave 3 tip, `cb385a13cf8f2bb4e8902f308a2558c41801ab82`. It uses the same frozen development inputs and no-loss gate. The five earlier trial scores and the initial sealed receipts above remain the record of the first Wave 3 pass.

### Coding verification under load

`768bb1b5f0014aabfcacd3dd8d77c4a06573423f` added bounded verifier reasons to the persisted run state and benchmark receipts. A receipt can report the failure or exit category, whether candidate enumeration reached its time or count budget, and whether example extraction timed out. The worker results exclude assertion text and code from the diagnostic fields.

The earlier transitions reduce to three distinct English coding cases. The same case accounts for the #77 → #72 recovery and the #73 loss. The first replay on the instrumentation commit passed all three serially and in the ordinary eight-worker v2 replay. The latter matched the retained v2 development total of 756/2,400 and coding 62/155. Those ordinary-load runs did not reproduce the intermittent losses.

Under the controlled two-CPU stress run, eight independent clients replayed the same three cases. Before repair, 11/24 passed and all 13 blocked attempts reported `assertion-failed` together with `search-wall-time`. The assertion failure came from a diagnostic fallback after the enumeration deadline expired. The timer charged elapsed time while the process was descheduled.

`2680598ea65e6592e2fbf48a0d244a340181df01` changes the enumeration budget from 0.5 seconds elapsed to 0.5 seconds of process CPU. The 2.5-second parent wall timeout, hard 3-second CPU cap, 75 ms attempt deadline, search-count bounds, default-deny seccomp, AST restrictions, and memory and output limits still apply. The change adds no retries. The new focused tests exercise an off-CPU delay and verify that the CPU budget still reports exhaustion. The earlier receipts lacked these diagnostic fields, so they do not establish the cause of each original block.

The same two-CPU stress workload passed 23/24 after repair. No attempt hit the enumeration wall deadline. The single blocked attempt reported `worker-wall-time` at the unchanged process boundary. The comparison uses amplified contention to reproduce the failure mechanism.

| Replay | Commit | Results | Started UTC | Finished UTC | Receipt SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Original serial | `768bb1b` | 3/3 | 06:29:45.648 | 06:29:52.591 | `bd76d5689641015bb30df36adf5aa7938a1645b5021e930090c06209047b4f07` |
| Original eight-worker v2 | `768bb1b` | 3/3 targets, 756/2,400 overall | 06:29:55.335 | 06:33:21.470 | `08166ebddf9b4afd9f149f28d45d29deb0d86764af35d9558823089fc4e5a1dd` |
| Original two-CPU stress | `768bb1b` | 11/24 | 06:35:19.341 | 06:36:09.366 | `d1f9dfa95ff461743a7b55f878b6a05a0a044097fc3e50c805043fed8f47395b` |
| CPU-budget repair two-CPU stress | `2680598` | 23/24 | 06:37:03.643 | 06:37:51.113 | `3294ddd510f84ca65a2618efb409b1a1fb90d41714e9f90234bcc740ecb78ef3` |

```bash
/workspace/work/wave3-followup/target-run targeted pre-fix 768bb1b5f0014aabfcacd3dd8d77c4a06573423f
taskset -c 0,1 /workspace/work/wave3-followup/target-run stress pre-fix-stress 768bb1b5f0014aabfcacd3dd8d77c4a06573423f
taskset -c 0,1 /workspace/work/wave3-followup/target-run stress repaired-stress 2680598ea65e6592e2fbf48a0d244a340181df01
```

All three commands exited 0. Each stress receipt reports 24 attempts rather than unique benchmark cases. The launchers retain the normal wave 3 flags and use private detached checkouts and scratch receipts under `/workspace/work/wave3-followup/target-receipts/`.

The focused verifier tests also exposed a mislabeled synchronous launch failure and an assertion-reason expectation. `91709243b958ad92aaa21afd29debf108ecf872a` distinguishes process startup from temporary workspace setup and tests the unsupported-assertion category. It preserves every timer and the measured CPU-budget repair.

The CPU-only repair on `9170924` passed all three original targets in serial and parallel. Its full paired run encountered one different English coding case that hit `search-cpu-time`. V2 coding scored 61/155 and English fell to 268/1,200, so the baseline comparison exited 1 despite v1 holding at 176/240.

`da6c3168dd519e3d3e90973f923cb283f0415232` permits one retry after a classified search CPU timeout, using the remaining portion of the original 2.5-second worker deadline. Both attempts use the same isolated launch checks and stay in the same concurrency slot. The verifier reports the final outcome and the search limit behind a recovered retry. Tests cover the shared deadline, a failed second attempt, a genuine assertion failure, and a worker stopped at the hard wall timeout.

```bash
/workspace/work/wave3-followup/target-run serial repaired-serial 91709243b958ad92aaa21afd29debf108ecf872a
/workspace/work/wave3-followup/target-run full repaired 91709243b958ad92aaa21afd29debf108ecf872a
/workspace/work/wave3-followup/gate initial repaired a33146f45e31d6a32b0313bda086533b3f7f5ad7 91709243b958ad92aaa21afd29debf108ecf872a
```

The repaired serial receipt is `repaired-serial/v2-target-serial.json`, SHA-256 `056ec1d966e5dbc6df9a45335914832b12b5c17ef05a2871b191e0598ff2977e` (06:39:57.767 to 06:40:04.780 UTC). The paired v2 receipt is `repaired/v2-development.json`, SHA-256 `d45bfccf13e8e9438fa248f63b70a57631ac8e2f2e67b64add158912ce60d151` (06:40:32.800 to 06:44:02.567 UTC). The repaired launcher invocations exited 0. The comparison detected the coding loss.

### Arabic follow-up repair

The first #74 merge replaced the old factual-question opener matcher. In doing so it dropped `شنو`, an Iraqi Arabic interrogative recognized by wave 2. The initial question lost its public target, routed to clarification, and left no public topic for the next turn. `public-question-syntax.ts` restores the general opener. The new routing regression uses a different authored question and follow-up and verifies that both route to public lookup while carrying the topic.

Reapplying the measured head `55450bbd9e1c6a8c2acffabddd6b00254c66c359` over #71 produced one conflict in `request-scope.ts`. The resolution combines the supplied rewrite and factual-question imports. The automatic `request-context.ts` merge preserves the grammatical reference check and the private supplied rewrite. The restored source guard compares the exact known inherited contexts in five paths against wave 2 and keeps the original baseline for all other paths. The #74 PR head and description are unchanged since the initial readiness check. Its report still attributes 342 of 481 newly passing factual development cases solely to a baseline fixture miss and gives no live result without replay. [PR #74](https://github.com/ahmadalwakai/Mohassan-AI/pull/74)

### Candidate retries

- **#71 retained** at integration commit `84fedfe462105bb381fff1b89fe213172f7a7b11`. V1 remained 176/240. V2 gained 46 follow-up passes, from 0 to 46/240, while coding held at 62/155. The trial reapplies the original measured head `b470d2a8e5e16febe79ac071f478362f8efd29b2` by undoing its prior revert. At the retry, GitHub head `8305ab4abca14ec35a7091070d90784ccf4db77b` reported matching full development counts for the learned fallback and attributed its previous sealed run to `b470d2a`. The retry therefore exercised the previously measured rules-only revision. The test clears prior search calls before the measured follow-up.
- **#73 retained** at integration commit `52e237cbff4bb2b787b8d49883151895b58d2fb3`. V1 held every group at 176/240. V2 calculation rose from 0 to 5/277 and coding held at 62/155. The trial restores the measured `ca50fd6a765058b1d3587d76f92d7c5472a8ebed` merge. Its evidence test calls the raw calculator with its ASCII operator and enables percentages explicitly.
- **#74 retained** at integration commit `1b07da474e739cab0109b9e35469172311dc60f3`. V1 reproduced 176/240, 18/18 follow-up and 85/120 Arabic. V2 rose by 486 to 1,293/2,400, with factual at 951/1,244 and comparison at 28/32. Both groups improved and every other area held.
- **#79 retained** at merge `9684a31e2644d9f13db9f0e2d579cc0ef0264bf7`. Its fetched head `892308680c8c2780c750137cb33460cfe4c0fcea` now reports one completed sealed run, 387 → 455/1,200 and refusal 133 → 201/258, with receipt SHA-256 `94ac02f4b34b1f75a1f540c026d5cefefdd82bb89738dc13590f30fa37747f9b`. Those are upstream figures. That report also measured zero refusals across its 881 allowed public held-out requests. The integration merge is clean and adds no flag. Its v1 development result stayed 176/240. V2 refusal rose 156 → 298/375 and v2 overall reached 1,435/2,400. Every area and language held. [PR #79](https://github.com/ahmadalwakai/Mohassan-AI/pull/79)

The bounded retry baseline and each of the four candidate trials passed the same paired comparison. The follow-up retains both original candidates #77 and #72.

### Follow-up v1 development

| Group | Retained #72 | CPU-budget trial | Verifier repair | #71 retry | #73 retry | #74 repair | #79 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **All** | 176/240 | 176/240 | 176/240 | 176/240 | 176/240 | 176/240 | 176/240 |
| calculation | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| clarification | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 |
| coding | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 |
| comparison | 11/18 | 11/18 | 11/18 | 11/18 | 11/18 | 11/18 | 11/18 |
| desktop | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 |
| document-file | 16/18 | 16/18 | 16/18 | 16/18 | 16/18 | 16/18 | 16/18 |
| explanation | 8/18 | 8/18 | 8/18 | 8/18 | 8/18 | 8/18 | 8/18 |
| factual | 10/18 | 10/18 | 10/18 | 10/18 | 10/18 | 10/18 | 10/18 |
| follow-up | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| google-ads | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 |
| memory | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 |
| multi-step | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| refusal | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 | 16/16 |
| small-talk | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |
| Language / ar | 85/120 | 85/120 | 85/120 | 85/120 | 85/120 | 85/120 | 85/120 |
| Language / en | 91/120 | 91/120 | 91/120 | 91/120 | 91/120 | 91/120 | 91/120 |

| Step | Commit | Started UTC | Finished UTC | Receipt | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Retained #72 | `a33146f45e31d6a32b0313bda086533b3f7f5ad7` | 2026-11-25T05:56:35.311Z | 2026-11-25T05:58:13.322Z | `wave3-bench/receipts/pr72-v1-development.json` | `8d3f99cf6dcaa0c8c2a37a3a64ac256d9c831227684387d0346fe27cde44afc8` |
| CPU-budget trial | `91709243b958ad92aaa21afd29debf108ecf872a` | 2026-11-25T06:40:32.543Z | 2026-11-25T06:42:07.288Z | `repaired/v1-development.json` | `17805b4b4af3a04fa344820ac98c2015acda960cedf2da2de1c1090f10a0296d` |
| Verifier repair | `da6c3168dd519e3d3e90973f923cb283f0415232` | 2026-11-25T06:47:41.326Z | 2026-11-25T06:49:18.963Z | `stable/v1-development.json` | `8e938518531d88d2aacce7039d8c1b1530cb6b2ff81d0383a85a4ce43d40c76e` |
| #71 retry | `84fedfe462105bb381fff1b89fe213172f7a7b11` | 2026-11-25T06:52:43.610Z | 2026-11-25T06:54:19.515Z | `retry71/v1-development.json` | `8ff09933b38942d232f2bf80763ed9e03e0734a54a3978c0b3d7efd0ecc75eb9` |
| #73 retry | `52e237cbff4bb2b787b8d49883151895b58d2fb3` | 2026-11-25T06:57:34.938Z | 2026-11-25T06:59:09.637Z | `retry73/v1-development.json` | `f1ec50d6f5beaefaac4d16494c13458172e08120059add431d4076002b9b2220` |
| #74 repair | `1b07da474e739cab0109b9e35469172311dc60f3` | 2026-11-25T07:02:20.641Z | 2026-11-25T07:04:21.818Z | `retry74/v1-development.json` | `2cc63678c04c8478979ce61557a24070cb1547ef63234583bc49426cbd185611` |
| #79 | `9684a31e2644d9f13db9f0e2d579cc0ef0264bf7` | 2026-11-25T07:06:47.921Z | 2026-11-25T07:08:47.241Z | `retry79/v1-development.json` | `eb7bbf37283dd81bb0e5e629ebab21d237d2429eeee42edc410d12134477a40a` |

### Follow-up v2 development

| Group | Retained #72 | CPU-budget trial | Verifier repair | #71 retry | #73 retry | #74 repair | #79 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **All** | 756/2,400 | 755/2,400 | 756/2,400 | 802/2,400 | 807/2,400 | 1,293/2,400 | 1,435/2,400 |
| calculation | 0/277 | 0/277 | 0/277 | 0/277 | 5/277 | 5/277 | 5/277 |
| clarification | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 | 9/9 |
| coding | 62/155 | 61/155 | 62/155 | 62/155 | 62/155 | 62/155 | 62/155 |
| comparison | 23/32 | 23/32 | 23/32 | 23/32 | 23/32 | 28/32 | 28/32 |
| factual | 470/1,244 | 470/1,244 | 470/1,244 | 470/1,244 | 470/1,244 | 951/1,244 | 951/1,244 |
| follow-up | 0/240 | 0/240 | 0/240 | 46/240 | 46/240 | 46/240 | 46/240 |
| refusal | 156/375 | 156/375 | 156/375 | 156/375 | 156/375 | 156/375 | 298/375 |
| small-talk | 36/68 | 36/68 | 36/68 | 36/68 | 36/68 | 36/68 | 36/68 |
| Language / ar | 487/1,200 | 487/1,200 | 487/1,200 | 487/1,200 | 487/1,200 | 898/1,200 | 952/1,200 |
| Language / en | 269/1,200 | 268/1,200 | 269/1,200 | 315/1,200 | 320/1,200 | 395/1,200 | 483/1,200 |

| Step | Commit | Started UTC | Finished UTC | Receipt | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Retained #72 | `a33146f45e31d6a32b0313bda086533b3f7f5ad7` | 2026-11-25T05:56:35.656Z | 2026-11-25T06:00:06.915Z | `wave3-bench/receipts/pr72-v2-development.json` | `7ebd40cce300661ae8ee7e5c366959adfe810ec7c61be00ababa89b973e4c014` |
| CPU-budget trial | `91709243b958ad92aaa21afd29debf108ecf872a` | 2026-11-25T06:40:32.800Z | 2026-11-25T06:44:02.567Z | `repaired/v2-development.json` | `d45bfccf13e8e9438fa248f63b70a57631ac8e2f2e67b64add158912ce60d151` |
| Verifier repair | `da6c3168dd519e3d3e90973f923cb283f0415232` | 2026-11-25T06:47:40.993Z | 2026-11-25T06:51:28.233Z | `stable/v2-development.json` | `c29efdba01bb3bca7e94cf46c1d6d1483b42d54c734e675e29288dc2fbb81a1b` |
| #71 retry | `84fedfe462105bb381fff1b89fe213172f7a7b11` | 2026-11-25T06:52:43.549Z | 2026-11-25T06:56:16.549Z | `retry71/v2-development.json` | `58bf52f5600df85ac522cf440017f5d1cf712ecf37de6a280eed2c8449eba487` |
| #73 retry | `52e237cbff4bb2b787b8d49883151895b58d2fb3` | 2026-11-25T06:57:34.842Z | 2026-11-25T07:00:56.172Z | `retry73/v2-development.json` | `76b9d22e65692a7dce395f8c1f36c040d80c293dc06be5d12cb4e63297bd6ba7` |
| #74 repair | `1b07da474e739cab0109b9e35469172311dc60f3` | 2026-11-25T07:02:20.687Z | 2026-11-25T07:05:21.889Z | `retry74/v2-development.json` | `645a444e9fadb9b32d7f0fbed1af7ce40bbe9457f0ebdb1d38b57b5027adef3a` |
| #79 | `9684a31e2644d9f13db9f0e2d579cc0ef0264bf7` | 2026-11-25T07:06:47.722Z | 2026-11-25T07:09:47.727Z | `retry79/v2-development.json` | `99fab1e23b4451613e8fbea05a929266a563a9a6b254dd8f51c917baa991e165` |

### Follow-up benchmark commands

```bash
/workspace/work/wave3-followup/target-run full stable da6c3168dd519e3d3e90973f923cb283f0415232
/workspace/work/wave3-followup/gate initial stable a33146f45e31d6a32b0313bda086533b3f7f5ad7 da6c3168dd519e3d3e90973f923cb283f0415232
/workspace/work/wave3-followup/target-run full retry71 84fedfe462105bb381fff1b89fe213172f7a7b11 MOHASSAN_QUESTION_REWRITER=1
/workspace/work/wave3-followup/gate stable retry71 da6c3168dd519e3d3e90973f923cb283f0415232 84fedfe462105bb381fff1b89fe213172f7a7b11
/workspace/work/wave3-followup/target-run full retry73 52e237cbff4bb2b787b8d49883151895b58d2fb3 MOHASSAN_QUESTION_REWRITER=1
/workspace/work/wave3-followup/gate retry71 retry73 84fedfe462105bb381fff1b89fe213172f7a7b11 52e237cbff4bb2b787b8d49883151895b58d2fb3
/workspace/work/wave3-followup/target-run full retry74 1b07da474e739cab0109b9e35469172311dc60f3 MOHASSAN_QUESTION_REWRITER=1
/workspace/work/wave3-followup/gate retry73 retry74 52e237cbff4bb2b787b8d49883151895b58d2fb3 1b07da474e739cab0109b9e35469172311dc60f3
/workspace/work/wave3-followup/target-run full retry79 9684a31e2644d9f13db9f0e2d579cc0ef0264bf7 MOHASSAN_QUESTION_REWRITER=1
/workspace/work/wave3-followup/gate retry74 retry79 1b07da474e739cab0109b9e35469172311dc60f3 9684a31e2644d9f13db9f0e2d579cc0ef0264bf7
```

The launchers replay the fixed v1/v2 development files. The diagnostic overlay reads the bounded verifier fields and copies them into receipts. It preserves the published score checks and complete case order. The first gate accepts only the pinned diagnostic changes to the runner, observer and scorer fingerprints and verifies the exact earlier #72 receipts. Later gates require equal harness hashes. All paired steps retain the original wave 2 flags plus `TEST_DRIVEN_CODING_ENABLED=true`. `MOHASSAN_QUESTION_REWRITER=1` is active from the #71 retry onward.

### Current held-file hunks

The line numbers are relative to the follow-up product commit. Hunk sizes are additions and removals against the initial wave 2 base.

| File | Line | Added / removed | Hook |
| --- | ---: | ---: | --- |
| `apps/server/src/assistant/brain.ts` | 287 | 1 / 0 | Optional bounded host verifier receipt on run state. |
| `apps/server/src/command-chat.ts` | 47 | 1 / 0 | Import the arithmetic abstention helper. |
| `apps/server/src/command-chat.ts` | 53 | 1 / 0 | Import the everyday clarification helper. |
| `apps/server/src/command-chat.ts` | 88 | 1 / 1 | Import the supplied rewrite, search-plan and admission helpers. |
| `apps/server/src/command-chat.ts` | 92 | 1 / 0 | Import the coding reply, hash binder and receipt publisher. |
| `apps/server/src/command-chat.ts` | 2019 | 2 / 0 | Complete a supplied rewrite after the worker refusal check. |
| `apps/server/src/command-chat.ts` | 2086 | 4 / 0 | Dispatch verified coding after refusal and ledger checks and publish the result with its bounded receipt. |
| `apps/server/src/command-chat.ts` | 2355 | 3 / 0 | Ask a focused everyday clarification before extractive writing. |
| `apps/server/src/command-chat.ts` | 2778 | 2 / 0 | Finish an abstained word problem before recording computation evidence. |
| `apps/server/src/command-chat.ts` | 2891 | 1 / 1 | Select the provenance-checked contextual question for the Hands plan. |
| `apps/server/src/command-chat.ts` | 4053 | 1 / 1 | Route admission through the rewrite wrapper and retain both history inputs. |
| `apps/server/src/command-chat.ts` | 4109 | 1 / 0 | Bind the accepted coding request hash before inserting the run. |

Every hook fits the five-line limit. The final code adds no database migration, legacy ID, pinned execution change or benchmark payload.

### Follow-up verification

Root and web typecheck exited 0. The 38 selected affected suites passed all 999 TypeScript tests on the follow-up product commit. The verifier synthesis and isolation suites passed 12 and 10 Python tests respectively. The three guard suites passed seven tests across both hashed v2 partitions and the isolated source-guard unit cases.

```bash
npm run typecheck
/workspace/work/wave3-followup/affected-tests
python3 -B tests/test_python_synthesis.py -v
python3 -B tests/test_test_driven_coding.py -v
python3 -B -m unittest discover -s tests -p test_check_v2_case_text.py -v
python3 -B -m unittest discover -s tests -p test_v2_source_leakage.py -v
python3 -B -m unittest discover -s tests -p test_v2_case_strings.py -v
git diff --check ee22b23041284a801f50f5930a875565c6f11785 HEAD
python3 -B /workspace/work/wave3-followup/check-scope.py ee22b23041284a801f50f5930a875565c6f11785 HEAD
```

The affected-suite command expanded to the following invocation.

```bash
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave3-chromium npm test -- \
  --maxWorkers=2 --fileParallelism --reporter=dot --disableConsoleIntercept \
  tests/assistant-test-driven-coding.test.ts tests/assistant-test-driven-coding-retry.test.ts \
  tests/assistant-inline-data-file.test.ts tests/assistant-refusal-chat.test.ts \
  tests/assistant-routing-decision.test.ts tests/assistant-user-fact-memory-chat.test.ts \
  tests/assistant-user-fact-memory-verification-chat.test.ts tests/run-plan-completeness-20261124.test.ts \
  tests/assistant-manners-chat.test.ts tests/assistant-manners-replies.test.ts \
  tests/assistant-manners-detection.test.ts tests/assistant-manners-development.test.ts \
  tests/everyday-clarification.test.ts tests/everyday-social.test.ts \
  tests/assistant-clarify-choices-chat.test.ts tests/question-rewrite-chat.test.ts \
  tests/question-rewriter.test.ts tests/public-conversation-followup.test.ts \
  tests/assistant-word-problem-allocations.test.ts tests/assistant-word-problem-chat.test.ts \
  tests/assistant-word-problem-costs.test.ts tests/assistant-word-problem-graph.test.ts \
  tests/assistant-word-problem-relations.test.ts tests/assistant-word-problem-repeated-rates.test.ts \
  tests/assistant-word-problem.test.ts tests/assistant-calculator.test.ts \
  tests/assistant-arithmetic-agreement.test.ts tests/assistant-local-computation.test.ts \
  tests/assistant-local-computation-chat.test.ts tests/assistant-computation-memory-chat.test.ts \
  tests/assistant-chat-supervision.test.ts tests/assistant-factual-evidence.test.ts \
  tests/assistant-hands-page-choice.test.ts tests/assistant-hands-open-read.test.ts \
  tests/assistant-request-scope.test.ts tests/assistant-request-context.test.ts \
  tests/assistant-refusal-actions.test.ts tests/assistant-refusal-replies.test.ts
```

Focused checks run before the paired benchmarks also passed. The four commands below exited 0 with 12, 15, 77 and 178 tests respectively. The three refusal suites added a separate 92/92 passing run before the #79 trial.

```bash
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave3-chromium npm test -- tests/assistant-test-driven-coding-retry.test.ts tests/assistant-test-driven-coding.test.ts --reporter=dot --disableConsoleIntercept
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave3-chromium npm test -- tests/question-rewrite-chat.test.ts tests/question-rewriter.test.ts --reporter=dot --disableConsoleIntercept
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave3-chromium npm test -- tests/assistant-calculator.test.ts tests/assistant-word-problem-chat.test.ts --reporter=dot --disableConsoleIntercept
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave3-chromium npm test -- tests/assistant-routing-decision.test.ts tests/assistant-request-scope.test.ts tests/assistant-request-context.test.ts tests/assistant-factual-evidence.test.ts --reporter=dot --disableConsoleIntercept
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave3-chromium npm test -- tests/assistant-refusal-actions.test.ts tests/assistant-refusal-chat.test.ts tests/assistant-refusal-replies.test.ts --reporter=dot --disableConsoleIntercept
```


### Follow-up freeze and sealed runs

Each sealed split ran once for this follow-up on `9684a31e2644d9f13db9f0e2d579cc0ef0264bf7`. Both commands exited 0. V2 preserved serial scheduling and an aggregate-only receipt. The v1 invocation reproduced every retained development group. Both runs used the final development flags.

```bash
/workspace/work/wave3-followup/target-run sealed final 9684a31e2644d9f13db9f0e2d579cc0ef0264bf7 MOHASSAN_QUESTION_REWRITER=1
python3 -B /workspace/work/wave3-followup/check-seals.py --frozen 9684a31e2644d9f13db9f0e2d579cc0ef0264bf7 --retained-v1-development /workspace/work/wave3-followup/target-receipts/retry79/v1-development.json --final-step-dir /workspace/work/wave3-followup/target-receipts/final
```

### Follow-up v1 sealed

| Group | Follow-up freeze |
| --- | ---: |
| **All** | 27/60 |
| calculation | 3/4 |
| clarification | 1/4 |
| coding | 0/4 |
| comparison | 0/4 |
| desktop | 3/4 |
| document-file | 1/4 |
| explanation | 1/4 |
| factual | 4/6 |
| follow-up | 3/4 |
| google-ads | 0/4 |
| memory | 2/4 |
| multi-step | 5/6 |
| refusal | 2/4 |
| small-talk | 2/4 |
| Language / ar | 14/30 |
| Language / en | 13/30 |

| Step | Commit | Started UTC | Finished UTC | Receipt | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Follow-up freeze | `9684a31e2644d9f13db9f0e2d579cc0ef0264bf7` | 2026-11-25T07:15:38.454Z | 2026-11-25T07:16:47.101Z | `final/v1-sealed.json` | `a8d867d894a9451a5e67c518417e893d589bc23fe1193044e1228d12726b806a` |

### Follow-up v2 sealed

| Group | Follow-up freeze |
| --- | ---: |
| **All** | 748/1,200 |
| calculation | 0/110 |
| clarification | 11/17 |
| coding | 43/85 |
| comparison | 64/70 |
| factual | 392/515 |
| follow-up | 16/95 |
| refusal | 201/258 |
| small-talk | 21/50 |
| Language / ar | 477/600 |
| Language / en | 271/600 |

| Step | Commit | Started UTC | Finished UTC | Receipt | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Follow-up freeze | `9684a31e2644d9f13db9f0e2d579cc0ef0264bf7` | 2026-11-25T07:15:38.535Z | 2026-11-25T07:20:23.879Z | `final/v2-sealed.json` | `4ad7fe593bf0c307034ebbeb770b586c19a3d842ab9913d5809edb39f05cbbf6` |

The follow-up moved v2 sealed by +296 passes from 452/1,200. V1 moved from 26/60 to 27/60.

V2 sealed verifier receipt counts were `assertion-failed` 40, `passed` 43. Search limits were `search-cpu-time` 2, `search-evaluations` 36. The receipt recorded 0 example extraction timeouts.

The exact cause of each original coding block remains unknown because those receipts predate the verifier fields. Production Python and libseccomp availability remain unverified. #74 has no reported live score without replay.
