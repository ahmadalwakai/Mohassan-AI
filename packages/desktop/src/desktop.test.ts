import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DesktopAudit } from './audit.ts';
import { parseDesktopCommand, describeDesktopCommand, folderReference } from './commands.ts';
import { DesktopEngine } from './engine.ts';
import { DesktopError } from './errors.ts';
import { DesktopFiles, nameMatcher } from './files.ts';
import { normalizeCombo } from './native.ts';
import { PathPolicy, knownFolders } from './paths.ts';
import { DesktopProjects, findTemplate, folderNameFor, slugFor } from './projects.ts';
import { classifyCommand } from './shell.ts';
import { findKnownApp, knownFolderPath } from './apps.ts';

const command = (text: string) => parseDesktopCommand(text)?.command ?? null;
/** A temp folder in its real spelling: Windows reports 8.3 short names for TEMP, the engine stores real paths. */
const tempRoot = async (prefix: string) => realpathSync.native(await mkdtemp(join(tmpdir(), prefix)));
const WINDOWS = process.platform === 'win32';
const NATIVE = WINDOWS && process.env.DESKTOP_NATIVE_TESTS !== '0';

describe('parseDesktopCommand: projects', () => {
  it('reads Arabic project requests with template, name, folder and options', () => {
    expect(command('أنشئ مشروع ويب اسمه متجري')).toEqual({ kind: 'project_create', name: 'متجري', template: 'web', parent: null, install: false, open: null, description: null });
    expect(command('انشئ لي مشروع react جديد باسم لوحة التحكم في المستندات وافتحه في vs code')).toEqual({ kind: 'project_create', name: 'لوحة التحكم', template: 'react', parent: knownFolders().documents, install: false, open: 'editor', description: null });
    expect(command('اعمل مشروع بايثون اسمه الفواتير وثبت الحزم')).toMatchObject({ kind: 'project_create', name: 'الفواتير', template: 'python', install: true });
    expect(command('أنشئ مشروع node')).toMatchObject({ kind: 'project_create', name: null, template: 'node' });
    expect(command('سوي مشروع جديد اسمه تجربة')).toMatchObject({ kind: 'project_create', name: 'تجربة', template: null });
  });
  it('reads English project requests', () => {
    expect(command('create a new python project called invoices')).toMatchObject({ kind: 'project_create', name: 'invoices', template: 'python' });
    expect(command('Create a web project named my-shop in Documents')).toMatchObject({ kind: 'project_create', name: 'my-shop', template: 'web', parent: knownFolders().documents });
    expect(command('make a node project and open it')).toMatchObject({ kind: 'project_create', template: 'node', open: 'folder' });
    expect(command('create project landing page')).toMatchObject({ kind: 'project_create', name: 'landing page', template: null });
  });
  it('lists and opens projects', () => {
    expect(command('ما مشاريعي؟')).toEqual({ kind: 'project_list' });
    expect(command('اعرض المشاريع عندي')).toEqual({ kind: 'project_list' });
    expect(command('list my projects')).toEqual({ kind: 'project_list' });
    expect(command('افتح مشروع متجري في vs code')).toEqual({ kind: 'project_open', name: 'متجري', target: 'editor' });
    expect(command('افتح مشروع متجري في الطرفية')).toEqual({ kind: 'project_open', name: 'متجري', target: 'terminal' });
    expect(command('open project my-shop')).toEqual({ kind: 'project_open', name: 'my-shop', target: 'folder' });
  });
});

