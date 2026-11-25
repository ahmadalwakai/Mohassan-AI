[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]*\z')]
    [string]$SshAlias,

    [Parameter(Mandatory)]
    [string]$Destination
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-BackupFile([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -ne $item -and ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint))) {
        throw 'Expected an ordinary backup file.'
    }
    return $item
}

function Set-PrivateAcl([IO.FileSystemInfo]$Item) {
    # Windows ACL protection and inheritance flags (Microsoft Learn, retrieved 2026-11-25).
    # https://learn.microsoft.com/dotnet/api/system.security.accesscontrol.objectsecurity.setaccessruleprotection
    # https://learn.microsoft.com/dotnet/api/system.security.accesscontrol.filesystemaccessrule
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($Item.PSIsContainer) {
        $acl = [Security.AccessControl.DirectorySecurity]::new()
        $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
        $acl = [Security.AccessControl.FileSecurity]::new()
        $inheritance = [Security.AccessControl.InheritanceFlags]::None
    }
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $sid, 'FullControl', $inheritance, 'None', 'Allow'
    ))
    Set-Acl -LiteralPath $Item.FullName -AclObject $acl
}

function Invoke-BackupSsh([string]$Alias, [string]$Request, [IO.Stream]$OutputStream) {
    $ssh = Get-Command ssh.exe -CommandType Application | Select-Object -First 1
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $ssh.Source
    # Alias and request tokens are validated before entering this function. Passed
    # as SSH arguments, with no local shell. BaseStream preserves dump bytes on PS 5.1.
    $start.Arguments = "-T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=3 $Alias $Request"
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [Diagnostics.Process]::Start($start)
    try {
        $discarded = $process.StandardError.ReadToEndAsync()
        $process.StandardOutput.BaseStream.CopyTo($OutputStream)
        $process.WaitForExit()
        $null = $discarded.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'SSH request failed.' }
    } finally {
        if (-not $process.HasExited) { $process.Kill() }
        $process.Dispose()
    }
}

function Receive-BackupFile([string]$Alias, [string]$Request, [string]$Path) {
    $stream = [IO.File]::Open($Path, 'CreateNew', 'Write', 'None')
    try {
        Invoke-BackupSsh $Alias $Request $stream
    } finally {
        $stream.Dispose()
    }
}

function Read-BackupManifest([string]$Manifest, [string]$Digest) {
    $document = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($document.sha256 -cne $Digest -or ($document.sizeBytes -isnot [long] -and $document.sizeBytes -isnot [int]) -or $document.sizeBytes -lt 1) {
        throw 'Backup manifest does not match the published backup.'
    }
    return $document
}

function Confirm-BackupDump([IO.FileInfo]$Dump, $Manifest) {
    if ($Dump.Length -ne $Manifest.sizeBytes -or (Get-FileHash -LiteralPath $Dump.FullName -Algorithm SHA256).Hash -ine $Manifest.sha256) {
        throw 'Backup size or SHA-256 does not match the manifest.'
    }
}

function Write-PullLog([string]$Path, [string]$Message) {
    $item = Get-BackupFile $Path
    if ($null -ne $item) { Set-PrivateAcl $item }
    $timestamp = [DateTime]::UtcNow.ToString('o')
    [IO.File]::WriteAllText($Path, "$timestamp $Message" + [Environment]::NewLine)
}

