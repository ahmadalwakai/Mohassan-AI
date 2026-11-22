# Creates the computer service's own Python environment in .venv (Python 3.11 or newer)
# and installs requirements.txt. Run once, then Start-Wasla.cmd uses it.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$python = $null
foreach ($candidate in @('py -3.11', 'py -3.12', 'py -3.13', 'python')) {
    try {
        $parts = $candidate.Split(' ')
        $version = & $parts[0] @($parts[1..($parts.Length - 1)] + @('-c', 'import sys; print(sys.version_info[0], sys.version_info[1])')) 2>$null
        if ($LASTEXITCODE -eq 0 -and $version) {
            $major, $minor = $version.Trim().Split(' ')
            if ([int]$major -eq 3 -and [int]$minor -ge 11) { $python = $parts; break }
        }
    } catch { }
}
if (-not $python) { throw 'Python 3.11 or newer was not found. Install it from python.org, then run this script again.' }
$venv = Join-Path $root '.venv'
if (-not (Test-Path (Join-Path $venv 'Scripts\python.exe'))) {
    & $python[0] @($python[1..($python.Length - 1)] + @('-m', 'venv', $venv))
}
& (Join-Path $venv 'Scripts\python.exe') -m pip install --upgrade pip --quiet
& (Join-Path $venv 'Scripts\python.exe') -m pip install -r (Join-Path $root 'requirements.txt') --quiet
Write-Output "Wasla service environment ready: $venv"