describe('parseDesktopCommand: files and folders', () => {
  it('creates files with content and location', () => {
    expect(command('أنشئ ملف ملاحظات.txt في سطح المكتب بمحتوى: مرحبا موحسن')).toEqual({ kind: 'file_create', name: 'ملاحظات.txt', folder: knownFolders().desktop, content: 'مرحبا موحسن' });
    expect(command('أنشئ ملف اسمه todo.md واكتب فيه «- شراء الحليب»')).toEqual({ kind: 'file_create', name: 'todo.md', folder: null, content: '- شراء الحليب' });
    expect(command('create a file notes.txt in Documents containing hello world')).toEqual({ kind: 'file_create', name: 'notes.txt', folder: knownFolders().documents, content: 'hello world' });
    expect(command('create file empty.txt')).toEqual({ kind: 'file_create', name: 'empty.txt', folder: null, content: null });
    expect(command('أنشئ ملف config.json في مشروع متجري:\n{\n  "a": 1\n}')).toEqual({ kind: 'file_create', name: 'config.json', folder: 'متجري', content: '{\n  "a": 1\n}' });
    expect(command('أنشئ ملف notes.txt في C:\\Temp\\demo')).toEqual({ kind: 'file_create', name: 'notes.txt', folder: 'C:\\Temp\\demo', content: null });
  });
  it('creates folders, writes, reads, lists, searches and deletes', () => {
    expect(command('أنشئ مجلد صور العمل في المستندات')).toEqual({ kind: 'folder_create', name: 'صور العمل', folder: knownFolders().documents });
    expect(command('create folder reports in Downloads')).toEqual({ kind: 'folder_create', name: 'reports', folder: knownFolders().downloads });
    expect(command('اكتب سطر جديد في ملف todo.md')).toEqual({ kind: 'file_write', path: 'todo.md', folder: null, content: 'سطر جديد', mode: 'append' });
    expect(command('أضف "عنصر ثالث" إلى ملف todo.md في سطح المكتب')).toEqual({ kind: 'file_write', path: 'todo.md', folder: knownFolders().desktop, content: 'عنصر ثالث', mode: 'append' });
    expect(command('append done to the file todo.md')).toMatchObject({ kind: 'file_write', path: 'todo.md', content: 'done', mode: 'append' });
    expect(command('اقرأ ملف todo.md')).toEqual({ kind: 'file_read', path: 'todo.md', folder: null });
    expect(command('ما محتوى ملف notes.txt في سطح المكتب؟')).toEqual({ kind: 'file_read', path: 'notes.txt', folder: knownFolders().desktop });
    expect(command('read the file README.md in Documents')).toEqual({ kind: 'file_read', path: 'README.md', folder: knownFolders().documents });
    expect(command('اعرض الملفات في سطح المكتب')).toEqual({ kind: 'file_list', path: knownFolders().desktop });
    expect(command('ما الملفات الموجودة في التنزيلات؟')).toEqual({ kind: 'file_list', path: knownFolders().downloads });
    expect(command('list files in Downloads')).toEqual({ kind: 'file_list', path: knownFolders().downloads });
    expect(command('اعرض الملفات')).toEqual({ kind: 'file_list', path: null });
    expect(command('ابحث عن ملف التقرير في المستندات')).toEqual({ kind: 'file_search', pattern: 'التقرير', root: knownFolders().documents });
    expect(command('find the file budget.xlsx')).toEqual({ kind: 'file_search', pattern: 'budget.xlsx', root: null });
    expect(command('احذف ملف old.txt من سطح المكتب')).toEqual({ kind: 'file_delete', path: 'old.txt', folder: knownFolders().desktop, what: 'file' });
    expect(command('delete the folder temp in Downloads')).toEqual({ kind: 'file_delete', path: 'temp', folder: knownFolders().downloads, what: 'folder' });
  });
});

