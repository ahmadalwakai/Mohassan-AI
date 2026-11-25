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
lock="$directory/.backup.lock"
[[ ! -L "$lock" && ( ! -e "$lock" || -f "$lock" ) ]] || exit 1
exec 9>"$lock"
flock -w 30 9 || { printf '%s\n' 'Could not acquire the daily backup lock.' >&2; exit 1; }

exec env -i PATH="$PATH" LC_ALL=C /usr/local/bin/node "$(dirname -- "${BASH_SOURCE[0]}")/backup-metadata.mjs" backup
