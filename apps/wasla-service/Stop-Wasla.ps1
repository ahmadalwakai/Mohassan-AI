$ErrorActionPreference = 'Stop'
# A private, identity-bound request is consumed by the backend. Never kill a PID.
$waslaTaskRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$waslaStateRoot = Join-Path $waslaTaskRoot 'work\wasla-state'
$waslaStatusPath = Join-Path $waslaStateRoot 'server-status.json'
if (-not (Test-Path -LiteralPath $waslaStatusPath -PathType Leaf)) {
    Write-Output 'Wasla is not reporting an active server.'
    exit 0
}
$waslaRawStatus = [System.IO.File]::ReadAllText($waslaStatusPath)
$waslaStatus = $waslaRawStatus | ConvertFrom-Json
$waslaPidMatch = [regex]::Match($waslaRawStatus, '"pid"\s*:\s*(\d+)')
$waslaStartedMatch = [regex]::Match($waslaRawStatus, '"started_at"\s*:\s*(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)')
if (-not $waslaPidMatch.Success -or -not $waslaStartedMatch.Success -or [int64]$waslaStatus.pid -le 0) {
    throw 'The server identity is incomplete. No stop request was written.'
}
# Preserve the exact timestamp literal; converting through a rounded JSON double
# can fail the backend's exact identity check in Windows PowerShell 5.1.
$waslaStopBody = '{"pid":' + $waslaPidMatch.Groups[1].Value + ',"started_at":' + $waslaStartedMatch.Groups[1].Value + '}'
$waslaRequestPath = Join-Path $waslaStateRoot 'stop-request.json'
$waslaTemporaryPath = Join-Path $waslaStateRoot ('stop-request.' + [guid]::NewGuid().ToString('N') + '.tmp')
$waslaEncoding = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($waslaTemporaryPath, $waslaStopBody, $waslaEncoding)
if (Test-Path -LiteralPath $waslaRequestPath -PathType Leaf) {
    [System.IO.File]::Replace($waslaTemporaryPath, $waslaRequestPath, $null)
} else {
    [System.IO.File]::Move($waslaTemporaryPath, $waslaRequestPath)
}
Write-Output 'Graceful stop requested. Remote access will close while owned work finishes cleanup.'
for ($waslaAttempt = 0; $waslaAttempt -lt 10; $waslaAttempt++) {
    Start-Sleep -Seconds 1
    if (-not (Test-Path -LiteralPath $waslaStatusPath -PathType Leaf)) {
        Write-Output 'Wasla stopped.'
        exit 0
    }
}
Write-Output 'Cleanup is still in progress. No process was forcefully stopped.'
