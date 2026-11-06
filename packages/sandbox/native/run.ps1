param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
try {
  Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Runner.cs') -Raw -Encoding UTF8)
  $request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $results = @()
  $deadline = [System.Diagnostics.Stopwatch]::StartNew()
  foreach ($command in $request.commands) {
    $remaining = [int]$request.timeoutMs - [int]$deadline.ElapsedMilliseconds
    if ($remaining -le 0 -and $results.Count -gt 0) {
      $results[-1].exitCode = 124
      $results[-1].timedOut = $true
      break
    }
    $result = [MohassanNativeSandbox]::Run([string]$request.node,[string]$request.work,[string]$request.temp,[string[]]$command.arguments,[Math]::Max(100,$remaining),[string]$request.cancelPath,[string]$request.output,[int]$request.memoryMb,[bool]$request.lowPrivilege,[bool]$request.publicResourceProbe,[long]$request.quotaBytes)
    $results += $result
    if ($result.exitCode -ne 0) { break }
  }
  @{ok=$true;results=$results} | ConvertTo-Json -Depth 8 -Compress
} catch {
  $cause = $_.Exception.GetBaseException()
  $detail = $cause.Message
  if ($cause -is [System.ComponentModel.Win32Exception]) { $detail += ' (Win32 ' + $cause.NativeErrorCode + ')' }
  @{ok=$false;error='AppContainer trusted helper failed';detail=$detail} | ConvertTo-Json -Compress
  exit 1
}
