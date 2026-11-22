import { dirname } from 'node:path';
import type { DesktopAudit } from './audit.ts';
import { DesktopError } from './errors.ts';
import { knownFolders, type PathPolicy } from './paths.ts';
import { psQuote, runCommand } from './shell.ts';

export interface KnownApp { id: string; label: string; labelAr: string; target: string; kind: 'exe' | 'uri' | 'command'; aliases: string[]; /** Process names and title words that identify the program's windows. */ match: string[] }

/** Programs the owner names in plain words; the target is what Start-Process receives. */
export const KNOWN_APPS: KnownApp[] = [
  { id: 'notepad', label: 'Notepad', labelAr: 'المفكرة', target: 'notepad.exe', kind: 'exe', aliases: ['notepad', 'المفكرة', 'مفكرة', 'المفكره', 'نوت باد', 'نوتباد'], match: ['notepad', 'المفكرة'] },
  { id: 'calculator', label: 'Calculator', labelAr: 'الحاسبة', target: 'calc.exe', kind: 'exe', aliases: ['calc', 'calculator', 'الحاسبة', 'الحاسبه', 'الآلة الحاسبة', 'الالة الحاسبة', 'الاله الحاسبه'], match: ['calculatorapp', 'calculator', 'calc', 'الحاسبة', 'الآلة الحاسبة'] },
  { id: 'explorer', label: 'File Explorer', labelAr: 'مستكشف الملفات', target: 'explorer.exe', kind: 'exe', aliases: ['explorer', 'file explorer', 'files', 'مستكشف الملفات', 'الملفات', 'اكسبلورر', 'إكسبلورر'], match: ['explorer', 'file explorer', 'مستكشف الملفات'] },
  { id: 'paint', label: 'Paint', labelAr: 'الرسام', target: 'mspaint.exe', kind: 'exe', aliases: ['paint', 'mspaint', 'الرسام', 'بينت'], match: ['mspaint', 'paint', 'الرسام'] },
  { id: 'cmd', label: 'Command Prompt', labelAr: 'موجه الأوامر', target: 'cmd.exe', kind: 'exe', aliases: ['cmd', 'command prompt', 'موجه الأوامر', 'موجه الاوامر', 'سي ام دي'], match: ['cmd', 'command prompt', 'موجه الأوامر'] },
  { id: 'powershell', label: 'PowerShell', labelAr: 'PowerShell', target: 'powershell.exe', kind: 'exe', aliases: ['powershell', 'باورشيل', 'بوورشيل', 'بور شيل'], match: ['powershell'] },
  { id: 'pwsh', label: 'PowerShell 7', labelAr: 'PowerShell 7', target: 'pwsh.exe', kind: 'exe', aliases: ['pwsh', 'powershell 7'], match: ['pwsh'] },
  { id: 'terminal', label: 'Windows Terminal', labelAr: 'الطرفية', target: 'wt.exe', kind: 'exe', aliases: ['terminal', 'windows terminal', 'الطرفية', 'الطرفيه', 'التيرمينال', 'ترمنال', 'تيرمينال'], match: ['windowsterminal', 'terminal'] },
  { id: 'code', label: 'Visual Studio Code', labelAr: 'VS Code', target: 'code', kind: 'command', aliases: ['code', 'vs code', 'vscode', 'visual studio code', 'فيجوال ستوديو كود', 'في اس كود', 'كود'], match: ['code', 'visual studio code'] },
  { id: 'chrome', label: 'Google Chrome', labelAr: 'كروم', target: 'chrome.exe', kind: 'exe', aliases: ['chrome', 'google chrome', 'كروم', 'جوجل كروم', 'غوغل كروم'], match: ['chrome'] },
  { id: 'edge', label: 'Microsoft Edge', labelAr: 'إيدج', target: 'msedge.exe', kind: 'exe', aliases: ['edge', 'microsoft edge', 'إيدج', 'ايدج', 'المتصفح', 'متصفح'], match: ['msedge', 'edge'] },
  { id: 'firefox', label: 'Firefox', labelAr: 'فايرفوكس', target: 'firefox.exe', kind: 'exe', aliases: ['firefox', 'فايرفوكس'], match: ['firefox'] },
  { id: 'word', label: 'Word', labelAr: 'وورد', target: 'winword.exe', kind: 'exe', aliases: ['word', 'ms word', 'microsoft word', 'وورد', 'ورد'], match: ['winword', 'word'] },
  { id: 'excel', label: 'Excel', labelAr: 'إكسل', target: 'excel.exe', kind: 'exe', aliases: ['excel', 'إكسل', 'اكسل', 'اكسيل'], match: ['excel'] },
  { id: 'powerpoint', label: 'PowerPoint', labelAr: 'بوربوينت', target: 'powerpnt.exe', kind: 'exe', aliases: ['powerpoint', 'power point', 'بوربوينت', 'باوربوينت'], match: ['powerpnt', 'powerpoint'] },
  { id: 'outlook', label: 'Outlook', labelAr: 'آوتلوك', target: 'outlook.exe', kind: 'exe', aliases: ['outlook', 'اوتلوك', 'آوتلوك'], match: ['outlook'] },
  { id: 'settings', label: 'Settings', labelAr: 'الإعدادات', target: 'ms-settings:', kind: 'uri', aliases: ['settings', 'windows settings', 'الإعدادات', 'الاعدادات', 'اعدادات', 'إعدادات'], match: ['systemsettings', 'settings', 'الإعدادات'] },
  { id: 'taskmgr', label: 'Task Manager', labelAr: 'مدير المهام', target: 'taskmgr.exe', kind: 'exe', aliases: ['task manager', 'taskmgr', 'مدير المهام'], match: ['taskmgr', 'task manager', 'مدير المهام'] },
  { id: 'control', label: 'Control Panel', labelAr: 'لوحة التحكم', target: 'control.exe', kind: 'exe', aliases: ['control panel', 'لوحة التحكم', 'لوحه التحكم'], match: ['control panel', 'لوحة التحكم'] },
  { id: 'snip', label: 'Snipping Tool', labelAr: 'أداة القص', target: 'ms-screenclip:', kind: 'uri', aliases: ['snipping tool', 'snip', 'أداة القص', 'اداة القص'], match: ['snippingtool', 'snipping tool'] },
  { id: 'camera', label: 'Camera', labelAr: 'الكاميرا', target: 'microsoft.windows.camera:', kind: 'uri', aliases: ['camera', 'الكاميرا'], match: ['windowscamera', 'camera'] },
  { id: 'store', label: 'Microsoft Store', labelAr: 'المتجر', target: 'ms-windows-store:', kind: 'uri', aliases: ['store', 'microsoft store', 'المتجر'], match: ['winstore', 'microsoft store'] },
  { id: 'wordpad', label: 'WordPad', labelAr: 'وورد باد', target: 'write.exe', kind: 'exe', aliases: ['wordpad', 'وورد باد'], match: ['wordpad'] },
];

