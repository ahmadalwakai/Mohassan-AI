$ErrorActionPreference = 'Stop'
# Read-only administrator inspection of this setup's fixed resources.
$summary = [ordered]@{ inspectedAt = [DateTime]::UtcNow.ToString('o'); elevated = $false; manifest = $false; quota = $null; winsockRecorded = $false; startupTask = $null }
try {
  $inspectionIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $summary.elevated = ([Security.Principal.WindowsPrincipal]$inspectionIdentity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $summary.elevated) { throw 'Administrator inspection requires an elevated process.' }
  $inspectionState = Get-Content -LiteralPath 'C:\ProgramData\MohassanAI\isolation-admin\state.json' -Raw | ConvertFrom-Json
  $summary.manifest = $true
  if ($inspectionState.quota) {
    $summary.quota = [ordered]@{
      sizeMb = $inspectionState.quota.sizeMb
      quotaRoot = $inspectionState.quota.quotaRoot
      vhdRoot = $inspectionState.quota.vhdRoot
      quotaDaclRecorded = [bool]$inspectionState.quota.quotaInstalledDacl
      vhdDaclRecorded = [bool]$inspectionState.quota.vhdInstalledDacl
      attachHashRecorded = [bool]$inspectionState.quota.attachHash
      slots = @(foreach ($inspectionSlot in $inspectionState.quota.slots) {
        $slotSummary = [ordered]@{ ready = $inspectionSlot.ready; mount = $inspectionSlot.mount; attached = $false }
        try {
          $slotImage = Get-DiskImage -ImagePath $inspectionSlot.vhd
          $slotSummary.attached = $slotImage.Attached
          if ($slotImage.Attached) { $slotSummary.capacityBytes = ($slotImage | Get-Disk).Size }
        } catch { $slotSummary.error = $_.Exception.Message }
        $slotSummary
      })
    }
  }
  $summary.winsockRecorded = [bool]$inspectionState.winsock
  $inspectionTask = Get-ScheduledTask -TaskName 'MohassanQuotaAttach' -ErrorAction SilentlyContinue
  $summary.startupTask = if ($inspectionTask) { [ordered]@{ name = $inspectionTask.TaskName; state = $inspectionTask.State.ToString() } } else { $null }
} catch { $summary.error = $_.Exception.Message }
$summary | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath 'C:\Mohassan AI\artifacts\isolation-admin-state.json' -Encoding UTF8
if ($summary.error) { exit 1 }
