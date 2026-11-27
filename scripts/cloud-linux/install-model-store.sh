#!/usr/bin/env bash
set -euo pipefail
umask 077
export LC_ALL=C
export PATH=/usr/local/bin:/usr/bin:/bin

install_model_store() (
    local group=$1 node=$2 checker=$3 directory
    shift 3
    directory=$(dirname -- "${BASH_SOURCE[0]}")
    /usr/bin/python3 -I -B "$directory/install-model-store.py" --group "$group" --node "$node" --checker "$checker" "$@"
)

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    if [[ $EUID -ne 0 ]]; then
        printf '%s\n' 'Run the model store installer with sudo on the VM.' >&2
        exit 1
    fi
    case ${1-} in
        install|rollback|-h|--help) ;;
        *) printf '%s\n' 'Choose install or rollback. Run with --help for usage.' >&2; exit 2 ;;
    esac
    install_model_store mohassan /usr/local/bin/node "$(dirname -- "${BASH_SOURCE[0]}")/../models/pack-store.mjs" "$@"
fi
