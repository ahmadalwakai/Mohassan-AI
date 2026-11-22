import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { DesktopEngine } from '@mohassan/desktop';

/**
 * The desktop panel's API: projects, files, programs, windows, input and the screen on
 * the owner's own computer. Owner-only by the default member gate; every write goes
 * through the engine's path policy and audit log.
 */
export interface DesktopRouteContext {
  owner(request: { headers: Record<string, unknown> }): Promise<{ id: string }>;
  engine: DesktopEngine | null;
}

const Path = z.string().trim().min(1).max(1024);
const CreateProject = z.object({ name: z.string().trim().min(1).max(100), template: z.enum(['empty', 'web', 'node', 'python', 'react', 'docs']).default('web'), parent: Path.optional(), git: z.boolean().default(true), install: z.boolean().default(false), description: z.string().trim().max(500).optional(), open: z.enum(['none', 'folder', 'editor']).default('none') }).strict();
const AdoptProject = z.object({ path: Path, name: z.string().trim().min(1).max(100).optional() }).strict();
const OpenProject = z.object({ target: z.enum(['folder', 'editor', 'terminal']).default('folder') }).strict();
const ListQuery = z.object({ path: Path.optional(), hidden: z.enum(['true', 'false']).optional() }).strict();
const ContentQuery = z.object({ path: Path }).strict();
const SearchQuery = z.object({ pattern: z.string().trim().min(1).max(200), root: Path.optional() }).strict();
const FileOperation = z.discriminatedUnion('op', [
  z.object({ op: z.literal('write'), path: Path, content: z.string().max(2 * 1024 * 1024), overwrite: z.boolean().default(false), append: z.boolean().default(false) }).strict(),
  z.object({ op: z.literal('mkdir'), path: Path }).strict(),
  z.object({ op: z.literal('move'), from: Path, to: Path, overwrite: z.boolean().default(false) }).strict(),
  z.object({ op: z.literal('copy'), from: Path, to: Path }).strict(),
  z.object({ op: z.literal('recycle'), path: Path }).strict(),
]);
const OpenRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('path'), target: Path }).strict(),
  z.object({ kind: z.literal('url'), target: z.string().url().max(2048) }).strict(),
  z.object({ kind: z.literal('app'), name: z.string().trim().min(1).max(80) }).strict(),
  z.object({ kind: z.literal('reveal'), target: Path }).strict(),
  z.object({ kind: z.literal('editor'), target: Path }).strict(),
  z.object({ kind: z.literal('terminal'), target: Path }).strict(),
]);
const ShellRequest = z.object({ command: z.string().trim().min(1).max(4000), cwd: Path.optional(), approved: z.boolean().default(false), timeoutMs: z.number().int().min(1000).max(15 * 60_000).optional() }).strict();
const WindowAction = z.object({ handle: z.number().int().positive().optional(), target: z.string().trim().min(1).max(200).optional(), action: z.enum(['focus', 'close', 'minimize', 'maximize', 'restore']) }).strict().refine(value => value.handle !== undefined || value.target !== undefined, { message: 'handle or target is required' });
const ScreenshotQuery = z.object({ window: z.string().trim().min(1).max(200).optional(), maxWidth: z.coerce.number().int().min(200).max(4000).optional(), save: z.enum(['true', 'false']).optional() }).strict();
const InputRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('type'), text: z.string().min(1).max(4000), window: z.string().trim().max(200).optional() }).strict(),
  z.object({ kind: z.literal('keys'), combo: z.string().trim().min(1).max(80), window: z.string().trim().max(200).optional() }).strict(),
  z.object({ kind: z.literal('click'), x: z.number().int().min(-20000).max(20000), y: z.number().int().min(-20000).max(20000), button: z.enum(['left', 'right', 'middle']).default('left'), double: z.boolean().default(false) }).strict(),
  z.object({ kind: z.literal('scroll'), delta: z.number().int().min(-20).max(20) }).strict(),
  z.object({ kind: z.literal('clipboard_set'), text: z.string().max(100_000) }).strict(),
]);
const CommandRequest = z.object({ text: z.string().trim().min(1).max(6000), approved: z.boolean().default(false), lang: z.enum(['ar', 'en']).optional() }).strict();
const AuditQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }).strict();

