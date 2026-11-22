import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { DesktopAudit } from './audit.ts';
import { DesktopError } from './errors.ts';
import type { PathPolicy } from './paths.ts';
import { runCommand } from './shell.ts';

export type TemplateId = 'empty' | 'web' | 'node' | 'python' | 'react' | 'docs';
export interface TemplateInfo { id: TemplateId; label: string; labelAr: string; description: string; descriptionAr: string; needsInstall: boolean; aliases: string[] }
export interface ProjectRecord { id: string; name: string; path: string; template: TemplateId; createdAt: string; git: boolean }
export interface ProjectView extends ProjectRecord { exists: boolean; display: string }
export interface CreateProjectInput { name: string; template?: TemplateId; parent?: string; git?: boolean; install?: boolean; description?: string }
export interface CreateProjectResult extends ProjectView { files: string[]; install: 'skipped' | 'ok' | 'failed'; installOutput: string; mainFile: string }

export const TEMPLATES: TemplateInfo[] = [
  { id: 'web', label: 'Website (HTML/CSS/JS)', labelAr: 'موقع ويب (HTML/CSS/JS)', description: 'A static page with styles and a script; opens in the browser.', descriptionAr: 'صفحة ثابتة مع تنسيق وسكربت، تُفتح في المتصفح مباشرة.', needsInstall: false, aliases: ['web', 'website', 'html', 'static', 'site', 'ويب', 'موقع', 'صفحة', 'صفحه', 'اتش تي ام ال'] },
  { id: 'node', label: 'Node.js', labelAr: 'Node.js', description: 'ES modules, a start script and a node:test test; no dependencies.', descriptionAr: 'وحدات ES، وأمر تشغيل، واختبار node:test، دون اعتماديات.', needsInstall: false, aliases: ['node', 'nodejs', 'node.js', 'javascript', 'js', 'نود', 'جافاسكربت', 'جافا سكربت', 'نود جي اس'] },
  { id: 'python', label: 'Python', labelAr: 'Python', description: 'main.py with a unittest file and requirements.txt.', descriptionAr: 'main.py مع ملف اختبار unittest وملف requirements.txt.', needsInstall: false, aliases: ['python', 'py', 'بايثون', 'بيثون', 'بايتون'] },
  { id: 'react', label: 'React (Vite)', labelAr: 'React (Vite)', description: 'Vite + React app; npm install runs when you ask for it.', descriptionAr: 'تطبيق Vite + React؛ يُشغَّل npm install عند طلبك.', needsInstall: true, aliases: ['react', 'vite', 'رياكت', 'ريأكت', 'ري اكت'] },
  { id: 'docs', label: 'Notes & documents', labelAr: 'ملاحظات ومستندات', description: 'Markdown notes with a daily log and a template.', descriptionAr: 'ملاحظات Markdown مع سجل يومي وقالب.', needsInstall: false, aliases: ['docs', 'notes', 'markdown', 'md', 'ملاحظات', 'مستندات', 'توثيق', 'وثائق'] },
  { id: 'empty', label: 'Empty folder', labelAr: 'مجلد فارغ', description: 'README and .gitignore only.', descriptionAr: 'ملف README و.gitignore فقط.', needsInstall: false, aliases: ['empty', 'blank', 'plain', 'فارغ', 'فاضي', 'عادي'] },
];

const fold = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[ـً-ٰٟ]/gu, '').replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ة/gu, 'ه').replace(/\s+/gu, ' ').trim();

export function findTemplate(word: string | undefined): TemplateInfo | null {
  if (!word) return null;
  const key = fold(word).replace(/^(?:مشروع|project)\s+/u, '');
  return TEMPLATES.find(template => template.id === key || template.aliases.some(alias => fold(alias) === key)) ?? null;
}

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
export function folderNameFor(name: string): string {
  const cleaned = name.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/gu, ' ').replace(/\s+/gu, ' ').trim().replace(/[. ]+$/u, '').slice(0, 80);
  if (!cleaned || RESERVED.test(cleaned)) throw new DesktopError('DESKTOP_PROJECT_NAME', 'اسم المشروع غير صالح كاسم مجلد.');
  return cleaned;
}
export function slugFor(name: string): string {
  const slug = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 50);
  return slug && /^[a-z]/u.test(slug) ? slug : `mohassan-project-${Date.now().toString(36)}`;
}

interface TemplateContext { name: string; slug: string; description: string; date: string; template: TemplateInfo }
type Files = Record<string, string>;

