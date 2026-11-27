# Reviewed answer feedback

Set `FEEDBACK_LOOP_ENABLED=1` on the server to enable the owner's review page and apply reviewed source decisions. It defaults to off. Owners can continue to rate answers through the same conversation feedback controls when it is off. The standard answer rating controls are hidden for members because the existing submit route is owner-only.

The chat menu links to **ملاحظات الإجابات** when review is enabled. Select a recorded source to prefer or exclude it on later matching questions from the same owner account. Follow-up questions must also match their previous question. Dismiss a rating to review it without creating a source rule. Clear a decision to return it to the pending queue. An exclusion takes precedence if another review prefers the same source.

The chat's existing search and relevance checks still find the candidates. Reviews can change their order or exclude a candidate, including a blocked redirect. Ratings and notes never supply answer text. Migration `049_feedback_loop` adds source metadata and review decisions, and removes credential-bearing notes recognized by the judge diagnostics filter from existing rating events. Historical ratings remain visible and can be dismissed. Source decisions are available only for answers whose evidence was recorded with the feature enabled.

Run the local replay against fictional sources with:

```sh
VITEST=1 FEEDBACK_LOOP_ENABLED=1 npm exec -- tsx scripts/quality/replay-feedback.ts
```

The replay uses the normal chat controller with an in-process database and local source fixtures. It checks the selected source before rating, while the rating is pending, after review, for a member, and after clearing the review.
