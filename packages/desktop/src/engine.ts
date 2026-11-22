import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DesktopApps, KNOWN_APPS, findKnownApp, windowKeysFor } from './apps.ts';
import { DesktopAudit } from './audit.ts';
import { describeDesktopCommand, parseDesktopCommand, type DesktopCommand, type ParsedDesktopCommand } from './commands.ts';
import { DesktopError } from './errors.ts';
import { DesktopFiles } from './files.ts';
import { DesktopInput, DesktopWindows, NativeHost, type Screenshot } from './native.ts';
import { PathPolicy, defaultRoots } from './paths.ts';
import { DesktopProjects, TEMPLATES } from './projects.ts';
import { classifyCommand, runCommand } from './shell.ts';
import { formatBytes, systemInfo } from './system.ts';

export interface DesktopEngineOptions {
  /** Registry, audit, native cache and screenshots live here. */
  dataDir: string;
  roots?: string[];
  projectsRoot?: string;
  screenshotsDir?: string;
  now?: () => Date;
  nativeHost?: NativeHost;
}

export interface DesktopOutcome {
  status: 'completed' | 'partial' | 'blocked' | 'needs_approval';
  text: string;
  /** Present when the owner must say yes before the action runs. */
  approval?: { prompt: string; detail: string; label: string };
  /** Structured data for the panel; the chat shows `text` only. */
  data?: unknown;
  screenshot?: Screenshot & { file: string | null };
}

export interface ExecuteOptions { approved?: boolean; lang?: 'ar' | 'en'; signal?: AbortSignal; cwd?: string }

const code = (value: string) => `\`${value.replace(/`/gu, "'")}\``;
const lines = (items: string[]) => items.join('\n');
/** «المشاريع», «مشاريعي», «projects», «my projects»: the projects folder itself. */
const PROJECTS_WORD = /^(?:(?:ال)?مشاريع(?:ي)?|(?:my\s+)?projects)$/iu;

/**
 * The desktop engine: files, projects, programs, windows, input and the screen on the
 * owner's own Windows session. Every method checks paths against the policy, writes to
 * the audit log, and never deletes permanently.
 */
export class DesktopEngine {
  readonly policy: PathPolicy;
  readonly audit: DesktopAudit;
  readonly files: DesktopFiles;
  readonly projects: DesktopProjects;
  readonly apps: DesktopApps;
  readonly host: NativeHost;
  readonly windows: DesktopWindows;
  readonly input: DesktopInput;
  readonly dataDir: string;
  readonly screenshotsDir: string;

  constructor(options: DesktopEngineOptions) {
    this.dataDir = resolve(options.dataDir);
    const projectsRoot = resolve(options.projectsRoot ?? join(homedir(), 'Mohassan Projects'));
    const roots = [projectsRoot, ...(options.roots ?? defaultRoots())];
    this.policy = new PathPolicy({ roots });
    this.audit = new DesktopAudit(join(this.dataDir, 'audit.jsonl'));
    this.files = new DesktopFiles(this.policy, this.audit);
    this.projects = new DesktopProjects(this.policy, this.audit, { registryFile: join(this.dataDir, 'projects.json'), projectsRoot, now: options.now });
    this.apps = new DesktopApps(this.policy, this.audit);
    this.host = options.nativeHost ?? new NativeHost({ cacheDir: join(this.dataDir, 'native') });
    this.windows = new DesktopWindows(this.host, this.audit);
    this.input = new DesktopInput(this.host, this.audit);
    this.screenshotsDir = resolve(options.screenshotsDir ?? join(homedir(), 'Pictures', 'Mohassan Screenshots'));
  }

  get enabled(): boolean { return true; }

