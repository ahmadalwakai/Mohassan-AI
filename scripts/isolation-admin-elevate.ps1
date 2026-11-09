$ErrorActionPreference = 'Stop'
# Only asks Windows for its normal UAC approval. It never accepts the prompt.
$setupScript = 'C:\Mohassan AI\scripts\isolation-admin-setup.ps1'
if (-not (Test-Path -LiteralPath $setupScript -PathType Leaf)) { throw 'The reviewed isolation setup script is missing.' }
try {
  $setupProcess = Start-Process -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', '"C:\Mohassan AI\scripts\isolation-admin-setup.ps1"', '-Quota', '-LpacWinsock') -PassThru
} catch {
  if ($_.Exception.NativeErrorCode -eq 1223) { Write-Output 'UAC_CANCELLED:1223'; exit 1223 }
  throw
}
$setupProcess.WaitForExit()
Write-Output ('SETUP_EXIT_CODE:' + $setupProcess.ExitCode)
exit $setupProcess.ExitCode
