# Deploy Wave 6 from the production baseline

**الخلاصة**

خذ نسخة احتياطية موثقة قبل نقل الإنتاج من `f015a18` إلى النسخة المعتمدة من `feat/monitors-phase1`. افحص Node 24 وChromium وPython مع `libseccomp` بحساب الخدمة، ثم ابدأ بمفاتيح التشغيل الجديدة مطفأة. شغّل الخادم ومفتاح عامل الطابور مطفأ حتى تنتهي الترحيلات وتنجح فحوص الصحة. بعد التحقق، فعّل المراقبات للمالك وحده وجرّب التنبيه والتقييم من محادثة الويب. يعتمد المالك حدود تجربة الأسبوع ويختمها قبل بدئها. عند التراجع أطفئ المفاتيح وأعد نشر `f015a18` عند الحاجة. استخدم النسخة الاحتياطية فقط عند فشل ترحيل قاعدة البيانات وثبوت الحاجة إلى الاستعادة.

## VM prerequisites

Use the existing Ubuntu 24.04 ARM64 VM, Caddy and local PostgreSQL 18. The systemd API unit uses `/usr/local/bin/node` from a verified Node 24 ARM64 distribution and runs as `mohassan`. Install the locked dependencies and the Playwright Chromium build with the existing Linux preparation procedure. Chromium and its Linux libraries must be available to `mohassan`, with the browser cache at `/var/lib/mohassan/ms-playwright`. Keep the existing persistent profile, state directories and frontend origin. [Linux deployment procedure](../scripts/cloud-linux/README.md#prerequisites)

Verified coding needs Linux, `libseccomp.so.2`, and Python 3.11 or newer. The default is `/usr/bin/python3`. Set `TEST_DRIVEN_CODING_PYTHON` only for an absolute override. The resolved interpreter must be owned by root with no set-ID bits. The service account needs execute access and must lack write access to the interpreter and its resolved parent directories. Run the separate worker smoke check as `mohassan` before ever enabling verified coding. [Verified coding procedure](MODELS-RUNBOOK.md#verified-python-coding-on-the-vm)

Once the target source and Chromium are in place, run the read-only preflight on the VM, with the target flags in the root-owned mode-0600 `/etc/mohassan/server.env`.

```bash
sudo /usr/local/bin/node /opt/mohassan/app/scripts/cloud-linux/preflight-wave-6.mjs
```

Exit 0 means the checked runtime and configuration passed. The script reads the environment file, probes the interpreter under the service identity, and checks the locked Chromium executable and optional signing configuration. It reports fixed check names and keeps values private. The separate browser smoke check renders and captures an isolated page. [Browser smoke check](../scripts/cloud-linux/README.md#configuration-and-staging)

## Environment changes

Keep the existing `DATABASE_URL` for the loopback PostgreSQL 18 cluster, the exact `WEB_ORIGIN`, authentication and internal API secrets, and existing integration encryption keys. Preserve the Caddy listener and frontend `MOHASSAN_SERVER_URL`. Apply configuration privately in `/etc/mohassan/server.env` using its `KEY=value` syntax. [VM settings](../scripts/cloud-linux/README.md#configuration-and-staging)

Start with these values for new runtime switches. Preserve explicitly approved pre-existing settings where they carry forward from `f015a18`.

| Initial value | Environment variables |
| --- | --- |
| `0` | `MOHASSAN_MONITORS_ENABLED`, `MOHASSAN_REPLY_POLICY_ENABLED`, `MOHASSAN_CONTEXT_POLICY_ENABLED`, `MOHASSAN_LONG_RUN_ENABLED`, `MOHASSAN_BACKGROUND_RESULTS_ENABLED` |
| `0` | `MOHASSAN_ARBITER_ROUTING`, `MOHASSAN_ARBITER_QUESTION_REWRITE`, `MOHASSAN_ARBITER_LOCAL_COMPUTATION`, `MOHASSAN_ARBITER_COMPOUND_PLAN`, and their four `_KILL` switches |
| `0` | `MOHASSAN_SMALL_TALK_MANNERS`, `MOHASSAN_CONVERSATION_REVIEW_APPLY`, `MOHASSAN_CONVERSATION_SHADOW`, `MOHASSAN_STRUCTURED_MEMORY`, `MOHASSAN_EXTRACTIVE_WRITING`, `MOHASSAN_REASONING`, `MOHASSAN_CLARIFY_CHOICES`, `MOHASSAN_SCRATCH_CLASSIFIERS`, `MOHASSAN_REFUSAL_POLICY`, `MOHASSAN_QUESTION_REWRITER`, `MOHASSAN_ARITHMETIC_SEARCH`, `MOHASSAN_MODEL_WORKER` |
| `off` | `MOHASSAN_PLAN_COMPILER`, `MOHASSAN_MODEL_RELATIONS` |
| `false` | `TEST_DRIVEN_CODING_ENABLED`, `PRODUCTION_METRICS_ENABLED`, `RUN_WORKER` |
| Unset | `MOHASSAN_DESKTOP_SHELL`, `MOHASSAN_ROUTER_SHADOW`, `EXECUTOR_EXPERIMENT` |

The initial explicit `PRODUCTION_METRICS_ENABLED=false` overrides its production default. Enable metrics for the owner trial after the base release is healthy. If push is desired, set all three `WEB_PUSH_VAPID_*` settings with a stable matching key pair and contact, or all four `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_PATH`, and `APNS_BUNDLE_ID` settings with a restricted private key readable by `mohassan`. Web Push and APNs are each optional. Conversation alerts work independently of push. [Wave 5 rollout switches](INTEGRATION-WAVE-5-2026-11-25.md#rollout-flags-and-environment) · [Push setup](BACKGROUND-RESULTS.md)

## Before deploying

The recorded pre-manifest production API commit on 2026-11-27 is `29448aea3fa10d226ef82ec5bf0a65e723d6ec39`. Use it for the one-time `--deployed` argument only while it is the running release. [Commit](https://github.com/ahmadalwakai/Mohassan-AI/commit/29448aea3fa10d226ef82ec5bf0a65e723d6ec39)

1. Record the current frontend commit and preserve the current API source and release manifest for rollback. Package the reviewed API commit from a clean checkout with `node scripts/package-cloud.mjs`. Compare the new manifest against the current production manifest before transfer, then run `verify-snapshot.mjs` on the staged VM source and its manifest. Stop on a comparison or verification failure. Use the recorded running commit for the first comparison if the current deployment predates manifests. Keep the existing release in place until the drain has completed. [Commands and first-release procedure](../scripts/cloud-linux/README.md#release-provenance)
2. Fence off new work. Drain chat runs, tasks, skills, benchmarks and active previews, and stop the old API and any standalone workers. Confirm their supervisors cannot restart them. Wait for running backup and restore-drill jobs before replacing source or operations files. [Cutover order](../scripts/cloud-linux/README.md#cutover-and-verification)
3. Run the installed backup job before the first migrated startup. Confirm its exit status and privately confirm the manifest's `snapshotAt`, digest and archive size. Verify an independent copy on the owner's PC. A same-UTC-day rerun reuses the already completed pair. Record any gap from that snapshot to the drained database, and confirm the recovery point is acceptable before proceeding. [Backups and restore drill](../scripts/cloud-linux/README.md#backups-and-restore-drill) · [Recovery point](BACKUP-RESTORE-2026-11-25.md#1-select-and-record-the-recovery-point)

```bash
sudo systemctl start mohassan-backup.service
sudo journalctl -u mohassan-backup.service -n 20
sudo /usr/local/bin/node /usr/local/sbin/backup-metadata.mjs check-archive "$dump" "$manifest"
```

Set `dump` and `manifest` to the existing verified archive and manifest paths under `/var/backups/mohassan/daily` before running the archive check.

## Database migration plan

The production baseline is `f015a1813c700c7cfd2f599a8095dd531a2ed1e4`. Keep PostgreSQL 18 and the existing application login. Use one API writer for the first start. Startup applies migrations even with `RUN_WORKER=false` and all rollout switches off. Capture both ledger tables before the start, after startup and after one controlled restart. Query the local cluster using read-only SQL, ordered by `applied_at` and `version`.

| Ledger | Expected new versions from `f015a18` |
| --- | --- |
| `schema_migrations` | `035_chat_conversation_review`, `037_notifications`, `036_structured_memory`, `038_reminders`, `039_conversation_shares`, `040_member_data_rights`, `041_long_run_checkpoints`, `042_background_results`, `043_smart_monitors`, `044_monitor_alert_feedback` |
| `auth_schema_migrations` | `003_member_run_quota` |

The Phase 1 rehearsal on disposable PostgreSQL 18.7 ran the real API startup at `05beb0be90916522bfbaf545084996fff0e6472f` with smart monitors and the queue worker off. Fresh and Wave 5 upgrade paths passed. The production path installed the exact `f015a18` baseline and seeded 12 representative rows before upgrade. All 51 original rows across 115 tables matched on their original columns, including ledger timestamps. The upgraded database recorded 47 application and three auth entries and one new member quota reservation for a recent run. Another startup added no entries or changes to rows or schema. Check that the approved release matches the versioned plan and that restart preserves the observed ledgers. [Migration ledger](MIGRATION-LEDGER-2026-11-25.md)

## Deploy and verify

1. With the old API stopped and the backup verified, place the reviewed source at `/opt/mohassan/app` without old dependencies, `.data` or private environment files. Preserve the pre-cutover source and host-specific unit settings. Where the existing Linux procedure calls for dependency or Chromium preparation, run `sudo bash /opt/mohassan/app/scripts/cloud-linux/prepare.sh` with the service stopped. Review differences to any installed unit before replacing it. Run the preflight and Chromium smoke check with the target installed. [Linux source preparation](../scripts/cloud-linux/README.md#prerequisites)
2. Keep traffic fenced and start `sudo systemctl start mohassan.service` with the new rollout flags and `RUN_WORKER` off. Check `systemctl is-active mohassan.service`, inspect `sudo journalctl --namespace=mohassan -u mohassan.service`, and confirm both ledgers. If startup fails, leave traffic fenced and determine whether the migration or a runtime prerequisite failed.
3. Run `node scripts/check-cloud.mjs http://127.0.0.1:4000` and `node scripts/check-cloud.mjs "$trusted_api_origin"` from the installed release with `INTERNAL_API_SECRET` provided privately in the verifier's environment. Check public health, the service auth boundary, setup closure and anonymous session rejection. Use `--owner-session-stdin` to check the dump, restore drill and off-server copy warnings. Keep credentials out of command arguments and logs. [Health and authenticated backup verification](../scripts/cloud-linux/README.md#backups-and-restore-drill)
4. Restore the existing queue worker setting once the single API writer is healthy. Restart and verify health and both ledgers again. If `MOHASSAN_MODEL_WORKER=1` is enabled, add `--expect-model-worker` to the final API verifier and require it to pass. Promote the verified manifest to `/opt/mohassan/release-manifest.json` before reopening traffic. Deploy the matching reviewed web snapshot through the existing frontend procedure with the same API origin. Verify owner sign-in, preserved conversation history, one read-only chat response, and browser access to a controlled public page. Retain the verified backup and restore the existing backup and restore-drill timers. [Cutover verification](../scripts/cloud-linux/README.md#cutover-and-verification)

## Turn on owner monitors

1. Set `MOHASSAN_MONITORS_ENABLED=owner` and `PRODUCTION_METRICS_ENABLED=true`, with the state directory writable by `mohassan`. Run the preflight with `--owner-trial` and restart the API. Use a member session to confirm that the monitor settings and proposals are absent and that listing monitors is denied. Keep `MOHASSAN_MONITORS_ENABLED=1` off during Phase 1.
2. In an owner web conversation, request a monitor for a controlled public page with a known baseline and a clear trigger. Review the proposed source and value, approve it, and confirm the next check. Verify the owner can pause and resume the monitor. Change the controlled fixture, then verify the alert appears in the conversation and on the card. Submit «مفيد» or «غير مفيد» and verify that both surfaces display the saved answer after refresh. Confirm the owner production metrics reflect the check, delivery and feedback.
3. If a push channel is configured for the trial, exercise a subscribed browser or registered iPhone using the existing account settings. Close or stop the smoke monitors. The owner approves and seals the thresholds before the seven-day window begins. [Owner-week gate registration](../scripts/gates/registrations/monitor-owner-week/README.md)

## Rollback

1. Turn monitors and the other new runtime switches off, restore the initial values above, and restart. If push dispatch also needs to stop, clear the newly configured APNs or VAPID group privately. Confirm health and that monitor detection and scheduled checks stop.
2. If needed, fence traffic, drain and stop all Wave 6 writers, and restore the previous verified API and matching frontend snapshots. Compare the rollback candidate with the deployed release before installing it. The original Wave 6 rollback target was `f015a18`; check that the rollback candidate retains later production fixes. Verify the restored service against the existing database, then promote its manifest before returning traffic. Keep successful additive migrations and the existing data.
3. Restore a verified backup only after a failed migration requires database recovery. Keep writers stopped, preserve the failed database for diagnosis, and follow recovery into an empty replacement PostgreSQL 18 database. Verify the archive, restored ledgers, counts and integrity before returning traffic. [Backup recovery runbook](BACKUP-RESTORE-2026-11-25.md#3-verify-and-restore-the-archive)

The redirect-header fix was carried separately in PR #99. Compare against the running release's recorded commit so both redirect paths are checked even when the fix was ported under different commit IDs. [PR #99](https://github.com/ahmadalwakai/Mohassan-AI/pull/99)
