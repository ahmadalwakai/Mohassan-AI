# Arabic folding adoption candidates

The 69 alef-folding replacements below span 62 non-test files under
`apps/server/src` and `packages`. The inventory counts literal alef-class
`.replace` expressions at the production baseline and omits the two consumers
migrated here, `assistant/reply-check.ts` and `assistant/clarify/policy.ts`.
Line numbers refer to [commit `29448ae`](https://github.com/ahmadalwakai/Mohassan-AI/commit/29448aea3fa10d226ef82ec5bf0a65e723d6ec39).

The brain track owns the `mind/` candidates. Memory search folding is tracked
in `fix/memory-reliability`.

- `apps/server/src/assistant/action-completion.ts:43`
- `apps/server/src/assistant/brain.ts:58`, `apps/server/src/assistant/brain.ts:64`
- `apps/server/src/assistant/compound-request.ts:24`, `apps/server/src/assistant/compound-request.ts:89`
- `apps/server/src/assistant/computation-reference.ts:22`
- `apps/server/src/assistant/computer-request-language.ts:13`
- `apps/server/src/assistant/computer-request-scope.ts:22`
- `apps/server/src/assistant/conversation-state-decisions.ts:39`
- `apps/server/src/assistant/conversation-state-page.ts:33`
- `apps/server/src/assistant/conversation-state.ts:318`
- `apps/server/src/assistant/current-memory-declaration.ts:11`
- `apps/server/src/assistant/hands.ts:156`
- `apps/server/src/assistant/image-reading.ts:39`
- `apps/server/src/assistant/inventory.ts:28`
- `apps/server/src/assistant/memory-recall.ts:86`
- `apps/server/src/assistant/memory-save-authorization.ts:17`
- `apps/server/src/assistant/memory-verification.ts:72`
- `apps/server/src/assistant/mind/computation-consumption.ts:46`
- `apps/server/src/assistant/mind/compute.ts:308`
- `apps/server/src/assistant/mind/extract.ts:41`
- `apps/server/src/assistant/mind/normalize.ts:17`
- `apps/server/src/assistant/mind/recall-coverage.ts:35`
- `apps/server/src/assistant/mind/recall.ts:46`, `apps/server/src/assistant/mind/recall.ts:73`
- `apps/server/src/assistant/preferred-language-fact.ts:19`
- `apps/server/src/assistant/public-conversation-followup.ts:29`
- `apps/server/src/assistant/public-query-provenance.ts:19`
- `apps/server/src/assistant/refusal/learned-classifier.ts:22`
- `apps/server/src/assistant/refusal/replies.ts:67`
- `apps/server/src/assistant/releases.ts:66`
- `apps/server/src/assistant/reply-directive.ts:37`, `apps/server/src/assistant/reply-directive.ts:178`
- `apps/server/src/assistant/request-constraints.ts:20`, `apps/server/src/assistant/request-constraints.ts:53`
- `apps/server/src/assistant/request-context.ts:104`
- `apps/server/src/assistant/request-scope.ts:41`
- `apps/server/src/assistant/response-policy-context.ts:21`, `apps/server/src/assistant/response-policy-context.ts:29`
- `apps/server/src/assistant/return-to.ts:22`
- `apps/server/src/assistant/review/language.ts:22`
- `apps/server/src/assistant/review/ledger.ts:60`
- `apps/server/src/assistant/router.ts:51`
- `apps/server/src/assistant/runtime-status.ts:124`
- `apps/server/src/assistant/slot-date-place-tagger.ts:257`
- `apps/server/src/assistant/slot-tagger.ts:252`
- `apps/server/src/assistant/structured-evidence-parsing.ts:43`
- `apps/server/src/assistant/structured-evidence.ts:140`
- `apps/server/src/assistant/tools.ts:89`
- `apps/server/src/assistant/unsupported-request.ts:11`
- `apps/server/src/assistant/user-fact-memory-receipt.ts:32`
- `apps/server/src/assistant/user-fact-memory-verification.ts:58`
- `apps/server/src/assistant/word-problem-arabic.ts:13`
- `apps/server/src/command-chat.ts:2513`
- `apps/server/src/monitors/page.ts:25`
- `apps/server/src/reminders/chat.ts:31`
- `apps/server/src/reminders/time.ts:108`
- `apps/server/src/v5-chat.ts:72`
- `packages/browser/src/search/ranking.ts:5`, `packages/browser/src/search/ranking.ts:23`
- `packages/desktop/src/apps.ts:39`
- `packages/desktop/src/native.ts:109`
- `packages/desktop/src/projects.ts:25`
- `packages/learning/src/brain-assessment.ts:66`
- `packages/learning/src/evaluation.ts:90`
- `packages/learning/src/lessons.ts:12`
- `packages/scratch-classifiers/src/features.ts:56`
- `packages/sites/src/text.ts:8`
- `packages/skills/src/stems.ts:11`
