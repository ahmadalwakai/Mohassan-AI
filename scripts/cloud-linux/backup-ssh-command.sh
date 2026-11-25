#!/bin/bash -p
set -euo pipefail
export LC_ALL=C
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

serve_backup() {
    local request=$1 directory=$2 pair digest extra file
    if ! IFS=' ' read -r pair digest extra < "$directory/current" ||
        [[ ! "$pair" =~ ^mohassan-[0-9]{4}-[0-9]{2}-[0-9]{2}$ || ! "$digest" =~ ^[0-9a-f]{64}$ || -n "$extra" ]]; then
        printf '%s\n' 'No published backup.' >&2
        return 1
    fi

    case "$request" in
        list) printf '%s %s\n' "$pair" "$digest"; return ;;
        "manifest $pair $digest") file="$pair.json" ;;
        "dump $pair $digest") file="$pair.dump" ;;
        *) printf '%s\n' 'Backup request refused.' >&2; return 1 ;;
    esac

    # A new generation may supersede this one during transfer. Once opened,
    # the stream keeps its original inode and the PC verifies its digest.
    cat -- "$directory/$pair-$digest/$file"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    serve_backup "${SSH_ORIGINAL_COMMAND:-}" /var/lib/mohassan-backup-pull/newest
fi