/** The words that find a program's window: the known app's process names, or the owner's own word. */
export const windowKeysFor = (reference: string): string[] => findKnownApp(reference)?.match ?? [reference];

const fold = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[ـً-ٰٟ]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').replace(/\s+/gu, ' ').trim();

export function findKnownApp(name: string): KnownApp | null {
  const key = fold(name).replace(/^(?:برنامج|تطبيق|the|app)\s+/u, '').replace(/\.exe$/u, '');
  if (!key) return null;
  for (const app of KNOWN_APPS) if (app.aliases.some(alias => fold(alias) === key)) return app;
  return null;
}

/** Folder words the owner uses instead of paths. */
export function knownFolderPath(name: string): string | null {
  const key = fold(name).replace(/^(?:مجلد|folder)\s+/u, '').replace(/^(?:ال)/u, '');
  const folders = knownFolders();
  const table: Record<string, string> = {
    'سطح المكتب': folders.desktop!, 'سطح مكتب': folders.desktop!, desktop: folders.desktop!,
    'مستندات': folders.documents!, 'المستندات': folders.documents!, documents: folders.documents!, 'my documents': folders.documents!,
    'تنزيلات': folders.downloads!, 'التنزيلات': folders.downloads!, 'تحميلات': folders.downloads!, 'التحميلات': folders.downloads!, downloads: folders.downloads!,
    'صور': folders.pictures!, 'الصور': folders.pictures!, pictures: folders.pictures!,
    'فيديو': folders.videos!, 'فيديوهات': folders.videos!, 'الفيديوهات': folders.videos!, videos: folders.videos!,
    'موسيقى': folders.music!, 'الموسيقى': folders.music!, music: folders.music!,
    'المنزل': folders.home!, home: folders.home!, 'مجلد المستخدم': folders.home!,
  };
  return table[key] ?? table[`ال${key}`] ?? null;
}

const URL_LIKE = /^(?:https?:\/\/|mailto:|ms-settings:|ms-screenclip:|ms-windows-store:|microsoft\.windows\.camera:)/iu;

export class DesktopApps {
  constructor(private readonly policy: PathPolicy, private readonly audit: DesktopAudit) {}

  /** Opens a file or folder with its default program, or a URL in the default browser. */
  async open(target: string, options: { base?: string } = {}): Promise<{ target: string; display: string; kind: 'file' | 'folder' | 'url' }> {
    if (URL_LIKE.test(target.trim())) {
      const url = target.trim();
      if (!/^(?:https?:\/\/|mailto:)/iu.test(url)) throw new DesktopError('DESKTOP_URL_SCHEME', 'يُفتح فقط رابط http أو https أو mailto.');
      await this.start(url, [], undefined);
      await this.audit.record('open_url', { url });
      return { target: url, display: url, kind: 'url' };
    }
    const path = await this.policy.resolve(target, { base: options.base, mustExist: true, allowRoot: true });
    const info = await this.policy.isInsideRoots(path);
    void info;
    const { stat } = await import('node:fs/promises');
    const details = await stat(path);
    const kind = details.isDirectory() ? 'folder' : 'file';
    if (kind === 'folder') await this.start('explorer.exe', [path], undefined);
    else await this.start(path, [], dirname(path));
    await this.audit.record('open_path', { path, kind });
    return { target: path, display: this.policy.display(path), kind };
  }

