#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C

[[ "$(uname -s)" == Linux && "$EUID" -eq 0 ]] || { printf '%s\n' 'Run this backup as root on the Linux database host.' >&2; exit 1; }
directory=/var/backups/mohassan/daily
for ancestor in /var /var/backups /var/backups/mohassan "$directory"; do
    [[ ! -L "$ancestor" ]] || { printf '%s\n' 'Backup directories must not be symlinks.' >&2; exit 1; }
done
if [[ ! -e /var/backups/mohassan ]]; then install -d -o root -g root -m 0700 /var/backups/mohassan; fi
install -d -o root -g root -m 0700 "$directory"
[[ "$(realpath -e -- "$directory")" == "$directory" ]] || exit 1
[[ ! -L "$directory/.backup.lock" ]] || exit 1
exec 9>"$directory/.backup.lock"
flock -n 9 || exit 0

day=$(date -u +%F)
destination="$directory/mohassan-$day.dump"
[[ ! -L "$destination" ]] || exit 1
[[ ! -e "$destination" || -f "$destination" ]] || exit 1
temporary=$(mktemp "$directory/.mohassan-$day.XXXXXX")
cleanup() { if [[ -n "${temporary:-}" ]]; then rm -f -- "$temporary"; fi; }
trap cleanup EXIT

# The root shell owns the output file. postgres authenticates over its local peer socket.
# A clean environment avoids relying on connection strings or password files from the app.
runuser -u postgres -- env -i PATH=/usr/bin:/bin PGAPPNAME=mohassan_daily_backup \
    /usr/lib/postgresql/18/bin/pg_dump --host=/var/run/postgresql --port=5432 \
    --username=postgres --dbname=mohassan --no-password --format=custom --no-owner --no-acl > "$temporary"
[[ -s "$temporary" ]]
/usr/lib/postgresql/18/bin/pg_restore --list "$temporary" >/dev/null
chmod 0600 "$temporary"
mv -fT -- "$temporary" "$destination"
temporary=''

# Retention applies only to our exact daily filenames, never to migration backups.
shopt -s nullglob
backups=()
for backup in "$directory"/mohassan-????-??-??.dump; do
    name=${backup##*/}
    if [[ -f "$backup" && ! -L "$backup" && "$name" =~ ^mohassan-[0-9]{4}-[0-9]{2}-[0-9]{2}\.dump$ ]]; then
        backups+=("$backup")
    fi
done
if (( ${#backups[@]} > 7 )); then
    for ((index=0; index<${#backups[@]}-7; index++)); do
        rm -f -- "${backups[index]}"
    done
fi
printf 'Backup complete: %s (%s bytes)\n' "$destination" "$(stat -c %s -- "$destination")"