  async status() {
    const projects = await this.projects.list();
    return {
      enabled: true, platform: process.platform, native: this.host.available, dataDir: this.dataDir, projectsRoot: this.projects.projectsRoot, roots: this.policy.roots,
      screenshotsDir: this.screenshotsDir, projects: projects.length, templates: TEMPLATES, apps: KNOWN_APPS.map(({ id, label, labelAr }) => ({ id, label, labelAr })),
      recent: await this.audit.recent(8),
    };
  }

  parse(request: string): ParsedDesktopCommand | null { return parseDesktopCommand(request); }
  describe(command: DesktopCommand, lang: 'ar' | 'en'): string { return describeDesktopCommand(command, lang); }

  /** Saves a capture under the screenshots folder and returns it with the file path. */
  async captureScreen(reference?: string | number | string[] | null, maxWidth = 1600): Promise<Screenshot & { file: string | null }> {
    const shot = await this.windows.screenshot(reference, maxWidth);
    let file: string | null = null;
    try {
      await mkdir(this.screenshotsDir, { recursive: true });
      file = join(this.screenshotsDir, `screenshot-${shot.capturedAt.replace(/[:.]/gu, '-').replace('T', '_').slice(0, 19)}.png`);
      await writeFile(file, Buffer.from(shot.png, 'base64'));
    } catch { file = null; }
    return { ...shot, file };
  }

  /** Runs a shell command the owner typed; forbidden commands never run, dangerous ones need `approved`. */
  async runShell(command: string, options: { cwd?: string | null; approved?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}) {
    const verdict = classifyCommand(command);
    const cwd = options.cwd ? await this.policy.resolve(options.cwd, { mustExist: true, allowRoot: true }) : await this.projects.ensureRoot();
    if (verdict.level === 'forbidden') { await this.audit.record('shell_refused', { command: command.slice(0, 300), reason: verdict.reason }, false); return { verdict, cwd, result: null as Awaited<ReturnType<typeof runCommand>> | null }; }
    if (verdict.level === 'dangerous' && !options.approved) return { verdict, cwd, result: null };
    const result = await runCommand(command, { cwd, timeoutMs: options.timeoutMs ?? 120_000, signal: options.signal });
    await this.audit.record('shell', { command: command.slice(0, 300), cwd, exitCode: result.exitCode, durationMs: result.durationMs, timedOut: result.timedOut, level: verdict.level }, result.exitCode === 0);
    return { verdict, cwd, result };
  }

