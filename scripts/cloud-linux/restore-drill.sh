#!/usr/bin/env bash
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C

[[ "$(uname -s)" == Linux && "$EUID" -eq 0 ]] || { printf '%s\n' 'Run the restore drill as root on the Linux database host.' >&2; exit 1; }
directory=/var/backups/mohassan/daily
[[ -d "$directory" && "$(realpath -e -- "$directory")" == "$directory" ]] || exit 1
for lock in "$directory/.restore-drill.lock" "$directory/.backup.lock"; do
    [[ ! -L "$lock" && ( ! -e "$lock" || -f "$lock" ) ]] || exit 1
done
exec 8>"$directory/.restore-drill.lock"
flock -n 8 || { printf '%s\n' 'A restore drill is already running.' >&2; exit 1; }
exec 9>"$directory/.backup.lock"
flock -s -w 900 9 || { printf '%s\n' 'Could not acquire the backup lock for the restore drill.' >&2; exit 1; }

exec env -i PATH="$PATH" LC_ALL=C /usr/local/bin/node "$(dirname -- "${BASH_SOURCE[0]}")/backup-metadata.mjs" drill "$@"