function Invoke-BackupPull([string]$Alias, [string]$Folder) {
    $folderPath = [IO.Path]::GetFullPath($Folder)
    if ($folderPath -eq [IO.Path]::GetPathRoot($folderPath)) { throw 'Use a dedicated backup folder.' }
    $directory = [IO.Directory]::CreateDirectory($folderPath)
    if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The backup folder must not be a reparse point.' }
    Set-PrivateAcl (Get-Item -LiteralPath $folderPath -Force)

    $lockPath = Join-Path $folderPath '.pull.lock'
    $logPath = Join-Path $folderPath 'last-run.log'
    $lockFile = Get-BackupFile $lockPath
    if ($null -ne $lockFile) { Set-PrivateAcl $lockFile }
    $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
    $temporary = @()
    $stage = 'discovering the newest backup'
    try {
        $listing = [IO.MemoryStream]::new()
        try {
            Invoke-BackupSsh $Alias 'list' $listing
            $listed = [Text.Encoding]::ASCII.GetString($listing.ToArray())
        } finally {
            $listing.Dispose()
        }
        if ($listed -cnotmatch '\A(mohassan-[0-9]{4}-[0-9]{2}-[0-9]{2}) ([0-9a-f]{64})\r?\n\z') {
            throw 'Invalid backup listing.'
        }
        $pair = $Matches[1]
        $digest = $Matches[2]
        $dumpPath = Join-Path $folderPath "$pair.dump"
        $manifestPath = Join-Path $folderPath "$pair.json"
        $receiptPath = Join-Path $folderPath 'off-server-copy.json'

        $stage = 'checking files already on disk'
        $dump = Get-BackupFile $dumpPath
        $manifest = Get-BackupFile $manifestPath
        if ($null -ne $manifest) { Set-PrivateAcl $manifest }
        if ($null -ne $dump) { Set-PrivateAcl $dump }
        $receipt = Get-BackupFile $receiptPath
        if ($null -ne $receipt) { Set-PrivateAcl $receipt }
        $downloaded = $null -eq $manifest -or $null -eq $dump
        $workId = [Guid]::NewGuid().ToString('N')

        if ($null -eq $manifest) {
            $stage = 'downloading the manifest'
            $stagedManifest = Join-Path $folderPath ".pull-$workId.json"
            $temporary += $stagedManifest
            Receive-BackupFile $Alias "manifest $pair $digest" $stagedManifest
        } else {
            $stagedManifest = $manifest.FullName
        }
        $stage = 'validating the manifest'
        $document = Read-BackupManifest $stagedManifest $digest

        if ($null -eq $dump) {
            $stage = 'downloading the dump'
            $stagedDump = Join-Path $folderPath ".pull-$workId.dump"
            $temporary += $stagedDump
            Receive-BackupFile $Alias "dump $pair $digest" $stagedDump
        } else {
            $stagedDump = $dump.FullName
        }
        $stage = 'verifying the dump size and SHA-256'
        Confirm-BackupDump (Get-BackupFile $stagedDump) $document

        $stage = 'publishing the verified backup on disk'
        if ($null -eq $dump) { [IO.File]::Move($stagedDump, $dumpPath) }
        if ($null -eq $manifest) { [IO.File]::Move($stagedManifest, $manifestPath) }
        if ($downloaded) {
            $stagedReceipt = Join-Path $folderPath ".pull-$workId.receipt"
            $temporary += $stagedReceipt
            $receiptJson = @{ downloadedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
            [IO.File]::WriteAllText($stagedReceipt, $receiptJson + [Environment]::NewLine)
            if ($null -eq $receipt) {
                [IO.File]::Move($stagedReceipt, $receiptPath)
            } else {
                [IO.File]::Replace($stagedReceipt, $receiptPath, [NullString]::Value)
            }
        }

        $stage = 'rotating local backup pairs'
        $kept = 0
        $files = Get-ChildItem -LiteralPath $folderPath -File -Force
        foreach ($file in $files) {
            if ($file.Name -cmatch '\A\.pull-[0-9a-f]{32}\.(dump|json|receipt)\z') {
                $abandoned = Get-BackupFile $file.FullName
                if ($null -ne $abandoned) { [IO.File]::Delete($abandoned.FullName) }
            }
            if ($file.Name -cmatch '\Amohassan-[0-9]{4}-[0-9]{2}-[0-9]{2}\.(dump|json)\z' -and $file.BaseName -clt $pair) {
                $otherExtension = if ($file.Extension -ceq '.dump') { '.json' } else { '.dump' }
                if ($null -eq (Get-BackupFile (Join-Path $folderPath "$($file.BaseName)$otherExtension"))) {
                    $orphan = Get-BackupFile $file.FullName
                    if ($null -ne $orphan) { [IO.File]::Delete($orphan.FullName) }
                }
            }
        }
        $manifests = $files | Where-Object {
            $_.Name -cmatch '\Amohassan-[0-9]{4}-[0-9]{2}-[0-9]{2}\.json\z'
        } | Sort-Object Name -Descending
        foreach ($old in $manifests) {
            $oldManifest = Get-BackupFile $old.FullName
            $oldDump = Get-BackupFile (Join-Path $folderPath "$($old.BaseName).dump")
            if ($null -eq $oldManifest -or $null -eq $oldDump) { continue }
            $kept += 1
            if ($kept -gt 14) {
                [IO.File]::Delete($oldManifest.FullName)
                [IO.File]::Delete($oldDump.FullName)
            } elseif ($old.Name -cne "$pair.json") {
                Set-PrivateAcl $oldManifest
                Set-PrivateAcl $oldDump
            }
        }
        if ($downloaded) { Write-PullLog $logPath 'Downloaded and verified the newest backup.' }
        else { Write-PullLog $logPath 'Newest backup already present and verified.' }
    } catch {
        Write-PullLog $logPath "Backup pull failed while $stage."
        throw
    } finally {
        try {
            foreach ($file in $temporary) { [IO.File]::Delete($file) }
        } finally {
            $lock.Dispose()
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        Invoke-BackupPull $SshAlias $Destination
    } catch {
        [Console]::Error.WriteLine('Backup pull failed. See last-run.log in the destination folder if available.')
        exit 1
    }
}
