<#
.SYNOPSIS
  One-time administrator setup for the isolation gates of executable skills.

.DESCRIPTION
  Run this yourself from an elevated PowerShell. Nothing in the app calls it.

  -Quota creates fixed-size VHD files on the current disk, mounts them as folders, and
  registers a startup task (running as SYSTEM) that reattaches them after a reboot. No extra
  physical disk is needed: 2 slots of 128 MB use 256 MB on C:.

  -LpacWinsock grants ALL RESTRICTED APPLICATION PACKAGES read access to the Winsock catalog in
  HKLM. Node cannot start under LPAC without it. It adds no capability to any process, but it is
  a machine-wide registry permission, so it is a separate switch.

  -Undo reverses whichever of the two switches is given.

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
  [string]$QuotaRoot = 'C:\MohassanQuota',
  [string]$VhdRoot = (Join-Path $env:ProgramData 'MohassanAI\quota'),
  [ValidateRange(1, 8)][int]$Slots = 2,
  [ValidateRange(32, 256)][int]$SizeMb = 128
)
$ErrorActionPreference = 'Stop'
$taskName = 'MohassanQuotaAttach'
$winsockKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\WinSock2\Parameters'
$allRestrictedPackages = 'S-1-15-2-2'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this from an elevated PowerShell (Run as administrator). Nothing was changed.'
}
if (-not $Quota -and -not $LpacWinsock) { throw 'Choose -Quota, -LpacWinsock or both. Nothing was changed.' }

function Invoke-DiskPart([string[]]$Lines) {
  $script = New-TemporaryFile
  try {
    Set-Content -LiteralPath $script.FullName -Value $Lines -Encoding ASCII
    $output = & "$env:SystemRoot\System32\diskpart.exe" /s $script.FullName
    if ($LASTEXITCODE -ne 0) { throw "diskpart failed:`n$($output -join "`n")" }
  } finally { Remove-Item -LiteralPath $script.FullName -Force }
}

function Install-Quota {
  $user = $identity.User
  New-Item -ItemType Directory -Force -Path $QuotaRoot, $VhdRoot | Out-Null
  $attach = @()
  foreach ($index in 0..($Slots - 1)) {
    $vhd = Join-Path $VhdRoot "slot-$index.vhd"
    $mount = Join-Path $QuotaRoot "slot-$index"
    $attach += "select vdisk file=`"$vhd`"", 'attach vdisk noerr'
    if (Test-Path -LiteralPath $vhd) { Write-Host "slot-$index already exists; left as it is."; continue }
    New-Item -ItemType Directory -Force -Path $mount | Out-Null
    Invoke-DiskPart @(
      "create vdisk file=`"$vhd`" maximum=$SizeMb type=fixed"
      "select vdisk file=`"$vhd`""
      'attach vdisk'
      'create partition primary'
      'format fs=ntfs quick label=MOHQUOTA'
      "assign mount=`"$mount`""
    )
    # Only the app's user may use the volume. The sandbox gets access per run, to one folder.
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($user, (New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'), (New-Object Security.Principal.SecurityIdentifier 'S-1-5-32-544'))) {
      $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule $sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    }
    Set-Acl -LiteralPath $mount -AclObject $acl
    Write-Host "slot-$index mounted at $mount ($SizeMb MB)."
  }
  # The lock files live in the root, on the system volume, so the user needs write access there.
  $rootAcl = Get-Acl -LiteralPath $QuotaRoot
  $rootAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule $user, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  Set-Acl -LiteralPath $QuotaRoot -AclObject $rootAcl

  $attachScript = Join-Path $VhdRoot 'attach.txt'
  Set-Content -LiteralPath $attachScript -Value $attach -Encoding ASCII
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\diskpart.exe" -Argument "/s `"$attachScript`""
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -RunLevel Highest
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
  Write-Host "Startup task $taskName registered."
  Write-Host "Add this line to the project's .env, then run: npm run sandbox:check"
  Write-Host "SANDBOX_QUOTA_ROOT=$QuotaRoot"
}

function Remove-Quota {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  foreach ($vhd in Get-ChildItem -LiteralPath $VhdRoot -Filter 'slot-*.vhd' -ErrorAction SilentlyContinue) {
    Invoke-DiskPart @("select vdisk file=`"$($vhd.FullName)`"", 'detach vdisk noerr')
    Remove-Item -LiteralPath $vhd.FullName -Force
    Write-Host "$($vhd.Name) detached and deleted."
  }
  Remove-Item -LiteralPath (Join-Path $VhdRoot 'attach.txt') -Force -ErrorAction SilentlyContinue
  foreach ($mount in Get-ChildItem -LiteralPath $QuotaRoot -Directory -Filter 'slot-*' -ErrorAction SilentlyContinue) { Remove-Item -LiteralPath $mount.FullName -Force }
  Get-ChildItem -LiteralPath $QuotaRoot -Filter '*.lock' -ErrorAction SilentlyContinue | Remove-Item -Force
  Write-Host "Removed. Delete SANDBOX_QUOTA_ROOT from .env."
}

function Set-WinsockRead([bool]$Grant) {
  $acl = Get-Acl -LiteralPath $winsockKey
  $sid = New-Object Security.Principal.SecurityIdentifier $allRestrictedPackages
  $rule = New-Object Security.AccessControl.RegistryAccessRule $sid, 'ReadKey', 'ContainerInherit', 'None', 'Allow'
  if ($Grant) { $acl.AddAccessRule($rule) } else { [void]$acl.RemoveAccessRule($rule) }
  Set-Acl -LiteralPath $winsockKey -AclObject $acl
  Write-Host $(if ($Grant) { 'Winsock catalog read granted to ALL RESTRICTED APPLICATION PACKAGES.' } else { 'Winsock catalog read removed.' })
}

if ($Quota) { if ($Undo) { Remove-Quota } else { Install-Quota } }
if ($LpacWinsock) { Set-WinsockRead (-not $Undo) }
