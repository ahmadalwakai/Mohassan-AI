<#
.SYNOPSIS
  Phase 0 resource sampler (docs/MOHASSAN-DEVELOPMENT-PLAN-2026-11-22.md §5.1).

.DESCRIPTION
  Writes one JSON line per sample: memory and CPU time of a process tree grouped by role
  (harness, api, web, browser, python, other), the whole computer's free memory and CPU load,
  and the GPU from nvidia-smi. Read-only: it never starts, stops or changes a process.

  The server's browser is Google Chrome in headless mode, the same chrome.exe as the owner's
  own Chrome, so processes are counted only when they descend from -RootPid. With -RootPid 0
  only the computer-wide and GPU fields are written.

.EXAMPLE
  pwsh -NoProfile -File scripts/perf/resource-sampler.ps1 -RootPid 1234 -OutFile artifacts/perf/x/resources.jsonl -StopFile artifacts/perf/x/sampler.stop
#>
param(
  [int]$RootPid = 0,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [double]$IntervalSeconds = 3,
  [int]$DurationSeconds = 0,
  [string]$StopFile = '',
  [switch]$Once
)
$ErrorActionPreference = 'Stop'
$nvidiaCommand = Get-Command nvidia-smi -ErrorAction SilentlyContinue
$nvidia = if ($nvidiaCommand) { $nvidiaCommand.Source } else { $null }
$parent = Split-Path -Parent $OutFile
if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
$started = Get-Date

function Get-Role($process) {
  $name = $process.Name.ToLowerInvariant()
  $line = [string]$process.CommandLine
  if ($process.ProcessId -eq $RootPid) { return 'harness' }
  if ($name -in @('chrome.exe', 'chromium.exe', 'chrome-headless-shell.exe', 'headless_shell.exe')) { return 'browser' }
  if ($name -like 'python*.exe') { return 'python' }
  if ($name -eq 'node.exe' -and $line -match 'server-entry\.ts|apps[\\/]server[\\/]src[\\/]index\.ts') { return 'api' }
  if ($name -eq 'node.exe' -and $line -match 'next[\\/]dist[\\/]bin[\\/]next|next-server|[\\/]next[\\/]dist[\\/]') { return 'web' }
  if ($name -eq 'node.exe') { return 'node-other' }
  if ($name -in @('pwsh.exe', 'powershell.exe', 'conhost.exe', 'nvidia-smi.exe', 'wmiprvse.exe')) { return 'tooling' }
  return 'other'
}

function Write-Sample {
  $at = (Get-Date).ToUniversalTime().ToString('o')
  $os = Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory, TotalVisibleMemorySize
  $cpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -Property PercentProcessorTime).PercentProcessorTime
  $sample = [ordered]@{
    at = $at
    system = [ordered]@{ freeMB = [math]::Round($os.FreePhysicalMemory / 1024, 1); totalMB = [math]::Round($os.TotalVisibleMemorySize / 1024, 1); cpuPercent = [int]$cpu }
  }
  if ($RootPid -gt 0) {
    $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, WorkingSetSize, PrivatePageCount, KernelModeTime, UserModeTime, CreationDate
    $children = @{}
    foreach ($process in $all) {
      $key = [int]$process.ParentProcessId
      if (-not $children.ContainsKey($key)) { $children[$key] = New-Object System.Collections.Generic.List[object] }
      $children[$key].Add($process)
    }
    $tree = New-Object System.Collections.Generic.List[object]
    $root = $all | Where-Object { $_.ProcessId -eq $RootPid } | Select-Object -First 1
    if ($root) {
      $queue = New-Object System.Collections.Generic.Queue[object]
      $queue.Enqueue($root)
      $visited = @{}
      while ($queue.Count -gt 0) {
        $item = $queue.Dequeue()
        if ($visited.ContainsKey([int]$item.ProcessId)) { continue }
        $visited[[int]$item.ProcessId] = $true
        $tree.Add($item)
        # A reused parent id can point at an older unrelated process; children must be created after it.
        if ($children.ContainsKey([int]$item.ProcessId)) {
          foreach ($child in $children[[int]$item.ProcessId]) { if ($child.CreationDate -ge $item.CreationDate) { $queue.Enqueue($child) } }
        }
      }
    }
    $roles = [ordered]@{}
    foreach ($process in $tree) {
      $role = Get-Role $process
      if (-not $roles.Contains($role)) { $roles[$role] = [ordered]@{ count = 0; workingSetMB = 0.0; privateMB = 0.0; cpuSeconds = 0.0 } }
      $roles[$role].count++
      $roles[$role].workingSetMB += [math]::Round($process.WorkingSetSize / 1MB, 1)
      $roles[$role].privateMB += [math]::Round($process.PrivatePageCount / 1MB, 1)
      $roles[$role].cpuSeconds += [math]::Round(($process.KernelModeTime + $process.UserModeTime) / 1e7, 2)
    }
    $sample.rootAlive = [bool]$root
    $sample.roles = $roles
  }
  if ($nvidia) {
    $line = & $nvidia --query-gpu=memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits 2>$null | Select-Object -First 1
    if ($line) {
      $parts = $line.Split(',') | ForEach-Object { $_.Trim() }
      $sample.gpu = [ordered]@{ usedMiB = [int]$parts[0]; totalMiB = [int]$parts[1]; utilizationPercent = [int]$parts[2]; temperatureC = [int]$parts[3]; powerW = $parts[4] }
    }
  }
  ($sample | ConvertTo-Json -Depth 6 -Compress) | Add-Content -LiteralPath $OutFile -Encoding utf8
  return $sample
}

while ($true) {
  $sample = Write-Sample
  if ($Once) { break }
  if ($StopFile -and (Test-Path -LiteralPath $StopFile)) { break }
  if ($DurationSeconds -gt 0 -and ((Get-Date) - $started).TotalSeconds -ge $DurationSeconds) { break }
  if ($RootPid -gt 0 -and -not $sample.rootAlive) { break }
  Start-Sleep -Milliseconds ([int]($IntervalSeconds * 1000))
}
