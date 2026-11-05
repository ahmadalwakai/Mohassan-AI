param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Runner.cs') -Raw)
  $request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
  $results = @()
  $deadline = [System.Diagnostics.Stopwatch]::StartNew()
  foreach ($command in $request.commands) {
    $remaining = [int]$request.timeoutMs - [int]$deadline.ElapsedMilliseconds
    if ($remaining -le 0 -and $results.Count -gt 0) {
      $results[-1].exitCode = 124
      $results[-1].timedOut = $true
      break
    }
    $result = [MohassanNativeSandbox]::Run([string]$request.node,[string]$request.work,[string]$request.temp,[string[]]$command.arguments,[Math]::Max(100,$remaining),[string]$request.cancelPath)
    $results += $result
    if ($result.exitCode -ne 0) { break }
  }
  @{ok=$true;results=$results} | ConvertTo-Json -Depth 8 -Compress
} catch {
  @{ok=$false;error='AppContainer trusted helper failed';detail=$_.Exception.Message} | ConvertTo-Json -Compress
  exit 1
}
