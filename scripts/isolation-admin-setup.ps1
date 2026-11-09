<#
.SYNOPSIS
  One-time administrator setup for the isolation gates of executable skills.

.DESCRIPTION
  Run this yourself from an elevated PowerShell. Nothing in the app calls it.

  -Quota creates fixed-size VHD files on the current disk, mounts them as folders, and
  registers a startup task (running as SYSTEM) that reattaches them after a reboot. No extra
  physical disk is needed: 2 slots of 128 MB use 256 MB on C:.

  -LpacWinsock grants ALL RESTRICTED APPLICATION PACKAGES read access to the Winsock catalog in
  HKLM. This diagnostic grant did not resolve Node's LPAC WSAStartup 10107 failure on the
  measured Windows build and was restored to its original DACL. It does not establish G5/G8
  or add any process capability. It is a machine-wide permission and a separate opt-in switch.

  -PlanOnly prints exact paths and changes without elevation or writes. Stop app workers before
  installation or removal. A private manifest records created resources and original DACLs.
  -Undo restores the recorded DACL only if it has not changed, and removes only recorded VHDs.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\isolation-admin-setup.ps1 -Quota
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\isolation-admin-setup.ps1 -LpacWinsock
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\isolation-admin-setup.ps1 -Quota -LpacWinsock -Undo
#>
[CmdletBinding()]
param(
  [switch]$Quota,
  [switch]$LpacWinsock,
  [switch]$Undo,
  [switch]$PlanOnly,
  [string]$QuotaRoot = 'C:\MohassanQuota',
  [string]$VhdRoot = (Join-Path $env:ProgramData 'MohassanAI\quota'),
  [ValidateRange(1, 8)][int]$Slots = 2,
  [ValidateRange(32, 256)][int]$SizeMb = 128
)
$ErrorActionPreference = 'Stop'
$taskName = 'MohassanQuotaAttach'
$winsockKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\WinSock2\Parameters'
$allRestrictedPackages = 'S-1-15-2-2'
$accessSection = [Security.AccessControl.AccessControlSections]::Access

