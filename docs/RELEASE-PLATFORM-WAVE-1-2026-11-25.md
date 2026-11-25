# Platform wave 1 release notes — 25 November 2026

تجمع هذه الدفعة ١٣ طلب دمج لموحسن، وتشمل النسخ الاحتياطي واستعادة قاعدة البيانات، ومقاييس التشغيل، والإشعارات والتذكيرات، ومشاركة المحادثات، وحقوق بيانات الأعضاء. تُطبَّق الترحيلات الأربعة عند بدء الخادم. قبل النشر، يلزم قرار المالك بشأن شروط Open‑Meteo، وتعديل مسار الحساب في العقل C، وترتيب الدمج مع دفعات الوكلاء. لم يُنفّذ هذا العمل أي خطوة على الإنتاج.

## Included pull requests

The integration starts at `c2a0ff765071657cf200b5ee7d12fabaad738c0b` on `feat/skill-engine`.

- `3a4ff3c35584a86df6bab75dce1aad228f2a16a3` — Verified PostgreSQL backups, weekly restoration drills, off-server Windows pulls, owner backup status and log rotation. [#64](https://github.com/ahmadalwakai/Mohassan-AI/pull/64)
- `74e85830758e2e6e20fa23a9daafd9afeec30419` — Owner dashboard and CSV for privacy-filtered HTTP, chat and resource metrics. [#67](https://github.com/ahmadalwakai/Mohassan-AI/pull/67)
- `cc577ba70d2a85500f7d712c432f4965660973fa` — Local owner training monitor for progress, GPU sampling and attempts. [#17](https://github.com/ahmadalwakai/Mohassan-AI/pull/17)
- `2dd30cb94f36da99e73cd6afddee25f0235e1c09` — Offline blind evaluation runner with pinned criteria, verdicts and decision records. [#16](https://github.com/ahmadalwakai/Mohassan-AI/pull/16)
- `b43ee56c3d2a914cc016da9c9a310ea3e500a941` — Corpus filtering, deduplication, contamination reporting and review handoff tooling. [#15](https://github.com/ahmadalwakai/Mohassan-AI/pull/15)
- `0915bdc450fbdbad52ac2ed74ebf6c73417c872b` — Standalone structured evidence extraction from page reads. [#18](https://github.com/ahmadalwakai/Mohassan-AI/pull/18)
- `9eab15c0ba9c4880b657e10a0fb7478dfb424dab` — Opt-in resident local model worker with bounded batching, cancellation and health reporting. [#19](https://github.com/ahmadalwakai/Mohassan-AI/pull/19)
- `65e701499ddf75acea1da12e6284fbeaf196773a` — Deterministic coding repairs with verification and the existing sandbox boundary. [#21](https://github.com/ahmadalwakai/Mohassan-AI/pull/21)
- `81f3304e5840bfda42cac2e2b1635cbc52912687` — Direct chat responses for Hijri dates, prayer times, weather and exchange rates. [#68](https://github.com/ahmadalwakai/Mohassan-AI/pull/68)
- `ae8b33121f312fce5a75e32fb7a21ac64946d7b6` — Account-scoped Web Push and hidden-tab notifications for chat outcomes. [#20](https://github.com/ahmadalwakai/Mohassan-AI/pull/20)
- `bccfe23ed5cf74157bcdd354d4f308da694d55a6` — Arabic and English chat reminders, recurrence, and a reminders panel. [#65](https://github.com/ahmadalwakai/Mohassan-AI/pull/65)
- `4e6d5bacb60a9437aaceecee45e3f62c6db95662` — Markdown and PDF exports, privacy review and revocable public snapshots. [#66](https://github.com/ahmadalwakai/Mohassan-AI/pull/66)
- `eb0b47e566b5911c33b6b48ccd41f4917812956e` — Member ZIP exports, session controls, deletion with a recovery window and owner audit history. [#69](https://github.com/ahmadalwakai/Mohassan-AI/pull/69)

## Database migrations

Start with a verified PostgreSQL backup and apply these four migrations in order through normal API startup. The legacy IDs are accepted for databases that already ran the corresponding individual PR. For reserved agent numbers and other collisions, see the [migration ledger](MIGRATION-LEDGER-2026-11-25.md).

| Order | Final ID | Legacy ID | One-time work |
| --- | --- | --- | --- |
| 1 | `037_notifications` | `035_notifications` | Startup creates notification preferences, browser subscriptions, presence and chat notification tables. Generate and install one VAPID key pair if enabling push. |
| 2 | `038_reminders` | `036_reminders` | Startup creates the reminder, delivery and time-zone tables after chat and auth exist. Users supply their time zone in chat. |
| 3 | `039_conversation_shares` | `038_conversation_shares` | Startup adds nullable run provenance to chat messages, creates snapshot and settings tables, and enables creation of member shares by default. Review the owner switch in member settings before opening traffic. |
| 4 | `040_member_data_rights` | `037_member_data_rights` | Startup installs the member deletion, export and audit tables, session guard and audit triggers after auth and workspace membership exist. Review outstanding deletion requests if the database has already used this feature. |

Reminders use Web Push when it is configured and a device accepts the notification. The scheduler writes a reminder into the conversation when push is unavailable or fails. A deletion request revokes public share links and push subscriptions on commit and pauses future reminder deliveries. Cancelling the request resumes the schedule. The member must create new share links and register devices again. [Reminder behavior](REMINDERS-2026-11-25.md) · [Member data rights](MEMBER-DATA-RIGHTS-2026-11-25.md)

## Configuration and host changes

Set server values privately in `/etc/mohassan/server.env`. Preserve the current PostgreSQL `DATABASE_URL`, `BETTER_AUTH_SECRET`, `INTERNAL_API_SECRET` and existing integration encryption secrets. Generate any VAPID keys in a private file with `node apps/server/scripts/generate-vapid-keys.mjs .env.web-push.local` and keep the same pair across restarts and release changes. [Notification setup](NOTIFICATIONS-2026-11-25.md)

| Server variable | Default | Purpose |
| --- | --- | --- |
| `WEB_PUSH_VAPID_SUBJECT` | Unset | `mailto:` or public HTTPS contact for the push service. |
| `WEB_PUSH_VAPID_PUBLIC_KEY` | Unset | Public key for browser subscriptions. All three VAPID values are required to enable push. |
| `WEB_PUSH_VAPID_PRIVATE_KEY` | Unset | Server-only signing key. |
| `PRODUCTION_METRICS_ENABLED` | `true` in production and `false` elsewhere | Collects aggregate metrics. Restart the API after changing it. |
| `PRODUCTION_METRICS_DIR` | `production-metrics` under `STATE_DIRECTORY`, otherwise `.data/production-metrics` | Persistent snapshots. On the standard systemd service this is `/var/lib/mohassan/production-metrics`. Grant the API service write access to a custom location. |
| `MOHASSAN_MODEL_WORKER` | Off | Set to `1` to start the optional worker with approved local artifacts. Keep off during the platform rollout. |
| `MOHASSAN_MODEL_WORKER_CONFIG` | `.data/model-worker.json` | Config path relative to the repository root unless absolute. The existing `EXECUTOR_PYTHON` override selects the interpreter. The worker otherwise uses `.venv-execution/bin/python` on Linux or `.venv-execution/Scripts/python.exe` on Windows. |

Vercel needs the existing `MOHASSAN_SERVER_URL` for the HTTPS API origin and matching `INTERNAL_API_SECRET`. No new manually configured Vercel variables are required. Member session metadata uses Vercel's `VERCEL` flag and platform-provided `x-vercel-forwarded-for` header. [Environment example](../.env.example) · [Vercel request headers, retrieved 25 November 2026](https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for)

| Host item | Changes |
| --- | --- |
| Daily backup | Revised `mohassan-backup.service` and existing `mohassan-backup.timer` at 03:15 UTC with up to 15 minutes of jitter. The service needs `/var/backups/mohassan/daily`, `/var/lib/mohassan-backup-status` and `/var/lib/mohassan-backup-pull/newest`. |
| Restore drill | New `mohassan-restore-drill.service` and `.timer` on Sundays at 05:00 UTC. The service restores into a date-scoped scratch database on the existing PostgreSQL cluster. It retains the latest 12 drill reports in `/var/lib/mohassan-backup-status`. |
| SSH pull | New system user and group `mohassan-backup-pull` with home `/var/lib/mohassan-backup-pull`. `prepare.sh` creates its `.ssh` and `newest` directories and installs `/etc/ssh/sshd_config.d/00-mohassan-backup-pull.conf`. Configure the dedicated public key and reload SSH once. |
| Journal and judge | New drop-ins `/etc/systemd/system/mohassan.service.d/30-journal-namespace.conf` and `/etc/systemd/journald@mohassan.conf.d/30-size-cap.conf` start the `mohassan` journal namespace with 128 MiB persistent and 32 MiB runtime caps. Judge rotation uses the existing `MOHASSAN_JUDGE_LOG_DIR`, `/var/lib/mohassan/judge` in the standard cloud configuration. |
| Installed helpers | `prepare.sh` installs `backup-metadata.mjs`, `mohassan-db-backup`, `mohassan-db-restore-drill`, `mohassan-backup-publish` and `mohassan-backup-ssh-command` in `/usr/local/sbin`. |
| Owner's PC | Manually import the Windows Task Scheduler template after configuring and verifying a private SSH key and backup folder. The template runs daily at 05:00 UTC. The optional receipt uses a separate administrative SSH connection. The training monitor reads local `artifacts/execution-model-runs` and `.data/gpu.lock` when the API and web origins are local. |

See the [cloud deployment guide](../scripts/cloud-linux/README.md), [Windows pull guide](../scripts/backup-pull/README.md), [metrics guide](PRODUCTION-METRICS-2026-11-25.md) and [model worker guide](../packages/execution-integration/docs/permanent-model-worker.md).

## Deployment and rollback

These are owner-run production steps, after the decisions below. Use an isolated PostgreSQL copy for staging. A process with `RUN_WORKER=false` still runs migrations, reminders and maintenance, including member purge.

| Step | Deploy | Roll back |
| --- | --- | --- |
| 1. Fence work and protect the recovery point | Save the prior release, frontend deployment, private configuration and host unit edits. Stop new traffic and drain work, then stop the API, standalone workers and backup timers. Let any running backup or drill finish. Take a verified pre-release PostgreSQL backup and preserve the private on-disk state. | Before new startup, restore the old service and timer enablement and reopen the previous frontend after checking read-only health. Keep the verified backup. |
| 2. Prepare the VM | Put the reviewed release in the server checkout. Run `sudo bash /opt/mohassan/app/scripts/cloud-linux/prepare.sh`. It creates the backup directories **before** it installs and verifies `mohassan-backup.service`. Installing the service by itself leaves missing `ReadWritePaths`, which cause startup to fail. Apply the private server values, verify the installed units and SSH settings, then reload SSH only if enabling the pull. Keep the existing administrative session available for the SSH change. | With the services stopped, restore the saved source, private environment, unit files, helpers and drop-ins. Run `systemctl daemon-reload`, validate the restored SSH configuration and reload SSH. Leave verified backups intact. |
| 3. Start and migrate the API | With previous writers stopped, start one API with `RUN_WORKER=false`. Confirm normal startup, the migration ledger, loopback and HTTPS health. Verify owner sign-in and owner-only routes and review member sharing and any due reminders or deletions before reopening traffic. | Fence traffic and stop the new API and every worker. Return to the prior backend only after checking its compatibility with the migrated schema. The release has no down migrations. If full schema rollback is required, use the verified pre-release backup on an isolated replacement database and reconcile post-backup writes before directing traffic there. |
| 4. Deploy the Vercel frontend | Deploy the matching web revision after the API checks pass. Check sign-in, member restrictions, export downloads, public share and revocation, and a reminder on a disposable account. Verify push on a registered browser if VAPID is enabled. Restore the intended queue-worker setting after the checks, and confirm no previous writer can restart. | Roll Vercel back to the saved deployment and restore its matching origin and secret if they changed. Drain and stop the new backend before changing backends. Restore the previous queue-worker configuration. |
| 5. Turn on backup and drill jobs | After the live API is healthy, enable `mohassan-backup.timer` and `mohassan-restore-drill.timer`. Run the backup and drill once, confirm owner backup status, and verify the first off-server copy. Then import and test the owner PC task. | Disable the new timers and the Windows task and wait for running work to finish. Restore the prior backup unit and timer if reverting the deployment. Revoke the dedicated pull key if removing access and keep the verified copies and receipts. |

Application rollback cannot recall a sent push, copies of exported data or previously opened snapshots. Cancelling a deletion during its seven-day recovery window cannot recover revoked sessions or credentials. After purge starts, the application offers no cancellation, and restoring an earlier database or filesystem snapshot can discard newer work. Backup retention and log rotation can remove historical files, so preserve any required evidence independently before the cutover. [PostgreSQL recovery runbook](BACKUP-RESTORE-2026-11-25.md)

## Owner decisions before release

1. **Open-Meteo terms (#68).** Accept the usage terms for the configured hosted forecast and geocoding endpoints, or arrange compliant service before deploying live weather and place lookup. The free hosted API is for noncommercial use and subject to the published limits. Commercial deployment requires the appropriate arrangement. [Open-Meteo terms, retrieved 25 November 2026](https://open-meteo.com/en/terms) · [Licence](https://open-meteo.com/en/licence) · [PR documentation](LIVE-DATA-2026-11-25.md)
2. **Mind C ownership (#68).** Approve the original #68 patch in `apps/server/src/assistant/mind/compute.ts`. It adds four lines and removes four. The patch imports and invokes two Hijri helpers and retires the unsupported-Hijri response. Role D owns `mind/compute.ts`, and the documented role scope excluded Hijri calculations in its first version. [Mind C role assignments](BRAIN-AGENT-INSTRUCTIONS.md#الدور-د--المسارات-المحلية) · [PR #68](https://github.com/ahmadalwakai/Mohassan-AI/pull/68)
3. **Wave order.** Choose whether the platform wave merges before or after the agent waves. `integration/wave-1` uses `035_chat_conversation_review` and `036_structured_memory`, with `035_structured_memory` recognized as legacy. The platform wave uses `037`–`040`. Recheck the next agent branch and the shared Mind C and member-route hooks when combining the waves. [Migration ledger](MIGRATION-LEDGER-2026-11-25.md) · [Agent wave 1](https://github.com/ahmadalwakai/Mohassan-AI/pull/61)
