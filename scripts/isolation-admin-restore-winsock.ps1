$ErrorActionPreference = 'Stop'
$restoration = [ordered]@{ startedAt = [DateTime]::UtcNow.ToString('o'); success = $false; restoredExact = $false; operation = 'restore-recorded-winsock-only'; quotaRetained = $true }
try {
  $recordedState = Get-Content -LiteralPath 'C:\ProgramData\MohassanAI\isolation-admin\state.json' -Raw | ConvertFrom-Json
  if (-not $recordedState.winsock -or $recordedState.winsock.key -cne 'HKLM:\SYSTEM\CurrentControlSet\Services\WinSock2\Parameters') { throw 'No exact Winsock backup is recorded; nothing will be guessed.' }
  $originalDacl = $recordedState.winsock.originalDacl
  & 'C:\Mohassan AI\scripts\isolation-admin-setup.ps1' -LpacWinsock -Undo
  $registryBase = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
  $registryKey = $null
  try {
    $registryKey = $registryBase.OpenSubKey('SYSTEM\CurrentControlSet\Services\WinSock2\Parameters', [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadSubTree, [Security.AccessControl.RegistryRights]::ReadPermissions)
    $actualDacl = $registryKey.GetAccessControl([Security.AccessControl.AccessControlSections]::Access).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    if ($actualDacl -cne $originalDacl) { throw 'The restored Winsock DACL does not exactly match its backup.' }
    $restoration.restoredExact = $true
  } finally { if ($registryKey) { $registryKey.Dispose() }; $registryBase.Dispose() }
  $restoration.success = $true
} catch {
  $restoration.error = $_.Exception.Message
  $restoration.errorId = $_.FullyQualifiedErrorId
} finally {
  $restoration | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath 'C:\Mohassan AI\artifacts\isolation-winsock-restoration.json' -Encoding UTF8
}
if (-not $restoration.success) { exit 1 }
