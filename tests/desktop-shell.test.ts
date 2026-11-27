import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureConfigFile, loadConfig } from '../apps/desktop/src/config.ts';
import { engines } from '../package.json';

// Documented settings and CLI flags (retrieved 2026-11-27):
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/desktop/README.md#الإعدادات
// Tray labels and crash-dialog copy (retrieved 2026-11-27):
// https://github.com/ahmadalwakai/Mohassan-AI/blob/29448ae/apps/desktop/src/main.ts

let profileDir: string;
let configPath: string;

function makeRepo(name: string) {
  const repoRoot = join(profileDir, name);
  mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
  writeFileSync(join(repoRoot, 'scripts', 'dev.mjs'), '');
  return repoRoot;
}

beforeEach(() => {
  profileDir = mkdtempSync(join(tmpdir(), 'mohassan-desktop-'));
  configPath = join(profileDir, 'config.json');
});

afterEach(() => {
  rmSync(profileDir, { recursive: true, force: true });
});

describe('desktop settings', () => {
  it.each([
    { flag: '--lab', mode: 'lab', savedMode: 'production' },
    { flag: '--production', mode: 'production', savedMode: 'lab' },
  ])('keeps $flag, --hidden and --repo overrides in the current launch', ({ flag, mode, savedMode }) => {
    const saved = {
      repoRoot: makeRepo('saved'), mode: savedMode, startHidden: false, autostartStack: false, closeToTray: false,
    };
    const savedText = JSON.stringify(saved);
    writeFileSync(configPath, savedText);
    const alternateRepo = makeRepo('alternate');

    expect(loadConfig(configPath, [flag, '--hidden', '--repo', alternateRepo])).toMatchObject({
      ...saved, repoRoot: alternateRepo, mode, startHidden: true,
    });
    expect(loadConfig(configPath, [], alternateRepo)).toMatchObject(saved);
    expect(readFileSync(configPath, 'utf8')).toBe(savedText);
  });

  it('creates an editable settings file from defaults only when requested', () => {
    const repoRoot = makeRepo('default');
    const alternateRepo = makeRepo('one-run');
    const defaults = loadConfig(configPath, [], repoRoot);
    expect(loadConfig(configPath, ['--production', '--hidden', '--repo', alternateRepo], repoRoot)).toMatchObject({
      mode: 'production', repoRoot: alternateRepo, startHidden: true,
    });
    expect(existsSync(configPath)).toBe(false);

    ensureConfigFile(configPath, repoRoot);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(defaults);
    const edited = { ...defaults, mode: 'production', startHidden: true };
    const editedText = JSON.stringify(edited);
    writeFileSync(configPath, editedText);
    ensureConfigFile(configPath, alternateRepo);
    expect(loadConfig(configPath, [], alternateRepo)).toEqual(edited);
    expect(readFileSync(configPath, 'utf8')).toBe(editedText);
  });
});

class FakeChild extends EventEmitter {
  readonly kill = vi.fn(() => true);
  readonly pid?: number;

  constructor(pid?: number) {
    super();
    this.pid = pid;
  }

  exit(code: number | null) {
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
}

class FakeBrowserWindow extends EventEmitter {
  readonly webContents = Object.assign(new EventEmitter(), {
    executeJavaScript: vi.fn<(script: string) => Promise<void>>().mockResolvedValue(undefined),
    setWindowOpenHandler: vi.fn(),
  });
  readonly show = vi.fn();
  readonly focus = vi.fn();
  private destroyed = false;

  constructor() {
    super();
    windows.push(this);
  }

  async loadFile() {
    this.webContents.emit('did-finish-load');
    queueMicrotask(() => this.emit('ready-to-show'));
  }

  async loadURL() {
    this.webContents.emit('did-stop-loading');
    queueMicrotask(() => this.emit('ready-to-show'));
  }

  close() {
    this.destroyed = true;
    this.emit('closed');
  }

