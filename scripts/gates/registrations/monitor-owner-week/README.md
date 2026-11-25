# Phase 1 owner-monitor week

Can owner-only smart monitors run on time, read their sources successfully, send useful alerts through the selected channels, and avoid repeated pauses? Evaluate one owner-only trial of 168 completed UTC hours. The owner approves the release commit, the UTC start, the delivery channels and every threshold before the first trial observation. Collect monitor evidence with `MOHASSAN_MONITORS_ENABLED=owner` and `PRODUCTION_METRICS_ENABLED=true`. [Wave 6 deployment](../../../../docs/DEPLOY-WAVE-6-2026-11-25.md#turn-on-owner-monitors)

## Proposed thresholds

| Metric | Threshold | Reason |
| --- | --- | --- |
| Due checks and lateness samples | At least 30 each | Establish a denominator for success and both percentiles. |
| Due-check lateness p50 and p95 | At most 20 s and 60 s | The worker polls every 30 s. Most checks should start promptly and at least 95% should start within two polls. |
| Check success rate | At least 95% | Readable sources and valid revalidations should account for nearly all finished checks. |
| Rated alerts, feedback coverage, helpful share | At least 5 rated alerts, 75% of alerts rated, and 80% of ratings helpful | Require several judgments and broad enough coverage before drawing a usefulness conclusion. |
| Feedback reasons | At most 1 «لم يتغير شيء مهم», at most 1 «تأخر التنبيه», and 0 «قيمة خاطئة» | Individual low-value or late alerts are reviewable. A wrong value or a repeated problem stops extension. |
| Conversation delivery | Exactly one conversation delivery per alert | The alert needs a durable place where the owner can review and rate it. |
| Tab, Web Push, and APNs deliveries | At least 1 per opted-in channel and 0 per channel omitted from the trial | Exercise each intended delivery path and verify that other channels stay inactive. The proposed plan includes tab delivery. |
| Pauses by reason | At most 3 manual, 1 missing and 1 unreachable, with at most 1 missing plus unreachable | Allow normal owner control and one isolated source failure while surfacing repeated source or scheduling problems. |

The machine-readable cases carry each cutoff and its reason. The existing automatic gate adapter compares each evaluator label to `pass`. All 19 cases must pass. Empty rate denominators and missing observations cannot produce a pass. The report uses counts and timings and carries no source content, URLs or account identifiers. [Proposed criteria](cases.jsonl) · [Production metrics](../../../../docs/PRODUCTION-METRICS-2026-11-25.md)

## Owner approval and trial window

1. Copy `registration.json`, `cases.jsonl` and `trial.json` to a private evaluation archive. Review the threshold cases before seeing the trial data. Fill the exact deployed commit and `startMs` in Unix milliseconds at a future UTC hour boundary. Confirm which of `tab`, `webPush` and `apns` will be exercised. Finalize the owner approval before the start. The end is the start plus `604800000` milliseconds. [Proposed registration](registration.json) · [Unapproved trial plan](trial.json)
2. From the reviewed source checkout, compute `sha256sum scripts/gates/monitor_trial.py "$trial_dir/cases.jsonl" "$trial_dir/trial.json"`. Store the evaluator digest in `trial.json` if it changed and recompute the plan's digest afterward. Update the exact cases and candidate SHA-256 values in the archived registration. If the owner changes the number of criteria, set both `minimum_counts.overall` and `minimum_passes.overall` to that number. Seal and start before the approved window opens. [Gate runner registration procedure](../../../../docs/GATE-RUNNER-2026-11-25.md#register-and-seal)

```bash
python3 -m scripts.gates seal "$trial_dir/registration.json"
python3 -m scripts.gates start "$trial_dir/registration.json" "$trial_dir/run" \
  --who owner --why 'Approved Phase 1 owner-only 168-hour trial'
```

## Evidence and result

Keep rollout in owner mode for the whole window. Rate the trial alerts with «مفيد» or «غير مفيد» and the optional reason. During the first UTC hour after the window ends, save the authenticated JSON response from `GET /api/ops/metrics` to `$trial_dir/metrics.json`. The evaluator matches `completedMonitorWeek.startMs` and `endMs` to the approved boundaries, and requires healthy metric snapshots and timing collection. Complete ratings before export to fix the evidence snapshot. Keep the original export in the archive. [Production metrics access](../../../../docs/PRODUCTION-METRICS-2026-11-25.md)

```bash
set -o noclobber
python3 -m scripts.gates.monitor_trial "$trial_dir/run" "$trial_dir/metrics.json" \
  > "$trial_dir/run/predictions.jsonl"
python3 -m scripts.gates record "$trial_dir/run" --role candidate \
  --provenance "$trial_dir/run/candidate-provenance.json"
python3 -m scripts.gates pack "$trial_dir/run"
python3 -m scripts.gates decide "$trial_dir/run"
```

The prediction rows record each measured value, its threshold and the metrics export SHA-256. The owner reviews the write-once gate report and supporting counts before deciding whether to extend rollout. An invalid window, missing evidence or a failed threshold blocks extension. The archived threshold registration requires the owner's seal before the trial. [Gate runner decisions](../../../../docs/GATE-RUNNER-2026-11-25.md#read-and-preserve-the-decision)
