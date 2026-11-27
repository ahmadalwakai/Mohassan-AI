#!/usr/bin/env bash

model_worker_fail() { printf '%s\n' "$1" >&2; exit 1; }

model_worker_require_stopped() {
    local service_state
    service_state=$(systemctl show --property=ActiveState --value mohassan.service) ||
        model_worker_fail 'Could not determine mohassan.service state.'
    [[ "$service_state" == inactive || "$service_state" == failed ]] ||
        model_worker_fail 'Stop mohassan.service before activating its model worker environment.'
}

model_worker_check_slot() {
    local slot=$1 venv=$2 target
    if [[ -L "$slot" ]]; then
        target=$(readlink -- "$slot")
        [[ -O "$slot" && "$target" == "$venv".generation.* && "${target#"$venv".generation.}" != */* &&
            ! -L "$target" && -d "$target" ]] ||
            model_worker_fail "Unexpected model worker environment link: $slot"
    fi
    if [[ -e "$slot" ]]; then
        [[ -d "$slot" && -O "$slot" ]] || model_worker_fail "Expected an owned environment directory: $slot"
    fi
}

model_worker_pip_check() {
    "$1" -I -B -m pip --isolated --disable-pip-version-check check
}

model_worker_probe() {
    # Mirror worker.py's isolated entry point. model_worker adds the two sibling packages.
    runuser -u mohassan -- env -i HOME=/var/lib/mohassan PATH=/usr/bin:/bin \
        "$1" -I -B - "$2/packages/execution-integration" <<'PY'
import sys

sys.path.insert(0, sys.argv[1])
from model_worker.engine import load_engine, torch
from execution_model.model import ExecutionModel
from execution_pipeline.chat import conversation_prompt

assert sys.version_info[:2] == (3, 12)
assert torch.__version__ == "2.10.0+cpu" and torch.version.cuda is None
PY
}

model_worker_matches() {
    local slot=$1 release=$2 stamp=$3 python="$1/bin/python"
    [[ -x "$python" && -f "$slot/.requirements-stamp" && "$(< "$slot/.requirements-stamp")" == "$stamp" ]] &&
        model_worker_pip_check "$python" &&
        model_worker_probe "$python" "$release"
}

model_worker_discard_staged() {
    local staged=$1 venv=$2 target
    if [[ -L "$staged" ]]; then
        target=$(readlink -- "$staged") || return
        if [[ "$staged" -ef "$venv" ]]; then
            model_worker_fail 'The staged model worker environment points to the active environment.'
        fi
        rm -- "$staged" || return
        rm -rf -- "$target"
    elif [[ -d "$staged" ]]; then
        rm -rf -- "$staged"
    fi
}

model_worker_build() (
    local system_python=$1 venv=$2 staged=$3 release=$4 requirements=$5 requirements_hash=$6 stamp=$7
    local generation python
    # Keep the build at its permanent path so generated console scripts keep valid shebangs.
    generation=$(mktemp -d -- "$venv.generation.XXXXXXXX") || exit 1
    trap 'if [[ "$(readlink -- "$staged")" != "$generation" ]]; then rm -rf -- "$generation"; fi' EXIT
    "$system_python" -I -m venv "$generation" || exit 1
    python="$generation/bin/python"
    PIP_CONFIG_FILE=/dev/null "$python" -I -m pip --isolated --disable-pip-version-check install \
        --index-url https://pypi.org/simple --only-binary=:all: --require-hashes \
        --no-cache-dir --requirement "$requirements" || exit 1
    [[ "$(sha256sum < "$requirements")" == "$requirements_hash" ]] ||
        model_worker_fail 'The model worker requirements changed during staging.'
    model_worker_pip_check "$python" || exit 1
    chmod 0755 "$generation" || exit 1
    model_worker_probe "$python" "$release" || exit 1
    printf '%s\n' "$stamp" > "$generation/.requirements-stamp" || exit 1
    ln -s -- "$generation" "$staged"
)

model_worker_swap() {
    # Linux v6.8 UAPI constants, retrieved 2026-11-27.
    # https://github.com/torvalds/linux/blob/v6.8/include/uapi/linux/fs.h
    # https://github.com/torvalds/linux/blob/v6.8/include/uapi/linux/fcntl.h
    "$1" -I - "$2" "$3" <<'PY'
import ctypes
import os
import sys

active, staged = sys.argv[1:]
if not os.path.lexists(active):
    os.replace(staged, active)
else:
    # The first exchange can replace a legacy directory with a symlink in one operation.
    renameat2 = ctypes.CDLL(None, use_errno=True).renameat2
    renameat2.argtypes = (
        ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint,
    )
    at_fdcwd = -100
    rename_exchange = 1 << 1
    if renameat2(at_fdcwd, os.fsencode(staged), at_fdcwd, os.fsencode(active), rename_exchange):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), active)
PY
}

setup_model_worker() (
    local mode=$1 release=$2 venv=$3 system_python=$4
    local requirements="$release/scripts/cloud-linux/model-worker-requirements-aarch64.txt"
    local staged="$venv.staged" parent="${venv%/*}" lock_fd requirements_hash python_version stamp
    [[ -r "$requirements" ]] || model_worker_fail 'The reviewed release is missing its model worker requirements.'
    [[ ! -L "$parent" && -d "$parent" && -O "$parent" && ! -L "$release" && ! -L "$venv.lock" ]] ||
        model_worker_fail 'Use a regular release directory and an owned model worker deployment directory.'
    exec {lock_fd}>>"$venv.lock" && flock -x "$lock_fd" ||
        model_worker_fail 'Could not lock the model worker environment.'
    model_worker_check_slot "$venv" "$venv"
    model_worker_check_slot "$staged" "$venv"

    if [[ "$mode" != --stage ]]; then
        model_worker_require_stopped
    fi
    requirements_hash=$(sha256sum < "$requirements") || exit 1
    python_version=$("$system_python" --version) || exit 1
    stamp=$(printf '%s\n' "$requirements_hash" "$python_version" | sha256sum) || exit 1
    stamp=${stamp%% *}
    if model_worker_matches "$venv" "$release" "$stamp"; then
        printf '%s\n' 'Active model worker dependencies and imports verified. Skipped pip install.'
        return
    fi

    if ! model_worker_matches "$staged" "$release" "$stamp"; then
        [[ "$mode" != --activate ]] ||
            model_worker_fail 'No verified model worker environment for this release. Run --stage first.'
        model_worker_discard_staged "$staged" "$venv" || exit 1
        model_worker_build "$system_python" "$venv" "$staged" "$release" \
            "$requirements" "$requirements_hash" "$stamp" || exit 1
    fi

    if [[ "$mode" == --stage ]]; then
        printf '%s\n' 'Model worker environment verified and staged for activation.'
    else
        model_worker_require_stopped
        model_worker_swap "$system_python" "$venv" "$staged" || exit 1
        printf '%s\n' 'Activated the verified model worker environment.'
    fi
)

model_worker_main() {
    set -euo pipefail
    umask 022

    local mode=--setup release=/opt/mohassan/app python=/usr/bin/python3.12
    case "${1:-}" in
        '') [[ $# -eq 0 ]] || model_worker_fail 'Usage: setup-model-worker.sh [--stage /path/to/release | --activate]' ;;
        --stage)
            [[ $# -eq 2 && "$2" == /* ]] || model_worker_fail 'Usage: setup-model-worker.sh --stage /path/to/release'
            mode=$1
            release=$2
            ;;
        --activate)
            [[ $# -eq 1 ]] || model_worker_fail 'Usage: setup-model-worker.sh --activate'
            mode=$1
            ;;
        *) model_worker_fail 'Usage: setup-model-worker.sh [--stage /path/to/release | --activate]' ;;
    esac

    [[ "$EUID" -eq 0 ]] || model_worker_fail 'Run this setup with sudo on the target VM.'
    [[ "$(uname -s):$(uname -m)" == Linux:aarch64 ]] || model_worker_fail 'The locked model worker wheels require Linux aarch64.'
    [[ -x "$python" ]] || model_worker_fail 'Install Ubuntu Python 3.12 and python3.12-venv first.'
    id -u mohassan >/dev/null || model_worker_fail 'Complete the standard release preparation first.'
    setup_model_worker "$mode" "$release" /opt/mohassan/venv-execution "$python"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    model_worker_main "$@"
fi
