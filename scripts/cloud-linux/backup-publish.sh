#!/usr/bin/env bash
set -euo pipefail
umask 077
export LC_ALL=C
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

publish_backup() (
    local dump=$1 manifest=$2 directory=$3 group=$4
    local pair=${dump##*/} digest generation temporary pointer old file
    pair=${pair%.dump}
    [[ "$pair" =~ ^mohassan-[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]
    [[ "$dump" == */"$pair.dump" && "$manifest" == "${dump%.dump}.json" ]]
    [[ -f "$dump" && ! -L "$dump" && -f "$manifest" && ! -L "$manifest" ]]
    [[ -d "$directory" && "$(realpath -e -- "$directory")" == "$directory" ]]
    [[ ! -L "$directory/current" && ( ! -e "$directory/current" || -f "$directory/current" ) ]]

    digest=$(sha256sum -- "$dump")
    digest=${digest%% *}
    generation="$directory/$pair-$digest"
    temporary=$(mktemp -d -- "$directory/.pair.XXXXXX")
    pointer=''
    # Invoked by the EXIT trap.
    # shellcheck disable=SC2329
    cleanup_publication() {
        if [[ -n "$temporary" ]]; then
            rm -f -- "$temporary/$pair.dump" "$temporary/$pair.json"
            rmdir -- "$temporary"
        fi
        if [[ -n "$pointer" ]]; then rm -f -- "$pointer"; fi
    }
    trap cleanup_publication EXIT
    if [[ -e "$generation" || -L "$generation" ]]; then
        [[ -d "$generation" && ! -L "$generation" ]]
        for file in "$pair.dump" "$pair.json"; do
            [[ -f "$generation/$file" && ! -L "$generation/$file" ]]
        done
        cmp -s -- "$dump" "$generation/$pair.dump"
        cmp -s -- "$manifest" "$generation/$pair.json"
    else
        install -g "$group" -m 0640 -- "$dump" "$temporary/$pair.dump"
        install -g "$group" -m 0640 -- "$manifest" "$temporary/$pair.json"
        chgrp -- "$group" "$temporary"
        chmod 0750 -- "$temporary"
        mv -T -- "$temporary" "$generation"
        temporary=''
    fi

    pointer=$(mktemp -- "$directory/.current.XXXXXX")
    printf '%s %s\n' "$pair" "$digest" > "$pointer"
    chgrp -- "$group" "$pointer"
    chmod 0640 -- "$pointer"
    mv -fT -- "$pointer" "$directory/current"
    pointer=''

    shopt -s nullglob
    for old in "$directory"/mohassan-*; do
        [[ "$old" != "$generation" && -d "$old" && ! -L "$old" ]] || continue
        [[ ${old##*/} =~ ^(mohassan-[0-9]{4}-[0-9]{2}-[0-9]{2})-[0-9a-f]{64}$ ]] || continue
        rm -f -- "$old/${BASH_REMATCH[1]}.dump" "$old/${BASH_REMATCH[1]}.json"
        rmdir -- "$old"
    done
)

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    [[ $# -eq 2 && $EUID -eq 0 ]] || exit 1
    publish_backup "$1" "$2" /var/lib/mohassan-backup-pull/newest mohassan-backup-pull
fi
