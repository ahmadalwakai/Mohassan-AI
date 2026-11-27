#!/usr/bin/env bash

ensure_chromium_system_dependencies() {
    local node=$1 playwright=$2
    # Playwright simulates apt and exits nonzero if any packages are missing.
    # https://github.com/microsoft/playwright/blob/v1.64.1/packages/playwright-core/src/server/registry/dependencies.ts#L92-L148
    # Retrieved 2026-11-27.
    if LC_ALL=C "$node" "$playwright" install-deps --dry-run chromium; then
        return 0
    fi
    "$node" "$playwright" install-deps chromium
}

prepare_main() (
    set -euo pipefail
    umask 027

    fail() { printf '%s\n' "$1" >&2; exit 1; }

    # Validate the host before any account, package, permission or configuration change.
    [[ "$(uname -s)" == Linux ]] || fail 'This preparation script requires Ubuntu Linux.'
    [[ "$(uname -m)" == aarch64 ]] || fail 'This template requires ARM64 (aarch64).'
    [[ "$EUID" -eq 0 ]] || fail 'Run this preparation script with sudo on the target VM.'
    [[ -r /etc/os-release ]] || fail 'Cannot identify the operating system.'
    # shellcheck source=/dev/null
    . /etc/os-release
    [[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || fail 'Use the tested target Ubuntu 24.04 ARM64.'

    app=/opt/mohassan/app
    state=/var/lib/mohassan
    node=/usr/local/bin/node
    npm=/usr/local/bin/npm
    cloud="$app/scripts/cloud-linux"
    pull_user=mohassan-backup-pull
    pull_home=/var/lib/mohassan-backup-pull
    backup_dir=/var/backups/mohassan/daily
    backup_status=/var/lib/mohassan-backup-status
    [[ -x "$node" && -x "$npm" ]] || fail 'Install an official Node 24 ARM64 distribution in /usr/local first.'
    [[ "$($node -p 'process.versions.node.split(".")[0] + ":" + process.arch')" == 24:arm64 ]] || fail 'Node 24 ARM64 is required.'
    for command in git runuser useradd install chown systemd-analyze systemctl /usr/sbin/sshd; do
        command -v "$command" >/dev/null || fail "Missing prerequisite command: $command"
    done
    if systemctl is-active --quiet mohassan.service; then
        fail 'Stop mohassan.service before replacing its dependencies or preparing a release.'
    fi
    [[ "$(readlink -f -- "$(dirname -- "${BASH_SOURCE[0]}")/../..")" == "$app" ]] || fail 'Place the source snapshot at /opt/mohassan/app before preparation.'
    for directory in /opt/mohassan "$app" /etc/mohassan "$state" /var/backups /var/backups/mohassan "$backup_dir" \
        "$backup_status" "$pull_home" "$pull_home/.ssh" "$pull_home/newest" /etc/ssh/sshd_config.d \
        /etc/systemd/system/mohassan.service.d /etc/systemd/journald@mohassan.conf.d; do
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

    if getent passwd "$pull_user" >/dev/null; then
        [[ "$(getent passwd "$pull_user" | cut -d: -f6,7)" == "$pull_home:/bin/sh" &&
           "$(id -u "$pull_user")" != 0 && "$(id -g "$pull_user")" != 0 &&
           "$(id -Gn "$pull_user")" == "$pull_user" ]] || fail 'The existing backup pull account is not dedicated to this job.'
    else
        useradd --system --user-group --home-dir "$pull_home" --no-create-home --shell /bin/sh "$pull_user"
    fi

    install -d -o root -g root -m 0700 /etc/mohassan
    install -d -o root -g mohassan -m 0750 /opt/mohassan
    install -d -o mohassan -g mohassan -m 0700 "$state"
    for directory in browser-profile studio-ai coding ms-playwright judge; do
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
    ensure_chromium_system_dependencies "$node" "$playwright"
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
    [[ ! -L "$unit" ]] || fail 'The API service unit must not be a symlink.'
    if [[ -e "$unit" ]]; then
        cmp -s "$unit" "$app/scripts/cloud-linux/mohassan.service" || fail 'An existing service unit differs; review it before replacing it.'
    else
        install -o root -g root -m 0644 "$cloud/mohassan.service" "$unit"
    fi

    install -d -o root -g root -m 0700 /var/backups/mohassan "$backup_dir"
    install -d -o root -g mohassan -m 0750 "$backup_status"
    install -d -o root -g "$pull_user" -m 0750 "$pull_home" "$pull_home/newest"
    install -d -o root -g root -m 0755 "$pull_home/.ssh" /etc/ssh/sshd_config.d \
        /etc/systemd/system/mohassan.service.d /etc/systemd/journald@mohassan.conf.d

    # Apply the repository-owned operations files without touching keys, timers' enablement or service state.
    install_managed() {
        local source=$1 destination=$2 mode=$3
        [[ ! -L "$destination" && ( ! -e "$destination" || -f "$destination" ) ]] ||
            fail "Managed destination must be a regular file: $destination"
        install -C -o root -g root -m "$mode" "$cloud/$source" "$destination"
    }
    install_managed backup-metadata.mjs /usr/local/sbin/backup-metadata.mjs 0644
    install_managed backup-publish.sh /usr/local/sbin/mohassan-backup-publish 0755
    install_managed backup-ssh-command.sh /usr/local/sbin/mohassan-backup-ssh-command 0755
    install_managed backup.sh /usr/local/sbin/mohassan-db-backup 0755
    install_managed restore-drill.sh /usr/local/sbin/mohassan-db-restore-drill 0755
    backup_units=(mohassan-backup.service mohassan-backup.timer mohassan-restore-drill.service mohassan-restore-drill.timer)
    for backup_unit in "${backup_units[@]}"; do
        install_managed "$backup_unit" "/etc/systemd/system/$backup_unit" 0644
    done
    install_managed mohassan.service.d/30-journal-namespace.conf /etc/systemd/system/mohassan.service.d/30-journal-namespace.conf 0644
    install_managed journald@mohassan.conf.d/30-size-cap.conf /etc/systemd/journald@mohassan.conf.d/30-size-cap.conf 0644

    # Validate the SSH restrictions before the owner reloads ssh.service.
    ssh_drop_in=/etc/ssh/sshd_config.d/00-mohassan-backup-pull.conf
    install_managed mohassan-backup-pull.sshd.conf "$ssh_drop_in" 0644
    /usr/sbin/sshd -t
    ssh_settings=$(/usr/sbin/sshd -T -C "user=$pull_user,host=localhost,addr=127.0.0.1")
    grep -Fx 'forcecommand /usr/local/sbin/mohassan-backup-ssh-command' <<< "$ssh_settings" >/dev/null ||
        fail 'The installed backup pull SSH restrictions are not effective.'
    grep -Fx "authorizedkeysfile $pull_home/.ssh/authorized_keys" <<< "$ssh_settings" >/dev/null ||
        fail 'The installed backup pull SSH key path is not effective.'

    systemd-analyze verify "$unit" "${backup_units[@]/#//etc/systemd/system/}"
    systemctl daemon-reload
    printf '%s\n' 'Prepared source, Chromium, state directories and operations configuration. No service was started.'
    printf '%s\n' 'Configure existing secrets, validate Caddy/DNS, then follow the staging and cutover steps in scripts/cloud-linux/README.md.'
)

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    prepare_main "$@"
fi
