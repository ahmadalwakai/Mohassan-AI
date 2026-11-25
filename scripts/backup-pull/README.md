# Pull backups to Windows

Use a dedicated SSH key and a dedicated local NTFS backup folder under your Windows profile. The folder will be owned by your Windows account and its ACL will grant access only to that account. Keep the folder on a disk with enough room for 14 verified backup pairs and one incoming pair. Keep the SSH key and database backups private.

## Configure the VM and SSH alias

1. After the release has been prepared on the VM, verify that `sshd -t` passes and that this command reports `forcecommand /usr/local/sbin/mohassan-backup-ssh-command` and `authorizedkeysfile /var/lib/mohassan-backup-pull/.ssh/authorized_keys`.

   ```sh
   sudo sshd -T -C user=mohassan-backup-pull,host=localhost,addr=127.0.0.1
   ```

2. In the owner's Windows session, create a dedicated key using `ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\mohassan-backup"`. If you protect the key with a passphrase, load it in the Windows SSH agent before your scheduled run. Keep the private key on the PC. In your existing administrative SSH session, edit `/var/lib/mohassan-backup-pull/.ssh/authorized_keys` on the VM as root. Use your new **public** key on this one line and set the file to `root:root` and mode `0644`. Check the host has `openssh-server` and use `sudo systemctl reload ssh` after `sshd -t` while keeping the administrative session open.

   ```text
   restrict,command="/usr/local/sbin/mohassan-backup-ssh-command" ssh-ed25519 REPLACE_WITH_PUBLIC_KEY_DATA
   ```

   OpenSSH documents `restrict`, forced commands and their interaction with `ForceCommand` in the authorized keys format. Retrieved 2026-11-25. [OpenSSH sshd(8)](https://man.openbsd.org/sshd#AUTHORIZED_KEYS_FILE_FORMAT)

3. Add an alias to your own `%USERPROFILE%\.ssh\config`. Use the VM's existing SSH port if it differs from the default. Establish trust in its host key by checking the fingerprint with the administrative session before accepting it into `known_hosts`. The pull uses strict host key checking and runs in batch mode.

   ```text
   Host mohassan-backup
       HostName REPLACE_WITH_VM_HOSTNAME
       User mohassan-backup-pull
       IdentityFile ~/.ssh/mohassan-backup
       IdentitiesOnly yes
   ```

4. After a successful VM backup, run from PowerShell under the Windows account that will own the scheduled task. Check for the verified `.dump` and `.json` pair, `off-server-copy.json` and `last-run.log`. Use the same alias and destination for each run. The pull verifies a pair already present without downloading it again. A checksum or size mismatch returns a nonzero exit code and leaves existing backup files in place for investigation.

   ```powershell
   .\scripts\backup-pull\pull-backups.ps1 -SshAlias mohassan-backup -Destination "$env:USERPROFILE\MohassanBackups"
   ```

## Schedule the pull

1. Copy `task-scheduler.xml` and edit the placeholders. Obtain your Windows SID with `[Security.Principal.WindowsIdentity]::GetCurrent().User.Value`. Enter the actual Windows SID, absolute script path, SSH alias and absolute destination. XML-escape any special characters in the values. The template starts at 05:00 UTC, after the 03:15 UTC VM schedule. Change the start date or time if needed.
2. Open Task Scheduler, select **Import Task**, choose the edited XML and review the settings. The template runs with the owner's existing Windows session and standard privileges. The PC must be running with that account signed in and network access. The task retries failed runs and runs a missed task when available. It uses Windows PowerShell with the account's existing execution policy.
3. Run the task from Task Scheduler once. Check **Last Run Result** and `last-run.log` in the backup folder. A successful manual run before import means the task should verify the existing pair and leave its download time unchanged.

## Report the off-server copy time (optional)

The receipt contains only the UTC time of a successful download and verification. The pull key cannot write to the VM. To report the receipt, transfer it via your **separate administrative SSH alias** to your administrator's VM home and install it in the status directory. Repeat when you want to refresh the time shown to the API owner. The status remains absent until the first receipt is installed.

```powershell
scp "$env:USERPROFILE\MohassanBackups\off-server-copy.json" YOUR_ADMIN_SSH_ALIAS:off-server-copy.json
```

```sh
sudo install -o root -g mohassan -m 0640 -- "$HOME/off-server-copy.json" /var/lib/mohassan-backup-status/.off-server-copy.json.new
sudo mv -fT -- /var/lib/mohassan-backup-status/.off-server-copy.json.new /var/lib/mohassan-backup-status/off-server-copy.json
rm -- "$HOME/off-server-copy.json"
```
