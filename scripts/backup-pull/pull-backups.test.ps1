$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ("mohassan-pull-test-" + [Guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($root)

function Assert-BackupTest([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

try {
    . (Join-Path $PSScriptRoot 'pull-backups.ps1') -SshAlias 'test-alias' -Destination $root
    $isWindowsEnvironment = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
    if (-not $isWindowsEnvironment) {
        function Set-PrivateAcl([IO.FileSystemInfo]$Item) { }
    }

    $fixturePath = Join-Path $root 'fixture.bin'
    $script:payload = [byte[]](85, 0, 255, 13, 10, 128, 250)
    [IO.File]::WriteAllBytes($fixturePath, $script:payload)
    if (-not $isWindowsEnvironment) {
        $mockSsh = Join-Path $root 'ssh.exe'
        $oldPath = $env:PATH
        $env:PATH = "$root$([IO.Path]::PathSeparator)$oldPath"
        $env:MOHASSAN_BACKUP_TEST_FIXTURE = $fixturePath
        $nativeStream = [IO.MemoryStream]::new()
        try {
            [IO.File]::WriteAllText($mockSsh, "#!/bin/sh`nexec cat -- `"`$MOHASSAN_BACKUP_TEST_FIXTURE`"`n")
            chmod 700 -- $mockSsh
            Invoke-BackupSsh 'test-alias' 'list' $nativeStream
            Assert-BackupTest ([Convert]::ToBase64String($nativeStream.ToArray()) -ceq [Convert]::ToBase64String($script:payload)) 'Native SSH byte stream was altered.'
        } finally {
            $nativeStream.Dispose()
            $env:PATH = $oldPath
            Remove-Item Env:MOHASSAN_BACKUP_TEST_FIXTURE
        }
    }
    $script:digest = (Get-FileHash -LiteralPath $fixturePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $script:expectedManifest = @{ sha256 = $script:digest; sizeBytes = $script:payload.Length } | ConvertTo-Json -Compress
    $script:manifestResponse = $script:expectedManifest
    $script:transfers = [Collections.Generic.List[string]]::new()
    $script:newest = 'mohassan-2026-11-25'
    function Invoke-BackupSsh([string]$Alias, [string]$Request, [IO.Stream]$OutputStream) {
        Assert-BackupTest ($Alias -ceq 'test-alias') 'SSH alias changed.'
        $script:transfers.Add($Request)
        $identifier = "$script:newest $script:digest"
        $bytes = switch -CaseSensitive ($Request) {
            'list' { [Text.Encoding]::ASCII.GetBytes("$identifier`n") }
            "manifest $identifier" { [Text.Encoding]::UTF8.GetBytes($script:manifestResponse) }
            "dump $identifier" { $script:payload }
            default { throw 'Unexpected SSH command.' }
        }
        $OutputStream.Write($bytes, 0, $bytes.Length)
    }

    $destination = Join-Path $root 'copies'
    $null = [IO.Directory]::CreateDirectory($destination)
    foreach ($day in (1..14)) {
        $old = Join-Path $destination "mohassan-2026-11-$($day.ToString('00'))"
        [IO.File]::WriteAllBytes("$old.dump", $script:payload)
        [IO.File]::WriteAllText("$old.json", $script:manifestResponse)
    }
    $orphan = Join-Path $destination 'mohassan-2026-11-20.dump'
    $abandoned = Join-Path $destination ".pull-$([Guid]::NewGuid().ToString('N')).dump"
    $unmanaged = Join-Path $destination 'notes.txt'
    [IO.File]::WriteAllBytes($orphan, $script:payload)
    [IO.File]::WriteAllBytes($abandoned, $script:payload)
    [IO.File]::WriteAllText($unmanaged, 'unrelated')

    Invoke-BackupPull 'test-alias' $destination
    $files = Get-ChildItem -LiteralPath $destination -Filter 'mohassan-*.dump'
    Assert-BackupTest ($files.Count -eq 14) 'Expected 14 retained dumps.'
    Assert-BackupTest ($null -eq (Get-BackupFile (Join-Path $destination 'mohassan-2026-11-01.json'))) 'Oldest pair was not removed.'
    Assert-BackupTest ($null -eq (Get-BackupFile $orphan) -and $null -eq (Get-BackupFile $abandoned)) 'Interrupted files were retained.'
    Assert-BackupTest ($null -ne (Get-BackupFile $unmanaged)) 'Unrelated file was removed.'
    Assert-BackupTest ($script:transfers.Count -eq 3) 'Expected discovery and two downloads.'
    $receipt = Join-Path $destination 'off-server-copy.json'
    $previousReceipt = [IO.File]::ReadAllText($receipt)
    $document = ConvertFrom-Json $previousReceipt
    Assert-BackupTest ($null -ne $document.downloadedAt) 'Receipt does not contain the verified download time.'

    if ($isWindowsEnvironment) {
        $acl = Get-Acl -LiteralPath $destination
        $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
        Assert-BackupTest ($acl.AreAccessRulesProtected -and $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -ceq $ownerSid) 'Folder ACL grants access outside the current user.'
    }

    Invoke-BackupPull 'test-alias' $destination
    Assert-BackupTest ($script:transfers.Count -eq 4) 'Existing pair should require discovery only.'
    Assert-BackupTest ([IO.File]::ReadAllText($receipt) -ceq $previousReceipt) 'Download time changed when nothing was downloaded.'

    $script:newest = 'mohassan-2026-11-26'
    $lastDump = Join-Path $destination "$script:newest.dump"
    $lastManifest = Join-Path $destination "$script:newest.json"
    $script:manifestResponse = @{ sha256 = $script:digest; sizeBytes = $script:payload.Length + 1 } | ConvertTo-Json -Compress
    $rejected = $false
    try { Invoke-BackupPull 'test-alias' $destination } catch { $rejected = $true }
    Assert-BackupTest $rejected 'Wrong-size dump was accepted.'
    Assert-BackupTest ($null -eq (Get-BackupFile $lastDump) -and $null -eq (Get-BackupFile $lastManifest)) 'Mismatch published files.'
    Assert-BackupTest ([IO.File]::ReadAllText($receipt) -ceq $previousReceipt) 'Mismatch updated the receipt.'

    $script:manifestResponse = $script:expectedManifest
    $script:payload[1] = 99
    $rejected = $false
    try { Invoke-BackupPull 'test-alias' $destination } catch { $rejected = $true }
    Assert-BackupTest $rejected 'Same-size wrong SHA-256 was accepted.'
    Assert-BackupTest ($null -eq (Get-BackupFile $lastDump) -and $null -eq (Get-BackupFile $lastManifest)) 'Wrong content was published.'

    [IO.File]::WriteAllText($lastManifest, $script:expectedManifest)
    $script:payload[1] = 0
    $script:transfers.Clear()
    Invoke-BackupPull 'test-alias' $destination
    Assert-BackupTest ($script:transfers.Count -eq 2 -and $script:transfers[1] -clike 'dump *') 'Existing manifest was re-downloaded.'
    Assert-BackupTest ([IO.File]::ReadAllText($receipt) -cne $previousReceipt) 'Recovered pair did not update the receipt.'

    'Backup pull tests passed.'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force
}
