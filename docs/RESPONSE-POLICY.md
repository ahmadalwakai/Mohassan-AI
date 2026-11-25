# Response policy

## ملخص بالعربية

يختار موحسن لكل طلب طول الرد وطريقة ترتيبه، وهل يحتاج إلى سؤال توضيحي أو اقتراح خطوة تالية، وما القدر اللازم من سياق المحادثة، وهل يحتاج الطلب إلى عمل طويل. يبدأ الرد بالنتيجة، ويحافظ على الحقائق والأرقام والخطوات والتحذيرات والمصادر المطلوبة، ويراعي لغة المستخدم ولهجته. تُقرأ الرسائل الأقدم من المحادثة نفسها عند وجود سبب صريح. ويحفظ العمل الطويل تقدمه بعد كل خطوة، ويبلغ المستخدم بالتقدم والنتيجة وما يتطلب تدخله، ويمكن إيقافه من المحادثة. المفاتيح الثلاثة مغلقة افتراضيًا.

## Decisions

`decideResponsePolicy` in `apps/server/src/assistant/response-policy.ts` uses the route, intent, handler, speech act, clarification state, constraints, language, dialect, channel, and turn count when available. The policy also reads explicit directions in the current message. Quoted and supplied material stays data. The latest applicable explicit direction takes precedence over the heuristics, with required evidence and existing permission checks preserved.

| Decision | Rule | English example | Arabic example |
| --- | --- | --- | --- |
| Short | Prefer one line or one value for a self-contained calculation, scalar fact, acknowledgement, or explicit brevity request. Keep the number, unit or source needed to understand it. | “Convert 9 hours to minutes. Just the result.” → “540 minutes.” | «حوّل ٩ ساعات إلى دقائق، النتيجة بس.» ← «٥٤٠ دقيقة.» |
| Medium | Use a few sentences for a focused explanation. Use a short list for distinct requested items. When the right length is uncertain, keep the existing reply length. | “Why does a wet towel dry faster outside?” | «ليه المنشفة المبلولة بتنشف أسرع برّه؟» |
| Long | Develop the answer when asked for detail or when multiple distinct topics or a procedure with required coverage demands it. Keep required steps, exceptions, warnings and citations even under a brevity preference. | “Explain the trade-offs of these two schedules in detail.” | «اشرح بالتفصيل مزايا الجدولين وعيوبهما.» |
| Clarification | Ask one focused question when a missing detail blocks a correct answer or safe action. | “Open my document.” → “Which document should I open?” | «افتح مستندي.» ← «أيّ مستند تريد أن أفتح؟» |
| Next step | Answer first. Offer one concrete, supported action when it is requested or the host can establish it. Most turns end after the answer. | “Is the draft ready, and what should I do next?” → “The draft passed its checks. Open the preview to review the text.” | «هل المسودة جاهزة، وش أسوي بعدها؟» ← «المسودة اجتازت الفحوص. افتح المعاينة وراجع النص.» |
| Reply form | Lead with the result or actual blocker. Match the user’s language and dialect, or the language explicitly requested. Use prose for a single point, steps for a procedure, and a list for distinct items. Apply an explicitly requested format such as JSON. | “Name three options.” → a three-item list. | «سمِّ ثلاثة خيارات.» ← قائمة من ثلاثة خيارات. |
| Context | Start with recent turns and structured memory. Read older turns for an explicit far-back reference, a recap of this conversation, conflicting earlier instructions or facts, or resumption of lengthy work. | “What limit did I give at the beginning of this conversation?” | «ما الحدّ الذي ذكرته في بداية هذه المحادثة؟» |
| Work mode | Keep a quick answer or bounded one-shot task interactive. Consider a durable run for a substantial build, deep research, recurring monitoring with an end condition, or an explicit background request. The host admits runs when it has a safe, supported plan. | “Monitor https://example.org every 15 minutes for two hours.” | «راقب https://example.org كل ١٥ دقيقة لمدة ساعتين.» |

The reply flag supplies composition guidance without slicing the finished reply or changing the token limit. The deterministic cleanup recognizes a verbatim framed echo of a plain factual question and keeps the remainder intact. Published proof, enforced reviews, structured-memory publications and already judged replies keep their existing paths. The model guidance and older references fit into the remaining prompt budget after the existing context.

The context flag scans older rows only on an explicit trigger. The read binds both the account and the conversation and stops at the boundary of the recent window. It ranks candidate turns by term relevance, recency or requested position, and recap coverage. It redacts and escapes excerpts, keeps up to 12 ranked messages and 4,800 characters of excerpts, restores their chronological order for composition, and marks partial coverage. The scan allows up to 1,000 older rows, with a 100 ms added-read budget. An over-limit or unavailable read falls back to recent context. Older excerpts are supplied as prompt data and never joined to the public query or read from another conversation. The existing local and specialist handlers continue to use their own inputs. An explicit current-message-only instruction suppresses legacy reference inheritance, earlier transcript and inherited model-prompt references. An answer to an existing clarification card still belongs to that card.

