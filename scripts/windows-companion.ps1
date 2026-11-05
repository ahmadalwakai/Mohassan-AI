param([string]$ServerUrl='http://127.0.0.1:4000',[switch]$FixtureSelfTest,[string]$ResultPath)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskSource=Join-Path $taskRoot 'apps/windows/Companion.cs'
$taskCompiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$taskFramework=Split-Path $taskCompiler
if(-not (Test-Path -LiteralPath $taskCompiler)){throw 'The trusted Windows .NET Framework compiler is unavailable.'}
$taskHash=(Get-FileHash -LiteralPath $taskSource -Algorithm SHA256).Hash.ToLowerInvariant()
$taskDirectory=Join-Path $taskRoot '.data/windows-native'
[IO.Directory]::CreateDirectory($taskDirectory)|Out-Null
$taskExecutable=Join-Path $taskDirectory ('companion-'+$taskHash+'.exe')
if(-not (Test-Path -LiteralPath $taskExecutable)){
  $taskReferences=@('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Net.Http.dll','System.Security.dll','System.Web.Extensions.dll','WPF/WindowsBase.dll','WPF/UIAutomationClient.dll','WPF/UIAutomationTypes.dll')|ForEach-Object{'/reference:'+(Join-Path $taskFramework $_)}
  & $taskCompiler /nologo /target:winexe /platform:x64 /optimize+ ('/out:'+$taskExecutable) @taskReferences $taskSource
  if($LASTEXITCODE -ne 0){throw 'Compilation of the trusted Windows companion failed.'}
}
if($FixtureSelfTest){
  if(-not $ResultPath){throw 'Fixture self-test needs an absolute report path.'}
  $taskResult=[IO.Path]::GetFullPath($ResultPath)
  $taskProcess=Start-Process -FilePath $taskExecutable -ArgumentList @('--fixture-self-test',('"'+$taskResult+'"')) -PassThru
  if(-not $taskProcess.WaitForExit(30000)){Stop-Process -Id $taskProcess.Id -Force;throw 'The fixture test exceeded its deadline.'}
  Get-Content -LiteralPath $taskResult -Raw
}else{
  # This is a visible, interactive consent window. Pairing or permissions are never enabled by this script.
  Start-Process -FilePath $taskExecutable -ArgumentList @('--server',('"'+$ServerUrl+'"')) | Out-Null
  Write-Output 'The Windows companion consent window is open. Pair and approve a target locally.'
}
