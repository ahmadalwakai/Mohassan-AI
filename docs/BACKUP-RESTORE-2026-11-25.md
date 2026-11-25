# Production backup recovery runbook

Use this procedure to recover the PostgreSQL database from a verified backup after losing the production VM or database. Work on a replacement VM or a new isolated PostgreSQL 18 cluster. Keep the old API and all workers fenced off if they are still reachable. Before starting any writer, confirm the old host cannot resume jobs or accept production traffic.

## 1. Select and record the recovery point

1. On the owner's PC, select the newest complete `mohassan-YYYY-MM-DD.dump` and `mohassan-YYYY-MM-DD.json` pair. If the original VM can still be reached, you can also compare its newest locally verified pair. Keep the original backup copies while investigating failures.
2. Open the manifest privately. Record `snapshotAt` in UTC and choose the pair with the latest verified snapshot. Compare it with the time production stopped accepting writes. The gap is the potential data-loss window. Changes committed after the snapshot may need to be reconciled outside the restored database.
3. Transfer both files over the administrator's authenticated SSH connection to the replacement host. Use a directory accessible only to the administrator during transfer, then install the pair in a root-owned directory with mode `0700` and files with mode `0600`. Remove the transient transfer copies after checking the root copies. Treat the dump as production data. Use the administrator account for this transfer.

## 2. Prepare the replacement host

1. Install and start a PostgreSQL 18 cluster with a `postgres` maintenance database, its local peer-authenticated socket at `/var/run/postgresql`, and TCP bound to loopback for the API. Confirm the intended cluster with `pg_lsclusters` and leave port 5432 closed to the public network.
2. Prepare the API release using the [cloud deployment instructions](../scripts/cloud-linux/README.md). Choose a release compatible with the backup and preserve the private environment, auth and integration encryption keys, and any separately backed-up files you intend to restore. The database backup excludes the environment, database roles, browser profiles and files stored outside PostgreSQL. Install the reviewed environment privately and keep the API, backup timers and background workers stopped during database recovery.
3. As the local PostgreSQL administrator, create a login role for the API, using the application's previous role if it was unprivileged or a new unprivileged role if needed. In an interactive `psql` session connected to `postgres`, create the role with `CREATE ROLE "<app-role>" LOGIN;` and set its password with `\password "<app-role>"`. Update the private `DATABASE_URL` for that role and the replacement cluster. Keep the existing auth and encryption secrets. Set `RUN_WORKER=false` for the first startup and review the startup behavior outlined in the cloud README.

## 3. Verify and restore the archive

Run these commands in Bash as an administrator with `sudo`. Replace the date in the first line with the selected pair's date and use the actual API database role when prompted. This creates `mohassan` in the replacement cluster. If it already exists, stop and investigate which cluster you are connected to. Preserve any existing database for investigation.

```bash
set -euo pipefail
day=YYYY-MM-DD
dump="/var/backups/mohassan/recovery/mohassan-$day.dump"
manifest="/var/backups/mohassan/recovery/mohassan-$day.json"
pg_bin=/usr/lib/postgresql/18/bin
read -r -p 'Replacement API database login role: ' app_role
test -n "$app_role"
test "$app_role" != postgres

sudo /usr/local/bin/node /usr/local/sbin/backup-metadata.mjs check-archive "$dump" "$manifest"
restore_started=$(date -u +%s)
sudo -u postgres "$pg_bin/createdb" --host=/var/run/postgresql --port=5432 \
  --maintenance-db=postgres --template=template0 --owner="$app_role" -- mohassan
sudo cat -- "$dump" | sudo -u postgres "$pg_bin/pg_restore" --host=/var/run/postgresql --port=5432 \
  --dbname=mohassan --role="$app_role" --no-owner --no-acl --exit-on-error --single-transaction
printf 'Production database creation and restore took %s seconds\n' "$(( $(date -u +%s) - restore_started ))"
sudo /usr/local/bin/node /usr/local/sbin/backup-metadata.mjs verify-production-restore "$manifest"
```

Proceed only after the archive check, restore and verification all pass. Verification compares both migration ledgers and all table counts against the manifest and checks the relationships covered by the weekly drill. Capture the counts, verdicts and timings in the incident record. On failure, leave traffic fenced and review the pair and restore error privately. If a second candidate is needed, repeat on an empty replacement cluster and record the new snapshot and data-loss window.

PostgreSQL command references, retrieved 2026-11-25. [createdb](https://www.postgresql.org/docs/18/app-createdb.html), [pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html), [psql](https://www.postgresql.org/docs/18/app-psql.html).

## 4. Return the service to production

1. With traffic still fenced, start `mohassan.service` against the restored database, verify the expected account and release, and check the journal using `sudo journalctl --namespace=mohassan -u mohassan.service`. API startup can run migrations and recovery maintenance even with `RUN_WORKER=false`. Review restored pending work and external integrations before re-enabling workers so an action committed outside PostgreSQL after the snapshot is not performed again blindly.
2. Validate loopback and the replacement HTTPS origin with `scripts/check-cloud.mjs`. Verify owner sign-in and a read-only request through the frontend. Update Caddy, DNS or the Vercel API origin as needed for the replacement VM, keeping the old API fenced. Verify public health and an owner session after cutover, then restore desired worker operation and record when the service was usable.
3. Run a new backup, enable and verify both timers, authorize the PC against the replacement host's verified SSH host key, and verify an off-server copy. Preserve the original incident backup and reports under the owner's retention decision.

## What the weekly drill measures

- **Recovery point.** `snapshotAt` is the timestamp of the exported database snapshot. `recoveryPointAgeSeconds` measures how old that snapshot was when the drill began. In a VM loss, use the snapshot of the newest verified pair still available off-server. An off-server receipt's download time gives evidence of transfer, and the manifest gives the actual data recovery point.
- **Recovery time.** `restoreDurationMs` measures the archive load into the scratch database. Use the latest passing report as a measured database-load time. Recovering the whole service also takes time to replace the VM, transfer the archive, configure secrets and roles, verify application behavior and restore traffic. Record the full outage-to-service interval separately during an incident.
