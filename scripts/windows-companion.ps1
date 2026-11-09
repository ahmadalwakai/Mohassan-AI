param([string]$ServerUrl='http://127.0.0.1:4000',[switch]$FixtureSelfTest,[switch]$FixtureFocusDiagnostic,[switch]$CompileOnly,[string]$ResultPath)
$ErrorActionPreference='Stop'
if(([int][bool]$FixtureSelfTest+[int][bool]$FixtureFocusDiagnostic+[int][bool]$CompileOnly) -gt 1){throw 'Choose one fixture or compile-only mode.'}
function Get-NativeFileHash([string]$Path){
  $taskStream=[IO.File]::OpenRead($Path)
  $taskSha=[Security.Cryptography.SHA256]::Create()
  try{return [BitConverter]::ToString($taskSha.ComputeHash($taskStream)).Replace('-','').ToLowerInvariant()}finally{$taskSha.Dispose();$taskStream.Dispose()}
}
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskSource=Join-Path $taskRoot 'apps/windows/Companion.cs'
$taskCompiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$taskFramework=Split-Path $taskCompiler
if(-not (Test-Path -LiteralPath $taskCompiler)){throw 'The trusted Windows .NET Framework compiler is unavailable.'}
$taskHash=Get-NativeFileHash $taskSource
$taskDirectory=Join-Path $taskRoot '.data/windows-native'
[IO.Directory]::CreateDirectory($taskDirectory)|Out-Null
$taskExecutable=Join-Path $taskDirectory ('companion-'+$taskHash+'.exe')
if(-not (Test-Path -LiteralPath $taskExecutable)){
  $taskReferences=@('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Net.Http.dll','System.Security.dll','System.Web.Extensions.dll','WPF/WindowsBase.dll','WPF/UIAutomationClient.dll','WPF/UIAutomationTypes.dll')|ForEach-Object{'/reference:'+(Join-Path $taskFramework $_)}
  & $taskCompiler /nologo /target:winexe /platform:x64 /optimize+ ('/out:'+$taskExecutable) @taskReferences $taskSource
  if($LASTEXITCODE -ne 0){throw 'Compilation of the trusted Windows companion failed.'}
}
if($CompileOnly){
  [pscustomobject]@{sourceSha256=$taskHash;executable=$taskExecutable;executableSha256=(Get-NativeFileHash $taskExecutable)}|ConvertTo-Json -Compress
}elseif($FixtureSelfTest -or $FixtureFocusDiagnostic){
  if(-not $ResultPath -or -not [IO.Path]::IsPathRooted($ResultPath)){throw 'Fixture needs an absolute report path.'}
  $taskResult=[IO.Path]::GetFullPath($ResultPath)
  if(Test-Path -LiteralPath $taskResult){throw 'Fixture report already exists; choose a new evidence path.'}
  $taskMode=if($FixtureFocusDiagnostic){'--fixture-focus-diagnostic'}else{'--fixture-self-test'}
  $taskProcess=Start-Process -FilePath $taskExecutable -ArgumentList @($taskMode,('"'+$taskResult+'"')) -WindowStyle Hidden -PassThru
  if(-not $taskProcess.WaitForExit(30000)){Stop-Process -Id $taskProcess.Id -Force;throw 'The fixture test exceeded its deadline.'}
  Get-Content -LiteralPath $taskResult -Raw
}else{
  # This is a visible, interactive consent window. Pairing or permissions are never enabled by this script.
  Start-Process -FilePath $taskExecutable -ArgumentList @('--server',('"'+$ServerUrl+'"')) | Out-Null
  Write-Output 'The Windows companion consent window is open. Pair and approve a target locally.'
}
