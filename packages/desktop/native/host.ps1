param([Parameter(Mandatory=$true)][string]$Source,[Parameter(Mandatory=$true)][string]$CacheDir)
# Mohassan desktop native host: one long-lived Windows PowerShell process. Requests arrive as JSON lines
# on stdin ({id, op, args}); every reply is one JSON line on stdout ({id, ok, result|error}).
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.Encoding]::UTF8
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$OutputEncoding=[Text.Encoding]::UTF8
$references=@('System.Drawing','System.Windows.Forms','UIAutomationClient','UIAutomationTypes','WindowsBase','System.Core')
$sha=[Security.Cryptography.SHA256]::Create()
$stream=[IO.File]::OpenRead($Source)
try{$hash=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant().Substring(0,16)}finally{$stream.Dispose();$sha.Dispose()}
[IO.Directory]::CreateDirectory($CacheDir)|Out-Null
$assembly=Join-Path $CacheDir ("desktop-native-"+$hash+".dll")
if(-not (Test-Path -LiteralPath $assembly)){
  Add-Type -Path $Source -ReferencedAssemblies $references -OutputAssembly $assembly -OutputType Library
}
Add-Type -Path $assembly -ReferencedAssemblies $references
[MohassanDesktop.Native]::Init()|Out-Null
function Emit([hashtable]$payload){[Console]::Out.WriteLine((ConvertTo-Json -InputObject $payload -Compress -Depth 6));[Console]::Out.Flush()}
Emit @{ready=$true;pid=$PID;assembly=$assembly}
while($true){
  $line=[Console]::In.ReadLine()
  if($null -eq $line){break}
  if(-not $line.Trim()){continue}
  $id=$null
  try{
    $request=$line|ConvertFrom-Json
    $id=$request.id
    $a=$request.args
    $result=$null
    switch($request.op){
      'ping' {$result='pong'}
      'windows.list' {$result=@([MohassanDesktop.Native]::ListWindows())}
      'windows.foreground' {$result=[MohassanDesktop.Native]::Foreground()}
      'windows.get' {$result=[MohassanDesktop.Native]::Window([long]$a.handle)}
      'windows.focus' {$result=[MohassanDesktop.Native]::Focus([long]$a.handle)}
      'windows.show' {$result=[MohassanDesktop.Native]::Show([long]$a.handle,[string]$a.mode)}
      'screen.capture' {$result=[MohassanDesktop.Native]::Screenshot([long]($(if($null -eq $a.handle){0}else{$a.handle})),[int]($(if($null -eq $a.maxWidth){1600}else{$a.maxWidth})))}
      'screen.list' {$result=@([MohassanDesktop.Native]::Screens())}
      'input.type' {$result=[MohassanDesktop.Native]::TypeText([string]$a.text)}
      'input.keys' {$result=[MohassanDesktop.Native]::PressKeys([string]$a.combo)}
      'input.click' {$result=[MohassanDesktop.Native]::Click([int]$a.x,[int]$a.y,[string]($(if($null -eq $a.button){'left'}else{$a.button})),[bool]($(if($null -eq $a.double){$false}else{$a.double})))}
      'input.move' {$result=[MohassanDesktop.Native]::MoveMouse([int]$a.x,[int]$a.y)}
      'input.scroll' {$result=[MohassanDesktop.Native]::Scroll([int]$a.delta)}
      'input.cursor' {$result=@([MohassanDesktop.Native]::CursorPosition())}
      'input.focusedIsPassword' {$result=[MohassanDesktop.Native]::FocusedIsPassword()}
      'input.focusedInfo' {$result=[MohassanDesktop.Native]::FocusedInfo()}
      'input.focusedContains' {$result=[MohassanDesktop.Native]::FocusedContains([string]$a.text)}
      'elements.list' {$result=@([MohassanDesktop.Native]::Elements([long]($(if($null -eq $a.handle){0}else{$a.handle})),[int]($(if($null -eq $a.limit){150}else{$a.limit}))))}
      'clipboard.get' {$result=[MohassanDesktop.Native]::ClipboardGet()}
      'clipboard.set' {$result=[MohassanDesktop.Native]::ClipboardSet([string]$a.text)}
      default {throw ('UNKNOWN_OP:'+$request.op)}
    }
    Emit @{id=$id;ok=$true;result=$result}
  }catch{
    $message=$_.Exception.Message
    if($_.Exception.InnerException){$message=$_.Exception.InnerException.Message}
    Emit @{id=$id;ok=$false;error=[string]$message}
  }
}