## Flags

| Environment variable | Default | Effect of `1` |
| --- | --- | --- |
| `MOHASSAN_REPLY_POLICY_ENABLED` | Off | Apply reply guidance and conservative echo cleanup. |
| `MOHASSAN_CONTEXT_POLICY_ENABLED` | Off | Allow the bounded, ranked older transcript read. |
| `MOHASSAN_LONG_RUN_ENABLED` | Off | Admit supported durable runs through chat. Existing admitted runs remain controllable after admission is disabled. |

The release tree at `5c9030b7b851f99c2fba400bd68c75a6c5b1ba93` has no `packages/model-relations` checkout. The policy uses the release’s existing deterministic signals and run infrastructure.

## Durable runs

The supported plans cover public-source research, monitoring a public page for up to two hours, and producing a draft website from a complete brief. Other capability paths retain their existing interactive behavior. The scheduler uses the existing chat run, run ledger, stop route, permission gate, and notifications. One active durable run per account includes work awaiting approval or user input.

| Bound | Limit |
| --- | --- |
| Wall time | 3 hours from admission, including time waiting for the user |
| Plan steps | 12 |
| Resource units | 18 step attempts across the run |
| Time per attempt | 30 seconds maximum |
| Retries | Up to 3 attempts per step, with 1 and 2 seconds of backoff for transient failures |
| Worker lease | A claim lasts at most 40 seconds, with a 2-second scheduler poll |
| Monitoring | Up to 2 hours and 12 checks, with at least 1 minute between checks |

Before dispatch and after each step the scheduler saves the claim, budget, result and next step to the existing run state. Restart can reclaim an expired safe read and continue from the last committed checkpoint. A stopped run loses its lease and the worker discards any late result. An uncertain site creation is recorded as unknown and is never replayed automatically. Existing approval binding attaches consent to the exact persisted action. If a source needs sign-in, credentials or payment, the run opens an existing user action card. It uses no stored credentials for public reads. Progress is notified at the first and every third non-terminal checkpoint, with separate completion and blocking notifications.

## Merge notes

| Held file | Hook | Changed lines |
| --- | --- | ---: |
| `apps/server/src/command-chat.ts` | Import policy runtime, apply echo check before existing review, delegate history read, bind the channel in keyed chat requests. | 5 |
| `apps/server/src/assistant/brain.ts` | Import prompt helpers, apply scope selection, and append policy guidance and older evidence. | 3 |
| `apps/web/components/notification-client.ts` | Localized progress notification title. | 1 |

Migration `041_long_run_checkpoints` follows `040_member_data_rights`. It adds the partial unique index for one active durable run per account, the due-time index for restart recovery, and the progress notification kind constraint. Checkpoints use the existing `chat_runs.state` column. No required chat request or response fields were added.

## Measurements

### Length