describe('parseDesktopCommand: programs, windows, input, system', () => {
  it('opens programs, folders and paths but leaves websites alone', () => {
    expect(command('افتح المفكرة')).toEqual({ kind: 'app_launch', name: 'notepad' });
    expect(command('شغّل الحاسبة')).toEqual({ kind: 'app_launch', name: 'calculator' });
    expect(command('open vs code')).toEqual({ kind: 'app_launch', name: 'code' });
    expect(command('افتح سطح المكتب')).toEqual({ kind: 'open', target: knownFolders().desktop });
    expect(command('افتح مجلد C:\\Temp\\demo')).toEqual({ kind: 'open', target: 'C:\\Temp\\demo' });
    expect(command('open the folder Downloads')).toEqual({ kind: 'open', target: knownFolders().downloads });
    expect(command('افتح يوتيوب')).toBeNull();
    expect(command('open youtube')).toBeNull();
    expect(command('افتح حسابي في البنك')).toBeNull();
  });
  it('runs commands only when the owner says they are commands', () => {
    expect(command('نفّذ الأمر: npm test')).toEqual({ kind: 'shell', command: 'npm test', cwd: null });
    expect(command('شغل الأمر `git status` في مجلد متجري')).toEqual({ kind: 'shell', command: 'git status', cwd: 'متجري' });
    expect(command('في مشروع متجري نفذ الأمر npm run build')).toEqual({ kind: 'shell', command: 'npm run build', cwd: 'متجري' });
    expect(command('run the command: dir')).toEqual({ kind: 'shell', command: 'dir', cwd: null });
    expect(command('terminal: node -v')).toEqual({ kind: 'shell', command: 'node -v', cwd: null });
    expect(command('npm test')).toBeNull();
  });
  it('reads window requests', () => {
    expect(command('ما النوافذ المفتوحة؟')).toEqual({ kind: 'window_list' });
    expect(command('اعرض البرامج الشغالة الآن')).toEqual({ kind: 'window_list' });
    expect(command('what windows are open')).toEqual({ kind: 'window_list' });
    expect(command('انتقل إلى نافذة المفكرة')).toEqual({ kind: 'window_focus', target: 'المفكرة' });
    expect(command('روح على كروم')).toEqual({ kind: 'window_focus', target: 'كروم' });
    expect(command('switch to chrome')).toEqual({ kind: 'window_focus', target: 'chrome' });
    expect(command('أغلق نافذة الحاسبة')).toEqual({ kind: 'window_close', target: 'الحاسبة' });
    expect(command('close notepad')).toEqual({ kind: 'window_close', target: 'notepad' });
    expect(command('صغّر نافذة كروم')).toEqual({ kind: 'window_minimize', target: 'كروم' });
    expect(command('maximize the window Untitled - Notepad')).toEqual({ kind: 'window_maximize', target: 'Untitled - Notepad' });
    expect(command('أغلق الباب')).toBeNull();
  });
  it('reads screenshots, typing, keys and clicks with an explicit PC context only', () => {
    expect(command('خذ لقطة شاشة')).toEqual({ kind: 'screenshot', target: null });
    expect(command('لقطة للشاشة')).toEqual({ kind: 'screenshot', target: null });
    expect(command('صور لي نافذة المفكرة')).toEqual({ kind: 'screenshot', target: 'المفكرة' });
    expect(command('take a screenshot of the window Calculator')).toEqual({ kind: 'screenshot', target: 'Calculator' });
    expect(command('اكتب مرحبا في المفكرة')).toEqual({ kind: 'type', text: 'مرحبا', window: 'المفكرة' });
    expect(command('اكتب «السلام عليكم» في النافذة الحالية')).toEqual({ kind: 'type', text: 'السلام عليكم', window: null });
    expect(command('type hello world in the current window')).toEqual({ kind: 'type', text: 'hello world', window: null });
    expect(command('اكتب رسالة اعتذار')).toBeNull();
    expect(command('اكتب لندن في خانة المدينة')).toBeNull();
    expect(command('اضغط ctrl+s')).toEqual({ kind: 'keys', combo: 'ctrl+s', window: null });
    expect(command('اضغط كنترول + شيفت + s في المفكرة')).toEqual({ kind: 'keys', combo: 'ctrl+shift+s', window: 'المفكرة' });
    expect(command('press enter on the keyboard')).toEqual({ kind: 'keys', combo: 'enter', window: null });
    expect(command('اضغط إنتر')).toBeNull();
    expect(command('اضغط على «تسجيل»')).toBeNull();
    expect(command('اضغط زر حفظ في المفكرة')).toEqual({ kind: 'click_element', name: 'حفظ', window: 'المفكرة' });
    expect(command('click the button Save in notepad')).toEqual({ kind: 'click_element', name: 'Save', window: 'notepad' });
    expect(command('انقر على (640, 480)')).toEqual({ kind: 'click_point', x: 640, y: 480 });
  });
  it('reads system and clipboard requests', () => {
    expect(command('ما مواصفات جهازي؟')).toEqual({ kind: 'system_info' });
    expect(command('كم الذاكرة الحرة عندي؟')).toEqual({ kind: 'system_info' });
    expect(command('system info')).toEqual({ kind: 'system_info' });
    expect(command('how much free disk space do I have?')).toEqual({ kind: 'system_info' });
    expect(command('ما في الحافظة؟')).toEqual({ kind: 'clipboard_read' });
    expect(command('انسخ "نص تجريبي" إلى الحافظة')).toEqual({ kind: 'clipboard_write', text: 'نص تجريبي' });
    expect(command("what's in the clipboard")).toEqual({ kind: 'clipboard_read' });
  });
  it('leaves questions, web searches, memory and arithmetic alone', () => {
    for (const text of ['ما عاصمة اليابان؟', 'ابحث عن مطاعم في لندن', 'كم 15 ضرب 23؟', 'تذكر أن اسمي أحمد', 'ما هي أخبار اليوم', 'search for winter tyres on amazon', 'اقرأ الصفحة', 'افتح النتيجة الثانية', 'ترجم هذا النص', 'hello', 'شكرا']) {
      expect(parseDesktopCommand(text), text).toBeNull();
    }
  });
  it('describes commands and folders', () => {
    expect(describeDesktopCommand({ kind: 'project_create', name: 'متجري', template: 'web', parent: null, install: false, open: null, description: null }, 'ar')).toBe('إنشاء مشروع متجري');
    expect(folderReference('مجلد التنزيلات')).toBe(knownFolders().downloads);
    expect(folderReference('Desktop')).toBe(knownFolders().desktop);
    expect(folderReference('my-shop')).toBe('my-shop');
    expect(knownFolderPath('سطح المكتب')).toBe(knownFolders().desktop);
    expect(findKnownApp('برنامج المفكرة')?.id).toBe('notepad');
    expect(findKnownApp('غير موجود')).toBeNull();
    expect(normalizeCombo('كنترول + شيفت + S')).toBe('ctrl+shift+s');
    expect(normalizeCombo('Ctrl+Alt+Delete')).toBe('ctrl+alt+delete');
  });
});

