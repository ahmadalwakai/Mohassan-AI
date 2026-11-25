# Integration wave 1 · 25 November 2026

`integration/wave-1` starts at `c2a0ff765071657cf200b5ee7d12fabaad738c0b` on `feat/skill-engine`. Each numbered step is a two-parent merge. For a stacked PR, its base was verified to be an ancestor of the merged tip. The branch is for draft review.

## Merge order and flags

Each development run enabled the additional flag in its row plus the flags for all previously retained steps. A revert restored the first-parent tree and removed that flag from later runs. The optional Arabic-understanding PR #23 was left out. Its standalone measurement lost one factual development pass, and the merge preview required a manual resolution in the held chat dispatcher. [PR #23](https://github.com/ahmadalwakai/Mohassan-AI/pull/23)

The current small-talk tip `f5052011` was merged. Its PR reports 1/4 standalone sealed small-talk passes at that tip, after an earlier revision reported 2/4. [PR #40](https://github.com/ahmadalwakai/Mohassan-AI/pull/40)

| Step | PRs | Tip merged | Merge commit | Additional flag | Development decision |
| --- | --- | --- | --- | --- | --- |
| 1 | [#40](https://github.com/ahmadalwakai/Mohassan-AI/pull/40) | `feat/small-talk-manners` at `f5052011` | `d84603cb` | `MOHASSAN_SMALL_TALK_MANNERS=1` | Retained |
| 2 | [#28](https://github.com/ahmadalwakai/Mohassan-AI/pull/28) | `feat/conversation-reviewer` at `eb5166e0` | `64f25f87` | `MOHASSAN_CONVERSATION_REVIEW_APPLY=1` | Retained |
| 3 | [#51](https://github.com/ahmadalwakai/Mohassan-AI/pull/51) + [#35](https://github.com/ahmadalwakai/Mohassan-AI/pull/35) | `e2e/follow-up-end-to-end` at `4f17a0ca` | `4118b49c` | `MOHASSAN_CONVERSATION_SHADOW=decide` | Retained |
| 4 | [#52](https://github.com/ahmadalwakai/Mohassan-AI/pull/52) + [#24](https://github.com/ahmadalwakai/Mohassan-AI/pull/24) | `e2e/multi-step-end-to-end` at `e150f149` | `876df310` | `MOHASSAN_PLAN_COMPILER=on` | Reverted in `bd2efae1` |
| 5 | [#53](https://github.com/ahmadalwakai/Mohassan-AI/pull/53) + [#31](https://github.com/ahmadalwakai/Mohassan-AI/pull/31) | `e2e/memory-end-to-end` at `06f2a00c` | `4fb2bdbe` | `MOHASSAN_STRUCTURED_MEMORY=1` | Retained |
| 6 | [#49](https://github.com/ahmadalwakai/Mohassan-AI/pull/49) + [#33](https://github.com/ahmadalwakai/Mohassan-AI/pull/33) | `feat/explanations-multisource` at `70c0ba45` | `0f5fcdfc` | `MOHASSAN_EXTRACTIVE_WRITING=1` | Retained |

## Development and sealed counts

The development table includes every attempted merge. Step 5 compares with step 3 because step 4 was reverted. The final-code column measures the source-selection repair with the retained flags.

| Area | Baseline | 1 | 2 | 3 | 4 | 5 | 6 | Final code |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **All areas** | 40/240 | 55/240 | 55/240 | 82/240 | 90/240 | 98/240 | 104/240 | 104/240 |
| calculation | 11/18 | 11/18 | 11/18 | 11/18 | 11/18 | 11/18 | 11/18 | 11/18 |
| clarification | 4/16 | 4/16 | 4/16 | 4/16 | 4/16 | 4/16 | 4/16 | 4/16 |
| coding | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 |
| comparison | 0/18 | 0/18 | 0/18 | 0/18 | 0/18 | 0/18 | 1/18 | 1/18 |
| desktop | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 | 11/16 |
| document-file | 5/18 | 5/18 | 5/18 | 5/18 | 5/18 | 5/18 | 5/18 | 5/18 |
| explanation | 0/18 | 0/18 | 0/18 | 3/18 | 3/18 | 3/18 | 8/18 | 8/18 |
| factual | 4/18 | 4/18 | 4/18 | 10/18 | 6/18 | 10/18 | 10/18 | 10/18 |
| follow-up | 0/18 | 0/18 | 0/18 | 18/18 | 13/18 | 18/18 | 18/18 | 18/18 |
| google-ads | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 |
| memory | 0/16 | 0/16 | 0/16 | 0/16 | 0/16 | 16/16 | 16/16 | 16/16 |
| multi-step | 1/18 | 1/18 | 1/18 | 1/18 | 18/18 | 1/18 | 1/18 | 1/18 |
| refusal | 1/16 | 1/16 | 1/16 | 1/16 | 1/16 | 1/16 | 1/16 | 1/16 |
| small-talk | 3/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 | 18/18 |

The following results come from the one sealed invocation on `c4d40d67c33b76aaab71e99c9dc7b4bb6d7b00a3`. It completed at 2026-11-25T03:29:59Z with exit 0 and matched the preceding development run in every area.

| Area | Development | Sealed |
| --- | ---: | ---: |
| All | 104/240 | 22/60 |
| calculation | 11/18 | 3/4 |
| clarification | 4/16 | 2/4 |
| coding | 0/16 | 0/4 |
| comparison | 1/18 | 0/4 |
| desktop | 11/16 | 3/4 |
| document-file | 5/18 | 2/4 |
| explanation | 8/18 | 1/4 |
| factual | 10/18 | 3/6 |
| follow-up | 18/18 | 3/4 |
| google-ads | 0/16 | 0/4 |
| memory | 16/16 | 2/4 |
| multi-step | 1/18 | 0/6 |
| refusal | 1/16 | 1/4 |
| small-talk | 18/18 | 2/4 |

## Reverted step

Step 4 gained 17 multi-step cases while losing four factual cases and five follow-up cases. Its aggregate gain of eight could not pass the per-area gate. In the development traces for the lost cases, an initial compiled read often completed, then the next plan step failed or remained blocked. This is the measured behavior of the combined run.

The revert is `bd2efae1d7d0ffddc590d87b9d6db91bc0ee2c32`. `git diff --exit-code 876df31004020337fd8fff2e4c3cefdd1675c766^1 bd2efae1d7d0ffddc590d87b9d6db91bc0ee2c32` exited 0. The plan compiler flag was dropped from steps 5 onward.

## Merge notes

- Steps 1–5 had no unmerged Git paths. Applicable hooks in the existing chat dispatcher, and the plan evidence hook during its trial, came from the upstream branches. The plan revert removed its net edits.
- Step 6 had one conflict in `.env.example`. The resolution kept the reviewer comment and `MOHASSAN_CONVERSATION_REVIEW_APPLY=0`, then the extractive-writing comment and `MOHASSAN_EXTRACTIVE_WRITING=0`, followed by the existing GitHub skills-source settings. Git merged the routing and dispatcher code automatically.
- Counts below are added plus removed lines from `c2a0ff7` to the measured integrated tree. The owner has local edits to these existing paths that need attention before a real merge.

| Held file | Added | Removed | Changed lines | Reconcile |
| --- | ---: | ---: | ---: | --- |
| `apps/server/src/app.ts` | 3 | 1 | 4 | PDF source read port |
| `apps/server/src/assistant/agent-run.ts` | 0 | 0 | 0 | Plan evidence hook reverted |
| `apps/server/src/assistant/brain.ts` | 1 | 0 | 1 | Same-conversation source state |
| `apps/server/src/command-chat.ts` | 24 | 5 | 29 | Manners, reviewer, follow-up, memory and writing hooks |
| `apps/web/components/markdown.tsx` | 5 | 2 | 7 | Table rendering and escaped source punctuation |

The writing stack also adds `apps/web/components/markdown-table.module.css` (32 lines) and `apps/web/components/markdown-table.tsx` (86 lines) beside the held Markdown component. The two pinned execution packages have zero changes.

### Migration order

| Step | Upstream claim | Integrated registration | Location |
| --- | --- | --- | --- |
| 2 | `035_chat_conversation_review` | `035_chat_conversation_review` | Central ledger in `packages/database/src/index.ts` |
| 5 | `035_structured_memory` | `036_structured_memory` | `apps/server/src/assistant/structured-memory-migration.ts`, invoked by `apps/server/src/memory.ts` |

The highest prefix on the base is 034. Structured memory adopts a standalone 035 ledger entry under the existing migration lock, preserving its data and the reviewer's separate 035 registration. `tests/assistant-schema-migration-order.test.ts` covers repeat startup and a database with standalone memory data. Migration numbers may need another adjustment at merge time.

### Failures found during integration

- Step 3 initially failed three assertions across its two invocations. With conversation-state decision mode disabled, the legacy Nile follow-up retained a generic river topic, a failure already documented in PR #35. With decision mode enabled, the follow-up treated the generic page title as part of the specific subject name and reread that page, producing a different river's length. The repair in `conversation-state-public-read.ts` reuses a page for an exact title or observed canonical alias. A longer user-established name can reuse the page when the prior answer was about the page itself. A specific item quoted from a generic list goes to the existing named lookup. The focused tests cover named search, aliases and anchored page reuse.
- The step 3, 4 and 5 leakage guards each reported two inherited exact phrases from #40, one in `apps/server/src/assistant/manners/replies.ts` and one in `tests/fixtures/manners-development.ts`. Both files were confirmed unchanged from `f5052011`. The follow-up test now counts occurrences against that pinned baseline for those two files. The memory audit accepts only their pinned SHA-256 versions and scans any changed version normally. The plan-specific guard left with the revert. No cases, scoring rules or manner strings were changed.
- The first source-selection repair at `745bb9d` required exact title equality. It scored 103/240 and dropped one follow-up case, so the final refinement restores evidence-backed title variants. The initial exact-title run is in `dev-final-code.json`.

## Measurement method

The frozen runner, scorer, development payload and manifest came from PR #22 at `a258b3d47e39b5a2c03c71d4a9eb01107ae3d97f`. They ran from an untracked overlay in the isolated clone. The observer used the published PR #41 adapters for reviewer publication and structured-memory startup when those features were present. Scoring and fixtures stayed byte-for-byte frozen. The commands used temporary PGlite state and fixture ports, without model calls. Measured case counts were keyed by area and compared to the last retained step, using the same lockfile and development hash. [PR #22](https://github.com/ahmadalwakai/Mohassan-AI/pull/22) · [PR #41](https://github.com/ahmadalwakai/Mohassan-AI/pull/41)

A setup run completed at 35/240 before Playwright's headless shell was available, with document/file at 0/18. Installing Chromium restored that area to 5/18 and the published 40/240 development baseline. The setup run was excluded from the gate. A second run of step 1 at the same commit also produced 55/240 and the same counts in all 14 areas.

The aggregate-only check for the final evaluation verifies the two split sizes and matching area totals. The sealed file was materialized only for that invocation, under a temporary directory. No sealed case text or per-case result was opened for analysis. The runner also repeated development within its joint invocation, so its development counts can be checked against the last development-only run.

## Verification and commands

Benchmark reports and logs were written under `/workspace/work/wave-benchmark`. Exact test commands and exits were captured in `/workspace/work/wave-checks`. The TypeScript check ran at all six merge commits, the initial repair and the final code commit. The table supplies phase-specific Vitest results. The full affected command includes the available test targets from all six attempts, the unchanged benchmark checks, and the new migration tests. Focused feature suites set their own rollout environment. The older follow-up suite was additionally run with decision mode enabled explicitly. The draft PR records the full affected result at its published commit.

| Step | Started UTC | Finished UTC | Raw development report | Typecheck | Affected Vitest |
| --- | --- | --- | --- | --- | --- |
| baseline | 2026-11-25T03:05:47.035Z | 2026-11-25T03:06:32.955Z | `dev-baseline.json` | — | — |
| 1 | 2026-11-25T03:07:04.796Z | 2026-11-25T03:07:54.778Z | `dev-1.json` | exit 0 | 379 passed (379) tests · 19 passed (19) files |
| 2 | 2026-11-25T03:09:00.279Z | 2026-11-25T03:09:48.431Z | `dev-2.json` | exit 0 | 289 passed (289) tests · 24 passed (24) files |
| 3 | 2026-11-25T03:10:54.619Z | 2026-11-25T03:11:36.954Z | `dev-3.json` | exit 0 | 2 failed, 713 passed, 1 skipped (716) tests · 2 failed, 30 passed (32) files |
| 4 | 2026-11-25T03:12:17.669Z | 2026-11-25T03:13:01.922Z | `dev-4.json` | exit 0 | 1 failed, 1094 passed (1095) tests · 1 failed, 37 passed (38) files |
| 5 | 2026-11-25T03:15:25.225Z | 2026-11-25T03:16:04.525Z | `dev-5.json` | exit 0 | 1 failed, 1423 passed (1424) tests · 1 failed, 44 passed (45) files |
| 6 | 2026-11-25T03:19:29.325Z | 2026-11-25T03:20:04.704Z | `dev-6.json` | exit 0 | 459 passed (459) tests · 29 passed (29) files |
| refined-code | 2026-11-25T03:27:52.626Z | 2026-11-25T03:28:28.038Z | `dev-refined-code.json` | exit 0 | 721 passed, 1 skipped (722) tests · 34 passed (34) files |

The first full affected run at `745bb9d` recorded 2813 passed, 1 skipped (2814). The suite exited 1 because `assistant-local-sequence-chat.test.ts` removed its temporary directory while the asynchronous judge writer still had a pending append (`ENOTEMPTY`). The test now flushes the existing judge sink before deleting the directory and the focused rerun exited 0. The final-code focused run covers the source-selection refinement and both leakage guards. The router parity test skips without its trained-model artifact.

The initial `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund` failed when the sandbox could not create `/home/agent/.npm/_cacache`. These setup commands then exited 0.

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --cache /workspace/work/wave-npm-cache --no-audit --no-fund
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium npm exec -- playwright install chromium
/workspace/work/wave-benchmark/overlay prepare
```

<details>
<summary>Benchmark commands</summary>

```bash
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium /workspace/work/wave-benchmark/overlay development \
  /workspace/work/wave-benchmark/dev-0.json
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium /workspace/work/wave-benchmark/overlay development \
  /workspace/work/wave-benchmark/dev-baseline.json
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium /workspace/work/wave-benchmark/overlay development \
  /workspace/work/wave-benchmark/dev-1.json MOHASSAN_SMALL_TALK_MANNERS=1
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium /workspace/work/wave-benchmark/overlay development \
  /workspace/work/wave-benchmark/dev-2.json MOHASSAN_SMALL_TALK_MANNERS=1 \
  MOHASSAN_CONVERSATION_REVIEW_APPLY=1
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium /workspace/work/wave-benchmark/overlay development \
  /workspace/work/wave-benchmark/dev-3.json MOHASSAN_SMALL_TALK_MANNERS=1 \
  MOHASSAN_CONVERSATION_REVIEW_APPLY=1 MOHASSAN_CONVERSATION_SHADOW=decide
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium /workspace/work/wave-benchmark/overlay development \
  /workspace/work/wave-benchmark/dev-4.json MOHASSAN_SMALL_TALK_MANNERS=1 \
  MOHASSAN_CONVERSATION_REVIEW_APPLY=1 MOHASSAN_CONVERSATION_SHADOW=decide MOHASSAN_PLAN_COMPILER=on
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium /workspace/work/wave-benchmark/overlay development \
  /workspace/work/wave-benchmark/dev-5.json MOHASSAN_SMALL_TALK_MANNERS=1 \
  MOHASSAN_CONVERSATION_REVIEW_APPLY=1 MOHASSAN_CONVERSATION_SHADOW=decide MOHASSAN_STRUCTURED_MEMORY=1
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium /workspace/work/wave-benchmark/overlay development \
  /workspace/work/wave-benchmark/dev-6.json MOHASSAN_SMALL_TALK_MANNERS=1 \
  MOHASSAN_CONVERSATION_REVIEW_APPLY=1 MOHASSAN_CONVERSATION_SHADOW=decide MOHASSAN_STRUCTURED_MEMORY=1 \
  MOHASSAN_EXTRACTIVE_WRITING=1
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium /workspace/work/wave-benchmark/overlay development \
  /workspace/work/wave-benchmark/dev-final-code.json MOHASSAN_SMALL_TALK_MANNERS=1 \
  MOHASSAN_CONVERSATION_REVIEW_APPLY=1 MOHASSAN_CONVERSATION_SHADOW=decide MOHASSAN_STRUCTURED_MEMORY=1 \
  MOHASSAN_EXTRACTIVE_WRITING=1
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium /workspace/work/wave-benchmark/overlay development \
  /workspace/work/wave-benchmark/dev-refined-code.json MOHASSAN_SMALL_TALK_MANNERS=1 \
  MOHASSAN_CONVERSATION_REVIEW_APPLY=1 MOHASSAN_CONVERSATION_SHADOW=decide MOHASSAN_STRUCTURED_MEMORY=1 \
  MOHASSAN_EXTRACTIVE_WRITING=1
PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium /workspace/work/wave-benchmark/overlay sealed \
  /workspace/work/wave-benchmark/final.json MOHASSAN_SMALL_TALK_MANNERS=1 \
  MOHASSAN_CONVERSATION_REVIEW_APPLY=1 MOHASSAN_CONVERSATION_SHADOW=decide MOHASSAN_STRUCTURED_MEMORY=1 \
  MOHASSAN_EXTRACTIVE_WRITING=1
/workspace/work/wave-benchmark/verify-aggregates.py /workspace/work/wave-benchmark/final.log \
  /workspace/work/wave-benchmark/dev-refined-code.log /workspace/work/wave-benchmark/sealed.started \
  c4d40d67c33b76aaab71e99c9dc7b4bb6d7b00a3
```

</details>

<details>
<summary>Typecheck and affected suite commands by step</summary>

```bash
env -i PATH="$PATH" TZ=UTC PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium npm run typecheck
env -i PATH="$PATH" TZ=UTC PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium npm test -- \
  tests/assistant-local-sequence-chat.test.ts
# 1
env -i PATH="$PATH" TZ=UTC PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium npm test -- --maxWorkers=2 \
  --fileParallelism --reporter=dot --disableConsoleIntercept \
  tests/assistant-clarification-time-audit.test.ts tests/assistant-constraint-conjunctions.test.ts \
  tests/assistant-context-chat.test.ts tests/assistant-judge-chat.test.ts \
  tests/assistant-judge-production.test.ts tests/assistant-local-computation-chat.test.ts \
  tests/assistant-local-conversation.test.ts tests/assistant-manners-chat.test.ts \
  tests/assistant-manners-detection.test.ts tests/assistant-manners-development.test.ts \
  tests/assistant-manners-replies.test.ts tests/assistant-public-query-provenance.test.ts \
  tests/assistant-request-constraints-chat.test.ts tests/assistant-request-constraints.test.ts \
  tests/assistant-routing-decision.test.ts tests/assistant-self-knowledge-chat.test.ts \
  tests/assistant-self-knowledge.test.ts tests/assistant-user-fact-memory-chat.test.ts \
  tests/conversation-state-chat.test.ts
# 2
env -i PATH="$PATH" TZ=UTC PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium npm test -- --maxWorkers=2 \
  --fileParallelism --reporter=dot --disableConsoleIntercept tests/assistant-agent-cycle-chat.test.ts \
  tests/assistant-chat-supervision.test.ts tests/assistant-compound-requests-chat.test.ts \
  tests/assistant-context-chat.test.ts tests/assistant-desktop-chat.test.ts \
  tests/assistant-image-messages.test.ts tests/assistant-image-reading.test.ts \
  tests/assistant-judge-chat.test.ts tests/assistant-judge-production.test.ts \
  tests/assistant-judge-shadow.test.ts tests/assistant-judge.test.ts \
  tests/assistant-local-sequence-chat.test.ts tests/assistant-web-sequence.test.ts \
  tests/chat-idempotency.test.ts tests/conversation-review-checks.test.ts \
  tests/conversation-review-evaluation.test.ts tests/conversation-review-ledger.test.ts \
  tests/conversation-review-migration.test.ts tests/conversation-review-publication.test.ts \
  tests/conversation-state-chat.test.ts tests/conversation-state-review.test.ts \
  tests/conversation-state-shadow.test.ts tests/conversation-state.test.ts \
  tests/skill-reader-judge-chat.test.ts
# 3
env -i PATH="$PATH" TZ=UTC PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium npm test -- --maxWorkers=2 \
  --fileParallelism --reporter=dot --disableConsoleIntercept tests/assistant-browser-request-scope.test.ts \
  tests/assistant-conversation-follow-up.test.ts tests/assistant-follow-up-corpus-leak.test.ts \
  tests/assistant-hands-attribute-pronoun.test.ts tests/assistant-hands-http-chat.test.ts \
  tests/assistant-hands-open-ask-chat.test.ts tests/assistant-hands-open-ask.test.ts \
  tests/assistant-hands-open-read.test.ts tests/assistant-hands-page-choice.test.ts \
  tests/assistant-hands-subject-name.test.ts tests/assistant-hands.test.ts \
  tests/assistant-local-conversation.test.ts tests/assistant-reply-check-byline.test.ts \
  tests/assistant-reply-check.test.ts tests/assistant-request-constraints-chat.test.ts \
  tests/assistant-request-constraints.test.ts tests/assistant-request-context.test.ts \
  tests/assistant-request-scope-nominal.test.ts tests/assistant-request-scope.test.ts \
  tests/assistant-router.test.ts tests/assistant-routing-decision.test.ts tests/chat-wait.test.ts \
  tests/conversation-state-chat.test.ts tests/conversation-state-decides-chat.test.ts \
  tests/conversation-state-decisions.test.ts tests/conversation-state-entities.test.ts \
  tests/conversation-state-page.test.ts tests/conversation-state-public-read.test.ts \
  tests/conversation-state-review.test.ts tests/conversation-state-shadow.test.ts \
  tests/conversation-state.test.ts tests/public-conversation-followup.test.ts
env -i PATH="$PATH" TZ=UTC PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium \
  MOHASSAN_CONVERSATION_SHADOW=decide npm test -- tests/assistant-conversation-follow-up.test.ts
# 4
env -i PATH="$PATH" TZ=UTC PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium npm test -- --maxWorkers=2 \
  --fileParallelism --reporter=dot --disableConsoleIntercept tests/agent-capability-leakage.test.ts \
  tests/agent-run-ledger.test.ts tests/assistant-action-completion-chat.test.ts \
  tests/assistant-action-completion.test.ts tests/assistant-browser-recovery-chat.test.ts \
  tests/assistant-browser-reported-scope-audit.test.ts tests/assistant-browser-request-scope.test.ts \
  tests/assistant-calculator.test.ts tests/assistant-chat-supervision.test.ts \
  tests/assistant-compound-requests-chat.test.ts tests/assistant-compound-requests.test.ts \
  tests/assistant-computation-memory-chat.test.ts tests/assistant-hands-http-chat.test.ts \
  tests/assistant-hands-open-read.test.ts tests/assistant-hands.test.ts \
  tests/assistant-live-test-pdf-chat.test.ts tests/assistant-local-computation-chat.test.ts \
  tests/assistant-local-computation.test.ts tests/assistant-local-memory-chat.test.ts \
  tests/assistant-local-sequence-chat.test.ts tests/assistant-local-sequence.test.ts \
  tests/assistant-plan-chat.test.ts tests/assistant-plan-compiler.test.ts \
  tests/assistant-plan-development.test.ts tests/assistant-plan-executor.test.ts \
  tests/assistant-plan-source-computation.test.ts tests/assistant-plan-tools.test.ts \
  tests/assistant-plan-web-tools.test.ts tests/assistant-request-constraints-chat.test.ts \
  tests/assistant-request-constraints.test.ts tests/assistant-request-scope.test.ts \
  tests/assistant-routing-decision.test.ts tests/assistant-search-routing.test.ts \
  tests/assistant-user-fact-memory-chat.test.ts tests/assistant-web-sequence.test.ts \
  tests/assistant-writer.test.ts tests/run-view.test.ts tests/sites-chat.test.ts
# 5
env -i PATH="$PATH" TZ=UTC PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium npm test -- --maxWorkers=2 \
  --fileParallelism --reporter=dot --disableConsoleIntercept packages/memory tests/agent-run-ledger.test.ts \
  tests/assistant-action-completion-chat.test.ts tests/assistant-action-completion.test.ts \
  tests/assistant-capability-case-leakage.test.ts tests/assistant-chat-supervision.test.ts \
  tests/assistant-computation-memory-chat.test.ts tests/assistant-computation-memory-completion.test.ts \
  tests/assistant-computation-memory-flow.test.ts tests/assistant-computation-memory-receipt.test.ts \
  tests/assistant-current-memory-declaration-chat.test.ts tests/assistant-current-memory-declaration.test.ts \
  tests/assistant-legacy-memory-statement.test.ts tests/assistant-literal-memory-source-audit.test.ts \
  tests/assistant-local-memory-chat.test.ts tests/assistant-memory-evidence-boundary.test.ts \
  tests/assistant-memory-exact-adapter.test.ts tests/assistant-memory-json-subject-audit.test.ts \
  tests/assistant-memory-publication-freshness-audit.test.ts tests/assistant-memory-recall-evidence.test.ts \
  tests/assistant-memory-recall.test.ts tests/assistant-memory-save-authorization.test.ts \
  tests/assistant-memory-verification-chat.test.ts tests/assistant-memory-verification.test.ts \
  tests/assistant-model-memory-recall-evidence-audit.test.ts tests/assistant-own-fact-question.test.ts \
  tests/assistant-request-constraints-chat.test.ts tests/assistant-request-constraints.test.ts \
  tests/assistant-routing-decision.test.ts tests/assistant-schema-migration-order.test.ts \
  tests/assistant-structured-memory-chat.test.ts tests/assistant-structured-memory-development.test.ts \
  tests/assistant-structured-memory-parser.test.ts tests/assistant-structured-memory-storage.test.ts \
  tests/assistant-user-fact-memory-chat.test.ts tests/assistant-user-fact-memory-completion.test.ts \
  tests/assistant-user-fact-memory-flow.test.ts tests/assistant-user-fact-memory-receipt.test.ts \
  tests/assistant-user-fact-memory-verification-chat.test.ts \
  tests/assistant-user-fact-memory-verification.test.ts tests/chat-idempotency.test.ts \
  tests/members-access.test.ts tests/memory-relevance-20261124.test.ts tests/mind-limits.test.ts
# 6
env -i PATH="$PATH" TZ=UTC PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium npm test -- --maxWorkers=2 \
  --fileParallelism --reporter=dot --disableConsoleIntercept tests/assistant-browser-request-scope.test.ts \
  tests/assistant-documents-chat.test.ts tests/assistant-documents.test.ts \
  tests/assistant-hands-http-chat.test.ts tests/assistant-live-test-pdf-chat.test.ts \
  tests/assistant-open-read-chat.test.ts tests/assistant-public-projection-chat.test.ts \
  tests/assistant-request-constraints-chat.test.ts tests/assistant-request-context.test.ts \
  tests/assistant-request-scope.test.ts tests/assistant-routing-decision.test.ts \
  tests/assistant-template-chat.test.ts tests/assistant-two-sources.test.ts tests/assistant-writer.test.ts \
  tests/documents-control.test.ts tests/explanations-alignment.test.ts tests/explanations-claims.test.ts \
  tests/explanations-compose.test.ts tests/explanations-gather.test.ts \
  tests/explanations-multisource-corpus.test.ts tests/explanations-request.test.ts \
  tests/extractive-writing-chat.test.ts tests/extractive-writing-corpus.test.ts \
  tests/extractive-writing-request.test.ts tests/extractive-writing-structures.test.ts \
  tests/extractive-writing-summary.test.ts tests/extractive-writing-table.test.ts \
  tests/markdown-copy.test.ts tests/page-cache.test.ts
# final-code
env -i PATH="$PATH" TZ=UTC PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium npm test -- --maxWorkers=2 \
  --fileParallelism --reporter=dot --disableConsoleIntercept packages/memory \
  tests/agent-capability-corpus.test.ts tests/agent-capability-leakage.test.ts \
  tests/agent-capability-observe.test.ts tests/agent-capability-score.test.ts tests/agent-run-ledger.test.ts \
  tests/assistant-action-completion-chat.test.ts tests/assistant-action-completion.test.ts \
  tests/assistant-agent-cycle-chat.test.ts tests/assistant-browser-recovery-chat.test.ts \
  tests/assistant-browser-reported-scope-audit.test.ts tests/assistant-browser-request-scope.test.ts \
  tests/assistant-calculator.test.ts tests/assistant-capability-case-leakage.test.ts \
  tests/assistant-chat-supervision.test.ts tests/assistant-clarification-time-audit.test.ts \
  tests/assistant-compound-requests-chat.test.ts tests/assistant-compound-requests.test.ts \
  tests/assistant-computation-memory-chat.test.ts tests/assistant-computation-memory-completion.test.ts \
  tests/assistant-computation-memory-flow.test.ts tests/assistant-computation-memory-receipt.test.ts \
  tests/assistant-constraint-conjunctions.test.ts tests/assistant-context-chat.test.ts \
  tests/assistant-conversation-follow-up.test.ts tests/assistant-current-memory-declaration-chat.test.ts \
  tests/assistant-current-memory-declaration.test.ts tests/assistant-desktop-chat.test.ts \
  tests/assistant-documents-chat.test.ts tests/assistant-documents.test.ts \
  tests/assistant-follow-up-corpus-leak.test.ts tests/assistant-hands-attribute-pronoun.test.ts \
  tests/assistant-hands-http-chat.test.ts tests/assistant-hands-open-ask-chat.test.ts \
  tests/assistant-hands-open-ask.test.ts tests/assistant-hands-open-read.test.ts \
  tests/assistant-hands-page-choice.test.ts tests/assistant-hands-subject-name.test.ts \
  tests/assistant-hands.test.ts tests/assistant-image-messages.test.ts tests/assistant-image-reading.test.ts \
  tests/assistant-judge-chat.test.ts tests/assistant-judge-production.test.ts \
  tests/assistant-judge-shadow.test.ts tests/assistant-judge.test.ts \
  tests/assistant-legacy-memory-statement.test.ts tests/assistant-literal-memory-source-audit.test.ts \
  tests/assistant-live-test-pdf-chat.test.ts tests/assistant-local-computation-chat.test.ts \
  tests/assistant-local-computation.test.ts tests/assistant-local-conversation.test.ts \
  tests/assistant-local-memory-chat.test.ts tests/assistant-local-sequence-chat.test.ts \
  tests/assistant-local-sequence.test.ts tests/assistant-manners-chat.test.ts \
  tests/assistant-manners-detection.test.ts tests/assistant-manners-development.test.ts \
  tests/assistant-manners-replies.test.ts tests/assistant-memory-evidence-boundary.test.ts \
  tests/assistant-memory-exact-adapter.test.ts tests/assistant-memory-json-subject-audit.test.ts \
  tests/assistant-memory-publication-freshness-audit.test.ts tests/assistant-memory-recall-evidence.test.ts \
  tests/assistant-memory-recall.test.ts tests/assistant-memory-save-authorization.test.ts \
  tests/assistant-memory-verification-chat.test.ts tests/assistant-memory-verification.test.ts \
  tests/assistant-model-memory-recall-evidence-audit.test.ts tests/assistant-open-read-chat.test.ts \
  tests/assistant-own-fact-question.test.ts tests/assistant-plan-chat.test.ts \
  tests/assistant-plan-compiler.test.ts tests/assistant-plan-development.test.ts \
  tests/assistant-plan-executor.test.ts tests/assistant-plan-tools.test.ts \
  tests/assistant-plan-web-tools.test.ts tests/assistant-public-projection-chat.test.ts \
  tests/assistant-public-query-provenance.test.ts tests/assistant-reply-check-byline.test.ts \
  tests/assistant-reply-check.test.ts tests/assistant-request-constraints-chat.test.ts \
  tests/assistant-request-constraints.test.ts tests/assistant-request-context.test.ts \
  tests/assistant-request-scope-nominal.test.ts tests/assistant-request-scope.test.ts \
  tests/assistant-router.test.ts tests/assistant-routing-decision.test.ts \
  tests/assistant-schema-migration-order.test.ts tests/assistant-search-routing.test.ts \
  tests/assistant-self-knowledge-chat.test.ts tests/assistant-self-knowledge.test.ts \
  tests/assistant-structured-memory-chat.test.ts tests/assistant-structured-memory-development.test.ts \
  tests/assistant-structured-memory-parser.test.ts tests/assistant-structured-memory-storage.test.ts \
  tests/assistant-template-chat.test.ts tests/assistant-two-sources.test.ts \
  tests/assistant-user-fact-memory-chat.test.ts tests/assistant-user-fact-memory-completion.test.ts \
  tests/assistant-user-fact-memory-flow.test.ts tests/assistant-user-fact-memory-receipt.test.ts \
  tests/assistant-user-fact-memory-verification-chat.test.ts \
  tests/assistant-user-fact-memory-verification.test.ts tests/assistant-web-sequence.test.ts \
  tests/assistant-writer.test.ts tests/chat-idempotency.test.ts tests/chat-wait.test.ts \
  tests/conversation-review-checks.test.ts tests/conversation-review-evaluation.test.ts \
  tests/conversation-review-ledger.test.ts tests/conversation-review-migration.test.ts \
  tests/conversation-review-publication.test.ts tests/conversation-state-chat.test.ts \
  tests/conversation-state-decides-chat.test.ts tests/conversation-state-decisions.test.ts \
  tests/conversation-state-entities.test.ts tests/conversation-state-page.test.ts \
  tests/conversation-state-public-read.test.ts tests/conversation-state-review.test.ts \
  tests/conversation-state-shadow.test.ts tests/conversation-state.test.ts tests/documents-control.test.ts \
  tests/explanations-alignment.test.ts tests/explanations-claims.test.ts tests/explanations-compose.test.ts \
  tests/explanations-gather.test.ts tests/explanations-multisource-corpus.test.ts \
  tests/explanations-request.test.ts tests/extractive-writing-chat.test.ts \
  tests/extractive-writing-corpus.test.ts tests/extractive-writing-request.test.ts \
  tests/extractive-writing-structures.test.ts tests/extractive-writing-summary.test.ts \
  tests/extractive-writing-table.test.ts tests/markdown-copy.test.ts tests/members-access.test.ts \
  tests/memory-relevance-20261124.test.ts tests/mind-limits.test.ts tests/page-cache.test.ts \
  tests/public-conversation-followup.test.ts tests/run-view.test.ts tests/sites-chat.test.ts \
  tests/skill-reader-judge-chat.test.ts
env -i PATH="$PATH" TZ=UTC PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium \
  MOHASSAN_CONVERSATION_SHADOW=decide npm test -- tests/assistant-conversation-follow-up.test.ts
# refined
env -i PATH="$PATH" TZ=UTC PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium npm test -- --maxWorkers=2 \
  --fileParallelism --reporter=dot --disableConsoleIntercept tests/assistant-browser-request-scope.test.ts \
  tests/assistant-conversation-follow-up.test.ts tests/assistant-follow-up-corpus-leak.test.ts \
  tests/assistant-hands-attribute-pronoun.test.ts tests/assistant-hands-http-chat.test.ts \
  tests/assistant-hands-open-ask-chat.test.ts tests/assistant-hands-open-ask.test.ts \
  tests/assistant-hands-open-read.test.ts tests/assistant-hands-page-choice.test.ts \
  tests/assistant-hands-subject-name.test.ts tests/assistant-hands.test.ts \
  tests/assistant-local-conversation.test.ts tests/assistant-reply-check-byline.test.ts \
  tests/assistant-reply-check.test.ts tests/assistant-request-constraints-chat.test.ts \
  tests/assistant-request-constraints.test.ts tests/assistant-request-context.test.ts \
  tests/assistant-request-scope-nominal.test.ts tests/assistant-request-scope.test.ts \
  tests/assistant-router.test.ts tests/assistant-routing-decision.test.ts tests/chat-wait.test.ts \
  tests/conversation-state-chat.test.ts tests/conversation-state-decides-chat.test.ts \
  tests/conversation-state-decisions.test.ts tests/conversation-state-entities.test.ts \
  tests/conversation-state-page.test.ts tests/conversation-state-public-read.test.ts \
  tests/conversation-state-review.test.ts tests/conversation-state-shadow.test.ts \
  tests/conversation-state.test.ts tests/public-conversation-followup.test.ts \
  tests/assistant-capability-case-leakage.test.ts tests/assistant-schema-migration-order.test.ts
env -i PATH="$PATH" TZ=UTC PLAYWRIGHT_BROWSERS_PATH=/workspace/work/wave-chromium \
  MOHASSAN_CONVERSATION_SHADOW=decide npm test -- tests/assistant-conversation-follow-up.test.ts
```

</details>

## Remaining review work

- The owner's working tree was outside this isolated clone. Reconcile the held files against those local edits before any real merge. The added migrations may need renumbering if another change claims 035 or 036 in the target by then.
- Source inspection found that an acknowledgement inserted by manners before dispatch can leave the conversation-state hook looking at an assistant message where it expects the active user request. A mixed preceding turn can also miss the immediate source anchor. Upstream focused tests exercise manners and source follow-up separately. This mixed path remains unverified.
- The original Nile example still follows the legacy generic-topic path with conversation-state decision mode off. The repaired test explicitly enables the new mode. Live sources, production PostgreSQL and trained-model parity were outside this offline run.