export async function registerDesktopRoutes(app: FastifyInstance, { owner, engine }: DesktopRouteContext) {
  const required = (): DesktopEngine => {
    if (!engine) throw Object.assign(new Error('محرك سطح المكتب يعمل على جهاز المالك فقط؛ هذا الخادم لا يشغّله.'), { statusCode: 503, code: 'DESKTOP_DISABLED' });
    return engine;
  };
  const limited = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  app.get('/api/desktop', async request => {
    await owner(request);
    return engine ? engine.status() : { enabled: false, platform: process.platform, native: false, projects: 0, templates: [], apps: [], recent: [] };
  });

  app.get('/api/desktop/projects', async request => {
    await owner(request);
    const desktop = required();
    return { projects: await desktop.projects.list(), templates: desktop.projects.templates(), root: desktop.projects.projectsRoot };
  });
  app.post('/api/desktop/projects', limited(20), async request => {
    await owner(request);
    const desktop = required();
    const input = CreateProject.parse(request.body ?? {});
    const created = await desktop.projects.create({ name: input.name, template: input.template, parent: input.parent, git: input.git, install: input.install, description: input.description });
    let opened: 'none' | 'folder' | 'editor' = 'none';
    if (input.open === 'editor') { try { await desktop.apps.openInEditor(created.path); opened = 'editor'; } catch { opened = 'none'; } }
    else if (input.open === 'folder') { try { await desktop.apps.open(created.path); opened = 'folder'; } catch { opened = 'none'; } }
    return { ...created, opened };
  });
  app.post('/api/desktop/projects/adopt', limited(20), async request => {
    await owner(request);
    const input = AdoptProject.parse(request.body ?? {});
    return required().projects.adopt(input.path, input.name);
  });
  app.post<{ Params: { id: string } }>('/api/desktop/projects/:id/forget', limited(30), async request => {
    await owner(request);
    return { removed: await required().projects.forget(z.uuid().parse(request.params.id)) };
  });
  app.post<{ Params: { id: string } }>('/api/desktop/projects/:id/open', limited(30), async request => {
    await owner(request);
    const desktop = required();
    const input = OpenProject.parse(request.body ?? {});
    const project = (await desktop.projects.list()).find(item => item.id === z.uuid().parse(request.params.id));
    if (!project) throw Object.assign(new Error('لم يُعثر على المشروع.'), { statusCode: 404, code: 'DESKTOP_PROJECT_NOT_FOUND' });
    if (input.target === 'editor') return { project, ...(await desktop.apps.openInEditor(project.path)) };
    if (input.target === 'terminal') return { project, ...(await desktop.apps.openTerminal(project.path)) };
    return { project, ...(await desktop.apps.open(project.path)) };
  });

  app.get('/api/desktop/files', async request => {
    await owner(request);
    const query = ListQuery.parse(request.query ?? {});
    return required().files.list(query.path, { showHidden: query.hidden === 'true' });
  });
  app.get('/api/desktop/files/content', async request => {
    await owner(request);
    const query = ContentQuery.parse(request.query ?? {});
    return required().files.read(query.path);
  });
  app.get('/api/desktop/files/search', async request => {
    await owner(request);
    const query = SearchQuery.parse(request.query ?? {});
    return required().files.search(query.root, query.pattern, { limit: 100 });
  });
  app.post('/api/desktop/files', { bodyLimit: 2_300_000, ...limited(60) }, async request => {
    await owner(request);
    const desktop = required();
    const input = FileOperation.parse(request.body ?? {});
    switch (input.op) {
      case 'write': return desktop.files.write(input.path, input.content, { overwrite: input.overwrite, append: input.append });
      case 'mkdir': return desktop.files.mkdir(input.path);
      case 'move': return desktop.files.move(input.from, input.to, { overwrite: input.overwrite });
      case 'copy': return desktop.files.copy(input.from, input.to);
      case 'recycle': return desktop.files.recycle(input.path);
    }
  });

  app.post('/api/desktop/open', limited(30), async request => {
    await owner(request);
    const desktop = required();
    const input = OpenRequest.parse(request.body ?? {});
    switch (input.kind) {
      case 'path': case 'url': return desktop.apps.open(input.target);
      case 'app': return desktop.apps.launch(input.name);
      case 'reveal': return desktop.apps.reveal(input.target);
      case 'editor': return desktop.apps.openInEditor(input.target);
      case 'terminal': return desktop.apps.openTerminal(input.target);
    }
  });

  app.post('/api/desktop/shell', limited(30), async request => {
    await owner(request);
    const input = ShellRequest.parse(request.body ?? {});
    return required().runShell(input.command, { cwd: input.cwd ?? null, approved: input.approved, timeoutMs: input.timeoutMs });
  });

  app.get('/api/desktop/windows', async request => {
    await owner(request);
    const desktop = required();
    return { windows: await desktop.windows.list(), foreground: await desktop.windows.foreground() };
  });
  app.post('/api/desktop/windows', limited(60), async request => {
    await owner(request);
    const desktop = required();
    const input = WindowAction.parse(request.body ?? {});
    const reference = input.handle ?? input.target!;
    if (input.action === 'focus') return desktop.windows.focus(reference);
    return desktop.windows.show(reference, input.action);
  });
  app.get('/api/desktop/screenshot', limited(60), async (request, reply: FastifyReply) => {
    await owner(request);
    const desktop = required();
    const query = ScreenshotQuery.parse(request.query ?? {});
    const shot = query.save === 'true' ? await desktop.captureScreen(query.window ?? null, query.maxWidth ?? 1600) : { ...(await desktop.windows.screenshot(query.window ?? null, query.maxWidth ?? 1600)), file: null };
    return reply.type('image/png').header('Content-Disposition', 'inline').header('X-Desktop-Capture', JSON.stringify({ width: shot.width, height: shot.height, capturedAt: shot.capturedAt, file: shot.file, window: shot.window?.title ?? null })).send(Buffer.from(shot.png, 'base64'));
  });
  app.get('/api/desktop/elements', async request => {
    await owner(request);
    const query = z.object({ window: z.string().trim().min(1).max(200).optional() }).strict().parse(request.query ?? {});
    return required().windows.elements(query.window ?? null, 200);
  });
  app.post('/api/desktop/input', limited(120), async request => {
    await owner(request);
    const desktop = required();
    const input = InputRequest.parse(request.body ?? {});
    switch (input.kind) {
      case 'type': if (input.window) await desktop.windows.focus(input.window); return desktop.input.type(input.text);
      case 'keys': if (input.window) await desktop.windows.focus(input.window); return desktop.input.keys(input.combo);
      case 'click': return desktop.input.click(input.x, input.y, { button: input.button, double: input.double });
      case 'scroll': return desktop.input.scroll(input.delta);
      case 'clipboard_set': await desktop.input.clipboardSet(input.text); return { ok: true };
    }
  });

  app.get('/api/desktop/system', async request => {
    await owner(request);
    const desktop = required();
    const { systemInfo } = await import('@mohassan/desktop');
    return systemInfo(desktop.dataDir);
  });
  app.get('/api/desktop/audit', async request => {
    await owner(request);
    const query = AuditQuery.parse(request.query ?? {});
    return { entries: await required().audit.recent(query.limit ?? 50) };
  });

  /** The panel's command box: the same parser and engine the chat uses, so the two never disagree. */
  app.post('/api/desktop/command', limited(60), async request => {
    await owner(request);
    const desktop = required();
    const input = CommandRequest.parse(request.body ?? {});
    const parsed = desktop.parse(input.text);
    if (!parsed) return { understood: false, outcome: null };
    const outcome = await desktop.execute(parsed.command, { approved: input.approved, lang: input.lang ?? parsed.lang });
    const { screenshot, ...rest } = outcome;
    return { understood: true, command: parsed.command, lang: parsed.lang, label: desktop.describe(parsed.command, parsed.lang), outcome: { ...rest, ...(screenshot ? { screenshot: { width: screenshot.width, height: screenshot.height, file: screenshot.file, capturedAt: screenshot.capturedAt, window: screenshot.window?.title ?? null } } : {}) } };
  });
}
