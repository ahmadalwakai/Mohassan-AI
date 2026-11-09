import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const windows = process.platform === 'win32';
const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const script = resolve('scripts/isolation-admin-setup.ps1');
const plan = (...args: string[]) => spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', script, '-Quota', '-LpacWinsock', '-PlanOnly', ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true });

describe.skipIf(!windows)('administrator isolation plan without machine mutations', () => {
  it('prints the precise registry, mount and backup scope without applying it', () => {
    const result = plan();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ changesApplied: false, quotaRoot: 'C:\\MohassanQuota', slots: 2, sizeMbPerSlot: 128, registryPrincipal: 'S-1-15-2-2', requiresStoppedWorkers: true });
  });

  it.each([
    ['-QuotaRoot', 'C:\\'],
    ['-QuotaRoot', 'C:\\Windows\\quota'],
    ['-QuotaRoot', 'C:\\unsafe"\nclean'],
    ['-QuotaRoot', '\\\\server\\share'],
    ['-QuotaRoot', 'C:\\same', '-VhdRoot', 'C:\\same\\nested'],
  ])('refuses unsafe or overlapping paths before any privileged action: %s %s', (...args) => {
    const result = plan(...args);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('changesApplied');
  });

  it('restores the exact original ACL, is idempotent and refuses a concurrent change', () => {
    const source = script.replace(/'/g, "''");
    const command = `
$errors = $null; $tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${source}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Syntax errors' }
foreach ($name in @('Get-SetupAcl', 'Set-SetupAcl', 'Assert-UnchangedDacl', 'Restore-Dacl')) {
  $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  Invoke-Expression $definition.Extent.Text
}
$accessSection = [Security.AccessControl.AccessControlSections]::Access
$script:fakeAcl = New-Object Security.AccessControl.RegistrySecurity
$script:fakeAcl.SetSecurityDescriptorSddlForm('D:P(A;CI;KR;;;SY)', $accessSection)
$original = $script:fakeAcl.GetSecurityDescriptorSddlForm($accessSection)
$sid = New-Object Security.Principal.SecurityIdentifier 'S-1-15-2-2'
$script:fakeAcl.AddAccessRule((New-Object Security.AccessControl.RegistryAccessRule $sid, 'ReadKey', 'ContainerInherit', 'None', 'Allow'))
$installed = $script:fakeAcl.GetSecurityDescriptorSddlForm($accessSection)
$script:writes = 0
function Get-Dacl([string]$Path) { $script:fakeAcl.GetSecurityDescriptorSddlForm($accessSection) }
function Get-Acl { param($LiteralPath) return $script:fakeAcl }
function Set-Acl { param($LiteralPath, $AclObject) $script:fakeAcl = $AclObject; $script:writes++ }
Restore-Dacl 'fixture' $original $installed
Restore-Dacl 'fixture' $original $installed
if ((Get-Dacl 'fixture') -cne $original -or $script:writes -ne 1) { throw 'Restore was not exact/idempotent' }
$script:fakeAcl.SetSecurityDescriptorSddlForm('D:P(A;CI;KA;;;SY)', $accessSection)
$blocked = $false
try { Restore-Dacl 'fixture' $original $installed } catch { $blocked = $true }
if (-not $blocked -or $script:writes -ne 1) { throw 'Concurrent ACL change was overwritten' }
Write-Output 'exact-restore-conflict-check-passed'
`;
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('exact-restore-conflict-check-passed');
  });

  it('reads the fixed Winsock DACL using the native 64-bit registry view without mutation', () => {
    const source = script.replace(/'/g, "''");
    const command = `
$errors = $null; $tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${source}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Syntax errors' }
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-SetupAcl' }, $true)
Invoke-Expression $definition.Extent.Text
$winsockKey = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\WinSock2\\Parameters'
$accessSection = [Security.AccessControl.AccessControlSections]::Access
$before = Get-SetupAcl $winsockKey
$after = Get-SetupAcl $winsockKey
if ($before -isnot [Security.AccessControl.RegistrySecurity] -or $before.Access.Count -lt 1) { throw 'No registry DACL evidence' }
if ($before.GetSecurityDescriptorSddlForm($accessSection) -cne $after.GetSecurityDescriptorSddlForm($accessSection)) { throw 'Registry DACL changed' }
Write-Output 'native-registry-dacl-read-passed'
`;
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('native-registry-dacl-read-passed');
  });

  it('accepts only the Windows auto-inherited marker on an otherwise exact protected volume DACL', () => {
    const source = script.replace(/'/g, "''");
    const command = `
$errors = $null; $tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${source}', [ref]$tokens, [ref]$errors)
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-PreparedVolumeDacl' }, $true)
Invoke-Expression $definition.Extent.Text
$prepared = 'D:P(A;OICI;FA;;;SY)'
if (-not (Test-PreparedVolumeDacl 'D:PAI(A;OICI;FA;;;SY)' $prepared)) { throw 'Windows DACL marker rejected' }
foreach ($changed in @('D:AI(A;OICI;FA;;;SY)', 'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;WD)', 'D:PAI(A;OICI;FR;;;SY)')) {
  if (Test-PreparedVolumeDacl $changed $prepared) { throw 'Changed permissions accepted' }
}
Write-Output 'protected-volume-dacl-check-passed'
`;
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('protected-volume-dacl-check-passed');
  });
});
