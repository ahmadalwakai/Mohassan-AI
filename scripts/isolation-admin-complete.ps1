$ErrorActionPreference = 'Stop'
# Recorded VHDs are verified and reused; the setup never reformats a recorded slot.
$completion = [ordered]@{ startedAt = [DateTime]::UtcNow.ToString('o'); success = $false; operation = 'complete-recorded-quota-and-winsock' }
try {
  & 'C:\Mohassan AI\scripts\isolation-admin-setup.ps1' -Quota -LpacWinsock
  $completion.success = $true
} catch {
  $completion.error = $_.Exception.Message
  $completion.errorId = $_.FullyQualifiedErrorId
  $completion.line = $_.InvocationInfo.ScriptLineNumber
  $completion.script = $_.InvocationInfo.ScriptName
} finally {
  $completion | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath 'C:\Mohassan AI\artifacts\isolation-admin-completion.json' -Encoding UTF8
}
if (-not $completion.success) { exit 1 }