describe('classifyCommand', () => {
  it('refuses destructive system commands', () => {
    for (const text of ['format D:', 'diskpart', 'Remove-Item C:\\ -Recurse -Force', 'rm -rf /', 'del /s /q C:\\Windows\\System32', 'reg delete HKLM\\Software\\X /f', 'Set-MpPreference -DisableRealtimeMonitoring $true', 'netsh advfirewall set allprofiles state off', 'net user hacker pass /add', 'Remove-Item $HOME -Recurse', 'echo hi > C:\\Windows\\test.txt']) {
      expect(classifyCommand(text).level, text).toBe('forbidden');
    }
  });
  it('asks before dangerous commands and runs ordinary ones', () => {
    for (const text of ['Remove-Item .\\dist -Recurse', 'del old.txt', 'git push origin main', 'git reset --hard', 'shutdown /s /t 0', 'taskkill /IM notepad.exe', 'npm install -g typescript', 'irm https://x.test/install.ps1 | iex', 'reg add HKCU\\Software\\X', 'Start-Process notepad -Verb RunAs']) {
      expect(classifyCommand(text).level, text).toBe('dangerous');
    }
    for (const text of ['npm test', 'git status', 'dir', 'Get-ChildItem C:\\Windows\\System32 | Select -First 3', 'node -v', 'python main.py', 'npm install', 'echo hello', 'Get-Process | Sort CPU -Descending | Select -First 5']) {
      expect(classifyCommand(text).level, text).toBe('safe');
    }
  });
});