const readme = (context: TemplateContext, howToRun: string[]): string => [
  `# ${context.name}`, '', context.description || `مشروع ${context.template.labelAr} أنشأه موحسن في ${context.date}.`, '',
  '## التشغيل / Run', '', ...howToRun.map(line => `- ${line}`), '',
  `_Created by Mohassan on ${context.date} (template: ${context.template.id})._`, '',
].join('\n');

const templateFiles: Record<TemplateId, (context: TemplateContext) => Files> = {
  empty: context => ({ 'README.md': readme(context, ['ابدأ بإضافة ملفاتك هنا.']), '.gitignore': 'node_modules/\n.env\n*.log\n' }),
  web: context => ({
    'index.html': `<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>${context.name}</title>\n  <link rel="stylesheet" href="styles.css" />\n</head>\n<body>\n  <main class="page">\n    <h1>${context.name}</h1>\n    <p>${context.description || 'صفحة جديدة أنشأها موحسن. عدّل هذا النص من index.html.'}</p>\n    <button id="hello" type="button">جرّب الزر</button>\n    <p id="output" aria-live="polite"></p>\n  </main>\n  <script src="app.js"></script>\n</body>\n</html>\n`,
    'styles.css': `:root { --ink: #172d2b; --green: #196b56; --surface: #f7f8f5; font-family: "Segoe UI", Tahoma, sans-serif; }\nbody { margin: 0; background: var(--surface); color: var(--ink); }\n.page { max-width: 720px; margin: 10vh auto; padding: 32px; background: #fff; border-radius: 16px; box-shadow: 0 10px 30px #0001; }\nh1 { margin-top: 0; }\nbutton { background: var(--green); color: #fff; border: 0; border-radius: 8px; padding: 10px 18px; font-size: 15px; cursor: pointer; }\nbutton:hover { filter: brightness(1.08); }\n`,
    'app.js': `const button = document.getElementById('hello');\nconst output = document.getElementById('output');\nlet clicks = 0;\nbutton.addEventListener('click', () => {\n  clicks += 1;\n  output.textContent = \`ضغطت الزر \${clicks} مرة\`;\n});\n`,
    'README.md': readme(context, ['افتح `index.html` في المتصفح، أو شغّل `npx serve .` من المجلد.']),
    '.gitignore': 'node_modules/\n.DS_Store\nThumbs.db\n',
  }),
  node: context => ({
    'package.json': `${JSON.stringify({ name: context.slug, version: '0.1.0', private: true, type: 'module', description: context.description || undefined, scripts: { start: 'node src/index.js', test: 'node --test' } }, null, 2)}\n`,
    'src/index.js': `import { greet } from './greet.js';\n\nconsole.log(greet('${context.name}'));\n`,
    'src/greet.js': `/** Returns a greeting; edit this to start your project. */\nexport function greet(name) {\n  return \`مرحبًا من \${name}!\`;\n}\n`,
    'test/greet.test.js': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/greet.js';\n\ntest('greets by name', () => {\n  assert.equal(greet('موحسن'), 'مرحبًا من موحسن!');\n});\n`,
    'README.md': readme(context, ['`npm start` لتشغيل البرنامج', '`npm test` لتشغيل الاختبارات (node:test، دون اعتماديات)']),
    '.gitignore': 'node_modules/\n.env\n*.log\ncoverage/\n',
  }),
  python: context => ({
    'main.py': `"""${context.name}\n\n${context.description || 'مشروع Python أنشأه موحسن.'}\n"""\n\n\ndef greet(name: str) -> str:\n    return f"مرحبًا من {name}!"\n\n\nif __name__ == "__main__":\n    print(greet("${context.name}"))\n`,
    'test_main.py': `import unittest\n\nfrom main import greet\n\n\nclass GreetTests(unittest.TestCase):\n    def test_greet(self) -> None:\n        self.assertEqual(greet("موحسن"), "مرحبًا من موحسن!")\n\n\nif __name__ == "__main__":\n    unittest.main()\n`,
    'requirements.txt': '',
    'README.md': readme(context, ['`python main.py` للتشغيل', '`python -m unittest` للاختبارات', '`python -m venv .venv` ثم `.venv\\Scripts\\activate` لبيئة معزولة']),
    '.gitignore': '.venv/\n__pycache__/\n*.pyc\n.env\n',
  }),
  react: context => ({
    'package.json': `${JSON.stringify({ name: context.slug, version: '0.1.0', private: true, type: 'module', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' }, dependencies: { react: '^19.2.0', 'react-dom': '^19.2.0' }, devDependencies: { '@vitejs/plugin-react': '^5.1.0', vite: '^7.2.0' } }, null, 2)}\n`,
    'index.html': `<!doctype html>\n<html lang="ar" dir="rtl">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n    <title>${context.name}</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n`,
    'vite.config.js': `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n`,
    'src/main.jsx': `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\nimport './App.css';\n\ncreateRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);\n`,
    'src/App.jsx': `import { useState } from 'react';\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return (\n    <main className="page">\n      <h1>${context.name}</h1>\n      <p>${context.description || 'تطبيق React أنشأه موحسن. عدّل src/App.jsx للبدء.'}</p>\n      <button onClick={() => setCount(value => value + 1)}>العدّاد: {count}</button>\n    </main>\n  );\n}\n`,
    'src/App.css': `body { margin: 0; font-family: "Segoe UI", Tahoma, sans-serif; background: #f7f8f5; color: #172d2b; }\n.page { max-width: 720px; margin: 10vh auto; padding: 32px; background: #fff; border-radius: 16px; box-shadow: 0 10px 30px #0001; }\nbutton { background: #196b56; color: #fff; border: 0; border-radius: 8px; padding: 10px 18px; font-size: 15px; cursor: pointer; }\n`,
    'README.md': readme(context, ['`npm install` مرة واحدة', '`npm run dev` ثم افتح الرابط الذي يطبعه Vite']),
    '.gitignore': 'node_modules/\ndist/\n.env\n*.log\n',
  }),
  docs: context => ({
    'README.md': readme(context, ['اكتب ملاحظاتك في `notes/`، وسجل كل يوم في ملف باسم تاريخه.']),
    [`notes/${context.date}.md`]: `# ${context.date}\n\n- \n`,
    'notes/TEMPLATE.md': '# العنوان\n\n## الهدف\n\n## النقاط\n\n- \n\n## الخطوة التالية\n\n',
    '.gitignore': '.DS_Store\nThumbs.db\n',
  }),
};