  /** The chat's single entry: a parsed command becomes an outcome in the owner's language. */
  async execute(command: DesktopCommand, options: ExecuteOptions = {}): Promise<DesktopOutcome> {
    const ar = (options.lang ?? 'ar') === 'ar';
    const base = options.cwd;
    try {
      switch (command.kind) {
        case 'project_create': {
          const template = TEMPLATES.find(item => item.id === (command.template ?? 'web'))!;
          const stamp = (new Date()).toISOString().slice(0, 16).replace('T', ' ').replace(':', '');
          const name = command.name ?? (ar ? `مشروع ${template.labelAr} ${stamp}` : `${template.label} project ${stamp}`);
          const created = await this.projects.create({ name, template: template.id, parent: command.parent ?? undefined, install: command.install, description: command.description ?? undefined });
          let opened = '';
          if (command.open === 'editor') { try { const result = await this.apps.openInEditor(created.path); opened = ar ? `\nفُتح في ${result.editor === 'code' ? 'VS Code' : 'المفكرة'}.` : `\nOpened in ${result.editor === 'code' ? 'VS Code' : 'Notepad'}.`; } catch { opened = ar ? '\nلم أتمكن من فتح المحرر.' : '\nI could not open the editor.'; } }
          else if (command.open === 'folder') { try { await this.apps.open(created.path); opened = ar ? '\nفُتح المجلد في مستكشف الملفات.' : '\nThe folder is open in File Explorer.'; } catch { opened = ''; } }
          const install = created.install === 'ok' ? (ar ? 'ثُبّتت الحزم (npm install).' : 'Packages installed (npm install).') : created.install === 'failed' ? (ar ? `تعذر تثبيت الحزم:\n${created.installOutput}` : `npm install failed:\n${created.installOutput}`) : template.needsInstall ? (ar ? 'لم تُثبّت الحزم بعد؛ شغّل `npm install` داخل المجلد عند الحاجة.' : 'Packages are not installed yet; run `npm install` inside the folder when needed.') : '';
          const text = lines([
            ar ? `أنشأت مشروع **${created.name}** (${template.labelAr}) في ${code(created.display)}.` : `Created project **${created.name}** (${template.label}) at ${code(created.display)}.`,
            ar ? `الملفات: ${created.files.map(code).join('، ')}.` : `Files: ${created.files.map(code).join(', ')}.`,
            created.git ? (ar ? 'بدأت مستودع Git بأول حفظ.' : 'Initialized a Git repository with a first commit.') : (ar ? 'لم يُنشأ مستودع Git.' : 'No Git repository was created.'),
            ...(install ? [install] : []),
            ...(command.name ? [] : [ar ? `لم تذكر اسمًا فاخترت «${created.name}»؛ يمكنك إعادة تسميته.` : `No name was given, so I used “${created.name}”; rename it any time.`]),
          ]) + opened;
          return { status: created.install === 'failed' ? 'partial' : 'completed', text, data: created };
        }
        case 'project_list': {
          const projects = await this.projects.list();
          if (!projects.length) return { status: 'completed', text: ar ? `لا توجد مشاريع مسجلة بعد. مجلد المشاريع: ${code(this.policy.display(this.projects.projectsRoot))}. قل مثلًا: «أنشئ مشروع ويب اسمه متجري».` : `No projects registered yet. Projects folder: ${code(this.policy.display(this.projects.projectsRoot))}. Say, for example: “create a web project called my-shop”.`, data: projects };
          return { status: 'completed', text: lines([ar ? `المشاريع المسجلة (${projects.length}):` : `Registered projects (${projects.length}):`, ...projects.map(project => `- **${project.name}** (${project.template}) — ${code(project.display)}${project.exists ? '' : ar ? ' — المجلد غير موجود الآن' : ' — folder missing'}`)]), data: projects };
        }
        case 'project_open': {
          const project = await this.projects.find(command.name);
          if (!project) return { status: 'blocked', text: ar ? `لا يوجد مشروع مسجل باسم «${command.name}». اطلب «ما مشاريعي» لرؤية القائمة.` : `No registered project is called “${command.name}”. Ask “list my projects” to see them.` };
          if (!project.exists) return { status: 'blocked', text: ar ? `مجلد المشروع «${project.name}» لم يعد موجودًا: ${code(project.display)}.` : `The folder of “${project.name}” no longer exists: ${code(project.display)}.` };
          if (command.target === 'editor') { const result = await this.apps.openInEditor(project.path); return { status: 'completed', text: ar ? `فتحت مشروع **${project.name}** في ${result.editor === 'code' ? 'VS Code' : 'المفكرة'}.` : `Opened **${project.name}** in ${result.editor === 'code' ? 'VS Code' : 'Notepad'}.` }; }
          if (command.target === 'terminal') { const result = await this.apps.openTerminal(project.path); return { status: 'completed', text: ar ? `فتحت طرفية (${result.shell}) داخل مشروع **${project.name}**.` : `Opened a terminal (${result.shell}) inside **${project.name}**.` }; }
          await this.apps.open(project.path);
          return { status: 'completed', text: ar ? `فتحت مجلد مشروع **${project.name}**: ${code(project.display)}.` : `Opened the folder of **${project.name}**: ${code(project.display)}.` };
        }
        case 'file_create': {
          const target = await this.targetPath(command.name, command.folder, base);
          const written = await this.files.write(target, command.content ?? '', { overwrite: false });
          return { status: 'completed', text: ar ? `أنشأت الملف ${code(written.display)}${command.content ? ` وكتبت فيه ${written.bytes} بايت.` : ' (فارغ).'}` : `Created ${code(written.display)}${command.content ? ` with ${written.bytes} bytes.` : ' (empty).'}`, data: written };
        }
        case 'folder_create': {
          const target = await this.targetPath(command.name, command.folder, base);
          const made = await this.files.mkdir(target);
          return { status: 'completed', text: made.created ? (ar ? `أنشأت المجلد ${code(made.display)}.` : `Created the folder ${code(made.display)}.`) : (ar ? `المجلد موجود مسبقًا: ${code(made.display)}.` : `The folder already exists: ${code(made.display)}.`), data: made };
        }
        case 'file_write': {
          const target = await this.targetPath(command.path, command.folder, base);
          const written = await this.files.write(target, command.mode === 'append' ? `${command.content}\n` : command.content, { append: command.mode === 'append', overwrite: command.mode === 'overwrite' });
          return { status: 'completed', text: written.created ? (ar ? `لم يكن الملف موجودًا فأنشأته وكتبت فيه: ${code(written.display)}.` : `The file did not exist, so I created it and wrote the text: ${code(written.display)}.`) : written.appended ? (ar ? `أضفت النص إلى نهاية ${code(written.display)}.` : `Appended the text to ${code(written.display)}.`) : (ar ? `استبدلت محتوى ${code(written.display)}.` : `Replaced the contents of ${code(written.display)}.`), data: written };
        }
        case 'file_read': {
          const target = await this.targetPath(command.path, command.folder, base);
          const content = await this.files.read(target, { maxBytes: 20_000 });
          if (content.binary) return { status: 'partial', text: ar ? `${code(content.display)} ملف ثنائي (${formatBytes(content.size)})، لا يُعرض كنص.` : `${code(content.display)} is a binary file (${formatBytes(content.size)}); it cannot be shown as text.`, data: content };
          const body = content.text.length > 6000 ? `${content.text.slice(0, 6000)}\n…` : content.text;
          return { status: 'completed', text: lines([ar ? `محتوى ${code(content.display)} (${formatBytes(content.size)}${content.truncated || content.text.length > 6000 ? (ar ? '، مقتطع' : ', truncated') : ''}):` : `Contents of ${code(content.display)} (${formatBytes(content.size)}${content.truncated || content.text.length > 6000 ? ', truncated' : ''}):`, '```', body.trim() || (ar ? '(فارغ)' : '(empty)'), '```']), data: content };
        }
        case 'file_list': {
          const listing = await this.files.list(command.path ? await this.folderPath(command.path, base) : base ?? undefined, { base });
          const shown = listing.entries.slice(0, 60);
          return { status: 'completed', text: lines([
            ar ? `محتويات ${code(listing.display)} (${listing.total}):` : `Contents of ${code(listing.display)} (${listing.total}):`,
            ...(shown.length ? shown.map(entry => `- ${entry.kind === 'folder' ? '📁' : '📄'} ${entry.name}${entry.kind === 'file' ? ` (${formatBytes(entry.size)})` : ''}`) : [ar ? '(المجلد فارغ)' : '(the folder is empty)']),
            ...(listing.total > shown.length ? [ar ? `… و${listing.total - shown.length} عناصر أخرى.` : `… and ${listing.total - shown.length} more.`] : []),
          ]), data: listing };
        }
        case 'file_search': {
          const found = await this.files.search(command.root ? await this.folderPath(command.root, base) : undefined, command.pattern, { limit: 30 });
          return { status: 'completed', text: lines([
            found.hits.length ? (ar ? `وجدت ${found.hits.length} نتيجة لـ«${command.pattern}» في ${code(this.policy.display(found.root))}${found.truncated ? ' (القائمة مقتطعة)' : ''}:` : `Found ${found.hits.length} result(s) for “${command.pattern}” in ${code(this.policy.display(found.root))}${found.truncated ? ' (truncated)' : ''}:`) : (ar ? `لم أجد شيئًا باسم «${command.pattern}» في ${code(this.policy.display(found.root))} (فحصت ${found.scanned} عنصرًا).` : `Nothing named “${command.pattern}” in ${code(this.policy.display(found.root))} (scanned ${found.scanned} items).`),
            ...found.hits.map(hit => `- ${hit.kind === 'folder' ? '📁' : '📄'} ${code(hit.display)}`),
          ]), data: found };
        }
        case 'file_delete': {
          const target = await this.targetPath(command.path, command.folder, base);
          const info = await this.files.info(target);
          if (!options.approved) return { status: 'needs_approval', text: ar ? `سأنقل ${info.kind === 'folder' ? 'المجلد' : 'الملف'} ${code(info.display)} إلى سلة المحذوفات. هل أتابع؟` : `I will move the ${info.kind} ${code(info.display)} to the Recycle Bin. Proceed?`, approval: { prompt: ar ? `أريد نقل ${info.kind === 'folder' ? 'المجلد' : 'الملف'} «${info.name}» إلى سلة المحذوفات. هل أتابع؟` : `Move the ${info.kind} “${info.name}” to the Recycle Bin?`, detail: ar ? `${info.display}\nلا حذف نهائي: يمكنك استعادته من سلة المحذوفات.` : `${info.display}\nNothing is deleted permanently; it can be restored from the Recycle Bin.`, label: ar ? `حذف ${info.name}` : `Delete ${info.name}` } };
          const removed = await this.files.recycle(target);
          return { status: 'completed', text: ar ? `نقلت ${removed.kind === 'folder' ? 'المجلد' : 'الملف'} ${code(removed.display)} إلى سلة المحذوفات.` : `Moved the ${removed.kind} ${code(removed.display)} to the Recycle Bin.`, data: removed };
        }
        case 'open': {
          const opened = await this.apps.open(command.target, { base });
          return { status: 'completed', text: opened.kind === 'url' ? (ar ? `فتحت الرابط ${opened.display} في المتصفح الافتراضي.` : `Opened ${opened.display} in the default browser.`) : (ar ? `فتحت ${opened.kind === 'folder' ? 'المجلد' : 'الملف'} ${code(opened.display)}.` : `Opened the ${opened.kind} ${code(opened.display)}.`), data: opened };
        }
        case 'app_launch': {
          const launched = await this.apps.launch(command.name);
          const label = launched.app ? (ar ? launched.app.labelAr : launched.app.label) : launched.target;
          return { status: 'completed', text: ar ? `شغّلت ${label}${launched.pid ? ` (PID ${launched.pid})` : ''}.` : `Launched ${label}${launched.pid ? ` (PID ${launched.pid})` : ''}.`, data: launched };
        }
        case 'shell': {
          const cwd = command.cwd ?? base ?? null;
          const run = await this.runShell(command.command, { cwd, approved: options.approved, signal: options.signal });
          if (run.verdict.level === 'forbidden') return { status: 'blocked', text: ar ? `لن أنفّذ هذا الأمر لأنه ${run.verdict.reasonAr}: ${code(command.command.slice(0, 120))}.` : `I will not run this command because it ${run.verdict.reason}: ${code(command.command.slice(0, 120))}.` };
          if (!run.result) return { status: 'needs_approval', text: ar ? `هذا الأمر ${run.verdict.reasonAr}. هل أنفّذه في ${code(this.policy.display(run.cwd))}؟` : `This command ${run.verdict.reason}. Run it in ${code(this.policy.display(run.cwd))}?`, approval: { prompt: ar ? `أريد تنفيذ أمر ${run.verdict.reasonAr}: «${command.command.slice(0, 80)}». هل أتابع؟` : `Run a command that ${run.verdict.reason}: “${command.command.slice(0, 80)}”?`, detail: `${command.command.slice(0, 400)}\n${ar ? 'المجلد' : 'Folder'}: ${run.cwd}`, label: ar ? 'تنفيذ الأمر' : 'Run command' } };
          const output = `${run.result.stdout}${run.result.stderr ? `\n${run.result.stderr}` : ''}`.trim();
          const shown = output.length > 4000 ? `${output.slice(0, 4000)}\n…` : output;
          const ok = run.result.exitCode === 0 && !run.result.timedOut;
          return { status: ok ? 'completed' : 'partial', text: lines([
            ar ? `نفّذت ${code(command.command.slice(0, 200))} في ${code(this.policy.display(run.cwd))} — ${run.result.timedOut ? 'انتهت المهلة' : `رمز الخروج ${run.result.exitCode}`} خلال ${(run.result.durationMs / 1000).toFixed(1)} ث.` : `Ran ${code(command.command.slice(0, 200))} in ${code(this.policy.display(run.cwd))} — ${run.result.timedOut ? 'timed out' : `exit code ${run.result.exitCode}`} in ${(run.result.durationMs / 1000).toFixed(1)} s.`,
            '```', shown || (ar ? '(لا مخرجات)' : '(no output)'), '```',
          ]), data: run.result };
        }
        case 'window_list': {
          const windows = await this.windows.list();
          return { status: 'completed', text: lines([ar ? `النوافذ المفتوحة (${windows.length}):` : `Open windows (${windows.length}):`, ...windows.slice(0, 40).map(window => `- ${window.foreground ? '▶ ' : ''}**${window.title.slice(0, 80)}** — ${window.processName}${window.minimized ? (ar ? ' (مصغّرة)' : ' (minimized)') : ''}`)]), data: windows };
        }
        case 'window_focus': {
          const { window, result } = await this.windows.focus(windowKeysFor(command.target));
          return { status: result === 'FOCUSED' ? 'completed' : 'partial', text: result === 'FOCUSED' ? (ar ? `انتقلت إلى نافذة **${window.title.slice(0, 80)}**.` : `Switched to **${window.title.slice(0, 80)}**.`) : (ar ? `طلبت إظهار نافذة **${window.title.slice(0, 80)}** لكن Windows لم يمنحها الواجهة (${result}).` : `Asked Windows to bring **${window.title.slice(0, 80)}** forward, but it did not become the foreground window (${result}).`), data: window };
        }
        case 'window_close': {
          const { window } = await this.windows.show(windowKeysFor(command.target), 'close');
          return { status: 'completed', text: ar ? `طلبت إغلاق نافذة **${window.title.slice(0, 80)}** (${window.processName}). إن كان فيها عمل غير محفوظ فسيسألك البرنامج.` : `Asked **${window.title.slice(0, 80)}** (${window.processName}) to close. If it has unsaved work, the program will ask you.`, data: window };
        }
        case 'window_minimize': case 'window_maximize': {
          const mode = command.kind === 'window_minimize' ? 'minimize' : 'maximize';
          const { window } = await this.windows.show(windowKeysFor(command.target), mode);
          return { status: 'completed', text: ar ? `${mode === 'minimize' ? 'صغّرت' : 'كبّرت'} نافذة **${window.title.slice(0, 80)}**.` : `${mode === 'minimize' ? 'Minimized' : 'Maximized'} **${window.title.slice(0, 80)}**.`, data: window };
        }
        case 'screenshot': {
          const shot = await this.captureScreen(command.target ? windowKeysFor(command.target) : null);
          return { status: 'completed', text: ar ? `التقطت لقطة ${shot.window ? `لنافذة **${shot.window.title.slice(0, 80)}**` : 'للشاشة كاملة'} (${shot.width}×${shot.height})${shot.file ? ` وحفظتها في ${code(this.policy.display(shot.file))}` : ''}. تظهر اللقطة في لوحة «سطح المكتب».` : `Captured ${shot.window ? `the window **${shot.window.title.slice(0, 80)}**` : 'the whole screen'} (${shot.width}×${shot.height})${shot.file ? ` and saved it to ${code(this.policy.display(shot.file))}` : ''}. The picture is shown in the Desktop panel.`, screenshot: shot };
        }
        case 'type': {
          if (command.window) await this.windows.focus(windowKeysFor(command.window));
          const typed = await this.input.type(command.text);
          return { status: typed.result === 'APPLIED' ? 'completed' : 'partial', text: ar ? `كتبت ${typed.characters} حرفًا${command.window ? ` في نافذة ${command.window}` : ' في النافذة النشطة'}.` : `Typed ${typed.characters} characters${command.window ? ` into ${command.window}` : ' into the active window'}.` };
        }
        case 'keys': {
          if (command.window) await this.windows.focus(windowKeysFor(command.window));
          const pressed = await this.input.keys(command.combo);
          return { status: pressed.result === 'APPLIED' ? 'completed' : 'partial', text: ar ? `ضغطت ${code(pressed.combo)}.` : `Pressed ${code(pressed.combo)}.` };
        }
        case 'click_element': {
          const scope = await this.windows.elements(command.window ? windowKeysFor(command.window) : null, 200);
          const key = command.name.normalize('NFKC').toLowerCase().trim();
          const matches = scope.elements.filter(element => element.width > 0 && element.height > 0 && !element.password && element.name.normalize('NFKC').toLowerCase().trim() === key);
          const candidates = matches.length ? matches : scope.elements.filter(element => element.width > 0 && element.height > 0 && !element.password && element.name.normalize('NFKC').toLowerCase().includes(key));
          if (!candidates.length) return { status: 'blocked', text: ar ? `لم أجد عنصرًا باسم «${command.name}» في ${scope.window ? `نافذة «${scope.window.title.slice(0, 60)}»` : 'النافذة النشطة'}. العناصر المرئية: ${scope.elements.filter(element => element.name).slice(0, 12).map(element => `«${element.name.slice(0, 30)}»`).join('، ') || 'لا شيء'}.` : `No element called “${command.name}” in ${scope.window ? `“${scope.window.title.slice(0, 60)}”` : 'the active window'}. Visible elements: ${scope.elements.filter(element => element.name).slice(0, 12).map(element => `“${element.name.slice(0, 30)}”`).join(', ') || 'none'}.` };
          if (candidates.length > 1 && matches.length !== 1) return { status: 'blocked', text: ar ? `يوجد ${candidates.length} عناصر تطابق «${command.name}»؛ حدد الاسم كاملًا كما يظهر.` : `${candidates.length} elements match “${command.name}”; give the exact name as shown.` };
          const element = candidates[0]!;
          if (scope.window) await this.windows.focus(scope.window.handle);
          const clicked = await this.input.click(element.x + element.width / 2, element.y + element.height / 2);
          await this.audit.record('click_element', { name: element.name, type: element.type, window: scope.window?.title ?? null });
          return { status: clicked.result === 'APPLIED' ? 'completed' : 'partial', text: ar ? `نقرت على «${element.name}» (${element.type})${scope.window ? ` في نافذة «${scope.window.title.slice(0, 60)}»` : ''}.` : `Clicked “${element.name}” (${element.type})${scope.window ? ` in “${scope.window.title.slice(0, 60)}”` : ''}.` };
        }
        case 'click_point': {
          const clicked = await this.input.click(command.x, command.y);
          return { status: clicked.result === 'APPLIED' ? 'completed' : 'partial', text: ar ? `نقرت عند النقطة (${command.x}, ${command.y}).` : `Clicked at (${command.x}, ${command.y}).` };
        }
        case 'system_info': {
          const info = await systemInfo(this.dataDir);
          return { status: 'completed', text: lines([
            ar ? `**${info.hostname}** — ${info.os} ${info.release} (${info.arch})، المستخدم ${info.user}.` : `**${info.hostname}** — ${info.os} ${info.release} (${info.arch}), user ${info.user}.`,
            ar ? `المعالج: ${info.cpu.model} (${info.cpu.cores} خيطًا).` : `CPU: ${info.cpu.model} (${info.cpu.cores} threads).`,
            ar ? `الذاكرة: ${formatBytes(info.memory.freeBytes)} حرة من ${formatBytes(info.memory.totalBytes)}.` : `Memory: ${formatBytes(info.memory.freeBytes)} free of ${formatBytes(info.memory.totalBytes)}.`,
            ...info.disks.map(disk => ar ? `القرص ${disk.drive} ${disk.label ? `(${disk.label}) ` : ''}: ${formatBytes(disk.freeBytes)} حرة من ${formatBytes(disk.totalBytes)}.` : `Disk ${disk.drive} ${disk.label ? `(${disk.label}) ` : ''}: ${formatBytes(disk.freeBytes)} free of ${formatBytes(disk.totalBytes)}.`),
            ...(info.gpus.length ? [ar ? `بطاقة الرسوم: ${info.gpus.join('، ')}.` : `GPU: ${info.gpus.join(', ')}.`] : []),
            ...(info.battery ? [ar ? `البطارية: ${info.battery.percent}%${info.battery.charging === true ? ' (تشحن)' : info.battery.charging === false ? ' (على البطارية)' : ''}.` : `Battery: ${info.battery.percent}%${info.battery.charging === true ? ' (charging)' : info.battery.charging === false ? ' (on battery)' : ''}.`] : []),
            ar ? `مدة التشغيل: ${Math.floor(info.uptimeSeconds / 3600)} س ${Math.floor((info.uptimeSeconds % 3600) / 60)} د.` : `Uptime: ${Math.floor(info.uptimeSeconds / 3600)} h ${Math.floor((info.uptimeSeconds % 3600) / 60)} min.`,
          ]), data: info };
        }
        case 'clipboard_read': {
          const text = await this.input.clipboardGet();
          return { status: 'completed', text: text ? lines([ar ? `محتوى الحافظة (${text.length} حرفًا):` : `Clipboard (${text.length} characters):`, '```', text.slice(0, 3000), '```']) : (ar ? 'الحافظة لا تحتوي نصًا الآن.' : 'The clipboard holds no text right now.') };
        }
        case 'clipboard_write': {
          await this.input.clipboardSet(command.text);
          return { status: 'completed', text: ar ? `نسخت ${command.text.length} حرفًا إلى الحافظة.` : `Copied ${command.text.length} characters to the clipboard.` };
        }
      }
    } catch (error) {
      if (error instanceof DesktopError) {
        await this.audit.record('error', { kind: command.kind, code: error.code, message: error.message }, false);
        return { status: 'blocked', text: ar ? error.message : `${error.code}: ${error.message}` };
      }
      throw error;
    }
  }

  /** A folder word from the owner: «المشاريع» is the projects folder, a project name is its path, anything else is a path. */
  private async folderPath(folder: string, base?: string): Promise<string> {
    if (PROJECTS_WORD.test(folder.trim())) return this.projects.ensureRoot();
    const project = await this.projects.find(folder);
    return this.policy.resolve(project ? project.path : folder, { base, allowRoot: true });
  }

  /** «ملف X في Y»: a name inside a folder word, a path, or the primary root. */
  private async targetPath(name: string, folder: string | null, base?: string): Promise<string> {
    const cleaned = name.trim();
    if (!cleaned) throw new DesktopError('DESKTOP_PATH_REQUIRED', 'يلزم اسم الملف أو المجلد.');
    if (folder) return this.policy.resolve(join(await this.folderPath(folder, base), cleaned));
    return this.policy.resolve(cleaned, { base: base ?? (await this.projects.ensureRoot()) });
  }

  async dispose(): Promise<void> { await this.host.dispose(); }
}

export const knownAppFor = findKnownApp;
