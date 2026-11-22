# Run manually by the user. This file has NOT been executed by the assistant.
$ErrorActionPreference='Stop'
$mind=Split-Path -Parent $PSScriptRoot
$backup=Join-Path $mind 'data\backups\dialogue-skill-20261115-130518'
$expected='0.1.0-p1-daily-routines-dialogue'
$h=Invoke-RestMethod 'http://127.0.0.1:8430/v1/health' -TimeoutSec 3
if($h.ok -and $h.version -eq $expected){Write-Output 'Dialogue skill is already loaded. Nothing restarted.';exit 0}
if(!$h.ok -or $h.version -ne '0.1.0-p1-daily-routines'){throw 'Unexpected mind version. No process stopped.'}
$nodes=@(Get-NetTCPConnection -LocalPort 8430 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)
if($nodes.Count -ne 1){throw 'Expected one mind listener. No process stopped.'}
$p=Get-CimInstance Win32_Process -Filter "ProcessId=$($nodes[0])"
if($p.ExecutablePath -ne 'D:\node.exe' -or $p.CommandLine -notmatch 'server[/\\]server\.ts'){
 throw 'Unexpected listener process. No process stopped.'
}
foreach($rel in @('server\lib\dialogueSkill.ts','docs\skills\dialogue\SKILL.md','server\server.ts')){
 if(!(Test-Path -LiteralPath (Join-Path $mind $rel))){throw 'Dialogue files are missing. No process stopped.'}
}
$cfgHash=(Get-FileHash -LiteralPath (Join-Path $mind 'config.json')).Hash
$personaHash=(Get-FileHash -LiteralPath (Join-Path $mind 'docs\设定\林阅心.md')).Hash
Write-Output 'Restarting mind only. Desktop pet, browsers, chat logs and memories are not being stopped or replaced.'
Stop-Process -Id $p.ProcessId
Wait-Process -Id $p.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
function Start-Mind {
 Start-Process -FilePath 'D:\node.exe' -ArgumentList 'server\server.ts' -WorkingDirectory $mind -WindowStyle Hidden -RedirectStandardOutput (Join-Path $backup 'manual-mind-stdout.log') -RedirectStandardError (Join-Path $backup 'manual-mind-stderr.log') | Out-Null
}
Start-Mind
$ready=$false
for($i=0;$i -lt 60;$i++){
 try{$h=Invoke-RestMethod 'http://127.0.0.1:8430/v1/health' -TimeoutSec 1;if($h.ok -and $h.version -eq $expected){$ready=$true;break}}catch{}
 Start-Sleep -Milliseconds 250
}
if(!$ready){
 Write-Output 'New mind did not become healthy. Restoring only the prior program files.'
 foreach($idValue in @(Get-NetTCPConnection -LocalPort 8430 -State Listen -ErrorAction SilentlyContinue|Select-Object -ExpandProperty OwningProcess -Unique)){
  $v=Get-CimInstance Win32_Process -Filter "ProcessId=$idValue"
  if($v.ExecutablePath -eq 'D:\node.exe' -and $v.CommandLine -match 'server[/\\]server\.ts'){Stop-Process -Id $idValue}
 }
 foreach($name in @('paths.ts','prompts.ts','dialogueReview.ts')){
  Copy-Item -LiteralPath (Join-Path $backup $name) -Destination (Join-Path $mind ('server\lib\'+$name)) -Force
 }
 Copy-Item -LiteralPath (Join-Path $backup 'server.ts') -Destination (Join-Path $mind 'server\server.ts') -Force
 Start-Mind
 throw 'Previous program files restored. New dialogue skill is not active.'
}
if((Get-FileHash -LiteralPath (Join-Path $mind 'config.json')).Hash -ne $cfgHash){throw 'Unexpected configuration change; inspect backup before proceeding.'}
if((Get-FileHash -LiteralPath (Join-Path $mind 'docs\设定\林阅心.md')).Hash -ne $personaHash){throw 'Unexpected persona document change.'}
Write-Output ('Loaded successfully: '+$h.version)
Write-Output 'Dialogue skill now applies to new replies and grounding review. No pet restart is needed.'