describe('PathPolicy and files', () => {
  let root: string, policy: PathPolicy, files: DesktopFiles;
  beforeAll(async () => {
    root = await tempRoot('mohassan-desktop-');
    policy = new PathPolicy({ roots: [root] });
    files = new DesktopFiles(policy, new DesktopAudit(join(root, '.audit', 'audit.jsonl')));
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it('keeps every path inside the roots and away from secrets', async () => {
    expect(await policy.resolve('notes.txt')).toBe(join(root, 'notes.txt'));
    expect(await policy.resolve(join(root, 'a', 'b.txt'))).toBe(join(root, 'a', 'b.txt'));
    await expect(policy.resolve(join(root, '..', 'outside.txt'))).rejects.toMatchObject({ code: 'DESKTOP_PATH_OUTSIDE' });
    await expect(policy.resolve(WINDOWS ? 'C:\\Windows\\win.ini' : '/etc/passwd')).rejects.toMatchObject({ code: 'DESKTOP_PATH_OUTSIDE' });
    await expect(policy.resolve(join(root, '.env'))).rejects.toMatchObject({ code: 'DESKTOP_PATH_OUTSIDE' });
    await expect(policy.resolve(join(root, 'repo', '.git', 'config'))).rejects.toMatchObject({ code: 'DESKTOP_PATH_OUTSIDE' });
    await expect(policy.resolve('')).rejects.toBeInstanceOf(DesktopError);
    expect(policy.display(join(root, 'x'))).toContain('x');
  });

  it('writes, reads, lists, appends, searches and refuses silent overwrites', async () => {
    const written = await files.write('docs/todo.md', '- one\n');
    expect(written.created).toBe(true);
    await expect(files.write('docs/todo.md', 'again')).rejects.toMatchObject({ code: 'DESKTOP_FILE_EXISTS' });
    const appended = await files.write('docs/todo.md', '- two\n', { append: true });
    expect(appended.appended).toBe(true);
    expect((await files.read('docs/todo.md')).text).toBe('- one\n- two\n');
    await files.mkdir('docs/images');
    const listing = await files.list('docs');
    expect(listing.entries.map(entry => `${entry.kind}:${entry.name}`)).toEqual(['folder:images', 'file:todo.md']);
    const found = await files.search(undefined, 'todo*');
    expect(found.hits.map(hit => hit.path)).toEqual([join(root, 'docs', 'todo.md')]);
    await writeFile(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
    expect((await files.read('bin.dat')).binary).toBe(true);
    await files.move('docs/todo.md', 'docs/done.md');
    await expect(stat(join(root, 'docs', 'done.md'))).resolves.toBeTruthy();
    expect(nameMatcher('*.md')('a.md')).toBe(true);
    expect(nameMatcher('report')('My Report.docx')).toBe(true);
  });

  it.skipIf(!WINDOWS)('sends a file to the Recycle Bin instead of deleting it', async () => {
    await files.write('trash-me.txt', 'bye');
    const removed = await files.recycle('trash-me.txt');
    expect(removed.kind).toBe('file');
    await expect(stat(join(root, 'trash-me.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);
});

describe('DesktopProjects', () => {
  let root: string, projects: DesktopProjects;
  beforeAll(async () => {
    root = await tempRoot('mohassan-projects-');
    const policy = new PathPolicy({ roots: [root] });
    projects = new DesktopProjects(policy, new DesktopAudit(join(root, '.audit', 'audit.jsonl')), { registryFile: join(root, '.registry', 'projects.json'), projectsRoot: join(root, 'Projects'), now: () => new Date('2026-11-22T10:00:00Z') });
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  it('maps template words and names', () => {
    expect(findTemplate('ويب')?.id).toBe('web');
    expect(findTemplate('بايثون')?.id).toBe('python');
    expect(findTemplate('React')?.id).toBe('react');
    expect(findTemplate('unknown')).toBeNull();
    expect(folderNameFor(' متجري: نسخة 2 ')).toBe('متجري  نسخة 2'.replace(/\s+/gu, ' '));
    expect(() => folderNameFor('con')).toThrow(DesktopError);
    expect(slugFor('My Shop!')).toBe('my-shop');
    expect(slugFor('متجري')).toMatch(/^mohassan-project-/u);
  });

  it('scaffolds a node project with git and registers it', async () => {
    const created = await projects.create({ name: 'متجري', template: 'node' });
    expect(created.path).toBe(join(root, 'Projects', 'متجري'));
    expect(created.files).toEqual(['.gitignore', '.mohassan/project.json', 'README.md', 'package.json', 'src/greet.js', 'src/index.js', 'test/greet.test.js']);
    expect(JSON.parse(await readFile(join(created.path, 'package.json'), 'utf8')).scripts.test).toBe('node --test');
    expect(created.git).toBe(true);
    const listed = await projects.list();
    expect(listed.map(project => project.name)).toEqual(['متجري']);
    expect((await projects.find('متجري'))?.path).toBe(created.path);
    await expect(projects.create({ name: 'متجري', template: 'web' })).rejects.toMatchObject({ code: 'DESKTOP_PROJECT_EXISTS' });
    const web = await projects.create({ name: 'Landing', template: 'web', git: false, parent: join(root, 'Elsewhere') });
    expect(web.path).toBe(join(root, 'Elsewhere', 'Landing'));
    expect(web.git).toBe(false);
    expect((await readFile(join(web.path, 'index.html'), 'utf8'))).toContain('<title>Landing</title>');
    expect(await projects.forget(web.id)).toBe(true);
    expect((await projects.list()).length).toBe(1);
  }, 60_000);
});

describe('DesktopEngine', () => {
  let root: string, engine: DesktopEngine;
  beforeAll(async () => {
    root = await tempRoot('mohassan-engine-');
    engine = new DesktopEngine({ dataDir: join(root, 'data'), roots: [root], projectsRoot: join(root, 'Projects'), screenshotsDir: join(root, 'shots') });
  });
  afterAll(async () => { await engine.dispose(); await rm(root, { recursive: true, force: true }); });

  it('executes file and project commands from plain sentences', async () => {
    const created = await engine.execute(command('أنشئ مشروع ويب اسمه تجربة')!, { lang: 'ar' });
    expect(created.status).toBe('completed');
    expect(created.text).toContain('أنشأت مشروع **تجربة**');
    const file = await engine.execute(command('أنشئ ملف notes.txt في مشروع تجربة بمحتوى: سطر أول')!, { lang: 'ar' });
    expect(file.status).toBe('completed');
    expect(await readFile(join(root, 'Projects', 'تجربة', 'notes.txt'), 'utf8')).toBe('سطر أول');
    const appended = await engine.execute(command('أضف سطر ثانٍ إلى ملف notes.txt في مشروع تجربة')!, { lang: 'ar' });
    expect(appended.text).toContain('أضفت النص');
    const read = await engine.execute(command('اقرأ ملف notes.txt في مشروع تجربة')!, { lang: 'ar' });
    expect(read.text).toContain('سطر أول\nسطر ثانٍ');
    const listed = await engine.execute(command('ما مشاريعي')!, { lang: 'ar' });
    expect(listed.text).toContain('**تجربة**');
    const search = await engine.execute(command('ابحث عن ملف notes')!, { lang: 'ar' });
    expect(search.text).toContain('notes.txt');
    // «مجلد المشاريع» and a project name both resolve to real folders, not to a folder literally named so.
    const inProjects = await engine.execute(command('ابحث عن ملف index.html في مجلد المشاريع')!, { lang: 'ar' });
    expect(inProjects.text).toContain('index.html');
    const listed2 = await engine.execute(command('اعرض الملفات في مشروع تجربة')!, { lang: 'ar' });
    expect(listed2.text).toContain('index.html');
    const projectsListing = await engine.execute(command('list files in my projects')!, { lang: 'en' });
    expect(projectsListing.text).toContain('تجربة');
    const missing = await engine.execute(command('اقرأ ملف غير-موجود.txt')!, { lang: 'ar' });
    expect(missing.status).toBe('blocked');
  }, 60_000);

  it('asks before deleting and before dangerous commands, and refuses forbidden ones', async () => {
    await engine.files.write('old.txt', 'x');
    const ask = await engine.execute(command('احذف ملف old.txt')!, { lang: 'ar' });
    expect(ask.status).toBe('needs_approval');
    expect(ask.approval?.prompt).toContain('سلة المحذوفات');
    const forbidden = await engine.execute(command('نفذ الأمر: format C:')!, { lang: 'ar' });
    expect(forbidden.status).toBe('blocked');
    expect(forbidden.text).toContain('لن أنفّذ');
    const dangerous = await engine.execute(command('نفذ الأمر: git push --force')!, { lang: 'ar' });
    expect(dangerous.status).toBe('needs_approval');
  });

  it.skipIf(!WINDOWS)('runs a safe shell command in the projects folder', async () => {
    const run = await engine.execute(command('نفذ الأمر: echo مرحبا')!, { lang: 'ar' });
    expect(run.status).toBe('completed');
    expect(run.text).toContain('مرحبا');
    expect(run.text).toContain('رمز الخروج 0');
  }, 60_000);

  it.skipIf(!NATIVE)('lists windows and captures the screen through the native host', async () => {
    const windows = await engine.execute(command('ما النوافذ المفتوحة')!, { lang: 'ar' });
    expect(windows.status).toBe('completed');
    expect(windows.text).toContain('النوافذ المفتوحة');
    const shot = await engine.execute(command('خذ لقطة شاشة')!, { lang: 'ar' });
    expect(shot.status).toBe('completed');
    expect(shot.screenshot?.png.slice(0, 8)).toBe('iVBORw0K');
    expect(shot.screenshot?.width).toBeGreaterThan(100);
    expect(shot.screenshot?.file).toBeTruthy();
    const info = await engine.execute(command('ما مواصفات جهازي')!, { lang: 'ar' });
    expect(info.text).toContain('المعالج');
  }, 120_000);
});
