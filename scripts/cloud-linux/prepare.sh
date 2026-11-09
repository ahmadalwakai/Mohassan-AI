#!/usr/bin/env bash
set -euo pipefail
umask 027

fail() { printf '%s\n' "$1" >&2; exit 1; }

# Validate the host before any account, package, permission or configuration change.
[[ "$(uname -s)" == Linux ]] || fail 'This preparation script requires Ubuntu Linux.'
[[ "$(uname -m)" == aarch64 ]] || fail 'This template requires ARM64 (aarch64).'
[[ "$EUID" -eq 0 ]] || fail 'Run this preparation script with sudo on the target VM.'
[[ -r /etc/os-release ]] || fail 'Cannot identify the operating system.'
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || fail 'Use the tested target Ubuntu 24.04 ARM64.'

app=/opt/mohassan/app
state=/var/lib/mohassan
node=/usr/local/bin/node
npm=/usr/local/bin/npm
[[ -x "$node" && -x "$npm" ]] || fail 'Install an official Node 24 ARM64 distribution in /usr/local first.'
[[ "$($node -p 'process.versions.node.split(".")[0] + ":" + process.arch')" == 24:arm64 ]] || fail 'Node 24 ARM64 is required.'
for command in git runuser useradd install chown systemd-analyze systemctl; do
    command -v "$command" >/dev/null || fail "Missing prerequisite command: $command"
done
if systemctl is-active --quiet mohassan.service; then
    fail 'Stop mohassan.service before replacing its dependencies or preparing a release.'
fi
[[ "$(readlink -f -- "$(dirname -- "${BASH_SOURCE[0]}")/../..")" == "$app" ]] || fail 'Place the source snapshot at /opt/mohassan/app before preparation.'
for directory in /opt/mohassan "$app" /etc/mohassan "$state"; do
    [[ ! -L "$directory" ]] || fail 'Deployment and state directories must not be symlinks.'
done
[[ -f "$app/package-lock.json" && -f "$app/scripts/start-server.mjs" ]] || fail 'The source snapshot is incomplete.'
[[ ! -e "$app/.env" && ! -e "$app/.data" ]] || fail 'Use a clean source snapshot; configure secrets in /etc/mohassan/server.env.'

if getent passwd mohassan >/dev/null; then
    [[ "$(getent passwd mohassan | cut -d: -f6)" == "$state" ]] || fail 'The existing mohassan account has an unexpected home directory.'
    [[ "$(id -u mohassan)" != 0 ]] || fail 'The service account must not be root.'
    [[ "$(id -gn mohassan)" == mohassan ]] || fail 'The service account must use group mohassan.'
else
    useradd --system --user-group --home-dir "$state" --shell /usr/sbin/nologin mohassan
fi

install -d -o root -g root -m 0700 /etc/mohassan
install -d -o root -g mohassan -m 0750 /opt/mohassan
install -d -o mohassan -g mohassan -m 0700 "$state"
for directory in browser-profile studio-ai coding ms-playwright; do
    [[ ! -L "$state/$directory" ]] || fail 'Persistent state directories must not be symlinks.'
    install -d -o mohassan -g mohassan -m 0700 "$state/$directory"
done

# npm lifecycle hooks run as the service account. It retains read/execute access
# after the source is sealed; umask 027 must not make root-owned dependencies unreadable.
seal_source() {
    chown -Rh root:mohassan "$app"
    chmod -R u+rwX,g+rX,g-w,o-rwx "$app"
}
chown -Rh mohassan:mohassan "$app"
trap seal_source EXIT
runuser -u mohassan -- env -i HOME="$state" USER=mohassan LOGNAME=mohassan PATH=/usr/local/bin:/usr/bin:/bin NODE_ENV=development \
    "$npm" --prefix "$app" ci --include=dev --no-audit --no-fund

playwright="$app/node_modules/playwright/cli.js"
[[ -f "$playwright" ]] || fail 'The locked Playwright package was not installed.'
# This uses the locked CLI to install Ubuntu system libraries through apt.
"$node" "$playwright" install-deps chromium
runuser -u mohassan -- env -i HOME="$state" USER=mohassan LOGNAME=mohassan PATH=/usr/local/bin:/usr/bin:/bin \
    PLAYWRIGHT_BROWSERS_PATH="$state/ms-playwright" "$node" "$playwright" install chromium
seal_source
trap - EXIT
runuser -u mohassan -- env -i HOME="$state" USER=mohassan LOGNAME=mohassan PATH=/usr/local/bin:/usr/bin:/bin \
    PLAYWRIGHT_BROWSERS_PATH="$state/ms-playwright" "$node" "$app/scripts/cloud-linux/smoke-browser.mjs"

if [[ ! -e /etc/mohassan/server.env ]]; then
    install -o root -g root -m 0600 "$app/scripts/cloud-linux/server.env.example" /etc/mohassan/server.env
else
    [[ -f /etc/mohassan/server.env && ! -L /etc/mohassan/server.env ]] || fail 'The existing environment file must be a regular file.'
    chown root:root /etc/mohassan/server.env
    chmod 0600 /etc/mohassan/server.env
    printf '%s\n' 'Preserved the existing /etc/mohassan/server.env.'
fi

unit=/etc/systemd/system/mohassan.service
if [[ -e "$unit" ]]; then
    cmp -s "$unit" "$app/scripts/cloud-linux/mohassan.service" || fail 'An existing service unit differs; review it before replacing it.'
else
    install -o root -g root -m 0644 "$app/scripts/cloud-linux/mohassan.service" "$unit"
fi
systemd-analyze verify "$unit"
systemctl daemon-reload
printf '%s\n' 'Prepared source, Chromium, state directories and the service unit. No service was started.'
printf '%s\n' 'Configure existing secrets, validate Caddy/DNS, then follow the staging and cutover steps in scripts/cloud-linux/README.md.'
