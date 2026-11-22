import { spawn } from 'node:child_process';
import { DesktopError } from './errors.ts';

export interface ShellResult {
  command: string;
  cwd: string;
  shell: 'pwsh' | 'powershell' | 'cmd';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export type DangerLevel = 'safe' | 'dangerous' | 'forbidden';
export interface CommandClassification { level: DangerLevel; reason: string; reasonAr: string }

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  shell?: 'pwsh' | 'powershell' | 'cmd';
  env?: Record<string, string>;
  signal?: AbortSignal;
}

const fold = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const SYSTEM_TARGET = /(?:c:\\windows|\\system32\\|\\syswow64\\|program files|programdata|\$env:windir|\$env:systemroot|\$env:programfiles|%windir%|%systemroot%|%programfiles%)/u;
const READ_ONLY_HEAD = /^(?:get-childitem|gci|dir|ls|get-item|gi|get-content|gc|cat|type|test-path|get-acl|get-filehash|where\.exe|where\b|get-command|gcm|tree|find\b|findstr|select-string|sls|measure-object|get-process|gps|ps\b|tasklist|get-service|gsv|systeminfo|whoami|hostname|ipconfig|get-date|echo|write-output|write-host|git (?:status|log|diff|show|branch|remote)|node -v|npm -v|python --version|dotnet --info|ver\b)/u;
const DELETE_VERB = /(?:^|[;|&(]\s*)(?:remove-item|ri|rm|rmdir|rd|del|erase|unlink|clear-content|clc|remove-itemproperty)\b/u;
/** Paths whose deletion is never allowed: drive roots, the Windows and program folders, the whole user profile. */
const DELETE_FORBIDDEN_TARGET = /(?:^|\s|["'])(?:[a-z]:\\?)(?=\s|$|["']|\*)|\\users\\?(?:\s|$|["'])|\\users\\[^\\\s"']+\\?(?:\s|$|["'])|(?:\$home|\$env:userprofile|~)(?:\\?\*?)?(?:\s|$|["'])|c:\\windows|program files|programdata|\$env:windir|\$env:systemroot/u;