  /** Shows the item selected inside File Explorer. */
  async reveal(target: string, options: { base?: string } = {}): Promise<{ path: string; display: string }> {
    const path = await this.policy.resolve(target, { base: options.base, mustExist: true, allowRoot: true });
    await this.start('explorer.exe', [`/select,"${path}"`], undefined, true);
    await this.audit.record('reveal', { path });
    return { path, display: this.policy.display(path) };
  }

  async launch(name: string, args: string[] = []): Promise<{ app: KnownApp | null; target: string; pid: number | null }> {
    const known = findKnownApp(name);
    if (!known) {
      // A plain executable name on PATH, nothing else: paths are opened through open().
      if (!/^[a-z0-9_.-]{1,64}$/iu.test(name.trim())) throw new DesktopError('DESKTOP_APP_UNKNOWN', `لا أعرف برنامجًا باسم «${name.slice(0, 60)}». اذكر اسمه كما يظهر في قائمة ابدأ، أو مساره الكامل.`, 404);
      const pid = await this.start(name.trim(), args, undefined);
      await this.audit.record('launch', { app: name.trim(), args });
      return { app: null, target: name.trim(), pid };
    }
    const pid = await this.start(known.target, args, undefined, known.kind === 'command');
    await this.audit.record('launch', { app: known.id, args });
    return { app: known, target: known.target, pid };
  }

  async openInEditor(path: string): Promise<{ path: string; editor: 'code' | 'notepad' }> {
    const target = await this.policy.resolve(path, { mustExist: true, allowRoot: true });
    const probe = await runCommand('if (Get-Command code -ErrorAction SilentlyContinue) { "yes" } else { "no" }', { cwd: dirname(target), shell: 'powershell', timeoutMs: 15_000 });
    const editor = probe.stdout.includes('yes') ? 'code' : 'notepad';
    if (editor === 'code') await this.start('code', [target], dirname(target), true);
    else await this.start('notepad.exe', [target], dirname(target));
    await this.audit.record('open_editor', { path: target, editor });
    return { path: target, editor };
  }

  async openTerminal(cwd: string): Promise<{ cwd: string; shell: string }> {
    const target = await this.policy.resolve(cwd, { mustExist: true, allowRoot: true });
    const probe = await runCommand('if (Get-Command wt.exe -ErrorAction SilentlyContinue) { "wt" } elseif (Get-Command pwsh.exe -ErrorAction SilentlyContinue) { "pwsh" } else { "powershell" }', { cwd: target, shell: 'powershell', timeoutMs: 15_000 });
    const shell = probe.stdout.trim().split(/\r?\n/u).pop() ?? 'powershell';
    if (shell === 'wt') await this.start('wt.exe', ['-d', target], target);
    else await runCommand(`Start-Process -FilePath ${psQuote(shell === 'pwsh' ? 'pwsh.exe' : 'powershell.exe')} -WorkingDirectory ${psQuote(target)}`, { cwd: target, shell: 'powershell', timeoutMs: 15_000 });
    await this.audit.record('open_terminal', { cwd: target, shell });
    return { cwd: target, shell };
  }

  /** Start-Process without waiting; returns the new process id when Windows reports one. */
  private async start(target: string, args: string[], cwd: string | undefined, viaCmd = false): Promise<number | null> {
    const list = args.length ? ` -ArgumentList @(${args.map(arg => psQuote(arg)).join(',')})` : '';
    const directory = cwd ? ` -WorkingDirectory ${psQuote(cwd)}` : '';
    const script = viaCmd
      ? `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d','/c',${psQuote(`${target} ${args.map(arg => `"${arg}"`).join(' ')}`.trim())})${directory} -WindowStyle Hidden -PassThru; if ($p) { $p.Id }`
      : `$p = Start-Process -FilePath ${psQuote(target)}${list}${directory} -PassThru; if ($p) { $p.Id }`;
    const result = await runCommand(script, { cwd: cwd ?? this.policy.primaryRoot, shell: 'powershell', timeoutMs: 30_000 });
    if (result.exitCode !== 0 || /Start-Process\s*:/u.test(result.stderr)) {
      const message = (result.stderr || result.stdout).trim().split(/\r?\n/u)[0] ?? '';
      throw new DesktopError('DESKTOP_LAUNCH_FAILED', `تعذر تشغيل «${target}»: ${message.slice(0, 200) || 'لم يُعثر على البرنامج'}`, 502);
    }
    const pid = Number(result.stdout.trim().split(/\r?\n/u).pop());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
}
