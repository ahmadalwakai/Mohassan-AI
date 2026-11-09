$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
$logDirectory = Join-Path $projectRoot '.data'

# A second Startup invocation must not create another API or restart loop.
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$supervisorMutex = [System.Threading.Mutex]::new($false, "Local\MohassanAI.Production.$userSid")
$ownsMutex = $false
try {
    try {
        $ownsMutex = $supervisorMutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $ownsMutex = $true
    }
    if (-not $ownsMutex) { exit 0 }

    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $restartDelaySeconds = 10
    while ($true) {
        $logDate = Get-Date -Format 'yyyy-MM-dd'
        $stdoutPath = Join-Path $logDirectory "production-$logDate.out.log"
        $stderrPath = Join-Path $logDirectory "production-$logDate.err.log"
        $startedAt = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            # This console child inherits the hidden PowerShell window launched at sign-in.
            & node (Join-Path $PSScriptRoot 'start-server.mjs') 1>> $stdoutPath 2>> $stderrPath
            $apiExitCode = $LASTEXITCODE
            "$(Get-Date -Format o) Production API exited with code $apiExitCode." | Add-Content -LiteralPath $stderrPath
        } catch {
            # Do not serialize exception details, environment values, or credentials.
            "$(Get-Date -Format o) Unable to launch the production API. Check Node.js and service configuration." | Add-Content -LiteralPath $stderrPath
        }
        $startedAt.Stop()
        if ($startedAt.Elapsed.TotalSeconds -ge 120) { $restartDelaySeconds = 10 }
        "$(Get-Date -Format o) Restarting production API in $restartDelaySeconds seconds." | Add-Content -LiteralPath $stderrPath
        Start-Sleep -Seconds $restartDelaySeconds
        $restartDelaySeconds = [Math]::Min(30, $restartDelaySeconds * 2)
    }
} finally {
    if ($ownsMutex) { $supervisorMutex.ReleaseMutex() }
    $supervisorMutex.Dispose()
}