const MAIN_FILE: Record<TemplateId, string> = { empty: 'README.md', web: 'index.html', node: 'src/index.js', python: 'main.py', react: 'src/App.jsx', docs: 'README.md' };

let gitAvailable: boolean | null = null;

export class DesktopProjects {
  private writing: Promise<unknown> = Promise.resolve();
  constructor(private readonly policy: PathPolicy, private readonly audit: DesktopAudit, private readonly options: { registryFile: string; projectsRoot: string; now?: () => Date }) {}

  get projectsRoot(): string { return this.options.projectsRoot; }
  templates(): TemplateInfo[] { return TEMPLATES; }

  async ensureRoot(): Promise<string> {
    await mkdir(this.options.projectsRoot, { recursive: true });
    return this.options.projectsRoot;
  }

  private async readRegistry(): Promise<ProjectRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.options.registryFile, 'utf8')) as { projects?: ProjectRecord[] };
      return Array.isArray(parsed.projects) ? parsed.projects : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async writeRegistry(mutate: (projects: ProjectRecord[]) => ProjectRecord[]): Promise<ProjectRecord[]> {
    const run = this.writing.then(async () => {
      const current = await this.readRegistry();
      const next = mutate(current);
      await mkdir(dirname(this.options.registryFile), { recursive: true });
      await writeFile(this.options.registryFile, `${JSON.stringify({ version: 1, projects: next }, null, 2)}\n`, 'utf8');
      return next;
    });
    this.writing = run.catch(() => undefined);
    return run;
  }

  async list(): Promise<ProjectView[]> {
    const projects = await this.readRegistry();
    const views: ProjectView[] = [];
    for (const project of projects) {
      let exists = false;
      try { exists = (await stat(project.path)).isDirectory(); } catch { exists = false; }
      views.push({ ...project, exists, display: this.policy.display(project.path) });
    }
    return views.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async find(nameOrPath: string): Promise<ProjectView | null> {
    const key = fold(nameOrPath);
    const projects = await this.list();
    return projects.find(project => fold(project.name) === key || fold(basename(project.path)) === key || fold(project.path) === key) ?? null;
  }

  async forget(id: string): Promise<boolean> {
    let removed = false;
    await this.writeRegistry(projects => { const next = projects.filter(project => project.id !== id); removed = next.length !== projects.length; return next; });
    if (removed) await this.audit.record('project_forget', { id });
    return removed;
  }

  /** Registers a folder that already exists so the panel and the chat know it by name. */
  async adopt(path: string, name?: string): Promise<ProjectView> {
    const target = await this.policy.resolve(path, { mustExist: true });
    const info = await stat(target);
    if (!info.isDirectory()) throw new DesktopError('DESKTOP_NOT_A_FOLDER', 'المسار ليس مجلدًا.');
    const existing = (await this.readRegistry()).find(project => fold(project.path) === fold(target));
    if (existing) return { ...existing, exists: true, display: this.policy.display(target) };
    let git = false;
    try { git = (await stat(join(target, '.git'))).isDirectory(); } catch { git = false; }
    const record: ProjectRecord = { id: randomUUID(), name: (name ?? basename(target)).trim().slice(0, 100) || basename(target), path: target, template: 'empty', createdAt: (this.options.now?.() ?? new Date()).toISOString(), git };
    await this.writeRegistry(projects => [...projects, record]);
    await this.audit.record('project_adopt', { path: target, name: record.name });
    return { ...record, exists: true, display: this.policy.display(target) };
  }

  async create(input: CreateProjectInput): Promise<CreateProjectResult> {
    const template = TEMPLATES.find(item => item.id === (input.template ?? 'web'));
    if (!template) throw new DesktopError('DESKTOP_TEMPLATE_UNKNOWN', `قالب غير معروف: ${String(input.template)}`);
    const name = String(input.name ?? '').trim().slice(0, 100);
    if (name.length < 1) throw new DesktopError('DESKTOP_PROJECT_NAME', 'يلزم اسم للمشروع.');
    const folder = folderNameFor(name);
    const parent = input.parent ? await this.policy.resolve(input.parent, { allowRoot: true }) : await this.ensureRoot();
    await mkdir(parent, { recursive: true });
    const path = await this.policy.resolve(join(parent, folder));
    try {
      const info = await stat(path);
      if (!info.isDirectory()) throw new DesktopError('DESKTOP_PROJECT_EXISTS', `يوجد ملف بهذا الاسم: ${this.policy.display(path)}`, 409);
      if ((await readdir(path)).length) throw new DesktopError('DESKTOP_PROJECT_EXISTS', `المجلد موجود وغير فارغ: ${this.policy.display(path)}. اختر اسمًا آخر أو اطلب فتحه.`, 409);
    } catch (error) {
      if (error instanceof DesktopError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const now = this.options.now?.() ?? new Date();
    const context: TemplateContext = { name, slug: slugFor(name), description: (input.description ?? '').trim().slice(0, 500), date: now.toISOString().slice(0, 10), template };
    const files = templateFiles[template.id](context);
    files['.mohassan/project.json'] = `${JSON.stringify({ name, template: template.id, createdAt: now.toISOString(), createdBy: 'Mohassan' }, null, 2)}\n`;
    await mkdir(path, { recursive: true });
    for (const [relativePath, content] of Object.entries(files)) {
      const target = join(path, ...relativePath.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }
    let git = false;
    if (input.git !== false) git = await this.initGit(path);
    let install: CreateProjectResult['install'] = 'skipped', installOutput = '';
    if (input.install && template.needsInstall) {
      const result = await runCommand('npm install --no-fund --no-audit', { cwd: path, timeoutMs: 5 * 60_000, shell: 'cmd' });
      install = result.exitCode === 0 && !result.timedOut ? 'ok' : 'failed';
      installOutput = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/u).slice(-12).join('\n');
    }
    const record: ProjectRecord = { id: randomUUID(), name, path, template: template.id, createdAt: now.toISOString(), git };
    await this.writeRegistry(projects => [...projects.filter(project => fold(project.path) !== fold(path)), record]);
    await this.audit.record('project_create', { name, path, template: template.id, git, install, files: Object.keys(files).length });
    return { ...record, exists: true, display: this.policy.display(path), files: Object.keys(files).sort(), install, installOutput, mainFile: MAIN_FILE[template.id] };
  }

  private async initGit(path: string): Promise<boolean> {
    if (gitAvailable === null) {
      try { const probe = await runCommand('git --version', { cwd: path, timeoutMs: 15_000, shell: 'cmd' }); gitAvailable = probe.exitCode === 0; } catch { gitAvailable = false; }
    }
    if (!gitAvailable) return false;
    const steps = ['git init -q', 'git add -A', 'git -c user.name="Mohassan" -c user.email="mohassan@localhost" commit -q -m "chore: initial project created by Mohassan"'];
    for (const step of steps) {
      const result = await runCommand(step, { cwd: path, timeoutMs: 60_000, shell: 'cmd' });
      if (result.exitCode !== 0) return false;
    }
    return true;
  }
}