  isDestroyed() { return this.destroyed; }
}

type TrayEntry = { label?: string; click?: () => void };

class FakeTray extends EventEmitter {
  setToolTip = vi.fn();
  setContextMenu(template: TrayEntry[]) { menu = template; }
}

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn<(command: string) => FakeChild>() }));
vi.mock('node:child_process', () => ({ spawn }));

let menu: TrayEntry[];
let windows: FakeBrowserWindow[];
const app = Object.assign(new EventEmitter(), {
  setName: vi.fn(),
  setAppUserModelId: vi.fn(),
  getPath: () => profileDir,
  requestSingleInstanceLock: () => true,
  whenReady: async () => undefined,
  setAccessibilitySupportEnabled: vi.fn(),
  getLoginItemSettings: () => ({ openAtLogin: false }),
});
const showMessageBoxSync = vi.fn(() => 2);
const openPath = vi.fn(async () => '');

vi.mock('electron', () => ({
  app,
  BrowserWindow: FakeBrowserWindow,
  Tray: FakeTray,
  Menu: { buildFromTemplate: (template: TrayEntry[]) => template, setApplicationMenu: vi.fn() },
  Notification: { isSupported: () => false },
  dialog: { showMessageBoxSync },
  globalShortcut: { register: vi.fn(), unregisterAll: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  shell: { openPath },
}));

const fetcher = vi.fn<typeof fetch>();
const appArgs = process.argv;

async function startDesktop(args: string[] = []) {
  process.argv = [process.execPath, 'desktop', ...args];
  await import('../apps/desktop/src/main.ts');
  await vi.advanceTimersByTimeAsync(0);
}

function trayAction(label: string) {
  const click = menu.find(item => item.label === label)?.click;
  if (!click) throw new Error(`No tray action named ${label}`);
  return click;
}

function nodeSpawns() {
  return spawn.mock.results.filter((_, index) => spawn.mock.calls[index][0] === 'node');
}

function withWindowsPlatform(action: () => void) {
  const platform = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { action(); } finally { Object.defineProperty(process, 'platform', { value: platform }); }
}

describe('desktop main process', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    fetcher.mockReset().mockResolvedValue(Response.error());
    vi.stubGlobal('fetch', fetcher);
    spawn.mockReset().mockImplementation(() => new FakeChild(spawn.mock.calls.length));
    showMessageBoxSync.mockClear();
    openPath.mockClear();
    menu = [];
    windows = [];
  });

  afterEach(() => {
    app.removeAllListeners();
    process.argv = appArgs;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('opens existing settings unchanged after running with Windows login flags', async () => {
    const savedText = JSON.stringify({ mode: 'production', autostartStack: false, startHidden: false });
    writeFileSync(configPath, savedText);
    await startDesktop(['--hidden']);

    trayAction('فتح الإعدادات')();
    expect(openPath).toHaveBeenCalledWith(configPath);
    expect(readFileSync(configPath, 'utf8')).toBe(savedText);
  });

  it('waits for a deliberate Windows stop before restarting and reports a later unexpected exit', async () => {
    await startDesktop();
    expect(nodeSpawns()).toHaveLength(1);
    const first = nodeSpawns()[0].value;

    const restart = trayAction('إعادة تشغيل الخدمة');
    withWindowsPlatform(restart);
    withWindowsPlatform(restart);
    expect(spawn.mock.calls.filter(([command]) => command === 'taskkill')).toHaveLength(1);
    const taskkill = spawn.mock.results.at(-1)!.value;
    taskkill.exit(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(nodeSpawns()).toHaveLength(1);

    first.exit(null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(nodeSpawns()).toHaveLength(2);
    expect(showMessageBoxSync).not.toHaveBeenCalled();

    nodeSpawns()[1].value.exit(1);
    expect(showMessageBoxSync).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      message: 'توقفت خدمة موحسن.',
    }));
  });

  it('keeps watching the child if Windows cannot launch taskkill', async () => {
    await startDesktop();
    const child = nodeSpawns()[0].value;
    withWindowsPlatform(trayAction('إعادة تشغيل الخدمة'));
    spawn.mock.results.at(-1)!.value.emit('error', new Error('could not launch taskkill'));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(nodeSpawns()).toHaveLength(1);
    expect(showMessageBoxSync).not.toHaveBeenCalled();
    child.exit(1);
    expect(showMessageBoxSync).toHaveBeenCalledOnce();
  });

  it('does not show a crash dialog or start a replacement when quitting', async () => {
    await startDesktop();
    expect(nodeSpawns()).toHaveLength(1);

    app.emit('before-quit');
    nodeSpawns()[0].value.exit(null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(nodeSpawns()).toHaveLength(1);
    expect(showMessageBoxSync).not.toHaveBeenCalled();
  });

  it('shows missing Node.js guidance on the splash even on a hidden launch', async () => {
    let resumeProbe!: (response: Response) => void;
    const pendingProbe = new Promise<Response>(resolve => { resumeProbe = resolve; });
    spawn.mockImplementationOnce(() => {
      fetcher.mockReturnValueOnce(pendingProbe);
      return new FakeChild();
    });
    await startDesktop(['--hidden']);
    expect(nodeSpawns()).toHaveLength(1);
    const splash = windows[0];
    expect(splash.show).not.toHaveBeenCalled();

    // A missing command emits error without exit (retrieved 2026-11-27).
    // https://nodejs.org/api/child_process.html#child_processspawncommand-args-options
    const child = nodeSpawns()[0].value;
    child.emit('error', Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }));
    child.emit('close', null, null);
    await vi.advanceTimersByTimeAsync(0);
    const status = splash.webContents.executeJavaScript.mock.lastCall?.[0];
    const nodeMajor = engines.node.match(/\d+/)?.[0];
    expect(status).toMatch(/window\.setStatus\(.*\p{Script=Arabic}.*, true\)$/u);
    expect(status).toContain(`Node.js ${nodeMajor}`);
    expect(status).toContain('PATH');
    expect(splash.show).toHaveBeenCalled();
    expect(showMessageBoxSync).not.toHaveBeenCalled();

    resumeProbe(new Response());
    await vi.advanceTimersByTimeAsync(2_000);
    expect(splash.webContents.executeJavaScript.mock.lastCall?.[0]).toBe(status);
    expect(windows).toHaveLength(1);
  });

  it('opens an error splash when the restarted service cannot execute Node.js', async () => {
    spawn.mockImplementationOnce(() => {
      fetcher.mockResolvedValue(new Response());
      return new FakeChild(spawn.mock.calls.length);
    });
    await startDesktop();
    expect(windows).toHaveLength(2);
    expect(windows[0].isDestroyed()).toBe(true);

    withWindowsPlatform(trayAction('إعادة تشغيل الخدمة'));
    fetcher.mockResolvedValue(Response.error());
    spawn.mockImplementationOnce(() => new FakeChild());
    spawn.mock.results.at(-1)!.value.exit(0);
    nodeSpawns()[0].value.exit(null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(nodeSpawns()).toHaveLength(2);

    // The executable can also fail with a permission error (retrieved 2026-11-27).
    // https://nodejs.org/api/errors.html#common-system-errors
    const child = nodeSpawns()[1].value;
    child.emit('error', Object.assign(new Error('spawn node EACCES'), { code: 'EACCES' }));
    child.emit('close', null, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(windows).toHaveLength(3);
    const splash = windows[2];
    expect(splash.webContents.executeJavaScript.mock.lastCall?.[0]).toMatch(/Node\.js.*PATH.*, true\)$/u);
    expect(splash.show).toHaveBeenCalled();
    expect(showMessageBoxSync).not.toHaveBeenCalled();
  });
});
