param(
  [switch]$Run,
  [string[]]$Tests = @(),
  [string[]]$ShareArtifact = @(),
  [int]$MaxAttempts = 3,
  [switch]$NoShareVenv
)
$ErrorActionPreference = 'Stop'
$brainSnapshotNode = (Get-Command node.exe -ErrorAction Stop).Source
$brainSnapshotArguments = @((Join-Path $PSScriptRoot 'snapshot-brain-tests.mjs'), '--max-attempts', [string]$MaxAttempts)
if ($Run) { $brainSnapshotArguments += '--run' }
if ($NoShareVenv) { $brainSnapshotArguments += '--no-share-venv' }
foreach ($brainSnapshotTest in $Tests) { $brainSnapshotArguments += @('--tests', $brainSnapshotTest) }
foreach ($brainSnapshotArtifact in $ShareArtifact) { $brainSnapshotArguments += @('--share-artifact', $brainSnapshotArtifact) }
& $brainSnapshotNode @brainSnapshotArguments
exit $LASTEXITCODE
