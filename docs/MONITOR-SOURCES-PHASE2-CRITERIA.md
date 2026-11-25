# Phase 2 monitor simulation criteria

Phase 2 uses the [v2 seeded testbed](../scripts/monitor-simulation/run.ts) with a separate SHA-256 seed namespace for each new source class. The tuning bank contains 32 trials per class. The held-out bank contains 64 trials per class and is scored only after the criteria and candidate are frozen. Each trial enrolls one monitor for one virtual week and uses production reads, evaluation and scheduling with controlled network, browser and OCR fixtures.

The classes cover pull request states, flapping CI status, release publication, PDF revisions and rendered values with noisy OCR. Each class includes trials with no qualifying event. Confidence noise can contain an incorrect but plausible value. Ground truth comes from the generated publication or state timeline independently of the reader. As in v2, any qualifying occurrence can satisfy a one-shot monitor. A delivery must match a real event at its observation time. Duplicate or unmatched condition alerts count as false alarms. Clarification and health pauses are recorded separately.

| Gate | Held-out threshold | Rationale |
| --- | --- | --- |
| Recall | At least 90% in each class | A monitor can miss opportunities when status flaps, a request is unavailable or an ambiguous image needs review. A separate gate per class exposes weak coverage. |
| Precision | 100% in each class with qualifying trials | The rollout requires evidence for every alert. |
| False alarms | Zero per enrolled monitor-week | Negative trials and misleading visual readings must stay silent. |
| Mean detection delay | At most 360 minutes in each class | The v2 maximum quiet polling interval is six hours. |
| p95 detection delay | At most 720 minutes in each class | A broad revision can require a second observation for confirmation. |
| Scheduled checks | At most 52 per monitor-week in each class | This is the v2 weekly ceiling of 28 quiet slots and 24 extra checks. |
| Low-confidence OCR alerts | Zero | Weak reads can cause a clarification or a pause. |
| GitHub request budget | Zero violations | Concurrent monitors across accounts and workers must stay within the documented-derived shared host budget. All dispatched API requests count, including conditional requests and retries. |

Recall divides matched opportunities by qualifying trials. Precision divides matched alerts by condition alerts. False alarms and checks use all enrolled monitor-weeks, including monitors that paused or completed early. Detection delays use matched observations only and p95 uses the nearest rank. Report counts and metrics by class and together. Score the candidate against these criteria once on the held-out bank. Record any failure against the frozen thresholds.
