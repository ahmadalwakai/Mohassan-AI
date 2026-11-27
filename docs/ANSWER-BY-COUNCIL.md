# Answer by council

The owner’s 2026-11-27 decision was «يجب ان يكون الجواب ناتج عن مناقشة النماذج و البحث في النت». In this answer mode, a factual reply comes from a council decision on pages read for that turn.

## Enable the mode

| `MOHASSAN_ANSWER_MODE` | Behavior |
| --- | --- |
| `off` or unset | Use the existing chat and council behavior. This is the default. |
| `council-web` | Use planned public search and council v2 for factual answers in the council’s audience. |

The server reads the switch when it starts. This stack uses `MOHASSAN_MODEL_COUNCIL=owner` to enable the council for the owner. If `council-web` is set with the council disabled, the server logs that answer mode is inactive. The answer-mode switch grants no additional account access. The invited-member council is being developed separately. When integrating that work, use its account admission, queue, and fenced publication rules for this mode too. To return to the stacked chat behavior, set `MOHASSAN_ANSWER_MODE=off` and restart the server. The council v2 and source planner changes ship independently of this switch. [Council v2](MODEL-COUNCIL.md)

## Turn scope

Public factual questions, comparisons, explanations, live lookups, and factual follow-ups use the mode. The public-query gate still applies. If a user forbids search, or the gate cannot form a safe public query, the reply reports that verification was unavailable.

The existing handlers cover these exemptions:

- Arithmetic and other computations that use given inputs or the server clock.
- The user’s own memory, settings, account and workspace data, and Mohassan’s runtime status.
- Small talk, creative writing, and transformations of supplied content.
- Browser and computer actions, typed executors, reminders, and plans. An explicit browser command to open a supplied URL and read it stays on the browser-action route.
- Monitors and campaigns.
- Clarification, cancellation, and other run controls.

Edit `routeExemptions` and the source checks in the scope module to change this policy. Add Arabic and English examples to the scope tests for any changed rule. [Scope](../apps/server/src/assistant/answer-mode-scope.ts) · [Tests](../tests/answer-mode-scope.test.ts)

## Search, deliberation, and publication

The source planner uses the question’s language, source restrictions, subject, and freshness needs. The chat searches using that plan and reads ranked result pages through the existing public reader. A redirected page must still match the plan. A snippet can help rank results. Evidence comes from the actual page read. The configured search providers and page reader determine which requested sources are reachable.

The pipeline member makes an extractive proposal when it can cite a matching passage from the planned search. Council v2 runs the propose, check, vote, and decide rounds with that proposal and same-turn evidence. Its usual accuracy receipts and replacement rules apply. In this mode a pipeline decision also needs a verified citation and independent model support. The selected answer includes its source and a short council disclosure. The reply distinguishes missing evidence, missing model proposals or checks, and failure to agree. It names any usable pages it read.

The turn has a **45-second budget** for queueing, routing, public search, page reading, and council deliberation. It is measured from the stored request time on a fresh turn and from worker entry when a clarification resumes. A fresh turn that waits more than 45 seconds in the queue gets an immediate time-limit reply when it reaches the answer-mode worker. Chat progress shows the search and council stages. At the budget limit, completed checks and votes can yield the best verified decision so far, marked as time-limited. If no verified decision is available, the reply reports that. The final database transaction checks account and run authority before storing the response. Database stalls or synchronous event-loop delays can add time to delivery. [Answer runtime](../apps/server/src/assistant/council-web-answer.ts) · [Council decision](../apps/server/src/assistant/council-deliberation.ts)