const FORBIDDEN: [RegExp, string, string][] = [
  [/(?:^|[;|&(]\s*)format(?:\.com)?\s+[a-z]:/u, 'formats a drive', 'يهيّئ قرصًا كاملًا'],
  [/(?:^|[;|&(]\s*)(?:diskpart|bcdedit|manage-bde|mkfs(?:\.\w+)?|dd\s+if=)\b/u, 'changes disks or boot settings', 'يغيّر الأقراص أو إعدادات الإقلاع'],
  [/\bcipher\s+\/w/u, 'wipes free space', 'يمسح المساحة الحرة نهائيًا'],
  [/\bvssadmin\b[^|]*\bdelete\b|\bwbadmin\s+delete\b/u, 'deletes system restore data', 'يحذف نسخ استعادة النظام'],
  [/\breg(?:\.exe)?\s+delete\s+(?:hklm|hkey_local_machine|hkcr|hkey_classes_root)\b/u, 'deletes machine registry keys', 'يحذف مفاتيح سجل النظام'],
  [/set-mppreference\b[^|]*-disable\w*\s+\$?true/u, 'disables Windows Defender protection', 'يعطّل حماية Windows Defender'],
  [/netsh\s+advfirewall\s+set\s+\w+\s+state\s+off/u, 'turns the firewall off', 'يوقف جدار الحماية'],
  [/\bnet\s+user\b[^|]*\/add|\bnet\s+localgroup\s+administrators\b[^|]*\/add/u, 'creates or elevates accounts', 'ينشئ حسابات أو يرفع صلاحياتها'],
  [/(?:takeown|icacls)\b[^|]*(?:c:\\windows|program files|\\system32)/u, 'changes ownership of system files', 'يغيّر ملكية ملفات النظام'],
  [/rm\s+-[a-z]*r[a-z]*\s+(?:\/|~|\$home)(?:\s|$)/u, 'deletes the whole file system or home', 'يحذف نظام الملفات أو مجلد المستخدم كله'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/u, 'fork bomb', 'يستهلك موارد الجهاز حتى يتوقف'],
];

const DANGEROUS: [RegExp, string, string][] = [
  [DELETE_VERB, 'deletes files or folders', 'يحذف ملفات أو مجلدات'],
  [/\bgit\s+(?:push\b[^|]*(?:--force|-f\b)|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-[dD]\b|stash\s+(?:drop|clear)|rebase\b|filter-branch)/u, 'rewrites or discards git history', 'يعيد كتابة سجل Git أو يتخلص من تغييرات'],
  [/\bgit\s+push\b/u, 'publishes to a remote repository', 'ينشر إلى مستودع بعيد'],
  [/(?:^|[;|&(]\s*)(?:taskkill|stop-process|spps|kill)\b/u, 'ends running programs', 'يُنهي برامج تعمل الآن'],
  [/(?:^|[;|&(]\s*)(?:shutdown|restart-computer|stop-computer|logoff|rundll32(?:\.exe)?\s+user32\.dll,\s*lockworkstation)\b/u, 'shuts down, restarts or locks the computer', 'يطفئ الجهاز أو يعيد تشغيله أو يقفله'],
  [/\bnpm\s+publish\b|\bpip\s+upload\b|\btwine\s+upload\b|\bdotnet\s+nuget\s+push\b/u, 'publishes a package', 'ينشر حزمة'],
  [/\b(?:npm|yarn|pnpm)\s+(?:install|add|i)\b[^|]*(?:\s-g\b|--global)|\b(?:choco|winget|scoop)\s+(?:install|uninstall|upgrade)\b|\bpip\s+install\b|\bmsiexec\b/u, 'installs or removes software', 'يثبّت برامج أو يزيلها'],
  [/\binvoke-expression\b|\biex\b|\|\s*(?:bash|sh|zsh|powershell|pwsh|cmd)(?:\.exe)?\b|\b(?:irm|iwr|invoke-webrequest|invoke-restmethod|curl|wget)\b[^|]*\|/u, 'runs code downloaded from the network', 'يشغّل كودًا منزّلًا من الشبكة'],
  [/\breg(?:\.exe)?\s+add\b|\b(?:set|new|remove)-itemproperty\b[^|]*\bhk(?:lm|cu|ey_)/u, 'writes to the registry', 'يكتب في سجل النظام'],
  [/\bschtasks\b[^|]*\/create|\bregister-scheduledtask\b|\bnew-service\b|\bset-service\b|\bsc(?:\.exe)?\s+(?:create|config|delete|stop)\b/u, 'changes services or scheduled tasks', 'يغيّر الخدمات أو المهام المجدولة'],
  [/\bnetsh\b|\bnew-netfirewallrule\b|\bset-netfirewall\w*\b|\bdisable-netadapter\b|\bset-dnsclientserveraddress\b/u, 'changes network settings', 'يغيّر إعدادات الشبكة'],
  [/\bstart-process\b[^|]*-verb\s+runas|\bsudo\b|\brunas\b/u, 'asks for administrator rights', 'يطلب صلاحيات المسؤول'],
  [/\bset-executionpolicy\b/u, 'changes the script execution policy', 'يغيّر سياسة تنفيذ السكربتات'],
  [/\bsend-mailmessage\b|\bsmtp\b/u, 'sends email', 'يرسل بريدًا'],
  [/\bmove-item\b[^|]*(?:c:\\windows|program files)|\b(?:copy-item|cp|xcopy|robocopy)\b[^|]*(?:c:\\windows|program files)/u, 'moves or copies system files', 'ينقل أو ينسخ ملفات النظام'],
  [/\bformat-volume\b|\bclear-disk\b|\bremove-partition\b|\binitialize-disk\b/u, 'changes disk volumes', 'يغيّر أقسام الأقراص'],
];

/**
 * Deterministic triage of a command before it runs: forbidden commands never run,
 * dangerous ones wait for the owner's approval, the rest run at once.
 */
export function classifyCommand(command: string): CommandClassification {
  const text = fold(command);
  if (!text) return { level: 'forbidden', reason: 'empty command', reasonAr: 'الأمر فارغ' };
  if (text.length > 4000) return { level: 'forbidden', reason: 'command too long', reasonAr: 'الأمر أطول من المسموح' };
  for (const [pattern, reason, reasonAr] of FORBIDDEN) if (pattern.test(text)) return { level: 'forbidden', reason, reasonAr };
  if (DELETE_VERB.test(text) && DELETE_FORBIDDEN_TARGET.test(text)) return { level: 'forbidden', reason: 'deletes a drive, system folder or the whole user profile', reasonAr: 'يحذف قرصًا أو مجلد نظام أو مجلد المستخدم كله' };
  const redirects = /(?:^|[^>])>(?!>)|>>|\bout-file\b|\bset-content\b|\badd-content\b|\btee-object\b|\btee\b|\bcopy-item\b|\bmove-item\b|\bnew-item\b|\bxcopy\b|\brobocopy\b|\bcopy\b|\bmove\b/u.test(text);
  if (SYSTEM_TARGET.test(text) && (!READ_ONLY_HEAD.test(text) || redirects)) return { level: 'forbidden', reason: 'writes inside Windows or program folders', reasonAr: 'يكتب داخل مجلدات Windows أو البرامج' };
  for (const [pattern, reason, reasonAr] of DANGEROUS) if (pattern.test(text)) return { level: 'dangerous', reason, reasonAr };
  return { level: 'safe', reason: 'no destructive pattern', reasonAr: 'لا يحوي نمطًا خطرًا' };
}

let pwshAvailable: boolean | null = null;

async function detectPwsh(): Promise<boolean> {
  if (pwshAvailable !== null) return pwshAvailable;
  pwshAvailable = await new Promise<boolean>(resolve => {
    try {
      const child = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
      child.on('error', () => resolve(false));
      child.on('exit', code => resolve(code === 0));
      setTimeout(() => { try { child.kill(); } catch { /* already gone */ } resolve(false); }, 8000).unref();
    } catch { resolve(false); }
  });
  return pwshAvailable;
}

/** Windows PowerShell 5.1 or PowerShell 7, whichever is present; 7 is preferred for the owner's commands. */
export async function preferredShell(): Promise<'pwsh' | 'powershell'> {
  return (await detectPwsh()) ? 'pwsh' : 'powershell';
}

const encode = (script: string) => Buffer.from(script, 'utf16le').toString('base64');

/**
 * Runs one command in a fresh PowerShell (or cmd) process with a timeout and an
 * output cap. The process tree is ended on timeout; nothing is retried.
 */
export async function runCommand(command: string, options: RunOptions): Promise<ShellResult> {
  const shell = options.shell ?? await preferredShell();
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 60_000, 1_000), 15 * 60_000);
  const maxOutput = options.maxOutputBytes ?? 64 * 1024;
  const started = Date.now();
  const executable = shell === 'cmd' ? 'cmd.exe' : shell === 'pwsh' ? 'pwsh.exe' : 'powershell.exe';
  const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; ${command}\nif ($LASTEXITCODE -is [int]) { exit $LASTEXITCODE } elseif ($?) { exit 0 } else { exit 1 }`;
  // cmd.exe gets the command verbatim inside one pair of quotes (/s), so inner quotes survive untouched.
  const args = shell === 'cmd' ? ['/d', '/s', '/c', `"${command}"`] : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(script)];
  return new Promise<ShellResult>((resolve, reject) => {
    let stdout = '', stderr = '', truncated = false, timedOut = false, settled = false;
    const child = spawn(executable, args, { cwd: options.cwd, windowsHide: true, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: shell === 'cmd' });
    const take = (current: string, chunk: Buffer) => {
      if (current.length >= maxOutput) { truncated = true; return current; }
      const next = current + chunk.toString('utf8');
      if (next.length > maxOutput) { truncated = true; return next.slice(0, maxOutput); }
      return next;
    };
    child.stdout.on('data', chunk => { stdout = take(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = take(stderr, chunk); });
    const end = () => {
      if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => { timedOut = true; end(); }, timeoutMs);
    const onAbort = () => { timedOut = true; end(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const done = (result: ShellResult) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); resolve(result); };
    child.on('error', error => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
      reject(new DesktopError('DESKTOP_SHELL_UNAVAILABLE', `تعذر تشغيل ${executable}: ${error.message}`, 503));
    });
    child.on('close', code => done({ command, cwd: options.cwd, shell, exitCode: code, stdout, stderr, durationMs: Date.now() - started, timedOut, truncated }));
  });
}

/** Runs a PowerShell snippet that prints JSON and parses it; used for small system queries. */
export async function powerShellJson<T>(script: string, options: Omit<RunOptions, 'shell'>): Promise<T> {
  const result = await runCommand(script, { ...options, shell: 'powershell' });
  if (result.exitCode !== 0 && !result.stdout.trim()) throw new DesktopError('DESKTOP_SHELL_FAILED', (result.stderr || result.stdout || 'PowerShell failed').trim().slice(0, 500), 502);
  const text = result.stdout.trim();
  try { return JSON.parse(text) as T; } catch {
    throw new DesktopError('DESKTOP_SHELL_OUTPUT', `مخرجات PowerShell ليست JSON: ${text.slice(0, 200)}`, 502);
  }
}

/** PowerShell single-quoted literal: the only escape is doubling the quote. */
export const psQuote = (value: string): string => `'${value.replace(/'/gu, "''")}'`;