The Natural Questions experiment uses one public English training shard, `default/partial-train/0000.parquet`, at revision `5645e0450e5db543a84d868a9c3230f2f424a9d2`. It maps a human-annotated short span or yes/no answer to “short” and a long span alone to “longer.” It excluded 1,084 of 2,071 rows without an answer and found zero overlaps against the v1 development inputs and the v2 benchmark exclusion registry. The projected 987-case SHA-256 is `92b0cbd0442c72f44ee983d1b165fe1d3d2667011f088496747564b3f1a18c9f`. [Natural Questions, CC BY-SA 3.0](https://huggingface.co/datasets/google-research-datasets/natural_questions/tree/5645e0450e5db543a84d868a9c3230f2f424a9d2)

| Human annotation | Policy short | Policy longer | Agreement |
| --- | ---: | ---: | ---: |
| Short | 587 | 137 | 587/724 (81.1%) |
| Longer | 171 | 92 | 92/263 (35.0%) |
| Overall | 758 | 229 | 679/987 (68.8%) |

Always choosing short would match 724/987 (73.4%) on this imbalanced shard. The annotation marks span availability rather than the ideal conversational answer length. The broader “longer” label combines medium and long policy choices. Arabic length agreement remains unmeasured.

### Follow-up, context and work mode

The 60 agent-written evaluation cases include 30 Arabic and 30 English cases, each labeled for all three decisions. The labels were frozen in `ecbb752dbb059e73681151ce27966fd2e9c5f0b3` with SHA-256 `e59e2dab99832c61e4216d67e22ac8301cf596ffb8f3afec9fb13668fc925ddc`. The tuned scores describe agreement on this development set.

| Decision | Initial | Tuned | Tuned Arabic | Tuned English |
| --- | ---: | ---: | ---: | ---: |
| Follow-up | 53/60 | 60/60 | 30/30 | 30/30 |
| Context scope | 48/60 | 60/60 | 30/30 | 30/30 |
| Work mode | 50/60 | 60/60 | 30/30 | 30/30 |

The 60 follow-up labels include 40 turns with no follow-up, 12 with one clarification, and 8 with a next-step offer. Context labels include 16 full-history triggers and 44 recent-only turns. Work labels include 14 autonomous turns and 46 interactive turns. This set was used to tune the rules. Independent agreement on these decisions remains unmeasured.

### Context latency

The context harness uses in-process PGlite and synthetic messages. It measures the actual context assembly function with five warm-up pairs and 40 alternating on/off pairs per size, holding seven recent messages fixed. The added column reports quantiles of paired duration differences. Production PostgreSQL latency remains unmeasured.

| Older messages | Off median / p95, ms | On median / p95, ms | Added median / p95, ms | Older evidence available |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 0.699 / 1.172 | 4.404 / 8.624 | 3.618 / 7.744 | 40/40 |
| 500 | 0.901 / 2.951 | 20.908 / 61.752 | 17.969 / 60.997 | 39/40 |
| 1,000 | 0.919 / 5.378 | 38.579 / 75.670 | 38.242 / 72.991 | 38/40 |
| 1,001 | 0.758 / 5.464 | 31.219 / 113.180 | 30.208 / 112.852 | 0/40 |

This run shared the machine with the benchmark and test workers. The over-limit case always fell back, with measured p95 above the 100 ms budget under contention. The deadline governs whether older evidence is accepted. Timer and database scheduling can delay the return to the recent-context path.

After the benchmark workers finished, all 120 in-limit reads supplied older evidence. The added median / p95 was 3.684 / 7.581 ms for 50 older messages, 9.556 / 16.051 ms for 500, and 19.168 / 30.179 ms for 1,000. All 40 reads at 1,001 messages fell back, with an added median / p95 of 15.732 / 26.246 ms.

### Development gates

Every measured area, language, and area-by-language group kept the same pass count. The gate checked 28 such cross-groups in v1 and 12 in v2. Neither split acquired a required-content failure.

| Group | v1 off | v1 on | v2 off | v2 on |
| --- | ---: | ---: | ---: | ---: |
| Overall | 169/240 | 169/240 | 1567/2400 | 1567/2400 |
| Arabic | 82/120 | 82/120 | 968/1200 | 968/1200 |
| English | 87/120 | 87/120 | 599/1200 | 599/1200 |
| Calculation | 18/18 | 18/18 | 5/277 | 5/277 |
| Clarification | 16/16 | 16/16 | 9/9 | 9/9 |
| Coding | 0/16 | 0/16 | 108/155 | 108/155 |
| Comparison | 11/18 | 11/18 | 28/32 | 28/32 |
| Desktop | 11/16 | 11/16 | — | — |
| Document file | 9/18 | 9/18 | — | — |
| Explanation | 8/18 | 8/18 | — | — |
| Factual | 10/18 | 10/18 | 976/1244 | 976/1244 |
| Follow-up | 18/18 | 18/18 | 46/240 | 46/240 |
| Google Ads | 0/16 | 0/16 | — | — |
| Memory | 16/16 | 16/16 | — | — |
| Multi-step | 18/18 | 18/18 | — | — |
| Refusal | 16/16 | 16/16 | 331/375 | 331/375 |
| Small talk | 18/18 | 18/18 | 64/68 | 64/68 |

| Observed latency per case | Off median / p95, ms | On median / p95, ms |
| --- | ---: | ---: |
| v1 | 165.238 / 883.884 | 75.227 / 381.479 |
| v2 | 95.167 / 1177.024 | 79.427 / 1168.573 |

The off and on runs were sequential and shared the machine with other checks. These measurements describe the recorded runs.

### Automated v2 reply quality

| Check | Off | On |
| --- | ---: | ---: |
| Answer first | 2400/2400 | 2400/2400 |
| No restated question | 2400/2400 | 2400/2400 |
| No repetition of an earlier reply | N/A, 0 eligible | N/A, 0 eligible |
| Structure appropriate to content | 2173/2400 | 2173/2400 |

All v2 cases are single-turn. The repeat checker also ran on v1, where 33 of 39 eligible replies passed in each mode. Structure scores were 1032/1200 in Arabic and 1141/1200 in English in each v2 arm. These are automated form checks.

Keep the three flags off by default. Natural Questions agreement trails the majority baseline, and the decision labels were used for tuning. The fixture gate establishes deterministic non-regression under its profile. Sealed sets remain unrun.

## Verification commands

The implementation measured by the development gate is `7f9c417f2e06b77c26eb6ff677d06e3457da650b`. The benchmark scripts export pinned development fixtures to a scratch directory. The runs use the published scorers and observers, with the same release features active in both arms. The harness disables the existing learned refusal and scratch routing heads, checks for zero model calls and denies unexpected network use. This profile measures deterministic replies. It cannot verify model-assisted composition, and the development observer calls the interactive chat control directly. The durable scheduler is verified in its own tests.

```sh
npm run typecheck
MOHASSAN_SCRATCH_CLASSIFIERS=0 npx vitest run --config /workspace/work/response-policy/weight-free-vitest.mjs tests/response-policy.test.ts tests/response-policy-runtime.test.ts tests/response-policy-reply-quality.test.ts tests/response-policy-long-run.test.ts tests/agent-run-ledger.test.ts tests/permission-gate.test.ts tests/chat-notification-lifecycle.test.ts tests/notifications.test.ts tests/reminders-scheduler.test.ts tests/web-notifications.test.ts tests/assistant-reply-directive.test.ts tests/assistant-reply-check.test.ts tests/assistant-request-context.test.ts tests/assistant-refusal-benchmark-isolation.test.ts tests/agent-capability-source-guard.test.ts tests/conversation-state-chat.test.ts tests/assistant-clarification-policy.test.ts tests/assistant-structured-memory-development.test.ts
```

Typecheck exited 0. Vitest exited 0 with 236 passed and one fixture-dependent test skipped in the release checkout. The scratch Vitest config extends the repository config and aliases the inherited `./learned-classifier.js` import to a module whose `classifyLearnedRefusal` returns `null`. The durable tests cover restart, stop, timeout, transient retry, approval expiry and continuity, input pause, one active run per account, and normal chat create/cancel routes.

```sh
PYTHONPATH=/workspace/work/response-policy/pydeps python scripts/response-policy/prepare-natural-questions.py --parquet /workspace/work/response-policy/nq-train-0000.parquet --v1-development /workspace/work/response-policy/v1-development.json --v2-exclusion-manifest /workspace/work/response-policy/nq-exclusion/manifest.json --output /workspace/work/response-policy/nq-policy-input.json
node --import tsx scripts/response-policy/evaluate.ts --natural-questions /workspace/work/response-policy/nq-policy-input.json > /workspace/work/response-policy/decision-measurements-final.json
node --import tsx scripts/response-policy/context-latency.ts > /workspace/work/response-policy/context-latency-final.json
node --import tsx scripts/response-policy/context-latency.ts > /workspace/work/response-policy/context-latency-quiet.json
```

Each command exited 0. The Natural Questions data and benchmark inputs stayed in scratch storage.

The four development commands ran in the clean detached benchmark checkout at `/workspace/work/response-policy-bench/measure-commit`.

```sh
node --import tsx scripts/response-policy/development-bench.mjs prepare /workspace/work/response-policy-bench/frozen
node --import tsx scripts/response-policy/development-bench.mjs off /workspace/work/response-policy-bench/frozen 4
node --import tsx scripts/response-policy/development-bench.mjs on /workspace/work/response-policy-bench/frozen 4
node scripts/response-policy/development-bench.mjs gate /workspace/work/response-policy-bench/frozen > /workspace/work/response-policy-bench/frozen/gate.json
```

Each command exited 0. Both arms verified the same clean commit, lockfile, case IDs and development fixture checksums.

### Benchmark source guards

The v1 guard ran in `/workspace/work/response-policy-bench/source-guard-base` at the implementation commit with the published v1 development fixture staged in that scratch checkout. It exited 0 with 13 passed.

```sh
npm test -- --maxWorkers=1 --reporter=dot --disableConsoleIntercept tests/assistant-refusal-benchmark-isolation.test.ts tests/agent-capability-source-guard.test.ts tests/response-policy-reply-quality.test.ts
```

The raw v2 guards each exited 1 with one passing and one failing test on both the release base and the implementation. They reported the same 11 inherited occurrences across 10 paths. The release-relative invocation of those test modules passed 4/4 and the checker’s unit suite passed 3/3. No guard source was edited.

```sh
python3 -B -m unittest discover -s tests -p test_v2_source_leakage.py -v
python3 -B -m unittest discover -s tests -p test_v2_case_strings.py -v
python3 -B -m unittest discover -s tests -p test_check_v2_case_text.py -v
python3 -B -c 'import sys, unittest; sys.path.insert(0, "tests"); import test_v2_source_leakage as scan, test_v2_case_strings as fields; base="5c9030b7b851f99c2fba400bd68c75a6c5b1ba93"; scan.BASE=scan.WAVE_2_BASE=fields.BASELINE=fields.WAVE_2_BASE=base; suite=unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromModule(module) for module in (scan, fields)); sys.exit(not unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful())'
```
