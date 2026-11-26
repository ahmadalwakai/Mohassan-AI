#!/usr/bin/env bash
set -euo pipefail
umask 022

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ "$EUID" -eq 0 ]] || fail 'Run this setup with sudo on the target VM.'
[[ "$(uname -s):$(uname -m)" == Linux:aarch64 ]] || fail 'The locked model worker wheels require Linux aarch64.'
[[ -x /usr/bin/python3.12 ]] || fail 'Install Ubuntu Python 3.12 and python3.12-venv first.'
id -u mohassan >/dev/null || fail 'Complete the standard release preparation first.'
if systemctl is-active --quiet mohassan.service; then
    fail 'Stop mohassan.service before preparing its model worker environment.'
fi

app=/opt/mohassan/app
venv=/opt/mohassan/venv-execution
requirements="$app/scripts/cloud-linux/model-worker-requirements-aarch64.txt"
[[ -r "$requirements" ]] || fail 'Install the reviewed release at /opt/mohassan/app first.'
[[ ! -L /opt/mohassan && ! -L "$app" && ! -L "$venv" ]] || fail 'Deployment directories must not be symlinks.'
[[ ! -e "$venv" || -O "$venv" ]] || fail 'The model worker environment must be owned by root.'

/usr/bin/python3.12 -I -m venv "$venv"
python="$venv/bin/python"
PIP_CONFIG_FILE=/dev/null "$python" -I -m pip --isolated --disable-pip-version-check install \
    --index-url https://pypi.org/simple --only-binary=:all: --require-hashes --force-reinstall \
    --no-cache-dir --requirement "$requirements"
"$python" -I -m pip --isolated --disable-pip-version-check check

# Mirror worker.py's isolated entry point. model_worker adds the two sibling packages.
runuser -u mohassan -- env -i HOME=/var/lib/mohassan PATH=/usr/bin:/bin "$python" -I -B - <<'PY'
import sys

sys.path.insert(0, "/opt/mohassan/app/packages/execution-integration")
from model_worker.engine import load_engine, torch
from execution_model.model import ExecutionModel
from execution_pipeline.chat import conversation_prompt

assert sys.version_info[:2] == (3, 12)
assert torch.__version__ == "2.10.0+cpu" and torch.version.cuda is None
PY
printf '%s\n' 'Model worker imports passed under the service account.'