function Assert-LocalDirectory([string]$Value) {
  if ($Value -notmatch '^[A-Za-z]:[\\/]' -or $Value -match '["\r\n]' -or $Value.Substring(2).Contains(':')) { throw 'Use an absolute local path without quotes, newlines, or alternate data streams.' }
  $full = [IO.Path]::GetFullPath($Value).TrimEnd('\')
  if ($full.Length -lt 4) { throw 'A drive root is not a valid setup directory.' }
  $cursor = $full
  while ($cursor.Length -gt 3) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Setup paths must be real directories without reparse-point ancestors: $cursor" }
    }
    $cursor = Split-Path -Path $cursor -Parent
  }
  return $full
}
function Assert-Leaf([string]$Root, [string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Path $full -Parent) -ine $Root -or $full -match '["\r\n]') { throw 'Resource escaped its recorded setup directory.' }
  return $full
}
$QuotaRoot = Assert-LocalDirectory $QuotaRoot
$VhdRoot = Assert-LocalDirectory $VhdRoot
$stateRoot = Assert-LocalDirectory (Join-Path $env:ProgramData 'MohassanAI\isolation-admin')
$statePath = Assert-Leaf $stateRoot (Join-Path $stateRoot 'state.json')
foreach ($protected in @($env:SystemRoot, $env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))) {
  if (-not $protected) { continue }
  foreach ($root in @($QuotaRoot, $VhdRoot)) {
    if ($root -ieq $protected -or $root.StartsWith($protected.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Do not place quota resources in a system or program directory.' }
  }
}
foreach ($pair in @(@($QuotaRoot, $VhdRoot), @($QuotaRoot, $stateRoot), @($VhdRoot, $stateRoot))) {
  if ($pair[0] -ieq $pair[1] -or $pair[0].StartsWith($pair[1] + '\', [StringComparison]::OrdinalIgnoreCase) -or $pair[1].StartsWith($pair[0] + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Quota, VHD and manifest directories must not overlap.' }
}
if (-not $Quota -and -not $LpacWinsock) { throw 'Choose -Quota, -LpacWinsock or both. Nothing was changed.' }
if ($PlanOnly) {
  [pscustomobject]@{ operation = $(if ($Undo) { 'undo-recorded-resources' } else { 'install' }); quota = [bool]$Quota; quotaRoot = $QuotaRoot; vhdRoot = $VhdRoot; slots = $Slots; sizeMbPerSlot = $SizeMb; startupTask = $taskName; registryReadGrant = [bool]$LpacWinsock; registryKey = $winsockKey; registryPrincipal = $allRestrictedPackages; backupManifest = $statePath; requiresStoppedWorkers = $true; changesApplied = $false } | ConvertTo-Json
  return
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this from an elevated PowerShell (Run as administrator). Nothing was changed.'
}
function Get-SetupAcl([string]$Path) {
  if ($Path -cne $winsockKey) { return Get-Acl -LiteralPath $Path }
  # Windows PowerShell 5.1's registry provider can report this existing key as missing.
  # Pin the native registry view and read only the DACL; do not enumerate catalog values.
  $registryBase = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
  $registryKey = $null
  try {
    $registryKey = $registryBase.OpenSubKey('SYSTEM\CurrentControlSet\Services\WinSock2\Parameters', [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadSubTree, [Security.AccessControl.RegistryRights]::ReadPermissions)
    if ($null -eq $registryKey) { throw 'The fixed Winsock registry key does not exist.' }
    return $registryKey.GetAccessControl($accessSection)
  } finally { if ($registryKey) { $registryKey.Dispose() }; $registryBase.Dispose() }
}
function Set-SetupAcl([string]$Path, $AclObject) {
  if ($Path -cne $winsockKey) { Set-Acl -LiteralPath $Path -AclObject $AclObject; return }
  $registryBase = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
  $registryKey = $null
  try {
    $registryKey = $registryBase.OpenSubKey('SYSTEM\CurrentControlSet\Services\WinSock2\Parameters', [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, ([Security.AccessControl.RegistryRights]::ReadPermissions -bor [Security.AccessControl.RegistryRights]::ChangePermissions))
    if ($null -eq $registryKey) { throw 'The fixed Winsock registry key does not exist.' }
    $registryKey.SetAccessControl($AclObject)
  } finally { if ($registryKey) { $registryKey.Dispose() }; $registryBase.Dispose() }
}
function Get-Dacl([string]$Path) { return (Get-SetupAcl $Path).GetSecurityDescriptorSddlForm($accessSection) }
function Protect-SetupDirectory([string]$Path) {
  New-Item -ItemType Directory -Path $Path -Force | Out-Null
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($principal in @('S-1-5-18', 'S-1-5-32-544')) {
    $sid = New-Object Security.Principal.SecurityIdentifier $principal
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}
function Assert-UnchangedDacl([string]$Path, [string]$Expected) {
  if ((Get-Dacl $Path) -cne $Expected) { throw "Permissions changed after setup; review before restoring: $Path" }
}
function Restore-Dacl([string]$Path, [string]$Original, [string]$Expected) {
  if ((Get-Dacl $Path) -ceq $Original) { return }
  Assert-UnchangedDacl $Path $Expected
  $acl = Get-SetupAcl $Path
  $acl.SetSecurityDescriptorSddlForm($Original, $accessSection)
  Set-SetupAcl $Path $acl
  if ((Get-Dacl $Path) -cne $Original) { throw "DACL restoration did not verify: $Path" }
}
if ((Test-Path -LiteralPath $statePath) -and ((Get-Item -LiteralPath $statePath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Manifest must not be a reparse point.' }
Protect-SetupDirectory $stateRoot
$state = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json } else { [pscustomobject]@{ version = 1; quota = $null; winsock = $null } }
if ($state.version -ne 1) { throw 'Unknown setup manifest version.' }
function Save-State {
  $temporaryState = Assert-Leaf $stateRoot (Join-Path $stateRoot ('state-' + [guid]::NewGuid().ToString('N') + '.tmp'))
  try {
    $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporaryState -Encoding UTF8
    Move-Item -LiteralPath $temporaryState -Destination $statePath -Force
  } finally { if (Test-Path -LiteralPath $temporaryState) { Remove-Item -LiteralPath $temporaryState -Force } }
}

function Invoke-DiskPart([string[]]$Lines) {
  $scriptPath = Assert-Leaf $stateRoot (Join-Path $stateRoot ('diskpart-' + [guid]::NewGuid().ToString('N') + '.txt'))
  try {
    Set-Content -LiteralPath $scriptPath -Value $Lines -Encoding ASCII
    $output = & "$env:SystemRoot\System32\diskpart.exe" /s $scriptPath
    if ($LASTEXITCODE -ne 0) { throw "diskpart failed:`n$($output -join "`n")" }
  } finally { Remove-Item -LiteralPath $scriptPath -Force }
}

function Assert-QuotaConfiguration {
  if ($state.quota -and ($state.quota.quotaRoot -ine $QuotaRoot -or $state.quota.vhdRoot -ine $VhdRoot -or $state.quota.slots.Count -ne $Slots -or $state.quota.sizeMb -ne $SizeMb)) { throw 'Use the roots, slot count and size recorded in the manifest; existing resources will not be reconfigured.' }
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task -and (-not $state.quota -or $task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ine "$env:SystemRoot\System32\diskpart.exe" -or $task.Actions[0].Arguments -cne "/s `"$(Join-Path $VhdRoot 'attach.txt')`"")) { throw 'An untracked or modified startup task has this name; it will not be overwritten.' }
  if ((Test-Path -LiteralPath $QuotaRoot) -and @(Get-ChildItem -LiteralPath $QuotaRoot -Filter 'slot-*.lock' -Force).Count -gt 0) { throw 'Quota locks exist. Stop workers and review locks before setup or undo; this script does not remove live locks.' }
}
function Assert-MountedSlot($Slot) {
  $image = Get-DiskImage -ImagePath $Slot.vhd -ErrorAction Stop
  if (-not $image.Attached) { throw "VHD is not attached: $($Slot.vhd)" }
  $disk = $image | Get-Disk
  if ($disk.Size -lt ($SizeMb * 1MB - 1MB) -or $disk.Size -gt ($SizeMb * 1MB + 1MB)) { throw 'Unexpected VHD capacity; no success is assumed.' }
  $mount = $Slot.mount.TrimEnd('\') + '\'
  $partitions = @($disk | Get-Partition | Where-Object { $_.AccessPaths -contains $mount })
  if ($partitions.Count -ne 1) { throw 'Expected NTFS volume is not mounted at the recorded slot.' }
  $volume = $partitions[0] | Get-Volume
  if ($volume.FileSystem -ne 'NTFS' -or $volume.Path -notmatch '^\\\\\?\\Volume\{[0-9a-fA-F-]{36}\}\\$') { throw 'Expected a canonical NTFS volume GUID path.' }
  return $volume.Path
}
function Test-PreparedVolumeDacl([string]$Actual, [string]$Prepared) {
  # Windows marks the protected DACL auto-inherited after applying it. Accept
  # only that one flag addition; every ACE and the protected flag remain exact.
  return $Actual -ceq $Prepared -or ($Prepared.StartsWith('D:P(') -and $Actual -ceq ('D:PAI' + $Prepared.Substring(3)))
}
function Protect-SlotVolume($Slot) {
  $volumePath = Assert-MountedSlot $Slot
  # A DACL on the mount-point directory applies to that directory, not the volume
  # root. Child files inherit the volume root DACL, which must grant the app user
  # full control so its medium-integrity native helper can assign a low label.
  if ($Slot.PSObject.Properties['volumePath'] -and $Slot.volumePath -cne $volumePath) { throw 'Recorded quota volume identity changed.' }
  $current = Get-Dacl $volumePath
  if (-not $Slot.PSObject.Properties['volumeInstalledDacl']) {
    $volumeAcl = New-Object Security.AccessControl.DirectorySecurity
    $volumeAcl.SetAccessRuleProtection($true, $false)
    foreach ($volumeSid in @($identity.User, (New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'), (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'))) {
      $volumeAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule $volumeSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    $Slot | Add-Member -NotePropertyName volumePath -NotePropertyValue $volumePath
    $Slot | Add-Member -NotePropertyName volumeOriginalDacl -NotePropertyValue $current
    $Slot | Add-Member -NotePropertyName volumeInstalledDacl -NotePropertyValue $volumeAcl.GetSecurityDescriptorSddlForm($accessSection)
    Save-State
  }
  if (-not (Test-PreparedVolumeDacl $current $Slot.volumeInstalledDacl) -and $current -cne $Slot.volumeOriginalDacl) { throw 'Quota volume permissions changed outside this setup; refusing to overwrite them.' }
  if (-not (Test-PreparedVolumeDacl $current $Slot.volumeInstalledDacl)) {
    $volumeAcl = Get-Acl -LiteralPath $volumePath
    $volumeAcl.SetSecurityDescriptorSddlForm($Slot.volumeInstalledDacl, $accessSection)
    Set-Acl -LiteralPath $volumePath -AclObject $volumeAcl
  }
  $installed = Get-Dacl $volumePath
  if (-not (Test-PreparedVolumeDacl $installed $Slot.volumeInstalledDacl)) { throw 'Quota volume DACL did not match the prepared permissions.' }
  $Slot.volumeInstalledDacl = $installed
  Save-State
}
function Install-Quota {
  Assert-QuotaConfiguration
  $user = $identity.User
  if (-not $state.quota) {
    foreach ($root in @($VhdRoot, $QuotaRoot)) { if ((Test-Path -LiteralPath $root) -and @(Get-ChildItem -LiteralPath $root -Force).Count -gt 0) { throw 'Setup directory is not empty and has no manifest; nothing there will be adopted.' } }
    $quotaAcl = if (Test-Path -LiteralPath $QuotaRoot) { Get-Dacl $QuotaRoot } else { $null }
    $vhdAcl = if (Test-Path -LiteralPath $VhdRoot) { Get-Dacl $VhdRoot } else { $null }
    $state.quota = [pscustomobject]@{ quotaRoot = $QuotaRoot; vhdRoot = $VhdRoot; sizeMb = $SizeMb; quotaOriginalDacl = $quotaAcl; vhdOriginalDacl = $vhdAcl; quotaInstalledDacl = $null; vhdInstalledDacl = $null; attachHash = $null; slots = @(foreach ($index in 0..($Slots - 1)) { [pscustomobject]@{ vhd = (Assert-Leaf $VhdRoot (Join-Path $VhdRoot "slot-$index.vhd")); mount = (Assert-Leaf $QuotaRoot (Join-Path $QuotaRoot "slot-$index")); ready = $false } }) }
    Save-State
  } else {
    if ($state.quota.vhdInstalledDacl) { Assert-UnchangedDacl $VhdRoot $state.quota.vhdInstalledDacl }
    if ($state.quota.quotaInstalledDacl) { Assert-UnchangedDacl $QuotaRoot $state.quota.quotaInstalledDacl }
  }
  New-Item -ItemType Directory -Force -Path $QuotaRoot, $VhdRoot | Out-Null
  Protect-SetupDirectory $VhdRoot
  $state.quota.vhdInstalledDacl = Get-Dacl $VhdRoot
  $state.quota.quotaInstalledDacl = Get-Dacl $QuotaRoot
  Save-State
  $attach = @()
  foreach ($slot in $state.quota.slots) {
    $vhd = Assert-Leaf $VhdRoot $slot.vhd
    $mount = Assert-Leaf $QuotaRoot $slot.mount
    $attach += "select vdisk file=`"$vhd`"", 'attach vdisk noerr'
    if (Test-Path -LiteralPath $vhd) {
      if ((Get-Item -LiteralPath $vhd -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'VHD must not be a reparse point.' }
      if (-not $slot.ready) { throw 'Partial VHD exists from interrupted setup. Review it before undo; it will not be reformatted.' }
      if (-not (Get-DiskImage -ImagePath $vhd).Attached) { Invoke-DiskPart @("select vdisk file=`"$vhd`"", 'attach vdisk') }
      Protect-SlotVolume $slot
      continue
    }
    if (Test-Path -LiteralPath $mount) { throw 'An untracked slot directory already exists.' }
    New-Item -ItemType Directory -Force -Path $mount | Out-Null
    Invoke-DiskPart @(
      "create vdisk file=`"$vhd`" maximum=$SizeMb type=fixed"
      "select vdisk file=`"$vhd`""
      'attach vdisk'
      'create partition primary'
      'format fs=ntfs quick label=MOHQUOTA'
      "assign mount=`"$mount`""
    )
    [void](Assert-MountedSlot $slot)
    # Only the app's user may use the volume. The sandbox gets access per run, to one folder.
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($user, (New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'), (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'))) {
      $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $mount -AclObject $acl
    Protect-SlotVolume $slot
    $slot.ready = $true
    Save-State
    Write-Host "Recorded slot mounted at $mount ($SizeMb MB)."
  }
  # The lock files live in the root, on the system volume, so the user needs write access there.
  $rootAcl = Get-Acl -LiteralPath $QuotaRoot
  $rootAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule $user, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  Set-Acl -LiteralPath $QuotaRoot -AclObject $rootAcl
  $state.quota.quotaInstalledDacl = Get-Dacl $QuotaRoot
  Save-State

  $attachScript = Assert-Leaf $VhdRoot (Join-Path $VhdRoot 'attach.txt')
  Set-Content -LiteralPath $attachScript -Value $attach -Encoding ASCII
  $state.quota.attachHash = (Get-FileHash -LiteralPath $attachScript -Algorithm SHA256).Hash
  Save-State
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\diskpart.exe" -Argument "/s `"$attachScript`""
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -RunLevel Highest
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
  Write-Host "Startup task $taskName registered."
  Write-Host "Add this line to the project's .env, then run: npm run sandbox:check"
  Write-Host "SANDBOX_QUOTA_ROOT=$QuotaRoot"
}

function Remove-Quota {
  if (-not $state.quota) { throw 'No quota installation recorded; nothing will be deleted.' }
  Assert-QuotaConfiguration
  Assert-UnchangedDacl $QuotaRoot $state.quota.quotaInstalledDacl
  Assert-UnchangedDacl $VhdRoot $state.quota.vhdInstalledDacl
  $attachScript = Assert-Leaf $VhdRoot (Join-Path $VhdRoot 'attach.txt')
  if ((Test-Path -LiteralPath $attachScript) -and (Get-FileHash -LiteralPath $attachScript -Algorithm SHA256).Hash -cne $state.quota.attachHash) { throw 'Startup script changed after installation; review before removal.' }
  foreach ($slot in $state.quota.slots) {
    [void](Assert-Leaf $VhdRoot $slot.vhd)
    [void](Assert-Leaf $QuotaRoot $slot.mount)
    if (Test-Path -LiteralPath $slot.vhd) {
      if ((Get-Item -LiteralPath $slot.vhd -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Recorded VHD became a reparse point.' }
      if ((Get-DiskImage -ImagePath $slot.vhd).Attached -and $slot.ready) {
        $volumePath = Assert-MountedSlot $slot
        if ($slot.PSObject.Properties['volumeInstalledDacl']) { Assert-UnchangedDacl $volumePath $slot.volumeInstalledDacl }
      }
    }
  }
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  foreach ($slot in $state.quota.slots) {
    if (Test-Path -LiteralPath $slot.vhd) {
      Invoke-DiskPart @("select vdisk file=`"$($slot.vhd)`"", 'detach vdisk noerr')
      if ((Get-DiskImage -ImagePath $slot.vhd).Attached) { throw 'VHD did not detach; it will not be deleted.' }
      Remove-Item -LiteralPath $slot.vhd -Force
    }
    # Non-recursive: if an unrelated file appeared, fail without deleting its contents.
    if (Test-Path -LiteralPath $slot.mount) { [IO.Directory]::Delete($slot.mount, $false) }
  }
  if (Test-Path -LiteralPath $attachScript) { Remove-Item -LiteralPath $attachScript -Force }
  if ($state.quota.quotaOriginalDacl) { Restore-Dacl $QuotaRoot $state.quota.quotaOriginalDacl $state.quota.quotaInstalledDacl }
  if ($state.quota.vhdOriginalDacl) { Restore-Dacl $VhdRoot $state.quota.vhdOriginalDacl $state.quota.vhdInstalledDacl }
  $state.quota = $null
  Save-State
  Write-Host 'Recorded quota resources removed; no unrelated files or lock files deleted. Delete SANDBOX_QUOTA_ROOT from .env.'
}

function Set-WinsockRead([bool]$Grant) {
  if ($Grant -and $state.winsock) {
    if ((Get-Dacl $winsockKey) -ceq $state.winsock.originalDacl) {
      # Recover a stop between recording the backup and applying its exact prepared DACL.
      $recordedAcl = Get-SetupAcl $winsockKey
      $recordedAcl.SetSecurityDescriptorSddlForm($state.winsock.installedDacl, $accessSection)
      Set-SetupAcl $winsockKey $recordedAcl
    }
    Assert-UnchangedDacl $winsockKey $state.winsock.installedDacl
    Write-Host 'Recorded Winsock read grant already installed.'
    return
  }
  if (-not $Grant) {
    if (-not $state.winsock -or $state.winsock.key -cne $winsockKey) { throw 'No matching Winsock ACL backup exists; permissions will not be guessed or removed.' }
    Restore-Dacl $winsockKey $state.winsock.originalDacl $state.winsock.installedDacl
    $state.winsock = $null
    Save-State
    Write-Host 'Exact original Winsock DACL restored and verified.'
    return
  }
  $acl = Get-SetupAcl $winsockKey
  $original = $acl.GetSecurityDescriptorSddlForm($accessSection)
  $sid = New-Object Security.Principal.SecurityIdentifier $allRestrictedPackages
  $rule = New-Object Security.AccessControl.RegistryAccessRule $sid, 'ReadKey', 'ContainerInherit', 'None', 'Allow'
  $acl.AddAccessRule($rule)
  $state.winsock = [pscustomobject]@{ key = $winsockKey; originalDacl = $original; installedDacl = $acl.GetSecurityDescriptorSddlForm($accessSection) }
  Save-State
  Set-SetupAcl $winsockKey $acl
  Assert-UnchangedDacl $winsockKey $state.winsock.installedDacl
  Write-Host 'Winsock read grant applied and verified; original DACL backed up.'
}

if ($Quota) { if ($Undo) { Remove-Quota } else { Install-Quota } }
if ($LpacWinsock) { Set-WinsockRead (-not $Undo) }
